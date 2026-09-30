/** Render-resolution policy for the shared Player: how many pixels a preset renders, how they reach the display and how a
 * design canvas is laid out and snapped. Pure and deterministic: no DOM, no clocks, no random source. The policy functions
 * (resolveRender, fitWithin, surfaceMetrics, strokePx, transitionSurface, describeResolved) are total: NaN, zero, negative and huge
 * inputs return a finite, valid result and nothing throws. The snapping helpers are plain arithmetic on the caller's drawing
 * coordinates: finite coordinates in, finite coordinates out.
 *
 * Proposed in docs/design/RESOLUTION-PIPELINE.md (section 5) and fixed by docs/design/CONTRACT.md 2.3.1. CPU-checked by
 * tools/check-render-resolution.mjs; nothing here has been seen on a display.
 *
 * - AVS `classic` (the default) reproduces the shipped rule bit for bit: a 640-wide surface, the height following the view up to
 *   640, and a present canvas of round(css * min(dpr, 1920/cssW, 1080/cssH)). Only CSS pixels and the DPR are read.
 * - NERV and vector HUD scenes render at device resolution, capped by a quality tier, and are presented 1:1 with smoothing.
 * - Pixel-art HUD scenes render on their native grid and are presented with integer nearest-neighbour scaling where it fits.
 * - `crisp` and `high` AVS delegate to the Studio policy in avs-presentation.ts (opt-in).
 * The module imports the Studio helpers and never modifies them. */
import { AvsFrameGovernor, avsPresentationLayout, type AvsResolutionMode } from './avs-presentation.ts';

// ---------------------------------------------------------------- vocabulary

/** Design canvas of every NERV scene (its drawing coordinates). Re-exported by nerv-scenes.ts. */
export const NERV_DESIGN: Readonly<{ width: 960; height: 540 }> = Object.freeze({ width: 960, height: 540 });

export type RenderKind = 'nerv' | 'hud' | 'avs';
export type QualityTier = 'auto' | 'performance' | 'balanced' | 'high' | 'native';
export type FixedTier = Exclude<QualityTier, 'auto'>;
export type PixelArtScaling = 'auto' | 'integer' | 'smooth';
export type Smoothing = 'nearest' | 'bilinear' | 'sharp-bilinear';

export interface Size { readonly width: number; readonly height: number }
/** A rectangle in device pixels. `x`/`y` are negative only for AVS `crisp`, whose integer cover overscans and is cropped by the canvas. */
export interface Box { readonly x: number; readonly y: number; readonly width: number; readonly height: number }
export interface TierSpec { readonly maxEdge: number; readonly maxPixels: number }

/** Fixed tiers in ascending cost; `auto` is resolved to one of them. */
export const FIXED_TIERS: readonly FixedTier[] = Object.freeze(['performance', 'balanced', 'high', 'native'] as const);
export const TIERS: Readonly<Record<FixedTier, TierSpec>> = Object.freeze({
  performance: Object.freeze({ maxEdge: 1280, maxPixels: 1280 * 720 }),
  balanced: Object.freeze({ maxEdge: 1920, maxPixels: 1920 * 1080 }),
  high: Object.freeze({ maxEdge: 2560, maxPixels: 2560 * 1440 }),
  native: Object.freeze({ maxEdge: 3840, maxPixels: 3840 * 2160 }),
});
/** Auto starts here and never rises above it; Native is always an explicit choice. */
export const AUTO_CEILING: FixedTier = 'high';
export const HARD_MAX_EDGE = 4096, HARD_MAX_PIXELS = 3840 * 2160, MIN_EDGE = 64;
/** The shipped AVS rule (mpc-host.ts before the resolution work): kept so `classic` stays bit-identical. */
export const LEGACY_AVS = { width: 640, maxHeight: 640, presentMaxWidth: 1920, presentMaxHeight: 1080 } as const;

