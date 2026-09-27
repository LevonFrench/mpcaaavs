import type { AvsBitmap } from './effects/bitmap-assets.ts';
import type { AvsTexer2Config, AvsTexerConfig } from './effects/texer.ts';
import type { AvsFrameGraphCapability, AvsGpuPassContext, PackedAvsGpuPass } from './gpu-frame-graph.ts';
import {
  avsOrderedTileRecordIndices,
  binAvsOrderedDrawRecords,
  planAvsOrderedTileBinning,
  type AvsOrderedTilePlan,
} from './gpu-ordered-draw.ts';

export interface ExactAvsTexerDrawRecord {
  readonly left: number;
  readonly top: number;
  readonly right: number;
  readonly bottom: number;
  readonly textureX: number;
  readonly textureY: number;
  readonly color: number;
  readonly flipX: boolean;
  readonly flipY: boolean;
  readonly colorize: boolean;
}

export interface ExactAvsTexerGpuPlan {
  readonly eligible: boolean;
  readonly reason: string | null;
  readonly width: number;
  readonly height: number;
  readonly maxRecords: number;
  readonly tilePlan: AvsOrderedTilePlan;
  readonly scanGroupCount: number;
  readonly maxTilesPerRecord: number;
  readonly compactIndexCapacity: number;
  readonly compactBytes: number;
  readonly residentSchedulingBytes: number;
}

export interface ExactAvsTexerGpuFrame {
  readonly records: readonly ExactAvsTexerDrawRecord[];
  readonly blendMode: number;
  readonly adjustableAlpha: number;
  readonly clearInput: boolean;
}

export const AVS_EXACT_ORDERED_TEXER_GPU_CAPABILITY: AvsFrameGraphCapability = {
  id: 'exact-ordered-texer-fixed-v1',
  backend: 'webgpu',
  lane: 'exact',
  byteExact: true,
  reason: 'Fixed bitmap Texer records are binned by stable source-order bits and replayed per pixel with packed integer AVS blends.',
};

export function planExactAvsTexerGpu(
  width: number,
  height: number,
  bitmap: AvsBitmap,
  maxRecords: number,
  memoryBudgetBytes = 64 * 1024 * 1024,
): ExactAvsTexerGpuPlan {
  const tilePlan = planAvsOrderedTileBinning(width, height, maxRecords, {
    memoryBudgetBytes,
    // The raster kernel maps one 16x16 workgroup to one membership tile.
    tileSizes: [16],
  });
  const scanGroupCount = Math.ceil(tilePlan.tileCount / 256);
  const maxTilesX = tilePlan.tileSize > 0 ? Math.min(tilePlan.tilesX, Math.ceil((bitmap.width + tilePlan.tileSize - 1) / tilePlan.tileSize)) : 0;
  const maxTilesY = tilePlan.tileSize > 0 ? Math.min(tilePlan.tilesY, Math.ceil((bitmap.height + tilePlan.tileSize - 1) / tilePlan.tileSize)) : 0;
  const maxTilesPerRecord = maxTilesX * maxTilesY;
  const compactIndexCapacity = maxRecords * maxTilesPerRecord;
  const compactBytes = compactIndexCapacity * 4;
  const residentSchedulingBytes = tilePlan.membershipBytes + compactBytes + (tilePlan.tileCount + 1 + scanGroupCount * 2) * 4;
  const base = { width, height, maxRecords, tilePlan, scanGroupCount, maxTilesPerRecord, compactIndexCapacity, compactBytes, residentSchedulingBytes };
  const reject = (reason: string): ExactAvsTexerGpuPlan => ({ eligible: false, reason, ...base });
  if (!tilePlan.eligible) return reject(tilePlan.reason ?? 'tile-plan');
  if (!Number.isInteger(bitmap.width) || !Number.isInteger(bitmap.height) || bitmap.width <= 1 || bitmap.height <= 1) return reject('bitmap-dimensions');
  if (bitmap.pixels.length !== bitmap.width * bitmap.height) return reject('bitmap-pixel-count');
  if (bitmap.width > 4096 || bitmap.height > 4096) return reject('bitmap-size-limit');
  if (scanGroupCount > 256) return reject('scan-group-limit');
  if (!Number.isSafeInteger(compactIndexCapacity) || compactIndexCapacity > 0xffffffff) return reject('compact-index-limit');
  if (residentSchedulingBytes > memoryBudgetBytes) return reject('resident-scheduling-memory-budget');
  return { eligible: true, reason: null, ...base };
}

