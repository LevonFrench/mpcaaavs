import { avsAudioSample } from '../audio.ts';
import { compileAvsEel } from '../eel/compiler.ts';
import { AvsEelVm } from '../eel/vm.ts';
import type { AvsEelProgram, AvsEelVariableBinding } from '../eel/types.ts';
import { AvsEffectRegistry, type AvsEffectContext } from '../executor.ts';
import { AVS_BLEND_TABLE } from '../framebuffer.ts';

const TEXT = new TextDecoder('windows-1252');

export interface AvsDynamicMovementConfig {
  readonly point: string;
  readonly frame: string;
  readonly beat: string;
  readonly init: string;
  readonly bilinear: boolean;
  readonly rectangular: boolean;
  readonly gridWidth: number;
  readonly gridHeight: number;
  readonly blend: boolean;
  readonly wrap: boolean;
  /** Zero selects the current framebuffer; 1..8 select a global buffer. */
  readonly buffer: number;
  readonly noMove: boolean;
}

interface DynamicMovementVariables {
  readonly x: AvsEelVariableBinding;
  readonly y: AvsEelVariableBinding;
  readonly d: AvsEelVariableBinding;
  readonly r: AvsEelVariableBinding;
  readonly w: AvsEelVariableBinding;
  readonly h: AvsEelVariableBinding;
  readonly b: AvsEelVariableBinding;
  readonly alpha: AvsEelVariableBinding;
}

interface DynamicMovementState {
  readonly config: AvsDynamicMovementConfig;
  readonly vm: AvsEelVm;
  readonly programs: readonly [AvsEelProgram | null, AvsEelProgram | null, AvsEelProgram | null, AvsEelProgram | null];
  /** EEL variables resolved once, so the per-grid-point loop skips name lookups. */
  readonly variables: DynamicMovementVariables;
  /** Audio read by the once-created getosc/getspec host closures. */
  readonly host: { audio: AvsEffectContext['audio'] };
  gridX: Float64Array;
  gridY: Float64Array;
  gridAlpha: Float64Array;
  cellX: Uint16Array;
  fractionX: Float64Array;
  cellY: Uint16Array;
  fractionY: Float64Array;
  initialized: boolean;
}

export function decodeAvsDynamicMovement(payload: Uint8Array): AvsDynamicMovementConfig {
  let offset = 0;
  let scripts: [string, string, string, string] = ['', '', '', ''];
  if (payload[0] === 1) {
    offset = 1;
    for (let i = 0; i < 4; i++) {
      const value = readString(payload, offset);
      scripts[i] = value.value;
      offset = value.next;
    }
  } else if (payload.length >= 1024) {
    scripts = [0, 256, 512, 768].map((start) => nulText(payload.subarray(start, start + 256))) as typeof scripts;
    offset = 1024;
  }
  const read = (fallback: number): number => { const value = i32(payload, offset, fallback); offset += 4; return value; };
  return {
    point: scripts[0], frame: scripts[1], beat: scripts[2], init: scripts[3],
    bilinear: read(1) !== 0,
    rectangular: read(0) !== 0,
    gridWidth: read(16),
    gridHeight: read(16),
    blend: read(0) !== 0,
    wrap: read(0) !== 0,
    buffer: read(0),
    noMove: read(0) !== 0,
  };
}

