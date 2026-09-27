// Photosensitivity flash limiter (review 2026-09-25, ux-architect §3.5; owner
// decision 2026-09-26: enforced on the projector, a toggle on the control
// window, opt-in for offline export).
//
// Pure: no DOM, no clock, no allocation per frame. The caller hands in pixels
// and a timestamp (audio clock live, frame index / fps offline) and gets back a
// blend factor. It never touches AVS pixel semantics — the renderer produces
// the frame it always produced, and the limiter only decides how much of it to
// SHOW over the previously displayed frame. Live that is `globalAlpha = blend`
// drawn over the retained canvas; offline it is `limitPackedFrame` below, which
// does the same arithmetic on bytes so the two agree.
//
// The thresholds are WCAG 2.x SC 2.3.1 "Three Flashes or Below Threshold":
//   - general flash: a pair of opposing changes in relative luminance of 10% or
//     more of the maximum, where the darker state is below 0.80;
//   - red flash: a pair of opposing transitions involving a saturated red
//     (R/(R+G+B) >= 0.8 in linear light), each changing (R-G-B)*320 by > 20;
//   - no more than three flashes in any one-second period, counted over an
//     area of 25% of any 10° visual field.
// We do not know the viewing distance, so the whole frame is treated as the
// 10° field. That is conservative for a laptop and not conservative enough for
// a wall-sized projection, which is what 'strict' is for.
//
// The model, and the one approximation in it. The frame is reduced to a grid of
// cells, each summarised by its MEAN sRGB-ENCODED colour; luminance and redness
// are computed from that mean. Averaging encoded values rather than linear ones
// understates the luminance of textured cells slightly (Jensen), but it buys
// something worth more: blending two frames with `globalAlpha` mixes encoded
// values, so the mean of a blended cell is EXACTLY the blend of the means. The
// limiter can therefore predict what the viewer will see for any blend factor
// without rendering it, and the prediction is the state it tracks. Flashes that
// matter are large uniform regions, where the approximation vanishes.

export type FlashMode = 'off' | 'limit' | 'strict';

export const FLASH_MODES: readonly FlashMode[] = ['off', 'limit', 'strict'];

/**
 * For a persisted setting or a job field. Anything unrecognised becomes
 * `fallback`: 'limit' (the safe default) for a live surface, but an offline
 * job must pass 'off' — export is opt-in, and a missing field must not quietly
 * change the rendered bytes.
 */
export function parseFlashMode(value: unknown, fallback: FlashMode = 'limit'): FlashMode {
  return value === 'off' || value === 'strict' || value === 'limit' ? value : fallback;
}

export const DEFAULT_GRID_W = 64;
export const DEFAULT_GRID_H = 36;

/** WCAG general-flash transition: 10% of the maximum relative luminance. */
export const LUMINANCE_STEP = 0.1;
/** WCAG: a luminance pair only counts when the darker state is below this. */
export const DARK_CEILING = 0.8;
/** WCAG red flash: (R-G-B)*320 must change by more than this. */
export const RED_STEP = 20;
/** WCAG saturated red: R/(R+G+B) in linear light at or above this. */
export const RED_SATURATION = 0.8;
/** The sliding window flashes are counted over. */
export const WINDOW_SEC = 1;

interface ModeParams {
  /** Flashes allowed per WINDOW_SEC. A flash is two transitions. */
  readonly maxFlashes: number;
  /** Fraction of the frame that must flash for it to count. */
  readonly area: number;
  /** Seconds for the blend to recover from 0 to 1 once the limit no longer bites. */
  readonly release: number;
}

const MODE_PARAMS: Record<Exclude<FlashMode, 'off'>, ModeParams> = {
  // WCAG as written.
  limit: { maxFlashes: 3, area: 0.25, release: 0.5 },
  // For a projection large enough that 25% of the frame is much more than a
  // 10° field: fewer flashes, a smaller qualifying area, a slower recovery.
  strict: { maxFlashes: 2, area: 0.1, release: 1 },
};

/**
 * Headroom when choosing a blend: the displayed change is held under this
 * fraction of the WCAG step, so rounding in the compositor (8-bit globalAlpha,
 * 8-bit bytes offline) cannot tip a held cell over the line.
 */
