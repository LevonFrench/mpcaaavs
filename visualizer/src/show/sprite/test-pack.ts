// The procedural test pack (Task 5, item 7): a complete asset pack generated in code, so checks and stills run with no private files.
// Everything is neutral plain shapes: blocky figures, blobs, diamonds, rings and bars. No game art, no names. It goes through the real
// manifest validator and `AssetPack`, exactly like a pack loaded from disk, and exercises the sprite-layer extensions of the manifest
// (indexed atlases and palette swap, trimmed frames with untrimmed foot anchors, detached parts).
//
// Atlases:  actors (indexed)   figures, blobs and their detached blades     palettes azure / ember / verdant / violet
//           fx (indexed)       projectiles, effects, pickups                 palettes glow-warm / glow-cool / glow-rose / dust
//           stage (indexed)    sky, far hills, skyline, floor, lamp          palettes dusk / neon / dawn / mono (window lights cycle on beats)
//           ui (RGBA)          panels, bar frames, banners, cursor, fonts
import { AssetPack, type AtlasImage } from '../../asset-packs/pack.ts';
import { checkAssetPackManifest, type AssetPackManifest, type ClipVerb } from '../../asset-packs/manifest.ts';
import { FONT_CHARS, glyphRows } from './font5x7.ts';

export const TEST_PACK_ID = 'test-pack';
/** An atlas image with its pixels: what the sprite layer uploads. Indexed atlases carry the palette index in the red channel. */
export interface RawAtlas extends AtlasImage { readonly data: Uint8Array; readonly indexed: boolean }
export interface TestPack {
  readonly pack: AssetPack;
  readonly manifest: AssetPackManifest;
  readonly atlases: ReadonlyMap<string, RawAtlas>;
  /** The manifest as authored (plain JSON, before validation and normalization): what a pipeline would write to pack.json. */
  readonly draft: unknown;
}

// ------------------------------------------------------------------------------------------------ pixel canvas and atlas packer
type Rect4 = [number, number, number, number];
class Canvas {
  readonly data: Uint8Array;
  constructor(readonly w: number, readonly h: number, readonly indexed: boolean) { this.data = new Uint8Array(w * h * 4); }
  inside(x: number, y: number) { return x >= 0 && y >= 0 && x < this.w && y < this.h; }
  /** Colour at a pixel: the palette index (indexed canvas, 0 = empty) or 0xRRGGBBAA. */
  get(x: number, y: number): number {
    if (!this.inside(x, y)) return 0;
    const p = (y * this.w + x) * 4;
    return this.indexed ? (this.data[p + 3] ? this.data[p]! : 0) : ((this.data[p]! << 24) | (this.data[p + 1]! << 16) | (this.data[p + 2]! << 8) | this.data[p + 3]!) >>> 0;
  }
  px(x: number, y: number, c: number) {
    x = Math.round(x); y = Math.round(y);
    if (!this.inside(x, y)) return;
    const p = (y * this.w + x) * 4;
    if (this.indexed) { this.data[p] = this.data[p + 1] = this.data[p + 2] = c; this.data[p + 3] = c ? 255 : 0; }
    else { this.data[p] = (c >>> 24) & 255; this.data[p + 1] = (c >>> 16) & 255; this.data[p + 2] = (c >>> 8) & 255; this.data[p + 3] = c & 255; }
  }
  empty(x: number, y: number) { return this.get(x, y) === 0 || (!this.indexed && (this.get(x, y) & 255) === 0); }
  rect(x: number, y: number, w: number, h: number, c: number) { for (let j = 0; j < h; j++) for (let i = 0; i < w; i++) this.px(x + i, y + j, c); }
  disc(cx: number, cy: number, r: number, c: number) {
    for (let j = Math.floor(cy - r); j <= Math.ceil(cy + r); j++) for (let i = Math.floor(cx - r); i <= Math.ceil(cx + r); i++) if ((i - cx) ** 2 + (j - cy) ** 2 <= r * r + 0.25) this.px(i, j, c);
  }
  line(x0: number, y0: number, x1: number, y1: number, c: number, thick = 1) {
    const n = Math.max(1, Math.ceil(Math.hypot(x1 - x0, y1 - y0) * 2));
    for (let k = 0; k <= n; k++) {
      const x = x0 + ((x1 - x0) * k) / n, y = y0 + ((y1 - y0) * k) / n;
      if (thick <= 1) this.px(x, y, c); else this.rect(Math.round(x - thick / 2 + 0.01), Math.round(y - thick / 2 + 0.01), Math.round(thick), Math.round(thick), c);
    }
  }
  /** Bounding box of the non-empty pixels (null when the canvas is empty). */
  bbox(): Rect4 | null {
    let x0 = this.w, y0 = this.h, x1 = -1, y1 = -1;
    for (let y = 0; y < this.h; y++) for (let x = 0; x < this.w; x++) if (!this.empty(x, y)) { if (x < x0) x0 = x; if (x > x1) x1 = x; if (y < y0) y0 = y; if (y > y1) y1 = y; }
    return x1 < 0 ? null : [x0, y0, x1 - x0 + 1, y1 - y0 + 1];
  }
  /** Indexed only: a one-pixel outline of index `c` around everything drawn. */
  outline(c: number) {
    const add: Array<[number, number]> = [];
    for (let y = 0; y < this.h; y++) for (let x = 0; x < this.w; x++) {
      if (!this.empty(x, y)) continue;
      if (!this.empty(x - 1, y) || !this.empty(x + 1, y) || !this.empty(x, y - 1) || !this.empty(x, y + 1)) add.push([x, y]);
    }
    for (const [x, y] of add) this.px(x, y, c);
  }
}

class Atlas {
  readonly canvas: Canvas;
  private x = 0; private y = 0; private rowH = 0; private usedH = 0;
  constructor(readonly width: number, maxHeight: number, readonly indexed: boolean) { this.canvas = new Canvas(width, maxHeight, indexed); }
  /** Copies `box` of `src` into the next free spot (1 px gutter) and returns its rectangle in the atlas. */
  place(src: Canvas, box: Rect4 = [0, 0, src.w, src.h]): Rect4 {
    const [bx, by, bw, bh] = box;
    if (this.x + bw > this.width) { this.x = 0; this.y += this.rowH + 1; this.rowH = 0; }
    const rect: Rect4 = [this.x, this.y, bw, bh];
    for (let j = 0; j < bh; j++) for (let i = 0; i < bw; i++) {
      const s = ((by + j) * src.w + bx + i) * 4, d = ((this.y + j) * this.width + this.x + i) * 4;
      this.canvas.data[d] = src.data[s]!; this.canvas.data[d + 1] = src.data[s + 1]!; this.canvas.data[d + 2] = src.data[s + 2]!; this.canvas.data[d + 3] = src.data[s + 3]!;
    }
    this.x += bw + 1; this.rowH = Math.max(this.rowH, bh); this.usedH = Math.max(this.usedH, this.y + bh);
    if (this.usedH > this.canvas.h) throw new Error('test pack atlas overflow');
    return rect;
  }
  finish(): RawAtlas { return { width: this.width, height: this.usedH, data: this.canvas.data.slice(0, this.width * this.usedH * 4), indexed: this.indexed }; }
}

