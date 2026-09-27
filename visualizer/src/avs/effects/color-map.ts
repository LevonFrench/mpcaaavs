import { AvsEffectRegistry, type AvsEffectContext } from '../executor.ts';

export const AVS_COLOR_MAP_APE_ID = 'Color Map';

const FIXED_CONFIG_BYTES = 496;
const MAP_HEADER_BYTES = 60;
const MAP_COUNT = 8;
const POINT_BYTES = 12;

export interface AvsColorMapPoint {
  readonly position: number;
  readonly color: number;
  /** Opaque editor identity persisted by colormap.ape. */
  readonly id: number;
}

export interface AvsColorMap {
  readonly index: number;
  readonly enabled: boolean;
  readonly id: number;
  readonly filename: string;
  readonly points: readonly AvsColorMapPoint[];
}

export interface AvsColorMapConfig {
  /** 0 red, 1 green, 2 blue, 3 saturated (R+G+B)/2, 4 max, 5 average. */
  readonly key: number;
  /** 0 replace through 9 adjustable, in the native Color Map ordering. */
  readonly blendMode: number;
  /** 0 single, 1 beat-random, 2 beat-sequential. */
  readonly mapCycleMode: number;
  readonly adjustBlend: number;
  readonly dontSkipFastBeats: boolean;
  readonly cycleSpeed: number;
  readonly maps: readonly AvsColorMap[];
}

interface ColorMapState {
  readonly tables: readonly Uint32Array[];
  previous: number;
  target: number;
  progress: number;
  random: number;
}

/** Decode the native 496-byte header followed by eight variable point arrays. */
export function decodeAvsColorMap(payload: Uint8Array): AvsColorMapConfig {
  if (payload.length < FIXED_CONFIG_BYTES) return defaultConfig();
  const view = new DataView(payload.buffer, payload.byteOffset, payload.byteLength);
  const maps: AvsColorMap[] = [];
  let pointOffset = FIXED_CONFIG_BYTES;
  for (let index = 0; index < MAP_COUNT; index++) {
    const header = 16 + index * MAP_HEADER_BYTES;
    const count = view.getInt32(header + 4, true);
    const byteCount = count > 0 && count <= 0x10000 ? count * POINT_BYTES : -1;
    let points: AvsColorMapPoint[];
    if (byteCount < 0 || pointOffset + byteCount > payload.length) {
      points = defaultPoints();
    } else {
      points = [];
      for (let point = 0; point < count; point++, pointOffset += POINT_BYTES) {
        points.push({
          position: view.getUint32(pointOffset, true),
          color: view.getUint32(pointOffset + 4, true) & 0x00ffffff,
          id: view.getUint32(pointOffset + 8, true),
        });
      }
    }
    maps.push({
      index,
      enabled: count > 0 ? view.getInt32(header, true) !== 0 : index === 0,
      id: view.getUint32(header + 8, true),
      filename: nulText(payload.subarray(header + 12, header + MAP_HEADER_BYTES)),
      points,
    });
  }
  return {
    key: view.getInt32(0, true),
    blendMode: view.getInt32(4, true),
    mapCycleMode: view.getInt32(8, true),
    adjustBlend: payload[12]!,
    dontSkipFastBeats: payload[14]! !== 0,
    cycleSpeed: normalizeCycleSpeed(payload[15]!),
    maps,
  };
}

/** Build the exact byte-domain lookup table produced by the native APE. */
export function buildAvsColorMapTable(points: readonly AvsColorMapPoint[]): Uint32Array {
  const table = new Uint32Array(256);
  const sorted = points.length > 0
    ? [...points].sort((a, b) => a.position - b.position || a.color - b.color)
    : defaultPoints();
  const first = sorted[0]!;
  const firstPosition = clamp(first.position, 0, 255);
  table.fill(first.color & 0x00ffffff, 0, firstPosition);
  for (let i = 0; i + 1 < sorted.length; i++) {
    const left = sorted[i]!;
    const right = sorted[i + 1]!;
    const leftPosition = clamp(left.position, 0, 255);
    const rightPosition = clamp(right.position, 0, 255);
    const distance = rightPosition - leftPosition;
    if (distance <= 0) continue;
    const increment = Math.trunc(65536 / distance);
    let fraction = 0;
    for (let position = leftPosition; position <= rightPosition; position++) {
      // The DLL discards the low eight fractional bits before selecting its
      // 0..256 MMX weight, rather than using floating-point interpolation.
      const weight = Math.min(256, fraction >>> 8);
      table[position] = mix256(left.color, right.color, weight);
      fraction += increment;
    }
  }
  const last = sorted[sorted.length - 1]!;
  table.fill(last.color & 0x00ffffff, clamp(last.position, 0, 255), 256);
  return table;
}

