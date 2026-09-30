import {
  AVS_AUDIO_SAMPLES,
  AVS_CONVOLUTION_APE_ID,
  AvsExecutor,
  AvsFramebuffer,
  registerAvsConvolutionFilter,
  type AvsAudioFrame,
  type AvsComponent,
  type AvsPresetAst,
} from '../src/avs/index.ts';

const audio: AvsAudioFrame = {
  waveform: [new Uint8Array(AVS_AUDIO_SAMPLES), new Uint8Array(AVS_AUDIO_SAMPLES)],
  spectrum: [new Uint8Array(AVS_AUDIO_SAMPLES), new Uint8Array(AVS_AUDIO_SAMPLES)],
  beat: false,
  beatLevel: 0,
};
const dimensions = [[1, 1], [2, 5], [5, 2], [7, 6], [19, 13], [23, 17], [40, 9]] as const;
let random = 0x243f6a88;
let assertions = 0;

interface ConvolutionSpec {
  readonly kernel: readonly number[];
  readonly scale: number;
  readonly bias: number;
  readonly wrap: boolean;
  readonly absolute: boolean;
  readonly twoPass: boolean;
}

// Count generated interior kernels, so a silent fallback cannot pass as coverage.
const nativeFunction = globalThis.Function;
let generatedKernels = 0;
globalThis.Function = new Proxy(nativeFunction, {
  construct(target, args) {
    generatedKernels++;
    return Reflect.construct(target, args);
  },
});
runTrials('generated');
if (generatedKernels === 0) throw new Error('no interior convolution kernel was generated');

// A CSP without 'unsafe-eval' makes `new Function` throw; the loop must take over.
// The first kernel for an unseen width fails, which disables generation for good.
let blockedKernels = 0;
globalThis.Function = new Proxy(nativeFunction, {
  construct() {
    blockedKernels++;
    throw new EvalError('Code generation from strings disallowed for this context');
  },
});
runTrials('fallback');
globalThis.Function = nativeFunction;
if (blockedKernels !== 1) throw new Error(`expected one blocked kernel generation, saw ${blockedKernels}`);

console.log(`avs-convolution-effects-check: PASS (${assertions} exact differential assertions, `
  + `${generatedKernels} generated kernels, CSP fallback covered)`);

function runTrials(label: string): void {
  // An unseen width forces a fresh `new Function` at the start of each run.
  const widths = label === 'fallback' ? [[31, 11] as const, ...dimensions] : dimensions;
  for (const [width, height] of widths) {
    for (let trial = 0; trial < 35; trial++) {
      checkTrial(width, height, basicSpec(trial), `${label} trial ${trial} at ${width}x${height}`);
    }
    for (let trial = 0; trial < 60; trial++) {
      checkTrial(width, height, extendedSpec(trial), `${label} extended trial ${trial} at ${width}x${height}`);
    }
  }
}

function checkTrial(width: number, height: number, spec: ConvolutionSpec, label: string): void {
  const pixels = new Uint32Array(width * height);
  for (let index = 0; index < pixels.length; index++) pixels[index] = nextRandom();
  const expected = referenceConvolution(pixels, width, height, spec);
  // Two frames through one executor: the second reuses the cached state and kernel.
  const actual = renderConvolution(pixels, width, height, spec, `${label}-${assertions}`);
  equalPixels(actual[0]!, expected, `${label} (${describe(spec)})`);
  equalPixels(actual[1]!, expected, `${label} second frame (${describe(spec)})`);
}

/** The original non-saturating differential: positive swap kernels, no bias or flags. */
function basicSpec(trial: number): ConvolutionSpec {
  const kernel = new Array<number>(49).fill(0);
  const scale = [1, 2, 3, 5, 8, 30, 120][trial % 7]!;
  if (trial < 7) {
    kernel.fill((trial % 5) + 1);
  } else {
    kernel[0] = 1 + (nextRandom() % 7);
    let magnitude = kernel[0]!;
    for (let tap = 1; tap < kernel.length && magnitude < 220; tap++) {
      if ((nextRandom() & 3) !== 0) continue;
      const coefficient = (nextRandom() % 11) - 5;
      if (coefficient === 0 || magnitude + Math.abs(coefficient) >= 250) continue;
      kernel[tap] = coefficient;
      magnitude += Math.abs(coefficient);
    }
  }
  return { kernel, scale, bias: 0, wrap: false, absolute: false, twoPass: false };
}

/**
 * Bias, saturation, two-pass, absolute/wrap, negative scales and in-place
 * kernels (first nonzero cell at or after the centre, so the APE writes into
 * the buffer it is still reading).
 */
