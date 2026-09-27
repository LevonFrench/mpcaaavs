import { AvsEffectRegistry, type AvsEffectContext } from '../executor.ts';
import { blendPixel } from '../framebuffer.ts';

const WINDOWS_1252 = new TextDecoder('windows-1252');
const CHOOSEFONT32_BYTES = 60;
const LOGFONTA_BYTES = 60;

export interface AvsTextFont {
  readonly height: number;
  readonly width: number;
  readonly weight: number;
  readonly italic: boolean;
  readonly underline: boolean;
  readonly strikeout: boolean;
  readonly face: string;
  readonly rawChooseFont: Uint8Array;
  readonly rawLogFont: Uint8Array;
}

export interface AvsTextConfig {
  readonly enabled: boolean;
  readonly color: number;
  readonly additive: boolean;
  readonly average: boolean;
  readonly onBeat: boolean;
  readonly insertBlank: boolean;
  readonly randomPosition: boolean;
  readonly verticalAlign: number;
  readonly horizontalAlign: number;
  readonly beatFrames: number;
  readonly normalFrames: number;
  readonly font: AvsTextFont;
  readonly text: string;
  readonly outline: boolean;
  readonly outlineColor: number;
  readonly horizontalShiftPercent: number;
  readonly verticalShiftPercent: number;
  readonly outlineSize: number;
  readonly randomWord: boolean;
  readonly shadow: boolean;
}

export interface AvsTextRasterRequest {
  readonly width: number;
  readonly height: number;
  readonly text: string;
  readonly color: number;
  readonly outline: boolean;
  readonly shadow: boolean;
  readonly outlineColor: number;
  readonly outlineSize: number;
  readonly horizontalAlign: number;
  readonly verticalAlign: number;
  readonly horizontalShiftPercent: number;
  readonly verticalShiftPercent: number;
  readonly font: AvsTextFont;
}

export interface AvsTextBitmap {
  readonly pixels: Uint32Array;
  readonly mask: Uint8Array;
  readonly textWidth: number;
  readonly textHeight: number;
}

export interface AvsTextOptions {
  readonly random?: () => number;
  readonly title?: () => string;
  readonly playbackPositionMs?: () => number;
  readonly playbackLengthMs?: () => number;
  readonly rasterize?: (request: AvsTextRasterRequest) => AvsTextBitmap;
}

interface TextState {
  currentWord: number;
  beatFrames: number;
  normalFrames: number;
  oddEven: number;
  horizontalAlign: number;
  verticalAlign: number;
  horizontalShift: number;
  verticalShift: number;
  randomState: number;
}

/** Decode the Win32 Text payload emitted by r_text.cpp. */
export function decodeAvsText(payload: Uint8Array): AvsTextConfig {
  let offset = 0;
  const read = (fallback: number): number => { const value = i32(payload, offset, fallback); offset += 4; return value; };
  const enabled = read(1) !== 0;
  const color = read(0x00ffffff) & 0x00ffffff;
  const additive = read(0) !== 0;
  const average = read(0) !== 0;
  const onBeat = read(0) !== 0;
  const insertBlank = read(0) !== 0;
  const randomPosition = read(0) !== 0;
  const verticalAlign = read(4);
  const horizontalAlign = read(1);
  const beatFrames = read(15);
  const normalFrames = read(15);
  const chooseFont = fixedBytes(payload, offset, CHOOSEFONT32_BYTES); offset += CHOOSEFONT32_BYTES;
  const logFont = fixedBytes(payload, offset, LOGFONTA_BYTES); offset += LOGFONTA_BYTES;
  const textLength = read(0);
  let text = '';
  if (textLength > 0 && offset + textLength <= payload.length) {
    text = nulText(payload.subarray(offset, offset + textLength)); offset += textLength;
  }
  return {
    enabled, color, additive, average, onBeat, insertBlank, randomPosition,
    verticalAlign, horizontalAlign, beatFrames, normalFrames,
    font: decodeFont(chooseFont, logFont), text,
    outline: read(0) !== 0,
    outlineColor: read(0) & 0x00ffffff,
    horizontalShiftPercent: read(0),
    verticalShiftPercent: read(0),
    outlineSize: read(1),
    randomWord: read(0) !== 0,
    shadow: read(0) !== 0,
  };
}

