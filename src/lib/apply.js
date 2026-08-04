import { buildAcceptLanguage } from './countries.js';
import { buildUserScriptCode, spoofMain } from './spoof.js';

const DNR_LANG_RULE_ID = 1001;
const USER_SCRIPT_ID = 'proxymate-spoof';

const ALL_RESOURCE_TYPES = [
  'main_frame', 'sub_frame', 'stylesheet', 'script', 'image', 'font', 'object',
  'xmlhttprequest', 'ping', 'csp_report', 'media', 'websocket', 'other'
];

/**
 * Достаёт из bypassList «чистые» домены — без схемы, порта, префикса
 * поддоменов и CIDR/<local> — для declarativeNetRequest и match-паттернов.
 * Поддомены покрываются автоматически (как и делает excludedRequestDomains),
 * так что «*.example.com» и «example.com» после нормализации совпадают.
 */
function bypassDomains(bypassList) {
  const out = new Set();
  for (const raw of bypassList || []) {
    if (!raw) continue;
    let s = String(raw).trim();
    if (!s || s === '<local>' || s.includes('/')) continue;
    s = s.replace(/^[a-z0-9+.-]+:\/\//i, '');
    s = s.replace(/^\*\./, '');
    s = s.split(':')[0];
    if (!s || !/^[a-z0-9.-]+$/i.test(s)) continue;
    out.add(s.toLowerCase());
  }
  return [...out];
}

/** Хост подпадает под какое-либо правило обхода прокси? */
export function isHostBypassed(host, bypassList) {
  if (!host) return false;
  const h = host.toLowerCase();
  return bypassDomains(bypassList).some((d) => h === d || h.endsWith('.' + d));
}

/* ------------------------------------------------------------------ */
/*  Прокси                                                             */
/* ------------------------------------------------------------------ */

export async function applyProxy(profile, settings) {
  if (!profile) return clearProxy();
  const scheme = profile.scheme === 'https' ? 'https' : profile.scheme;
  const config = {
    mode: 'fixed_servers',
    rules: {
      singleProxy: { scheme, host: profile.host, port: Number(profile.port) },
      bypassList: (settings.bypassList || []).filter(Boolean)
    }
  };
  await chrome.proxy.settings.set({ value: config, scope: 'regular' });
}

export async function clearProxy() {
  await chrome.proxy.settings.clear({ scope: 'regular' });
}

/** Схема профиля -> синтаксис PAC. */
function pacLine(p) {
  const kind = { http: 'PROXY', https: 'HTTPS', socks5: 'SOCKS5', socks4: 'SOCKS4' }[p.scheme] || 'PROXY';
  return `${kind} ${p.host}:${Number(p.port)}`;
}

/**
 * Ставит PAC, который отправляет через проверяемый прокси ТОЛЬКО пробный хост,
 * а весь остальной трафик — туда же, куда он шёл до проверки.
 *
 * Направление возможной ошибки выбрано в безопасную сторону: список исключений
 * в PAC не воспроизводится, поэтому на время пробы обходные сайты просто пойдут
 * через прокси. Уйти напрямую при активном профиле они не могут.
 *
 * @param {object} testProfile проверяемый профиль
 * @param {object|null} currentProfile активный сейчас профиль (null — прямое соединение)
 * @param {string} probeHost хост пробного запроса
 */
export async function applyProbePac(testProfile, currentProfile, probeHost) {
  const fallback = currentProfile ? pacLine(currentProfile) : 'DIRECT';
  const data =
    'function FindProxyForURL(url, host) {' +
    `if (host === ${JSON.stringify(probeHost)}) return ${JSON.stringify(pacLine(testProfile))};` +
    `return ${JSON.stringify(fallback)};}`;
  await chrome.proxy.settings.set({
    value: { mode: 'pac_script', pacScript: { data, mandatory: true } },
    scope: 'regular'
  });
}

/* ------------------------------------------------------------------ */
/*  WebRTC (уровень браузера)                                          */
/* ------------------------------------------------------------------ */

export async function applyWebRTCPolicy(policy) {
  try {
    await chrome.privacy.network.webRTCIPHandlingPolicy.set({
      value: policy || 'default',
      scope: 'regular'
    });
  } catch (e) {
    console.warn('[proxymate] не удалось применить политику WebRTC:', e.message);
  }
}

/* ------------------------------------------------------------------ */
/*  Accept-Language через declarativeNetRequest                        */
/* ------------------------------------------------------------------ */

export async function applyAcceptLanguage(languages, bypassList) {
  const value = buildAcceptLanguage(languages);
  const excludedRequestDomains = bypassDomains(bypassList);
  const rules = value
    ? [{
        id: DNR_LANG_RULE_ID,
        priority: 1,
        action: {
          type: 'modifyHeaders',
          requestHeaders: [{ header: 'Accept-Language', operation: 'set', value }]
        },
        condition: {
          resourceTypes: ALL_RESOURCE_TYPES,
          ...(excludedRequestDomains.length ? { excludedRequestDomains } : {})
        }
      }]
    : [];
  await chrome.declarativeNetRequest.updateDynamicRules({
    removeRuleIds: [DNR_LANG_RULE_ID],
    addRules: rules
  });
}

/* ------------------------------------------------------------------ */
/*  Инжект подмены в MAIN-мир                                          */
/* ------------------------------------------------------------------ */

export function userScriptsAvailable() {
  try {
    return !!(chrome.userScripts && typeof chrome.userScripts.register === 'function');
  } catch (e) {
    return false;
  }
}

/** cfg === null -> снять подмену */
export async function applySpoofScript(cfg, bypassList) {
  const active = cfg && (cfg.timeZone || cfg.languages || cfg.coords || cfg.blockWebRTC);

  if (!userScriptsAvailable()) {
    // Фоллбэк живёт в service-worker через webNavigation.onCommitted.
    await chrome.storage.session.set({
      spoofConfig: active ? cfg : null,
      spoofBypassList: active ? (bypassList || []) : null
    });
    return { mode: 'fallback', active: !!active };
  }

  try {
    if (chrome.userScripts.configureWorld) {
      await chrome.userScripts.configureWorld({ messaging: false });
    }
  } catch (e) { /* не критично */ }

  const existing = await chrome.userScripts.getScripts({ ids: [USER_SCRIPT_ID] }).catch(() => []);
  if (!active) {
    if (existing.length) await chrome.userScripts.unregister({ ids: [USER_SCRIPT_ID] });
    await chrome.storage.session.set({ spoofConfig: null, spoofBypassList: null });
    return { mode: 'userScripts', active: false };
  }

  const domains = bypassDomains(bypassList);
  const excludeMatches = domains.flatMap((d) => [`*://${d}/*`, `*://*.${d}/*`]);

  const script = {
    id: USER_SCRIPT_ID,
    matches: ['http://*/*', 'https://*/*'],
    ...(excludeMatches.length ? { excludeMatches } : {}),
    js: [{ code: buildUserScriptCode(cfg) }],
    runAt: 'document_start',
    allFrames: true,
    world: 'MAIN'
  };
  if (existing.length) {
    await chrome.userScripts.update([script]);
  } else {
    await chrome.userScripts.register([script]);
  }
  await chrome.storage.session.set({ spoofConfig: null });
  return { mode: 'userScripts', active: true };
}

/** Используется фоллбэком из service worker'а. */
export function injectFallback(tabId, frameId, cfg) {
  return chrome.scripting.executeScript({
    target: { tabId, frameIds: [frameId] },
    world: 'MAIN',
    injectImmediately: true,
    func: spoofMain,
    args: [cfg]
  });
}

/* ------------------------------------------------------------------ */
/*  Сводное применение состояния                                       */
/* ------------------------------------------------------------------ */

/**
 * @param {object|null} profile активный профиль (null — отключено)
 * @param {object} settings
 */
export async function applyAll(profile, settings) {
  const errors = [];
  /** каждый шаг изолирован: падение одного не должно отменять остальные */
  const step = async (name, fn) => {
    try {
      return await fn();
    } catch (e) {
      console.error(`[proxymate] шаг «${name}» упал:`, e);
      errors.push(`${name}: ${e.message || e}`);
      return null;
    }
  };

  if (!profile) {
    await step('снятие прокси', () => clearProxy());
    await step('Accept-Language', () => applyAcceptLanguage(null));
    await step('инжект', () => applySpoofScript(null));
    await step('WebRTC', () => applyWebRTCPolicy('default'));
    await setBadge(null);
    return { spoof: null, errors };
  }

  // Режим профиля решает, откуда брать значения (и брать ли вообще),
  // глобальные галочки — что из этого разрешено применять.
  const mode = profile.spoofMode || 'auto';
  const det = profile.detected || null;

  let baseTz = null, baseLangs = null, baseCoords = null;
  if (mode === 'auto' && det) {
    baseTz = det.timeZone || null;
    baseLangs = det.languages || null;
    if (Number.isFinite(det.latitude) && Number.isFinite(det.longitude)) {
      baseCoords = { lat: det.latitude, lon: det.longitude };
    }
  } else if (mode === 'manual') {
    baseTz = profile.timeZone || null;
    baseLangs = profile.languages || null;
    if (Number.isFinite(profile.latitude) && Number.isFinite(profile.longitude)) {
      baseCoords = { lat: profile.latitude, lon: profile.longitude };
    }
  }
  // mode === 'off' — всё остаётся null

  const timeZone = settings.spoofTimezone ? baseTz : null;
  const languages = settings.spoofLanguage ? baseLangs : null;
  const coords = settings.spoofGeolocation ? baseCoords : null;
  const headerLangs = settings.spoofAcceptLanguage ? baseLangs : null;

  const cfg = { timeZone, languages, coords, blockWebRTC: !!settings.blockWebRTC };

  await step('прокси', () => applyProxy(profile, settings));
  await step('WebRTC', () => applyWebRTCPolicy(settings.webrtcPolicy));
  await step('Accept-Language', () => applyAcceptLanguage(headerLangs, settings.bypassList));
  await step('инжект', () => applySpoofScript(cfg, settings.bypassList));
  // На значке — код страны выхода: полезнее, чем безликое «ON».
  await setBadge(profile.detected?.countryCode || 'ON');
  return { spoof: cfg, errors };
}

/* ------------------------------------------------------------------ */
/*  Диагностика                                                        */
/* ------------------------------------------------------------------ */

export async function readDiagnostics() {
  const out = {};
  try {
    const p = await chrome.proxy.settings.get({});
    out.proxyLevel = p.levelOfControl;
    out.proxyValue = p.value;
  } catch (e) { out.proxyLevel = 'ошибка: ' + e.message; }

  try {
    const w = await chrome.privacy.network.webRTCIPHandlingPolicy.get({});
    out.webrtcLevel = w.levelOfControl;
    out.webrtcValue = w.value;
  } catch (e) { out.webrtcLevel = 'ошибка: ' + e.message; }

  try {
    const rules = await chrome.declarativeNetRequest.getDynamicRules();
    const lang = rules.find((r) => r.id === DNR_LANG_RULE_ID);
    out.acceptLanguage = lang
      ? lang.action.requestHeaders[0].value
      : 'правило не установлено';
  } catch (e) { out.acceptLanguage = 'ошибка: ' + e.message; }

  out.userScripts = userScriptsAvailable();
  if (out.userScripts) {
    try {
      const s = await chrome.userScripts.getScripts({ ids: [USER_SCRIPT_ID] });
      out.spoofRegistered = s.length > 0;
    } catch (e) { out.spoofRegistered = 'ошибка: ' + e.message; }
  }
  return out;
}

/** @param {string|null|false} label код страны, 'ON' или пусто для «отключено» */
export async function setBadge(label) {
  try {
    await chrome.action.setBadgeText({ text: label ? String(label).slice(0, 4) : '' });
    await chrome.action.setBadgeBackgroundColor({ color: label ? '#16a34a' : '#64748b' });
  } catch (e) { /* noop */ }
}
