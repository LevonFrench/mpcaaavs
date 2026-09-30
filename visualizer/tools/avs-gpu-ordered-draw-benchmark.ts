import { performance } from 'node:perf_hooks';
import {
  avsOrderedTileRecordIndices,
  binAvsOrderedDrawRecords,
  planAvsOrderedTileBinning,
  type AvsOrderedDrawRecordBounds,
} from '../src/avs/gpu-ordered-draw.ts';

interface DrawRecord extends AvsOrderedDrawRecordBounds { readonly color: number }
const width = 640, height = 360;
const cases = [
  { count: 1_024, samples: 15 },
  { count: 16_384, samples: 7 },
  { count: 65_536, samples: 3 },
];
const results = [];

for (const test of cases) {
  const generation: number[] = [], binning: number[] = [], directRaster: number[] = [], binnedRaster: number[] = [];
  let checksum = 0;
  const plan = planAvsOrderedTileBinning(width, height, test.count);
  for (let sample = -2; sample < test.samples; sample++) {
    const generationStart = performance.now();
    const records = generate(test.count, sample + 3);
    const generationElapsed = performance.now() - generationStart;
    const binStart = performance.now();
    const membership = binAvsOrderedDrawRecords(records, plan);
    const binElapsed = performance.now() - binStart;
    const directStart = performance.now();
    const direct = rasterDirect(records);
    const directElapsed = performance.now() - directStart;
    const binnedStart = performance.now();
    const binned = rasterBinned(records, membership, plan);
    const binnedElapsed = performance.now() - binnedStart;
    const directHash = hash(direct), binnedHash = hash(binned);
    if (directHash !== binnedHash) throw new Error(`Binned raster differs at ${test.count} records`);
    checksum = directHash;
    if (sample >= 0) {
      generation.push(generationElapsed); binning.push(binElapsed);
      directRaster.push(directElapsed); binnedRaster.push(binnedElapsed);
    }
  }
  results.push({
    records: test.count,
    tileSize: plan.tileSize,
    membershipBytes: plan.membershipBytes,
    generationMedianMs: median(generation),
    binningMedianMs: median(binning),
    directRasterMedianMs: median(directRaster),
    binnedRasterMedianMs: median(binnedRaster),
    checksum,
  });
}

console.log(JSON.stringify({ width, height, workload: 'deterministic 1-7px ordered rectangles', results }, null, 2));

function generate(count: number, frame: number): DrawRecord[] {
  let seed = (0x9e3779b9 ^ frame) >>> 0;
  const random = (): number => { seed ^= seed << 13; seed ^= seed >>> 17; seed ^= seed << 5; return seed >>> 0; };
  const records: DrawRecord[] = [];
  for (let index = 0; index < count; index++) {
    const x = Number(random() % (width + 24)) - 12;
    const y = Number(random() % (height + 24)) - 12;
    const size = 1 + random() % 7;
    records.push({ minX: x, minY: y, maxX: x + size - 1, maxY: y + size - 1, color: random() & 0x00ffffff });
  }
  return records;
}

function rasterDirect(records: readonly DrawRecord[]): Uint32Array {
  const pixels = new Uint32Array(width * height);
  for (const record of records) paint(pixels, record, 0, 0, width - 1, height - 1);
  return pixels;
}

function rasterBinned(records: readonly DrawRecord[], membership: Uint32Array, plan: ReturnType<typeof planAvsOrderedTileBinning>): Uint32Array {
  const pixels = new Uint32Array(width * height);
  for (let tileY = 0; tileY < plan.tilesY; tileY++) for (let tileX = 0; tileX < plan.tilesX; tileX++) {
    const minX = tileX * plan.tileSize, minY = tileY * plan.tileSize;
    const maxX = Math.min(width - 1, minX + plan.tileSize - 1);
    const maxY = Math.min(height - 1, minY + plan.tileSize - 1);
    for (const index of avsOrderedTileRecordIndices(membership, plan, tileX, tileY, records.length)) {
      paint(pixels, records[index]!, minX, minY, maxX, maxY);
    }
  }
  return pixels;
}

function paint(pixels: Uint32Array, record: DrawRecord, clipMinX: number, clipMinY: number, clipMaxX: number, clipMaxY: number): void {
  const minX = Math.max(clipMinX, record.minX, 0), minY = Math.max(clipMinY, record.minY, 0);
  const maxX = Math.min(clipMaxX, record.maxX, width - 1), maxY = Math.min(clipMaxY, record.maxY, height - 1);
  for (let y = minY; y <= maxY; y++) for (let x = minX; x <= maxX; x++) {
    const offset = y * width + x;
    pixels[offset] = blend(record.color, pixels[offset]!);
  }
}

function blend(source: number, destination: number): number {
  return channel(source, destination, 0) | channel(source, destination, 8) << 8 | channel(source, destination, 16) << 16;
}
function channel(source: number, destination: number, shift: number): number {
  return ((((source >>> shift) & 255) * 173 >>> 8) + (((destination >>> shift) & 255) * 83 >>> 8)) & 255;
}
function median(values: number[]): number { return values.sort((a, b) => a - b)[Math.floor(values.length / 2)]!; }
function hash(pixels: Uint32Array): number {
  let value = 0x811c9dc5;
  for (const pixel of pixels) value = Math.imul(value ^ pixel, 0x01000193);
  return value >>> 0;
}
