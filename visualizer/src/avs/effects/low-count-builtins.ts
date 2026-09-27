import { AvsEffectRegistry, type AvsEffectContext } from '../executor.ts';
import { blendPixel } from '../framebuffer.ts';
import { blendLine, blendLineRun } from './core.ts';

interface ColorState { colorPosition: number }
interface GridState extends ColorState { x: number; y: number }
interface GrainState { width: number; height: number; depth: Uint8Array; random: number }

/** Preserved-source ports of low-count Winamp AVS built-ins. */
export function registerAvsLowCountBuiltins(registry = new AvsEffectRegistry()): AvsEffectRegistry {
  const simpleStates = new Map<string, ColorState>();
  const ringStates = new Map<string, ColorState>();
  const gridStates = new Map<string, GridState>();
  const grainStates = new Map<string, GrainState>();

  // Render / Simple (ID 0, r_simple.cpp).
  registry.registerBuiltin(0, (context) => {
    if (context.preinit) return;
    const colors = colorList(context, 4);
    if (colors.length === 0) return;
    const state = simpleStates.get(context.component.path) ?? { colorPosition: 0 };
    simpleStates.set(context.component.path, state);
    const color = cycleColor(colors, state);
    renderSimple(context, int(context, 0, 40), color);
  });

  // Render / Ring (ID 14, r_oscring.cpp).
  registry.registerBuiltin(14, (context) => {
    if (context.preinit) return;
    const count = int(context, 4, 1);
    const colors = readColors(context, 8, count);
    if (colors.length === 0) return;
    const state = ringStates.get(context.component.path) ?? { colorPosition: 0 };
    ringStates.set(context.component.path, state);
    const tail = 8 + colors.length * 4;
    renderRing(context, int(context, 0, 40), cycleColor(colors, state), int(context, tail, 8), int(context, tail + 4, 0));
  });

  // Render / Dot Grid (ID 17, r_dotgrid.cpp).
  registry.registerBuiltin(17, (context) => {
    if (context.preinit) return;
    const colors = colorList(context, 0);
    if (colors.length === 0) return;
    let state = gridStates.get(context.component.path);
    if (!state) { state = { colorPosition: 0, x: 0, y: 0 }; gridStates.set(context.component.path, state); }
    const tail = 4 + colors.length * 4;
    const spacing = Math.max(2, int(context, tail, 8));
    while (state.x < 0) state.x += spacing * 256;
    while (state.y < 0) state.y += spacing * 256;
    const sx = (state.x >>> 8) % spacing;
    const sy = (state.y >>> 8) % spacing;
    const color = cycleColor(colors, state);
    const blend = int(context, tail + 12, 3);
    if (blend === 3) {
      // Global line blend: one strided run per grid row through the shared span helper.
      const width = context.input.width;
      for (let y = sy; y < context.input.height; y += spacing) {
        const row = y * width;
        blendLineRun(context.input.pixels, row + sx, row + width, spacing, color, context.line.blendMode, context.line.adjustableAlpha);
      }
    } else for (let y = sy; y < context.input.height; y += spacing) for (let x = sx; x < context.input.width; x += spacing) {
      const index = x + y * context.input.width;
      const destination = context.input.pixels[index]!;
      context.input.pixels[index] = blend === 1 ? blendPixel(color, destination, 'additive')
        : blend === 2 ? blendPixel(color, destination, 'average')
        : color;
    }
    state.x += int(context, tail + 4, 128);
    state.y += int(context, tail + 8, 128);
  });

  // Trans / Grain (ID 24, r_grain.cpp).
  registry.registerBuiltin(24, (context) => {
    if (context.preinit || int(context, 0, 1) === 0) return;
    let state = grainStates.get(context.component.path);
    if (!state || state.width !== context.input.width || state.height !== context.input.height) {
      const random = hashPath(context.component.path);
      state = { width: context.input.width, height: context.input.height, depth: new Uint8Array(context.input.pixels.length * 2), random };
      for (let i = 0; i < state.depth.length; i += 2) {
        state.random = xorshift32(state.random); state.depth[i] = state.random % 255;
        state.random = xorshift32(state.random); state.depth[i + 1] = state.random % 100;
      }
      grainStates.set(context.component.path, state);
    }
    const staticGrain = int(context, 16, 0) !== 0;
    const threshold = Math.trunc(int(context, 12, 100) * 255 / 100);
    for (let i = 0; i < context.input.pixels.length; i++) {
      const pixel = context.input.pixels[i]!;
      if (pixel === 0) continue;
      let gate: number;
      let scale: number;
      if (staticGrain) { scale = state.depth[i * 2]!; gate = state.depth[i * 2 + 1]!; }
      else {
        state.random = xorshift32(state.random); gate = state.random & 255;
        state.random = xorshift32(state.random); scale = state.random & 255;
      }
      const grain = gate < threshold ? scalePixel(pixel, scale) : 0;
      context.input.pixels[i] = int(context, 4, 0) !== 0 ? blendPixel(grain, pixel, 'additive')
        : int(context, 8, 0) !== 0 ? blendPixel(grain, pixel, 'average') : grain;
    }
  });
  return registry;
}

