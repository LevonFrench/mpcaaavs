import { AvsEffectRegistry, type AvsEffectContext } from '../executor.ts';
import { blendPixel } from '../framebuffer.ts';
import { blendLine } from './core.ts';

interface RotoState { reverse: number; reversePosition: number; scalePosition: number }
interface InterferenceState { rotation: number; status: number }
interface FountainState {
  rotation: number;
  readonly radius: Float32Array; readonly radialVelocity: Float32Array;
  readonly height: Float32Array; readonly heightVelocity: Float32Array;
  readonly axisX: Float32Array; readonly axisY: Float32Array; readonly color: Uint32Array;
}

/** Final preserved-source low-count ports: Roto Blitter, Dot Fountain, Interferences. */
export function registerAvsFinalLowCountBuiltins(registry = new AvsEffectRegistry()): AvsEffectRegistry {
  const rotoStates = new Map<string, RotoState>();
  const interferenceStates = new Map<string, InterferenceState>();
  const fountainStates = new Map<string, FountainState>();

  // Trans / Roto Blitter (ID 9, r_rotblit.cpp).
  registry.registerBuiltin(9, (context) => {
    if (context.preinit) return;
    const zoom = int(context, 0, 31), direction = int(context, 4, 31), blend = int(context, 8, 0) !== 0;
    const beatReverse = int(context, 12, 0) !== 0, beatSpeed = int(context, 16, 0);
    const beatZoom = int(context, 20, 31), beatScale = int(context, 24, 0) !== 0, subpixel = int(context, 28, 0) !== 0;
    let state = rotoStates.get(context.component.path);
    if (!state) { state = { reverse: 1, reversePosition: 1, scalePosition: zoom }; rotoStates.set(context.component.path, state); }
    if (context.beat && beatReverse) state.reverse = -state.reverse;
    if (!beatReverse) state.reverse = 1;
    state.reversePosition += (state.reverse - state.reversePosition) / (1 + beatSpeed * 4);
    if (state.reverse > 0 && state.reversePosition > state.reverse) state.reversePosition = state.reverse;
    if (state.reverse < 0 && state.reversePosition < state.reverse) state.reversePosition = state.reverse;
    if (context.beat && beatScale) state.scalePosition = beatZoom;
    let scale: number;
    if (zoom < beatZoom) { scale = Math.max(state.scalePosition, zoom); if (state.scalePosition > zoom) state.scalePosition -= 3; }
    else { scale = Math.min(state.scalePosition, zoom); if (state.scalePosition < zoom) state.scalePosition += 3; }
    rotoBlit(context, 1 + (scale - 31) / 31, (direction - 32) * state.reversePosition, blend, subpixel);
    return { swap: true };
  });

  // Render / Dot Fountain (ID 19, r_dotfnt.cpp).
  registry.registerBuiltin(19, (context) => {
    if (context.preinit) return;
    let state = fountainStates.get(context.component.path);
    if (!state) { state = createFountain(int(context, 28, 0) / 32); fountainStates.set(context.component.path, state); }
    renderFountain(context, state, int(context, 0, 16), readFiveColors(context), int(context, 24, -20));
  });

  // Trans / Interferences (ID 41, r_interf.cpp).
  registry.registerBuiltin(41, (context) => {
    if (context.preinit || int(context, 0, 1) === 0) return;
    const count = Math.max(0, Math.min(8, int(context, 4, 2)));
    if (count === 0) return;
    let state = interferenceStates.get(context.component.path);
    if (!state) { state = { rotation: int(context, 8, 0), status: Math.PI }; interferenceStates.set(context.component.path, state); }
    const onBeat = int(context, 48, 1) !== 0;
    if (onBeat && context.beat && state.status >= Math.PI) state.status = 0;
    const wave = Math.sin(state.status);
    const rotationIncrement = int(context, 20, 0) + Math.trunc((int(context, 40, 25) - int(context, 20, 0)) * wave);
    const alpha = int(context, 16, 128) + Math.trunc((int(context, 36, 192) - int(context, 16, 128)) * wave);
    const distance = int(context, 12, 10) + Math.trunc((int(context, 32, 32) - int(context, 12, 10)) * wave);
    const points = Array.from({ length: count }, (_, index) => {
      const angle = state!.rotation / 255 * Math.PI * 2 + Math.PI * 2 * index / count;
      return [Math.trunc(Math.cos(angle) * distance), Math.trunc(Math.sin(angle) * distance)] as const;
    });
    interference(context, points, alpha, int(context, 44, 1) !== 0);
    state.rotation += rotationIncrement;
    state.rotation = state.rotation > 255 ? state.rotation - 255 : state.rotation < -255 ? state.rotation + 255 : state.rotation;
    state.status = Math.min(Math.PI, state.status + float(context, 52, 0.2));
    if (state.status < -Math.PI) state.status = Math.PI;
    const additive = int(context, 24, 0) !== 0, average = int(context, 28, 0) !== 0;
    if (!additive && !average) return { swap: true };
    const blockLength = Math.trunc(context.input.pixels.length / 4) * 4;
    for (let i = 0; i < blockLength; i++) context.input.pixels[i] = blendPixel(context.output.pixels[i]!, context.input.pixels[i]!, average ? 'average' : 'additive');
  });
  return registry;
}

