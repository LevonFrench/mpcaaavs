import { blendPixel } from '../framebuffer.ts';
import type {
  AvsFrameGraphCapability, AvsGpuPassContext, PackedAvsGpuPass,
} from '../gpu-frame-graph.ts';
import type { AvsBumpConfig } from './bump.ts';

export const AVS_GPU_BUMP_CAPABILITY: AvsFrameGraphCapability = {
  id: 'classic-bump-packed-u32', backend: 'webgpu', lane: 'exact', byteExact: true,
  reason: 'Uses separate resident packed-u32 surfaces, four-neighbor maximum-channel depth, and native integer lighting/blends.',
};

export interface ExactAvsBumpGpuEligibilityContext {
  /** This isolated pass may only replace a terminal Bump until CPU EEL scheduling is wired into the resident graph. */
  readonly terminal: boolean;
}

export interface ExactAvsBumpGpuEligibility { readonly eligible: boolean; readonly reason: string }

/** CPU EEL/depth state distilled to the only three values needed by the pixel pass. */
export interface ExactAvsBumpGpuFrame {
  readonly currentDepth: number;
  readonly lightX: number;
  readonly lightY: number;
}

export function assessExactGpuBump(
  config: AvsBumpConfig,
  context: ExactAvsBumpGpuEligibilityContext,
): ExactAvsBumpGpuEligibility {
  if (!config.enabled) return { eligible: false, reason: 'Bump is disabled' };
  if (!context.terminal) return { eligible: false, reason: 'non-terminal Bump requires resident CPU/GPU EEL scheduling' };
  if (config.buffer !== 0) return { eligible: false, reason: 'global depth buffers are not bound by this isolated pass' };
  return { eligible: true, reason: 'terminal current-frame Bump has independent output pixels' };
}

export function prepareExactAvsBumpGpuFrame(
  frame: ExactAvsBumpGpuFrame,
  width: number,
  height: number,
): Int32Array {
  if (!Number.isInteger(width) || width < 1 || !Number.isInteger(height) || height < 1) {
    throw new RangeError('Bump dimensions must be positive integers');
  }
  if (!Number.isFinite(frame.currentDepth)) throw new RangeError('Bump current depth must be finite');
  if (!Number.isInteger(frame.lightX) || frame.lightX < 0 || frame.lightX > width) {
    throw new RangeError(`Bump lightX must be an integer in [0, ${width}]`);
  }
  if (!Number.isInteger(frame.lightY) || frame.lightY < 0 || frame.lightY > height) {
    throw new RangeError(`Bump lightY must be an integer in [0, ${height}]`);
  }
  // Preserve the CPU renderer's native-compatible signed 32-bit shift before division.
  const currentDepth = Math.trunc(frame.currentDepth);
  const scaledDepth = Math.trunc((currentDepth << 8) / 100);
  return new Int32Array([width, height, frame.lightX, frame.lightY, scaledDepth, 0, 0, 0]);
}

/** Byte oracle for the isolated GPU pixel phase. EEL and beat-depth evolution remain caller-owned. */
export function renderExactAvsBumpCpu(
  source: Uint32Array,
  width: number,
  height: number,
  config: AvsBumpConfig,
  frame: ExactAvsBumpGpuFrame,
): Uint32Array {
  const eligibility = assessExactGpuBump(config, { terminal: true });
  if (!eligibility.eligible) throw new Error(eligibility.reason);
  if (source.length !== width * height) throw new RangeError('Bump source size does not match dimensions');
  const values = prepareExactAvsBumpGpuFrame(frame, width, height);
  const lightX = values[2]!, lightY = values[3]!, scaledDepth = values[4]!;
  const output = new Uint32Array(source.length);
  if (config.showLight && lightX < width && lightY < height) output[lightX + lightY * width] = 0x00ffffff;
  for (let y = 1; y < height - 1; y++) for (let x = 1; x < width - 1; x++) {
    const index = x + y * width;
    const left = source[index - 1]!, right = source[index + 1]!;
    const above = source[index - width]!, below = source[index + width]!;
    if (!(left || right || above || below)) continue;
    const horizontal = 127 - Math.abs(depthOf(right, config.invertDepth) - depthOf(left, config.invertDepth) - (x - lightX));
    const vertical = 127 - Math.abs(depthOf(below, config.invertDepth) - depthOf(above, config.invertDepth) - (y - lightY));
    const original = source[index]!;
    const lit = horizontal <= 0 || vertical <= 0
      ? clamp254(original)
      : addLight(original, (horizontal * vertical * scaledDepth) >> 14);
    output[index] = config.additive
      ? blendPixel(lit, original, 'additive')
      : config.average ? blendPixel(lit, original, 'average') : lit;
  }
  return output;
}

