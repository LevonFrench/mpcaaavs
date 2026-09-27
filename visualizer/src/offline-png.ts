const PNG_SIGNATURE = new Uint8Array([137, 80, 78, 71, 13, 10, 26, 10]);
const CRC_TABLE = buildCrcTable();

/** Number of bytes in filter-0 RGB24 scanlines for one frame. */
export function rgbScanlineBytes(width: number, height: number): number {
  assertRaster(width, height);
  return height * (1 + width * 3);
}

/** Number of bytes in one unfiltered, row-major RGB24 raster (the pixel-ledger hash input). */
export function rgbRasterBytes(width: number, height: number): number {
  assertRaster(width, height);
  return width * height * 3;
}

/**
 * Convert AVS packed 0xRRGGBB pixels into reusable PNG RGB scanline storage.
 *
 * The Sub filter preserves the RGB bytes exactly while making the horizontal
 * coherence common to AVS frames substantially cheaper to DEFLATE. Packing
 * directly into filtered storage avoids retaining a second full RGB raster.
 * When `rgbOutput` is given, the unfiltered RGB24 bytes are written there in
 * the same pass so the caller can hash pixels independently of the encoder.
 */
export function packRgbScanlines(
  pixels: Uint32Array,
  width: number,
  height: number,
  output: Uint8Array,
  rgbOutput?: Uint8Array,
): void {
  const expectedPixels = width * height;
  const expectedBytes = rgbScanlineBytes(width, height);
  if (pixels.length !== expectedPixels) {
    throw new RangeError(`Expected ${expectedPixels} packed pixels, got ${pixels.length}`);
  }
  if (output.length !== expectedBytes) {
    throw new RangeError(`Expected ${expectedBytes} RGB scanline bytes, got ${output.length}`);
  }
  if (rgbOutput) {
    if (rgbOutput.length !== expectedPixels * 3) {
      throw new RangeError(`Expected ${expectedPixels * 3} unfiltered RGB bytes, got ${rgbOutput.length}`);
    }
    packRgbScanlinesWithRaster(pixels, width, height, output, rgbOutput);
    return;
  }
  let source = 0;
  let target = 0;
  for (let y = 0; y < height; y++) {
    output[target++] = 1; // PNG filter type Sub.
    const end = source + width;
    let priorR = 0;
    let priorG = 0;
    let priorB = 0;
    while (source < end) {
      const pixel = pixels[source++]!;
      const r = (pixel >>> 16) & 0xff;
      const g = (pixel >>> 8) & 0xff;
      const b = pixel & 0xff;
      output[target++] = r - priorR;
      output[target++] = g - priorG;
      output[target++] = b - priorB;
      priorR = r;
      priorG = g;
      priorB = b;
    }
  }
}

/**
 * The packRgbScanlines loop plus the unfiltered raster write. Kept separate so
 * the plain packing path carries no per-pixel branch.
 */
function packRgbScanlinesWithRaster(
  pixels: Uint32Array,
  width: number,
  height: number,
  output: Uint8Array,
  rgbOutput: Uint8Array,
): void {
  let source = 0;
  let target = 0;
  let raw = 0;
  for (let y = 0; y < height; y++) {
    output[target++] = 1; // PNG filter type Sub.
    const end = source + width;
    let priorR = 0;
    let priorG = 0;
    let priorB = 0;
    while (source < end) {
      const pixel = pixels[source++]!;
      const r = (pixel >>> 16) & 0xff;
      const g = (pixel >>> 8) & 0xff;
      const b = pixel & 0xff;
      output[target++] = r - priorR;
      output[target++] = g - priorG;
      output[target++] = b - priorB;
      rgbOutput[raw++] = r;
      rgbOutput[raw++] = g;
      rgbOutput[raw++] = b;
      priorR = r;
      priorG = g;
      priorB = b;
    }
  }
}

