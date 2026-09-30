/** Minimal PNG header reader for atlas verification. It checks the signature, the IHDR chunk (length, type, CRC, colour type and
 * depth combination, dimensions) so a manifest's declared atlas size can be compared with the file before the browser decodes it.
 * It does not inflate pixel data; decoding is the host's job (createImageBitmap). Pure: no DOM, no imports. */
export interface PngHeader { readonly width: number; readonly height: number; readonly bitDepth: number; readonly colorType: number; readonly interlaced: boolean }

const SIGNATURE = [137, 80, 78, 71, 13, 10, 26, 10];
const DEPTHS: Readonly<Record<number, readonly number[]>> = { 0: [1, 2, 4, 8, 16], 2: [8, 16], 3: [1, 2, 4, 8], 4: [8, 16], 6: [8, 16] };
let table: Uint32Array | null = null;

export function crc32(bytes: Uint8Array, start = 0, end = bytes.length): number {
  if (!table) {
    table = new Uint32Array(256);
    for (let n = 0; n < 256; n++) { let c = n; for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1; table[n] = c >>> 0; }
  }
  let crc = 0xffffffff;
  for (let i = start; i < end; i++) crc = table[(crc ^ bytes[i]!) & 255]! ^ (crc >>> 8);
  return (crc ^ 0xffffffff) >>> 0;
}

/** Header of a PNG, or a reason it is not acceptable. */
export function readPngHeader(bytes: Uint8Array, maxDimension = 4096): { header: PngHeader; problem?: undefined } | { header?: undefined; problem: string } {
  if (bytes.length < 33) return { problem: 'file is too short to be a PNG' };
  for (let i = 0; i < 8; i++) if (bytes[i] !== SIGNATURE[i]) return { problem: 'file is not a PNG' };
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  if (view.getUint32(8) !== 13 || String.fromCharCode(bytes[12]!, bytes[13]!, bytes[14]!, bytes[15]!) !== 'IHDR') return { problem: 'PNG header chunk is malformed' };
  if (crc32(bytes, 12, 29) !== view.getUint32(29)) return { problem: 'PNG header checksum mismatch' };
  const width = view.getUint32(16), height = view.getUint32(20), bitDepth = bytes[24]!, colorType = bytes[25]!;
  if (!DEPTHS[colorType]?.includes(bitDepth)) return { problem: 'PNG colour type and bit depth are not a valid combination' };
  if (bytes[26] !== 0 || bytes[27] !== 0 || bytes[28]! > 1) return { problem: 'PNG uses an unsupported compression, filter or interlace method' };
  if (width < 1 || height < 1 || width > maxDimension || height > maxDimension) return { problem: `PNG dimensions must be 1-${maxDimension} pixels` };
  return { header: { width, height, bitDepth, colorType, interlaced: bytes[28] === 1 } };
}