function rotoBlit(context: AvsEffectContext, zoom: number, degrees: number, blend: boolean, subpixel: boolean): void {
  const width = context.input.width, height = context.input.height;
  const ds = (width - 1) << 16, dt = (height - 1) << 16;
  if (ds === 0 || dt === 0) { context.output.copyFrom(context.input); return; }
  const cosine = Math.cos(degrees * Math.PI / 180) * zoom, sine = Math.sin(degrees * Math.PI / 180) * zoom;
  const dsDx = Math.trunc(cosine * 65536), dtDy = Math.trunc(cosine * 65536);
  const dsDy = -Math.trunc(sine * 65536), dtDx = Math.trunc(sine * 65536);
  if (dsDx <= -ds || dsDx >= ds || dtDx <= -dt || dtDx >= dt) return;
  let sStart = -Math.trunc((width - 1) / 2) * dsDx - Math.trunc((height - 1) / 2) * dsDy + (width - 1) * (32768 + (1 << 20));
  let tStart = -Math.trunc((width - 1) / 2) * dtDx - Math.trunc((height - 1) / 2) * dtDy + (height - 1) * (32768 + (1 << 20));
  let output = 0;
  for (let row = height; row > 0; row--) {
    let s = modulo(sStart, ds), t = modulo(tStart, dt);
    for (let x = width; x > 0; x--) {
      const sample = subpixel ? bilinear(context, s, t) : context.input.pixels[(s >> 16) + (t >> 16) * width]!;
      context.output.pixels[output] = blend ? blendPixel(sample, context.input.pixels[output]!, 'average') : sample;
      output++; s = modulo(s + dsDx, ds); t = modulo(t + dtDx, dt);
    }
    sStart += dsDy; tStart += dtDy;
  }
}
function bilinear(context: AvsEffectContext, s: number, t: number): number {
  const x = s >> 16, y = t >> 16, fx = (s >> 8) & 255, fy = (t >> 8) & 255, width = context.input.width;
  const pixels = context.input.pixels, base = x + y * width;
  const weights = [table(255 - fx, 255 - fy), table(fx, 255 - fy), table(255 - fx, fy), table(fx, fy)];
  const samples = [pixels[base]!, pixels[base + 1]!, pixels[base + width]!, pixels[base + width + 1]!];
  return channels(samples, weights);
}

