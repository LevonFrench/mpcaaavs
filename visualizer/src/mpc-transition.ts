/** AVS transition geometry, based on Nullsoft's r_transition.cpp (BSD-3-Clause).
 * See docs/AVS-TRANSITIONS.md and THIRD-PARTY-AVS-TRANSITIONS.txt. The notice covers the classic switch (indices 1-14) below only.
 * Indices 16-30 are original designs in mpc-transition-fx.ts; 0, 31 and 32 are selectors that resolve to one of the concrete styles.
 * Operates on presentation surfaces; preset GPU execution remains unchanged. */
import { TRANSITION_COUNT, TRANSITION_CUT } from './mpc-contract.ts';
import { FxState, FX_FIRST, drawFx, hash32, seededRandom, stepQ, subSeed, ticks, transitionUnit } from './mpc-transition-fx.ts';
export { TRANSITION_COUNT, TRANSITION_CUT };
export { hash32, stepQ, subSeed, ticks, transitionUnit };

/** Everything a style may read while drawing. `level`, `bands`, `beatPhase` and `barPhase` only scale decoration, so a seek replays the reveal exactly. */
export interface TransitionEnv {
  /** 20..400: the scene-clock tempo, else the locked live tempo, else 120. */
  readonly bpm: number;
  /** 0..1, fraction of the current musical beat (a pure function of media time on the clocked path). */
  readonly beatPhase: number;
  /** 0..1, fraction of the current bar. */
  readonly barPhase: number;
  /** Length of this transition in beats, 0.25..64. */
  readonly beatsTotal: number;
  /** Length in seconds when the host knows it exactly (tempo maps); otherwise `beatsTotal * 60 / bpm`. */
  readonly seconds?: number;
  /** 0..1 audio energy in quarters. Decoration only. */
  readonly level: number;
  /** Optional 16 values in 0..1 frozen when the transition starts (live AVS path only). */
  readonly bands?: readonly number[];
  /** 0 neutral cool-grey accent, 1 NERV orange and amber (both plates are NERV or HUD scenes). */
  readonly accent: 0 | 1;
  readonly reducedMotion: boolean;
}
export const defaultTransitionEnv: TransitionEnv = Object.freeze({ bpm: 120, beatPhase: 0, barPhase: 0, beatsTotal: 4, level: 0, accent: 0, reducedMotion: false });
/** What the two selectors (31, 32) and the reduced-motion fallback need at construction; part of the worker cache key. */
export interface TransitionContext {
  /** Transition length in beats after the timing module resolved its own seeded duration. */
  beatsTotal: number;
  /** 0 free, manual or adaptive; 1 bar; 2 phrase; 3 section. */
  boundary: 0 | 1 | 2 | 3;
  /** Both plates are NERV or HUD scene presets. */
  nervPair: boolean;
  reducedMotion: boolean;
  /** Live level bucket at commit (AVS path only). The clocked path leaves it undefined so its picks replay after a seek. */
  energy?: 0 | 1 | 2 | 3;
}
const defaultContext: TransitionContext = Object.freeze({ beatsTotal: 4, boundary: 0, nervPair: false, reducedMotion: false });
/** A full context from whatever a caller has (a worker message, a host adapter): unknown or out-of-range fields take the defaults, so selection never throws. */
export function normalizeContext(input?: Partial<TransitionContext> | null): TransitionContext {
  const c: Partial<TransitionContext> = input && typeof input === 'object' ? input : {};
  const cx: TransitionContext = {
    beatsTotal: typeof c.beatsTotal === 'number' && Number.isFinite(c.beatsTotal) && c.beatsTotal > 0 ? Math.min(c.beatsTotal, 64) : 4,
    boundary: c.boundary === 1 || c.boundary === 2 || c.boundary === 3 ? c.boundary : 0, nervPair: c.nervPair === true, reducedMotion: c.reducedMotion === true,
  };
  if (c.energy === 0 || c.energy === 1 || c.energy === 2 || c.energy === 3) cx.energy = c.energy;
  return cx;
}
export interface TransitionMeta {
  readonly name: string;
  readonly kind: 'classic' | 'fx' | 'selector';
  readonly family: string;
  /** Styles that cannot work outside this length are left out of the selector pools. */
  readonly minBeats: number;
  readonly maxBeats: number;
  /** Peak or drop of the style as a fraction of the transition, or null. */
  readonly hit: ((beats: number) => number) | null;
  /** Allowed under reduced motion. */
  readonly calm: boolean;
  /** NERV or HUD flavoured: Smart random prefers these on NERV and HUD pairs. */
  readonly nerv: boolean;
  /** Preferred on section boundaries. */
  readonly dramatic: boolean;
  /** Per-frame upper bounds on canvas calls (base draws included), independent of resolution; asserted by check-mpc-transition-fx.mjs. */
  readonly cost: { readonly draw: number; readonly clip: number; readonly fill: number; readonly text: number };
}
const cost = (draw: number, clip = 0, fill = 0, text = 0) => ({ draw, clip, fill, text });
const classic = (name: string, family: string, c: TransitionMeta['cost']): TransitionMeta => ({ name, kind: 'classic', family, minBeats: 0, maxBeats: 64, hit: null, calm: true, nerv: false, dramatic: false, cost: c });
const selector = (name: string): TransitionMeta => ({ name, kind: 'selector', family: 'selector', minBeats: 0, maxBeats: 64, hit: null, calm: true, nerv: false, dramatic: false, cost: cost(0) });
const fx = (name: string, family: string, minBeats: number, o: { max?: number; hit?: TransitionMeta['hit']; calm?: boolean; nerv?: boolean; dramatic?: boolean }, c: TransitionMeta['cost']): TransitionMeta =>
  ({ name, kind: 'fx', family, minBeats, maxBeats: o.max ?? 64, hit: o.hit ?? null, calm: o.calm ?? false, nerv: o.nerv ?? false, dramatic: o.dramatic ?? false, cost: c });