/** Dynamic Movement (ID 43), preserving its coarse-grid EEL execution model. */
export function registerAvsDynamicMovement(registry: AvsEffectRegistry): AvsEffectRegistry {
  const states = new Map<string, DynamicMovementState>();
  registry.registerBuiltin(43, (context) => {
    let state = states.get(context.component.path);
    if (!state) {
      const config = decodeAvsDynamicMovement(context.component.payload);
      const vm = new AvsEelVm({ global: registry.eelGlobal, seed: hashPath(context.component.path) });
      const host = { audio: context.audio };
      vm.setHost({
        getosc: (band, width, channel) => avsAudioSample(host.audio, 'osc', band, width, channel),
        getspec: (band, width, channel) => avsAudioSample(host.audio, 'spec', band, width, channel),
      });
      state = {
        config,
        vm,
        variables: {
          x: vm.bindVariable('x'), y: vm.bindVariable('y'), d: vm.bindVariable('d'), r: vm.bindVariable('r'),
          w: vm.bindVariable('w'), h: vm.bindVariable('h'), b: vm.bindVariable('b'), alpha: vm.bindVariable('alpha'),
        },
        host,
        programs: [
          compileOrNull(config.point), compileOrNull(config.frame),
          compileOrNull(config.beat), compileOrNull(config.init),
        ],
        gridX: new Float64Array(0),
        gridY: new Float64Array(0),
        gridAlpha: new Float64Array(0),
        cellX: new Uint16Array(0),
        fractionX: new Float64Array(0),
        cellY: new Uint16Array(0),
        fractionY: new Float64Array(0),
        initialized: false,
      };
      states.set(context.component.path, state);
    }
    if (context.preinit) return;
    return renderDynamicMovement(context, state.config, state);
  });
  return registry;
}

function renderDynamicMovement(
  context: AvsEffectContext,
  config: AvsDynamicMovementConfig,
  state: DynamicMovementState,
): { swap: boolean } | void {
  const source = config.buffer === 0
    ? context.input
    : context.buffers.get(config.buffer - 1, context.input.width, context.input.height, false);
  if (!source) return;
  const vm = state.vm;
  const variables = state.variables;
  state.host.audio = context.audio;
  setBinding(variables.w, context.input.width);
  setBinding(variables.h, context.input.height);
  setBinding(variables.b, context.beat ? 1 : 0);
  setBinding(variables.alpha, 0.5);
  if (!state.initialized) { execute(state.programs[3], vm); state.initialized = true; }
  execute(state.programs[1], vm);
  if (context.beat) execute(state.programs[2], vm);

  const columns = clamp(Math.trunc(config.gridWidth) + 1, 2, 256);
  const rows = clamp(Math.trunc(config.gridHeight) + 1, 2, 256);
  const gridSize = columns * rows;
  if (state.gridX.length !== gridSize) {
    state.gridX = new Float64Array(gridSize);
    state.gridY = new Float64Array(gridSize);
    state.gridAlpha = new Float64Array(gridSize);
  }
  const gridX = state.gridX;
  const gridY = state.gridY;
  const gridAlpha = state.gridAlpha;
  const width = context.input.width;
  const height = context.input.height;
  prepareInterpolationAxis(state, width, height, columns, rows);
  const radius = Math.sqrt(width * width + height * height) * 0.5;
  for (let gy = 0; gy < rows; gy++) {
    const screenY = gy * height / (rows - 1);
    const normalizedY = (screenY - height * 0.5) * (2 / height);
    for (let gx = 0; gx < columns; gx++) {
      const screenX = gx * width / (columns - 1);
      const normalizedX = (screenX - width * 0.5) * (2 / width);
      setBinding(variables.x, normalizedX);
      setBinding(variables.y, normalizedY);
      setBinding(variables.d, Math.hypot(screenX - width * 0.5, screenY - height * 0.5) / radius);
      setBinding(variables.r, Math.atan2(screenY - height * 0.5, screenX - width * 0.5) + Math.PI * 0.5);
      execute(state.programs[0], vm);
      let x: number;
      let y: number;
      if (config.rectangular) {
        x = (getBinding(variables.x) + 1) * width * 0.5;
        y = (getBinding(variables.y) + 1) * height * 0.5;
      } else {
        const distance = getBinding(variables.d) * radius;
        const angle = getBinding(variables.r) - Math.PI * 0.5;
        x = width * 0.5 + Math.cos(angle) * distance;
        y = height * 0.5 + Math.sin(angle) * distance;
      }
      const index = gx + gy * columns;
      gridX[index] = x;
      gridY[index] = y;
      gridAlpha[index] = clamp(getBinding(variables.alpha), 0, 1);
    }
  }

  const cellXs = state.cellX;
  const fractionXs = state.fractionX;
  const cellYs = state.cellY;
  const fractionYs = state.fractionY;
  if (!config.noMove && !config.bilinear) {
    renderNearestGrid(
      context, config, source.pixels, gridX, gridY, gridAlpha,
      cellXs, fractionXs, cellYs, fractionYs, columns,
    );
    return { swap: true };
  }
  if (!config.noMove) {
    if (config.blend) {
      renderBilinearBlendGrid(
        context, source.pixels, gridX, gridY, gridAlpha,
        cellXs, fractionXs, cellYs, fractionYs, columns, config.wrap,
      );
    } else {
      renderBilinearReplaceGrid(
        context, source.pixels, gridX, gridY,
        cellXs, fractionXs, cellYs, fractionYs, columns, config.wrap,
      );
    }
    return { swap: true };
  }
  renderNoMoveGrid(
    context, config.buffer === 0 ? null : source.pixels, gridAlpha,
    cellXs, fractionXs, cellYs, fractionYs, columns,
  );
  return;
}

