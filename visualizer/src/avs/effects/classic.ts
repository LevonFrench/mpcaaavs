import { AvsEffectRegistry, type AvsEffectContext } from '../executor.ts';

/** Hooks for effects which call the process-global C `rand()`. */
export interface AvsClassicEffectOptions {
  readonly randomInt?: (exclusiveMaximum: number) => number;
}

interface BlitterState { scale: number; position: number }
interface MirrorInstanceState { beatMode: number; frameCount: number }
interface MirrorSharedState { lastMode: number; divisor: number[]; increment: number[] }

/** Register source-grounded AVS 2.81d byte-framebuffer transforms. */
export function registerAvsClassicEffects(
  registry = new AvsEffectRegistry(),
  options: AvsClassicEffectOptions = {},
): AvsEffectRegistry {
  const randomInt = options.randomInt ?? ((maximum: number) => Math.floor(Math.random() * maximum));
  const blitters = new Map<string, BlitterState>();
  const scatterTables = new Map<number, Int32Array>();
  const mirrors = new Map<string, MirrorInstanceState>();
  // r_mirror.cpp declares these function-static, so all Mirror instances share them.
  const mirrorShared: MirrorSharedState = {
    lastMode: 0, divisor: [0, 0, 0, 0], increment: [0, 0, 0, 0],
  };

  // Trans / Fadeout (r_fadeout.cpp).
  registry.registerBuiltin(3, (ctx) => {
    if (ctx.preinit) return;
    const fade = int(ctx, 0, 16);
    if (fade === 0) return;
    const target = int(ctx, 4, 0);
    const tr = target & 0xff;
    const tg = (target >>> 8) & 0xff;
    const tb = (target >>> 16) & 0xff;
    // approach() is a pure function of one byte for a fixed target and fade,
    // so per-call 256-entry LUTs give identical pixels (alpha still dropped).
    const low = FADE_LUT_LOW, middle = FADE_LUT_MIDDLE, high = FADE_LUT_HIGH;
    for (let v = 0; v < 256; v++) {
      low[v] = approach(v, tr, fade);
      middle[v] = approach(v, tg, fade) << 8;
      high[v] = approach(v, tb, fade) << 16;
    }
    const pixels = ctx.input.pixels;
    for (let i = 0; i < pixels.length; i++) {
      const pixel = pixels[i]!;
      pixels[i] = low[pixel & 0xff]! | middle[(pixel >>> 8) & 0xff]! | high[(pixel >>> 16) & 0xff]!;
    }
  });

  // Trans / Blitter Feedback (r_blit.cpp).
  registry.registerBuiltin(4, (ctx) => {
    if (ctx.preinit) return;
    const scale = int(ctx, 0, 30);
    const beatScale = int(ctx, 4, 30);
    const blend = int(ctx, 8, 0) !== 0;
    const changeOnBeat = int(ctx, 12, 0) !== 0;
    const subpixel = int(ctx, 16, 0) !== 0;
    let state = blitters.get(ctx.component.path);
    if (!state || state.scale !== scale) {
      state = { scale, position: scale };
      blitters.set(ctx.component.path, state);
    }
    if (ctx.beat && changeOnBeat) state.position = beatScale;
    let value: number;
    if (scale < beatScale) {
      value = Math.max(state.position, scale);
      state.position -= 3;
    } else {
      value = Math.min(state.position, scale);
      state.position += 3;
    }
    value = Math.max(0, value);
    if (value < 32) {
      blitIn(ctx, value, blend, subpixel);
      return { swap: true };
    }
    if (value > 32) blitOut(ctx, value, blend);
  });

  // Trans / Blur (r_blur.cpp): mode 1 normal, 2 light, 3 heavy.
  registry.registerBuiltin(6, (ctx) => {
    const mode = int(ctx, 0, 1);
    if (ctx.preinit || mode === 0) return;
    blur(ctx, mode, int(ctx, 4, 0) !== 0);
    return { swap: true };
  });

  // Trans / Scatter (r_scat.cpp).
  registry.registerBuiltin(16, (ctx) => {
    if (int(ctx, 0, 1) === 0 || ctx.preinit) return;
    const { width, height } = ctx.input;
    // The C renderer assumes at least eight rows and otherwise overruns.
    if (height <= 8) {
      ctx.output.copyFrom(ctx.input);
      return { swap: true };
    }
    let table = scatterTables.get(width);
    if (!table) {
      table = new Int32Array(512);
      for (let i = 0; i < table.length; i++) {
        let dx = (i % 8) - 4;
        let dy = (Math.floor(i / 8) % 8) - 4;
        if (dx < 0) dx++;
        if (dy < 0) dy++;
        table[i] = width * dy + dx;
      }
      scatterTables.set(width, table);
    }
    const edge = width * 4;
    ctx.output.pixels.set(ctx.input.pixels.subarray(0, edge), 0);
    for (let i = edge; i < width * (height - 4); i++) {
      const offset = table[normalizeRandom(randomInt(512), 512)]!;
      ctx.output.pixels[i] = ctx.input.pixels[i + offset]!;
    }
    ctx.output.pixels.set(ctx.input.pixels.subarray(width * (height - 4)), width * (height - 4));
    return { swap: true };
  });

  // Trans / Brightness (r_bright.cpp).
  registry.registerBuiltin(22, (ctx) => {
    if (ctx.preinit || int(ctx, 0, 1) === 0) return;
    const additive = int(ctx, 4, 0) !== 0;
    const average = int(ctx, 8, 1) !== 0;
    const red = multiplier(int(ctx, 12, 0));
    const green = multiplier(int(ctx, 16, 0));
    const blue = multiplier(int(ctx, 20, 0));
    // Offset 24 (`dissoc`) affects only the configuration UI.
    const reference = int(ctx, 28, 0);
    const exclude = int(ctx, 32, 0) !== 0;
    const distance = int(ctx, 36, 16);
    for (let i = 0; i < ctx.input.pixels.length; i++) {
      const pixel = ctx.input.pixels[i]!;
      if (exclude && inRange(pixel, reference, distance)) continue;
      const adjusted = adjustBrightness(pixel, red, green, blue);
      ctx.input.pixels[i] = additive ? add(pixel, adjusted)
        : average ? averagePixel(pixel, adjusted)
          : adjusted;
    }
  });

  // Trans / Mirror (r_mirror.cpp).
  registry.registerBuiltin(26, (ctx) => {
    if (ctx.preinit || int(ctx, 0, 1) === 0) return;
    const configuredMode = int(ctx, 4, 1) & 15;
    const onBeat = int(ctx, 8, 0) !== 0;
    const smooth = int(ctx, 12, 0) !== 0;
    const slower = Math.max(1, int(ctx, 16, 4));
    let state = mirrors.get(ctx.component.path);
    if (!state) {
      // rbeat is uninitialized in the original constructor. Zero is the only
      // deterministic interpretation before the first beat.
      state = { beatMode: 0, frameCount: 0 };
      mirrors.set(ctx.component.path, state);
    }
    if (onBeat && ctx.beat) state.beatMode = normalizeRandom(randomInt(16), 16) & configuredMode;
    const mode = onBeat ? state.beatMode : configuredMode;
    updateMirrorTarget(mirrorShared, mode);
    renderMirror(ctx, mode, smooth, mirrorShared.divisor);
    state.frameCount++;
    if (smooth && state.frameCount % slower === 0) stepMirror(mirrorShared);
  });

  return registry;
}