function interference(context: AvsEffectContext, points: readonly (readonly [number, number])[], alpha: number, rgb: boolean): void {
  const width = context.input.width, height = context.input.height;
  for (let y = 0; y < height; y++) for (let x = 0; x < width; x++) {
    if (rgb && (points.length === 3 || points.length === 6)) {
      const values = [0, 0, 0];
      for (let index = 0; index < points.length; index++) {
        const pixel = displaced(context, x, y, points[index]!);
        const channel = index % 3;
        values[channel] = Math.min(255, values[channel]! + table((pixel >>> (channel * 8)) & 255, alpha));
      }
      context.output.pixels[x + y * width] = values[0]! | (values[1]! << 8) | (values[2]! << 16);
    } else {
      let red = 0, green = 0, blue = 0;
      for (const point of points) { const pixel = displaced(context, x, y, point); blue += table(pixel & 255, alpha); green += table((pixel >>> 8) & 255, alpha); red += table((pixel >>> 16) & 255, alpha); }
      context.output.pixels[x + y * width] = Math.min(255, blue) | (Math.min(255, green) << 8) | (Math.min(255, red) << 16);
    }
  }
}
function displaced(context: AvsEffectContext, x: number, y: number, point: readonly [number, number]): number {
  const sx = x - point[0], sy = y - point[1];
  return sx >= 0 && sy >= 0 && sx < context.input.width && sy < context.input.height ? context.input.pixels[sx + sy * context.input.width]! : 0;
}

function createFountain(rotation: number): FountainState {
  const length = 256 * 30;
  return { rotation, radius: new Float32Array(length), radialVelocity: new Float32Array(length), height: new Float32Array(length), heightVelocity: new Float32Array(length), axisX: new Float32Array(length), axisY: new Float32Array(length), color: new Uint32Array(length) };
}
function renderFountain(context: AvsEffectContext, state: FountainState, velocity: number, colors: readonly number[], tilt: number): void {
  const columns = 30;
  for (let row = 254; row >= 0; row--) for (let column = 0; column < columns; column++) {
    const source = row * columns + column, target = source + columns, acceleration = 1.3 / (row + 100);
    state.radius[target] = state.radius[source]! + state.radialVelocity[source]!;
    state.heightVelocity[target] = state.heightVelocity[source]! + 0.05;
    state.radialVelocity[target] = state.radialVelocity[source]! + acceleration;
    state.height[target] = state.height[source]! + state.heightVelocity[target]!;
    state.axisX[target] = state.axisX[source]!; state.axisY[target] = state.axisY[source]!; state.color[target] = state.color[source]!;
  }
  const colorTable = fountainColors(colors);
  for (let column = 0; column < columns; column++) {
    let energy = Math.trunc((context.audio.waveform[0][column]! ^ 128) * 5 / 4) - 64;
    if (context.beat) energy += 128; energy = Math.min(255, energy);
    const radial = Math.abs(energy / 200) + 1, index = column;
    state.radius[index] = 1; state.height[index] = 250;
    state.heightVelocity[index] = -radial * (100 + (state.heightVelocity[index]! - state.heightVelocity[index]!)) / 100 * 2.8;
    state.color[index] = colorTable[Math.min(63, Math.trunc(energy / 4))] ?? 0;
    const angle = column * Math.PI * 2 / columns; state.axisX[index] = Math.sin(angle); state.axisY[index] = Math.cos(angle); state.radialVelocity[index] = 0;
  }
  const rotateZ = rotationMatrix(2, state.rotation), rotateY = rotationMatrix(1, tilt), translated = translationMatrix(0, -20, 400);
  const matrix = multiplyMatrices(multiplyMatrices(rotateZ, rotateY), translated);
  const projection = Math.min(context.input.width * 440 / 640, context.input.height * 440 / 480);
  for (let index = 0; index < state.radius.length; index++) {
    const [x, y, z] = applyMatrix(matrix, state.axisX[index]! * state.radius[index]!, state.height[index]!, state.axisY[index]! * state.radius[index]!);
    const scale = projection / z; if (scale <= 1e-7) continue;
    const px = Math.trunc(x * scale) + Math.trunc(context.input.width / 2), py = Math.trunc(y * scale) + Math.trunc(context.input.height / 2);
    if (px >= 0 && py >= 0 && px < context.input.width && py < context.input.height) { const at = px + py * context.input.width; context.input.pixels[at] = blendLine(state.color[index]!, context.input.pixels[at]!, context.line.blendMode, context.line.adjustableAlpha); }
  }
  state.rotation += velocity / 5; if (state.rotation >= 360) state.rotation -= 360; if (state.rotation < 0) state.rotation += 360;
}
function fountainColors(colors: readonly number[]): Uint32Array {
  const tableOut = new Uint32Array(64);
  for (let segment = 0; segment < 4; segment++) for (let step = 0; step < 16; step++) tableOut[segment * 16 + step] = mixColor(colors[segment]!, colors[segment + 1]!, step, 16);
  return tableOut;
}
function readFiveColors(context: AvsEffectContext): number[] { const defaults = [0x1c6b18, 0xff0a23, 0x2a1d74, 0x9036d9, 0x6b88ff]; return defaults.map((fallback, index) => int(context, 4 + index * 4, fallback) & 0xffffff); }

