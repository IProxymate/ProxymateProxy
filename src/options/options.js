import { send, el } from '../ui/msg.js';
import { parseProxyLine, newProfileId } from '../lib/storage.js';
import { countryLabel } from '../lib/countries.js';

const $ = (id) => document.getElementById(id);
let state = null;
let editing = null;   // редактируемый профиль или null

/* ------------------------------ утилиты ------------------------------ */

function flash(text, bad) {
  const m = $('msg');
  m.textContent = text;
  m.className = bad ? 'notice bad' : 'muted';
  if (!bad) setTimeout(() => { if (m.textContent === text) { m.textContent = ''; } }, 3000);
}

function validTimeZone(tz) {
  if (!tz) return true;
  try { new Intl.DateTimeFormat('en', { timeZone: tz }); return true; } catch (e) { return false; }
}

/* ------------------------------ список ------------------------------ */

const MODE_SHORT = { auto: 'подмена авто', manual: 'подмена вручную', off: 'без подмены' };

function renderList() {
  const box = $('plist');
  box.textContent = '';
  if (!state.profiles.length) {
    box.appendChild(el('div', { class: 'muted', text: 'Пока пусто. Добавьте профиль или импортируйте список.' }));
    return;
  }
  for (const p of state.profiles) {
    const active = p.id === state.activeId;
    box.appendChild(el('div', { class: 'prow' + (active ? ' active' : '') }, [
      el('span', { class: 'cc', title: p.detected?.country || 'страна не определена', text: countryLabel(p.detected?.countryCode) }),
      el('div', { class: 'grow' }, [
        el('div', {}, [
          p.name,
          active ? el('span', { class: 'badge ok', text: 'активен', style: 'margin-left:6px' }) : null
        ]),
        el('div', { class: 'meta' , text:
          `${p.scheme}://${p.host}:${p.port}` +
          (p.username ? ` · ${p.username}` : '') +
          ' · ' + MODE_SHORT[p.spoofMode || 'auto'] +
          (p.detected?.countryCode ? ` · выход ${p.detected.countryCode}` : '')
        })
      ]),
      el('button', { class: 'sm', text: active ? 'Откл.' : 'Вкл.', onclick: () => toggle(p) }),
      el('button', { class: 'sm', text: 'Изм.', onclick: () => openEditor(p) })
    ]));
  }
}

async function toggle(p) {
  try {
    if (p.id === state.activeId) {
      await send('disconnect');
      flash('Отключено');
    } else {
      flash('Подключение…');
      await send('connect', { id: p.id });
      flash('Подключено, страна выхода определяется в фоне');
    }
  } catch (e) {
    flash(e.message, true);
  }
  await refreshStatus();
}

/* ------------------------------ редактор ------------------------------ */

const MODE_NOTE = {
  auto: 'Часовой пояс, языки и координаты берутся из гео по IP прокси при каждом подключении.',
  manual: 'Применяются значения из полей ниже. Пустое поле — эта часть не подменяется.',
  off: 'Для этого профиля не подменяется ничего: сайты увидят ваши настоящие зону, язык и координаты.'
};

function openEditor(p) {
  editing = p || {
    id: newProfileId(), name: '', scheme: 'http', host: '', port: '',
    username: '', password: '', spoofMode: 'auto', timeZone: '', languages: null
  };
  $('editor-title').textContent = p ? 'Редактирование профиля' : 'Новый профиль';
  $('f-name').value = editing.name || '';
  $('f-host').value = editing.host || '';
  $('f-port').value = editing.port || '';
  $('f-scheme').value = editing.scheme || 'http';
  $('f-user').value = editing.username || '';
  $('f-pass').value = editing.password || '';
  $('f-mode').value = editing.spoofMode || 'auto';
  $('f-tz').value = editing.timeZone || '';
  $('f-langs').value = (editing.languages || []).join(', ');
  $('f-lat').value = editing.latitude ?? '';
  $('f-lon').value = editing.longitude ?? '';
  $('delete').hidden = !p;
  $('test-profile-result').textContent = '';
  syncEditorState();
  $('editor').showModal();
  $('f-name').focus();
}