/** Register the external APE under its exact fixed-width preset identifier. */
export function registerAvsColorMap(
  registry = new AvsEffectRegistry(),
): AvsEffectRegistry {
  const states = new Map<string, ColorMapState>();
  registry.registerApe(AVS_COLOR_MAP_APE_ID, (context) => {
    if (context.preinit) return;
    const config = decodedConfig(context.component.payload);
    let state = states.get(context.component.path);
    if (!state) {
      const initial = firstEnabled(config.maps);
      state = {
        tables: config.maps.map((map) => buildAvsColorMapTable(map.points)),
        previous: initial,
        target: initial,
        // load_config copies the variable tail into the object before fixing
        // pointers, so the first point's editor id also becomes this field.
        progress: readI32(context.component.payload, FIXED_CONFIG_BYTES + 8, 0),
        random: hashPath(context.component.path),
      };
      states.set(context.component.path, state);
    }
    const table = selectTable(config, state, context.beat);
    transform(context, config, table);
  });
  return registry;
}

/** Decoded configs by payload identity; payloads are replaced, never mutated, on edit. */
const decodedConfigs = new WeakMap<Uint8Array, AvsColorMapConfig>();

function decodedConfig(payload: Uint8Array): AvsColorMapConfig {
  let config = decodedConfigs.get(payload);
  if (!config) {
    config = decodeAvsColorMap(payload);
    decodedConfigs.set(payload, config);
  }
  return config;
}

function selectTable(config: AvsColorMapConfig, state: ColorMapState, beat: boolean): Uint32Array {
  if (config.mapCycleMode === 0) {
    state.progress = 0;
    return state.tables[state.previous]!;
  }
  state.target = modulo(state.target, MAP_COUNT);
  state.progress = Math.min(256, state.progress + config.cycleSpeed);
  if (beat && (!config.dontSkipFastBeats || state.progress === 256)) {
    const enabled = config.maps.filter((map) => map.enabled).map((map) => map.index);
    if (enabled.length > 0) {
      state.previous = state.target;
      if (config.mapCycleMode === 1) {
        do {
          state.random = xorshift32(state.random);
          state.target = state.random & 7;
        } while (!config.maps[state.target]!.enabled);
      } else {
        let candidate = state.target;
        do candidate = (candidate + 1) & 7; while (!config.maps[candidate]!.enabled);
        state.target = candidate;
      }
    }
    state.progress = 0;
  }
  if (state.progress === 0 || state.previous === state.target) return state.tables[state.previous]!;
  if (state.progress === 256) {
    state.previous = state.target;
    return state.tables[state.target]!;
  }
  const table = new Uint32Array(256);
  const previous = state.tables[state.previous]!;
  const target = state.tables[state.target]!;
  for (let i = 0; i < 256; i++) table[i] = mix256(previous[i]!, target[i]!, state.progress);
  return table;
}

/** Per-pixel colour keys, reused across frames at the same size. */
let keyScratch = new Uint8Array(0);

/**
 * Key and blend mode are loop-invariant, so each is dispatched once per frame:
 * one pass writes the key of every pixel (0 red, 1 green, 2 blue, 3
 * min(255, sum >> 1), 4 max, 5 sum / 3), then one loop per blend mode applies
 * the table per channel. Every mode's channel result is already 0..255 and
 * the output never keeps the destination's alpha byte.
 */
