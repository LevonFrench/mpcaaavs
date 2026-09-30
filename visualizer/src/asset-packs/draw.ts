/** Drawing and procedural stand-ins for asset-pack sprites.
 *
 * A show plate never branches on "is the pack installed". It declares a `SpriteSlot` (the region id it would like, the role it
 * expects and a design size) and calls `drawSprite(ctx, pack, slot, x, y, ...)` with the pack or `null`. With a loaded pack that has
 * a region of that id and role (and a decoded atlas) the real art is drawn; in every other case (no pack, invalid pack, unknown
 * region, wrong role, metadata-only pack) a procedural stand-in of the same size, anchor and timing is drawn from plain shapes.
 * The stand-in is a pure function of (slot, time, seed): no wall clock, no randomness, no game art.
 *
 * `time` is always in source frames since the clip or effect started, so stand-in and real art share one timeline. */
import type { AssetRole, ClipVerb, Point, Rect, Region } from './manifest.ts';
import { AssetPack, clipFrameIndex, glyphAdvance, glyphRect, type AtlasImage } from './pack.ts';

/** The subset of a 2D canvas context these helpers use (CanvasRenderingContext2D and OffscreenCanvasRenderingContext2D both fit). */
export type SpriteContext = Pick<CanvasRenderingContext2D,
  'globalAlpha' | 'globalCompositeOperation' | 'imageSmoothingEnabled' | 'fillStyle' | 'strokeStyle' | 'lineWidth'
  | 'save' | 'restore' | 'translate' | 'scale' | 'rotate' | 'beginPath' | 'moveTo' | 'lineTo' | 'closePath' | 'arc' | 'fillRect' | 'strokeRect' | 'fill' | 'stroke' | 'drawImage'>;

/** What a plate needs from a pack. `size` is the design size in pixels used by the stand-in and as the default draw size. */
export interface SpriteSlot {
  readonly region: string;
  readonly role: AssetRole;
  readonly size: readonly [width: number, height: number];
  /** Stand-in colour, #rrggbb. */
  readonly tone?: string;
  /** Anchor inside `size` for the stand-in; defaults follow the role (feet for actor, prop, pickup; centre for projectile, effect). */
  readonly anchor?: Point;
}
export interface DrawOptions {
  /** Uniform scale applied to the sprite, default 1. */
  readonly scale?: number;
  /** Mirror horizontally around the anchor. */
  readonly flip?: boolean;
  readonly alpha?: number;
  /** Source frames since the animation started (default 0). Loops wrap, one-shots hold their last frame. */
  readonly time?: number;
  /** Actor animation verb (default `idle`). */
  readonly verb?: ClipVerb;
  /** Target size for stretchable parts (hud, text, screen, background, nine-slice boxes), in unscaled pixels. */
  readonly width?: number;
  readonly height?: number;
  /** Meter level 0..1 for `hud` bars. */
  readonly fill?: number;
}
export type SpriteSource = 'pack' | 'stand-in';

const clamp01 = (v: number): number => (v > 0 ? (v < 1 ? v : 1) : 0);
const finite = (v: number | undefined, fallback: number): number => (v !== undefined && Number.isFinite(v) ? v : fallback);