const GUARD = 0.9;
/**
 * The same headroom on the two yes/no edges: the 0.80 dark ceiling and the 0.8
 * red-saturation ratio. Without it the blend search can land a hair above the
 * ceiling in float and the 8-bit output a hair below it.
 */
const CEILING_GUARD = 0.02;
/** Per-cell transition memory. Only "more than the budget" matters, so this caps well above 2*3. */
const RING = 16;
/** Bisection steps for the blend: 1/4096 resolution, far below 8-bit alpha. */
const BISECT_STEPS = 12;

// -- colour maths ------------------------------------------------------------

/** sRGB byte -> linear light. */
const LIN8 = new Float32Array(256);
/** sRGB encoded 0..1 -> linear, sampled finely enough for a 10% threshold. */
const LIN_N = 4096;
const LINF = new Float32Array(LIN_N + 1);
for (let i = 0; i < 256; i++) LIN8[i] = srgbToLinear(i / 255);
for (let i = 0; i <= LIN_N; i++) LINF[i] = srgbToLinear(i / LIN_N);

function srgbToLinear(c: number): number {
  return c <= 0.04045 ? c / 12.92 : Math.pow((c + 0.055) / 1.055, 2.4);
}

/** Encoded 0..1 -> linear, through the table. Used for every cell value so stats and predictions agree bit-for-bit. */
function lin(v: number): number {
  const i = Math.round((v < 0 ? 0 : v > 1 ? 1 : v) * LIN_N);
  return LINF[i]!;
}

/** Rec.709 / WCAG relative luminance of an encoded colour. */
export function relativeLuminance(r: number, g: number, b: number): number {
  return 0.2126 * lin(r) + 0.7152 * lin(g) + 0.0722 * lin(b);
}

/** WCAG red value (R-G-B)*320 in linear light, negatives clamped to 0. */
function redValue(lr: number, lg: number, lb: number): number {
  const v = (lr - lg - lb) * 320;
  return v > 0 ? v : 0;
}

function redSaturated(lr: number, lg: number, lb: number, threshold = RED_SATURATION): boolean {
  const s = lr + lg + lb;
  return s > 0 && lr / s >= threshold;
}

// -- frame statistics -------------------------------------------------------

/**
 * Per-cell summary of one frame. Create once with `createFrameStats`, reuse
 * forever: the compute functions only reallocate when the frame size changes.
 */
export interface FrameStats {
  readonly gridW: number;
  readonly gridH: number;
  /** Mean sRGB-encoded channel per cell, 0..1. The limiter's state and blend model. */
  readonly r: Float32Array;
  readonly g: Float32Array;
  readonly b: Float32Array;
  /** WCAG relative luminance of the cell mean, 0..1. */
  readonly lum: Float32Array;
  /** WCAG (R-G-B)*320, clamped at 0. */
  readonly red: Float32Array;
  /** 1 where the cell mean is saturated red (R/(R+G+B) >= 0.8), else 0. */
  readonly redSat: Uint8Array;
  /** Frame size the sample tables below were built for. */
  w: number;
  h: number;
  /** Sampled source column / row per sample, and which cell each belongs to. */
  xs: Int32Array;
  ys: Int32Array;
  cellX: Int32Array;
  cellY: Int32Array;
  /** Samples that landed in each cell. */
  counts: Uint16Array;
}

/**
 * Samples per cell along each axis. 4x4 at 64x36 is 36,864 reads — a quarter
 * of a 640x360 frame and a tiny fraction of 1080p, and plenty for a quantity
 * that only matters when it covers a quarter of the screen.
 */
const SAMPLES = 4;

export function createFrameStats(gridW = DEFAULT_GRID_W, gridH = DEFAULT_GRID_H): FrameStats {
  const n = gridW * gridH;
  return {
    gridW, gridH,
    r: new Float32Array(n), g: new Float32Array(n), b: new Float32Array(n),
    lum: new Float32Array(n), red: new Float32Array(n), redSat: new Uint8Array(n),
    w: 0, h: 0,
    xs: new Int32Array(0), ys: new Int32Array(0),
    cellX: new Int32Array(0), cellY: new Int32Array(0),
    counts: new Uint16Array(n),
  };
}

