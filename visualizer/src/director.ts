// The preset director — automatic, musically-timed preset changes.
//
// A show that never changes preset is a screensaver; a show that changes
// whenever it feels like it is a slideshow. Both failures are avoided by the
// same rule the whole project runs on: cuts land on a MUSICAL boundary, decided
// ahead of time (§4.3), never reacted to.
//
// What this module does NOT do:
//   - own the preset content (that is src/presets/)
//   - execute anything (it returns a decision; the caller applies it)
//   - crossfade (see §Transitions below — a cut is the right default and a
//     crossfade costs a second full pass chain)
//
// It is deliberately source-agnostic: it knows nothing about layers, shaders or
// audio buffers, only about bars and a bank of names. That is what makes it
// testable without a GPU.

import type { Preset, Timeline } from './contracts.ts';
import { Scheduler, type FiredEvent } from './timeline.ts';
import { hash2 } from './rng.ts';

/** Bar counts that read as a musical section rather than an arbitrary timer. */
export const PHRASE_CHOICES = [4, 8, 16, 32] as const;
export type PhraseBars = (typeof PHRASE_CHOICES)[number];

/** Holds used by the responsive director. None are arbitrary wall-clock times. */
const DYNAMIC_HOLDS = [2, 3, 4, 6, 8, 12] as const;

/**
 * How the next preset is chosen.
 *
 * `shuffle` is the default and is NOT random: it is a seeded permutation, so a
 * show replays identically (§4.7) and the golden harness stays byte-stable. A
 * genuinely random pick would also happily play the same preset twice in a row,
 * which reads as the director having crashed.
 */
export type PickMode = 'shuffle' | 'sequential' | 'hold';

export interface DirectorEntry {
  readonly preset: Preset;
  /**
   * Relative likelihood in `shuffle`. 0 excludes it from automatic selection
   * while leaving it reachable by hand — useful for a preset you are still
   * working on.
   */
  readonly weight?: number;
  /**
   * Optional energy gate, 0..1, matched against the caller's energy estimate.
   * A quiet ink preset landing on a drop is worse than no change at all.
   */
  readonly minEnergy?: number;
  readonly maxEnergy?: number;
  /** Which art-direction look this is, used by `suggestTransition`. */
  readonly look?: string;
  /** Coarse render cost used to avoid long held-frame blends into heavy scenes. */
  readonly cost?: 'light' | 'medium' | 'heavy';
  /** Overrides the suggestion when entering THIS preset. */
  readonly transition?: TransitionSpec;
}

export interface DirectorOptions {
  /** Static cadence, retained for callers that explicitly disable dynamic mode. */
  every?: PhraseBars;
  /** Default: react to musical energy while continuing to land only on bar boundaries. */
  dynamic?: boolean;
  /** Shortest permitted hold in responsive mode. Defaults to two bars. */
  minBars?: number;
  /** Longest permitted hold in responsive mode. Defaults to twelve bars. */
  maxBars?: number;
  mode?: PickMode;
  /** Seeds the shuffle. Same seed + same bank = same running order, forever. */
  seed?: number;
  /**
   * Used when an entry declares none and the looks give no hint. Default is a
   * hard cut: a change you did not ask for should be legible, not smeared.
   */
  defaultTransition?: TransitionSpec;
  /** Start enabled. Off by default: nothing should start moving on its own. */
  enabled?: boolean;
}

export interface DirectorChange {
  readonly preset: Preset;
  readonly index: number;
  /** Audio-clock time of the boundary this change belongs to. */
  readonly time: number;
  /** Which cycle produced it — the hash input, so a change is reproducible. */
  readonly cycle: number;
  readonly reason: 'phrase' | 'manual' | 'drop';
  /** How to get there. The caller applies it; see `Transition`. */
  readonly transition: TransitionSpec;
}

/**
 * Decides WHEN to change preset and to WHICH. Returns a change; applying it is
 * the caller's job, because loading a preset touches the layer stack, the
 * scheduler and the renderer's target pool, and none of those belong here.
 */
export class PresetDirector {
  private bank: DirectorEntry[];
  private scheduler = new Scheduler();
  /** Index into `bank`, not into the caller's list. */
  private current = 0;
  private cycle = 0;
  /** Recently played, newest first. Prevents an immediate repeat. */
  private recent: number[] = [];
  /** The next planned change boundary. `null` means auto has not started yet. */
  private nextBar: number | null = null;
  private lastChangeBar = -Infinity;
  private lastEnergy = 0;
  /** Strongest onset since the most recent bar decision. */
  private pendingImpact = 0;

