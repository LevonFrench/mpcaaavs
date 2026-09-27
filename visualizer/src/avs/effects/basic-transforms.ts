import { AvsEffectRegistry, type AvsEffectContext } from '../executor.ts';
import { blendPixel } from '../framebuffer.ts';

interface OnBeatClearState { beats: number; quiet: number }
interface InterleaveState { x: number; y: number }
interface MosaicState { quality: number; remaining: number }
interface ColorFadeState { position: [number, number, number]; random: number }

/** Small source-grounded AVS transforms whose payloads are fixed int32 fields. */
export function registerAvsBasicTransforms(registry = new AvsEffectRegistry()): AvsEffectRegistry {
  const clears = new Map<string, OnBeatClearState>();
  const interleaves = new Map<string, InterleaveState>();
  const mosaics = new Map<string, MosaicState>();
  const colorFades = new Map<string, ColorFadeState>();
  const waterFrames = new Map<string, Uint32Array>();

  // Render / OnBeat Clear (ID 5, r_nfclr.cpp).
  registry.registerBuiltin(5, (context) => {
    if (context.preinit) return;
    const color = int(context, 0, 0xffffff) & 0xffffff;
    const average = int(context, 4, 0) !== 0;
    const every = int(context, 8, 1);
    let state = clears.get(context.component.path);
    if (!state) { state = { beats: 0, quiet: 0 }; clears.set(context.component.path, state); }
    if (context.beat) {
      if (every !== 0 && ++state.beats >= every) {
        state.beats = 0; state.quiet = 0;
        if (average) for (let i = 0; i < context.input.pixels.length; i++) {
          context.input.pixels[i] = blendPixel(color, context.input.pixels[i]!, 'average');
        }
        else context.input.clear(color);
      }
    } else if (++state.quiet >= every) state.quiet = 0;
  });

  // Trans / Colorfade (ID 11, r_colorfade.cpp).
  registry.registerBuiltin(11, (context) => {
    if (context.preinit) return;
    const enabled = int(context, 0, 1);
    if (enabled === 0) return;
    const normal: [number, number, number] = [int(context, 4, 8), int(context, 8, -8), int(context, 12, -8)];
    const beat: [number, number, number] = [int(context, 16, normal[0]), int(context, 20, normal[1]), int(context, 24, normal[2])];
    let state = colorFades.get(context.component.path);
    if (!state) { state = { position: [...normal], random: hashPath(context.component.path) }; colorFades.set(context.component.path, state); }
    state.position[0] += Math.sign(normal[0] - state.position[0]);
    state.position[1] += Math.sign(normal[2] - state.position[1]);
    state.position[2] += Math.sign(normal[1] - state.position[2]);
    if ((enabled & 4) === 0) state.position = [...normal];
    else if (context.beat && (enabled & 2) !== 0) {
      state.position[0] = nextRandom(state, 32) - 6;
      state.position[1] = nextRandom(state, 64) - 32;
      if (state.position[1] < 0 && state.position[1] > -16) state.position[1] = -32;
      if (state.position[1] >= 0 && state.position[1] < 16) state.position[1] = 32;
      state.position[2] = nextRandom(state, 32) - 6;
    } else if (context.beat) state.position = [...beat];
    const [first, second, third] = state.position;
    const table = [[third, second, first], [second, first, third], [first, third, second], [third, third, third]];
    for (let i = 0; i < context.input.pixels.length; i++) {
      const pixel = context.input.pixels[i]!;
      const low = pixel & 255, middle = (pixel >>> 8) & 255, high = (pixel >>> 16) & 255;
      const x = middle - high;
      const y = high - low;
      const category = x > 0 && x > -y ? 0 : y < 0 && x < -y ? 1 : x < 0 && y > 0 ? 2 : 3;
      const offsets = table[category]!;
      context.input.pixels[i] = clampByte(low + offsets[0]!)
        | (clampByte(middle + offsets[1]!) << 8)
        | (clampByte(high + offsets[2]!) << 16);
    }
  });

  // Trans / Color Clip (ID 12, r_contrast.cpp).
  registry.registerBuiltin(12, (context) => {
    if (context.preinit) return;
    const mode = int(context, 0, 1);
    if (mode === 0) return;
    const source = int(context, 4, 0x202020) & 0xffffff;
    const replacement = int(context, 8, source) & 0xffffff;
    const distanceSquared = Math.pow(int(context, 12, 10) * 2, 2);
    const sr = source & 255, sg = (source >>> 8) & 255, sb = (source >>> 16) & 255;
    for (let i = 0; i < context.input.pixels.length; i++) {
      const pixel = context.input.pixels[i]!;
      const r = pixel & 255, g = (pixel >>> 8) & 255, b = (pixel >>> 16) & 255;
      const match = mode === 1 ? r <= sr && g <= sg && b <= sb
        : mode === 2 ? r >= sr && g >= sg && b >= sb
          : Math.pow(r - sr, 2) + Math.pow(g - sg, 2) + Math.pow(b - sb, 2) <= distanceSquared;
      if (match) context.input.pixels[i] = replacement;
    }
  });

  // Trans / Water (ID 20, r_water.cpp): discrete wave equation per channel.
  registry.registerBuiltin(20, (context) => {
    if (context.preinit || int(context, 0, 1) === 0) return;
    const { width, height } = context.input;
    const source = context.input.pixels;
    const destination = context.output.pixels;
    let previous = waterFrames.get(context.component.path);
    if (!previous || previous.length !== source.length) {
      previous = new Uint32Array(source.length);
      waterFrames.set(context.component.path, previous);
    }

    // Separate corners, edges, and interior so the 230k-pixel hot loop has no
    // coordinate tests and creates no neighbor arrays/iterators. The packed
    // helpers preserve the native per-channel sums, truncation, and clamp.
    destination[0] = water2(source[1]!, source[width]!, previous[0]!);
    for (let x = 1; x < width - 1; x++) {
      destination[x] = water3(source[x - 1]!, source[x + 1]!, source[width + x]!, previous[x]!);
    }
    const topRight = width - 1;
    destination[topRight] = water2(source[topRight - 1]!, source[topRight + width]!, previous[topRight]!);

    for (let y = 1; y < height - 1; y++) {
      const row = y * width;
      destination[row] = water3(source[row + 1]!, source[row - width]!, source[row + width]!, previous[row]!);
      for (let x = 1; x < width - 1; x++) {
        const index = row + x;
        destination[index] = water4(
          source[index - 1]!, source[index + 1]!, source[index - width]!, source[index + width]!, previous[index]!,
        );
      }
      const right = row + width - 1;
      destination[right] = water3(
        source[right - 1]!, source[right - width]!, source[right + width]!, previous[right]!,
      );
    }

    const bottom = (height - 1) * width;
    destination[bottom] = water2(source[bottom + 1]!, source[bottom - width]!, previous[bottom]!);
    for (let x = 1; x < width - 1; x++) {
      const index = bottom + x;
      destination[index] = water3(
        source[index - 1]!, source[index + 1]!, source[index - width]!, previous[index]!,
      );
    }
    const final = source.length - 1;
    destination[final] = water2(source[final - 1]!, source[final - width]!, previous[final]!);
    previous.set(source);
    return { swap: true };
  });

  // Trans / Interleave (ID 23, r_interleave.cpp).
  registry.registerBuiltin(23, (context) => {
    if (context.preinit || int(context, 0, 1) === 0) return;
    const normalX = int(context, 4, 1);
    const normalY = int(context, 8, 1);
    const color = int(context, 12, 0) & 0xffffff;
    const additive = int(context, 16, 0) !== 0;
    const average = int(context, 20, 0) !== 0;
    const onBeat = int(context, 24, 0) !== 0;
    const beatX = int(context, 28, normalX);
    const beatY = int(context, 32, normalY);
    const duration = int(context, 36, 4);
    let state = interleaves.get(context.component.path);
    if (!state) { state = { x: normalX, y: normalY }; interleaves.set(context.component.path, state); }
    const smoothing = (duration + 448) / 512;
    state.x = state.x * smoothing + normalX * (1 - smoothing);
    state.y = state.y * smoothing + normalY * (1 - smoothing);
    if (context.beat && onBeat) { state.x = beatX; state.y = beatY; }
    const blockX = Math.trunc(state.x);
    const blockY = Math.trunc(state.y);
    if (blockX < 0 || blockY < 0) return;
    let vertical = blockY === 0;
    let yPhase = blockY > 0 ? context.input.height % blockY / 2 : 0;
    const xOffset = blockX > 0 ? Math.trunc((context.input.width % blockX) / 2) : 0;
    for (let y = 0; y < context.input.height; y++) {
      if (blockY > 0 && ++yPhase >= blockY) { vertical = !vertical; yPhase = 0; }
      let horizontal = false;
      for (let x = 0; x < context.input.width; x++) {
        const selected = !vertical || (blockX > 0 && !horizontal);
        if (selected) {
          const index = x + y * context.input.width;
          const mode = additive ? 'additive' : average ? 'average' : 'replace';
          context.input.pixels[index] = blendPixel(color, context.input.pixels[index]!, mode);
        }
        if (blockX > 0 && ((x + xOffset + 1) % blockX) === 0) horizontal = !horizontal;
      }
    }
  });

  // Trans / Mosaic (ID 30, r_mosaic.cpp).
  registry.registerBuiltin(30, (context) => {
    if (context.preinit || int(context, 0, 1) === 0) return;
    const quality = int(context, 4, 50);
    const beatQuality = int(context, 8, quality);
    const additive = int(context, 12, 0) !== 0;
    const average = int(context, 16, 0) !== 0;
    const onBeat = int(context, 20, 0) !== 0;
    const duration = Math.max(1, int(context, 24, 15));
    let state = mosaics.get(context.component.path);
    if (!state) { state = { quality, remaining: 0 }; mosaics.set(context.component.path, state); }
    if (onBeat && context.beat) { state.quality = beatQuality; state.remaining = duration; }
    else if (state.remaining === 0) state.quality = quality;
    if (state.quality < 100 && state.quality > 0) {
      mosaic(context, state.quality, additive, average);
      if (state.remaining > 0) {
        state.remaining--;
        if (state.remaining > 0) {
          const step = Math.trunc(Math.abs(quality - beatQuality) / duration);
          state.quality += step * (beatQuality > quality ? -1 : 1);
        }
      }
      return { swap: true };
    }
    if (state.remaining > 0) state.remaining--;
  });
  return registry;
}