const rgba = (hex: string) => (parseInt(hex.slice(1), 16) * 256 + 255) >>> 0;

// ------------------------------------------------------------------------------------------------ figures (indexed art)
/** Palette indices of the figure art: 1 outline, 2 body shade, 3 body, 4 body light, 5 skin, 6 skin shade, 7 accent, 8 accent light, 9 eye, 10 hair, 11 blade, 12 blade light, 13 boots. */
const OUT = 1, SHADE = 2, BODY = 3, LIGHT = 4, SKIN = 5, ACC = 7, ACC2 = 8, EYE = 9, HAIR = 10, BLADE = 11, BLADE2 = 12, BOOT = 13;

type V2 = [number, number];
interface Pose {
  /** Hand positions relative to their shoulders, feet relative to their hips (x, lift). */
  fa: V2; ba: V2; ff: V2; bf: V2;
  lean?: number; crouch?: number; air?: number;
  /** Blade angle (radians, 0 = pointing forward) drawn as a detached part. */
  blade?: number;
  hurt?: boolean;
  /** Fraction of the figure visible from the feet up (materialise and fade). */
  reveal?: number;
}
const stance = (o: Partial<Pose> = {}): Pose => ({ fa: [5, 6], ba: [-4, 7], ff: [4, 0], bf: [-3, 0], ...o });

const FIG_W = 32, FIG_H = 40;
interface Drawn { body: Canvas; hand: V2; bladeCanvas: Canvas | null; bladeBase: V2 }

function drawFigure(pose: Pose, s: number, horns: boolean): Drawn {
  const W = FIG_W * s, H = FIG_H * s, c = new Canvas(W, H, true);
  const lean = (pose.lean ?? 0) * s, air = (pose.air ?? 0) * s, crouch = (pose.crouch ?? 0) * s;
  const cx = 16 * s, hipY = 27 * s + crouch - air, shY = 15 * s + crouch - air, footY = 39 * s - air;
  const shB: V2 = [cx - 3 * s + lean, shY + s], shF: V2 = [cx + 3 * s + lean, shY + s];
  const limb = (from: V2, d: V2, col: number) => { const to: V2 = [from[0] + d[0] * s, from[1] + d[1] * s]; c.line(from[0], from[1], to[0], to[1], col, 3 * s); return to; };
  limb(shB, pose.ba, BODY); // back arm, then back leg
  const leg = (hx: number, f: V2) => {
    const fx = hx + f[0] * s, fy = footY - f[1] * s;
    c.line(hx, hipY, fx, fy - 2 * s, SHADE, 3 * s);
    c.rect(Math.round(fx - 2 * s), Math.round(fy - 2 * s), 5 * s, 3 * s, BOOT);
  };
  leg(cx - 2 * s, pose.bf);
  // torso: leans from the hips up
  const rows = Math.max(1, hipY - shY);
  for (let r = 0; r <= rows; r++) { const off = lean * (1 - r / rows); c.rect(Math.round(cx - 4 * s + off), Math.round(shY + r), 8 * s, 1, BODY); }
  c.rect(Math.round(cx - 4 * s), Math.round(hipY - s), 8 * s, s, ACC);
  leg(cx + 2 * s, pose.ff);
  // head
  const hx = cx + lean, hy = shY - 5 * s, r = 5 * s;
  c.disc(hx, hy, r, SKIN);
  for (let j = Math.floor(hy - r); j <= Math.ceil(hy - 1.5 * s); j++) for (let i = Math.floor(hx - r); i <= Math.ceil(hx + r); i++) if (c.get(i, j) === SKIN && (j < hy - 1.5 * s || i < hx - 2 * s)) c.px(i, j, HAIR);
  if (pose.hurt) c.line(hx + s, hy, hx + 3.5 * s, hy, OUT, Math.max(1, s)); else { c.rect(Math.round(hx + s), Math.round(hy - s), 2 * s, 2 * s, EYE); c.px(hx + 3 * s - 1, hy, OUT); }
  if (horns) { c.line(hx - 3 * s, hy - 4 * s, hx - 7 * s, hy - 7 * s, ACC, 2 * s); c.line(hx + 3 * s, hy - 4 * s, hx + 7 * s, hy - 7 * s, ACC, 2 * s); c.px(hx - 7 * s, hy - 7 * s, ACC2); c.px(hx + 7 * s, hy - 7 * s, ACC2); }
  // front arm and hand
  const hand = limb(shF, pose.fa, BODY);
  c.disc(hand[0], hand[1], 1.6 * s, SKIN);
  if (pose.reveal !== undefined && pose.reveal < 1) c.rect(0, 0, W, Math.round(H * (1 - pose.reveal)), 0);
  // shading: a dark edge on the right of body colour, a light edge above
  const snap = new Canvas(W, H, true); snap.data.set(c.data);
  for (let y = 0; y < H; y++) for (let x = 0; x < W; x++) {
    const v = snap.get(x, y);
    if (v !== BODY && v !== SHADE) continue;
    if (snap.empty(x + 1, y) || snap.get(x + 1, y) === OUT) c.px(x, y, SHADE);
    else if (v === BODY && (snap.empty(x, y - 1) || snap.empty(x - 1, y))) c.px(x, y, LIGHT);
  }
  c.outline(OUT);
  // the blade is a detached part: its own canvas with the base at (3s, 12s)
  let bladeCanvas: Canvas | null = null;
  const base: V2 = [3 * s, 12 * s];
  if (pose.blade !== undefined && (pose.reveal === undefined || pose.reveal >= 1)) {
    bladeCanvas = new Canvas(24 * s, 24 * s, true);
    const a = pose.blade, len = 15 * s;
    bladeCanvas.line(base[0], base[1], base[0] + Math.cos(a) * len, base[1] + Math.sin(a) * len, BLADE, 2 * s);
    bladeCanvas.line(base[0] + Math.cos(a) * 2 * s, base[1] + Math.sin(a) * 2 * s, base[0] + Math.cos(a) * len, base[1] + Math.sin(a) * len, BLADE2, Math.max(1, s));
    bladeCanvas.line(base[0] - Math.cos(a) * 2 * s, base[1] - Math.sin(a) * 2 * s, base[0] + Math.cos(a) * 2 * s, base[1] + Math.sin(a) * 2 * s, ACC, 3 * s);
    bladeCanvas.outline(OUT);
  }
  return { body: c, hand, bladeCanvas, bladeBase: base };
}