function extendedSpec(trial: number): ConvolutionSpec {
  const kernel = new Array<number>(49).fill(0);
  const inPlace = trial % 3 === 0;
  const saturating = trial % 5 === 1;
  const firstCell = inPlace ? 24 + (nextRandom() % 25) : nextRandom() % 24;
  const density = [1, 2, 4, 8][nextRandom() & 3]!;
  const limit = saturating ? 300 : 12;
  kernel[firstCell] = 1 + (nextRandom() % limit);
  for (let tap = firstCell + 1; tap < kernel.length; tap++) {
    if (nextRandom() % density !== 0) continue;
    kernel[tap] = (nextRandom() % (2 * limit + 1)) - limit;
  }
  if (!saturating) scaleDown(kernel);
  if (trial % 17 === 5) kernel.fill(0);
  const biasChoice = nextRandom() % 4;
  const bias = biasChoice === 0 ? 0
    : saturating ? (nextRandom() % 601) - 300
      : (nextRandom() % 41) - 20;
  const scales = [1, 2, 4, 3, 7, 16, 100, 256, 0x8000, 0x10000, 0x12345, -1, -4, -3];
  return {
    kernel,
    scale: scales[nextRandom() % scales.length]!,
    bias,
    wrap: (nextRandom() & 3) === 0,
    absolute: (nextRandom() & 3) === 0,
    twoPass: (nextRandom() & 3) === 0,
  };
}

/** Keep a non-saturating kernel's positive and negative sums below 256 (bias included). */
function scaleDown(kernel: number[]): void {
  let positive = 0;
  let negative = 0;
  for (let tap = 0; tap < kernel.length; tap++) {
    const coefficient = kernel[tap]!;
    if (coefficient > 0 && positive + coefficient > 200) kernel[tap] = 0;
    else if (coefficient < 0 && negative - coefficient > 200) kernel[tap] = 0;
    else if (coefficient > 0) positive += coefficient;
    else negative -= coefficient;
  }
}

function renderConvolution(
  pixels: Uint32Array,
  width: number,
  height: number,
  spec: ConvolutionSpec,
  path: string,
): Uint32Array[] {
  const payload = new Uint8Array(220);
  const view = new DataView(payload.buffer);
  view.setInt32(0, 1, true);
  view.setInt32(4, spec.wrap ? 1 : 0, true);
  view.setInt32(8, spec.absolute ? 1 : 0, true);
  view.setInt32(12, spec.twoPass ? 1 : 0, true);
  for (let index = 0; index < 49; index++) view.setInt32(16 + index * 4, spec.kernel[index]!, true);
  view.setInt32(212, spec.bias, true);
  view.setInt32(216, spec.scale, true);
  const component: AvsComponent = {
    effectId: -1,
    apeId: AVS_CONVOLUTION_APE_ID,
    payload,
    fileOffset: 0,
    path,
    children: [],
    list: null,
    listCode: null,
  };
  const preset: AvsPresetAst = {
    version: 2,
    header: 'Nullsoft AVS Preset 0.2\u001a',
    clearEveryFrame: false,
    components: [component],
    byteLength: payload.byteLength,
  };
  const executor = new AvsExecutor(preset, registerAvsConvolutionFilter());
  const frames: Uint32Array[] = [];
  for (let frame = 0; frame < 2; frame++) {
    const framebuffer = new AvsFramebuffer(width, height, new Uint32Array(pixels));
    executor.render(framebuffer, audio);
    frames.push(new Uint32Array(framebuffer.pixels));
  }
  return frames;
}

/**
 * Straight transcription of Holden03's per-pixel word arithmetic: a 16-bit
 * product per tap, saturating or wrapping adds, bias, subtract / absolute /
 * wraparound, the rotated second pass, then pmulhuw-style scaling. In-place
 * kernels read the buffer they are writing, in row-major order.
 */
