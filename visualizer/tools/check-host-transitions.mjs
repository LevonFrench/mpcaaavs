import {build} from 'esbuild';
import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import {resolve} from 'node:path';
// Host-level check of the transition wiring in src/mpc-host.ts (docs/design/CONTRACT.md Appendix A, TRX column; TRANSITIONS-V2.md 6.1-6.3).
// Written in Wave 1 as a specification: it FAILS until INT1 applies the TRX call sites to the host in Wave 3, and it needs no browser, GPU, worker
// or server. The real host is bundled with the real AvsTransition (wrapped by a spy that records its constructor options and every draw call),
// the real audio analyser, director, flash gate and timing modules; only the collection, the Preset Manager and bitmap loading are replaced, and
// the DOM, canvases, contexts, workers, matchMedia and fetch are fakes. Nothing here says how a transition LOOKS.
//
// What it pins (all observable through the fakes):
//  - Live compositor (main thread): every transition is constructed with a numeric uint32 seed that is the same for the same replay and differs
//    per preset pair and per commit time, and with a context {beatsTotal, boundary, nervPair, reducedMotion, energy}; each frame is drawn with
//    a TransitionEnv (finite, in range, accent 0 for AVS pairs and 1 for scene pairs, live level, 16 band levels frozen when the transition
//    starts, one transition length everywhere). Instant and Cut skip the compositor. A seek discards the transition.
//  - Reduced motion is read once from matchMedia('(prefers-reduced-motion: reduce)'), guarded (absent, throwing or odd matchMedia never
//    breaks the host); it reaches the constructor context, the env and the clocked wire frame; a non-calm style then draws as Cross dissolve.
//  - Clocked NERV path: transitionBeats, transitionBoundary (the bar level of the boundary, C-33), transitionAccent (1), transitionReduced and
//    fadeSeconds are valid on every frame with an outgoing plate, follow the fade length, replay byte-identically after a seek, and Instant
//    and Cut send no outgoing plate. The four selectors and every new style index reach the worker unchanged.
//  - The announcement names the style from TRANSITIONS; indices outside 0..32 fall back to Cross dissolve.
// AAAVS_HOST_ENTRY (optional) bundles another host file with src/ as its import root: how the owner rehearses an edit list before applying it.
const entry = process.env.AAAVS_HOST_ENTRY ? resolve(process.env.AAAVS_HOST_ENTRY) : resolve('src/mpc-host.ts');
const hostText = readFileSync(entry, 'utf8');
for (const [pattern, what] of [[/\bhash32\b/, 'hash32 (the boundary seed)'], [/\bbands16\b/, 'bands16 (frozen band levels)'], [/\btransitionLevel\b/, 'transitionLevel (live level)'],
  [/\btransitionBeats\b/, 'transitionBeats'], [/\btransitionBoundary\b/, 'transitionBoundary'], [/\btransitionAccent\b/, 'transitionAccent'], [/\btransitionReduced\b/, 'transitionReduced'],
  [/\bTRANSITION_CUT\b/, 'TRANSITION_CUT'], [/\bmatchMedia\b/, 'matchMedia (reduced motion)'], [/\bboundaryLevel\b/, 'boundaryLevel']])
  assert.ok(pattern.test(hostText), `mpc-host.ts is not wired to the transition layer yet (${what} is missing): apply the TRX column of docs/design/CONTRACT.md Appendix A before this check can pass`);
assert.ok(!/transitionMode\s*[!=]==\s*15\b/.test(hostText), 'the host still compares the transition index with the literal 15; use TRANSITION_CUT');
assert.ok(!/\?\s*message\.transition\s*:\s*1\b/.test(hostText) || /TRANSITION_COUNT/.test(hostText), 'the settings range check must use TRANSITION_COUNT');

const avsCatalog = [0, 1, 2, 3].map(i => ({name: `avs ${i}`, sha256: `a${i}`.padEnd(64, '0'), autoEligible: true}));
const scenes = ['boot', 'magi', 'psycho', 'radar', 'harmonics', 'seele', 'battery', 'atfield', 'alert', 'plug', 'target', 'city', 'sync', 'berserk', 'impact', 'end'];
const nervCatalog = scenes.map((scene, i) => ({kind: 'nerv', scene, name: `NERV ${scene}`, sha256: i.toString(16).padStart(64, '0'), autoEligible: true}));