/** Encode prepacked filter-0 rows as an opaque, sRGB, color-type-2 PNG. */
export async function encodeRgb24Png(
  scanlines: Uint8Array,
  width: number,
  height: number,
): Promise<Uint8Array> {
  if (scanlines.length !== rgbScanlineBytes(width, height)) {
    throw new RangeError('RGB scanline storage does not match the requested raster');
  }
  if (typeof CompressionStream === 'undefined') {
    throw new Error('This browser does not provide CompressionStream for lossless PNG export');
  }
  // CompressionStream stays the encoder so PNG bytes, and therefore the sha256
  // ledger, are unchanged. Its chunks are read directly and copied once into
  // the final PNG while the IDAT CRC runs incrementally, instead of being
  // concatenated by Response.arrayBuffer() and then copied a second time.
  const compression = new CompressionStream('deflate');
  const compressedChunks = readAllChunks(compression.readable);
  const writer = compression.writable.getWriter();
  await writer.write(scanlines as Uint8Array<ArrayBuffer>);
  await writer.close();
  const { chunks, byteLength: compressedLength } = await compressedChunks;

  const ihdr = new Uint8Array(13);
  writeU32(ihdr, 0, width);
  writeU32(ihdr, 4, height);
  ihdr[8] = 8; // bit depth
  ihdr[9] = 2; // RGB, explicitly no alpha
  const length = PNG_SIGNATURE.length
    + 12 + ihdr.length
    + 13 // one-byte sRGB chunk
    + 12 + compressedLength
    + 12; // empty IEND chunk
  const png = new Uint8Array(length);
  png.set(PNG_SIGNATURE);
  let offset = PNG_SIGNATURE.length;
  offset = writeChunk(png, offset, 'IHDR', ihdr);
  offset = writeChunk(png, offset, 'sRGB', SRGB_RENDERING_INTENT);
  writeU32(png, offset, compressedLength);
  png.set(IDAT_TYPE, offset + 4);
  let crc = crc32Update(CRC_INITIAL, IDAT_TYPE);
  let cursor = offset + 8;
  for (const chunk of chunks) {
    png.set(chunk, cursor);
    crc = crc32Update(crc, chunk);
    cursor += chunk.byteLength;
  }
  writeU32(png, cursor, (crc ^ CRC_INITIAL) >>> 0);
  writeChunk(png, cursor + 4, 'IEND', EMPTY_BYTES);
  return png;
}

async function readAllChunks(
  readable: ReadableStream<Uint8Array>,
): Promise<{ chunks: Uint8Array[]; byteLength: number }> {
  const reader = readable.getReader();
  const chunks: Uint8Array[] = [];
  let byteLength = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    chunks.push(value);
    byteLength += value.byteLength;
  }
  return { chunks, byteLength };
}

export interface PngFrameWriteResult {
  readonly sha256: string;
  readonly bytes: number;
  /** Wall time from encode start to DEFLATE completion; on a shared thread it includes interleaving. */
  readonly deflateMs: number;
  /** Wall time for hashing, file creation, write and close. */
  readonly writeMs: number;
}

export interface PngFrameWriteOptions {
  /** Debug only: probe for an existing file before every frame write. */
  readonly refuseExisting: boolean;
  readonly cancelled: () => boolean;
}

/**
 * Encode one frame and write it as frames/frame_NNNNNN.png. Shared by the
 * in-thread fallback and the encoder workers so both write identical bytes.
 * Returns null when the job was cancelled before the file was committed.
 */
export async function writePngFrame(
  framesDirectory: FileSystemDirectoryHandle,
  scanlines: Uint8Array,
  width: number,
  height: number,
  frame: number,
  options: PngFrameWriteOptions,
): Promise<PngFrameWriteResult | null> {
  const started = performance.now();
  const png = await encodeRgb24Png(scanlines, width, height);
  const encoded = performance.now();
  if (options.cancelled()) return null;
  const name = frameFileName(frame);
  if (options.refuseExisting) await refuseExistingFile(framesDirectory, name);
  const handle = await framesDirectory.getFileHandle(name, { create: true });
  const writable = await handle.createWritable();
  let sha256: string;
  try {
    if (options.cancelled()) {
      await writable.abort();
      return null;
    }
    [sha256] = await Promise.all([
      sha256Hex(png),
      writable.write(png as Uint8Array<ArrayBuffer>),
    ]);
    await writable.close();
  } catch (error) {
    try { await writable.abort(); } catch { /* original error is authoritative */ }
    throw error;
  }
  return { sha256, bytes: png.byteLength, deflateMs: encoded - started, writeMs: performance.now() - encoded };
}

/**
 * Select bounded encode concurrency from CPU and memory budgets.
 *
 * One in-flight PNG can temporarily retain the filtered RGB input, DEFLATE
 * result, and final PNG. The conservative 3x estimate keeps high-resolution
 * exports from turning throughput into garbage-collection stalls.
 */
export function choosePngEncodeSlots(
  width: number,
  height: number,
  hardwareConcurrency = 4,
  memoryBudgetBytes = 96 * 1024 * 1024,
): number {
  const scanlineBytes = rgbScanlineBytes(width, height);
  const cpuSlots = Math.max(1, Math.min(4, Math.trunc(hardwareConcurrency) - 1 || 1));
  const memorySlots = Math.max(1, Math.trunc(memoryBudgetBytes / (scanlineBytes * 3)));
  return Math.min(cpuSlots, memorySlots);
}

