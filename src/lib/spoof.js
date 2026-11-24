/**
 * Код, который выполняется в MAIN-мире страницы на document_start.
 *
 * ВАЖНО: функция должна быть полностью самодостаточной (без замыканий на
 * модульную область), потому что она сериализуется через toString() и
 * передаётся либо в chrome.userScripts.register({js:[{code}]}),
 * либо в chrome.scripting.executeScript({func, args}). Тот же исходный текст
 * она сама вшивает в Web Worker'ы, созданные страницей.
 *
 * @param {{timeZone?: string|null, languages?: string[]|null, coords?: object|null, blockWebRTC?: boolean}} cfg
 * @param {object} [targetGlobal] чужой глобальный объект (окно about:blank-фрейма);
 *   по умолчанию — globalThis текущего контекста (окно или воркер)
 */
export function spoofMain(cfg, targetGlobal) {
  const G = targetGlobal || globalThis;

  /*
   * Метка «уже применено». Свойство на window само было бы отпечатком
   * (Object.getOwnPropertyNames(window) его покажет), поэтому спрашиваем
   * наш же подменённый Function.prototype.toString: на строку-ключ он
   * отвечает паролем, а родной toString на строке бросает TypeError.
   */
  const MARK_KEY = '__proxymate_probe__';
  const MARK_ANSWER = 'proxymate:applied';
  let GFunction;
  try { GFunction = G.Function; } catch (e) { return; }   // чужой origin
  try {
    if (GFunction.prototype.toString.call(MARK_KEY) === MARK_ANSWER) return;
  } catch (e) { /* не применено */ }

  const objToString = Object.prototype.toString;
  const NativeDate = G.Date;
  const DP = NativeDate.prototype;
  const nGetTime = DP.getTime;
  const nGetTZO = DP.getTimezoneOffset;
  const nToLocaleString = DP.toLocaleString;
  const nToLocaleDateString = DP.toLocaleDateString;
  const nToLocaleTimeString = DP.toLocaleTimeString;
  const GIntl = G.Intl;
  const NativeDTF = GIntl.DateTimeFormat;

  /* ---------- маскировка патченых функций под нативные ---------- */
  const fake = new WeakMap();
  const origFnToString = GFunction.prototype.toString;
  function patchedFnToString() {
    if (objToString.call(this) === '[object String]' && String(this) === MARK_KEY) return MARK_ANSWER;
    const n = fake.get(this);
    if (n !== undefined) return 'function ' + n + '() { [native code] }';
    return origFnToString.call(this);
  }
  fake.set(patchedFnToString, 'toString');
  try {
    Object.defineProperty(patchedFnToString, 'name', { value: 'toString', configurable: true });
    Object.defineProperty(GFunction.prototype, 'toString', {
      value: patchedFnToString, writable: true, enumerable: false, configurable: true
    });
  } catch (e) { /* noop */ }

  function tag(fn, name, length) {
    try { Object.defineProperty(fn, 'name', { value: name, configurable: true }); } catch (e) { /* noop */ }
    // Длина аргументов — тоже отпечаток: у родного setHours она 4, а не 0.
    if (typeof length === 'number') {
      try { Object.defineProperty(fn, 'length', { value: length, configurable: true }); } catch (e) { /* noop */ }
    }
    fake.set(fn, name);
    return fn;
  }
  function defMethod(obj, name, fn) {
    let orig;
    try { orig = obj[name]; } catch (e) { orig = undefined; }
    tag(fn, name, typeof orig === 'function' ? orig.length : undefined);
    try {
      Object.defineProperty(obj, name, { value: fn, writable: true, enumerable: false, configurable: true });
    } catch (e) { /* noop */ }
  }
  function defGetter(obj, name, getter, enumerable) {
    tag(getter, 'get ' + name, 0);
    try {
      Object.defineProperty(obj, name, { get: getter, set: undefined, enumerable: !!enumerable, configurable: true });
    } catch (e) { /* noop */ }
  }

  /* ==================== ЧАСОВОЙ ПОЯС ==================== */
  const tz = cfg && cfg.timeZone;
  let partsFmt = null;
  if (tz) {
    try {
      partsFmt = new NativeDTF('en-US', {
        timeZone: tz, hour12: false,
        year: 'numeric', month: '2-digit', day: '2-digit',
        hour: '2-digit', minute: '2-digit', second: '2-digit'
      });
    } catch (e) { partsFmt = null; }
  }

  if (partsFmt) {
    let longNameFmt = null;
    try { longNameFmt = new NativeDTF('en-US', { timeZone: tz, timeZoneName: 'long' }); } catch (e) { /* noop */ }

    /* смещение в минутах к востоку от UTC для конкретного момента */
    const offCache = new Map();
    const rawOffset = function (ts) {
      const parts = partsFmt.formatToParts(new NativeDate(ts));
      const o = {};
      for (let i = 0; i < parts.length; i++) o[parts[i].type] = parts[i].value;
      let hour = +o.hour;
      if (hour === 24) hour = 0;
      const asUTC = NativeDate.UTC(+o.year, +o.month - 1, +o.day, hour, +o.minute, +o.second);
      return Math.round((asUTC - ts) / 60000);
    };
    const offsetMinutes = function (ts) {
      if (!isFinite(ts)) return 0;
      const bucket = Math.floor(ts / 3600000);
      const hit = offCache.get(bucket);
      if (hit !== undefined) return hit;
      let val;
      try { val = rawOffset(ts); } catch (e) { val = 0; }
      if (offCache.size > 512) offCache.clear();
      offCache.set(bucket, val);
      return val;
    };
    const offsetMs = function (ts) { return offsetMinutes(ts) * 60000; };

    /* «настенное» UTC-представление локального времени в подменной зоне */
    const toWall = function (ts) { return ts + offsetMs(ts); };
    /**
     * Обратное преобразование: «настенное» время -> реальный timestamp.
     * Разрешение неоднозначности как в V8: для пропущенного часа (перевод
     * вперёд) берётся смещение до перехода, для повторяющегося (перевод
     * назад) — первое вхождение.
     */
    const fromWall = function (wall) {
      if (!isFinite(wall)) return NaN;
      const o1 = offsetMinutes(wall);
      let guess = wall - o1 * 60000;
      const o2 = offsetMinutes(guess);
      if (o2 === o1) return guess;
      guess = wall - o2 * 60000;
      const o3 = offsetMinutes(guess);
      if (o3 === o2) return guess;
      return wall - Math.min(o2, o3) * 60000;
    };

    const WD = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'];
    const MO = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];
    const pad = function (n, len) {
      let s = String(Math.abs(n));
      while (s.length < (len || 2)) s = '0' + s;
      return (n < 0 ? '-' : '') + s;
    };
    const gmtString = function (mins) {
      const sign = mins < 0 ? '-' : '+';
      const a = Math.abs(mins);
      return 'GMT' + sign + pad(Math.floor(a / 60)) + pad(a % 60);
    };
    const tzLongName = function (d) {
      if (!longNameFmt) return tz;
      try {
        const parts = longNameFmt.formatToParts(d);
        for (let i = 0; i < parts.length; i++) if (parts[i].type === 'timeZoneName') return parts[i].value;
      } catch (e) { /* noop */ }
      return tz;
    };

    /* ---- геттеры локального времени ---- */
    const getterMap = {
      getFullYear: 'getUTCFullYear', getMonth: 'getUTCMonth', getDate: 'getUTCDate',
      getDay: 'getUTCDay', getHours: 'getUTCHours', getMinutes: 'getUTCMinutes',
      getSeconds: 'getUTCSeconds', getMilliseconds: 'getUTCMilliseconds'
    };
    Object.keys(getterMap).forEach(function (localName) {
      const utcFn = DP[getterMap[localName]];
      defMethod(DP, localName, function () {
        const t = nGetTime.call(this);
        if (!isFinite(t)) return NaN;
        return utcFn.call(new NativeDate(toWall(t)));
      });
    });

    defMethod(DP, 'getTimezoneOffset', function () {
      const t = nGetTime.call(this);
      if (!isFinite(t)) return NaN;
      return -offsetMinutes(t);
    });

    /* ---- сеттеры локального времени ---- */
    const setterNames = ['setFullYear', 'setMonth', 'setDate', 'setHours', 'setMinutes', 'setSeconds', 'setMilliseconds'];
    const nSetTime = DP.setTime;
    setterNames.forEach(function (localName) {
      const utcFn = DP['setUTC' + localName.slice(3)];
      defMethod(DP, localName, function () {
        const t = nGetTime.call(this);
        const base = isFinite(t) ? toWall(t) : NaN;
        const tmp = new NativeDate(base);
        utcFn.apply(tmp, arguments);
        return nSetTime.call(this, fromWall(nGetTime.call(tmp)));
      });
    });

    /* ---- строковые представления ---- */
    const dateStr = function (d) {
      const w = new NativeDate(toWall(nGetTime.call(d)));
      return WD[w.getUTCDay()] + ' ' + MO[w.getUTCMonth()] + ' ' + pad(w.getUTCDate()) + ' ' + pad(w.getUTCFullYear(), 4);
    };
    const timeStr = function (d) {
      const t = nGetTime.call(d);
      const w = new NativeDate(toWall(t));
      return pad(w.getUTCHours()) + ':' + pad(w.getUTCMinutes()) + ':' + pad(w.getUTCSeconds()) +
        ' ' + gmtString(offsetMinutes(t)) + ' (' + tzLongName(d) + ')';
    };
    defMethod(DP, 'toString', function () {
      const t = nGetTime.call(this);
      if (!isFinite(t)) return 'Invalid Date';
      return dateStr(this) + ' ' + timeStr(this);
    });
    defMethod(DP, 'toDateString', function () {
      const t = nGetTime.call(this);
      return isFinite(t) ? dateStr(this) : 'Invalid Date';
    });
    defMethod(DP, 'toTimeString', function () {
      const t = nGetTime.call(this);
      return isFinite(t) ? timeStr(this) : 'Invalid Date';
    });

    /* ---- конструктор Date: многоаргументная форма и парсинг локальных строк ---- */
    const HAS_TZ = /(?:Z|[+-]\d{2}:?\d{2}|GMT|UTC)\s*$/i;
    const DATE_ONLY = /^[+-]?\d{4,6}-\d{2}(?:-\d{2})?$/;
    const patchedParse = function (input) {
      const s = String(input).trim();
      const t = NativeDate.parse(s);
      if (!isFinite(t)) return NaN;
      if (HAS_TZ.test(s) || DATE_ONLY.test(s)) return t;   // абсолютный момент — не трогаем
      // строка была разобрана в реальной локальной зоне — переносим в подменную
      const realOff = -nGetTZO.call(new NativeDate(t)) * 60000;
      return fromWall(t + realOff);
    };
    const fromComponents = function (args) {
      const y = Number(args[0]);
      const mo = Number(args[1]);
      const d = args.length > 2 ? Number(args[2]) : 1;
      const h = args.length > 3 ? Number(args[3]) : 0;
      const mi = args.length > 4 ? Number(args[4]) : 0;
      const s = args.length > 5 ? Number(args[5]) : 0;
      const ms = args.length > 6 ? Number(args[6]) : 0;
      const wall = NativeDate.UTC(y, mo, d, h, mi, s, ms);
      if (!isFinite(wall)) return NaN;
      return fromWall(wall);
    };

    const taggedParse = tag(function (s) { return patchedParse(s); }, 'parse', 1);
    const PatchedDate = new Proxy(NativeDate, {
      construct: function (target, args, newTarget) {
        if (args.length >= 2) {
          return Reflect.construct(target, [fromComponents(args)], newTarget);
        }
        if (args.length === 1 && typeof args[0] === 'string') {
          return Reflect.construct(target, [patchedParse(args[0])], newTarget);
        }
        return Reflect.construct(target, args, newTarget);
      },
      apply: function () {
        return DP.toString.call(new NativeDate());
      },
      get: function (target, prop, receiver) {
        if (prop === 'parse') return taggedParse;
        return Reflect.get(target, prop, receiver);
      }
    });
    try {
      Object.defineProperty(G, 'Date', { value: PatchedDate, writable: true, enumerable: false, configurable: true });
      Object.defineProperty(DP, 'constructor', { value: PatchedDate, writable: true, enumerable: false, configurable: true });
    } catch (e) { /* noop */ }

    /* ---- Temporal: Temporal.Now.timeZoneId() отдаёт системную зону ---- */
    try {
      const TNow = G.Temporal && G.Temporal.Now;
      if (TNow) {
        if (typeof TNow.timeZoneId === 'function') {
          defMethod(TNow, 'timeZoneId', function () { return tz; });
        }
        ['zonedDateTimeISO', 'plainDateTimeISO', 'plainDateISO', 'plainTimeISO'].forEach(function (n) {
          const nf = TNow[n];
          if (typeof nf !== 'function') return;
          defMethod(TNow, n, function () {
            const a = arguments.length && arguments[0] !== undefined ? arguments[0] : tz;
            return nf.call(TNow, a);
          });
        });
      }
    } catch (e) { /* Temporal нет — не страшно */ }
  }

  /* ==================== ЯЗЫК ==================== */
  const langs = cfg && Array.isArray(cfg.languages) && cfg.languages.length ? cfg.languages.slice() : null;
  const locale = langs ? langs[0] : null;

  if (langs) {
    // Массив из того же realm, что и страница: иначе instanceof Array === false.
    let frozen;
    try { frozen = G.Object.freeze(G.Array.from(langs)); } catch (e) { frozen = Object.freeze(langs.slice()); }
    if (typeof G.Navigator === 'function') {
      defGetter(G.Navigator.prototype, 'language', function () { return frozen[0]; }, true);
      defGetter(G.Navigator.prototype, 'languages', function () { return frozen; }, true);
    }
    if (typeof G.WorkerNavigator === 'function') {
      defGetter(G.WorkerNavigator.prototype, 'language', function () { return frozen[0]; }, true);
      defGetter(G.WorkerNavigator.prototype, 'languages', function () { return frozen; }, true);
    }
  }

  /* ==================== Intl ==================== */
  if (tz || locale) {
    const wrapIntl = function (name, injectTimeZone) {
      const Native = GIntl[name];
      if (typeof Native !== 'function') return;
      const Wrapped = new Proxy(Native, {
        construct: function (target, args, newTarget) {
          const a = args.slice();
          if (locale && (a[0] === undefined || a[0] === null)) a[0] = locale;
          if (injectTimeZone && tz) {
            const opts = Object.assign({}, a[1]);
            if (!opts.timeZone) opts.timeZone = tz;
            a[1] = opts;
          }
          return Reflect.construct(target, a, newTarget === Wrapped ? Native : newTarget);
        },
        apply: function (target, thisArg, args) {
          return Reflect.construct(Wrapped, args);
        }
      });
      try {
        Object.defineProperty(GIntl, name, { value: Wrapped, writable: true, enumerable: false, configurable: true });
        Object.defineProperty(Native.prototype, 'constructor', { value: Wrapped, writable: true, enumerable: false, configurable: true });
      } catch (e) { /* noop */ }
    };
    wrapIntl('DateTimeFormat', true);
    ['NumberFormat', 'Collator', 'RelativeTimeFormat', 'ListFormat', 'PluralRules', 'DisplayNames', 'Segmenter', 'DurationFormat']
      .forEach(function (n) { wrapIntl(n, false); });

    /* Date#toLocale* — форсируем зону и локаль по умолчанию */
    const localeWrapper = function (nativeFn, name) {
      defMethod(DP, name, function () {
        const loc = arguments[0];
        const o = Object.assign({}, arguments[1]);
        if (tz && !o.timeZone) o.timeZone = tz;
        return nativeFn.call(this, loc === undefined || loc === null ? (locale || undefined) : loc, o);
      });
    };
    localeWrapper(nToLocaleString, 'toLocaleString');
    localeWrapper(nToLocaleDateString, 'toLocaleDateString');
    localeWrapper(nToLocaleTimeString, 'toLocaleTimeString');

    if (locale) {
      const nNumToLocale = G.Number.prototype.toLocaleString;
      defMethod(G.Number.prototype, 'toLocaleString', function () {
        const loc = arguments[0];
        return nNumToLocale.call(this, loc === undefined || loc === null ? locale : loc, arguments[1]);
      });
    }
  }

  /* ==================== ГЕОЛОКАЦИЯ ==================== */
  const coords = cfg && cfg.coords;
  let geoApi = null;
  try { geoApi = G.navigator && G.navigator.geolocation; } catch (e) { geoApi = null; }
  if (coords && isFinite(coords.lat) && isFinite(coords.lon) && geoApi) {
    try {
      const GeoProto = Object.getPrototypeOf(geoApi);
      const nativeGet = GeoProto.getCurrentPosition;
      const nativeWatch = GeoProto.watchPosition;

      // Стабильное в пределах страницы смещение ~100 м: ровные до знака
      // координаты сами по себе выглядят синтетикой.
      const dLat = (Math.random() - 0.5) * 0.002;
      const dLon = (Math.random() - 0.5) * 0.002;

      const makePosition = function () {
        return {
          coords: {
            latitude: coords.lat + dLat,
            longitude: coords.lon + dLon,
            accuracy: isFinite(coords.accuracy) ? coords.accuracy : 1200,
            altitude: null,
            altitudeAccuracy: null,
            heading: null,
            speed: null
          },
          timestamp: NativeDate.now()
        };
      };

      /**
       * Сначала дёргаем настоящий API, чтобы сохранить обычный запрос
       * разрешения у пользователя. Явный отказ уважаем, прочие сбои
       * (нет сервиса геопозиции, таймаут) подменяем своими координатами.
       */
      const wrap = function (native) {
        return function () {
          const success = arguments[0], error = arguments[1], options = arguments[2];
          if (typeof success !== 'function') {
            throw new G.TypeError("Failed to execute on 'Geolocation': parameter 1 is not of type 'Function'.");
          }
          const onOk = function () { success(makePosition()); };
          const onErr = function (err) {
            if (err && err.code === 1) { if (typeof error === 'function') error(err); return; }
            success(makePosition());
          };
          try {
            return native.call(this, onOk, onErr, options);
          } catch (e) {
            setTimeout(onOk, 0);
            return 0;
          }
        };
      };

      defMethod(GeoProto, 'getCurrentPosition', wrap(nativeGet));
      defMethod(GeoProto, 'watchPosition', wrap(nativeWatch));
    } catch (e) { /* геолокация недоступна — не критично */ }
  }

  /* ==================== WebRTC ==================== */
  if (cfg && cfg.blockWebRTC) {
    ['RTCPeerConnection', 'webkitRTCPeerConnection', 'RTCDataChannel', 'mozRTCPeerConnection'].forEach(function (n) {
      try {
        if (n in G) {
          Object.defineProperty(G, n, { value: undefined, writable: true, enumerable: false, configurable: true });
        }
      } catch (e) { /* noop */ }
    });
    try {
      if (G.navigator && G.navigator.mediaDevices && G.MediaDevices) {
        defMethod(G.MediaDevices.prototype, 'enumerateDevices', function () { return G.Promise.resolve(new G.Array()); });
      }
    } catch (e) { /* noop */ }
  }

  /* ==================== WEB WORKER'Ы ==================== */
  /*
   * Расширение не может внедрить скрипт в воркер, поэтому воркер из blob:
   * пересобирается: наш код + исходный код воркера. Именно blob-воркерами
   * пользуются сторонние скрипты фингерпринтинга: чужой домен не может
   * запустить воркер с URL страницы. Воркеры с обычным URL не трогаем —
   * пересборка сломала бы им относительные пути (importScripts, fetch).
   */
  const anySpoof = tz || langs;
  if (anySpoof && typeof G.Blob === 'function' && typeof G.XMLHttpRequest === 'function' && G.URL) {
    const NBlob = G.Blob;
    const NXHR = G.XMLHttpRequest;
    const nCreateURL = G.URL.createObjectURL;
    const nRevokeURL = G.URL.revokeObjectURL;
    // Родной таймер, захваченный до скриптов страницы: её подменённый
    // setTimeout увидел бы наш вызов с blob-адресом.
    const nSetTimeout = typeof G.setTimeout === 'function' ? G.setTimeout : null;
    const prefix = '(' + origFnToString.call(spoofMain) + ')(' + JSON.stringify(cfg) + ');\n';

    const rebuild = function (url) {
      // blob: читается синхронно; страница часто отзывает URL сразу после new Worker().
      const x = new NXHR();
      x.open('GET', url, false);
      x.send();
      if (x.status !== 200 && x.status !== 0) throw new Error('read failed');
      const code = x.responseText;
      const strict = /^\s*(['"])use strict\1/.test(code) ? '"use strict";\n' : '';
      const out = nCreateURL(new NBlob([strict + prefix + code], { type: 'text/javascript' }));
      if (nSetTimeout) {
        nSetTimeout.call(G, function () { try { nRevokeURL.call(G.URL, out); } catch (e) { /* noop */ } }, 60000);
      }
      return out;
    };

    ['Worker', 'SharedWorker'].forEach(function (name) {
      const Native = G[name];
      if (typeof Native !== 'function') return;
      const Wrapped = new Proxy(Native, {
        construct: function (target, args, newTarget) {
          const nt = newTarget === Wrapped ? target : newTarget;
          let url = null;
          try { url = String(args[0]); } catch (e) { url = null; }
          if (url && /^blob:/i.test(url)) {
            let rebuilt = null;
            try { rebuilt = rebuild(url); } catch (e) { rebuilt = null; }
            if (rebuilt) {
              const a = Array.prototype.slice.call(args);
              a[0] = rebuilt;
              try { return Reflect.construct(target, a, nt); } catch (e) { /* ниже — как было */ }
            }
          }
          return Reflect.construct(target, args, nt);
        }
      });
      try {
        Object.defineProperty(G, name, { value: Wrapped, writable: true, enumerable: false, configurable: true });
        Object.defineProperty(Native.prototype, 'constructor', { value: Wrapped, writable: true, enumerable: false, configurable: true });
      } catch (e) { /* noop */ }
    });
  }

  /* ==================== ПУСТЫЕ ФРЕЙМЫ ==================== */
  /*
   * about:blank-фрейм того же origin получает свежие Date/Intl/navigator,
   * а userScripts в него не внедряется. Классический обход подмены:
   * создать iframe и прочитать зону из его contentWindow. Подменяем окно
   * фрейма при первом доступе к нему и при вставке в документ.
   */
  if (typeof G.HTMLIFrameElement === 'function') {
    const patchWin = function (win) {
      if (!win || win === G) return;
      try {
        // Чужой origin бросит SecurityError — туда нам и не надо.
        if (win.Function.prototype.toString.call(MARK_KEY) === MARK_ANSWER) return;
      } catch (e) {
        if (!(e && e.name === 'TypeError')) return;
      }
      try { spoofMain(cfg, win); } catch (e) { /* noop */ }
    };

    const IP = G.HTMLIFrameElement.prototype;
    const cw = Object.getOwnPropertyDescriptor(IP, 'contentWindow');
    const cd = Object.getOwnPropertyDescriptor(IP, 'contentDocument');
    if (cw && cw.get) {
      const nGet = cw.get;
      defGetter(IP, 'contentWindow', function () {
        const w = nGet.call(this);
        patchWin(w);
        return w;
      }, cw.enumerable);
    }
    if (cd && cd.get) {
      const nGet = cd.get;
      defGetter(IP, 'contentDocument', function () {
        const d = nGet.call(this);
        if (d) patchWin(d.defaultView);
        return d;
      }, cd.enumerable);
    }

    // window[0] / window.frames[0] геттер contentWindow обходят —
    // поэтому патчим фреймы сразу при вставке узла в документ.
    const nativeCW = cw && cw.get;
    const collect = function (nodes) {
      const out = [];
      for (let i = 0; i < nodes.length; i++) {
        const n = nodes[i];
        if (!n || typeof n !== 'object') continue;
        if (n.nodeName === 'IFRAME') out.push(n);
        else if (typeof n.getElementsByTagName === 'function') {
          const list = n.getElementsByTagName('iframe');
          for (let j = 0; j < list.length; j++) out.push(list[j]);
        }
      }
      return out;
    };
    const after = function (frames) {
      for (let i = 0; i < frames.length; i++) {
        try { patchWin(nativeCW.call(frames[i])); } catch (e) { /* noop */ }
      }
    };
    if (nativeCW && G.Node && G.Element) {
      const hook = function (proto, name, argIdx) {
        const nf = proto[name];
        if (typeof nf !== 'function') return;
        defMethod(proto, name, function () {
          const frames = collect(argIdx === 'all' ? arguments : [arguments[argIdx]]);
          const r = nf.apply(this, arguments);
          if (frames.length) after(frames);
          return r;
        });
      };
      hook(G.Node.prototype, 'appendChild', 0);
      hook(G.Node.prototype, 'insertBefore', 0);
      hook(G.Node.prototype, 'replaceChild', 0);
      hook(G.Element.prototype, 'append', 'all');
      hook(G.Element.prototype, 'prepend', 'all');
      hook(G.Element.prototype, 'after', 'all');
      hook(G.Element.prototype, 'before', 'all');
      hook(G.Element.prototype, 'replaceWith', 'all');
    }

    // innerHTML, insertAdjacentHTML, document.write — запасной путь.
    try {
      if (typeof G.MutationObserver === 'function' && G.document) {
        new G.MutationObserver(function (records) {
          for (let i = 0; i < records.length; i++) after(collect(records[i].addedNodes));
        }).observe(G.document, { childList: true, subtree: true });
      }
    } catch (e) { /* noop */ }
  }
}

/** Сборка самовыполняющегося кода для chrome.userScripts.register */
export function buildUserScriptCode(cfg) {
  return '(' + spoofMain.toString() + ')(' + JSON.stringify(cfg) + ');';
}
