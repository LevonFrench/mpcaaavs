import { encodeRgb24Png, packRgbScanlines, rgbScanlineBytes, sha256Hex } from '../src/offline-png.ts';

const width = Number(process.env.AAAVS_BENCH_WIDTH ?? 1280);
const height = Number(process.env.AAAVS_BENCH_HEIGHT ?? 720);
const frames = Number(process.env.AAAVS_BENCH_FRAMES ?? 12);
const concurrency = Number(process.env.AAAVS_BENCH_CONCURRENCY ?? 1);
const filter = process.env.AAAVS_BENCH_FILTER ?? 'sub';
const framePixels = Array.from({ length: frames }, (_, frame) => {
  const pixels = new Uint32Array(width * height);
  fillDeterministicFrame(pixels, width, height, frame);
  return pixels;
});
let packMs = 0;
let encodeMs = 0;
let hashMs = 0;
let encodedBytes = 0;

let nextFrame = 0;
const wallStarted = performance.now();
await Promise.all(Array.from({ length: concurrency }, async () => {
  while (nextFrame < frames) {
    const frame = nextFrame++;
    const pixels = framePixels[frame]!;
    const scanlines = new Uint8Array(rgbScanlineBytes(width, height));
  const packStarted = performance.now();
  if (filter === 'paeth') packPaethScanlines(pixels, width, height, scanlines);
  else packRgbScanlines(pixels, width, height, scanlines);
  packMs += performance.now() - packStarted;
  const encodeStarted = performance.now();
  const png = await encodeRgb24Png(scanlines, width, height);
  encodeMs += performance.now() - encodeStarted;
  const hashStarted = performance.now();
  await sha256Hex(png);
  hashMs += performance.now() - hashStarted;
  encodedBytes += png.byteLength;
  }
}));
const wallMs = performance.now() - wallStarted;

const totalMs = packMs + encodeMs + hashMs;
console.log(JSON.stringify({
  width, height, frames, concurrency, filter,
  packMs: round(packMs),
  encodeMs: round(encodeMs),
  hashMs: round(hashMs),
  totalMs: round(totalMs),
  wallMs: round(wallMs),
  framesPerSecond: round(frames * 1000 / wallMs),
  meanPngBytes: Math.round(encodedBytes / frames),
  rawRgbBytes: width * height * 3,
  compressionRatio: round(encodedBytes / frames / (width * height * 3)),
}));

function fillDeterministicFrame(output: Uint32Array, width: number, height: number, frame: number): void {
  for (let y = 0; y < height; y++) {
    const fy = y / height;
    for (let x = 0; x < width; x++) {
      const fx = x / width;
      const wave = Math.sin(fx * 41 + frame * .13) * Math.cos(fy * 29 - frame * .07);
      const ring = Math.sin(Math.hypot(fx - .5, fy - .5) * 90 - frame * .19);
      const noise = xorshift32((x + y * width + frame * 2654435761) >>> 0) & 31;
      const r = clampByte(128 + wave * 90 + ring * 20 + noise);
      const g = clampByte(112 + wave * 55 - ring * 50 + noise);
      const b = clampByte(142 - wave * 70 + ring * 65 + noise);
      output[y * width + x] = (r << 16) | (g << 8) | b;
    }
  }
}

function xorshift32(value: number): number {
  let x = value || 0x6d2b79f5;
  x ^= x << 13; x ^= x >>> 17; x ^= x << 5;
  return x >>> 0;
}

function packPaethScanlines(
  pixels: Uint32Array,
  width: number,
  height: number,
  output: Uint8Array,
): void {
  let source = 0;
  let target = 0;
  for (let y = 0; y < height; y++) {
    output[target++] = 4;
    let leftR = 0;
    let leftG = 0;
    let leftB = 0;
    for (let x = 0; x < width; x++, source++) {
      const pixel = pixels[source]!;
      const above = y > 0 ? pixels[source - width]! : 0;
      const aboveLeft = y > 0 && x > 0 ? pixels[source - width - 1]! : 0;
      const r = (pixel >>> 16) & 0xff;
      const g = (pixel >>> 8) & 0xff;
      const b = pixel & 0xff;
      output[target++] = r - paeth(leftR, above >>> 16, aboveLeft >>> 16);
      output[target++] = g - paeth(leftG, (above >>> 8) & 0xff, (aboveLeft >>> 8) & 0xff);
      output[target++] = b - paeth(leftB, above & 0xff, aboveLeft & 0xff);
      leftR = r;
      leftG = g;
      leftB = b;
    }
  }
}

function paeth(left: number, above: number, aboveLeft: number): number {
  const prediction = left + above - aboveLeft;
  const leftDistance = Math.abs(prediction - left);
  const aboveDistance = Math.abs(prediction - above);
  const cornerDistance = Math.abs(prediction - aboveLeft);
  return leftDistance <= aboveDistance && leftDistance <= cornerDistance
    ? left : aboveDistance <= cornerDistance ? above : aboveLeft;
}

function clampByte(value: number): number {
  return Math.max(0, Math.min(255, Math.round(value)));
}

function round(value: number): number {
  return Math.round(value * 100) / 100;
}
