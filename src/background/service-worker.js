import { getState, setState, normalizeProfile, newProfileId, DEFAULT_SETTINGS } from '../lib/storage.js';
import { detectGeo, probeGeo, PROBE_HOST } from '../lib/geo.js';
import {
  applyAll, applyProbePac, injectFallback, userScriptsAvailable,
  setBadge, clearProxy, readDiagnostics, isHostBypassed, bypassHost,
  setKillSwitch, killSwitchActive
} from '../lib/apply.js';
import { checkForUpdate } from '../lib/update.js';

/* ------------------------------------------------------------------ */
/*  Инициализация / восстановление состояния                           */
/* ------------------------------------------------------------------ */

chrome.runtime.onInstalled.addListener(async (details) => {
  const state = await getState();
  if (details.reason === 'install') {
    await setState({ settings: DEFAULT_SETTINGS });
  }
  await serial(() => reapply(state));
  await checkControl();
  scheduleUpdateChecks();
});

chrome.runtime.onStartup.addListener(async () => {
  await serial(() => reapply());
  await checkControl();
  scheduleUpdateChecks();
});

/**
 * Кто сейчас управляет прокси — проверка по факту, а не по событию.
 * Идёт через очередь: иначе она могла бы попасть между записью activeId
 * и применением прокси в connect и поднять ложную тревогу «прокси сброшен».
 */
function checkControl() {
  return serial(async () => {
    const level = (await chrome.proxy.settings.get({})).levelOfControl;
    await handleControlChange(level);
  }).catch(() => { /* noop */ });
}

let controlTimer = null;
/** Отложенная проверка: событие пришло, пока шла наша собственная запись. */
function scheduleControlCheck() {
  clearTimeout(controlTimer);
  controlTimer = setTimeout(() => {
    controlTimer = null;
    if (applyDepth > 0) scheduleControlCheck();
    else checkControl();
  }, 800);
}

/* ------------------------------------------------------------------ */
/*  Проверка обновлений на GitHub — раз в сутки + вручную из настроек  */
/* ------------------------------------------------------------------ */

const UPDATE_ALARM = 'proxymate-update-check';

function scheduleUpdateChecks() {
  chrome.alarms.create(UPDATE_ALARM, { delayInMinutes: 3, periodInMinutes: 24 * 60 });
}

async function notifyUpdate(info) {
  const { updateNotifiedVersion } = await chrome.storage.local.get('updateNotifiedVersion');
  if (updateNotifiedVersion === info.latest) return;
  await chrome.storage.local.set({ updateNotifiedVersion: info.latest });
  try {
    await chrome.notifications.create('proxymate-update', {
      type: 'basic',
      iconUrl: chrome.runtime.getURL('icons/icon128.png'),
      title: 'Proxymate Proxy: доступно обновление',
      message: `Версия ${info.latest} доступна (у вас ${info.current}). Нажмите, чтобы открыть релиз.`
    });
  } catch (e) { /* системные уведомления могут быть выключены */ }
}

async function runUpdateCheck() {
  try {
    const info = await checkForUpdate();
    const record = Object.assign({}, info, { checkedAt: Date.now(), error: null });
    await chrome.storage.local.set({ updateInfo: record });
    if (info.hasUpdate) await notifyUpdate(record);
    return record;
  } catch (e) {
    const record = { checkedAt: Date.now(), error: e.message };
    await chrome.storage.local.set({ updateInfo: record });
    return record;
  }
}

chrome.alarms.onAlarm.addListener((alarm) => {
  if (alarm.name === UPDATE_ALARM) runUpdateCheck();
});

chrome.notifications.onClicked.addListener(async (id) => {
  if (id !== 'proxymate-update') return;
  const { updateInfo } = await chrome.storage.local.get('updateInfo');
  if (updateInfo && updateInfo.url) chrome.tabs.create({ url: updateInfo.url });
  chrome.notifications.clear(id);
});

/**
 * Наши собственные записи в chrome.proxy тоже поднимают settings.onChange.
 * Счётчик позволяет отличить их от чужого вмешательства и не поднимать
 * ложную тревогу. Обнуляется с задержкой, потому что событие асинхронное.
 */
let applyDepth = 0;

/**
 * Номер последней записи в chrome.proxy. Проба сравнивает его до и после
 * запроса: если за это время конфиг переписали, результат пробы недостоверен.
 */
let applyGen = 0;

/** Наша собственная запись в настройки браузера. */
async function ownWrite(fn) {
  applyDepth++;
  applyGen++;
  try {
    return await fn();
  } finally {
    setTimeout(() => { applyDepth = Math.max(0, applyDepth - 1); }, 700);
  }
}

function apply(profile, settings) {
  return ownWrite(() => applyAll(profile, settings));
}