/** Pixel aspect (width / height of one source pixel, default 1) must come from authored data; kit metadata cannot supply it. */
export interface PixelGrid { readonly width: number; readonly height: number; readonly par?: number }
export interface SceneTraits {
  /** Design canvas; NERV_DESIGN (960x540) when absent. */
  readonly logical?: Size;
  /** Present => a retro pixel-art scene (`hud` only). */
  readonly pixelGrid?: PixelGrid | null;
}
export interface Budget { readonly maxPixels?: number; readonly maxBytes?: number; readonly surfaces?: number }

export interface ResolveInput {
  readonly kind: RenderKind;
  readonly cssWidth: number; readonly cssHeight: number; readonly dpr: number;
  /** Exact device-pixel content box from ResizeObserver when available; wins over cssSize * dpr for every kind except AVS `classic`. */
  readonly deviceWidth?: number; readonly deviceHeight?: number;
  readonly tier: QualityTier;
  /** The governor's current tier when `tier === 'auto'` (default AUTO_CEILING; never above it). */
  readonly autoTier?: FixedTier;
  readonly traits?: SceneTraits;
  readonly pixelArt?: PixelArtScaling;
  /** Kind `avs`; default classic. `scale` is the Studio High tier (2, 1.5 or 1; default 2). */
  readonly avs?: { readonly mode: AvsResolutionMode; readonly scale?: number };
  readonly budget?: Budget;
}

export interface ResolvedRender {
  readonly kind: RenderKind;
  /** Effective tier with Auto resolved. Pixel-art scenes report `native` (only the hard caps apply); AVS reports the tier whose
   * present cap matches (`balanced` for classic and high, `native` for crisp). It is a label, never a user setting. */
  readonly tier: QualityTier;
  /** Worker surface -> AvsWorkerRenderMessage.width/height. */
  readonly render: Size;
  /** Display canvas backing store. */
  readonly canvas: Size;
  /** Where the render surface is drawn on the canvas (device px, integers). Clear the canvas first when the box does not cover it. */
  readonly box: Box;
  readonly smoothing: Smoothing;
  readonly cssImageRendering: 'auto' | 'pixelated';
  /** Vertical factor k when render -> box is an exact nearest enlargement (the horizontal factor is box.width / render.width and
   * differs only for a non-square pixel aspect). */
  readonly integerScale: number | null;
  /** Nearest prescale before the final resample (sharp-bilinear only, else 1). */
  readonly prescale: number;
  /** Device px per render px, telemetry only. */
  readonly presentScale: number;
  /** Design-canvas metrics for scenes; null for AVS. */
  readonly metrics: SurfaceMetrics | null;
  /** Stable identity of everything a presenter or worker must react to (sizes, box, smoothing, prescale, design canvas). It excludes
   * `tier` and the telemetry, so a tier change that alters nothing on screen changes nothing. */
  readonly key: string;
}

// ---------------------------------------------------------------- helpers

const finiteOr = (value: unknown, fallback: number): number => typeof value === 'number' && Number.isFinite(value) ? value : fallback;
const nonNegative = (value: unknown): number => typeof value === 'number' && Number.isFinite(value) && value > 0 ? value : 0;
const clamp = (value: number, low: number, high: number): number => value < low ? low : value > high ? high : value;
/** Largest CSS size the vector paths accept before the device size is capped anyway; keeps every product finite. */
const MAX_CSS = 1e6;

function tierIndex(tier: FixedTier): number { return FIXED_TIERS.indexOf(tier); }
function isFixedTier(value: unknown): value is FixedTier { return typeof value === 'string' && (FIXED_TIERS as readonly string[]).includes(value); }

/** Auto never exceeds the ceiling, whatever a governor reports. */
function effectiveTier(tier: unknown, autoTier: unknown): FixedTier {
  if (isFixedTier(tier)) return tier;
  const requested = isFixedTier(autoTier) ? autoTier : AUTO_CEILING;
  return tierIndex(requested) > tierIndex(AUTO_CEILING) ? AUTO_CEILING : requested;
}

/**
 * Uniform fit of (width, height) inside a long-edge cap and a pixel cap. Never enlarges; both axes are floored so rounding cannot
 * break either cap, and no axis drops below MIN_EDGE (a degenerate window is not worth an aspect-exact surface). Invalid caps fall
 * back to the hard caps.
 */
