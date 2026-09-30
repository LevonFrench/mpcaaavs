// CPU check of the host side of the stage timing (src/mpc-host.ts, src/perf-trace.ts) against the same fake page check-mpc-host.mjs uses,
// with a NERV catalog so render requests take the show-worker path:
//  - off by default: render requests carry no `perf` field, nothing is recorded, the timing line has no perf segment;
//  - enabled (?perf=1): requests carry {mode, sent?}, frame replies with a worker report feed the recorder, window.__aaavsPerf.trace() validates,
//    the timing line shows a perf segment;
//  - Ctrl+Alt+P cycles off -> CPU -> synchronised -> off;
//  - a malformed worker report is ignored, and the host never throws on it.
//   node tools/check-perf-host.mjs
import { build } from 'esbuild';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';

const bundle = async (entry, plugins = []) => (await build({ entryPoints: [entry], bundle: true, format: 'esm', write: false, define: { 'import.meta.url': '"https://aaavs.invalid/dist/mpc-host.js"' }, plugins })).outputFiles[0].text;
const trace = await import(`data:text/javascript;base64,${Buffer.from(await bundle('src/perf-trace.ts')).toString('base64')}`);
const hostText = await bundle('src/mpc-host.ts', [{ name: 'fixture-catalog', setup(b) {
  b.onResolve({ filter: /local-collection\.ts$/ }, () => ({ path: 'catalog', namespace: 'test' }));
  b.onResolve({ filter: /mpc-bitmap-dependencies\.ts$/ }, () => ({ path: 'bitmaps', namespace: 'test' }));
  b.onLoad({ filter: /.*/, namespace: 'test' }, (args) => ({ contents: args.path === 'catalog'
    ? `export async function fetchLocalAvsCatalog(){return [0,1,2].map(i=>({name:'plate '+i,sha256:''+i,autoEligible:true,kind:'nerv',scene:['magi','psycho','radar'][i]}));} export function fetchLocalAvsPreset(p){return Promise.resolve(new Uint8Array(4));} export function isSceneKind(p){return p?.kind==='nerv'||p?.kind==='hud'} export async function fetchLocalAvsSources(){return new Map()}`
    : 'export async function loadPresetBitmaps(){return [];}' }));
} }]);

