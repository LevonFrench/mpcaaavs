import { AvsEffectRegistry, type AvsEffectContext } from '../executor.ts';

export const AVS_CONVOLUTION_APE_ID = 'Holden03: Convolution Filter';
export const AVS_CONVOLUTION_KERNEL_SIZE = 7;

export interface AvsConvolutionConfig {
  readonly enabled: boolean;
  /** Native name: wraparound. This changes subtraction, not edge sampling. */
  readonly wrap: boolean;
  readonly absolute: boolean;
  readonly twoPass: boolean;
  readonly kernel: readonly number[];
  readonly bias: number;
  readonly scale: number;
  readonly legacyFilename: string;
}

const KERNEL_CELLS = AVS_CONVOLUTION_KERNEL_SIZE ** 2;
const CORE_BYTES = (4 + KERNEL_CELLS + 2) * 4;

interface ConvolutionTap { readonly dx: number; readonly dy: number; readonly coefficient: number }
interface PreparedConvolution {
  readonly config: AvsConvolutionConfig;
  readonly taps: readonly ConvolutionTap[];
  readonly rotatedTaps: readonly ConvolutionTap[];
  readonly bias: number;
  readonly biasProduct: number;
  readonly divisor: number;
  readonly hasNegative: boolean;
  readonly saturatePositive: boolean;
  readonly saturateNegative: boolean;
  readonly swap: boolean;
  readonly leftEdge: number;
  readonly rightEdge: number;
  readonly scaleShift: number;
  readonly positiveDx: Int8Array;
  readonly positiveDy: Int8Array;
  readonly positiveCoefficients: Uint16Array;
  readonly negativeDx: Int8Array;
  readonly negativeDy: Int8Array;
  readonly negativeCoefficients: Uint16Array;
  readonly boxCoefficient: number;
  boxScratch: ConvolutionBoxScratch | null;
  /** Rows the kernel reaches above/below the centre, for the unclamped interior band. */
  readonly topEdge: number;
  readonly bottomEdge: number;
  /** Packed-lane path eligibility: no saturation, no two-pass, subtract-and-clamp only. */
  readonly packed: boolean;
  /** Proven lane bounds (see prepareConvolution); required by the generated kernel. */
  readonly exactLanes: boolean;
  /** biasProduct replicated into both 16-bit lanes of the positive/negative accumulators. */
  readonly positiveBiasLanes: number;
  readonly negativeBiasLanes: number;
  readonly generic: GenericConvolutionTaps;
  readonly rotated: GenericConvolutionTaps;
  interiorWidth: number;
  interiorKernel: ConvolutionInteriorKernel | null;
}

/** Flat per-tap arrays for the saturating / two-pass / absolute / wrap path. */
interface GenericConvolutionTaps {
  readonly count: number;
  readonly dx: Int8Array;
  readonly dy: Int8Array;
  /** Math.abs(coefficient) & 0xffff, exactly as the per-tap word product uses it. */
  readonly magnitude: Uint16Array;
  readonly positive: Uint8Array;
  readonly leftEdge: number;
  readonly rightEdge: number;
}

/** Generated straight-line convolution of one interior row span [start, end). */
type ConvolutionInteriorKernel = (source: Uint32Array, target: Uint32Array, start: number, end: number) => void;

interface ConvolutionBoxScratch {
  readonly width: number;
  readonly height: number;
  readonly redBlue: Uint32Array;
  readonly greenAlpha: Uint32Array;
}

/** Decode the exact integer layout emitted by Holden03's save_config(). */
export function decodeAvsConvolutionConfig(payload: Uint8Array): AvsConvolutionConfig {
  const defaults = new Int32Array(4 + KERNEL_CELLS + 2);
  defaults[0] = 1;
  defaults[4 + 24] = 1;
  defaults[4 + KERNEL_CELLS + 1] = 1;
  const view = new DataView(payload.buffer, payload.byteOffset, payload.byteLength);
  const words = Math.min(defaults.length, Math.floor(payload.length / 4));
  for (let index = 0; index < words; index++) defaults[index] = view.getInt32(index * 4, true);

  const scale = defaults[4 + KERNEL_CELLS + 1]!;
  return {
    // The native loader tests these four values against exactly one.
    enabled: defaults[0] === 1,
    wrap: defaults[1] === 1,
    absolute: defaults[2] === 1,
    twoPass: defaults[3] === 1,
    kernel: Array.from(defaults.subarray(4, 4 + KERNEL_CELLS)),
    bias: defaults[4 + KERNEL_CELLS]!,
    scale: scale === 0 ? 1 : scale,
    legacyFilename: payload.length > CORE_BYTES
      ? new TextDecoder('windows-1252').decode(payload.subarray(CORE_BYTES))
      : '',
  };
}