function syncEditorState() {
  const mode = $('f-mode').value;
  const manual = mode === 'manual';
  for (const id of ['f-tz', 'f-langs', 'f-lat', 'f-lon']) $(id).disabled = !manual;
  $('mode-note').textContent = MODE_NOTE[mode] || '';

  const scheme = $('f-scheme').value;
  $('socks-note').hidden = !(scheme.startsWith('socks') && ($('f-user').value || $('f-pass').value));
  $('https-note').hidden = scheme !== 'https';
  $('socks4-note').hidden = scheme !== 'socks4';
}

function closeEditor() {
  editing = null;
  if ($('editor').open) $('editor').close();
}

/** Данные из полей редактора без сохранения — для пробной проверки. */
function draftProfile() {
  return {
    scheme: $('f-scheme').value,
    host: $('f-host').value.trim(),
    port: Number($('f-port').value),
    username: $('f-user').value.trim(),
    password: $('f-pass').value
  };
}

async function testDraft(btn) {
  const box = $('test-profile-result');
  const draft = draftProfile();
  if (!draft.host || !draft.port) {
    box.textContent = '';
    box.appendChild(el('div', { class: 'notice bad', text: 'Сначала укажите хост и порт' }));
    return;
  }

  btn.disabled = true;
  const label = btn.textContent;
  btn.textContent = 'проверяю…';
  box.textContent = '';
  box.appendChild(el('div', { class: 'muted', text: 'пробный запрос через этот прокси…' }));

  try {
    const res = await send('testProfile', { profile: draft });
    box.textContent = '';
    if (res.ok) {
      const g = res.geo;
      box.appendChild(el('div', { class: 'notice', style: 'border-color:var(--ok); color:var(--ok)' }, [
        el('div', { text: `✅ Прокси работает — ${res.ms} мс` }),
        el('div', { class: 'mono', style: 'margin-top:3px',
          text: `${g.ip} · ${[g.city, g.countryCode].filter(Boolean).join(', ')}` }),
        g.timeZone ? el('div', { class: 'mono', text: g.timeZone }) : null,
        $('f-mode').value === 'manual'
          ? el('button', {
              class: 'link', style: 'margin-top:6px', text: 'подставить зону, языки и координаты в поля',
              onclick: () => {
                if (g.timeZone) $('f-tz').value = g.timeZone;
                if (g.languages) $('f-langs').value = g.languages.join(', ');
                if (Number.isFinite(g.latitude)) $('f-lat').value = g.latitude;
                if (Number.isFinite(g.longitude)) $('f-lon').value = g.longitude;
              }
            })
          : null
      ]));
    } else {
      box.appendChild(el('div', { class: 'notice bad' }, [
        el('div', { text: `❌ Не отвечает (${res.ms} мс): ${res.message}` }),
        res.netError ? el('div', { class: 'mono', style: 'margin-top:4px', text: res.netError.error }) : null,
        res.netError?.hint ? el('div', { style: 'margin-top:4px', text: res.netError.hint }) : null
      ]));
    }
  } catch (e) {
    box.textContent = '';
    box.appendChild(el('div', { class: 'notice bad', text: e.message }));
  } finally {
    btn.disabled = false;
    btn.textContent = label;
  }
}

