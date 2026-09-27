import { avsAudioSample } from '../audio.ts';
import { compileAvsEel } from '../eel/compiler.ts';
import { AvsEelVm } from '../eel/vm.ts';
import type {
  AvsEelBoundExecutor,
  AvsEelProgram,
  AvsEelVariableBinding,
} from '../eel/types.ts';
import { AvsEffectRegistry, type AvsEffectContext } from '../executor.ts';
import { blendLine, blendLineRun } from './core.ts';
import type { AvsAudioFrame } from '../types.ts';

const TEXT = new TextDecoder('windows-1252');
const MAX_POINTS = 128 * 1024;

export interface AvsSuperScopeConfig {
  readonly point: string;
  readonly frame: string;
  readonly beat: string;
  readonly init: string;
  readonly channel: number;
  readonly colors: readonly number[];
  readonly lines: boolean;
}

interface SuperScopeState {
  readonly config: AvsSuperScopeConfig;
  readonly vm: AvsEelVm;
  readonly executors: readonly [AvsEelBoundExecutor | null, AvsEelBoundExecutor | null, AvsEelBoundExecutor | null, AvsEelBoundExecutor | null];
  readonly host: { audio: AvsAudioFrame };
  initialized: boolean;
  colorPosition: number;
  readonly centeredAudio: Uint8Array;
  readonly variables: SuperScopeVariables;
}

interface SuperScopeVariables {
  readonly n: AvsEelVariableBinding;
  readonly h: AvsEelVariableBinding;
  readonly w: AvsEelVariableBinding;
  readonly b: AvsEelVariableBinding;
  readonly blue: AvsEelVariableBinding;
  readonly green: AvsEelVariableBinding;
  readonly red: AvsEelVariableBinding;
  readonly skip: AvsEelVariableBinding;
  readonly linesize: AvsEelVariableBinding;
  readonly drawmode: AvsEelVariableBinding;
  readonly v: AvsEelVariableBinding;
  readonly i: AvsEelVariableBinding;
  readonly x: AvsEelVariableBinding;
  readonly y: AvsEelVariableBinding;
}

/** Decode built-in renderer 36's versioned binary configuration. */
export function decodeAvsSuperScope(payload: Uint8Array): AvsSuperScopeConfig {
  let offset = 0;
  let scripts: [string, string, string, string] = ['', '', '', ''];
  if (payload[0] === 1) {
    offset = 1;
    for (let i = 0; i < 4; i++) {
      const decoded = readString(payload, offset);
      scripts[i] = decoded.value;
      offset = decoded.next;
    }
  } else if (payload.length >= 1024) {
    scripts = [0, 256, 512, 768].map((start) => nulText(payload.subarray(start, start + 256))) as typeof scripts;
    offset = 1024;
  }

  const channel = readI32(payload, offset, 2); offset += 4;
  const declaredColors = readI32(payload, offset, 1); offset += 4;
  const colors: number[] = [];
  if (declaredColors >= 0 && declaredColors <= 16) {
    for (let i = 0; i < declaredColors && offset + 4 <= payload.length; i++, offset += 4) {
      colors.push(readI32(payload, offset, 0) & 0x00ffffff);
    }
  }
  const mode = readI32(payload, offset, 0);
  return {
    point: scripts[0], frame: scripts[1], beat: scripts[2], init: scripts[3],
    channel, colors, lines: mode !== 0,
  };
}

/** Register AVS SuperScope with persistent per-component EEL contexts. */
export function registerAvsSuperScope(
  registry: AvsEffectRegistry,
  global = registry.eelGlobal,
): AvsEffectRegistry {
  const states = new Map<string, SuperScopeState>();
  registry.registerBuiltin(36, (context) => {
    let state = states.get(context.component.path);
    if (!state) {
      const config = decodeAvsSuperScope(context.component.payload);
      const vm = new AvsEelVm({ global, seed: hashPath(context.component.path) });
      const host = { audio: context.audio };
      vm.setHost({
        getosc: (band, width, channel) => avsAudioSample(host.audio, 'osc', band, width, channel),
        getspec: (band, width, channel) => avsAudioSample(host.audio, 'spec', band, width, channel),
      });
      vm.set('n', 100);
      const programs = [
        compileOrNull(config.point), compileOrNull(config.frame),
        compileOrNull(config.beat), compileOrNull(config.init),
      ] as const;
      state = {
        config,
        vm,
        executors: [
          programs[0]?.bind(vm) ?? null,
          programs[1]?.bind(vm) ?? null,
          programs[2]?.bind(vm) ?? null,
          programs[3]?.bind(vm) ?? null,
        ],
        host,
        initialized: false,
        colorPosition: 0,
        centeredAudio: new Uint8Array(576),
        variables: bindVariables(vm),
      };
      states.set(context.component.path, state);
    }
    if (context.preinit) return;
    renderSuperScope(context, state.config, state);
  });
  return registry;
}

