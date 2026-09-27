import { avsAudioSample } from '../audio.ts';
import { compileAvsEel } from '../eel/compiler.ts';
import type { AvsEelProgram, AvsEelVariableBinding } from '../eel/types.ts';
import { AvsEelGlobalState, AvsEelVm } from '../eel/vm.ts';
import { AvsEffectRegistry, type AvsEffectContext } from '../executor.ts';
import { AVS_BLEND_TABLE } from '../framebuffer.ts';

const TEXT = new TextDecoder('windows-1252');
const CUSTOM_EFFECT = 32_767;
const LAST_BUILTIN_EFFECT = 23;
const OFFSET_MASK = (1 << 22) - 1;
const BILINEAR_WEIGHTS = (() => {
  const weights = [
    new Uint8Array(32 * 32),
    new Uint8Array(32 * 32),
    new Uint8Array(32 * 32),
    new Uint8Array(32 * 32),
  ] as const;
  for (let x = 0; x < 32; x++) {
    const xp = x << 3;
    const inverseX = 255 - xp;
    for (let y = 0; y < 32; y++) {
      const yp = y << 3;
      const inverseY = 255 - yp;
      const key = (x << 5) | y;
      weights[0][key] = AVS_BLEND_TABLE[(inverseX << 8) | inverseY]!;
      weights[1][key] = AVS_BLEND_TABLE[(xp << 8) | inverseY]!;
      weights[2][key] = AVS_BLEND_TABLE[(inverseX << 8) | yp]!;
      weights[3][key] = AVS_BLEND_TABLE[(xp << 8) | yp]!;
    }
  }
  return weights;
})();

/** Binary configuration of AVS built-in renderer 15, Trans / Movement. */
export interface AvsMovementConfig {
  readonly effect: number;
  readonly expression: string;
  readonly blend: boolean;
  /** Native `sourcemapped`: bit 0 selects forward mapping, bit 1 toggles it on beat. */
  readonly sourceMapped: number;
  readonly rectangular: boolean;
  readonly subpixel: boolean;
  readonly wrap: boolean;
}

export interface AvsStaticMovementGpuMap {
  /** Offset in bits 0..21 and AVS 5-bit bilinear key in bits 22..31. */
  readonly packedCoordinates: Uint32Array;
  readonly bilinear: boolean;
  readonly blend: boolean;
}

interface MovementTable {
  readonly offsets: Uint32Array;
  /** Index into the 32x32 table of AVS's effective 5-bit bilinear weights. */
  readonly weightKeys: Uint16Array;
  readonly bilinear: boolean;
}

interface MovementState {
  readonly config: AvsMovementConfig;
  readonly program: AvsEelProgram | null;
  sourceMapped: number;
  width: number;
  height: number;
  table: MovementTable | null;
  randomState: number;
}

interface Coordinate {
  x: number;
  y: number;
}

const EVALUATED_BUILTINS: Readonly<Record<number, { source: string; rectangular: boolean }>> = {
  18: {
    source: 'd=d*(1-(sin((r-$pi*.5)*7)*.03));r=r+(cos(d*12)*.03)',
    rectangular: false,
  },
  19: {
    source: 'd=d*(1-(sin((r-$pi*.5)*12)*.05));r=r+(cos(d*18)*.05);d=d*(1-((d-.4)*.03));r=r+((d-.4)*.13)',
    rectangular: false,
  },
  20: { source: 'x=x+(cos(y*18)*.02);y=y+(sin(x*14)*.03)', rectangular: true },
  21: {
    source: 'x=x+(cos(abs(y-.5)*8)*.02);y=y+(sin(abs(x-.5)*8)*.05);x=x*.95;y=y*.95',
    rectangular: true,
  },
  22: {
    source: 'y=y*(1+(sin(r+$pi/2)*.3));x=x*(1+(cos(r+$pi/2)*.3));x=x*.995;y=y*.995',
    rectangular: true,
  },
  23: { source: 'y=(r*6)/$pi;x=d', rectangular: true },
};

