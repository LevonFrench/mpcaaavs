/** Show render worker (AAAVS):
 * Two dialects: the show dialect of src/show/protocol.ts (a whole song map, still renderer) and the NERV preset dialect of
 * src/avs-worker-protocol.ts ('load' a .nerv preset, 'render' with a NervPlaybackFrame and an AvsAudioFrame), which the MPC
 * host and the shared Player use for NERV presets when the show engine is on (src/hud/hud-host.ts nervWorkerUrl). In the
 * preset dialect the analysis is the live fallback over a window around the scene (src/show/preset-window.ts); if WebGL2
 * or the engine cannot start, the worker falls back to the Canvas2D NERV renderer (src/nerv-legacy-render.ts).
 * the port of bizarro/evangelion's engine (MIT, see THIRD-PARTY-NERV.txt) rendering
 * the NERV show with WebGL2 (three.js, HalfFloat linear HDR, upstream post chain) into an OffscreenCanvas.
 * Output size is 1920x1080 times the scale in the worker URL (`?scale=2` = 3840x2160); a scale change restarts the worker.
 * Frames are pure functions of media time, seed and the song map: a seek simply renders the new time.
 * Dialects: src/show/protocol.ts (show-init / show-render). */
import { Engine, type TimelineEntry } from './show/engine.ts';
import { AudioData } from './show/audio.ts';
import { PW, PH, SCALE } from './show/gl.ts';
import { setAssetBase } from './show/canvas.ts';
import { planShow, type PlannedPlate } from './show/plan.ts';
import { validateShowRequest, type ShowAudioMessage, type ShowInitMessage, type ShowPlanEntry, type ShowRenderMessage } from './show/protocol.ts';
import { LiveAudioData } from './show/live.ts';
import { presetWindow, type PresetEntry } from './show/preset-window.ts';
import { loadEngineFonts } from './show/engine.ts';
import type { AvsWorkerRequest, AvsWorkerRenderMessage, NervPlaybackFrame } from './avs-worker-protocol.ts';
import { parseNervPreset } from './nerv-preset.ts';
import { createNervLegacyRenderer, drawNervTransition, validateNervClock, NERV_SILENCE, type NervTransitionCache } from './nerv-legacy-render.ts';
import { HARD_MAX_EDGE, HARD_MAX_PIXELS, fitWithin } from './render-resolution.ts';
import { NERV_SCENE_CLASSES, NERV_SHOW, type NervPlateId } from './shows/nerv/index.ts';
import { SHOW_DEFS, isShowId, type ShowId } from './shows/defs.ts';
import { SHOW_SCENES } from './shows/scenes.ts';
import { validateSongMap } from './song-map/validate.ts';
import { synthesizeWave } from './song-map/synth-wave.ts';
import { PERF, perfAdd, perfBegin, perfConfigure, perfEnd, perfNow, perfTake } from './perf-worker.ts';
import { epochNow, parsePerfMode, type PerfMode } from './perf-trace.ts';

const scope = self as unknown as {
  onmessage: ((event: MessageEvent<unknown>) => void) | null;
  postMessage(message: unknown, transfer?: Transferable[]): void;
};

const canvas = new OffscreenCanvas(PW, PH);
let engine: Engine | null = null;
let entries: TimelineEntry[] = [];
let generation = -1;
let queue: Promise<void> = Promise.resolve();
let verbose = false;
let live: LiveAudioData | null = null;
const debug = (s: string) => { if (verbose) console.info('[show worker]', s); };
/** Stage timing (src/perf-worker.ts, docs/PERFORMANCE.md): off unless the worker URL has ?perf=1|sync or a render message carries `perf`. */
const urlPerf: PerfMode = parsePerfMode(new URL(self.location.href).searchParams.get('perf'));
/** Apply the mode of this render message (its `perf` field, else the URL default) and account the request's time in flight. */
function perfFrameStart(perf: { readonly mode: PerfMode; readonly sent?: number } | undefined) {
  perfConfigure(perf ? perf.mode : urlPerf);
  if (PERF.on && typeof perf?.sent === 'number' && Number.isFinite(perf.sent)) { const at = epochNow(); if (Number.isFinite(at)) perfAdd('msg.request', Math.max(0, at - perf.sent)); }
}

