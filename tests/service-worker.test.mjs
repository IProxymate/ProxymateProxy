// Фоновый процесс на заглушках chrome.*: гонки подключения, самовосстановление,
// блокировка трафика, счётчик живости туннеля. `node --test tests/`
//
// Модуль service worker'а держит состояние в памяти, поэтому он загружается
// один раз, а сценарии идут строго по порядку.
import test from 'node:test';
import assert from 'node:assert/strict';

const ev = () => { const ls = []; return { addListener: (f) => ls.push(f), ls }; };
const tick = () => new Promise((r) => setTimeout(r, 5));
const wait = (ms) => new Promise((r) => setTimeout(r, ms));

const storageChanged = ev();
function store(init = {}, area) {
  const data = { ...init };
  return {
    data,
    async get(keys) {
      const ks = typeof keys === 'string' ? [keys] : Array.isArray(keys) ? keys : Object.keys(data);
      const o = {};
      for (const k of ks) if (k in data) o[k] = structuredClone(data[k]);
      return o;
    },
    async set(o) {
      const changes = {};
      for (const [k, v] of Object.entries(o)) changes[k] = { oldValue: data[k], newValue: structuredClone(v) };
      Object.assign(data, structuredClone(o));
      for (const f of storageChanged.ls) f(changes, area);
    },
    async remove(ks) { for (const k of [].concat(ks)) delete data[k]; }
  };
}

let proxyValue = null;          // null — расширение прокси не держит
let otherExtension = false;     // настройками завладело другое расширение
const proxyOnChange = ev();
const fireControl = () => {
  const levelOfControl = otherExtension ? 'controlled_by_other_extensions'
    : proxyValue ? 'controlled_by_this_extension' : 'controllable_by_this_extension';
  for (const f of proxyOnChange.ls) f({ levelOfControl });
};
let sessionRules = [];
const onMessage = ev();

globalThis.chrome = {
  runtime: {
    onInstalled: ev(), onStartup: ev(), onMessage,
    getURL: (p) => p, getManifest: () => ({ version: '0.0.0' }), openOptionsPage() {}
  },
  alarms: { create() {}, onAlarm: ev() },
  notifications: { create: async () => {}, clear: async () => {}, onClicked: ev() },
  webRequest: { onAuthRequired: ev(), onCompleted: ev(), onErrorOccurred: ev() },
  storage: {
    local: store({
      profiles: [{ id: 'a', name: 'A', scheme: 'http', host: '1.2.3.4', port: 80, spoofMode: 'auto' }],
      activeId: null,
      settings: { bypassList: ['localhost', 'bypassed.example'] }
    }, 'local'),
    session: store({}, 'session'),
    onChanged: storageChanged
  },
  proxy: {
    settings: {
      async get() {
        return {
          levelOfControl: otherExtension ? 'controlled_by_other_extensions'
            : proxyValue ? 'controlled_by_this_extension' : 'controllable_by_this_extension',
          value: proxyValue || { mode: 'system' }
        };
      },
      async set({ value }) { await tick(); proxyValue = value; fireControl(); },
      async clear() { await tick(); proxyValue = null; fireControl(); },
      onChange: proxyOnChange
    },
    onProxyError: ev()
  },
  action: { setBadgeText: async () => {}, setBadgeBackgroundColor: async () => {} },
  privacy: { network: { webRTCIPHandlingPolicy: { set: async () => {}, get: async () => ({}) } } },
  declarativeNetRequest: {
    updateDynamicRules: async () => {},
    getDynamicRules: async () => [],
    async updateSessionRules({ removeRuleIds = [], addRules = [] }) {
      sessionRules = sessionRules.filter((r) => !removeRuleIds.includes(r.id)).concat(addRules);
    },
    async getSessionRules() { return sessionRules; }
  },
  scripting: { executeScript: async () => {} },
  webNavigation: { onCommitted: ev() },
  tabs: { query: async () => [], create() {} }
};

// fetch к гео-сервисам висит, пока тест не ответит сам.
let pending = [];
globalThis.fetch = (url, opts) => new Promise((resolve, reject) => {
  pending.push({ url, resolve, reject });
  opts?.signal?.addEventListener('abort', () => {
    const e = new Error('aborted'); e.name = 'AbortError'; reject(e);
  });
});
function answerGeo() {
  const items = pending; pending = [];
  for (const it of items) {
    it.resolve({
      ok: true,
      json: async () => ({
        success: true, ip: '9.9.9.9', country: 'Netherlands', country_code: 'NL',
        timezone: { id: 'Europe/Amsterdam' }, latitude: 52, longitude: 4
      })
    });
  }
}

const origWarn = console.warn;
console.warn = () => {};
await import('../src/background/service-worker.js');
const send = (type, payload) => new Promise((res) => onMessage.ls[0]({ type, payload }, {}, res));
const killOn = () => sessionRules.some((r) => r.action.type === 'block');
/** События во время собственной записи перепроверяются с задержкой ~1,5 с. */
const settle = () => wait(1700);
await wait(50);