function renderNoMoveGrid(
  context: AvsEffectContext,
  maskSource: Uint32Array | null,
  gridAlpha: Float64Array,
  cellXs: Uint16Array,
  fractionXs: Float64Array,
  cellYs: Uint16Array,
  fractionYs: Float64Array,
  columns: number,
): void {
  const width = context.input.width;
  const height = context.input.height;
  const input = context.input.pixels;
  const blendTable = AVS_BLEND_TABLE;
  let index = 0;
  for (let y = 0; y < height; y++) {
    const cellY = cellYs[y]!;
    const fy = fractionYs[y]!;
    const inverseY = 1 - fy;
    const row = cellY * columns;
    for (let x = 0; x < width; x++, index++) {
      const fx = fractionXs[x]!;
      const topLeft = cellXs[x]! + row;
      const topRight = topLeft + 1;
      const bottomLeft = topLeft + columns;
      const bottomRight = bottomLeft + 1;
      const rawAlpha = (gridAlpha[topLeft]! + (gridAlpha[topRight]! - gridAlpha[topLeft]!) * fx) * inverseY
        + (gridAlpha[bottomLeft]! + (gridAlpha[bottomRight]! - gridAlpha[bottomLeft]!) * fx) * fy;
      const alpha = Math.trunc(clamp(rawAlpha, 0, 1) * 255);
      const inverseAlpha = 255 - alpha;
      const source = maskSource?.[index] ?? 0;
      const current = input[index]!;
      const low = blendTable[((source & 255) << 8) | alpha]!
        + blendTable[((current & 255) << 8) | inverseAlpha]!;
      const middle = blendTable[(((source >>> 8) & 255) << 8) | alpha]!
        + blendTable[(((current >>> 8) & 255) << 8) | inverseAlpha]!;
      const high = blendTable[(((source >>> 16) & 255) << 8) | alpha]!
        + blendTable[(((current >>> 16) & 255) << 8) | inverseAlpha]!;
      input[index] = low | (middle << 8) | (high << 16);
    }
  }
}

