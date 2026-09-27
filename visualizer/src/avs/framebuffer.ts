/** Packed 0x00RRGGBB compatibility framebuffer and AVS integer blends. */

export type AvsListBlendMode =
  | 'ignore' | 'replace' | 'average' | 'maximum' | 'additive'
  | 'destination-minus-source' | 'source-minus-destination'
  | 'every-other-line' | 'every-other-pixel' | 'xor'
  | 'adjustable' | 'multiply' | 'buffer-depth' | 'minimum';

export const AVS_LIST_BLEND_MODES: Readonly<Record<number, AvsListBlendMode>> = {
  0: 'ignore',
  1: 'replace',
  2: 'average',
  3: 'maximum',
  4: 'additive',
  5: 'destination-minus-source',
  6: 'source-minus-destination',
  7: 'every-other-line',
  8: 'every-other-pixel',
  9: 'xor',
  10: 'adjustable',
  11: 'multiply',
  12: 'buffer-depth',
  13: 'minimum',
};

/** Native AVS's 256x256 `g_blendtable`, shared by all CPU effects. */
export const AVS_BLEND_TABLE = (() => {
  const values = new Uint8Array(256 * 256);
  for (let x = 0; x < 256; x++) {
    const row = x << 8;
    for (let y = 0; y < 256; y++) values[row | y] = Math.trunc((x / 255) * y);
  }
  return values;
})();

export class AvsFramebuffer {
  readonly pixels: Uint32Array;

  constructor(readonly width: number, readonly height: number, pixels?: Uint32Array) {
    if (!Number.isInteger(width) || !Number.isInteger(height) || width <= 0 || height <= 0) {
      throw new RangeError(`Invalid AVS framebuffer size ${width}x${height}`);
    }
    const length = width * height;
    if (pixels && pixels.length !== length) {
      throw new RangeError(`AVS framebuffer has ${pixels.length} pixels, expected ${length}`);
    }
    this.pixels = pixels ?? new Uint32Array(length);
  }

  clear(color = 0): void { this.pixels.fill(color & 0x00ffffff); }
  clone(): AvsFramebuffer { return new AvsFramebuffer(this.width, this.height, this.pixels.slice()); }

  copyFrom(source: AvsFramebuffer): void {
    this.assertShape(source);
    this.pixels.set(source.pixels);
  }

  /** Blend source (the list/local image) over this destination/parent image. */
  blendFrom(
    source: AvsFramebuffer,
    mode: AvsListBlendMode,
    amount = 128,
    depth?: AvsFramebuffer,
    invertDepth = false,
  ): void {
    this.assertShape(source);
    if (mode === 'ignore') return;
    if (mode === 'replace') { this.copyFrom(source); return; }
    if (mode === 'buffer-depth') {
      if (!depth) return;
      this.assertShape(depth);
    }
    const alpha = clampByte(amount);
    const destination = this.pixels;
    const input = source.pixels;
    const length = destination.length;
    if (mode === 'every-other-line') {
      const width = this.width;
      for (let y = 0; y < this.height; y += 2) {
        const end = (y + 1) * width;
        for (let i = y * width; i < end; i++) destination[i] = input[i]!;
      }
      return;
    }
    if (mode === 'every-other-pixel') {
      const width = this.width;
      for (let y = 0; y < this.height; y++) {
        const end = (y + 1) * width;
        for (let i = y * width + (y & 1); i < end; i += 2) destination[i] = input[i]!;
      }
      return;
    }
    if (mode === 'buffer-depth') {
      const depthPixels = depth!.pixels;
      for (let i = 0; i < length; i++) {
        const depthPixel = depthPixels[i]!;
        const low = depthPixel & 255;
        const middle = (depthPixel >>> 8) & 255;
        const high = (depthPixel >>> 16) & 255;
        let mix = low > middle ? low : middle;
        if (high > mix) mix = high;
        if (invertDepth) mix = 255 - mix;
        destination[i] = adjustablePixel(input[i]!, destination[i]!, mix);
      }
      return;
    }
    switch (mode) {
      case 'average':
        for (let i = 0; i < length; i++) {
          destination[i] = ((input[i]! >>> 1) & 0x007f7f7f) + ((destination[i]! >>> 1) & 0x007f7f7f);
        }
        return;
      case 'maximum':
        for (let i = 0; i < length; i++) destination[i] = maximumPixel(input[i]!, destination[i]!);
        return;
      case 'minimum':
        for (let i = 0; i < length; i++) destination[i] = minimumPixel(input[i]!, destination[i]!);
        return;
      case 'additive':
        for (let i = 0; i < length; i++) destination[i] = additivePixel(input[i]!, destination[i]!);
        return;
      case 'destination-minus-source':
        for (let i = 0; i < length; i++) destination[i] = subtractPixel(destination[i]!, input[i]!);
        return;
      case 'source-minus-destination':
        for (let i = 0; i < length; i++) destination[i] = subtractPixel(input[i]!, destination[i]!);
        return;
      case 'xor':
        for (let i = 0; i < length; i++) destination[i] = (input[i]! ^ destination[i]!) & 0x00ffffff;
        return;
      case 'adjustable':
        for (let i = 0; i < length; i++) destination[i] = adjustablePixel(input[i]!, destination[i]!, alpha);
        return;
      case 'multiply':
        for (let i = 0; i < length; i++) destination[i] = multiplyPixel(input[i]!, destination[i]!);
        return;
    }
  }