/**
 * Select 1-3 dedicated PNG encoder workers. Each runs DEFLATE on its own
 * thread, so the count leaves one core for the render worker and one for the
 * page, and stays within the same memory budget as the scanline buffers.
 */
export function choosePngEncoderWorkers(
  width: number,
  height: number,
  hardwareConcurrency = 4,
  memoryBudgetBytes = 96 * 1024 * 1024,
): number {
  const scanlineBytes = rgbScanlineBytes(width, height);
  const cpuWorkers = Math.max(1, Math.min(3, Math.trunc(hardwareConcurrency) - 2 || 1));
  const memoryWorkers = Math.max(1, Math.trunc(memoryBudgetBytes / (scanlineBytes * 3)));
  return Math.min(cpuWorkers, memoryWorkers);
}

export function frameFileName(frame: number): string {
  if (!Number.isSafeInteger(frame) || frame < 0 || frame > 999_999) {
    throw new RangeError(`Frame number is outside the six-digit package range: ${frame}`);
  }
  return `frame_${String(frame).padStart(6, '0')}.png`;
}

/**
 * SHA-256 of a byte view. WebCrypto copies its input when digest() is called,
 * so the view is passed directly (no slice) and the caller may reuse the
 * storage as soon as this returns its promise.
 */
export async function sha256Hex(bytes: Uint8Array): Promise<string> {
  const input = bytes.buffer instanceof ArrayBuffer
    ? bytes as Uint8Array<ArrayBuffer>
    : bytes.slice();
  const digest = new Uint8Array(await crypto.subtle.digest('SHA-256', input));
  let hex = '';
  for (let i = 0; i < digest.length; i++) hex += digest[i]!.toString(16).padStart(2, '0');
  return hex;
}

const EMPTY_BYTES = new Uint8Array(0);
const SRGB_RENDERING_INTENT = new Uint8Array([0]);
const IDAT_TYPE = new Uint8Array([0x49, 0x44, 0x41, 0x54]);
const CRC_INITIAL = 0xffffffff;

/**
 * Debug-only overwrite probe. The render worker asserts the output directory is
 * empty at job start and is the only writer of unique frame names, so this
 * extra round trip per frame runs only when a job asks for it.
 */
async function refuseExistingFile(directory: FileSystemDirectoryHandle, name: string): Promise<void> {
  try {
    await directory.getFileHandle(name);
  } catch (error) {
    if (error instanceof DOMException && error.name === 'NotFoundError') return;
    throw error;
  }
  throw new Error(`Refusing to overwrite existing output file frames/${name}`);
}

function writeChunk(output: Uint8Array, offset: number, type: string, data: Uint8Array): number {
  writeU32(output, offset, data.length);
  for (let i = 0; i < 4; i++) output[offset + 4 + i] = type.charCodeAt(i);
  output.set(data, offset + 8);
  const crcInput = output.subarray(offset + 4, offset + 8 + data.length);
  writeU32(output, offset + 8 + data.length, crc32(crcInput));
  return offset + 12 + data.length;
}

function crc32(bytes: Uint8Array): number {
  return (crc32Update(CRC_INITIAL, bytes) ^ CRC_INITIAL) >>> 0;
}

/** Continue a running, not yet inverted, CRC-32 over another span of bytes. */
function crc32Update(crc: number, bytes: Uint8Array): number {
  for (let i = 0; i < bytes.length; i++) crc = CRC_TABLE[(crc ^ bytes[i]!) & 0xff]! ^ (crc >>> 8);
  return crc;
}

function buildCrcTable(): Uint32Array {
  const table = new Uint32Array(256);
  for (let n = 0; n < 256; n++) {
    let c = n;
    for (let k = 0; k < 8; k++) c = (c & 1) ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    table[n] = c >>> 0;
  }
  return table;
}

function writeU32(output: Uint8Array, offset: number, value: number): void {
  output[offset] = value >>> 24;
  output[offset + 1] = value >>> 16;
  output[offset + 2] = value >>> 8;
  output[offset + 3] = value;
}

function assertRaster(width: number, height: number): void {
  if (!Number.isSafeInteger(width) || !Number.isSafeInteger(height) || width <= 0 || height <= 0) {
    throw new RangeError(`Invalid output raster ${width}x${height}`);
  }
}