export function exactAvsTexerConfigEligibility(config: AvsTexerConfig): { eligible: true; maxRecords: number } | { eligible: false; reason: string } {
  if (!Number.isSafeInteger(config.particles)) return { eligible: false, reason: 'particle-count' };
  return { eligible: true, maxRecords: Math.max(1, config.particles) };
}

export function exactAvsTexer2ConfigEligibility(config: AvsTexer2Config): { eligible: true; maxRecords: number } | { eligible: false; reason: string } {
  if (config.resize) return { eligible: false, reason: 'resized-sprites-require-fixed-point-raster-v2' };
  return { eligible: true, maxRecords: 65_536 * (config.wrap ? 4 : 1) };
}

/** Original Texer fixed stamp after a nonzero source pixel was selected. */
export function buildExactAvsTexerRecord(
  bitmap: AvsBitmap,
  centreX: number,
  centreY: number,
  mask: number | null,
): ExactAvsTexerDrawRecord {
  const left = centreX - Math.trunc(bitmap.width / 2);
  const top = centreY - Math.trunc(bitmap.height / 2);
  return {
    left, top, right: left + bitmap.width - 1, bottom: top + bitmap.height - 1,
    textureX: 0, textureY: 0, color: mask ?? 0x00ffffff,
    flipX: false, flipY: false, colorize: mask !== null,
  };
}

/** Exact fixed-size Texer II record. Wrapping is represented by calling this for each placement. */
export function buildExactAvsTexer2UnscaledRecord(
  bitmap: AvsBitmap,
  frameWidth: number,
  frameHeight: number,
  x: number,
  y: number,
  color: number,
  colorize: boolean,
  flipX: boolean,
  flipY: boolean,
): ExactAvsTexerDrawRecord | null {
  const screenMaxX = frameWidth - 1, screenMaxY = frameHeight - 1;
  const imageMaxX = bitmap.width - 1, imageMaxY = bitmap.height - 1;
  let left = roundEven((x * 0.5 + 0.5) * screenMaxX) - Math.trunc(imageMaxX / 2);
  let top = roundEven((y * 0.5 + 0.5) * screenMaxY) - Math.trunc(imageMaxY / 2);
  let right = left + imageMaxX - 1, bottom = top + imageMaxY - 1;
  if (right < 0 || left > screenMaxX || bottom < 0 || top > screenMaxY) return null;
  let textureX = left < 0 && right !== left ? roundEven((-left / (right - left)) * imageMaxX) : 0;
  let textureY = top < 0 && bottom !== top ? roundEven((-top / (bottom - top)) * imageMaxY) : 0;
  left = Math.max(0, left); top = Math.max(0, top);
  right = Math.min(screenMaxX, right); bottom = Math.min(screenMaxY, bottom);
  if (right <= left || bottom <= top) return null;
  return { left, top, right, bottom, textureX, textureY, color, colorize, flipX, flipY };
}

export function renderExactAvsTexerRecordsCpu(
  source: Uint32Array,
  width: number,
  height: number,
  bitmap: AvsBitmap,
  frame: ExactAvsTexerGpuFrame,
): Uint32Array {
  const target = frame.clearInput ? new Uint32Array(source.length) : new Uint32Array(source);
  for (const record of frame.records) {
    const minX = Math.max(0, record.left), minY = Math.max(0, record.top);
    const maxX = Math.min(width - 1, record.right), maxY = Math.min(height - 1, record.bottom);
    for (let y = minY; y <= maxY; y++) for (let x = minX; x <= maxX; x++) {
      const texX = record.textureX + x - record.left;
      const texY = record.textureY + y - record.top;
      const sx = record.flipX ? bitmap.width - texX - 1 : texX;
      const sy = record.flipY ? bitmap.height - texY - 1 : texY;
      if (sx < 0 || sy < 0 || sx >= bitmap.width || sy >= bitmap.height) continue;
      let sample = bitmap.pixels[sy * bitmap.width + sx]! & 0x00ffffff;
      if (record.colorize) sample = filterPixel(sample, record.color);
      const offset = y * width + x;
      target[offset] = blendTexerPixel(sample, target[offset]!, frame.blendMode, frame.adjustableAlpha);
    }
  }
  return target;
}

