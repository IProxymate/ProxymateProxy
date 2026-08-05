import { send, el } from '../ui/msg.js';
import { countryLabel } from '../lib/countries.js';
import { bypassHost } from '../lib/apply.js';

const $ = (id) => document.getElementById(id);

let state = null;
let siteHost = null;      // хост активной вкладки, если это обычный сайт
let siteTabId = null;
let filterText = '';

const FRESH_MS = 10 * 60 * 1000;
const MODE_SHORT = { auto: '· авто', manual: '· вручную', off: '· без подмены' };

/* ------------------------------ статус ------------------------------ */

function setStatus(active) {
  const s = $('status');
  const broken = state.health && state.health.state !== 'ok';
  if (active && broken) {
    s.textContent = 'ПРОБЛЕМА';
    s.className = 'badge bad';
    return;
  }
  s.textContent = active ? 'ПОДКЛЮЧЕНО' : 'ПРЯМОЕ СОЕДИНЕНИЕ';
  s.className = 'badge ' + (active ? 'ok' : '');
}

function notice(text, bad, onDismiss) {
  return el('div', { class: 'notice dismissable' + (bad ? ' bad' : '') }, [
    el('span', { text }),
    el('button', {
      title: 'скрыть', text: '×',
      onclick: (e) => { e.currentTarget.closest('.notice').remove(); if (onDismiss) onDismiss(); }
    })
  ]);
}

const HEALTH_UI = {
  failing: {
    title: 'Прокси не отвечает',
    body: 'Несколько запросов подряд не прошли через туннель. Страницы не загружаются.'
  },
  hijacked: {
    title: 'Настройками прокси управляет другое расширение',
    body: 'Трафик может идти не через выбранный прокси. Отключите конкурирующее расширение, затем нажмите «Переприменить».'
  },
  cleared: {
    title: 'Прокси сброшен извне',
    body: 'Трафик идёт напрямую — ваш настоящий IP виден сайтам.'
  }
};

/** Проблема с туннелем: показываем крупно и с действиями, но ничего не делаем сами. */
function renderHealth() {
  const h = state.health;
  if (!h || h.state === 'ok') return null;
  const ui = HEALTH_UI[h.state];
  if (!ui) return null;

  return el('div', { class: 'notice bad', style: 'margin-bottom:10px' }, [
    el('div', { style: 'font-weight:600; margin-bottom:3px', text: '⚠ ' + ui.title }),
    el('div', { class: 'note-sm', style: 'margin-top:0', text: ui.body }),
    h.code ? el('div', { class: 'note-sm mono', text: h.code }) : null,
    h.detail ? el('div', { class: 'note-sm', text: h.detail }) : null,
    el('div', { class: 'btn-row', style: 'margin-top:8px' }, [
      el('button', { class: 'sm primary', text: 'Переприменить', onclick: (e) => reapplyNow(e.target) }),
      el('button', { class: 'sm', text: 'Отключить прокси', onclick: () => disconnect() })
    ])
  ]);
}

async function reapplyNow(btn) {
  btn.disabled = true;
  btn.textContent = '…';
  try {
    await send('reapplyNow');
  } catch (e) { /* состояние покажет refresh */ }
  await refresh();
  await loadInfo();
}

function renderWarn() {
  const box = $('warn');
  box.textContent = '';
  const h = renderHealth();
  if (h) box.appendChild(h);
  if (state.lastError) {
    box.appendChild(notice(state.lastError, true, () => send('dismissError').catch(() => {})));
  }
  if (!state.userScripts) {
    box.appendChild(notice(
      'Подмена работает в запасном режиме. Включите «Allow user scripts» на ' +
      'chrome://extensions → Proxymate Proxy для надёжного инжекта.', false));
  }
  if (state.updateInfo && state.updateInfo.hasUpdate) {
    box.appendChild(el('div', { class: 'notice' }, [
      el('span', { text: `Доступна версия ${state.updateInfo.latest} (у вас ${state.updateInfo.current}). ` }),
      el('button', { class: 'link', text: 'Открыть релиз', onclick: () => chrome.tabs.create({ url: state.updateInfo.url }) })
    ]));
  }
}

