import { avsAudioSample } from '../audio.ts';
import { compileAvsEel } from '../eel/compiler.ts';
import type { AvsEelProgram } from '../eel/types.ts';
import { AvsEelVm } from '../eel/vm.ts';
import { AvsEffectRegistry, type AvsEffectContext } from '../executor.ts';
import { blendPixel } from '../framebuffer.ts';

const TEXT = new TextDecoder('windows-1252');

export interface AvsBumpConfig {
  readonly enabled: boolean;
  readonly onBeat: boolean;
  readonly beatDurationFrames: number;
  readonly depth: number;
  readonly beatDepth: number;
  readonly additive: boolean;
  readonly average: boolean;
  readonly frame: string;
  readonly beat: string;
  readonly init: string;
  readonly showLight: boolean;
  readonly invertDepth: boolean;
  /** Legacy payloads without this word default to percentage coordinates. */
  readonly oldStyle: boolean;
  /** Zero uses the current framebuffer; 1..8 select a global buffer. */
  readonly buffer: number;
}

interface BumpState {
  readonly vm: AvsEelVm;
  readonly frame: AvsEelProgram | null;
  readonly beat: AvsEelProgram | null;
  readonly init: AvsEelProgram | null;
  initialized: boolean;
  currentDepth: number;
  beatFrames: number;
}

/** Decode r_bump.cpp's fixed header, three strings, and versioned suffix. */
export function decodeAvsBump(payload: Uint8Array): AvsBumpConfig {
  let offset = 0;
  const read = (fallback: number): number => { const value = i32(payload, offset, fallback); offset += 4; return value; };
  const enabled = read(1) !== 0;
  const onBeat = read(0) !== 0;
  const beatDurationFrames = read(15);
  const depth = read(30);
  const beatDepth = read(100);
  const additive = read(0) !== 0;
  const average = read(0) !== 0;
  const scripts: string[] = [];
  for (let i = 0; i < 3; i++) {
    const decoded = readString(payload, offset);
    scripts.push(decoded.value); offset = decoded.next;
  }
  const showLight = read(0) !== 0;
  const invertDepth = read(0) !== 0;
  // r_bump.cpp explicitly selects old style when this field is absent.
  const oldStyle = offset + 4 <= payload.length ? read(0) !== 0 : true;
  const buffer = read(0);
  return {
    enabled, onBeat, beatDurationFrames, depth, beatDepth, additive, average,
    frame: scripts[0]!, beat: scripts[1]!, init: scripts[2]!,
    showLight, invertDepth, oldStyle, buffer,
  };
}

/** Register source-grounded Trans / Bump (built-in ID 29). */
export function registerAvsBump(registry: AvsEffectRegistry): AvsEffectRegistry {
  const states = new Map<string, BumpState>();
  registry.registerBuiltin(29, (context) => {
    const config = decodeAvsBump(context.component.payload);
    if (!config.enabled) return;
    let state = states.get(context.component.path);
    if (!state) {
      const vm = new AvsEelVm({ global: registry.eelGlobal, seed: hashPath(context.component.path) });
      vm.set('bi', 1);
      state = {
        vm,
        frame: compileOrNull(config.frame), beat: compileOrNull(config.beat), init: compileOrNull(config.init),
        initialized: false, currentDepth: config.depth, beatFrames: 0,
      };
      states.set(context.component.path, state);
    }
    if (context.preinit) return;
    const depthSurface = config.buffer === 0
      ? context.input
      : context.buffers.get(config.buffer - 1, context.input.width, context.input.height, false);
    if (!depthSurface) return;

    configureVm(state.vm, context);
    if (!state.initialized) { execute(state.init, state.vm); state.initialized = true; }
    execute(state.frame, state.vm);
    if (context.beat) execute(state.beat, state.vm);
    // Native AVS updates these after executing this frame's programs.
    state.vm.set('isbeat', context.beat ? -1 : 1);
    state.vm.set('islbeat', state.beatFrames ? -1 : 1);
    if (config.onBeat && context.beat) {
      state.currentDepth = config.beatDepth;
      state.beatFrames = config.beatDurationFrames;
    } else if (!state.beatFrames) state.currentDepth = config.depth;

    context.output.clear();
    const lightX = clamp(Math.trunc(state.vm.get('x') * context.input.width / (config.oldStyle ? 100 : 1)), 0, context.input.width);
    const lightY = clamp(Math.trunc(state.vm.get('y') * context.input.height / (config.oldStyle ? 100 : 1)), 0, context.input.height);
    if (config.showLight && lightX < context.input.width && lightY < context.input.height) {
      context.output.pixels[lightX + lightY * context.input.width] = 0x00ffffff;
    }
    const intensity = clamp(state.vm.get('bi'), 0, 1);
    state.vm.set('bi', intensity);
    state.currentDepth = Math.trunc(state.currentDepth * intensity);
    shadeBump(context, depthSurface.pixels, config, state.currentDepth, lightX, lightY);

    if (state.beatFrames) {
      state.beatFrames--;
      if (state.beatFrames) {
        const step = Math.trunc(Math.abs(config.depth - config.beatDepth) / config.beatDurationFrames);
        state.currentDepth += step * (config.beatDepth > config.depth ? -1 : 1);
      }
    }
    return { swap: true };
  });
  return registry;
}