export const TRANSITION_META: readonly TransitionMeta[] = Object.freeze([
  selector('Random · classic'),
  classic('Cross dissolve', 'dissolve', cost(2)),
  classic('L/R Push', 'push', cost(3)), classic('R/L Push', 'push', cost(3)), classic('T/B Push', 'push', cost(3)), classic('B/T Push', 'push', cost(3)),
  classic('9 Random Blocks', 'reveal', cost(10, 9)), classic('Split L/R Push', 'push', cost(5, 2)),
  classic('L/R to Center Push', 'push', cost(3, 2)), classic('L/R to Center Squeeze', 'push', cost(4, 2)),
  classic('L/R Wipe', 'wipe', cost(2, 1)), classic('R/L Wipe', 'wipe', cost(2, 1)), classic('T/B Wipe', 'wipe', cost(2, 1)), classic('B/T Wipe', 'wipe', cost(2, 1)),
  classic('Dot Dissolve', 'dissolve', cost(3, 0, 2)), classic('Cut', 'cut', cost(1)),
  fx('Beat Step Wipe', 'tick', .5, { calm: true }, cost(2, 1, 1)),
  fx('Hazard Stripe Wipe', 'wipe', .5, { calm: true, nerv: true }, cost(2, 2, 2)),
  fx('MAGI Hex Reveal', 'reveal', 1, { calm: true, nerv: true, dramatic: true }, cost(2, 1, 2)),
  fx('AT Field Iris', 'reveal', .5, { calm: true, nerv: true, dramatic: true }, cost(2, 1, 3)),
  fx('Radar Sweep', 'reveal', 1, { calm: true, nerv: true, dramatic: true }, cost(2, 1, 5)),
  fx('Venetian Blinds', 'reveal', .5, { calm: true }, cost(2, 1)),
  fx('CRT Off', 'reveal', .5, { calm: true, nerv: true }, cost(2, 0, 1)),
  fx('CRT On', 'reveal', .5, { calm: true, nerv: true }, cost(2, 0, 1)),
  fx('Glitch Stutter', 'glitch', 1, {}, cost(34, 1)),
  fx('Datamosh Smear', 'glitch', 1, {}, cost(28, 1)),
  fx('Tile Flip', 'tick', 1, {}, cost(42, 1, 40)),
  fx('Countdown Iris', 'build', 2, { max: 9, hit: () => 1, nerv: true, dramatic: true }, cost(2, 1, 2, 2)),
  fx('Kick-Punch Zoom', 'tick', .5, { hit: () => .5 }, cost(2)),
  fx('Mosaic Drop', 'build', 4, { hit: beats => Math.min(.9, Math.max(.5, 1 - 1 / beats)), dramatic: true }, cost(2, 0, 1)),
  fx('Spectrum Bars Wipe', 'reveal', .5, { calm: true }, cost(2, 1, 1)),
  selector('Random · all styles'), selector('Smart random'),
]);
if (TRANSITION_META.length !== TRANSITION_COUNT) throw Error('TRANSITION_META must have TRANSITION_COUNT entries');
export const TRANSITIONS: readonly string[] = TRANSITION_META.map(m => m.name);

