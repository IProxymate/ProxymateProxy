export const DEFAULT_SETTINGS = {
  spoofTimezone: true,
  spoofLanguage: true,
  spoofAcceptLanguage: true,
  spoofGeolocation: true,
  /** 'default' | 'default_public_interface_only' | 'disable_non_proxied_udp' */
  webrtcPolicy: 'disable_non_proxied_udp',
  /** полностью вырезать RTCPeerConnection на страницах */
  blockWebRTC: false,
  bypassList: ['localhost', '127.0.0.1', '<local>'],
  autoCheckOnConnect: true
};

const DEFAULT_STATE = {
  profiles: [],
  activeId: null,
  settings: DEFAULT_SETTINGS,
  lastCheck: null
};

export async function getState() {
  const raw = await chrome.storage.local.get(['profiles', 'activeId', 'settings', 'lastCheck']);
  return {
    profiles: Array.isArray(raw.profiles) ? raw.profiles : DEFAULT_STATE.profiles,
    activeId: raw.activeId ?? null,
    settings: Object.assign({}, DEFAULT_SETTINGS, raw.settings || {}),
    lastCheck: raw.lastCheck ?? null
  };
}

export async function setState(patch) {
  await chrome.storage.local.set(patch);
}

export async function getProfiles() {
  return (await getState()).profiles;
}

export async function getActiveProfile() {
  const s = await getState();
  if (!s.activeId) return null;
  return s.profiles.find((p) => p.id === s.activeId) || null;
}

export function newProfileId() {
  return 'p_' + Date.now().toString(36) + '_' + Math.random().toString(36).slice(2, 8);
}

/**
 * Режим подмены у профиля:
 *   'auto'   — зона, язык и координаты берутся из гео по IP прокси
 *   'manual' — берутся из полей профиля
 *   'off'    — для этого профиля не подменяется ничего
 */
export const SPOOF_MODES = ['auto', 'manual', 'off'];

function migrateSpoofMode(p) {
  if (SPOOF_MODES.includes(p.spoofMode)) return p.spoofMode;
  if (p.auto === false) return (p.timeZone || p.languages) ? 'manual' : 'off';
  return 'auto';
}

function num(v) {
  const n = Number(v);
  return Number.isFinite(n) ? n : null;
}

export function normalizeProfile(p) {
  return {
    id: p.id || newProfileId(),
    name: (p.name || '').trim() || `${p.host}:${p.port}`,
    scheme: p.scheme || 'http',
    host: (p.host || '').trim(),
    port: Number(p.port) || 0,
    username: p.username || '',
    password: p.password || '',
    spoofMode: migrateSpoofMode(p),
    timeZone: p.timeZone || null,
    languages: Array.isArray(p.languages) ? p.languages : null,
    latitude: num(p.latitude),
    longitude: num(p.longitude),
    detected: p.detected || null
  };
}

/**
 * Разбор строк вида:
 *   host:port
 *   host:port:user:pass
 *   scheme://user:pass@host:port
 */
export function parseProxyLine(line) {
  const s = line.trim();
  if (!s || s.startsWith('#')) return null;

  const urlMatch = /^(https?|socks4|socks5):\/\/(?:([^:@/]+):([^@/]*)@)?([^:@/]+):(\d+)$/i.exec(s);
  if (urlMatch) {
    return normalizeProfile({
      scheme: urlMatch[1].toLowerCase(),
      username: urlMatch[2] || '',
      password: urlMatch[3] || '',
      host: urlMatch[4],
      port: Number(urlMatch[5])
    });
  }

  const parts = s.split(':');
  if (parts.length === 2) {
    return normalizeProfile({ scheme: 'http', host: parts[0], port: Number(parts[1]) });
  }
  if (parts.length === 4) {
    return normalizeProfile({
      scheme: 'http', host: parts[0], port: Number(parts[1]),
      username: parts[2], password: parts[3]
    });
  }
  return null;
}