/** Register Tom Holden's original 7x7 convolution APE. */
export function registerAvsConvolutionFilter(
  registry = new AvsEffectRegistry(),
): AvsEffectRegistry {
  const states = new Map<string, PreparedConvolution>();
  registry.registerApe(AVS_CONVOLUTION_APE_ID, (context) => {
    let state = states.get(context.component.path);
    if (!state) {
      state = prepareConvolution(decodeAvsConvolutionConfig(context.component.payload));
      states.set(context.component.path, state);
    }
    if (!state.config.enabled || context.input.width === 0 || context.input.height === 0) return;
    return renderConvolution(context, state);
  });
  return registry;
}

function prepareConvolution(config: AvsConvolutionConfig): PreparedConvolution {
  let firstNonzero = -1;
  const sign = config.scale < 0 ? -1 : 1;
  const taps: ConvolutionTap[] = [];
  const rotatedTaps: ConvolutionTap[] = [];
  for (let index = 0; index < KERNEL_CELLS; index++) {
    const raw = config.kernel[index]!;
    if (raw === 0) continue;
    if (firstNonzero < 0) firstNonzero = index;
    const coefficient = Math.imul(raw, sign);
    const dx = index % 7 - 3;
    const dy = Math.floor(index / 7) - 3;
    taps.push({ dx, dy, coefficient });
    rotatedTaps.push({ dx: -dy, dy: dx, coefficient });
  }
  if (firstNonzero < 0 && config.bias !== 0) firstNonzero = KERNEL_CELLS;
  const sums = coefficientSums(config.kernel, config.bias);
  const bias = Math.imul(config.bias, sign);
  const minimumX = taps.reduce((minimum, tap) => Math.min(minimum, tap.dx), 0);
  const maximumX = taps.reduce((maximum, tap) => Math.max(maximum, tap.dx), 0);
  const divisor = Math.abs(config.scale) || 1;
  const positiveTaps = taps.filter((tap) => tap.coefficient > 0);
  const negativeTaps = taps.filter((tap) => tap.coefficient < 0);
  const minimumY = taps.reduce((minimum, tap) => Math.min(minimum, tap.dy), 0);
  const maximumY = taps.reduce((maximum, tap) => Math.max(maximum, tap.dy), 0);
  const boxCoefficient = taps.length === KERNEL_CELLS
    && taps.every((tap) => tap.coefficient === taps[0]!.coefficient)
    && taps[0]!.coefficient > 0
    ? taps[0]!.coefficient
    : 0;
  const biasProduct = Math.imul(Math.abs(bias) & 0xffff, 256) & 0xffff;
  const hasNegative = bias < 0 || taps.some((tap) => tap.coefficient < 0);
  const subtractOnly = !config.twoPass && (!hasNegative || (!config.absolute && !config.wrap));
  // The selection the packed path has always had (coefficientSums wraps at 2^32,
  // so a pathological kernel can pass it); keep it byte-for-byte on the loop.
  const legacyPacked = firstNonzero >= 0 && firstNonzero < 24 && bias === 0
    && !sums.saturatePositive && !sums.saturateNegative && subtractOnly;
  // With both unwrapped coefficient sums (bias included) below 256, every 16-bit
  // channel sum stays <= 255 * 255 + 256 * 255 < 0x10000: the per-tap `& 0xffff`,
  // the wrapping add and the bias `min(0xffff)` are no-ops, so the packed lanes
  // equal the generic word arithmetic exactly, bias and in-place kernels included.
  let positiveSum = 0;
  let negativeSum = 0;
  for (const coefficient of [...config.kernel, config.bias]) {
    if (coefficient > 0) positiveSum += coefficient;
    else negativeSum -= coefficient;
  }
  const exactLanes = subtractOnly && positiveSum < 256 && negativeSum < 256;
  const biasLanes = biasProduct * 0x10001;
  return {
    config, taps, rotatedTaps, bias,
    biasProduct,
    divisor,
    hasNegative,
    saturatePositive: sums.saturatePositive,
    saturateNegative: sums.saturateNegative,
    swap: firstNonzero >= 0 && firstNonzero < 24,
    leftEdge: -minimumX,
    rightEdge: maximumX,
    scaleShift: divisor <= 0x8000 && (divisor & (divisor - 1)) === 0 ? Math.log2(divisor) : -1,
    positiveDx: Int8Array.from(positiveTaps, (tap) => tap.dx),
    positiveDy: Int8Array.from(positiveTaps, (tap) => tap.dy),
    positiveCoefficients: Uint16Array.from(positiveTaps, (tap) => tap.coefficient),
    negativeDx: Int8Array.from(negativeTaps, (tap) => tap.dx),
    negativeDy: Int8Array.from(negativeTaps, (tap) => tap.dy),
    negativeCoefficients: Uint16Array.from(negativeTaps, (tap) => -tap.coefficient),
    boxCoefficient,
    boxScratch: null,
    topEdge: -minimumY,
    bottomEdge: maximumY,
    packed: legacyPacked || exactLanes,
    exactLanes,
    positiveBiasLanes: bias > 0 ? biasLanes : 0,
    negativeBiasLanes: bias < 0 ? biasLanes : 0,
    generic: flattenTaps(taps),
    rotated: flattenTaps(rotatedTaps),
    interiorWidth: -1,
    interiorKernel: null,
  };
}