/** FNV-1a over a string: the stable per-slot seed of the stand-ins. */
export function hashString(text: string): number {
  let h = 0x811c9dc5;
  for (let i = 0; i < text.length; i++) { h ^= text.charCodeAt(i); h = Math.imul(h, 0x01000193); }
  return h >>> 0;
}
const parseTone = (tone: string | undefined, seed: number): [number, number, number] => {
  if (tone !== undefined && /^#[0-9a-fA-F]{6}$/.test(tone)) return [parseInt(tone.slice(1, 3), 16), parseInt(tone.slice(3, 5), 16), parseInt(tone.slice(5, 7), 16)];
  const h = (seed % 360) / 60, x = Math.round(255 * (1 - Math.abs((h % 2) - 1))), q = 200;
  const table: Array<[number, number, number]> = [[q, x, 60], [x, q, 60], [60, q, x], [60, x, q], [x, 60, q], [q, 60, x]];
  return table[Math.floor(h) % 6]!;
};
const shade = (rgb: readonly [number, number, number], k: number, alpha = 1): string =>
  `rgba(${Math.max(0, Math.min(255, Math.round(rgb[0] * k)))},${Math.max(0, Math.min(255, Math.round(rgb[1] * k)))},${Math.max(0, Math.min(255, Math.round(rgb[2] * k)))},${alpha})`;

const defaultAnchor = (role: AssetRole, w: number, h: number): Point =>
  role === 'actor' || role === 'prop' || role === 'pickup' ? [w >> 1, h] : role === 'projectile' || role === 'effect' ? [w >> 1, h >> 1] : [0, 0];

/** Which path `drawSprite` will take for this slot: the real region when the pack can supply it, else the stand-in. */
export function spriteSource(pack: AssetPack | null, slot: SpriteSlot): SpriteSource {
  const region = pack?.regionOf(slot.region, slot.role as never) as Region | undefined;
  return region && pack!.image(region.atlas) ? 'pack' : 'stand-in';
}

/** Draws `slot` with its anchor at (x, y). Returns which path drew it. Never throws for a missing or partial pack. */
export function drawSprite(ctx: SpriteContext, pack: AssetPack | null, slot: SpriteSlot, x: number, y: number, options: DrawOptions = {}): SpriteSource {
  const scale = finite(options.scale, 1), time = finite(options.time, 0), alpha = clamp01(finite(options.alpha, 1));
  const region = pack?.regionOf(slot.region, slot.role as never) as Region | undefined;
  const image = region ? pack!.image(region.atlas) : null;
  ctx.save();
  ctx.globalAlpha *= alpha;
  ctx.translate(x, y);
  if (options.flip) ctx.scale(-1, 1);
  ctx.scale(scale, scale);
  let source: SpriteSource;
  if (region && image && pack && drawRegion(ctx, pack, region, slot, image, options, time)) source = 'pack';
  else { drawStandIn(ctx, slot, options, time); source = 'stand-in'; }
  ctx.restore();
  return source;
}

const STRETCHY: readonly AssetRole[] = ['hud', 'text', 'screen', 'background', 'transition'];

/** Real art, in a context already translated to the anchor and scaled. False when nothing drawable was found. */
function drawRegion(ctx: SpriteContext, pack: AssetPack, region: Region, slot: SpriteSlot, image: AtlasImage, options: DrawOptions, time: number): boolean {
  const atlas = pack.atlas(region.atlas);
  ctx.imageSmoothingEnabled = atlas?.filter === 'linear';
  const img = image as unknown as CanvasImageSource;
  let clipId: string | undefined;
  if (region.role === 'actor') clipId = pack.actorClip(slot.region, options.verb ?? 'idle')?.id;
  else if ('clip' in region && region.clip !== undefined) clipId = region.clip;
  else if (region.role === 'pickup' || region.role === 'prop') clipId = region.idle;
  else if (region.role === 'background') clipId = region.tiles;
  const frames = clipId === undefined ? undefined : pack.clipFrames(clipId);
  if (frames && frames.length > 0) {
    const clip = pack.clip(clipId!)!;
    const frame = frames[clipFrameIndex(clip.hold, clip.loop, time)]!;
    const frameImage = pack.image(frame.atlas);
    if (!frameImage) return false;
    const [fx, fy, fw, fh] = frame.rect;
    ctx.drawImage(frameImage as unknown as CanvasImageSource, fx, fy, fw, fh, -frame.anchor[0], -frame.anchor[1], fw, fh);
    return true;
  }
  const [rx, ry, rw, rh] = region.rect;
  const stretch = STRETCHY.includes(region.role);
  const w = stretch ? finite(options.width, rw) : rw, h = stretch ? finite(options.height, rh) : rh;
  const ax = region.anchor[0] * (w / rw), ay = region.anchor[1] * (h / rh);
  if (region.nineSlice && (w !== rw || h !== rh)) { drawNineSlice(ctx, img, region.rect, region.nineSlice, -ax, -ay, w, h); return true; }
  if (region.role === 'hud' && region.part === 'bar' && options.fill !== undefined) {
    // A meter: the region is the full bar; show the filled fraction from the side the manifest names.
    const f = clamp01(options.fill), dir = region.fill ?? 'left-to-right';
    if (dir === 'left-to-right') ctx.drawImage(img, rx, ry, Math.max(1, Math.round(rw * f)), rh, -ax, -ay, Math.max(1, Math.round(rw * f)) * (w / rw), h);
    else if (dir === 'right-to-left') { const sw = Math.max(1, Math.round(rw * f)); ctx.drawImage(img, rx + rw - sw, ry, sw, rh, -ax + (rw - sw) * (w / rw), -ay, sw * (w / rw), h); }
    else if (dir === 'bottom-to-top') { const sh = Math.max(1, Math.round(rh * f)); ctx.drawImage(img, rx, ry + rh - sh, rw, sh, -ax, -ay + (rh - sh) * (h / rh), w, sh * (h / rh)); }
    else { const sh = Math.max(1, Math.round(rh * f)); ctx.drawImage(img, rx, ry, rw, sh, -ax, -ay, w, sh * (h / rh)); }
    return true;
  }
  ctx.drawImage(img, rx, ry, rw, rh, -ax, -ay, w, h);
  return true;
}

/** Nine-slice blit of `rect` (atlas pixels) into a w x h box at (dx, dy). Corners keep their size; edges and centre stretch. */
export function drawNineSlice(ctx: SpriteContext, image: CanvasImageSource, rect: Rect, slice: { left: number; top: number; right: number; bottom: number }, dx: number, dy: number, w: number, h: number): void {
  const [sx, sy, sw, sh] = rect;
  const l = Math.min(slice.left, w / 2), r = Math.min(slice.right, w / 2), t = Math.min(slice.top, h / 2), b = Math.min(slice.bottom, h / 2);
  const xs = [sx, sx + slice.left, sx + sw - slice.right, sx + sw], ys = [sy, sy + slice.top, sy + sh - slice.bottom, sy + sh];
  const dxs = [dx, dx + l, dx + w - r, dx + w], dys = [dy, dy + t, dy + h - b, dy + h];
  for (let j = 0; j < 3; j++) for (let i = 0; i < 3; i++) {
    const cw = xs[i + 1]! - xs[i]!, ch = ys[j + 1]! - ys[j]!, tw = dxs[i + 1]! - dxs[i]!, th = dys[j + 1]! - dys[j]!;
    if (cw > 0 && ch > 0 && tw > 0 && th > 0) ctx.drawImage(image, xs[i]!, ys[j]!, cw, ch, dxs[i]!, dys[j]!, tw, th);
  }
}

/** The procedural stand-in for a slot, anchor at the context origin. Exported for plates that never had a region id to look up. */
export function drawStandIn(ctx: SpriteContext, slot: SpriteSlot, options: DrawOptions = {}, time = 0): void {
  const seed = hashString(`${slot.role}:${slot.region}`), rgb = parseTone(slot.tone, seed);
  const stretch = STRETCHY.includes(slot.role);
  const w = Math.max(1, stretch ? finite(options.width, slot.size[0]) : slot.size[0]), h = Math.max(1, stretch ? finite(options.height, slot.size[1]) : slot.size[1]);
  const a = slot.anchor ?? defaultAnchor(slot.role, slot.size[0], slot.size[1]);
  const ax = stretch ? a[0] * (w / slot.size[0]) : a[0], ay = stretch ? a[1] * (h / slot.size[1]) : a[1];
  ctx.translate(-ax, -ay);
  ctx.imageSmoothingEnabled = false;
  const f = Math.max(0, time), beat = f / 24, fill = shade(rgb, 1), dark = shade(rgb, 0.45), light = shade(rgb, 1.35);
  switch (slot.role) {
    case 'actor': {
      const bob = Math.round(Math.sin(beat * Math.PI * 2) * h * 0.02), head = Math.min(w, h) * 0.22, bodyTop = h * 0.3 + bob;
      ctx.fillStyle = dark; ctx.fillRect(w * 0.22, bodyTop, w * 0.56, h * 0.64 - bob);
      ctx.fillStyle = fill; ctx.fillRect(w * 0.28, bodyTop + h * 0.04, w * 0.44, h * 0.3);
      ctx.beginPath(); ctx.arc(w / 2, bodyTop - head * 0.4, head, 0, Math.PI * 2); ctx.closePath(); ctx.fillStyle = light; ctx.fill();
      ctx.fillStyle = dark; ctx.fillRect(w * 0.6, bodyTop - head * 0.55, head * 0.35, head * 0.35);   // facing mark
      break;
    }
    case 'projectile': {
      ctx.translate(w / 2, h / 2); ctx.rotate(beat * Math.PI * 4);
      ctx.beginPath(); ctx.moveTo(0, -h / 2); ctx.lineTo(w / 2, 0); ctx.lineTo(0, h / 2); ctx.lineTo(-w / 2, 0); ctx.closePath(); ctx.fillStyle = fill; ctx.fill();
      ctx.strokeStyle = light; ctx.lineWidth = Math.max(1, Math.min(w, h) * 0.08); ctx.stroke();
      break;
    }
    case 'effect': {
      const life = clamp01(f / 12);
      ctx.globalCompositeOperation = 'lighter';
      ctx.translate(w / 2, h / 2);
      const spokes = 8, outer = Math.min(w, h) * (0.2 + 0.3 * life), inner = outer * 0.35;
      ctx.beginPath();
      for (let i = 0; i < spokes * 2; i++) { const r = i % 2 === 0 ? outer : inner, ang = (i / (spokes * 2)) * Math.PI * 2 + life; if (i === 0) ctx.moveTo(Math.cos(ang) * r, Math.sin(ang) * r); else ctx.lineTo(Math.cos(ang) * r, Math.sin(ang) * r); }
      ctx.closePath(); ctx.globalAlpha *= 1 - life * 0.8; ctx.fillStyle = fill; ctx.fill();
      break;
    }
    case 'pickup': {
      const bob = Math.sin(beat * Math.PI * 2) * h * 0.06;
      ctx.translate(w / 2, h / 2 + bob);
      ctx.beginPath(); ctx.moveTo(0, -h * 0.4); ctx.lineTo(w * 0.35, 0); ctx.lineTo(0, h * 0.4); ctx.lineTo(-w * 0.35, 0); ctx.closePath();
      ctx.fillStyle = fill; ctx.fill(); ctx.strokeStyle = light; ctx.lineWidth = Math.max(1, w * 0.06); ctx.stroke();
      break;
    }
    case 'prop': {
      ctx.fillStyle = dark; ctx.fillRect(w * 0.1, h * 0.25, w * 0.8, h * 0.75);
      ctx.fillStyle = fill; ctx.fillRect(w * 0.16, h * 0.31, w * 0.68, h * 0.14);
      ctx.strokeStyle = light; ctx.lineWidth = Math.max(1, w * 0.04); ctx.strokeRect(w * 0.1, h * 0.25, w * 0.8, h * 0.75);
      break;
    }
    case 'background': {
      const bands = 6, scroll = (f * 0.5) % w;
      for (let i = 0; i < bands; i++) { ctx.fillStyle = shade(rgb, 0.25 + (i / bands) * 0.5); ctx.fillRect(0, (h * i) / bands, w, h / bands + 1); }
      ctx.fillStyle = shade(rgb, 0.9, 0.35);
      for (let i = -1; i < 4; i++) ctx.fillRect(((i * w) / 3 - scroll + w) % w, h * 0.55, w * 0.08, h * 0.45);
      break;
    }
    case 'hud': {
      ctx.fillStyle = dark; ctx.fillRect(0, 0, w, h);
      const inset = Math.max(1, Math.min(w, h) * 0.12), level = options.fill === undefined ? 1 : clamp01(options.fill);
      ctx.fillStyle = fill; ctx.fillRect(inset, inset, (w - inset * 2) * level, h - inset * 2);
      ctx.strokeStyle = light; ctx.lineWidth = 1; ctx.strokeRect(0.5, 0.5, w - 1, h - 1);
      break;
    }
    case 'text': {
      ctx.fillStyle = dark; ctx.fillRect(0, 0, w, h);
      ctx.fillStyle = light;
      const lines = Math.max(1, Math.floor(h / 10));
      for (let i = 0; i < lines; i++) ctx.fillRect(6, 6 + i * 10, (w - 12) * (0.5 + 0.5 * (((seed >>> i) & 3) / 3)), 3);
      ctx.strokeStyle = fill; ctx.strokeRect(0.5, 0.5, w - 1, h - 1);
      break;
    }
    case 'transition': {
      const reveal = clamp01(f / 24);
      ctx.fillStyle = dark; ctx.fillRect(0, 0, w * reveal, h);
      ctx.fillStyle = light; ctx.fillRect(Math.max(0, w * reveal - 2), 0, 2, h);
      break;
    }
    case 'screen': {
      ctx.fillStyle = dark; ctx.fillRect(0, 0, w, h);
      ctx.strokeStyle = fill; ctx.lineWidth = 1;
      const cols = 4, rows = 3;
      for (let j = 0; j < rows; j++) for (let i = 0; i < cols; i++) ctx.strokeRect(w * (0.1 + (i * 0.8) / cols) + 0.5, h * (0.15 + (j * 0.7) / rows) + 0.5, (w * 0.8) / cols - 4, (h * 0.7) / rows - 4);
      break;
    }
    case 'clip': {
      ctx.fillStyle = fill; ctx.fillRect(0, 0, w, h);
      break;
    }
  }
}

/** One character in the procedural stand-in font: a 3x5 block pattern derived from the character code. Deterministic. */
function drawStandInGlyph(ctx: SpriteContext, char: string, x: number, y: number, size: number): void {
  const bits = hashString(char) ^ (char.codePointAt(0)! * 2654435761 >>> 0);
  const cell = size / 7;
  for (let row = 0; row < 5; row++) for (let col = 0; col < 3; col++) if ((bits >>> (row * 3 + col)) & 1) ctx.fillRect(x + (col + 1) * cell, y + (row + 1) * cell, cell, cell);
}

export interface TextOptions { readonly scale?: number; readonly alpha?: number; readonly tone?: string; readonly letterSpacing?: number }
/** Draws one line of text with the pack's glyph-grid font `fontId`, or, when the pack or font is missing, with the procedural
 * block font at `fallbackSize` pixels tall. (x, y) is the left end of the baseline-top of the line. Returns the width drawn. */
export function drawGlyphs(ctx: SpriteContext, pack: AssetPack | null, fontId: string, text: string, x: number, y: number, fallbackSize = 12, options: TextOptions = {}): number {
  const scale = finite(options.scale, 1), spacing = finite(options.letterSpacing, 0);
  const font = pack?.font(fontId), image = font ? pack!.image(font.atlas) : null;
  let cursor = 0;
  ctx.save();
  ctx.globalAlpha *= clamp01(finite(options.alpha, 1));
  ctx.translate(x, y); ctx.scale(scale, scale);
  if (font && image) {
    ctx.imageSmoothingEnabled = pack!.atlas(font.atlas)?.filter === 'linear';
    for (const ch of Array.from(text)) {
      const rect = glyphRect(font, ch), advance = glyphAdvance(font, ch);
      if (!rect || advance === undefined) { cursor += font.cell[0] + spacing; continue; }   // a missing glyph is a blank cell, never a throw
      ctx.drawImage(image as unknown as CanvasImageSource, rect[0], rect[1], rect[2], rect[3], cursor, 0, rect[2], rect[3]);
      cursor += advance + spacing;
    }
  } else {
    const rgb = parseTone(options.tone, hashString(fontId));
    ctx.fillStyle = shade(rgb, 1.2);
    const step = fallbackSize * 0.6 + spacing;
    for (const ch of Array.from(text)) { if (ch !== ' ') drawStandInGlyph(ctx, ch, cursor, 0, fallbackSize); cursor += step; }
  }
  ctx.restore();
  return cursor * scale;
}
