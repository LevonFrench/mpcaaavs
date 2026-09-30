// HUD as meters (Task 5, item 6; docs/design/SPRITE-SHOW-KIT.md "HUD as meters"). The HUD never shows game state: bars read band energy
// (with the ghost trail a game draws when a bar drains), segmented meters read an energy trend and flash MAX when full, counters count onsets,
// timers count bars or beats left in the section, banners punctuate musical events. Every primitive returns sprite draws in native pixels and
// is a pure function of its inputs (and of t for the signals), so a seek lands on the same HUD.
import type { AssetPack } from '../../asset-packs/pack.ts';
import { glyphAdvance, glyphRect } from '../../asset-packs/pack.ts';
import type { BlendMode } from '../../asset-packs/manifest.ts';
import type { SpriteDraw } from './perform.ts';

/** The sprite layer's built-in 1x1 white atlas, used for solid rectangles. */
export const SOLID_ATLAS = '$solid';
export type RGB = readonly [number, number, number];

const toLinear = (c: number) => (c <= 0.04045 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4);
/** `#rrggbb` to a linear RGB multiplier, optionally scaled above 1 for bloom. */
export function lin(hex: string, gain = 1): RGB {
  const n = (i: number) => toLinear(parseInt(hex.slice(i, i + 2), 16) / 255) * gain;
  return [n(1), n(3), n(5)];
}
export const mix3 = (a: RGB, b: RGB, k: number): RGB => [a[0] + (b[0] - a[0]) * k, a[1] + (b[1] - a[1]) * k, a[2] + (b[2] - a[2]) * k];
const clamp01 = (x: number) => (x < 0 ? 0 : x > 1 ? 1 : x);

export function solid(x: number, y: number, w: number, h: number, tint: RGB, z: number, alpha = 1, blend: BlendMode = 'normal'): SpriteDraw {
  return { atlas: SOLID_ATLAS, rect: [0, 0, 1, 1], x: Math.round(x), y: Math.round(y), w: Math.round(w), h: Math.round(h), tint, alpha, blend, z };
}

/** Nine-slice box from a pack region (hud, text or screen role with `nineSlice`); a plain solid box when the region is missing. */
export function box(pack: AssetPack, regionId: string, x: number, y: number, w: number, h: number, z: number, tint?: RGB, alpha = 1): SpriteDraw[] {
  const r = pack.region(regionId);
  const ns = r && (r.role === 'hud' || r.role === 'text' || r.role === 'screen') ? r.nineSlice : undefined;
  if (!r || !ns) return [solid(x, y, w, h, tint ?? [0.02, 0.03, 0.08], z, alpha * 0.85)];
  const [rx, ry, rw, rh] = r.rect, { left: L, top: T, right: R, bottom: B } = ns;
  const xs = [0, L, rw - R, rw], ys = [0, T, rh - B, rh], dx = [0, L, w - R, w], dy = [0, T, h - B, h];
  const out: SpriteDraw[] = [];
  for (let j = 0; j < 3; j++) for (let i = 0; i < 3; i++) {
    const sw = xs[i + 1]! - xs[i]!, sh = ys[j + 1]! - ys[j]!, tw = dx[i + 1]! - dx[i]!, th = dy[j + 1]! - dy[j]!;
    if (sw <= 0 || sh <= 0 || tw <= 0 || th <= 0) continue;
    out.push({ atlas: r.atlas, rect: [rx + xs[i]!, ry + ys[j]!, sw, sh], x: Math.round(x + dx[i]!), y: Math.round(y + dy[j]!), w: tw, h: th, tint, alpha, palette: r.palette, z });
  }
  return out;
}

export interface TextOptions { readonly scale?: number; readonly tint?: RGB; readonly alpha?: number; readonly align?: 'left' | 'center' | 'right'; readonly z?: number; readonly blend?: BlendMode; readonly spacing?: number }

/** Width in px of `text` in a pack font at an integer scale. */
export function textWidth(pack: AssetPack, fontId: string, text: string, scale = 1, spacing = 0): number {
  const font = pack.font(fontId);
  if (!font) return 0;
  let w = 0;
  for (const ch of Array.from(text)) w += ((glyphAdvance(font, ch) ?? font.advance[0] ?? font.cell[0]) + spacing) * scale;
  return Math.max(0, w - spacing * scale);
}

