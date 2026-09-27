// In-app frame recorder — the RUM half of the performance story (review
// 2026-09-25, performance-benchmarker "RUM collector"; SUMMARY item 4).
//
// `gputimer.ts` says what the GPU spent; nothing said what the viewer got. This
// does: the rAF delta the page actually delivered, how many display refreshes
// went by without a new frame, percentiles over a window long enough for p99 to
// mean something, and how long a preset switch takes to reach the screen.
//
// Same rule as gputimer: never cost the frame. Every per-frame method writes a
// few numbers into preallocated rings and returns — no allocation, no sorting.
// The sorting happens in `readout()`, which the HUD calls a few times a second
// (or the D overlay once a frame while it is open, which is its own budget).
//
// Pure: no DOM, no clock. The caller passes `performance.now()` values in, so
// the maths is testable on synthetic timestamps.

/** rAF deltas kept for percentiles. ~8.5 s at 120 Hz, ~17 s at 60. */
export const DEFAULT_CAPACITY = 1024;
/** Histogram bins are 1 ms wide; the last bin collects everything longer. */
export const HISTOGRAM_BINS = 50;
/**
 * A delta this long is not a slow frame, it is a hidden tab, a breakpoint or a
 * laptop lid. It restarts the baseline rather than being counted as hundreds
 * of dropped frames.
 */
export const GAP_MS = 1000;
/** A delta more than this many display intervals counts as dropping frames. */
export const DROP_FACTOR = 1.5;
/** Preset-switch latencies kept. */
const TTFF_HISTORY = 16;
/** Deltas between re-estimates of the display interval (it is a histogram walk plus a ring scan). */
const REESTIMATE = 32;

export interface FrameReadout {
  /** Deltas in the window. */
  samples: number;
  /** Frames per second actually delivered over the window. */
  fps: number;
  /** Display refresh rate: set by the caller, or estimated from the fastest deltas. */
  displayHz: number;
  /** Refreshes that passed without a new frame, within the window / since reset. */
  droppedWindow: number;
  droppedTotal: number;
  /** rAF delta percentiles, ms (nearest-rank). */
  p50: number;
  p95: number;
  p99: number;
  maxMs: number;
  /** Most recent preset-switch-to-first-present, ms; NaN when none measured yet. */
  ttffMs: number;
  /** Worst of the recent switches, ms; NaN when none. */
  ttffMaxMs: number;
  /** Worker render ms (mean / p95 over the render ring); NaN when not reported. */
  renderMeanMs: number;
  renderP95Ms: number;
  /** GPU ms (mean / p95); NaN when the adapter has no timestamp-query. */
  gpuMeanMs: number;
  gpuP95Ms: number;
  /** Delta histogram, 1 ms bins, last bin = overflow. Shared with the recorder; copy to keep. */
  histogram: Uint32Array;
}

export function createFrameReadout(): FrameReadout {
  return {
    samples: 0, fps: 0, displayHz: 0, droppedWindow: 0, droppedTotal: 0,
    p50: 0, p95: 0, p99: 0, maxMs: 0,
    ttffMs: NaN, ttffMaxMs: NaN,
    renderMeanMs: NaN, renderP95Ms: NaN, gpuMeanMs: NaN, gpuP95Ms: NaN,
    histogram: new Uint32Array(HISTOGRAM_BINS),
  };
}

/** Fixed-capacity ring of numbers. Overwrites the oldest; never grows. */
class Ring {
  readonly data: Float64Array;
  head = 0;
  size = 0;
  constructor(capacity: number) { this.data = new Float64Array(capacity); }
  /** Returns the evicted value, or NaN when nothing was evicted. */
  push(v: number): number {
    const cap = this.data.length;
    let evicted = NaN;
    if (this.size === cap) {
      evicted = this.data[this.head]!;
      this.data[this.head] = v;
      this.head = (this.head + 1) % cap;
    } else {
      this.data[(this.head + this.size) % cap] = v;
      this.size++;
    }
    return evicted;
  }
  clear(): void { this.head = 0; this.size = 0; }
  /** Copy into `out` (length >= size), oldest first. */
  copyTo(out: Float64Array): number {
    const cap = this.data.length;
    for (let i = 0; i < this.size; i++) out[i] = this.data[(this.head + i) % cap]!;
    return this.size;
  }
}

/** Nearest-rank percentile of the first `n` entries of an ascending array. */
export function percentileSorted(sorted: Float64Array, n: number, p: number): number {
  if (n <= 0) return NaN;
  const rank = Math.ceil((p / 100) * n);
  return sorted[Math.min(n - 1, Math.max(0, rank - 1))]!;
}

