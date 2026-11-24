import { send, el } from '../ui/msg.js';

const $ = (id) => document.getElementById(id);
let lastGeo = null;

function fail(msg) {
  $('err').appendChild(el('div', { class: 'notice bad', text: msg }));
}

/* ------------------------- 1. IP / гео ------------------------- */

async function runGeo() {
  $('ip').textContent = 'проверка…';
  try {
    const geo = await send('check');
    lastGeo = geo;
    $('ip').textContent = geo.ip;
    $('loc').textContent = [geo.city, geo.country, geo.countryCode].filter(Boolean).join(', ');
    $('geotz').textContent = geo.timeZone || '—';
    $('prov').textContent = geo.provider;
  } catch (e) {
    $('ip').textContent = '—';
    fail('IP: ' + e.message);
  }
}

/* ------------------------- 2. WebRTC ------------------------- */

/**
 * Собирает ICE-кандидаты. Выполняется в MAIN-мире целевой страницы —
 * важно, потому что страницы расширения освобождены от mDNS-обфускации
 * локальных адресов и дают завышенно «дырявый» результат.
 */
function gatherCandidates(timeoutMs) {
  return new Promise((resolve) => {
    let pc;
    try {
      pc = new RTCPeerConnection({
        iceServers: [
          { urls: 'stun:stun.l.google.com:19302' },
          { urls: 'stun:stun1.l.google.com:19302' }
        ]
      });
    } catch (e) {
      return resolve({ blocked: true, candidates: [] });
    }
    const candidates = [];
    const done = () => {
      try { pc.close(); } catch (e) { /* noop */ }
      resolve({ blocked: false, candidates });
    };
    const timer = setTimeout(done, timeoutMs);
    pc.onicecandidate = (e) => {
      if (!e.candidate) { clearTimeout(timer); return done(); }
      candidates.push(e.candidate.candidate);
    };
    pc.onicegatheringstatechange = () => {
      if (pc.iceGatheringState === 'complete') { clearTimeout(timer); done(); }
    };
    try {
      pc.createDataChannel('probe');
      pc.createOffer().then((o) => pc.setLocalDescription(o)).catch(() => { clearTimeout(timer); done(); });
    } catch (e) {
      clearTimeout(timer);
      done();
    }
  });
}

/* ------------------- выбор целевой вкладки ------------------- */

let webTabs = [];

async function loadTabs(preserve) {
  const wanted = preserve ? Number($('tab-pick').value) : null;
  webTabs = await send('listWebTabs');
  const sel = $('tab-pick');
  sel.textContent = '';

  if (!webTabs.length) {
    sel.appendChild(el('option', { value: '', text: 'нет открытых http/https-вкладок' }));
    sel.disabled = true;
    $('tab-note').textContent =
      'Откройте любой сайт в соседней вкладке — без него проверки 2 и 3 недостоверны.';
    $('tab-note').className = 'notice';
    return;
  }

  sel.disabled = false;
  for (const t of webTabs) {
    const label = t.host + (t.title && t.title !== t.host ? ' — ' + t.title.slice(0, 60) : '');
    sel.appendChild(el('option', { value: String(t.id), text: label }));
  }
  const keep = webTabs.some((t) => t.id === wanted) ? wanted : (webTabs.find((t) => t.active) || webTabs[0]).id;
  sel.value = String(keep);
  $('tab-note').textContent = `Найдено вкладок: ${webTabs.length}`;
  $('tab-note').className = 'muted';
}

/** Вкладка, выбранная пользователем; null — если выбирать не из чего. */
async function targetTab() {
  const id = Number($('tab-pick').value);
  if (!id) return null;
  try {
    const tab = await chrome.tabs.get(id);
    if (tab && /^https?:/.test(tab.url || '')) return tab;
  } catch (e) { /* вкладку закрыли */ }
  await loadTabs(false);
  const retry = Number($('tab-pick').value);
  return retry ? chrome.tabs.get(retry).catch(() => null) : null;
}

const IPV4 = /\b(\d{1,3}(?:\.\d{1,3}){3})\b/;
const IPV6 = /\b((?:[0-9a-f]{0,4}:){2,7}[0-9a-f]{0,4})\b/i;

