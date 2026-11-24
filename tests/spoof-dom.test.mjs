// Web Worker'ы и пустые iframe на минимальных заглушках DOM: `node --test tests/`
import test from 'node:test';
import assert from 'node:assert/strict';
import vm from 'node:vm';
import { spoofMain, buildUserScriptCode } from '../src/lib/spoof.js';

const TOKYO = { timeZone: 'Asia/Tokyo', languages: ['ja-JP', 'ja'] };

function realm(extra = {}) {
  const ctx = vm.createContext(extra);
  const run = (code) => vm.runInContext(code, ctx);
  return { ctx, run, G: run('globalThis') };
}

/** Blob, URL, синхронный XHR по blob: и конструктор Worker, запоминающий адреса. */
const WORKER_SHIM = `
  globalThis.__blobs = new Map();
  globalThis.__made = [];
  let __n = 0;
  globalThis.setTimeout = function () { return 0; };
  globalThis.Blob = class Blob { constructor(parts) { this.text = parts.join(''); } };
  globalThis.URL = {
    createObjectURL(b) { const u = 'blob:test/' + (++__n); __blobs.set(u, b.text); return u; },
    revokeObjectURL(u) { __blobs.delete(u); }
  };
  globalThis.XMLHttpRequest = class XMLHttpRequest {
    open(m, u) { this.u = u; }
    send() { this.status = __blobs.has(this.u) ? 200 : 404; this.responseText = __blobs.get(this.u) || ''; }
  };
  globalThis.Worker = class Worker { constructor(u) { __made.push(String(u)); } };
`;

for (const mode of ['userscript', 'cross-realm']) {
  test(`${mode}: blob-воркер получает подмену до своего кода`, () => {
    const page = realm();
    page.run(WORKER_SHIM);
    if (mode === 'userscript') page.run(buildUserScriptCode(TOKYO));
    else spoofMain(TOKYO, page.G);

    // Типичный приём фингерпринтинга: воркер из строки, URL сразу отзывается.
    page.run(`
      const u = URL.createObjectURL(new Blob(['globalThis.__h = new Date(0).getHours();']));
      new Worker(u);
      URL.revokeObjectURL(u);
    `);
    const made = page.run('__made[0]');
    assert.match(made, /^blob:/);
    const code = page.run(`__blobs.get(${JSON.stringify(made)})`);
    assert.ok(code, 'пересобранный blob ещё жив');
    assert.match(code, /^\(function spoofMain/);

    // Исполняем пересобранный код в отдельном контексте, как в воркере.
    const worker = realm();
    worker.run(code);
    assert.equal(worker.run('__h'), 9);
  });

  test(`${mode}: воркер с обычным URL не пересобирается`, () => {
    const page = realm();
    page.run(WORKER_SHIM);
    if (mode === 'userscript') page.run(buildUserScriptCode(TOKYO));
    else spoofMain(TOKYO, page.G);
    page.run(`new Worker('https://example.com/w.js')`);
    assert.equal(page.run('__made[0]'), 'https://example.com/w.js');
  });

  test(`${mode}: директива "use strict" остаётся первой`, () => {
    const page = realm();
    page.run(WORKER_SHIM);
    if (mode === 'userscript') page.run(buildUserScriptCode(TOKYO));
    else spoofMain(TOKYO, page.G);
    page.run(`new Worker(URL.createObjectURL(new Blob(['"use strict";\\nglobalThis.__strict = (function () { return this === undefined; })();'])))`);
    const code = page.run('__blobs.get(__made[0])');
    const worker = realm();
    worker.run(code);
    assert.equal(worker.run('__strict'), true);
  });
}

test('about:blank-фрейм подменяется при первом доступе к contentWindow', () => {
  const page = realm();
  const frame = realm();
  page.ctx.__frame = frame.G;
  page.run(`
    globalThis.HTMLIFrameElement = class HTMLIFrameElement {
      get contentWindow() { return __frame; }
      get contentDocument() { return null; }
    };
  `);
  page.run(buildUserScriptCode(TOKYO));
  const untouched = frame.run('Date.prototype.getHours');
  assert.equal(frame.run('Date.prototype.getHours'), untouched, 'до доступа фрейм не тронут');
  page.run('new HTMLIFrameElement().contentWindow');
  assert.notEqual(frame.run('Date.prototype.getHours'), untouched);
  assert.equal(frame.run('new Date(0).getHours()'), 9);
  assert.equal(frame.run('Intl.DateTimeFormat().resolvedOptions().timeZone'), 'Asia/Tokyo');
  // Повторный доступ не применяет подмену второй раз.
  page.run('new HTMLIFrameElement().contentWindow');
  assert.equal(frame.run('new Date(0).getHours()'), 9);
  assert.equal(page.run('Object.getOwnPropertyDescriptor(HTMLIFrameElement.prototype, "contentWindow").get.name'),
    'get contentWindow');
});