  enabled: boolean;
  every: PhraseBars;
  dynamic: boolean;
  minBars: number;
  maxBars: number;
  mode: PickMode;
  seed: number;
  defaultTransition: TransitionSpec;

  constructor(bank: DirectorEntry[], opts: DirectorOptions = {}) {
    if (bank.length === 0) throw new Error('PresetDirector needs at least one preset');
    this.bank = bank;
    this.every = opts.every ?? 8;
    this.dynamic = opts.dynamic ?? true;
    this.minBars = Math.max(1, Math.round(opts.minBars ?? 2));
    this.maxBars = Math.max(this.minBars, Math.round(opts.maxBars ?? 12));
    this.mode = opts.mode ?? 'shuffle';
    this.seed = opts.seed ?? 0x5eed;
    this.enabled = opts.enabled ?? false;
    this.defaultTransition = opts.defaultTransition ?? CUT;
  }

  /** Output latency compensation, mirroring the layer scheduler. */
  set outputLatency(v: number) { this.scheduler.outputLatency = v; }

  get currentIndex(): number { return this.current; }
  get currentPreset(): Preset { return this.bank[this.current]!.preset; }
  get size(): number { return this.bank.length; }

  /** Replace the bank, keeping the current preset selected if it is still present. */
  setBank(bank: DirectorEntry[]): void {
    if (bank.length === 0) throw new Error('PresetDirector needs at least one preset');
    const keep = this.bank[this.current]?.preset.name;
    this.bank = bank;
    const found = bank.findIndex((e) => e.preset.name === keep);
    this.current = found >= 0 ? found : 0;
    this.recent.length = 0;
  }

  /**
   * Poll once per frame. Returns a change only on the frame a boundary fires.
   *
   * `energy` is 0..1 and gates entries with min/maxEnergy — pass the tension
   * score or a smoothed level. Omit it and the gates are ignored.
   */
  update(timeline: Timeline, now: number, energy?: number, impact = 0): DirectorChange | null {
    if (!this.enabled || this.mode === 'hold' || this.bank.length < 2) return null;

    // Onsets may land between the bar checks below. Remember only the strongest
    // one; a flurry should make a confident decision, not enqueue a flurry of
    // changes. This remains deterministic because the audio snapshot is an
    // input to the frame, just like `energy`.
    this.pendingImpact = Math.max(this.pendingImpact, clamp01(impact));

    // One request, on the bar, keyed so its fire state is stable. `anchor:
    // 'start'` because a preset cut has no attack to land the peak of — the
    // change IS the event. A zero envelope keeps the scheduler from adding lead.
    const fired: FiredEvent[] = this.scheduler.due(timeline, now, {
      key: 'director',
      // euclidK/N = 1/1 is "every tick" — the Euclidean generator's identity.
      // Not optional on TriggerSpec, and 0/0 would silently produce no ticks.
      trigger: { division: 'bar', probability: 1, euclidK: 1, euclidN: 1, offsetSteps: 0 },
      anchor: 'start',
      envelope: { attackBeats: 0, holdBeats: 0, releaseBeats: 0 },
      seed: this.seed,
    });
    if (fired.length === 0) return null;

    // A backlog can deliver several bars at once after a stall. Only the LAST
    // matters — replaying intermediate changes would flash through presets.
    const last = fired[fired.length - 1]!;
    const bar = Math.floor(last.tick);
    const level = clamp01(energy ?? this.lastEnergy);

    // Fixed cadence remains available for embedders who want it, but the app
    // runs responsive mode: it plans a new phrase after each change rather
    // than consulting one global modulo clock forever.
    if (!this.dynamic) {
      if (bar % this.every !== 0) return null;
      return this.advance(now, last.time, 'phrase', level);
    }

    if (this.nextBar === null) {
      this.lastChangeBar = bar;
      this.nextBar = bar + this.nextHold(bar, level, this.pendingImpact);
      this.lastEnergy = level;
      this.pendingImpact = 0;
      return null;
    }

    const heldBars = bar - this.lastChangeBar;
    const rise = level - this.lastEnergy;
    // A pronounced onset with a real energy lift can pull a planned change
    // forward, but never inside the two-bar minimum. That is the musical
    // equivalent of reacting to a drop without turning the director into a
    // trigger-happy slideshow.
    const earlyDrop = heldBars >= this.minBars
      && this.pendingImpact >= 0.72
      && level >= 0.38
      && rise >= 0.08;
    if (bar < this.nextBar && !earlyDrop) {
      this.lastEnergy = level;
      this.pendingImpact = 0;
      return null;
    }

    const change = this.advance(now, last.time, 'phrase', level);
    this.lastChangeBar = bar;
    this.nextBar = bar + this.nextHold(bar, level, this.pendingImpact);
    this.lastEnergy = level;
    this.pendingImpact = 0;
    return change;
  }

