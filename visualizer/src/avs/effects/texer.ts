import { avsAudioSample } from '../audio.ts';
import { compileAvsEel } from '../eel/compiler.ts';
import type { AvsEelProgram } from '../eel/types.ts';
import { AvsEelVm } from '../eel/vm.ts';
import { AvsEffectRegistry, type AvsEffectContext } from '../executor.ts';
import type { AvsBitmap, AvsBitmapResolver } from './bitmap-assets.ts';

export const AVS_TEXER_APE_ID = 'Texer';
export const AVS_TEXER_II_APE_ID = 'Acko.net: Texer II';

const TEXT = new TextDecoder('windows-1252');
const MAX_TEXER_II_PARTICLES = 65_536;

export interface AvsTexerConfig {
  readonly image: string;
  readonly addToInput: boolean;
  readonly colorize: boolean;
  readonly particles: number;
}

export interface AvsTexer2Config {
  readonly version: 0 | 1;
  readonly image: string;
  readonly resize: boolean;
  readonly wrap: boolean;
  readonly colorize: boolean;
  readonly init: string;
  readonly frame: string;
  readonly beat: string;
  readonly point: string;
}

export interface AvsTexerEffectOptions {
  readonly bitmapResolver?: AvsBitmapResolver;
  readonly defaultTexer2Bitmap?: AvsBitmap;
}

interface Texer2State {
  readonly vm: AvsEelVm;
  readonly programs: readonly [AvsEelProgram | null, AvsEelProgram | null, AvsEelProgram | null, AvsEelProgram | null];
  initialized: boolean;
}

/** Decode Texer's sparse 288-byte legacy struct. */
export function decodeAvsTexerConfig(payload: Uint8Array): AvsTexerConfig {
  const mode = readI32(payload, 276, 0);
  return {
    image: payload.length >= 276 ? nulText(payload.subarray(16, 276)) : '',
    addToInput: (mode & 0b11) === 2,
    colorize: (mode & 0b1100) === 8,
    particles: readI32(payload, 280, 100),
  };
}

/** Decode the original Texer II v1.0 payload used by AVS 2.81d presets. */
export function decodeAvsTexer2Config(payload: Uint8Array): AvsTexer2Config {
  const rawVersion = readI32(payload, 0, 0);
  let offset = 280;
  const scripts: string[] = [];
  for (let index = 0; index < 4; index++) {
    const decoded = readLengthString(payload, offset);
    scripts.push(decoded.value);
    offset = decoded.next;
  }
  return {
    version: rawVersion === 1 ? 1 : 0,
    image: payload.length >= 264 ? nulText(payload.subarray(4, 264)) : '',
    resize: readI32(payload, 264, 0) !== 0,
    wrap: readI32(payload, 268, 0) !== 0,
    colorize: readI32(payload, 272, 1) !== 0,
    init: scripts[0]!, frame: scripts[1]!, beat: scripts[2]!, point: scripts[3]!,
  };
}

/** Register original Texer and source-donated Texer II with injected bitmap lookup. */
export function registerAvsTexerEffects(
  registry = new AvsEffectRegistry(),
  options: AvsTexerEffectOptions = {},
): AvsEffectRegistry {
  registry.registerApe(AVS_TEXER_APE_ID, (context) => {
    const config = decodeAvsTexerConfig(context.component.payload);
    const bitmap = options.bitmapResolver?.(config.image);
    if (!bitmap) return;
    renderTexer(context, config, bitmap);
    return { swap: true };
  });

  const states = new Map<string, Texer2State>();
  registry.registerApe(AVS_TEXER_II_APE_ID, (context) => {
    const config = decodeAvsTexer2Config(context.component.payload);
    let state = states.get(context.component.path);
    if (!state) {
      const vm = new AvsEelVm({ global: registry.eelGlobal, seed: hashPath(context.component.path) });
      state = {
        vm,
        programs: [
          compileOrNull(config.init), compileOrNull(config.frame),
          compileOrNull(config.beat), compileOrNull(config.point),
        ],
        initialized: false,
      };
      states.set(context.component.path, state);
    }
    const bitmap = resolveTexer2Bitmap(config.image, options);
    renderTexer2(context, config, bitmap, state);
  });
  return registry;
}