/** Timeline entries for planned plates (one scene instance per window). */
export function entriesFor(plan: readonly PlannedPlate[], show: ShowId = 'nerv'): TimelineEntry[] {
  return plan.map((p) => {
    const cls = SHOW_SCENES[show][p.id];
    if (!cls) throw new Error(`unknown ${show} plate ${p.id}`);
    return { id: p.id, key: `${p.id}@${p.start.toFixed(4)}-${p.end.toFixed(4)}`, load: () => ({ default: cls }), start: p.start, end: p.end, barMap: p.barMap, params: p.params };
  });
}

async function init(m: ShowInitMessage) {
  const t0 = performance.now();
  setAssetBase(m.assetBase);
  verbose = m.verbose === true;
  let audio: AudioData, synthesized = false;
  if (!m.songMap) {
    // live fallback: tempo grid + live AVS frames (show-audio) until a song map arrives in a new show-init
    audio = live = new LiveAudioData({ duration: m.duration!, bpm: m.bpm!, firstBeat: m.firstBeat, sampleRate: m.sampleRate });
  } else {
    live = null;
    const spec = m.spec ? new Uint8Array(m.spec) : undefined;
    const map = validateSongMap(m.songMap, { spec });
    let wave: Float32Array | undefined = m.wave ? new Float32Array(m.wave) : undefined;
    if (!wave) {
      const w = synthesizeWave(map, { spec });
      wave = w.wave; synthesized = true;
      map.wave = { rate: w.rate, channels: 2, frames: w.frames };
    }
    audio = new AudioData(map, { spec, wave });
  }
  const map = audio.map;
  debug(`analysis ready ${(performance.now() - t0).toFixed(0)} ms`);
  const showId: ShowId = isShowId(m.show) ? m.show : 'nerv';
  const full = planShow(map, SHOW_DEFS[showId], { ...(m.params ?? {}) });
  // other shows than NERV number their plates in the header (the index in the whole plan, not in the filtered one)
  if (showId !== 'nerv') full.forEach((p, i) => { p.params = { ...p.params, plateNo: i + 1 }; });
  let plan = full;
  if (m.only?.length) plan = plan.filter((p) => m.only!.includes(p.id));
  entries = entriesFor(plan, showId);
  if (!engine) {
    engine = new Engine(canvas as unknown as HTMLCanvasElement, () => entries);
    engine.onProgress = (msg) => debug(`${msg} ${(performance.now() - t0).toFixed(0)} ms`);
    await engine.init(audio);
  } else await engine.setAudio(audio, entries);
  debug(`engine ready ${(performance.now() - t0).toFixed(0)} ms`);
  const out: ShowPlanEntry[] = full.map((p) => ({ id: p.id, role: p.role, start: p.start, end: p.end, startBar: p.startBar, endBar: p.endBar }));
  scope.postMessage({ type: 'show-ready', generation: m.generation, plan: out, duration: map.duration, scale: SCALE, width: PW, height: PH, errors: engine.errors.slice(), synthesizedWave: synthesized, initMs: performance.now() - t0 });
}

function render(m: ShowRenderMessage) {
  if (!engine) throw new Error('show worker not initialised');
  perfFrameStart(m.perf);
  const t0 = performance.now();
  engine.render(m.time, m.dt ?? 1 / 60, true);
  if (m.sync) engine.renderer.getContext().finish();
  const renderMs = performance.now() - t0;
  const b0 = PERF.on ? perfBegin() : 0;
  const bitmap = canvas.transferToImageBitmap();
  if (PERF.on) { perfEnd('frame.bitmap', b0); perfAdd('frame.total', perfNow() - t0); }
  const e = entries.find((x) => m.time >= x.start && m.time < x.end);
  const perf = perfTake();
  const r0 = perf ? perfNow() : 0;
  scope.postMessage({ type: 'show-frame', generation: m.generation, sequence: m.sequence, bitmap, width: PW, height: PH, renderMs, plate: e?.id ?? null, ...(perf ? { perf } : {}) }, [bitmap]);
  if (perf) perfAdd('frame.reply', perfNow() - r0);
}

function pushAudio(m: ShowAudioMessage) {
  if (!live) return; // a song map is loaded: live frames are not needed
  const w = new Uint8Array(m.waveform), sp = new Uint8Array(m.spectrum);
  const a0 = PERF.on ? perfNow() : 0;
  live.push(m.time, { waveform: [w.subarray(0, 576), w.subarray(576)], spectrum: [sp.subarray(0, 576), sp.subarray(576)], beat: m.beat, beatLevel: m.beatLevel });
  if (PERF.on) perfAdd('live.push', perfNow() - a0);
}

