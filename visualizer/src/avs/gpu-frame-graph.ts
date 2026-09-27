import {
  buildStaticAvsMovementGpuMap,
  type AvsMovementConfig,
} from './effects/movement.ts';
import {
  buildStaticAvsBlitterFeedbackGpuParams,
  buildStaticAvsRotoBlitterGpuParams,
  type AvsBlitterFeedbackConfig,
  type AvsRotoBlitterConfig,
} from './effects/blitter-gpu.ts';
import { GpuTimer } from '../gputimer.ts';

/**
 * Packed-u32 WebGPU frame-graph seam for the AVS compatibility renderer.
 *
 * The compatibility executor still fills the primary buffer on the CPU.  The
 * terminal pass consumes that packed buffer directly, avoiding the old
 * packed-RGB -> RGBA ImageData conversion.  Future exact compute effects can
 * alternate primary/secondary without changing presentation or introducing a
 * framebuffer readback.
 */

export type AvsFrameGraphLane = 'exact' | '120';
export type AvsResidentFrameSlot = 'primary' | 'secondary';

export interface AvsFrameGraphCapability {
  readonly id: string;
  readonly backend: 'webgpu' | 'cpu';
  readonly lane: AvsFrameGraphLane;
  readonly byteExact: boolean;
  readonly reason: string;
}

export const AVS_GPU_TERMINAL_CAPABILITY: AvsFrameGraphCapability = {
  id: 'packed-u32-terminal',
  backend: 'webgpu',
  lane: 'exact',
  byteExact: true,
  reason: 'Unpacks AVS 0x00RRGGBB channels with integer shifts; no filtering or blend approximation.',
};

export interface AvsFrameGraphTiming {
  readonly frame: number;
  readonly uploadMs: number;
  readonly encodeSubmitMs: number;
  /** Wall time to queue completion; asynchronous and absent if timing is disabled. */
  readonly gpuCompleteMs?: number;
}

export interface PackedAvsGpuFrameGraphOptions {
  readonly canvas: OffscreenCanvas;
  readonly width: number;
  readonly height: number;
  /** Exact is the default. Approximate passes require an explicit 120 lane. */
  readonly lane?: AvsFrameGraphLane;
  readonly onTiming?: (timing: AvsFrameGraphTiming) => void;
  /**
   * Request `timestamp-query` when the adapter offers it and time every node
   * plus the terminal pass. Readback is ring-buffered and never awaited, so the
   * numbers arrive a frame or two late. Off by default; pixels are unaffected.
   */
  readonly timestamps?: boolean;
  /** Called once if the device is lost for any reason other than `destroy()`. */
  readonly onDeviceLost?: (reason: string) => void;
  /** Validation, out-of-memory and internal errors no error scope captured. */
  readonly onUncapturedError?: (message: string) => void;
}

/**
 * The only canvas configuration the exact AVS terminal may present with. The
 * terminal writes `channel / 255` into a non-sRGB unorm target, which the
 * swap chain stores back as exactly `channel`; the compositor then treats
 * those bytes as sRGB, which is what Winamp-era output was. An `-srgb` format
 * or view format, a wide-gamut colour space, extended tone mapping or
 * premultiplied alpha would each silently change every AVS pixel. Display
 * filters (upscaling, HDR) belong in a separate pipeline, never here.
 */
export function avsPresentCanvasConfiguration(device: GPUDevice, format: GPUTextureFormat): GPUCanvasConfiguration {
  const configuration: GPUCanvasConfiguration = { device, format, alphaMode: 'opaque', colorSpace: 'srgb' };
  assertAvsPresentCanvasConfiguration(configuration);
  return configuration;
}

/** Guardrail for `avsPresentCanvasConfiguration`; throws on any colour-altering setting. */
export function assertAvsPresentCanvasConfiguration(configuration: GPUCanvasConfiguration): void {
  if (configuration.format.endsWith('-srgb')) {
    throw new Error(`AVS present format ${configuration.format} would re-encode exact bytes`);
  }
  if (configuration.format !== 'bgra8unorm' && configuration.format !== 'rgba8unorm') {
    throw new Error(`AVS present format ${configuration.format} is not an 8-bit unorm swap-chain format`);
  }
  if (configuration.viewFormats && Array.from(configuration.viewFormats).length > 0) {
    throw new Error('AVS present configuration must not declare viewFormats');
  }
  if ((configuration.alphaMode ?? 'opaque') !== 'opaque') {
    throw new Error(`AVS present alphaMode ${String(configuration.alphaMode)} is not opaque`);
  }
  if ((configuration.colorSpace ?? 'srgb') !== 'srgb') {
    throw new Error(`AVS present colorSpace ${String(configuration.colorSpace)} is not srgb`);
  }
  const toneMapping = (configuration as { toneMapping?: { mode?: string } }).toneMapping;
  if (toneMapping && (toneMapping.mode ?? 'standard') !== 'standard') {
    throw new Error(`AVS present toneMapping ${String(toneMapping.mode)} is not standard SDR`);
  }
}

export interface AvsFrameGraphPresentResult {
  readonly uploadMs: number;
  readonly encodeSubmitMs: number;
}

export interface AvsGpuPassContext {
  readonly device: GPUDevice;
  readonly encoder: GPUCommandEncoder;
  readonly width: number;
  readonly height: number;
  readonly source: GPUBuffer;
  readonly target: GPUBuffer;
}

/** A compiled pass owns/cache its pipeline and only records commands here. */
export interface PackedAvsGpuPass {
  readonly capability: AvsFrameGraphCapability;
  encode(context: AvsGpuPassContext): void;
  /**
   * Releases size-baked GPU buffers. The frame graph now outlives its passes
   * (resize and preset changes keep the device), so a discarded pass no longer
   * gets freed by `device.destroy()`. Optional; must be idempotent.
   */
  destroy?(): void;
}

export interface AvsFrameGraphPlan {
  readonly width: number;
  readonly height: number;
  readonly pixels: number;
  readonly framebufferBytes: number;
  readonly residentBytes: number;
}

export interface ExactAvsBlurConfig {
  readonly mode: 1 | 2 | 3;
  readonly roundUp: boolean;
}

export type ExactAvsPointwiseOperation =
  | { readonly kind: 'fade'; readonly fade: number; readonly target: number }
  | { readonly kind: 'invert' }
  | { readonly kind: 'fast-brightness'; readonly direction: 0 | 1 }
  | { readonly kind: 'channel-shift'; readonly mode: number }
  | { readonly kind: 'color-reduction'; readonly mask: number }
  | { readonly kind: 'multiplier'; readonly mode: number }
  | {
    readonly kind: 'color-clip';
    readonly mode: 1 | 2 | 3;
    readonly source: number;
    readonly replacement: number;
    readonly distanceSquared: number;
  }
  | {
    readonly kind: 'brightness';
    readonly additive: boolean;
    readonly average: boolean;
    readonly redMultiplier: number;
    readonly greenMultiplier: number;
    readonly blueMultiplier: number;
    readonly reference: number;
    readonly exclude: boolean;
    readonly distance: number;
  };

export type ExactAvsGpuPassConfig =
  | { readonly kind: 'blur'; readonly config: ExactAvsBlurConfig }
  | { readonly kind: 'pointwise'; readonly operations: readonly ExactAvsPointwiseOperation[] }
  | { readonly kind: 'movement'; readonly config: AvsMovementConfig }
  | { readonly kind: 'roto-blitter'; readonly config: AvsRotoBlitterConfig }
  | { readonly kind: 'blitter-feedback'; readonly config: AvsBlitterFeedbackConfig };

export const AVS_GPU_BLUR_CAPABILITY: AvsFrameGraphCapability = {
  id: 'classic-blur-packed-u32', backend: 'webgpu', lane: 'exact', byteExact: true,
  reason: 'Uses AVS integer channel shifts, zero-edge kernels, and per-mode rounding in packed u32 storage.',
};