test.after(() => { console.warn = origWarn; });

test('запоздалое гео после отключения не включает прокси обратно', async () => {
  const r = await send('connect', { id: 'a' });
  assert.equal(r.data.geoPending, true, 'connect отвечает, не дожидаясь гео');
  assert.equal(proxyValue?.mode, 'fixed_servers');
  await send('disconnect');
  assert.equal(proxyValue, null);
  answerGeo();
  await wait(100);
  assert.equal(proxyValue, null);
  assert.equal(chrome.storage.local.data.activeId, null);
});

test('запоздалый check после отключения не включает прокси обратно', async () => {
  await send('connect', { id: 'a' });
  answerGeo(); await wait(100);
  const pendingCheck = send('check');
  await wait(20);
  await send('disconnect');
  answerGeo();
  const r = await pendingCheck;
  await wait(50);
  assert.equal(proxyValue, null);
  assert.match(r.error, /сменилось/);
});

test('открытие popup снимает «бесхозный» прокси', async () => {
  proxyValue = { mode: 'fixed_servers', rules: {} };
  await send('getState');
  assert.equal(proxyValue, null);
});

test('проба профиля не оставляет соединение без прокси', async () => {
  const probe = send('testProfile', { profile: { scheme: 'http', host: '5.5.5.5', port: 8080 } });
  await wait(30);
  assert.equal(proxyValue?.mode, 'pac_script');
  await send('connect', { id: 'a' });
  answerGeo();
  const r = await probe;
  await wait(100);
  assert.equal(proxyValue?.mode, 'fixed_servers');
  assert.equal(r.data.ok, false, 'проба помечена прерванной');
  await send('disconnect');
});

test('перехват прокси другим расширением включает блокировку трафика', async () => {
  await send('connect', { id: 'a' });
  answerGeo(); await wait(100);
  assert.equal(killOn(), false);
  otherExtension = true;
  fireControl();
  await settle();
  assert.equal(killOn(), true, 'перехват сразу после нашей записи тоже замечен');
  const st = await send('getState');
  assert.equal(st.data.health.state, 'hijacked');
  assert.equal(st.data.killSwitchOn, true);
  await send('disconnect');
  assert.equal(killOn(), false, '«Отключить» снимает блокировку');
  otherExtension = false;
});

test('блокировка не включается, если она выключена в настройках', async () => {
  await send('saveSettings', { settings: { killSwitch: false } });
  await send('connect', { id: 'a' });
  answerGeo(); await wait(100);
  otherExtension = true;
  fireControl();
  await settle();
  assert.equal(killOn(), false);
  await send('disconnect');
  otherExtension = false;
  await send('saveSettings', { settings: { killSwitch: true } });
});

test('успех сайта из списка обхода не маскирует мёртвый туннель', async () => {
  await send('connect', { id: 'a' });
  answerGeo(); await wait(100);
  const err = (n) => chrome.webRequest.onErrorOccurred.ls[0]({
    requestId: 'e' + n, url: 'https://site' + n + '.example/', error: 'net::ERR_PROXY_CONNECTION_FAILED', type: 'main_frame'
  });
  const ok = (url, extra = {}) => chrome.webRequest.onCompleted.ls[0]({ requestId: 'ok', url, statusCode: 200, ...extra });
  err(1); err(2);
  ok('https://bypassed.example/');
  ok('http://localhost:3000/');
  ok('https://cached.example/', { fromCache: true });
  err(3);
  await wait(50);
  const st = await send('getState');
  assert.equal(st.data.health.state, 'failing');
  ok('https://real.example/');
  await wait(50);
  assert.equal((await send('getState')).data.health.state, 'ok', 'настоящий успех снимает тревогу');
  await send('disconnect');
});

test('onAuthRequired отвечает по таймауту, даже если хранилище зависло', async () => {
  await send('connect', { id: 'a' });
  answerGeo();
  await settle();
  const origGet = chrome.storage.local.get;
  chrome.storage.local.get = () => new Promise(() => {});
  let reply = null;
  chrome.webRequest.onAuthRequired.ls[0]({ isProxy: true, url: 'https://x.example/', requestId: 'r1' }, (v) => { reply = v; });
  await wait(5200);
  chrome.storage.local.get = origGet;
  assert.deepEqual(reply, { cancel: true });
  await send('disconnect');
});

test('очередь не блокируется навсегда зависшей операцией', async () => {
  // Зависший getState внутри очереди — затем «Отключить» всё равно проходит.
  await send('connect', { id: 'a' });
  answerGeo();
  await settle();
  const origGet = chrome.storage.local.get;
  let hung = true;
  chrome.storage.local.get = (k) => (hung ? new Promise(() => {}) : origGet(k));
  send('saveSettings', { settings: {} });   // повиснет на getState
  await wait(20);
  hung = false;
  chrome.storage.local.get = origGet;
  const started = Date.now();
  await send('disconnect');
  assert.ok(Date.now() - started < 17000);
  assert.equal(proxyValue, null);
});
