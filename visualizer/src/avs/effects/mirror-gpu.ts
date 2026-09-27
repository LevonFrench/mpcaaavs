import type {
  AvsFrameGraphCapability, AvsGpuPassContext, PackedAvsGpuPass,
} from '../gpu-frame-graph.ts';

export interface AvsMirrorConfig {
  readonly enabled: boolean;
  readonly mode: number;
  readonly randomOnBeat: boolean;
  readonly smooth: boolean;
  readonly slower: number;
}

export interface ExactAvsMirrorGpuFrame {
  readonly mode: number;
  readonly smooth: boolean;
  /** Native transition divisors in top-bottom, bottom-top, left-right, right-left order. */
  readonly divisor: readonly [number, number, number, number];
}

export interface ExactAvsMirrorGpuPlan {
  readonly eligible: boolean;
  readonly reason: string | null;
  readonly width: number;
  readonly height: number;
  readonly framebufferBytes: number;
  readonly uniformBytes: 32;
}

export interface ExactAvsMirrorGpuPlanContext {
  readonly terminal: boolean;
  /** r_mirror.cpp shares smooth state across all instances; isolate one until the graph owns that shared state. */
  readonly mirrorInstances: number;
}

export const AVS_GPU_MIRROR_CAPABILITY: AvsFrameGraphCapability = {
  id: 'classic-mirror-ordered-packed-u32', backend: 'webgpu', lane: 'exact', byteExact: true,
  reason: 'Expands native left/right then top/bottom in-place ordering into an equivalent independent packed-u32 expression.',
};

export function decodeAvsMirror(payload: Uint8Array): AvsMirrorConfig {
  return {
    enabled: int(payload, 0, 1) !== 0,
    mode: int(payload, 4, 1) & 15,
    randomOnBeat: int(payload, 8, 0) !== 0,
    smooth: int(payload, 12, 0) !== 0,
    slower: Math.max(1, int(payload, 16, 4)),
  };
}

export function planExactAvsMirrorGpu(
  config: AvsMirrorConfig,
  width: number,
  height: number,
  context: ExactAvsMirrorGpuPlanContext,
): ExactAvsMirrorGpuPlan {
  const pixels = width * height;
  const base = { width, height, framebufferBytes: Number.isSafeInteger(pixels) ? pixels * 4 : 0, uniformBytes: 32 as const };
  const reject = (reason: string): ExactAvsMirrorGpuPlan => ({ eligible: false, reason, ...base });
  if (!config.enabled) return reject('Mirror is disabled');
  if (!Number.isInteger(width) || width < 1 || !Number.isInteger(height) || height < 1 || width > 16_384 || height > 16_384) return reject('Mirror dimensions must be integers in [1, 16384]');
  if (!Number.isSafeInteger(pixels) || pixels > 0x3fffffff) return reject('Mirror framebuffer size exceeds packed-u32 limits');
  if (!context.terminal) return reject('non-terminal Mirror requires resident state scheduling');
  if (context.mirrorInstances !== 1) return reject('native smooth state is shared across Mirror instances');
  if (config.randomOnBeat) return reject('beat-random Mirror mode remains CPU-owned');
  return { eligible: true, reason: null, ...base };
}

/** Exact CPU owner for the native smooth transition state of one fail-closed Mirror instance. */
export class ExactAvsMirrorCpuState {
  private lastMode = 0;
  private readonly divisor = [0, 0, 0, 0];
  private readonly increment = [0, 0, 0, 0];
  private frameCount = 0;

  next(config: AvsMirrorConfig): ExactAvsMirrorGpuFrame {
    if (config.randomOnBeat) throw new Error('beat-random Mirror state requires the classic CPU random source');
    const mode = config.mode & 15;
    const difference = mode ^ this.lastMode;
    for (let index = 0; index < 4; index++) {
      const bit = 1 << index;
      if ((difference & bit) === 0) continue;
      const wasOn = (this.lastMode & bit) !== 0;
      this.increment[index] = wasOn ? -1 : 1;
      if (this.divisor[index] === 0) this.divisor[index] = wasOn ? 16 : 1;
    }
    this.lastMode = mode;
    const frame: ExactAvsMirrorGpuFrame = { mode, smooth: config.smooth, divisor: [...this.divisor] as [number, number, number, number] };
    this.frameCount++;
    if (config.smooth && this.frameCount % Math.max(1, config.slower) === 0) {
      for (let index = 0; index < 4; index++) if (this.divisor[index] !== 0) {
        this.divisor[index] = (this.divisor[index]! + this.increment[index]! + 16) % 16;
      }
    }
    return frame;
  }
}