export function fitWithin(width: number, height: number, maxEdge: number, maxPixels: number): Size {
  const edge = nonNegative(maxEdge) || HARD_MAX_EDGE, pixels = nonNegative(maxPixels) || HARD_MAX_PIXELS;
  const w = Math.max(1, nonNegative(width) || 1), h = Math.max(1, nonNegative(height) || 1);
  const f = Math.min(1, edge / Math.max(w, h), Math.sqrt(pixels / (w * h)));
  // The epsilon absorbs f * w landing at 2559.9999999999995 for an exact 2560.
  let rw = Math.max(MIN_EDGE, f >= 1 ? Math.round(w) : Math.floor(w * f + 1e-9));
  let rh = Math.max(MIN_EDGE, f >= 1 ? Math.round(h) : Math.floor(h * f + 1e-9));
  // Re-prove both caps after rounding and the MIN_EDGE floor (a 20000x10 view floors its short axis up to 64, which can push the
  // product over the cap): shrink the free axis, or the larger one when neither is pinned. A step or two at most.
  while ((rw * rh > pixels || Math.max(rw, rh) > edge) && (rw > MIN_EDGE || rh > MIN_EDGE)) {
    if (rh <= MIN_EDGE) rw = Math.max(MIN_EDGE, Math.min(rw - 1, Math.floor(Math.min(edge, pixels / rh))));
    else if (rw <= MIN_EDGE) rh = Math.max(MIN_EDGE, Math.min(rh - 1, Math.floor(Math.min(edge, pixels / rw))));
    else if (rw >= rh) rw--;
    else rh--;
  }
  return { width: rw, height: rh };
}

function deviceSize(cssW: number, cssH: number, dpr: number, deviceWidth: unknown, deviceHeight: unknown): Size {
  const okW = typeof deviceWidth === 'number' && Number.isFinite(deviceWidth) && deviceWidth >= 1;
  const okH = typeof deviceHeight === 'number' && Number.isFinite(deviceHeight) && deviceHeight >= 1;
  return {
    width: clamp(Math.round(okW && okH ? deviceWidth as number : Math.min(cssW, MAX_CSS) * dpr), 1, 1 << 20),
    height: clamp(Math.round(okW && okH ? deviceHeight as number : Math.min(cssH, MAX_CSS) * dpr), 1, 1 << 20),
  };
}

/** DPR outside 0.25..16 is not a real display; clamped (wider than the design's 0.5..8 so a zoomed-out browser still maps to true device pixels). */
const sanitizeDpr = (dpr: unknown): number => clamp(finiteOr(dpr, 1) || 1, 0.25, 16);

// ---------------------------------------------------------------- AVS

/**
 * The shipped rule, verbatim (the arithmetic order matters for bit-identical rounding):
 *   width = 640, height = max(64, min(640, round(640 * cssH / max(1, cssW))))
 *   scale = min(dpr || 1, 1920 / max(1, cssW), 1080 / max(1, cssH)), canvas = max(1, round(css * scale))
 * Only CSS pixels and the DPR are read. A DPR of 0 or NaN is 1, exactly as `|| 1` did; a negative DPR (which no browser reports, and
 * which made the shipped code produce a 1x1 canvas or NaN) is 1 as well, so the result is always finite.
 */
function classicSurfaces(cssW: number, cssH: number, dpr: number): { render: Size; canvas: Size } {
  const height = Math.max(MIN_EDGE, Math.min(LEGACY_AVS.maxHeight, Math.round(LEGACY_AVS.width * cssH / Math.max(1, cssW))));
  const scale = Math.min(dpr > 0 ? dpr : 1, LEGACY_AVS.presentMaxWidth / Math.max(1, cssW), LEGACY_AVS.presentMaxHeight / Math.max(1, cssH));
  return {
    render: { width: LEGACY_AVS.width, height },
    canvas: { width: Math.max(1, Math.round(cssW * scale)), height: Math.max(1, Math.round(cssH * scale)) },
  };
}