function prepare(s: FrameStats, w: number, h: number): void {
  if (s.w === w && s.h === h) return;
  const cols = Math.min(w, s.gridW * SAMPLES);
  const rows = Math.min(h, s.gridH * SAMPLES);
  s.xs = new Int32Array(cols);
  s.cellX = new Int32Array(cols);
  s.ys = new Int32Array(rows);
  s.cellY = new Int32Array(rows);
  for (let i = 0; i < cols; i++) {
    const x = Math.min(w - 1, Math.floor(((i + 0.5) * w) / cols));
    s.xs[i] = x;
    s.cellX[i] = Math.min(s.gridW - 1, Math.floor((x * s.gridW) / w));
  }
  for (let j = 0; j < rows; j++) {
    const y = Math.min(h - 1, Math.floor(((j + 0.5) * h) / rows));
    s.ys[j] = y;
    s.cellY[j] = Math.min(s.gridH - 1, Math.floor((y * s.gridH) / h));
  }
  s.counts.fill(0);
  for (let j = 0; j < rows; j++) {
    for (let i = 0; i < cols; i++) s.counts[s.cellY[j]! * s.gridW + s.cellX[i]!]!++;
  }
  s.w = w;
  s.h = h;
}

/** Stats from packed 0x00RRGGBB pixels (the AVS framebuffer layout). */
export function computeFrameStatsPacked(pixels: Uint32Array, w: number, h: number, out: FrameStats): FrameStats {
  prepare(out, w, h);
  out.r.fill(0); out.g.fill(0); out.b.fill(0);
  const { xs, ys, cellX, cellY, gridW } = out;
  const R = out.r, G = out.g, B = out.b;
  for (let j = 0; j < ys.length; j++) {
    const row = ys[j]! * w;
    const cellRow = cellY[j]! * gridW;
    for (let i = 0; i < xs.length; i++) {
      const p = pixels[row + xs[i]!]!;
      const c = cellRow + cellX[i]!;
      R[c]! += (p >>> 16) & 255;
      G[c]! += (p >>> 8) & 255;
      B[c]! += p & 255;
    }
  }
  return finish(out);
}

/** Stats from RGBA bytes (ImageData / canvas readback). Alpha is ignored. */
export function computeFrameStatsRgba(pixels: Uint8ClampedArray | Uint8Array, w: number, h: number, out: FrameStats): FrameStats {
  prepare(out, w, h);
  out.r.fill(0); out.g.fill(0); out.b.fill(0);
  const { xs, ys, cellX, cellY, gridW } = out;
  const R = out.r, G = out.g, B = out.b;
  for (let j = 0; j < ys.length; j++) {
    const row = ys[j]! * w;
    const cellRow = cellY[j]! * gridW;
    for (let i = 0; i < xs.length; i++) {
      const o = (row + xs[i]!) << 2;
      const c = cellRow + cellX[i]!;
      R[c]! += pixels[o]!;
      G[c]! += pixels[o + 1]!;
      B[c]! += pixels[o + 2]!;
    }
  }
  return finish(out);
}

function finish(s: FrameStats): FrameStats {
  const n = s.gridW * s.gridH;
  for (let c = 0; c < n; c++) {
    const k = s.counts[c]!;
    // A frame smaller than the grid leaves cells unsampled; they read as black
    // and, never changing, never flash.
    const inv = k > 0 ? 1 / (255 * k) : 0;
    const r = s.r[c]! * inv, g = s.g[c]! * inv, b = s.b[c]! * inv;
    s.r[c] = r; s.g[c] = g; s.b[c] = b;
    const lr = lin(r), lg = lin(g), lb = lin(b);
    s.lum[c] = 0.2126 * lr + 0.7152 * lg + 0.0722 * lb;
    s.red[c] = redValue(lr, lg, lb);
    s.redSat[c] = redSaturated(lr, lg, lb) ? 1 : 0;
  }
  return s;
}