/** Decode both the fixed-size legacy and length-prefixed Movement payloads. */
export function decodeAvsMovement(payload: Uint8Array): AvsMovementConfig {
  let offset = 0;
  let effect = readI32(payload, offset, 1); offset += 4;
  let expression = '';
  let rectangular = false;

  if (effect === CUSTOM_EFFECT) {
    // AVS 2.7's custom rectangular form put "!rect " before its 250-byte code.
    if (asciiEquals(payload, offset, '!rect ')) {
      offset += 6;
      rectangular = true;
    }
    if (payload[offset] === 1) {
      offset++;
      const length = readI32(payload, offset, 0); offset += 4;
      if (length > 0 && offset + length <= payload.length) {
        expression = nulText(payload.subarray(offset, offset + length));
        offset += length;
      }
    } else {
      const length = 256 - (rectangular ? 6 : 0);
      if (offset + length <= payload.length) {
        expression = nulText(payload.subarray(offset, offset + length));
        offset += length;
      }
    }
  }

  const blend = readI32(payload, offset, 0) !== 0; offset += 4;
  const sourceMapped = readI32(payload, offset, 0); offset += 4;
  rectangular = readI32(payload, offset, rectangular ? 1 : 0) !== 0; offset += 4;
  const subpixel = readI32(payload, offset, 0) !== 0; offset += 4;
  const wrap = readI32(payload, offset, 0) !== 0; offset += 4;

  // Effects 16..23 were written as zero for old AVS, then appended after the
  // common fields. The native loader only consumes this word when the first ID
  // was zero.
  if (effect === 0 && offset + 4 <= payload.length) effect = readI32(payload, offset, 0);
  if ((effect !== CUSTOM_EFFECT && effect > LAST_BUILTIN_EFFECT) || effect < 0) effect = 0;

  return { effect, expression, blend, sourceMapped, rectangular, subpixel, wrap };
}

/** Register source-grounded CPU compatibility for AVS Movement (effect ID 15). */
export function registerAvsMovement(
  registry: AvsEffectRegistry,
  global = new AvsEelGlobalState(),
): AvsEffectRegistry {
  const states = new Map<string, MovementState>();
  registry.registerBuiltin(15, (context) => {
    let state = states.get(context.component.path);
    if (!state) {
      const config = decodeAvsMovement(context.component.payload);
      state = {
        config,
        program: movementProgram(config),
        sourceMapped: config.sourceMapped,
        width: 0,
        height: 0,
        table: null,
        randomState: hashPath(context.component.path),
      };
      states.set(context.component.path, state);
    }

    if (state.config.effect === 0) return;
    if (!state.table || state.width !== context.input.width || state.height !== context.input.height) {
      state.table = buildMovementTable(context, state, global);
      state.width = context.input.width;
      state.height = context.input.height;
    }
    if (context.preinit) return;

    if ((state.sourceMapped & 2) !== 0 && context.beat) state.sourceMapped ^= 1;
    if ((state.sourceMapped & 1) !== 0) renderForward(context, state.table, state.config.blend);
    else renderInverse(context, state.table, state.config.blend);
    return { swap: true };
  });
  return registry;
}

/**
 * Build the exact native lookup table for the stateless inverse-mapped subset.
 * Custom/EEL, random, evaluated, beat-toggled and forward-scatter modes stay on
 * the CPU executor because extracting them would change state or ordering.
 */
export function buildStaticAvsMovementGpuMap(
  config: AvsMovementConfig,
  width: number,
  height: number,
): AvsStaticMovementGpuMap | null {
  if (!Number.isInteger(width) || !Number.isInteger(height) || width <= 0 || height <= 0) return null;
  if (config.sourceMapped !== 0 || config.effect < 2 || config.effect > 17) return null;
  const count = width * height;
  if (!Number.isSafeInteger(count) || count >= (1 << 22)) return null;
  const bilinear = config.subpixel && width > 1 && height > 1 && config.effect >= 3 && config.effect !== 7;
  const table: MovementTable = {
    offsets: new Uint32Array(count), weightKeys: new Uint16Array(count), bilinear,
  };
  buildStaticMovementTable(config, table, width, height);
  const packedCoordinates = new Uint32Array(count);
  for (let index = 0; index < count; index++) {
    packedCoordinates[index] = table.offsets[index]! | (table.weightKeys[index]! << 22);
  }
  return { packedCoordinates, bilinear, blend: config.blend };
}

function movementProgram(config: AvsMovementConfig): AvsEelProgram | null {
  const source = config.effect === CUSTOM_EFFECT
    ? config.expression
    : EVALUATED_BUILTINS[config.effect]?.source;
  if (!source?.trim()) return null;
  try { return compileAvsEel(source); } catch { return null; }
}