let n = 0;
const ok = (c, m) => { n++; assert.ok(c, m); };
async function session(search) {
  const posted = [], workers = [], nodes = new Map(), timers = new Map();
  let timer = 0, now = 0, listener, raf, keydown, pagehide;
  Object.defineProperty(globalThis, 'performance', { value: { now: () => now, timeOrigin: 1e12 }, configurable: true });
  globalThis.fetch = async () => { throw Error('offline fixture'); };
  const ctx = { clearRect() {}, setTransform() {}, globalAlpha: 1, drawImage() {}, getImageData() { return { data: new Uint8ClampedArray(256 * 144 * 4) }; }, save() {}, restore() {}, beginPath() {}, rect() {}, clip() {}, fillRect() {}, createPattern() { return {}; } };
  class Element {
    constructor(tag) { this.tagName = tag; this.children = []; this.attributes = {}; this.textContent = ''; this.value = ''; }
    append(...i) { this.children.push(...i); } prepend(...i) { this.children.unshift(...i); } replaceChildren(...i) { this.children = i; } setAttribute(k, v) { this.attributes[k] = v; }
    addEventListener() {} focus() {} all() { return [this, ...this.children.flatMap((c) => c.all())]; } querySelector() { return undefined; }
  }
  const canvas = () => ({ width: 640, height: 360, clientWidth: 640, clientHeight: 360, getContext() { return { ...ctx, canvas: this }; } });
  globalThis.OffscreenCanvas = class { constructor(w, h) { Object.assign(this, canvas(), { width: w, height: h }); } };
  const classes = new Set();
  globalThis.document = { hidden: false, baseURI: 'https://aaavs.invalid/mpc.html', body: { append() {}, classList: { add(x) { classes.add(x); }, remove(x) { classes.delete(x); } } },
    createElement(tag) { return tag === 'canvas' ? canvas() : new Element(tag); },
    querySelector(id) { if (!nodes.has(id)) nodes.set(id, id === '#visualizer' ? canvas() : id === '#management' ? new Element('section') : { textContent: '' }); return nodes.get(id); },
    addEventListener(type, fn) { if (type === 'keydown') keydown = fn; } };
  globalThis.window = { location: { reload() {}, search }, chrome: { webview: { postMessage(m) { posted.push(m); }, addEventListener(_, fn) { listener = fn; } } },
    setTimeout(fn, d) { timers.set(++timer, { fn, at: now + d }); return timer; }, addEventListener(type, fn) { if (type === 'pagehide') pagehide = fn; } };
  globalThis.clearTimeout = (id) => timers.delete(id);
  globalThis.requestAnimationFrame = (fn) => { raf = fn; }; globalThis.devicePixelRatio = 1;
  globalThis.Worker = class { constructor(url) { this.url = String(url); this.requests = []; this.dead = false; workers.push(this); } postMessage(m) { this.requests.push(m); } terminate() { this.dead = true; } };
  const flush = async () => { for (let i = 0; i < 12; i++) await Promise.resolve(); };
  const tick = (ms = 16) => { now += ms; raf(now); };
  const bitmap = () => ({ width: 640, height: 360, close() {} });
  await import(`data:text/javascript;base64,${Buffer.from(hostText + `\n// session ${Math.random()}`).toString('base64')}`);
  await flush();
  // the first preset loads: the catalog fixture resolves synchronously, so a worker exists once the microtasks have run
  const w = workers.at(-1);
  ok(w && w.url.includes('show-render.worker.js'), 'a NERV preset starts the show worker');
  w.onmessage({ data: { type: 'ready', generation: 1, unsupported: 0, renderer: 'show' } });
  const message = (data) => listener({ data });
  return { w, workers, posted, nodes, classes, tick, message, keydown: (e) => keydown({ preventDefault() {}, ...e }), flush, bitmap, pagehide, set now(v) { now = v; }, get now() { return now; } };
}
const audio = (s, position, playing = true) => s.message({ type: 'audio', playing, position, epoch: 1, pcm: Array(1152).fill(0), frames: [{ time: position, sampleRate: 44100, samples: 576, pcm: Array(1152).fill(0) }] });
const renders = (w) => w.requests.filter((r) => r.type === 'render');
const answer = (s) => { const r = renders(s.w).at(-1); s.w.onmessage({ data: { type: 'frame', generation: 1, sequence: r.sequence, bitmap: s.bitmap(), pcm: new ArrayBuffer(4), width: 640, height: 360, unsupported: 0, renderMs: 5 } }); };
const report = () => ({ stages: { 'frame.total': 9, 'scene.render': 6 }, counts: { 'frame.total': 1 }, mode: 1, epoch: 1e12 + 1 });

// ------------------------------------------------------------------ off by default
{
  const s = await session('');
  ok(typeof window.__aaavsPerf.enable === 'function' && window.__aaavsPerf.mode === 0, 'the page exposes window.__aaavsPerf, off');
  audio(s, 0); s.tick();
  ok(renders(s.w).length >= 1, 'the host renders');
  for (const r of renders(s.w)) ok(!('perf' in r), 'a render request carries no perf field while off');
  s.w.onmessage({ data: { type: 'frame', generation: 1, sequence: 1, bitmap: s.bitmap(), pcm: new ArrayBuffer(4), width: 640, height: 360, unsupported: 0, renderMs: 5, perf: report() } });
  s.tick();
  const t = window.__aaavsPerf.trace(false);
  ok(Object.keys(t.stages).length === 0 && Object.keys(t.counters).length === 0 && t.frames === 0, 'nothing is recorded while off, even when a worker sends a report');
  ok(!(s.nodes.get('#timing').textContent ?? '').includes('perf'), 'the timing line has no perf segment while off');
  ok(!s.classes.has('timing-always'), 'the timing overlay is not forced visible');
}

// ------------------------------------------------------------------ enabled by the page URL
{
  const s = await session('?perf=1');
  ok(window.__aaavsPerf.mode === 1, '?perf=1 enables CPU timestamps');
  audio(s, 0); s.tick();
  const req = renders(s.w).at(-1);
  ok(req.perf && req.perf.mode === 1 && typeof req.perf.sent === 'number' && Number.isFinite(req.perf.sent), 'render requests carry {mode, sent}');
  s.tick(20);
  s.w.onmessage({ data: { type: 'frame', generation: 1, sequence: req.sequence, bitmap: s.bitmap(), pcm: new ArrayBuffer(4), width: 640, height: 360, unsupported: 0, renderMs: 5, perf: report() } });
  // the first reply commits the prepared slot; the next round trip belongs to the active slot and is the one that is measured
  audio(s, 0.05); s.tick();
  const req1 = renders(s.w).at(-1);
  s.tick(20);
  s.w.onmessage({ data: { type: 'frame', generation: 1, sequence: req1.sequence, bitmap: s.bitmap(), pcm: new ArrayBuffer(4), width: 640, height: 360, unsupported: 0, renderMs: 5, perf: report() } });
  audio(s, 0.08); s.tick(); s.tick(); s.tick(600);
  const t = window.__aaavsPerf.trace(true);
  trace.validateTrace(t);
  ok(t.stages['host.rtt'].n >= 1 && t.stages['frame.total'].p50 === 9 && t.stages['scene.render'].p50 === 6 && t.stages['host.reply'].n >= 1, 'the worker report and the round trip are recorded');
  ok(t.counters['host.render.messages'].total >= 1 && t.counters['host.render.bytes'].total >= 4608 && t.counters['host.audio.messages'].total >= 1 && t.counters['host.audio.floats'].total >= 1152 && t.counters['host.frame.messages'].total >= 1, 'message counters');
  ok(t.stages['host.raf.interval'].n >= 2 && t.stages['host.raf.busy'].n >= 2, 'rAF cadence and callback time are recorded');
  ok(t.meta && t.meta.page === 'mpc-host' && ['present', 'display', 'render', 'clock'].every((k) => k in t.meta.fps), 'the trace carries the existing FPS meter channels');
  ok(t.stages['host.audio.msg'].n >= 1, 'native audio message handling time is recorded');
  ok(s.classes.has('timing-always') && (s.nodes.get('#timing').textContent ?? '').includes('perf'), 'the timing line shows the perf segment');
  // a malformed report is dropped, not thrown
  const before = window.__aaavsPerf.trace(false).stages['frame.total'].n;
  audio(s, 0.1); s.tick();
  const req2 = renders(s.w).at(-1);
  s.w.onmessage({ data: { type: 'frame', generation: 1, sequence: req2.sequence, bitmap: s.bitmap(), pcm: new ArrayBuffer(4), width: 640, height: 360, unsupported: 0, renderMs: 5, perf: { stages: { 'bogus.stage': 1 }, mode: 1 } } });
  ok(window.__aaavsPerf.trace(false).stages['frame.total'].n === before, 'a malformed worker report is ignored');
  // toggling: Ctrl+Alt+P cycles off -> CPU -> sync -> off
  window.__aaavsPerf.disable();
  ok(window.__aaavsPerf.mode === 0, 'disable()');
  s.keydown({ ctrlKey: true, altKey: true, code: 'KeyP' }); ok(window.__aaavsPerf.mode === 1, 'Ctrl+Alt+P: CPU timestamps');
  s.keydown({ ctrlKey: true, altKey: true, code: 'KeyP' }); ok(window.__aaavsPerf.mode === 2, 'Ctrl+Alt+P again: GL-synchronised');
  answer(s); audio(s, 0.2); s.tick(); s.tick(); s.tick(600);
  ok(renders(s.w).at(-1).perf?.mode === 2, 'requests carry the synchronised mode');
  s.keydown({ ctrlKey: true, altKey: true, code: 'KeyP' }); ok(window.__aaavsPerf.mode === 0, 'Ctrl+Alt+P again: off');
  answer(s); audio(s, 0.3); s.tick(); s.tick(); s.tick(600);
  ok(!('perf' in renders(s.w).at(-1)), 'and requests stop carrying the field');
  s.pagehide();
}

// ------------------------------------------------------------------ enabled by the stored preference
{
  globalThis.localStorage = { getItem: (k) => (k === 'mpcaaavs.perf' ? 'sync' : null) };
  const s = await session('');
  ok(window.__aaavsPerf.mode === 2, 'localStorage mpcaaavs.perf=sync enables the synchronised mode');
  s.pagehide();
  delete globalThis.localStorage;
}
console.log(`Host stage timing PASS (${n} assertions): off by default and absent from messages, enabled by URL/storage/key, recorder and trace, malformed reports ignored.`);