interface ClipSpec { verb: ClipVerb; loop: boolean; hold: number[]; big: number[]; poses: Pose[] }
const swing = (n: number, amp: number, lift: number, lean = 0, arm = 3): Pose[] => Array.from({ length: n }, (_, i) => {
  const a = (i / n) * Math.PI * 2;
  return stance({
    ff: [Math.round(amp * Math.sin(a)), Math.round(lift * Math.max(0, Math.cos(a)))], bf: [Math.round(-amp * Math.sin(a)), Math.round(lift * Math.max(0, -Math.cos(a)))],
    fa: [Math.round(4 - arm * Math.sin(a)), 6 - (lean ? 2 : 0)], ba: [Math.round(-4 + arm * Math.sin(a)), 6 - (lean ? 2 : 0)], lean, crouch: i % Math.max(1, n / 2) === 0 ? 1 : 0,
  });
});
const FIGURE_CLIPS: ClipSpec[] = [
  { verb: 'idle', loop: true, hold: [10, 10, 10, 10], big: [], poses: [stance(), stance({ crouch: 1, fa: [5, 7] }), stance({ crouch: 1, fa: [5, 7], ba: [-4, 8] }), stance({ ba: [-4, 6] })] },
  { verb: 'walk', loop: true, hold: [6, 6, 6, 6, 6, 6], big: [], poses: swing(6, 5, 2) },
  { verb: 'run', loop: true, hold: [4, 4, 4, 4, 4, 4], big: [], poses: swing(6, 7, 4, 3, 5) },
  { verb: 'jump', loop: false, hold: [5, 10, 6], big: [1], poses: [stance({ crouch: 3 }), stance({ air: 10, ff: [4, 6], bf: [-3, 8], fa: [3, -4], ba: [-3, -3] }), stance({ air: 14, ff: [3, 7], bf: [-4, 6], fa: [5, -2], ba: [-5, -1] })] },
  { verb: 'dash', loop: false, hold: [3, 3, 8], big: [1], poses: [stance({ lean: 4, ff: [6, 0], bf: [-6, 0] }), stance({ lean: 6, ff: [8, 1], bf: [-8, 1], fa: [8, 2], ba: [-7, 3] }), stance({ lean: 3, ff: [5, 0], bf: [-4, 0] })] },
  { verb: 'attack', loop: false, hold: [4, 4, 3, 6, 5, 5], big: [3], poses: [
    stance({ lean: -1, fa: [-3, 4], blade: -2.2 }), stance({ lean: -3, crouch: 1, fa: [-6, 2], blade: -2.4 }), stance({ lean: -4, crouch: 1, fa: [-7, 0], ff: [5, 0], bf: [-4, 0], blade: -2.5 }),
    stance({ lean: 5, fa: [13, -2], ba: [-3, 8], ff: [7, 0], bf: [-5, 0], blade: -0.1 }), stance({ lean: 3, fa: [9, -1], ff: [6, 0], blade: 0.6 }), stance({ lean: 1, fa: [6, 4], blade: 1.0 })] },
  { verb: 'special', loop: false, hold: [6, 6, 6, 6, 4, 8, 8, 8], big: [4], poses: [
    stance({ crouch: 1, fa: [3, 6], ba: [-3, 6] }), stance({ crouch: 2, lean: -2, fa: [-4, 2], ba: [-5, 3], blade: -2.2 }), stance({ crouch: 2, lean: -3, fa: [-3, -6], ba: [-4, -5], blade: -2.0 }),
    stance({ air: 6, lean: -1, fa: [2, -8], ba: [-2, -8], ff: [3, 5], bf: [-3, 6], blade: -1.6 }), stance({ crouch: 3, lean: 7, fa: [12, 6], ba: [10, 5], ff: [8, 0], bf: [-6, 0], blade: 1.0 }),
    stance({ crouch: 2, lean: 5, fa: [10, 6], ba: [8, 6], blade: 1.2 }), stance({ crouch: 1, lean: 2, fa: [7, 6], ba: [-2, 7], blade: 1.2 }), stance()] },
  { verb: 'swing', loop: false, hold: [2, 4, 5, 5], big: [1], poses: [stance({ lean: -2, fa: [-4, 2], blade: -2.0 }), stance({ lean: 4, fa: [11, 0], ff: [6, 0], blade: -0.2 }), stance({ lean: 2, fa: [8, 2], blade: 0.5 }), stance({ fa: [6, 5], blade: 0.9 })] },
  { verb: 'cast', loop: false, hold: [5, 5, 5, 6, 8], big: [3], poses: [stance({ fa: [2, 0], ba: [1, 0] }), stance({ fa: [4, -4], ba: [3, -4], crouch: 1 }), stance({ fa: [3, -7], ba: [2, -7], crouch: 1, lean: -1 }), stance({ fa: [11, -2], ba: [9, -2], lean: 3 }), stance({ fa: [7, 2], ba: [5, 3], lean: 1 })] },
  { verb: 'throw', loop: false, hold: [4, 4, 5, 6], big: [2], poses: [stance({ fa: [-5, -3], lean: -2 }), stance({ fa: [-7, -6], lean: -3, crouch: 1 }), stance({ fa: [10, -5], lean: 4 }), stance({ fa: [7, 0], lean: 2 })] },
  { verb: 'guard', loop: false, hold: [3, 12, 5], big: [1], poses: [stance({ fa: [3, -2], ba: [3, -3] }), stance({ fa: [4, -7], ba: [3, -7], crouch: 1, lean: -1 }), stance({ fa: [3, -2], ba: [3, -3] })] },
  { verb: 'parry', loop: false, hold: [2, 3, 6, 7], big: [1], poses: [stance({ lean: -2, fa: [2, -2] }), stance({ lean: 2, fa: [9, -5], blade: -0.6 }), stance({ lean: 1, fa: [7, -3], blade: -0.3 }), stance({ fa: [5, 2] })] },
  { verb: 'hurt', loop: false, hold: [5, 9, 6], big: [0], poses: [stance({ lean: -4, fa: [-2, -5], ba: [-5, -4], hurt: true }), stance({ lean: -3, crouch: 1, fa: [-1, 2], hurt: true }), stance({ lean: -1, fa: [3, 5] })] },
  { verb: 'die', loop: false, hold: [5, 5, 6, 8, 40], big: [1], poses: [
    stance({ lean: -4, hurt: true, fa: [-2, -4] }), stance({ lean: -6, crouch: 6, hurt: true, fa: [-3, -2], ff: [2, 2], bf: [-4, 1] }), stance({ lean: -9, crouch: 12, hurt: true, fa: [-4, 2], ff: [2, 0], bf: [-4, 0] }),
    stance({ lean: -12, crouch: 17, hurt: true, fa: [-5, 3], ff: [2, 0], bf: [-3, 0] }), stance({ lean: -12, crouch: 17, hurt: true, reveal: 0.3, fa: [-5, 3] })] },
  { verb: 'spawn', loop: false, hold: [4, 4, 4, 4, 6], big: [3], poses: [stance({ reveal: 0.2 }), stance({ reveal: 0.45 }), stance({ reveal: 0.7 }), stance({ reveal: 1, crouch: 1 }), stance()] },
  { verb: 'taunt', loop: false, hold: [6, 6, 10, 6, 6], big: [2], poses: [stance({ fa: [4, 0] }), stance({ fa: [5, -5], ba: [-4, -2] }), stance({ fa: [3, -10], ba: [-3, -10], crouch: 1 }), stance({ fa: [5, -5], ba: [-4, -2] }), stance({ fa: [4, 2] })] },
  { verb: 'pose', loop: false, hold: [10, 40], big: [0], poses: [stance({ fa: [9, -6], lean: 2, ff: [6, 0], bf: [-6, 0], blade: -1.0 }), stance({ fa: [9, -6], lean: 2, ff: [6, 0], bf: [-6, 0], blade: -1.0, crouch: 1 })] },
  { verb: 'super', loop: false, hold: [8, 8, 8, 8, 8, 6, 10, 14], big: [5], poses: [
    stance({ crouch: 1, fa: [2, 3], ba: [-2, 3] }), stance({ crouch: 2, fa: [3, -3], ba: [-3, -3] }), stance({ crouch: 2, fa: [3, -8], ba: [-3, -8], lean: -1 }), stance({ crouch: 3, fa: [2, -11], ba: [-2, -11], lean: -2 }),
    stance({ air: 8, fa: [2, -12], ba: [-2, -12], ff: [3, 5], bf: [-3, 6] }), stance({ lean: 6, fa: [14, -3], ba: [12, -2], ff: [8, 0], bf: [-6, 0], blade: -0.2 }),
    stance({ lean: 4, fa: [10, 2], ba: [8, 3], blade: 0.5 }), stance({ lean: 1, fa: [6, 5], blade: 1.0 })] },
];
const BOSS_VERBS: readonly ClipVerb[] = ['idle', 'attack', 'special', 'super', 'hurt', 'taunt', 'cast', 'pose', 'guard', 'swing', 'spawn'];

