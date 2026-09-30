// Pixel scaling policy (Task 5, item 2). The sprite layer draws at the game's native resolution (the pack's screen size, e.g. 256x224 or
// 384x216) into a small target and presents it on the output with
//  - 'integer' (default): the largest whole-number scale that fits, centred, nearest-neighbour; what is left over is a themed border.
//    Every native pixel becomes a k x k block, so it is crisp at 1080p, 4K and any output scale;
//  - 'sharp': a fractional scale that fills the screen, sampled with the sharp-bilinear shader (nearest inside a texel, a one-output-pixel
//    bilinear seam between texels). Used only when the owner prefers filling the frame over exact pixels.
// Output sizes here are physical pixels (1920x1080 times the engine's output scale).
export type ScaleMode = 'integer' | 'sharp';

export interface ScaleLayout {
  readonly mode: ScaleMode;
  readonly nativeW: number;
  readonly nativeH: number;
  readonly outW: number;
  readonly outH: number;
  /** Output px per native px: a whole number in 'integer' mode. */
  readonly scale: number;
  /** The game rectangle on the output, top-left origin, whole pixels. */
  readonly x: number;
  readonly y: number;
  readonly w: number;
  readonly h: number;
  /** True when every native pixel is an exact k x k block (crisp). */
  readonly exact: boolean;
  /** The integer policy could not fit the native size (the output is smaller than it); the layout fell back to 'sharp'. */
  readonly fellBack: boolean;
}

export function scaleLayout(nativeW: number, nativeH: number, outW: number, outH: number, mode: ScaleMode = 'integer'): ScaleLayout {
  if (![nativeW, nativeH, outW, outH].every((v) => Number.isInteger(v) && v >= 1)) throw new Error('scaleLayout: sizes must be whole positive pixels');
  const fit = Math.min(outW / nativeW, outH / nativeH);
  const k = Math.floor(fit + 1e-9);
  if (mode === 'integer' && k >= 1) {
    const w = nativeW * k, h = nativeH * k;
    return { mode, nativeW, nativeH, outW, outH, scale: k, x: Math.floor((outW - w) / 2), y: Math.floor((outH - h) / 2), w, h, exact: true, fellBack: false };
  }
  const w = Math.min(outW, Math.round(nativeW * fit)), h = Math.min(outH, Math.round(nativeH * fit));
  return { mode: 'sharp', nativeW, nativeH, outW, outH, scale: fit, x: Math.floor((outW - w) / 2), y: Math.floor((outH - h) / 2), w, h, exact: Number.isInteger(fit) && w === nativeW * fit && h === nativeH * fit, fellBack: mode === 'integer' };
}

/** Border thickness on each side of the game rectangle, output px. */
export function borderOf(l: ScaleLayout) {
  return { left: l.x, right: l.outW - l.x - l.w, top: l.y, bottom: l.outH - l.y - l.h };
}

/** Native sizes whose integer fit is exact at 1920x1080 (no border): 1080 / n and 1920 / n both whole. */
export const EXACT_NATIVE_SIZES: readonly (readonly [number, number])[] = [[320, 180], [384, 216], [480, 270], [640, 360], [240, 135], [192, 108], [160, 90]];