function renderBilinearReplaceGrid(
  context: AvsEffectContext,
  source: Uint32Array,
  gridX: Float64Array,
  gridY: Float64Array,
  cellXs: Uint16Array,
  fractionXs: Float64Array,
  cellYs: Uint16Array,
  fractionYs: Float64Array,
  columns: number,
  wrap: boolean,
): void {
  const width = context.input.width;
  const height = context.input.height;
  const destination = context.output.pixels;
  const maxX = Math.max(0, width - 2);
  const maxY = Math.max(0, height - 2);
  const spanX = Math.max(1, maxX);
  const spanY = Math.max(1, maxY);
  const blendTable = AVS_BLEND_TABLE;
  let index = 0;
  for (let y = 0; y < height; y++) {
    const cellY = cellYs[y]!;
    const fy = fractionYs[y]!;
    const inverseY = 1 - fy;
    const row = cellY * columns;
    for (let x = 0; x < width; x++, index++) {
      const fx = fractionXs[x]!;
      const topLeft = cellXs[x]! + row;
      const topRight = topLeft + 1;
      const bottomLeft = topLeft + columns;
      const bottomRight = bottomLeft + 1;
      let mappedX = (gridX[topLeft]! + (gridX[topRight]! - gridX[topLeft]!) * fx) * inverseY
        + (gridX[bottomLeft]! + (gridX[bottomRight]! - gridX[bottomLeft]!) * fx) * fy;
      let mappedY = (gridY[topLeft]! + (gridY[topRight]! - gridY[topLeft]!) * fx) * inverseY
        + (gridY[bottomLeft]! + (gridY[bottomRight]! - gridY[bottomLeft]!) * fx) * fy;
      if (wrap) {
        mappedX = wrapCoordinate(mappedX, spanX);
        mappedY = wrapCoordinate(mappedY, spanY);
      } else {
        mappedX = clamp(mappedX, 0, maxX);
        mappedY = clamp(mappedY, 0, maxY);
      }
      const ix = Math.trunc(mappedX);
      const iy = Math.trunc(mappedY);
      if (width < 2 || height < 2) {
        destination[index] = source[ix + iy * width]!;
        continue;
      }
      const sampleX = Math.trunc((mappedX - ix) * 256) & 255;
      const sampleY = Math.trunc((mappedY - iy) * 256) & 255;
      const inverseX = 255 - sampleX;
      const inverseSampleY = 255 - sampleY;
      const weight0 = blendTable[(inverseX << 8) | inverseSampleY]!;
      const weight1 = blendTable[(sampleX << 8) | inverseSampleY]!;
      const weight2 = blendTable[(inverseX << 8) | sampleY]!;
      const weight3 = blendTable[(sampleX << 8) | sampleY]!;
      const offset = ix + iy * width;
      const pixel0 = source[offset]!;
      const pixel1 = source[offset + 1]!;
      const pixel2 = source[offset + width]!;
      const pixel3 = source[offset + width + 1]!;
      const low = blendTable[((pixel0 & 255) << 8) | weight0]!
        + blendTable[((pixel1 & 255) << 8) | weight1]!
        + blendTable[((pixel2 & 255) << 8) | weight2]!
        + blendTable[((pixel3 & 255) << 8) | weight3]!;
      const middle = blendTable[(((pixel0 >>> 8) & 255) << 8) | weight0]!
        + blendTable[(((pixel1 >>> 8) & 255) << 8) | weight1]!
        + blendTable[(((pixel2 >>> 8) & 255) << 8) | weight2]!
        + blendTable[(((pixel3 >>> 8) & 255) << 8) | weight3]!;
      const high = blendTable[(((pixel0 >>> 16) & 255) << 8) | weight0]!
        + blendTable[(((pixel1 >>> 16) & 255) << 8) | weight1]!
        + blendTable[(((pixel2 >>> 16) & 255) << 8) | weight2]!
        + blendTable[(((pixel3 >>> 16) & 255) << 8) | weight3]!;
      destination[index] = (low & 255) | ((middle & 255) << 8) | ((high & 255) << 16);
    }
  }
}