// The real NERV worker (src/nerv-render.worker.ts) with recording scene drawing: every clocked frame the host builds must be accepted by it (contract 2.3.4).
const workerReplies = [];
let workerFrames = 0;
const workerScope = {postMessage(message) { workerReplies.push(message); }};
class WorkerCanvas { constructor(w, h) { this.width = w; this.height = h; } getContext() { return makeContext(this); } transferToImageBitmap() { return {width: this.width, height: this.height}; } }
{
  const worker = await build({entryPoints: [resolve('src/nerv-render.worker.ts')], bundle: true, format: 'esm', write: false, plugins: [{name: 'scene-fixture', setup(b) {
    b.onResolve({filter: /nerv-scenes\.ts$/}, () => ({path: 'scene', namespace: 'fixture'}));
    b.onLoad({filter: /.*/, namespace: 'fixture'}, () => ({contents: `export const NERV_SCENES=${JSON.stringify(scenes)};export function renderNervScene(){}`}));
  }}]});
  const saved = globalThis.self;
  globalThis.self = workerScope;   // the worker captures `self` when it is imported
  await import(`data:text/javascript;base64,${Buffer.from(worker.outputFiles[0].text).toString('base64')}`);
  globalThis.self = saved;
}
/** Send one render request to the real worker (after loading a scene); returns its reply. */
function feedWorker(nerv) {
  const saved = globalThis.OffscreenCanvas;
  globalThis.OffscreenCanvas = WorkerCanvas;
  try {
    const bytes = readFileSync('nerv-presets/magi.nerv');
    workerReplies.length = 0;
    workerScope.onmessage({data: {type: 'load', generation: 1, preset: bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength)}});
    assert.equal(workerReplies.at(-1).type, 'ready');
    workerScope.onmessage({data: {type: 'render', generation: 1, sequence: 1, pcm: new ArrayBuffer(4608), width: 640, height: 360, nerv: structuredClone(nerv)}});
    if (workerReplies.at(-1).type === 'frame') workerFrames++;
    return workerReplies.at(-1);
  } finally { globalThis.OffscreenCanvas = saved; }
}