/** Glyph sprites of a string from a pack font grid (hud digits, caption letters). Characters the font lacks advance blank. */
export function text(pack: AssetPack, fontId: string, str: string, x: number, y: number, o: TextOptions = {}): SpriteDraw[] {
  const font = pack.font(fontId);
  if (!font) return [];
  const s = Math.max(1, Math.round(o.scale ?? 1)), sp = o.spacing ?? 0;
  const w = textWidth(pack, fontId, str, s, sp);
  let cx = Math.round(o.align === 'center' ? x - w / 2 : o.align === 'right' ? x - w : x);
  const out: SpriteDraw[] = [];
  for (const ch of Array.from(str)) {
    const rect = glyphRect(font, ch);
    if (rect && ch !== ' ') out.push({ atlas: font.atlas, rect, x: cx, y: Math.round(y), scale: s, tint: o.tint, alpha: o.alpha, palette: font.palette, z: o.z ?? 1000, blend: o.blend });
    cx += ((glyphAdvance(font, ch) ?? font.advance[0] ?? font.cell[0]) + sp) * s;
  }
  return out;
}

/** Digits of a count, zero-padded to `digits` places (a counter that never shows more than it can: it saturates at 10^digits - 1). */
export function counterText(n: number, digits: number): string {
  const max = 10 ** digits - 1;
  return String(Math.max(0, Math.min(max, Math.floor(Number.isFinite(n) ? n : 0)))).padStart(digits, '0');
}
/** Timer text MM:SS from seconds, clamped at 99:59. */
export function timerText(seconds: number): string {
  const s = Math.max(0, Math.min(99 * 60 + 59, Math.floor(Number.isFinite(seconds) ? seconds : 0)));
  return `${String(Math.floor(s / 60)).padStart(2, '0')}:${String(s % 60).padStart(2, '0')}`;
}

// ------------------------------------------------------------------------------------------------ ghost drain
export interface GhostOptions {
  /** Level units per second the ghost drains at (after the hold). Default 0.7. */
  readonly rate?: number;
  /** Seconds the ghost stays before draining. Default 0.22. */
  readonly hold?: number;
  /** Samples of history (spacing 1/30 s). Default 30. */
  readonly samples?: number;
}
/** The bar's level and its ghost at t. The ghost is the highest recent level minus a drain: it stays where the bar was, then falls. A pure
 * function of `level`, never of earlier frames. */
export function ghostLevel(level: (t: number) => number, t: number, o: GhostOptions = {}): { value: number; ghost: number } {
  const rate = o.rate ?? 0.7, hold = o.hold ?? 0.22, n = o.samples ?? 30, value = clamp01(level(t));
  let ghost = value;
  for (let k = 1; k <= n; k++) { const age = k / 30, v = clamp01(level(t - age)) - Math.max(0, age - hold) * rate; if (v > ghost) ghost = v; }
  return { value, ghost };
}

export interface BarStyle {
  readonly fill: RGB;
  readonly ghost: RGB;
  readonly back?: RGB;
  /** Fill in steps of this many px (segment pitch); 0/undefined = smooth. */
  readonly pitch?: number;
  /** Nine-slice frame region from the pack (drawn behind and around the fill). */
  readonly frame?: string;
  readonly z?: number;
  /** Fill from the right (a mirrored player-two bar). */
  readonly rtl?: boolean;
}
/** A bar with a ghost trail in a (w x h) box: frame, back, ghost (the drained part), fill. */
export function ghostBar(pack: AssetPack, x: number, y: number, w: number, h: number, value: number, ghost: number, s: BarStyle): SpriteDraw[] {
  const z = s.z ?? 900, out: SpriteDraw[] = [];
  if (s.frame) out.push(...box(pack, s.frame, x, y, w, h, z));
  const ix = x + 2, iy = y + 2, iw = w - 4, ih = h - 4;
  out.push(solid(ix, iy, iw, ih, s.back ?? [0.01, 0.012, 0.03], z + 0.1));
  const px = (v: number) => { const raw = clamp01(v) * iw; return Math.round(s.pitch ? Math.floor(raw / s.pitch) * s.pitch : raw); };
  const gw = px(Math.max(value, ghost)), fw = px(value);
  const rect = (a: number, b: number, col: RGB, dz: number) => { if (b > a) out.push(solid(s.rtl ? ix + iw - b : ix + a, iy, b - a, ih, col, z + dz)); };
  rect(fw, gw, s.ghost, 0.2);
  rect(0, fw, s.fill, 0.3);
  if (s.pitch) for (let sx = s.pitch; sx < iw; sx += s.pitch) out.push(solid(s.rtl ? ix + iw - sx : ix + sx - 1, iy, 1, ih, [0.005, 0.006, 0.015], z + 0.4));
  return out;
}