/** Register portable Render / Text compatibility (built-in ID 28). */
export function registerAvsText(
  registry: AvsEffectRegistry,
  options: AvsTextOptions = {},
): AvsEffectRegistry {
  const states = new Map<string, TextState>();
  const rasterize = options.rasterize ?? rasterizePortableText;
  registry.registerBuiltin(28, (context) => {
    const config = decodeAvsText(context.component.payload);
    if (!config.enabled || context.preinit) return;
    let state = states.get(context.component.path);
    if (!state) {
      state = {
        currentWord: 0, beatFrames: 0, normalFrames: 0, oddEven: 0,
        horizontalAlign: config.horizontalAlign, verticalAlign: config.verticalAlign,
        horizontalShift: config.horizontalShiftPercent, verticalShift: config.verticalShiftPercent,
        randomState: hashPath(context.component.path),
      };
      states.set(context.component.path, state);
    }

    const shouldAdvance = (!config.onBeat && state.normalFrames >= config.normalFrames)
      || (config.onBeat && context.beat && state.beatFrames === 0);
    const words = config.text.split(';');
    if (shouldAdvance) {
      if (!(config.insertBlank && state.oddEven % 2 === 0)) {
        state.currentWord = config.randomWord
          ? randomBound(state, options.random, words.length)
          : (state.currentWord + 1) % words.length;
      }
      state.oddEven = (state.oddEven + 1) % 2;
    }
    if (config.onBeat && context.beat && state.beatFrames === 0) state.beatFrames = config.beatFrames;

    let text = expandText(words[state.currentWord] ?? '', registry, options);
    if (config.insertBlank && state.oddEven === 0) text = '';
    if (shouldAdvance) {
      state.normalFrames = 0;
      if (config.randomPosition) {
        const measured = rasterize({
          ...request(config, context, text, 0, 0),
          horizontalAlign: 0, verticalAlign: 0,
        });
        state.horizontalAlign = 0; state.verticalAlign = 0;
        if (measured.textWidth < context.input.width) {
          const bound = Math.trunc((context.input.width - measured.textWidth) / context.input.width * 100);
          state.horizontalShift = randomBound(state, options.random, bound);
        }
        if (measured.textHeight < context.input.height) {
          const bound = Math.trunc((context.input.height - measured.textHeight) / context.input.height * 100);
          state.verticalShift = randomBound(state, options.random, bound);
        }
      } else {
        state.horizontalAlign = config.horizontalAlign; state.verticalAlign = config.verticalAlign;
        state.horizontalShift = config.horizontalShiftPercent; state.verticalShift = config.verticalShiftPercent;
      }
    }

    if (!(config.onBeat && state.beatFrames === 0)) {
      const bitmap = rasterize(request(
        config, context, text, state.horizontalShift, state.verticalShift,
        state.horizontalAlign, state.verticalAlign,
      ));
      if (bitmap.pixels.length !== context.input.pixels.length || bitmap.mask.length !== bitmap.pixels.length) {
        throw new RangeError('AVS Text rasterizer returned a bitmap with the wrong dimensions');
      }
      for (let i = 0; i < bitmap.pixels.length; i++) {
        if (!bitmap.mask[i]) continue;
        const rendered = bitmap.pixels[i]!;
        const original = context.input.pixels[i]!;
        context.input.pixels[i] = config.additive
          ? blendPixel(rendered, original, 'additive')
          : config.average ? blendPixel(rendered, original, 'average') : rendered;
      }
    }
    if (!config.onBeat) state.normalFrames++;
    if (config.onBeat && state.beatFrames) state.beatFrames--;
  });
  return registry;
}

function request(
  config: AvsTextConfig,
  context: AvsEffectContext,
  text: string,
  horizontalShiftPercent: number,
  verticalShiftPercent: number,
  horizontalAlign = config.horizontalAlign,
  verticalAlign = config.verticalAlign,
): AvsTextRasterRequest {
  return {
    width: context.input.width, height: context.input.height, text,
    color: config.color, outline: config.outline, shadow: config.shadow,
    outlineColor: config.outlineColor, outlineSize: config.outlineSize,
    horizontalAlign, verticalAlign, horizontalShiftPercent, verticalShiftPercent,
    font: config.font,
  };
}