export const AVS_GPU_POINTWISE_CAPABILITY: AvsFrameGraphCapability = {
  id: 'classic-pointwise-fused-packed-u32', backend: 'webgpu', lane: 'exact', byteExact: true,
  reason: 'Fuses stateless AVS byte-channel transforms into one integer storage-buffer dispatch.',
};

export const AVS_GPU_MOVEMENT_CAPABILITY: AvsFrameGraphCapability = {
  id: 'classic-movement-static-map-packed-u32', backend: 'webgpu', lane: 'exact', byteExact: true,
  reason: 'CPU builds one immutable native coordinate table; WebGPU performs exact packed-u32 nearest/bilinear resampling.',
};

export const AVS_GPU_ROTO_BLITTER_CAPABILITY: AvsFrameGraphCapability = {
  id: 'classic-roto-blitter-affine-packed-u32', backend: 'webgpu', lane: 'exact', byteExact: true,
  reason: 'Evaluates native 16.16 affine coordinates and packed nearest/bilinear sampling per destination pixel.',
};

export const AVS_GPU_BLITTER_FEEDBACK_CAPABILITY: AvsFrameGraphCapability = {
  id: 'classic-blitter-feedback-affine-packed-u32', backend: 'webgpu', lane: 'exact', byteExact: true,
  reason: 'Evaluates native static zoom coordinates, legacy group-of-four stepping, and packed sampling per destination pixel.',
};

export const AVS_EXACT_BLUR_WGSL = /* wgsl */ `
struct Params { width: u32, height: u32, mode: u32, rounding: u32 };
@group(0) @binding(0) var<storage, read> source: array<u32>;
@group(0) @binding(1) var<storage, read_write> destination: array<u32>;
@group(0) @binding(2) var<uniform> params: Params;

fn shifted(pixel: u32, amount: u32) -> u32 {
  let masks = array<u32, 5>(0u, 0x007f7f7fu, 0x003f3f3fu, 0x001f1f1fu, 0x000f0f0fu);
  return (pixel >> amount) & masks[amount];
}

@compute @workgroup_size(256)
fn blur_main(@builtin(global_invocation_id) id: vec3u) {
  let index = id.x;
  let count = params.width * params.height;
  if (index >= count) { return; }
  if (params.width < 2u || params.height < 2u) {
    destination[index] = source[index] & 0x00ffffffu;
    return;
  }
  let x = index % params.width;
  let y = index / params.width;
  let at_left = x == 0u;
  let at_right = x + 1u == params.width;
  let at_top = y == 0u;
  let at_bottom = y + 1u == params.height;
  let center = source[index];
  var left = 0u; var right = 0u; var up = 0u; var down = 0u;
  if (!at_left) { left = source[index - 1u]; }
  if (!at_right) { right = source[index + 1u]; }
  if (!at_top) { up = source[index - params.width]; }
  if (!at_bottom) { down = source[index + params.width]; }
  let corner = (at_left || at_right) && (at_top || at_bottom);
  let edge = at_left || at_right || at_top || at_bottom;
  var value = 0u;
  var round = 0u;
  if (params.mode == 3u) {
    value += select(shifted(left, 2u) + shifted(right, 2u), shifted(select(left, right, at_left), 1u), at_left || at_right);
    value += select(shifted(up, 2u) + shifted(down, 2u), shifted(select(up, down, at_top), 1u), at_top || at_bottom);
    round = select(3u, select(2u, 1u, corner), at_left || at_right || at_top || at_bottom);
  } else if (params.mode == 2u) {
    value = shifted(center, 1u);
    if (corner) {
      value += shifted(center, 2u) + shifted(select(left, right, at_left), 3u) + shifted(select(up, down, at_top), 3u);
      round = 3u;
    } else if (edge) {
      value += shifted(center, 3u);
      if (at_top || at_bottom) {
        value += shifted(left, 3u) + shifted(right, 3u) + shifted(select(up, down, at_top), 3u);
      } else {
        value += shifted(select(left, right, at_left), 3u) + shifted(up, 3u) + shifted(down, 3u);
      }
      round = 4u;
    } else {
      value += shifted(center, 2u) + shifted(left, 4u) + shifted(right, 4u) + shifted(up, 4u) + shifted(down, 4u);
      round = 5u;
    }
  } else {
    if (corner) {
      value = shifted(center, 1u) + shifted(select(left, right, at_left), 2u) + shifted(select(up, down, at_top), 2u);
      round = 2u;
    } else if (at_top || at_bottom) {
      value = shifted(center, 2u) + shifted(left, 2u) + shifted(right, 2u) + shifted(select(up, down, at_top), 2u);
      round = 3u;
    } else if (at_left || at_right) {
      value = shifted(center, 2u) + shifted(select(left, right, at_left), 2u) + shifted(up, 2u) + shifted(down, 2u);
      round = 3u;
    } else {
      value = shifted(center, 1u) + shifted(left, 3u) + shifted(right, 3u) + shifted(up, 3u) + shifted(down, 3u);
      round = 4u;
    }
  }
  let rounding = select(0u, round * 0x00010101u, params.rounding != 0u);
  destination[index] = (value + rounding) & 0x00ffffffu;
}
`;

/**
 * Specialize a pointwise chain once per preset. Consecutive effects stay in
 * registers and therefore cost one storage read/write pair instead of one
 * full-frame pass per AVS component.
 */
export const AVS_EXACT_POINTWISE_HELPERS_WGSL = /* wgsl */ `
fn avs_approach(value: i32, target_value: i32, amount: i32) -> u32 {
  if (value <= target_value - amount) { return u32(value + amount) & 255u; }
  if (value >= target_value + amount) { return u32(value - amount) & 255u; }
  return u32(target_value) & 255u;
}
fn avs_pack(low: u32, middle: u32, high: u32) -> u32 { return (low & 255u) | ((middle & 255u) << 8u) | ((high & 255u) << 16u); }
fn avs_adjust(pixel: u32, red_multiplier: u32, green_multiplier: u32, blue_multiplier: u32) -> u32 {
  return avs_pack(min(255u, ((pixel & 255u) * blue_multiplier) / 65536u), min(255u, (((pixel >> 8u) & 255u) * green_multiplier) / 65536u), min(255u, (((pixel >> 16u) & 255u) * red_multiplier) / 65536u));
}
fn avs_add(left: u32, right: u32) -> u32 { return avs_pack(min(255u, (left & 255u) + (right & 255u)), min(255u, ((left >> 8u) & 255u) + ((right >> 8u) & 255u)), min(255u, ((left >> 16u) & 255u) + ((right >> 16u) & 255u))); }
fn avs_in_range(pixel: u32, reference: u32, distance: i32) -> bool {
  return abs(i32(pixel & 255u) - i32(reference & 255u)) <= distance && abs(i32((pixel >> 8u) & 255u) - i32((reference >> 8u) & 255u)) <= distance && abs(i32((pixel >> 16u) & 255u) - i32((reference >> 16u) & 255u)) <= distance;
}`;

export function buildExactAvsPointwiseBody(operations: readonly ExactAvsPointwiseOperation[]): string {
  if (!operations.length) throw new RangeError('Pointwise GPU fragment needs at least one operation');
  return operations.map((operation, index) => pointwiseWgsl(operation, index)).join('\n');
}