export function createExactAvsBumpGpuPassFactory(
  config: AvsBumpConfig,
  width: number,
  height: number,
  context: ExactAvsBumpGpuEligibilityContext,
): (device: GPUDevice) => ExactAvsBumpGpuPass {
  const eligibility = assessExactGpuBump(config, context);
  if (!eligibility.eligible) throw new Error(eligibility.reason);
  if (!Number.isInteger(width) || width < 1 || !Number.isInteger(height) || height < 1 || width > 16_384 || height > 16_384) {
    throw new RangeError('Bump dimensions must be integers in [1, 16384]');
  }
  return device => new ExactAvsBumpGpuPass(device, config, width, height, context);
}

export class ExactAvsBumpGpuPass implements PackedAvsGpuPass {
  readonly capability = AVS_GPU_BUMP_CAPABILITY;
  private readonly pipeline: GPUComputePipeline;
  private readonly params: GPUBuffer;
  private readonly groups = new WeakMap<GPUBuffer, WeakMap<GPUBuffer, GPUBindGroup>>();
  private frameReady = false;

  constructor(
    private readonly device: GPUDevice,
    readonly config: AvsBumpConfig,
    readonly width: number,
    readonly height: number,
    context: ExactAvsBumpGpuEligibilityContext,
  ) {
    const eligibility = assessExactGpuBump(config, context);
    if (!eligibility.eligible) throw new Error(eligibility.reason);
    if (!Number.isInteger(width) || width < 1 || !Number.isInteger(height) || height < 1 || width > 16_384 || height > 16_384) {
      throw new RangeError('Bump dimensions must be integers in [1, 16384]');
    }
    this.params = device.createBuffer({
      label: 'AVS exact Bump CPU-state uniform', size: 32,
      usage: GPUBufferUsage.UNIFORM | GPUBufferUsage.COPY_DST,
    });
    const module = device.createShaderModule({ label: 'AVS exact Bump', code: buildExactAvsBumpWgsl(config) });
    this.pipeline = device.createComputePipeline({ label: 'AVS exact Bump', layout: 'auto', compute: { module, entryPoint: 'main' } });
  }

  updateFrame(frame: ExactAvsBumpGpuFrame): void {
    const words = prepareExactAvsBumpGpuFrame(frame, this.width, this.height);
    this.device.queue.writeBuffer(this.params, 0, words.buffer as ArrayBuffer, words.byteOffset, words.byteLength);
    this.frameReady = true;
  }

  encode(context: AvsGpuPassContext): void { this.encodeInternal(context); }

  encodeTimed(context: AvsGpuPassContext, querySet: GPUQuerySet, beginningOfPassWriteIndex: number, endOfPassWriteIndex: number): void {
    this.encodeInternal(context, { querySet, beginningOfPassWriteIndex, endOfPassWriteIndex });
  }