export function prepareExactAvsMirrorGpuFrame(frame: ExactAvsMirrorGpuFrame, width: number, height: number): Uint32Array {
  if (!Number.isInteger(width) || width < 1 || !Number.isInteger(height) || height < 1) throw new RangeError('Mirror dimensions must be positive integers');
  if (!Number.isInteger(frame.mode) || frame.mode < 0 || frame.mode > 15) throw new RangeError('Mirror mode must be in [0, 15]');
  if (frame.divisor.length !== 4 || frame.divisor.some(value => !Number.isInteger(value) || value < 0 || value > 15)) throw new RangeError('Mirror divisors must contain four integers in [0, 15]');
  return new Uint32Array([width, height, frame.mode, frame.smooth ? 1 : 0, ...frame.divisor]);
}

/** Ordered CPU oracle for the GPU's dependency-expanded single dispatch. */
export function renderExactAvsMirrorCpu(
  source: Uint32Array,
  width: number,
  height: number,
  frame: ExactAvsMirrorGpuFrame,
): Uint32Array {
  prepareExactAvsMirrorGpuFrame(frame, width, height);
  if (source.length !== width * height) throw new RangeError('Mirror source size does not match dimensions');
  const pixels = new Uint32Array(source), halfWidth = Math.trunc(width / 2), halfHeight = Math.trunc(height / 2);
  const direction = (bit: number, amount: number): boolean => (frame.mode & bit) !== 0 || (frame.smooth && amount !== 0);
  const copy = (target: number, sourceIndex: number, amount: number): void => {
    pixels[target] = frame.smooth && amount ? adaptive(pixels[target]!, pixels[sourceIndex]!, amount) : pixels[sourceIndex]!;
  };
  if (direction(4, frame.divisor[2])) for (let y = 0; y < height; y++) for (let x = 0; x < halfWidth; x++) copy(y * width + width - 1 - x, y * width + x, frame.divisor[2]);
  if (direction(8, frame.divisor[3])) for (let y = 0; y < height; y++) for (let x = 0; x < halfWidth; x++) copy(y * width + x, y * width + width - 1 - x, frame.divisor[3]);
  if (direction(1, frame.divisor[0])) for (let y = 0; y < halfHeight; y++) for (let x = 0; x < width; x++) copy((height - 1 - y) * width + x, y * width + x, frame.divisor[0]);
  if (direction(2, frame.divisor[1])) for (let y = 0; y < halfHeight; y++) for (let x = 0; x < width; x++) copy(y * width + x, (height - 1 - y) * width + x, frame.divisor[1]);
  return pixels;
}

export function createExactAvsMirrorGpuPassFactory(
  plan: ExactAvsMirrorGpuPlan,
): (device: GPUDevice) => ExactAvsMirrorGpuPass {
  if (!plan.eligible) throw new Error(`Cannot create Mirror GPU pass: ${plan.reason}`);
  return device => new ExactAvsMirrorGpuPass(device, plan);
}

export class ExactAvsMirrorGpuPass implements PackedAvsGpuPass {
  readonly capability = AVS_GPU_MIRROR_CAPABILITY;
  private readonly pipeline: GPUComputePipeline;
  private readonly params: GPUBuffer;
  private readonly groups = new WeakMap<GPUBuffer, WeakMap<GPUBuffer, GPUBindGroup>>();
  private frameReady = false;

  constructor(private readonly device: GPUDevice, readonly plan: ExactAvsMirrorGpuPlan) {
    if (!plan.eligible) throw new Error(`Ineligible Mirror GPU plan: ${plan.reason}`);
    this.params = device.createBuffer({ label: 'AVS exact Mirror CPU-state uniform', size: plan.uniformBytes, usage: GPUBufferUsage.UNIFORM | GPUBufferUsage.COPY_DST });
    const module = device.createShaderModule({ label: 'AVS exact ordered Mirror', code: AVS_EXACT_MIRROR_WGSL });
    this.pipeline = device.createComputePipeline({ label: 'AVS exact ordered Mirror', layout: 'auto', compute: { module, entryPoint: 'main' } });
  }

  updateFrame(frame: ExactAvsMirrorGpuFrame): void {
    const words = prepareExactAvsMirrorGpuFrame(frame, this.plan.width, this.plan.height);
    this.device.queue.writeBuffer(this.params, 0, words.buffer as ArrayBuffer, words.byteOffset, words.byteLength); this.frameReady = true;
  }