export function buildExactAvsPointwiseWgsl(
  operations: readonly ExactAvsPointwiseOperation[],
): string {
  if (operations.length === 0) throw new RangeError('Pointwise GPU pass needs at least one operation');
  const body = operations.map((operation, index) => pointwiseWgsl(operation, index)).join('\n');
  return /* wgsl */ `
@group(0) @binding(0) var<storage, read> source: array<u32>;
@group(0) @binding(1) var<storage, read_write> destination: array<u32>;

fn avs_approach(value: i32, target_value: i32, amount: i32) -> u32 {
  if (value <= target_value - amount) { return u32(value + amount) & 255u; }
  if (value >= target_value + amount) { return u32(value - amount) & 255u; }
  return u32(target_value) & 255u;
}

fn avs_pack(low: u32, middle: u32, high: u32) -> u32 {
  return (low & 255u) | ((middle & 255u) << 8u) | ((high & 255u) << 16u);
}

fn avs_adjust(pixel: u32, red_multiplier: u32, green_multiplier: u32, blue_multiplier: u32) -> u32 {
  let low = min(255u, ((pixel & 255u) * blue_multiplier) / 65536u);
  let middle = min(255u, (((pixel >> 8u) & 255u) * green_multiplier) / 65536u);
  let high = min(255u, (((pixel >> 16u) & 255u) * red_multiplier) / 65536u);
  return avs_pack(low, middle, high);
}

fn avs_add(left: u32, right: u32) -> u32 {
  return avs_pack(
    min(255u, (left & 255u) + (right & 255u)),
    min(255u, ((left >> 8u) & 255u) + ((right >> 8u) & 255u)),
    min(255u, ((left >> 16u) & 255u) + ((right >> 16u) & 255u)),
  );
}

fn avs_in_range(pixel: u32, reference: u32, distance: i32) -> bool {
  return abs(i32(pixel & 255u) - i32(reference & 255u)) <= distance
    && abs(i32((pixel >> 8u) & 255u) - i32((reference >> 8u) & 255u)) <= distance
    && abs(i32((pixel >> 16u) & 255u) - i32((reference >> 16u) & 255u)) <= distance;
}

@compute @workgroup_size(256)
fn pointwise_main(@builtin(global_invocation_id) id: vec3u) {
  let index = id.x;
  if (index >= arrayLength(&source)) { return; }
  var pixel = source[index] & 0x00ffffffu;
${indentWgsl(body, 2)}
  destination[index] = pixel & 0x00ffffffu;
}
`;
}

function pointwiseWgsl(operation: ExactAvsPointwiseOperation, index: number): string {
  switch (operation.kind) {
    case 'fade': {
      assertIntegerRange(operation.fade, 1, 255, 'Fade amount');
      const target = operation.target & 0x00ffffff;
      return `// fused ${index}: Fade Out\n` +
        `pixel = avs_pack(` +
        `avs_approach(i32(pixel & 255u), ${target & 255}i, ${operation.fade}i), ` +
        `avs_approach(i32((pixel >> 8u) & 255u), ${(target >>> 8) & 255}i, ${operation.fade}i), ` +
        `avs_approach(i32((pixel >> 16u) & 255u), ${(target >>> 16) & 255}i, ${operation.fade}i));`;
    }
    case 'invert':
      return `// fused ${index}: Invert\npixel = pixel ^ 0x00ffffffu;`;
    case 'fast-brightness':
      if (operation.direction !== 0 && operation.direction !== 1) {
        throw new RangeError(`Fast Brightness direction ${String(operation.direction)} is not exact-GPU eligible`);
      }
      return operation.direction === 0
        ? `// fused ${index}: Fast Brightness double\npixel = avs_pack(min(255u, (pixel & 255u) * 2u), min(255u, ((pixel >> 8u) & 255u) * 2u), min(255u, ((pixel >> 16u) & 255u) * 2u));`
        : `// fused ${index}: Fast Brightness half\npixel = (pixel >> 1u) & 0x007f7f7fu;`;
    case 'channel-shift': {
      assertIntegerRange(operation.mode, -0x80000000, 0x7fffffff, 'Channel Shift mode');
      const low='pixel & 255u',middle='(pixel >> 8u) & 255u',high='(pixel >> 16u) & 255u';
      const packed = operation.mode === 1020 ? `avs_pack(${middle}, ${low}, ${high})`
        : operation.mode === 1018 ? `avs_pack(${high}, ${low}, ${middle})`
          : operation.mode === 1022 ? `avs_pack(${low}, ${high}, ${middle})`
            : operation.mode === 1019 ? `avs_pack(${middle}, ${high}, ${low})`
              : operation.mode === 1021 ? `avs_pack(${high}, ${middle}, ${low})` : null;
      return packed ? `// fused ${index}: Channel Shift ${operation.mode}\npixel = ${packed};`
        : `// fused ${index}: Channel Shift ${operation.mode} native no-op`;
    }
    case 'color-reduction':
      assertIntegerRange(operation.mask, 0, 0x00ffffff, 'Color Reduction mask');
      return `// fused ${index}: Color Reduction\nif (index >= 4u) { pixel &= ${operation.mask}u; }`;
    case 'multiplier': {
      assertIntegerRange(operation.mode, -0x80000000, 0x7fffffff, 'Multiplier mode');
      if (operation.mode === 0) return `// fused ${index}: Multiplier infinite root\nif (index > 0u) { pixel = select(0xffffffu, 0u, pixel == 0u); }`;
      if (operation.mode === 7) return `// fused ${index}: Multiplier infinite square\nif (index > 0u) { pixel = select(0u, 0xffffffu, pixel == 0xffffffu); }`;
      if (operation.mode >= 1 && operation.mode <= 3) {
        const factor=1<<(4-operation.mode);
        return `// fused ${index}: Multiplier x${factor}\nif (index < arrayLength(&source) - (arrayLength(&source) & 1u)) { pixel = avs_pack(min(255u, (pixel & 255u) * ${factor}u), min(255u, ((pixel >> 8u) & 255u) * ${factor}u), min(255u, ((pixel >> 16u) & 255u) * ${factor}u)); }`;
      }
      if (operation.mode >= 4 && operation.mode <= 6) {
        const shift=operation.mode-3;
        return `// fused ${index}: Multiplier divide ${1<<shift}\nif (index < arrayLength(&source) - (arrayLength(&source) & 1u)) { pixel = avs_pack((pixel & 255u) >> ${shift}u, ((pixel >> 8u) & 255u) >> ${shift}u, ((pixel >> 16u) & 255u) >> ${shift}u); }`;
      }
      return `// fused ${index}: Multiplier ${operation.mode} native no-op`;
    }
    case 'color-clip': {
      assertIntegerRange(operation.mode, 1, 3, 'Color Clip mode');
      assertIntegerRange(operation.distanceSquared, 0, 195_075, 'Color Clip distance squared');
      const source = operation.source & 0x00ffffff;
      const low = source & 255; const middle = (source >>> 8) & 255; const high = (source >>> 16) & 255;
      const condition = operation.mode === 1
        ? `(pixel & 255u) <= ${low}u && ((pixel >> 8u) & 255u) <= ${middle}u && ((pixel >> 16u) & 255u) <= ${high}u`
        : operation.mode === 2
          ? `(pixel & 255u) >= ${low}u && ((pixel >> 8u) & 255u) >= ${middle}u && ((pixel >> 16u) & 255u) >= ${high}u`
          : `u32((i32(pixel & 255u) - ${low}i) * (i32(pixel & 255u) - ${low}i) + ` +
            `(i32((pixel >> 8u) & 255u) - ${middle}i) * (i32((pixel >> 8u) & 255u) - ${middle}i) + ` +
            `(i32((pixel >> 16u) & 255u) - ${high}i) * (i32((pixel >> 16u) & 255u) - ${high}i)) <= ${operation.distanceSquared}u`;
      return `// fused ${index}: Color Clip\nif (${condition}) { pixel = ${operation.replacement & 0x00ffffff}u; }`;
    }
    case 'brightness': {
      for (const [name, value] of [
        ['red', operation.redMultiplier], ['green', operation.greenMultiplier], ['blue', operation.blueMultiplier],
      ] as const) assertIntegerRange(value, 0, Math.floor(0xffffffff / 255), `Brightness ${name} multiplier`);
      assertIntegerRange(operation.distance, -0x7fffffff, 0x7fffffff, 'Brightness exclusion distance');
      const adjusted = `adjusted_${index}`;
      const excluded = operation.exclude
        ? `if (!avs_in_range(pixel, ${operation.reference & 0x00ffffff}u, ${operation.distance}i)) {\n`
        : '';
      const close = operation.exclude ? '\n}' : '';
      const combine = operation.additive
        ? `pixel = avs_add(pixel, ${adjusted});`
        : operation.average
          ? `pixel = ((pixel >> 1u) & 0x007f7f7fu) + ((${adjusted} >> 1u) & 0x007f7f7fu);`
          : `pixel = ${adjusted};`;
      return `// fused ${index}: Brightness\n${excluded}` +
        `  let ${adjusted} = avs_adjust(pixel, ${operation.redMultiplier}u, ${operation.greenMultiplier}u, ${operation.blueMultiplier}u);\n` +
        `  ${combine}${close}`;
    }
  }
}