function renderSimple(context: AvsEffectContext, effect: number, color: number): void {
  const width = context.input.width;
  const height = context.input.height;
  const yScale = height / 512;
  const channel = (effect >>> 2) & 3;
  const vertical = (effect >>> 4) & 3;
  const source = (effect & 3) > 1 ? context.audio.waveform : context.audio.spectrum;
  const data = selectChannel(source, channel);
  const point = (x: number, y: number): void => plot(context, x, y, color);
  if ((effect & 64) !== 0) {
    if ((effect & 2) !== 0) {
      const center = vertical === 2 ? height / 4 : vertical * height / 2;
      for (let x = 0; x < width; x++) point(x, Math.trunc(center + interpolateSigned(data, x * 288 / width) * yScale));
    } else {
      const { center, scale, adjust } = analyzerVertical(vertical, height, yScale);
      for (let x = 0; x < width; x++) point(x, Math.trunc(center + adjust + interpolate(data, x * 200 / width) * scale - 1));
    }
    return;
  }
  switch (effect & 3) {
    case 0: {
      const { center, scale, adjust } = analyzerVertical(vertical, height, yScale);
      for (let x = 0; x < width; x++) drawLine(context, x, center - adjust, x, Math.trunc(center + adjust + interpolate(data, x * 200 / width) * scale - 1), color);
      break;
    }
    case 1: {
      const { center, scale } = analyzerVertical(vertical, height, yScale);
      let lx = 0, ly = Math.trunc(center + data[0]! * scale);
      for (let x = 1; x < 200; x++) { const ox = Math.trunc(x * width / 200); const oy = Math.trunc(center + data[x]! * scale); drawLine(context, lx, ly, ox, oy, color); lx = ox; ly = oy; }
      break;
    }
    case 2: {
      const center = vertical === 2 ? height / 4 : vertical * height / 2;
      let lx = 0, ly = Math.trunc(center + (data[0]! ^ 128) * yScale);
      for (let x = 1; x < 288; x++) { const ox = Math.trunc(x * width / 288); const oy = Math.trunc(center + (data[x]! ^ 128) * yScale); drawLine(context, lx, ly, ox, oy, color); lx = ox; ly = oy; }
      break;
    }
    case 3: {
      const center = vertical === 2 ? height / 4 : vertical * height / 2;
      const start = Math.trunc(center + yScale * 128) - 1;
      for (let x = 0; x < width; x++) drawLine(context, x, start, x, Math.trunc(center + interpolateSigned(data, x * 288 / width) * yScale), color);
      break;
    }
  }
}

function renderRing(context: AvsEffectContext, effect: number, color: number, size: number, spectrumMode: number): void {
  const channel = (effect >>> 2) & 3;
  const horizontal = effect >>> 4;
  const source = spectrumMode ? context.audio.spectrum : context.audio.waveform;
  const data = selectChannel(source, channel);
  const radius = Math.min(context.input.height * size / 32, context.input.width * size / 32);
  const cx = horizontal === 2 ? context.input.width / 2 : horizontal === 0 ? context.input.width / 4 : context.input.width * 3 / 4;
  const cy = context.input.height / 2;
  const amplitude = (q: number): number => spectrumMode
    ? 0.1 + ((data[q * 2]! / 2 + data[q * 2 + 1]! / 2) / 255) * 0.9
    : 0.1 + ((data[q]! ^ 128) / 255) * 0.9;
  let lastX = Math.trunc(cx + radius * amplitude(0));
  let lastY = Math.trunc(cy);
  for (let q = 1; q <= 80; q++) {
    const index = q > 40 ? 80 - q : q;
    const angle = -Math.PI * 2 * q / 80;
    const scale = amplitude(index);
    const x = Math.trunc(cx + Math.cos(angle) * radius * scale);
    const y = Math.trunc(cy + Math.sin(angle) * radius * scale);
    drawLine(context, x, y, lastX, lastY, color); lastX = x; lastY = y;
  }
}