// blob art: 16x16
function drawBlob(frame: { squash?: number; foot?: number; hurt?: boolean; reveal?: number; eyes?: number; lunge?: number }): Canvas {
  const c = new Canvas(16, 16, true), sq = frame.squash ?? 0, lunge = frame.lunge ?? 0;
  c.disc(8 + lunge, 9 - sq * 0.5, 5.4, BODY);
  c.rect(3 + lunge, Math.round(9 - sq), 10, 4 + Math.round(sq), BODY);
  c.rect(4 + lunge + (frame.foot ?? 0), 13, 3, 2, SHADE); c.rect(9 + lunge - (frame.foot ?? 0), 13, 3, 2, SHADE);
  c.line(8 + lunge, 3, 8 + lunge, 1, ACC, 1); c.px(8 + lunge, 0, ACC2);
  if (frame.hurt) { c.line(5 + lunge, 8, 7 + lunge, 8, OUT); c.line(9 + lunge, 8, 11 + lunge, 8, OUT); }
  else { c.rect(5 + lunge, 7, 2, 3, EYE); c.rect(9 + lunge, 7, 2, 3, EYE); c.px(6 + lunge + (frame.eyes ?? 0), 9, OUT); c.px(10 + lunge + (frame.eyes ?? 0), 9, OUT); }
  const snap = new Canvas(16, 16, true); snap.data.set(c.data);
  for (let y = 0; y < 16; y++) for (let x = 0; x < 16; x++) if (snap.get(x, y) === BODY) { if (snap.empty(x + 1, y)) c.px(x, y, SHADE); else if (snap.empty(x, y - 1)) c.px(x, y, LIGHT); }
  if (frame.reveal !== undefined && frame.reveal < 1) c.rect(0, 0, 16, Math.round(16 * (1 - frame.reveal)), 0);
  c.outline(OUT);
  return c;
}
const BLOB_CLIPS: Array<{ verb: ClipVerb; loop: boolean; hold: number[]; big: number[]; frames: Array<Parameters<typeof drawBlob>[0]> }> = [
  { verb: 'idle', loop: true, hold: [8, 8, 8, 8], big: [], frames: [{}, { squash: 1 }, { squash: 2, eyes: 1 }, { squash: 1 }] },
  { verb: 'walk', loop: true, hold: [6, 6, 6, 6], big: [], frames: [{ foot: 1 }, { foot: 0, squash: 1 }, { foot: -1 }, { foot: 0, squash: 1 }] },
  { verb: 'attack', loop: false, hold: [6, 4, 8], big: [1], frames: [{ squash: 2 }, { lunge: 2, eyes: 1 }, { squash: 1 }] },
  { verb: 'hurt', loop: false, hold: [4, 8], big: [0], frames: [{ hurt: true, squash: -1 }, { hurt: true, squash: 1 }] },
  { verb: 'die', loop: false, hold: [4, 4, 4, 4, 4], big: [1], frames: [{ hurt: true }, { hurt: true, squash: 2 }, { hurt: true, reveal: 0.7 }, { hurt: true, reveal: 0.4 }, { hurt: true, reveal: 0.15 }] },
  { verb: 'spawn', loop: false, hold: [4, 4, 4, 4], big: [3], frames: [{ reveal: 0.25 }, { reveal: 0.5 }, { reveal: 0.8 }, { squash: 1 }] },
];

