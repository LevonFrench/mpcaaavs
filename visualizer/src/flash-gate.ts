// Live flash gate: the flash limiter (src/flash-limiter.ts) at the one place
// both windows present an AVS frame — `presentLatest`'s draw callback, which
// hands over the FINAL bitmap whatever lane made it (CPU, exact GPU suffix,
// the '120' lane, the enhanced passes). Limiting there, rather than on the
// worker's packed pixels, is what keeps it honest: the GPU suffix runs after
// the upload, so the packed buffer is not what the viewer sees, and feeding a
// limited buffer into a stateful GPU pass would change what later frames
// render. Here the renderer is untouched; only `globalAlpha` changes.
//
// Each presented bitmap is downsampled to a 256x144 probe (4x4 samples per
// limiter cell), measured, and drawn with `globalAlpha = blend` over the
// retained 2D canvas. The limiter cannot read back the blended result, so it
// runs on `evaluate()`'s prediction (8-bit alpha, 8-bit channels). Not for
// `putImageData` (it ignores globalAlpha): the CPU fallback uses
// `limitRgbaFrame` on its ImageData copy instead.

import {
  DEFAULT_GRID_H, DEFAULT_GRID_W, FlashLimiter, computeFrameStatsRgba, createFrameStats,
  type FlashDecision, type FlashMode,
} from './flash-limiter.ts';

export const PROBE_W = DEFAULT_GRID_W * 4;
export const PROBE_H = DEFAULT_GRID_H * 4;

/** RGBA bytes of `source` scaled to PROBE_W x PROBE_H, or null when it cannot be read. */
export type FlashProbeSampler = (source: CanvasImageSource) => Uint8ClampedArray | null;

/** The minimum of a 2D context the gate touches (a fake one in the Node check). */
export interface FlashGateContext {
  globalAlpha: number;
  readonly canvas: { readonly width: number; readonly height: number };
}

export class FlashGate {
  readonly limiter: FlashLimiter;
  private readonly stats = createFrameStats();
  private readonly sample: FlashProbeSampler;
  private readonly offDecision: FlashDecision = { mode: 'off', blend: 1, limited: false, flashRate: 0, redFlashRate: 0 };
  private readonly heldDecision: FlashDecision = { mode: 'limit', blend: 0, limited: true, flashRate: 0, redFlashRate: 0 };
  /** False when the probe could not be read: retain the last presented frame. */
  available = true;

  constructor(mode: FlashMode = 'limit', sampler: FlashProbeSampler = canvasProbeSampler()) {
    this.limiter = new FlashLimiter(mode);
    this.sample = sampler;
  }

  get mode(): FlashMode { return this.limiter.mode; }

  /**
   * 'off' skips the probe entirely (it costs a small readback per frame), so
   * the history is not kept while off; turning it back on starts fresh and the
   * first frame is shown whole.
   */
  setMode(mode: FlashMode): void {
    if (mode === this.limiter.mode) return;
    if (this.limiter.mode === 'off') this.limiter.reset();
    this.limiter.setMode(mode);
  }

  /** Forget the displayed state: a cleared canvas, a new preset window, a seek. */
  reset(): void { this.limiter.reset(); }

  /**
   * Run `draw` (which draws `source` into `context`) with `globalAlpha` set to
   * the limiter's blend for time `tSec` (seconds, monotonic — the rAF clock,
   * never the audio clock, which pauses and rewinds while frames keep
   * flashing). Always restores `globalAlpha` to 1. The result is reused.
   */
  present(context: FlashGateContext, source: CanvasImageSource, tSec: number, draw: () => void): FlashDecision {
    if (this.limiter.mode === 'off') {
      draw();
      return this.offDecision;
    }
    let pixels: Uint8ClampedArray | null;
    try { pixels = this.sample(source); } catch { pixels = null; }
    if (!pixels || pixels.length < PROBE_W * PROBE_H * 4) {
      // Hold the retained canvas. Keep history because no new frame was shown.
      this.available = false;
      context.globalAlpha = 1;
      this.heldDecision.mode = this.limiter.mode;
      return this.heldDecision;
    }
    this.available = true;
    const d = this.limiter.evaluate(computeFrameStatsRgba(pixels, PROBE_W, PROBE_H, this.stats), tSec);
    const w = context.canvas.width;
    const h = context.canvas.height;
    context.globalAlpha = d.blend;
    try {
      draw();
    } finally {
      context.globalAlpha = 1;
    }
    // A presenter that resized its canvas cleared it (and reset globalAlpha to
    // 1), so the frame went up whole over black; the prediction is void.
    if (context.canvas.width !== w || context.canvas.height !== h) this.limiter.reset();
    return d;
  }
}

/** Default sampler: one reused OffscreenCanvas; null where OffscreenCanvas 2D is unavailable. */
export function canvasProbeSampler(): FlashProbeSampler {
  let context: OffscreenCanvasRenderingContext2D | null = null;
  let failed = false;
  return (source) => {
    if (failed) return null;
    if (!context) {
      if (typeof OffscreenCanvas === 'undefined') { failed = true; return null; }
      context = new OffscreenCanvas(PROBE_W, PROBE_H).getContext('2d', { alpha: false });
      if (!context) { failed = true; return null; }
      context.imageSmoothingEnabled = true;
    }
    try {
      context.drawImage(source, 0, 0, PROBE_W, PROBE_H);
      return context.getImageData(0, 0, PROBE_W, PROBE_H).data;
    } catch {
      // A detached bitmap or a tainted source: skip this frame, keep trying.
      return null;
    }
  };
}