function transform(context: AvsEffectContext, config: AvsColorMapConfig, table: Uint32Array): void {
  const pixels = context.input.pixels;
  const count = pixels.length;
  // Any other key selects no table entry, which leaves every pixel untouched.
  if (config.key < 0 || config.key > 5) return;
  if (keyScratch.length < count) keyScratch = new Uint8Array(count);
  const keys = keyScratch;
  switch (config.key) {
    case 0: for (let i = 0; i < count; i++) keys[i] = (pixels[i]! >>> 16) & 255; break;
    case 1: for (let i = 0; i < count; i++) keys[i] = (pixels[i]! >>> 8) & 255; break;
    case 2: for (let i = 0; i < count; i++) keys[i] = pixels[i]! & 255; break;
    case 3:
      for (let i = 0; i < count; i++) {
        const pixel = pixels[i]!;
        const sum = (pixel & 255) + ((pixel >>> 8) & 255) + ((pixel >>> 16) & 255);
        keys[i] = sum >= 510 ? 255 : sum >>> 1;
      }
      break;
    case 4:
      for (let i = 0; i < count; i++) {
        const pixel = pixels[i]!;
        const blue = pixel & 255;
        const green = (pixel >>> 8) & 255;
        const red = (pixel >>> 16) & 255;
        const high = red > green ? red : green;
        keys[i] = high > blue ? high : blue;
      }
      break;
    default:
      for (let i = 0; i < count; i++) {
        const pixel = pixels[i]!;
        keys[i] = Math.trunc(((pixel & 255) + ((pixel >>> 8) & 255) + ((pixel >>> 16) & 255)) / 3);
      }
      break;
  }
  switch (config.blendMode) {
    case 0:
      for (let i = 0; i < count; i++) pixels[i] = table[keys[i]!]!;
      return;
    case 1:
      for (let i = 0; i < count; i++) {
        const s = table[keys[i]!]!;
        const d = pixels[i]!;
        const blue = (s & 255) + (d & 255);
        const green = ((s >>> 8) & 255) + ((d >>> 8) & 255);
        const red = ((s >>> 16) & 255) + ((d >>> 16) & 255);
        pixels[i] = (blue > 255 ? 255 : blue) | ((green > 255 ? 255 : green) << 8)
          | ((red > 255 ? 255 : red) << 16);
      }
      return;
    case 2:
    case 3: {
      const maximum = config.blendMode === 2;
      for (let i = 0; i < count; i++) {
        const s = table[keys[i]!]!;
        const d = pixels[i]!;
        const sb = s & 255; const sg = (s >>> 8) & 255; const sr = (s >>> 16) & 255;
        const db = d & 255; const dg = (d >>> 8) & 255; const dr = (d >>> 16) & 255;
        pixels[i] = maximum
          ? (sb > db ? sb : db) | ((sg > dg ? sg : dg) << 8) | ((sr > dr ? sr : dr) << 16)
          : (sb < db ? sb : db) | ((sg < dg ? sg : dg) << 8) | ((sr < dr ? sr : dr) << 16);
      }
      return;
    }
    case 4:
      for (let i = 0; i < count; i++) {
        const s = table[keys[i]!]!;
        const d = pixels[i]!;
        pixels[i] = (((s & 255) + (d & 255)) >>> 1)
          | ((((s >>> 8) & 255) + ((d >>> 8) & 255)) >>> 1 << 8)
          | ((((s >>> 16) & 255) + ((d >>> 16) & 255)) >>> 1 << 16);
      }
      return;
    case 5:
    case 6: {
      // 5: destination minus source, 6: source minus destination, floored at 0.
      const subtractSource = config.blendMode === 5;
      for (let i = 0; i < count; i++) {
        const s = table[keys[i]!]!;
        const d = pixels[i]!;
        const left = subtractSource ? d : s;
        const right = subtractSource ? s : d;
        const blue = (left & 255) - (right & 255);
        const green = ((left >>> 8) & 255) - ((right >>> 8) & 255);
        const red = ((left >>> 16) & 255) - ((right >>> 16) & 255);
        pixels[i] = (blue < 0 ? 0 : blue) | ((green < 0 ? 0 : green) << 8) | ((red < 0 ? 0 : red) << 16);
      }
      return;
    }
    case 7:
      for (let i = 0; i < count; i++) {
        const s = table[keys[i]!]!;
        const d = pixels[i]!;
        pixels[i] = (((s & 255) * (d & 255)) >>> 8)
          | ((((s >>> 8) & 255) * ((d >>> 8) & 255)) >>> 8 << 8)
          | ((((s >>> 16) & 255) * ((d >>> 16) & 255)) >>> 8 << 16);
      }
      return;
    case 8:
      for (let i = 0; i < count; i++) pixels[i] = (table[keys[i]!]! ^ pixels[i]!) & 0x00ffffff;
      return;
    case 9: {
      const amount = config.adjustBlend;
      const inverse = 256 - amount;
      for (let i = 0; i < count; i++) {
        const s = table[keys[i]!]!;
        const d = pixels[i]!;
        const blue = (((s & 255) * amount) >>> 8) + (((d & 255) * inverse) >>> 8);
        const green = ((((s >>> 8) & 255) * amount) >>> 8) + ((((d >>> 8) & 255) * inverse) >>> 8);
        const red = ((((s >>> 16) & 255) * amount) >>> 8) + ((((d >>> 16) & 255) * inverse) >>> 8);
        pixels[i] = (blue > 255 ? 255 : blue) | ((green > 255 ? 255 : green) << 8)
          | ((red > 255 ? 255 : red) << 16);
      }
      return;
    }
    default:
      // Unknown modes return the destination unchanged, which still drops alpha.
      for (let i = 0; i < count; i++) pixels[i] = pixels[i]! & 0x00ffffff;
  }
}

