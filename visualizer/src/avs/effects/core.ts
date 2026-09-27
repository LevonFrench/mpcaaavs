import { AvsEffectRegistry, type AvsEffectContext } from '../executor.ts';
import { AvsFramebuffer, type AvsListBlendMode } from '../framebuffer.ts';

/** Register exact, source-grounded AVS byte-domain utility effects. */
export function registerAvsCoreEffects(registry = new AvsEffectRegistry()): AvsEffectRegistry {
  const stackDirection = new Map<string, number>();
  const clearFrames = new Map<string, number>();

  // Misc / Buffer Save (Stack)
  registry.registerBuiltin(18, (ctx) => {
    if (ctx.preinit) return;
    const direction = int(ctx, 0, 0);
    const index = clamp(int(ctx, 4, 0), 0, 7);
    const blend = int(ctx, 8, 0);
    const amount = int(ctx, 12, 128);
    const buffer = ctx.buffers.get(index, ctx.input.width, ctx.input.height, direction !== 1);
    if (!buffer) return;
    let actual = direction;
    if (direction >= 2) {
      const phase = stackDirection.get(ctx.component.path) ?? 0;
      actual = (direction & 1) ^ phase;
      stackDirection.set(ctx.component.path, phase ^ 1);
    }
    const source = actual === 0 ? ctx.input : buffer;
    const destination = actual === 0 ? buffer : ctx.input;
    blendStack(destination, source, blend, amount);
  });

  // Misc / Comment
  registry.registerBuiltin(21, () => undefined);

  // Render / Clear Screen
  registry.registerBuiltin(25, (ctx) => {
    if (ctx.preinit || int(ctx, 0, 1) === 0) return;
    const seen = clearFrames.get(ctx.component.path) ?? 0;
    if (int(ctx, 16, 0) !== 0 && seen > 0) return;
    clearFrames.set(ctx.component.path, seen + 1);
    const color = int(ctx, 4, 0) & 0x00ffffff;
    const blend = int(ctx, 8, 0);
    const average = int(ctx, 12, 0) !== 0;
    if (blend === 2) {
      const pixels = ctx.input.pixels;
      blendLineRun(pixels, 0, pixels.length, 1, color, ctx.line.blendMode, ctx.line.adjustableAlpha);
    } else if (blend !== 0) {
      // Additive clear = line mode 1.
      const pixels = ctx.input.pixels;
      blendLineRun(pixels, 0, pixels.length, 1, color, 1, 0);
    } else if (average) {
      for (let i = 0; i < ctx.input.pixels.length; i++) {
        ctx.input.pixels[i] = averagePixel(color, ctx.input.pixels[i]!);
      }
    } else ctx.input.clear(color);
  });

  // Trans / Invert
  registry.registerBuiltin(37, (ctx) => {
    if (ctx.preinit || int(ctx, 0, 1) === 0) return;
    for (let i = 0; i < ctx.input.pixels.length; i++) {
      ctx.input.pixels[i] = ctx.input.pixels[i]! ^ 0x00ffffff;
    }
  });

  // Misc / Set Render Mode
  registry.registerBuiltin(40, (ctx) => {
    if (ctx.preinit) return;
    const mode = uint(ctx, 0, 0x80010000);
    if ((mode & 0x80000000) === 0) return;
    ctx.line.blendMode = mode & 0xff;
    ctx.line.adjustableAlpha = (mode >>> 8) & 0xff;
    ctx.line.lineWidth = (mode >>> 16) & 0xff;
  });

  // Trans / Fast Brightness: direction 0 doubles, 1 halves, 2 bypasses.
  registry.registerBuiltin(44, (ctx) => {
    if (ctx.preinit) return;
    const direction = int(ctx, 0, 0);
    if (direction === 0) {
      // Per channel min(255, 2v); the alpha byte is dropped as rgb() did.
      const pixels = ctx.input.pixels;
      for (let i = 0; i < pixels.length; i++) {
        const p = pixels[i]!;
        pixels[i] = DOUBLE_LUT[p & 255]! | (DOUBLE_LUT[(p >>> 8) & 255]! << 8) | (DOUBLE_LUT[(p >>> 16) & 255]! << 16);
      }
    } else if (direction === 1) {
      for (let i = 0; i < ctx.input.pixels.length; i++) {
        ctx.input.pixels[i] = (ctx.input.pixels[i]! >>> 1) & 0x007f7f7f;
      }
    }
  });

  return registry;
}