function renderSuperScope(context: AvsEffectContext, config: AvsSuperScopeConfig, state: SuperScopeState): void {
  if (config.colors.length === 0) return;
  const { vm } = state;
  const variables = state.variables;
  state.host.audio = context.audio;

  state.colorPosition++;
  if (state.colorPosition >= config.colors.length * 64) state.colorPosition = 0;
  const color = interpolatedColor(config.colors, state.colorPosition);
  setBinding(variables.h, context.input.height);
  setBinding(variables.w, context.input.width);
  setBinding(variables.b, context.beat ? 1 : 0);
  setBinding(variables.blue, (color & 255) / 255);
  setBinding(variables.green, ((color >>> 8) & 255) / 255);
  setBinding(variables.red, ((color >>> 16) & 255) / 255);
  setBinding(variables.skip, 0);
  setBinding(variables.linesize, (context.line.lineWidth >>> 0) & 255);
  setBinding(variables.drawmode, config.lines ? 1 : 0);

  if (!state.initialized) {
    execute(state.executors[3]);
    state.initialized = true;
  }
  execute(state.executors[1]);
  if (context.beat) execute(state.executors[2]);
  const executePoint = state.executors[0];
  if (!executePoint) return;

  const count = Math.min(MAX_POINTS, Math.trunc(getBinding(variables.n)));
  if (count <= 0) return;
  const data = scopeChannel(context, config.channel, state.centeredAudio);
  const xor = (config.channel & 4) !== 0 ? 0 : 128;
  runSuperScopePoints(context, variables, executePoint, data, xor, count);
}

/** Bound, allocation-free point driver; EEL and variable cells are resolved once. */
function runSuperScopePoints(
  context: AvsEffectContext,
  variables: SuperScopeVariables,
  executePoint: AvsEelBoundExecutor,
  data: Uint8Array,
  xor: number,
  count: number,
): void {
  const vValues = variables.v.values;
  const vIndex = variables.v.index;
  const iValues = variables.i.values;
  const iIndex = variables.i.index;
  const skipValues = variables.skip.values;
  const skipIndex = variables.skip.index;
  const xValues = variables.x.values;
  const xIndex = variables.x.index;
  const yValues = variables.y.values;
  const yIndex = variables.y.index;
  const blueValues = variables.blue.values;
  const blueIndex = variables.blue.index;
  const greenValues = variables.green.values;
  const greenIndex = variables.green.index;
  const redValues = variables.red.values;
  const redIndex = variables.red.index;
  const drawmodeValues = variables.drawmode.values;
  const drawmodeIndex = variables.drawmode.index;
  const linesizeValues = variables.linesize.values;
  const linesizeIndex = variables.linesize.index;
  const inputWidth = context.input.width;
  const inputHeight = context.input.height;
  let canDraw = false;
  let lastX = 0;
  let lastY = 0;
  for (let index = 0; index < count; index++) {
    const audioPosition = index * 576 / count;
    const sourceIndex = Math.trunc(audioPosition);
    const fraction = audioPosition - sourceIndex;
    // Native AVS reads one byte past its 576-byte array at the final sample for
    // some point counts. Clamp that undefined read for deterministic imports.
    const a = data[Math.min(575, sourceIndex)]! ^ xor;
    const b = data[Math.min(575, sourceIndex + 1)]! ^ xor;
    vValues[vIndex] = (a * (1 - fraction) + b * fraction) / 128 - 1;
    iValues[iIndex] = count === 1 ? 0 : index / (count - 1);
    skipValues[skipIndex] = 0;
    executePoint();
    const x = Math.trunc(((xValues[xIndex] ?? 0) + 1) * inputWidth * 0.5);
    const y = Math.trunc(((yValues[yIndex] ?? 0) + 1) * inputHeight * 0.5);
    if ((skipValues[skipIndex] ?? 0) < 0.00001) {
      const drawColor = makeByte(blueValues[blueIndex] ?? 0)
        | (makeByte(greenValues[greenIndex] ?? 0) << 8)
        | (makeByte(redValues[redIndex] ?? 0) << 16);
      if ((drawmodeValues[drawmodeIndex] ?? 0) < 0.00001) {
        drawPoint(context, x, y, drawColor);
      } else if (canDraw && (drawColor !== 0 || context.line.blendMode !== 1)) {
        drawLine(context, lastX, lastY, x, y, drawColor, Math.trunc((linesizeValues[linesizeIndex] ?? 0) + 0.5));
      }
    }
    canDraw = true;
    lastX = x;
    lastY = y;
  }
}

