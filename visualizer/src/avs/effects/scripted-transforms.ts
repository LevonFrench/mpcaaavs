import { avsAudioSample } from '../audio.ts';
import { compileAvsEel } from '../eel/compiler.ts';
import type { AvsEelProgram } from '../eel/types.ts';
import { AvsEelVm } from '../eel/vm.ts';
import { AvsEffectRegistry, type AvsEffectContext } from '../executor.ts';
import { blendPixel } from '../framebuffer.ts';

const TEXT = new TextDecoder('windows-1252');

export interface AvsDynamicColorModifierConfig {
  readonly level: string;
  readonly frame: string;
  readonly beat: string;
  readonly init: string;
  readonly recompute: boolean;
}

export interface AvsDynamicShiftConfig {
  readonly init: string;
  readonly frame: string;
  readonly beat: string;
  readonly blend: boolean;
  readonly subpixel: boolean;
}

export interface AvsDynamicDistanceModifierConfig {
  readonly point: string;
  readonly frame: string;
  readonly beat: string;
  readonly init: string;
  readonly blend: boolean;
  readonly subpixel: boolean;
}

export interface AvsUniqueToneConfig {
  readonly enabled: boolean;
  /** Packed AVS 0x00RRGGBB target color. */
  readonly color: number;
  readonly additive: boolean;
  readonly average: boolean;
  readonly invert: boolean;
}

interface ScriptState {
  readonly vm: AvsEelVm;
  readonly programs: readonly (AvsEelProgram | null)[];
  initialized: boolean;
}

interface ColorState extends ScriptState {
  readonly red: Uint8Array;
  readonly green: Uint8Array;
  readonly blue: Uint8Array;
  tableValid: boolean;
}

interface ShiftState extends ScriptState {
  width: number;
  height: number;
}

/** Decode r_dcolormod.cpp's versioned or four-block legacy payload. */
export function decodeAvsDynamicColorModifier(payload: Uint8Array): AvsDynamicColorModifierConfig {
  const decoded = decodeScripts(payload, 4);
  return {
    level: decoded.scripts[0]!, frame: decoded.scripts[1]!,
    beat: decoded.scripts[2]!, init: decoded.scripts[3]!,
    recompute: i32(payload, decoded.offset, 1) !== 0,
  };
}

/** Decode r_shift.cpp's versioned or three-block legacy payload. */
export function decodeAvsDynamicShift(payload: Uint8Array): AvsDynamicShiftConfig {
  const decoded = decodeScripts(payload, 3);
  return {
    init: decoded.scripts[0]!, frame: decoded.scripts[1]!, beat: decoded.scripts[2]!,
    blend: i32(payload, decoded.offset, 0) !== 0,
    subpixel: i32(payload, decoded.offset + 4, 1) !== 0,
  };
}

/** Decode r_ddm.cpp's versioned or four-block legacy payload. */
export function decodeAvsDynamicDistanceModifier(payload: Uint8Array): AvsDynamicDistanceModifierConfig {
  const decoded = decodeScripts(payload, 4);
  return {
    point: decoded.scripts[0]!, frame: decoded.scripts[1]!,
    beat: decoded.scripts[2]!, init: decoded.scripts[3]!,
    blend: i32(payload, decoded.offset, 0) !== 0,
    subpixel: i32(payload, decoded.offset + 4, 0) !== 0,
  };
}

/** Decode r_onetone.cpp's five fixed little-endian integers. */
export function decodeAvsUniqueTone(payload: Uint8Array): AvsUniqueToneConfig {
  return {
    enabled: i32(payload, 0, 1) !== 0,
    color: i32(payload, 4, 0x00ffffff) & 0x00ffffff,
    additive: i32(payload, 8, 0) !== 0,
    average: i32(payload, 12, 0) !== 0,
    invert: i32(payload, 16, 0) !== 0,
  };
}

/** Register Dynamic Color Modifier (45), Dynamic Shift (42), DDM (35), and Unique Tone (38). */
export function registerAvsScriptedTransforms(registry: AvsEffectRegistry): AvsEffectRegistry {
  registerDynamicColorModifier(registry);
  registerDynamicShift(registry);
  registerDynamicDistanceModifier(registry);
  registerUniqueTone(registry);
  return registry;
}