export function transitionProgress(progress: number) { return (1 - Math.cos(Math.max(0, Math.min(1, progress)) * Math.PI)) / 2; }
export function blockOrder(random = Math.random) {
  const blocks = Array.from({ length: 9 }, (_, i) => i);
  for (let i = 8; i > 0; i--) { const j = Math.floor(random() * (i + 1)); [blocks[i], blocks[j]] = [blocks[j]!, blocks[i]!]; }
  return blocks;
}

// ---- inputs derived from the audio frame --------------------------------------------------------------------------------------------------

type SpectrumSource = { readonly spectrum: readonly Uint8Array[] } | null | undefined;
/** Mean of the first 93 spectrum bins of both channels over 255, quantised to quarters. Decoration only. */
export function transitionLevel(audio: SpectrumSource): number {
  const spectrum = audio?.spectrum;
  if (!spectrum?.length) return 0;
  let sum = 0;
  for (let c = 0; c < 2; c++) { const bins = spectrum[Math.min(c, spectrum.length - 1)]; let mean = 0; for (let i = 0; i < 93; i++) mean += bins?.[i] ?? 0; sum += mean / 93; }
  return Math.round(Math.max(0, Math.min(1, sum / 510)) * 4) / 4;
}
/** Sixteen log-spaced band levels in 0..1 (the same axis as the NERV spectrum plates), frozen by the host when a transition starts. */
export function bands16(audio: SpectrumSource): number[] {
  const out = new Array<number>(16).fill(0), spectrum = audio?.spectrum;
  if (!spectrum?.length) return out;
  const channels = spectrum.slice(0, 2);
  for (let i = 0; i < 16; i++) {
    const from = Math.min(511, Math.floor(Math.expm1(i / 16 * Math.log(513)))), to = Math.min(512, Math.max(from + 1, Math.floor(Math.expm1((i + 1) / 16 * Math.log(513)))));
    let sum = 0, n = 0;
    for (const bins of channels) for (let k = from; k < to; k++) { sum += bins[k] ?? 0; n++; }
    out[i] = n ? Math.max(0, Math.min(1, sum / (n * 255))) : 0;
  }
  return out;
}
/** A full env from whatever a caller has: every number finite and in range, unknown fields dropped. */
export function normalizeEnv(input?: Partial<TransitionEnv> | null): TransitionEnv {
  const e: Partial<TransitionEnv> = input ?? {}, num = (v: unknown, lo: number, hi: number, fallback: number) => typeof v === 'number' && Number.isFinite(v) ? Math.min(hi, Math.max(lo, v)) : fallback;
  const env: { -readonly [K in keyof TransitionEnv]: TransitionEnv[K] } = {
    bpm: num(e.bpm, 20, 400, 120), beatPhase: num(e.beatPhase, 0, 1, 0), barPhase: num(e.barPhase, 0, 1, 0), beatsTotal: num(e.beatsTotal, .25, 64, 4),
    level: num(e.level, 0, 1, 0), accent: e.accent === 1 ? 1 : 0, reducedMotion: e.reducedMotion === true,
  };
  if (typeof e.seconds === 'number' && Number.isFinite(e.seconds) && e.seconds > 0) env.seconds = Math.min(e.seconds, 4096);
  if (Array.isArray(e.bands)) env.bands = e.bands.slice(0, 16).map(v => num(v, 0, 1, 0));
  return env;
}

// ---- style selection ---------------------------------------------------------------------------------------------------------------------

