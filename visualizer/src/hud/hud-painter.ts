/** Procedural HUD painter (docs/design/HUD-PACK-ENGINE.md 5.2 and 5.5, docs/design/CONTRACT.md 2.3.9).
 *
 * A thin, counting layer over a 2D context. Every coordinate the instruments pass in is a logical design-canvas unit; the painter maps the design canvas
 * onto the surface with the resolution module's helpers (`surfaceMetrics`, `applyDesignTransform`, `snapSpan`, `snapBaseline`, `strokePx`: there is no second
 * snapping implementation) so rectangles and hairlines land on device pixels at any scale. Two drawing regimes share one API:
 *   - vector canvases draw shapes as paths and rectangles as snapped fills;
 *   - pixel canvases (the surface is the authored native grid, or a larger surface of it) draw EVERYTHING as snapped rectangles: diagonal lines, circles and
 *     polygons are rasterised into a small mask on the logical pixel grid and emitted as merged runs, so no antialiased edge ever appears in a pixel-art scene.
 * Rectangles of one colour and alpha are batched into a single fill. Text is drawn from hud-font.ts as batched rectangles (identical on every machine); only the
 * `mono` and `display` faces use the system stack. Nothing here measures text, reads the clock or draws a random number.
 *
 * Counters follow the design's budget vocabulary (section 5.5): `draws` is fill, stroke, fillRect and fillText calls; `paths` is path segments including batched
 * rectangles; hard caps make a runaway manifest degrade (`skipped`) instead of stalling a frame.
 * Status: proposed and CPU-checked (tools/check-hud-engine.mjs); nothing here has been seen on a display. */
import { applyDesignTransform, snapBaseline, snapSpan, surfaceMetrics, type SurfaceMetrics } from '../render-resolution.ts';
import { FONT, ICON_SIZE, glyphRects, iconRects, segMask, segRects, textCells } from './hud-font.ts';

// ---------------------------------------------------------------------------------------------------------------- context
export interface PaintGradient { addColorStop(offset: number, color: string): void }
/** The exact subset of the 2D context the HUD engine uses. A fake context in a test needs only these. */
export interface PaintContext {
  save(): void; restore(): void; translate(x: number, y: number): void; scale(x: number, y: number): void;
  beginPath(): void; closePath(): void; moveTo(x: number, y: number): void; lineTo(x: number, y: number): void;
  rect(x: number, y: number, w: number, h: number): void; arc(x: number, y: number, r: number, a0: number, a1: number, ccw?: boolean): void;
  clip(): void; fill(): void; stroke(): void; fillRect(x: number, y: number, w: number, h: number): void; fillText(text: string, x: number, y: number): void;
  createLinearGradient(x0: number, y0: number, x1: number, y1: number): PaintGradient;
  createRadialGradient(x0: number, y0: number, r0: number, x1: number, y1: number, r1: number): PaintGradient;
  fillStyle: string | object; strokeStyle: string | object; lineWidth: number; globalAlpha: number; font: string; textAlign: string; textBaseline: string; lineJoin: string; lineCap: string;
}

/** Frame statistics; the shape of `AvsWorkerFrameMessage.hudStats` (hud-engine.ts asserts the two agree at compile time). */
export interface HudRenderStats {
  draws: number; fills: number; strokes: number; texts: number; paths: number; saves: number; gradients: number; clips: number;
  /** Filled area over the surface area (an overdraw estimate). */
  area: number; instruments: number; skipped: number; flashEvents: number; degraded: number;
}
export const blankStats = (): HudRenderStats => ({ draws: 0, fills: 0, strokes: 0, texts: 0, paths: 0, saves: 0, gradients: 0, clips: 0, area: 0, instruments: 0, skipped: 0, flashEvents: 0, degraded: 0 });
export interface PainterBudget { readonly draws: number; readonly segments: number; readonly texts: number; readonly gradients: number; readonly saves: number }
/** Test and diagnostic hook: `(instrument id, tag, a, b)`. Called for drawn text and for a few named values; costs nothing when absent. */
export type HudTrace = (layer: string, tag: string, a: number | string, b?: number) => void;