function assertIntegerRange(value: number, minimum: number, maximum: number, label: string): void {
  if (!Number.isInteger(value) || value < minimum || value > maximum) {
    throw new RangeError(`${label} ${String(value)} is outside ${minimum}..${maximum}`);
  }
}

function indentWgsl(source: string, spaces: number): string {
  const prefix = ' '.repeat(spaces);
  return source.split('\n').map(line => `${prefix}${line}`).join('\n');
}

export const AVS_EXACT_MOVEMENT_WGSL = /* wgsl */ `
struct Params { width: u32, pixels: u32, bilinear: u32, blend: u32 };
@group(0) @binding(0) var<storage, read> source: array<u32>;
@group(0) @binding(1) var<storage, read_write> destination: array<u32>;
@group(0) @binding(2) var<storage, read> coordinate_map: array<u32>;
@group(0) @binding(3) var<uniform> params: Params;

fn avs_table(first: u32, second: u32) -> u32 {
  var result = (first * second) / 255u;
  // The compatibility oracle builds native g_blendtable in JS as
  // trunc((first / 255) * second). Binary64 lands just below the exact integer
  // for these twelve ordered pairs, so preserve that established byte result.
  let correction = (first == 147u && (second == 85u || second == 170u))
    || (first == 155u && (second == 51u || second == 102u || second == 153u || second == 204u))
    || (first == 171u && (second == 85u || second == 170u))
    || (first == 187u && (second == 75u || second == 150u || second == 165u))
    || (first == 195u && second == 153u);
  if (correction) { result -= 1u; }
  return result;
}
fn avs_average(first: u32, second: u32) -> u32 {
  return ((first >> 1u) & 0x007f7f7fu) + ((second >> 1u) & 0x007f7f7fu);
}
fn avs_bilinear(offset: u32, key: u32) -> u32 {
  let x_part = (key >> 5u) << 3u;
  let y_part = (key & 31u) << 3u;
  let inverse_x = 255u - x_part;
  let inverse_y = 255u - y_part;
  let weights = array<u32, 4>(
    avs_table(inverse_x, inverse_y), avs_table(x_part, inverse_y),
    avs_table(inverse_x, y_part), avs_table(x_part, y_part),
  );
  let samples = array<u32, 4>(
    source[offset], source[offset + 1u],
    source[offset + params.width], source[offset + params.width + 1u],
  );
  var low = 0u; var middle = 0u; var high = 0u;
  for (var sample_index = 0u; sample_index < 4u; sample_index++) {
    let pixel = samples[sample_index]; let weight = weights[sample_index];
    low += avs_table(pixel & 255u, weight);
    middle += avs_table((pixel >> 8u) & 255u, weight);
    high += avs_table((pixel >> 16u) & 255u, weight);
  }
  return (low & 255u) | ((middle & 255u) << 8u) | ((high & 255u) << 16u);
}
@compute @workgroup_size(256)
fn movement_main(@builtin(global_invocation_id) id: vec3u) {
  let index = id.x;
  if (index >= params.pixels) { return; }
  let packed = coordinate_map[index];
  let offset = packed & 0x003fffffu;
  var sampled = source[offset];
  if (params.bilinear != 0u) { sampled = avs_bilinear(offset, packed >> 22u); }
  destination[index] = select(sampled, avs_average(source[index], sampled), params.blend != 0u);
}
`;

export const AVS_EXACT_ROTO_BLITTER_WGSL = /* wgsl */ `
struct Params {
  width: i32, height: i32, pixels: i32, ds: i32,
  dt: i32, ds_dx: i32, ds_dy: i32, dt_dx: i32,
  dt_dy: i32, s_start: i32, t_start: i32, subpixel: i32,
  blend: i32,
};
@group(0) @binding(0) var<storage, read> source: array<u32>;
@group(0) @binding(1) var<storage, read_write> destination: array<u32>;
@group(0) @binding(2) var<uniform> params: Params;

fn positive_mod(value: i32, divisor: i32) -> i32 {
  let remainder = value % divisor;
  return select(remainder, remainder + divisor, remainder < 0);
}
fn avs_table(first: u32, second: u32) -> u32 {
  var result = (first * second) / 255u;
  let correction = (first == 147u && (second == 85u || second == 170u))
    || (first == 155u && (second == 51u || second == 102u || second == 153u || second == 204u))
    || (first == 171u && (second == 85u || second == 170u))
    || (first == 187u && (second == 75u || second == 150u || second == 165u))
    || (first == 195u && second == 153u);
  if (correction) { result -= 1u; }
  return result;
}
fn avs_average(first: u32, second: u32) -> u32 {
  return ((first >> 1u) & 0x007f7f7fu) + ((second >> 1u) & 0x007f7f7fu);
}
fn avs_bilinear(offset: u32, fx: u32, fy: u32) -> u32 {
  let inverse_x = 255u - fx;
  let inverse_y = 255u - fy;
  let weights = array<u32, 4>(
    avs_table(inverse_x, inverse_y), avs_table(fx, inverse_y),
    avs_table(inverse_x, fy), avs_table(fx, fy),
  );
  let width = u32(params.width);
  let samples = array<u32, 4>(
    source[offset], source[offset + 1u],
    source[offset + width], source[offset + width + 1u],
  );
  var low = 0u; var middle = 0u; var high = 0u;
  for (var sample_index = 0u; sample_index < 4u; sample_index++) {
    let pixel = samples[sample_index]; let weight = weights[sample_index];
    low += avs_table(pixel & 255u, weight);
    middle += avs_table((pixel >> 8u) & 255u, weight);
    high += avs_table((pixel >> 16u) & 255u, weight);
  }
  return (low & 255u) | ((middle & 255u) << 8u) | ((high & 255u) << 16u);
}
@compute @workgroup_size(256)
fn roto_blitter_main(@builtin(global_invocation_id) id: vec3u) {
  let index = i32(id.x);
  if (index >= params.pixels) { return; }
  let x = index % params.width;
  let y = index / params.width;
  let s = positive_mod(params.s_start + y * params.ds_dy + x * params.ds_dx, params.ds);
  let t = positive_mod(params.t_start + y * params.dt_dy + x * params.dt_dx, params.dt);
  let source_x = s >> 16;
  let source_y = t >> 16;
  let offset = u32(source_x + source_y * params.width);
  var sampled = source[offset];
  if (params.subpixel != 0) {
    sampled = avs_bilinear(offset, u32((s >> 8) & 255), u32((t >> 8) & 255));
  }
  destination[u32(index)] = select(sampled, avs_average(source[u32(index)], sampled), params.blend != 0);
}
`;