function blur(ctx: AvsEffectContext, mode: number, roundUp: boolean): void {
  const { width, height } = ctx.input;
  const source = ctx.input.pixels;
  const destination = ctx.output.pixels;
  if (width < 2 || height < 2) { destination.set(source); return; }
  if (mode === 3) renderHeavyBlur(source, destination, width, height, roundUp);
  else if (mode === 2) renderLightBlur(source, destination, width, height, roundUp);
  else renderNormalBlur(source, destination, width, height, roundUp);
}

const SHIFT_1_MASK = 0x007f7f7f;
const SHIFT_2_MASK = 0x003f3f3f;
const SHIFT_3_MASK = 0x001f1f1f;
const SHIFT_4_MASK = 0x000f0f0f;
const ROUND_1 = 0x00010101;
const ROUND_2 = 0x00020202;
const ROUND_3 = 0x00030303;
const ROUND_4 = 0x00040404;
const ROUND_5 = 0x00050505;

function shr1(pixel: number): number { return (pixel >>> 1) & SHIFT_1_MASK; }
function shr2(pixel: number): number { return (pixel >>> 2) & SHIFT_2_MASK; }
function shr3(pixel: number): number { return (pixel >>> 3) & SHIFT_3_MASK; }
function shr4(pixel: number): number { return (pixel >>> 4) & SHIFT_4_MASK; }