// ---------------------------------------------------------------------------------------------------------------- small pure helpers
export const clamp = (x: number, lo: number, hi: number): number => (x < lo ? lo : x > hi ? hi : x);
/** NaN reads as 0. */
export const clamp01 = (x: number): number => (x > 0 ? (x < 1 ? x : 1) : 0);
export const lerp = (a: number, b: number, t: number): number => a + (b - a) * t;
export const smooth01 = (x: number): number => { const t = clamp01(x); return t * t * (3 - 2 * t); };
/** Deterministic hash of up to three integers to [0, 1). Fractions are truncated: pass whole numbers. */
export function hash01(a: number, b: number, c = 0): number {
  let h = Math.imul((a | 0) ^ 0x9e3779b9, 0x85ebca6b) ^ Math.imul((b | 0) + 0x7f4a7c15, 0xc2b2ae35) ^ Math.imul((c | 0) + 0x165667b1, 0x27d4eb2f);
  h ^= h >>> 15; h = Math.imul(h, 0x2c1b3c6d); h ^= h >>> 12; h = Math.imul(h, 0x297a2d39); h ^= h >>> 15;
  return (h >>> 0) / 4294967296;
}
/** Smooth value noise in [0, 1]: a closed-form slow random walk (`x` in cycles). */
export function noise1(seed: number, x: number): number {
  const i = Math.floor(x), f = x - i, u = f * f * (3 - 2 * f);
  return lerp(hash01(seed, i), hash01(seed, i + 1), u);
}
/** Stable 32-bit hash of a string (layer ids seed per-instrument variation). */
export function hashText(s: string): number {
  let h = 0x811c9dc5;
  for (let i = 0; i < s.length; i++) { h ^= s.charCodeAt(i); h = Math.imul(h, 0x01000193); }
  return h | 0;
}
const mixCache = new Map<string, string>();
const hex2 = (n: number): string => (n < 16 ? '0' : '') + n.toString(16);
/** Colour between two `#rrggbb` colours. `t` is quantised to 1/64 and results are cached (bounded), so a per-frame call allocates nothing in steady state. */
export function mixHex(a: string, b: string, t: number): string {
  const q = Math.round(clamp01(t) * 64);
  if (q === 0) return a;
  if (q === 64) return b;
  const key = `${a}${b}${q}`;
  let hit = mixCache.get(key);
  if (hit === undefined) {
    const p = parseInt(a.slice(1), 16), r = parseInt(b.slice(1), 16), k = q / 64;
    const ch = (s: number) => Math.round(((p >> s) & 255) + (((r >> s) & 255) - ((p >> s) & 255)) * k);
    hit = `#${hex2(ch(16))}${hex2(ch(8))}${hex2(ch(0))}`;
    if (mixCache.size > 1024) mixCache.clear();
    mixCache.set(key, hit);
  }
  return hit;
}
/** Perceptual lightness proxy 0..1 of a `#rrggbb` colour (Rec. 709 weights on the sRGB values; a heuristic for picking text colour, not a colorimetric value). */
export function luma(hex: string): number {
  const p = parseInt(hex.slice(1), 16);
  return (0.2126 * ((p >> 16) & 255) + 0.7152 * ((p >> 8) & 255) + 0.0722 * (p & 255)) / 255;
}

const TAU = Math.PI * 2;
const MASK_MAX = 1 << 18;
/** System stacks for the two non-pixel faces. The only source of machine-to-machine difference, as documented for the NERV scenes. */
const STACKS = { mono: 'ui-monospace, "Cascadia Mono", Consolas, Menlo, monospace', display: '"Bahnschrift", "Segoe UI", system-ui, sans-serif' } as const;
export type TextFace = keyof typeof STACKS;
export type TextAlign = 'left' | 'center' | 'right';

// ---------------------------------------------------------------------------------------------------------------- painter
export class Painter {
  ctx!: PaintContext;
  m: SurfaceMetrics = surfaceMetrics(1, 1, 1, 1);
  pixel = false;
  readonly stats: HudRenderStats = blankStats();
  /** Multiplies every alpha; the engine sets it per instrument (pulse and blink modifiers). */
  alphaScale = 1;
  layerId = '';
  spy: HudTrace | null = null;
  private budget: PainterBudget = { draws: 900, segments: 5000, texts: 96, gradients: 24, saves: 96 };
  private buf: number[] = [];
  private bColor = ''; private bAlpha = 1;
  private fillKey: string | object = ''; private alphaKey = -1; private strokeKey = ''; private widthKey = -1; private fontKey = ''; private alignKey = '';
  private den = 1; private sq = 1;
  private mask = new Uint8Array(4096);
  private mx = 0; private my = 0; private mw = 0; private mh = 0;
  private runsA: number[] = []; private runsB: number[] = [];
  private depth = 0;

  /** Bind a surface and start a frame: saves the context, paints `base` over the whole surface, then maps the design canvas (letterboxed, clipped). */
  begin(ctx: PaintContext, width: number, height: number, canvasW: number, canvasH: number, pixel: boolean, budget: PainterBudget, base: string): void {
    this.ctx = ctx; this.pixel = pixel; this.budget = budget;
    const m = this.m = surfaceMetrics(width, height, canvasW, canvasH);
    Object.assign(this.stats, blankStats());
    this.buf.length = 0; this.bColor = ''; this.bAlpha = 1; this.alphaScale = 1; this.layerId = ''; this.depth = 0;
    this.fillKey = ''; this.alphaKey = -1; this.strokeKey = ''; this.widthKey = -1; this.fontKey = ''; this.alignKey = '';
    this.den = m.width * m.height; this.sq = m.scale * m.scale;
    ctx.save(); this.stats.saves++;
    this.style(base, 1);
    ctx.fillRect(0, 0, m.width, m.height);
    this.stats.draws++; this.stats.fills++; this.stats.paths++; this.stats.area += 1;
    applyDesignTransform(ctx, m);
    this.stats.clips++; this.stats.paths++;
    ctx.textBaseline = 'alphabetic';
  }
  /** Flush and restore the context to what it was before `begin`. */
  end(): void {
    this.flush();
    while (this.depth > 0) this.clipEnd();
    this.ctx.restore();
  }