function flattenTaps(taps: readonly ConvolutionTap[]): GenericConvolutionTaps {
  return {
    count: taps.length,
    dx: Int8Array.from(taps, (tap) => tap.dx),
    dy: Int8Array.from(taps, (tap) => tap.dy),
    magnitude: Uint16Array.from(taps, (tap) => Math.abs(tap.coefficient) & 0xffff),
    positive: Uint8Array.from(taps, (tap) => tap.coefficient > 0 ? 1 : 0),
    leftEdge: -taps.reduce((minimum, tap) => Math.min(minimum, tap.dx), 0),
    rightEdge: taps.reduce((maximum, tap) => Math.max(maximum, tap.dx), 0),
  };
}

function renderConvolution(context: AvsEffectContext, state: PreparedConvolution): { swap: true } | void {
  const swap = state.swap;
  const source = context.input.pixels;
  const target = swap ? context.output.pixels : source;
  const width = context.input.width;
  const height = context.input.height;
  if (state.packed) {
    if (swap && state.boxCoefficient !== 0 && state.bias === 0 && !state.config.twoPass) {
      renderBoxConvolution(source, target, width, height, state);
      return { swap: true };
    }
    // In place (!swap) is exact here too: every path below visits pixels in
    // row-major order and reads all taps of a pixel before writing it, so it
    // sees exactly the already-overwritten neighbours the APE's loop sees.
    renderFastConvolution(source, target, width, height, state);
  } else {
    renderGenericConvolution(source, target, width, height, state);
  }
  return swap ? { swap: true } : undefined;
}

/** Channel words of one generic pass (blue, green, red, alpha). */
const firstWords = new Int32Array(4);
const secondWords = new Int32Array(4);

/**
 * Saturating, two-pass, absolute and wraparound kernels, with the APE's word
 * arithmetic: a 16-bit product per tap, then a saturating or wrapping add.
 * Both adds are order-independent over non-negative words (saturating adds
 * equal min(0xffff, total), wrapping adds equal total & 0xffff), so each pass
 * sums exactly in a double and applies the add mode once per channel. Pixels
 * are visited row-major with every tap read before the write, which keeps the
 * aliasing of in-place (!swap) kernels identical.
 */