function expandText(text: string, registry: AvsEffectRegistry, options: AvsTextOptions): string {
  return text.replace(/\$\(([^)]*)\)/gi, (whole, body: string) => {
    const lower = body.toLowerCase();
    if (lower.startsWith('playpos')) return formatTime(options.playbackPositionMs?.() ?? 0, lower);
    if (lower.startsWith('playlen')) return formatTime(options.playbackLengthMs?.() ?? 0, lower);
    if (lower.startsWith('title')) {
      let title = (options.title?.() ?? '').replace(/\s*- Winamp\s*$/i, '');
      const specification = lower.slice(5);
      const noNumber = specification.startsWith(':n');
      if (!noNumber) title = title.replace(/^\d+\.\s+/, '');
      const maximum = Number.parseInt(specification.replace(/^:n?/, ''), 10);
      return maximum > 0 ? title.slice(0, maximum) : title;
    }
    const register = /^reg(\d\d)(?::([0-9]*)(?:\.([0-9]+))?)?$/.exec(lower);
    if (register) {
      const value = registry.eelGlobal.registers[Number(register[1])] ?? 0;
      const precision = register[3] === undefined ? 6 : Number(register[3]);
      const formatted = value.toFixed(precision);
      const width = Number(register[2] ?? 0);
      return width > formatted.length ? formatted.padStart(width) : formatted;
    }
    return whole;
  }).slice(0, 255);
}

function formatTime(milliseconds: number, specification: string): string {
  const digits = clamp(Number.parseInt(specification.split('.')[1] ?? '0', 10) || 0, 0, 3);
  const value = Math.max(0, Math.trunc(milliseconds));
  const base = `${Math.trunc(value / 60_000)}:${String(Math.trunc(value / 1_000) % 60).padStart(2, '0')}`;
  return digits ? `${base}.${String(value % 1_000).padStart(3, '0').slice(0, digits)}` : base;
}

/** Small deterministic bitmap font; GDI can be supplied through the rasterizer hook. */
function rasterizePortableText(request: AvsTextRasterRequest): AvsTextBitmap {
  const pixels = new Uint32Array(request.width * request.height);
  const mask = new Uint8Array(pixels.length);
  const scale = Math.max(1, Math.trunc(Math.abs(request.font.height || 7) / 7));
  const glyphWidth = 6 * scale;
  const textWidth = Math.max(0, request.text.length * glyphWidth - scale);
  const textHeight = 7 * scale;
  let left = request.horizontalAlign === 2 ? request.width - textWidth
    : request.horizontalAlign === 1 ? Math.trunc((request.width - textWidth) / 2) : 0;
  let top = (request.verticalAlign & 8) !== 0 ? request.height - textHeight
    : (request.verticalAlign & 4) !== 0 ? Math.trunc((request.height - textHeight) / 2) : 0;
  left += Math.trunc(request.horizontalShiftPercent * request.width / 100);
  top += Math.trunc(request.verticalShiftPercent * request.height / 100);

  const foreground = new Uint8Array(pixels.length);
  for (let index = 0; index < request.text.length; index++) {
    const glyph = glyphFor(request.text[index]!);
    for (let row = 0; row < 7; row++) for (let column = 0; column < 5; column++) {
      if (((glyph[row]! >>> (4 - column)) & 1) === 0) continue;
      fillMask(foreground, request.width, request.height,
        left + index * glyphWidth + column * scale, top + row * scale, scale);
    }
  }
  const outlineMask = new Uint8Array(pixels.length);
  if (request.outline || request.shadow) {
    const radius = Math.max(1, Math.abs(Math.trunc(request.outlineSize)));
    for (let y = 0; y < request.height; y++) for (let x = 0; x < request.width; x++) {
      if (!foreground[x + y * request.width]) continue;
      if (request.shadow) stamp(outlineMask, request.width, request.height, x + radius, y + radius, 0);
      else for (let dy = -radius; dy <= radius; dy++) for (let dx = -radius; dx <= radius; dx++) {
        if (dx || dy) stamp(outlineMask, request.width, request.height, x + dx, y + dy, 0);
      }
    }
  }
  for (let i = 0; i < pixels.length; i++) {
    if (outlineMask[i]) { pixels[i] = request.outlineColor; mask[i] = 1; }
    if (foreground[i]) { pixels[i] = request.color; mask[i] = 1; }
  }
  return { pixels, mask, textWidth, textHeight };
}

function fillMask(mask: Uint8Array, width: number, height: number, x: number, y: number, size: number): void {
  for (let dy = 0; dy < size; dy++) for (let dx = 0; dx < size; dx++) stamp(mask, width, height, x + dx, y + dy, 1);
}
function stamp(mask: Uint8Array, width: number, height: number, x: number, y: number, value: number): void {
  if (x >= 0 && y >= 0 && x < width && y < height) mask[x + y * width] = value || 1;
}

function glyphFor(character: string): readonly number[] {
  const glyph = GLYPHS[character.toUpperCase()];
  if (glyph) return glyph;
  const code = character.charCodeAt(0);
  return [31, 17, (code >>> 0) & 31, (code >>> 2) & 31, (code >>> 4) & 31, 17, 31];
}