/** CPU oracle for the GPU's per-tile/per-pixel stable replay. */
export function renderExactAvsTexerRecordsBinnedCpu(
  source: Uint32Array,
  width: number,
  height: number,
  bitmap: AvsBitmap,
  frame: ExactAvsTexerGpuFrame,
  plan: ExactAvsTexerGpuPlan,
): Uint32Array {
  const target = frame.clearInput ? new Uint32Array(source.length) : new Uint32Array(source);
  const membership = binAvsOrderedDrawRecords(frame.records.map(record => ({
    minX: record.left, minY: record.top, maxX: record.right, maxY: record.bottom,
  })), plan.tilePlan);
  for (let tileY = 0; tileY < plan.tilePlan.tilesY; tileY++) for (let tileX = 0; tileX < plan.tilePlan.tilesX; tileX++) {
    const x0 = tileX * 16, y0 = tileY * 16;
    for (let y = y0; y < Math.min(height, y0 + 16); y++) for (let x = x0; x < Math.min(width, x0 + 16); x++) {
      const offset = y * width + x;
      let destination = target[offset]!;
      for (const index of avsOrderedTileRecordIndices(membership, plan.tilePlan, tileX, tileY, frame.records.length)) {
        const record = frame.records[index]!;
        if (x < record.left || x > record.right || y < record.top || y > record.bottom) continue;
        const texX = record.textureX + x - record.left, texY = record.textureY + y - record.top;
        const sx = record.flipX ? bitmap.width - texX - 1 : texX;
        const sy = record.flipY ? bitmap.height - texY - 1 : texY;
        if (sx < 0 || sy < 0 || sx >= bitmap.width || sy >= bitmap.height) continue;
        let sample = bitmap.pixels[sy * bitmap.width + sx]! & 0x00ffffff;
        if (record.colorize) sample = filterPixel(sample, record.color);
        destination = blendTexerPixel(sample, destination, frame.blendMode, frame.adjustableAlpha);
      }
      target[offset] = destination;
    }
  }
  return target;
}

export function createExactAvsTexerGpuPassFactory(
  plan: ExactAvsTexerGpuPlan,
  bitmap: AvsBitmap,
): (device: GPUDevice) => ExactAvsOrderedTexerGpuPass {
  if (!plan.eligible) throw new Error(`Cannot create Texer GPU pass: ${plan.reason}`);
  return device => new ExactAvsOrderedTexerGpuPass(device, plan, bitmap);
}

export class ExactAvsOrderedTexerGpuPass implements PackedAvsGpuPass {
  readonly capability = AVS_EXACT_ORDERED_TEXER_GPU_CAPABILITY;
  private readonly clearPipeline: GPUComputePipeline;
  private readonly binPipeline: GPUComputePipeline;
  private readonly countScanPipeline: GPUComputePipeline;
  private readonly groupScanPipeline: GPUComputePipeline;
  private readonly addOffsetsPipeline: GPUComputePipeline;
  private readonly compactPipeline: GPUComputePipeline;
  private readonly rasterPipeline: GPUComputePipeline;
  private readonly records: GPUBuffer;
  private readonly membership: GPUBuffer;
  private readonly bitmap: GPUBuffer;
  private readonly params: GPUBuffer;
  private readonly tileOffsets: GPUBuffer;
  private readonly groupScan: GPUBuffer;
  private readonly compactIndices: GPUBuffer;
  private readonly packedRecords: ArrayBuffer;
  private readonly paramsWords = new Uint32Array(12);
  private readonly groups = new WeakMap<GPUBuffer, WeakMap<GPUBuffer, GPUBindGroup>>();
  private recordCount = 0;
  private destroyed = false;