function renderGenericConvolution(
  source: Uint32Array,
  target: Uint32Array,
  width: number,
  height: number,
  state: PreparedConvolution,
): void {
  const taps = state.generic;
  const rotated = state.rotated;
  const twoPass = state.config.twoPass;
  const rowBases = new Int32Array(taps.count);
  const rotatedRowBases = new Int32Array(rotated.count);
  const interiorStart = Math.min(width, taps.leftEdge);
  const interiorEnd = Math.max(interiorStart, width - taps.rightEdge);
  const rotatedStart = Math.min(width, rotated.leftEdge);
  const rotatedEnd = Math.max(rotatedStart, width - rotated.rightEdge);
  const shift = state.scaleShift;
  const reciprocal = shift < 0 ? Math.floor(0x10000 / state.divisor) & 0xffff : 0;
  for (let y = 0; y < height; y++) {
    for (let tap = 0; tap < taps.count; tap++) {
      rowBases[tap] = clamp(y + taps.dy[tap]!, 0, height - 1) * width;
    }
    for (let tap = 0; tap < rotated.count; tap++) {
      rotatedRowBases[tap] = clamp(y + rotated.dy[tap]!, 0, height - 1) * width;
    }
    const targetRow = y * width;
    for (let x = 0; x < width; x++) {
      convolveGenericPass(source, width, x, x >= interiorStart && x < interiorEnd,
        taps, rowBases, state, firstWords);
      if (twoPass) {
        convolveGenericPass(source, width, x, x >= rotatedStart && x < rotatedEnd,
          rotated, rotatedRowBases, state, secondWords);
        for (let channel = 0; channel < 4; channel++) {
          firstWords[channel] = Math.min(0xffff, firstWords[channel]! + secondWords[channel]!);
        }
      }
      let blue = firstWords[0]!;
      let green = firstWords[1]!;
      let red = firstWords[2]!;
      let alpha = firstWords[3]!;
      // scaleWord with the divisor test hoisted; every word is already <= 0xffff.
      if (shift >= 0) {
        blue >>>= shift; green >>>= shift; red >>>= shift; alpha >>>= shift;
      } else {
        blue = Math.floor((blue * reciprocal) / 0x10000) & 0xffff;
        green = Math.floor((green * reciprocal) / 0x10000) & 0xffff;
        red = Math.floor((red * reciprocal) / 0x10000) & 0xffff;
        alpha = Math.floor((alpha * reciprocal) / 0x10000) & 0xffff;
      }
      target[targetRow + x] = (packByte(blue) | (packByte(green) << 8)
        | (packByte(red) << 16) | (packByte(alpha) << 24)) >>> 0;
    }
  }
}

function convolveGenericPass(
  source: Uint32Array,
  width: number,
  x: number,
  interior: boolean,
  taps: GenericConvolutionTaps,
  rowBases: Int32Array,
  state: PreparedConvolution,
  output: Int32Array,
): void {
  const dx = taps.dx;
  const magnitudes = taps.magnitude;
  const positive = taps.positive;
  let p0 = 0; let p1 = 0; let p2 = 0; let p3 = 0;
  let n0 = 0; let n1 = 0; let n2 = 0; let n3 = 0;
  for (let tap = 0; tap < taps.count; tap++) {
    const sourceX = interior ? x + dx[tap]! : clamp(x + dx[tap]!, 0, width - 1);
    const pixel = source[rowBases[tap]! + sourceX]!;
    const magnitude = magnitudes[tap]!;
    const w0 = Math.imul(pixel & 255, magnitude) & 0xffff;
    const w1 = Math.imul((pixel >>> 8) & 255, magnitude) & 0xffff;
    const w2 = Math.imul((pixel >>> 16) & 255, magnitude) & 0xffff;
    const w3 = Math.imul(pixel >>> 24, magnitude) & 0xffff;
    if (positive[tap] !== 0) {
      p0 += w0; p1 += w1; p2 += w2; p3 += w3;
    } else {
      n0 += w0; n1 += w1; n2 += w2; n3 += w3;
    }
  }
  if (state.saturatePositive) {
    p0 = Math.min(0xffff, p0); p1 = Math.min(0xffff, p1);
    p2 = Math.min(0xffff, p2); p3 = Math.min(0xffff, p3);
  } else {
    p0 &= 0xffff; p1 &= 0xffff; p2 &= 0xffff; p3 &= 0xffff;
  }
  if (state.saturateNegative) {
    n0 = Math.min(0xffff, n0); n1 = Math.min(0xffff, n1);
    n2 = Math.min(0xffff, n2); n3 = Math.min(0xffff, n3);
  } else {
    n0 &= 0xffff; n1 &= 0xffff; n2 &= 0xffff; n3 &= 0xffff;
  }
  if (state.bias > 0) {
    p0 = Math.min(0xffff, p0 + state.biasProduct); p1 = Math.min(0xffff, p1 + state.biasProduct);
    p2 = Math.min(0xffff, p2 + state.biasProduct); p3 = Math.min(0xffff, p3 + state.biasProduct);
  } else if (state.bias < 0) {
    n0 = Math.min(0xffff, n0 + state.biasProduct); n1 = Math.min(0xffff, n1 + state.biasProduct);
    n2 = Math.min(0xffff, n2 + state.biasProduct); n3 = Math.min(0xffff, n3 + state.biasProduct);
  }
  output[0] = combineWords(p0, n0, state);
  output[1] = combineWords(p1, n1, state);
  output[2] = combineWords(p2, n2, state);
  output[3] = combineWords(p3, n3, state);
}