// ------------------------------------------------------------------------------------------------ effects and projectiles (indexed art, 'glow' palettes: 1 core .. 6 edge)
function fxCanvas(size: number, draw: (c: Canvas, m: number) => void): Canvas { const c = new Canvas(size, size, true); draw(c, (size - 1) / 2); return c; }
function star(c: Canvas, m: number, r: number, rays: number, rot: number, core = 1, edge = 3) {
  for (let k = 0; k < rays; k++) { const a = rot + (Math.PI * 2 * k) / rays; c.line(m, m, m + Math.cos(a) * r, m + Math.sin(a) * r, edge, 2); c.line(m, m, m + Math.cos(a) * r * 0.7, m + Math.sin(a) * r * 0.7, 2, 1); }
  c.disc(m, m, Math.max(1.5, r * 0.3), core);
}
function ring(c: Canvas, m: number, r: number, t: number) {
  for (let y = 0; y < c.h; y++) for (let x = 0; x < c.w; x++) { const d = Math.hypot(x - m, y - m); if (d <= r && d > r - t) c.px(x, y, d > r - t * 0.4 ? 1 : d > r - t * 0.75 ? 2 : 3); }
}
const FX_FRAMES: Record<string, (() => Canvas)[]> = {
  'note-spin': [7, 5, 3, 5].map((w) => () => fxCanvas(9, (c, m) => { for (let j = -4; j <= 4; j++) { const half = Math.round((w / 2) * (1 - Math.abs(j) / 4.6)); for (let i = -half; i <= half; i++) c.px(m + i, m + j, Math.abs(i) + Math.abs(j) < 2 ? 1 : 2); } c.outline(4); })),
  'orb-pulse': [3, 4, 5].map((r) => () => fxCanvas(13, (c, m) => { c.disc(m, m, r + 1.2, 4); c.disc(m, m, r, 3); c.disc(m, m, r * 0.6, 2); c.disc(m, m, r * 0.3, 1); })),
  'bolt-flicker': [0, 1].map((k) => () => fxCanvas(15, (c, m) => { const pts: V2[] = k ? [[1, m], [5, m - 3], [8, m + 3], [13, m]] : [[1, m], [5, m + 3], [8, m - 3], [13, m]]; for (let i = 0; i < 3; i++) c.line(pts[i]![0], pts[i]![1], pts[i + 1]![0], pts[i + 1]![1], 2, 3); for (let i = 0; i < 3; i++) c.line(pts[i]![0], pts[i]![1], pts[i + 1]![0], pts[i + 1]![1], 1, 1); })),
  'star-twinkle': [0, 0.4, 0.8, 1.2].map((r) => () => fxCanvas(9, (c, m) => { star(c, m, 3.6, 4, r, 1, 2); })),
  'spark-burst': [3, 7, 10, 11, 8].map((r, i) => () => fxCanvas(25, (c, m) => { star(c, m, r, 8, 0.2 * i, 1, i < 3 ? 2 : 4); })),
  'ring-wave': [5, 9, 13, 17, 21, 25].map((r, i) => () => fxCanvas(53, (c, m) => { ring(c, m, r, Math.max(2, 7 - i)); })),
  'death-burst': [4, 8, 12, 15, 17, 18].map((r, i) => () => fxCanvas(37, (c, m) => { for (let k = 0; k < 10; k++) { const a = k * 2.399 + 0.3; const d = r * (0.55 + 0.45 * ((k * 7) % 5) / 4); c.disc(m + Math.cos(a) * d, m + Math.sin(a) * d, Math.max(0.6, 3 - i * 0.45), k % 3 === 0 ? 1 : 3); } if (i < 3) c.disc(m, m, 6 - i * 2, 2); })),
  puff: [3, 5, 7, 8, 9].map((r, i) => () => fxCanvas(19, (c, m) => { for (let k = 0; k < 5; k++) { const a = k * 1.3; c.disc(m + Math.cos(a) * r * 0.45, m + Math.sin(a) * r * 0.3, Math.max(1, r * 0.55 - i * 0.4), k % 2 ? 1 : 2); } c.outline(3); })),
  'flash-full': [16, 26, 30].map((r) => () => fxCanvas(65, (c, m) => { for (let y = 0; y < 65; y++) for (let x = 0; x < 65; x++) { const d = Math.hypot(x - m, y - m) / r; if (d < 1) c.px(x, y, d < 0.35 ? 1 : d < 0.65 ? 2 : d < 0.85 ? 3 : 4); } })),
  glint: [1, 3, 5, 3].map((r) => () => fxCanvas(11, (c, m) => { c.line(m - r, m, m + r, m, 1, 1); c.line(m, m - r, m, m + r, 1, 1); c.px(m, m, 1); if (r > 2) { c.px(m - 1, m, 2); c.px(m + 1, m, 2); c.px(m, m - 1, 2); c.px(m, m + 1, 2); } })),
  'gem-glint': [0, 1, 2, 1].map((k) => () => fxCanvas(9, (c, m) => { c.rect(m - 2, m - 2, 5, 5, 3); c.rect(m - 1, m - 3, 3, 7, 3); c.rect(m - 3, m - 1, 7, 3, 3); c.px(m - 1 + k - 1, m - 1, 1); c.px(m + 1, m + 1, 2); c.outline(5); })),
};

// ------------------------------------------------------------------------------------------------ backdrop art (indexed, 'stage' palettes)
// 1-4 sky bands (top to bottom), 5 star, 6 hill dark, 7 hill light, 8 building dark, 9 building edge, 10-13 window lights (cycle), 14 floor a, 15 floor b, 16 floor line, 17 lamp post, 18 lamp glow
function drawSky(): Canvas {
  const c = new Canvas(64, 240, true);
  for (let y = 0; y < 240; y++) for (let x = 0; x < 64; x++) {
    const band = y < 40 ? 1 : y < 90 ? 2 : y < 135 ? 3 : 4, next = y < 40 ? 2 : y < 90 ? 3 : y < 135 ? 4 : 4;
    const edge = y % 45, dither = edge > 37 && ((x + y) & 1) === 0;
    c.px(x, y, dither ? next : band);
  }
  for (let k = 0; k < 14; k++) c.px((k * 37 + 11) % 64, (k * 53 + 5) % 100, 5);
  return c;
}
function drawHills(): Canvas {
  const c = new Canvas(192, 72, true);
  for (let x = 0; x < 192; x++) {
    const a = 34 + 16 * Math.sin((x / 192) * Math.PI * 4) + 8 * Math.sin((x / 192) * Math.PI * 10 + 1), b = 46 + 10 * Math.sin((x / 192) * Math.PI * 6 + 2);
    for (let y = Math.round(a); y < 72; y++) c.px(x, y, y < a + 2 ? 7 : 6);
    for (let y = Math.round(b); y < 72; y++) c.px(x, y, 6);
  }
  return c;
}
function drawSkyline(): Canvas {
  const c = new Canvas(160, 96, true);
  const towers = [[0, 52, 22], [24, 30, 18], [44, 64, 26], [72, 40, 20], [94, 70, 16], [112, 46, 24], [138, 58, 22]];
  towers.forEach(([x, h, w], t) => {
    c.rect(x!, 96 - h!, w!, h!, 8); c.rect(x!, 96 - h!, w!, 1, 9); c.rect(x!, 96 - h!, 1, h!, 9);
    for (let wy = 96 - h! + 5; wy < 92; wy += 7) for (let wx = x! + 3; wx < x! + w! - 3; wx += 5) c.rect(wx, wy, 3, 4, 10 + ((wx + wy * 3 + t) % 4));
  });
  return c;
}
function drawFloor(): Canvas {
  const c = new Canvas(32, 48, true);
  for (let y = 0; y < 48; y++) for (let x = 0; x < 32; x++) c.px(x, y, ((x >> 4) + (y >> 4)) & 1 ? 15 : 14);
  c.rect(0, 0, 32, 1, 16); c.rect(0, 0, 1, 48, 16); c.rect(0, 16, 32, 1, 16); c.rect(0, 32, 32, 1, 16);
  return c;
}
function drawLamp(f: number): Canvas {
  const c = new Canvas(16, 44, true);
  c.rect(7, 12, 2, 32, 17); c.rect(4, 42, 8, 2, 17); c.rect(3, 6, 10, 6, 17);
  c.rect(4, 7, 8, 4, f === 1 ? 18 : 13);
  return c;
}