async function saveProfile() {
  const tz = $('f-tz').value.trim();
  if (!validTimeZone(tz)) return flash(`Неизвестный часовой пояс: ${tz}`, true);
  const host = $('f-host').value.trim();
  const port = Number($('f-port').value);
  if (!host || !port) return flash('Укажите хост и порт', true);

  const coord = (id, min, max, label) => {
    const raw = $(id).value.trim().replace(',', '.');
    if (!raw) return null;
    const n = Number(raw);
    if (!Number.isFinite(n) || n < min || n > max) throw new Error(`${label} должна быть числом от ${min} до ${max}`);
    return n;
  };

  let latitude, longitude;
  try {
    latitude = coord('f-lat', -90, 90, 'Широта');
    longitude = coord('f-lon', -180, 180, 'Долгота');
  } catch (e) {
    return flash(e.message, true);
  }
  if ((latitude === null) !== (longitude === null)) {
    return flash('Координаты задаются парой — заполните и широту, и долготу', true);
  }

  const langs = $('f-langs').value.split(',').map((s) => s.trim()).filter(Boolean);
  const profile = {
    id: editing.id,
    name: $('f-name').value.trim(),
    scheme: $('f-scheme').value,
    host, port,
    username: $('f-user').value.trim(),
    password: $('f-pass').value,
    spoofMode: $('f-mode').value,
    timeZone: tz || null,
    languages: langs.length ? langs : null,
    latitude, longitude,
    detected: editing.detected || null
  };
  await send('saveProfile', { profile });
  closeEditor();
  await refreshStatus();
  flash('Профиль сохранён');
}

async function deleteProfile() {
  if (!editing) return;
  await send('deleteProfile', { id: editing.id });
  closeEditor();
  await refreshStatus();
  flash('Профиль удалён');
}

/* ------------------------------ настройки ------------------------------ */

/* ------------------------ список исключений ------------------------ */

let bypass = [];

/** Правило обхода Chrome: [схема://]хост[:порт], CIDR или <local>/<-loopback>. */
const BYPASS_RE = /^(?:(?:https?|ftp|socks[45]?):\/\/)?(?:<local>|<-loopback>|\*|[A-Za-z0-9*._-]+(?:\/\d{1,3})?)(?::\d{1,5})?$/;

