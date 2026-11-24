import { languagesForCountry, timezoneForCountry } from './countries.js';

/**
 * Провайдеры гео-данных по IP. Запрос уходит из service worker'а, а значит —
 * через текущие настройки прокси, поэтому отдаёт данные выходного узла.
 */
const PROVIDERS = [
  {
    name: 'ipwho.is',
    url: 'https://ipwho.is/?fields=ip,success,country,country_code,city,timezone,latitude,longitude',
    parse: (d) => (d && d.success === false ? null : {
      ip: d.ip,
      country: d.country,
      countryCode: d.country_code,
      city: d.city,
      timeZone: d.timezone && (d.timezone.id || d.timezone),
      latitude: d.latitude,
      longitude: d.longitude
    })
  },
  {
    name: 'ipapi.co',
    url: 'https://ipapi.co/json/',
    parse: (d) => (d && !d.error ? {
      ip: d.ip, country: d.country_name, countryCode: d.country_code,
      city: d.city, timeZone: d.timezone,
      latitude: d.latitude, longitude: d.longitude
    } : null)
  },
  {
    name: 'ipinfo.io',
    url: 'https://ipinfo.io/json',
    parse: (d) => {
      if (!d || !d.ip) return null;
      const [lat, lon] = String(d.loc || '').split(',');
      return {
        ip: d.ip, country: d.country, countryCode: d.country, city: d.city,
        timeZone: d.timezone, latitude: lat, longitude: lon
      };
    }
  }
];

/**
 * Хост, по которому PAC-скрипт узнаёт пробный запрос. Через него пойдёт
 * только проверка добавляемого прокси, весь остальной трафик — как обычно.
 */
export const PROBE_HOST = 'ipwho.is';

/** Одиночная проба конкретного прокси: только ipwho.is, без запасных провайдеров. */
export async function probeGeo(timeoutMs) {
  const p = PROVIDERS[0];
  const data = await fetchJson(p.url, timeoutMs || 10000);
  const parsed = p.parse(data);
  if (!parsed || !parsed.ip) throw new Error('прокси ответил, но данные не разобрались');
  const cc = parsed.countryCode ? String(parsed.countryCode).toUpperCase() : null;
  return {
    ip: parsed.ip,
    country: parsed.country || cc,
    countryCode: cc,
    city: parsed.city || null,
    timeZone: parsed.timeZone || timezoneForCountry(cc),
    languages: languagesForCountry(cc),
    latitude: Number(parsed.latitude),
    longitude: Number(parsed.longitude)
  };
}

async function fetchJson(url, timeoutMs) {
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), timeoutMs);
  try {
    const res = await fetch(url, { signal: ctrl.signal, cache: 'no-store', credentials: 'omit' });
    if (!res.ok) throw new Error('HTTP ' + res.status);
    return await res.json();
  } finally {
    clearTimeout(timer);
  }
}

/**
 * Общий бюджет на все провайдеры. Раньше было 8 с на каждого, то есть до 24 с
 * ожидания с мёртвым прокси, и всё это время интерфейс показывал «проверка…».
 */
const DETECT_BUDGET_MS = 15000;

/**
 * @returns {Promise<{ip,country,countryCode,city,timeZone,languages,provider,ts}>}
 */
export async function detectGeo() {
  const errors = [];
  const deadline = Date.now() + DETECT_BUDGET_MS;
  for (const p of PROVIDERS) {
    const left = deadline - Date.now();
    if (left < 1000) {
      errors.push(`${p.name}: пропущен, время вышло`);
      continue;
    }
    try {
      const data = await fetchJson(p.url, Math.min(8000, left));
      const parsed = p.parse(data);
      if (!parsed || !parsed.ip) throw new Error('пустой ответ');
      const cc = parsed.countryCode ? String(parsed.countryCode).toUpperCase() : null;
      const lat = Number(parsed.latitude);
      const lon = Number(parsed.longitude);
      return {
        ip: parsed.ip,
        country: parsed.country || cc,
        countryCode: cc,
        city: parsed.city || null,
        timeZone: parsed.timeZone || timezoneForCountry(cc),
        languages: languagesForCountry(cc),
        latitude: Number.isFinite(lat) ? lat : null,
        longitude: Number.isFinite(lon) ? lon : null,
        provider: p.name,
        ts: Date.now()
      };
    } catch (e) {
      errors.push(`${p.name}: ${e.name === 'AbortError' ? 'таймаут' : e.message}`);
    }
  }
  throw new Error('Не удалось определить IP. ' + errors.join('; '));
}