function parseCandidate(line) {
  const type = (/ typ (\w+)/.exec(line) || [])[1] || '?';
  const m = IPV4.exec(line) || IPV6.exec(line);
  const addr = /\.local\b/.test(line) ? 'mdns' : (m ? m[1] : null);
  return { type, addr, mdns: /\.local\b/.test(line) };
}

async function runRTC() {
  $('rtc-verdict').textContent = 'сбор ICE-кандидатов…';
  $('rtc-verdict').className = 'verdict muted';
  $('rtc-raw').textContent = '';

  const tab = await targetTab();
  let blocked, candidates;

  if (tab) {
    $('rtc-ctx').textContent = 'контекст обычной страницы — ' + new URL(tab.url).hostname;
    $('rtc-ctx').className = 'muted';
    try {
      const [res] = await chrome.scripting.executeScript({
        target: { tabId: tab.id },
        world: 'MAIN',
        func: gatherCandidates,
        args: [6000]
      });
      ({ blocked, candidates } = res.result);
    } catch (e) {
      $('rtc-ctx').textContent = 'не удалось выполнить во вкладке: ' + e.message;
      return;
    }
  } else {
    // Резерв: мерим у себя, но честно предупреждаем, что результат завышен.
    $('rtc-ctx').textContent =
      'нет открытой http/https-вкладки — замер идёт на странице расширения, ' +
      'где Chrome не обфусцирует локальные IP. Результат строже реального: откройте любой сайт и повторите.';
    $('rtc-ctx').className = 'notice';
    ({ blocked, candidates } = await gatherCandidates(6000));
  }

  if (blocked) {
    $('rtc-verdict').textContent = '✅ RTCPeerConnection недоступен — WebRTC полностью отключён';
    $('rtc-verdict').className = 'verdict';
    $('rtc-verdict').style.color = 'var(--ok)';
    ['rtc-public', 'rtc-local', 'rtc-mdns'].forEach((id) => { $(id).textContent = '—'; });
    return;
  }

  const pub = new Set(), loc = new Set();
  let mdns = 0;
  for (const c of candidates) {
    $('rtc-raw').appendChild(el('div', { text: c }));
    const p = parseCandidate(c);
    if (p.mdns) { mdns++; continue; }
    if (!p.addr) continue;
    if (p.type === 'host') loc.add(p.addr);
    else pub.add(p.addr);
  }

  $('rtc-public').textContent = pub.size ? [...pub].join(', ') : 'нет';
  $('rtc-local').textContent = loc.size ? [...loc].join(', ') : 'нет';
  $('rtc-mdns').textContent = mdns ? `${mdns} шт. (обфусцированы, утечкой не являются)` : 'нет';

  const v = $('rtc-verdict');
  const proxyIp = lastGeo && lastGeo.ip;
  const leakedPublic = [...pub].filter((ip) => ip !== proxyIp);

  if (!candidates.length) {
    v.textContent = '✅ Кандидатов нет — UDP не проходит мимо прокси';
    v.style.color = 'var(--ok)';
  } else if (loc.size) {
    v.textContent = '❌ Утечка: видны локальные IP вашей сети';
    v.style.color = 'var(--bad)';
  } else if (leakedPublic.length) {
    v.textContent = '❌ Утечка: публичный IP из WebRTC не совпадает с IP прокси (' + leakedPublic.join(', ') + ')';
    v.style.color = 'var(--bad)';
  } else if (pub.size) {
    v.textContent = '✅ Публичный кандидат совпадает с IP прокси';
    v.style.color = 'var(--ok)';
  } else {
    v.textContent = '✅ Реальных адресов не обнаружено';
    v.style.color = 'var(--ok)';
  }
}

/* ------------------- 3. Значения в контексте страницы ------------------- */

/** Выполняется в MAIN-мире целевой вкладки. */
function readPageFingerprint() {
  const d = new Date();
  let iLocale = null;
  try { iLocale = new Intl.NumberFormat().resolvedOptions().locale; } catch (e) { /* noop */ }
  let tz = null;
  try { tz = Intl.DateTimeFormat().resolvedOptions().timeZone; } catch (e) { /* noop */ }
  return {
    tz,
    offset: d.getTimezoneOffset(),
    dateString: d.toString(),
    localeString: d.toLocaleString(),
    language: navigator.language,
    languages: (navigator.languages || []).join(', '),
    intlLocale: iLocale,
    rtc: typeof RTCPeerConnection === 'function' ? 'доступен' : 'отсутствует'
  };
}