/**
 * Most shipped convolution presets use a small, non-saturating kernel and a power-of-two
 * scale.  Keep the four 16-bit channel sums in scalars and only clamp coordinates
 * on the narrow left/right border.  This preserves the APE's word arithmetic while
 * avoiding four helper calls and two coordinate clamps for every tap and pixel.
 */
function renderFastConvolution(
  source: Uint32Array,
  target: Uint32Array,
  width: number,
  height: number,
  state: PreparedConvolution,
): void {
  const dx = state.positiveDx;
  const dy = state.positiveDy;
  const coefficients = state.positiveCoefficients;
  const tapCount = coefficients.length;
  const negativeDy = state.negativeDy;
  const negativeTapCount = state.negativeCoefficients.length;
  if (negativeTapCount === 0 && tapCount === 1 && coefficients[0] === 1 && state.scaleShift === 0
      && state.bias === 0) {
    const shiftX = dx[0]!;
    const shiftY = dy[0]!;
    for (let y = 0; y < height; y++) {
      const sourceRow = clamp(y + shiftY, 0, height - 1) * width;
      const targetRow = y * width;
      if (shiftX === 0) {
        target.set(source.subarray(sourceRow, sourceRow + width), targetRow);
      } else {
        for (let x = 0; x < width; x++) {
          target[targetRow + x] = source[sourceRow + clamp(x + shiftX, 0, width - 1)]!;
        }
      }
    }
    return;
  }

  const rowBases = new Int32Array(tapCount);
  const negativeRowBases = new Int32Array(negativeTapCount);
  const interiorStart = Math.min(width, state.leftEdge);
  const interiorEnd = Math.max(interiorStart, width - state.rightEdge);
  const interiorTop = state.topEdge;
  const interiorBottom = height - state.bottomEdge;
  // Rows whose taps never clamp run their unclamped column span through the
  // generated kernel; border pixels (and builds without codegen) keep the loop.
  const kernel = state.exactLanes && interiorStart < interiorEnd && interiorTop < interiorBottom
    ? convolutionInteriorKernel(state, width)
    : null;
  const reciprocal = state.scaleShift < 0 ? Math.floor(0x10000 / state.divisor) & 0xffff : 0;
  for (let y = 0; y < height; y++) {
    for (let tap = 0; tap < tapCount; tap++) {
      rowBases[tap] = clamp(y + dy[tap]!, 0, height - 1) * width;
    }
    for (let tap = 0; tap < negativeTapCount; tap++) {
      negativeRowBases[tap] = clamp(y + negativeDy[tap]!, 0, height - 1) * width;
    }
    const targetRow = y * width;
    if (kernel && y >= interiorTop && y < interiorBottom) {
      // Left border, interior, right border: still row-major for in-place kernels.
      renderFastConvolutionSpan(source, target, width, state, rowBases, negativeRowBases,
        targetRow, 0, interiorStart, interiorStart, interiorEnd, reciprocal);
      kernel(source, target, targetRow + interiorStart, targetRow + interiorEnd);
      renderFastConvolutionSpan(source, target, width, state, rowBases, negativeRowBases,
        targetRow, interiorEnd, width, interiorStart, interiorEnd, reciprocal);
    } else {
      renderFastConvolutionSpan(source, target, width, state, rowBases, negativeRowBases,
        targetRow, 0, width, interiorStart, interiorEnd, reciprocal);
    }
  }
}