function referenceConvolution(
  source: Uint32Array,
  width: number,
  height: number,
  spec: ConvolutionSpec,
): Uint32Array {
  const sign = spec.scale < 0 ? -1 : 1;
  const divisor = Math.abs(spec.scale) || 1;
  const bias = Math.imul(spec.bias, sign);
  let firstNonzero = spec.kernel.findIndex((value) => value !== 0);
  if (firstNonzero < 0 && spec.bias !== 0) firstNonzero = 49;
  const inPlace = !(firstNonzero >= 0 && firstNonzero < 24);
  const target = inPlace ? new Uint32Array(source) : new Uint32Array(source.length);
  const read = inPlace ? target : source;
  let positiveSum = 0;
  let negativeSum = 0;
  for (const coefficient of [...spec.kernel, spec.bias]) {
    if (coefficient > 0) positiveSum = (positiveSum + coefficient) >>> 0;
    else if (coefficient < 0) negativeSum = (negativeSum + (-coefficient >>> 0)) >>> 0;
  }
  const saturatePositive = positiveSum >= 256;
  const saturateNegative = negativeSum >= 256;
  const hasNegative = bias < 0 || spec.kernel.some((value) => Math.imul(value, sign) < 0);
  const biasProduct = Math.imul(Math.abs(bias) & 0xffff, 256) & 0xffff;

  const pass = (x: number, y: number, rotated: boolean): number[] => {
    const positive = [0, 0, 0, 0];
    const negative = [0, 0, 0, 0];
    for (let tap = 0; tap < 49; tap++) {
      const coefficient = Math.imul(spec.kernel[tap]!, sign);
      if (coefficient === 0) continue;
      const kx = tap % 7 - 3;
      const ky = Math.floor(tap / 7) - 3;
      const sx = clamp(x + (rotated ? -ky : kx), 0, width - 1);
      const sy = clamp(y + (rotated ? kx : ky), 0, height - 1);
      const pixel = read[sy * width + sx]!;
      const magnitude = Math.abs(coefficient) & 0xffff;
      const output = coefficient > 0 ? positive : negative;
      const saturate = coefficient > 0 ? saturatePositive : saturateNegative;
      for (let channel = 0; channel < 4; channel++) {
        const word = Math.imul((pixel >>> (channel * 8)) & 255, magnitude) & 0xffff;
        output[channel] = saturate ? Math.min(0xffff, output[channel]! + word) : (output[channel]! + word) & 0xffff;
      }
    }
    for (let channel = 0; channel < 4; channel++) {
      if (bias > 0) positive[channel] = Math.min(0xffff, positive[channel]! + biasProduct);
      if (bias < 0) negative[channel] = Math.min(0xffff, negative[channel]! + biasProduct);
    }
    return positive.map((value, channel) => {
      const subtrahend = negative[channel]!;
      if (!hasNegative) return value;
      if (spec.absolute) return (clamp(signed16(value) - signed16(subtrahend), -0x8000, 0x7fff) & 0xffff) & 0x7fff;
      if (spec.wrap) return (value - subtrahend) & 0xffff;
      return value > subtrahend ? value - subtrahend : 0;
    });
  };

  for (let y = 0; y < height; y++) {
    for (let x = 0; x < width; x++) {
      let words = pass(x, y, false);
      if (spec.twoPass) {
        const second = pass(x, y, true);
        words = words.map((value, channel) => Math.min(0xffff, value + second[channel]!));
      }
      target[y * width + x] = (packByte(scaleWord(words[0]!, divisor))
        | (packByte(scaleWord(words[1]!, divisor)) << 8)
        | (packByte(scaleWord(words[2]!, divisor)) << 16)
        | (packByte(scaleWord(words[3]!, divisor)) << 24)) >>> 0;
    }
  }
  return target;
}

function scaleWord(value: number, divisor: number): number {
  if (divisor <= 1) return value & 0xffff;
  if (divisor <= 0x8000 && (divisor & (divisor - 1)) === 0) return value >>> Math.log2(divisor);
  const reciprocal = Math.floor(0x10000 / divisor) & 0xffff;
  return Math.floor((value * reciprocal) / 0x10000) & 0xffff;
}

function signed16(value: number): number {
  return value & 0x8000 ? (value & 0xffff) - 0x10000 : value & 0xffff;
}

function packByte(value: number): number {
  const signed = signed16(value);
  return signed < 0 ? 0 : signed > 255 ? 255 : signed;
}

function clamp(value: number, minimum: number, maximum: number): number {
  return value < minimum ? minimum : value > maximum ? maximum : value;
}

function nextRandom(): number {
  random ^= random << 13; random ^= random >>> 17; random ^= random << 5;
  return random >>> 0;
}

function describe(spec: ConvolutionSpec): string {
  const cells = spec.kernel.flatMap((value, index) => value === 0 ? [] : [`${index}:${value}`]);
  return `kernel {${cells.join(' ')}} scale ${spec.scale} bias ${spec.bias}`
    + `${spec.wrap ? ' wrap' : ''}${spec.absolute ? ' absolute' : ''}${spec.twoPass ? ' twoPass' : ''}`;
}

function equalPixels(actual: Uint32Array, expected: Uint32Array, label: string): void {
  if (actual.length !== expected.length) throw new Error(`${label}: length ${actual.length} !== ${expected.length}`);
  for (let index = 0; index < actual.length; index++) {
    if (actual[index] !== expected[index]) {
      throw new Error(`${label}: pixel ${index} 0x${actual[index]!.toString(16)} !== 0x${expected[index]!.toString(16)}`);
    }
  }
  assertions++;
}