async function reapply(state) {
  const s = state || (await getState());
  const profile = s.activeId ? s.profiles.find((p) => p.id === s.activeId) : null;
  await apply(profile || null, s.settings);
}

/**
 * Очередь операций, меняющих состояние и настройки браузера.
 *
 * applyAll — это несколько асинхронных шагов. Без очереди две операции
 * (например, «отключить» и запоздавшее переприменение после определения
 * гео) перемешивались, и прокси оставался включённым при activeId === null:
 * popup показывал «прямое соединение», кнопка «Отключить» была неактивна,
 * а трафик шёл в мёртвый прокси до перезапуска браузера.
 *
 * Долгие сетевые запросы (гео, проба) внутри очереди не выполняются —
 * иначе «Отключить» ждал бы их таймаута.
 */
let opChain = Promise.resolve();

/**
 * Предохранитель: зависший вызов API не должен навсегда заблокировать
 * очередь — иначе перестали бы работать и «Отключить», и всё остальное.
 * Обычная операция занимает доли секунды.
 */
const SERIAL_WAIT_MS = 15000;

function serial(fn) {
  const prev = opChain;
  const run = new Promise((resolve) => {
    const t = setTimeout(() => {
      console.warn('[proxymate] предыдущая операция зависла — продолжаю без неё');
      resolve();
    }, SERIAL_WAIT_MS);
    prev.then(() => { clearTimeout(t); resolve(); });
  }).then(() => fn());
  opChain = run.catch(() => {});
  return run;
}

/**
 * Номер «подключения»: растёт при каждой смене активного профиля.
 * Асинхронное продолжение (гео после connect, check) сверяет его, прежде чем
 * что-то применять, и отказывается, если пользователь уже переключился.
 */
let epoch = 0;
const STALE_MSG = 'Подключение сменилось во время проверки — повторите';

/**
 * Страховка от рассинхрона: настройки прокси должны соответствовать activeId.
 * Если профиль не активен, а наш прокси в браузере стоит, — снимаем его.
 * Если профиль активен, но остался PAC от прерванной пробы, — переприменяем.
 * Вызывается при старте service worker'а и при каждом открытии popup/настроек.
 */
function reconcileProxy() {
  return serial(async () => {
    if (probe) return false;
    const s = await getState();
    const cur = await chrome.proxy.settings.get({});
    if (cur.levelOfControl !== 'controlled_by_this_extension') return false;
    const mode = cur.value && cur.value.mode;
    if (!s.activeId && mode !== 'direct' && mode !== 'system') {
      console.warn('[proxymate] прокси стоял без активного профиля — снимаю');
      await apply(null, s.settings);
      return true;
    }
    if (s.activeId && mode === 'pac_script') {
      console.warn('[proxymate] остался PAC прерванной пробы — переприменяю');
      await reapply(s);
      return true;
    }
    return false;
  }).catch((e) => { console.warn('[proxymate] сверка не удалась:', e); return false; });
}

/* ------------------------------------------------------------------ */
/*  Авторизация на прокси                                              */
/* ------------------------------------------------------------------ */

/** requestId -> число попыток, защита от бесконечного цикла при неверном пароле */
const authAttempts = new Map();

/**
 * Активная проба добавляемого прокси: {host, username, password}.
 * Пока она идёт, запросы к probe.host обслуживает проверяемый прокси, поэтому
 * и учётные данные, и ошибки для них берутся отдельно от активного профиля.
 */
let probe = null;

const isProbeRequest = (url) => {
  if (!probe) return false;
  try { return new URL(url).hostname === probe.host; } catch (e) { return false; }
};

chrome.webRequest.onAuthRequired.addListener(
  (details, callback) => {
    if (!details.isProxy) {
      callback({});
      return;
    }
    // Проба идёт через другой прокси — и логин/пароль у неё свои.
    const tries = (authAttempts.get(details.requestId) || 0) + 1;
    authAttempts.set(details.requestId, tries);

    if (isProbeRequest(details.url)) {
      // Неверный пароль у пробы иначе крутился бы до её таймаута.
      if (tries > 2 || !probe.username) {
        authAttempts.delete(details.requestId);
        callback(tries > 2 ? { cancel: true } : {});
        return;
      }
      callback({ authCredentials: { username: probe.username, password: probe.password } });
      return;
    }
    if (tries > 2) {
      authAttempts.delete(details.requestId);
      callback({ cancel: true });
      notifyAuthFailure();
      return;
    }

    // asyncBlocking: если callback не вызвать, запрос висит вечно, а вместе
    // с ним и соединения через прокси. Поэтому ответ гарантирован:
    // ровно один раз и не позже чем через 5 секунд.
    let answered = false;
    const reply = (v) => { if (!answered) { answered = true; callback(v); } };
    const guard = setTimeout(() => reply({ cancel: true }), 5000);
    getState().then((s) => {
      const profile = s.activeId ? s.profiles.find((p) => p.id === s.activeId) : null;
      if (profile && profile.username) {
        reply({ authCredentials: { username: profile.username, password: profile.password } });
      } else {
        reply({});
      }
    }).catch(() => reply({})).finally(() => clearTimeout(guard));
  },
  { urls: ['<all_urls>'] },
  ['asyncBlocking']
);

