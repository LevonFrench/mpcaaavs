import { AvsEffectRegistry, type AvsEffectContext } from '../executor.ts';

export const AVS_CHANNEL_SHIFT_APE_ID = 'Channel Shift';
export const AVS_COLOR_REDUCTION_APE_ID = 'Color Reduction';
export const AVS_MULTIPLIER_APE_ID = 'Multiplier';

export const AVS_CHANNEL_SHIFT_MODES = [1183, 1020, 1018, 1022, 1019, 1021] as const;

export interface AvsChannelShiftConfig {
  readonly mode: number;
  readonly randomizeOnBeat: boolean;
}

export interface AvsColorReductionConfig {
  readonly legacyFilename: string;
  readonly levels: number;
}

export interface AvsMultiplierConfig {
  readonly mode: number;
}

export interface AvsChannelShiftState {
  mode: number;
  randomState: number;
}

export function createAvsChannelShiftState(config: AvsChannelShiftConfig, path: string): AvsChannelShiftState {
  return { mode: config.mode, randomState: hashPath(path) };
}

/** CPU-resolved compact state shared by the exact CPU and future GPU schedulers. */
export function resolveAvsChannelShiftMode(
  state: AvsChannelShiftState, config: AvsChannelShiftConfig, beat: boolean,
): number {
  if (beat && config.randomizeOnBeat) {
    state.randomState = xorshift32(state.randomState);
    state.mode = AVS_CHANNEL_SHIFT_MODES[state.randomState % AVS_CHANNEL_SHIFT_MODES.length]!;
  }
  return state.mode;
}

/** Decode the native two-int Channel Shift APE configuration. */
export function decodeAvsChannelShift(payload: Uint8Array): AvsChannelShiftConfig {
  const native = new Uint8Array(8);
  const view = new DataView(native.buffer);
  view.setInt32(0, 1020, true);
  view.setInt32(4, 1, true);
  // The native loader accepts partial structs, but ignores oversized payloads.
  if (payload.length <= native.length) native.set(payload);
  return {
    mode: view.getInt32(0, true),
    randomizeOnBeat: view.getInt32(4, true) !== 0,
  };
}

/** Decode the native MAX_PATH filename plus trailing level integer. */
export function decodeAvsColorReduction(payload: Uint8Array): AvsColorReductionConfig {
  // load_config() accepts only the complete 264-byte struct and zeroes it on
  // every other length. The filename was never used by the renderer.
  if (payload.length !== 264) return { legacyFilename: '', levels: 0 };
  return {
    legacyFilename: nulText(payload.subarray(0, 260)),
    levels: readI32(payload, 260, 0),
  };
}

/** Decode the native one-int Multiplier APE configuration. */
export function decodeAvsMultiplier(payload: Uint8Array): AvsMultiplierConfig {
  return { mode: payload.length === 4 ? readI32(payload, 0, 0) : 0 };
}

/** Register the named built-in APEs exercised by the bundled Winamp corpus. */
export function registerAvsNamedApeEffects(
  registry = new AvsEffectRegistry(),
): AvsEffectRegistry {
  const shifts = new Map<string, AvsChannelShiftState>();

  registry.registerApe(AVS_CHANNEL_SHIFT_APE_ID, (context) => {
    if (context.preinit) return;
    const config = decodeAvsChannelShift(context.component.payload);
    let state = shifts.get(context.component.path);
    if (!state) {
      state = createAvsChannelShiftState(config, context.component.path);
      shifts.set(context.component.path, state);
    }
    shiftChannels(context, resolveAvsChannelShiftMode(state, config, context.beat));
  });

  registry.registerApe(AVS_COLOR_REDUCTION_APE_ID, (context) => {
    if (context.preinit) return;
    reduceColors(context, decodeAvsColorReduction(context.component.payload).levels);
  });

  registry.registerApe(AVS_MULTIPLIER_APE_ID, (context) => {
    if (context.preinit) return;
    multiplyColors(context, decodeAvsMultiplier(context.component.payload).mode);
  });

  return registry;
}