// The Studio governor is only asked for dimensions(), which depend on its policy and tier scale alone, so one instance per
// (policy, scale) is shared. Scales are quantised to the Studio High tiers, which bounds the cache.
const avsGovernors = new Map<string, AvsFrameGovernor>();
function avsDimensions(policy: 'integer' | 'fit', scale: number, width: number, height: number): Size {
  const key = `${policy}:${scale}`;
  let governor = avsGovernors.get(key);
  if (!governor) {
    governor = new AvsFrameGovernor({ tiers: [{ scale, fps: 60 }], initialTier: 0, dimensionsPolicy: policy });
    avsGovernors.set(key, governor);
  }
  return governor.dimensions(width, height);
}
const quantiseHighScale = (scale: unknown): number => { const s = finiteOr(scale, 2); return s >= 1.75 ? 2 : s >= 1.25 ? 1.5 : 1; };

function finish(r: Omit<ResolvedRender, 'key'>): ResolvedRender {
  const m = r.metrics;
  const key = [r.kind, r.render.width, r.render.height, r.canvas.width, r.canvas.height, r.box.x, r.box.y, r.box.width, r.box.height,
    r.smoothing, r.cssImageRendering, r.integerScale ?? '-', r.prescale, m ? `${m.logicalWidth}x${m.logicalHeight}` : '-'].join('|');
  return Object.freeze({ ...r, key });
}

function resolveAvs(i: Partial<ResolveInput>, cssW: number, cssH: number): ResolvedRender {
  const mode: AvsResolutionMode = i.avs?.mode === 'crisp' || i.avs?.mode === 'high' ? i.avs.mode : 'classic';
  const rawDpr = typeof i.dpr === 'number' && !Number.isNaN(i.dpr) ? i.dpr : 1;
  const classic = classicSurfaces(cssW, cssH, rawDpr);
  if (mode === 'classic') {
    const dw = Math.max(1, Math.round(Math.min(cssW, MAX_CSS) * sanitizeDpr(rawDpr)));
    return finish({
      kind: 'avs', tier: 'balanced', render: classic.render, canvas: classic.canvas,
      box: { x: 0, y: 0, ...classic.canvas }, smoothing: 'nearest', cssImageRendering: 'pixelated',
      integerScale: null, prescale: 1, presentScale: dw / classic.render.width, metrics: null,
    });
  }
  const device = deviceSize(cssW, cssH, sanitizeDpr(rawDpr), i.deviceWidth, i.deviceHeight);
  if (mode === 'crisp') {
    const shown = fitWithin(device.width, device.height, HARD_MAX_EDGE, HARD_MAX_PIXELS);
    const render = avsDimensions('integer', 1, shown.width, shown.height);
    const layout = avsPresentationLayout('pixelated', render.width, render.height, shown.width, shown.height, true);
    const box = layout.box ?? { left: 0, top: 0, width: shown.width, height: shown.height };
    return finish({
      kind: 'avs', tier: 'native', render, canvas: shown, box: { x: box.left, y: box.top, width: box.width, height: box.height },
      smoothing: 'nearest', cssImageRendering: 'pixelated', integerScale: Math.round(box.width / render.width), prescale: 1,
      presentScale: box.width / render.width, metrics: null,
    });
  }
  const render = avsDimensions('fit', quantiseHighScale(i.avs?.scale), device.width, device.height);
  return finish({
    kind: 'avs', tier: 'balanced', render, canvas: classic.canvas, box: { x: 0, y: 0, ...classic.canvas },
    smoothing: 'nearest', cssImageRendering: 'pixelated', integerScale: null, prescale: 1, presentScale: device.width / render.width, metrics: null,
  });
}

// ---------------------------------------------------------------- scenes

/** Design canvases are authored (catalog canvases are 64..1920) and surfaces are at most a few thousand pixels; these bounds only exist so
 * garbage (a 5e-324 design canvas made w / lw overflow to Infinity and the letterbox offsets NaN) still produces finite, positive metrics. */
const LOGICAL_MAX = 1e6, SURFACE_MAX = 1e7;