  constructor(private readonly device: GPUDevice, readonly plan: ExactAvsTexerGpuPlan, bitmap: AvsBitmap) {
    if (!plan.eligible) throw new Error(`Ineligible Texer GPU plan: ${plan.reason}`);
    const module = device.createShaderModule({ label: 'AVS exact ordered Texer', code: AVS_EXACT_ORDERED_TEXER_WGSL });
    const bindGroupLayout = device.createBindGroupLayout({ label: 'AVS Texer shared layout', entries: [
      { binding: 0, visibility: GPUShaderStage.COMPUTE, buffer: { type: 'read-only-storage' } },
      { binding: 1, visibility: GPUShaderStage.COMPUTE, buffer: { type: 'storage' } },
      { binding: 2, visibility: GPUShaderStage.COMPUTE, buffer: { type: 'uniform' } },
      { binding: 3, visibility: GPUShaderStage.COMPUTE, buffer: { type: 'read-only-storage' } },
      { binding: 4, visibility: GPUShaderStage.COMPUTE, buffer: { type: 'read-only-storage' } },
      { binding: 5, visibility: GPUShaderStage.COMPUTE, buffer: { type: 'storage' } },
      { binding: 6, visibility: GPUShaderStage.COMPUTE, buffer: { type: 'storage' } },
      { binding: 7, visibility: GPUShaderStage.COMPUTE, buffer: { type: 'storage' } },
      { binding: 8, visibility: GPUShaderStage.COMPUTE, buffer: { type: 'storage' } },
    ] });
    const pipelineLayout = device.createPipelineLayout({ label: 'AVS Texer pipeline layout', bindGroupLayouts: [bindGroupLayout] });
    this.clearPipeline = device.createComputePipeline({ label: 'AVS Texer clear membership', layout: pipelineLayout, compute: { module, entryPoint: 'clear_membership' } });
    this.binPipeline = device.createComputePipeline({ label: 'AVS Texer bin records', layout: pipelineLayout, compute: { module, entryPoint: 'bin_records' } });
    this.countScanPipeline = device.createComputePipeline({ label: 'AVS Texer tile count scan', layout: pipelineLayout, compute: { module, entryPoint: 'scan_tile_counts' } });
    this.groupScanPipeline = device.createComputePipeline({ label: 'AVS Texer group scan', layout: pipelineLayout, compute: { module, entryPoint: 'scan_group_totals' } });
    this.addOffsetsPipeline = device.createComputePipeline({ label: 'AVS Texer add group offsets', layout: pipelineLayout, compute: { module, entryPoint: 'add_group_offsets' } });
    this.compactPipeline = device.createComputePipeline({ label: 'AVS Texer stable compact', layout: pipelineLayout, compute: { module, entryPoint: 'compact_tiles' } });
    this.rasterPipeline = device.createComputePipeline({ label: 'AVS Texer ordered raster', layout: pipelineLayout, compute: { module, entryPoint: 'raster_texer' } });
    this.records = device.createBuffer({ label: 'AVS Texer records', size: Math.max(32, plan.maxRecords * 32), usage: GPUBufferUsage.STORAGE | GPUBufferUsage.COPY_DST });
    this.membership = device.createBuffer({ label: 'AVS Texer membership', size: Math.max(4, plan.tilePlan.membershipBytes), usage: GPUBufferUsage.STORAGE });
    this.bitmap = device.createBuffer({ label: 'AVS Texer bitmap', size: bitmap.pixels.byteLength, usage: GPUBufferUsage.STORAGE | GPUBufferUsage.COPY_DST });
    this.params = device.createBuffer({ label: 'AVS Texer params', size: this.paramsWords.byteLength, usage: GPUBufferUsage.UNIFORM | GPUBufferUsage.COPY_DST });
    this.tileOffsets = device.createBuffer({ label: 'AVS Texer tile offsets', size: (plan.tilePlan.tileCount + 1) * 4, usage: GPUBufferUsage.STORAGE });
    this.groupScan = device.createBuffer({ label: 'AVS Texer scan group totals and offsets', size: Math.max(8, plan.scanGroupCount * 8), usage: GPUBufferUsage.STORAGE });
    this.compactIndices = device.createBuffer({ label: 'AVS Texer compact indices', size: Math.max(4, plan.compactBytes), usage: GPUBufferUsage.STORAGE });
    this.packedRecords = new ArrayBuffer(Math.max(32, plan.maxRecords * 32));
    device.queue.writeBuffer(this.bitmap, 0, bitmap.pixels.buffer as ArrayBuffer, bitmap.pixels.byteOffset, bitmap.pixels.byteLength);
    this.paramsWords.set([plan.width, plan.height, 0, 16, plan.tilePlan.tilesX, plan.tilePlan.tilesY,
      plan.tilePlan.wordsPerTile, plan.tilePlan.membershipWords, bitmap.width, bitmap.height, 0, 0]);
  }

