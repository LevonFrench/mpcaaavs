import {build} from 'esbuild';
import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import {resolve} from 'node:path';
// Host-level check of the render-resolution wiring in src/mpc-host.ts (docs/design/CONTRACT.md Appendix A, RES column; RES 5.5-5.9).
// Written in Wave 1 as a specification: it FAILS until INT1 applies the RES call sites to the host in Wave 3, and it needs no browser, GPU,
// worker or server. The real host is bundled with the real sizer, presenter, display prefs, flash gate and AvsTransition; only the
// collection, the Preset Manager and bitmap loading are replaced, and the DOM, canvases, contexts, workers and ResizeObserver are fakes.
//
// What it pins (all observable through the fakes):
//  - AVS classic keeps today's rule bit for bit through the host: worker load and render sizes, present canvas, nearest sampling, and the
//    `load` message carries the policy size (no 640x360 warm-up); size changes wait 250 ms (AVS) or 120 ms (NERV) on the host clock.
//  - NERV renders at device resolution by tier (Auto = High), is presented 1:1 with smoothing, keeps rendering while paused when its size
//    changes, follows a device-pixel content box, and steps the Auto tier down under sustained slow frames (round trip, playing only).
//  - The composite copy is skipped without a transition; a transition composites into the larger plate and passes `smooth` for scene kinds.
//  - Display preferences arrive on the `settings` message (integers; absent or invalid keeps the current value), reach the Preset Manager
//    through Actions.display/setDisplay, leave through a `display:` string, and toggle body.timing-always.
//  - The flash probe sampler is created with imageSmoothingQuality 'medium'.
// AAAVS_HOST_ENTRY (optional) bundles another host file with src/ as its import root: how the owner rehearses an edit list before applying it.
const entry = process.env.AAAVS_HOST_ENTRY ? resolve(process.env.AAAVS_HOST_ENTRY) : resolve('src/mpc-host.ts');
const hostText = readFileSync(entry, 'utf8');
assert.ok(/render-sizer\.ts'/.test(hostText) && /mpc-display\.ts'/.test(hostText) && /render-resolution\.ts'/.test(hostText),
  'mpc-host.ts is not wired to the resolution policy yet: apply the RES column of docs/design/CONTRACT.md Appendix A (RenderSizer, mpc-display, render-resolution imports) before this check can pass');
const D = await bundle('src/mpc-display.ts');
async function bundle(path) { const r = await build({entryPoints: [path], bundle: true, format: 'esm', write: false}); return import(`data:text/javascript;base64,${Buffer.from(r.outputFiles[0].text).toString('base64')}`); }

const scenes = ['boot', 'magi'];
const catalog = [
  ...[0, 1].map(i => ({name: `avs ${i}`, sha256: `a${i}`.padEnd(64, '0'), autoEligible: true})),
  ...scenes.map((scene, i) => ({kind: 'nerv', scene, name: `NERV ${scene}`, sha256: `b${i}`.padEnd(64, '0'), autoEligible: true})),
];
const spy = `
export class AvsTransition extends RealAvsTransition {
  constructor(mode: number, options?: any) { super(mode, options); ((globalThis as any).transitionLog ||= []).push({ mode, smooth: options?.smooth === true, options }); }
}`;
const result = await build({stdin: {contents: hostText, resolveDir: resolve('src'), sourcefile: entry, loader: 'ts'}, bundle: true, format: 'esm', write: false,
  define: {'import.meta.url': '"https://aaavs.invalid/dist/mpc-host.js"'}, plugins: [{name: 'fixture', setup(b) {
    b.onResolve({filter: /(local-collection|mpc-management|mpc-bitmap-dependencies)\.ts$/}, args => ({path: args.path, namespace: 'fixture'}));
    b.onLoad({filter: /.*/, namespace: 'fixture'}, args => ({contents: args.path.includes('local-collection')
      ? `export async function fetchLocalAvsCatalog(){return globalThis.catalog;} export function fetchLocalAvsPreset(p){return globalThis.fetchPreset(p);}
         export const isSceneKind=p=>p?.kind==='nerv'||p?.kind==='hud'; export async function fetchLocalAvsSources(){return new Map();} export function parseLocalAvsSources(){return new Map();}`
      : args.path.includes('management')
        ? `export class PresetManagement{open=false;constructor(a){globalThis.actions=a;return new Proxy(this,{get:(t,k)=>k in t?t[k]:typeof k==='symbol'?undefined:()=>undefined});}}`
        : `export async function loadPresetBitmaps(){return [];}`}));
    // The real transition class, wrapped so the constructor options the host passes are observable.
    b.onLoad({filter: /mpc-transition\.ts$/}, args => {
      const text = readFileSync(args.path, 'utf8');
      if (!/export class AvsTransition\b/.test(text)) throw new Error('mpc-transition.ts no longer declares `export class AvsTransition`; update the spy in check-host-resolution.mjs');
      return {contents: text.replace(/export class AvsTransition\b/, 'class RealAvsTransition') + spy, loader: 'ts', resolveDir: resolve('src')};
    });
  }}]});