// -- the limiter --------------------------------------------------------------

export interface FlashDecision {
  mode: FlashMode;
  /**
   * Fraction of the new frame to present over the previously displayed one:
   * 1 = show it as rendered, 0 = hold the last displayed frame. Live, draw the
   * new frame with `globalAlpha = blend` over the retained output.
   */
  blend: number;
  /** True when the limit (not just the release ramp) constrained this frame. */
  limited: boolean;
  /** General flashes in the last second over the qualifying area, as displayed. */
  flashRate: number;
  /** Red flashes in the last second over the qualifying area, as displayed. */
  redFlashRate: number;
}

/** One cell's transition tracker: the extreme it is moving away from, the direction, and a ring of times. */
interface Tracker {
  ref: Float32Array;
  dir: Int8Array;
  /** Red only: whether the reference state was saturated red. */
  refSat: Uint8Array;
  /** 1 while a reversal that did not yet qualify is in progress; `origin` is where it started. */
  pend: Uint8Array;
  origin: Float32Array;
  originSat: Uint8Array;
  times: Float64Array;
  head: Uint16Array;
  len: Uint16Array;
}

function createTracker(n: number): Tracker {
  return {
    ref: new Float32Array(n), dir: new Int8Array(n), refSat: new Uint8Array(n),
    pend: new Uint8Array(n), origin: new Float32Array(n), originSat: new Uint8Array(n),
    times: new Float64Array(n * RING), head: new Uint16Array(n), len: new Uint16Array(n),
  };
}

export class FlashLimiter {
  private modeValue: FlashMode;
  private readonly n: number;
  private readonly gridW: number;
  private readonly gridH: number;
  /** What the viewer is seeing now, per cell, as mean encoded colour. */
  private readonly dr: Float32Array;
  private readonly dg: Float32Array;
  private readonly db: Float32Array;
  private readonly lumT: Tracker;
  private readonly redT: Tracker;
  private primed = false;
  private lastT = 0;
  private lastBlend = 1;
  private readonly decision: FlashDecision;
  private readonly hist = new Uint32Array(RING + 1);

  constructor(mode: FlashMode = 'limit', gridW = DEFAULT_GRID_W, gridH = DEFAULT_GRID_H) {
    this.modeValue = mode;
    this.gridW = gridW;
    this.gridH = gridH;
    this.n = gridW * gridH;
    this.dr = new Float32Array(this.n);
    this.dg = new Float32Array(this.n);
    this.db = new Float32Array(this.n);
    this.lumT = createTracker(this.n);
    this.redT = createTracker(this.n);
    this.decision = { mode, blend: 1, limited: false, flashRate: 0, redFlashRate: 0 };
  }

  get mode(): FlashMode { return this.modeValue; }

  /**
   * Switching mode keeps the flash history: turning the limiter on in the
   * middle of a strobe must know the strobe has been running.
   */
  setMode(mode: FlashMode): void {
    this.modeValue = mode;
    this.decision.mode = mode;
    if (mode === 'off') this.lastBlend = 1;
  }

  /** Forget everything. For a cut to unrelated content, or a new render. */
  reset(): void {
    this.primed = false;
    this.lastBlend = 1;
    for (const t of [this.lumT, this.redT]) {
      t.dir.fill(0);
      t.pend.fill(0);
      t.head.fill(0);
      t.len.fill(0);
    }
  }

  /**
   * Decide how much of `frame` to show at time `t` (seconds), and record the
   * PREDICTED result as displayed. For a presenter that cannot read back what
   * it showed (a GPU canvas drawn with `globalAlpha`). The returned object is
   * reused — read it, don't keep it.
   */
  evaluate(frame: FrameStats, t: number): FlashDecision {
    const d = this.decide(frame, t);
    // Snap down to the 8-bit alpha the compositor will actually use, so the
    // prediction is at least made with the real alpha.
    if (d.blend < 1) {
      d.blend = Math.floor(d.blend * 255) / 255;
      this.lastBlend = d.blend;
    }
    this.adopt(frame, d.blend, t, true);
    return d;
  }