function mix256(left: number, right: number, rightWeight: number): number {
  return channels2(right, left, (r, l) => ((r * rightWeight) + (l * (256 - rightWeight))) >>> 8);
}
function channels2(a: number, b: number, fn: (a: number, b: number) => number): number {
  return (fn(a & 255, b & 255) & 255)
    | ((fn((a >>> 8) & 255, (b >>> 8) & 255) & 255) << 8)
    | ((fn((a >>> 16) & 255, (b >>> 16) & 255) & 255) << 16);
}
function defaultConfig(): AvsColorMapConfig {
  return {
    key: 0, blendMode: 0, mapCycleMode: 0, adjustBlend: 0,
    dontSkipFastBeats: false, cycleSpeed: 8,
    maps: Array.from({ length: MAP_COUNT }, (_, index) => ({
      index, enabled: index === 0, id: 0, filename: '', points: defaultPoints(),
    })),
  };
}
function defaultPoints(): AvsColorMapPoint[] {
  return [{ position: 0, color: 0, id: 0 }, { position: 255, color: 0xffffff, id: 1 }];
}
function normalizeCycleSpeed(raw: number): number {
  const signed = raw < 128 ? raw : raw - 256;
  if (signed === 0) return 8;
  return clamp(signed, 1, 64);
}
function readI32(payload: Uint8Array, offset: number, fallback: number): number {
  return offset + 4 <= payload.length
    ? new DataView(payload.buffer, payload.byteOffset, payload.byteLength).getInt32(offset, true)
    : fallback;
}
function firstEnabled(maps: readonly AvsColorMap[]): number {
  return maps.find((map) => map.enabled)?.index ?? 0;
}
function nulText(bytes: Uint8Array): string {
  const end = bytes.indexOf(0);
  return new TextDecoder('windows-1252').decode(end < 0 ? bytes : bytes.subarray(0, end));
}
function clamp(value: number, minimum: number, maximum: number): number {
  return value < minimum ? minimum : value > maximum ? maximum : value;
}
function modulo(value: number, divisor: number): number {
  const result = value % divisor;
  return result < 0 ? result + divisor : result;
}
function hashPath(path: string): number {
  let hash = 0x811c9dc5;
  for (let i = 0; i < path.length; i++) hash = Math.imul(hash ^ path.charCodeAt(i), 0x01000193);
  return hash >>> 0;
}
function xorshift32(value: number): number {
  let state = value || 0x6d2b79f5;
  state ^= state << 13; state ^= state >>> 17; state ^= state << 5;
  return state >>> 0;
}