  // ------------------------------------------------------------------------------------------------ state
  private style(color: string, alpha: number): void {
    const a = clamp01(alpha * this.alphaScale);
    if (a !== this.alphaKey) { this.ctx.globalAlpha = a; this.alphaKey = a; }
    if (color !== this.fillKey) { this.ctx.fillStyle = color; this.fillKey = color; }
  }
  private strokeStyle(color: string, alpha: number, width: number): void {
    const a = clamp01(alpha * this.alphaScale);
    if (a !== this.alphaKey) { this.ctx.globalAlpha = a; this.alphaKey = a; }
    if (color !== this.strokeKey) { this.ctx.strokeStyle = color; this.strokeKey = color; }
    if (width !== this.widthKey) { this.ctx.lineWidth = width; this.widthKey = width; }
  }
  /** Logical width of a stroke that is at least one device pixel and a whole number of device pixels. */
  strokeWidth(width: number): number {
    const d = Math.max(1, Math.round(Math.min(Math.max(width, 0), 1e6) * this.m.scale));
    return d / this.m.scale;
  }
  /** One device pixel in logical units. */
  get hair(): number { return 1 / this.m.scale; }
  private canSegment(n = 1): boolean {
    if (this.stats.paths + this.buf.length / 4 + n > this.budget.segments) { this.stats.skipped++; return false; }
    return true;
  }
  private canDraw(): boolean {
    if (this.stats.draws >= this.budget.draws) { this.stats.skipped++; return false; }
    return true;
  }

  // ------------------------------------------------------------------------------------------------ rectangles
  private add(x: number, y: number, w: number, h: number, color: string, alpha: number): void {
    if (!Number.isFinite(x + y + w + h)) return;
    if (color !== this.bColor || alpha !== this.bAlpha) { this.flush(); this.bColor = color; this.bAlpha = alpha; }
    if (this.stats.paths + this.buf.length / 4 + 1 > this.budget.segments) { this.stats.skipped++; return; }
    this.buf.push(x, y, w, h);
    this.stats.area += (w * h * this.sq) / this.den;
  }
  /** Fill a rectangle; both edges are snapped to device pixels (a positive size keeps at least one). */
  rect(x: number, y: number, w: number, h: number, color: string, alpha = 1): void {
    if (!(w > 0 && h > 0 && alpha > 0)) return;
    const sx = snapSpan(this.m, 'x', x, w), sy = snapSpan(this.m, 'y', y, h);
    this.add(sx[0], sy[0], sx[1], sy[1], color, alpha);
  }
  /** Outline of `t` logical units drawn as four snapped rectangles that do not overlap. */
  frame(x: number, y: number, w: number, h: number, t: number, color: string, alpha = 1): void {
    if (!(w > 0 && h > 0)) return;
    const k = Math.min(Math.max(t, 0), w / 2, h / 2);
    if (!(k > 0)) return;
    this.rect(x, y, w, k, color, alpha); this.rect(x, y + h - k, w, k, color, alpha);
    if (h > 2 * k) { this.rect(x, y + k, k, h - 2 * k, color, alpha); this.rect(x + w - k, y + k, k, h - 2 * k, color, alpha); }
  }
  /** Emit the pending batch: one `fillRect` for a single rectangle, else one path and one fill. */
  flush(): void {
    const b = this.buf, n = b.length >> 2;
    if (!n) return;
    if (!this.canDraw()) { this.stats.skipped += n - 1; b.length = 0; return; }
    const ctx = this.ctx;
    this.style(this.bColor, this.bAlpha);
    if (n === 1) ctx.fillRect(b[0]!, b[1]!, b[2]!, b[3]!);
    else { ctx.beginPath(); for (let i = 0; i < b.length; i += 4) ctx.rect(b[i]!, b[i + 1]!, b[i + 2]!, b[i + 3]!); ctx.fill(); }
    this.stats.draws++; this.stats.fills++; this.stats.paths += n;
    b.length = 0;
  }
  /** Clip to a snapped rectangle until `clipEnd`. False (and nothing saved) when the save budget is spent: the caller then skips the clipped drawing. */
  clipBegin(x: number, y: number, w: number, h: number): boolean {
    this.flush();
    if (this.stats.saves >= this.budget.saves || !(w > 0 && h > 0) || !this.canSegment()) { this.stats.skipped++; return false; }
    const ctx = this.ctx, sx = snapSpan(this.m, 'x', x, w), sy = snapSpan(this.m, 'y', y, h);
    ctx.save(); this.stats.saves++; this.depth++;
    ctx.beginPath(); ctx.rect(sx[0], sy[0], sx[1], sy[1]); ctx.clip(); this.stats.clips++; this.stats.paths++;
    return true;
  }
  clipEnd(): void {
    if (this.depth <= 0) return;
    this.flush();
    this.ctx.restore(); this.depth--;
    // a restore reverts the style state to what it was at the matching save
    this.fillKey = ''; this.alphaKey = -1; this.strokeKey = ''; this.widthKey = -1; this.fontKey = ''; this.alignKey = '';
  }
  /** Translate the design canvas (screen shake). Balanced by `unshift`. */
  shift(dx: number, dy: number): void {
    this.flush();
    this.ctx.save(); this.stats.saves++; this.depth++;
    this.ctx.translate(dx, dy);
  }
  unshift(): void { this.clipEnd(); }