/**
 * Число успешных запросов с момента подключения. Пока оно нулевое, ошибка
 * прокси-класса означает «прокси не работает». Как только хоть что-то
 * прошло, такие же ошибки — проблема конкретного сайта, а не туннеля.
 */
let successSinceConnect = 0;

/**
 * Активный профиль и список обхода в памяти: onCompleted срабатывает на
 * каждый запрос, читать хранилище там слишком дорого.
 */
const live = { activeId: null, bypassList: [] };
getState()
  .then((s) => { live.activeId = s.activeId; live.bypassList = s.settings.bypassList || []; })
  .catch(() => {});
chrome.storage.onChanged.addListener((changes, area) => {
  if (area !== 'local') return;
  if (changes.activeId) live.activeId = changes.activeId.newValue ?? null;
  if (changes.settings) live.bypassList = (changes.settings.newValue && changes.settings.newValue.bypassList) || [];
});

/**
 * Запрос шёл через туннель? Сайты из списка обхода и локальные адреса
 * идут напрямую: их успех ничего не говорит о живости прокси, а раньше
 * он обнулял серию отказов и тревога «прокси не отвечает» не поднималась.
 */
function viaTunnel(url) {
  if (!live.activeId) return false;
  let u;
  try { u = new URL(url); } catch (e) { return false; }
  if (!/^(https?|wss?):$/.test(u.protocol)) return false;
  const h = u.hostname;
  if (live.bypassList.includes('<local>') && (!h.includes('.') || h.startsWith('['))) return false;
  return !isHostBypassed(h, live.bypassList);
}

// Service worker выгружается между запросами, поэтому факт «через прокси уже
// что-то прошло» переживает перезапуск в session storage.
chrome.storage.session.get('successCount')
  .then((v) => { successSinceConnect = v.successCount || 0; })
  .catch(() => {});

chrome.webRequest.onCompleted.addListener(
  (d) => {
    authAttempts.delete(d.requestId);
    // Ответ из кэша и запросы мимо прокси о живости туннеля ничего не говорят.
    if (d.fromCache || !viaTunnel(d.url)) return;
    if (d.statusCode >= 200 && d.statusCode < 400) {
      if (successSinceConnect === 0) {
        chrome.storage.session.remove('lastError');
        chrome.storage.session.set({ successCount: 1 });
      }
      successSinceConnect++;
      // Любой успех означает, что туннель жив: серия отказов прервана.
      failStreak = 0;
      if (health.state === 'failing') setHealth('ok').catch(() => {});
    }
  },
  { urls: ['<all_urls>'] }
);

/* ------------------------------------------------------------------ */
/*  Перехват сетевых ошибок — главный источник правды о том,           */
/*  почему страницы не грузятся                                        */
/* ------------------------------------------------------------------ */

/** Расшифровка кодов net::ERR_*, которые реально относятся к прокси. */
const NET_ERROR_HINTS = {
  'net::ERR_PROXY_CONNECTION_FAILED': 'Не удалось подключиться к самому прокси — проверьте хост, порт и что прокси жив.',
  'net::ERR_TUNNEL_CONNECTION_FAILED': 'Прокси отказал в CONNECT. Обычно это неверный логин/пароль либо прокси не разрешает HTTPS.',
  'net::ERR_PROXY_AUTH_UNSUPPORTED': 'Прокси требует схему авторизации, которую Chrome не поддерживает для расширений.',
  'net::ERR_UNEXPECTED_PROXY_AUTH': 'Прокси запросил авторизацию там, где она не ожидалась.',
  'net::ERR_SOCKS_CONNECTION_FAILED': 'SOCKS-прокси отклонил соединение. Напоминание: SOCKS с логином/паролем Chrome для расширений не поддерживает.',
  'net::ERR_SOCKS_CONNECTION_HOST_UNREACHABLE': 'SOCKS-прокси не смог достучаться до целевого хоста.',
  // Ниже — коды, которые чаще относятся к конкретному сайту. Подсказка
  // упоминает прокси только как одну из версий, а не как диагноз.
  'net::ERR_CONNECTION_TIMED_OUT': 'Таймаут соединения. Если это повторяется на всех сайтах — проверьте прокси.',
  'net::ERR_CONNECTION_REFUSED': 'Соединение отклонено. На всех сайтах сразу — вероятно, неверный порт прокси.',
  'net::ERR_NAME_NOT_RESOLVED': 'Имя хоста не разрешилось.',
  'net::ERR_EMPTY_RESPONSE': 'Соединение разорвано без ответа. На всех сайтах — частый признак неверного протокола (HTTP вместо SOCKS5 или наоборот).',
  'net::ERR_SSL_PROTOCOL_ERROR': 'Ошибка TLS. Если выбран протокол HTTPS, а прокси обычный — вернитесь на HTTP.'
};

