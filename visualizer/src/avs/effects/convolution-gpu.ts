import { AVS_EXACT_POINTWISE_HELPERS_WGSL, buildExactAvsPointwiseBody, type AvsFrameGraphCapability, type AvsGpuPassContext, type ExactAvsPointwiseOperation, type PackedAvsGpuPass } from '../gpu-frame-graph.ts';
import type { AvsConvolutionConfig } from './convolution.ts';

export const AVS_GPU_CONVOLUTION_CAPABILITY: AvsFrameGraphCapability = {
  id: 'holden03-convolution-packed-u32', backend: 'webgpu', lane: 'exact', byteExact: true,
  reason: 'Parallelizes independent output pixels while preserving native 16-bit integer accumulation; an optional workgroup-tiled kernel is benchmark-only.',
};

export interface AvsGpuConvolutionEligibility {
  readonly eligible: boolean;
  readonly reason: string;
}

/** Parallel execution is exact only when the native APE selects its swap buffer. */
export function assessExactGpuConvolution(config: AvsConvolutionConfig): AvsGpuConvolutionEligibility {
  if (!config.enabled) return { eligible: false, reason: 'convolution is disabled' };
  const first = config.kernel.findIndex(value => value !== 0);
  if (first < 0 || first >= 24) {
    return { eligible: false, reason: 'native center/right kernel uses ordered in-place raster feedback' };
  }
  return { eligible: true, reason: 'native APE selects a separate output buffer; pixels are independent' };
}

/** Exact resident WebGPU pass for the parallel-safe Holden03 7x7 subset. */
export class ExactAvsConvolutionGpuPass implements PackedAvsGpuPass {
  readonly capability = AVS_GPU_CONVOLUTION_CAPABILITY;
  private readonly pipeline: GPUComputePipeline;
  private readonly groups = new WeakMap<GPUBuffer, WeakMap<GPUBuffer, GPUBindGroup>>();

  constructor(device: GPUDevice, config: AvsConvolutionConfig, width: number, height: number, tiled = false, pointwise: readonly ExactAvsPointwiseOperation[] = []) {
    const eligibility = assessExactGpuConvolution(config);
    if (!eligibility.eligible) throw new Error(eligibility.reason);
    const module = device.createShaderModule({
      label: 'AVS exact tiled Convolution', code: buildExactAvsConvolutionWgsl(config, width, height, tiled, pointwise),
    });
    this.pipeline = device.createComputePipeline({
      label: 'AVS exact tiled Convolution', layout: 'auto', compute: { module, entryPoint: 'main' },
    });
  }

  encode(context: AvsGpuPassContext): void {
    let targets = this.groups.get(context.source);
    if (!targets) { targets = new WeakMap(); this.groups.set(context.source, targets); }
    let group = targets.get(context.target);
    if (!group) {
      group = context.device.createBindGroup({
        label: 'AVS exact tiled Convolution buffers', layout: this.pipeline.getBindGroupLayout(0),
        entries: [
          { binding: 0, resource: { buffer: context.source } },
          { binding: 1, resource: { buffer: context.target } },
        ],
      });
      targets.set(context.target, group);
    }
    const pass = context.encoder.beginComputePass({ label: 'AVS exact tiled Convolution' });
    pass.setPipeline(this.pipeline);
    pass.setBindGroup(0, group);
    pass.dispatchWorkgroups(Math.ceil(context.width / 16), Math.ceil(context.height / 16));
    pass.end();
  }
}