function buildMovementTable(
  context: AvsEffectContext,
  state: MovementState,
  global: AvsEelGlobalState,
): MovementTable {
  const { width, height } = context.input;
  const count = width * height;
  const config = state.config;
  const bilinear = config.subpixel && width > 1 && height > 1 && count < (1 << 22)
    && (config.effect === CUSTOM_EFFECT || (config.effect >= 3 && config.effect <= 23 && config.effect !== 7));
  const table: MovementTable = {
    offsets: new Uint32Array(count),
    weightKeys: new Uint16Array(count),
    bilinear,
  };

  if (config.effect === 1) {
    for (let i = 0; i < count; i++) {
      const dx = nextRandom(state) % 3 - 1;
      const dy = nextRandom(state) % 3 - 1;
      table.offsets[i] = clamp(i + dx + dy * width, 0, count - 1);
    }
    return table;
  }
  if (config.effect === 2) {
    buildStaticMovementTable(config, table, width, height);
    return table;
  }
  if (config.effect === 7) {
    buildStaticMovementTable(config, table, width, height);
    return table;
  }

  if (state.program) buildEvaluatedTable(context, state, table, global);
  else if (config.effect >= 3 && config.effect <= 17) buildStaticMovementTable(config, table, width, height);
  else fillIdentity(table, width, height);
  return table;
}

function buildStaticMovementTable(
  config: AvsMovementConfig, table: MovementTable, width: number, height: number,
): void {
  if (config.effect === 2) {
    const shift = Math.trunc(width / 64);
    for (let y = 0; y < height; y++) {
      let sourceX = shift;
      for (let x = 0; x < width; x++) {
        table.offsets[x + y * width] = sourceX + y * width;
        sourceX++;
        if (sourceX >= width) sourceX -= width;
      }
    }
    return;
  }
  if (config.effect === 7) {
    for (let y = 0; y < height; y++) for (let x = 0; x < width; x++) {
      let sourceX = x; let sourceY = y;
      if ((x & 2) === 0 && (y & 2) === 0) {
        sourceX = Math.trunc(width / 2 + ((x & ~1) - width / 2) * 7 / 8);
        sourceY = Math.trunc(height / 2 + ((y & ~1) - height / 2) * 7 / 8);
      }
      table.offsets[x + y * width] = clamp(sourceX, 0, width - 1)
        + clamp(sourceY, 0, height - 1) * width;
    }
    return;
  }
  const halfWidth = Math.trunc(width / 2);
  const halfHeight = Math.trunc(height / 2);
  const maxDistance = Math.sqrt(width * width + height * height) / 2;
  for (let y = 0; y < height; y++) {
    for (let x = 0; x < width; x++) {
      const xd = x - halfWidth;
      const yd = y - halfHeight;
      let distance = Math.hypot(xd, yd);
      let angle = Math.atan2(yd, xd);
      let xOffset = 0;
      switch (config.effect) {
        case 3: angle += 0.1 - 0.2 * distance / maxDistance; distance *= 0.96; break;
        case 4: distance *= 0.99 * (1 - Math.sin(angle) / 32); angle += 0.03 * Math.sin(distance / maxDistance * Math.PI * 4); break;
        case 5: distance *= 0.94 + Math.cos(angle * 32) * 0.06; break;
        case 6: distance *= 1.01 + Math.cos(angle * 4) * 0.04; angle += 0.03 * Math.sin(distance / maxDistance * Math.PI * 4); break;
        case 8: angle += 0.1 * Math.sin(distance / maxDistance * Math.PI * 5); break;
        case 9: { const t = Math.sin(distance / maxDistance * Math.PI); distance -= 8 * t ** 5; break; }
        case 10: {
          const t = Math.sin(distance / maxDistance * Math.PI);
          distance -= 8 * t ** 5;
          const swirl = Math.cos(distance / maxDistance * Math.PI / 2);
          angle += 0.1 * swirl ** 3;
          break;
        }
        case 11: distance *= 0.95 + Math.cos(angle * 5 - Math.PI / 2.5) * 0.03; break;
        case 12: angle += 0.04; distance *= 0.96 + Math.cos(distance / maxDistance * Math.PI) * 0.05; break;
        case 13: {
          const t = Math.cos(distance / maxDistance * Math.PI);
          angle += 0.07 * t; distance *= 0.98 + t * 0.1; break;
        }
        case 14: angle += 0.1 - 0.2 * distance / maxDistance; distance *= 0.96; xOffset = 8; break;
        case 15: distance = maxDistance * 0.15; break;
        case 16: angle = Math.cos(angle * 3); break;
        case 17: distance *= 1 - (distance / maxDistance - 0.35) * 0.5; angle += 0.1; break;
      }
      const sampleX = halfWidth + Math.cos(angle) * distance + 0.5 + xOffset * width / 256;
      const sampleY = halfHeight + Math.sin(angle) * distance + 0.5;
      storeCoordinate(table, x + y * width, sampleX, sampleY, width, height, config.wrap);
    }
  }
}