/** Ошибка уровня туннеля, а не конкретного сайта? */
function isProxyClass(error) {
  return /^net::ERR_(PROXY|TUNNEL|SOCKS|UNEXPECTED_PROXY)/.test(error);
}

/** Кольцевой буфер последних сетевых ошибок. */
const recentErrors = [];

chrome.webRequest.onErrorOccurred.addListener(
  (d) => {
    authAttempts.delete(d.requestId);
    if (d.error === 'net::ERR_ABORTED' || d.error === 'net::ERR_BLOCKED_BY_CLIENT') return;

    const proxyClass = isProxyClass(d.error);
    // Сбой пробы относится к проверяемому прокси, а не к рабочему туннелю.
    const forProbe = isProbeRequest(d.url);
    recentErrors.unshift({
      error: d.error,
      hint: NET_ERROR_HINTS[d.error] || null,
      kind: forProbe ? 'probe' : (proxyClass ? 'proxy' : 'site'),
      url: d.url.slice(0, 120),
      type: d.type,
      ts: Date.now()
    });
    recentErrors.length = Math.min(recentErrors.length, 12);
    chrome.storage.session.set({ recentErrors });

    if (!proxyClass || forProbe || !viaTunnel(d.url)) return;

    // Тревожим пользователя только если через прокси ещё вообще ничего
    // не прошло. Иначе это сломанный сайт, а не сломанный туннель.
    if (successSinceConnect === 0) {
      chrome.storage.session.set({
        lastError: d.error + (NET_ERROR_HINTS[d.error] ? ' — ' + NET_ERROR_HINTS[d.error] : '')
      });
    }

    // Серия отказов подряд без единого успеха между ними — туннель лёг.
    failStreak++;
    if (failStreak >= FAIL_THRESHOLD && health.state === 'ok') {
      setHealth('failing', d.error, NET_ERROR_HINTS[d.error] || null).catch(() => {});
    }
  },
  { urls: ['<all_urls>'] }
);

let lastAuthWarning = 0;
function notifyAuthFailure() {
  const now = Date.now();
  if (now - lastAuthWarning < 10000) return;
  lastAuthWarning = now;
  chrome.storage.session.set({ lastError: 'Прокси отклонил логин/пароль' });
  setHealth('failing', null, 'Прокси отклонил логин/пароль — проверьте учётные данные профиля.').catch(() => {});
}

/* ------------------------------------------------------------------ */
/*  Ошибки прокси                                                      */
/* ------------------------------------------------------------------ */

/* ------------------------------------------------------------------ */
/*  Состояние соединения: только детект и сигнал                       */
/*  Прокси никогда не снимается автоматически — иначе видимая ошибка   */
/*  превратилась бы в незаметный слив реального IP.                    */
/* ------------------------------------------------------------------ */

/** Сколько подряд идущих отказов туннеля считать поломкой. */
const FAIL_THRESHOLD = 3;

/** Отказы туннеля подряд, без единого успешного запроса между ними. */
let failStreak = 0;

/**
 * 'ok'       — всё в порядке
 * 'failing'  — туннель стабильно отказывает
 * 'hijacked' — настройками прокси управляет другое расширение
 * 'cleared'  — наши настройки сброшены, трафик идёт напрямую
 */
let health = { state: 'ok', code: null, detail: null, ts: 0 };

chrome.storage.session.get('health')
  .then((v) => { if (v.health && (v.health.ts || 0) > health.ts) health = v.health; })
  .catch(() => {});

const HEALTH_TEXT = {
  failing: {
    title: 'Прокси не отвечает',
    body: 'Страницы не загружаются. Проверьте профиль или отключите прокси.'
  },
  hijacked: {
    title: 'Настройками прокси управляет другое расширение',
    body: 'Ваш трафик может идти не через выбранный прокси. Отключите конкурирующее расширение.'
  },
  cleared: {
    title: 'Прокси сброшен',
    body: 'Настройки прокси снял кто-то извне — трафик идёт напрямую, ваш реальный IP виден сайтам.'
  }
};

let lastNotifyTs = 0;

/**
 * Включает блокировку трафика, когда прокси перехвачен или снят извне и
 * профиль при этом активен; снимает её во всех остальных случаях.
 * При «failing» блокировка не нужна: мёртвый прокси и так не пускает трафик.
 */