  private encodeInternal(context: AvsGpuPassContext, timestampWrites?: GPUComputePassTimestampWrites): void {
    if (!this.frameReady) throw new Error('Bump GPU frame state must be updated before encode');
    if (context.width !== this.width || context.height !== this.height) {
      throw new RangeError(`Bump pass is ${this.width}x${this.height}, got ${context.width}x${context.height}`);
    }
    if (context.source === context.target) throw new Error('Bump requires distinct source and target buffers');
    let targets = this.groups.get(context.source);
    if (!targets) { targets = new WeakMap(); this.groups.set(context.source, targets); }
    let group = targets.get(context.target);
    if (!group) {
      group = context.device.createBindGroup({
        label: 'AVS exact Bump buffers', layout: this.pipeline.getBindGroupLayout(0), entries: [
          { binding: 0, resource: { buffer: context.source } },
          { binding: 1, resource: { buffer: context.target } },
          { binding: 2, resource: { buffer: this.params } },
        ],
      });
      targets.set(context.target, group);
    }
    const pass = context.encoder.beginComputePass({ label: 'AVS exact Bump', timestampWrites });
    pass.setPipeline(this.pipeline); pass.setBindGroup(0, group);
    pass.dispatchWorkgroups(Math.ceil(this.width / 16), Math.ceil(this.height / 16)); pass.end();
  }

  destroy(): void { this.params.destroy(); }
}

export function buildExactAvsBumpWgsl(config: AvsBumpConfig): string {
  const eligibility = assessExactGpuBump(config, { terminal: true });
  if (!eligibility.eligible) throw new Error(eligibility.reason);
  const showLight = config.showLight ? 'true' : 'false';
  const invertDepth = config.invertDepth ? 'true' : 'false';
  const blend = config.additive
    ? 'result = additive(lit, original);'
    : config.average ? 'result = average(lit, original);' : 'result = lit;';
  return /* wgsl */ `
struct Params { width:u32, height:u32, light_x:i32, light_y:i32, scaled_depth:i32, pad0:i32, pad1:i32, pad2:i32 };
@group(0) @binding(0) var<storage,read> source_pixels:array<u32>;
@group(0) @binding(1) var<storage,read_write> destination_pixels:array<u32>;
@group(0) @binding(2) var<uniform> params:Params;

fn pack(b:u32,g:u32,r:u32)->u32{return b|(g<<8u)|(r<<16u);}
fn depth(pixel:u32)->i32{
  let value=max(pixel&255u,max((pixel>>8u)&255u,(pixel>>16u)&255u));
  return select(i32(value),255-i32(value),${invertDepth});
}
fn clamp254(pixel:u32)->u32{return pack(min(pixel&255u,254u),min((pixel>>8u)&255u,254u),min((pixel>>16u)&255u,254u));}
fn add_light(pixel:u32,amount:i32)->u32{
  let b=min(i32(pixel&255u)+amount,254);let g=min(i32((pixel>>8u)&255u)+amount,254);let r=min(i32((pixel>>16u)&255u)+amount,254);
  return bitcast<u32>(b)|(bitcast<u32>(g)<<8u)|(bitcast<u32>(r)<<16u);
}
fn additive(a:u32,b:u32)->u32{return pack(min(255u,(a&255u)+(b&255u)),min(255u,((a>>8u)&255u)+((b>>8u)&255u)),min(255u,((a>>16u)&255u)+((b>>16u)&255u)));}
fn average(a:u32,b:u32)->u32{return ((a>>1u)&0x007f7f7fu)+((b>>1u)&0x007f7f7fu);}

@compute @workgroup_size(16,16)
fn main(@builtin(global_invocation_id) id:vec3u){
  let x=id.x;let y=id.y;if(x>=params.width||y>=params.height){return;}let index=y*params.width+x;
  var result=select(0u,0x00ffffffu,${showLight}&&i32(x)==params.light_x&&i32(y)==params.light_y);
  if(x==0u||y==0u||x+1u==params.width||y+1u==params.height){destination_pixels[index]=result;return;}
  let left=source_pixels[index-1u];let right=source_pixels[index+1u];let above=source_pixels[index-params.width];let below=source_pixels[index+params.width];
  if((left|right|above|below)==0u){destination_pixels[index]=result;return;}
  let horizontal=127-abs(depth(right)-depth(left)-(i32(x)-params.light_x));
  let vertical=127-abs(depth(below)-depth(above)-(i32(y)-params.light_y));
  let original=source_pixels[index];
  let lit=select(add_light(original,(horizontal*vertical*params.scaled_depth)>>14u),clamp254(original),horizontal<=0||vertical<=0);
  ${blend}
  destination_pixels[index]=result;
}`;
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
