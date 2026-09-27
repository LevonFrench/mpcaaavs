/** Immutable top-down AVS bitmap in packed 0x00RRGGBB form. */
export interface AvsBitmap {
  readonly width: number;
  readonly height: number;
  readonly pixels: Uint32Array;
}

/** Synchronous by design: AVS effect handlers render synchronously. */
export type AvsBitmapResolver = (legacyName: string) => AvsBitmap | null | undefined;

export type AvsBitmapAsset = AvsBitmap | Uint8Array;

/**
 * Build a case-insensitive resolver from decoded bitmaps or original BMP bytes.
 * Both the normalized legacy path and its basename are indexed, allowing an
 * importer to retain old absolute paths while storing assets by filename.
 */
export function createAvsBitmapResolver(
  assets: Readonly<Record<string, AvsBitmapAsset>> | ReadonlyMap<string, AvsBitmapAsset>,
): AvsBitmapResolver {
  const resolved = new Map<string, AvsBitmap>();
  const decoded = new Map<AvsBitmapAsset, AvsBitmap>();
  const byteViews = new Map<ArrayBufferLike, Map<string, AvsBitmap>>();
  const entries: Iterable<readonly [string, AvsBitmapAsset]> = assets instanceof Map
    ? assets.entries()
    : Object.entries(assets);
  for (const [name, value] of entries) {
    const key = value instanceof Uint8Array ? `${value.byteOffset}:${value.byteLength}` : '';
    const cached = value instanceof Uint8Array ? byteViews.get(value.buffer)?.get(key) : decoded.get(value);
    const bitmap = cached ?? (value instanceof Uint8Array ? decodeAvsBmp(value) : validateBitmap(value));
    if (value instanceof Uint8Array) {
      const views = byteViews.get(value.buffer) ?? new Map<string, AvsBitmap>();
      views.set(key, bitmap); byteViews.set(value.buffer, views);
    } else decoded.set(value, bitmap);
    const normalized = normalizeName(name);
    resolved.set(normalized, bitmap);
    resolved.set(basename(normalized), bitmap);
  }
  return (legacyName) => {
    const normalized = normalizeName(legacyName);
    return resolved.get(normalized) ?? resolved.get(basename(normalized)) ?? null;
  };
}

/** Decode the BMP variants used by the audited Texer resource corpus. */
export function decodeAvsBmp(bytes: Uint8Array): AvsBitmap {
  if (bytes.length < 54 || bytes[0] !== 0x42 || bytes[1] !== 0x4d) {
    throw new Error('Invalid BMP file header');
  }
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  const pixelOffset = u32(view, 10);
  const dibSize = u32(view, 14);
  if (dibSize < 40 || 14 + dibSize > bytes.length) throw new Error(`Unsupported BMP DIB header ${dibSize}`);
  const width = i32(view, 18);
  const rawHeight = i32(view, 22);
  const planes = u16(view, 26);
  const bits = u16(view, 28);
  const compression = u32(view, 30);
  if (width <= 0 || rawHeight === 0 || planes !== 1) throw new Error('Invalid BMP dimensions or plane count');
  const height = Math.abs(rawHeight);
  // Reject expansion bombs before allocating pixels, including compressed RLE.
  if (!Number.isSafeInteger(width * height) || width * height > 16_777_216) throw new Error('BMP exceeds pixel budget');
  const topDown = rawHeight < 0;
  if (pixelOffset > bytes.length) throw new Error('BMP pixel offset is outside the file');

  if (!(compression === 1 && bits === 8)
    && !(compression === 0 && [1, 4, 8, 16, 24, 32].includes(bits))
    && !(compression === 3 && [16, 32].includes(bits))) throw new Error('Unsupported BMP encoding');
  if (compression !== 1) {
    const stride = Math.floor((width * bits + 31) / 32) * 4;
    if (pixelOffset + stride * height > bytes.length) throw new Error('Truncated BMP pixel rows');
  }

  const palette = readPalette(bytes, view, dibSize, bits);
  const pixels = new Uint32Array(width * height);
  if (compression === 1 && bits === 8) {
    decodeRle8(bytes.subarray(pixelOffset), pixels, width, height, topDown, palette);
  } else if (compression === 0 || (compression === 3 && (bits === 16 || bits === 32))) {
    decodeRows(bytes, view, pixelOffset, pixels, width, height, topDown, bits, compression, dibSize, palette);
  } else {
    throw new Error(`Unsupported BMP encoding: ${bits} bits, compression ${compression}`);
  }
  return { width, height, pixels };
}