function water2(a: number, b: number, previous: number): number {
  return waterChannels(
    (a & 255) + (b & 255),
    ((a >>> 8) & 255) + ((b >>> 8) & 255),
    ((a >>> 16) & 255) + ((b >>> 16) & 255),
    previous,
  );
}

function water3(a: number, b: number, c: number, previous: number): number {
  return waterChannels(
    ((a & 255) + (b & 255) + (c & 255)) >> 1,
    (((a >>> 8) & 255) + ((b >>> 8) & 255) + ((c >>> 8) & 255)) >> 1,
    (((a >>> 16) & 255) + ((b >>> 16) & 255) + ((c >>> 16) & 255)) >> 1,
    previous,
  );
}

function water4(a: number, b: number, c: number, d: number, previous: number): number {
  return waterChannels(
    ((a & 255) + (b & 255) + (c & 255) + (d & 255)) >> 1,
    (((a >>> 8) & 255) + ((b >>> 8) & 255) + ((c >>> 8) & 255) + ((d >>> 8) & 255)) >> 1,
    (((a >>> 16) & 255) + ((b >>> 16) & 255) + ((c >>> 16) & 255) + ((d >>> 16) & 255)) >> 1,
    previous,
  );
}

function waterChannels(low: number, middle: number, high: number, previous: number): number {
  return clampByte(low - (previous & 255))
    | (clampByte(middle - ((previous >>> 8) & 255)) << 8)
    | (clampByte(high - ((previous >>> 16) & 255)) << 16);
}