function renderFastConvolutionSpan(
  source: Uint32Array,
  target: Uint32Array,
  width: number,
  state: PreparedConvolution,
  rowBases: Int32Array,
  negativeRowBases: Int32Array,
  targetRow: number,
  from: number,
  to: number,
  interiorStart: number,
  interiorEnd: number,
  reciprocal: number,
): void {
  const dx = state.positiveDx;
  const coefficients = state.positiveCoefficients;
  const tapCount = coefficients.length;
  const negativeDx = state.negativeDx;
  const negativeCoefficients = state.negativeCoefficients;
  const negativeTapCount = negativeCoefficients.length;
  const hasNegative = state.hasNegative;
  const positiveBias = state.bias > 0 ? state.biasProduct : 0;
  const negativeBias = state.bias < 0 ? state.biasProduct : 0;
  const shift = state.scaleShift;
  for (let x = from; x < to; x++) {
    let redBlue = state.positiveBiasLanes;
    let green = positiveBias;
    let alpha = positiveBias;
    let negativeRedBlue = state.negativeBiasLanes;
    let negativeGreen = negativeBias;
    let negativeAlpha = negativeBias;
    const interior = x >= interiorStart && x < interiorEnd;
    for (let tap = 0; tap < tapCount; tap++) {
      const sourceX = interior ? x + dx[tap]! : clamp(x + dx[tap]!, 0, width - 1);
      const pixel = source[rowBases[tap]! + sourceX]!;
      const coefficient = coefficients[tap]!;
      redBlue += (pixel & 0x00ff00ff) * coefficient;
      green += ((pixel >>> 8) & 255) * coefficient;
      alpha += (pixel >>> 24) * coefficient;
    }
    for (let tap = 0; tap < negativeTapCount; tap++) {
      const sourceX = interior ? x + negativeDx[tap]! : clamp(x + negativeDx[tap]!, 0, width - 1);
      const pixel = source[negativeRowBases[tap]! + sourceX]!;
      const coefficient = negativeCoefficients[tap]!;
      negativeRedBlue += (pixel & 0x00ff00ff) * coefficient;
      negativeGreen += ((pixel >>> 8) & 255) * coefficient;
      negativeAlpha += (pixel >>> 24) * coefficient;
    }
    let blue = redBlue & 0xffff;
    let red = Math.floor(redBlue / 0x10000);
    if (hasNegative) {
      const negativeBlue = negativeRedBlue & 0xffff;
      const negativeRed = Math.floor(negativeRedBlue / 0x10000);
      blue = blue > negativeBlue ? blue - negativeBlue : 0;
      green = green > negativeGreen ? green - negativeGreen : 0;
      red = red > negativeRed ? red - negativeRed : 0;
      alpha = alpha > negativeAlpha ? alpha - negativeAlpha : 0;
    }
    if (shift >= 0) {
      blue >>>= shift; green >>>= shift; red >>>= shift; alpha >>>= shift;
    } else {
      blue = Math.floor((blue * reciprocal) / 0x10000) & 0xffff;
      green = Math.floor((green * reciprocal) / 0x10000) & 0xffff;
      red = Math.floor((red * reciprocal) / 0x10000) & 0xffff;
      alpha = Math.floor((alpha * reciprocal) / 0x10000) & 0xffff;
    }
    blue = packByte(blue); green = packByte(green);
    red = packByte(red); alpha = packByte(alpha);
    target[targetRow + x] = (blue | (green << 8) | (red << 16) | (alpha << 24)) >>> 0;
  }
}

/** Generated interior kernels, shared by source text across instances. */
const interiorKernelCache = new Map<string, ConvolutionInteriorKernel>();
const INTERIOR_KERNEL_CACHE_LIMIT = 64;
/** Cleared once `new Function` throws (a CSP without 'unsafe-eval'). */
let interiorKernelsAvailable = true;

function convolutionInteriorKernel(state: PreparedConvolution, width: number): ConvolutionInteriorKernel | null {
  if (state.interiorWidth === width) return state.interiorKernel;
  state.interiorWidth = width;
  state.interiorKernel = null;
  if (!interiorKernelsAvailable) return null;
  const code = interiorKernelSource(state, width);
  let kernel = interiorKernelCache.get(code);
  if (!kernel) {
    try {
      kernel = new Function('source', 'target', 'start', 'end', code) as ConvolutionInteriorKernel;
    } catch {
      interiorKernelsAvailable = false;
      return null;
    }
    // Every resize and preset adds entries; bound the cache (states keep their own kernel).
    if (interiorKernelCache.size >= INTERIOR_KERNEL_CACHE_LIMIT) interiorKernelCache.clear();
    interiorKernelCache.set(code, kernel);
  }
  state.interiorKernel = kernel;
  return kernel;
}

/**
 * Straight-line body of renderFastConvolutionSpan's interior case, with each
 * tap's offset (dy * width + dx) and coefficient folded to a constant and `* 1`
 * elided. Green and alpha share a packed accumulator like red and blue: under
 * `exactLanes` every lane stays below 0x10000 (see prepareConvolution) and each
 * sum below 2^32, so `& 0xffff` / `>>> 16` equal the loop's `& 0xffff` /
 * `Math.floor(/ 0x10000)`, and `(v * reciprocal) >>> 16` equals
 * `Math.floor(v * reciprocal / 0x10000) & 0xffff` for v, reciprocal < 0x10000.
 */