// ---- fakes: a universal 2D context that logs every call and property write, canvases, workers, ResizeObserver
const posted = [], workers = [], fetches = [], created = [], offscreens = [], nodes = new Map(), classes = new Set();
let now = 0, listener, raf, pagehide, observer;
Object.defineProperty(globalThis, 'performance', {value: {now: () => now}, configurable: true});
function makeContext(canvas) {
  const target = {log: [], canvas};
  const state = {imageSmoothingEnabled: true, imageSmoothingQuality: 'low', globalAlpha: 1, fillStyle: '#000', globalCompositeOperation: 'source-over'};
  return new Proxy(target, {
    get(t, k) {
      if (k in t) return t[k];
      if (typeof k === 'symbol') return undefined;
      if (k in state) return state[k];
      if (k === 'getImageData') return (x, y, w, h) => ({data: new Uint8ClampedArray(w * h * 4)});
      if (k === 'createPattern') return () => ({});
      if (k === 'createLinearGradient' || k === 'createRadialGradient') return () => ({addColorStop() {}});
      if (k === 'measureText') return s => ({width: String(s).length * 6});
      return (...args) => { t.log.push([k, ...args]); };
    },
    set(t, k, v) { if (k in state) { state[k] = v; t.log.push(['set', k, v]); } else t[k] = v; return true; },
  });
}
function makeCanvas(width, height) {
  const canvas = {width, height, clientWidth: width, clientHeight: height, style: {}, ctxs: [], getContext() { const c = makeContext(canvas); canvas.ctxs.push(c); return c; }};
  return canvas;
}
const vis = makeCanvas(1000, 500);
nodes.set('#visualizer', vis);
globalThis.catalog = catalog;
globalThis.fetchPreset = p => new Promise(resolveFetch => fetches.push({p, resolve: () => resolveFetch(new Uint8Array(4))}));
globalThis.fetch = async () => { throw new Error('offline fixture'); };
globalThis.OffscreenCanvas = class { constructor(w, h) { Object.assign(this, makeCanvas(w, h)); this.width = w; this.height = h; offscreens.push(this); } };
globalThis.ResizeObserver = class { constructor(callback) { observer = this; this.callback = callback; this.disconnected = 0; } observe(target, options) { this.target = target; this.options = options; } disconnect() { this.disconnected++; } };
globalThis.document = {hidden: false, baseURI: 'https://aaavs.invalid/mpc.html',
  body: {append() {}, classList: {add: x => classes.add(x), remove: x => classes.delete(x)}},
  createElement() { const c = makeCanvas(300, 150); created.push(c); return c; },
  querySelector(id) { if (!nodes.has(id)) nodes.set(id, {textContent: ''}); return nodes.get(id); }, addEventListener() {}};
globalThis.window = {chrome: {webview: {postMessage(m) { posted.push(m); }, addEventListener(_, fn) { listener = fn; }}}, setTimeout() { return 1; }, addEventListener(t, fn) { if (t === 'pagehide') pagehide = fn; }};
globalThis.clearTimeout = () => {};
globalThis.requestAnimationFrame = fn => { raf = fn; };
globalThis.devicePixelRatio = 1;
globalThis.Worker = class {
  constructor(url) { this.kind = /(nerv|show)-render/.test(String(url)) ? 'nerv' : 'avs'; this.requests = []; this.dead = false; this.outstanding = 0; workers.push(this); }
  postMessage(m) { this.requests.push(m); if (m.type === 'render') this.outstanding++; }
  terminate() { this.dead = true; }
  renders() { return this.requests.filter(r => r.type === 'render'); }
  last() { return this.renders().at(-1); }
  load() { return this.requests.find(r => r.type === 'load'); }
  ready() { this.onmessage({data: {type: 'ready'}}); }
  /** A worker reply at the size of the newest request, like the real workers. */
  reply() { const q = this.last(), bitmap = {width: q.width, height: q.height, closed: false, close() { this.closed = true; }}; this.outstanding = Math.max(0, this.outstanding - 1); this.onmessage({data: {type: 'frame', bitmap}}); return bitmap; }
};