function renderTexer(context: AvsEffectContext, config: AvsTexerConfig, bitmap: AvsBitmap): void {
  const source = context.input.pixels;
  const output = context.output.pixels;
  if (config.addToInput) output.set(source); else output.fill(0);
  let drawn = 0;
  for (let y = 0; y < context.input.height; y++) {
    for (let x = 0; x < context.input.width; x++) {
      const mask = source[y * context.input.width + x]! & 0x00ffffff;
      if (mask === 0) continue;
      drawTexerStamp(output, context.input.width, context.input.height, bitmap, x, y, config.colorize ? mask : null);
      drawn++;
      // Native increments before comparing, so zero/negative payload values
      // still render the first discovered particle.
      if (drawn >= config.particles) return;
    }
  }
}

function drawTexerStamp(
  output: Uint32Array, width: number, height: number, bitmap: AvsBitmap,
  centreX: number, centreY: number, mask: number | null,
): void {
  const startX = centreX - Math.trunc(bitmap.width / 2);
  const startY = centreY - Math.trunc(bitmap.height / 2);
  for (let imageY = 0; imageY < bitmap.height; imageY++) {
    const y = startY + imageY;
    if (y < 0 || y >= height) continue;
    for (let imageX = 0; imageX < bitmap.width; imageX++) {
      const x = startX + imageX;
      if (x < 0 || x >= width) continue;
      let source = bitmap.pixels[imageY * bitmap.width + imageX]!;
      if (mask !== null) source = filterPixel(source, mask);
      const index = y * width + x;
      output[index] = blendTexerPixel(source, output[index]!, 1, 0);
    }
  }
}

function renderTexer2(
  context: AvsEffectContext,
  config: AvsTexer2Config,
  bitmap: AvsBitmap,
  state: Texer2State,
): void {
  const { vm } = state;
  vm.setHost({
    getosc: (band, width, channel) => avsAudioSample(context.audio, 'osc', band, width, channel),
    getspec: (band, width, channel) => avsAudioSample(context.audio, 'spec', band, width, channel),
  });
  vm.set('i', 0); vm.set('x', 0); vm.set('y', 0); vm.set('v', 0);
  vm.set('w', context.input.width); vm.set('h', context.input.height);
  vm.set('b', context.beat || context.preinit ? 1 : 0);
  vm.set('iw', bitmap.width); vm.set('ih', bitmap.height);
  vm.set('sizex', 1); vm.set('sizey', 1);
  vm.set('red', 1); vm.set('green', 1); vm.set('blue', 1); vm.set('skip', 0);

  if (!state.initialized || context.preinit) {
    vm.set('n', 0);
    execute(state.programs[0], vm);
    state.initialized = true;
  }
  execute(state.programs[1], vm);
  if (context.beat && !context.preinit) execute(state.programs[2], vm);
  const count = clamp(roundEven(vm.get('n')), 0, MAX_TEXER_II_PARTICLES);
  if (count <= 0) return;

  let progress = 0;
  const step = 1 / (count - 1);
  for (let index = 0; index < count; index++) {
    vm.set('i', progress); progress += step;
    vm.set('skip', 0);
    const sample = Math.trunc(index * 575 / count);
    const left = signedByte(context.audio.waveform[0][sample]!);
    const right = signedByte(context.audio.waveform[1][sample]!);
    vm.set('v', (left + right) / 256);
    execute(state.programs[3], vm);
    if (vm.get('skip') !== 0) continue;

    const sizeX = Math.abs(vm.get('sizex'));
    const sizeY = Math.abs(vm.get('sizey'));
    if (sizeX <= 0.01 || sizeY <= 0.01) continue;
    const color = config.colorize
      ? byteColor(vm.get('blue')) | (byteColor(vm.get('green')) << 8) | (byteColor(vm.get('red')) << 16)
      : 0x00ffffff;
    const flipX = vm.get('sizex') < 0;
    const flipY = vm.get('sizey') < 0;
    let x = vm.get('x');
    let y = vm.get('y');
    if (config.wrap) {
      let overlapCoordinateX: number;
      let overlapCoordinateY: number;
      if (config.version === 0) {
        overlapCoordinateX = x; overlapCoordinateY = y;
        x -= x > 1 ? 2 : x < -1 ? -2 : 0;
        y -= y > 1 ? 2 : y < -1 ? -2 : 0;
      } else {
        x -= roundAway(x / 2) * 2;
        y -= roundAway(y / 2) * 2;
        overlapCoordinateX = x; overlapCoordinateY = y;
      }
      const overlapX = overlapsEdge(overlapCoordinateX, sizeX, bitmap.width, context.input.width);
      const overlapY = overlapsEdge(overlapCoordinateY, sizeY, bitmap.height, context.input.height);
      const shiftX = x > 0 ? 2 : -2;
      const shiftY = y > 0 ? 2 : -2;
      if (overlapX) drawTexer2Particle(context, config, bitmap, x - shiftX, y, sizeX, sizeY, color, flipX, flipY);
      if (overlapY) drawTexer2Particle(context, config, bitmap, x, y - shiftY, sizeX, sizeY, color, flipX, flipY);
      if (overlapX && overlapY) {
        drawTexer2Particle(context, config, bitmap, x - shiftX, y - shiftY, sizeX, sizeY, color, flipX, flipY);
      }
    }
    drawTexer2Particle(context, config, bitmap, x, y, sizeX, sizeY, color, flipX, flipY);
  }
}