function sanitizeLogical(logical: Size | undefined): Size {
  const w = finiteOr(logical?.width, 0), h = finiteOr(logical?.height, 0);
  return w > 0 && h > 0 ? { width: clamp(w, 1, LOGICAL_MAX), height: clamp(h, 1, LOGICAL_MAX) } : NERV_DESIGN;
}

function sanitizeGrid(grid: PixelGrid | null | undefined): { width: number; height: number; par: number } | null {
  if (!grid || typeof grid !== 'object') return null;
  const w = finiteOr(grid.width, 0), h = finiteOr(grid.height, 0);
  if (w < 1 || h < 1) return null;
  // Catalog grids are 64..1920; anything past the hard caps is shrunk uniformly so no surface can exceed them.
  const f = Math.min(1, HARD_MAX_EDGE / Math.max(w, h), Math.sqrt(HARD_MAX_PIXELS / (w * h)));
  return { width: Math.max(1, Math.floor(w * f)), height: Math.max(1, Math.floor(h * f)), par: clamp(finiteOr(grid.par, 1) || 1, 1 / 16, 16) };
}

/** Pixel-art rule of RES 5.4: integer nearest scaling where at most 20 percent of the display is lost, else sharp-bilinear. */
function resolvePixelArt(kind: RenderKind, grid: { width: number; height: number; par: number }, mode: PixelArtScaling, canvas: Size): ResolvedRender {
  const { width: gw, height: gh, par } = grid;
  const kFit = Math.min(canvas.width / (gw * par), canvas.height / gh);
  const kInt = Math.floor(kFit + 1e-9);
  const centred = (width: number, height: number): Box => {
    const bw = clamp(width, 1, canvas.width), bh = clamp(height, 1, canvas.height);
    return { x: Math.floor((canvas.width - bw) / 2), y: Math.floor((canvas.height - bh) / 2), width: bw, height: bh };
  };
  const base = { kind, tier: 'native' as const, render: { width: gw, height: gh }, canvas, cssImageRendering: 'pixelated' as const, metrics: surfaceMetrics(gw, gh, gw, gh) };
  const smoothBox = (): Box => centred(Math.round(gw * par * kFit), Math.round(gh * kFit));
  if (kInt >= 1) {
    // Horizontal factor for a non-square pixel: exact only within 0.02 of an integer; 'integer' rounds regardless.
    const kx = (k: number): number => Math.max(1, Math.round(k * par));
    const exact = Math.abs(kInt * par - kx(kInt)) <= 0.02;
    const coverage = (kx(kInt) * gw * kInt * gh) / (canvas.width * canvas.height);
    if ((mode === 'auto' && exact && kx(kInt) * gw <= canvas.width && coverage >= 0.8) || mode === 'integer') {
      let k = kInt;
      while (k > 1 && kx(k) * gw > canvas.width) k--;
      if (kx(k) * gw <= canvas.width) {
        const box = centred(kx(k) * gw, k * gh);
        return finish({ ...base, box, smoothing: 'nearest', integerScale: k, prescale: 1, presentScale: box.height / gh });
      }
    }
    const box = smoothBox();
    return finish({ ...base, box, smoothing: 'sharp-bilinear', integerScale: null, prescale: kInt, presentScale: box.height / gh });
  }
  // The display is smaller than the grid: an aspect-preserving smooth shrink.
  const box = smoothBox();
  return finish({ ...base, box, smoothing: 'bilinear', integerScale: null, prescale: 1, presentScale: box.height / gh });
}

/**
 * Resolve every surface a preset needs for the current view. Total: never throws. See the file header for the per-kind rules and
 * docs/design/RESOLUTION-PIPELINE.md 5.2-5.4 for the tables.
 */