function decodeRows(
  bytes: Uint8Array,
  view: DataView,
  pixelOffset: number,
  pixels: Uint32Array,
  width: number,
  height: number,
  topDown: boolean,
  bits: number,
  compression: number,
  dibSize: number,
  palette: readonly number[],
): void {
  if (![1, 4, 8, 16, 24, 32].includes(bits)) throw new Error(`Unsupported BMP depth ${bits}`);
  const stride = Math.floor((width * bits + 31) / 32) * 4;
  const masks = colorMasks(view, bits, compression, dibSize);
  for (let storedY = 0; storedY < height; storedY++) {
    const y = topDown ? storedY : height - storedY - 1;
    const row = pixelOffset + storedY * stride;
    if (row + stride > bytes.length) throw new Error('Truncated BMP pixel rows');
    for (let x = 0; x < width; x++) {
      let pixel: number;
      if (bits === 1) pixel = palette[(bytes[row + (x >>> 3)]! >>> (7 - (x & 7))) & 1] ?? 0;
      else if (bits === 4) {
        const packed = bytes[row + (x >>> 1)]!;
        pixel = palette[(x & 1) === 0 ? packed >>> 4 : packed & 15] ?? 0;
      } else if (bits === 8) pixel = palette[bytes[row + x]!] ?? 0;
      else if (bits === 16) pixel = maskedPixel(u16(view, row + x * 2), masks);
      else if (bits === 24) {
        const offset = row + x * 3;
        pixel = bytes[offset]! | (bytes[offset + 1]! << 8) | (bytes[offset + 2]! << 16);
      } else pixel = maskedPixel(u32(view, row + x * 4), masks);
      pixels[y * width + x] = pixel & 0x00ffffff;
    }
  }
}

function decodeRle8(
  data: Uint8Array,
  pixels: Uint32Array,
  width: number,
  height: number,
  topDown: boolean,
  palette: readonly number[],
): void {
  let offset = 0;
  let x = 0;
  let storedY = 0;
  const write = (index: number): void => {
    if (x < width && storedY < height) {
      const y = topDown ? storedY : height - storedY - 1;
      pixels[y * width + x] = palette[index] ?? 0;
    }
    x++;
  };
  while (offset + 1 < data.length && storedY < height) {
    const count = data[offset++]!;
    const value = data[offset++]!;
    if (count !== 0) {
      for (let i = 0; i < count; i++) write(value);
      continue;
    }
    if (value === 0) { x = 0; storedY++; continue; }
    if (value === 1) break;
    if (value === 2) {
      if (offset + 1 >= data.length) throw new Error('Truncated BMP RLE delta');
      x += data[offset++]!;
      storedY += data[offset++]!;
      continue;
    }
    if (offset + value > data.length) throw new Error('Truncated BMP RLE literal');
    for (let i = 0; i < value; i++) write(data[offset + i]!);
    offset += value;
    if (value & 1) offset++;
  }
}

function readPalette(bytes: Uint8Array, view: DataView, dibSize: number, bits: number): number[] {
  if (bits > 8) return [];
  const declared = u32(view, 46);
  const count = declared || (1 << bits);
  const start = 14 + dibSize;
  if (start + count * 4 > bytes.length) throw new Error('Truncated BMP palette');
  const palette: number[] = [];
  for (let index = 0; index < count; index++) {
    const offset = start + index * 4;
    palette.push(bytes[offset]! | (bytes[offset + 1]! << 8) | (bytes[offset + 2]! << 16));
  }
  return palette;
}

interface Masks { readonly red: number; readonly green: number; readonly blue: number }
function colorMasks(view: DataView, bits: number, compression: number, dibSize: number): Masks {
  if (bits !== 16 && bits !== 32) return { red: 0, green: 0, blue: 0 };
  if (bits === 16 && compression === 0) return { red: 0x7c00, green: 0x03e0, blue: 0x001f };
  if (bits === 32 && compression === 0) return { red: 0x00ff0000, green: 0x0000ff00, blue: 0x000000ff };
  const offset = dibSize >= 52 ? 14 + 40 : 14 + dibSize;
  return { red: u32(view, offset), green: u32(view, offset + 4), blue: u32(view, offset + 8) };
}
function maskedPixel(value: number, masks: Masks): number {
  return scaleMask(value, masks.blue) | (scaleMask(value, masks.green) << 8) | (scaleMask(value, masks.red) << 16);
}
function scaleMask(value: number, mask: number): number {
  if (mask === 0) return 0;
  let shift = 0;
  while (((mask >>> shift) & 1) === 0) shift++;
  const maximum = mask >>> shift;
  return Math.round((((value & mask) >>> shift) * 255) / maximum);
}
function validateBitmap(bitmap: AvsBitmap): AvsBitmap {
  if (!Number.isInteger(bitmap.width) || !Number.isInteger(bitmap.height)
      || bitmap.width <= 0 || bitmap.height <= 0
      || bitmap.pixels.length !== bitmap.width * bitmap.height) {
    throw new Error('Invalid AVS bitmap asset');
  }
  return bitmap;
}
function normalizeName(name: string): string { return name.trim().replaceAll('\\', '/').toLowerCase(); }
function basename(name: string): string { return name.slice(name.lastIndexOf('/') + 1); }
function u16(view: DataView, offset: number): number {
  if (offset + 2 > view.byteLength) throw new Error('Truncated BMP field');
  return view.getUint16(offset, true);
}
function u32(view: DataView, offset: number): number {
  if (offset + 4 > view.byteLength) throw new Error('Truncated BMP field');
  return view.getUint32(offset, true);
}
function i32(view: DataView, offset: number): number {
  if (offset + 4 > view.byteLength) throw new Error('Truncated BMP field');
  return view.getInt32(offset, true);
}
