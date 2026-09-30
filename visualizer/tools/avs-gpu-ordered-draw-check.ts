import {
  AVS_ORDERED_TILE_BINNING_WGSL,
  avsOrderedTileRecordIndices,
  binAvsOrderedDrawRecords,
  planAvsOrderedTileBinning,
  type AvsOrderedDrawRecordBounds,
} from '../src/avs/gpu-ordered-draw.ts';

let assertions = 0;
const assert = (condition: unknown, message: string): asserts condition => {
  assertions++;
  if (!condition) throw new Error(message);
};

const plan = planAvsOrderedTileBinning(640, 360, 65_536);
assert(plan.eligible, '65K records at 640x360 should fit the default resident budget');
assert(plan.tileSize === 16 && plan.tilesX === 40 && plan.tilesY === 23, 'unexpected default tile grid');
assert(plan.membershipBytes === 7_536_640, 'membership byte accounting mismatch');
assert(plan.passes.join(',') === 'clear-membership,bin-records,ordered-raster', 'multi-dispatch ordering contract missing');
assert(planAvsOrderedTileBinning(1920, 1080, 131_072).tileSize === 32, 'planner should enlarge tiles to stay under budget');
assert(planAvsOrderedTileBinning(640, 360, 600_000).reason === 'record-capacity-limit', 'record safety limit must fail closed');
assert(planAvsOrderedTileBinning(3840, 2160, 131_072, { tileSizes: [16], memoryBudgetBytes: 64 << 20 }).reason === 'membership-memory-budget', 'memory budget must fail closed');
assert(planAvsOrderedTileBinning(640, 360, 65_536, { maxComputeWorkgroupsPerDimension: 10 }).reason === 'dispatch-limit', 'dispatch limit must fail closed');

const records: AvsOrderedDrawRecordBounds[] = [
  { minX: -5, minY: -5, maxX: 2, maxY: 2 },
  { minX: 1, minY: 1, maxX: 18, maxY: 18 },
  { minX: 4, minY: 4, maxX: 6, maxY: 6 },
  { minX: 700, minY: 0, maxX: 710, maxY: 4 },
  { minX: 2, minY: 2, maxX: 2, maxY: 2 },
];
const small = planAvsOrderedTileBinning(32, 32, records.length, { tileSizes: [16] });
const membership = binAvsOrderedDrawRecords(records, small);
assert([...avsOrderedTileRecordIndices(membership, small, 0, 0, records.length)].join(',') === '0,1,2,4', 'tile candidates must retain source order');
assert([...avsOrderedTileRecordIndices(membership, small, 1, 1, records.length)].join(',') === '1', 'cross-tile bounds membership mismatch');

// Collision order is observable for source-over style blends. Tile replay must equal direct replay.
const colors = [0x102030, 0xf01020, 0x20e030, 0x3040d0, 0xffffff];
let direct = 0x010203;
for (const index of [0, 1, 2, 4]) direct = orderedBlend(colors[index]!, direct);
let binned = 0x010203;
for (const index of avsOrderedTileRecordIndices(membership, small, 0, 0, records.length)) binned = orderedBlend(colors[index]!, binned);
assert(binned === direct, 'ordered collision replay differs from direct source order');
let reversed = 0x010203;
for (const index of [4, 2, 1, 0]) reversed = orderedBlend(colors[index]!, reversed);
assert(reversed !== direct, 'collision fixture must be order-sensitive');

let seed = 0x7f4a7c15;
const random = (): number => { seed ^= seed << 13; seed ^= seed >>> 17; seed ^= seed << 5; return seed >>> 0; };
for (let trial = 0; trial < 64; trial++) {
  const count = 1 + random() % 257;
  const randomRecords: AvsOrderedDrawRecordBounds[] = [];
  for (let index = 0; index < count; index++) {
    const x = Number(random() % 100) - 18, y = Number(random() % 75) - 18;
    randomRecords.push({ minX: x, minY: y, maxX: x + random() % 24, maxY: y + random() % 24 });
  }
  const randomPlan = planAvsOrderedTileBinning(64, 48, count, { tileSizes: [16] });
  const bits = binAvsOrderedDrawRecords(randomRecords, randomPlan);
  for (let tileY = 0; tileY < randomPlan.tilesY; tileY++) for (let tileX = 0; tileX < randomPlan.tilesX; tileX++) {
    const actual = [...avsOrderedTileRecordIndices(bits, randomPlan, tileX, tileY, count)];
    const expected = randomRecords.flatMap((record, index) => overlapsTile(record, tileX, tileY, randomPlan.tileSize, 64, 48) ? [index] : []);
    assert(actual.join(',') === expected.join(','), `random stable membership mismatch trial=${trial} tile=${tileX},${tileY}`);
  }
}
assert(AVS_ORDERED_TILE_BINNING_WGSL.includes('atomicOr'), 'WGSL must use order-independent atomic membership writes');
assert(AVS_ORDERED_TILE_BINNING_WGSL.includes('clear_membership') && AVS_ORDERED_TILE_BINNING_WGSL.includes('bin_records'), 'WGSL must expose bounded separate passes');

console.log(`AVS ordered GPU draw scheduling check passed (${assertions} assertions)`);

function overlapsTile(record: AvsOrderedDrawRecordBounds, tileX: number, tileY: number, size: number, width: number, height: number): boolean {
  const minX = Math.max(0, Math.trunc(record.minX)), minY = Math.max(0, Math.trunc(record.minY));
  const maxX = Math.min(width - 1, Math.trunc(record.maxX)), maxY = Math.min(height - 1, Math.trunc(record.maxY));
  if (minX > maxX || minY > maxY) return false;
  return maxX >= tileX * size && minX < Math.min(width, (tileX + 1) * size)
    && maxY >= tileY * size && minY < Math.min(height, (tileY + 1) * size);
}

function orderedBlend(source: number, destination: number): number {
  const channel = (shift: number): number => {
    const s = (source >>> shift) & 255, d = (destination >>> shift) & 255;
    return ((s * 173 >>> 8) + (d * 83 >>> 8)) & 255;
  };
  return channel(0) | channel(8) << 8 | channel(16) << 16;
}