export function resolveRender(input: ResolveInput): ResolvedRender {
  const i = (input && typeof input === 'object' ? input : {}) as Partial<ResolveInput>;
  const kind: RenderKind = i.kind === 'nerv' || i.kind === 'hud' || i.kind === 'avs' ? i.kind : 'avs';
  const cssW = nonNegative(i.cssWidth), cssH = nonNegative(i.cssHeight);
  if (kind === 'avs') return resolveAvs(i, cssW, cssH);
  const device = deviceSize(cssW, cssH, sanitizeDpr(i.dpr), i.deviceWidth, i.deviceHeight);
  const budget = i.budget && typeof i.budget === 'object' ? i.budget : {};
  // A budget can shrink the surface but never below a MIN_EDGE square.
  const floorPixels = MIN_EDGE * MIN_EDGE;
  let maxPixels = Math.min(HARD_MAX_PIXELS, Math.max(floorPixels, nonNegative(budget.maxPixels) || Infinity));
  const bytes = nonNegative(budget.maxBytes);
  if (bytes) maxPixels = Math.min(maxPixels, Math.max(floorPixels, Math.floor(bytes / (4 * Math.max(1, Math.floor(finiteOr(budget.surfaces, 1)))))));
  const grid = kind === 'hud' ? sanitizeGrid(i.traits?.pixelGrid) : null;
  if (grid) {
    const mode: PixelArtScaling = i.pixelArt === 'integer' || i.pixelArt === 'smooth' ? i.pixelArt : 'auto';
    return resolvePixelArt(kind, grid, mode, fitWithin(device.width, device.height, HARD_MAX_EDGE, maxPixels));
  }
  const tier = effectiveTier(i.tier, i.autoTier);
  const spec = TIERS[tier];
  const render = fitWithin(device.width, device.height, Math.min(spec.maxEdge, HARD_MAX_EDGE), Math.min(spec.maxPixels, maxPixels));
  const logical = sanitizeLogical(i.traits?.logical);
  return finish({
    kind, tier, render, canvas: render, box: { x: 0, y: 0, ...render }, smoothing: 'bilinear', cssImageRendering: 'auto',
    integerScale: null, prescale: 1, presentScale: device.width / render.width, metrics: surfaceMetrics(render.width, render.height, logical.width, logical.height),
  });
}

// ---------------------------------------------------------------- design canvas

/** Where a logical (lw x lh) design canvas sits inside a (width x height) surface: uniform scale, integer letterbox offsets. */
export interface SurfaceMetrics {
  readonly width: number; readonly height: number;
  readonly logicalWidth: number; readonly logicalHeight: number;
  /** min(width / lw, height / lh): device px per logical unit. */
  readonly scale: number;
  readonly offsetX: number; readonly offsetY: number;
  readonly contentWidth: number; readonly contentHeight: number;
}

export function surfaceMetrics(width: number, height: number, logicalWidth: number, logicalHeight: number): SurfaceMetrics {
  const w = clamp(nonNegative(width) || 1, 1, SURFACE_MAX), h = clamp(nonNegative(height) || 1, 1, SURFACE_MAX);
  const lw = clamp(nonNegative(logicalWidth) || NERV_DESIGN.width, 1, LOGICAL_MAX), lh = clamp(nonNegative(logicalHeight) || NERV_DESIGN.height, 1, LOGICAL_MAX);
  const scale = Math.min(w / lw, h / lh);
  return {
    width: w, height: h, logicalWidth: lw, logicalHeight: lh, scale,
    // `|| 0` folds -0 (a centred axis whose slack rounds to -0) into 0.
    offsetX: Math.round((w - lw * scale) / 2) || 0, offsetY: Math.round((h - lh * scale) / 2) || 0,
    contentWidth: Math.round(lw * scale), contentHeight: Math.round(lh * scale),
  };
}

/** Device pixels for a logical stroke width: an integer, never thinner than one device pixel. */
export function strokePx(m: SurfaceMetrics, logicalWidth: number): number {
  return Math.max(1, Math.round(Math.min(nonNegative(logicalWidth), LOGICAL_MAX) * m.scale));
}

const offsetOf = (m: SurfaceMetrics, axis: 'x' | 'y'): number => axis === 'x' ? m.offsetX : m.offsetY;

