import type {
  AvsFrameGraphCapability, AvsGpuPassContext, PackedAvsGpuPass,
} from '../gpu-frame-graph.ts';
import type { AvsListBlendMode } from '../framebuffer.ts';
import type { AvsResidentOperation } from '../gpu-surface-plan.ts';

export type AvsBufferSaveResidentOperation = Extract<AvsResidentOperation, { kind: 'buffer-save' }>;

export const AVS_GPU_BUFFER_SAVE_CAPABILITY: AvsFrameGraphCapability = {
  id: 'buffer-save-resident-packed-u32', backend: 'webgpu', lane: 'exact', byteExact: true,
  reason: 'Retains the eight shared global buffers on GPU and preserves native store/load phase and integer blends.',
};

export interface AvsGpuBufferSaveEligibility { readonly eligible: boolean; readonly reason: string }

export interface AvsGpuBufferSaveDirectionStep {
  readonly direction: 'store' | 'load';
  readonly nextPhase: 0 | 1;
}

export function resolveExactAvsBufferSaveDirection(direction: number, phase: 0 | 1): AvsGpuBufferSaveDirectionStep {
  if (!Number.isInteger(direction)) throw new TypeError('Buffer Save direction must be an integer');
  if (phase !== 0 && phase !== 1) throw new RangeError(`Unsupported Buffer Save phase ${phase}`);
  if (direction < 2) return { direction: direction === 0 ? 'store' : 'load', nextPhase: phase };
  return { direction: ((direction & 1) ^ phase) === 0 ? 'store' : 'load', nextPhase: (phase ^ 1) as 0 | 1 };
}

const BUFFER_SAVE_MODES = new Set<AvsListBlendMode>([
  'replace', 'average', 'additive', 'every-other-pixel', 'destination-minus-source',
  'every-other-line', 'xor', 'maximum', 'minimum', 'source-minus-destination',
  'multiply', 'adjustable',
]);

export function assessExactGpuBufferSave(
  operation: AvsBufferSaveResidentOperation,
  initialPhase = 0,
): AvsGpuBufferSaveEligibility {
  if (!Number.isInteger(operation.direction)) return { eligible: false, reason: 'Buffer Save direction is not an integer' };
  if (!Number.isInteger(operation.bufferIndex) || operation.bufferIndex < 0 || operation.bufferIndex > 7) {
    return { eligible: false, reason: `invalid global buffer ${operation.bufferIndex}` };
  }
  if (initialPhase !== 0 && initialPhase !== 1) return { eligible: false, reason: `unsupported alternating phase ${initialPhase}` };
  if (operation.condition !== 'frame-not-preinit') return { eligible: false, reason: `unsupported execution condition ${operation.condition}` };
  if (!Number.isInteger(operation.blendCode) || operation.blendCode < 0 || operation.blendCode > 11) {
    return { eligible: false, reason: `unsupported Buffer Save blend code ${operation.blendCode}` };
  }
  if (!BUFFER_SAVE_MODES.has(operation.blendMode)) return { eligible: false, reason: `unsupported Buffer Save blend ${operation.blendMode}` };
  const alternating = operation.direction >= 2;
  if (operation.alternatesEachFrame !== alternating || operation.cpuPhaseState !== alternating) {
    return { eligible: false, reason: 'surface-plan phase metadata does not match native direction' };
  }
  const directions = alternating ? 'store,load' : operation.direction === 0 ? 'store' : 'load';
  if (operation.possibleDirections.join(',') !== directions) {
    return { eligible: false, reason: 'surface-plan direction dependencies do not match native direction' };
  }
  if (operation.createsBuffer !== (operation.direction !== 1)) {
    return { eligible: false, reason: 'surface-plan lazy-buffer metadata does not match native direction' };
  }
  return { eligible: true, reason: 'exact resident global-buffer operation' };
}

/** Shared, lazy eight-slot bank. One instance must be used for every Buffer Save in a preset. */
export class ExactAvsGpuBufferBank {
  readonly framebufferBytes: number;
  private readonly buffers: Array<GPUBuffer | null> = new Array(8).fill(null);
  private readonly initialized = new Uint8Array(8);

  constructor(private readonly device: GPUDevice, readonly width: number, readonly height: number) {
    if (!Number.isInteger(width) || width < 1 || !Number.isInteger(height) || height < 1) {
      throw new RangeError('Buffer Save dimensions must be positive integers');
    }
    this.framebufferBytes = width * height * Uint32Array.BYTES_PER_ELEMENT;
  }

  resource(index: number, create: boolean): GPUBuffer | null {
    const existing = this.buffers[index] ?? null;
    if (existing || !create) return existing;
    const buffer = this.device.createBuffer({
      label: `AVS global buffer ${index}`, size: this.framebufferBytes,
      usage: GPUBufferUsage.STORAGE | GPUBufferUsage.COPY_SRC | GPUBufferUsage.COPY_DST,
    });
    this.buffers[index] = buffer;
    return buffer;
  }