// ------------------------------------------------------------------------------------------------ interface art (RGBA)
function drawPanel(w: number, h: number, edge: string, fill: string, inner: string): Canvas {
  const c = new Canvas(w, h, false);
  c.rect(0, 0, w, h, rgba(fill)); c.rect(0, 0, w, 1, rgba(edge)); c.rect(0, h - 1, w, 1, rgba(edge)); c.rect(0, 0, 1, h, rgba(edge)); c.rect(w - 1, 0, 1, h, rgba(edge));
  c.rect(1, 1, w - 2, 1, rgba(inner)); c.rect(1, h - 2, w - 2, 1, rgba(inner)); c.rect(1, 1, 1, h - 2, rgba(inner)); c.rect(w - 2, 1, 1, h - 2, rgba(inner));
  for (const [x, y] of [[0, 0], [w - 1, 0], [0, h - 1], [w - 1, h - 1]] as const) c.px(x!, y!, 0);
  return c;
}
function drawGlyphGrid(chars: string, columns: number): Canvas {
  const rows = Math.ceil(chars.length / columns), c = new Canvas(columns * 6, rows * 8, false), white = rgba('#ffffff');
  Array.from(chars).forEach((ch, i) => {
    const ox = (i % columns) * 6, oy = Math.floor(i / columns) * 8, g = glyphRows(ch);
    for (let r = 0; r < 7; r++) for (let b = 0; b < 5; b++) if (g[r]! & (0x10 >> b)) c.px(ox + b, oy + r, white);
  });
  return c;
}

// ------------------------------------------------------------------------------------------------ the pack
const PALETTES = {
  azure: ['#00000000', '#0b1026', '#1f3a8a', '#2f6fe0', '#79b4ff', '#f2c7a0', '#c9946a', '#ffd23f', '#fff3a0', '#ffffff', '#3a2418', '#c8d6e5', '#ffffff', '#1b1f3b'],
  ember: ['#00000000', '#1a0a08', '#8a2a1f', '#e0542f', '#ff9a6a', '#e9b98f', '#b98058', '#3fe3ff', '#b0f6ff', '#ffffff', '#20140c', '#e5d6c8', '#ffffff', '#2b1a14'],
  verdant: ['#00000000', '#06170f', '#1f6a3c', '#2fc06a', '#8ff0a6', '#f0d9a0', '#c2a460', '#ff5fa2', '#ffb0d2', '#ffffff', '#16341f', '#cfe8d6', '#ffffff', '#0f2a1a'],
  violet: ['#00000000', '#10061f', '#4a1f8a', '#8a3fe0', '#c79aff', '#d8b0f0', '#a070c8', '#ff3fa8', '#ffb0e0', '#ffffff', '#1f0a3a', '#e0d0f5', '#ffffff', '#1c0f34'],
  'glow-warm': ['#00000000', '#ffffff', '#fff3a0', '#ffb43a', '#ff5a1a', '#b01030', '#60082a'],
  'glow-cool': ['#00000000', '#ffffff', '#d6fbff', '#6fe3ff', '#2a8cff', '#1a3fb0', '#101a60'],
  'glow-rose': ['#00000000', '#ffffff', '#ffd6f0', '#ff7ad0', '#d01fa0', '#7a0f80', '#3a0850'],
  dust: ['#00000000', '#e6e0d0', '#b8b0a0', '#807868'],
  dusk: ['#00000000', '#231a4a', '#3b2a6e', '#6a3a86', '#b24f7e', '#fff0c0', '#2b1f54', '#46336e', '#1b1438', '#5a4a9a', '#ffd86a', '#ff9a3a', '#ff6a8a', '#8af0ff', '#3a2a5e', '#2e2150', '#5d4a94', '#8a7ab8', '#ffd86a'],
  neon: ['#00000000', '#06040f', '#0b0822', '#14103a', '#1f1a5a', '#9ad7ff', '#0b1236', '#15235a', '#080a24', '#2a4a9a', '#ff2a8a', '#2affd0', '#ffd02a', '#8a2aff', '#0c0a1e', '#120f2c', '#2a2a7a', '#5a5ad0', '#2affd0'],
  dawn: ['#00000000', '#2a4a7a', '#5a7aa8', '#ffa878', '#ffd8a0', '#ffffff', '#3a5a8a', '#8aa0c8', '#2a3a5e', '#7a8ab0', '#fff3c0', '#ffc070', '#ff9a70', '#ffffff', '#46628e', '#3a5480', '#c0d0e8', '#e0e8f4', '#fff3c0'],
  mono: ['#00000000', '#101010', '#202020', '#303030', '#404040', '#d0d0d0', '#181818', '#282828', '#0c0c0c', '#585858', '#f0f0f0', '#b0b0b0', '#808080', '#d8d8d8', '#1c1c1c', '#242424', '#444444', '#666666', '#f0f0f0'],
} as const;
const CYCLING = new Set(['dusk', 'neon', 'dawn', 'mono']);