/** Logical coordinate for the centre of a `px`-wide stroke whose two edges both land on device pixels. Moves the centre by at most half a device pixel plus the width rounding. */
export function snapStroke(m: SurfaceMetrics, axis: 'x' | 'y', v: number, px: number): number {
  const s = m.scale, o = offsetOf(m, axis);
  return (Math.round(v * s + o - px / 2) + px / 2 - o) / s;
}

/**
 * [start, length] in logical units of a fill from `v` to `v + length` with both edges on device pixels. A positive length keeps
 * at least one device pixel. Adjacent spans that share the same edge expression round identically, so they neither overlap nor leave a seam.
 */
export function snapSpan(m: SurfaceMetrics, axis: 'x' | 'y', v: number, length: number): readonly [number, number] {
  const s = m.scale, o = offsetOf(m, axis);
  const a = Math.round(v * s + o), b = Math.max(a + (length > 0 ? 1 : 0), Math.round((v + length) * s + o));
  return [(a - o) / s, (b - a) / s];
}

/** Logical y of a text baseline moved onto a device pixel row. */
export function snapBaseline(m: SurfaceMetrics, y: number): number {
  const s = m.scale, o = m.offsetY;
  return (Math.round(y * s + o) - o) / s;
}

export interface TransformLike { translate(x: number, y: number): void; scale(x: number, y: number): void; beginPath(): void; rect(x: number, y: number, w: number, h: number): void; clip(): void }

/** Translate to the letterbox offset, scale to design units and clip to the design rectangle, whose edges sit on device pixels. The caller owns save/restore. */
export function applyDesignTransform(c: TransformLike, m: SurfaceMetrics): void {
  c.translate(m.offsetX, m.offsetY);
  c.scale(m.scale, m.scale);
  c.beginPath();
  c.rect(0, 0, m.contentWidth / m.scale, m.contentHeight / m.scale);
  c.clip();
}

// ---------------------------------------------------------------- Auto governor

export interface QualityGovernorOptions {
  ceiling?: FixedTier; floor?: FixedTier; targetFps?: number; downSamples?: number; upSamples?: number; dwellMs?: number; warmup?: number;
}

/** How long a tier stays banned after the governor leaves it, so a marginal machine cannot oscillate. */
export const GOVERNOR_BAN_MS = 60000;

/**
 * Picks a FixedTier from measured frame cost (Auto mode). Starting-point constants, to be calibrated at runtime: a sample is
 * overloaded above one frame interval (or when the EMA exceeds 0.75 of it) and has headroom under 0.5 (EMA under 0.35); 12
 * overloaded samples step down, 600 headroom samples step up, at least `dwellMs` apart, never into a tier left within the last minute,
 * with 30 warm-up samples after every change. It never rises above AUTO_CEILING, so it never selects Native.
 */
export class QualityGovernor {
  private readonly ceiling: number;
  private readonly floor: number;
  private readonly interval: number;
  private readonly downSamples: number;
  private readonly upSamples: number;
  private readonly dwellMs: number;
  private readonly warmup: number;
  private index: number;
  private ema = 0;
  private samples = 0;
  private over = 0;
  private headroom = 0;
  private skip: number;
  private lastChange = -Infinity;
  private readonly banned = new Map<number, number>();

  constructor(options: QualityGovernorOptions = {}) {
    const ceiling = tierIndex(isFixedTier(options.ceiling) ? options.ceiling : AUTO_CEILING);
    this.ceiling = Math.min(ceiling, tierIndex(AUTO_CEILING));
    this.floor = Math.min(this.ceiling, isFixedTier(options.floor) ? tierIndex(options.floor) : 0);
    this.interval = 1000 / clamp(finiteOr(options.targetFps, 60) || 60, 1, 1000);
    this.downSamples = Math.max(1, Math.trunc(finiteOr(options.downSamples, 12)));
    this.upSamples = Math.max(1, Math.trunc(finiteOr(options.upSamples, 600)));
    this.dwellMs = Math.max(0, finiteOr(options.dwellMs, 4000));
    this.warmup = Math.max(0, Math.trunc(finiteOr(options.warmup, 30)));
    this.index = this.ceiling;
    this.skip = this.warmup;
  }