  // ------------------------------------------------------------------------------------------------ gradients
  /** Linear ramp `c0` to `c1` over a rectangle: a real gradient on a vector canvas, `bands` flat rectangles on a pixel canvas. */
  ramp(x: number, y: number, w: number, h: number, c0: string, c1: string, vertical: boolean, alpha = 1, bands = 6): void {
    if (!(w > 0 && h > 0 && alpha > 0)) return;
    if (this.pixel || this.stats.gradients >= this.budget.gradients) {
      const n = Math.max(1, Math.min(bands, Math.floor(vertical ? h : w)));
      for (let i = 0; i < n; i++) {
        const a = Math.round(((vertical ? h : w) * i) / n), b = Math.round(((vertical ? h : w) * (i + 1)) / n), c = mixHex(c0, c1, n === 1 ? 0.5 : i / (n - 1));
        if (vertical) this.rect(x, y + a, w, b - a, c, alpha); else this.rect(x + a, y, b - a, h, c, alpha);
      }
      return;
    }
    this.flush();
    if (!this.canDraw()) return;
    const sx = snapSpan(this.m, 'x', x, w), sy = snapSpan(this.m, 'y', y, h), ctx = this.ctx;
    const g = vertical ? ctx.createLinearGradient(0, sy[0], 0, sy[0] + sy[1]) : ctx.createLinearGradient(sx[0], 0, sx[0] + sx[1], 0);
    g.addColorStop(0, c0); g.addColorStop(1, c1); this.stats.gradients++;
    const a = clamp01(alpha * this.alphaScale);
    if (a !== this.alphaKey) { ctx.globalAlpha = a; this.alphaKey = a; }
    ctx.fillStyle = g; this.fillKey = g;
    ctx.fillRect(sx[0], sy[0], sx[1], sy[1]);
    this.stats.draws++; this.stats.fills++; this.stats.paths++; this.stats.area += (sx[1] * sy[1] * this.sq) / this.den;
  }
  /** Radial ramp from `c0` at the centre to `c1` at `r`, drawn as a disc (bands of concentric discs on a pixel canvas). */
  radial(cx: number, cy: number, r: number, c0: string, c1: string, alpha = 1, bands = 5): void {
    if (!(r > 0 && alpha > 0)) return;
    if (this.pixel || this.stats.gradients >= this.budget.gradients) {
      const n = Math.max(1, bands);
      for (let i = 0; i < n; i++) this.disc(cx, cy, (r * (n - i)) / n, mixHex(c1, c0, n === 1 ? 0.5 : i / (n - 1)), alpha);
      return;
    }
    this.flush();
    if (!this.canDraw()) return;
    const ctx = this.ctx, g = ctx.createRadialGradient(cx, cy, 0, cx, cy, r);
    g.addColorStop(0, c0); g.addColorStop(1, c1); this.stats.gradients++;
    const a = clamp01(alpha * this.alphaScale);
    if (a !== this.alphaKey) { ctx.globalAlpha = a; this.alphaKey = a; }
    ctx.fillStyle = g; this.fillKey = g;
    ctx.beginPath(); ctx.arc(cx, cy, r, 0, TAU); ctx.fill();
    this.stats.draws++; this.stats.fills++; this.stats.paths++; this.stats.area += (Math.PI * r * r * this.sq) / this.den;
  }
  /** A vignette: transparent in the middle, `color` at the corners. Vector: a radial gradient over the rectangle; pixel: nested frames of rising alpha. */
  vignette(x: number, y: number, w: number, h: number, color: string, amount: number): void {
    if (!(w > 0 && h > 0 && amount > 0)) return;
    if (this.pixel || this.stats.gradients >= this.budget.gradients) {
      const n = Math.max(2, Math.min(5, Math.floor(Math.min(w, h) / 12)));
      for (let i = 0; i < n; i++) {
        const inset = (Math.min(w, h) * 0.22 * i) / n, t = (n - i) / n, band = (Math.min(w, h) * 0.22) / n;
        this.frame(x + inset, y + inset, w - 2 * inset, h - 2 * inset, Math.max(1, Math.round(band)), color, amount * t * t);
      }
      return;
    }
    this.flush();
    if (!this.canDraw()) return;
    const ctx = this.ctx, cx = x + w / 2, cy = y + h / 2, R = Math.hypot(w, h) / 2;
    const g = ctx.createRadialGradient(cx, cy, R * 0.45, cx, cy, R);
    g.addColorStop(0, rgba(color, 0)); g.addColorStop(1, rgba(color, 1)); this.stats.gradients++;
    const sx = snapSpan(this.m, 'x', x, w), sy = snapSpan(this.m, 'y', y, h);
    const a = clamp01(amount * this.alphaScale);
    if (a !== this.alphaKey) { ctx.globalAlpha = a; this.alphaKey = a; }
    ctx.fillStyle = g; this.fillKey = g;
    ctx.fillRect(sx[0], sy[0], sx[1], sy[1]);
    this.stats.draws++; this.stats.fills++; this.stats.paths++; this.stats.area += (sx[1] * sy[1] * this.sq) / this.den;
  }