const GLYPHS: Readonly<Record<string, readonly number[]>> = {
  ' ': [0, 0, 0, 0, 0, 0, 0], '!': [4, 4, 4, 4, 4, 0, 4], '-': [0, 0, 0, 31, 0, 0, 0],
  '.': [0, 0, 0, 0, 0, 6, 6], ':': [0, 6, 6, 0, 6, 6, 0],
  '0': [14, 17, 19, 21, 25, 17, 14], '1': [4, 12, 4, 4, 4, 4, 14],
  '2': [14, 17, 1, 2, 4, 8, 31], '3': [30, 1, 1, 14, 1, 1, 30],
  '4': [2, 6, 10, 18, 31, 2, 2], '5': [31, 16, 16, 30, 1, 1, 30],
  '6': [14, 16, 16, 30, 17, 17, 14], '7': [31, 1, 2, 4, 8, 8, 8],
  '8': [14, 17, 17, 14, 17, 17, 14], '9': [14, 17, 17, 15, 1, 1, 14],
  A: [14, 17, 17, 31, 17, 17, 17], B: [30, 17, 17, 30, 17, 17, 30],
  C: [14, 17, 16, 16, 16, 17, 14], D: [30, 17, 17, 17, 17, 17, 30],
  E: [31, 16, 16, 30, 16, 16, 31], F: [31, 16, 16, 30, 16, 16, 16],
  G: [14, 17, 16, 23, 17, 17, 15], H: [17, 17, 17, 31, 17, 17, 17],
  I: [14, 4, 4, 4, 4, 4, 14], J: [7, 2, 2, 2, 18, 18, 12],
  K: [17, 18, 20, 24, 20, 18, 17], L: [16, 16, 16, 16, 16, 16, 31],
  M: [17, 27, 21, 21, 17, 17, 17], N: [17, 25, 21, 19, 17, 17, 17],
  O: [14, 17, 17, 17, 17, 17, 14], P: [30, 17, 17, 30, 16, 16, 16],
  Q: [14, 17, 17, 17, 21, 18, 13], R: [30, 17, 17, 30, 20, 18, 17],
  S: [15, 16, 16, 14, 1, 1, 30], T: [31, 4, 4, 4, 4, 4, 4],
  U: [17, 17, 17, 17, 17, 17, 14], V: [17, 17, 17, 17, 17, 10, 4],
  W: [17, 17, 17, 21, 21, 21, 10], X: [17, 17, 10, 4, 10, 17, 17],
  Y: [17, 17, 10, 4, 4, 4, 4], Z: [31, 1, 2, 4, 8, 16, 31],
};

function decodeFont(chooseFont: Uint8Array, logFont: Uint8Array): AvsTextFont {
  return {
    height: i32(logFont, 0, 0), width: i32(logFont, 4, 0), weight: i32(logFont, 16, 0),
    italic: logFont[20] !== 0, underline: logFont[21] !== 0, strikeout: logFont[22] !== 0,
    face: nulText(logFont.subarray(28, 60)), rawChooseFont: chooseFont, rawLogFont: logFont,
  };
}
function fixedBytes(payload: Uint8Array, offset: number, length: number): Uint8Array {
  const bytes = new Uint8Array(length);
  bytes.set(payload.subarray(offset, Math.min(payload.length, offset + length)));
  return bytes;
}
function randomBound(state: TextState, hook: (() => number) | undefined, bound: number): number {
  if (bound <= 0) return 0;
  const value = hook ? Math.trunc(hook()) >>> 0 : nextRandom(state);
  return value % bound;
}
function nextRandom(state: TextState): number {
  let value = state.randomState || 0x6d2b79f5;
  value ^= value << 13; value ^= value >>> 17; value ^= value << 5;
  state.randomState = value >>> 0;
  return state.randomState;
}
function i32(payload: Uint8Array, offset: number, fallback: number): number {
  return offset + 4 <= payload.length
    ? new DataView(payload.buffer, payload.byteOffset, payload.byteLength).getInt32(offset, true)
    : fallback;
}
function nulText(bytes: Uint8Array): string {
  const end = bytes.indexOf(0);
  return WINDOWS_1252.decode(end < 0 ? bytes : bytes.subarray(0, end));
}
function clamp(value: number, minimum: number, maximum: number): number {
  return value < minimum ? minimum : value > maximum ? maximum : value;
}
function hashPath(path: string): number {
  let hash = 0x811c9dc5;
  for (let i = 0; i < path.length; i++) hash = Math.imul(hash ^ path.charCodeAt(i), 0x01000193);
  return hash >>> 0;
}