function interiorKernelSource(state: PreparedConvolution, width: number): string {
  const lines = ['for (let i = start; i < end; i++) {'];
  const accumulate = (
    dx: Int8Array, dy: Int8Array, coefficients: Uint16Array, prefix: string, biasLanes: number,
  ): void => {
    const redBlue = biasLanes !== 0 ? [String(biasLanes)] : [];
    const greenAlpha = biasLanes !== 0 ? [String(biasLanes)] : [];
    for (let tap = 0; tap < coefficients.length; tap++) {
      const offset = dy[tap]! * width + dx[tap]!;
      const pixel = `${prefix}${tap}`;
      const factor = coefficients[tap] === 1 ? '' : ` * ${coefficients[tap]}`;
      const index = offset === 0 ? 'i' : offset > 0 ? `i + ${offset}` : `i - ${-offset}`;
      lines.push(`const ${pixel} = source[${index}];`);
      redBlue.push(`(${pixel} & 16711935)${factor}`);
      greenAlpha.push(`((${pixel} >>> 8) & 16711935)${factor}`);
    }
    lines.push(`const ${prefix}rb = ${redBlue.join(' + ') || '0'};`);
    lines.push(`const ${prefix}ga = ${greenAlpha.join(' + ') || '0'};`);
  };
  accumulate(state.positiveDx, state.positiveDy, state.positiveCoefficients, 'p', state.positiveBiasLanes);
  lines.push('let b = prb & 65535, r = prb >>> 16, g = pga & 65535, a = pga >>> 16;');
  if (state.hasNegative) {
    accumulate(state.negativeDx, state.negativeDy, state.negativeCoefficients, 'n', state.negativeBiasLanes);
    lines.push('const nb = nrb & 65535, nr = nrb >>> 16, ng = nga & 65535, na = nga >>> 16;');
    lines.push('b = b > nb ? b - nb : 0; g = g > ng ? g - ng : 0;');
    lines.push('r = r > nr ? r - nr : 0; a = a > na ? a - na : 0;');
  }
  const shift = state.scaleShift;
  if (shift > 0) {
    lines.push(`b >>>= ${shift}; g >>>= ${shift}; r >>>= ${shift}; a >>>= ${shift};`);
  } else if (shift < 0) {
    const reciprocal = Math.floor(0x10000 / state.divisor) & 0xffff;
    lines.push(`b = (b * ${reciprocal}) >>> 16; g = (g * ${reciprocal}) >>> 16;`);
    lines.push(`r = (r * ${reciprocal}) >>> 16; a = (a * ${reciprocal}) >>> 16;`);
  }
  // packByte for 0 <= v < 0x10000: a set sign bit (v > 0x7fff) clamps to 0.
  for (const channel of ['b', 'g', 'r', 'a']) {
    lines.push(`${channel} = ${channel} > 32767 ? 0 : ${channel} > 255 ? 255 : ${channel};`);
  }
  lines.push('target[i] = b | (g << 8) | (r << 16) | (a << 24);', '}');
  return lines.join('\n');
}

/**
 * A full 7x7 constant kernel is separable. Compute the clamped horizontal
 * window once, then slide the vertical window. Each packed lane stays below
 * 16 bits because this path is restricted to the native non-saturating case.
 */