function scopeChannel(context: AvsEffectContext, selection: number, centered: Uint8Array): Uint8Array {
  const source = (selection & 4) !== 0 ? context.audio.spectrum : context.audio.waveform;
  const channel = selection & 3;
  if (channel < 2) return source[channel as 0 | 1];
  for (let i = 0; i < centered.length; i++) {
    centered[i] = (Math.trunc(signed(source[0][i]!) / 2) + Math.trunc(signed(source[1][i]!) / 2)) & 255;
  }
  return centered;
}

function drawPoint(context: AvsEffectContext, x: number, y: number, color: number): void {
  if (x < 0 || y < 0 || x >= context.input.width || y >= context.input.height) return;
  const index = x + y * context.input.width;
  context.input.pixels[index] = blendLine(color, context.input.pixels[index]!, context.line.blendMode, context.line.adjustableAlpha);
}

/**
 * Integer AVS line rasterizer, including its exclusive far endpoint.
 *
 * Each Bresenham step plots one lineWidth-long run (a row run for vertical,
 * horizontal and y-major lines, a column run for x-major lines). Runs are
 * clipped to [0, width) x [0, height) exactly as the per-pixel reject did,
 * including negative starts from `x1 - half`, then blended by one
 * blendLineRun() call that switches on the line mode once. A run never
 * revisits a pixel, and runs are emitted in the original plot order.
 */
function drawLine(
  context: AvsEffectContext,
  x1: number, y1: number, x2: number, y2: number,
  color: number, requestedWidth: number,
): void {
  const width = context.input.width;
  const height = context.input.height;
  const pixels = context.input.pixels;
  const mode = context.line.blendMode;
  const amount = context.line.adjustableAlpha;
  const dx = Math.abs(x2 - x1);
  const dy = Math.abs(y2 - y1);
  const lineWidth = clamp(requestedWidth, 1, 255);
  const half = Math.trunc(lineWidth / 2);

  if (dx === 0) {
    // Row bound stops at height - 1 (native quirk); columns [x1 - half, +lineWidth).
    let left = x1 - half;
    let right = x1 - half + lineWidth;
    if (left < 0) left = 0;
    if (right > width) right = width;
    if (!(left < right)) return;
    for (let y = Math.max(Math.min(y1, y2), 0); y < Math.min(Math.max(y1, y2), height - 1); y++) {
      const row = y * width;
      blendLineRun(pixels, row + left, row + right, 1, color, mode, amount);
    }
    return;
  }
  if (y1 === y2) {
    // Column bound stops at width - 1 (native quirk); rows [y1 - half, +lineWidth).
    const left = Math.max(Math.min(x1, x2), 0);
    const right = Math.min(Math.max(x1, x2), width - 1);
    if (!(left < right)) return;
    for (let y = y1 - half; y < y1 - half + lineWidth; y++) {
      if (y < 0 || y >= height) continue;
      const row = y * width;
      blendLineRun(pixels, row + left, row + right, 1, color, mode, amount);
    }
    return;
  }

  if (dy <= dx) {
    if (x2 < x1) { let t = x1; x1 = x2; x2 = t; t = y1; y1 = y2; y2 = t; }
    const yIncrement = y2 > y1 ? 1 : -1;
    let y = y1 - half;
    let decision = 2 * dy - dx;
    const east = 2 * dy;
    const northEast = decision - dx;
    while (x1 < x2) {
      if (x1 >= 0 && x1 < width) {
        let top = y;
        let bottom = y + lineWidth;
        if (top < 0) top = 0;
        if (bottom > height) bottom = height;
        if (top < bottom) blendLineRun(pixels, x1 + top * width, x1 + bottom * width, width, color, mode, amount);
      }
      if (decision < 0) decision += east;
      else { decision += northEast; y += yIncrement; }
      x1++;
    }
  } else {
    if (y2 < y1) { let t = x1; x1 = x2; x2 = t; t = y1; y1 = y2; y2 = t; }
    const xIncrement = x2 > x1 ? 1 : -1;
    let x = x1 - half;
    let decision = 2 * dx - dy;
    const east = 2 * dx;
    const northEast = decision - dy;
    while (y1 < y2) {
      if (y1 >= 0 && y1 < height) {
        let left = x;
        let right = x + lineWidth;
        if (left < 0) left = 0;
        if (right > width) right = width;
        if (left < right) {
          const row = y1 * width;
          blendLineRun(pixels, row + left, row + right, 1, color, mode, amount);
        }
      }
      if (decision < 0) decision += east;
      else { decision += northEast; x += xIncrement; }
      y1++;
    }
  }
}