function renderBilinearBlendGrid(
  context: AvsEffectContext,
  source: Uint32Array,
  gridX: Float64Array,
  gridY: Float64Array,
  gridAlpha: Float64Array,
  cellXs: Uint16Array,
  fractionXs: Float64Array,
  cellYs: Uint16Array,
  fractionYs: Float64Array,
  columns: number,
  wrap: boolean,
): void {
  const width = context.input.width;
  const height = context.input.height;
  const input = context.input.pixels;
  const destination = context.output.pixels;
  const maxX = Math.max(0, width - 2);
  const maxY = Math.max(0, height - 2);
  const spanX = Math.max(1, maxX);
  const spanY = Math.max(1, maxY);
  const blendTable = AVS_BLEND_TABLE;
  let index = 0;
  for (let y = 0; y < height; y++) {
    const cellY = cellYs[y]!;
    const fy = fractionYs[y]!;
    const inverseY = 1 - fy;
    const row = cellY * columns;
    for (let x = 0; x < width; x++, index++) {
      const fx = fractionXs[x]!;
      const topLeft = cellXs[x]! + row;
      const topRight = topLeft + 1;
      const bottomLeft = topLeft + columns;
      const bottomRight = bottomLeft + 1;
      let mappedX = (gridX[topLeft]! + (gridX[topRight]! - gridX[topLeft]!) * fx) * inverseY
        + (gridX[bottomLeft]! + (gridX[bottomRight]! - gridX[bottomLeft]!) * fx) * fy;
      let mappedY = (gridY[topLeft]! + (gridY[topRight]! - gridY[topLeft]!) * fx) * inverseY
        + (gridY[bottomLeft]! + (gridY[bottomRight]! - gridY[bottomLeft]!) * fx) * fy;
      if (wrap) {
        mappedX = wrapCoordinate(mappedX, spanX);
        mappedY = wrapCoordinate(mappedY, spanY);
      } else {
        mappedX = clamp(mappedX, 0, maxX);
        mappedY = clamp(mappedY, 0, maxY);
      }
      const ix = Math.trunc(mappedX);
      const iy = Math.trunc(mappedY);
      let sampled: number;
      if (width < 2 || height < 2) {
        sampled = source[ix + iy * width]!;
      } else {
        const sampleX = Math.trunc((mappedX - ix) * 256) & 255;
        const sampleY = Math.trunc((mappedY - iy) * 256) & 255;
        const inverseX = 255 - sampleX;
        const inverseSampleY = 255 - sampleY;
        const weight0 = blendTable[(inverseX << 8) | inverseSampleY]!;
        const weight1 = blendTable[(sampleX << 8) | inverseSampleY]!;
        const weight2 = blendTable[(inverseX << 8) | sampleY]!;
        const weight3 = blendTable[(sampleX << 8) | sampleY]!;
        const offset = ix + iy * width;
        const pixel0 = source[offset]!;
        const pixel1 = source[offset + 1]!;
        const pixel2 = source[offset + width]!;
        const pixel3 = source[offset + width + 1]!;
        const low = blendTable[((pixel0 & 255) << 8) | weight0]!
          + blendTable[((pixel1 & 255) << 8) | weight1]!
          + blendTable[((pixel2 & 255) << 8) | weight2]!
          + blendTable[((pixel3 & 255) << 8) | weight3]!;
        const middle = blendTable[(((pixel0 >>> 8) & 255) << 8) | weight0]!
          + blendTable[(((pixel1 >>> 8) & 255) << 8) | weight1]!
          + blendTable[(((pixel2 >>> 8) & 255) << 8) | weight2]!
          + blendTable[(((pixel3 >>> 8) & 255) << 8) | weight3]!;
        const high = blendTable[(((pixel0 >>> 16) & 255) << 8) | weight0]!
          + blendTable[(((pixel1 >>> 16) & 255) << 8) | weight1]!
          + blendTable[(((pixel2 >>> 16) & 255) << 8) | weight2]!
          + blendTable[(((pixel3 >>> 16) & 255) << 8) | weight3]!;
        sampled = (low & 255) | ((middle & 255) << 8) | ((high & 255) << 16);
      }
      const rawAlpha = (gridAlpha[topLeft]! + (gridAlpha[topRight]! - gridAlpha[topLeft]!) * fx) * inverseY
        + (gridAlpha[bottomLeft]! + (gridAlpha[bottomRight]! - gridAlpha[bottomLeft]!) * fx) * fy;
      const alpha = Math.trunc(clamp(rawAlpha, 0, 1) * 255);
      const inverseAlpha = 255 - alpha;
      const current = input[index]!;
      const low = blendTable[((sampled & 255) << 8) | alpha]!
        + blendTable[((current & 255) << 8) | inverseAlpha]!;
      const middle = blendTable[(((sampled >>> 8) & 255) << 8) | alpha]!
        + blendTable[(((current >>> 8) & 255) << 8) | inverseAlpha]!;
      const high = blendTable[(((sampled >>> 16) & 255) << 8) | alpha]!
        + blendTable[(((current >>> 16) & 255) << 8) | inverseAlpha]!;
      destination[index] = low | (middle << 8) | (high << 16);
    }
  }
}