  get tier(): FixedTier { return FIXED_TIERS[this.index]!; }

  /** Back to the ceiling with no history (a new device, a preference change, a new session). */
  reset(): void {
    this.index = this.ceiling;
    this.banned.clear();
    this.lastChange = -Infinity;
    this.settle();
  }

  /** Feed one frame cost in ms at time `nowMs`; true when the tier changed. Invalid samples are ignored. */
  record(frameMs: number, nowMs: number): boolean {
    if (!(frameMs >= 0) || !Number.isFinite(frameMs) || !Number.isFinite(nowMs)) return false;
    if (this.skip > 0) { this.skip--; return false; }
    this.ema = this.samples++ === 0 ? frameMs : this.ema * 0.85 + frameMs * 0.15;
    const overloaded = frameMs > this.interval || this.ema > this.interval * 0.75;
    const roomy = frameMs < this.interval * 0.5 && this.ema < this.interval * 0.35;
    this.over = overloaded ? this.over + 1 : Math.max(0, this.over - 1);
    this.headroom = roomy ? this.headroom + 1 : 0;
    if (nowMs - this.lastChange < this.dwellMs) return false;
    if (this.over >= this.downSamples && this.index > this.floor) {
      this.banned.set(this.index, nowMs + GOVERNOR_BAN_MS);
      return this.move(this.index - 1, nowMs);
    }
    if (this.headroom >= this.upSamples && this.index < this.ceiling && (this.banned.get(this.index + 1) ?? -Infinity) <= nowMs) {
      return this.move(this.index + 1, nowMs);
    }
    return false;
  }

  private move(index: number, nowMs: number): boolean {
    this.index = index;
    this.lastChange = nowMs;
    this.settle();
    return true;
  }

  private settle(): void { this.ema = 0; this.samples = 0; this.over = 0; this.headroom = 0; this.skip = this.warmup; }
}

// ---------------------------------------------------------------- display settings and host glue

/** The three device-local resolution preferences (mpc-display.ts adds the FPS and timing-overlay ones). */
export interface DisplaySettings { readonly quality: QualityTier; readonly avsResolution: AvsResolutionMode; readonly pixelArt: PixelArtScaling }
export const DEFAULT_DISPLAY: DisplaySettings = Object.freeze({ quality: 'auto', avsResolution: 'classic', pixelArt: 'auto' });

/**
 * Surface for a main-thread transition between two slots (a = outgoing, b = incoming): the larger of the two render sizes by
 * area, ties to the incoming side. Smoothing is on when either side is a scene kind; the smaller side is enlarged by the
 * transition's own scaled draws.
 */
export function transitionSurface(a: { render: Size; kind: RenderKind }, b: { render: Size; kind: RenderKind }): { size: Size; smooth: boolean } {
  const area = (s: Size): number => s.width * s.height;
  const pick = area(a.render) > area(b.render) ? a.render : b.render;
  return { size: { width: pick.width, height: pick.height }, smooth: a.kind !== 'avs' || b.kind !== 'avs' };
}

/** One line for announcements and the FPS detail overlay, for example "NERV 1920x1080 - scale 2.00 - high". */
export function describeResolved(r: ResolvedRender): string {
  const size = `${r.render.width}x${r.render.height}`;
  if (r.kind === 'avs') return `AVS ${size} - ${r.integerScale ? `integer x${r.integerScale}` : `x${r.presentScale.toFixed(2)}`}`;
  if (r.cssImageRendering === 'pixelated') {   // pixel-art HUD: the surface is the native grid
    if (r.smoothing === 'nearest') return `HUD ${size} - integer x${r.integerScale ?? 1}`;
    return `HUD ${size} - ${r.smoothing === 'sharp-bilinear' ? `sharp-bilinear x${r.prescale}` : `smooth x${r.presentScale.toFixed(2)}`}`;
  }
  return `${r.kind === 'nerv' ? 'NERV' : 'HUD'} ${size} - scale ${(r.metrics?.scale ?? 1).toFixed(2)} - ${r.tier}`;
}