function mosaic(context: AvsEffectContext, quality: number, additive: boolean, average: boolean): void {
  const { width, height } = context.input;
  const incrementX = Math.trunc(width * 65536 / quality);
  const incrementY = Math.trunc(height * 65536 / quality);
  let sourceY = incrementY >> 17;
  let yPosition = 0;
  for (let y = 0; y < height; y++) {
    let sourceX = incrementX >> 17;
    let xPosition = 0;
    let sampled = context.input.pixels[Math.min(height - 1, sourceY) * width + Math.min(width - 1, sourceX)]!;
    for (let x = 0; x < width; x++) {
      const index = y * width + x;
      context.output.pixels[index] = additive
        ? blendPixel(sampled, context.input.pixels[index]!, 'additive')
        : average ? blendPixel(sampled, context.input.pixels[index]!, 'average') : sampled;
      xPosition += 65536;
      if (xPosition >= incrementX) {
        sourceX += xPosition >> 16;
        xPosition -= incrementX;
        if (sourceX < width) sampled = context.input.pixels[Math.min(height - 1, sourceY) * width + sourceX]!;
      }
    }
    yPosition += 65536;
    if (yPosition >= incrementY) { sourceY += yPosition >> 16; yPosition -= incrementY; }
  }
}

function int(context: AvsEffectContext, offset: number, fallback: number): number {
  if (offset + 4 > context.component.payload.length) return fallback;
  return new DataView(
    context.component.payload.buffer,
    context.component.payload.byteOffset,
    context.component.payload.byteLength,
  ).getInt32(offset, true);
}
function clampByte(value: number): number { return value < 0 ? 0 : value > 255 ? 255 : Math.trunc(value); }
function nextRandom(state: ColorFadeState, bound: number): number {
  let value = state.random || 0x6d2b79f5;
  value ^= value << 13; value ^= value >>> 17; value ^= value << 5;
  state.random = value >>> 0;
  return state.random % bound;
}
function hashPath(path: string): number {
  let hash = 0x811c9dc5;
  for (let i = 0; i < path.length; i++) hash = Math.imul(hash ^ path.charCodeAt(i), 0x01000193);
  return hash >>> 0;
}
