import type { AvsFrameGraphCapability, AvsGpuPassContext, PackedAvsGpuPass } from '../gpu-frame-graph.ts';
import type { AvsComponent } from '../types.ts';

export const AVS_GPU_WATER_CAPABILITY: AvsFrameGraphCapability = {
  id: 'water-retained-wave-packed-u32', backend: 'webgpu', lane: 'exact', byteExact: true,
  reason: 'Preserves the previous packed source frame in a resident buffer and evaluates native integer edge/interior wave sums.',
};
export interface AvsGpuWaterEligibility { readonly eligible: boolean; readonly reason: string }
export function assessExactGpuWater(component: AvsComponent, width: number, height: number): AvsGpuWaterEligibility {
  if (component.list || component.apeId || component.effectId !== 20) return { eligible: false, reason: 'component is not native Water' };
  if (!Number.isInteger(width) || width < 2 || !Number.isInteger(height) || height < 2) return { eligible: false, reason: 'native corner/edge Water semantics require dimensions of at least 2x2' };
  const enabled = component.payload.byteLength >= 4 ? new DataView(component.payload.buffer, component.payload.byteOffset, component.payload.byteLength).getInt32(0, true) : 1;
  if (enabled === 0) return { eligible: false, reason: 'Water is disabled' };
  return { eligible: true, reason: 'stateful previous source and all integer channel math are resident and exact' };
}