export const AVS_EXACT_BLITTER_FEEDBACK_WGSL = /* wgsl */ `
struct Params {
  width: i32, height: i32, pixels: i32, mode: i32,
  step: i32, start_x: i32, start_y: i32, region_width: i32,
  region_height: i32, blend: i32, subpixel: i32, padding: i32,
};
@group(0) @binding(0) var<storage, read> source: array<u32>;
@group(0) @binding(1) var<storage, read_write> destination: array<u32>;
@group(0) @binding(2) var<uniform> params: Params;

fn avs_average(first: u32, second: u32) -> u32 {
  return ((first >> 1u) & 0x007f7f7fu) + ((second >> 1u) & 0x007f7f7fu);
}
fn channel_bilinear(a: u32, b: u32, c: u32, d: u32, fx: u32, fy: u32) -> u32 {
  let top = (a * (255u - fx) + b * fx) >> 8u;
  let bottom = (c * (255u - fx) + d * fx) >> 8u;
  return (top * (255u - fy) + bottom * fy) >> 8u;
}
fn bilinear(offset: u32, source_x: i32, source_y: i32, fx: u32, fy: u32) -> u32 {
  let x1 = min(params.width - 1, source_x + 1);
  let y1 = min(params.height - 1, source_y + 1);
  let b = u32(source_y * params.width + x1);
  let c = u32(y1 * params.width + source_x);
  let d = u32(y1 * params.width + x1);
  let pa = source[offset]; let pb = source[b]; let pc = source[c]; let pd = source[d];
  return channel_bilinear(pa & 255u, pb & 255u, pc & 255u, pd & 255u, fx, fy)
    | (channel_bilinear((pa >> 8u) & 255u, (pb >> 8u) & 255u, (pc >> 8u) & 255u, (pd >> 8u) & 255u, fx, fy) << 8u)
    | (channel_bilinear((pa >> 16u) & 255u, (pb >> 16u) & 255u, (pc >> 16u) & 255u, (pd >> 16u) & 255u, fx, fy) << 16u);
}
fn nearest_or_black(linear: i32) -> u32 {
  if (linear < 0 || linear >= params.pixels) { return 0u; }
  return source[u32(linear)];
}
@compute @workgroup_size(256)
fn blitter_feedback_main(@builtin(global_invocation_id) id: vec3u) {
  let index = i32(id.x);
  if (index >= params.pixels) { return; }
  let x = index % params.width;
  let y = index / params.width;
  if (params.mode == 1) {
    let extra = select(0, (x / 4) * params.step, params.blend != 0 && params.subpixel == 0);
    let fixed_x = params.start_x + x * params.step + extra;
    let fixed_y = params.start_y + y * params.step;
    let source_x = fixed_x >> 16;
    let source_y = fixed_y >> 16;
    var sampled = nearest_or_black(source_y * params.width + source_x);
    if (params.subpixel != 0) {
      sampled = bilinear(u32(source_y * params.width + source_x), source_x, source_y,
        u32((fixed_x >> 8) & 255), u32((fixed_y >> 8) & 255));
    }
    destination[u32(index)] = select(sampled, avs_average(source[u32(index)], sampled), params.blend != 0);
    return;
  }
  let local_x = x - params.start_x;
  let local_y = y - params.start_y;
  if (local_x < 0 || local_y < 0 || local_x >= params.region_width || local_y >= params.region_height) {
    destination[u32(index)] = source[u32(index)];
    return;
  }
  let extra = select(0, (local_x / 4) * params.step, params.blend != 0);
  let source_x = (32768 + local_x * params.step + extra) >> 16;
  let source_y = (32768 + local_y * params.step) >> 16;
  let sampled = nearest_or_black(source_y * params.width + source_x);
  destination[u32(index)] = select(sampled, avs_average(source[u32(index)], sampled), params.blend != 0);
}
`;

export const AVS_PACKED_PRESENT_WGSL = /* wgsl */ `
@group(0) @binding(0) var<storage, read> avs_pixels: array<u32>;
@group(0) @binding(1) var<uniform> frame_width: u32;

struct VertexOutput {
  @builtin(position) position: vec4f,
};

@vertex fn vertex_main(@builtin(vertex_index) vertex_index: u32) -> VertexOutput {
  var positions = array<vec2f, 3>(
    vec2f(-1.0, -1.0),
    vec2f( 3.0, -1.0),
    vec2f(-1.0,  3.0),
  );
  var output: VertexOutput;
  output.position = vec4f(positions[vertex_index], 0.0, 1.0);
  return output;
}

@fragment fn fragment_main(@builtin(position) position: vec4f) -> @location(0) vec4f {
  let coordinate = vec2u(position.xy);
  let pixel = avs_pixels[coordinate.y * frame_width + coordinate.x];
  return vec4f(
    f32((pixel >> 16u) & 255u),
    f32((pixel >> 8u) & 255u),
    f32(pixel & 255u),
    255.0,
  ) / 255.0;
}
`;

/** Pure validation/planning seam used by both construction and tests. */
export function planPackedAvsFrameGraph(
  width: number,
  height: number,
  maxStorageBufferBindingSize = Number.MAX_SAFE_INTEGER,
): AvsFrameGraphPlan {
  if (!Number.isInteger(width) || !Number.isInteger(height) || width <= 0 || height <= 0) {
    throw new RangeError(`Invalid AVS frame-graph size ${width}x${height}`);
  }
  const pixels = width * height;
  const framebufferBytes = pixels * Uint32Array.BYTES_PER_ELEMENT;
  if (!Number.isSafeInteger(framebufferBytes)) throw new RangeError('AVS framebuffer byte size is unsafe');
  if (framebufferBytes > maxStorageBufferBindingSize) {
    throw new RangeError(
      `AVS framebuffer needs ${framebufferBytes} bytes; adapter limit is ${maxStorageBufferBindingSize}`,
    );
  }
  return { width, height, pixels, framebufferBytes, residentBytes: framebufferBytes * 2 };
}

/** O(1) exact-lane guard. The backing Uint32Array is uploaded without repacking. */
export function assertPackedAvsFrame(pixels: Uint32Array, expectedPixels: number): void {
  if (pixels.length !== expectedPixels) {
    throw new RangeError(`Packed AVS frame has ${pixels.length} pixels, expected ${expectedPixels}`);
  }
  if (!(pixels.buffer instanceof ArrayBuffer)) {
    throw new TypeError('Packed AVS frame must use transferable ArrayBuffer storage');
  }
}

/** Reference channel decode for capability tests and non-GPU diagnostics. */
export function unpackAvsPixel(pixel: number): readonly [number, number, number, number] {
  return [(pixel >>> 16) & 255, (pixel >>> 8) & 255, pixel & 255, 255];
}

export function assertAvsPassCompatible(
  lane: AvsFrameGraphLane,
  capability: AvsFrameGraphCapability,
): void {
  if (lane === 'exact' && (!capability.byteExact || capability.lane !== 'exact')) {
    throw new Error(`Frame pass ${capability.id} requires the explicit 120 lane: ${capability.reason}`);
  }
}

/**
 * Two-buffer resident frame graph.  `upload()` is the current CPU-executor
 * ingress; `buffer()` and `present()` are stable seams for later GPU effects.
 */
export class PackedAvsGpuFrameGraph {
  readonly capability = AVS_GPU_TERMINAL_CAPABILITY;
  /** Non-null only when `timestamps` was requested and the adapter supports it. */
  readonly timer: GpuTimer | null;

  private readonly device: GPUDevice;
  private readonly context: GPUCanvasContext;
  private readonly canvas: OffscreenCanvas;
  private readonly format: GPUTextureFormat;
  private currentPlan: AvsFrameGraphPlan;
  private currentLane: AvsFrameGraphLane;
  private buffers: Readonly<Record<AvsResidentFrameSlot, GPUBuffer>>;
  private widthBuffer: GPUBuffer;
  private bindGroups: Readonly<Record<AvsResidentFrameSlot, GPUBindGroup>>;
  private readonly pipeline: GPURenderPipeline;
  private readonly onTiming?: (timing: AvsFrameGraphTiming) => void;
  private frame = 0;
  private destroyed = false;
  private lostReason: string | null = null;