  hasValue(index: number): boolean { return this.initialized[index] === 1; }
  markStored(index: number): void { this.initialized[index] = 1; }

  destroy(): void {
    for (const buffer of this.buffers) buffer?.destroy();
    this.buffers.fill(null); this.initialized.fill(0);
  }
}

/**
 * Encodes one surface-plan Buffer Save operation as a normal resident pass.
 * Store writes the global surface while copying the framebuffer through to the
 * graph's next slot; load writes the blended framebuffer to that next slot.
 */
export class ExactAvsBufferSaveGpuPass implements PackedAvsGpuPass {
  readonly capability = AVS_GPU_BUFFER_SAVE_CAPABILITY;
  private readonly storePipeline: GPUComputePipeline | null;
  private readonly loadPipeline: GPUComputePipeline | null;
  private readonly groups = new WeakMap<GPUBuffer, WeakMap<GPUBuffer, { store?: GPUBindGroup; load?: GPUBindGroup }>>();
  private phase: 0 | 1;

  constructor(
    device: GPUDevice,
    private readonly bank: ExactAvsGpuBufferBank,
    readonly operation: AvsBufferSaveResidentOperation,
    initialPhase = 0,
  ) {
    const eligibility = assessExactGpuBufferSave(operation, initialPhase);
    if (!eligibility.eligible) throw new Error(eligibility.reason);
    this.phase = initialPhase as 0 | 1;
    const hasStore = operation.possibleDirections.includes('store');
    const hasLoad = operation.possibleDirections.includes('load');
    const needsBlendPipeline = operation.blendMode !== 'replace';
    this.storePipeline = hasStore && needsBlendPipeline ? createPipeline(device, operation, true, bank.width) : null;
    this.loadPipeline = hasLoad && needsBlendPipeline ? createPipeline(device, operation, false, bank.width) : null;
  }

  encode(context: AvsGpuPassContext): void {
    if (context.width !== this.bank.width || context.height !== this.bank.height) {
      throw new RangeError(`Buffer Save pass is ${this.bank.width}x${this.bank.height}, got ${context.width}x${context.height}`);
    }
    const step = resolveExactAvsBufferSaveDirection(this.operation.direction, this.phase);
    this.phase = step.nextPhase;
    const store = step.direction === 'store';
    if (!store && !this.bank.hasValue(this.operation.bufferIndex)) {
      context.encoder.copyBufferToBuffer(context.source, 0, context.target, 0, this.bank.framebufferBytes);
      return;
    }
    const global = this.bank.resource(this.operation.bufferIndex, store);
    if (!global) throw new Error('initialized Buffer Save surface is absent');
    if (this.operation.blendMode === 'replace') {
      if (store) {
        context.encoder.copyBufferToBuffer(context.source, 0, global, 0, this.bank.framebufferBytes);
        context.encoder.copyBufferToBuffer(context.source, 0, context.target, 0, this.bank.framebufferBytes);
        this.bank.markStored(this.operation.bufferIndex);
      } else {
        context.encoder.copyBufferToBuffer(global, 0, context.target, 0, this.bank.framebufferBytes);
      }
      return;
    }
    const pipeline = store ? this.storePipeline : this.loadPipeline;
    if (!pipeline) throw new Error(`Buffer Save ${store ? 'store' : 'load'} pipeline was not compiled`);
    const group = this.bindGroup(context.device, pipeline, context.source, context.target, global, store);
    const pass = context.encoder.beginComputePass({ label: `AVS exact Buffer Save ${store ? 'store' : 'load'}` });
    pass.setPipeline(pipeline); pass.setBindGroup(0, group);
    pass.dispatchWorkgroups(Math.ceil((context.width * context.height) / 256)); pass.end();
    if (store) this.bank.markStored(this.operation.bufferIndex);
  }

  private bindGroup(
    device: GPUDevice, pipeline: GPUComputePipeline, source: GPUBuffer, target: GPUBuffer,
    global: GPUBuffer, store: boolean,
  ): GPUBindGroup {
    let targets = this.groups.get(source);
    if (!targets) { targets = new WeakMap(); this.groups.set(source, targets); }
    let pair = targets.get(target);
    if (!pair) { pair = {}; targets.set(target, pair); }
    const cached = store ? pair.store : pair.load;
    if (cached) return cached;
    const group = device.createBindGroup({
      label: `AVS exact Buffer Save ${store ? 'store' : 'load'} buffers`,
      layout: pipeline.getBindGroupLayout(0),
      entries: [
        { binding: 0, resource: { buffer: source } },
        { binding: 1, resource: { buffer: global } },
        { binding: 2, resource: { buffer: target } },
      ],
    });
    if (store) pair.store = group; else pair.load = group;
    return group;
  }
}