function buildEvaluatedTable(
  context: AvsEffectContext,
  state: MovementState,
  table: MovementTable,
  global: AvsEelGlobalState,
): void {
  const { width, height } = context.input;
  const halfWidth = Math.trunc(width / 2);
  const halfHeight = Math.trunc(height / 2);
  const maxDistance = Math.sqrt(width * width + height * height) / 2;
  const vm = new AvsEelVm({ global, seed: state.randomState });
  vm.setHost({
    getosc: (band, span, channel) => avsAudioSample(context.audio, 'osc', band, span, channel),
    getspec: (band, span, channel) => avsAudioSample(context.audio, 'spec', band, span, channel),
  });
  vm.set('sw', width);
  vm.set('sh', height);
  // Resolve the per-point variables once: this loop runs width x height times
  // on every resize and preset load, and name lookups dominated it.
  const variableX = vm.bindVariable('x');
  const variableY = vm.bindVariable('y');
  const variableD = vm.bindVariable('d');
  const variableR = vm.bindVariable('r');
  const rectangular = state.config.effect === CUSTOM_EFFECT
    ? state.config.rectangular
    : EVALUATED_BUILTINS[state.config.effect]?.rectangular === true;

  for (let y = 0; y < height; y++) {
    for (let x = 0; x < width; x++) {
      const xd = x - halfWidth;
      const yd = y - halfHeight;
      setBinding(variableX, halfWidth === 0 ? 0 : xd / halfWidth);
      setBinding(variableY, halfHeight === 0 ? 0 : yd / halfHeight);
      setBinding(variableD, maxDistance === 0 ? 0 : Math.hypot(xd, yd) / maxDistance);
      setBinding(variableR, Math.atan2(yd, xd) + Math.PI / 2);
      vm.execute(state.program!);

      let sampleX: number;
      let sampleY: number;
      if (rectangular) {
        sampleX = (getBinding(variableX) + 1) * halfWidth;
        sampleY = (getBinding(variableY) + 1) * halfHeight;
      } else {
        const distance = getBinding(variableD) * maxDistance;
        const angle = getBinding(variableR) - Math.PI / 2;
        sampleX = halfWidth + Math.cos(angle) * distance;
        sampleY = halfHeight + Math.sin(angle) * distance;
      }
      // Evaluated Movement adds 0.5 only on its nearest-neighbour path.
      if (!table.bilinear) { sampleX += 0.5; sampleY += 0.5; }
      storeCoordinate(table, x + y * width, sampleX, sampleY, width, height, state.config.wrap);
    }
  }
}

function storeCoordinate(
  table: MovementTable,
  destination: number,
  rawX: number,
  rawY: number,
  width: number,
  height: number,
  wrap: boolean,
): void {
  if (!table.bilinear) {
    let x = Math.trunc(rawX);
    let y = Math.trunc(rawY);
    if (wrap) {
      x = modulo(x, width);
      y = modulo(y, height);
    } else {
      x = clamp(x, 0, width - 1);
      y = clamp(y, 0, height - 1);
    }
    table.offsets[destination] = x + y * width;
    return;
  }

  let x = Math.trunc(rawX);
  let y = Math.trunc(rawY);
  let xPartial = Math.trunc(32 * (rawX - x));
  let yPartial = Math.trunc(32 * (rawY - y));
  if (wrap) {
    x = modulo(x, width - 1);
    y = modulo(y, height - 1);
  } else {
    if (x < 0) { x = 0; xPartial = 0; }
    else if (x >= width - 1) { x = width - 2; xPartial = 31; }
    if (y < 0) { y = 0; yPartial = 0; }
    else if (y >= height - 1) { y = height - 2; yPartial = 31; }
  }

  // Reproduce r_trans.cpp's packed table and then unpack it exactly as its
  // portable BLEND4 render path does. This deliberately retains the odd signed
  // fractional behavior near wrapped negative coordinates.
  const packed = ((x + y * width) | (yPartial << 22) | (xPartial << 27)) >>> 0;
  table.offsets[destination] = packed & OFFSET_MASK;
  const xWeight = (packed >>> 24) & (31 << 3);
  const yWeight = (packed >>> 19) & (31 << 3);
  table.weightKeys[destination] = (xWeight << 2) | (yWeight >>> 3);
}