function drawTexer2Particle(
  context: AvsEffectContext,
  config: AvsTexer2Config,
  bitmap: AvsBitmap,
  x: number,
  y: number,
  sizeX: number,
  sizeY: number,
  color: number,
  flipX: boolean,
  flipY: boolean,
): void {
  if (config.resize) drawScaledParticle(context, bitmap, x, y, sizeX, sizeY, color, flipX, flipY);
  else drawUnscaledParticle(context, bitmap, x, y, color, config.colorize, flipX, flipY);
}

function drawUnscaledParticle(
  context: AvsEffectContext,
  bitmap: AvsBitmap,
  x: number,
  y: number,
  color: number,
  colorize: boolean,
  flipX: boolean,
  flipY: boolean,
): void {
  const pixels = context.input.pixels;
  const width = context.input.width;
  const blendMode = context.line.blendMode;
  const adjustableAlpha = context.line.adjustableAlpha;
  const screenMaxX = context.input.width - 1;
  const screenMaxY = context.input.height - 1;
  const imageMaxX = bitmap.width - 1;
  const imageMaxY = bitmap.height - 1;
  let left = roundEven((x * 0.5 + 0.5) * screenMaxX) - Math.trunc(imageMaxX / 2);
  let top = roundEven((y * 0.5 + 0.5) * screenMaxY) - Math.trunc(imageMaxY / 2);
  let right = left + imageMaxX - 1;
  let bottom = top + imageMaxY - 1;
  if (right < 0 || left > screenMaxX || bottom < 0 || top > screenMaxY) return;
  let textureX = left < 0 && right !== left ? roundEven((-left / (right - left)) * imageMaxX) : 0;
  let textureY = top < 0 && bottom !== top ? roundEven((-top / (bottom - top)) * imageMaxY) : 0;
  left = Math.max(0, left); top = Math.max(0, top);
  right = Math.min(screenMaxX, right); bottom = Math.min(screenMaxY, bottom);
  if (right <= left || bottom <= top) return;
  for (let drawY = top; drawY <= bottom; drawY++, textureY++) {
    let tx = textureX;
    let destination = drawY * width + left;
    for (let drawX = left; drawX <= right; drawX++, tx++) {
      let source = sampleBitmap(bitmap, tx, textureY, flipX, flipY);
      if (colorize) source = filterPixel(source, color);
      pixels[destination] = blendMode === 0
        ? source & 0x00ffffff
        : blendTexerPixel(source, pixels[destination]!, blendMode, adjustableAlpha);
      destination++;
    }
  }
}