function renderNormalBlur(
  source: Uint32Array, destination: Uint32Array, width: number, height: number, roundUp: boolean,
): void {
  const cornerRound = roundUp ? ROUND_2 : 0;
  const edgeRound = roundUp ? ROUND_3 : 0;
  const centerRound = roundUp ? ROUND_4 : 0;
  destination[0] = cornerRound + shr1(source[0]!) + shr2(source[1]!) + shr2(source[width]!);
  for (let x = 1; x < width - 1; x++) {
    destination[x] = edgeRound + shr2(source[x]!) + shr2(source[x - 1]!)
      + shr2(source[x + 1]!) + shr2(source[width + x]!);
  }
  destination[width - 1] = cornerRound + shr1(source[width - 1]!)
    + shr2(source[width - 2]!) + shr2(source[width * 2 - 1]!);

  for (let y = 1; y < height - 1; y++) {
    const row = y * width;
    destination[row] = edgeRound + shr2(source[row]!) + shr2(source[row + 1]!)
      + shr2(source[row - width]!) + shr2(source[row + width]!);
    for (let x = 1; x < width - 1; x++) {
      const index = row + x;
      destination[index] = centerRound + shr1(source[index]!) + shr3(source[index - 1]!)
        + shr3(source[index + 1]!) + shr3(source[index - width]!) + shr3(source[index + width]!);
    }
    const right = row + width - 1;
    destination[right] = edgeRound + shr2(source[right]!) + shr2(source[right - 1]!)
      + shr2(source[right - width]!) + shr2(source[right + width]!);
  }

  const bottom = (height - 1) * width;
  destination[bottom] = cornerRound + shr1(source[bottom]!)
    + shr2(source[bottom + 1]!) + shr2(source[bottom - width]!);
  for (let x = 1; x < width - 1; x++) {
    const index = bottom + x;
    destination[index] = edgeRound + shr2(source[index]!) + shr2(source[index - 1]!)
      + shr2(source[index + 1]!) + shr2(source[index - width]!);
  }
  const final = source.length - 1;
  destination[final] = cornerRound + shr1(source[final]!)
    + shr2(source[final - 1]!) + shr2(source[final - width]!);
}

function renderLightBlur(
  source: Uint32Array, destination: Uint32Array, width: number, height: number, roundUp: boolean,
): void {
  const cornerRound = roundUp ? ROUND_3 : 0;
  const edgeRound = roundUp ? ROUND_4 : 0;
  const centerRound = roundUp ? ROUND_5 : 0;
  destination[0] = cornerRound + shr1(source[0]!) + shr2(source[0]!)
    + shr3(source[1]!) + shr3(source[width]!);
  for (let x = 1; x < width - 1; x++) {
    destination[x] = edgeRound + shr1(source[x]!) + shr3(source[x]!)
      + shr3(source[x - 1]!) + shr3(source[x + 1]!) + shr3(source[width + x]!);
  }
  destination[width - 1] = cornerRound + shr1(source[width - 1]!) + shr2(source[width - 1]!)
    + shr3(source[width - 2]!) + shr3(source[width * 2 - 1]!);

  for (let y = 1; y < height - 1; y++) {
    const row = y * width;
    destination[row] = edgeRound + shr1(source[row]!) + shr3(source[row]!)
      + shr3(source[row + 1]!) + shr3(source[row - width]!) + shr3(source[row + width]!);
    for (let x = 1; x < width - 1; x++) {
      const index = row + x;
      destination[index] = centerRound + shr1(source[index]!) + shr2(source[index]!)
        + shr4(source[index - 1]!) + shr4(source[index + 1]!)
        + shr4(source[index - width]!) + shr4(source[index + width]!);
    }
    const right = row + width - 1;
    destination[right] = edgeRound + shr1(source[right]!) + shr3(source[right]!)
      + shr3(source[right - 1]!) + shr3(source[right - width]!) + shr3(source[right + width]!);
  }

  const bottom = (height - 1) * width;
  destination[bottom] = cornerRound + shr1(source[bottom]!) + shr2(source[bottom]!)
    + shr3(source[bottom + 1]!) + shr3(source[bottom - width]!);
  for (let x = 1; x < width - 1; x++) {
    const index = bottom + x;
    destination[index] = edgeRound + shr1(source[index]!) + shr3(source[index]!)
      + shr3(source[index - 1]!) + shr3(source[index + 1]!) + shr3(source[index - width]!);
  }
  const final = source.length - 1;
  destination[final] = cornerRound + shr1(source[final]!) + shr2(source[final]!)
    + shr3(source[final - 1]!) + shr3(source[final - width]!);
}