  // ------------------------------------------------------------------------------------------------ pixel mask
  private maskBegin(x0: number, y0: number, w: number, h: number): boolean {
    const ix = Math.floor(x0), iy = Math.floor(y0), iw = Math.ceil(x0 + w) - ix, ih = Math.ceil(y0 + h) - iy;
    if (!(iw >= 1 && ih >= 1) || iw * ih > MASK_MAX || !Number.isFinite(iw * ih)) return false;
    if (this.mask.length < iw * ih) this.mask = new Uint8Array(Math.min(MASK_MAX, Math.max(iw * ih, this.mask.length * 2)));
    this.mask.fill(0, 0, iw * ih);
    this.mx = ix; this.my = iy; this.mw = iw; this.mh = ih;
    return true;
  }
  private maskSet(x: number, y: number): void {
    const i = x - this.mx, j = y - this.my;
    if (i >= 0 && j >= 0 && i < this.mw && j < this.mh) this.mask[j * this.mw + i] = 1;
  }
  /** Emit the mask as merged runs: horizontal runs per row, joined vertically while identical. */
  private maskFlush(color: string, alpha: number): void {
    const { mw, mh, mask } = this;
    let prev = this.runsA, cur = this.runsB;
    prev.length = 0;      // triples: x0, x1, first row
    for (let j = 0; j <= mh; j++) {
      cur.length = 0;
      if (j < mh) {
        const row = j * mw;
        for (let i = 0; i < mw; i++) {
          if (!mask[row + i]) continue;
          let k = i + 1;
          while (k < mw && mask[row + k]) k++;
          cur.push(i, k, j);
          i = k;
        }
      }
      let p = 0, c = 0;
      while (p < prev.length || c < cur.length) {
        if (p >= prev.length) { c += 3; continue; }                     // a run that starts on this row
        const px0 = prev[p]!, px1 = prev[p + 1]!;
        if (c >= cur.length) { this.rect(this.mx + px0, this.my + prev[p + 2]!, px1 - px0, j - prev[p + 2]!, color, alpha); p += 3; continue; }
        const cx0 = cur[c]!, cx1 = cur[c + 1]!;
        if (px0 === cx0 && px1 === cx1) { cur[c + 2] = prev[p + 2]!; p += 3; c += 3; }   // identical: the rectangle grows
        else if (cx1 <= px0) c += 3;                                    // new run left of the old one
        else { this.rect(this.mx + px0, this.my + prev[p + 2]!, px1 - px0, j - prev[p + 2]!, color, alpha); p += 3; }   // the old run ended
      }
      const t = prev; prev = cur; cur = t;
    }
  }