const CALM_ENERGY = new Set([1, 14, 19, 20, 21, 23]);   // dissolves, iris, radar, blinds, CRT On
const LIVELY = new Set([17, 24, 25, 16, 26, 28]);       // hazard, glitch, tick and Kick-Punch
function smartWeight(index: number, m: TransitionMeta, cx: TransitionContext): number {
  const b = cx.beatsTotal;
  if (b < m.minBeats || b > m.maxBeats || cx.reducedMotion && !m.calm) return 0;
  let weight = m.kind === 'classic' ? index === 1 ? 1 : .5 : 1;
  if (b <= 1.5) { if (m.family === 'tick' || m.family === 'glitch') weight *= 3; if (m.family === 'build') weight = 0; }
  else if (b < 6) { if (m.family === 'reveal') weight *= 2; }
  else { if (m.family === 'build') weight *= 3; if (m.family === 'reveal') weight *= 2; if (m.family === 'tick') weight *= .3; }
  if (cx.boundary === 0) { if (m.dramatic) weight *= .5; if (m.hit) weight = 0; }
  else if (cx.boundary === 2) { if (m.dramatic) weight *= 2; }
  else if (cx.boundary === 3) { if (m.dramatic) weight *= 3; }
  if (cx.energy !== undefined) { if (cx.energy >= 2 && LIVELY.has(index)) weight *= 2; else if (cx.energy <= 0 && CALM_ENERGY.has(index)) weight *= 2; }
  return weight * (cx.nervPair ? m.nerv ? 2 : .5 : 1);
}
/** The concrete style for a requested one. 0 is the classic Random (the legacy stream, 1..14 only); 31 is uniform over every fitting
 * style and 32 is weighted by tempo, boundary and pair; both are pure functions of (seed, context). Any other valid index is returned
 * unchanged, except that a non-calm style becomes Cross dissolve under reduced motion. Invalid input yields Cross dissolve. */
export function resolveTransitionMode(mode: number, seed: number, context?: Partial<TransitionContext> | null): number {
  if (!Number.isInteger(mode) || mode < 0 || mode >= TRANSITION_COUNT) return 1;
  if (mode === 0) { const random = seededRandom(seed); blockOrder(random); return 1 + Math.floor(random() * 14); }
  const cx = normalizeContext(context);
  if (mode < 31) return cx.reducedMotion && !TRANSITION_META[mode]!.calm ? 1 : mode;
  const pool: number[] = [], weights: number[] = [];
  TRANSITION_META.forEach((m, i) => {
    if (m.kind === 'selector' || i === TRANSITION_CUT) return;
    const weight = mode === 31 ? (cx.beatsTotal < m.minBeats || cx.beatsTotal > m.maxBeats || cx.reducedMotion && !m.calm ? 0 : 1) : smartWeight(i, m, cx);
    if (weight > 0) { pool.push(i); weights.push(weight); }
  });
  if (!pool.length) return 1;
  const random = seededRandom(subSeed(seed, mode === 31 ? 1 : 2));
  if (mode === 31) return pool[Math.floor(random() * pool.length)]!;
  let x = random() * weights.reduce((a, b) => a + b, 0);
  for (let k = 0; k < pool.length; k++) if ((x -= weights[k]!) < 0) return pool[k]!;
  return pool[pool.length - 1]!;
}

// ---- the transition ------------------------------------------------------------------------------------------------------------------------