const flush = async () => { for (let i = 0; i < 12; i++) await Promise.resolve(); };
const msg = data => listener({data});
const audio = (position, playing = true) => msg({type: 'audio', playing, position, epoch: 1, pcm: Array(1152).fill(0)});
let pos = 0;
const tick = ms => { now += ms; raf(now); };
/** One playing frame: fresh audio, `ms` of host time, then answer any outstanding render so the next frame may render again. */
const play = (w, ms) => { pos += ms / 1000; audio(pos, true); tick(ms); const bitmaps = []; while (w.outstanding > 0) bitmaps.push(w.reply()); return bitmaps.at(-1); };
const settings = extra => msg({type: 'settings', enabled: false, shuffle: false, ...extra});
const draws = canvas => canvas.ctxs[0].log.filter(e => e[0] === 'drawImage');
const sets = (canvas, key) => canvas.ctxs[0].log.filter(e => e[0] === 'set' && e[1] === key).map(e => e[2]);
const size = q => [q.width, q.height];
const status = () => nodes.get('#status').textContent;

await import(`data:text/javascript;base64,${Buffer.from(result.outputFiles[0].text).toString('base64')}`);
await flush();
const composite = created[0];
assert.ok(composite && composite.ctxs.length === 1, 'the host creates its composite canvas first');
assert.ok(observer && observer.target === vis && observer.options?.box === 'device-pixel-content-box', 'the host observes the visualizer canvas with the device-pixel content box');
assert.deepEqual({...actions.display()}, {quality: 'auto', avsResolution: 'classic', pixelArt: 'auto', showFps: 1, timingOverlay: 0}, 'Actions.display() starts at the defaults');

// ---- shipped AVS rule, verbatim (mpc-host.ts before the resolution work)
const shipped = (w, h, d) => {
  const width = 640, height = Math.max(64, Math.min(640, Math.round(width * h / Math.max(1, w))));
  const scale = Math.min(d || 1, 1920 / Math.max(1, w), 1080 / Math.max(1, h));
  return {render: [width, height], canvas: [Math.max(1, Math.round(w * scale)), Math.max(1, Math.round(h * scale))]};
};
const setView = (w, h, d = 1) => { vis.clientWidth = w; vis.clientHeight = h; globalThis.devicePixelRatio = d; };

// ================================================================ A. AVS classic through the host
fetches.at(-1).resolve(); await flush();   // the initial preset was requested during module load, at the 1000x500 view of the fixture canvas
let avs = workers.at(-1);
assert.equal(avs.kind, 'avs');
const firstLoad = avs.load();
assert.equal(firstLoad.gpuLane, 'exact');
assert.deepEqual(size(firstLoad), [640, 320], 'the first AVS load carries the classic policy size for a 1000x500 view, not the 640x360 warm-up');
avs.ready();
settings({});
avs.reply();
assert.ok(posted.includes('ready'), 'the first preset commits');
play(avs, 16);
assert.deepEqual(size(avs.last()), shipped(1000, 500, 1).render, 'AVS classic render size at a 1000x500 view');
assert.deepEqual([vis.width, vis.height], shipped(1000, 500, 1).canvas, 'AVS classic present canvas');
assert.equal(vis.style.imageRendering, 'pixelated', 'AVS keeps the pixelated CSS');
assert.equal(sets(vis, 'imageSmoothingEnabled').at(-1), false, 'AVS is sampled with nearest neighbour');
assert.equal(composite.ctxs[0].log.filter(e => e[0] === 'drawImage').length, 0, 'no transition: the composite canvas is not touched');
{
  const last = draws(vis).at(-1);
  assert.ok(last && last.slice(2).join() === [0, 0, ...shipped(1000, 500, 1).canvas].join(), 'the bitmap is drawn over the whole canvas');
  assert.notEqual(last[1], composite, 'the source is a worker bitmap, not the composite');
}
// A second preset at the same non-16:9 view: load and first render agree, so the worker never resizes and resets feedback state.
{
  settings({manualFade: false});
  msg({type: 'next'}); await flush();
  fetches.at(-1).resolve(); await flush();
  const second = workers.at(-1);
  assert.deepEqual(size(second.load()), [640, 320], 'AVS load carries the classic policy size for the view');
  second.ready();
  assert.deepEqual(size(second.last()), size(second.load()), 'the first render matches the load size: no resize, no feedback reset');
  second.reply();
  play(second, 16);
  assert.equal(avs.dead, true, 'without a fade the previous renderer is released');
  avs = second;
}

