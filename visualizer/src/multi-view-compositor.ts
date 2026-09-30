/** Canvas presentation only: pane and layout motion never run or mutate a preset. */
import { AvsTransition, hash32, normalizeEnv, transitionProgress, type TransitionEnv } from './mpc-transition.ts';
import { multiViewPixelRects, type MultiViewBorder, type MultiViewLayout, type MultiViewMotion, type MultiViewPane, type MultiViewRect } from './multi-view-model.ts';
type Context = CanvasRenderingContext2D | OffscreenCanvasRenderingContext2D;
type Surface = HTMLCanvasElement | OffscreenCanvas;
export interface MultiViewPlate { readonly image: CanvasImageSource; readonly width: number; readonly height: number; readonly smooth?: boolean }
export interface MultiViewPaneImage {
  readonly current: MultiViewPlate | null;
  readonly outgoing?: MultiViewPlate | null;
  readonly progress?: number;
  readonly seed?: number;
  readonly transition?: number | MultiViewMotion;
  readonly env?: Partial<TransitionEnv>;
}
export interface MultiViewComposition {
  readonly layout: MultiViewLayout;
  readonly count: number;
  readonly width: number;
  readonly height: number;
  readonly panes: readonly MultiViewPane[];
  readonly images: readonly MultiViewPaneImage[];
  readonly border: MultiViewBorder;
  readonly gutter: number;
  readonly beat: number;
  readonly level: number;
  readonly reducedMotion: boolean;
  readonly previousLayout?: MultiViewLayout;
  readonly previousCount?: number;
  readonly layoutProgress?: number;
  readonly layoutMotion?: MultiViewMotion;
}
const unit = (v: number | undefined) => Math.min(1, Math.max(0, Number.isFinite(v) ? v! : 0));
function fit(c: Context, plate: MultiViewPlate, box: MultiViewRect, mode: MultiViewPane['fit']) {
  if (!(plate.width > 0 && plate.height > 0 && Number.isFinite(plate.width) && Number.isFinite(plate.height) && box.width > 0 && box.height > 0)) return;
  c.imageSmoothingEnabled = plate.smooth !== false;
  const scale = mode === 'cover' ? Math.max(box.width / plate.width, box.height / plate.height) : Math.min(box.width / plate.width, box.height / plate.height);
  const w = mode === 'stretch' ? box.width : plate.width * scale, h = mode === 'stretch' ? box.height : plate.height * scale;
  c.drawImage(plate.image, box.x + (box.width - w) / 2, box.y + (box.height - h) / 2, w, h);
}
function clip(c: Context, b: MultiViewRect) { c.beginPath(); c.rect(b.x, b.y, b.width, b.height); c.clip(); }
function shifted(b: MultiViewRect, dx: number, dy: number): MultiViewRect { return { ...b, x: b.x + dx, y: b.y + dy }; }
function lerp(a: MultiViewRect, b: MultiViewRect, t: number): MultiViewRect { return { x: a.x + (b.x - a.x) * t, y: a.y + (b.y - a.y) * t, width: a.width + (b.width - a.width) * t, height: a.height + (b.height - a.height) * t }; }
export function drawMultiViewBorder(c: Context, box: MultiViewRect, border: MultiViewBorder, beat: number, level: number, reduced: boolean) {
  if (border.style === 'none' || !(border.width > 0) || box.width <= 0 || box.height <= 0) return;
  const energy = reduced ? 0 : unit(level), phase = reduced || !Number.isFinite(beat) ? 0 : beat - Math.floor(beat);
  const thickness = Math.min(box.width / 2, box.height / 2, border.width * (border.style === 'pulse' ? 1 + energy * .75 : 1));
  c.fillStyle = border.color;
  c.globalAlpha = border.style === 'pulse' && !reduced ? .65 + .35 * (1 - phase) : 1;
  const b = box, k = thickness;
  c.fillRect(b.x, b.y, b.width, k); c.fillRect(b.x, b.y + b.height - k, b.width, k);
  c.fillRect(b.x, b.y + k, k, Math.max(0, b.height - 2 * k)); c.fillRect(b.x + b.width - k, b.y + k, k, Math.max(0, b.height - 2 * k));
  if (border.style === 'chase' && !reduced) {
    c.globalAlpha = .85; c.fillStyle = '#eafaff';
    const length = Math.min(b.width, b.height) * .15, cursor = phase * 4, edge = Math.floor(cursor), p = cursor - edge;
    if (edge === 0) c.fillRect(b.x + (b.width - length) * p, b.y, length, k);
    else if (edge === 1) c.fillRect(b.x + b.width - k, b.y + (b.height - length) * p, k, length);
    else if (edge === 2) c.fillRect(b.x + (b.width - length) * (1 - p), b.y + b.height - k, length, k);
    else c.fillRect(b.x, b.y + (b.height - length) * (1 - p), k, length);
  }
  c.globalAlpha = 1;
}
interface Cache { width: number; height: number; surfaces: readonly [Surface, Surface, Surface]; transition: AvsTransition | null; key: string; owned: Surface[] }
/** Byte ceiling for numeric-transition scratch storage across all panes (RGBA, modelled below). */
export const MULTI_VIEW_SCRATCH_BYTES = 96 * 1024 * 1024;
/** Surfaces modelled per active numeric fade: old, new and output planes plus the transition's own mask and tile. */
export const MULTI_VIEW_SCRATCH_PLANES = 5;
/**
 * Create surfaces lazily through the host, only for panes whose numeric (AVS-style) fade is running. A pane's cache is released on the
 * first frame its fade is no longer running, and the planes of every running fade share MULTI_VIEW_SCRATCH_BYTES: a fade whose full-size
 * planes would not fit renders at a reduced scratch resolution and is scaled into its pane.
 */