  /**
   * First half of `evaluate`: choose the blend without recording anything.
   * Follow with exactly one `commit(displayed, t)` carrying the stats of what
   * was ACTUALLY shown. That is the accurate path: an 8-bit blend rounds, and
   * a cell held at the edge of a threshold for many frames would otherwise let
   * the prediction and the pixels drift apart one rounding at a time.
   */
  decide(frame: FrameStats, t: number): FlashDecision {
    if (frame.gridW !== this.gridW || frame.gridH !== this.gridH) {
      throw new Error(`FlashLimiter grid ${this.gridW}x${this.gridH} given ${frame.gridW}x${frame.gridH} stats.`);
    }
    const d = this.decision;
    if (!this.primed) {
      // Nothing displayed yet: the first frame is shown whole.
      this.lastT = t;
      this.lastBlend = 1;
      d.blend = 1;
      d.limited = false;
      return d;
    }
    // A seek or restart rewinds the clock. Old transitions would sit in the
    // future and never age out, so drop them; the displayed state stays.
    if (t < this.lastT - 1e-6) {
      for (const tr of [this.lumT, this.redT]) { tr.head.fill(0); tr.len.fill(0); }
    }
    const dt = Math.max(0, t - this.lastT);
    this.lastT = t;

    let blend = 1;
    let limited = false;
    if (this.modeValue !== 'off') {
      const p = MODE_PARAMS[this.modeValue];
      // Attack is instant (safety cannot wait), release is a ramp: once the
      // limit lets go the blend climbs back at 1/release per second rather
      // than snapping, which is what stops it pumping on a steady strobe.
      const ceiling = Math.min(1, this.lastBlend + dt / p.release);
      const areaCells = Math.max(1, Math.ceil(this.n * p.area));
      const budget = p.maxFlashes * 2;
      blend = ceiling;
      if (this.violations(frame, ceiling, t, budget) >= areaCells) {
        // Largest blend that keeps the over-budget area below the threshold.
        // b = 0 (hold the last frame) always qualifies: nothing changes.
        let lo = 0;
        let hi = ceiling;
        for (let i = 0; i < BISECT_STEPS; i++) {
          const mid = (lo + hi) / 2;
          if (this.violations(frame, mid, t, budget) >= areaCells) hi = mid; else lo = mid;
        }
        blend = lo;
        limited = true;
      }
    }
    this.lastBlend = blend;
    d.blend = blend;
    d.limited = limited;
    return d;
  }

  /** Second half of `decide`: record `displayed` (stats of the frame actually shown at `t`). */
  commit(displayed: FrameStats, t: number): FlashDecision {
    this.adopt(displayed, 1, t);
    return this.decision;
  }

  /** Count cells that would make an over-budget transition if `frame` were shown at `blend`. */
  private violations(frame: FrameStats, blend: number, t: number, budget: number): number {
    let count = 0;
    const lumT = this.lumT, redT = this.redT;
    const cutoff = t - WINDOW_SEC;
    for (let c = 0; c < this.n; c++) {
      const lumOver = inWindow(lumT, c, cutoff) + 1 > budget;
      const redOver = inWindow(redT, c, cutoff) + 1 > budget;
      if (!lumOver && !redOver) continue;
      const r = this.dr[c]! + (frame.r[c]! - this.dr[c]!) * blend;
      const g = this.dg[c]! + (frame.g[c]! - this.dg[c]!) * blend;
      const b = this.db[c]! + (frame.b[c]! - this.db[c]!) * blend;
      const lr = lin(r), lg = lin(g), lb = lin(b);
      const L = 0.2126 * lr + 0.7152 * lg + 0.0722 * lb;
      if (lumOver && lumWouldTransition(lumT, c, L, LUMINANCE_STEP * GUARD, DARK_CEILING + CEILING_GUARD)) {
        count++;
        continue;
      }
      if (redOver && redWouldTransition(redT, c, redValue(lr, lg, lb),
        redSaturated(lr, lg, lb, RED_SATURATION - CEILING_GUARD), RED_STEP * GUARD)) count++;
    }
    return count;
  }