async function syncKillSwitch() {
  try {
    const s = await getState();
    const on = !!(s.activeId && s.settings.killSwitch &&
      (health.state === 'hijacked' || health.state === 'cleared'));
    if (on !== (await killSwitchActive())) await setKillSwitch(on);
  } catch (e) {
    console.warn('[proxymate] не удалось переключить блокировку трафика:', e);
  }
}

async function setHealth(state, code, detail) {
  if (health.state === state && health.code === code) return;
  const changed = health.state !== state;
  health = { state, code: code || null, detail: detail || null, ts: Date.now() };
  await chrome.storage.session.set({ health });
  await syncKillSwitch();
  await refreshBadge();

  if (state === 'ok') {
    try { await chrome.notifications.clear('proxymate-health'); } catch (e) { /* noop */ }
    return;
  }
  if (changed) await notifyHealth(state, code);
}

async function notifyHealth(state, code) {
  const now = Date.now();
  if (now - lastNotifyTs < 60000) return;   // не спамим при шторме ошибок
  lastNotifyTs = now;
  const text = HEALTH_TEXT[state];
  if (!text) return;
  try {
    await chrome.notifications.create('proxymate-health', {
      type: 'basic',
      iconUrl: chrome.runtime.getURL('icons/icon128.png'),
      title: text.title,
      message: (code ? code + '\n' : '') + text.body,
      priority: 2
    });
  } catch (e) {
    console.warn('[proxymate] уведомление не показано:', e.message);
  }
}

chrome.notifications.onClicked.addListener((id) => {
  if (id === 'proxymate-health') chrome.runtime.openOptionsPage();
});

/** Значок: код страны в норме, красный «!» при проблеме. */
async function refreshBadge() {
  const s = await getState();
  if (!s.activeId) return setBadge(null);
  if (health.state !== 'ok') {
    try {
      await chrome.action.setBadgeText({ text: '!' });
      await chrome.action.setBadgeBackgroundColor({ color: '#dc2626' });
    } catch (e) { /* noop */ }
    return;
  }
  const p = s.profiles.find((x) => x.id === s.activeId);
  await setBadge(p?.detected?.countryCode || 'ON');
}

/*
 * Чужое вмешательство в настройки прокси ловим событием, без опроса.
 * Событие во время нашей записи раньше просто отбрасывалось — и перехват,
 * случившийся в эти 700 мс, оставался незамеченным. Теперь оно откладывается
 * до окончания записи и перепроверяется по фактическому состоянию.
 */
chrome.proxy.settings.onChange.addListener(() => {
  if (applyDepth > 0) scheduleControlCheck();
  else checkControl();
});

async function handleControlChange(level) {
  const s = await getState();
  if (!s.activeId) {
    if (health.state !== 'ok') await setHealth('ok');
    return;
  }
  if (level === 'controlled_by_other_extensions' || level === 'not_controllable') {
    await setHealth('hijacked', level);
  } else if (level === 'controllable_by_this_extension') {
    await setHealth('cleared', level);
  } else if (health.state === 'hijacked' || health.state === 'cleared') {
    await setHealth('ok');
  }
}

chrome.proxy.onProxyError.addListener((err) => {
  console.warn('[proxymate] proxy error:', err);
  if (successSinceConnect > 0) return;
  chrome.storage.session.set({
    lastError: err.error + (err.details ? ': ' + err.details : '')
  });
});

/* ------------------------------------------------------------------ */
/*  Фоллбэк-инжект, если chrome.userScripts недоступен                 */
/* ------------------------------------------------------------------ */

chrome.webNavigation.onCommitted.addListener(async (details) => {
  if (userScriptsAvailable()) return;
  if (!/^https?:/.test(details.url)) return;
  const { spoofConfig, spoofBypassList } = await chrome.storage.session.get(['spoofConfig', 'spoofBypassList']);
  if (!spoofConfig) return;
  try {
    if (isHostBypassed(new URL(details.url).hostname, spoofBypassList)) return;
  } catch (e) { /* noop */ }
  try {
    await injectFallback(details.tabId, details.frameId, spoofConfig);
  } catch (e) { /* страница могла закрыться */ }
});

/* ------------------------------------------------------------------ */
/*  Определение гео выходного узла после подключения                   */
/* ------------------------------------------------------------------ */

/** Текущее фоновое определение гео: {epoch, promise}. */
let geoTask = null;

/**
 * Сохраняет замер; для активного профиля в авто-режиме перенастраивает
 * язык и зону. Вызывается только внутри serial().
 */