  private assertShape(other: AvsFramebuffer): void {
    if (other.width !== this.width || other.height !== this.height) {
      throw new RangeError(`AVS framebuffer mismatch ${other.width}x${other.height} vs ${this.width}x${this.height}`);
    }
  }
}

/** Eight preset-global buffers, recreated lazily when the render size changes. */
export class AvsBufferBank {
  private readonly buffers: Array<AvsFramebuffer | null> = new Array(8).fill(null);

  get(index: number, width: number, height: number, create = true): AvsFramebuffer | null {
    if (!Number.isInteger(index) || index < 0 || index >= 8) return null;
    const current = this.buffers[index];
    if (current?.width === width && current.height === height) return current;
    if (!create) return null;
    const next = new AvsFramebuffer(width, height);
    this.buffers[index] = next;
    return next;
  }

  clear(): void { for (const buffer of this.buffers) buffer?.clear(); }
  release(): void { this.buffers.fill(null); }
}

export function decodeAvsListBlend(code: number): AvsListBlendMode {
  return AVS_LIST_BLEND_MODES[code] ?? 'ignore';
}

/** Source is local/list, destination is parent; direction matters for subtract. */
export function blendPixel(source: number, destination: number, mode: AvsListBlendMode, amount = 128): number {
  source &= 0x00ffffff;
  destination &= 0x00ffffff;
  switch (mode) {
    case 'ignore': return destination;
    case 'replace': return source;
    case 'average': return ((source >>> 1) & 0x007f7f7f) + ((destination >>> 1) & 0x007f7f7f);
    case 'maximum': return maximumPixel(source, destination);
    case 'minimum': return minimumPixel(source, destination);
    case 'additive': return additivePixel(source, destination);
    case 'destination-minus-source': return subtractPixel(destination, source);
    case 'source-minus-destination': return subtractPixel(source, destination);
    case 'xor': return (source ^ destination) & 0x00ffffff;
    case 'adjustable':
    case 'buffer-depth': {
      const a = clampByte(amount);
      return adjustablePixel(source, destination, a);
    }
    case 'multiply': return multiplyPixel(source, destination);
    // Selection for these modes is performed by blendFrom because it needs x/y.
    case 'every-other-line':
    case 'every-other-pixel': return source;
  }
}

function maximumPixel(a: number, b: number): number {
  const a0 = a & 255; const b0 = b & 255;
  const a1 = (a >>> 8) & 255; const b1 = (b >>> 8) & 255;
  const a2 = (a >>> 16) & 255; const b2 = (b >>> 16) & 255;
  return (a0 > b0 ? a0 : b0) | ((a1 > b1 ? a1 : b1) << 8) | ((a2 > b2 ? a2 : b2) << 16);
}

function minimumPixel(a: number, b: number): number {
  const a0 = a & 255; const b0 = b & 255;
  const a1 = (a >>> 8) & 255; const b1 = (b >>> 8) & 255;
  const a2 = (a >>> 16) & 255; const b2 = (b >>> 16) & 255;
  return (a0 < b0 ? a0 : b0) | ((a1 < b1 ? a1 : b1) << 8) | ((a2 < b2 ? a2 : b2) << 16);
}

function additivePixel(a: number, b: number): number {
  let c0 = (a & 255) + (b & 255);
  let c1 = ((a >>> 8) & 255) + ((b >>> 8) & 255);
  let c2 = ((a >>> 16) & 255) + ((b >>> 16) & 255);
  if (c0 > 255) c0 = 255;
  if (c1 > 255) c1 = 255;
  if (c2 > 255) c2 = 255;
  return c0 | (c1 << 8) | (c2 << 16);
}

function subtractPixel(a: number, b: number): number {
  let c0 = (a & 255) - (b & 255);
  let c1 = ((a >>> 8) & 255) - ((b >>> 8) & 255);
  let c2 = ((a >>> 16) & 255) - ((b >>> 16) & 255);
  if (c0 < 0) c0 = 0;
  if (c1 < 0) c1 = 0;
  if (c2 < 0) c2 = 0;
  return c0 | (c1 << 8) | (c2 << 16);
}

function adjustablePixel(source: number, destination: number, amount: number): number {
  const inverse = 255 - amount;
  const c0 = table(source & 255, amount) + table(destination & 255, inverse);
  const c1 = table((source >>> 8) & 255, amount) + table((destination >>> 8) & 255, inverse);
  const c2 = table((source >>> 16) & 255, amount) + table((destination >>> 16) & 255, inverse);
  return c0 | (c1 << 8) | (c2 << 16);
}

function multiplyPixel(a: number, b: number): number {
  return table(a & 255, b & 255)
    | (table((a >>> 8) & 255, (b >>> 8) & 255) << 8)
    | (table((a >>> 16) & 255, (b >>> 16) & 255) << 16);
}

/** g_blendtable[x][y] = trunc((x / 255.0) * y). */
function table(x: number, y: number): number { return AVS_BLEND_TABLE[(x << 8) | y]!; }
function clampByte(value: number): number { return value < 0 ? 0 : value > 255 ? 255 : Math.trunc(value); }