// classic debounce: 250 ms on the host clock
setView(1280, 720);
play(avs, 1);
const t0 = now;
assert.deepEqual(size(avs.last()), [640, 320], 'a size change is held at first');
play(avs, 100);
assert.deepEqual(size(avs.last()), [640, 320], 'held 100 ms later');
play(avs, 148);
assert.equal(now - t0, 248);
assert.deepEqual(size(avs.last()), [640, 320], 'held 248 ms after the first differing frame');
assert.deepEqual([vis.width, vis.height], [1000, 500], 'the presented canvas is held with the render size');
play(avs, 2);
assert.deepEqual(size(avs.last()), [640, 360], 'adopted at 250 ms');
assert.deepEqual([vis.width, vis.height], [1280, 720]);

// classic parity through the host over many views (each waits out the debounce)
for (const [w, h, d] of [[1920, 1080, 1], [1919, 1013, 1.25], [480, 480, 1], [2560, 1440, 1.5], [800, 1600, 2], [640, 360, 1], [3840, 2160, 1], [300, 200, 3], [9000, 8000, 4], [1366, 768, 1], [1000, 500, 1]]) {
  setView(w, h, d); play(avs, 1); play(avs, 300); play(avs, 16);
  const want = shipped(w, h, d);
  assert.deepEqual(size(avs.last()), want.render, `AVS classic render at ${w}x${h}@${d}`);
  assert.deepEqual([vis.width, vis.height], want.canvas, `AVS classic canvas at ${w}x${h}@${d}`);
  assert.equal(vis.style.imageRendering, 'pixelated');
}
// determinism across a seek: the surfaces are a function of the view and preferences only
{
  const before = size(avs.last());
  const back = Math.max(0, pos - 3); audio(back, true); pos = back; tick(16); while (avs.outstanding) avs.reply();
  play(avs, 16);
  assert.deepEqual(size(avs.last()), before, 'a seek does not change the render size');
}

// AVS resolution opt-ins apply at once on the settings message
setView(2560, 1440, 1.5); play(avs, 1); play(avs, 300); play(avs, 16);
assert.deepEqual([vis.width, vis.height], [1920, 1080], 'classic canvas at 2560x1440 css, DPR 1.5 (1920x1080 cap)');
settings({avsResolution: 1}); play(avs, 16); play(avs, 16);
assert.deepEqual(size(avs.last()), [640, 360], 'crisp renders 640x360 at 3840x2160 device pixels');
assert.deepEqual([vis.width, vis.height], [3840, 2160], 'crisp presents at the device size');
assert.equal(vis.style.imageRendering, 'pixelated');
assert.ok(status().includes('640x360'), `the change is announced with the resolved size: ${status()}`);
settings({avsResolution: 2}); play(avs, 16); play(avs, 16);
assert.deepEqual(size(avs.last()), [1280, 720], 'high renders 1280x720');
settings({avsResolution: 9}); play(avs, 16);
assert.deepEqual(size(avs.last()), [1280, 720], 'an invalid avsResolution keeps the current value');
settings({avsResolution: 0}); play(avs, 16); play(avs, 16);
assert.deepEqual(size(avs.last()), [640, 360]);
assert.deepEqual([vis.width, vis.height], [1920, 1080], 'classic again');

// timing overlay class and hostile display input
settings({timingOverlay: 1}); assert.ok(classes.has('timing-always'), 'timingOverlay 1 adds body.timing-always');
settings({}); assert.ok(classes.has('timing-always'), 'a settings message without the key keeps it');
settings({timingOverlay: 5, quality: 'x', avsResolution: {}, pixelArt: [], showFps: null}); assert.ok(classes.has('timing-always'), 'invalid display keys change nothing');
assert.equal(actions.display().quality, 'auto'); assert.equal(actions.display().timingOverlay, 1);
settings({timingOverlay: 0}); assert.ok(!classes.has('timing-always'), 'timingOverlay 0 removes it');
settings({showFps: 2, timingOverlay: 0}); assert.equal(actions.display().showFps, 2, 'showFps is stored (its text belongs to the timing label)');
settings({showFps: 1});