async function storeGeo(s, geo) {
  const patch = { lastCheck: geo };
  if (s.activeId) {
    patch.profiles = s.profiles.map((p) => (p.id === s.activeId ? Object.assign({}, p, { detected: geo }) : p));
  }
  await setState(patch);
  const active = patch.profiles && patch.profiles.find((p) => p.id === s.activeId);
  if (active && (active.spoofMode || 'auto') === 'auto') await apply(active, s.settings);
  else await refreshBadge();
}

function startGeoTask(myEpoch, id) {
  const promise = (async () => {
    let geo;
    try {
      geo = await detectGeo();
    } catch (e) {
      if (myEpoch === epoch) await chrome.storage.session.set({ lastError: e.message });
      throw e;
    }
    return serial(async () => {
      // Пользователь успел отключиться или выбрать другой профиль:
      // применять устаревший результат нельзя — он бы снова включил прокси.
      if (myEpoch !== epoch) throw new Error(STALE_MSG);
      const s = await getState();
      if (s.activeId !== id) throw new Error(STALE_MSG);
      const marked = Object.assign(geo, { viaProxy: true, profileId: id });
      await storeGeo(s, marked);
      return marked;
    });
  })();
  geoTask = { epoch: myEpoch, promise };
  promise
    .catch(() => {})
    .finally(() => { if (geoTask && geoTask.promise === promise) geoTask = null; });
  return promise;
}

/* ------------------------------------------------------------------ */
/*  Сообщения от popup / options / страницы теста                      */
/* ------------------------------------------------------------------ */

