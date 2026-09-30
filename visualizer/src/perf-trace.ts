/** Per-stage performance trace (AAAVS): the stage-name catalog, the trace JSON format, the statistics helpers and the host-side recorder.
 * Pure TypeScript with no DOM and no engine imports, so the worker, the hosts, the bench tool (tools/bench-shows.mjs) and the CPU checks all
 * share one definition. Everything here is OFF by default: a recorder that is not enabled ignores every call after a single boolean test.
 * See docs/PERFORMANCE.md for how to read a trace. */

export const PERF_TRACE_FORMAT = 'aaavs-perf-trace';
export const PERF_TRACE_VERSION = 1;
/** Budget of one frame at 60 fps, ms. A frame whose total exceeds it is "over budget" (dropped at 60 Hz). */
export const FRAME_BUDGET_MS = 1000 / 60;
/** Mode of the instrumentation: 0 off, 1 CPU timestamps, 2 CPU timestamps with a GPU wait around each GL stage (distorts pipelining). */
export type PerfMode = 0 | 1 | 2;

export interface StageDef {
  readonly name: string;
  readonly where: 'worker' | 'host';
  /** The stage this one is nested in (its time is included in the parent's); roots partition a frame. */
  readonly parent?: string;
  readonly desc: string;
}

/** Every stage the instrumentation can emit. Names of the form layer.<id>.draw and layer.<id>.upload are open-ended (see isKnownStage). */
export const PERF_STAGES: readonly StageDef[] = [
  { name: 'frame.total', where: 'worker', desc: 'Whole frame build in the worker: from the render message to the finished ImageBitmap, excluding the reply postMessage.' },
  { name: 'frame.window', where: 'worker', parent: 'frame.total', desc: 'NERV preset window (presetWindow) and, when the scene window changed, the rebuild of the live analysis and the engine timeline (first frame of a scene).' },
  { name: 'live.push', where: 'worker', parent: 'frame.total', desc: 'Pushing the host AVS audio frame into the live analysis (LiveAudioData.push); in the show dialect one sample per show-audio message.' },
  { name: 'frame.plates', where: 'worker', parent: 'frame.total', desc: 'All engine renders of the frame (one per plate, two during a crossfade).' },
  { name: 'engine.render', where: 'worker', parent: 'frame.plates', desc: 'One Engine.render call: analysis textures, scene composite, HUD, post chain and blit.' },
  { name: 'engine.spectrum', where: 'worker', parent: 'engine.render', desc: 'Upload of the live analysis textures that changed since the last frame (mel, chroma, waveform).' },
  { name: 'engine.composite', where: 'worker', parent: 'engine.render', desc: 'Scene composite: every active scene rendered into HDR targets and crossfaded.' },
  { name: 'scene.render', where: 'worker', parent: 'engine.composite', desc: 'Scene.render of the plate(s): its Canvas2D layers, GL draws and their texture uploads.' },
  { name: 'scene.preroll', where: 'worker', parent: 'engine.composite', desc: 'Fast-forward re-simulation of a stateful scene after a seek (never in steady playback).' },
  { name: 'engine.xfade', where: 'worker', parent: 'engine.composite', desc: 'The default crossfade pass between two overlapping scenes.' },
  { name: 'engine.hud', where: 'worker', parent: 'engine.render', desc: 'HUD overlay (captions, crop marks): Canvas2D draw plus texture upload.' },
  { name: 'engine.post', where: 'worker', parent: 'engine.render', desc: 'The post chain: bloom pyramid and the final grade pass.' },
  { name: 'post.bloom', where: 'worker', parent: 'engine.post', desc: 'Bloom prefilter, 6 downsamples and 6 upsamples.' },
  { name: 'post.final', where: 'worker', parent: 'engine.post', desc: 'Final pass: aberration, bloom and halation add, HUD composite, tone shoulder, vignette, grain.' },
  { name: 'engine.blit', where: 'worker', parent: 'engine.render', desc: 'Copy of the final target to the canvas.' },
  { name: 'comp.draw', where: 'worker', desc: 'Compositor.draw calls (texture over target): their CPU time; the first use of a freshly uploaded Canvas2D layer includes its texture upload. Overlaps scene.render and engine.composite.' },
  { name: 'canvas2d.draw', where: 'worker', desc: 'Sum of the Layer2D draw spans (clear() to upload()): Canvas2D command recording, plus any other work between the two calls.' },
  { name: 'gl.upload.canvas', where: 'worker', desc: 'Texture uploads from a Canvas2D layer (texImage2D/texSubImage2D with a canvas source); the GPU raster of the layer is flushed here.' },
  { name: 'gl.upload.data', where: 'worker', desc: 'Texture uploads from typed arrays (analysis textures, scope banks).' },
  { name: 'gl.upload.buffer', where: 'worker', desc: 'bufferData/bufferSubData (line and geometry buffers).' },
  { name: 'frame.fit', where: 'worker', parent: 'frame.total', desc: 'Copy of the WebGL canvas into the 2D output surface (letterbox, scale). Without sync timing this is where queued GPU work is waited for.' },
  { name: 'frame.transition', where: 'worker', parent: 'frame.total', desc: 'The AVS-style transition between the outgoing and incoming plate (Canvas2D).' },
  { name: 'frame.bitmap', where: 'worker', parent: 'frame.total', desc: 'transferToImageBitmap of the output surface.' },
  { name: 'frame.reply', where: 'worker', desc: 'The reply postMessage (structured clone and transfer); reported with the next frame.' },
  { name: 'msg.request', where: 'worker', desc: 'Time the render request spent between the host postMessage and the worker starting it (flight plus queueing behind earlier work); needs the host to send its epoch.' },
  { name: 'host.rtt', where: 'host', desc: 'Request to frame reply of the active slot, measured on the main thread.' },
  { name: 'host.reply', where: 'host', desc: 'Time the frame reply spent between the worker postMessage and the host handler starting (flight plus main-thread queueing).' },
  { name: 'host.complete', where: 'host', desc: 'Bench only: time from the reply to the frame\'s pixels existing (a 1-pixel readback of the presented canvas): GPU work the worker had queued but not finished.' },
  { name: 'host.present', where: 'host', desc: 'Main-thread draw of a presented frame: flash gate and canvas copy/scale.' },
  { name: 'host.transition', where: 'host', desc: 'Main-thread AVS transition composite between two worker bitmaps.' },
  { name: 'host.raf.interval', where: 'host', desc: 'Interval between requestAnimationFrame callbacks (display cadence; jitter is its spread).' },
  { name: 'host.raf.busy', where: 'host', desc: 'Duration of the requestAnimationFrame callback body on the main thread.' },
  { name: 'host.audio.msg', where: 'host', desc: 'Handling of one native audio message on the main thread (analysis, worker audio queues, scene clock), until the ack.' },
];

