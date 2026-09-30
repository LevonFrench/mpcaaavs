// The 13 motion models of docs/design/SPRITE-SHOW-KIT.md ("Motion models"): projectiles and moving actors as pure functions of the
// beat grid, so things arrive on beats. A flight (straight, arc, sine, boomerang, homing, bounce, spread, fall, rise, swoop) runs from
// beat `beat0` to beat `beat1` (continuous beat indices; the choreographer puts `beat1` on a whole beat so the arrival lands on the
// grid) and reads its progress from the clock's beat; the continuous models (orbit, hover, pendulum) read the beat or bar phase.
// Positions are native pixels, y down.
import type { MotionModel } from '../../asset-packs/manifest.ts';

export type Vec = readonly [number, number];
/** Continuous beat index and continuous bar index (the song's own downbeat grid) at a moment. */
export interface MotionClock { readonly beat: number; readonly bar: number }

export interface MotionSpec {
  readonly model: MotionModel;
  /** Start (for orbit: centre, hover: rest position, pendulum: pivot) and end point. */
  readonly from: Vec;
  readonly to: Vec;
  readonly beat0: number;
  readonly beat1: number;
  /** Size in px: arc height, sine amplitude, bounce height, boomerang curve, orbit radius, hover bob, rise depth, pendulum length. */
  readonly amp?: number;
  /** sine: beats per wave. */
  readonly periodBeats?: number;
  /** spread: shots in the fan and this shot's index, fan half-angle in radians. */
  readonly count?: number;
  readonly index?: number;
  readonly fan?: number;
  /** orbit: turns per bar (default 1) and start phase in turns. pendulum: swing half-angle in radians via `fan`. */
  readonly turns?: number;
  readonly phase?: number;
  /** homing: where the target is at this clock (defaults to `to`). */
  readonly target?: (clock: MotionClock) => Vec;
}

export interface MotionState {
  readonly x: number;
  readonly y: number;
  /** Flight progress 0..1 (0 before the launch, 1 from the arrival on); 0 for the continuous models. */
  readonly u: number;
  /** Heading or swing angle in radians. */
  readonly angle: number;
  /** rise: y below which the sprite is hidden (the floor it emerges from); null otherwise. */
  readonly clipY: number | null;
  /** True once a flight has arrived (continuous models are never done). */
  readonly done: boolean;
}

const clamp01 = (x: number) => (x < 0 ? 0 : x > 1 ? 1 : x);
const fract = (x: number) => x - Math.floor(x);
const outQuad = (t: number) => 1 - (1 - t) * (1 - t);
const outCubic = (t: number) => 1 - (1 - t) ** 3;
const smooth = (t: number) => t * t * (3 - 2 * t);
export const TAU = Math.PI * 2;

export const FLIGHT_MODELS: readonly MotionModel[] = ['straight', 'arc', 'sine', 'boomerang', 'homing', 'bounce', 'spread', 'fall', 'rise', 'swoop'];
export const CONTINUOUS_MODELS: readonly MotionModel[] = ['orbit', 'hover', 'pendulum'];

/** Flight progress before clamping (negative before the launch, above 1 after the arrival). */
export const rawProgress = (spec: MotionSpec, clock: MotionClock): number => (clock.beat - spec.beat0) / Math.max(1e-9, spec.beat1 - spec.beat0);