function registerDynamicColorModifier(registry: AvsEffectRegistry): void {
  const states = new Map<string, ColorState>();
  registry.registerBuiltin(45, (context) => {
    const config = decodeAvsDynamicColorModifier(context.component.payload);
    let state = states.get(context.component.path);
    if (!state) {
      state = {
        vm: createVm(registry, context.component.path),
        programs: compilePrograms([config.level, config.frame, config.beat, config.init]),
        initialized: false,
        red: new Uint8Array(256), green: new Uint8Array(256), blue: new Uint8Array(256),
        tableValid: false,
      };
      states.set(context.component.path, state);
    }
    if (context.preinit) return;
    configureVm(state.vm, context);
    state.vm.set('beat', context.beat ? 1 : 0);
    if (!state.initialized) { execute(state.programs[3], state.vm); state.initialized = true; }
    execute(state.programs[1], state.vm);
    if (context.beat) execute(state.programs[2], state.vm);

    if (config.recompute || !state.tableValid) {
      for (let value = 0; value < 256; value++) {
        const normalized = value / 255;
        state.vm.set('red', normalized); state.vm.set('green', normalized); state.vm.set('blue', normalized);
        execute(state.programs[0], state.vm);
        state.red[value] = eelChannel(state.vm.get('red'));
        state.green[value] = eelChannel(state.vm.get('green'));
        state.blue[value] = eelChannel(state.vm.get('blue'));
      }
      state.tableValid = true;
    }

    const pixels = context.input.pixels;
    for (let i = 0; i < pixels.length; i++) {
      const pixel = pixels[i]!;
      pixels[i] = state.blue[pixel & 255]!
        | (state.green[(pixel >>> 8) & 255]! << 8)
        | (state.red[(pixel >>> 16) & 255]! << 16);
    }
  });
}

function registerDynamicShift(registry: AvsEffectRegistry): void {
  const states = new Map<string, ShiftState>();
  registry.registerBuiltin(42, (context) => {
    const config = decodeAvsDynamicShift(context.component.payload);
    let state = states.get(context.component.path);
    if (!state) {
      state = {
        vm: createVm(registry, context.component.path),
        programs: compilePrograms([config.init, config.frame, config.beat]),
        initialized: false, width: 0, height: 0,
      };
      states.set(context.component.path, state);
    }
    configureVm(state.vm, context);
    state.vm.set('w', context.input.width); state.vm.set('h', context.input.height);
    state.vm.set('b', context.beat ? 1 : 0);
    if (context.preinit) return;
    if (!state.initialized || state.width !== context.input.width || state.height !== context.input.height) {
      state.width = context.input.width; state.height = context.input.height;
      state.vm.set('x', 0); state.vm.set('y', 0); state.vm.set('alpha', 0.5);
      execute(state.programs[0], state.vm);
      state.initialized = true;
    }
    execute(state.programs[1], state.vm);
    if (context.beat) execute(state.programs[2], state.vm);

    let doBlend = config.blend;
    const alpha = Math.trunc(state.vm.get('alpha') * 255);
    if (doBlend && alpha <= 0) return;
    if (doBlend && alpha >= 255) doBlend = false;
    if (config.subpixel && context.input.width > 1 && context.input.height > 1) {
      renderSubpixelShift(context, state.vm.get('x'), state.vm.get('y'), doBlend, alpha);
    } else {
      renderNearestShift(context, Math.trunc(state.vm.get('x')), Math.trunc(state.vm.get('y')), doBlend, alpha);
    }
    return { swap: true };
  });
}

function renderNearestShift(context: AvsEffectContext, shiftX: number, shiftY: number, blend: boolean, alpha: number): void {
  const { width, height } = context.input;
  const source = context.input.pixels;
  const output = context.output.pixels;
  for (let y = 0; y < height; y++) {
    const sourceY = y - shiftY;
    for (let x = 0; x < width; x++) {
      const index = x + y * width;
      const sourceX = x - shiftX;
      const shifted = sourceX >= 0 && sourceX < width && sourceY >= 0 && sourceY < height
        ? source[sourceX + sourceY * width]!
        : 0;
      output[index] = blend ? blendPixel(shifted, source[index]!, 'adjustable', alpha) : shifted;
    }
  }
}

/** Preserve r_shift.cpp's base-coordinate and cropped-border bilinear path. */
function renderSubpixelShift(context: AvsEffectContext, vx: number, vy: number, blend: boolean, alpha: number): void {
  const { width, height } = context.input;
  const source = context.input.pixels;
  const output = context.output.pixels;
  let shiftX = Math.trunc(vx);
  let shiftY = Math.trunc(vy);
  let xPartial = Math.trunc((vx - shiftX) * 255);
  let yPartial = Math.trunc((vy - shiftY) * 255);
  if (xPartial < 0) xPartial = -xPartial; else { shiftX++; xPartial = 255 - xPartial; }
  if (yPartial < 0) yPartial = -yPartial; else { shiftY++; yPartial = 255 - yPartial; }
  xPartial = clamp(xPartial, 0, 255); yPartial = clamp(yPartial, 0, 255);
  shiftX = clamp(shiftX, 1 - width, width - 1);
  shiftY = clamp(shiftY, 1 - height, height - 1);
  const endX = clamp(width - 1 + shiftX, 0, width - 1);
  const endY = clamp(height - 1 + shiftY, 0, height - 1);
  const startX = Math.max(0, shiftX);
  const startY = Math.max(0, shiftY);

  for (let y = 0; y < height; y++) {
    for (let x = 0; x < width; x++) {
      const index = x + y * width;
      let shifted = 0;
      if (x >= startX && x < endX && y >= startY && y < endY) {
        const sourceX = x - shiftX;
        const sourceY = y - shiftY;
        shifted = sampleBilinear(source, sourceX + sourceY * width, width, xPartial, yPartial);
      }
      output[index] = blend ? blendPixel(shifted, source[index]!, 'adjustable', alpha) : shifted;
    }
  }
}