/** Exact two-dispatch Water simulation. State resets when this pass is recreated. */
export class ExactAvsWaterGpuPass implements PackedAvsGpuPass {
  readonly capability = AVS_GPU_WATER_CAPABILITY;
  private readonly updatePipeline: GPUComputePipeline;
  private readonly commitPipeline: GPUComputePipeline;
  private readonly previous: GPUBuffer;
  private readonly wave: GPUBuffer;
  private readonly groups = new WeakMap<GPUBuffer, WeakMap<GPUBuffer, readonly [GPUBindGroup, GPUBindGroup]>>();
  private destroyed = false;
  constructor(device: GPUDevice, readonly component: AvsComponent, readonly width: number, readonly height: number) {
    const eligibility = assessExactGpuWater(component, width, height); if (!eligibility.eligible) throw new Error(eligibility.reason);
    const bytes = width * height * Uint32Array.BYTES_PER_ELEMENT, usage = GPUBufferUsage.STORAGE | GPUBufferUsage.COPY_SRC | GPUBufferUsage.COPY_DST;
    this.previous = device.createBuffer({ label: `AVS Water ${component.path} previous source`, size: bytes, usage });
    this.wave = device.createBuffer({ label: `AVS Water ${component.path} wave result`, size: bytes, usage });
    const update = device.createShaderModule({ label: 'AVS exact Water update', code: buildExactAvsWaterUpdateWgsl(width, height) });
    const commit = device.createShaderModule({ label: 'AVS exact Water state commit', code: AVS_EXACT_WATER_COMMIT_WGSL });
    this.updatePipeline = device.createComputePipeline({ label: 'AVS exact Water update', layout: 'auto', compute: { module: update, entryPoint: 'main' } });
    this.commitPipeline = device.createComputePipeline({ label: 'AVS exact Water state commit', layout: 'auto', compute: { module: commit, entryPoint: 'main' } });
  }
  encode(context: AvsGpuPassContext): void {
    if (this.destroyed) throw new Error('Water pass is destroyed');
    if (context.width !== this.width || context.height !== this.height) throw new RangeError(`Water pass is ${this.width}x${this.height}, got ${context.width}x${context.height}`);
    const [updateGroup, commitGroup] = this.bindGroups(context.device, context.source, context.target), workgroups = Math.ceil((this.width * this.height) / 256);
    const update = context.encoder.beginComputePass({ label: 'AVS exact Water update' }); update.setPipeline(this.updatePipeline); update.setBindGroup(0, updateGroup); update.dispatchWorkgroups(workgroups); update.end();
    const commit = context.encoder.beginComputePass({ label: 'AVS exact Water state commit' }); commit.setPipeline(this.commitPipeline); commit.setBindGroup(0, commitGroup); commit.dispatchWorkgroups(workgroups); commit.end();
  }
  destroy(): void { if (this.destroyed) return; this.destroyed = true; this.previous.destroy(); this.wave.destroy(); }
  private bindGroups(device: GPUDevice, source: GPUBuffer, target: GPUBuffer): readonly [GPUBindGroup, GPUBindGroup] {
    let targets=this.groups.get(source);if(!targets){targets=new WeakMap();this.groups.set(source,targets);}const cached=targets.get(target);if(cached)return cached;
    const update=device.createBindGroup({label:'AVS exact Water update buffers',layout:this.updatePipeline.getBindGroupLayout(0),entries:[{binding:0,resource:{buffer:source}},{binding:1,resource:{buffer:this.previous}},{binding:2,resource:{buffer:this.wave}}]});
    const commit=device.createBindGroup({label:'AVS exact Water commit buffers',layout:this.commitPipeline.getBindGroupLayout(0),entries:[{binding:0,resource:{buffer:source}},{binding:1,resource:{buffer:this.wave}},{binding:2,resource:{buffer:this.previous}},{binding:3,resource:{buffer:target}}]});
    const groups=[update,commit]as const;targets.set(target,groups);return groups;
  }
}
export function createExactAvsWaterGpuPass(device:GPUDevice,component:AvsComponent,width:number,height:number):PackedAvsGpuPass{return new ExactAvsWaterGpuPass(device,component,width,height);}
export function buildExactAvsWaterUpdateWgsl(width:number,height:number):string{
  if(!Number.isInteger(width)||width<2||!Number.isInteger(height)||height<2)throw new RangeError('Water dimensions must be at least 2x2');
  return/* wgsl */`
const WIDTH=${width}u;const HEIGHT=${height}u;
@group(0) @binding(0) var<storage,read> source:array<u32>;
@group(0) @binding(1) var<storage,read> previous:array<u32>;
@group(0) @binding(2) var<storage,read_write> wave:array<u32>;
fn add(sum:ptr<function,vec3u>,pixel:u32){*sum+=vec3u(pixel&255u,(pixel>>8u)&255u,(pixel>>16u)&255u);}
fn pack(value:vec3u)->u32{return (value.x&255u)|((value.y&255u)<<8u)|((value.z&255u)<<16u);}
@compute @workgroup_size(256)
fn main(@builtin(global_invocation_id) id:vec3u){let index=id.x;if(index>=arrayLength(&source)){return;}let x=index%WIDTH;let y=index/WIDTH;var sum=vec3u(0u);var count=0u;
if(x>0u){add(&sum,source[index-1u]);count++;}if(x+1u<WIDTH){add(&sum,source[index+1u]);count++;}if(y>0u){add(&sum,source[index-WIDTH]);count++;}if(y+1u<HEIGHT){add(&sum,source[index+WIDTH]);count++;}
if(count>2u){sum>>=vec3u(1u);}let old=previous[index];let prior=vec3u(old&255u,(old>>8u)&255u,(old>>16u)&255u);wave[index]=pack(min(vec3u(255u),select(vec3u(0u),sum-prior,sum>prior)));}`;
}
export const AVS_EXACT_WATER_COMMIT_WGSL=/* wgsl */`
@group(0) @binding(0) var<storage,read> source:array<u32>;
@group(0) @binding(1) var<storage,read> wave:array<u32>;
@group(0) @binding(2) var<storage,read_write> previous:array<u32>;
@group(0) @binding(3) var<storage,read_write> output:array<u32>;
@compute @workgroup_size(256)
fn main(@builtin(global_invocation_id) id:vec3u){let index=id.x;if(index>=arrayLength(&source)){return;}previous[index]=source[index]&0x00ffffffu;output[index]=wave[index];}`;