  /** Change now, outside the grid. For a key press or a detected drop. */
  jump(now: number, reason: 'manual' | 'drop' = 'manual', energy?: number): DirectorChange {
    return this.advance(now, now, reason, energy);
  }

  /** Step by hand without disturbing the automatic cycle's determinism. */
  step(delta: number, now: number): DirectorChange {
    const from = this.current;
    this.current = (this.current + delta + this.bank.length) % this.bank.length;
    this.remember(this.current);
    return {
      preset: this.currentPreset, index: this.current,
      time: now, cycle: this.cycle, reason: 'manual',
      transition: this.transitionFor(from, this.current),
    };
  }

  private advance(now: number, time: number, reason: DirectorChange['reason'], energy?: number): DirectorChange {
    this.cycle++;
    const from = this.current;
    const next = this.mode === 'sequential'
      ? (this.current + 1) % this.bank.length
      : this.pickWeighted(energy);
    this.current = next;
    this.remember(next);
    void now;
    return {
      preset: this.currentPreset, index: next, time, cycle: this.cycle, reason,
      transition: this.transitionFor(from, next),
    };
  }

  /**
   * Explicit entry override, else a suggestion from the two looks, else the
   * bank default. Deterministic — no hashing here, because a transition that
   * varies run to run makes two otherwise identical shows diverge visually
   * while the golden harness still calls them equal.
   */
  private transitionFor(from: number, to: number): TransitionSpec {
    const entry = this.bank[to];
    if (entry?.transition) return entry.transition;
    const fromEntry = this.bank[from];
    if (fromEntry?.cost === 'heavy' || entry?.cost === 'heavy') return { kind: 'cut', beats: 0 };
    const suggested = suggestTransition(this.bank[from]?.look, entry?.look);
    return suggested.kind === 'cut' ? this.defaultTransition : suggested;
  }

  /**
   * Seeded weighted pick, excluding anything played recently.
   *
   * Deterministic by construction: the only inputs are the seed, the cycle
   * counter and the bank. No Math.random anywhere (§4.7) — a show must replay
   * identically, and the golden harness compares byte-for-byte.
   */
  private pickWeighted(energy?: number): number {
    // Do not let the exclusion window eat the whole bank.
    const window = Math.min(this.recent.length, Math.max(0, this.bank.length - 2));
    const banned = new Set(this.recent.slice(0, window));

    const eligible: number[] = [];
    const weights: number[] = [];
    for (let i = 0; i < this.bank.length; i++) {
      if (banned.has(i)) continue;
      const e = this.bank[i]!;
      const w = e.weight ?? 1;
      if (w <= 0) continue;
      if (energy !== undefined) {
        if (e.minEnergy !== undefined && energy < e.minEnergy) continue;
        if (e.maxEnergy !== undefined && energy > e.maxEnergy) continue;
      }
      eligible.push(i);
      weights.push(w);
    }

    // Every candidate filtered out — by the energy gate, most likely. Falling
    // back to "anything but the current one" is better than refusing to change,
    // because a director that silently stops is indistinguishable from a bug.
    if (eligible.length === 0) {
      const alt = (this.current + 1) % this.bank.length;
      return alt;
    }

    let total = 0;
    for (const w of weights) total += w;
    let r = hash2(this.seed, this.cycle) * total;
    for (let i = 0; i < eligible.length; i++) {
      r -= weights[i]!;
      if (r <= 0) return eligible[i]!;
    }
    return eligible[eligible.length - 1]!;
  }

  private remember(i: number): void {
    this.recent.unshift(i);
    if (this.recent.length > 8) this.recent.length = 8;
  }

  /** After a seek or a track change: forget fire state so nothing back-fires. */
  reset(): void {
    this.scheduler.reset();
    this.recent.length = 0;
    this.cycle = 0;
    this.nextBar = null;
    this.lastChangeBar = -Infinity;
    this.lastEnergy = 0;
    this.pendingImpact = 0;
  }