  // ------------------------------------------------------------------------------------------------ shapes
  /** Filled disc. Pixel canvases sample cell centres. */
  disc(cx: number, cy: number, r: number, color: string, alpha = 1): void {
    if (!(r > 0 && alpha > 0) || !Number.isFinite(cx + cy + r)) return;
    if (this.pixel) {
      if (!this.maskBegin(cx - r, cy - r, 2 * r, 2 * r)) {
        // A large authored pixel canvas must not make an orb disappear merely because a dense mask is capped.
        // Draw coarse, grid-aligned row bands instead; this costs at most 128 segments and retains hard budgets.
        this.stats.degraded++;
        const step = Math.max(1, Math.ceil(r * 2 / 128));
        for (let row = Math.floor(cy - r); row < cy + r; row += step) {
          const yy = row + step / 2 - cy, half = Math.sqrt(Math.max(0, r * r - yy * yy));
          this.rect(Math.ceil(cx - half), row, Math.max(0, Math.floor(cx + half) - Math.ceil(cx - half)), Math.min(step, cy + r - row), color, alpha);
        }
        return;
      }
      const r2 = r * r;
      for (let y = this.my; y < this.my + this.mh; y++) for (let x = this.mx; x < this.mx + this.mw; x++) { const dx = x + 0.5 - cx, dy = y + 0.5 - cy; if (dx * dx + dy * dy <= r2) this.maskSet(x, y); }
      this.maskFlush(color, alpha);
      return;
    }
    this.flush();
    if (!this.canDraw() || !this.canSegment()) return;
    this.style(color, alpha);
    this.ctx.beginPath(); this.ctx.arc(cx, cy, r, 0, TAU); this.ctx.fill();
    this.stats.draws++; this.stats.fills++; this.stats.paths++; this.stats.area += (Math.PI * r * r * this.sq) / this.den;
  }
  /** Arc band of stroke `thick` around (cx, cy) from angle `a0` to `a1` (radians, clockwise from +x in screen space); a span of a full turn or more is a ring. */
  ring(cx: number, cy: number, r: number, thick: number, a0: number, a1: number, color: string, alpha = 1): void {
    if (!(r > 0 && thick > 0 && alpha > 0) || !Number.isFinite(cx + cy + r + a0 + a1)) return;
    const sweep = clamp(a1 - a0, 0, TAU);
    if (!(sweep > 0)) return;
    if (this.pixel) {
      const half = Math.max(thick, 1) / 2 + 0.1, out = r + half;
      if (!this.maskBegin(cx - out, cy - out, 2 * out, 2 * out)) {
        // Bounded polygonal outline on large native pixel grids. Short individual segments have small masks.
        this.stats.degraded++;
        const n = Math.max(2, Math.ceil(sweep / TAU * 48));
        for (let i = 0; i < n; i++) {
          const a = a0 + sweep * i / n, b = a0 + sweep * (i + 1) / n;
          this.line(cx + Math.cos(a) * r, cy + Math.sin(a) * r, cx + Math.cos(b) * r, cy + Math.sin(b) * r, thick, color, alpha);
        }
        return;
      }
      const start = ((a0 % TAU) + TAU) % TAU, full = sweep >= TAU - 1e-9;
      for (let y = this.my; y < this.my + this.mh; y++) for (let x = this.mx; x < this.mx + this.mw; x++) {
        const dx = x + 0.5 - cx, dy = y + 0.5 - cy, d = Math.hypot(dx, dy);
        if (d < r - half || d >= r + half) continue;
        if (!full) { const rel = (((Math.atan2(dy, dx) - start) % TAU) + TAU) % TAU; if (rel > sweep) continue; }
        this.maskSet(x, y);
      }
      this.maskFlush(color, alpha);
      return;
    }
    this.flush();
    if (!this.canDraw() || !this.canSegment()) return;
    const w = this.strokeWidth(thick);
    this.strokeStyle(color, alpha, w);
    this.ctx.lineCap = 'butt';
    this.ctx.beginPath(); this.ctx.arc(cx, cy, r, a0, a0 + sweep); this.ctx.stroke();
    this.stats.draws++; this.stats.strokes++; this.stats.paths++;
  }
  /** Full outline using the same bounded pixel/vector ring primitive. */
  circle(cx: number, cy: number, r: number, thick: number, color: string, alpha = 1): void {
    this.ring(cx, cy, r, thick, 0, Math.PI * 2, color, alpha);
  }
  /** Arc with a positive sweep (the underlying ring takes start/end angles). */
  arc(cx: number, cy: number, r: number, start: number, sweep: number, thick: number, color: string, alpha = 1): void {
    this.ring(cx, cy, r, thick, start, start + sweep, color, alpha);
  }
  /** Straight line of stroke `thick`. Axis-aligned lines are snapped rectangles on both canvas kinds. */
  line(x0: number, y0: number, x1: number, y1: number, thick: number, color: string, alpha = 1): void {
    if (!(thick > 0 && alpha > 0) || !Number.isFinite(x0 + y0 + x1 + y1)) return;
    const w = this.pixel ? Math.max(1, Math.round(thick)) : this.strokeWidth(thick);
    if (Math.abs(y1 - y0) < 1e-9) { this.rect(Math.min(x0, x1), y0 - w / 2, Math.abs(x1 - x0), w, color, alpha); return; }
    if (Math.abs(x1 - x0) < 1e-9) { this.rect(x0 - w / 2, Math.min(y0, y1), w, Math.abs(y1 - y0), color, alpha); return; }
    this.polyline([x0, y0, x1, y1], 2, thick, color, alpha, false);
  }
  /** Connected line segments through `n` points [x, y, ...]. One stroke on a vector canvas, one mask on a pixel canvas. */
  polyline(pts: ArrayLike<number>, n: number, thick: number, color: string, alpha = 1, closed = false): void {
    if (n < 2 || !(thick > 0 && alpha > 0)) return;
    for (let i = 0; i < n * 2; i++) if (!Number.isFinite(pts[i])) return;
    if (this.pixel) {
      let lx = Infinity, ly = Infinity, hx = -Infinity, hy = -Infinity;
      for (let i = 0; i < n; i++) { lx = Math.min(lx, pts[2 * i]!); hx = Math.max(hx, pts[2 * i]!); ly = Math.min(ly, pts[2 * i + 1]!); hy = Math.max(hy, pts[2 * i + 1]!); }
      const pad = Math.max(1, thick);
      if (!this.maskBegin(lx - pad, ly - pad, hx - lx + 2 * pad, hy - ly + 2 * pad)) {
        this.stats.degraded++;
        const segs = closed ? n : n - 1;
        if (n > 2) {
          for (let i = 0; i < segs; i++) this.line(pts[2 * i]!, pts[2 * i + 1]!, pts[2 * ((i + 1) % n)]!, pts[2 * ((i + 1) % n) + 1]!, thick, color, alpha);
        } else {
          const x0 = pts[0]!, y0 = pts[1]!, dx = pts[2]! - x0, dy = pts[3]! - y0, steps = Math.min(128, Math.max(1, Math.ceil(Math.max(Math.abs(dx), Math.abs(dy))))), cell = Math.max(thick, Math.ceil(Math.max(Math.abs(dx), Math.abs(dy)) / steps));
          for (let i = 0; i <= steps; i++) this.rect(Math.round(x0 + dx * i / steps - cell / 2), Math.round(y0 + dy * i / steps - cell / 2), cell, cell, color, alpha);
        }
        return;
      }
      const segs = closed ? n : n - 1;
      for (let s = 0; s < segs; s++) this.maskSegment(pts[2 * s]!, pts[2 * s + 1]!, pts[2 * ((s + 1) % n)]!, pts[2 * ((s + 1) % n) + 1]!, thick);
      this.maskFlush(color, alpha);
      return;
    }
    this.flush();
    if (!this.canDraw() || !this.canSegment(n)) return;
    this.strokeStyle(color, alpha, this.strokeWidth(thick));
    this.ctx.lineJoin = 'round'; this.ctx.lineCap = 'butt';
    this.ctx.beginPath(); this.ctx.moveTo(pts[0]!, pts[1]!);
    for (let i = 1; i < n; i++) this.ctx.lineTo(pts[2 * i]!, pts[2 * i + 1]!);
    if (closed) this.ctx.closePath();
    this.ctx.stroke();
    this.stats.draws++; this.stats.strokes++; this.stats.paths += n;
  }
  private maskSegment(x0: number, y0: number, x1: number, y1: number, thick: number): void {
    if (thick <= 1.5) {
      // Bresenham on the cells that contain the end points
      let cx = Math.floor(x0), cy = Math.floor(y0);
      const ex = Math.floor(x1), ey = Math.floor(y1), dx = Math.abs(ex - cx), dy = -Math.abs(ey - cy), sx = cx < ex ? 1 : -1, sy = cy < ey ? 1 : -1;
      let err = dx + dy;
      for (let guard = 0; guard < 1 << 16; guard++) {
        this.maskSet(cx, cy);
        if (cx === ex && cy === ey) break;
        const e2 = 2 * err;
        if (e2 >= dy) { err += dy; cx += sx; }
        if (e2 <= dx) { err += dx; cy += sy; }
      }
      return;
    }
    const half = thick / 2 + 0.05, vx = x1 - x0, vy = y1 - y0, len2 = vx * vx + vy * vy;
    const lo = Math.floor(Math.min(x0, x1) - half), hi = Math.ceil(Math.max(x0, x1) + half), lj = Math.floor(Math.min(y0, y1) - half), hj = Math.ceil(Math.max(y0, y1) + half);
    for (let y = lj; y < hj; y++) for (let x = lo; x < hi; x++) {
      const px = x + 0.5 - x0, py = y + 0.5 - y0, t = len2 > 0 ? clamp01((px * vx + py * vy) / len2) : 0;
      const ddx = px - vx * t, ddy = py - vy * t;
      if (ddx * ddx + ddy * ddy <= half * half) this.maskSet(x, y);
    }
  }
  /** Filled polygon through `n` points [x, y, ...] (even-odd). */
  polygon(pts: ArrayLike<number>, n: number, color: string, alpha = 1): void {
    if (n < 3 || !(alpha > 0)) return;
    for (let i = 0; i < n * 2; i++) if (!Number.isFinite(pts[i])) return;
    let lx = Infinity, ly = Infinity, hx = -Infinity, hy = -Infinity;
    for (let i = 0; i < n; i++) { lx = Math.min(lx, pts[2 * i]!); hx = Math.max(hx, pts[2 * i]!); ly = Math.min(ly, pts[2 * i + 1]!); hy = Math.max(hy, pts[2 * i + 1]!); }
    if (this.pixel) {
      if (!this.maskBegin(lx, ly, hx - lx, hy - ly)) {
        this.stats.degraded++;
        const step = Math.max(1, Math.ceil((hy - ly) / 128)), xs: number[] = [];
        for (let y = Math.floor(ly); y < hy; y += step) {
          const yc = y + step / 2; xs.length = 0;
          for (let i = 0; i < n; i++) {
            const ax = pts[2 * i]!, ay = pts[2 * i + 1]!, bx = pts[2 * ((i + 1) % n)]!, by = pts[2 * ((i + 1) % n) + 1]!;
            if ((ay <= yc && by > yc) || (by <= yc && ay > yc)) xs.push(ax + (yc - ay) * (bx - ax) / (by - ay));
          }
          xs.sort((a, b) => a - b);
          for (let i = 0; i + 1 < xs.length; i += 2) { const left = Math.ceil(xs[i]!), right = Math.floor(xs[i + 1]!); this.rect(left, y, Math.max(0, right - left), Math.min(step, hy - y), color, alpha); }
        }
        return;
      }
      const xs: number[] = [];
      for (let y = this.my; y < this.my + this.mh; y++) {
        const yc = y + 0.5;
        xs.length = 0;
        for (let i = 0; i < n; i++) {
          const ax = pts[2 * i]!, ay = pts[2 * i + 1]!, bx = pts[2 * ((i + 1) % n)]!, by = pts[2 * ((i + 1) % n) + 1]!;
          if ((ay <= yc && by > yc) || (by <= yc && ay > yc)) xs.push(ax + ((yc - ay) / (by - ay)) * (bx - ax));
        }
        xs.sort((a, b) => a - b);
        for (let k = 0; k + 1 < xs.length; k += 2) for (let x = Math.ceil(xs[k]! - 0.5); x + 0.5 < xs[k + 1]!; x++) this.maskSet(x, y);
      }
      this.maskFlush(color, alpha);
      return;
    }
    this.flush();
    if (!this.canDraw() || !this.canSegment(n)) return;
    this.style(color, alpha);
    this.ctx.beginPath(); this.ctx.moveTo(pts[0]!, pts[1]!);
    for (let i = 1; i < n; i++) this.ctx.lineTo(pts[2 * i]!, pts[2 * i + 1]!);
    this.ctx.closePath(); this.ctx.fill();
    this.stats.draws++; this.stats.fills++; this.stats.paths += n; this.stats.area += ((hx - lx) * (hy - ly) * 0.5 * this.sq) / this.den;
  }