function execute(executor: AvsEelBoundExecutor | null): number {
  return executor ? executor() : 0;
}
function bindVariables(vm: AvsEelVm): SuperScopeVariables {
  return {
    n: vm.bindVariable('n'), h: vm.bindVariable('h'), w: vm.bindVariable('w'), b: vm.bindVariable('b'),
    blue: vm.bindVariable('blue'), green: vm.bindVariable('green'), red: vm.bindVariable('red'),
    skip: vm.bindVariable('skip'), linesize: vm.bindVariable('linesize'), drawmode: vm.bindVariable('drawmode'),
    v: vm.bindVariable('v'), i: vm.bindVariable('i'), x: vm.bindVariable('x'), y: vm.bindVariable('y'),
  };
}
function getBinding(binding: AvsEelVariableBinding): number {
  return binding.values[binding.index] ?? 0;
}
function setBinding(binding: AvsEelVariableBinding, value: number): void {
  binding.values[binding.index] = Number.isFinite(value) ? value : 0;
}
function compileOrNull(source: string): AvsEelProgram | null {
  if (!source.trim()) return null;
  try { return compileAvsEel(source); } catch { return null; }
}
function interpolatedColor(colors: readonly number[], position: number): number {
  const index = Math.trunc(position / 64);
  const fraction = position & 63;
  const first = colors[index]!;
  const second = colors[(index + 1) % colors.length]!;
  const channel = (shift: number): number => Math.trunc(
    (((first >>> shift) & 255) * (63 - fraction) + ((second >>> shift) & 255) * fraction) / 64,
  );
  return channel(0) | (channel(8) << 8) | (channel(16) << 16);
}
function readString(payload: Uint8Array, offset: number): { value: string; next: number } {
  if (offset + 4 > payload.length) return { value: '', next: payload.length };
  const length = readU32(payload, offset, 0);
  const start = offset + 4;
  const end = Math.min(payload.length, start + length);
  return { value: nulText(payload.subarray(start, end)), next: end };
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
function nulText(bytes: Uint8Array): string {
  const end = bytes.indexOf(0);
  return TEXT.decode(end < 0 ? bytes : bytes.subarray(0, end));
}
function signed(value: number): number { return value < 128 ? value : value - 256; }
function makeByte(value: number): number {
  return value <= 0 ? 0 : value >= 1 ? 255 : Math.trunc(value * 255);
}
function clamp(value: number, minimum: number, maximum: number): number {
  return value < minimum ? minimum : value > maximum ? maximum : value;
}
function hashPath(path: string): number {
  let hash = 0x811c9dc5;
  for (let i = 0; i < path.length; i++) hash = Math.imul(hash ^ path.charCodeAt(i), 0x01000193);
  return hash >>> 0;
}
