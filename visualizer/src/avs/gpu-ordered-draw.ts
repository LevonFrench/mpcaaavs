/** Inclusive framebuffer-space bounds. Array index is the canonical AVS draw order. */
export interface AvsOrderedDrawRecordBounds {
  readonly minX: number;
  readonly minY: number;
  readonly maxX: number;
  readonly maxY: number;
}

export interface AvsOrderedTilePlanOptions {
  readonly memoryBudgetBytes?: number;
  readonly tileSizes?: readonly number[];
  readonly maxRecords?: number;
  readonly maxComputeWorkgroupsPerDimension?: number;
}

export interface AvsOrderedTilePlan {
  readonly eligible: boolean;
  readonly reason: string | null;
  readonly width: number;
  readonly height: number;
  readonly recordCapacity: number;
  readonly tileSize: number;
  readonly tilesX: number;
  readonly tilesY: number;
  readonly tileCount: number;
  readonly wordsPerTile: number;
  readonly membershipWords: number;
  readonly membershipBytes: number;
  readonly clearDispatchX: number;
  readonly binDispatchX: number;
  readonly rasterDispatchX: number;
  readonly rasterDispatchY: number;
  readonly passes: readonly ['clear-membership', 'bin-records', 'ordered-raster'];
}

const DEFAULT_BUDGET = 64 * 1024 * 1024;
const DEFAULT_TILE_SIZES = [16, 32, 64] as const;
const DEFAULT_MAX_RECORDS = 4 * 128 * 1024;

/**
 * Choose the smallest exact stable-membership grid that fits the resident budget.
 * Each tile owns a dense bitset whose increasing bit index is source draw order.
 */
export function planAvsOrderedTileBinning(
  width: number,
  height: number,
  recordCapacity: number,
  options: AvsOrderedTilePlanOptions = {},
): AvsOrderedTilePlan {
  const budget = options.memoryBudgetBytes ?? DEFAULT_BUDGET;
  const sizes = options.tileSizes ?? DEFAULT_TILE_SIZES;
  const maxRecords = options.maxRecords ?? DEFAULT_MAX_RECORDS;
  const maxWorkgroups = options.maxComputeWorkgroupsPerDimension ?? 65_535;
  const reject = (reason: string): AvsOrderedTilePlan => makePlan(false, reason, width, height, recordCapacity, 0);
  if (!Number.isSafeInteger(width) || !Number.isSafeInteger(height) || width <= 0 || height <= 0) return reject('invalid-frame-size');
  if (width > 0x7fffffff || height > 0x7fffffff) return reject('wgsl-i32-frame-limit');
  if (!Number.isSafeInteger(recordCapacity) || recordCapacity < 0) return reject('invalid-record-capacity');
  if (recordCapacity > maxRecords) return reject('record-capacity-limit');
  if (!Number.isSafeInteger(budget) || budget <= 0) return reject('invalid-memory-budget');
  if (!Number.isSafeInteger(maxWorkgroups) || maxWorkgroups <= 0) return reject('invalid-dispatch-limit');
  const candidates = [...new Set(sizes)].filter(size => Number.isInteger(size) && size > 0).sort((a, b) => a - b);
  if (candidates.length === 0) return reject('no-tile-size');
  let memoryFit = false;
  for (const tileSize of candidates) {
    const plan = makePlan(true, null, width, height, recordCapacity, tileSize);
    if (plan.membershipBytes > budget) continue;
    memoryFit = true;
    if (plan.clearDispatchX <= maxWorkgroups && plan.binDispatchX <= maxWorkgroups
        && plan.rasterDispatchX <= maxWorkgroups && plan.rasterDispatchY <= maxWorkgroups) return plan;
  }
  return reject(memoryFit ? 'dispatch-limit' : 'membership-memory-budget');
}

function makePlan(
  eligible: boolean,
  reason: string | null,
  width: number,
  height: number,
  recordCapacity: number,
  tileSize: number,
): AvsOrderedTilePlan {
  const tilesX = tileSize > 0 && width > 0 ? Math.ceil(width / tileSize) : 0;
  const tilesY = tileSize > 0 && height > 0 ? Math.ceil(height / tileSize) : 0;
  const tileCount = tilesX * tilesY;
  const wordsPerTile = Math.ceil(Math.max(0, recordCapacity) / 32);
  const membershipWords = tileCount * wordsPerTile;
  return {
    eligible, reason, width, height, recordCapacity, tileSize,
    tilesX, tilesY, tileCount, wordsPerTile, membershipWords,
    membershipBytes: membershipWords * 4,
    clearDispatchX: Math.ceil(membershipWords / 256),
    binDispatchX: Math.ceil(Math.max(0, recordCapacity) / 256),
    rasterDispatchX: tilesX,
    rasterDispatchY: tilesY,
    passes: ['clear-membership', 'bin-records', 'ordered-raster'],
  };
}