function blendStack(destination: AvsFramebuffer, source: AvsFramebuffer, code: number, amount: number): void {
  const modes: Readonly<Record<number, AvsListBlendMode>> = {
    0: 'replace', 1: 'average', 2: 'additive', 3: 'every-other-pixel',
    4: 'destination-minus-source', 5: 'every-other-line', 6: 'xor',
    7: 'maximum', 8: 'minimum', 9: 'source-minus-destination',
    10: 'multiply', 11: 'adjustable',
  };
  destination.blendFrom(source, modes[code] ?? 'replace', amount);
}

/** AVS global line-render modes used by point/line effects and default clears. */
export function blendLine(source: number, destination: number, mode: number, amount: number): number {
  // Closure-free per-channel forms of the original channel2() callbacks;
  // each channel keeps the same expression and the same `& 255`.
  const s0 = source & 255, s1 = (source >>> 8) & 255, s2 = (source >>> 16) & 255;
  const d0 = destination & 255, d1 = (destination >>> 8) & 255, d2 = (destination >>> 16) & 255;
  switch (mode) {
    case 1: return (s0 + d0 > 255 ? 255 : s0 + d0) | ((s1 + d1 > 255 ? 255 : s1 + d1) << 8) | ((s2 + d2 > 255 ? 255 : s2 + d2) << 16);
    case 2: return (s0 > d0 ? s0 : d0) | ((s1 > d1 ? s1 : d1) << 8) | ((s2 > d2 ? s2 : d2) << 16);
    case 3: return averagePixel(source, destination);
    case 4: return (d0 > s0 ? d0 - s0 : 0) | ((d1 > s1 ? d1 - s1 : 0) << 8) | ((d2 > s2 ? d2 - s2 : 0) << 16);
    case 5: return (s0 > d0 ? s0 - d0 : 0) | ((s1 > d1 ? s1 - d1 : 0) << 8) | ((s2 > d2 ? s2 - d2 : 0) << 16);
    case 6: return (table(s0, d0) & 255) | ((table(s1, d1) & 255) << 8) | ((table(s2, d2) & 255) << 16);
    case 7: {
      const inverse = 255 - amount;
      return ((table(s0, amount) + table(d0, inverse)) & 255)
        | (((table(s1, amount) + table(d1, inverse)) & 255) << 8)
        | (((table(s2, amount) + table(d2, inverse)) & 255) << 16);
    }
    case 8: return (source ^ destination) & 0x00ffffff;
    case 9: return (s0 < d0 ? s0 : d0) | ((s1 < d1 ? s1 : d1) << 8) | ((s2 < d2 ? s2 : d2) << 16);
    default: return source & 0x00ffffff;
  }
}

/**
 * pixels[i] = blendLine(color, pixels[i], mode, amount) for i = start, start + step, ...
 * while i < end (step > 0). The mode switch runs once per run instead of once per
 * pixel; visit order and per-pixel results match blendLine() exactly. Callers clip
 * the run to the framebuffer first.
 */