/** Refreshes skipped by one delta, given the display interval. */
export function droppedFor(deltaMs: number, intervalMs: number): number {
  if (!(intervalMs > 0) || deltaMs <= intervalMs * DROP_FACTOR) return 0;
  return Math.max(0, Math.round(deltaMs / intervalMs) - 1);
}

export class FrameRecorder {
  private readonly deltas: Ring;
  private readonly drops: Ring;
  private readonly renders: Ring;
  private readonly gpus: Ring;
  private readonly ttffs: Ring;
  private readonly scratch: Float64Array;
  private readonly histogram = new Uint32Array(HISTOGRAM_BINS);
  private lastMs = NaN;
  private fixedHz = 0;
  private droppedTotal = 0;
  private droppedWindow = 0;
  private windowMs = 0;
  private switchAt = NaN;
  private statP95 = NaN;
  /** Estimated display interval, refreshed every REESTIMATE deltas rather than every frame. */
  private estimate = 0;
  private sinceEstimate = 0;

  constructor(capacity = DEFAULT_CAPACITY) {
    this.deltas = new Ring(capacity);
    this.drops = new Ring(capacity);
    this.renders = new Ring(capacity);
    this.gpus = new Ring(capacity);
    this.ttffs = new Ring(TTFF_HISTORY);
    this.scratch = new Float64Array(capacity);
  }

  /**
   * Pin the display rate (e.g. from a known projector mode). 0 returns to
   * estimating it from the deltas, which is right on any display that the
   * page has ever managed to keep up with.
   */
  setDisplayHz(hz: number): void { this.fixedHz = hz > 0 ? hz : 0; }

  /** Call once per rAF with its timestamp. */
  frame(nowMs: number): void {
    const prev = this.lastMs;
    this.lastMs = nowMs;
    if (!Number.isFinite(prev)) return;
    const delta = nowMs - prev;
    if (!(delta > 0) || delta >= GAP_MS) return;

    const evicted = this.deltas.push(delta);
    this.windowMs += delta;
    this.histogram[binOf(delta)]!++;
    if (!Number.isNaN(evicted)) {
      this.windowMs -= evicted;
      this.histogram[binOf(evicted)]!--;
    }
    // Drops are judged against the interval as known NOW and remembered per
    // delta, so the window count can be corrected as old deltas leave it.
    if (this.estimate === 0 || ++this.sinceEstimate >= REESTIMATE) {
      this.estimate = this.estimateInterval();
      this.sinceEstimate = 0;
    }
    const dropped = droppedFor(delta, this.intervalMs());
    this.droppedTotal += dropped;
    this.droppedWindow += dropped;
    const evictedDrop = this.drops.push(dropped);
    if (!Number.isNaN(evictedDrop)) this.droppedWindow -= evictedDrop;
  }

  /** A preset switch was requested (e.g. at the top of `loadAvsPreset`). */
  markPresetSwitch(nowMs: number): void { this.switchAt = nowMs; }

  /**
   * A frame reached the screen. Only the first one after a switch is measured;
   * calling this every frame is fine and costs one comparison.
   */
  markPresented(nowMs: number): void {
    if (!Number.isFinite(this.switchAt)) return;
    this.ttffs.push(Math.max(0, nowMs - this.switchAt));
    this.switchAt = NaN;
  }

  /** Worker-reported CPU render time for the frame, ms. */
  recordRender(ms: number): void { if (Number.isFinite(ms) && ms >= 0) this.renders.push(ms); }

  /** GPU time for the frame, ms (sum of `GpuTimer.timings`). */
  recordGpu(ms: number): void { if (Number.isFinite(ms) && ms >= 0) this.gpus.push(ms); }

  reset(): void {
    this.deltas.clear(); this.drops.clear(); this.renders.clear(); this.gpus.clear(); this.ttffs.clear();
    this.histogram.fill(0);
    this.lastMs = NaN;
    this.droppedTotal = 0;
    this.droppedWindow = 0;
    this.windowMs = 0;
    this.switchAt = NaN;
    this.estimate = 0;
    this.sinceEstimate = 0;
  }

  /** Display interval in ms: pinned, or the 10th-percentile delta (vsync-quantised, so the floor is the refresh). */
  private intervalMs(): number {
    return this.fixedHz > 0 ? 1000 / this.fixedHz : this.estimate;
  }