function registerDynamicDistanceModifier(registry: AvsEffectRegistry): void {
  const states = new Map<string, ScriptState>();
  registry.registerBuiltin(35, (context) => {
    const config = decodeAvsDynamicDistanceModifier(context.component.payload);
    let state = states.get(context.component.path);
    if (!state) {
      state = {
        vm: createVm(registry, context.component.path),
        programs: compilePrograms([config.point, config.frame, config.beat, config.init]),
        initialized: false,
      };
      states.set(context.component.path, state);
    }
    if (context.preinit) return;
    configureVm(state.vm, context);
    state.vm.set('b', context.beat ? 1 : 0);
    if (!state.initialized) { execute(state.programs[3], state.vm); state.initialized = true; }
    execute(state.programs[1], state.vm);
    if (context.beat) execute(state.programs[2], state.vm);
    renderDynamicDistance(context, config, state);
    return { swap: true };
  });
}

function renderDynamicDistance(
  context: AvsEffectContext,
  config: AvsDynamicDistanceModifierConfig,
  state: ScriptState,
): void {
  const { width, height } = context.input;
  const maxDistance = Math.sqrt((width * width + height * height) / 4);
  const tableLength = Math.max(33, Math.trunc(maxDistance + 32.9));
  const distanceTable = new Int32Array(tableLength);
  if (state.programs[0]) {
    const computed = tableLength - 32;
    for (let distance = 0; distance < computed; distance++) {
      state.vm.set('d', distance / (maxDistance - 1));
      execute(state.programs[0], state.vm);
      distanceTable[distance] = Math.trunc(state.vm.get('d') * 256 * maxDistance / (distance + 1));
    }
    const last = distanceTable[Math.max(0, computed - 1)]!;
    for (let distance = computed; distance < tableLength; distance++) distanceTable[distance] = last;
  }

  const source = context.input.pixels;
  const output = context.output.pixels;
  const halfWidth = Math.trunc(width / 2);
  const halfHeight = Math.trunc(height / 2);
  const bilinear = config.subpixel && width > 1 && height > 1;
  for (let y = 0; y < height; y++) {
    const relativeY = y - halfHeight;
    let radiusSquared = halfWidth * halfWidth + halfWidth + relativeY * relativeY + 256;
    let radiusDelta = -2 * halfWidth;
    let relativeX = -halfWidth;
    for (let x = 0; x < width; x++) {
      const scale = distanceTable[Math.min(tableLength - 1, avsIntegerSquareRoot(radiusSquared))]!;
      const scaledX = scale * relativeX + 128;
      const scaledY = scale * relativeY + 128;
      let sourceX = halfWidth + (scaledX >> 8);
      let sourceY = halfHeight + (scaledY >> 8);
      let sampled: number;
      if (bilinear) {
        sourceX = clamp(sourceX, 0, width - 2); sourceY = clamp(sourceY, 0, height - 2);
        sampled = sampleBilinear(source, sourceX + sourceY * width, width, scaledX & 255, scaledY & 255);
      } else {
        sourceX = clamp(sourceX, 0, width - 1); sourceY = clamp(sourceY, 0, height - 1);
        sampled = source[sourceX + sourceY * width]!;
      }
      const index = x + y * width;
      output[index] = config.blend ? averagePixel(sampled, source[index]!) : sampled;
      radiusSquared += radiusDelta; radiusDelta += 2; relativeX++;
    }
  }
}

function registerUniqueTone(registry: AvsEffectRegistry): void {
  registry.registerBuiltin(38, (context) => {
    const config = decodeAvsUniqueTone(context.component.payload);
    if (!config.enabled || context.preinit) return;
    const red = (config.color >>> 16) & 255;
    const green = (config.color >>> 8) & 255;
    const blue = config.color & 255;
    const pixels = context.input.pixels;
    for (let i = 0; i < pixels.length; i++) {
      const original = pixels[i]!;
      let depth = Math.max(original & 255, (original >>> 8) & 255, (original >>> 16) & 255);
      if (config.invert) depth = 255 - depth;
      const tone = table(depth, blue) | (table(depth, green) << 8) | (table(depth, red) << 16);
      pixels[i] = config.additive
        ? blendPixel(tone, original, 'additive')
        : config.average ? averagePixel(original, tone) : tone;
    }
  });
}