function waitForComplete(tabId, timeoutMs) {
  return new Promise((resolve) => {
    const finish = () => {
      clearTimeout(timer);
      chrome.tabs.onUpdated.removeListener(listener);
      resolve();
    };
    const listener = (id, info) => { if (id === tabId && info.status === 'complete') finish(); };
    const timer = setTimeout(finish, timeoutMs);
    chrome.tabs.onUpdated.addListener(listener);
  });
}

async function reloadAndCheck() {
  const tab = await targetTab();
  if (!tab) return fail('Нет открытой http/https-вкладки. Откройте любой сайт и повторите.');
  $('page-src').textContent = 'перезагрузка ' + new URL(tab.url).hostname + '…';
  await chrome.tabs.reload(tab.id);
  await waitForComplete(tab.id, 20000);
  await runPage();
}

async function runPage() {
  const target = await targetTab();

  if (!target) {
    $('page-src').textContent = '';
    return fail('Нет открытой http/https-вкладки для проверки. Откройте любой сайт и повторите.');
  }
  $('page-src').textContent = new URL(target.url).hostname;

  let res;
  try {
    [res] = await chrome.scripting.executeScript({
      target: { tabId: target.id },
      world: 'MAIN',
      func: readPageFingerprint
    });
  } catch (e) {
    return fail('Не удалось прочитать вкладку: ' + e.message);
  }
  const r = res.result;
  $('p-tz').textContent = r.tz || '—';
  $('p-off').textContent = r.offset + ' мин (UTC' + (r.offset <= 0 ? '+' : '-') + Math.abs(r.offset / 60) + ')';
  $('p-date').textContent = r.dateString;
  $('p-loc').textContent = r.localeString;
  $('p-lang').textContent = r.language;
  $('p-langs').textContent = r.languages;
  $('p-ilocale').textContent = r.intlLocale || '—';
  $('p-rtc').textContent = r.rtc;

  const cell = $('p-match');
  if (!lastGeo || !lastGeo.timeZone) {
    cell.textContent = 'сначала определите IP';
    cell.className = 'muted';
  } else if (r.tz === lastGeo.timeZone) {
    cell.textContent = '✅ часовой пояс страницы совпадает с зоной IP (' + lastGeo.timeZone + ')';
    cell.style.color = 'var(--ok)';
  } else {
    cell.textContent = `❌ страница отдаёт ${r.tz}, а IP находится в ${lastGeo.timeZone}`;
    cell.style.color = 'var(--bad)';
  }
}

/* ------------------- 4. Accept-Language ------------------- */

/**
 * Выполняется в изолированном мире вкладки: запрос уходит как обычный
 * запрос страницы, и правило подмены заголовка применяется к нему так же,
 * как к запросам сайта. Со страницы расширения это не гарантировано.
 */
function fetchAcceptLanguage() {
  return fetch('https://httpbin.org/headers', { cache: 'no-store', credentials: 'omit' })
    .then((r) => r.json())
    .then((d) => ({ value: d.headers['Accept-Language'] || d.headers['accept-language'] || null }))
    .catch((e) => ({ error: String((e && e.message) || e) }));
}

async function runHeader() {
  $('hdr').textContent = 'проверка…';
  $('hdr-src').textContent = '—';
  let res = null;
  const tab = await targetTab();
  if (tab) {
    try {
      const [r] = await chrome.scripting.executeScript({ target: { tabId: tab.id }, func: fetchAcceptLanguage });
      res = r.result;
      $('hdr-src').textContent = 'вкладка ' + new URL(tab.url).hostname;
    } catch (e) {
      res = null;
    }
  }
  if (!res || res.error) {
    // Резерв: запрос со страницы расширения. Правило DNR к нему может не применяться.
    const fromTab = res && res.error;
    res = await fetchAcceptLanguage();
    $('hdr-src').textContent = 'страница расширения — результат может не совпадать с тем, что видят сайты' +
      (fromTab ? ` (из вкладки не вышло: ${fromTab})` : '');
  }
  if (res.error) {
    $('hdr').textContent = '—';
    fail('Accept-Language: ' + res.error);
    return;
  }
  $('hdr').textContent = res.value || '(не отправлен)';
}

