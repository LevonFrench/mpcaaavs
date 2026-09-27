import type { AvsFrameGraphCapability, AvsGpuPassContext, PackedAvsGpuPass } from '../gpu-frame-graph.ts';
import { buildAvsColorMapTable, type AvsColorMapConfig } from './color-map.ts';

export const AVS_GPU_COLOR_MAP_CAPABILITY: AvsFrameGraphCapability = {
  id: 'color-map-stable-lut-packed-u32', backend: 'webgpu', lane: 'exact', byteExact: true,
  reason: 'Uses the native 256-entry integer LUT and exact packed-channel key/blend arithmetic; beat-cycled maps remain on CPU.',
};

export interface AvsGpuColorMapEligibility { readonly eligible: boolean; readonly reason: string }

export function assessExactGpuColorMap(config: AvsColorMapConfig): AvsGpuColorMapEligibility {
  if (config.mapCycleMode !== 0) return { eligible: false, reason: 'beat-cycled map selection and transition progress are stateful' };
  if (config.key < 0 || config.key > 5) return { eligible: false, reason: `unsupported Color Map key ${config.key}` };
  if (config.blendMode < 0 || config.blendMode > 9) return { eligible: false, reason: `unsupported Color Map blend ${config.blendMode}` };
  if (!config.maps.some(map => map.enabled)) return { eligible: false, reason: 'no enabled Color Map LUT' };
  return { eligible: true, reason: 'single enabled LUT is stable and every pixel is independent' };
}

export class ExactAvsColorMapGpuPass implements PackedAvsGpuPass {
  readonly capability = AVS_GPU_COLOR_MAP_CAPABILITY;
  private readonly pipeline: GPUComputePipeline;
  private readonly table: GPUBuffer;
  private readonly groups = new WeakMap<GPUBuffer, WeakMap<GPUBuffer, GPUBindGroup>>();

  constructor(device: GPUDevice, config: AvsColorMapConfig) {
    const eligibility = assessExactGpuColorMap(config);
    if (!eligibility.eligible) throw new Error(eligibility.reason);
    const active = config.maps.find(map => map.enabled)!;
    const values = buildAvsColorMapTable(active.points);
    this.table = device.createBuffer({ label: 'AVS Color Map stable LUT', size: values.byteLength,
      usage: GPUBufferUsage.STORAGE, mappedAtCreation: true });
    new Uint32Array(this.table.getMappedRange()).set(values); this.table.unmap();
    const module = device.createShaderModule({ label: 'AVS exact Color Map', code: buildExactAvsColorMapWgsl(config) });
    this.pipeline = device.createComputePipeline({ label: `AVS exact Color Map key ${config.key} blend ${config.blendMode}`,
      layout: 'auto', compute: { module, entryPoint: 'main' } });
  }

  encode(context: AvsGpuPassContext): void {
    let targets = this.groups.get(context.source);
    if (!targets) { targets = new WeakMap(); this.groups.set(context.source, targets); }
    let group = targets.get(context.target);
    if (!group) {
      group = context.device.createBindGroup({ label: 'AVS exact Color Map buffers', layout: this.pipeline.getBindGroupLayout(0), entries: [
        { binding: 0, resource: { buffer: context.source } }, { binding: 1, resource: { buffer: context.target } },
        { binding: 2, resource: { buffer: this.table } },
      ] }); targets.set(context.target, group);
    }
    const pass = context.encoder.beginComputePass({ label: 'AVS exact Color Map' });
    pass.setPipeline(this.pipeline); pass.setBindGroup(0, group);
    pass.dispatchWorkgroups(Math.ceil((context.width * context.height) / 256)); pass.end();
  }

  destroy(): void { this.table.destroy(); }
}

export function createExactAvsColorMapGpuPass(device: GPUDevice, config: AvsColorMapConfig): PackedAvsGpuPass {
  return new ExactAvsColorMapGpuPass(device, config);
}

export function buildExactAvsColorMapWgsl(config: AvsColorMapConfig): string {
  const eligibility = assessExactGpuColorMap(config); if (!eligibility.eligible) throw new Error(eligibility.reason);
  return /* wgsl */ `
@group(0) @binding(0) var<storage, read> source_pixels: array<u32>;
@group(0) @binding(1) var<storage, read_write> destination_pixels: array<u32>;
@group(0) @binding(2) var<storage, read> color_table: array<u32, 256>;
fn pack(b: u32, g: u32, r: u32) -> u32 { return (b & 255u) | ((g & 255u) << 8u) | ((r & 255u) << 16u); }
fn blend(source: u32, destination: u32) -> u32 {
  let sb=source&255u; let sg=(source>>8u)&255u; let sr=(source>>16u)&255u;
  let db=destination&255u; let dg=(destination>>8u)&255u; let dr=(destination>>16u)&255u;
  ${blendBody(config.blendMode, config.adjustBlend)}
}
@compute @workgroup_size(256)
fn main(@builtin(global_invocation_id) id: vec3u) {
  let index=id.x; if(index>=arrayLength(&source_pixels)){return;}
  let destination=source_pixels[index]&0x00ffffffu;
  let blue=destination&255u; let green=(destination>>8u)&255u; let red=(destination>>16u)&255u;
  ${keyBody(config.key)}
  destination_pixels[index]=blend(color_table[key],destination)&0x00ffffffu;
}`;
}

function keyBody(key: number): string {
  switch (key) {
    case 0: return 'let key=red;'; case 1: return 'let key=green;'; case 2: return 'let key=blue;';
    case 3: return 'let key=min(255u,(red+green+blue)>>1u);';
    case 4: return 'let key=max(red,max(green,blue));';
    case 5: return 'let key=(red+green+blue)/3u;';
    default: throw new RangeError(`Unsupported Color Map key ${key}`);
  }
}
function blendBody(mode: number, amount: number): string {
  switch (mode) {
    case 0: return 'return source;';
    case 1: return 'return pack(min(255u,sb+db),min(255u,sg+dg),min(255u,sr+dr));';
    case 2: return 'return pack(max(sb,db),max(sg,dg),max(sr,dr));';
    case 3: return 'return pack(min(sb,db),min(sg,dg),min(sr,dr));';
    case 4: return 'return pack((sb+db)>>1u,(sg+dg)>>1u,(sr+dr)>>1u);';
    case 5: return 'return pack(select(0u,db-sb,db>sb),select(0u,dg-sg,dg>sg),select(0u,dr-sr,dr>sr));';
    case 6: return 'return pack(select(0u,sb-db,sb>db),select(0u,sg-dg,sg>dg),select(0u,sr-dr,sr>dr));';
    case 7: return 'return pack((sb*db)>>8u,(sg*dg)>>8u,(sr*dr)>>8u);';
    case 8: return 'return (source^destination)&0x00ffffffu;';
    case 9: { const inverse = 256 - amount; return `return pack(min(255u,((sb*${amount}u)>>8u)+((db*${inverse}u)>>8u)),min(255u,((sg*${amount}u)>>8u)+((dg*${inverse}u)>>8u)),min(255u,((sr*${amount}u)>>8u)+((dr*${inverse}u)>>8u)));`; }
    default: throw new RangeError(`Unsupported Color Map blend ${mode}`);
  }
}