function renderNearestGrid(
  context: AvsEffectContext,
  config: AvsDynamicMovementConfig,
  source: Uint32Array,
  gridX: Float64Array,
  gridY: Float64Array,
  gridAlpha: Float64Array,
  cellXs: Uint16Array,
  fractionXs: Float64Array,
  cellYs: Uint16Array,
  fractionYs: Float64Array,
  columns: number,
): void {
  const width = context.input.width;
  const height = context.input.height;
  const destination = context.output.pixels;
  const input = context.input.pixels;
  const maxX = width - 1;
  const maxY = height - 1;
  const spanX = Math.max(1, maxX);
  const spanY = Math.max(1, maxY);
  const blendTable = AVS_BLEND_TABLE;
  let index = 0;
  for (let y = 0; y < height; y++) {
    const cellY = cellYs[y]!;
    const fy = fractionYs[y]!;
    const inverseY = 1 - fy;
    const row = cellY * columns;
    for (let x = 0; x < width; x++, index++) {
      const fx = fractionXs[x]!;
      const topLeft = cellXs[x]! + row;
      const topRight = topLeft + 1;
      const bottomLeft = topLeft + columns;
      const bottomRight = bottomLeft + 1;
      let mappedX = (gridX[topLeft]! + (gridX[topRight]! - gridX[topLeft]!) * fx) * inverseY
        + (gridX[bottomLeft]! + (gridX[bottomRight]! - gridX[bottomLeft]!) * fx) * fy;
      let mappedY = (gridY[topLeft]! + (gridY[topRight]! - gridY[topLeft]!) * fx) * inverseY
        + (gridY[bottomLeft]! + (gridY[bottomRight]! - gridY[bottomLeft]!) * fx) * fy;
      if (config.wrap) {
        if (!(mappedX >= 0 && mappedX < spanX && Number.isInteger(mappedX))) {
          mappedX = wrapCoordinate(mappedX, spanX);
        }
        if (!(mappedY >= 0 && mappedY < spanY && Number.isInteger(mappedY))) {
          mappedY = wrapCoordinate(mappedY, spanY);
        }
      } else {
        mappedX = clamp(mappedX, 0, maxX);
        mappedY = clamp(mappedY, 0, maxY);
      }
      const sampled = source[Math.trunc(mappedX) + Math.trunc(mappedY) * width]!;
      if (!config.blend) {
        destination[index] = sampled;
        continue;
      }
      const rawAlpha = (gridAlpha[topLeft]! + (gridAlpha[topRight]! - gridAlpha[topLeft]!) * fx) * inverseY
        + (gridAlpha[bottomLeft]! + (gridAlpha[bottomRight]! - gridAlpha[bottomLeft]!) * fx) * fy;
      const alpha = Math.trunc(clamp(rawAlpha, 0, 1) * 255);
      const inverse = 255 - alpha;
      const current = input[index]!;
      const low = blendTable[((sampled & 255) << 8) | alpha]!
        + blendTable[((current & 255) << 8) | inverse]!;
      const middle = blendTable[(((sampled >>> 8) & 255) << 8) | alpha]!
        + blendTable[(((current >>> 8) & 255) << 8) | inverse]!;
      const high = blendTable[(((sampled >>> 16) & 255) << 8) | alpha]!
        + blendTable[(((current >>> 16) & 255) << 8) | inverse]!;
      destination[index] = low | (middle << 8) | (high << 16);
    }
  }
}