  // ------------------------------------------------------------------------------------------------ text
  /** Rectangles of a cell list (x, y, w, h in cells) placed at (ox, oy) with cell size `cw` x `ch`; cell edges go through one snapping expression so neighbours share edges. */
  cells(list: ArrayLike<number>, ox: number, oy: number, cw: number, ch: number, color: string, alpha = 1): void {
    for (let i = 0; i + 3 < list.length; i += 4) this.rect(ox + list[i]! * cw, oy + list[i + 1]! * ch, list[i + 2]! * cw, list[i + 3]! * ch, color, alpha);
  }
  /** Text in the pixel font as batched rectangles. `x` is the left edge, centre or right edge by `align`, `y` the top of the glyph. Returns the width in logical units.
   * With `shadow` the string is first drawn once in that colour one cell down and right. */
  pixelText(text: string, x: number, y: number, cell: number, color: string, alpha = 1, align: TextAlign = 'left', shadow?: string): number {
    const len = text.length, width = textCells(len) * cell;
    if (!(cell > 0) || !Number.isFinite(x + y + cell)) return 0;
    this.spy?.(this.layerId, 'text', text);
    let left = align === 'left' ? x : align === 'center' ? x - width / 2 : x - width;
    if (this.pixel) left = Math.round(left);
    // shadow first (paint order), then the glyphs
    for (let pass = shadow ? 0 : 1; pass < 2; pass++) {
      const col = pass === 0 ? shadow! : color, off = pass === 0 ? (this.pixel ? Math.max(1, Math.round(cell / 2)) : cell / 2) : 0;
      for (let i = 0; i < len; i++) {
        const r = glyphRects(text.charAt(i));
        if (r.length) this.cells(r, left + i * FONT.advance * cell + off, y + off, cell, cell, col, pass === 0 ? alpha * 0.85 : alpha);
      }
    }
    return width;
  }
  /** Seven-segment text: digits and a few letters, `:` and `.` narrow. Lit segments in `color`; unlit ones in `dim` at `dimAlpha` (skipped when null).
   * `cw` x `ch` is one digit cell, `t` the bar thickness. `x` is the left, centre or right edge by `align`. Returns the width. */
  segText(text: string, x: number, y: number, cw: number, ch: number, t: number, color: string, dim: string | null, alpha = 1, align: TextAlign = 'left', dimAlpha = 0.16): number {
    if (!(cw > 0 && ch > 0) || !Number.isFinite(x + y)) return 0;
    this.spy?.(this.layerId, 'text', text);
    const px1 = this.pixel, gap = px1 ? Math.max(1, Math.round(cw * 0.22)) : Math.max(this.hair, cw * 0.22), colon = px1 ? Math.max(2, Math.round(t * 2)) : Math.max(t * 2, 2 * this.hair);
    const snap = (v: number) => (px1 ? Math.round(v) : v);
    let width = 0;
    for (let i = 0; i < text.length; i++) width += (i ? gap : 0) + (text.charAt(i) === ':' || text.charAt(i) === '.' ? colon : cw);
    let px = snap(align === 'left' ? x : align === 'center' ? x - width / 2 : x - width);
    const seg = segRects(cw, ch, t), lit: number[] = [], off: number[] = [];
    for (let i = 0; i < text.length; i++, px += gap) {
      const c = text.charAt(i);
      if (c === ':' || c === '.') {
        const dot = px1 ? Math.max(1, Math.round(t)) : Math.max(t, this.hair);
        if (c === ':') { this.rect(px + snap((colon - dot) / 2), y + snap(ch * 0.3 - dot / 2), dot, dot, color, alpha); this.rect(px + snap((colon - dot) / 2), y + snap(ch * 0.7 - dot / 2), dot, dot, color, alpha); }
        else this.rect(px + snap((colon - dot) / 2), y + ch - dot, dot, dot, color, alpha);
        px += colon;
        continue;
      }
      const mask = segMask(c);
      for (let s = 0; s < 7; s++) {
        const dst = mask & (1 << s) ? lit : off;
        dst.push(px + seg[s * 4]!, y + seg[s * 4 + 1]!, seg[s * 4 + 2]!, seg[s * 4 + 3]!);
      }
      px += cw;
    }
    if (dim) for (let i = 0; i < off.length; i += 4) this.rect(off[i]!, off[i + 1]!, off[i + 2]!, off[i + 3]!, dim, dimAlpha * alpha);
    for (let i = 0; i < lit.length; i += 4) this.rect(lit[i]!, lit[i + 1]!, lit[i + 2]!, lit[i + 3]!, color, alpha);
    return width;
  }
  /** Draw a 7x7 icon at (x, y) with cell size `cell`. */
  icon(name: string, x: number, y: number, cell: number, color: string, alpha = 1): void {
    if (cell > 0) this.cells(iconRects(name), x, y, cell, cell, color, alpha);
  }
  /** System-font text (`mono` or `display`) with the baseline snapped to a device pixel row. `size` is a logical font size. */
  text(text: string, x: number, baseline: number, size: number, color: string, alpha = 1, align: TextAlign = 'left', face: TextFace = 'mono'): void {
    if (!(size > 0 && alpha > 0) || !Number.isFinite(x + baseline + size)) return;
    this.flush();
    if (this.stats.texts >= this.budget.texts || !this.canDraw()) { this.stats.skipped++; return; }
    this.spy?.(this.layerId, 'text', text);
    const ctx = this.ctx, font = `${Math.round(size * 100) / 100}px ${STACKS[face]}`;
    if (font !== this.fontKey) { ctx.font = font; this.fontKey = font; }
    if (align !== this.alignKey) { ctx.textAlign = align; this.alignKey = align; }
    this.style(color, alpha);
    ctx.fillText(text, x, snapBaseline(this.m, baseline));
    this.stats.draws++; this.stats.texts++; this.stats.paths++;
  }
}

/** `#rrggbb` as `rgba(r, g, b, a)`. */
export function rgba(hex: string, a: number): string {
  const p = parseInt(hex.slice(1), 16);
  return `rgba(${(p >> 16) & 255}, ${(p >> 8) & 255}, ${p & 255}, ${clamp01(a)})`;
}
export { FONT, ICON_SIZE, textCells };