function renderBoxConvolution(
  source: Uint32Array,
  target: Uint32Array,
  width: number,
  height: number,
  state: PreparedConvolution,
): void {
  let scratch = state.boxScratch;
  if (!scratch || scratch.width !== width || scratch.height !== height) {
    scratch = {
      width,
      height,
      redBlue: new Uint32Array(width * height),
      greenAlpha: new Uint32Array(width * height),
    };
    state.boxScratch = scratch;
  }
  const horizontalRedBlue = scratch.redBlue;
  const horizontalGreenAlpha = scratch.greenAlpha;
  for (let y = 0; y < height; y++) {
    const row = y * width;
    const first = source[row]!;
    let redBlue = (first & 255) * 4 + (((first >>> 16) & 255) * 4 * 0x10000);
    let greenAlpha = ((first >>> 8) & 255) * 4 + ((first >>> 24) * 4 * 0x10000);
    for (let x = 1; x <= Math.min(3, width - 1); x++) {
      const pixel = source[row + x]!;
      redBlue += (pixel & 255) + (((pixel >>> 16) & 255) * 0x10000);
      greenAlpha += ((pixel >>> 8) & 255) + ((pixel >>> 24) * 0x10000);
    }
    if (width < 4) {
      const last = source[row + width - 1]!;
      const missing = 4 - width;
      redBlue += (last & 255) * missing + (((last >>> 16) & 255) * missing * 0x10000);
      greenAlpha += ((last >>> 8) & 255) * missing + ((last >>> 24) * missing * 0x10000);
    }
    for (let x = 0; x < width; x++) {
      horizontalRedBlue[row + x] = redBlue;
      horizontalGreenAlpha[row + x] = greenAlpha;
      const removeX = x < 3 ? 0 : x - 3;
      const addX = x + 4 >= width ? width - 1 : x + 4;
      const remove = source[row + removeX]!;
      const add = source[row + addX]!;
      redBlue += (add & 255) - (remove & 255)
        + ((((add >>> 16) & 255) - ((remove >>> 16) & 255)) * 0x10000);
      greenAlpha += ((add >>> 8) & 255) - ((remove >>> 8) & 255)
        + (((add >>> 24) - (remove >>> 24)) * 0x10000);
    }
  }

  const coefficient = state.boxCoefficient;
  const reciprocal = state.scaleShift < 0 ? Math.floor(0x10000 / state.divisor) & 0xffff : 0;
  for (let x = 0; x < width; x++) {
    let redBlue = horizontalRedBlue[x]! * 4;
    let greenAlpha = horizontalGreenAlpha[x]! * 4;
    for (let y = 1; y <= Math.min(3, height - 1); y++) {
      redBlue += horizontalRedBlue[y * width + x]!;
      greenAlpha += horizontalGreenAlpha[y * width + x]!;
    }
    if (height < 4) {
      const last = (height - 1) * width + x;
      const missing = 4 - height;
      redBlue += horizontalRedBlue[last]! * missing;
      greenAlpha += horizontalGreenAlpha[last]! * missing;
    }
    for (let y = 0; y < height; y++) {
      let blue = (redBlue & 0xffff) * coefficient;
      let red = Math.floor(redBlue / 0x10000) * coefficient;
      let green = (greenAlpha & 0xffff) * coefficient;
      let alpha = Math.floor(greenAlpha / 0x10000) * coefficient;
      if (state.scaleShift >= 0) {
        blue >>>= state.scaleShift; green >>>= state.scaleShift;
        red >>>= state.scaleShift; alpha >>>= state.scaleShift;
      } else {
        blue = Math.floor((blue * reciprocal) / 0x10000) & 0xffff;
        green = Math.floor((green * reciprocal) / 0x10000) & 0xffff;
        red = Math.floor((red * reciprocal) / 0x10000) & 0xffff;
        alpha = Math.floor((alpha * reciprocal) / 0x10000) & 0xffff;
      }
      blue = packByte(blue); green = packByte(green);
      red = packByte(red); alpha = packByte(alpha);
      target[y * width + x] = (blue | (green << 8) | (red << 16) | (alpha << 24)) >>> 0;

      const removeY = y < 3 ? 0 : y - 3;
      const addY = y + 4 >= height ? height - 1 : y + 4;
      redBlue += horizontalRedBlue[addY * width + x]! - horizontalRedBlue[removeY * width + x]!;
      greenAlpha += horizontalGreenAlpha[addY * width + x]! - horizontalGreenAlpha[removeY * width + x]!;
    }
  }
}

interface CoefficientSums {
  readonly saturatePositive: boolean;
  readonly saturateNegative: boolean;
}

function coefficientSums(kernel: readonly number[], bias: number): CoefficientSums {
  let positive = 0;
  let negative = 0;
  for (const coefficient of [...kernel, bias]) {
    if (coefficient > 0) positive = (positive + coefficient) >>> 0;
    else if (coefficient < 0) negative = (negative + (-coefficient >>> 0)) >>> 0;
  }
  return { saturatePositive: positive >= 256, saturateNegative: negative >= 256 };
}

function combineWords(positive: number, negative: number, state: PreparedConvolution): number {
  if (!state.hasNegative) return positive;
  if (state.config.absolute) {
    return (clamp(signed16(positive) - signed16(negative), -0x8000, 0x7fff) & 0xffff) & 0x7fff;
  }
  if (state.config.wrap) return (positive - negative) & 0xffff;
  return positive > negative ? positive - negative : 0;
}

function signed16(value: number): number { return value & 0x8000 ? (value & 0xffff) - 0x10000 : value & 0xffff; }
function packByte(value: number): number {
  const signed = signed16(value);
  return signed < 0 ? 0 : signed > 255 ? 255 : signed;
}
function clamp(value: number, minimum: number, maximum: number): number {
  return value < minimum ? minimum : value > maximum ? maximum : value;
}