function shadeBump(
  context: AvsEffectContext,
  depthPixels: Uint32Array,
  config: AvsBumpConfig,
  currentDepth: number,
  lightX: number,
  lightY: number,
): void {
  const { width, height } = context.input;
  const source = context.input.pixels;
  const output = context.output.pixels;
  const currentDepthBuffer = depthPixels === source;
  const scaledDepth = Math.trunc((currentDepth << 8) / 100);
  for (let y = 1; y < height - 1; y++) {
    const relativeY = y - lightY;
    for (let x = 1; x < width - 1; x++) {
      const index = x + y * width;
      const left = depthPixels[index - 1]!;
      const right = depthPixels[index + 1]!;
      const above = depthPixels[index - width]!;
      const below = depthPixels[index + width]!;
      if (currentDepthBuffer && !(left || right || above || below)) continue;
      let horizontal = depthOf(right, config.invertDepth) - depthOf(left, config.invertDepth) - (x - lightX);
      let vertical = depthOf(below, config.invertDepth) - depthOf(above, config.invertDepth) - relativeY;
      horizontal = 127 - Math.abs(horizontal);
      vertical = 127 - Math.abs(vertical);
      const original = source[index]!;
      const lit = horizontal <= 0 || vertical <= 0
        ? clamp254(original)
        : addLight(original, (horizontal * vertical * scaledDepth) >> 14);
      output[index] = config.additive
        ? blendPixel(lit, original, 'additive')
        : config.average ? blendPixel(lit, original, 'average') : lit;
    }
  }
}

function depthOf(pixel: number, invert: boolean): number {
  const depth = Math.max(pixel & 255, (pixel >>> 8) & 255, (pixel >>> 16) & 255);
  return invert ? 255 - depth : depth;
}

function addLight(pixel: number, amount: number): number {
  return Math.min((pixel & 255) + amount, 254)
    | (Math.min(((pixel >>> 8) & 255) + amount, 254) << 8)
    | (Math.min(((pixel >>> 16) & 255) + amount, 254) << 16);
}

function clamp254(pixel: number): number {
  return Math.min(pixel & 255, 254)
    | (Math.min((pixel >>> 8) & 255, 254) << 8)
    | (Math.min((pixel >>> 16) & 255, 254) << 16);
}

function configureVm(vm: AvsEelVm, context: AvsEffectContext): void {
  vm.setHost({
    getosc: (band, width, channel) => avsAudioSample(context.audio, 'osc', band, width, channel),
    getspec: (band, width, channel) => avsAudioSample(context.audio, 'spec', band, width, channel),
  });
}

function readString(payload: Uint8Array, offset: number): { value: string; next: number } {
  if (offset + 4 > payload.length) return { value: '', next: payload.length };
  const length = i32(payload, offset, 0);
  const start = offset + 4;
  if (length <= 0 || start + length > payload.length) return { value: '', next: start };
  return { value: nulText(payload.subarray(start, start + length)), next: start + length };
}

function compileOrNull(source: string): AvsEelProgram | null {
  if (!source.trim()) return null;
  try { return compileAvsEel(source); } catch { return null; }
}
function execute(program: AvsEelProgram | null, vm: AvsEelVm): number { return program ? vm.execute(program) : 0; }
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