/* --------------------------- текущий выход --------------------------- */

/** Замер сделан в том же режиме, что сейчас, и ещё не протух? */
function checkIsCurrent(lc) {
  if (!lc || !lc.ip) return false;
  const viaProxy = !!state.activeId;
  if (!!lc.viaProxy !== viaProxy) return false;
  if (viaProxy && lc.profileId && lc.profileId !== state.activeId) return false;
  return !lc.ts || Date.now() - lc.ts < FRESH_MS;
}

function renderInfo(geo) {
  const viaProxy = !!state.activeId;
  $('info-title').textContent = viaProxy ? 'Текущий выход' : 'Ваше соединение';

  $('v-ip').textContent = geo?.ip || '—';
  $('copy-ip').hidden = !geo?.ip;
  $('v-country').textContent = geo ? ([geo.city, geo.country].filter(Boolean).join(', ') || '—') : '—';
  $('v-tz').textContent = geo?.timeZone || '—';
  $('v-lang').textContent = geo?.languages ? geo.languages.slice(0, 3).join(', ') : '—';

  const note = $('info-note');
  if (!geo) {
    note.textContent = '';
  } else if (viaProxy) {
    note.textContent = 'Данные выходного узла прокси. Часовой пояс и языки подставляются сайтам.';
  } else {
    note.textContent = 'Прокси выключен — это ваш настоящий IP, его видят все сайты.';
  }
}

/** Показывает кэш, если он актуален; иначе сам делает свежий замер. */
async function loadInfo() {
  if (checkIsCurrent(state.lastCheck)) {
    renderInfo(state.lastCheck);
    return;
  }
  renderInfo(null);
  $('v-ip').textContent = 'проверка…';
  try {
    renderInfo(await send('check'));
  } catch (e) {
    $('v-ip').textContent = '—';
    $('info-note').textContent = 'Не удалось определить IP: ' + e.message;
  }
}

/* ---------------------------- текущий сайт ---------------------------- */

function isBypassed(host) {
  const list = state.settings.bypassList || [];
  const d = bypassHost(host);
  return list.includes(d) || list.includes('*.' + d);
}

async function loadSite() {
  const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
  siteHost = null;
  siteTabId = null;
  if (tab && /^https?:/.test(tab.url || '')) {
    try {
      siteHost = new URL(tab.url).hostname;
      siteTabId = tab.id;
    } catch (e) { /* noop */ }
  }
  renderSite();
}

function renderSite() {
  const card = $('site-card');
  if (!siteHost) { card.hidden = true; return; }
  card.hidden = false;

  const bypassed = isBypassed(siteHost);
  $('site-host').textContent = siteHost;
  $('site-host').title = siteHost;
  const btn = $('site-bypass');
  btn.textContent = bypassed ? 'Вернуть в прокси' : 'В обход';
  btn.className = 'sm' + (bypassed ? '' : ' primary');
  $('site-note').textContent = bypassed
    ? 'Сайт идёт напрямую, мимо прокси.'
    : '';
}

async function toggleSiteBypass(btn) {
  if (!siteHost) return;
  btn.disabled = true;
  try {
    const res = await send('toggleBypass', { host: siteHost });
    state.settings.bypassList = res.bypassList;
    renderSite();
    const d = bypassHost(siteHost);
    const note = $('site-note');
    note.textContent = '';
    note.appendChild(el('span', {
      text: res.bypassed
        ? `${d} и поддомены теперь идут мимо прокси. `
        : `${d} и поддомены снова через прокси. `
    }));
    if (siteTabId) {
      note.appendChild(el('button', {
        class: 'link', text: 'перезагрузить страницу',
        onclick: () => { chrome.tabs.reload(siteTabId); window.close(); }
      }));
    }
  } catch (e) {
    $('site-note').textContent = 'Ошибка: ' + e.message;
  } finally {
    btn.disabled = false;
  }
}