function shiftChannels(context: AvsEffectContext, mode: number): void {
  // Resource IDs are persisted directly. Unknown values fall through to RGB
  // in r_chanshift.cpp; 1023 occurs twice in the corpus and is therefore a
  // deliberate no-op, not an unsupported configuration.
  if (mode === 1183 || !AVS_CHANNEL_SHIFT_MODES.includes(mode as typeof AVS_CHANNEL_SHIFT_MODES[number])) return;
  for (let i = 0; i < context.input.pixels.length; i++) {
    const pixel = context.input.pixels[i]!;
    const red = (pixel >>> 16) & 255;
    const green = (pixel >>> 8) & 255;
    const blue = pixel & 255;
    let next: readonly [number, number, number];
    switch (mode) {
      case 1020: next = [red, blue, green]; break; // RBG
      case 1018: next = [green, blue, red]; break; // GBR
      case 1022: next = [green, red, blue]; break; // GRB
      case 1019: next = [blue, red, green]; break; // BRG
      case 1021: next = [blue, green, red]; break; // BGR
      default: next = [red, green, blue]; break;
    }
    context.input.pixels[i] = (next[0] << 16) | (next[1] << 8) | next[2];
  }
}

function reduceColors(context: AvsEffectContext, rawLevels: number): void {
  const levels = clamp(Math.trunc(rawLevels), 0, 8);
  const mask = levels === 0 ? 0 : (0xff << (8 - levels)) & 0xff;
  const rgbMask = mask | (mask << 8) | (mask << 16);
  // The original backwards four-pixel assembly loop branches before its last
  // AND block, leaving pixels 0..3 untouched.
  for (let i = 4; i < context.input.pixels.length; i++) {
    context.input.pixels[i] = context.input.pixels[i]! & rgbMask;
  }
}

function multiplyColors(context: AvsEffectContext, mode: number): void {
  const pixels = context.input.pixels;
  if (mode === 0 || mode === 7) {
    // Scalar source loop decrements before processing and exits at index zero.
    for (let i = pixels.length - 1; i >= 1; i--) {
      const pixel = pixels[i]! & 0x00ffffff;
      pixels[i] = mode === 0
        ? pixel === 0 ? 0 : 0xffffff
        : pixel === 0xffffff ? 0xffffff : 0;
    }
    return;
  }
  if (mode < 1 || mode > 6) return;
  // MMX source processes two pixels per iteration; an odd tail is untouched.
  const end = pixels.length - (pixels.length & 1);
  for (let i = 0; i < end; i++) {
    const pixel = pixels[i]!;
    if (mode <= 3) {
      const factor = 1 << (4 - mode); // modes 1,2,3 => x8,x4,x2
      pixels[i] = channels(pixel, (value) => Math.min(255, value * factor));
    } else {
      const shift = mode - 3; // modes 4,5,6 => /2,/4,/8
      pixels[i] = channels(pixel, (value) => value >>> shift);
    }
  }
}

function channels(pixel: number, fn: (value: number) => number): number {
  const blue = fn(pixel & 255);
  const green = fn((pixel >>> 8) & 255);
  const red = fn((pixel >>> 16) & 255);
  return blue | (green << 8) | (red << 16);
}

function readI32(payload: Uint8Array, offset: number, fallback: number): number {
  return offset + 4 <= payload.length
    ? new DataView(payload.buffer, payload.byteOffset, payload.byteLength).getInt32(offset, true)
    : fallback;
}
function nulText(bytes: Uint8Array): string {
  const end = bytes.indexOf(0);
  return new TextDecoder('windows-1252').decode(end < 0 ? bytes : bytes.subarray(0, end));
}
function clamp(value: number, minimum: number, maximum: number): number {
  return value < minimum ? minimum : value > maximum ? maximum : value;
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