export function buildExactAvsConvolutionWgsl(
  config: AvsConvolutionConfig, width: number, height: number, tiled = true,
  pointwise: readonly ExactAvsPointwiseOperation[] = [],
): string {
  if (!assessExactGpuConvolution(config).eligible) throw new Error(assessExactGpuConvolution(config).reason);
  if (!Number.isInteger(width) || width < 1 || !Number.isInteger(height) || height < 1) {
    throw new RangeError('Convolution dimensions must be positive integers');
  }
  const sign = config.scale < 0 ? -1 : 1;
  const kernel = config.kernel.map(value => Math.imul(value, sign));
  const divisor = Math.abs(config.scale) || 1;
  const reciprocal = Math.floor(0x10000 / divisor) & 0xffff;
  const bias = Math.imul(config.bias, sign);
  const biasProduct = Math.imul(Math.abs(bias) & 0xffff, 256) & 0xffff;
  // Native prepares saturation from the serialized signs before applying a
  // negative scale's sign flip. Preserve that unintuitive ordering exactly.
  const sums = coefficientSums(config.kernel, config.bias);
  const fused = pointwise.length ? { helpers: AVS_EXACT_POINTWISE_HELPERS_WGSL, body: buildExactAvsPointwiseBody(pointwise) } : null;
  const combine = config.absolute
    ? 'return u32(clamp(signed16(p) - signed16(n), -32768, 32767)) & 0x7fffu;'
    : config.wrap
      ? 'return (p - n) & 0xffffu;'
      : 'return select(0u, p - n, p > n);';
  const scale = divisor <= 1 ? 'return value & 0xffffu;'
    : divisor <= 0x8000 && (divisor & (divisor - 1)) === 0
      ? `return value >> ${Math.log2(divisor)}u;`
      : `return ((value * ${reciprocal}u) >> 16u) & 0xffffu;`;
  const sample = tiled
    ? 'let pixel = tile[u32(sy) * 22u + u32(sx)];'
    : 'let gx = u32(clamp(i32(origin.x) + sx - 3, 0, i32(WIDTH) - 1)); let gy = u32(clamp(i32(origin.y) + sy - 3, 0, i32(HEIGHT) - 1)); let pixel = source[gy * WIDTH + gx];';
  return /* wgsl */ `
const WIDTH = ${width}u; const HEIGHT = ${height}u;
const KERNEL = array<i32, 49>(${kernel.map(value => `${value}i`).join(',')});
@group(0) @binding(0) var<storage, read> source: array<u32>;
@group(0) @binding(1) var<storage, read_write> destination: array<u32>;
var<workgroup> tile: array<u32, 484>;
${fused?.helpers ?? ''}

fn add_word(a: u32, b: u32, saturate: bool) -> u32 { return select((a + b) & 0xffffu, min(0xffffu, a + b), saturate); }
fn signed16(v: u32) -> i32 { let low = v & 0xffffu; return select(i32(low), i32(low) - 65536, (low & 0x8000u) != 0u); }
fn combine(p: u32, n: u32) -> u32 { ${combine} }
fn scale_word(value: u32) -> u32 { ${scale} }
fn byte(value: u32) -> u32 { return u32(clamp(signed16(value), 0, 255)); }

fn convolve(origin: vec2u, local: vec2u, rotated: bool) -> vec4u {
  var positive = vec4u(0u); var negative = vec4u(0u);
  for (var tap = 0u; tap < 49u; tap++) {
    let coefficient = KERNEL[tap];
    if (coefficient == 0i) { continue; }
    let dx = i32(tap % 7u) - 3; let dy = i32(tap / 7u) - 3;
    let sx = i32(local.x) + 3 + select(dx, -dy, rotated);
    let sy = i32(local.y) + 3 + select(dy, dx, rotated);
    ${sample}
    let magnitude = select(u32(coefficient), 0u - u32(coefficient), coefficient < 0i) & 0xffffu;
    let product = (vec4u(pixel & 255u, (pixel >> 8u) & 255u, (pixel >> 16u) & 255u, pixel >> 24u) * magnitude) & vec4u(0xffffu);
    if (coefficient > 0i) {
      positive = vec4u(add_word(positive.x, product.x, ${sums.positive}), add_word(positive.y, product.y, ${sums.positive}), add_word(positive.z, product.z, ${sums.positive}), add_word(positive.w, product.w, ${sums.positive}));
    } else {
      negative = vec4u(add_word(negative.x, product.x, ${sums.negative}), add_word(negative.y, product.y, ${sums.negative}), add_word(negative.z, product.z, ${sums.negative}), add_word(negative.w, product.w, ${sums.negative}));
    }
  }
  ${bias > 0 ? `positive = min(vec4u(0xffffu), positive + vec4u(${biasProduct}u));` : ''}
  ${bias < 0 ? `negative = min(vec4u(0xffffu), negative + vec4u(${biasProduct}u));` : ''}
  return vec4u(combine(positive.x, negative.x), combine(positive.y, negative.y), combine(positive.z, negative.z), combine(positive.w, negative.w));
}

@compute @workgroup_size(16, 16)
fn main(@builtin(workgroup_id) group: vec3u, @builtin(local_invocation_id) local3: vec3u, @builtin(local_invocation_index) lane: u32) {
  let origin = vec2u(group.xy) * 16u;
  ${tiled ? `
  for (var offset = lane; offset < 484u; offset += 256u) {
    let tx = offset % 22u; let ty = offset / 22u;
    let gx = u32(clamp(i32(origin.x) + i32(tx) - 3, 0, i32(WIDTH) - 1));
    let gy = u32(clamp(i32(origin.y) + i32(ty) - 3, 0, i32(HEIGHT) - 1));
    tile[offset] = source[gy * WIDTH + gx];
  }
  workgroupBarrier();` : ''}
  let local = local3.xy; let global = origin + local;
  if (global.x >= WIDTH || global.y >= HEIGHT) { return; }
  var value = convolve(origin, local, false);
  ${config.twoPass ? 'value = min(vec4u(0xffffu), value + convolve(origin, local, true));' : ''}
  value = vec4u(scale_word(value.x), scale_word(value.y), scale_word(value.z), scale_word(value.w));
  var pixel = byte(value.x) | (byte(value.y) << 8u) | (byte(value.z) << 16u) | (byte(value.w) << 24u);
  let index = global.y * WIDTH + global.x;
  ${fused ? `pixel = pixel & 0x00ffffffu;\n${fused.body}` : ''}
  destination[index] = pixel${fused ? ' & 0x00ffffffu' : ''};
}`;
}

function coefficientSums(kernel: readonly number[], bias: number): { positive: boolean; negative: boolean } {
  let positive = 0; let negative = 0;
  for (const coefficient of [...kernel, bias]) {
    if (coefficient > 0) positive = (positive + coefficient) >>> 0;
    else if (coefficient < 0) negative = (negative + (-coefficient >>> 0)) >>> 0;
  }
  return { positive: positive >= 256, negative: negative >= 256 };
}
