/**
 * Код, который выполняется в MAIN-мире страницы на document_start.
 *
 * ВАЖНО: функция должна быть полностью самодостаточной (без замыканий на
 * модульную область), потому что она сериализуется через toString() и
 * передаётся либо в chrome.userScripts.register({js:[{code}]}),
 * либо в chrome.scripting.executeScript({func, args}).
 *
 * @param {{timeZone?: string|null, languages?: string[]|null, blockWebRTC?: boolean}} cfg
 */
export function spoofMain(cfg) {
  try {
    if (Object.getOwnPropertyDescriptor(window, '__proxymateApplied')) return;
    Object.defineProperty(window, '__proxymateApplied', {
      value: true, enumerable: false, configurable: true, writable: false
    });
  } catch (e) { return; }

  const NativeDate = Date;
  const DP = Date.prototype;
  const nGetTime = DP.getTime;
  const nGetTZO = DP.getTimezoneOffset;
  const nToLocaleString = DP.toLocaleString;
  const nToLocaleDateString = DP.toLocaleDateString;
  const nToLocaleTimeString = DP.toLocaleTimeString;
  const NativeDTF = Intl.DateTimeFormat;

  /* ---------- маскировка патченых функций под нативные ---------- */
  const fake = new WeakMap();
  const origFnToString = Function.prototype.toString;
  function patchedFnToString() {
    const n = fake.get(this);
    if (n !== undefined) return 'function ' + n + '() { [native code] }';
    return origFnToString.call(this);
  }
  fake.set(patchedFnToString, 'toString');
  try { Function.prototype.toString = patchedFnToString; } catch (e) { /* noop */ }

  function tag(fn, name) {
    try { Object.defineProperty(fn, 'name', { value: name, configurable: true }); } catch (e) { /* noop */ }
    fake.set(fn, name);
    return fn;
  }
  function defMethod(obj, name, fn) {
    tag(fn, name);
    try {
      Object.defineProperty(obj, name, { value: fn, writable: true, enumerable: false, configurable: true });
    } catch (e) { /* noop */ }
  }
  function defGetter(obj, name, getter, enumerable) {
    tag(getter, 'get ' + name);
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
    function rawOffset(ts) {
      const parts = partsFmt.formatToParts(new NativeDate(ts));
      const o = {};
      for (let i = 0; i < parts.length; i++) o[parts[i].type] = parts[i].value;
      let hour = +o.hour;
      if (hour === 24) hour = 0;
      const asUTC = NativeDate.UTC(+o.year, +o.month - 1, +o.day, hour, +o.minute, +o.second);
      return Math.round((asUTC - ts) / 60000);
    }
    function offsetMinutes(ts) {
      if (!isFinite(ts)) return 0;
      const bucket = Math.floor(ts / 3600000);
      const hit = offCache.get(bucket);
      if (hit !== undefined) return hit;
      let val;
      try { val = rawOffset(ts); } catch (e) { val = 0; }
      if (offCache.size > 512) offCache.clear();
      offCache.set(bucket, val);
      return val;
    }
    function offsetMs(ts) { return offsetMinutes(ts) * 60000; }

    /* «настенное» UTC-представление локального времени в подменной зоне */
    function toWall(ts) { return ts + offsetMs(ts); }
    /**
     * Обратное преобразование: «настенное» время -> реальный timestamp.
     * Разрешение неоднозначности как в V8: для пропущенного часа (перевод
     * вперёд) берётся смещение до перехода, для повторяющегося (перевод
     * назад) — первое вхождение.
     */
    function fromWall(wall) {
      if (!isFinite(wall)) return NaN;
      const o1 = offsetMinutes(wall);
      let guess = wall - o1 * 60000;
      const o2 = offsetMinutes(guess);
      if (o2 === o1) return guess;
      guess = wall - o2 * 60000;
      const o3 = offsetMinutes(guess);
      if (o3 === o2) return guess;
      return wall - Math.min(o2, o3) * 60000;
    }

    const WD = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'];
    const MO = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];
    function pad(n, len) {
      let s = String(Math.abs(n));
      while (s.length < (len || 2)) s = '0' + s;
      return (n < 0 ? '-' : '') + s;
    }
    function gmtString(mins) {
      const sign = mins < 0 ? '-' : '+';
      const a = Math.abs(mins);
      return 'GMT' + sign + pad(Math.floor(a / 60)) + pad(a % 60);
    }
    function tzLongName(d) {
      if (!longNameFmt) return tz;
      try {
        const parts = longNameFmt.formatToParts(d);
        for (let i = 0; i < parts.length; i++) if (parts[i].type === 'timeZoneName') return parts[i].value;
      } catch (e) { /* noop */ }
      return tz;
    }

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
    setterNames.forEach(function (localName) {
      const utcFn = DP['setUTC' + localName.slice(3)];
      const nSetTime = DP.setTime;
      defMethod(DP, localName, function () {
        const t = nGetTime.call(this);
        const base = isFinite(t) ? toWall(t) : NaN;
        const tmp = new NativeDate(base);
        utcFn.apply(tmp, arguments);
        return nSetTime.call(this, fromWall(nGetTime.call(tmp)));
      });
    });

    /* ---- строковые представления ---- */
    function dateStr(d) {
      const w = new NativeDate(toWall(nGetTime.call(d)));
      return WD[w.getUTCDay()] + ' ' + MO[w.getUTCMonth()] + ' ' + pad(w.getUTCDate()) + ' ' + pad(w.getUTCFullYear(), 4);
    }
    function timeStr(d) {
      const t = nGetTime.call(d);
      const w = new NativeDate(toWall(t));
      return pad(w.getUTCHours()) + ':' + pad(w.getUTCMinutes()) + ':' + pad(w.getUTCSeconds()) +
        ' ' + gmtString(offsetMinutes(t)) + ' (' + tzLongName(d) + ')';
    }
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
    function patchedParse(input) {
      const s = String(input).trim();
      const t = NativeDate.parse(s);
      if (!isFinite(t)) return NaN;
      if (HAS_TZ.test(s) || DATE_ONLY.test(s)) return t;   // абсолютный момент — не трогаем
      // строка была разобрана в реальной локальной зоне — переносим в подменную
      const realOff = -nGetTZO.call(new NativeDate(t)) * 60000;
      return fromWall(t + realOff);
    }
    function fromComponents(args) {
      const y = Number(args[0]);
      const mo = Number(args[1]);
      const d = args.length > 2 ? Number(args[2]) : 1;
      const h = args.length > 3 ? Number(args[3]) : 0;
      const mi = args.length > 4 ? Number(args[4]) : 0;
      const s = args.length > 5 ? Number(args[5]) : 0;
      const ms = args.length > 6 ? Number(args[6]) : 0;
      let wall = NativeDate.UTC(y, mo, d, h, mi, s, ms);
      if (!isFinite(wall)) return NaN;
      return fromWall(wall);
    }

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
    const taggedParse = tag(function (s) { return patchedParse(s); }, 'parse');
    try {
      Object.defineProperty(window, 'Date', { value: PatchedDate, writable: true, enumerable: false, configurable: true });
      Object.defineProperty(DP, 'constructor', { value: PatchedDate, writable: true, enumerable: false, configurable: true });
    } catch (e) { /* noop */ }
  }

  /* ==================== ЯЗЫК ==================== */
  const langs = cfg && Array.isArray(cfg.languages) && cfg.languages.length ? cfg.languages.slice() : null;
  const locale = langs ? langs[0] : null;

  if (langs) {
    const frozen = Object.freeze(langs.slice());
    defGetter(Navigator.prototype, 'language', function () { return frozen[0]; }, true);
    defGetter(Navigator.prototype, 'languages', function () { return frozen; }, true);
    if (typeof WorkerNavigator !== 'undefined') {
      defGetter(WorkerNavigator.prototype, 'language', function () { return frozen[0]; }, true);
      defGetter(WorkerNavigator.prototype, 'languages', function () { return frozen; }, true);
    }
  }

  /* ==================== Intl ==================== */
  if (tz || locale) {
    function wrapIntl(name, injectTimeZone) {
      const Native = Intl[name];
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
        Object.defineProperty(Intl, name, { value: Wrapped, writable: true, enumerable: false, configurable: true });
        Object.defineProperty(Native.prototype, 'constructor', { value: Wrapped, writable: true, enumerable: false, configurable: true });
      } catch (e) { /* noop */ }
    }
    wrapIntl('DateTimeFormat', true);
    ['NumberFormat', 'Collator', 'RelativeTimeFormat', 'ListFormat', 'PluralRules', 'DisplayNames', 'Segmenter', 'DurationFormat']
      .forEach(function (n) { wrapIntl(n, false); });

    /* Date#toLocale* — форсируем зону и локаль по умолчанию */
    function localeWrapper(nativeFn, name) {
      defMethod(DP, name, function (loc, opts) {
        const o = Object.assign({}, opts);
        if (tz && !o.timeZone) o.timeZone = tz;
        return nativeFn.call(this, loc === undefined || loc === null ? (locale || undefined) : loc, o);
      });
    }
    localeWrapper(nToLocaleString, 'toLocaleString');
    localeWrapper(nToLocaleDateString, 'toLocaleDateString');
    localeWrapper(nToLocaleTimeString, 'toLocaleTimeString');

    if (locale) {
      const nNumToLocale = Number.prototype.toLocaleString;
      defMethod(Number.prototype, 'toLocaleString', function (loc, opts) {
        return nNumToLocale.call(this, loc === undefined || loc === null ? locale : loc, opts);
      });
    }
  }

  /* ==================== ГЕОЛОКАЦИЯ ==================== */
  const coords = cfg && cfg.coords;
  if (coords && isFinite(coords.lat) && isFinite(coords.lon) &&
      typeof navigator !== 'undefined' && navigator.geolocation) {
    try {
      const geo = navigator.geolocation;
      const GeoProto = Object.getPrototypeOf(geo);
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
          timestamp: Date.now()
        };
      };

      /**
       * Сначала дёргаем настоящий API, чтобы сохранить обычный запрос
       * разрешения у пользователя. Явный отказ уважаем, прочие сбои
       * (нет сервиса геопозиции, таймаут) подменяем своими координатами.
       */
      const wrap = function (native) {
        return function (success, error, options) {
          if (typeof success !== 'function') {
            throw new TypeError("Failed to execute on 'Geolocation': parameter 1 is not of type 'Function'.");
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
        if (n in window) {
          Object.defineProperty(window, n, { value: undefined, writable: true, enumerable: false, configurable: true });
        }
      } catch (e) { /* noop */ }
    });
    try {
      if (navigator.mediaDevices) {
        defMethod(MediaDevices.prototype, 'enumerateDevices', function () { return Promise.resolve([]); });
      }
    } catch (e) { /* noop */ }
  }
}

/** Сборка самовыполняющегося кода для chrome.userScripts.register */
export function buildUserScriptCode(cfg) {
  return '(' + spoofMain.toString() + ')(' + JSON.stringify(cfg) + ');';
}