function drawScaledParticle(
  context: AvsEffectContext,
  bitmap: AvsBitmap,
  x: number,
  y: number,
  sizeX: number,
  sizeY: number,
  color: number,
  flipX: boolean,
  flipY: boolean,
): void {
  const pixels = context.input.pixels;
  const width = context.input.width;
  const blendMode = context.line.blendMode;
  const adjustableAlpha = context.line.adjustableAlpha;
  const screenMaxX = context.input.width - 1;
  const screenMaxY = context.input.height - 1;
  const imageMaxX = bitmap.width - 1;
  const imageMaxY = bitmap.height - 1;
  const centreX = (x * 0.5 + 0.5) * screenMaxX;
  const centreY = (y * 0.5 + 0.5) * screenMaxY;
  const leftF = -imageMaxX * 0.5 * sizeX + 0.5 + centreX;
  const topF = -imageMaxY * 0.5 * sizeY + 0.5 + centreY;
  const rightF = (imageMaxX - 1) * 0.5 * sizeX + 0.5 + centreX;
  const bottomF = (imageMaxY - 1) * 0.5 * sizeY + 0.5 + centreY;
  let left = roundEven(leftF); let top = roundEven(topF);
  let right = roundEven(rightF); let bottom = roundEven(bottomF);
  if (right < 0 || left > screenMaxX || bottom < 0 || top > screenMaxY) return;
  let x0 = (0.5 - fractional(leftF + 0.5)) / (rightF - leftF);
  let y0 = (0.5 - fractional(topF + 0.5)) / (bottomF - topF);
  if (leftF < 0) x0 = -leftF / (rightF - leftF);
  if (topF < 0) y0 = -topF / (bottomF - topF);
  left = Math.max(0, left); top = Math.max(0, top);
  right = Math.min(screenMaxX, right); bottom = Math.min(screenMaxY, bottom);
  if (right <= left || bottom <= top) return;

  const fx0 = x0 * imageMaxX;
  const fy0 = y0 * imageMaxY;
  let cx = (roundEven(fx0) << 16) + 65535 - Math.trunc((0.5 - (fx0 - roundEven(fx0))) * 65536);
  let cy = (roundEven(fy0) << 16) + 65535 - Math.trunc((0.5 - (fy0 - roundEven(fy0))) * 65536);
  const stepX = Math.trunc(((imageMaxX - 1) / (rightF - leftF + 1)) * 65536);
  const stepY = Math.trunc(((imageMaxY - 1) / (bottomF - topF + 1)) * 65536);
  if (cx < 0) { cx += stepX; left++; }
  if (cy < 0) { cy += stepY; top++; }
  if (right <= left || bottom <= top) return;

  for (let drawY = top, fy = cy; drawY <= bottom; drawY++, fy += stepY) {
    let destination = drawY * width + left;
    for (let drawX = left, fx = cx; drawX <= right; drawX++, fx += stepX) {
      const source = filterPixel(sampleBilinearFixed(bitmap, fx, fy, flipX, flipY), color);
      pixels[destination] = blendMode === 0
        ? source & 0x00ffffff
        : blendTexerPixel(source, pixels[destination]!, blendMode, adjustableAlpha);
      destination++;
    }
  }
}