// ------------------------------------------------------------------ NERV preset dialect
const params = new URL(self.location.href).searchParams;
let presetEngine: Engine | null = null, presetLive: LiveAudioData | null = null, presetEntries: TimelineEntry[] = [];
let presetPlate: NervPlateId | null = null, presetGen = -1, presetKey = '', presetLastTime = -1, presetReady = false;
let legacy: ((m: AvsWorkerRequest) => void) | null = null;
let out: OffscreenCanvas | null = null, oldOut: OffscreenCanvas | null = null, nextOut: OffscreenCanvas | null = null;
const transition: NervTransitionCache = { transition: null, key: '' };
const clocks = new Map<string, number>();
const post = (message: unknown, transfer?: Transferable[]) => scope.postMessage(message, transfer);

function surface(c: OffscreenCanvas | null, w: number, h: number): OffscreenCanvas {
  const r = c ?? new OffscreenCanvas(w, h);
  if (r.width !== w) r.width = w;
  if (r.height !== h) r.height = h;
  return r;
}
/** The engine's 16:9 frame fitted inside w x h (letterboxed). */
function drawFitted(target: OffscreenCanvas, w: number, h: number) {
  const f0 = PERF.on ? perfBegin() : 0;
  const g = target.getContext('2d', { alpha: false });
  if (!g) throw new Error('NERV canvas unavailable');
  g.fillStyle = '#000'; g.fillRect(0, 0, w, h);
  const k = Math.min(w / PW, h / PH), dw = Math.round(PW * k), dh = Math.round(PH * k);
  g.imageSmoothingEnabled = true; g.imageSmoothingQuality = 'high';
  g.drawImage(canvas, Math.floor((w - dw) / 2), Math.floor((h - dh) / 2), dw, dh);
  if (PERF.on) perfEnd('frame.fit', f0);
  return g;
}
function presetEntry(e: PresetEntry): TimelineEntry {
  return { id: e.id, key: e.key, load: () => ({ default: NERV_SCENE_CLASSES[e.id] }), start: e.start, end: e.end, barMap: e.barMap, params: {} };
}
/** Render one plate of the preset timeline at time t on its own clock (seek detection per plate). */
function renderPlate(key: string, t: number) {
  const p0 = PERF.on ? perfBegin() : 0;
  const eng = presetEngine!;
  eng.filter = (e) => Engine.keyOf(e) === key;
  eng.lastT = clocks.get(key) ?? -1;
  const last = eng.lastT, dt = last >= 0 && t > last && t - last < 0.1 ? t - last : 1 / 60;
  eng.render(t, dt, true);
  clocks.set(key, t);
  if (PERF.on) perfEnd('frame.plates', p0);
}

async function presetLoad(m: Extract<AvsWorkerRequest, { type: 'load' }>) {
  presetGen = m.generation;
  if (legacy) { legacy(m); return; }
  try {
    // ?renderer=canvas2d forces the fallback (diagnostics, and the smoke test's proof of the fallback path)
    if (params.get('renderer') === 'canvas2d') throw new Error('Canvas2D renderer requested');
    presetPlate = parseNervPreset(m.preset) as NervPlateId;
    if (!NERV_SCENE_CLASSES[presetPlate]) throw new Error(`unknown NERV plate ${presetPlate}`);
    setAssetBase(new URL(params.get('assets') ?? '../show-assets/', self.location.href).href);
    await loadEngineFonts();
    // WebGL2 is created here, so a device without it falls back before the first frame
    presetEngine ??= new Engine(canvas as unknown as HTMLCanvasElement, () => presetEntries);
    presetKey = ''; clocks.clear();
    post({ type: 'ready', generation: presetGen, unsupported: 0, renderer: 'show' });
  } catch (error) {
    console.warn('[show worker] NERV presets fall back to the Canvas2D renderer:', error);
    presetEngine = null;
    legacy = createNervLegacyRenderer((msg, transfer) => post((msg as { type?: string }).type === 'ready' ? { ...(msg as object), renderer: 'canvas2d' } : msg, transfer));
    legacy(m);
  }
}