// ================================================================ B. AVS to NERV: composite surface, smoothing, direct draw afterwards
setView(2560, 1440, 1.5); play(avs, 1); play(avs, 300); play(avs, 16);
const logBefore = (globalThis.transitionLog ?? []).length;
actions.load(2); await flush();
fetches.at(-1).resolve(); await flush();
const nerv = workers.at(-1);
assert.equal(nerv.kind, 'nerv');
assert.deepEqual(size(nerv.load()), [2560, 1440], 'a NERV scene loads at the Auto (High) surface for a 3840x2160 device view');
nerv.ready();
assert.deepEqual(size(nerv.last()), [2560, 1440], 'the first NERV render uses the policy size');
audio(pos += 0.016, true); nerv.reply();
assert.equal(globalThis.transitionLog.length, logBefore + 1, 'the manual change while playing starts a transition');
assert.equal(globalThis.transitionLog.at(-1).smooth, true, 'AVS to NERV passes smooth: true');
tick(16);
assert.deepEqual([composite.width, composite.height], [2560, 1440], 'the composite is sized to the larger plate');
{
  const cd = composite.ctxs[0].log.filter(e => e[0] === 'drawImage').length;
  assert.ok(cd > 0, 'the transition draws into the composite');
  const last = draws(vis).at(-1);
  assert.equal(last[1], composite, 'during a transition the display samples the composite');
  assert.deepEqual([vis.width, vis.height], [2560, 1440], 'NERV canvas equals the render size');
}
for (let i = 0; i < 6; i++) play(nerv, 500);
assert.equal(avs.dead, true, 'the transition completes on media time and releases the outgoing renderer');
{
  const c0 = composite.ctxs[0].log.filter(e => e[0] === 'drawImage').length;
  const previous = play(nerv, 16);
  play(nerv, 16);   // this frame presents the bitmap the previous reply delivered
  const last = draws(vis).at(-1);
  assert.equal(last[1], previous, 'after the transition the display samples the worker bitmap directly');
  assert.equal(composite.ctxs[0].log.filter(e => e[0] === 'drawImage').length, c0, 'and the composite copy is skipped');
  for (let i = 0; i < 5; i++) play(nerv, 16);
  assert.equal(composite.ctxs[0].log.filter(e => e[0] === 'drawImage').length, c0, 'still skipped over further frames');
}
assert.equal(vis.style.imageRendering, 'auto', 'NERV is presented with image-rendering: auto');
assert.equal(sets(vis, 'imageSmoothingEnabled').at(-1), true, 'NERV is presented with smoothing on');
assert.equal(sets(vis, 'imageSmoothingQuality').at(-1), 'high', 'at high quality');
assert.deepEqual(draws(vis).at(-1).slice(2), [0, 0, 2560, 1440], 'drawn 1:1 over the whole canvas');
{
  const probe = offscreens.find(o => o.width === 256 && o.height === 144);
  assert.ok(probe && probe.ctxs[0], 'the flash gate created its 256x144 probe');
  assert.deepEqual(probe.ctxs[0].log.filter(e => e[0] === 'set' && e[1] === 'imageSmoothingQuality').map(e => e[2]), ['medium'], 'the probe sampler uses medium smoothing quality (photosensitivity safety)');
}