/** Counters of the host trace: message counts and payload sizes per second. */
export const PERF_COUNTERS: readonly { name: string; desc: string }[] = [
  { name: 'host.audio.messages', desc: 'Native audio messages received by the page.' },
  { name: 'host.audio.frames', desc: 'Native PCM frames inside those messages.' },
  { name: 'host.audio.floats', desc: 'PCM floats received (1152 per frame plus the 1152 of the message itself); the JSON on the wire is several times larger.' },
  { name: 'host.render.messages', desc: 'Render requests posted to workers.' },
  { name: 'host.render.bytes', desc: 'Payload of those requests (PCM buffer, AVS audio frame, clock fields).' },
  { name: 'host.frame.messages', desc: 'Frame replies received from workers.' },
];

const STAGE_NAMES = new Set(PERF_STAGES.map((s) => s.name));
const COUNTER_NAMES = new Set(PERF_COUNTERS.map((c) => c.name));
const LAYER_STAGE = /^layer\.[A-Za-z0-9_.#\-]+\.(draw|upload)$/;
export const isKnownStage = (name: string) => STAGE_NAMES.has(name) || LAYER_STAGE.test(name);
export const isKnownCounter = (name: string) => COUNTER_NAMES.has(name);

// ------------------------------------------------------------------ statistics
export interface StageSummary { readonly n: number; readonly mean: number; readonly p50: number; readonly p95: number; readonly p99: number; readonly max: number }

/** Nearest-rank percentile of an ascending array (0 <= q <= 1). */
export function percentile(sorted: ArrayLike<number>, q: number): number {
  const n = sorted.length;
  if (!n) return 0;
  return sorted[Math.min(n - 1, Math.max(0, Math.ceil(q * n) - 1))]!;
}
export function summarize(values: ArrayLike<number>): StageSummary {
  const n = values.length;
  if (!n) return { n: 0, mean: 0, p50: 0, p95: 0, p99: 0, max: 0 };
  const a = Float64Array.from(values as ArrayLike<number>).sort();
  let sum = 0;
  for (let i = 0; i < n; i++) sum += a[i]!;
  return { n, mean: sum / n, p50: percentile(a, 0.5), p95: percentile(a, 0.95), p99: percentile(a, 0.99), max: a[n - 1]! };
}
/** Frame-time histogram: counts of values below each edge, then the overflow. `edges` ascending (ms). */
export const FRAME_HISTOGRAM_EDGES = [4, 8, 12, 16.7, 20, 25, 33.4, 50, 67, 100, 200, 500, 1000] as const;
export function histogram(values: ArrayLike<number>, edges: readonly number[] = FRAME_HISTOGRAM_EDGES): number[] {
  const out = new Array<number>(edges.length + 1).fill(0);
  for (let i = 0; i < values.length; i++) {
    const v = values[i]!;
    let k = 0;
    while (k < edges.length && v >= edges[k]!) k++;
    out[k]!++;
  }
  return out;
}
const r3 = (x: number) => Math.round(x * 1000) / 1000;
export const roundSummary = (s: StageSummary): StageSummary => ({ n: s.n, mean: r3(s.mean), p50: r3(s.p50), p95: r3(s.p95), p99: r3(s.p99), max: r3(s.max) });

// ------------------------------------------------------------------ trace format
/** One frame's stage times (ms, summed when a stage ran more than once) and call counts, as sent by a worker in `perf` on its frame reply. */
export interface WorkerPerfFrame {
  readonly stages: Record<string, number>;
  readonly counts?: Record<string, number>;
  readonly mode: PerfMode;
  /** Worker epoch time (performance.timeOrigin + performance.now()) just before the reply was posted. */
  readonly epoch?: number;
}

export interface PerfTrace {
  readonly format: typeof PERF_TRACE_FORMAT;
  readonly version: typeof PERF_TRACE_VERSION;
  /** 'host' (page recorder), 'bench' (tools/bench-shows.mjs). */
  readonly source: string;
  readonly mode: PerfMode;
  readonly frames: number;
  readonly seconds: number;
  readonly stages: Record<string, StageSummary>;
  readonly counters: Record<string, { readonly total: number; readonly perSecond: number }>;
  /** Raw per-frame values of each stage (most recent first-to-last), only in a downloaded trace. */
  readonly series?: Record<string, number[]>;
  readonly meta?: Record<string, unknown>;
}

const isNum = (x: unknown): x is number => typeof x === 'number' && Number.isFinite(x);
const isSummary = (s: unknown): s is StageSummary => !!s && typeof s === 'object' && (['n', 'mean', 'p50', 'p95', 'p99', 'max'] as const).every((k) => isNum((s as Record<string, unknown>)[k]));
/** The contract of a trace: format and version, known stage and counter names, finite ordered statistics. Throws on the first violation. */
export function validateTrace(t: unknown): PerfTrace {
  if (!t || typeof t !== 'object') throw new Error('trace is not an object');
  const x = t as Record<string, unknown>;
  if (x.format !== PERF_TRACE_FORMAT) throw new Error(`trace format ${String(x.format)}`);
  if (x.version !== PERF_TRACE_VERSION) throw new Error(`trace version ${String(x.version)}`);
  if (typeof x.source !== 'string') throw new Error('trace source');
  if (x.mode !== 0 && x.mode !== 1 && x.mode !== 2) throw new Error('trace mode');
  if (!Number.isInteger(x.frames) || (x.frames as number) < 0 || !isNum(x.seconds) || x.seconds < 0) throw new Error('trace frames or seconds');
  if (!x.stages || typeof x.stages !== 'object') throw new Error('trace stages');
  for (const [name, s] of Object.entries(x.stages as Record<string, unknown>)) {
    if (!isKnownStage(name)) throw new Error(`unknown stage ${name}`);
    if (!isSummary(s)) throw new Error(`stage ${name} summary`);
    if (!(s.p50 <= s.p95 + 1e-9 && s.p95 <= s.p99 + 1e-9 && s.p99 <= s.max + 1e-9 && s.p50 >= 0)) throw new Error(`stage ${name} statistics are not ordered`);
  }
  if (!x.counters || typeof x.counters !== 'object') throw new Error('trace counters');
  for (const [name, c] of Object.entries(x.counters as Record<string, unknown>)) {
    if (!isKnownCounter(name)) throw new Error(`unknown counter ${name}`);
    if (!c || !isNum((c as Record<string, unknown>).total) || !isNum((c as Record<string, unknown>).perSecond)) throw new Error(`counter ${name}`);
  }
  if (x.series !== undefined) {
    if (!x.series || typeof x.series !== 'object') throw new Error('trace series');
    for (const [name, v] of Object.entries(x.series as Record<string, unknown>)) {
      if (!isKnownStage(name)) throw new Error(`unknown series ${name}`);
      if (!Array.isArray(v) || !v.every(isNum)) throw new Error(`series ${name}`);
    }
  }
  return t as PerfTrace;
}

/** Validate a worker's per-frame report (the host and the bench accept nothing else). */
export function validateWorkerPerf(p: unknown): WorkerPerfFrame {
  if (!p || typeof p !== 'object') throw new Error('perf frame is not an object');
  const x = p as Record<string, unknown>;
  if (x.mode !== 1 && x.mode !== 2) throw new Error('perf frame mode');
  if (!x.stages || typeof x.stages !== 'object') throw new Error('perf frame stages');
  for (const [name, v] of Object.entries(x.stages as Record<string, unknown>)) {
    if (!isKnownStage(name)) throw new Error(`unknown stage ${name}`);
    if (!isNum(v) || v < 0) throw new Error(`stage ${name} value`);
  }
  if (x.counts !== undefined) for (const [name, v] of Object.entries(x.counts as Record<string, unknown>)) if (!isKnownStage(name) || !isNum(v) || v < 0) throw new Error(`count ${name}`);
  if (x.epoch !== undefined && !isNum(x.epoch)) throw new Error('perf frame epoch');
  return p as WorkerPerfFrame;
}

/** Mode named by a `perf` URL or storage value: '1' / 'on' / 'true' -> 1, '2' / 'sync' -> 2, anything else -> 0. */
export function parsePerfMode(value: unknown): PerfMode {
  const v = String(value ?? '').trim().toLowerCase();
  if (v === '2' || v === 'sync') return 2;
  if (v === '1' || v === 'on' || v === 'true' || v === 'cpu') return 1;
  return 0;
}

/** Epoch time in ms (shared by a page and its workers), or NaN where performance.timeOrigin does not exist. */
export function epochNow(): number {
  const p = (globalThis as { performance?: { timeOrigin?: number; now(): number } }).performance;
  return p && typeof p.timeOrigin === 'number' ? p.timeOrigin + p.now() : NaN;
}

// ------------------------------------------------------------------ host recorder
const RING = 4096;
class Series {
  readonly values = new Float32Array(RING);
  head = 0; count = 0;
  push(v: number) { this.values[this.head] = v; this.head = (this.head + 1) % RING; if (this.count < RING) this.count++; }
  /** Oldest to newest. */
  toArray(): number[] {
    const out: number[] = [];
    const start = this.count < RING ? 0 : this.head;
    for (let i = 0; i < this.count; i++) out.push(this.values[(start + i) % RING]!);
    return out;
  }
}

/** Host-side recorder: bounded rings of per-event values per stage, and per-second counters. Disabled until enable(); every record call then costs
 * one boolean test. The page creates one (mpc-host.ts) and exposes it as window.__aaavsPerf. */
export class PerfRecorder {
  private mode: PerfMode = 0;
  private series = new Map<string, Series>();
  private counters = new Map<string, number>();
  private started = 0;
  private now: () => number;
  constructor(now?: () => number) { this.now = now ?? (() => (globalThis as { performance?: { now(): number } }).performance?.now() ?? Date.now()); }
  get enabled() { return this.mode !== 0; }
  get sync() { return this.mode === 2; }
  get level(): PerfMode { return this.mode; }
  enable(mode: PerfMode = 1) { if (this.mode === 0 && mode !== 0) this.reset(); this.mode = mode; }
  disable() { this.mode = 0; }
  reset() { this.series.clear(); this.counters.clear(); this.started = this.now(); }
  /** One event of a stage (ms). Call sites guard with `if (perf.enabled)` so the disabled cost is the boolean read. */
  record(stage: string, ms: number) {
    if (this.mode === 0 || !Number.isFinite(ms)) return;
    let s = this.series.get(stage);
    if (!s) this.series.set(stage, s = new Series());
    s.push(ms);
  }
  add(counter: string, n = 1) { if (this.mode !== 0) this.counters.set(counter, (this.counters.get(counter) ?? 0) + n); }
  /** A worker's per-frame report: each stage becomes one event; its epoch gives the reply latency. */
  recordWorker(p: WorkerPerfFrame | undefined, arrivedEpoch = NaN) {
    if (this.mode === 0 || !p) return;
    for (const [k, v] of Object.entries(p.stages)) this.record(k, v);
    if (Number.isFinite(arrivedEpoch) && typeof p.epoch === 'number') this.record('host.reply', Math.max(0, arrivedEpoch - p.epoch));
  }
  seconds() { return this.started ? Math.max(0, (this.now() - this.started) / 1000) : 0; }
  summary(): Record<string, StageSummary> {
    const out: Record<string, StageSummary> = {};
    for (const [k, s] of this.series) out[k] = roundSummary(summarize(s.toArray()));
    return out;
  }
  /** The trace JSON (what the page downloads). `series` adds the raw values. */
  trace(withSeries = true, meta: Record<string, unknown> = {}): PerfTrace {
    const seconds = this.seconds();
    const stages = this.summary();
    const counters: Record<string, { total: number; perSecond: number }> = {};
    for (const [k, v] of this.counters) counters[k] = { total: v, perSecond: seconds > 0 ? r3(v / seconds) : 0 };
    const frames = stages['host.rtt']?.n ?? stages['frame.total']?.n ?? 0;
    const trace: PerfTrace = { format: PERF_TRACE_FORMAT, version: PERF_TRACE_VERSION, source: 'host', mode: this.mode, frames, seconds: r3(seconds), stages, counters, meta };
    if (!withSeries) return trace;
    const series: Record<string, number[]> = {};
    for (const [k, s] of this.series) series[k] = s.toArray().map(r3);
    return { ...trace, series };
  }
  /** One short overlay segment (recent p50/p95 of the headline stages) or null when nothing was recorded. */
  line(): string | null {
    if (this.mode === 0) return null;
    const s = (k: string) => { const v = this.series.get(k); return v && v.count ? summarize(v.toArray().slice(-120)) : null; };
    const ms = (x: number) => x >= 100 ? x.toFixed(0) : x.toFixed(1);
    const parts: string[] = [];
    const w = s('frame.total'), r = s('host.rtt'), p = s('host.present'), j = s('host.raf.interval'), b = s('host.raf.busy');
    if (w) parts.push(`worker ${ms(w.p50)}/${ms(w.p95)}`);
    if (r) parts.push(`rtt ${ms(r.p50)}/${ms(r.p95)}`);
    if (p) parts.push(`present ${ms(p.p50)}/${ms(p.p95)}`);
    if (j) parts.push(`raf ${ms(j.p50)}/${ms(j.p95)}`);
    if (b) parts.push(`busy ${ms(b.p95)}`);
    const sec = this.seconds(), m = this.counters.get('host.audio.messages');
    if (m && sec > 1) parts.push(`audio ${Math.round(m / sec)}/s`);
    return parts.length ? `perf${this.mode === 2 ? ' (sync)' : ''} ms p50/p95: ${parts.join(' · ')}` : `perf${this.mode === 2 ? ' (sync)' : ''}: collecting`;
  }
}