export function motionAt(spec: MotionSpec, clock: MotionClock): MotionState {
  const raw = rawProgress(spec, clock), u = clamp01(raw);
  const [fx, fy] = spec.from, [tx, ty] = spec.to;
  const dx = tx - fx, dy = ty - fy, dist = Math.hypot(dx, dy) || 1;
  const heading = Math.atan2(dy, dx);
  const done = raw >= 1;
  const out = (x: number, y: number, angle = heading, clipY: number | null = null): MotionState => ({ x, y, u, angle, clipY, done });
  switch (spec.model) {
    case 'straight': return out(fx + dx * u, fy + dy * u);
    case 'arc': {
      const h = spec.amp ?? Math.max(16, dist * 0.25);
      const y = fy + dy * u - 4 * h * u * (1 - u);
      const vy = dy - 4 * h * (1 - 2 * u);
      return out(fx + dx * u, y, Math.atan2(vy, dx));
    }
    case 'sine': {
      const a = spec.amp ?? 10, period = Math.max(0.25, spec.periodBeats ?? 2);
      const w = Math.sin(TAU * (clock.beat - spec.beat0) / period) * (done ? 0 : 1);
      const nx = -dy / dist, ny = dx / dist;
      return out(fx + dx * u + nx * a * w, fy + dy * u + ny * a * w);
    }
    case 'boomerang': {
      const s = u < 0.5 ? outQuad(2 * u) : outQuad(2 - 2 * u);
      const curve = (spec.amp ?? 0) * Math.sin(Math.PI * u), nx = -dy / dist, ny = dx / dist;
      return out(fx + dx * s + nx * curve, fy + dy * s + ny * curve);
    }
    case 'homing': {
      const [gx, gy] = spec.target ? spec.target(clock) : spec.to;
      const e = smooth(u);
      return out(fx + (gx - fx) * e, fy + (gy - fy) * e, Math.atan2(gy - fy, gx - fx));
    }
    case 'bounce': {
      // contacts on every whole beat: the first arc runs from the launch to the next beat, then one arc per beat, each lower than the last
      const b0 = Math.ceil(spec.beat0 - 1e-9);
      let k: number, ph: number;
      if (clock.beat < b0) { k = 0; ph = (clock.beat - spec.beat0) / Math.max(1e-9, b0 - spec.beat0); }
      else { k = Math.floor(clock.beat - b0) + 1; ph = fract(clock.beat - b0); }
      const h = (spec.amp ?? 14) * 0.8 ** k * 4 * ph * (1 - ph) * (done || raw <= 0 ? 0 : 1);
      return out(fx + dx * u, fy + dy * u - h, 0);
    }
    case 'spread': {
      const n = Math.max(1, spec.count ?? 5), i = Math.min(n - 1, Math.max(0, spec.index ?? 0)), fan = spec.fan ?? 0.5;
      const th = heading + (n > 1 ? -fan + (2 * fan * i) / (n - 1) : 0);
      return out(fx + Math.cos(th) * dist * u, fy + Math.sin(th) * dist * u, th);
    }
    case 'orbit': {
      const r = spec.amp ?? 20, turns = spec.turns ?? 1;
      const a = TAU * (turns * clock.bar + (spec.phase ?? 0));
      return { x: fx + r * Math.cos(a), y: fy + r * 0.6 * Math.sin(a), u: 0, angle: a, clipY: null, done: false };
    }
    case 'fall': return out(tx, fy + dy * u * u, Math.PI / 2);
    case 'rise': {
      const depth = spec.amp ?? 24, e = outCubic(u);
      return out(tx, ty + depth * (1 - e), -Math.PI / 2, ty);
    }
    case 'swoop': {
      // quadratic Bezier that is at `to` exactly half way: in from `from`, out to its mirror image across `to`
      const p2x = 2 * tx - fx, p2y = fy, cx = 2 * tx - 0.5 * (fx + p2x), cy = 2 * ty - 0.5 * (fy + p2y);
      const a = (1 - u) ** 2, b = 2 * (1 - u) * u, c = u * u;
      const x = a * fx + b * cx + c * p2x, y = a * fy + b * cy + c * p2y;
      const vx = 2 * (1 - u) * (cx - fx) + 2 * u * (p2x - cx), vy = 2 * (1 - u) * (cy - fy) + 2 * u * (p2y - cy);
      return out(x, y, Math.atan2(vy, vx));
    }
    case 'hover': {
      const a = spec.amp ?? 4;
      return { x: fx + a * 0.8 * Math.sin(TAU * clock.bar), y: fy - a * (0.5 + 0.5 * Math.cos(TAU * clock.beat)), u: 0, angle: 0, clipY: null, done: false };
    }
    case 'pendulum': {
      const swing = spec.fan ?? 0.6, len = spec.amp ?? 24;
      const th = swing * Math.cos(TAU * clock.bar);
      return { x: fx + len * Math.sin(th), y: fy + len * Math.cos(th), u: 0, angle: th, clipY: null, done: false };
    }
  }
}

/** The whole beat a flight that starts at `beat0` should land on, at least `minBeats` later. */
export const landingBeat = (beat0: number, minBeats: number): number => Math.ceil(beat0 + minBeats - 1e-6);