  private constructor(
    device: GPUDevice,
    context: GPUCanvasContext,
    format: GPUTextureFormat,
    options: PackedAvsGpuFrameGraphOptions,
    timestamps: boolean,
  ) {
    this.device = device;
    this.context = context;
    this.canvas = options.canvas;
    this.format = format;
    this.onTiming = options.onTiming;
    this.currentLane = options.lane ?? 'exact';
    this.currentPlan = planPackedAvsFrameGraph(
      options.width,
      options.height,
      Number(device.limits.maxStorageBufferBindingSize),
    );
    this.canvas.width = options.width;
    this.canvas.height = options.height;
    this.context.configure(avsPresentCanvasConfiguration(device, format));

    const module = device.createShaderModule({
      label: 'AVS exact packed-u32 terminal',
      code: AVS_PACKED_PRESENT_WGSL,
    });
    this.pipeline = device.createRenderPipeline({
      label: 'AVS exact packed-u32 terminal',
      layout: 'auto',
      vertex: { module, entryPoint: 'vertex_main' },
      fragment: { module, entryPoint: 'fragment_main', targets: [{ format }] },
      primitive: { topology: 'triangle-list' },
    });
    // The terminal pipeline reads the width from a uniform, so only the
    // resident buffers and their bind groups depend on the frame size.
    const resident = this.createResident(this.currentPlan);
    this.buffers = resident.buffers;
    this.widthBuffer = resident.widthBuffer;
    this.bindGroups = resident.bindGroups;
    this.timer = timestamps ? new GpuTimer(device, true) : null;

    // `destroy()` also resolves `lost`; the flag keeps that from reading as a
    // driver reset.
    void device.lost.then((info) => {
      if (this.destroyed) return;
      this.lostReason = `${info.reason}${info.message ? `: ${info.message}` : ''}`;
      options.onDeviceLost?.(this.lostReason);
    });
    if (options.onUncapturedError) {
      const report = options.onUncapturedError;
      device.addEventListener('uncapturederror', (event) => {
        if (!this.destroyed) report((event as GPUUncapturedErrorEvent).error.message);
      });
    }
  }

  static async create(options: PackedAvsGpuFrameGraphOptions): Promise<PackedAvsGpuFrameGraph | null> {
    const navigation = globalThis.navigator as (Navigator & { gpu?: GPU }) | undefined;
    const gpu = navigation?.gpu;
    if (!gpu) return null;
    const adapter = await gpu.requestAdapter({ powerPreference: 'high-performance' });
    if (!adapter) return null;
    const timestamps = options.timestamps === true && adapter.features.has('timestamp-query');
    const device = timestamps
      ? await adapter.requestDevice({ requiredFeatures: ['timestamp-query'] })
      : await adapter.requestDevice();
    const context = options.canvas.getContext('webgpu');
    if (!context) {
      device.destroy();
      return null;
    }
    try {
      return new PackedAvsGpuFrameGraph(device, context, gpu.getPreferredCanvasFormat(), options, timestamps);
    } catch (error) {
      context.unconfigure();
      device.destroy();
      throw error;
    }
  }

  get plan(): AvsFrameGraphPlan { return this.currentPlan; }
  get lane(): AvsFrameGraphLane { return this.currentLane; }
  /** Set once the device is lost outside `destroy()`; the graph must then be replaced. */
  get lost(): string | null { return this.lostReason; }

  /**
   * Adopts a new frame size (and optionally lane) without touching the
   * adapter, device, context or terminal pipeline. The resident buffers are
   * reallocated, so every compiled pass that baked the old size must be
   * recompiled by the caller; passes that did not are merely rebound, which
   * their per-buffer bind-group caches already handle. Returns false when
   * nothing changed.
   */
  resize(width: number, height: number, lane: AvsFrameGraphLane = this.currentLane): boolean {
    this.assertActive();
    const laneChanged = lane !== this.currentLane;
    this.currentLane = lane;
    if (width === this.currentPlan.width && height === this.currentPlan.height) return laneChanged;
    // Validate before mutating anything, so a rejected size leaves the graph usable.
    const plan = planPackedAvsFrameGraph(width, height, Number(this.device.limits.maxStorageBufferBindingSize));
    const previous = this.buffers;
    const previousWidth = this.widthBuffer;
    const resident = this.createResident(plan);
    this.currentPlan = plan;
    this.buffers = resident.buffers;
    this.widthBuffer = resident.widthBuffer;
    this.bindGroups = resident.bindGroups;
    this.canvas.width = width;
    this.canvas.height = height;
    this.context.configure(avsPresentCanvasConfiguration(this.device, this.format));
    // Already-submitted work keeps the old buffers alive until it completes.
    previous.primary.destroy();
    previous.secondary.destroy();
    previousWidth.destroy();
    return true;
  }

  buffer(slot: AvsResidentFrameSlot): GPUBuffer {
    this.assertActive();
    return this.buffers[slot];
  }

  compileExactBlur(config: ExactAvsBlurConfig): PackedAvsGpuPass {
    this.assertActive();
    return new ExactAvsBlurPass(this.device, this.currentPlan, config);
  }

  compileExactPointwise(operations: readonly ExactAvsPointwiseOperation[]): PackedAvsGpuPass {
    this.assertActive();
    return new ExactAvsPointwisePass(this.device, operations);
  }

  compileExactMovement(config: AvsMovementConfig): PackedAvsGpuPass {
    this.assertActive();
    return new ExactAvsMovementPass(this.device, this.currentPlan, config);
  }

  compileExactRotoBlitter(config: AvsRotoBlitterConfig): PackedAvsGpuPass {
    this.assertActive();
    return new ExactAvsRotoBlitterPass(this.device, this.currentPlan, config);
  }

  compileExactBlitterFeedback(config: AvsBlitterFeedbackConfig): PackedAvsGpuPass {
    this.assertActive();
    return new ExactAvsBlitterFeedbackPass(this.device, this.currentPlan, config);
  }

  /** Compile an independently owned resident pass without exposing the device. */
  compileExternalPass(factory: (device: GPUDevice) => PackedAvsGpuPass): PackedAvsGpuPass {
    this.assertActive();
    return factory(this.device);
  }

  compileExactPass(config: ExactAvsGpuPassConfig): PackedAvsGpuPass {
    switch (config.kind) {
      case 'blur': return this.compileExactBlur(config.config);
      case 'pointwise': return this.compileExactPointwise(config.operations);
      case 'movement': return this.compileExactMovement(config.config);
      case 'roto-blitter': return this.compileExactRotoBlitter(config.config);
      case 'blitter-feedback': return this.compileExactBlitterFeedback(config.config);
    }
  }

  upload(slot: AvsResidentFrameSlot, pixels: Uint32Array): number {
    this.assertActive();
    assertPackedAvsFrame(pixels, this.currentPlan.pixels);
    const started = performance.now();
    this.device.queue.writeBuffer(
      this.buffers[slot], 0, pixels.buffer as ArrayBuffer, pixels.byteOffset, pixels.byteLength,
    );
    return performance.now() - started;
  }

  present(slot: AvsResidentFrameSlot, uploadMs = 0): AvsFrameGraphPresentResult {
    return this.executeAndPresent([], slot, uploadMs);
  }

  /**
   * Records the compiled pass chain and terminal presentation in one encoder.
   * Every pass alternates the two resident buffers; no pass may read back.
   */
  executeAndPresent(
    passes: readonly PackedAvsGpuPass[],
    inputSlot: AvsResidentFrameSlot = 'primary',
    uploadMs = 0,
  ): AvsFrameGraphPresentResult {
    this.assertActive();
    const started = performance.now();
    const timer = this.timer;
    timer?.beginFrame();
    const encoder = this.device.createCommandEncoder({ label: 'AVS frame graph encoder' });
    let sourceSlot = inputSlot;
    for (const framePass of passes) {
      assertAvsPassCompatible(this.currentLane, framePass.capability);
      const targetSlot: AvsResidentFrameSlot = sourceSlot === 'primary' ? 'secondary' : 'primary';
      // Nodes record their own compute passes, so they are bracketed by
      // timestamp markers rather than handed timestampWrites.
      const span = timer ? timer.openSpan(encoder, framePass.capability.id) : null;
      framePass.encode({
        device: this.device,
        encoder,
        width: this.currentPlan.width,
        height: this.currentPlan.height,
        source: this.buffers[sourceSlot],
        target: this.buffers[targetSlot],
      });
      timer?.closeSpan(encoder, span);
      sourceSlot = targetSlot;
    }
    const view = this.context.getCurrentTexture().createView();
    // GpuTimer.beginPass records the identical clear-to-black descriptor plus
    // timestamp writes; the untimed branch is today's path verbatim.
    const pass = timer ? timer.beginPass(encoder, view, 'AVS exact terminal pass') : encoder.beginRenderPass({
      label: 'AVS exact terminal pass',
      colorAttachments: [{
        view,
        loadOp: 'clear', storeOp: 'store',
        clearValue: { r: 0, g: 0, b: 0, a: 1 },
      }],
    });
    pass.setPipeline(this.pipeline);
    pass.setBindGroup(0, this.bindGroups[sourceSlot]);
    pass.draw(3);
    pass.end();
    timer?.endFrame(encoder);
    this.device.queue.submit([encoder.finish()]);
    // Must follow the submit: mapping first would invalidate the copy just queued.
    timer?.poll();
    const encodeSubmitMs = performance.now() - started;
    const frame = ++this.frame;
    this.onTiming?.({ frame, uploadMs, encodeSubmitMs });
    if (this.onTiming) {
      const gpuStarted = performance.now();
      void this.device.queue.onSubmittedWorkDone().then(() => {
        if (!this.destroyed) {
          this.onTiming?.({ frame, uploadMs, encodeSubmitMs, gpuCompleteMs: performance.now() - gpuStarted });
        }
      });
    }
    return { uploadMs, encodeSubmitMs };
  }