/* ------------------------------ профили ------------------------------ */

function renderList() {
  const list = $('list');
  list.textContent = '';

  $('filter').hidden = state.profiles.length <= 5;

  if (!state.profiles.length) {
    list.appendChild(el('div', { class: 'empty', text: 'Профилей нет — добавьте в настройках.' }));
    return;
  }

  const q = filterText.trim().toLowerCase();
  const shown = q
    ? state.profiles.filter((p) =>
        (p.name || '').toLowerCase().includes(q) ||
        (p.host || '').toLowerCase().includes(q) ||
        (p.detected?.countryCode || '').toLowerCase().includes(q) ||
        (p.detected?.country || '').toLowerCase().includes(q))
    : state.profiles;

  if (!shown.length) {
    list.appendChild(el('div', { class: 'empty', text: 'Ничего не найдено.' }));
    return;
  }

  for (const p of shown) {
    const active = p.id === state.activeId;
    const geo = p.detected;
    const meta = [
      `${p.scheme}://${p.host}:${p.port}`,
      geo?.countryCode ? `· ${geo.countryCode}` : null,
      MODE_SHORT[p.spoofMode || 'auto']
    ].filter(Boolean).join(' ');

    list.appendChild(el('div', {
      class: 'item' + (active ? ' active' : ''),
      onclick: () => (active ? disconnect() : connect(p.id))
    }, [
      el('span', { class: 'dot' }),
      el('span', { class: 'cc', text: countryLabel(geo?.countryCode) }),
      el('div', { class: 'grow' }, [
        el('div', { class: 'ellipsis', text: p.name }),
        el('div', { class: 'meta ellipsis', text: meta })
      ])
    ]));
  }
}

/* ------------------------------ действия ------------------------------ */

function render() {
  setStatus(!!state.activeId);
  renderWarn();
  renderList();
  renderSite();
  $('disconnect').disabled = !state.activeId;
}

async function refresh() {
  state = await send('getState');
  render();
}

async function connect(id) {
  $('status').textContent = 'ПОДКЛЮЧЕНИЕ…';
  let failure = null;
  try {
    await send('connect', { id });
  } catch (e) {
    failure = e.message;
  }
  await refresh();
  await loadInfo();
  if (failure) $('warn').appendChild(notice(failure, true));
}

async function disconnect() {
  await send('disconnect');
  await refresh();
  await loadInfo();
}

$('disconnect').addEventListener('click', () => disconnect());
$('recheck').addEventListener('click', async (e) => {
  e.target.disabled = true;
  $('v-ip').textContent = 'проверка…';
  try {
    renderInfo(await send('check'));
    await refresh();
  } catch (err) {
    $('v-ip').textContent = '—';
    $('info-note').textContent = 'Не удалось определить IP: ' + err.message;
  } finally {
    e.target.disabled = false;
  }
});
$('copy-ip').addEventListener('click', async (e) => {
  try {
    await navigator.clipboard.writeText($('v-ip').textContent.trim());
    e.target.textContent = 'скопировано';
    setTimeout(() => { e.target.textContent = 'копировать'; }, 1500);
  } catch (err) {
    e.target.textContent = 'не вышло';
    setTimeout(() => { e.target.textContent = 'копировать'; }, 1500);
  }
});
$('site-bypass').addEventListener('click', (e) => toggleSiteBypass(e.target));
$('filter').addEventListener('input', (e) => { filterText = e.target.value; renderList(); });
$('options').addEventListener('click', () => chrome.runtime.openOptionsPage());
$('leak').addEventListener('click', () => {
  chrome.tabs.create({ url: chrome.runtime.getURL('src/leaktest/leaktest.html') });
  window.close();
});

(async () => {
  await refresh();
  await loadSite();
  await loadInfo();
})();