function renderHeavyBlur(
  source: Uint32Array, destination: Uint32Array, width: number, height: number, roundUp: boolean,
): void {
  const cornerRound = roundUp ? ROUND_1 : 0;
  const edgeRound = roundUp ? ROUND_2 : 0;
  const centerRound = roundUp ? ROUND_3 : 0;
  destination[0] = cornerRound + shr1(source[1]!) + shr1(source[width]!);
  for (let x = 1; x < width - 1; x++) {
    destination[x] = edgeRound + shr2(source[x - 1]!) + shr2(source[x + 1]!) + shr1(source[width + x]!);
  }
  destination[width - 1] = cornerRound + shr1(source[width - 2]!) + shr1(source[width * 2 - 1]!);

  for (let y = 1; y < height - 1; y++) {
    const row = y * width;
    destination[row] = edgeRound + shr1(source[row + 1]!) + shr2(source[row - width]!) + shr2(source[row + width]!);
    for (let x = 1; x < width - 1; x++) {
      const index = row + x;
      destination[index] = centerRound + shr2(source[index - 1]!) + shr2(source[index + 1]!)
        + shr2(source[index - width]!) + shr2(source[index + width]!);
    }
    const right = row + width - 1;
    destination[right] = edgeRound + shr1(source[right - 1]!)
      + shr2(source[right - width]!) + shr2(source[right + width]!);
  }

  const bottom = (height - 1) * width;
  destination[bottom] = cornerRound + shr1(source[bottom + 1]!) + shr1(source[bottom - width]!);
  for (let x = 1; x < width - 1; x++) {
    const index = bottom + x;
    destination[index] = edgeRound + shr2(source[index - 1]!) + shr2(source[index + 1]!) + shr1(source[index - width]!);
  }
  const final = source.length - 1;
  destination[final] = cornerRound + shr1(source[final - 1]!) + shr1(source[final - width]!);
}

function blitIn(ctx: AvsEffectContext, value: number, blend: boolean, subpixel: boolean): void {
  const { width, height } = ctx.input;
  const source = ctx.input.pixels;
  const destination = ctx.output.pixels;
  const step = Math.trunc(((value + 32) * 65_536) / 64);
  const startX = Math.trunc(((width * 65_536) - step * width) / 2);
  let sourceY = Math.trunc(((height * 65_536) - step * height) / 2);
  for (let y = 0; y < height; y++) {
    let sourceX = startX;
    for (let x = 0; x < width; x++) {
      const sx = sourceX >> 16;
      const sy = sourceY >> 16;
      const sampled = subpixel
        ? bilinear(source, width, height, sx, sy, (sourceX >> 8) & 0xff, (sourceY >> 8) & 0xff)
        : source[sy * width + sx]!;
      destination[y * width + x] = blend ? averagePixel(source[y * width + x]!, sampled) : sampled;
      sourceX += step;
      // Preserve the non-subpixel + blend loop's extra step after each group of four.
      if (!subpixel && blend && (x & 3) === 3) sourceX += step;
    }
    sourceY += step;
  }
}