export function blendLineRun(
  pixels: Uint32Array, start: number, end: number, step: number,
  color: number, mode: number, amount: number,
): void {
  const s0 = color & 255, s1 = (color >>> 8) & 255, s2 = (color >>> 16) & 255;
  switch (mode) {
    case 1:
      for (let i = start; i < end; i += step) {
        const d = pixels[i]!;
        let r = s0 + (d & 255), g = s1 + ((d >>> 8) & 255), b = s2 + ((d >>> 16) & 255);
        if (r > 255) r = 255;
        if (g > 255) g = 255;
        if (b > 255) b = 255;
        pixels[i] = r | (g << 8) | (b << 16);
      }
      return;
    case 2:
      for (let i = start; i < end; i += step) {
        const d = pixels[i]!;
        const d0 = d & 255, d1 = (d >>> 8) & 255, d2 = (d >>> 16) & 255;
        pixels[i] = (s0 > d0 ? s0 : d0) | ((s1 > d1 ? s1 : d1) << 8) | ((s2 > d2 ? s2 : d2) << 16);
      }
      return;
    case 3: {
      const half = (color >>> 1) & 0x007f7f7f;
      for (let i = start; i < end; i += step) pixels[i] = half + ((pixels[i]! >>> 1) & 0x007f7f7f);
      return;
    }
    case 4:
      for (let i = start; i < end; i += step) {
        const d = pixels[i]!;
        const d0 = d & 255, d1 = (d >>> 8) & 255, d2 = (d >>> 16) & 255;
        pixels[i] = (d0 > s0 ? d0 - s0 : 0) | ((d1 > s1 ? d1 - s1 : 0) << 8) | ((d2 > s2 ? d2 - s2 : 0) << 16);
      }
      return;
    case 5:
      for (let i = start; i < end; i += step) {
        const d = pixels[i]!;
        const d0 = d & 255, d1 = (d >>> 8) & 255, d2 = (d >>> 16) & 255;
        pixels[i] = (s0 > d0 ? s0 - d0 : 0) | ((s1 > d1 ? s1 - d1 : 0) << 8) | ((s2 > d2 ? s2 - d2 : 0) << 16);
      }
      return;
    case 6: {
      // table(s, d) = trunc((s / 255) * d); s / 255 is the same double for every pixel.
      const q0 = s0 / 255, q1 = s1 / 255, q2 = s2 / 255;
      for (let i = start; i < end; i += step) {
        const d = pixels[i]!;
        pixels[i] = (Math.trunc(q0 * (d & 255)) & 255)
          | ((Math.trunc(q1 * ((d >>> 8) & 255)) & 255) << 8)
          | ((Math.trunc(q2 * ((d >>> 16) & 255)) & 255) << 16);
      }
      return;
    }
    case 7: {
      const inverse = 255 - amount;
      const t0 = table(s0, amount), t1 = table(s1, amount), t2 = table(s2, amount);
      for (let i = start; i < end; i += step) {
        const d = pixels[i]!;
        pixels[i] = ((t0 + table(d & 255, inverse)) & 255)
          | (((t1 + table((d >>> 8) & 255, inverse)) & 255) << 8)
          | (((t2 + table((d >>> 16) & 255, inverse)) & 255) << 16);
      }
      return;
    }
    case 8: {
      const c = color & 0x00ffffff;
      for (let i = start; i < end; i += step) pixels[i] = (c ^ pixels[i]!) & 0x00ffffff;
      return;
    }
    case 9:
      for (let i = start; i < end; i += step) {
        const d = pixels[i]!;
        const d0 = d & 255, d1 = (d >>> 8) & 255, d2 = (d >>> 16) & 255;
        pixels[i] = (s0 < d0 ? s0 : d0) | ((s1 < d1 ? s1 : d1) << 8) | ((s2 < d2 ? s2 : d2) << 16);
      }
      return;
    default: {
      const c = color & 0x00ffffff;
      for (let i = start; i < end; i += step) pixels[i] = c;
    }
  }
}

function int(ctx: AvsEffectContext, offset: number, fallback: number): number {
  if (offset + 4 > ctx.component.payload.length) return fallback;
  return new DataView(
    ctx.component.payload.buffer,
    ctx.component.payload.byteOffset,
    ctx.component.payload.byteLength,
  ).getInt32(offset, true);
}

function uint(ctx: AvsEffectContext, offset: number, fallback: number): number {
  if (offset + 4 > ctx.component.payload.length) return fallback >>> 0;
  return new DataView(
    ctx.component.payload.buffer,
    ctx.component.payload.byteOffset,
    ctx.component.payload.byteLength,
  ).getUint32(offset, true);
}

function averagePixel(a: number, b: number): number {
  return ((a >>> 1) & 0x007f7f7f) + ((b >>> 1) & 0x007f7f7f);
}
function table(a: number, b: number): number { return Math.trunc((a / 255) * b); }
/** Fast Brightness doubling, min(255, v + v) per channel byte. */
const DOUBLE_LUT = (() => {
  const lut = new Uint32Array(256);
  for (let v = 0; v < 256; v++) lut[v] = Math.min(255, v + v);
  return lut;
})();
function clamp(value: number, lo: number, hi: number): number {
  return value < lo ? lo : value > hi ? hi : value;
}
