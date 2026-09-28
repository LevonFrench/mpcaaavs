/** AVS transition geometry, based on Nullsoft's r_transition.cpp (BSD-3-Clause).
 * See docs/AVS-TRANSITIONS.md and THIRD-PARTY-AVS-TRANSITIONS.txt.
 * Operates on presentation surfaces; preset GPU execution remains unchanged. */
export const TRANSITIONS = ['Random', 'Cross dissolve', 'L/R Push', 'R/L Push', 'T/B Push', 'B/T Push', '9 Random Blocks', 'Split L/R Push', 'L/R to Center Push', 'L/R to Center Squeeze', 'L/R Wipe', 'R/L Wipe', 'T/B Wipe', 'B/T Wipe', 'Dot Dissolve', 'Cut'];
export function transitionProgress(progress: number) { return (1 - Math.cos(Math.max(0, Math.min(1, progress)) * Math.PI)) / 2; }
export function blockOrder(random = Math.random) {
  const blocks = Array.from({ length: 9 }, (_, i) => i);
  for (let i = 8; i > 0; i--) { const j = Math.floor(random() * (i + 1)); [blocks[i], blocks[j]] = [blocks[j]!, blocks[i]!]; }
  return blocks;
}
type TransitionCanvas = HTMLCanvasElement | OffscreenCanvas;
type TransitionContext = CanvasRenderingContext2D | OffscreenCanvasRenderingContext2D;
export interface AvsTransitionOptions {
  /** A stable boundary identity makes Random and block order reproducible after seeks. */
  readonly seed?: number;
  /** Worker callers provide OffscreenCanvas; regular player transitions retain HTML canvases. */
  readonly createCanvas?: () => TransitionCanvas;
}
function seededRandom(seed: number): () => number {
  let state = seed >>> 0;
  return () => {
    state = (state + 0x6d2b79f5) >>> 0;
    let value = Math.imul(state ^ state >>> 15, state | 1);
    value ^= value + Math.imul(value ^ value >>> 7, value | 61);
    return ((value ^ value >>> 14) >>> 0) / 4294967296;
  };
}
function context2d(canvas: TransitionCanvas): TransitionContext {
  const context = canvas.getContext('2d') as TransitionContext | null;
  if (!context) throw Error('Transition canvas unavailable');
  return context;
}
export class AvsTransition {
  private mask: TransitionCanvas;
  private tile: TransitionCanvas;
  readonly order: number[];
  readonly mode: number;
  constructor(mode: number, options: AvsTransitionOptions = {}) {
    const createCanvas = options.createCanvas ?? (() => document.createElement('canvas'));
    this.mask = createCanvas(); this.tile = createCanvas();
    const random = options.seed === undefined ? Math.random : seededRandom(options.seed);
    this.order = blockOrder(random);
    this.mode = mode === 0 ? 1 + Math.floor(random() * 14) : mode;
  }
  draw(ctx: TransitionContext, old: CanvasImageSource, next: CanvasImageSource, progress: number, w: number, h: number) {
    const t = Math.max(0, Math.min(1, progress)), s = transitionProgress(t);
    ctx.globalAlpha = 1; ctx.imageSmoothingEnabled = false;
    const draw = (source: CanvasImageSource, x = 0, y = 0, width = w, height = h) => ctx.drawImage(source, x, y, width, height);
    const clip = (x: number, y: number, width: number, height: number, fn: () => void) => {
      if (width <= 0 || height <= 0) return;
      ctx.save(); ctx.beginPath(); ctx.rect(x, y, width, height); ctx.clip(); fn(); ctx.restore();
    };
    if (t >= 1 || this.mode === 15) { draw(next); return; }
    draw(old);
    const x = Math.floor(s * w), y = Math.floor(s * h), half = Math.floor(s * w / 2);
    switch (this.mode) {
      case 1: ctx.globalAlpha = t; draw(next); ctx.globalAlpha = 1; break;
      case 2: draw(old, x); draw(next, x - w); break;
      case 3: draw(old, -x); draw(next, w - x); break;
      case 4: draw(old, 0, y); draw(next, 0, y - h); break;
      case 5: draw(old, 0, -y); draw(next, 0, h - y); break;
      case 6:
        for (const b of this.order.slice(0, Math.min(9, 1 + Math.floor(t * 255 / 28)))) {
          const left = Math.floor(b % 3 * w / 3), top = Math.floor(Math.floor(b / 3) * h / 3);
          clip(left, top, Math.floor((b % 3 + 1) * w / 3) - left, Math.floor((Math.floor(b / 3) + 1) * h / 3) - top, () => draw(next));
        } break;
      case 7:
        clip(0, 0, w, Math.floor(h / 2), () => { draw(old, x); draw(next, x - w); });
        clip(0, Math.floor(h / 2), w, h - Math.floor(h / 2), () => { draw(old, -x); draw(next, w - x); }); break;
      case 8:
        clip(0, 0, half, h, () => draw(next, half - w / 2));
        clip(w - half, 0, half, h, () => draw(next, w / 2 - half)); break;
      case 9:
        if (half) {
          clip(0, 0, half, h, () => draw(next, 0, 0, half * 2, h));
          clip(w - half, 0, half, h, () => draw(next, w - half * 2, 0, half * 2, h));
        }
        if (w > 2 * half) draw(old, half, 0, w - 2 * half, h); break;
      case 10: clip(0, 0, x, h, () => draw(next)); break;
      case 11: clip(w - x, 0, x, h, () => draw(next)); break;
      case 12: clip(0, 0, w, y, () => draw(next)); break;
      case 13: clip(0, h - y, w, y, () => draw(next)); break;
      case 14: {
        // AVS's stepped, repeating dot grid (not stochastic noise).
        const spacing = (1 << Math.max(0, 4 - Math.floor(s * 5))) + 1;
        this.tile.width = this.tile.height = spacing;
        const tc = context2d(this.tile); tc.fillStyle = '#fff'; tc.fillRect(spacing - 1, spacing - 1, 1, 1);
        this.mask.width = w; this.mask.height = h;
        const mc = context2d(this.mask);
        mc.drawImage(next, 0, 0, w, h); mc.globalCompositeOperation = 'destination-in';
        mc.fillStyle = mc.createPattern(this.tile, 'repeat')!; mc.fillRect(0, 0, w, h);
        draw(this.mask); break;
      }
    }
  }
}