function sampleBilinearFixed(bitmap: AvsBitmap, fx: number, fy: number, flipX: boolean, flipY: boolean): number {
  const x = clamp(fx >> 16, 0, Math.max(0, bitmap.width - 2));
  const y = clamp(fy >> 16, 0, Math.max(0, bitmap.height - 2));
  const dx = (fx >>> 8) & 255;
  const dy = (fy >>> 8) & 255;
  // Load the four texels once. The former channel loop called sampleBitmap
  // twelve times for this same quad (four samples for each RGB byte), making
  // clamp/flip/index arithmetic dominate large resized Texer II sprites.
  const x1 = Math.min(x + 1, bitmap.width - 1);
  const y1 = Math.min(y + 1, bitmap.height - 1);
  const sx0 = flipX ? bitmap.width - x - 1 : x;
  const sx1 = flipX ? bitmap.width - x1 - 1 : x1;
  const row0 = (flipY ? bitmap.height - y - 1 : y) * bitmap.width;
  const row1 = (flipY ? bitmap.height - y1 - 1 : y1) * bitmap.width;
  const a = bitmap.pixels[row0 + sx0]!;
  const b = bitmap.pixels[row0 + sx1]!;
  const c = bitmap.pixels[row1 + sx0]!;
  const d = bitmap.pixels[row1 + sx1]!;
  const inverseX = 255 - dx;
  const inverseY = 255 - dy;
  return interpolateByte(a, b, c, d, dx, dy, inverseX, inverseY)
    | (interpolateByte(a >>> 8, b >>> 8, c >>> 8, d >>> 8, dx, dy, inverseX, inverseY) << 8)
    | (interpolateByte(a >>> 16, b >>> 16, c >>> 16, d >>> 16, dx, dy, inverseX, inverseY) << 16);
}

function interpolateByte(
  a: number, b: number, c: number, d: number,
  dx: number, dy: number, inverseX: number, inverseY: number,
): number {
  const upper = (((a & 255) * inverseX) >>> 8) + (((b & 255) * dx) >>> 8);
  const lower = (((c & 255) * inverseX) >>> 8) + (((d & 255) * dx) >>> 8);
  return (((upper * inverseY) >>> 8) + ((lower * dy) >>> 8)) & 255;
}

function sampleBitmap(bitmap: AvsBitmap, x: number, y: number, flipX: boolean, flipY: boolean): number {
  const sx = flipX ? bitmap.width - x - 1 : x;
  const sy = flipY ? bitmap.height - y - 1 : y;
  return bitmap.pixels[clamp(sy, 0, bitmap.height - 1) * bitmap.width + clamp(sx, 0, bitmap.width - 1)]!;
}

function filterPixel(pixel: number, color: number): number {
  return (((pixel & 255) * (color & 255)) >>> 8)
    | (((((pixel >>> 8) & 255) * ((color >>> 8) & 255)) >>> 8) << 8)
    | (((((pixel >>> 16) & 255) * ((color >>> 16) & 255)) >>> 8) << 16);
}

function blendTexerPixel(source: number, destination: number, mode: number, amount: number): number {
  source &= 0x00ffffff; destination &= 0x00ffffff;
  switch (mode) {
    case 1: return channels(source, destination, (s, d) => Math.min(255, s + d));
    case 2: return channels(source, destination, Math.max);
    case 3: return ((source >>> 1) & 0x007f7f7f) + ((destination >>> 1) & 0x007f7f7f);
    case 4: return channels(source, destination, (s, d) => Math.max(0, d - s));
    case 5: return channels(source, destination, (s, d) => Math.max(0, s - d));
    case 6: return channels(source, destination, (s, d) => (s * d) >>> 8);
    case 7: {
      const alpha = clamp(amount, 0, 255);
      return channels(source, destination, (s, d) => ((s * alpha) >>> 8) + ((d * (256 - alpha)) >>> 8));
    }
    case 8: return (source ^ destination) & 0x00ffffff;
    case 9: return channels(source, destination, Math.min);
    default: return source;
  }
}