const handlers = {
  async getState() {
    await reconcileProxy();
    const s = await getState();
    const session = await chrome.storage.session.get(['lastError']);
    const local = await chrome.storage.local.get('updateInfo');
    return Object.assign({}, s, {
      lastError: session.lastError || null,
      userScripts: userScriptsAvailable(),
      killSwitchOn: await killSwitchActive(),
      health,
      updateInfo: local.updateInfo || null
    });
  },

  /** Ручная проверка обновлений — кнопка в настройках. */
  async checkUpdate() {
    return runUpdateCheck();
  },

  async diagnostics() {
    const diag = await readDiagnostics();
    const session = await chrome.storage.session.get(['lastError', 'recentErrors', 'applyErrors']);
    return Object.assign(diag, {
      lastError: session.lastError || null,
      applyErrors: session.applyErrors || [],
      recentErrors: session.recentErrors || recentErrors,
      successCount: successSinceConnect,
      health,
      failStreak
    });
  },

  async dismissError() {
    await chrome.storage.session.remove('lastError');
    return { ok: true };
  },

  /** Список открытых http/https-вкладок для выбора цели проверки. */
  async listWebTabs() {
    const tabs = await chrome.tabs.query({ url: ['http://*/*', 'https://*/*'] });
    return tabs.map((t) => ({
      id: t.id,
      title: t.title || t.url,
      host: (() => { try { return new URL(t.url).hostname; } catch (e) { return t.url; } })(),
      active: t.active
    }));
  },

  /** Прямая проверка проходимости прокси без гео-сервисов. */
  async testProxy() {
    const started = Date.now();
    try {
      const ctrl = new AbortController();
      const timer = setTimeout(() => ctrl.abort(), 12000);
      const res = await fetch('https://www.gstatic.com/generate_204', {
        cache: 'no-store', credentials: 'omit', signal: ctrl.signal
      });
      clearTimeout(timer);
      return { ok: true, status: res.status, ms: Date.now() - started };
    } catch (e) {
      const net = recentErrors[0];
      return {
        ok: false,
        ms: Date.now() - started,
        message: e.name === 'AbortError' ? 'Таймаут 12 с — прокси не ответил' : e.message,
        netError: net && Date.now() - net.ts < 20000 ? net : null
      };
    }
  },

  /**
   * Проверка произвольного профиля без его сохранения и без разрыва текущего
   * соединения: пробный хост уводится на проверяемый прокси PAC-скриптом,
   * весь остальной трафик остаётся там же, где был.
   */
  async testProfile({ profile }) {
    if (probe) throw new Error('Проверка уже идёт');
    const p = normalizeProfile(profile);
    if (!p.host || !p.port) throw new Error('Укажите хост и порт');
    if (p.scheme.startsWith('socks') && p.username) {
      return { ok: false, message: 'SOCKS с логином и паролем Chrome не поддерживает — проверять нечего' };
    }

    const started = Date.now();
    probe = { host: PROBE_HOST, username: p.username, password: p.password };
    try {
      const gen = await serial(async () => {
        const s = await getState();
        const current = s.activeId ? s.profiles.find((x) => x.id === s.activeId) : null;
        await ownWrite(() => applyProbePac(p, current || null, PROBE_HOST));
        return applyGen;
      });
      const geo = await probeGeo(12000);
      // Пока шла проба, конфиг переписали (подключение, настройки) —
      // запрос мог уйти не через проверяемый прокси.
      if (applyGen !== gen) {
        return { ok: false, ms: Date.now() - started, message: 'Проверку прервало изменение подключения — повторите' };
      }
      return { ok: true, ms: Date.now() - started, geo };
    } catch (e) {
      const net = recentErrors.find((r) => r.kind === 'probe' && Date.now() - r.ts < 20000);
      return {
        ok: false,
        ms: Date.now() - started,
        message: e.name === 'AbortError' ? 'Таймаут 12 с — прокси не ответил' : e.message,
        netError: net || null
      };
    } finally {
      probe = null;
      // Восстанавливаем состояние из свежего хранилища, а не из снимка на
      // момент старта: пользователь мог за это время подключиться или отключиться.
      await serial(() => reapply()).catch(() => { /* см. диагностику */ });
    }
  },

  /**
   * Подключение отвечает сразу после применения прокси. Определение гео
   * идёт в фоне: с медленным или мёртвым прокси оно занимает до 15 секунд,
   * и всё это время popup был бы заблокирован.
   */
  async connect({ id }) {
    const res = await serial(async () => {
      const s = await getState();
      const profile = s.profiles.find((p) => p.id === id);
      if (!profile) throw new Error('Профиль не найден');

      epoch++;
      await chrome.storage.session.remove(['lastError', 'applyErrors', 'successCount']);
      recentErrors.length = 0;
      successSinceConnect = 0;
      failStreak = 0;
      await setHealth('ok');
      await setState({ activeId: id });
      const applied = await apply(profile, s.settings);
      if (applied.errors.length) {
        await chrome.storage.session.set({ applyErrors: applied.errors, lastError: applied.errors[0] });
      }
      return { profile, settings: s.settings, myEpoch: epoch, applyErrors: applied.errors };
    });

    if (res.settings.autoCheckOnConnect) startGeoTask(res.myEpoch, id);
    return { ok: true, profile: res.profile, applyErrors: res.applyErrors, geoPending: !!res.settings.autoCheckOnConnect };
  },

  async disconnect() {
    await serial(async () => {
      epoch++;
      await setState({ activeId: null });
      await apply(null, (await getState()).settings);
      recentErrors.length = 0;
      failStreak = 0;
      await setHealth('ok');
      await chrome.storage.session.remove(['lastError', 'applyErrors', 'recentErrors', 'successCount']);
    });
    return { ok: true };
  },

  /** Ручное переприменение настроек — например, чтобы вернуть себе контроль. */
  async reapplyNow() {
    return serial(async () => {
      failStreak = 0;
      await reapply();
      const level = (await chrome.proxy.settings.get({})).levelOfControl;
      await handleControlChange(level);
      return { ok: true, levelOfControl: level, health };
    });
  },

  async check() {
    // Гео-сервис и проба используют один хост — параллельно они бы мешали.
    if (probe) throw new Error('Идёт проверка прокси, повторите через несколько секунд');
    const myEpoch = epoch;
    // Сразу после подключения гео уже определяется в фоне — ждём его,
    // а не запускаем второй такой же запрос.
    if (geoTask && geoTask.epoch === myEpoch) return geoTask.promise;

    const geo = await detectGeo();
    return serial(async () => {
      if (myEpoch !== epoch) throw new Error(STALE_MSG);
      const s = await getState();
      // Помечаем, в каком режиме сделан замер: иначе при отключённом прокси
      // popup показывал бы старые данные выходного узла как «текущие».
      const marked = Object.assign(geo, { viaProxy: !!s.activeId, profileId: s.activeId || null });
      await storeGeo(s, marked);
      return marked;
    });
  },

  /** Добавить/убрать сайт из списка обхода прямо из popup. */
  async toggleBypass({ host }) {
    if (!host) throw new Error('Не указан хост');
    const s = await getState();
    const list = s.settings.bypassList || [];
    const d = bypassHost(host);
    const both = [d, '*.' + d];
    const present = both.some((h) => list.includes(h));
    const bypassList = present
      ? list.filter((h) => !both.includes(h))
      : list.concat(both.filter((h) => !list.includes(h)));

    const settings = Object.assign({}, s.settings, { bypassList });
    await setState({ settings });
    const profile = s.activeId ? s.profiles.find((p) => p.id === s.activeId) : null;
    await apply(profile || null, settings);
    return { bypassed: !present, bypassList };
  },

  async saveProfile({ profile }) {
    const s = await getState();
    const norm = normalizeProfile(profile);
    const exists = s.profiles.some((p) => p.id === norm.id);
    const profiles = exists
      ? s.profiles.map((p) => (p.id === norm.id ? Object.assign({}, p, norm) : p))
      : s.profiles.concat([norm]);
    await setState({ profiles });
    if (s.activeId === norm.id) await reapply();
    return { ok: true, profile: norm };
  },

  /** Бэкап профилей и настроек в JSON. */
  async exportData({ withPasswords }) {
    const s = await getState();
    return {
      format: 'proxymate-backup',
      version: 1,
      exportedAt: new Date().toISOString(),
      withPasswords: !!withPasswords,
      settings: s.settings,
      profiles: s.profiles.map((p) => {
        const c = Object.assign({}, p);
        if (!withPasswords) c.password = '';
        delete c.detected;   // кэш гео привязан к моменту, в бэкапе бесполезен
        return c;
      })
    };
  },

  /**
   * @param {object} data содержимое файла
   * @param {boolean} replace заменить всё вместо слияния
   */
  async importData({ data, replace }) {
    if (!data || !Array.isArray(data.profiles)) {
      throw new Error('Файл не похож на бэкап Proxymate: нет списка профилей');
    }
    const s = await getState();
    const incoming = data.profiles.map(normalizeProfile).filter((p) => p.host && p.port);
    if (!incoming.length) throw new Error('В файле нет ни одного валидного профиля');

    if (replace) {
      epoch++;
      await setState({ activeId: null });
      await apply(null, s.settings);
      const settings = data.settings
        ? Object.assign({}, DEFAULT_SETTINGS, data.settings)
        : s.settings;
      await setState({ profiles: incoming, activeId: null, settings });
      return { added: incoming.length, skipped: 0, replaced: true, settings: !!data.settings };
    }

    // слияние: одинаковыми считаем профили с тем же адресом и логином
    const key = (p) => `${p.scheme}://${p.username}@${p.host}:${p.port}`;
    const existing = new Set(s.profiles.map(key));
    const fresh = [];
    let skipped = 0;
    for (const p of incoming) {
      if (existing.has(key(p))) { skipped++; continue; }
      existing.add(key(p));
      fresh.push(Object.assign({}, p, { id: newProfileId() }));
    }
    await setState({ profiles: s.profiles.concat(fresh) });
    return { added: fresh.length, skipped, replaced: false, settings: false };
  },

  async importProfiles({ profiles }) {
    const s = await getState();
    const list = profiles.map(normalizeProfile);
    await setState({ profiles: s.profiles.concat(list) });
    return { ok: true, added: list.length };
  },

  async deleteProfile({ id }) {
    const s = await getState();
    const profiles = s.profiles.filter((p) => p.id !== id);
    const patch = { profiles };
    // Сначала снимаем активность, потом трогаем настройки: иначе onChange
    // увидит сброшенный прокси при ещё живом activeId и решит, что нас сбросили.
    if (s.activeId === id) {
      epoch++;
      patch.activeId = null;
      await setState({ activeId: null });
      await apply(null, s.settings);
      failStreak = 0;
      await setHealth('ok');
    }
    await setState(patch);
    return { ok: true };
  },

  async saveSettings({ settings }) {
    const s = await getState();
    const merged = Object.assign({}, s.settings, settings);
    await setState({ settings: merged });
    const profile = s.activeId ? s.profiles.find((p) => p.id === s.activeId) : null;
    await apply(profile || null, merged);
    await syncKillSwitch();
    return { ok: true, settings: merged };
  },

  async resetAll() {
    epoch++;
    await setState({ activeId: null });
    await ownWrite(() => clearProxy());
    await apply(null, DEFAULT_SETTINGS);
    failStreak = 0;
    await setHealth('ok');
    await setKillSwitch(false).catch(() => {});
    await setBadge(null);
    return { ok: true };
  }
};

/**
 * Обработчики, которые читают-изменяют-применяют состояние целиком.
 * Их выполняем строго по очереди. connect, disconnect, check, testProfile
 * и reapplyNow сами берут очередь только на нужные участки.
 */
const SERIAL_HANDLERS = new Set([
  'toggleBypass', 'saveProfile', 'importData', 'importProfiles',
  'deleteProfile', 'saveSettings', 'resetAll'
]);

chrome.runtime.onMessage.addListener((msg, sender, sendResponse) => {
  const type = msg && msg.type;
  const handler = handlers[type];
  if (!handler) {
    sendResponse({ error: 'Неизвестная команда: ' + type });
    return false;
  }
  const payload = msg.payload || {};
  const run = SERIAL_HANDLERS.has(type)
    ? serial(() => handler(payload))
    : Promise.resolve().then(() => handler(payload));
  run
    .then((data) => sendResponse({ data }))
    .catch((e) => sendResponse({ error: e.message || String(e) }));
  return true; // асинхронный ответ
});

// Service worker мог быть выгружен посреди пробы или в рассинхроне —
// при каждом его старте сверяем настройки прокси с activeId.
reconcileProxy();