// ================================================================ C. NERV tiers, pause, device box, governor
// tier table at 3840x2160 device pixels (RES Appendix A): performance, balanced, high, native, auto
for (const [quality, want] of [[1, [1280, 720]], [2, [1920, 1080]], [3, [2560, 1440]], [4, [3840, 2160]], [0, [2560, 1440]]]) {
  settings({quality}); play(nerv, 16); play(nerv, 16);
  assert.deepEqual(size(nerv.last()), want, `NERV quality ${quality} renders ${want}`);
  assert.deepEqual([vis.width, vis.height], want, `and the canvas equals the render size (1:1)`);
  assert.deepEqual(draws(vis).at(-1).slice(2), [0, 0, ...want], 'drawn over the whole canvas');
  assert.ok(status().includes(`${want[0]}x${want[1]}`), `a tier change is announced with the resolved size: ${status()}`);
}
settings({quality: 2}); play(nerv, 16); play(nerv, 16);
for (const bad of [9, -1, 1.5, 'x', null, {}, []]) { settings({quality: bad}); play(nerv, 16); assert.deepEqual(size(nerv.last()), [1920, 1080], `invalid quality ${JSON.stringify(bad)} keeps Balanced`); }
settings({}); play(nerv, 16); assert.deepEqual(size(nerv.last()), [1920, 1080], 'a settings message without a quality keeps it');
// paused: a tier change and a resize still re-render the deterministic NERV geometry, and an unchanged paused scene stays idle. The tier is
// changed through the Preset Manager path because a settings message also bumps the clock revision, which re-renders by itself.
audio(pos, false); tick(16); while (nerv.outstanding) nerv.reply();
{
  tick(16); const idle = nerv.renders().length; tick(16);
  assert.equal(nerv.renders().length, idle, 'a paused scene with nothing new is idle');
  actions.setDisplay({quality: 'performance'}); tick(16);
  assert.deepEqual(size(nerv.last()), [1280, 720], 'a quality change re-renders a paused NERV scene at the new size');
  assert.equal(nerv.renders().length, idle + 1, 'exactly one extra render');
  while (nerv.outstanding) nerv.reply(); tick(16);
  assert.equal(nerv.renders().length, idle + 1, 'and then it is idle again');
  actions.setDisplay({quality: 'auto'}); tick(16); while (nerv.outstanding) nerv.reply();
  assert.deepEqual(size(nerv.last()), [2560, 1440]);
  // resize while paused: adopted after 120 ms of host time, not 250
  setView(1920, 1080, 1); tick(1);
  const n = nerv.renders().length; tick(119);
  assert.equal(nerv.renders().length, n, 'held 119 ms after the first differing frame');
  tick(1);
  assert.deepEqual(size(nerv.last()), [1920, 1080], 'a NERV resize is adopted after 120 ms');
  while (nerv.outstanding) nerv.reply(); tick(16);
  assert.deepEqual([vis.width, vis.height], [1920, 1080]);
}
// device-pixel content box: 1919x1079 device pixels on a css view whose css * dpr rounds to 1920x1080
observer.callback([{devicePixelContentBoxSize: [{inlineSize: 1919, blockSize: 1079}]}]); tick(1); tick(120); while (nerv.outstanding) nerv.reply();
assert.deepEqual(size(nerv.last()), [1919, 1079], 'the observed device box sets the NERV surface after the wait');
observer.callback([{}]); tick(1); tick(120); while (nerv.outstanding) nerv.reply();
assert.deepEqual(size(nerv.last()), [1920, 1080], 'an entry without a device box returns to css * dpr');
// a stale observation far from css * dpr is ignored
observer.callback([{devicePixelContentBoxSize: [{inlineSize: 6000, blockSize: 5000}]}]); tick(1); tick(200); while (nerv.outstanding) nerv.reply();
assert.deepEqual(size(nerv.last()), [1920, 1080], 'an implausible device box is ignored');
observer.callback([{}]);
// Auto governor: sustained slow round trips step the tier down while playing; a fixed tier never moves; a pause feeds nothing
setView(2560, 1440, 1.5); tick(1); tick(130); play(nerv, 16);
assert.deepEqual(size(nerv.last()), [2560, 1440], 'Auto starts at High');
{
  let stepped = 0;
  for (let i = 1; i <= 80 && !stepped; i++) { pos += 0.017; audio(pos, true); tick(1); now += 30; while (nerv.outstanding) nerv.reply(); if (size(nerv.last())[0] < 2560) stepped = i; }
  assert.ok(stepped >= 12 && stepped <= 60, `Auto stepped down after ${stepped} slow frames`);
  tick(16);
  assert.deepEqual(size(nerv.last()), [1920, 1080], 'the next render uses the Balanced surface at once');
  assert.ok(status().includes('1920x1080'), `the step is announced: ${status()}`);
  settings({quality: 3}); play(nerv, 16); play(nerv, 16);
  assert.deepEqual(size(nerv.last()), [2560, 1440], 'choosing High fixes the tier');
  for (let i = 0; i < 150; i++) { pos += 0.017; audio(pos, true); tick(1); now += 30; while (nerv.outstanding) nerv.reply(); }
  assert.deepEqual(size(nerv.last()), [2560, 1440], 'a fixed tier never steps down');
  settings({quality: 0}); play(nerv, 16); play(nerv, 16);
  assert.deepEqual(size(nerv.last()), [2560, 1440], 'returning to Auto restarts at High');
}