  encode(context: AvsGpuPassContext): void {
    if (!this.frameReady) throw new Error('Mirror GPU frame state must be updated before encode');
    if (context.width !== this.plan.width || context.height !== this.plan.height) throw new RangeError(`Mirror pass is ${this.plan.width}x${this.plan.height}, got ${context.width}x${context.height}`);
    if (context.source === context.target) throw new Error('Mirror requires distinct source and target buffers');
    let targets = this.groups.get(context.source); if (!targets) { targets = new WeakMap(); this.groups.set(context.source, targets); }
    let group = targets.get(context.target); if (!group) {
      group = context.device.createBindGroup({ label: 'AVS exact Mirror buffers', layout: this.pipeline.getBindGroupLayout(0), entries: [
        { binding: 0, resource: { buffer: context.source } }, { binding: 1, resource: { buffer: context.target } }, { binding: 2, resource: { buffer: this.params } },
      ] }); targets.set(context.target, group);
    }
    const pass = context.encoder.beginComputePass({ label: 'AVS exact ordered Mirror' }); pass.setPipeline(this.pipeline); pass.setBindGroup(0, group);
    pass.dispatchWorkgroups(Math.ceil(this.plan.width / 16), Math.ceil(this.plan.height / 16)); pass.end();
  }

  destroy(): void { this.params.destroy(); }
}

export const AVS_EXACT_MIRROR_WGSL = /* wgsl */ `
struct Params { width:u32, height:u32, mode:u32, smooth:u32, d0:u32, d1:u32, d2:u32, d3:u32 };
@group(0) @binding(0) var<storage,read> source_pixels:array<u32>;
@group(0) @binding(1) var<storage,read_write> destination_pixels:array<u32>;
@group(0) @binding(2) var<uniform> params:Params;
fn pack(b:u32,g:u32,r:u32)->u32{return (b&255u)|((g&255u)<<8u)|((r&255u)<<16u);}
fn adaptive(current:u32,target:u32,amount:u32)->u32{
  let inverse=16u-amount;
  return pack((((current&255u)>>4u)*inverse+((target&255u)>>4u)*amount)&255u,
    ((((current>>8u)&255u)>>4u)*inverse+(((target>>8u)&255u)>>4u)*amount)&255u,
    ((((current>>16u)&255u)>>4u)*inverse+(((target>>16u)&255u)>>4u)*amount)&255u);
}
fn apply_direction(current:u32,target:u32,active:bool,amount:u32)->u32{
  if(!active){return current;}if(params.smooth!=0u&&amount!=0u){return adaptive(current,target,amount);}return target;
}
fn original(x:u32,y:u32)->u32{return source_pixels[y*params.width+x];}
fn horizontal(x:u32,y:u32)->u32{
  let half=params.width/2u;let mirrored=params.width-1u-x;var value=original(x,y);
  let left_to_right=(params.mode&4u)!=0u||(params.smooth!=0u&&params.d2!=0u);
  let right_to_left=(params.mode&8u)!=0u||(params.smooth!=0u&&params.d3!=0u);
  if(x>=params.width-half&&mirrored<half){value=apply_direction(value,original(mirrored,y),left_to_right,params.d2);}
  if(x<half){
    let right_original=original(mirrored,y);
    let right_after=apply_direction(right_original,original(x,y),left_to_right,params.d2);
    value=apply_direction(value,right_after,right_to_left,params.d3);
  }
  return value;
}
fn after_top_to_bottom(x:u32,y:u32)->u32{
  let half=params.height/2u;let mirrored=params.height-1u-y;var value=horizontal(x,y);
  let active=(params.mode&1u)!=0u||(params.smooth!=0u&&params.d0!=0u);
  if(y>=params.height-half&&mirrored<half){value=apply_direction(value,horizontal(x,mirrored),active,params.d0);}return value;
}
@compute @workgroup_size(16,16)
fn main(@builtin(global_invocation_id) id:vec3u){
  let x=id.x;let y=id.y;if(x>=params.width||y>=params.height){return;}let half=params.height/2u;let mirrored=params.height-1u-y;
  var value=after_top_to_bottom(x,y);let active=(params.mode&2u)!=0u||(params.smooth!=0u&&params.d1!=0u);
  if(y<half){value=apply_direction(value,after_top_to_bottom(x,mirrored),active,params.d1);}
  destination_pixels[y*params.width+x]=value;
}`;

function adaptive(current: number, target: number, divisor: number): number {
  const channel = (shift: number): number => ((((current >>> shift) & 255) >>> 4) * (16 - divisor) + (((target >>> shift) & 255) >>> 4) * divisor) & 255;
  return channel(0) | (channel(8) << 8) | (channel(16) << 16);
}
function int(payload: Uint8Array, offset: number, fallback: number): number {
  return offset + 4 <= payload.byteLength ? new DataView(payload.buffer, payload.byteOffset, payload.byteLength).getInt32(offset, true) : fallback;
}