function prepareInterpolationAxis(
  state: DynamicMovementState,
  width: number,
  height: number,
  columns: number,
  rows: number,
): void {
  let rebuildX = false;
  if (state.cellX.length !== width) {
    state.cellX = new Uint16Array(width);
    state.fractionX = new Float64Array(width);
    rebuildX = true;
  }
  let rebuildY = false;
  if (state.cellY.length !== height) {
    state.cellY = new Uint16Array(height);
    state.fractionY = new Float64Array(height);
    rebuildY = true;
  }
  if (rebuildX) {
    for (let x = 0; x < width; x++) {
      const coordinate = x * (columns - 1) / width;
      const cell = Math.min(columns - 2, Math.trunc(coordinate));
      state.cellX[x] = cell;
      state.fractionX[x] = coordinate - cell;
    }
  }
  if (rebuildY) {
    for (let y = 0; y < height; y++) {
      const coordinate = y * (rows - 1) / height;
      const cell = Math.min(rows - 2, Math.trunc(coordinate));
      state.cellY[y] = cell;
      state.fractionY[y] = coordinate - cell;
    }
  }
}

function readString(payload: Uint8Array, offset: number): { value: string; next: number } {
  if (offset + 4 > payload.length) return { value: '', next: payload.length };
  const length = u32(payload, offset, 0);
  const start = offset + 4;
  const end = Math.min(payload.length, start + length);
  return { value: nulText(payload.subarray(start, end)), next: end };
}
function compileOrNull(source: string): AvsEelProgram | null {
  if (!source.trim()) return null;
  try { return compileAvsEel(source); } catch { return null; }
}
function execute(program: AvsEelProgram | null, vm: AvsEelVm): number { return program ? vm.execute(program) : 0; }
function i32(payload: Uint8Array, offset: number, fallback: number): number {
  return offset + 4 <= payload.length ? new DataView(payload.buffer, payload.byteOffset, payload.byteLength).getInt32(offset, true) : fallback;
}
function u32(payload: Uint8Array, offset: number, fallback: number): number {
  return offset + 4 <= payload.length ? new DataView(payload.buffer, payload.byteOffset, payload.byteLength).getUint32(offset, true) : fallback;
}
function nulText(bytes: Uint8Array): string {
  const end = bytes.indexOf(0);
  return TEXT.decode(end < 0 ? bytes : bytes.subarray(0, end));
}
/**
 * Exactly `((value % span) + span) % span` for a positive integer span, without
 * the two fmod calls when value is already in [0, span). There fl(value + span)
 * lies in [span, 2 * span]: below 2 * span, Sterbenz makes `t - span` exact and
 * equal to fmod(t, span); a sum rounded up to 2 * span wraps to 0, as fmod does.
 * -0 yields +0 like the original. Negative, out-of-range, NaN and infinite
 * values take the original expression. A naive `return value` when in range is
 * NOT equivalent (value + span can round) and changes corpus pixels.
 */
function wrapCoordinate(value: number, span: number): number {
  if (value >= 0 && value < span) {
    const t = value + span;
    return t >= span + span ? 0 : t - span;
  }
  return ((value % span) + span) % span;
}
function getBinding(binding: AvsEelVariableBinding): number {
  return binding.values[binding.index] ?? 0;
}
/** Same NaN/Infinity-to-zero rule as AvsEelVm.set. */
function setBinding(binding: AvsEelVariableBinding, value: number): void {
  binding.values[binding.index] = Number.isFinite(value) ? value : 0;
}
function clamp(value: number, minimum: number, maximum: number): number {
  return value < minimum ? minimum : value > maximum ? maximum : value;
}
function hashPath(path: string): number {
  let hash = 0x811c9dc5;
  for (let i = 0; i < path.length; i++) hash = Math.imul(hash ^ path.charCodeAt(i), 0x01000193);
  return hash >>> 0;
}