function blitOut(ctx: AvsEffectContext, value: number, blend: boolean): void {
  const { width, height } = ctx.input;
  const source = ctx.input.pixels;
  const scratch = ctx.output.pixels;
  const step = (value + 128 - 32) << 9;
  const regionWidth = Math.trunc((width * 65_536) / step) & ~3;
  const regionHeight = Math.trunc((height * 65_536) / step);
  if (regionWidth >= width || regionHeight >= height || regionWidth <= 0 || regionHeight <= 0) return;
  const startX = Math.trunc((width - regionWidth) / 2);
  const startY = Math.trunc((height - regionHeight) / 2);
  let sourceY = 32_768;
  for (let y = 0; y < regionHeight; y++) {
    let sourceX = 32_768;
    const sy = sourceY >> 16;
    for (let x = 0; x < regionWidth; x++) {
      const sampled = source[sy * width + (sourceX >> 16)]!;
      const index = (startY + y) * width + startX + x;
      scratch[index] = blend ? averagePixel(source[index]!, sampled) : sampled;
      sourceX += step;
      if (blend && (x & 3) === 3) sourceX += step;
    }
    sourceY += step;
  }
  for (let y = 0; y < regionHeight; y++) {
    const offset = (startY + y) * width + startX;
    source.set(scratch.subarray(offset, offset + regionWidth), offset);
  }
}

function bilinear(
  pixels: Uint32Array, width: number, height: number,
  x: number, y: number, xPart: number, yPart: number,
): number {
  const x1 = Math.min(width - 1, x + 1);
  const y1 = Math.min(height - 1, y + 1);
  const a = pixels[y * width + x]!;
  const b = pixels[y * width + x1]!;
  const c = pixels[y1 * width + x]!;
  const d = pixels[y1 * width + x1]!;
  return channels4(a, b, c, d, (av, bv, cv, dv) => {
    const top = (av * (255 - xPart) + bv * xPart) >>> 8;
    const bottom = (cv * (255 - xPart) + dv * xPart) >>> 8;
    return (top * (255 - yPart) + bottom * yPart) >>> 8;
  });
}

function renderMirror(ctx: AvsEffectContext, mode: number, smooth: boolean, divisor: readonly number[]): void {
  const pixels = ctx.input.pixels;
  const { width, height } = ctx.input;
  const halfWidth = Math.trunc(width / 2);
  const halfHeight = Math.trunc(height / 2);
  if ((mode & 4) !== 0 || (smooth && divisor[2]! !== 0)) {
    const amount = divisor[2]!;
    for (let y = 0; y < height; y++) for (let x = 0; x < halfWidth; x++) {
      const source = y * width + x;
      const target = y * width + width - 1 - x;
      pixels[target] = smooth && amount ? adaptive(pixels[target]!, pixels[source]!, amount) : pixels[source]!;
    }
  }
  if ((mode & 8) !== 0 || (smooth && divisor[3]! !== 0)) {
    const amount = divisor[3]!;
    for (let y = 0; y < height; y++) for (let x = 0; x < halfWidth; x++) {
      const target = y * width + x;
      const source = y * width + width - 1 - x;
      pixels[target] = smooth && amount ? adaptive(pixels[target]!, pixels[source]!, amount) : pixels[source]!;
    }
  }
  if ((mode & 1) !== 0 || (smooth && divisor[0]! !== 0)) {
    const amount = divisor[0]!;
    for (let y = 0; y < halfHeight; y++) for (let x = 0; x < width; x++) {
      const source = y * width + x;
      const target = (height - 1 - y) * width + x;
      pixels[target] = smooth && amount ? adaptive(pixels[target]!, pixels[source]!, amount) : pixels[source]!;
    }
  }
  if ((mode & 2) !== 0 || (smooth && divisor[1]! !== 0)) {
    const amount = divisor[1]!;
    for (let y = 0; y < halfHeight; y++) for (let x = 0; x < width; x++) {
      const target = y * width + x;
      const source = (height - 1 - y) * width + x;
      pixels[target] = smooth && amount ? adaptive(pixels[target]!, pixels[source]!, amount) : pixels[source]!;
    }
  }
}