const spy = `
export class AvsTransition extends RealAvsTransition {
  constructor(mode: number, options?: any) {
    super(mode, options);
    const entry = { mode, options, instance: this, draws: [] as any[] };
    ((globalThis as any).transitionLog ||= []).push(entry); (this as any).__entry = entry;
  }
  draw(ctx: any, old: any, next: any, progress: number, w: number, h: number, env?: any) {
    (this as any).__entry.draws.push({ progress, w, h, env: env === undefined ? undefined : { ...env, bands: Array.isArray(env.bands) ? [...env.bands] : env.bands } });
    super.draw(ctx, old, next, progress, w, h, env);
  }
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
    // The real transition class, wrapped so the constructor options and the draw arguments the host passes are observable.
    b.onLoad({filter: /mpc-transition\.ts$/}, args => {
      const text = readFileSync(args.path, 'utf8');
      if (!/export class AvsTransition\b/.test(text)) throw new Error('mpc-transition.ts no longer declares `export class AvsTransition`; update the spy in check-host-transitions.mjs');
      return {contents: text.replace(/export class AvsTransition\b/, 'class RealAvsTransition') + spy, loader: 'ts', resolveDir: resolve('src')};
    });
  }}]});
const hostCode = result.outputFiles[0].text;

// ---- fakes ---------------------------------------------------------------------------------------------------------------------------------------
function makeContext(canvas) {
  const state = {imageSmoothingEnabled: true, imageSmoothingQuality: 'low', globalAlpha: 1, fillStyle: '#000', strokeStyle: '#000', globalCompositeOperation: 'source-over', lineWidth: 1};
  return new Proxy({canvas}, {
    get(t, k) {
      if (k in t) return t[k];
      if (typeof k === 'symbol') return undefined;
      if (k in state) return state[k];
      if (k === 'getImageData') return (x, y, w, h) => ({data: new Uint8ClampedArray(w * h * 4)});
      if (k === 'createPattern') return () => ({});
      if (k === 'createLinearGradient' || k === 'createRadialGradient') return () => ({addColorStop() {}});
      if (k === 'measureText') return s => ({width: String(s).length * 6});
      return () => {};
    },
    set(t, k, v) { state[k] = v; return true; },
  });
}
const makeCanvas = (width = 640, height = 360) => ({width, height, clientWidth: width, clientHeight: height, style: {}, getContext() { return makeContext(this); }});
const noise = (amp = .8) => { let s = 12345; return Array.from({length: 1152}, () => { s = (Math.imul(s, 1664525) + 1013904223) >>> 0; return (s / 4294967296 * 2 - 1) * amp; }); };
const silent = Array(1152).fill(0);

let instance = 0;
/** A fresh host on fake surfaces. `matchMedia`: null (the API does not exist), or a function (query) => result, which may throw. */
async function boot({catalog, matchMedia = null} = {}) {
  const nodes = new Map(), posted = [], workers = [], fetches = [], queries = [], log = [];
  const env = {nodes, posted, workers, fetches, queries, log, now: 0, listener: null, raf: null, pagehide: null, actions: null};
  globalThis.catalog = catalog;
  globalThis.transitionLog = log;
  globalThis.fetchPreset = p => new Promise(resolveFetch => fetches.push({p, resolve: () => resolveFetch(new Uint8Array(4))}));
  globalThis.fetch = async () => { throw new Error('offline fixture'); };
  globalThis.OffscreenCanvas = class { constructor(w, h) { Object.assign(this, makeCanvas(w, h)); } };
  delete globalThis.ResizeObserver;
  nodes.set('#visualizer', makeCanvas(640, 360));
  globalThis.document = {hidden: false, baseURI: 'https://aaavs.invalid/mpc.html', body: {append() {}, classList: {add() {}, remove() {}, toggle() {}, contains() { return false; }}},
    createElement() { return makeCanvas(300, 150); }, querySelector(id) { if (!nodes.has(id)) nodes.set(id, {textContent: ''}); return nodes.get(id); }, addEventListener() {}};
  globalThis.window = {chrome: {webview: {postMessage(m) { posted.push(m); }, addEventListener(_, fn) { env.listener = fn; }}}, setTimeout() { return 1; }, addEventListener(t, fn) { if (t === 'pagehide') env.pagehide = fn; }};
  delete globalThis.matchMedia;
  if (matchMedia) { const fn = query => { queries.push(query); return matchMedia(query); }; globalThis.matchMedia = fn; globalThis.window.matchMedia = fn; }
  globalThis.clearTimeout = () => {};
  Object.defineProperty(globalThis, 'performance', {value: {now: () => env.now}, configurable: true});
  globalThis.requestAnimationFrame = fn => { env.raf = fn; }; globalThis.devicePixelRatio = 1;
  globalThis.Worker = class {
    constructor(url) { this.kind = /(nerv|show)-render/.test(String(url)) ? 'nerv' : 'avs'; this.requests = []; this.dead = false; workers.push(this); }
    postMessage(m) { this.requests.push(m); }
    terminate() { this.dead = true; }
    send(type) { const bitmap = {width: 640, height: 360, closed: false, close() { this.closed = true; }}; this.onmessage({data: {type, bitmap}}); return bitmap; }
  };
  await import(`data:text/javascript;base64,${Buffer.from(`${hostCode}\n// instance ${++instance}`).toString('base64')}`);
  env.actions = globalThis.actions;
  env.flush = async () => { for (let i = 0; i < 12; i++) await Promise.resolve(); };
  env.msg = data => env.listener({data});
  env.audio = (position, playing = true, extra = {}) => env.msg({type: 'audio', playing, position, epoch: 1, pcm: silent, ...extra});
  env.settings = extra => env.msg({type: 'settings', enabled: false, shuffle: false, ...extra});
  env.tick = (dt = 16) => { env.now += dt; env.raf(env.now); };
  env.lastRender = w => w.requests.filter(r => r.type === 'render').at(-1);
  env.load = async () => { fetches.at(-1).resolve(); await env.flush(); const w = workers.at(-1); w.send('ready'); w.send('frame'); return w; };
  await env.flush();
  env.active = await env.load();
  return env;
}
/** Manual Next while playing at `position`: returns the new plate's worker and the transition it started (or null). */
async function next(env, position, extra = {}) {
  const before = env.log.length, previous = env.active;
  env.audio(position, true, extra); env.msg({type: 'next'}); await env.flush();
  env.active = await env.load();
  return {previous, worker: env.active, entry: env.log.length > before ? env.log.at(-1) : null};
}
const near = (a, b, eps = 1e-9) => Math.abs(a - b) <= eps;
const isUint32 = v => Number.isInteger(v) && v >= 0 && v <= 0xffffffff;
const QUARTERS = [0, .25, .5, .75, 1];
function assertEnv(e, where) {
  assert.ok(e && typeof e === 'object', `${where}: the host passes a TransitionEnv to draw`);
  for (const k of ['bpm', 'beatPhase', 'barPhase', 'beatsTotal', 'level']) assert.ok(Number.isFinite(e[k]), `${where}: env.${k} is finite (${e[k]})`);
  assert.ok(e.bpm >= 20 && e.bpm <= 400, `${where}: bpm ${e.bpm}`); assert.ok(e.beatPhase >= 0 && e.beatPhase <= 1 && e.barPhase >= 0 && e.barPhase <= 1, `${where}: phases`);
  assert.ok(e.beatsTotal >= .25 && e.beatsTotal <= 64, `${where}: beatsTotal ${e.beatsTotal}`); assert.ok(QUARTERS.includes(e.level), `${where}: level is in quarters (${e.level})`);
  assert.ok(e.accent === 0 || e.accent === 1, `${where}: accent`); assert.equal(typeof e.reducedMotion, 'boolean', `${where}: reducedMotion`);
  if (e.seconds !== undefined) assert.ok(Number.isFinite(e.seconds) && e.seconds > 0, `${where}: seconds`);
  if (e.bands !== undefined) assert.ok(Array.isArray(e.bands) && e.bands.length === 16 && e.bands.every(v => Number.isFinite(v) && v >= 0 && v <= 1), `${where}: bands are 16 values in 0..1`);
}
function assertContext(c, where) {
  assert.ok(c && typeof c === 'object', `${where}: the host passes a TransitionContext`);
  assert.ok(Number.isFinite(c.beatsTotal) && c.beatsTotal > 0 && c.beatsTotal <= 64, `${where}: context.beatsTotal ${c.beatsTotal}`);
  assert.ok([0, 1, 2, 3].includes(c.boundary), `${where}: boundary`); assert.equal(typeof c.nervPair, 'boolean', `${where}: nervPair`); assert.equal(typeof c.reducedMotion, 'boolean', `${where}: reducedMotion`);
  assert.ok(c.energy === undefined || [0, 1, 2, 3].includes(c.energy), `${where}: energy is a bucket 0..3 or absent (${c.energy})`);
}

// ================================================================ 1. live compositor, AVS to AVS
{
  const env = await boot({catalog: avsCatalog});
  assert.ok(env.log.length === 0, 'the first preset has no outgoing plate and no transition');
  env.settings({transition: 16, beats: 0, durationMs: 2000});   // Beat Step Wipe over 2 s, no tempo: 2 s at the 120 BPM fallback is 4 beats
  const {previous, worker, entry} = await next(env, 10, {pcm: noise()});
  assert.ok(entry, 'a manual Next while playing starts a transition'); assert.equal(previous.dead, false, 'the outgoing plate lives while it fades');
  assert.equal(entry.mode, 16, 'the requested style reaches the constructor'); assert.equal(entry.instance.mode, 16); assert.equal(entry.instance.requested, 16);
  const {seed, context, smooth} = entry.options ?? {};
  assert.ok(isUint32(seed), `the boundary seed is a uint32 (${seed})`); assertContext(context, 'AVS pair');
  assert.ok(near(context.beatsTotal, 4), `2 s at 120 BPM is 4 beats (${context.beatsTotal})`); assert.equal(context.boundary, 0, 'a manual change has no musical boundary');
  assert.equal(context.nervPair, false, 'two AVS presets are not a scene pair'); assert.equal(context.reducedMotion, false);
  assert.ok(smooth === undefined || typeof smooth === 'boolean', 'smooth is a boolean when passed'); assert.ok(!smooth, 'classic AVS surfaces are not smoothed');
  // Frame 0 (t = 0, still the noisy audio of the commit), then one quarter of the way through with silence.
  env.tick(); assert.equal(entry.draws.length, 1); const first = entry.draws[0]; assertEnv(first.env, 'first frame');
  assert.equal(first.progress, 0); assert.equal(first.w, 640); assert.equal(first.h, 360);
  assert.equal(first.env.accent, 0, 'AVS pairs use the neutral accent'); assert.equal(first.env.reducedMotion, false); assert.ok(near(first.env.bpm, 120), 'no locked tempo: 120 BPM');
  assert.ok(near(first.env.beatsTotal, 4) && near(context.beatsTotal, first.env.beatsTotal), 'one transition length in the context and the env');
  assert.ok(first.env.seconds === undefined || near(first.env.seconds, 2), 'the env length in seconds is the transition length');
  assert.ok(first.env.level > 0, `the live level follows the audio (${first.env.level})`); assert.ok(Array.isArray(first.env.bands), 'the band levels are frozen for a live transition');
  assert.ok(first.env.bands.some(v => v > 0), 'the frozen bands come from the audio at the commit (loud noise)');
  for (const at of [10.25, 10.5]) env.audio(at, true, {pcm: silent});
  env.tick(); assert.equal(entry.draws.length, 2); const second = entry.draws[1]; assertEnv(second.env, 'second frame');
  assert.ok(near(second.progress, .25), `progress follows media time (${second.progress})`); assert.equal(second.env.level, 0, 'the level is live: silence now');
  assert.deepEqual(second.env.bands, first.env.bands, 'the band levels stay frozen for the whole transition');
  // Progress is monotone and reaches the end; the outgoing plate is released at t >= 1.
  let last = second.progress;
  for (const at of [10.9, 11.4, 11.9]) { env.audio(at, true); env.tick(); const d = entry.draws.at(-1); assert.ok(d.progress > last, 'progress increases'); last = d.progress; }
  assert.equal(previous.dead, false); env.audio(12.1, true); env.tick(); assert.ok(entry.draws.at(-1).progress >= 1); assert.equal(previous.dead, true, 'the outgoing plate is released once t reaches 1');
  const count = entry.draws.length; env.audio(12.6, true); env.tick(); assert.equal(entry.draws.length, count, 'a finished transition draws nothing more');
  // A seek discards a running transition.
  const two = await next(env, 13, {pcm: noise()}); assert.ok(two.entry); env.tick(); const drawn = two.entry.draws.length; assert.equal(two.previous.dead, false);
  env.audio(60, true); env.tick(); env.tick(); assert.equal(two.previous.dead, true, 'a seek releases the outgoing plate'); assert.equal(two.entry.draws.length, drawn, 'and draws no more of that transition');
}

// ================================================================ 2. the boundary seed: replayable, and different per pair and per commit time
{
  const seeds = async ({at = [10, 10.4], mode = 32} = {}) => {
    const env = await boot({catalog: avsCatalog}); env.settings({transition: mode, beats: 0, durationMs: 2000});
    const out = []; for (const position of at) out.push((await next(env, position)).entry.options.seed); return out;
  };
  const a = await seeds(), b = await seeds(), c = await seeds({at: [10.5, 10.9]});
  assert.deepEqual(b, a, 'the same session replays the same boundary seeds'); assert.notEqual(a[0], a[1], 'a different preset pair and time give a different seed');
  assert.notEqual(c[0], a[0], 'the commit time is part of the seed'); assert.ok([...a, ...c].every(isUint32));
  // The style a selector resolves to is a pure function of that seed and the context (the transition object agrees with the pure resolver).
  const env = await boot({catalog: avsCatalog}); env.settings({transition: 32, beats: 0, durationMs: 2000});
  for (const position of [20, 21, 22, 23]) { const {entry} = await next(env, position); assert.ok(entry.instance.mode >= 1 && entry.instance.mode <= 30 && entry.instance.mode !== 15, `smart random resolved to ${entry.instance.mode}`); assert.equal(entry.instance.requested, 32); }
}

// ================================================================ 3. live compositor, scene pair
{
  const env = await boot({catalog: nervCatalog});
  env.settings({transition: 20, beats: 0, durationMs: 2000});
  const {entry} = await next(env, 5); assert.ok(entry, 'Next between two NERV scenes on the live path fades on the main thread');
  assert.equal(entry.options.context.nervPair, true, 'both plates are scene presets'); assertContext(entry.options.context, 'scene pair');
  assert.ok(entry.options.smooth === undefined || typeof entry.options.smooth === 'boolean'); env.tick();
  assertEnv(entry.draws[0].env, 'scene pair'); assert.equal(entry.draws[0].env.accent, 1, 'scene pairs use the NERV accent');
}

// ================================================================ 4. Instant and Cut skip the compositor
{
  const env = await boot({catalog: avsCatalog});
  env.settings({transition: 15, beats: 0, durationMs: 2000});
  const cut = await next(env, 10); assert.equal(cut.entry, null, 'Cut constructs no transition'); assert.equal(cut.previous.dead, true, 'Cut releases the outgoing plate at once');
  env.settings({transition: 16, fadeTiming: 1});
  const instant = await next(env, 11); assert.equal(instant.entry?.draws.length ?? 0, 0, 'Instant draws no transition frame'); assert.equal(instant.previous.dead, true, 'Instant is Cut: the outgoing plate is released at once');
  env.tick(); env.audio(11.2, true); env.tick(); assert.ok(env.log.every(e => e.draws.length === 0), 'no transition frame was ever composited');
  env.settings({transition: 16, beats: 0, durationMs: 2000});
  const back = await next(env, 12); assert.ok(back.entry, 'a timed fade works again after Instant'); assert.equal(back.previous.dead, false);
}

// ================================================================ 5. reduced motion: read once, guarded, and carried everywhere
{
  const asked = [];
  const env = await boot({catalog: avsCatalog, matchMedia: q => { asked.push(q); return {matches: q === '(prefers-reduced-motion: reduce)'}; }});
  assert.ok(env.queries.length >= 1 && env.queries.every(q => q === '(prefers-reduced-motion: reduce)'), `the host asks for the reduce preference only (${env.queries})`);
  env.settings({transition: 24, beats: 0, durationMs: 2000});   // Glitch Stutter is not calm
  const {entry} = await next(env, 10); assert.equal(entry.options.context.reducedMotion, true, 'reduced motion reaches the constructor context');
  assert.equal(entry.instance.requested, 24); assert.equal(entry.instance.mode, 1, 'a non-calm style draws as Cross dissolve under reduced motion');
  env.tick(); assert.equal(entry.draws[0].env.reducedMotion, true, 'and the env');
  env.settings({transition: 28, beats: 0, durationMs: 2000}); assert.equal((await next(env, 11)).entry.instance.mode, 1, 'Kick-Punch Zoom too');
  env.settings({transition: 17, beats: 0, durationMs: 2000}); assert.equal((await next(env, 12)).entry.instance.mode, 17, 'a calm style keeps its geometry');
  env.settings({transition: 31, beats: 0, durationMs: 2000});
  for (const position of [13, 14, 15, 16, 17, 18]) { const mode = (await next(env, position)).entry.instance.mode; assert.ok(mode >= 1 && mode !== 15 && ![24, 25, 26, 27, 28, 29].includes(mode), `Random, all styles never picks a non-calm style under reduced motion (${mode})`); }
  // The preference is not forced on when the platform says no.
  const off = await boot({catalog: avsCatalog, matchMedia: () => ({matches: false})});
  off.settings({transition: 24, beats: 0, durationMs: 2000}); const plain = await next(off, 10);
  assert.equal(plain.entry.options.context.reducedMotion, false); assert.equal(plain.entry.instance.mode, 24); off.tick(); assert.equal(plain.entry.draws[0].env.reducedMotion, false);
  // Guarded: a missing API, a throwing API and an odd answer never break the host and mean full motion.
  for (const [label, matchMedia] of [['no matchMedia', null], ['throws', () => { throw new Error('unavailable'); }], ['returns undefined', () => undefined], ['returns a non-boolean match', () => ({matches: 'yes'})], ['returns null', () => null]]) {
    const e = await boot({catalog: avsCatalog, matchMedia}); e.settings({transition: 24, beats: 0, durationMs: 2000});
    const n = await next(e, 10); assert.equal(n.entry.options.context.reducedMotion, false, label); assert.equal(n.entry.instance.mode, 24, label);
  }
}

// ================================================================ 6. the clocked NERV path
const CLOCK = {enabled: true, bpm: 120, offsetSeconds: 0, barsPerScene: 1, seed: 89};
async function clocked(catalog, timing = CLOCK, options = {}) {
  const env = await boot({catalog, ...options}), setup = env.actions.nervSetup();
  setup.timing = {...timing}; env.actions.activate(setup); await env.flush(); env.active = await env.load();
  return env;
}
/** Move the paused clock to `t` and return the frame the active plate was asked for (loading the scene of a new ordinal when the clock crossed one). */
async function seek(env, t) {
  const before = env.fetches.length; env.audio(t, false); await env.flush();
  if (env.fetches.length > before) env.active = await env.load(); else { env.tick(); env.active.send('frame'); }
  return structuredClone(env.lastRender(env.active).nerv);
}
function assertWire(nerv, where, {reduced = false} = {}) {
  const reply = feedWorker(nerv); assert.equal(reply.type, 'frame', `${where}: the NERV worker accepts the wire frame (${reply.message})`);
  if (nerv.transitionBeats !== undefined) assert.ok(Number.isFinite(nerv.transitionBeats) && nerv.transitionBeats > 0 && nerv.transitionBeats <= 64, `${where}: transitionBeats ${nerv.transitionBeats}`);
  if (nerv.transitionBoundary !== undefined) assert.ok(Number.isInteger(nerv.transitionBoundary) && nerv.transitionBoundary >= 0 && nerv.transitionBoundary <= 3, `${where}: transitionBoundary ${nerv.transitionBoundary}`);
  if (nerv.transitionAccent !== undefined) assert.ok(nerv.transitionAccent === 0 || nerv.transitionAccent === 1, `${where}: transitionAccent`);
  if (nerv.transitionReduced !== undefined) assert.equal(typeof nerv.transitionReduced, 'boolean', `${where}: transitionReduced`);
  if (nerv.fadeSeconds !== undefined) assert.ok(Number.isFinite(nerv.fadeSeconds) && nerv.fadeSeconds >= 0, `${where}: fadeSeconds`);
  if (nerv.previousScene !== undefined) {
    assert.notEqual(nerv.transitionBeats, undefined, `${where}: an outgoing plate carries transitionBeats`); assert.notEqual(nerv.transitionBoundary, undefined, `${where}: an outgoing plate carries transitionBoundary`);
    assert.equal(nerv.transitionAccent ?? 1, 1, `${where}: both plates of the clocked path are scenes: NERV accent`); assert.equal(nerv.transitionReduced ?? false, reduced, `${where}: transitionReduced`);
  }
}
{
  const env = await clocked(nervCatalog);
  // Fade length in beats and seconds, from the three timing vocabularies of the settings message.
  for (const [extra, seconds, beats] of [[{beats: 1}, .5, 1], [{beats: 2}, 1, 2], [{beats: 4}, 2, 4], [{beats: 0, durationMs: 1000}, 1, 2], [{beats: 0, durationMs: 500}, .5, 1]]) {
    env.settings({enabled: true, transition: 1, ...extra}); env.tick(); const frame = await seek(env, 4.25);
    assert.ok(frame.previousScene, `${JSON.stringify(extra)}: an outgoing plate`); assertWire(frame, JSON.stringify(extra));
    assert.ok(near(frame.fadeSeconds, seconds), `${JSON.stringify(extra)}: fadeSeconds ${frame.fadeSeconds}`); assert.ok(near(frame.transitionBeats, beats), `${JSON.stringify(extra)}: transitionBeats ${frame.transitionBeats}`);
    assert.ok(near(frame.blend, Math.min(1, .25 / seconds))); assert.equal(frame.transitionAccent ?? 1, 1);
  }
  // The bar level of the boundary (C-33): 3 on every 16th bar, 2 on every 4th, otherwise 1.
  const level = (ordinal, barsPerScene) => { const bar = ordinal * barsPerScene; return bar % 16 === 0 ? 3 : bar % 4 === 0 ? 2 : 1; };
  for (const barsPerScene of [1, 2, 4]) {
    const c = await clocked(nervCatalog, {...CLOCK, barsPerScene}), sceneSeconds = 2 * barsPerScene, seen = new Map();
    c.settings({enabled: true, transition: 31, beats: 1});
    for (const ordinal of [1, 2, 3, 4, 5, 8, 12, 15, 16, 17, 20, 32]) {
      const frame = await seek(c, ordinal * sceneSeconds + .25); assertWire(frame, `bars ${barsPerScene} ordinal ${ordinal}`);
      assert.ok(frame.previousScene, `bars ${barsPerScene} ordinal ${ordinal}: an outgoing plate`);
      assert.equal(frame.transitionBoundary, level(ordinal, barsPerScene), `bars ${barsPerScene} ordinal ${ordinal}: boundary level`);
      assert.equal(frame.transitionMode, 31, 'Random, all styles reaches the worker as requested'); assert.ok(isUint32(frame.transitionSeed)); seen.set(ordinal, frame.transitionSeed);
    }
    assert.equal(new Set(seen.values()).size, seen.size, `bars ${barsPerScene}: every boundary has its own seed`);
  }
  // Seek and repeat replay byte-identically, new fields included.
  const c = await clocked(nervCatalog); c.settings({enabled: true, transition: 32, beats: 4});
  const a = await seek(c, 8.25); await seek(c, 26.25); await seek(c, 4.25); const again = await seek(c, 8.25); assert.deepEqual(again, a, 'the wire frame of a boundary replays after seeking away and back');
  assertWire(a, 'replay'); assert.equal(a.transitionMode, 32);
  // Every style index, selectors included, reaches the worker unchanged; Cut and Instant send no outgoing plate.
  for (const mode of [0, 1, 16, 22, 24, 27, 29, 30, 31, 32]) { c.settings({enabled: true, transition: mode, beats: 4}); c.tick(); const f = await seek(c, 8.25); assert.equal(f.transitionMode, mode, `style ${mode}`); assert.ok(f.previousScene, `style ${mode} fades`); assertWire(f, `style ${mode}`); }
  c.settings({enabled: true, transition: 15, beats: 4}); c.tick(); assert.equal((await seek(c, 8.25)).previousScene, undefined, 'Cut sends no outgoing plate');
  c.settings({enabled: true, transition: 16, fadeTiming: 1}); c.tick(); assert.equal((await seek(c, 8.25)).previousScene, undefined, 'Instant is Cut: no outgoing plate');
  c.settings({enabled: true, transition: 16, beats: 4}); c.tick(); assert.ok((await seek(c, 8.25)).previousScene, 'a timed fade works again after Instant');
}
{
  const env = await clocked(nervCatalog, CLOCK, {matchMedia: q => ({matches: q === '(prefers-reduced-motion: reduce)'})});
  env.settings({enabled: true, transition: 24, beats: 4});
  const f = await seek(env, 4.25); assert.ok(f.previousScene); assertWire(f, 'reduced', {reduced: true}); assert.equal(f.transitionReduced, true, 'the clocked wire frame carries reduced motion');
  assert.equal(f.transitionMode, 24, 'the host sends the requested style; the worker applies the fallback');
  const plain = await clocked(nervCatalog, CLOCK, {matchMedia: () => ({matches: false})}); plain.settings({enabled: true, transition: 24, beats: 4});
  const g = await seek(plain, 4.25); assertWire(g, 'not reduced'); assert.ok(g.transitionReduced !== true);
  // A clocked NERV setup survives a throwing matchMedia.
  const thrown = await clocked(nervCatalog, CLOCK, {matchMedia: () => { throw new Error('unavailable'); }}); thrown.settings({enabled: true, transition: 24, beats: 4}); assertWire(await seek(thrown, 4.25), 'throwing matchMedia');
}

// ================================================================ 7. the settings message: range and announcement
{
  const env = await boot({catalog: avsCatalog}), status = () => env.nodes.get('#status').textContent;
  for (const [mode, name] of [[0, 'Random · classic'], [1, 'Cross dissolve'], [15, 'Cut'], [16, 'Beat Step Wipe'], [24, 'Glitch Stutter'], [30, 'Spectrum Bars Wipe'], [31, 'Random · all styles'], [32, 'Smart random']]) {
    env.settings({transition: mode}); assert.ok(status().includes(name), `settings ${mode} announces ${name}: ${status()}`);
  }
  for (const bad of [33, -1, 1.5, 'x', null, 100]) { env.settings({transition: bad}); assert.ok(status().includes('Cross dissolve'), `settings ${String(bad)} falls back to Cross dissolve: ${status()}`); assert.ok(!status().includes('undefined')); }
  env.pagehide();
}
assert.ok(workerFrames >= 40, `the real NERV worker accepted ${workerFrames} wire frames`);
console.log('Host transitions: live seed/context/env (frozen bands, live level, accent, length), replayable seeds, Instant/Cut/seek, reduced motion (guarded, read once, context/env/wire), clocked wire fields (beats, boundary levels, accent, replay, selectors, Cut/Instant; each frame accepted by the real NERV worker), announcements and range PASS (fake DOM, workers and canvases; no GPU, no launch)');