  uploadAndPresent(pixels: Uint32Array, slot: AvsResidentFrameSlot = 'primary'): AvsFrameGraphPresentResult {
    const uploadMs = this.upload(slot, pixels);
    return this.present(slot, uploadMs);
  }

  uploadExecuteAndPresent(
    pixels: Uint32Array,
    passes: readonly PackedAvsGpuPass[],
    slot: AvsResidentFrameSlot = 'primary',
  ): AvsFrameGraphPresentResult {
    const uploadMs = this.upload(slot, pixels);
    return this.executeAndPresent(passes, slot, uploadMs);
  }

  /**
   * Rolling-average GPU time of the node chain plus terminal pass, from
   * timestamp queries. Undefined until the first readback lands or when
   * timestamps are unavailable; never a CPU-side estimate.
   */
  get gpuMs(): number | undefined {
    return this.timer && this.timer.timings.length > 0 ? this.timer.totalMs : undefined;
  }

  destroy(): void {
    if (this.destroyed) return;
    this.destroyed = true;
    this.timer?.destroy();
    this.context.unconfigure();
    this.buffers.primary.destroy();
    this.buffers.secondary.destroy();
    this.widthBuffer.destroy();
    this.device.destroy();
  }

  private createResident(plan: AvsFrameGraphPlan): {
    buffers: Readonly<Record<AvsResidentFrameSlot, GPUBuffer>>;
    widthBuffer: GPUBuffer;
    bindGroups: Readonly<Record<AvsResidentFrameSlot, GPUBindGroup>>;
  } {
    const device = this.device;
    const createFramebuffer = (label: string): GPUBuffer => device.createBuffer({
      label,
      size: plan.framebufferBytes,
      usage: GPUBufferUsage.STORAGE | GPUBufferUsage.COPY_DST | GPUBufferUsage.COPY_SRC,
    });
    const buffers = {
      primary: createFramebuffer('AVS frame graph primary'),
      secondary: createFramebuffer('AVS frame graph secondary'),
    };
    const widthBuffer = device.createBuffer({
      label: 'AVS frame graph width', size: 16,
      usage: GPUBufferUsage.UNIFORM | GPUBufferUsage.COPY_DST,
    });
    device.queue.writeBuffer(widthBuffer, 0, new Uint32Array([plan.width]));
    const layout = this.pipeline.getBindGroupLayout(0);
    const bind = (slot: AvsResidentFrameSlot): GPUBindGroup => device.createBindGroup({
      label: `AVS exact terminal ${slot}`,
      layout,
      entries: [
        { binding: 0, resource: { buffer: buffers[slot] } },
        { binding: 1, resource: { buffer: widthBuffer } },
      ],
    });
    return { buffers, widthBuffer, bindGroups: { primary: bind('primary'), secondary: bind('secondary') } };
  }

  private assertActive(): void {
    if (this.destroyed) throw new Error('AVS GPU frame graph is destroyed');
  }
}

class ExactAvsBlurPass implements PackedAvsGpuPass {
  readonly capability = AVS_GPU_BLUR_CAPABILITY;
  private readonly pipeline: GPUComputePipeline;
  private readonly params: GPUBuffer;
  private readonly groups = new WeakMap<GPUBuffer, WeakMap<GPUBuffer, GPUBindGroup>>();

  constructor(device: GPUDevice, plan: AvsFrameGraphPlan, config: ExactAvsBlurConfig) {
    if (config.mode !== 1 && config.mode !== 2 && config.mode !== 3) {
      throw new RangeError(`Invalid AVS Blur mode ${String(config.mode)}`);
    }
    const module = device.createShaderModule({ label: 'AVS exact Blur', code: AVS_EXACT_BLUR_WGSL });
    this.pipeline = device.createComputePipeline({
      label: `AVS exact Blur mode ${config.mode}`,
      layout: 'auto', compute: { module, entryPoint: 'blur_main' },
    });
    this.params = device.createBuffer({
      label: 'AVS exact Blur parameters', size: 16,
      usage: GPUBufferUsage.UNIFORM | GPUBufferUsage.COPY_DST,
      mappedAtCreation: true,
    });
    new Uint32Array(this.params.getMappedRange()).set([
      plan.width, plan.height, config.mode, config.roundUp ? 1 : 0,
    ]);
    this.params.unmap();
  }

  encode(context: AvsGpuPassContext): void {
    let targets = this.groups.get(context.source);
    if (!targets) { targets = new WeakMap(); this.groups.set(context.source, targets); }
    let group = targets.get(context.target);
    if (!group) {
      group = context.device.createBindGroup({
        label: 'AVS exact Blur buffers', layout: this.pipeline.getBindGroupLayout(0),
        entries: [
          { binding: 0, resource: { buffer: context.source } },
          { binding: 1, resource: { buffer: context.target } },
          { binding: 2, resource: { buffer: this.params } },
        ],
      });
      targets.set(context.target, group);
    }
    const pass = context.encoder.beginComputePass({ label: 'AVS exact Blur' });
    pass.setPipeline(this.pipeline);
    pass.setBindGroup(0, group);
    pass.dispatchWorkgroups(Math.ceil((context.width * context.height) / 256));
    pass.end();
  }

  destroy(): void { this.params.destroy(); }
}

class ExactAvsPointwisePass implements PackedAvsGpuPass {
  readonly capability = AVS_GPU_POINTWISE_CAPABILITY;
  private readonly pipeline: GPUComputePipeline;
  private readonly groups = new WeakMap<GPUBuffer, WeakMap<GPUBuffer, GPUBindGroup>>();

  constructor(device: GPUDevice, operations: readonly ExactAvsPointwiseOperation[]) {
    const module = device.createShaderModule({
      label: `AVS exact fused pointwise (${operations.length})`,
      code: buildExactAvsPointwiseWgsl(operations),
    });
    this.pipeline = device.createComputePipeline({
      label: `AVS exact fused pointwise (${operations.length})`,
      layout: 'auto', compute: { module, entryPoint: 'pointwise_main' },
    });
  }

  encode(context: AvsGpuPassContext): void {
    let targets = this.groups.get(context.source);
    if (!targets) { targets = new WeakMap(); this.groups.set(context.source, targets); }
    let group = targets.get(context.target);
    if (!group) {
      group = context.device.createBindGroup({
        label: 'AVS exact fused pointwise buffers', layout: this.pipeline.getBindGroupLayout(0),
        entries: [
          { binding: 0, resource: { buffer: context.source } },
          { binding: 1, resource: { buffer: context.target } },
        ],
      });
      targets.set(context.target, group);
    }
    const pass = context.encoder.beginComputePass({ label: 'AVS exact fused pointwise' });
    pass.setPipeline(this.pipeline);
    pass.setBindGroup(0, group);
    pass.dispatchWorkgroups(Math.ceil((context.width * context.height) / 256));
    pass.end();
  }
}