  /** Make `frame` at `blend` the displayed state, recording any transitions it makes. */
  private adopt(frame: FrameStats, blend: number, t: number, quantize = false): void {
    if (frame.gridW !== this.gridW || frame.gridH !== this.gridH) {
      throw new Error(`FlashLimiter grid ${this.gridW}x${this.gridH} given ${frame.gridW}x${frame.gridH} stats.`);
    }
    const first = !this.primed;
    this.primed = true;
    this.lastT = t;
    const cutoff = t - WINDOW_SEC;
    for (let c = 0; c < this.n; c++) {
      // blend 1 copies exactly, so a committed readback IS the state.
      const whole = first || blend === 1;
      this.dr[c] = whole ? frame.r[c]! : this.dr[c]! + (frame.r[c]! - this.dr[c]!) * blend;
      this.dg[c] = whole ? frame.g[c]! : this.dg[c]! + (frame.g[c]! - this.dg[c]!) * blend;
      this.db[c] = whole ? frame.b[c]! : this.db[c]! + (frame.b[c]! - this.db[c]!) * blend;
      if (quantize && !whole) {
        // Predicting without readback: the compositor writes 8-bit channels,
        // and its rounding is lopsided when a cell is held — a small step up
        // rounds to nothing, a big step down to at least one level — so an
        // unrounded prediction drifts away from the pixels over a long hold.
        // Rounding the prediction the same way is exact for flat regions,
        // which are the ones that flash.
        this.dr[c] = Math.round(this.dr[c]! * 255) / 255;
        this.dg[c] = Math.round(this.dg[c]! * 255) / 255;
        this.db[c] = Math.round(this.db[c]! * 255) / 255;
      }
      const lr = lin(this.dr[c]!), lg = lin(this.dg[c]!), lb = lin(this.db[c]!);
      const L = 0.2126 * lr + 0.7152 * lg + 0.0722 * lb;
      const red = redValue(lr, lg, lb);
      const sat = redSaturated(lr, lg, lb);
      if (first) {
        this.lumT.ref[c] = L;
        this.redT.ref[c] = red;
        this.redT.refSat[c] = sat ? 1 : 0;
        continue;
      }
      prune(this.lumT, c, cutoff);
      prune(this.redT, c, cutoff);
      lumStep(this.lumT, c, L, t);
      redStep(this.redT, c, red, sat, t);
    }
    this.rates();
  }

  /** Area-qualified flash rates: the count reached by at least the qualifying area of cells. */
  private rates(): void {
    const area = this.modeValue === 'strict' ? MODE_PARAMS.strict.area : MODE_PARAMS.limit.area;
    const areaCells = Math.max(1, Math.ceil(this.n * area));
    const cutoff = this.lastT - WINDOW_SEC;
    this.decision.flashRate = this.areaCount(this.lumT, cutoff, areaCells) / 2;
    this.decision.redFlashRate = this.areaCount(this.redT, cutoff, areaCells) / 2;
  }

  private areaCount(tr: Tracker, cutoff: number, areaCells: number): number {
    const h = this.hist;
    h.fill(0);
    for (let c = 0; c < this.n; c++) h[inWindow(tr, c, cutoff)]!++;
    let acc = 0;
    for (let k = RING; k > 0; k--) {
      acc += h[k]!;
      if (acc >= areaCells) return k;
    }
    return 0;
  }
}

// -- tracker steps ----------------------------------------------------------
//
// Each tracker follows the extreme in its current direction: while luminance
// keeps rising after an upward transition the reference rises with it, so a
// slow fade is one transition, not one per 10%. A transition is a move of the
// full step AGAINST the reference, which is what makes consecutive transitions
// opposing — the pair WCAG calls a flash.

function inWindow(tr: Tracker, c: number, cutoff: number): number {
  let len = tr.len[c]!;
  let head = tr.head[c]!;
  const base = c * RING;
  // Read-only count: skip expired entries without mutating the ring.
  while (len > 0 && tr.times[base + head]! <= cutoff) { head = (head + 1) % RING; len--; }
  return len;
}