  update(frame: ExactAvsTexerGpuFrame): void {
    this.assertAlive();
    if (frame.records.length > this.plan.maxRecords) throw new RangeError('Texer record count exceeds planned capacity');
    if (!Number.isInteger(frame.blendMode) || frame.blendMode < 0 || frame.blendMode > 9) throw new RangeError('Unsupported Texer blend mode');
    const ints = new Int32Array(this.packedRecords);
    const uints = new Uint32Array(this.packedRecords);
    for (let index = 0; index < frame.records.length; index++) {
      const record = frame.records[index]!, offset = index * 8;
      const minTileX = Math.floor(Math.max(0, record.left) / 16), minTileY = Math.floor(Math.max(0, record.top) / 16);
      const maxTileX = Math.floor(Math.min(this.plan.width - 1, record.right) / 16), maxTileY = Math.floor(Math.min(this.plan.height - 1, record.bottom) / 16);
      const tileSpan = maxTileX >= minTileX && maxTileY >= minTileY ? (maxTileX - minTileX + 1) * (maxTileY - minTileY + 1) : 0;
      if (tileSpan > this.plan.maxTilesPerRecord) throw new RangeError('Texer record bounds exceed planned fixed-bitmap tile span');
      ints[offset] = record.left; ints[offset + 1] = record.top; ints[offset + 2] = record.right; ints[offset + 3] = record.bottom;
      ints[offset + 4] = record.textureX; ints[offset + 5] = record.textureY;
      uints[offset + 6] = record.color >>> 0;
      uints[offset + 7] = (record.flipX ? 1 : 0) | (record.flipY ? 2 : 0) | (record.colorize ? 4 : 0);
    }
    const bytes = frame.records.length * 32;
    if (bytes > 0) this.device.queue.writeBuffer(this.records, 0, this.packedRecords, 0, bytes);
    this.recordCount = frame.records.length;
    this.paramsWords[2] = this.recordCount;
    this.paramsWords[10] = frame.blendMode;
    this.paramsWords[11] = (clamp(frame.adjustableAlpha, 0, 255) | (frame.clearInput ? 0x100 : 0)) >>> 0;
    this.device.queue.writeBuffer(this.params, 0, this.paramsWords.buffer as ArrayBuffer);
  }

  encode(context: AvsGpuPassContext): void {
    this.encodePasses(context);
  }

  /** Seven passes, two timestamp slots each. Returns the next free query index. */
  encodeTimed(context: AvsGpuPassContext, querySet: GPUQuerySet, firstQuery = 0): number {
    this.encodePasses(context, querySet, firstQuery);
    return firstQuery + 14;
  }

  private encodePasses(context: AvsGpuPassContext, querySet?: GPUQuerySet, firstQuery = 0): void {
    this.assertAlive();
    if (context.width !== this.plan.width || context.height !== this.plan.height) throw new Error('Texer GPU pass/frame size mismatch');
    const group = this.bindGroup(context.source, context.target);
    let query = firstQuery;
    const descriptor = (label: string): GPUComputePassDescriptor => ({ label, ...(querySet ? { timestampWrites: { querySet, beginningOfPassWriteIndex: query++, endOfPassWriteIndex: query++ } } : {}) });
    let pass = context.encoder.beginComputePass(descriptor('AVS Texer clear membership'));
    pass.setPipeline(this.clearPipeline); pass.setBindGroup(0, group);
    if (this.plan.tilePlan.clearDispatchX > 0) pass.dispatchWorkgroups(this.plan.tilePlan.clearDispatchX);
    pass.end();
    pass = context.encoder.beginComputePass(descriptor('AVS Texer stable bin records'));
    pass.setPipeline(this.binPipeline); pass.setBindGroup(0, group);
    if (this.recordCount > 0) pass.dispatchWorkgroups(Math.ceil(this.recordCount / 256));
    pass.end();
    pass = context.encoder.beginComputePass(descriptor('AVS Texer scan tile counts'));
    pass.setPipeline(this.countScanPipeline); pass.setBindGroup(0, group);
    pass.dispatchWorkgroups(this.plan.scanGroupCount); pass.end();
    pass = context.encoder.beginComputePass(descriptor('AVS Texer scan group totals'));
    pass.setPipeline(this.groupScanPipeline); pass.setBindGroup(0, group);
    pass.dispatchWorkgroups(1); pass.end();
    pass = context.encoder.beginComputePass(descriptor('AVS Texer add group offsets'));
    pass.setPipeline(this.addOffsetsPipeline); pass.setBindGroup(0, group);
    pass.dispatchWorkgroups(Math.ceil(this.plan.tilePlan.tileCount / 256)); pass.end();
    pass = context.encoder.beginComputePass(descriptor('AVS Texer compact tile indices'));
    pass.setPipeline(this.compactPipeline); pass.setBindGroup(0, group);
    pass.dispatchWorkgroups(Math.ceil(this.plan.tilePlan.tileCount / 64)); pass.end();
    pass = context.encoder.beginComputePass(descriptor('AVS Texer ordered raster'));
    pass.setPipeline(this.rasterPipeline); pass.setBindGroup(0, group);
    pass.dispatchWorkgroups(this.plan.tilePlan.tilesX, this.plan.tilePlan.tilesY);
    pass.end();
  }