/** Builds the pack once per call (deterministic, a few milliseconds of integer arithmetic). */
export function buildTestPack(): TestPack {
  const actors = new Atlas(1024, 1024, true), fx = new Atlas(512, 512, true), stage = new Atlas(512, 512, true), ui = new Atlas(256, 256, false);
  const regions: Record<string, unknown> = {}, clips: Record<string, unknown> = {};

  // ---- figures: frames per verb; hero, rival, ally share the hero clips (palette swap), boss has its own 2x frames
  const figureClips = (prefix: string, s: number, horns: boolean, verbs: readonly ClipVerb[] | null) => {
    const ids: Partial<Record<ClipVerb, string>> = {};
    for (const spec of FIGURE_CLIPS) {
      if (verbs && !verbs.includes(spec.verb)) continue;
      const frames: string[] = [], anchors: number[][] = [], trims: number[][] = [];
      const parts: { rects: (number[] | null)[]; offsets: number[][] } = { rects: [], offsets: [] };
      let anyPart = false;
      const anchor: V2 = [16 * s, 40 * s - 1];
      spec.poses.forEach((pose, i) => {
        const d = drawFigure(pose, s, horns), box = d.body.bbox() ?? [0, 0, 1, 1];
        const rect = actors.place(d.body, box);
        const id = `${prefix}-${spec.verb}-${i}`;
        regions[id] = { role: 'clip', atlas: 'actors', rect };
        frames.push(id); anchors.push([...anchor]); trims.push([box[0], box[1]]);
        if (d.bladeCanvas) {
          const bb = d.bladeCanvas.bbox()!, r = actors.place(d.bladeCanvas, bb);
          parts.rects.push(r); parts.offsets.push([Math.round(d.hand[0] - d.bladeBase[0] + bb[0] - anchor[0]), Math.round(d.hand[1] - d.bladeBase[1] + bb[1] - anchor[1])]);
          anyPart = true;
        } else { parts.rects.push(null); parts.offsets.push([0, 0]); }
      });
      const clipId = `${prefix}-${spec.verb}`;
      clips[clipId] = { verb: spec.verb, loop: spec.loop, hold: spec.hold, big: spec.big, frames, anchors, trims, ...(anyPart ? { parts: { blade: { atlas: 'actors', rects: parts.rects, offsets: parts.offsets, layer: 'front' } } } : {}) };
      ids[spec.verb] = clipId;
    }
    return ids;
  };
  const heroClips = figureClips('hero', 1, false, null);
  const bossClips = figureClips('boss', 2, true, BOSS_VERBS);
  const actorRegion = (id: string, role: { class: string; size: string; palette: string; clips: Partial<Record<ClipVerb, string>>; firstFrame: string }) => {
    const first = (regions[role.firstFrame] as { rect: Rect4 }).rect;
    regions[id] = { role: 'actor', atlas: 'actors', rect: first, class: role.class, size: role.size, facing: 'right', palette: role.palette, tags: ['stand-in'], clips: role.clips };
  };
  actorRegion('hero', { class: 'hero', size: 'medium', palette: 'azure', clips: heroClips, firstFrame: 'hero-idle-0' });
  actorRegion('rival', { class: 'hero', size: 'medium', palette: 'ember', clips: heroClips, firstFrame: 'hero-idle-0' });
  actorRegion('ally', { class: 'companion', size: 'medium', palette: 'verdant', clips: heroClips, firstFrame: 'hero-idle-0' });
  actorRegion('boss', { class: 'boss', size: 'huge', palette: 'violet', clips: bossClips, firstFrame: 'boss-idle-0' });
  // blobs
  const blobClips: Partial<Record<ClipVerb, string>> = {};
  for (const spec of BLOB_CLIPS) {
    const frames: string[] = [], anchors: number[][] = [], trims: number[][] = [];
    spec.frames.forEach((f, i) => {
      const c = drawBlob(f), box = c.bbox() ?? [0, 0, 1, 1], rect = actors.place(c, box), id = `minion-${spec.verb}-${i}`;
      regions[id] = { role: 'clip', atlas: 'actors', rect }; frames.push(id); anchors.push([8, 15]); trims.push([box[0], box[1]]);
    });
    clips[`minion-${spec.verb}`] = { verb: spec.verb, loop: spec.loop, hold: spec.hold, big: spec.big, frames, anchors, trims };
    blobClips[spec.verb] = `minion-${spec.verb}`;
  }
  actorRegion('minion', { class: 'enemy', size: 'small', palette: 'verdant', clips: blobClips, firstFrame: 'minion-idle-0' });
  actorRegion('minion-b', { class: 'enemy', size: 'small', palette: 'ember', clips: blobClips, firstFrame: 'minion-idle-0' });
  actorRegion('minion-c', { class: 'enemy', size: 'small', palette: 'violet', clips: blobClips, firstFrame: 'minion-idle-0' });

  // ---- fx
  const fxRects: Record<string, Rect4[]> = {}, fxBoxes: Record<string, Rect4[]> = {};
  for (const [name, makers] of Object.entries(FX_FRAMES)) {
    fxRects[name] = []; fxBoxes[name] = [];
    for (const make of makers) { const c = make(), box = c.bbox() ?? [0, 0, 1, 1]; fxBoxes[name]!.push(box); fxRects[name]!.push(fx.place(c, box)); }
  }
  // fx frames are drawn centred in their cell: the cell centre is the anchor and the trimmed box offset is the trim
  const fxClip = (name: string, hold: number[], loop: boolean, big: number[], cell: number) => {
    const ids: string[] = [], anchors: number[][] = [], trims: number[][] = [];
    fxRects[name]!.forEach((rect, i) => {
      const id = `${name}-${i}`; regions[id] = { role: 'clip', atlas: 'fx', rect }; ids.push(id);
      const box = fxBoxes[name]![i]!;
      anchors.push([(cell - 1) >> 1, (cell - 1) >> 1]); trims.push([box[0], box[1]]);
    });
    clips[name] = { verb: 'pose', loop, hold, big, frames: ids, anchors, trims };
    return name;
  };
  fxClip('note-spin', [4, 4, 4, 4], true, [], 9); fxClip('orb-pulse', [5, 5, 5], true, [], 13); fxClip('bolt-flicker', [3, 3], true, [], 15); fxClip('star-twinkle', [4, 4, 4, 4], true, [], 9);
  fxClip('spark-burst', [2, 2, 3, 3, 4], false, [0], 25); fxClip('ring-wave', [3, 3, 3, 3, 3, 4], false, [0], 53); fxClip('death-burst', [3, 3, 3, 3, 3, 4], false, [0], 37);
  fxClip('puff', [3, 3, 4, 4, 5], false, [0], 19); fxClip('flash-full', [3, 4, 6], false, [0], 65); fxClip('glint', [3, 3, 3, 3], false, [1], 11); fxClip('gem-glint', [6, 6, 6, 6], true, [], 9);
  const first = (n: string) => fxRects[n]![0]!;
  regions.note = { role: 'projectile', atlas: 'fx', rect: first('note-spin'), motion: 'arc', spawn: [10, 14], clip: 'note-spin', impact: 'spark', palette: 'glow-warm', anchor: [Math.floor(first('note-spin')[2] / 2), Math.floor(first('note-spin')[3] / 2)] };
  regions.orb = { role: 'projectile', atlas: 'fx', rect: first('orb-pulse'), motion: 'homing', spawn: [10, 14], clip: 'orb-pulse', impact: 'spark', palette: 'glow-cool' };
  regions.bolt = { role: 'projectile', atlas: 'fx', rect: first('bolt-flicker'), motion: 'straight', spawn: [10, 14], clip: 'bolt-flicker', impact: 'spark', palette: 'glow-rose' };
  regions.star = { role: 'projectile', atlas: 'fx', rect: first('star-twinkle'), motion: 'sine', spawn: [10, 14], clip: 'star-twinkle', impact: 'spark', palette: 'glow-warm' };
  const effect = (id: string, blend: 'add' | 'screen' | 'normal', duration: number, scale: string, palette: string) => { regions[id] = { role: 'effect', atlas: 'fx', rect: first(id === 'spark' ? 'spark-burst' : id === 'ring' ? 'ring-wave' : id === 'burst' ? 'death-burst' : id === 'flash' ? 'flash-full' : id), blend, duration, scale, palette, clip: id === 'spark' ? 'spark-burst' : id === 'ring' ? 'ring-wave' : id === 'burst' ? 'death-burst' : id === 'flash' ? 'flash-full' : id }; };
  effect('spark', 'add', 14, 'small', 'glow-warm'); effect('ring', 'add', 19, 'large', 'glow-cool'); effect('burst', 'add', 19, 'medium', 'glow-rose'); effect('flash', 'add', 13, 'huge', 'glow-warm');
  effect('puff', 'normal', 19, 'small', 'dust'); effect('glint', 'screen', 12, 'tiny', 'glow-cool');
  regions.gem = { role: 'pickup', atlas: 'fx', rect: first('gem-glint'), idle: 'gem-glint', collect: 'glint', caption: 'Gem', palette: 'glow-cool' };

  // ---- stage
  const place = (c: Canvas) => stage.place(c);
  const skyRect = place(drawSky()), hillRect = place(drawHills()), lineRect = place(drawSkyline()), floorRect = place(drawFloor());
  regions.sky = { role: 'background', atlas: 'stage', rect: skyRect, scroll: 0, layer: 0, loopWidth: 64 };
  regions.hills = { role: 'background', atlas: 'stage', rect: hillRect, scroll: 0.25, layer: 1, loopWidth: 192 };
  regions.skyline = { role: 'background', atlas: 'stage', rect: lineRect, scroll: 0.5, layer: 2, loopWidth: 160 };
  regions.floor = { role: 'background', atlas: 'stage', rect: floorRect, scroll: 1, layer: 3, loopWidth: 32 };
  const lampFrames = [0, 1, 0, 1].map((f, i) => { const r = place(drawLamp(f)); regions[`lamp-${i}`] = { role: 'clip', atlas: 'stage', rect: r }; return `lamp-${i}`; });
  clips['lamp-flicker'] = { verb: 'idle', loop: true, hold: [18, 6, 10, 8], frames: lampFrames, anchors: lampFrames.map(() => [8, 43]) };
  regions.lamp = { role: 'prop', atlas: 'stage', rect: (regions['lamp-0'] as { rect: Rect4 }).rect, anchor: [8, 43], idle: 'lamp-flicker', drops: ['gem'] };

  // ---- ui (RGBA)
  const panel = drawPanel(16, 16, '#e8f0ff', '#0a1024d0', '#3a4a8a'), barFrame = drawPanel(48, 9, '#ffffff', '#000000a0', '#5a6aa0'), banner = drawPanel(24, 16, '#ffe680', '#b0181e', '#ff6a5a'), selPanel = drawPanel(64, 48, '#9ab0ff', '#081028e0', '#2a3a7a');
  const panelRect = ui.place(panel), barRect = ui.place(barFrame), bannerRect = ui.place(banner), selRect = ui.place(selPanel);
  regions.panel = { role: 'hud', atlas: 'ui', rect: panelRect, part: 'box', nineSlice: { left: 4, top: 4, right: 4, bottom: 4 } };
  regions['bar-frame'] = { role: 'hud', atlas: 'ui', rect: barRect, part: 'bar', fill: 'left-to-right', segmentPitch: 4, ghost: '#ffffff', nineSlice: { left: 3, top: 3, right: 3, bottom: 3 } };
  regions.banner = { role: 'hud', atlas: 'ui', rect: bannerRect, part: 'banner', nineSlice: { left: 6, top: 6, right: 6, bottom: 6 } };
  regions.select = { role: 'screen', atlas: 'ui', rect: selRect, nineSlice: { left: 4, top: 4, right: 4, bottom: 4 }, slots: { a: [4, 4, 26, 40], b: [34, 4, 26, 40] }, cursors: [[4, 4], [34, 4]] };
  const dialogRect = ui.place(drawPanel(24, 16, '#ffffff', '#101830e8', '#6a7ab0')), wipeRect = ui.place(drawPanel(16, 16, '#ffffff', '#000000ff', '#000000'));
  regions.dialog = { role: 'text', atlas: 'ui', rect: dialogRect, nineSlice: { left: 4, top: 4, right: 4, bottom: 4 } };
  regions.wipe = { role: 'transition', atlas: 'ui', rect: wipeRect, beats: 2, direction: 'left' };
  // cursor: 2-frame arrow
  const cursorFrames = [0, 1].map((f) => { const c = new Canvas(9, 9, false); for (let i = 0; i < 6; i++) c.rect(i + f, i, 1, 1, rgba('#ffffff')); c.rect(f, 0, 6, 1, rgba('#ffffff')); c.rect(f, 0, 1, 6, rgba('#ffffff')); return ui.place(c, c.bbox()!); });
  cursorFrames.forEach((r, i) => { regions[`cursor-${i}`] = { role: 'clip', atlas: 'ui', rect: r }; });
  clips['cursor-blink'] = { verb: 'idle', loop: true, hold: [12, 12], frames: ['cursor-0', 'cursor-1'], anchors: [[0, 0], [0, 0]] };
  regions.cursor = { role: 'hud', atlas: 'ui', rect: cursorFrames[0]!, part: 'cursor' };
  const DIGITS = '0123456789:./-%+ ';
  const digitsRect = ui.place(drawGlyphGrid(DIGITS, 9)), capsRect = ui.place(drawGlyphGrid(FONT_CHARS, 16));
  const manifestDraft = {
    format: 'mpcaaavs-assets', version: 1, id: TEST_PACK_ID, name: 'Procedural Test Pack',
    atlases: {
      actors: { file: 'atlas/actors.png', width: 1024, height: 0, filter: 'nearest', indexed: true },
      fx: { file: 'atlas/fx.png', width: 512, height: 0, filter: 'nearest', indexed: true },
      stage: { file: 'atlas/stage.png', width: 512, height: 0, filter: 'nearest', indexed: true },
      ui: { file: 'atlas/ui.png', width: 256, height: 0, filter: 'nearest' },
    } as Record<string, { file: string; width: number; height: number; filter: string; indexed?: boolean }>,
    palettes: Object.fromEntries(Object.entries(PALETTES).map(([id, colors]) => [id, {
      colors,
      ...(CYCLING.has(id) ? { cycles: [{ from: 10, to: 13, beats: 2 }, { from: 14, to: 15, beats: 4 }] } : {}),
    }])),
    regions, clips,
    fonts: {
      digits: { role: 'hud', atlas: 'ui', rect: digitsRect, cell: [6, 8], columns: 9, chars: DIGITS, advance: 6, lineHeight: 8, baseline: 7 },
      caps: { role: 'text', atlas: 'ui', rect: capsRect, cell: [6, 8], columns: 16, chars: FONT_CHARS, advance: 6, lineHeight: 9, baseline: 7 },
    },
  };
  const atlases = new Map<string, RawAtlas>([['actors', actors.finish()], ['fx', fx.finish()], ['stage', stage.finish()], ['ui', ui.finish()]]);
  for (const [id, a] of atlases) manifestDraft.atlases[id]!.height = a.height;
  // the palette cycles are only meaningful for the stage palettes; the cycling ranges must exist in every palette that has them
  const draft = JSON.parse(JSON.stringify(manifestDraft));
  const checked = checkAssetPackManifest(draft);
  if (!checked.manifest) throw new Error(`test pack manifest is invalid: ${JSON.stringify(checked.issues.slice(0, 5))}`);
  return { pack: new AssetPack(checked.manifest, atlases), manifest: checked.manifest, atlases, draft: JSON.parse(JSON.stringify(manifestDraft)) };
}