function prune(tr: Tracker, c: number, cutoff: number): void {
  const base = c * RING;
  while (tr.len[c]! > 0 && tr.times[base + tr.head[c]!]! <= cutoff) {
    tr.head[c] = (tr.head[c]! + 1) % RING;
    tr.len[c]!--;
  }
}

function push(tr: Tracker, c: number, t: number): void {
  const base = c * RING;
  if (tr.len[c]! === RING) {
    // Full: the oldest falls off. A count saturating at RING is still far
    // above any budget, so nothing downstream can tell.
    tr.head[c] = (tr.head[c]! + 1) % RING;
    tr.len[c]!--;
  }
  tr.times[base + ((tr.head[c]! + tr.len[c]!) % RING)] = t;
  tr.len[c]!++;
}

// A reversal that does not qualify yet (a luminance dip that stays above the
// 0.80 ceiling, a red swing between two unsaturated states) still turns the
// tracker round, but remembers where the move began. If the same move goes on
// to qualify — 1.0 easing to 0.85 and then plunging to 0.2 — that is one real
// transition, and it is counted then, from the origin. Without this, a move
// could launder itself past the counter by pausing just above the ceiling.

function lumQualifies(a: number, b: number, step: number, ceiling: number): boolean {
  return Math.abs(a - b) >= step && Math.min(a, b) < ceiling;
}

function lumWouldTransition(tr: Tracker, c: number, L: number, step: number, ceiling: number): boolean {
  const ref = tr.ref[c]!;
  const dir = tr.dir[c]!;
  if ((dir > 0 && L >= ref) || (dir < 0 && L <= ref)) {
    return tr.pend[c]! === 1 && lumQualifies(L, tr.origin[c]!, step, ceiling);
  }
  return lumQualifies(L, ref, step, ceiling);
}

function lumStep(tr: Tracker, c: number, L: number, t: number): void {
  const ref = tr.ref[c]!;
  const dir = tr.dir[c]!;
  if ((dir > 0 && L >= ref) || (dir < 0 && L <= ref)) {
    tr.ref[c] = L;
    if (tr.pend[c]! === 1 && lumQualifies(L, tr.origin[c]!, LUMINANCE_STEP, DARK_CEILING)) {
      push(tr, c, t);
      tr.pend[c] = 0;
    }
    return;
  }
  const delta = L - ref;
  if (Math.abs(delta) < LUMINANCE_STEP) return;
  if (Math.min(L, ref) < DARK_CEILING) {
    push(tr, c, t);
    tr.pend[c] = 0;
  } else {
    tr.pend[c] = 1;
    tr.origin[c] = ref;
  }
  tr.dir[c] = delta > 0 ? 1 : -1;
  tr.ref[c] = L;
}

function redQualifies(a: number, aSat: boolean, b: number, bSat: boolean, step: number): boolean {
  return Math.abs(a - b) > step && (aSat || bSat);
}

function redWouldTransition(tr: Tracker, c: number, red: number, sat: boolean, step: number): boolean {
  const ref = tr.ref[c]!;
  const dir = tr.dir[c]!;
  if ((dir > 0 && red >= ref) || (dir < 0 && red <= ref)) {
    return tr.pend[c]! === 1 && redQualifies(red, sat, tr.origin[c]!, tr.originSat[c]! === 1, step);
  }
  return redQualifies(red, sat, ref, tr.refSat[c]! === 1, step);
}

function redStep(tr: Tracker, c: number, red: number, sat: boolean, t: number): void {
  const ref = tr.ref[c]!;
  const dir = tr.dir[c]!;
  if ((dir > 0 && red >= ref) || (dir < 0 && red <= ref)) {
    tr.ref[c] = red;
    tr.refSat[c] = sat ? 1 : 0;
    if (tr.pend[c]! === 1 && redQualifies(red, sat, tr.origin[c]!, tr.originSat[c]! === 1, RED_STEP)) {
      push(tr, c, t);
      tr.pend[c] = 0;
    }
    return;
  }
  const delta = red - ref;
  if (Math.abs(delta) <= RED_STEP) return;
  if (redQualifies(red, sat, ref, tr.refSat[c]! === 1, RED_STEP)) {
    push(tr, c, t);
    tr.pend[c] = 0;
  } else {
    tr.pend[c] = 1;
    tr.origin[c] = ref;
    tr.originSat[c] = tr.refSat[c]!;
  }
  tr.dir[c] = delta > 0 ? 1 : -1;
  tr.ref[c] = red;
  tr.refSat[c] = sat ? 1 : 0;
}

