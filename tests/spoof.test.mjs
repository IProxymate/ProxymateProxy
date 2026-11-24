// Проверка подмены в Node: `node --test tests/`
// Код подмены исполняется в отдельном vm-контексте — так же, как в чужом
// realm страницы. Два пути: собранный userscript-код (как его внедряет
// chrome.userScripts) и прямой вызов с чужим глобальным объектом (как для
// about:blank-фреймов).
import test from 'node:test';
import assert from 'node:assert/strict';
import vm from 'node:vm';
import { spoofMain, buildUserScriptCode } from '../src/lib/spoof.js';

function realm() {
  const ctx = vm.createContext({});
  const run = (code) => vm.runInContext(code, ctx);
  return { ctx, run, G: run('globalThis') };
}

const TOKYO = { timeZone: 'Asia/Tokyo', languages: ['ja-JP', 'ja', 'en'] };
const NY = { timeZone: 'America/New_York', languages: ['en-US', 'en'] };

for (const mode of ['userscript', 'cross-realm']) {
  const apply = (r, cfg) => (mode === 'userscript' ? r.run(buildUserScriptCode(cfg)) : spoofMain(cfg, r.G));

  test(`${mode}: часовой пояс и Intl`, () => {
    const r = realm();
    apply(r, TOKYO);
    assert.equal(r.run('new Date(0).getHours()'), 9);
    assert.equal(r.run('new Date(0).getTimezoneOffset()'), -540);
    assert.equal(r.run('Intl.DateTimeFormat().resolvedOptions().timeZone'), 'Asia/Tokyo');
    assert.equal(r.run('Intl.DateTimeFormat().resolvedOptions().locale'), 'ja-JP');
    assert.equal(r.run('new Date(2026, 0, 1).toISOString()'), '2025-12-31T15:00:00.000Z');
    assert.match(r.run('new Date(0).toString()'), /GMT\+0900/);
  });

  test(`${mode}: переходы на летнее время`, () => {
    const r = realm();
    apply(r, NY);
    // 8 марта 2026, 02:30 не существует — V8 сдвигает на 03:30
    assert.equal(r.run('new Date(2026, 2, 8, 2, 30).getHours()'), 3);
    // 1 ноября 2026, 01:30 повторяется — берётся первое вхождение (EDT)
    assert.equal(r.run('new Date(2026, 10, 1, 1, 30).getTimezoneOffset()'), 240);
    assert.equal(r.run('(() => { const d = new Date(2026, 5, 1); d.setHours(12); return d.toISOString(); })()'),
      '2026-06-01T16:00:00.000Z');
  });

  test(`${mode}: маскировка под нативные функции`, () => {
    const r = realm();
    apply(r, TOKYO);
    assert.match(r.run('Function.prototype.toString.call(Date.prototype.getHours)'), /\[native code\]/);
    assert.match(r.run('Function.prototype.toString.call(Function.prototype.toString)'), /\[native code\]/);
    assert.equal(r.run('Date.prototype.setHours.length'), 4);
    assert.equal(r.run('Date.prototype.toLocaleString.length'), 0);
    assert.equal(r.run('Date.prototype.getHours.name'), 'getHours');
    assert.equal(r.run('Object.getOwnPropertyNames(globalThis).some((n) => /proxymate/i.test(n))'), false);
    assert.throws(() => r.run('Function.prototype.toString.call("x")'), { name: 'TypeError' });
  });

  test(`${mode}: повторное применение не сдвигает время дважды`, () => {
    const r = realm();
    apply(r, TOKYO);
    apply(r, TOKYO);
    assert.equal(r.run('new Date(0).getHours()'), 9);
    assert.equal(r.run('new Date(2026, 0, 1).toISOString()'), '2025-12-31T15:00:00.000Z');
  });

  test(`${mode}: Temporal.Now, если он есть`, (t) => {
    const r = realm();
    if (!r.run('typeof Temporal !== "undefined" && !!Temporal.Now')) return t.skip('Temporal недоступен в этом Node');
    apply(r, TOKYO);
    assert.equal(r.run('Temporal.Now.timeZoneId()'), 'Asia/Tokyo');
    assert.equal(r.run('Temporal.Now.zonedDateTimeISO().timeZoneId'), 'Asia/Tokyo');
    assert.equal(r.run('Temporal.Now.zonedDateTimeISO("UTC").timeZoneId'), 'UTC');
  });
}

test('без зоны в конфиге Date не трогается', () => {
  const r = realm();
  const before = r.run('Date.prototype.getHours');
  spoofMain({ timeZone: null, languages: null }, r.G);
  assert.equal(r.run('Date.prototype.getHours'), before);
});