/* ------------------- запуск ------------------- */

$('run').addEventListener('click', async (e) => {
  $('err').textContent = '';
  e.target.disabled = true;
  try {
    await runGeo();
    await runRTC();
    await runPage();
  } catch (err) {
    fail(err.message);
  } finally {
    e.target.disabled = false;
  }
});
$('run-page').addEventListener('click', () => { $('err').textContent = ''; runPage(); });
$('reload-page').addEventListener('click', (e) => {
  $('err').textContent = '';
  e.target.disabled = true;
  reloadAndCheck().catch((err) => fail(err.message)).finally(() => { e.target.disabled = false; });
});
/* ------------------- геолокация в контексте страницы ------------------- */

/** Выполняется в MAIN-мире целевой вкладки. */
function askGeolocation() {
  return new Promise((resolve) => {
    if (!navigator.geolocation) return resolve({ error: 'API недоступен' });
    const timer = setTimeout(() => resolve({ error: 'таймаут 15 с' }), 15000);
    navigator.geolocation.getCurrentPosition(
      (pos) => {
        clearTimeout(timer);
        resolve({ lat: pos.coords.latitude, lon: pos.coords.longitude, acc: pos.coords.accuracy });
      },
      (err) => { clearTimeout(timer); resolve({ error: `${err.code}: ${err.message}` }); },
      { enableHighAccuracy: false, timeout: 12000, maximumAge: 0 }
    );
  });
}

/** Расстояние между точками по формуле гаверсинусов, км. */
function distanceKm(a, b, c, d) {
  const R = 6371, rad = Math.PI / 180;
  const dLat = (c - a) * rad, dLon = (d - b) * rad;
  const h = Math.sin(dLat / 2) ** 2 +
    Math.cos(a * rad) * Math.cos(c * rad) * Math.sin(dLon / 2) ** 2;
  return 2 * R * Math.asin(Math.sqrt(h));
}

async function runGeoPermission() {
  const tab = await targetTab();
  if (!tab) return fail('Нет вкладки для проверки геолокации.');
  const cell = $('p-geo');
  cell.textContent = 'ожидание ответа страницы…';
  cell.style.color = '';

  let res;
  try {
    [res] = await chrome.scripting.executeScript({
      target: { tabId: tab.id }, world: 'MAIN', func: askGeolocation
    });
  } catch (e) {
    cell.textContent = 'не удалось выполнить: ' + e.message;
    return;
  }

  const r = res.result;
  if (r.error) {
    cell.textContent = 'отказ или ошибка — ' + r.error;
    cell.style.color = 'var(--muted)';
    return;
  }

  const coords = `${r.lat.toFixed(4)}, ${r.lon.toFixed(4)} (±${Math.round(r.acc)} м)`;
  if (lastGeo && Number.isFinite(lastGeo.latitude) && Number.isFinite(lastGeo.longitude)) {
    const km = distanceKm(r.lat, r.lon, lastGeo.latitude, lastGeo.longitude);
    cell.textContent = km < 50
      ? `✅ ${coords} — ${km.toFixed(1)} км от города IP`
      : `❌ ${coords} — ${Math.round(km)} км от города IP, это утечка`;
    cell.style.color = km < 50 ? 'var(--ok)' : 'var(--bad)';
  } else {
    cell.textContent = coords + ' (координаты IP неизвестны, сравнить не с чем)';
  }
}

$('ask-geo').addEventListener('click', (e) => {
  $('err').textContent = '';
  e.target.disabled = true;
  runGeoPermission().catch((err) => fail(err.message)).finally(() => { e.target.disabled = false; });
});
$('run-hdr').addEventListener('click', () => { $('err').textContent = ''; runHeader(); });
$('tab-refresh').addEventListener('click', () => loadTabs(true));
$('tab-pick').addEventListener('change', () => { $('page-src').textContent = ''; });

loadTabs(false).then(runGeo).then(runRTC);

