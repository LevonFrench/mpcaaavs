/** Conservative GPU-only decoders for AVS affine blitters. */

export interface AvsRotoBlitterConfig {
  readonly zoom: number;
  readonly direction: number;
  readonly blend: boolean;
  readonly beatReverse: boolean;
  readonly beatSpeed: number;
  readonly beatZoom: number;
  readonly beatScale: boolean;
  readonly subpixel: boolean;
}

export interface AvsStaticRotoBlitterGpuParams {
  readonly width: number;
  readonly height: number;
  readonly pixels: number;
  readonly ds: number;
  readonly dt: number;
  readonly dsDx: number;
  readonly dsDy: number;
  readonly dtDx: number;
  readonly dtDy: number;
  readonly sStart: number;
  readonly tStart: number;
  readonly subpixel: boolean;
  readonly blend: boolean;
}

export interface AvsBlitterFeedbackConfig {
  readonly scale: number;
  readonly beatScale: number;
  readonly blend: boolean;
  readonly changeOnBeat: boolean;
  readonly subpixel: boolean;
}

export interface AvsStaticBlitterFeedbackGpuParams {
  readonly width: number; readonly height: number; readonly pixels: number;
  readonly mode: 1 | 2; readonly step: number;
  readonly startX: number; readonly startY: number;
  readonly regionWidth: number; readonly regionHeight: number;
  readonly blend: boolean; readonly subpixel: boolean;
}

export function decodeAvsRotoBlitter(payload: Uint8Array): AvsRotoBlitterConfig {
  return {
    zoom: int(payload, 0, 31),
    direction: int(payload, 4, 31),
    blend: int(payload, 8, 0) !== 0,
    beatReverse: int(payload, 12, 0) !== 0,
    beatSpeed: int(payload, 16, 0),
    beatZoom: int(payload, 20, 31),
    beatScale: int(payload, 24, 0) !== 0,
    subpixel: int(payload, 28, 0) !== 0,
  };
}

export function decodeAvsBlitterFeedback(payload: Uint8Array): AvsBlitterFeedbackConfig {
  return {
    scale: int(payload, 0, 30), beatScale: int(payload, 4, 30),
    blend: int(payload, 8, 0) !== 0, changeOnBeat: int(payload, 12, 0) !== 0,
    subpixel: int(payload, 16, 0) !== 0,
  };
}

export function buildStaticAvsBlitterFeedbackGpuParams(
  config: AvsBlitterFeedbackConfig, width: number, height: number,
): AvsStaticBlitterFeedbackGpuParams | null {
  if (config.changeOnBeat || !Number.isInteger(width) || !Number.isInteger(height) || width < 1 || height < 1) return null;
  const pixels = width * height;
  if (!Number.isSafeInteger(pixels) || pixels > 0x7fffffff) return null;
  const value = Math.max(0, config.scale);
  if (value === 32) return null;
  if (value < 32) {
    const step = Math.trunc(((value + 32) * 65_536) / 64);
    const startX = Math.trunc((width * 65_536 - step * width) / 2);
    const startY = Math.trunc((height * 65_536 - step * height) / 2);
    if (Math.max(startX + width * step * 2, startY + height * step) > 0x7fffffff) return null;
    return {
      width, height, pixels, mode: 1, step, startX, startY,
      regionWidth: width, regionHeight: height, blend: config.blend, subpixel: config.subpixel,
    };
  }
  if (value > 4_095) return null;
  const step = (value + 96) << 9;
  if (step <= 0) return null;
  const regionWidth = Math.trunc((width * 65_536) / step) & ~3;
  const regionHeight = Math.trunc((height * 65_536) / step);
  if (regionWidth >= width || regionHeight >= height || regionWidth <= 0 || regionHeight <= 0) return null;
  const startX = Math.trunc((width - regionWidth) / 2);
  const startY = Math.trunc((height - regionHeight) / 2);
  if (Math.max(regionWidth * step * 2, regionHeight * step) > 0x7fffffff) return null;
  return {
    width, height, pixels, mode: 2, step, startX, startY, regionWidth, regionHeight,
    blend: config.blend, subpixel: false,
  };
}

/**
 * Build the exact fixed-point transform used by the deterministic subset of
 * native Roto Blitter. Beat reversal/zoom are stateful and therefore remain
 * on the CPU graph.
 */
export function buildStaticAvsRotoBlitterGpuParams(
  config: AvsRotoBlitterConfig,
  width: number,
  height: number,
): AvsStaticRotoBlitterGpuParams | null {
  if (config.beatReverse || config.beatScale || width < 2 || height < 2) return null;
  if (!Number.isInteger(width) || !Number.isInteger(height) || width > 16_384 || height > 16_384) return null;
  const pixels = width * height;
  if (!Number.isSafeInteger(pixels) || pixels > 0x7fffffff) return null;
  const ds = (width - 1) << 16;
  const dt = (height - 1) << 16;
  if (ds <= 0 || dt <= 0) return null;
  const zoom = 1 + (config.zoom - 31) / 31;
  const radians = (config.direction - 32) * Math.PI / 180;
  const cosine = Math.cos(radians) * zoom;
  const sine = Math.sin(radians) * zoom;
  const dsDx = Math.trunc(cosine * 65_536);
  const dtDy = Math.trunc(cosine * 65_536);
  const dsDy = -Math.trunc(sine * 65_536);
  const dtDx = Math.trunc(sine * 65_536);
  if (dsDx <= -ds || dsDx >= ds || dtDx <= -dt || dtDx >= dt) return null;
  if (![dsDx, dtDy, dsDy, dtDx].every(Number.isSafeInteger)) return null;
  // The shader evaluates each invocation independently. Keep its signed i32
  // affine products in range so WGSL overflow cannot alter native modulo math.
  const safe = 0x7fffffff;
  if (Math.abs(dsDx) * (width - 1) + Math.abs(dsDy) * (height - 1) + ds > safe) return null;
  if (Math.abs(dtDx) * (width - 1) + Math.abs(dtDy) * (height - 1) + dt > safe) return null;
  const halfWidth = Math.trunc((width - 1) / 2);
  const halfHeight = Math.trunc((height - 1) / 2);
  const sStart = modulo(
    -halfWidth * dsDx - halfHeight * dsDy + (width - 1) * (32_768 + (1 << 20)), ds,
  );
  const tStart = modulo(
    -halfWidth * dtDx - halfHeight * dtDy + (height - 1) * (32_768 + (1 << 20)), dt,
  );
  return {
    width, height, pixels, ds, dt, dsDx, dsDy, dtDx, dtDy, sStart, tStart,
    subpixel: config.subpixel, blend: config.blend,
  };
}

function modulo(value: number, divisor: number): number {
  const result = value % divisor;
  return result < 0 ? result + divisor : result;
}

function int(payload: Uint8Array, offset: number, fallback: number): number {
  if (offset + 4 > payload.byteLength) return fallback;
  return new DataView(payload.buffer, payload.byteOffset, payload.byteLength).getInt32(offset, true);
}