export function createExactAvsBufferSaveGpuPass(
  device: GPUDevice,
  bank: ExactAvsGpuBufferBank,
  operation: AvsBufferSaveResidentOperation,
  initialPhase = 0,
): PackedAvsGpuPass {
  return new ExactAvsBufferSaveGpuPass(device, bank, operation, initialPhase);
}

function createPipeline(
  device: GPUDevice, operation: AvsBufferSaveResidentOperation, store: boolean, width: number,
): GPUComputePipeline {
  const label = `AVS exact Buffer Save ${store ? 'store' : 'load'}`;
  const module = device.createShaderModule({ label, code: buildExactAvsBufferSaveWgsl(operation, store, width) });
  return device.createComputePipeline({ label, layout: 'auto', compute: { module, entryPoint: 'main' } });
}

export function buildExactAvsBufferSaveWgsl(
  operation: AvsBufferSaveResidentOperation, store: boolean, width: number,
): string {
  const eligibility = assessExactGpuBufferSave(operation);
  if (!eligibility.eligible) throw new Error(eligibility.reason);
  if (!operation.possibleDirections.includes(store ? 'store' : 'load')) {
    throw new Error(`Buffer Save operation cannot ${store ? 'store' : 'load'}`);
  }
  if (!Number.isInteger(width) || width < 1) throw new RangeError('Buffer Save width must be a positive integer');
  const amount = Math.max(0, Math.min(255, Math.trunc(operation.amount)));
  const body = store
    ? 'let frame=framebuffer[index]&0x00ffffffu; let old=global_buffer[index]&0x00ffffffu; global_buffer[index]=blend(frame,old,index); output[index]=frame;'
    : 'let frame=framebuffer[index]&0x00ffffffu; let saved=global_buffer[index]&0x00ffffffu; output[index]=blend(saved,frame,index);';
  return /* wgsl */ `
const WIDTH=${width}u;
@group(0) @binding(0) var<storage, read> framebuffer: array<u32>;
@group(0) @binding(1) var<storage, read_write> global_buffer: array<u32>;
@group(0) @binding(2) var<storage, read_write> output: array<u32>;
fn pack(b:u32,g:u32,r:u32)->u32{return (b&255u)|((g&255u)<<8u)|((r&255u)<<16u);}
fn blend(source:u32,destination:u32,index:u32)->u32{
  let sb=source&255u;let sg=(source>>8u)&255u;let sr=(source>>16u)&255u;
  let db=destination&255u;let dg=(destination>>8u)&255u;let dr=(destination>>16u)&255u;
  ${blendBody(operation.blendMode, amount)}
}
@compute @workgroup_size(256)
fn main(@builtin(global_invocation_id) id:vec3u){let index=id.x;if(index>=arrayLength(&framebuffer)){return;}${body}}
`;
}

function blendBody(mode: AvsListBlendMode, amount: number): string {
  switch (mode) {
    case 'replace': return 'return source;';
    case 'average': return 'return ((source>>1u)&0x007f7f7fu)+((destination>>1u)&0x007f7f7fu);';
    case 'additive': return 'return pack(min(255u,sb+db),min(255u,sg+dg),min(255u,sr+dr));';
    case 'every-other-pixel': return 'let y=index/WIDTH;let x=index-y*WIDTH;return select(destination,source,((x^y)&1u)==0u);';
    case 'destination-minus-source': return 'return pack(select(0u,db-sb,db>sb),select(0u,dg-sg,dg>sg),select(0u,dr-sr,dr>sr));';
    case 'every-other-line': return 'let y=index/WIDTH;return select(destination,source,(y&1u)==0u);';
    case 'xor': return 'return (source^destination)&0x00ffffffu;';
    case 'maximum': return 'return pack(max(sb,db),max(sg,dg),max(sr,dr));';
    case 'minimum': return 'return pack(min(sb,db),min(sg,dg),min(sr,dr));';
    case 'source-minus-destination': return 'return pack(select(0u,sb-db,sb>db),select(0u,sg-dg,sg>dg),select(0u,sr-dr,sr>dr));';
    case 'multiply': return 'return pack((sb*db)/255u,(sg*dg)/255u,(sr*dr)/255u);';
    case 'adjustable': {
      const inverse = 255 - amount;
      return `return pack((sb*${amount}u)/255u+(db*${inverse}u)/255u,(sg*${amount}u)/255u+(dg*${inverse}u)/255u,(sr*${amount}u)/255u+(dr*${inverse}u)/255u);`;
    }
    default: throw new Error(`Unsupported Buffer Save blend ${mode}`);
  }
}