function channels(a: number, b: number, fn: (a: number, b: number) => number): number {
  return (fn(a & 255, b & 255) & 255)
    | ((fn((a >>> 8) & 255, (b >>> 8) & 255) & 255) << 8)
    | ((fn((a >>> 16) & 255, (b >>> 16) & 255) & 255) << 16);
}

function resolveTexer2Bitmap(name: string, options: AvsTexerEffectOptions): AvsBitmap {
  if (name && name !== '(default image)') {
    const resolved = options.bitmapResolver?.(name);
    if (resolved) return resolved;
  }
  return options.defaultTexer2Bitmap ?? defaultTexer2Bitmap();
}

let defaultBitmap: AvsBitmap | undefined;
function defaultTexer2Bitmap(): AvsBitmap {
  if (defaultBitmap) return defaultBitmap;
  const encoded = 'AAAAAAAAAAAAAAAAAAAAAAAAAAADAwMICAgNDQ0QEBASEhIQEBANDQ0ICAgDAwMBAQEAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAADAwMLCwsWFhYhISEqKiovLy8yMjIvLy8qKiohISEWFhYLCwsDAwMAAAAAAAAAAAAAAAAAAAAAAAAAAAAFBQUSEhIiIiIyMjJBQUFNTU1UVFRXV1dUVFRNTU1BQUEyMjIiIiISEhIFBQUAAAAAAAAAAAAAAAAAAAAFBQUUFBQoKCg+Pj5TU1NlZWV0dHR9fX2AgIB9fX10dHRmZmZTU1M+Pj4oKCgUFBQFBQUAAAAAAAAAAAADAwMREREoKChCQkJdXV13d3eNjY2cnJylpaWoqKilpaWcnJyNjY13d3ddXV1CQkIoKCgREREDAwMAAAAAAAAKCgohISE+Pj5dXV19fX2ampqvr6/AwMDKysrNzc3KysrAwMCvr6+ampp9fX1dXV0+Pj4hISEKCgoAAAADAwMVFRUxMTFTU1N2dnaZmZm2trbOzs7e3t7o6Ojr6+vo6Oje3t7Nzc22traZmZl2dnZTU1MxMTEVFRUDAwMHBwcfHx9AQEBlZWWMjIyvr6/Nzc3l5eXy8vL4+Pj6+vr4+Pjy8vLl5eXNzc2vr6+MjIxlZWVAQEAfHx8HBwcMDAwoKChMTExzc3Obm5u/v7/d3d3y8vL6+vr9/f3+/v79/f36+vry8vLd3d2/v7+bm5tzc3NMTEwoKCgLCwsPDw8uLi5TU1N8fHykpKTIyMjn5+f4+Pj9/f3////////////9/f34+Pjn5+fIyMikpKR8fHxTU1MuLi4PDw8QEBAwMDBVVVV+fn6mpqbLy8vp6en5+fn+/v7////////////+/v75+fnp6enLy8umpqZ+fn5VVVUwMDAQEBAPDw8tLS1SUlJ7e3ujo6PHx8fm5ub39/f9/f3+/v7////+/v79/f339/fm5ubHx8ejo6N7e3tSUlItLS0PDw8LCwsoKChKSkpxcXGampq9vb3c3Nzx8fH6+vr9/f3+/v79/f36+vrx8fHc3Ny9vb2amppxcXFKSkooKCgLCwsGBgYfHx8/Pz9jY2OKioqtra3Ly8vj4+Px8fH39/f5+fn39/fx8fHj4+PLy8utra2KiopjY2M/Pz8fHx8GBgYDAwMUFBQwMDBQUFB0dHSWlpazs7PKysrb29vl5eXo6Ojl5eXb29vLy8uzs7OWlpZ0dHRQUFAwMDAUFBQCAgIAAAAJCQkgICA8PDxaWlp6enqWlpasrKy8vLzGxsbJycnGxsa8vLysrKyWlpZ6enpaWlo8PDwgICAJCQkAAAAAAAACAgIQEBAmJiY/Pz9aWlpzc3OJiYmZmZmhoaGkpKShoaGZmZmJiYlzc3NaWlpAQEAmJiYQEBACAgIAAAAAAAAAAAAEBAQSEhImJiY7OztQUFBiYmJwcHB5eXl8fHx5eXlwcHBiYmJQUFA7OzsmJiYSEhIEBAQAAAAAAAAAAAAAAAAAAAAEBAQPDw8fHx8vLy8+Pj5JSUlQUFBTU1NQUFBJSUk+Pj4vLy8fHx8PDw8EBAQAAAAAAAAAAAAAAAAAAAAAAAAAAAACAgIJCQkTExMeHh4mJiYsLCwuLi4sLCwmJiYdHR0TExMJCQkCAgIAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAACAgIGBgYKCgoODg4PDw8ODg4KCgoGBgYDAwMAAAAAAAAAAAAAAAAAAAAA';
  const raw = atob(encoded);
  const pixels = new Uint32Array(21 * 21);
  for (let index = 0; index < pixels.length; index++) {
    const offset = index * 3;
    pixels[index] = raw.charCodeAt(offset) | (raw.charCodeAt(offset + 1) << 8) | (raw.charCodeAt(offset + 2) << 16);
  }
  defaultBitmap = { width: 21, height: 21, pixels };
  return defaultBitmap;
}