  /** Choose the next hold from musical states, never from elapsed seconds. */
  private nextHold(bar: number, energy: number, impact: number): number {
    let candidates: readonly number[];
    if (impact >= 0.7) candidates = [2, 3, 4];
    else if (energy >= 0.72) candidates = [2, 3, 4, 4, 6];
    else if (energy <= 0.26) candidates = [4, 6, 8, 8, 12];
    else candidates = [3, 4, 4, 6, 8];

    const allowed = candidates.filter((bars) => bars >= this.minBars && bars <= this.maxBars);
    const pool = allowed.length > 0
      ? allowed
      : DYNAMIC_HOLDS.filter((bars) => bars >= this.minBars && bars <= this.maxBars);
    const fallback = Math.max(this.minBars, Math.min(this.maxBars, 4));
    if (pool.length === 0) return fallback;
    const index = Math.min(pool.length - 1, Math.floor(hash2(this.seed, bar + this.cycle * 97) * pool.length));
    return pool[index] ?? fallback;
  }
}

function clamp01(v: number): number {
  return v < 0 ? 0 : v > 1 ? 1 : v;
}

// -----------------------------------------------------------------------------
// Transitions
// -----------------------------------------------------------------------------

/**
 * How one preset becomes the next.
 *
 * `cut` and `crossfade` are deliberate opposites and both are wanted: a cut is
 * a decision, a crossfade is a breath. `build` and `dissolve` sit between them.
 */
export type TransitionKind =
  /** Instant, on the downbeat. Free, and reads as intentional — what a VJ does. */
  | 'cut'
  /** Cut, but the incoming preset's envelopes start at zero so the look builds in. */
  | 'build'
  // --- everything below renders BOTH chains and blends by a spatial mask ------
  /** Uniform blend. The exact opposite of a cut. */
  | 'crossfade'
  /** Hashed per-pixel threshold — a grain dissolve. */
  | 'dissolve'
  /** Straight edge sweeping at `angle`. */
  | 'wipe'
  /** Angular sweep about the centre — a clock wipe. */
  | 'radial'
  /** Circle growing or shrinking from the centre. */
  | 'iris'
  /** N strips wiping in sequence, staggered along `angle`. */
  | 'panelWipe'
  /** N strips each flipping about their own axis — the card-turn fade. */
  | 'panelFlip'
  /** Horizontal bands sliding opposite ways as they hand over. */
  | 'slice';

/**
 * Numeric ids shared with the shader.
 *
 * Declared ONCE here and emitted into WGSL by `transitionWgslConstants()`. Two
 * hand-maintained lists of the same numbers is exactly the drift that validates
 * cleanly and then plays the wrong transition.
 */
export const TRANSITION_ID: Readonly<Record<TransitionKind, number>> = {
  cut: 0, build: 1, crossfade: 2, dissolve: 3, wipe: 4,
  radial: 5, iris: 6, panelWipe: 7, panelFlip: 8, slice: 9,
};

/** Emit the WGSL const block. Prepend this to transition.wgsl. */
export function transitionWgslConstants(): string {
  return Object.entries(TRANSITION_ID)
    .map(([k, v]) => 'const TR_' + k.toUpperCase() + ' : f32 = ' + v.toFixed(1) + ';')
    .join('\n');
}

/**
 * Blend curve for the two-chain kinds.
 *
 * `equalPower` matters more than it sounds. Two DIFFERENT images crossfaded
 * linearly dip in perceived brightness at the midpoint, because neither is at
 * full strength and they do not correlate. cos/sin holds the sum of squares
 * constant and removes the sag. For ADDITIVE HDR content that already sums to
 * light, `linear` is the honest choice and equal-power will over-bright the
 * middle — so this is a real per-preset decision, not a default to ignore.
 */
export type TransitionCurve = 'linear' | 'equalPower' | 'smooth';

export interface TransitionSpec {
  readonly kind: TransitionKind;
  /** Duration in BEATS, converted at the live tempo. 0 for a cut. */
  readonly beats: number;
  readonly curve?: TransitionCurve;
  /** Radians. Direction for wipe/panelWipe/slice; start angle for radial. */
  readonly angle?: number;
  /** Edge softness in UV. 0 is a hard edge and will alias — keep a pixel or two. */
  readonly softness?: number;
  /** Strip count for panelWipe/panelFlip/slice. */
  readonly panels?: number;
  /** iris: true grows from the centre, false closes onto it. */
  readonly grow?: boolean;
}

/** Kinds that need a held image of the outgoing chain. */
const TWO_CHAIN: ReadonlySet<TransitionKind> = new Set<TransitionKind>([
  'crossfade', 'dissolve', 'wipe', 'radial', 'iris', 'panelWipe', 'panelFlip', 'slice',
]);