async function presetRender(m: AvsWorkerRenderMessage) {
  if (legacy) { legacy(m); return; }
  if (m.generation !== presetGen || !presetPlate || !presetEngine) return;
  try {
    perfFrameStart(m.perf);
    const started = performance.now();
    if (!Number.isFinite(m.width) || !Number.isFinite(m.height)) throw Error('Invalid scene size');
    const { width, height } = fitWithin(m.width, m.height, HARD_MAX_EDGE, HARD_MAX_PIXELS);
    const clock: NervPlaybackFrame = m.nerv ?? { time: 0, localTime: 0, progress: 0, bpm: 120, seed: 1 };
    validateNervClock(clock);
    const w0 = PERF.on ? perfNow() : 0;
    const w = presetWindow(clock, presetPlate);
    if (w.key !== presetKey) {
      presetLive = new LiveAudioData(w.live);
      presetEntries = [presetEntry(w.current), ...(w.previous ? [presetEntry(w.previous)] : [])];
      if (!presetReady) { await presetEngine.init(presetLive); presetReady = true; } else await presetEngine.setAudio(presetLive, presetEntries);
      presetKey = w.key; clocks.clear();
    }
    if (PERF.on) perfAdd('frame.window', perfNow() - w0);
    const audio = m.audio ?? NERV_SILENCE;
    const l0 = PERF.on ? perfNow() : 0;
    if (m.audio && clock.time !== presetLastTime) { presetLive!.push(clock.time, m.audio); if (PERF.on) perfAdd('live.push', perfNow() - l0); }
    presetLastTime = clock.time;
    out = surface(out, width, height);
    if (w.previous) {
      oldOut = surface(oldOut, width, height); nextOut = surface(nextOut, width, height);
      renderPlate(w.previous.key, clock.previousTime ?? clock.time); drawFitted(oldOut, width, height);
      renderPlate(w.current.key, clock.time); drawFitted(nextOut, width, height);
      const ctx = out.getContext('2d', { alpha: false });
      if (!ctx) throw Error('NERV canvas unavailable');
      const x0 = PERF.on ? perfNow() : 0;
      drawNervTransition(ctx, oldOut, nextOut, clock, audio, width, height, transition);
      if (PERF.on) perfAdd('frame.transition', perfNow() - x0);
    } else {
      if (oldOut || nextOut) { for (const c of [oldOut, nextOut]) if (c) { c.width = 0; c.height = 0; } oldOut = nextOut = null; transition.transition = null; transition.key = ''; }
      renderPlate(w.current.key, clock.time);
      drawFitted(out, width, height);
    }
    const b0 = PERF.on ? perfNow() : 0;
    const bitmap = out.transferToImageBitmap(), elapsed = performance.now() - started;
    if (PERF.on) { perfAdd('frame.bitmap', perfNow() - b0); perfAdd('frame.total', elapsed); }
    const perf = perfTake(), r0 = perf ? perfNow() : 0;
    post({ type: 'frame', generation: presetGen, sequence: m.sequence, bitmap, pcm: m.pcm, width, height, unsupported: 0, renderMs: elapsed > 0 ? elapsed : 0, ...(perf ? { perf } : {}) }, [bitmap, m.pcm]);
    if (perf) perfAdd('frame.reply', perfNow() - r0);
  } catch (error) {
    post({ type: 'error', generation: m.generation, message: String(error), fatal: true });
  }
}

scope.onmessage = ({ data }) => {
  const type = (data as { type?: unknown } | null)?.type;
  if (type === 'load' || type === 'render' || type === 'clear' || type === 'controls') {
    queue = queue.then(async () => {
      const m = data as AvsWorkerRequest;
      if (m.type === 'load') await presetLoad(m);
      else if (m.type === 'render') await presetRender(m);
      else legacy?.(m);
    });
    return;
  }
  queue = queue.then(async () => {
    let gen = -1;
    try {
      const m = validateShowRequest(data);
      gen = m.generation;
      if (m.type === 'show-init') { generation = m.generation; await init(m); return; }
      if (m.generation !== generation) return;
      if (m.type === 'show-audio') { pushAudio(m); return; }
      render(m);
    } catch (error) {
      scope.postMessage({ type: 'show-error', generation: gen, message: String((error as Error)?.stack ?? error) });
    }
  });
};