  private estimateInterval(): number {
    // Cheap estimate from the histogram: the first bin holding >= 10% of the
    // window. Good to 1 ms, which is all DROP_FACTOR needs. Before there are
    // enough samples, no drops are counted rather than guessed.
    const n = this.deltas.size;
    if (n < 30) return 0;
    const need = Math.ceil(n * 0.1);
    let acc = 0;
    for (let i = 0; i < HISTOGRAM_BINS - 1; i++) {
      acc += this.histogram[i]!;
      if (acc >= need) return this.refineInterval(i);
    }
    return 0;
  }

  /** Mean of the deltas in histogram bin `bin`, for a sub-millisecond interval. */
  private refineInterval(bin: number): number {
    const d = this.deltas;
    const cap = d.data.length;
    let sum = 0;
    let k = 0;
    for (let i = 0; i < d.size; i++) {
      const v = d.data[(d.head + i) % cap]!;
      if (binOf(v) === bin) { sum += v; k++; }
    }
    return k > 0 ? sum / k : bin + 0.5;
  }

  /** Fill `out` (from `createFrameReadout`). Sorts a copy of the ring: call at HUD rate, not per frame. */
  readout(out: FrameReadout): FrameReadout {
    const n = this.deltas.copyTo(this.scratch);
    const s = this.scratch.subarray(0, n).sort();
    out.samples = n;
    out.fps = this.windowMs > 0 ? (n * 1000) / this.windowMs : 0;
    this.estimate = this.estimateInterval();
    const interval = this.intervalMs();
    out.displayHz = interval > 0 ? 1000 / interval : 0;
    out.droppedWindow = this.droppedWindow;
    out.droppedTotal = this.droppedTotal;
    out.p50 = percentileSorted(s, n, 50);
    out.p95 = percentileSorted(s, n, 95);
    out.p99 = percentileSorted(s, n, 99);
    out.maxMs = n > 0 ? s[n - 1]! : NaN;
    out.histogram.set(this.histogram);

    const tn = this.ttffs.copyTo(this.scratch);
    out.ttffMs = tn > 0 ? this.scratch[tn - 1]! : NaN;
    let tmax = NaN;
    for (let i = 0; i < tn; i++) if (!(this.scratch[i]! <= tmax)) tmax = this.scratch[i]!;
    out.ttffMaxMs = tmax;

    out.renderMeanMs = this.stat(this.renders);
    out.renderP95Ms = this.statP95;
    out.gpuMeanMs = this.stat(this.gpus);
    out.gpuP95Ms = this.statP95;
    return out;
  }

  /** Mean of a ring; its p95 is left in `statP95` (no tuple, no allocation). */
  private stat(ring: Ring): number {
    const n = ring.copyTo(this.scratch);
    this.statP95 = NaN;
    if (n === 0) return NaN;
    let sum = 0;
    for (let i = 0; i < n; i++) sum += this.scratch[i]!;
    const s = this.scratch.subarray(0, n).sort();
    this.statP95 = percentileSorted(s, n, 95);
    return sum / n;
  }

  /**
   * Everything, as JSON, for pasting into a benchmark table or attaching to a
   * bug. `meta` is merged in verbatim (preset name, resolution, lane...).
   */
  exportJson(meta: Record<string, unknown> = {}): string {
    const r = this.readout(createFrameReadout());
    const n = this.deltas.copyTo(this.scratch);
    const deltas = Array.from(this.scratch.subarray(0, n), (v) => Math.round(v * 1000) / 1000);
    return JSON.stringify({
      kind: 'aaavs-frame-recording',
      version: 1,
      ...meta,
      summary: {
        samples: r.samples, fps: round3(r.fps), displayHz: round3(r.displayHz),
        droppedWindow: r.droppedWindow, droppedTotal: r.droppedTotal,
        p50: round3(r.p50), p95: round3(r.p95), p99: round3(r.p99), maxMs: round3(r.maxMs),
        ttffMs: nullable(r.ttffMs), ttffMaxMs: nullable(r.ttffMaxMs),
        renderMeanMs: nullable(r.renderMeanMs), renderP95Ms: nullable(r.renderP95Ms),
        gpuMeanMs: nullable(r.gpuMeanMs), gpuP95Ms: nullable(r.gpuP95Ms),
      },
      histogramMs: Array.from(r.histogram),
      deltasMs: deltas,
    });
  }
}

function binOf(ms: number): number {
  const b = Math.floor(ms);
  return b < 0 ? 0 : b >= HISTOGRAM_BINS ? HISTOGRAM_BINS - 1 : b;
}

function round3(v: number): number { return Math.round(v * 1000) / 1000; }
function nullable(v: number): number | null { return Number.isFinite(v) ? round3(v) : null; }