function colorList(context: AvsEffectContext, offset: number): number[] {
  return readColors(context, offset + 4, int(context, offset, 1));
}
function readColors(context: AvsEffectContext, offset: number, count: number): number[] {
  if (count < 1 || count > 16) return [];
  const result: number[] = [];
  for (let i = 0; i < count && offset + i * 4 + 4 <= context.component.payload.length; i++) result.push(int(context, offset + i * 4, 0) & 0xffffff);
  return result;
}
function cycleColor(colors: readonly number[], state: ColorState): number {
  state.colorPosition = (state.colorPosition + 1) % (colors.length * 64);
  const index = Math.trunc(state.colorPosition / 64);
  const fraction = state.colorPosition & 63;
  return channels2(colors[index]!, colors[(index + 1) % colors.length]!, (a, b) => Math.trunc((a * (63 - fraction) + b * fraction) / 64));
}
function selectChannel(source: readonly [Uint8Array, Uint8Array], channel: number): Uint8Array {
  if (channel < 2) return source[channel as 0 | 1];
  const center = new Uint8Array(576);
  for (let i = 0; i < 576; i++) center[i] = (Math.trunc(signed(source[0][i]!) / 2) + Math.trunc(signed(source[1][i]!) / 2)) & 255;
  return center;
}
function analyzerVertical(position: number, height: number, yScale: number): { center: number; scale: number; adjust: number } {
  let center = height / 2, scale = yScale, adjust = 1;
  if (position !== 1) { scale = -scale; adjust = 0; }
  if (position === 2) center -= scale * 128;
  return { center: Math.trunc(center), scale, adjust };
}
function interpolate(data: Uint8Array, at: number): number { const i = Math.trunc(at), f = at - i; return data[i]! * (1 - f) + data[i + 1]! * f; }
function interpolateSigned(data: Uint8Array, at: number): number { const i = Math.trunc(at), f = at - i; return (data[i]! ^ 128) * (1 - f) + (data[i + 1]! ^ 128) * f; }
function signed(value: number): number { return (value << 24) >> 24; }
function plot(context: AvsEffectContext, x: number, y: number, color: number): void {
  x = Math.trunc(x); y = Math.trunc(y); if (x < 0 || y < 0 || x >= context.input.width || y >= context.input.height) return;
  const index = x + y * context.input.width; context.input.pixels[index] = blendLine(color, context.input.pixels[index]!, context.line.blendMode, context.line.adjustableAlpha);
}
function drawLine(context: AvsEffectContext, x0: number, y0: number, x1: number, y1: number, color: number): void {
  x0 = Math.trunc(x0); y0 = Math.trunc(y0); x1 = Math.trunc(x1); y1 = Math.trunc(y1);
  const dx = Math.abs(x1 - x0), sx = x0 < x1 ? 1 : -1, dy = -Math.abs(y1 - y0), sy = y0 < y1 ? 1 : -1; let error = dx + dy;
  while (x0 !== x1 || y0 !== y1) { plot(context, x0, y0, color); const twice = 2 * error; if (twice >= dy) { error += dy; x0 += sx; } if (twice <= dx) { error += dx; y0 += sy; } }
}
function scalePixel(pixel: number, scale: number): number { return channels2(pixel, 0, (value) => (value * scale) >>> 8); }
function channels2(a: number, b: number, fn: (a: number, b: number) => number): number { return fn(a & 255, b & 255) | (fn((a >>> 8) & 255, (b >>> 8) & 255) << 8) | (fn((a >>> 16) & 255, (b >>> 16) & 255) << 16); }
function int(context: AvsEffectContext, offset: number, fallback: number): number { return offset + 4 <= context.component.payload.length ? new DataView(context.component.payload.buffer, context.component.payload.byteOffset, context.component.payload.byteLength).getInt32(offset, true) : fallback; }
function hashPath(path: string): number { let hash = 0x811c9dc5; for (let i = 0; i < path.length; i++) hash = Math.imul(hash ^ path.charCodeAt(i), 0x01000193); return hash >>> 0; }
function xorshift32(value: number): number { let state = value || 0x6d2b79f5; state ^= state << 13; state ^= state >>> 17; state ^= state << 5; return state >>> 0; }