function overlapsEdge(coordinate: number, size: number, imagePixels: number, screenPixels: number): boolean {
  const half = size * (imagePixels - 1) / screenPixels;
  const absolute = Math.abs(coordinate);
  return absolute + half > 1 && absolute - half < 1;
}
function readLengthString(payload: Uint8Array, offset: number): { value: string; next: number } {
  if (offset + 4 > payload.length) return { value: '', next: payload.length };
  const length = readU32(payload, offset, 0);
  const start = offset + 4;
  const end = Math.min(payload.length, start + length);
  return { value: nulText(payload.subarray(start, end)), next: end };
}
function nulText(bytes: Uint8Array): string {
  const end = bytes.indexOf(0);
  return TEXT.decode(end < 0 ? bytes : bytes.subarray(0, end));
}
function readI32(payload: Uint8Array, offset: number, fallback: number): number {
  return offset + 4 <= payload.length
    ? new DataView(payload.buffer, payload.byteOffset, payload.byteLength).getInt32(offset, true)
    : fallback;
}
function readU32(payload: Uint8Array, offset: number, fallback: number): number {
  return offset + 4 <= payload.length
    ? new DataView(payload.buffer, payload.byteOffset, payload.byteLength).getUint32(offset, true)
    : fallback;
}
function compileOrNull(source: string): AvsEelProgram | null {
  if (!source.trim()) return null;
  try { return compileAvsEel(source); } catch { return null; }
}
function execute(program: AvsEelProgram | null, vm: AvsEelVm): number { return program ? vm.execute(program) : 0; }
function signedByte(value: number): number { return value < 128 ? value : value - 256; }
function byteColor(value: number): number { return clamp(roundEven(value * 255), 0, 255); }
function roundEven(value: number): number {
  if (!Number.isFinite(value)) return 0;
  const floor = Math.floor(value);
  const fraction = value - floor;
  if (fraction < 0.5) return floor;
  if (fraction > 0.5) return floor + 1;
  return (floor & 1) === 0 ? floor : floor + 1;
}
function roundAway(value: number): number {
  return value < 0 ? -Math.round(-value) : Math.round(value);
}
function fractional(value: number): number { return value - Math.trunc(value); }
function clamp(value: number, minimum: number, maximum: number): number {
  return value < minimum ? minimum : value > maximum ? maximum : value;
}
function hashPath(path: string): number {
  let hash = 0x811c9dc5;
  for (let i = 0; i < path.length; i++) hash = Math.imul(hash ^ path.charCodeAt(i), 0x01000193);
  return hash >>> 0;
}