type TransitionCanvas = HTMLCanvasElement | OffscreenCanvas;
type TransitionContext2D = CanvasRenderingContext2D | OffscreenCanvasRenderingContext2D;
export interface AvsTransitionOptions {
  /** A stable boundary identity makes Random and block order reproducible after seeks. */
  readonly seed?: number;
  /** Worker callers provide OffscreenCanvas; regular player transitions retain HTML canvases. */
  readonly createCanvas?: () => TransitionCanvas;
  /** Inputs of the selectors and the reduced-motion fallback. Defaults: 4 beats, free boundary, not a scene pair, full motion. */
  readonly context?: TransitionContext;
  /** High-resolution scene surfaces: bilinear 'high' smoothing instead of nearest. Off (the default) keeps classic AVS output exactly. */
  readonly smooth?: boolean;
}
function context2d(canvas: TransitionCanvas): TransitionContext2D {
  const context = canvas.getContext('2d') as TransitionContext2D | null;
  if (!context) throw Error('Transition canvas unavailable');
  return context;
}
/** A scratch surface at (width, height): resized only when the size changed, then reset to an empty source-over state. */
function scratch(canvas: TransitionCanvas, width: number, height: number): TransitionContext2D {
  if (canvas.width !== width) canvas.width = width;
  if (canvas.height !== height) canvas.height = height;
  const c = context2d(canvas);
  c.globalCompositeOperation = 'source-over'; c.globalAlpha = 1;
  if (typeof c.clearRect === 'function') c.clearRect(0, 0, width, height);
  return c;
}
export class AvsTransition {
  private mask: TransitionCanvas;
  private tile: TransitionCanvas;
  private readonly smooth: boolean;
  private readonly fx: FxState | null;
  readonly order: number[];
  /** The concrete style that draws (never a selector; Cross dissolve when the request was invalid or non-calm under reduced motion). */
  readonly mode: number;
  /** The style that was asked for, as given. */
  readonly requested: number;
  constructor(mode: number, options: AvsTransitionOptions = {}) {
    const createCanvas = options.createCanvas ?? (() => document.createElement('canvas'));
    this.mask = createCanvas(); this.tile = createCanvas();
    this.smooth = options.smooth === true;
    const random = options.seed === undefined ? Math.random : seededRandom(options.seed);
    this.order = blockOrder(random);
    this.requested = mode;
    const valid = Number.isInteger(mode) && mode >= 0 && mode < TRANSITION_COUNT ? mode : 1, context = options.context ? normalizeContext(options.context) : defaultContext;
    const seed = options.seed ?? Math.floor(Math.random() * 4294967296);
    this.mode = valid === 0 ? 1 + Math.floor(random() * 14) : resolveTransitionMode(valid, seed, context);
    this.fx = this.mode >= FX_FIRST ? new FxState(this.mode, seed, createCanvas) : null;
  }
  draw(ctx: TransitionContext2D, old: CanvasImageSource, next: CanvasImageSource, progress: number, w: number, h: number, env?: Partial<TransitionEnv>) {
    if (!(w > 0) || !(h > 0) || !Number.isFinite(w) || !Number.isFinite(h)) return;
    const t = progress >= 1 ? 1 : progress > 0 ? progress : 0, s = transitionProgress(t);   // NaN and -Infinity draw the old frame, +Infinity the new one
    ctx.globalAlpha = 1; ctx.imageSmoothingEnabled = this.smooth; if (this.smooth) ctx.imageSmoothingQuality = 'high';
    const draw = (source: CanvasImageSource, x = 0, y = 0, width = w, height = h) => ctx.drawImage(source, x, y, width, height);
    const clip = (x: number, y: number, width: number, height: number, fn: () => void) => {
      if (width <= 0 || height <= 0) return;
      ctx.save(); ctx.beginPath(); ctx.rect(x, y, width, height); ctx.clip(); fn(); ctx.restore();
    };
    if (t >= 1 || this.mode === TRANSITION_CUT) { draw(next); return; }
    let mode = this.mode;
    if (mode >= FX_FIRST) {
      const e = normalizeEnv(env);
      // Only the new styles read env. Under reduced motion a non-calm style is Cross dissolve.
      if (!e.reducedMotion || TRANSITION_META[mode]!.calm) { drawFx(this.fx!, ctx, old, next, t, w, h, e); return; }
      mode = 1;
    }
    draw(old);
    const x = Math.floor(s * w), y = Math.floor(s * h), half = Math.floor(s * w / 2);
    switch (mode) {
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
        clip(0, 0, half, h, () => draw(next, half - Math.floor(w / 2)));
        clip(w - half, 0, half, h, () => draw(next, Math.floor(w / 2) - half)); break;
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
        // AVS's stepped, repeating dot grid (not stochastic noise). Cell and dot scale with the surface (unit 1 on every classic AVS surface).
        const unit = transitionUnit(w, h), cell = (1 << Math.max(0, 4 - Math.floor(s * 5))) + 1, spacing = cell * unit;
        const tc = scratch(this.tile, spacing, spacing); tc.fillStyle = '#fff'; tc.fillRect((cell - 1) * unit, (cell - 1) * unit, unit, unit);
        const mc = scratch(this.mask, w, h);
        mc.drawImage(next, 0, 0, w, h); mc.globalCompositeOperation = 'destination-in';
        mc.fillStyle = mc.createPattern(this.tile, 'repeat')!; mc.fillRect(0, 0, w, h);
        draw(this.mask); break;
      }
    }
  }
}