/** CPU oracle for the atomic membership produced by AVS_ORDERED_TILE_BINNING_WGSL. */
export function binAvsOrderedDrawRecords(
  records: readonly AvsOrderedDrawRecordBounds[],
  plan: AvsOrderedTilePlan,
): Uint32Array {
  if (!plan.eligible) throw new Error(`Cannot bin with ineligible plan: ${plan.reason}`);
  if (records.length > plan.recordCapacity) throw new RangeError('Draw record count exceeds planned capacity');
  const membership = new Uint32Array(plan.membershipWords);
  for (let recordIndex = 0; recordIndex < records.length; recordIndex++) {
    const bounds = clippedBounds(records[recordIndex]!, plan.width, plan.height);
    if (!bounds) continue;
    const minTileX = Math.floor(bounds.minX / plan.tileSize);
    const minTileY = Math.floor(bounds.minY / plan.tileSize);
    const maxTileX = Math.floor(bounds.maxX / plan.tileSize);
    const maxTileY = Math.floor(bounds.maxY / plan.tileSize);
    const word = recordIndex >>> 5;
    const bit = (1 << (recordIndex & 31)) >>> 0;
    for (let tileY = minTileY; tileY <= maxTileY; tileY++) {
      for (let tileX = minTileX; tileX <= maxTileX; tileX++) {
        const tile = tileY * plan.tilesX + tileX;
        membership[tile * plan.wordsPerTile + word] = (membership[tile * plan.wordsPerTile + word]! | bit) >>> 0;
      }
    }
  }
  return membership;
}

/** Iterate candidates in canonical source order. A tile raster must preserve this order. */
export function* avsOrderedTileRecordIndices(
  membership: Uint32Array,
  plan: AvsOrderedTilePlan,
  tileX: number,
  tileY: number,
  recordCount: number,
): Generator<number> {
  if (tileX < 0 || tileY < 0 || tileX >= plan.tilesX || tileY >= plan.tilesY) return;
  const base = (tileY * plan.tilesX + tileX) * plan.wordsPerTile;
  for (let wordIndex = 0; wordIndex < plan.wordsPerTile; wordIndex++) {
    let word = membership[base + wordIndex]! >>> 0;
    while (word !== 0) {
      const bit = 31 - Math.clz32(word & -word);
      const recordIndex = wordIndex * 32 + bit;
      if (recordIndex < recordCount) yield recordIndex;
      word = (word & (word - 1)) >>> 0;
    }
  }
}

function clippedBounds(bounds: AvsOrderedDrawRecordBounds, width: number, height: number): AvsOrderedDrawRecordBounds | null {
  if (![bounds.minX, bounds.minY, bounds.maxX, bounds.maxY].every(Number.isFinite)) return null;
  const minX = Math.max(0, Math.trunc(bounds.minX));
  const minY = Math.max(0, Math.trunc(bounds.minY));
  const maxX = Math.min(width - 1, Math.trunc(bounds.maxX));
  const maxY = Math.min(height - 1, Math.trunc(bounds.maxY));
  return minX <= maxX && minY <= maxY ? { minX, minY, maxX, maxY } : null;
}

/**
 * Portable two-dispatch membership builder. `clear_membership` must complete before
 * `bin_records`; the ordered raster is a later pass that scans words/bits ascending.
 */
export const AVS_ORDERED_TILE_BINNING_WGSL = /* wgsl */ `
struct DrawBounds { min_x: i32, min_y: i32, max_x: i32, max_y: i32 };
struct DrawRecords { values: array<DrawBounds> };
struct Membership { values: array<atomic<u32>> };
struct Params {
  width: u32,
  height: u32,
  record_count: u32,
  tile_size: u32,
  tiles_x: u32,
  tiles_y: u32,
  words_per_tile: u32,
  membership_words: u32,
};

@group(0) @binding(0) var<storage, read> records: DrawRecords;
@group(0) @binding(1) var<storage, read_write> membership: Membership;
@group(0) @binding(2) var<uniform> params: Params;

@compute @workgroup_size(256, 1, 1)
fn clear_membership(@builtin(global_invocation_id) id: vec3<u32>) {
  if (id.x < params.membership_words) { atomicStore(&membership.values[id.x], 0u); }
}

@compute @workgroup_size(256, 1, 1)
fn bin_records(@builtin(global_invocation_id) id: vec3<u32>) {
  let record_index = id.x;
  if (record_index >= params.record_count) { return; }
  let bounds = records.values[record_index];
  let min_x = clamp(bounds.min_x, 0, i32(params.width) - 1);
  let min_y = clamp(bounds.min_y, 0, i32(params.height) - 1);
  let max_x = clamp(bounds.max_x, 0, i32(params.width) - 1);
  let max_y = clamp(bounds.max_y, 0, i32(params.height) - 1);
  if (bounds.max_x < 0 || bounds.max_y < 0 || bounds.min_x >= i32(params.width) ||
      bounds.min_y >= i32(params.height) || min_x > max_x || min_y > max_y) { return; }
  let min_tile_x = u32(min_x) / params.tile_size;
  let min_tile_y = u32(min_y) / params.tile_size;
  let max_tile_x = u32(max_x) / params.tile_size;
  let max_tile_y = u32(max_y) / params.tile_size;
  let record_word = record_index >> 5u;
  let record_bit = 1u << (record_index & 31u);
  for (var tile_y = min_tile_y; tile_y <= max_tile_y; tile_y++) {
    for (var tile_x = min_tile_x; tile_x <= max_tile_x; tile_x++) {
      let tile_index = tile_y * params.tiles_x + tile_x;
      atomicOr(&membership.values[tile_index * params.words_per_tile + record_word], record_bit);
    }
  }
}
`;