function renderInverse(context: AvsEffectContext, table: MovementTable, blend: boolean): void {
  const source = context.input.pixels;
  const output = context.output.pixels;
  const width = context.input.width;
  if (table.bilinear) {
    if (blend) {
      for (let i = 0; i < output.length; i++) {
        output[i] = averagePixel(source[i]!, sampleBilinear(
          source, table.offsets[i]!, width, table.weightKeys[i]!,
        ));
      }
    } else {
      for (let i = 0; i < output.length; i++) {
        output[i] = sampleBilinear(source, table.offsets[i]!, width, table.weightKeys[i]!);
      }
    }
  } else if (blend) {
    for (let i = 0; i < output.length; i++) output[i] = averagePixel(source[i]!, source[table.offsets[i]!]!);
  } else {
    for (let i = 0; i < output.length; i++) output[i] = source[table.offsets[i]!]!;
  }
}

function renderForward(context: AvsEffectContext, table: MovementTable, blend: boolean): void {
  const source = context.input.pixels;
  const output = context.output.pixels;
  if (blend) output.set(source); else output.fill(0);
  for (let i = 0; i < source.length; i++) {
    const destination = table.offsets[i]!;
    output[destination] = maximumPixel(source[i]!, output[destination]!);
  }
  if (blend) {
    for (let i = 0; i < output.length; i++) output[i] = averagePixel(output[i]!, source[i]!);
  }
}

/** Portable NO_MMX BLEND4 from r_defs.h, including its two-stage truncation. */
function sampleBilinear(source: Uint32Array, offset: number, width: number, weightKey: number): number {
  const blendTable = AVS_BLEND_TABLE;
  const w0 = BILINEAR_WEIGHTS[0][weightKey]!;
  const w1 = BILINEAR_WEIGHTS[1][weightKey]!;
  const w2 = BILINEAR_WEIGHTS[2][weightKey]!;
  const w3 = BILINEAR_WEIGHTS[3][weightKey]!;
  const p0 = source[offset]!;
  const p1 = source[offset + 1]!;
  const p2 = source[offset + width]!;
  const p3 = source[offset + width + 1]!;
  const low = blendTable[((p0 & 255) << 8) | w0]! + blendTable[((p1 & 255) << 8) | w1]!
    + blendTable[((p2 & 255) << 8) | w2]! + blendTable[((p3 & 255) << 8) | w3]!;
  const middle = blendTable[(((p0 >>> 8) & 255) << 8) | w0]! + blendTable[(((p1 >>> 8) & 255) << 8) | w1]!
    + blendTable[(((p2 >>> 8) & 255) << 8) | w2]! + blendTable[(((p3 >>> 8) & 255) << 8) | w3]!;
  const high = blendTable[(((p0 >>> 16) & 255) << 8) | w0]! + blendTable[(((p1 >>> 16) & 255) << 8) | w1]!
    + blendTable[(((p2 >>> 16) & 255) << 8) | w2]! + blendTable[(((p3 >>> 16) & 255) << 8) | w3]!;
  return (low & 255) | ((middle & 255) << 8) | ((high & 255) << 16);
}


function fillIdentity(table: MovementTable, width: number, height: number): void {
  for (let i = 0; i < width * height; i++) table.offsets[i] = i;
}
function averagePixel(a: number, b: number): number {
  return (((a >>> 1) & 0x007f7f7f) + ((b >>> 1) & 0x007f7f7f)) & 0x00ffffff;
}
function maximumPixel(a: number, b: number): number {
  return Math.max(a & 255, b & 255)
    | (Math.max((a >>> 8) & 255, (b >>> 8) & 255) << 8)
    | (Math.max((a >>> 16) & 255, (b >>> 16) & 255) << 16);
}
function nextRandom(state: MovementState): number {
  let x = state.randomState || 0x6d2b79f5;
  x ^= x << 13; x ^= x >>> 17; x ^= x << 5;
  state.randomState = x >>> 0;
  return state.randomState;
}
function modulo(value: number, modulus: number): number {
  if (modulus <= 0) return 0;
  const result = value % modulus;
  return result < 0 ? result + modulus : result;
}
function getBinding(binding: AvsEelVariableBinding): number {
  return binding.values[binding.index] ?? 0;
}
/** Same NaN/Infinity-to-zero rule as AvsEelVm.set. */
function setBinding(binding: AvsEelVariableBinding, value: number): void {
  binding.values[binding.index] = Number.isFinite(value) ? value : 0;
}
function readI32(payload: Uint8Array, offset: number, fallback: number): number {
  return offset + 4 <= payload.length
    ? new DataView(payload.buffer, payload.byteOffset, payload.byteLength).getInt32(offset, true)
    : fallback;
}
function asciiEquals(payload: Uint8Array, offset: number, value: string): boolean {
  if (offset + value.length > payload.length) return false;
  for (let i = 0; i < value.length; i++) if (payload[offset + i] !== value.charCodeAt(i)) return false;
  return true;
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