// ------------------------------------------------------------------------------------------------ segmented meter with MAX flash
/** Segments lit for a level 0..1 (rounded; a level below half a segment lights none). */
export const litSegments = (level: number, segments: number): number => Math.max(0, Math.min(segments, Math.round(clamp01(level) * segments)));
/** True while a full meter flashes MAX: from 98 % full, blinking four times per bar's beat (a pure function of the beat). */
export const isMaxFlash = (level: number, beat: number): boolean => level >= 0.98 && Math.floor(beat * 4) % 2 === 0;

export interface SegStyle { readonly low: RGB; readonly high: RGB; readonly off?: RGB; readonly segW?: number; readonly gap?: number; readonly frame?: string; readonly z?: number; readonly label?: { font: string; tint: RGB } }
/** A row of segments, colours ramping low to high; at MAX the lit segments flash bright and a MAX caption blinks above. */
export function segmentedMeter(pack: AssetPack, x: number, y: number, n: number, h: number, level: number, beat: number, s: SegStyle): SpriteDraw[] {
  const z = s.z ?? 900, sw = s.segW ?? 6, gap = s.gap ?? 1, out: SpriteDraw[] = [];
  const w = n * (sw + gap) + gap + 2;
  if (s.frame) out.push(...box(pack, s.frame, x - 2, y - 2, w + 2, h + 4, z));
  const lit = litSegments(level, n), flash = isMaxFlash(level, beat);
  for (let i = 0; i < n; i++) {
    const k = n > 1 ? i / (n - 1) : 1, on = i < lit;
    const col = on ? mix3(s.low, s.high, k) : s.off ?? [0.012, 0.014, 0.03];
    out.push(solid(x + 1 + i * (sw + gap), y, sw, h, flash && on ? [col[0] * 2.2 + 0.25, col[1] * 2.2 + 0.25, col[2] * 2.2 + 0.25] : col, z + 0.2));
  }
  if (flash && s.label) out.push(...text(pack, s.label.font, 'MAX', x + w / 2, y - 11, { align: 'center', tint: s.label.tint, z: z + 0.5 }));
  return out;
}

/** A banner: a plate with centred text that slides in over its first beat-quarter and out at the end. */
export function banner(pack: AssetPack, str: string, cx: number, cy: number, age: number, left: number, o: { font: string; scale: number; tint: RGB; region?: string; z?: number }): SpriteDraw[] {
  const s = Math.max(1, Math.round(o.scale)), w = textWidth(pack, o.font, str, s) + 14 * s, h = 10 * s + 6;
  const slide = Math.min(clamp01(age / 0.12), clamp01(left / 0.12)), ease = 1 - (1 - slide) ** 3;
  const x = Math.round(cx - w / 2), y = Math.round(cy - h / 2 - (1 - ease) * 40);
  return [...box(pack, o.region ?? 'banner', x, y, w, h, o.z ?? 1100), ...text(pack, o.font, str, cx, y + Math.round((h - 7 * s) / 2), { scale: s, align: 'center', tint: o.tint, z: (o.z ?? 1100) + 0.5 })];
}

// ------------------------------------------------------------------------------------------------ musical signals
/** Number of onsets of a kind in [t0, t]: a counter that only ever counts up with the song, exactly reproducible after a seek. */
export function countOnsets(onsets: Readonly<Record<string, readonly (readonly [number, number])[]>>, kind: string, t0: number, t: number): number {
  const list = onsets[kind];
  if (!list) return 0;
  const idx = (x: number) => { let lo = 0, hi = list.length; while (lo < hi) { const m = (lo + hi) >> 1; if (list[m]![0] <= x) lo = m + 1; else hi = m; } return lo; };
  return Math.max(0, idx(t) - idx(t0 - 1e-9));
}