export class MultiViewCompositor {
  private readonly cache = new Map<number, Cache>();
  private active = 1;
  constructor(private readonly createCanvas: (width: number, height: number) => Surface) {}
  clear() { for (const pane of [...this.cache.keys()]) this.release(pane); }
  /** Modelled bytes currently retained by scratch planes. */
  get scratchBytes() { let bytes = 0; for (const c of this.cache.values()) bytes += c.width * c.height * 4 * MULTI_VIEW_SCRATCH_PLANES; return bytes; }
  private release(pane: number) {
    const cache = this.cache.get(pane); if (!cache) return;
    // Zero-size the planes so the browser can free their backing stores even if a reference lingers elsewhere.
    for (const surface of [...cache.surfaces, ...cache.owned]) { surface.width = 0; surface.height = 0; }
    cache.transition = null; this.cache.delete(pane);
  }
  private scratch(pane: number, width: number, height: number): Cache {
    let w = Math.max(1, Math.round(width)), h = Math.max(1, Math.round(height));
    const budget = MULTI_VIEW_SCRATCH_BYTES / Math.max(1, this.active), need = w * h * 4 * MULTI_VIEW_SCRATCH_PLANES;
    if (need > budget) { const k = Math.sqrt(budget / need); w = Math.max(1, Math.floor(w * k)); h = Math.max(1, Math.floor(h * k)); }
    let cache = this.cache.get(pane);
    if (!cache || cache.width !== w || cache.height !== h) {
      this.release(pane);
      cache = { width: w, height: h, surfaces: [this.createCanvas(w, h), this.createCanvas(w, h), this.createCanvas(w, h)], transition: null, key: '', owned: [] };
      this.cache.set(pane, cache);
    }
    return cache;
  }
  /** True when this pane image needs numeric-transition scratch planes this frame. */
  private numeric(image: MultiViewPaneImage | undefined, options: MultiViewPane | undefined, reduced: boolean) {
    if (!image?.current || !image.outgoing || !options) return false;
    const progress = image.progress === undefined ? 1 : unit(image.progress), mode = image.transition ?? options.transition;
    return progress > 0 && progress < 1 && typeof mode === 'number' && !(reduced && mode !== 15);
  }
  private pane(c: Context, b: MultiViewRect, options: MultiViewPane, image: MultiViewPaneImage, pane: number, reduced: boolean, used?: Set<number>) {
    if (!image.current || b.width <= 0 || b.height <= 0) return;
    c.save(); clip(c, b); c.fillStyle = '#000'; c.fillRect(b.x, b.y, b.width, b.height);
    const current = image.current, old = image.outgoing, progress = image.progress === undefined ? 1 : unit(image.progress), t = transitionProgress(progress);
    let mode = image.transition ?? options.transition;
    if (reduced && mode !== 'cut' && mode !== 15) mode = 'dissolve';
    const paint = (plate: MultiViewPlate, box = b) => fit(c, plate, box, options.fit);
    if (!old || progress >= 1 || mode === 'cut') paint(current);
    else if (progress <= 0) paint(old);
    else if (typeof mode === 'number') {
      const cache = this.scratch(pane, b.width, b.height), local = { x: 0, y: 0, width: cache.width, height: cache.height }; used?.add(pane);
      for (const [i, plate] of [old, current].entries()) { const ctx = cache.surfaces[i]!.getContext('2d') as Context; ctx.clearRect(0, 0, local.width, local.height); ctx.fillStyle = '#000'; ctx.fillRect(0, 0, local.width, local.height); fit(ctx, plate, local, options.fit); }
      const seed = image.seed ?? 1, key = `${mode}:${seed}:${reduced}`;
      if (cache.key !== key) { const owned = cache.owned; for (const surface of owned.splice(0)) { surface.width = 0; surface.height = 0; } cache.key = key; cache.transition = new AvsTransition(mode, { seed, createCanvas: () => { const surface = this.createCanvas(1, 1); owned.push(surface); return surface; }, context: { reducedMotion: reduced, beatsTotal: image.env?.beatsTotal ?? 4, boundary: 0, nervPair: false }, smooth: current.smooth !== false }); }
      cache.transition!.draw(cache.surfaces[2].getContext('2d') as Context, cache.surfaces[0], cache.surfaces[1], progress, local.width, local.height, normalizeEnv({ ...image.env, reducedMotion: reduced }));
      c.drawImage(cache.surfaces[2], b.x, b.y, b.width, b.height);
    } else if (mode === 'dissolve' || mode === 'morph') { paint(old); c.globalAlpha = t; paint(current); c.globalAlpha = 1; }
    else if (mode === 'slide-x' || mode === 'slide-y') {
      const dx = mode === 'slide-x' ? b.width : 0, dy = mode === 'slide-y' ? b.height : 0;
      paint(old, shifted(b, -dx * t, -dy * t)); paint(current, shifted(b, dx * (1 - t), dy * (1 - t)));
    } else if (mode === 'wipe-x' || mode === 'wipe-y') {
      paint(old); c.save(); clip(c, { ...b, width: mode === 'wipe-x' ? b.width * t : b.width, height: mode === 'wipe-y' ? b.height * t : b.height }); paint(current); c.restore();
    } else {
      // A foreshortened card, with a face swap edge-on. Both faces stay readable rather than mirror-writing the back.
      const scale = Math.abs(Math.cos(Math.PI * t));
      if (scale > .001) { c.save(); c.translate(b.x + b.width / 2, b.y + b.height / 2); c.scale(mode === 'flip-x' ? scale : 1, mode === 'flip-y' ? scale : 1);
        c.transform(1, mode === 'flip-x' ? Math.sin(Math.PI * t) * .08 : 0, mode === 'flip-y' ? Math.sin(Math.PI * t) * .08 : 0, 1, 0, 0);
        fit(c, t < .5 ? old : current, { x: -b.width / 2, y: -b.height / 2, width: b.width, height: b.height }, options.fit); c.restore(); }
    }
    c.restore();
  }
  /** Returns the painted pane boxes for pointer picking. Final output must go through the host's FlashGate. */
  draw(c: Context, input: MultiViewComposition): readonly MultiViewRect[] {
    const rects = multiViewPixelRects(input.layout, input.count, input.width, input.height, input.gutter);
    const previous = input.previousLayout ? multiViewPixelRects(input.previousLayout, input.previousCount ?? input.count, input.width, input.height, input.gutter) : rects;
    const progress = input.layoutProgress === undefined ? 1 : unit(input.layoutProgress), t = transitionProgress(progress), mode = input.reducedMotion ? 'dissolve' : input.layoutMotion ?? 'morph';
    c.save(); c.setTransform(1, 0, 0, 1, 0, 0); c.globalAlpha = 1; c.fillStyle = '#000'; c.fillRect(0, 0, input.width, input.height);
    const boxes: MultiViewRect[] = [], used = new Set<number>();
    this.active = 0; for (let i = 0; i < rects.length; i++) if (this.numeric(input.images[i], input.panes[i], input.reducedMotion)) this.active++;
    for (let i = 0; i < rects.length; i++) {
      const target = rects[i]!, from = previous[i] ?? { ...target, width: 0, height: 0 }, options = input.panes[i], image = input.images[i];
      let b = mode === 'morph' && progress < 1 ? lerp(from, target, t) : target;
      if ((mode === 'slide-x' || mode === 'slide-y') && progress < 1) b = shifted(target, mode === 'slide-x' ? input.width * (1 - t) : 0, mode === 'slide-y' ? input.height * (1 - t) : 0);
      boxes.push(b); if (!options || !image) continue;
      if (progress < 1 && mode !== 'morph' && mode !== 'slide-x' && mode !== 'slide-y') {
        // Full layout motion compares the same live panes in both layouts; no extra workers.
        if (mode !== 'flip-x' && mode !== 'flip-y') this.pane(c, from, options, { ...image, outgoing: null, progress: 1 }, i, input.reducedMotion);
        c.save(); if (mode === 'wipe-x' || mode === 'wipe-y') clip(c, { x: 0, y: 0, width: mode === 'wipe-x' ? input.width * t : input.width, height: mode === 'wipe-y' ? input.height * t : input.height });
        if (mode === 'dissolve') c.globalAlpha = t;
        // Card motion at layout level uses a face turn per panel while pane replacement remains independent.
        if (mode === 'flip-x' || mode === 'flip-y') { const scale = Math.abs(Math.cos(Math.PI * t)); const face = t < .5 ? from : target;
          c.translate(face.x + face.width / 2, face.y + face.height / 2); c.scale(mode === 'flip-x' ? scale : 1, mode === 'flip-y' ? scale : 1); c.translate(-face.x - face.width / 2, -face.y - face.height / 2); this.pane(c, face, options, { ...image, outgoing: null }, i, input.reducedMotion); }
        else this.pane(c, target, options, { ...image, outgoing: null }, i, input.reducedMotion);
        c.restore();
      } else this.pane(c, b, options, image, i, input.reducedMotion, used);
      c.save(); clip(c, b); drawMultiViewBorder(c, b, input.border, input.beat + i / 4, input.level, input.reducedMotion); c.restore();
    }
    // Finished (or never started) numeric fades and removed panes release their planes at once.
    for (const pane of [...this.cache.keys()]) if (pane >= rects.length || !used.has(pane)) this.release(pane);
    c.restore(); return boxes;
  }
}
export function multiViewTransitionSeed(seed: number, pane: number, ordinal: number) { return hash32(seed ^ Math.imul(pane + 1, 0x85ebca6b) ^ Math.imul(ordinal + 1, 0x9e3779b1)); }