  destroy(): void {
    if (this.destroyed) return;
    this.destroyed = true;
    this.records.destroy(); this.membership.destroy(); this.bitmap.destroy(); this.params.destroy();
    this.tileOffsets.destroy(); this.groupScan.destroy(); this.compactIndices.destroy();
  }

  private bindGroup(source: GPUBuffer, target: GPUBuffer): GPUBindGroup {
    let targets = this.groups.get(source);
    if (!targets) { targets = new WeakMap(); this.groups.set(source, targets); }
    let group = targets.get(target);
    if (!group) {
      group = this.device.createBindGroup({ label: 'AVS Texer ordered resources', layout: this.rasterPipeline.getBindGroupLayout(0), entries: [
        { binding: 0, resource: { buffer: this.records } }, { binding: 1, resource: { buffer: this.membership } },
        { binding: 2, resource: { buffer: this.params } }, { binding: 3, resource: { buffer: this.bitmap } },
        { binding: 4, resource: { buffer: source } }, { binding: 5, resource: { buffer: target } },
        { binding: 6, resource: { buffer: this.tileOffsets } }, { binding: 7, resource: { buffer: this.groupScan } },
        { binding: 8, resource: { buffer: this.compactIndices } },
      ] });
      targets.set(target, group);
    }
    return group;
  }

  private assertAlive(): void { if (this.destroyed) throw new Error('Texer GPU pass is destroyed'); }
}

function filterPixel(pixel: number, color: number): number {
  return (((pixel & 255) * (color & 255)) >>> 8)
    | (((((pixel >>> 8) & 255) * ((color >>> 8) & 255)) >>> 8) << 8)
    | (((((pixel >>> 16) & 255) * ((color >>> 16) & 255)) >>> 8) << 16);
}
function blendTexerPixel(source: number, destination: number, mode: number, amount: number): number {
  source &= 0x00ffffff; destination &= 0x00ffffff;
  const channels = (fn: (s: number, d: number) => number): number => {
    const c = (shift: number): number => fn((source >>> shift) & 255, (destination >>> shift) & 255) & 255;
    return c(0) | c(8) << 8 | c(16) << 16;
  };
  switch (mode) {
    case 1: return channels((s, d) => Math.min(255, s + d));
    case 2: return channels(Math.max);
    case 3: return ((source >>> 1) & 0x007f7f7f) + ((destination >>> 1) & 0x007f7f7f);
    case 4: return channels((s, d) => Math.max(0, d - s));
    case 5: return channels((s, d) => Math.max(0, s - d));
    case 6: return channels((s, d) => (s * d) >>> 8);
    case 7: { const alpha = clamp(amount, 0, 255); return channels((s, d) => ((s * alpha) >>> 8) + ((d * (256 - alpha)) >>> 8)); }
    case 8: return (source ^ destination) & 0x00ffffff;
    case 9: return channels(Math.min);
    default: return source;
  }
}
function roundEven(value: number): number {
  const floor = Math.floor(value), fraction = value - floor;
  return fraction < 0.5 ? floor : fraction > 0.5 ? floor + 1 : (floor & 1) === 0 ? floor : floor + 1;
}
function clamp(value: number, minimum: number, maximum: number): number { return Math.min(maximum, Math.max(minimum, value)); }

