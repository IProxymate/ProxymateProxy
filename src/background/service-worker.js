import { getState, setState, normalizeProfile, newProfileId, DEFAULT_SETTINGS } from '../lib/storage.js';
import { detectGeo, probeGeo, PROBE_HOST } from '../lib/geo.js';
import {
  applyAll, applyProbePac, injectFallback, userScriptsAvailable,
  setBadge, clearProxy, readDiagnostics, isHostBypassed
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
  await reapply(state);
  scheduleUpdateChecks();
});

chrome.runtime.onStartup.addListener(async () => {
  await reapply(await getState());
  scheduleUpdateChecks();
});

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

async function apply(profile, settings) {
  applyDepth++;
  try {
    return await applyAll(profile, settings);
  } finally {
    setTimeout(() => { applyDepth = Math.max(0, applyDepth - 1); }, 700);
  }
}

async function reapply(state) {
  const s = state || (await getState());
  const profile = s.activeId ? s.profiles.find((p) => p.id === s.activeId) : null;
  await apply(profile || null, s.settings);
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
    if (isProbeRequest(details.url)) {
      callback(probe.username
        ? { authCredentials: { username: probe.username, password: probe.password } }
        : {});
      return;
    }
    const tries = (authAttempts.get(details.requestId) || 0) + 1;
    authAttempts.set(details.requestId, tries);
    if (tries > 2) {
      authAttempts.delete(details.requestId);
      callback({ cancel: true });
      notifyAuthFailure();
      return;
    }
    getState().then((s) => {
      const profile = s.activeId ? s.profiles.find((p) => p.id === s.activeId) : null;
      if (profile && profile.username) {
        callback({ authCredentials: { username: profile.username, password: profile.password } });
      } else {
        callback({});
      }
    }).catch(() => callback({}));
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

// Service worker выгружается между запросами, поэтому факт «через прокси уже
// что-то прошло» переживает перезапуск в session storage.
chrome.storage.session.get('successCount')
  .then((v) => { successSinceConnect = v.successCount || 0; })
  .catch(() => {});

chrome.webRequest.onCompleted.addListener(
  (d) => {
    authAttempts.delete(d.requestId);
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

    if (!proxyClass || forProbe) return;

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
  chrome.action.setBadgeText({ text: '!' });
  chrome.action.setBadgeBackgroundColor({ color: '#dc2626' });
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
  .then((v) => { if (v.health) health = v.health; })
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

async function setHealth(state, code, detail) {
  if (health.state === state && health.code === code) return;
  const changed = health.state !== state;
  health = { state, code: code || null, detail: detail || null, ts: Date.now() };
  await chrome.storage.session.set({ health });
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

/* Чужое вмешательство в настройки прокси ловим событием, без опроса. */
chrome.proxy.settings.onChange.addListener((details) => {
  if (applyDepth > 0) return;   // это наша собственная запись
  handleControlChange(details.levelOfControl).catch(() => {});
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
/*  Сообщения от popup / options / страницы теста                      */
/* ------------------------------------------------------------------ */

const handlers = {
  async getState() {
    const s = await getState();
    const session = await chrome.storage.session.get(['lastError']);
    const local = await chrome.storage.local.get('updateInfo');
    return Object.assign({}, s, {
      lastError: session.lastError || null,
      userScripts: userScriptsAvailable(),
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

    const s = await getState();
    const current = s.activeId ? s.profiles.find((x) => x.id === s.activeId) : null;
    const started = Date.now();

    probe = { host: PROBE_HOST, username: p.username, password: p.password };
    applyDepth++;   // чужим вмешательством это не считается
    try {
      await applyProbePac(p, current || null, PROBE_HOST);
      const geo = await probeGeo(12000);
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
      // Восстанавливаем прежнее состояние при любом исходе.
      try { await apply(current || null, s.settings); } catch (err) { /* см. диагностику */ }
      setTimeout(() => { applyDepth = Math.max(0, applyDepth - 1); }, 700);
    }
  },

  async connect({ id }) {
    const s = await getState();
    const profile = s.profiles.find((p) => p.id === id);
    if (!profile) throw new Error('Профиль не найден');

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

    if (!s.settings.autoCheckOnConnect) return { ok: true, profile, applyErrors: applied.errors };

    // Определяем гео уже через прокси и, если профиль в авто-режиме,
    // перенастраиваем язык/таймзону под выходной узел.
    try {
      const geo = await detectGeo();
      const updated = Object.assign({}, profile, { detected: geo });
      const profiles = s.profiles.map((p) => (p.id === id ? updated : p));
      await setState({ profiles, lastCheck: geo });
      if ((profile.spoofMode || 'auto') === 'auto') await apply(updated, s.settings);
      return { ok: true, profile: updated, geo };
    } catch (e) {
      await chrome.storage.session.set({ lastError: e.message });
      return { ok: true, profile, geoError: e.message };
    }
  },

  async disconnect() {
    await setState({ activeId: null });
    await apply(null, (await getState()).settings);
    recentErrors.length = 0;
    failStreak = 0;
    await setHealth('ok');
    await chrome.storage.session.remove(['lastError', 'applyErrors', 'recentErrors', 'successCount']);
    return { ok: true };
  },

  /** Ручное переприменение настроек — например, чтобы вернуть себе контроль. */
  async reapplyNow() {
    failStreak = 0;
    await reapply();
    const level = (await chrome.proxy.settings.get({})).levelOfControl;
    await handleControlChange(level);
    return { ok: true, levelOfControl: level, health };
  },

  async check() {
    // Гео-сервис и проба используют один хост — параллельно они бы мешали.
    if (probe) throw new Error('Идёт проверка прокси, повторите через несколько секунд');
    const s = await getState();
    // Помечаем, в каком режиме сделан замер: иначе при отключённом прокси
    // popup показывал бы старые данные выходного узла как «текущие».
    const geo = Object.assign(await detectGeo(), {
      viaProxy: !!s.activeId,
      profileId: s.activeId || null
    });
    const patch = { lastCheck: geo };
    if (s.activeId) {
      patch.profiles = s.profiles.map((p) => (p.id === s.activeId ? Object.assign({}, p, { detected: geo }) : p));
      const active = patch.profiles.find((p) => p.id === s.activeId);
      if (active && (active.spoofMode || 'auto') === 'auto') await apply(active, s.settings);
      else await setBadge(geo.countryCode || 'ON');
    }
    await setState(patch);
    return geo;
  },

  /** Добавить/убрать сайт из списка обхода прямо из popup. */
  async toggleBypass({ host }) {
    if (!host) throw new Error('Не указан хост');
    const s = await getState();
    const list = s.settings.bypassList || [];
    const both = [host, '*.' + host];
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
    return { ok: true, settings: merged };
  },

  async resetAll() {
    await setState({ activeId: null });
    await clearProxy();
    await apply(null, DEFAULT_SETTINGS);
    failStreak = 0;
    await setHealth('ok');
    await setBadge(null);
    return { ok: true };
  }
};

chrome.runtime.onMessage.addListener((msg, sender, sendResponse) => {
  const handler = handlers[msg && msg.type];
  if (!handler) {
    sendResponse({ error: 'Неизвестная команда: ' + (msg && msg.type) });
    return false;
  }
  Promise.resolve(handler(msg.payload || {}))
    .then((data) => sendResponse({ data }))
    .catch((e) => sendResponse({ error: e.message || String(e) }));
  return true; // асинхронный ответ
});