function createVm(registry: AvsEffectRegistry, path: string): AvsEelVm {
  return new AvsEelVm({ global: registry.eelGlobal, seed: hashPath(path) });
}

function configureVm(vm: AvsEelVm, context: AvsEffectContext): void {
  vm.setHost({
    getosc: (band, width, channel) => avsAudioSample(context.audio, 'osc', band, width, channel),
    getspec: (band, width, channel) => avsAudioSample(context.audio, 'spec', band, width, channel),
  });
}

function decodeScripts(payload: Uint8Array, count: number): { scripts: string[]; offset: number } {
  const scripts = new Array<string>(count).fill('');
  if (payload[0] === 1) {
    let offset = 1;
    for (let i = 0; i < count; i++) {
      if (offset + 4 > payload.length) return { scripts, offset: payload.length };
      const length = i32(payload, offset, 0); offset += 4;
      if (length > 0 && offset + length <= payload.length) {
        scripts[i] = nulText(payload.subarray(offset, offset + length));
        offset += length;
      }
    }
    return { scripts, offset };
  }
  const bytes = count * 256;
  if (payload.length >= bytes) {
    for (let i = 0; i < count; i++) scripts[i] = nulText(payload.subarray(i * 256, (i + 1) * 256));
    return { scripts, offset: bytes };
  }
  return { scripts, offset: 0 };
}

function compilePrograms(sources: readonly string[]): readonly (AvsEelProgram | null)[] {
  return sources.map((source) => {
    if (!source.trim()) return null;
    try { return compileAvsEel(source); } catch { return null; }
  });
}

function execute(program: AvsEelProgram | null | undefined, vm: AvsEelVm): number {
  return program ? vm.execute(program) : 0;
}

/** r_ddm.cpp's lookup-table integer square-root approximation. */
function avsIntegerSquareRoot(value: number): number {
  const n = value >>> 0;
  const sq = (index: number): number => Math.trunc(Math.sqrt(index) * 16);
  if (n >= 0x10000) {
    if (n >= 0x1000000) {
      if (n >= 0x10000000) return n >= 0x40000000 ? sq(n >>> 24) << 8 : sq(n >>> 22) << 7;
      return n >= 0x4000000 ? sq(n >>> 20) << 6 : sq(n >>> 18) << 5;
    }
    if (n >= 0x100000) return n >= 0x400000 ? sq(n >>> 16) << 4 : sq(n >>> 14) << 3;
    return n >= 0x40000 ? sq(n >>> 12) << 2 : sq(n >>> 10) << 1;
  }
  if (n >= 0x100) {
    if (n >= 0x1000) return n >= 0x4000 ? sq(n >>> 8) : sq(n >>> 6) >>> 1;
    return n >= 0x400 ? sq(n >>> 4) >>> 2 : sq(n >>> 2) >>> 3;
  }
  return Math.trunc(Math.sqrt(n));
}

/** Portable NO_MMX BLEND4, including both blend-table truncation stages. */
function sampleBilinear(source: Uint32Array, offset: number, width: number, xp: number, yp: number): number {
  const weights = [table(255 - xp, 255 - yp), table(xp, 255 - yp), table(255 - xp, yp), table(xp, yp)];
  const pixels = [source[offset]!, source[offset + 1]!, source[offset + width]!, source[offset + width + 1]!];
  let result = 0;
  for (let shift = 0; shift <= 16; shift += 8) {
    let value = 0;
    for (let i = 0; i < 4; i++) value += table((pixels[i]! >>> shift) & 255, weights[i]!);
    result |= (value & 255) << shift;
  }
  return result;
}

function eelChannel(value: number): number { return clamp(Math.trunc(value * 255 + 0.5), 0, 255); }
function averagePixel(a: number, b: number): number {
  return (((a >>> 1) & 0x007f7f7f) + ((b >>> 1) & 0x007f7f7f)) & 0x00ffffff;
}
function table(x: number, y: number): number { return Math.trunc((x / 255) * y); }
function i32(payload: Uint8Array, offset: number, fallback: number): number {
  return offset + 4 <= payload.length
    ? new DataView(payload.buffer, payload.byteOffset, payload.byteLength).getInt32(offset, true)
    : fallback;
}
function nulText(bytes: Uint8Array): string {
  const end = bytes.indexOf(0);
  return TEXT.decode(end < 0 ? bytes : bytes.subarray(0, end));
}
function clamp(value: number, minimum: number, maximum: number): number {
  return value < minimum ? minimum : value > maximum ? maximum : value;
}
function hashPath(path: string): number {
  let hash = 0x811c9dc5;
  for (let i = 0; i < path.length; i++) hash = Math.imul(hash ^ path.charCodeAt(i), 0x01000193);
  return hash >>> 0;
}