function rotationMatrix(axis: number, degrees: number): number[] { const m = new Array<number>(16).fill(0), m1 = axis % 3, m2 = (m1 + 1) % 3, c = Math.cos(degrees * Math.PI / 180), s = Math.sin(degrees * Math.PI / 180); m[(axis - 1) * 4 + axis - 1] = 1; m[15] = 1; m[m1 * 4 + m1] = c; m[m1 * 4 + m2] = s; m[m2 * 4 + m2] = c; m[m2 * 4 + m1] = -s; return m; }
function translationMatrix(x: number, y: number, z: number): number[] { return [1,0,0,x, 0,1,0,y, 0,0,1,z, 0,0,0,1]; }
function multiplyMatrices(destination: readonly number[], source: readonly number[]): number[] { const out = new Array<number>(16); for (let row = 0; row < 4; row++) for (let column = 0; column < 4; column++) out[row * 4 + column] = source[row * 4]! * destination[column]! + source[row * 4 + 1]! * destination[4 + column]! + source[row * 4 + 2]! * destination[8 + column]! + source[row * 4 + 3]! * destination[12 + column]!; return out; }
function applyMatrix(m: readonly number[], x: number, y: number, z: number): readonly [number, number, number] { return [x*m[0]!+y*m[1]!+z*m[2]!+m[3]!, x*m[4]!+y*m[5]!+z*m[6]!+m[7]!, x*m[8]!+y*m[9]!+z*m[10]!+m[11]!]; }
function channels(samples: readonly number[], weights: readonly number[]): number { let out = 0; for (let channel = 0; channel < 3; channel++) { let value = 0; for (let i = 0; i < 4; i++) value += table((samples[i]! >>> (channel * 8)) & 255, weights[i]!); out |= (value & 255) << (channel * 8); } return out; }
function mixColor(a: number, b: number, numerator: number, denominator: number): number { let out = 0; for (let channel = 0; channel < 3; channel++) out |= Math.trunc((((a >>> (channel*8))&255)*(denominator-numerator)+((b >>> (channel*8))&255)*numerator)/denominator) << (channel*8); return out; }
function table(x: number, y: number): number { return Math.trunc(x / 255 * y); }
function modulo(value: number, divisor: number): number { const result = value % divisor; return result < 0 ? result + divisor : result; }
function int(context: AvsEffectContext, offset: number, fallback: number): number { return offset + 4 <= context.component.payload.length ? new DataView(context.component.payload.buffer, context.component.payload.byteOffset, context.component.payload.byteLength).getInt32(offset, true) : fallback; }
function float(context: AvsEffectContext, offset: number, fallback: number): number { return offset + 4 <= context.component.payload.length ? new DataView(context.component.payload.buffer, context.component.payload.byteOffset, context.component.payload.byteLength).getFloat32(offset, true) : fallback; }