class ExactAvsMovementPass implements PackedAvsGpuPass {
  readonly capability = AVS_GPU_MOVEMENT_CAPABILITY;
  private readonly pipeline: GPUComputePipeline;
  private readonly coordinateMap: GPUBuffer;
  private readonly params: GPUBuffer;
  private readonly groups = new WeakMap<GPUBuffer, WeakMap<GPUBuffer, GPUBindGroup>>();

  constructor(device: GPUDevice, plan: AvsFrameGraphPlan, config: AvsMovementConfig) {
    const movement = buildStaticAvsMovementGpuMap(config, plan.width, plan.height);
    if (!movement) throw new Error('Movement configuration is not exact-GPU eligible');
    const module = device.createShaderModule({ label: 'AVS exact static Movement', code: AVS_EXACT_MOVEMENT_WGSL });
    this.pipeline = device.createComputePipeline({
      label: `AVS exact Movement ${config.effect}`,
      layout: 'auto', compute: { module, entryPoint: 'movement_main' },
    });
    this.coordinateMap = device.createBuffer({
      label: `AVS Movement ${config.effect} coordinate map`, size: movement.packedCoordinates.byteLength,
      usage: GPUBufferUsage.STORAGE | GPUBufferUsage.COPY_DST, mappedAtCreation: true,
    });
    new Uint32Array(this.coordinateMap.getMappedRange()).set(movement.packedCoordinates);
    this.coordinateMap.unmap();
    this.params = device.createBuffer({
      label: `AVS Movement ${config.effect} parameters`, size: 16,
      usage: GPUBufferUsage.UNIFORM | GPUBufferUsage.COPY_DST, mappedAtCreation: true,
    });
    new Uint32Array(this.params.getMappedRange()).set([
      plan.width, plan.pixels, movement.bilinear ? 1 : 0, movement.blend ? 1 : 0,
    ]);
    this.params.unmap();
  }

  encode(context: AvsGpuPassContext): void {
    let targets = this.groups.get(context.source);
    if (!targets) { targets = new WeakMap(); this.groups.set(context.source, targets); }
    let group = targets.get(context.target);
    if (!group) {
      group = context.device.createBindGroup({
        label: 'AVS exact Movement buffers', layout: this.pipeline.getBindGroupLayout(0),
        entries: [
          { binding: 0, resource: { buffer: context.source } },
          { binding: 1, resource: { buffer: context.target } },
          { binding: 2, resource: { buffer: this.coordinateMap } },
          { binding: 3, resource: { buffer: this.params } },
        ],
      });
      targets.set(context.target, group);
    }
    const pass = context.encoder.beginComputePass({ label: 'AVS exact Movement' });
    pass.setPipeline(this.pipeline); pass.setBindGroup(0, group);
    pass.dispatchWorkgroups(Math.ceil((context.width * context.height) / 256));
    pass.end();
  }

  destroy(): void { this.coordinateMap.destroy(); this.params.destroy(); }
}

class ExactAvsRotoBlitterPass implements PackedAvsGpuPass {
  readonly capability = AVS_GPU_ROTO_BLITTER_CAPABILITY;
  private readonly pipeline: GPUComputePipeline;
  private readonly params: GPUBuffer;
  private readonly groups = new WeakMap<GPUBuffer, WeakMap<GPUBuffer, GPUBindGroup>>();

  constructor(device: GPUDevice, plan: AvsFrameGraphPlan, config: AvsRotoBlitterConfig) {
    const values = buildStaticAvsRotoBlitterGpuParams(config, plan.width, plan.height);
    if (!values) throw new Error('Roto Blitter configuration is not exact-GPU eligible');
    const module = device.createShaderModule({ label: 'AVS exact static Roto Blitter', code: AVS_EXACT_ROTO_BLITTER_WGSL });
    this.pipeline = device.createComputePipeline({
      label: 'AVS exact static Roto Blitter',
      layout: 'auto', compute: { module, entryPoint: 'roto_blitter_main' },
    });
    this.params = device.createBuffer({
      label: 'AVS exact Roto Blitter parameters', size: 64,
      usage: GPUBufferUsage.UNIFORM | GPUBufferUsage.COPY_DST, mappedAtCreation: true,
    });
    new Int32Array(this.params.getMappedRange()).set([
      values.width, values.height, values.pixels, values.ds,
      values.dt, values.dsDx, values.dsDy, values.dtDx,
      values.dtDy, values.sStart, values.tStart, values.subpixel ? 1 : 0,
      values.blend ? 1 : 0,
    ]);
    this.params.unmap();
  }

  encode(context: AvsGpuPassContext): void {
    let targets = this.groups.get(context.source);
    if (!targets) { targets = new WeakMap(); this.groups.set(context.source, targets); }
    let group = targets.get(context.target);
    if (!group) {
      group = context.device.createBindGroup({
        label: 'AVS exact Roto Blitter buffers', layout: this.pipeline.getBindGroupLayout(0),
        entries: [
          { binding: 0, resource: { buffer: context.source } },
          { binding: 1, resource: { buffer: context.target } },
          { binding: 2, resource: { buffer: this.params } },
        ],
      });
      targets.set(context.target, group);
    }
    const pass = context.encoder.beginComputePass({ label: 'AVS exact Roto Blitter' });
    pass.setPipeline(this.pipeline); pass.setBindGroup(0, group);
    pass.dispatchWorkgroups(Math.ceil((context.width * context.height) / 256));
    pass.end();
  }

  destroy(): void { this.params.destroy(); }
}

class ExactAvsBlitterFeedbackPass implements PackedAvsGpuPass {
  readonly capability = AVS_GPU_BLITTER_FEEDBACK_CAPABILITY;
  private readonly pipeline: GPUComputePipeline;
  private readonly params: GPUBuffer;
  private readonly groups = new WeakMap<GPUBuffer, WeakMap<GPUBuffer, GPUBindGroup>>();

  constructor(device: GPUDevice, plan: AvsFrameGraphPlan, config: AvsBlitterFeedbackConfig) {
    const values = buildStaticAvsBlitterFeedbackGpuParams(config, plan.width, plan.height);
    if (!values) throw new Error('Blitter Feedback configuration is not exact-GPU eligible');
    const module = device.createShaderModule({ label: 'AVS exact static Blitter Feedback', code: AVS_EXACT_BLITTER_FEEDBACK_WGSL });
    this.pipeline = device.createComputePipeline({
      label: 'AVS exact static Blitter Feedback',
      layout: 'auto', compute: { module, entryPoint: 'blitter_feedback_main' },
    });
    this.params = device.createBuffer({
      label: 'AVS exact Blitter Feedback parameters', size: 48,
      usage: GPUBufferUsage.UNIFORM | GPUBufferUsage.COPY_DST, mappedAtCreation: true,
    });
    new Int32Array(this.params.getMappedRange()).set([
      values.width, values.height, values.pixels, values.mode, values.step,
      values.startX, values.startY, values.regionWidth, values.regionHeight,
      values.blend ? 1 : 0, values.subpixel ? 1 : 0, 0,
    ]);
    this.params.unmap();
  }

  encode(context: AvsGpuPassContext): void {
    let targets = this.groups.get(context.source);
    if (!targets) { targets = new WeakMap(); this.groups.set(context.source, targets); }
    let group = targets.get(context.target);
    if (!group) {
      group = context.device.createBindGroup({
        label: 'AVS exact Blitter Feedback buffers', layout: this.pipeline.getBindGroupLayout(0),
        entries: [
          { binding: 0, resource: { buffer: context.source } },
          { binding: 1, resource: { buffer: context.target } },
          { binding: 2, resource: { buffer: this.params } },
        ],
      });
      targets.set(context.target, group);
    }
    const pass = context.encoder.beginComputePass({ label: 'AVS exact Blitter Feedback' });
    pass.setPipeline(this.pipeline); pass.setBindGroup(0, group);
    pass.dispatchWorkgroups(Math.ceil((context.width * context.height) / 256));
    pass.end();
  }

  destroy(): void { this.params.destroy(); }
}