export const CUT: TransitionSpec = { kind: 'cut', beats: 0 };

/**
 * The running state of one transition.
 *
 * The caller drives it: at start it captures the outgoing accumulator once,
 * then renders the incoming stack and blends that live image against the held
 * frame by `mix`. This is deliberately a held-frame transition, not two live
 * scene graphs. The object never touches the GPU — it is arithmetic on the
 * audio clock and deterministic by construction (§4.7).
 */
export class Transition {
  private spec: TransitionSpec = CUT;
  private startTime = 0;
  private endTime = 0;
  private running = false;

  /** 0 = fully the outgoing preset, 1 = fully the incoming one. */
  mix = 1;
  /** Set for `dissolve`; the shader uses it to offset its threshold hash. */
  seed = 0;

  get active(): boolean { return this.running; }
  get kind(): TransitionKind { return this.spec.kind; }
  get current(): TransitionSpec { return this.spec; }

  /**
   * Begin at `atTime` on the audio clock. `bpm` converts the beat duration —
   * captured once at the start rather than tracked, so a tempo wobble mid-fade
   * cannot stretch or truncate a transition that is already underway.
   */
  begin(spec: TransitionSpec, atTime: number, bpm: number, seed = 0): void {
    this.spec = spec;
    this.seed = seed;
    if (spec.kind === 'cut' || spec.beats <= 0 || !(bpm > 0)) {
      this.running = false;
      this.mix = 1;
      return;
    }
    this.startTime = atTime;
    this.endTime = atTime + spec.beats * (60 / bpm);
    this.running = true;
    this.mix = 0;
  }

  /** Call once per frame with the audio clock. Returns true while blending. */
  update(now: number): boolean {
    if (!this.running) { this.mix = 1; return false; }
    const span = this.endTime - this.startTime;
    const t = span > 0 ? (now - this.startTime) / span : 1;
    if (t >= 1) {
      this.running = false;
      this.mix = 1;
      return false;
    }
    // Clamped rather than assumed in range: a seek backwards can hand us a
    // negative t, and a negative mix silently inverts the blend.
    this.mix = curveAt(Math.max(0, t), this.spec.curve ?? 'linear');
    return true;
  }

  /** Seek, track change, or a manual override mid-fade. */
  cancel(): void { this.running = false; this.mix = 1; }
}

function curveAt(t: number, curve: TransitionCurve): number {
  switch (curve) {
    case 'equalPower': return Math.sin((t * Math.PI) / 2);
    case 'smooth':     return t * t * (3 - 2 * t);
    default:           return t;
  }
}

/**
 * Does this kind need a held outgoing-frame snapshot?
 *
 * `cut` and `build` need only the live incoming accumulator. The other kinds
 * retain one extra full-resolution HDR image captured before the preset swap.
 *
 * There is no second live stack, but the held image costs memory and a composite
 * pass. Long freezes are also visually obvious, so heavy entries force a cut
 * and same-look held-frame blends stay short.
 */
export function needsBothChains(kind: TransitionKind): boolean {
  return TWO_CHAIN.has(kind);
}

/** Pack a spec into the shader's uniform. Order must match `struct Trans`. */
export function packTransition(
  spec: TransitionSpec, mix: number, seed: number, aspect: number, out: Float32Array,
): void {
  out[0] = TRANSITION_ID[spec.kind];
  out[1] = mix;
  out[2] = spec.angle ?? 0;
  out[3] = spec.softness ?? 0.04;
  out[4] = Math.max(1, Math.round(spec.panels ?? 8));
  out[5] = seed;
  out[6] = aspect;
  out[7] = spec.grow === false ? 0 : 1;
}

/** Does the incoming preset start its envelopes from zero? */
export function buildsIn(kind: TransitionKind): boolean {
  return kind === 'build';
}

/**
 * A sensible transition for a change, given how far apart the two looks are.
 *
 * Cutting between two presets of the same look reads as a glitch; crossfading
 * between a quiet ink preset and a rave one reads as mud. So: same look ->
 * blend, different look -> cut. Deterministic, and overridable per entry.
 */
export function suggestTransition(fromLook: string | undefined, toLook: string | undefined): TransitionSpec {
  if (!fromLook || !toLook) return CUT;
  if (fromLook === toLook) return { kind: 'crossfade', beats: 1, curve: 'equalPower' };
  return { kind: 'build', beats: 2 };
}