export const AVS_EXACT_ORDERED_TEXER_WGSL = /* wgsl */ `
struct DrawRecord { left:i32, top:i32, right:i32, bottom:i32, texture_x:i32, texture_y:i32, color:u32, flags:u32 };
struct Records { values:array<DrawRecord> }; struct Membership { values:array<atomic<u32>> }; struct Bitmap { pixels:array<u32> };
struct Frame { pixels:array<u32> }; struct Words { values:array<u32> };
struct Params { width:u32, height:u32, record_count:u32, tile_size:u32, tiles_x:u32, tiles_y:u32, words_per_tile:u32, membership_words:u32, bitmap_width:u32, bitmap_height:u32, blend_mode:u32, alpha_flags:u32 };
@group(0) @binding(0) var<storage,read> records:Records; @group(0) @binding(1) var<storage,read_write> membership:Membership;
@group(0) @binding(2) var<uniform> params:Params; @group(0) @binding(3) var<storage,read> bitmap:Bitmap;
@group(0) @binding(4) var<storage,read> source:Frame; @group(0) @binding(5) var<storage,read_write> destination:Frame;
@group(0) @binding(6) var<storage,read_write> tile_offsets:Words; @group(0) @binding(7) var<storage,read_write> group_scan:Words;
@group(0) @binding(8) var<storage,read_write> compact_indices:Words;
var<workgroup> scan_scratch:array<u32,256>;
@compute @workgroup_size(256) fn clear_membership(@builtin(global_invocation_id) id:vec3u){if(id.x<params.membership_words){atomicStore(&membership.values[id.x],0u);}}
@compute @workgroup_size(256) fn bin_records(@builtin(global_invocation_id) id:vec3u){let i=id.x;if(i>=params.record_count){return;}let r=records.values[i];if(r.right<0||r.bottom<0||r.left>=i32(params.width)||r.top>=i32(params.height)){return;}let x0=u32(max(0,r.left))/params.tile_size;let y0=u32(max(0,r.top))/params.tile_size;let x1=u32(min(i32(params.width)-1,r.right))/params.tile_size;let y1=u32(min(i32(params.height)-1,r.bottom))/params.tile_size;for(var ty=y0;ty<=y1;ty++){for(var tx=x0;tx<=x1;tx++){atomicOr(&membership.values[(ty*params.tiles_x+tx)*params.words_per_tile+(i>>5u)],1u<<(i&31u));}}}
@compute @workgroup_size(256) fn scan_tile_counts(@builtin(local_invocation_index) lid:u32,@builtin(workgroup_id) group:vec3u){let tile_count=params.tiles_x*params.tiles_y;let tile=group.x*256u+lid;var count=0u;if(tile<tile_count){let base=tile*params.words_per_tile;for(var w=0u;w<params.words_per_tile;w++){count+=countOneBits(atomicLoad(&membership.values[base+w]));}}scan_scratch[lid]=count;workgroupBarrier();for(var step=1u;step<256u;step<<=1u){var add=0u;if(lid>=step){add=scan_scratch[lid-step];}workgroupBarrier();if(lid>=step){scan_scratch[lid]+=add;}workgroupBarrier();}if(tile<tile_count){tile_offsets.values[tile]=scan_scratch[lid]-count;}let group_size=min(256u,tile_count-group.x*256u);if(lid+1u==group_size){group_scan.values[group.x]=scan_scratch[lid];}}
@compute @workgroup_size(256) fn scan_group_totals(@builtin(local_invocation_index) lid:u32){let tile_count=params.tiles_x*params.tiles_y;let groups=(tile_count+255u)/256u;let count=select(0u,group_scan.values[lid],lid<groups);scan_scratch[lid]=count;workgroupBarrier();for(var step=1u;step<256u;step<<=1u){var add=0u;if(lid>=step){add=scan_scratch[lid-step];}workgroupBarrier();if(lid>=step){scan_scratch[lid]+=add;}workgroupBarrier();}if(lid<groups){group_scan.values[groups+lid]=scan_scratch[lid]-count;}if(lid+1u==groups){tile_offsets.values[tile_count]=scan_scratch[lid];}}
@compute @workgroup_size(256) fn add_group_offsets(@builtin(global_invocation_id) id:vec3u){let tile_count=params.tiles_x*params.tiles_y;let groups=(tile_count+255u)/256u;if(id.x<tile_count){tile_offsets.values[id.x]+=group_scan.values[groups+id.x/256u];}}
@compute @workgroup_size(64) fn compact_tiles(@builtin(global_invocation_id) id:vec3u){let tile_count=params.tiles_x*params.tiles_y;let tile=id.x;if(tile>=tile_count){return;}let output=tile_offsets.values[tile];let base=tile*params.words_per_tile;var cursor=0u;for(var wi=0u;wi<params.words_per_tile;wi++){var bits=atomicLoad(&membership.values[base+wi]);while(bits!=0u){let bit=firstTrailingBit(bits);let ri=wi*32u+bit;if(ri<params.record_count){compact_indices.values[output+cursor]=ri;cursor++;}bits&=bits-1u;}}}
fn ch(p:u32,s:u32)->u32{return (p>>s)&255u;} fn pack(r:u32,g:u32,b:u32)->u32{return r|(g<<8u)|(b<<16u);} fn filt(p:u32,c:u32)->u32{return pack((ch(p,0u)*ch(c,0u))>>8u,(ch(p,8u)*ch(c,8u))>>8u,(ch(p,16u)*ch(c,16u))>>8u);}
fn blend(s:u32,d:u32)->u32{let m=params.blend_mode;let sr=ch(s,0u);let sg=ch(s,8u);let sb=ch(s,16u);let dr=ch(d,0u);let dg=ch(d,8u);let db=ch(d,16u);if(m==1u){return pack(min(255u,sr+dr),min(255u,sg+dg),min(255u,sb+db));}if(m==2u){return pack(max(sr,dr),max(sg,dg),max(sb,db));}if(m==3u){return ((s>>1u)&0x007f7f7fu)+((d>>1u)&0x007f7f7fu);}if(m==4u){return pack(select(0u,dr-sr,dr>=sr),select(0u,dg-sg,dg>=sg),select(0u,db-sb,db>=sb));}if(m==5u){return pack(select(0u,sr-dr,sr>=dr),select(0u,sg-dg,sg>=dg),select(0u,sb-db,sb>=db));}if(m==6u){return pack((sr*dr)>>8u,(sg*dg)>>8u,(sb*db)>>8u);}if(m==7u){let a=params.alpha_flags&255u;let z=256u-a;return pack(((sr*a)>>8u)+((dr*z)>>8u),((sg*a)>>8u)+((dg*z)>>8u),((sb*a)>>8u)+((db*z)>>8u));}if(m==8u){return (s^d)&0x00ffffffu;}if(m==9u){return pack(min(sr,dr),min(sg,dg),min(sb,db));}return s&0x00ffffffu;}
@compute @workgroup_size(16,16,1) fn raster_texer(@builtin(global_invocation_id) id:vec3u,@builtin(workgroup_id) group:vec3u){if(id.x>=params.width||id.y>=params.height){return;}let pixel=id.y*params.width+id.x;var d=select(source.pixels[pixel],0u,(params.alpha_flags&0x100u)!=0u);let tile=group.y*params.tiles_x+group.x;let begin=tile_offsets.values[tile];let end=tile_offsets.values[tile+1u];for(var ci=begin;ci<end;ci++){let r=records.values[compact_indices.values[ci]];if(i32(id.x)>=r.left&&i32(id.x)<=r.right&&i32(id.y)>=r.top&&i32(id.y)<=r.bottom){var tx=r.texture_x+i32(id.x)-r.left;var ty=r.texture_y+i32(id.y)-r.top;if((r.flags&1u)!=0u){tx=i32(params.bitmap_width)-tx-1;}if((r.flags&2u)!=0u){ty=i32(params.bitmap_height)-ty-1;}if(tx>=0&&ty>=0&&tx<i32(params.bitmap_width)&&ty<i32(params.bitmap_height)){var s=bitmap.pixels[u32(ty)*params.bitmap_width+u32(tx)]&0x00ffffffu;if((r.flags&4u)!=0u){s=filt(s,r.color);}d=blend(s,d);}}}destination.pixels[pixel]=d;}
`;