// -- in-place limiting (offline export; live CPU frames) ------------------------

/**
 * Limit one packed 0x00RRGGBB frame in place. `prevOut` holds the previously
 * OUTPUT frame and is updated to this one; on the first call (or after
 * `limiter.reset()`) its contents are ignored — the first frame is always
 * shown whole. `stats` is scratch from `createFrameStats`.
 *
 * NEVER pass an AVS runtime's `framebuffer.pixels`: that buffer is the
 * preset's feedback state, and limiting it would change what the next frame
 * renders. Copy into a presentation buffer first and limit the copy.
 *
 * Offline export uses this (opt-in, recorded in the manifest), with `t` =
 * frame index / fps. Deterministic: integer blending, and the limiter's state
 * is committed from the bytes actually written, so the same input sequence
 * produces the same output bytes on every run and machine.
 *
 * The blend is per channel on encoded values — what `globalAlpha` does live —
 * so an export and a GPU-presented projector agree on what a limited strobe
 * looks like.
 */
export function limitPackedFrame(
  limiter: FlashLimiter,
  stats: FrameStats,
  frame: Uint32Array,
  prevOut: Uint32Array,
  w: number,
  h: number,
  t: number,
): FlashDecision {
  const n = w * h;
  if (frame.length < n || prevOut.length < n) throw new Error('limitPackedFrame: buffer smaller than w*h.');
  computeFrameStatsPacked(frame, w, h, stats);
  const d = limiter.decide(stats, t);
  if (d.blend < 1) {
    const a = alpha256(d.blend);
    for (let i = 0; i < n; i++) {
      const p = prevOut[i]!;
      const q = frame[i]!;
      const r = mix((p >>> 16) & 255, (q >>> 16) & 255, a);
      const g = mix((p >>> 8) & 255, (q >>> 8) & 255, a);
      const b = mix(p & 255, q & 255, a);
      frame[i] = (r << 16) | (g << 8) | b;
    }
    computeFrameStatsPacked(frame, w, h, stats);
  }
  limiter.commit(stats, t);
  prevOut.set(frame.subarray(0, n));
  return d;
}

/** `limitPackedFrame` for RGBA bytes (ImageData). Alpha is copied from the new frame. */
export function limitRgbaFrame(
  limiter: FlashLimiter,
  stats: FrameStats,
  frame: Uint8ClampedArray | Uint8Array,
  prevOut: Uint8ClampedArray | Uint8Array,
  w: number,
  h: number,
  t: number,
): FlashDecision {
  const n = w * h * 4;
  if (frame.length < n || prevOut.length < n) throw new Error('limitRgbaFrame: buffer smaller than w*h*4.');
  computeFrameStatsRgba(frame, w, h, stats);
  const d = limiter.decide(stats, t);
  if (d.blend < 1) {
    const a = alpha256(d.blend);
    for (let i = 0; i < n; i += 4) {
      frame[i] = mix(prevOut[i]!, frame[i]!, a);
      frame[i + 1] = mix(prevOut[i + 1]!, frame[i + 1]!, a);
      frame[i + 2] = mix(prevOut[i + 2]!, frame[i + 2]!, a);
    }
    computeFrameStatsRgba(frame, w, h, stats);
  }
  limiter.commit(stats, t);
  prevOut.set(frame.subarray(0, n));
  return d;
}

/**
 * Blend as a 0..256 integer, rounded DOWN: showing slightly less of a frame
 * the limiter is holding back is safe; showing slightly more is not.
 */
function alpha256(blend: number): number {
  return Math.max(0, Math.min(256, Math.floor(blend * 256)));
}

/** prev + (next - prev) * a/256, rounded to nearest, in integers. */
function mix(prev: number, next: number, a: number): number {
  return prev + (((next - prev) * a + 128) >> 8);
}