function updateMirrorTarget(state: MirrorSharedState, mode: number): void {
  const difference = mode ^ state.lastMode;
  for (let i = 0; i < 4; i++) {
    const bit = 1 << i;
    if ((difference & bit) === 0) continue;
    const wasOn = (state.lastMode & bit) !== 0;
    state.increment[i] = wasOn ? -1 : 1;
    if (state.divisor[i] === 0) state.divisor[i] = wasOn ? 16 : 1;
  }
  state.lastMode = mode;
}

function stepMirror(state: MirrorSharedState): void {
  for (let i = 0; i < 4; i++) {
    if (state.divisor[i] !== 0) state.divisor[i] = (state.divisor[i]! + state.increment[i]! + 16) % 16;
  }
}

function adaptive(current: number, target: number, divisor: number): number {
  return channels2(current, target, (a, b) => ((a >>> 4) * (16 - divisor) + (b >>> 4) * divisor) & 0xff);
}

function multiplier(setting: number): number {
  return Math.trunc((1 + (setting < 0 ? 1 : 16) * (setting / 4096)) * 65_536);
}

function adjustBrightness(pixel: number, red: number, green: number, blue: number): number {
  const high = clampByte(Math.trunc(((pixel >>> 16) & 0xff) * red / 65_536));
  const middle = clampByte(Math.trunc(((pixel >>> 8) & 0xff) * green / 65_536));
  const low = clampByte(Math.trunc((pixel & 0xff) * blue / 65_536));
  return low | (middle << 8) | (high << 16);
}

function inRange(pixel: number, reference: number, distance: number): boolean {
  return Math.abs((pixel & 0xff) - (reference & 0xff)) <= distance
    && Math.abs(((pixel >>> 8) & 0xff) - ((reference >>> 8) & 0xff)) <= distance
    && Math.abs(((pixel >>> 16) & 0xff) - ((reference >>> 16) & 0xff)) <= distance;
}

/** Fade Out scratch LUTs, rebuilt on every call (shared; effects run one at a time). */
const FADE_LUT_LOW = new Int32Array(256);
const FADE_LUT_MIDDLE = new Int32Array(256);
const FADE_LUT_HIGH = new Int32Array(256);

function approach(value: number, target: number, fade: number): number {
  if (value <= target - fade) return (value + fade) & 0xff;
  if (value >= target + fade) return (value - fade) & 0xff;
  return target;
}

function averagePixel(a: number, b: number): number {
  return ((a >>> 1) & 0x007f7f7f) + ((b >>> 1) & 0x007f7f7f);
}

function add(a: number, b: number): number {
  return channels2(a, b, (x, y) => Math.min(255, x + y));
}

function channels2(a: number, b: number, fn: (a: number, b: number) => number): number {
  return (fn(a & 0xff, b & 0xff) & 0xff)
    | ((fn((a >>> 8) & 0xff, (b >>> 8) & 0xff) & 0xff) << 8)
    | ((fn((a >>> 16) & 0xff, (b >>> 16) & 0xff) & 0xff) << 16);
}

function channels4(
  a: number, b: number, c: number, d: number,
  fn: (a: number, b: number, c: number, d: number) => number,
): number {
  return (fn(a & 0xff, b & 0xff, c & 0xff, d & 0xff) & 0xff)
    | ((fn((a >>> 8) & 0xff, (b >>> 8) & 0xff, (c >>> 8) & 0xff, (d >>> 8) & 0xff) & 0xff) << 8)
    | ((fn((a >>> 16) & 0xff, (b >>> 16) & 0xff, (c >>> 16) & 0xff, (d >>> 16) & 0xff) & 0xff) << 16);
}

function int(ctx: AvsEffectContext, offset: number, fallback: number): number {
  if (offset + 4 > ctx.component.payload.length) return fallback;
  return new DataView(
    ctx.component.payload.buffer,
    ctx.component.payload.byteOffset,
    ctx.component.payload.byteLength,
  ).getInt32(offset, true);
}

function normalizeRandom(value: number, maximum: number): number {
  if (!Number.isFinite(value)) return 0;
  const integer = Math.trunc(value);
  return ((integer % maximum) + maximum) % maximum;
}

function clampByte(value: number): number { return value < 0 ? 0 : value > 255 ? 255 : value; }