function normalizeRule(raw) {
  let s = raw.trim().replace(/\s+/g, '');
  if (!s) return null;
  // из вставленного URL берём только хост (и порт)
  const m = /^[a-z][a-z0-9+.-]*:\/\/([^/?#]+)/i.exec(s);
  if (m) s = m[1];
  s = s.replace(/^www\./, '').replace(/\/+$/, '');
  return s || null;
}

function addRules(input, withSubdomains) {
  const added = [];
  const rejected = [];
  for (const part of String(input).split(/[,\s\n]+/)) {
    const rule = normalizeRule(part);
    if (!rule) continue;
    if (!BYPASS_RE.test(rule)) { rejected.push(part.trim()); continue; }
    const candidates = [rule];
    // «example.com» и «*.example.com» — в Chrome это два разных правила
    const bare = /^[a-z0-9-]+(\.[a-z0-9-]+)+$/i.test(rule);
    if (withSubdomains && bare) candidates.push('*.' + rule);
    for (const c of candidates) {
      if (!bypass.includes(c)) { bypass.push(c); added.push(c); }
    }
  }
  renderChips();
  return { added, rejected };
}

function renderChips() {
  const box = $('chips');
  box.textContent = '';
  for (const rule of bypass) {
    box.appendChild(el('span', { class: 'chip' }, [
      el('span', { text: rule }),
      el('button', {
        title: 'удалить', text: '×',
        onclick: () => { bypass = bypass.filter((r) => r !== rule); renderChips(); }
      })
    ]));
  }
}

function renderSettings() {
  const s = state.settings;
  $('s-tz').checked = s.spoofTimezone;
  $('s-lang').checked = s.spoofLanguage;
  $('s-al').checked = s.spoofAcceptLanguage;
  $('s-geo').checked = s.spoofGeolocation;
  $('s-auto').checked = s.autoCheckOnConnect;
  $('s-kill').checked = s.killSwitch;
  $('s-blockrtc').checked = s.blockWebRTC;
  $('s-rtc').value = s.webrtcPolicy;
  bypass = (s.bypassList || []).slice();
  renderChips();
}

async function saveSettings() {
  const settings = {
    spoofTimezone: $('s-tz').checked,
    spoofLanguage: $('s-lang').checked,
    spoofAcceptLanguage: $('s-al').checked,
    spoofGeolocation: $('s-geo').checked,
    autoCheckOnConnect: $('s-auto').checked,
    killSwitch: $('s-kill').checked,
    blockWebRTC: $('s-blockrtc').checked,
    webrtcPolicy: $('s-rtc').value,
    bypassList: bypass.slice()
  };
  await send('saveSettings', { settings });
  await refresh();
  flash('Настройки применены');
}

/* ------------------------------ диагностика ------------------------------ */

const CONTROL_LABEL = {
  controlled_by_this_extension: ['ok', 'управляется этим расширением'],
  controllable_by_this_extension: ['warn', 'не применено (доступно, но не установлено)'],
  controlled_by_other_extensions: ['bad', 'ПЕРЕХВАЧЕНО ДРУГИМ РАСШИРЕНИЕМ'],
  not_controllable: ['bad', 'недоступно (политика системы)']
};

function controlBadge(level) {
  const [cls, text] = CONTROL_LABEL[level] || ['warn', String(level)];
  return el('span', { class: 'badge ' + cls, text });
}

async function renderDiag() {
  const d = $('diag');
  d.textContent = 'загрузка…';

  let diag;
  try {
    diag = await send('diagnostics');
  } catch (e) {
    d.textContent = '';
    d.appendChild(el('div', { class: 'notice bad', text:
      'Фоновый процесс не отвечает: ' + e.message +
      '. Откройте chrome://extensions → Proxymate Proxy → «Service worker» и посмотрите консоль.' }));
    return;
  }

  const HEALTH_BADGE = {
    ok: ['ok', 'норма'],
    failing: ['bad', 'туннель не отвечает'],
    hijacked: ['bad', 'перехвачено другим расширением'],
    cleared: ['bad', 'прокси сброшен, трафик идёт напрямую']
  };
  const hs = diag.health?.state || 'ok';
  const [hCls, hText] = HEALTH_BADGE[hs] || ['warn', hs];

  const sp = diag.proxyValue?.rules?.singleProxy;
  const rows = [
    ['Состояние туннеля', el('span', { class: 'badge ' + hCls, text: hText })],
    ['Настройка прокси', controlBadge(diag.proxyLevel)],
    ['Применённый сервер', sp ? `${sp.scheme}://${sp.host}:${sp.port}`
      : diag.proxyValue?.mode === 'pac_script' ? 'PAC-скрипт (идёт проверка профиля)' : 'нет (прямое соединение)'],
    ['Блокировка трафика', diag.killSwitch
      ? el('span', { class: 'badge bad', text: 'ВКЛЮЧЕНА — весь трафик заблокирован' })
      : el('span', { class: 'badge', text: 'выключена' })],
    ['Политика WebRTC', controlBadge(diag.webrtcLevel)],
    ['Значение WebRTC', diag.webrtcValue || '—'],
    ['Accept-Language', diag.acceptLanguage],
    ['Инжект подмены', state.userScripts
      ? el('span', { class: 'badge ok', text: 'chrome.userScripts' })
      : el('span', { class: 'badge warn', text: 'запасной режим' })],
    ['Скрипт зарегистрирован', diag.userScripts ? String(diag.spoofRegistered) : 'н/д'],
    ['Активный профиль', state.activeId
      ? (state.profiles.find((p) => p.id === state.activeId)?.name || '—') : 'нет']
  ];

  d.textContent = '';
  const t = el('table');
  for (const [k, v] of rows) {
    t.appendChild(el('tr', {}, [
      el('th', { text: k }),
      el('td', {}, [typeof v === 'string' ? document.createTextNode(v) : v])
    ]));
  }
  d.appendChild(t);

  if (diag.applyErrors?.length) {
    d.appendChild(el('div', { class: 'notice bad' }, [
      el('div', { text: 'Шаги применения, завершившиеся ошибкой:' }),
      el('ul', { style: 'margin:4px 0 0; padding-left:18px' },
        diag.applyErrors.map((e) => el('li', { text: e })))
    ]));
  }

  // Ошибки проб относятся к проверяемому прокси, а не к рабочему туннелю.
  const proxyErrs = (diag.recentErrors || []).filter((e) => e.kind === 'proxy');
  const siteErrs = (diag.recentErrors || []).filter((e) => e.kind === 'site');

  const errBlock = (title, items, bad) => {
    const box = el('div', { style: 'font-size:12px; margin-top:10px' });
    box.appendChild(el('div', { class: 'muted', style: 'margin-bottom:4px', text: title }));
    for (const e of items.slice(0, 5)) {
      box.appendChild(el('div', { style: 'margin-bottom:5px' }, [
        el('code', { style: bad ? 'color:var(--bad)' : '', text: e.error }),
        e.hint ? el('div', { style: 'color:var(--bad)', text: e.hint }) : null,
        el('div', { class: 'ellipsis muted', text: e.url })
      ]));
    }
    return box;
  };

  if (proxyErrs.length) {
    d.appendChild(errBlock(
      diag.successCount > 0
        ? `Сбои туннеля (но ${diag.successCount} запросов прошло — прокси в целом жив):`
        : 'Сбои туннеля:',
      proxyErrs, true));
  }

  if (siteErrs.length) {
    const det = el('details', { style: 'margin-top:10px' });
    det.appendChild(el('summary', { class: 'muted', style: 'font-size:12px',
      text: `Ошибки отдельных сайтов: ${siteErrs.length} — к прокси отношения не имеют` }));
    det.appendChild(errBlock('', siteErrs, false));
    d.appendChild(det);
  }

  if (!state.userScripts) {
    d.appendChild(el('p', { class: 'muted', text:
      'Откройте chrome://extensions, найдите Proxymate Proxy → «Подробнее» и включите ' +
      '«Разрешить пользовательские скрипты» (Allow user scripts). Без этого подмена ' +
      'применяется через executeScript и может не успеть до скриптов страницы.' }));
  }
}

async function testProxy() {
  const box = $('test-result');
  box.textContent = '';
  box.appendChild(el('div', { class: 'muted', text: 'запрос через прокси…' }));
  const res = await send('testProxy');
  box.textContent = '';
  if (res.ok) {
    box.appendChild(el('div', { class: 'badge ok', text: `прокси отвечает, ${res.ms} мс` }));
  } else {
    box.appendChild(el('div', { class: 'notice bad' }, [
      el('div', { text: `Трафик не проходит (${res.ms} мс): ${res.message}` }),
      res.netError ? el('div', { style: 'margin-top:4px' }, [el('code', { text: res.netError.error })]) : null,
      res.netError?.hint ? el('div', { style: 'margin-top:4px', text: res.netError.hint }) : null
    ]));
  }
  await renderDiag();
}

/* ------------------------------ обновления ------------------------------ */

function renderUpdate() {
  $('version-label').textContent = 'v' + chrome.runtime.getManifest().version;

  const badge = $('update-badge');
  const info = state.updateInfo;
  badge.onclick = null;
  badge.style.cursor = '';
  if (!info) { badge.hidden = true; return; }
  badge.hidden = false;

  if (info.error) {
    badge.className = 'badge warn';
    badge.textContent = 'проверка не удалась';
    badge.title = info.error;
  } else if (info.hasUpdate) {
    badge.className = 'badge ok';
    badge.textContent = `доступна v${info.latest}`;
    badge.title = 'Открыть страницу релиза';
    badge.style.cursor = 'pointer';
    badge.onclick = () => chrome.tabs.create({ url: info.url });
  } else {
    badge.className = 'badge';
    badge.textContent = 'актуальная версия';
    badge.title = '';
  }
}

async function checkUpdate(btn) {
  btn.disabled = true;
  const label = btn.textContent;
  btn.textContent = 'проверяю…';
  try {
    state.updateInfo = await send('checkUpdate');
    renderUpdate();
    if (state.updateInfo.error) flash('Не удалось проверить обновления: ' + state.updateInfo.error, true);
    else flash(state.updateInfo.hasUpdate
      ? `Доступна версия ${state.updateInfo.latest} — кликните по бейджу, чтобы открыть релиз`
      : 'У вас последняя версия');
  } catch (e) {
    flash(e.message, true);
  } finally {
    btn.disabled = false;
    btn.textContent = label;
  }
}

/* ------------------------------ загрузка ------------------------------ */

function renderTop() {
  const active = state.profiles.find((p) => p.id === state.activeId);
  const top = $('top-status');
  top.textContent = active ? 'Подключено — ' + active.name : 'Прямое соединение';
  top.className = 'badge' + (active ? ' ok' : '');
}

/** Полная перерисовка, включая форму настроек — несохранённые правки в ней сбрасываются. */
async function refresh() {
  state = await send('getState');
  renderTop();
  renderList();
  renderSettings();
  renderUpdate();
  await renderDiag();
}

/** Обновление статуса и списка без трогания формы настроек. */
async function refreshStatus() {
  state = await send('getState');
  renderTop();
  renderList();
  await renderDiag();
}

let statusTimer = null;
chrome.storage.onChanged.addListener((changes, area) => {
  if (area !== 'local' || !state) return;
  if (!changes.profiles && !changes.activeId) return;
  clearTimeout(statusTimer);
  statusTimer = setTimeout(() => refreshStatus().catch(() => {}), 150);
});

/* ------------------------ экспорт и импорт ------------------------ */

function backupMsg(text, bad) {
  const m = $('backup-msg');
  m.textContent = text;
  m.className = bad ? 'notice bad' : 'muted';
}

async function exportBackup() {
  const data = await send('exportData', { withPasswords: $('exp-pass').checked });
  const blob = new Blob([JSON.stringify(data, null, 2)], { type: 'application/json' });
  const url = URL.createObjectURL(blob);
  const stamp = new Date().toISOString().slice(0, 10);
  const a = el('a', { href: url, download: `proxymate-backup-${stamp}.json` });
  document.body.appendChild(a);
  a.click();
  a.remove();
  setTimeout(() => URL.revokeObjectURL(url), 10000);
  backupMsg(`Сохранено профилей: ${data.profiles.length}` +
    (data.withPasswords ? ' (с паролями — храните файл как секрет)' : ' (без паролей)'));
}

async function importBackup(file) {
  const text = await file.text();
  let data;
  try {
    data = JSON.parse(text);
  } catch (e) {
    return backupMsg('Это не JSON: ' + e.message, true);
  }
  const replace = $('imp-replace').checked;
  if (replace && !confirm('Заменить все текущие профили и настройки содержимым файла? Отменить будет нельзя.')) return;

  const res = await send('importData', { data, replace });
  await refresh();
  backupMsg(res.replaced
    ? `Восстановлено профилей: ${res.added}` + (res.settings ? ', настройки применены' : '')
    : `Добавлено: ${res.added}` + (res.skipped ? `, пропущено дубликатов: ${res.skipped}` : ''));
}

$('backup-open').addEventListener('click', () => { backupMsg(''); $('backup').showModal(); });
$('backup-close').addEventListener('click', () => $('backup').close());
$('export').addEventListener('click', (e) => {
  e.target.disabled = true;
  exportBackup().catch((err) => backupMsg(err.message, true)).finally(() => { e.target.disabled = false; });
});
$('import-file').addEventListener('click', () => $('imp-input').click());
$('imp-input').addEventListener('change', (e) => {
  const file = e.target.files[0];
  e.target.value = '';   // чтобы повторный выбор того же файла сработал
  if (file) importBackup(file).catch((err) => backupMsg(err.message, true));
});
$('test-profile').addEventListener('click', (e) => testDraft(e.target));

$('add').addEventListener('click', () => openEditor(null));
$('cancel').addEventListener('click', closeEditor);
$('editor').addEventListener('close', () => { editing = null; });   // закрытие по Esc
$('save-profile').addEventListener('click', () => saveProfile().catch((e) => flash(e.message, true)));
$('delete').addEventListener('click', () => deleteProfile().catch((e) => flash(e.message, true)));
$('f-mode').addEventListener('change', syncEditorState);
$('f-scheme').addEventListener('change', syncEditorState);
$('f-user').addEventListener('input', syncEditorState);
$('save-settings').addEventListener('click', () => saveSettings().catch((e) => flash(e.message, true)));
$('reset').addEventListener('click', async () => {
  await send('resetAll');
  await refresh();
  flash('Прокси отключён, настройки браузера восстановлены');
});
$('leak').addEventListener('click', () => {
  chrome.tabs.create({ url: chrome.runtime.getURL('src/leaktest/leaktest.html') });
});
$('refresh-diag').addEventListener('click', () => renderDiag());
$('check-update').addEventListener('click', (e) => checkUpdate(e.target));

/* --- исключения --- */
function commitInput() {
  const raw = $('bp-input').value;
  if (!raw.trim()) return;
  const { added, rejected } = addRules(raw, $('bp-subs').checked);
  $('bp-input').value = '';
  if (rejected.length) flash('Не похоже на правило обхода: ' + rejected.join(', '), true);
  else if (!added.length) flash('Уже в списке');
  else flash('Добавлено: ' + added.join(', '));
}
$('bp-add').addEventListener('click', commitInput);
$('bp-input').addEventListener('keydown', (e) => {
  if (e.key === 'Enter' || e.key === ',') { e.preventDefault(); commitInput(); }
});
$('bp-tab').addEventListener('click', async () => {
  const [tab] = await chrome.tabs.query({ active: true, lastFocusedWindow: true });
  const tabs = tab && /^https?:/.test(tab.url || '') ? [tab]
    : await chrome.tabs.query({ url: ['http://*/*', 'https://*/*'] });
  if (!tabs.length) return flash('Нет открытой http/https-вкладки', true);
  const host = new URL(tabs[0].url).hostname;
  const { added } = addRules(host, $('bp-subs').checked);
  flash(added.length ? 'Добавлено: ' + added.join(', ') : host + ' уже в списке');
});
$('bp-local').addEventListener('click', () => {
  const { added } = addRules('<local> <-loopback> 10.0.0.0/8 172.16.0.0/12 192.168.0.0/16', false);
  flash(added.length ? 'Добавлено: ' + added.join(', ') : 'Локальные адреса уже в списке');
});
$('bp-clear').addEventListener('click', () => { bypass = []; renderChips(); flash('Список очищен — не забудьте сохранить'); });
$('test').addEventListener('click', (e) => {
  e.target.disabled = true;
  testProxy().catch((err) => flash(err.message, true)).finally(() => { e.target.disabled = false; });
});
$('import').addEventListener('click', async () => {
  const lines = $('bulk').value.split('\n');
  const parsed = [];
  const bad = [];
  lines.forEach((line, i) => {
    if (!line.trim()) return;
    const p = parseProxyLine(line);
    if (p) parsed.push(p); else bad.push(i + 1);
  });
  if (!parsed.length) return flash('Ничего не распознано', true);
  await send('importProfiles', { profiles: parsed });
  $('bulk').value = '';
  await refreshStatus();
  flash(`Добавлено: ${parsed.length}` + (bad.length ? `; пропущены строки: ${bad.join(', ')}` : ''));
});

refresh();