// ================================================================ D. Preset Manager row and the display: string
{
  const before = posted.filter(m => typeof m === 'string' && m.startsWith('display:')).length;
  actions.setDisplay({quality: 'balanced'});
  const sent = posted.filter(m => typeof m === 'string' && m.startsWith('display:'));
  assert.equal(sent.length, before + 1, 'setDisplay posts one display: string');
  const wire = JSON.parse(sent.at(-1).slice(8));
  assert.deepEqual(wire, {quality: 2, avsResolution: 0, pixelArt: 0, showFps: 1, timingOverlay: 0}, 'wire integers, every key');
  assert.equal(actions.display().quality, 'balanced');
  play(nerv, 16); play(nerv, 16);
  assert.deepEqual(size(nerv.last()), [1920, 1080], 'the change applies without waiting for the native echo');
  actions.setDisplay({quality: 'balanced'}); actions.setDisplay({quality: 'nope'}); actions.setDisplay({}); actions.setDisplay(null); actions.setDisplay({showFps: 7});
  assert.equal(posted.filter(m => typeof m === 'string' && m.startsWith('display:')).length, before + 1, 'no change or an invalid patch posts nothing');
  msg({type: 'settings', enabled: false, shuffle: false, ...wire});
  assert.equal(posted.filter(m => typeof m === 'string' && m.startsWith('display:')).length, before + 1, 'the native echo does not loop back');
  actions.setDisplay({timingOverlay: 1, showFps: 2});
  assert.ok(classes.has('timing-always'), 'setDisplay toggles body.timing-always');
  assert.deepEqual(JSON.parse(posted.filter(m => typeof m === 'string' && m.startsWith('display:')).at(-1).slice(8)), {quality: 2, avsResolution: 0, pixelArt: 0, showFps: 2, timingOverlay: 1});
  const wireNow = D.prefsToWire(actions.display());
  assert.deepEqual(wireNow, {quality: 2, avsResolution: 0, pixelArt: 0, showFps: 2, timingOverlay: 1});
  actions.setDisplay({quality: 'auto', timingOverlay: 0, showFps: 1});
}

// ================================================================ E. NERV to AVS and AVS to AVS transitions
setView(1000, 500, 1); play(nerv, 1); play(nerv, 300); play(nerv, 16);
{
  const n = globalThis.transitionLog.length;
  actions.load(0); await flush(); fetches.at(-1).resolve(); await flush();
  const toAvs = workers.at(-1); assert.equal(toAvs.kind, 'avs');
  assert.deepEqual(size(toAvs.load()), [640, 320], 'AVS load size after a NERV scene, at the same view');
  toAvs.ready(); audio(pos += 0.016, true); toAvs.reply();
  assert.equal(globalThis.transitionLog.length, n + 1);
  assert.equal(globalThis.transitionLog.at(-1).smooth, true, 'NERV to AVS passes smooth: true');
  for (let i = 0; i < 6; i++) play(toAvs, 500);
  assert.equal(nerv.dead, true);
  assert.deepEqual([vis.width, vis.height], [1000, 500], 'back on the AVS classic canvas');
  assert.equal(vis.style.imageRendering, 'pixelated', 'and the pixelated CSS returns');
  assert.equal(sets(vis, 'imageSmoothingEnabled').at(-1), false, 'and nearest sampling');
  const m = globalThis.transitionLog.length;
  actions.load(1); await flush(); fetches.at(-1).resolve(); await flush();
  const other = workers.at(-1); other.ready(); audio(pos += 0.016, true); other.reply();
  assert.equal(globalThis.transitionLog.length, m + 1);
  assert.equal(globalThis.transitionLog.at(-1).smooth, false, 'AVS to AVS keeps the classic nearest transition (smooth: false)');
  tick(16);
  assert.deepEqual([composite.width, composite.height], [640, 320], 'the AVS to AVS composite is the classic surface');
  for (let i = 0; i < 6; i++) play(other, 500);
  pagehide();
  assert.ok(workers.every(w => w.dead), 'teardown releases every worker');
}
console.log('Host resolution wiring: AVS classic parity (load/render/canvas, 250 ms wait), NERV tiers 1:1 smoothed, paused re-render, device box, Auto governor, composite skip and transition surface, smooth flag, medium probe, display prefs/Actions/display: string PASS');
