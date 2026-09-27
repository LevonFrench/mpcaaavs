// The layer graph (plan §4.1) — the ordered stack, its blending, its envelopes,
// and the pass/target allocation plan the renderer executes.
//
// This file replaces the hard-coded pass order of the Phase 0.5 slice with data.
// Its job is to answer three questions per frame, in this order:
//
//   1. Which layers are live right now, and how far through their envelope are
//      they? (`resolve`)
//   2. How does each one composite? (`BLEND_PLANS`)
//   3. What is the minimum set of render passes and targets that produces that
//      composite? (`planStack`)
//
// What it deliberately does NOT do: touch a GPUDevice, own a texture, know what
// any layer type draws, or read a clock. It is handed `nowBeats` and returns
// plain data. That is what makes the golden-image harness possible — the same
// beats in must give the same plan and the same envelope values out, on any
// machine (§4.7). It also means this module can be unit-tested without a GPU,
// which matters because pass merging is the kind of arithmetic that is wrong in
// a way you cannot see by looking at the frame.
//
// Everything musical is in BEATS. There is no seconds-domain number anywhere in
// this file except the ones the caller has already converted.

import {
  type Anchor,
  type BlendMode,
  type Envelope,
  type LayerFamily,
  type LayerSpec,
  type Preset,
  SLOTS_PER_BEAT,
  anchorLeadBeats,
} from './contracts.ts';
import { DIVISIONS, type DivisionName } from './clock.ts';
import { hash2, hashString, hashU32 } from './rng.ts';
import { BLEND_INFO, type BlendInfo } from './blend.ts';

// ---------------------------------------------------------------------------
// Blend modes (plan §4.1)
// ---------------------------------------------------------------------------

/**
 * Compatibility names for callers that pre-date the canonical blend module.
 * `BlendInfo` is a strict superset of the old plan, so the planner receives the
 * same data while the table has one source of truth.
 */
export type BlendPlan = BlendInfo;
export const BLEND_PLANS: Readonly<Record<BlendMode, BlendPlan>> = BLEND_INFO;

/** The blend constant to set for a layer, or `null` when the pipeline does not use one. */
export function blendConstantFor(spec: LayerSpec): number | null {
  if (spec.blend === '50/50') return 0.5;
  if (spec.blend === 'adjustable') {
    const raw = spec.params['mix'];
    return typeof raw === 'number' ? clamp01(raw) : 0.5;
  }
  return null;
}

// ---------------------------------------------------------------------------
// Euclidean rhythms (plan §4.4)
// ---------------------------------------------------------------------------

/**
 * Bjorklund's algorithm. `E(k, n)` distributes `k` onsets as evenly as possible
 * over `n` steps, which is most of the rhythms anyone actually plays from two
 * integers.
 *
 * `k = 0` returns an all-false pattern and that is a legitimate answer, not an
 * edge case to guard against: silence has to be expressible or the show never
 * rests (art direction §3.5).
 */
export function euclid(k: number, n: number): boolean[] {
  if (n <= 0) return [];
  if (k <= 0) return new Array<boolean>(n).fill(false);
  if (k >= n) return new Array<boolean>(n).fill(true);

  let head: boolean[][] = [];
  let tail: boolean[][] = [];
  for (let i = 0; i < k; i++) head.push([true]);
  for (let i = 0; i < n - k; i++) tail.push([false]);

  // Fold the remainder into the head until at most one remainder group is left.
  while (tail.length > 1) {
    const pairs = Math.min(head.length, tail.length);
    const merged: boolean[][] = [];
    for (let i = 0; i < pairs; i++) merged.push([...head[i]!, ...tail[i]!]);
    const rest = head.length > pairs ? head.slice(pairs) : tail.slice(pairs);
    head = merged;
    tail = rest;
  }

  const out: boolean[] = [];
  for (const group of head) out.push(...group);
  for (const group of tail) out.push(...group);
  return out;
}

// ---------------------------------------------------------------------------
// Envelopes, in beats
// ---------------------------------------------------------------------------

/**
 * Curvature of the exponential attack and release. 5 puts the knee where the
 * eye expects it; the exact number is taste, but LINEAR is not an option —
 * symmetric linear envelopes are why a lot of audio-reactive work feels like a
 * bouncing progress bar (art direction §3.2).
 */
const ENV_CURVE = 5;

/** Normalised so it reaches exactly 1 at u = 1. Fast at first, then eases in. */
function attackCurve(u: number): number {
  return (1 - Math.exp(-ENV_CURVE * u)) / (1 - Math.exp(-ENV_CURVE));
}

/** Normalised so it reaches exactly 0 at u = 1 — see `evalEnvelope` for why that matters. */
function releaseCurve(u: number): number {
  return (Math.exp(-ENV_CURVE * u) - Math.exp(-ENV_CURVE)) / (1 - Math.exp(-ENV_CURVE));
}

/**
 * Envelope value 0..1 at `sinceBeats` beats after the trigger.
 *
 * Both curves are normalised to hit their endpoints EXACTLY. A release that
 * only asymptotes towards zero leaves every finished layer contributing a
 * fraction of a bit forever, and "a layer at 0 must be a true no-op" is a Phase
 * 5 DoD, not a nicety — an almost-zero layer still costs a full pass.
 *
 * A zero-length attack is treated as instant rather than as a division by zero,
 * because `attackBeats: 0` with `anchor: 'start'` is the correct spelling of a
 * strobe and the code should not make the user write 0.0001 instead.
 */
export function evalEnvelope(env: Envelope, sinceBeats: number): number {
  if (sinceBeats < 0) return 0;
  const a = Math.max(0, env.attackBeats);
  const h = Math.max(0, env.holdBeats);
  const r = Math.max(0, env.releaseBeats);

  if (sinceBeats < a) return attackCurve(sinceBeats / a);
  if (sinceBeats < a + h) return 1;
  if (r <= 0) return 0;
  const u = (sinceBeats - a - h) / r;
  return u >= 1 ? 0 : releaseCurve(u);
}

// ---------------------------------------------------------------------------
// Layer
// ---------------------------------------------------------------------------

/** Per-layer deterministic seed. Derived from the ID, never the array index — reordering must not change how a layer looks (§4.7). */
export function layerSeed(presetSeed: number, id: string): number {
  return hashU32(presetSeed ^ hashString(id));
}

/**
 * The runtime companion to a `LayerSpec`.
 *
 * The spec is immutable data that round-trips to JSON; the Layer is the small
 * amount of mutable state that cannot be serialised because it is a function of
 * where we are in the track — which pulse last fired, and when. Keeping them
 * apart is what makes "saved and reloaded pixel-identically" (Phase 3 DoD) a
 * property rather than a hope: reloading a preset rebuilds Layers from scratch,
 * so there is nothing stale to carry over.
 */
export class Layer {
  readonly spec: LayerSpec;
  /** Seeded from the preset and the layer ID. Every hashed decision this layer makes uses it. */
  readonly seed: number;
  /** Slots between pulses for this layer's division. Cached; it is a table lookup, but it is read every frame. */
  readonly strideSlots: number;
  private readonly pattern: readonly boolean[];

  /** Beat position of the last trigger. `-Infinity` means "never fired", which evaluates to an envelope of 0. */
  private triggeredAtBeats = -Infinity;
  /** Last pulse index examined, so a pulse cannot fire twice. Pulses CAN be skipped, but only via the explicit catch-up clamp in `update`. */
  private lastPulse = -Infinity;
  /** Runtime overrides. Not serialised — solo/mute are a mixing-desk gesture, not part of the preset. */
  muted = false;

  constructor(spec: LayerSpec, presetSeed: number) {
    this.spec = spec;
    this.seed = layerSeed(presetSeed, spec.id);
    this.strideSlots = DIVISIONS[spec.trigger.division as DivisionName];
    this.pattern = euclid(spec.trigger.euclidK, spec.trigger.euclidN);
  }

  get id(): string { return this.spec.id; }
  get family(): LayerFamily { return this.spec.family; }
  get blend(): BlendMode { return this.spec.blend; }
  get anchor(): Anchor { return this.spec.anchor; }

  /** How far ahead of the musical event this layer must fire so its payload lands on it (§4.3). */
  get leadBeats(): number {
    return anchorLeadBeats(this.spec.anchor, this.spec.envelope);
  }

  /**
   * Advance to `nowBeats` and fire any pulses that have come due.
   *
   * The lead is applied by looking AHEAD rather than by firing late and
   * back-dating: the trigger time recorded is the pulse's own beat position
   * minus the lead, so the envelope's phase is exact rather than quantised to
   * whenever this happened to be called. Two machines running at different
   * frame rates therefore agree on the envelope value, which is the whole of
   * §4.7 in one detail.
   *
   * Returns the number of pulses that fired this call — usually 0 or 1, more
   * only after a stall or on a very fast division.
   */
  update(nowBeats: number): number {
    const lookBeats = nowBeats + this.leadBeats;
    const pulseBeats = this.strideSlots / SLOTS_PER_BEAT;
    const pulse = Math.floor(lookBeats / pulseBeats);
    if (!Number.isFinite(pulse)) return 0;

    if (!Number.isFinite(this.lastPulse)) {
      // First sight of the clock. Do not fire retroactively for every pulse
      // since t=0 — that would dump hundreds of triggers into the first frame.
      this.lastPulse = pulse - 1;
    }

    let fired = 0;
    // Bounded so a bad tempo estimate cannot turn one frame into a thousand
    // iterations. clock.ts's scheduler has the same backstop for the same reason.
    const from = Math.max(this.lastPulse + 1, pulse - 64);
    for (let p = from; p <= pulse; p++) {
      this.lastPulse = p;
      if (!this.gate(p)) continue;
      this.triggeredAtBeats = p * pulseBeats - this.leadBeats;
      fired++;
    }
    return fired;
  }

  /** Does pulse `p` survive the Euclidean pattern and the probability roll? */
  private gate(p: number): boolean {
    const t = this.spec.trigger;
    if (this.pattern.length > 0) {
      const n = this.pattern.length;
      const step = ((p + t.offsetSteps) % n + n) % n;
      if (!this.pattern[step]) return false;
    }
    if (t.probability >= 1) return true;
    if (t.probability <= 0) return false;
    // Seeded, not Math.random(): the same preset over the same track must roll
    // the same dice on the same pulse (§4.7).
    return hash2(this.seed, p) < t.probability;
  }

  /** Envelope value 0..1 at `nowBeats`. Zero before the first trigger and after the release completes. */
  progress(nowBeats: number): number {
    return evalEnvelope(this.spec.envelope, nowBeats - this.triggeredAtBeats);
  }

  /**
   * The half of "is this layer live" that costs nothing to ask: the flags, with
   * no envelope evaluation. Split out because `resolve` needs the envelope value
   * anyway, and asking `isLive` first would evaluate it twice per layer per
   * frame — two `Math.exp` pairs times 40 layers times 120 fps, for an answer it
   * is about to compute again. Splitting rather than inlining keeps the two
   * callers from drifting apart about what "live" means.
   */
  get gateOpen(): boolean {
    return this.spec.enabled && !this.muted && this.spec.opacity > 0;
  }

  /** Whether this layer contributes anything at all right now. */
  isLive(nowBeats: number): boolean {
    return this.gateOpen && this.progress(nowBeats) > 0;
  }

  /**
   * Forget the trigger history. Called on seek and track change (§4.10) — a
   * layer that is mid-release from a passage we jumped away from is visually
   * wrong, and its `lastPulse` is on the wrong side of the new position, which
   * would suppress every trigger until the clock caught up.
   */
  reset(): void {
    this.triggeredAtBeats = -Infinity;
    this.lastPulse = -Infinity;
  }
}

// ---------------------------------------------------------------------------
// Resolved frame state
// ---------------------------------------------------------------------------

export interface ResolvedLayer {
  readonly layer: Layer;
  /** Envelope value 0..1. Layer implementations use this for whatever they modulate. */
  readonly progress: number;
  /** `spec.opacity * progress` — what the compositor should actually use. */
  readonly opacity: number;
  /** Blend constant for `setBlendConstant`, or null if this pipeline has none. */
  readonly blendConstant: number | null;
}

// ---------------------------------------------------------------------------
// Pass and target allocation (plan §4.11)
// ---------------------------------------------------------------------------

/**
 * - `draw` — one or more layers rendered with fixed-function blending into an
 *   attachment they do not read, `loadOp: 'load'`. Usually the accumulator; the
 *   scratch target when `usesScratch` is set.
 * - `transform` — SAMPLES the accumulator and writes elsewhere. Warps,
 *   operators, and merged runs of colour layers.
 *
 * `kind` answers "does this pass bind the accumulator as an input texture?" and
 * nothing else. Whether the result lands on the other accumulator side is
 * `swapsAccumulator`, and whether it lands on scratch is `usesScratch` — the
 * three are deliberately independent, because a warp with a shader blend is a
 * transform that writes scratch and does not swap.
 * - `feedback` — updates a layer's own dedicated ping-pong pair. Does not touch
 *   the accumulator; the composite is a separate entry.
 * - `composite` — resolves a `shader` blend: samples a scratch (or feedback)
 *   target plus the accumulator and writes the other accumulator side. Swaps.
 */
export type PassKind = 'draw' | 'transform' | 'feedback' | 'composite';

export interface PassPlan {
  readonly label: string;
  readonly kind: PassKind;
  /** Layers handled by this pass, in stack order. Longer than one only for a merged run. */
  readonly layerIds: readonly string[];
  /** The caller must swap the accumulator's ping-pong after this pass. */
  readonly swapsAccumulator: boolean;
  /** This pass needs the shared scratch target. */
  readonly usesScratch: boolean;
  /** Set on `feedback` passes and on the `composite` that consumes one. */
  readonly feedbackSlot?: string;
  /**
   * Full-res fraction. Never a compromise between members: layers of differing
   * scale are not merged at all (a render pass has one attachment size), so
   * every member of a run shares this exact value.
   */
  readonly resolutionScale: number;
}

export interface StackPlan {
  readonly passes: readonly PassPlan[];
  /** IDs of layers that own a dedicated ping-pong pair. */
  readonly feedbackSlots: readonly string[];
  /** 0 or 1. One scratch target is enough because its contents are consumed by the very next pass. */
  readonly scratchTargets: number;
  /** §4.11: the pass COUNT is the budget, so it is reported as a first-class number. */
  readonly passCount: number;
  /** 2 (accumulator pair) + 2 per feedback slot + scratch. */
  readonly targetCount: number;
}

/**
 * Decide the passes for a resolved stack.
 *
 * The merging rules, and why each one is what it is:
 *
 * - Consecutive `source` layers with fixed-function blends share ONE render
 *   pass. A source does not read the accumulator, so N of them are N draw calls
 *   into the same attachment, not N passes. This is the single biggest win
 *   available: at 2K120 a full-screen RGBA16F pass moves ~7 GB/s doing nothing
 *   but copying (§4.11).
 * - Consecutive `color` layers merge into one `transform`. A colour op reads
 *   only its own pixel, so a run of them is a chain of pure functions that a
 *   single shader can apply in sequence. This is §4.11's "merge, don't
 *   ping-pong" verbatim, and it is why `LayerFamily` is a scheduling decision
 *   rather than cosmetic taxonomy.
 * - `warp` and `operator` NEVER merge, with each other or with anything. They
 *   sample the accumulated frame at displaced coordinates, so the result
 *   depends on neighbours, so the input must be a finished texture. Two warps in
 *   one shader would sample the pre-warp frame twice and produce a different
 *   image from the one the user composed.
 * - Layers of different `resolutionScale` never merge either. A render pass has
 *   one attachment size; there is no per-draw resolution.
 * - A `shader` blend (today: `xor` alone) costs an extra pass and the scratch
 *   target, because a WebGPU render pass may not sample the attachment it
 *   writes. A `feedback` layer with a shader blend costs no scratch — its own
 *   output target already is one.
 *
 * One scratch target suffices for the whole stack: it is written by a pass and
 * consumed by the immediately following composite, so no two shader-blend
 * layers ever need it at the same time.
 */
export function planStack(resolved: readonly ResolvedLayer[]): StackPlan {
  const passes: PassPlan[] = [];
  const feedbackSlots: string[] = [];
  let scratch = 0;

  // The run currently open for merging, if any. `null` between runs.
  let run: { kind: 'draw' | 'transform'; ids: string[]; scale: number } | null = null;

  const flush = (): void => {
    if (!run) return;
    passes.push({
      label: `${run.kind}:${run.ids.join('+')}`,
      kind: run.kind,
      layerIds: run.ids.slice(),
      swapsAccumulator: run.kind === 'transform',
      usesScratch: false,
      resolutionScale: run.scale,
    });
    run = null;
  };

  const append = (kind: 'draw' | 'transform', id: string, scale: number): void => {
    // Merging across a resolution change is not possible; a pass has one size.
    if (run && (run.kind !== kind || run.scale !== scale)) flush();
    if (!run) run = { kind, ids: [], scale };
    run.ids.push(id);
  };

  for (const r of resolved) {
    const { spec } = r.layer;
    const blend = BLEND_PLANS[spec.blend];
    const scale = spec.resolutionScale;

    if (spec.family === 'feedback') {
      flush();
      feedbackSlots.push(spec.id);
      passes.push({
        label: `feedback:${spec.id}`,
        kind: 'feedback',
        layerIds: [spec.id],
        swapsAccumulator: false,
        usesScratch: false,
        feedbackSlot: spec.id,
        resolutionScale: scale,
      });
      if (blend.readsDestination) {
        // Its own pair holds the source, so this costs a pass but no scratch.
        passes.push({
          label: `composite:${spec.id}`,
          kind: 'composite',
          layerIds: [spec.id],
          swapsAccumulator: true,
          usesScratch: false,
          feedbackSlot: spec.id,
          resolutionScale: scale,
        });
      } else {
        // A fixed-function composite of a finished texture is exactly a source
        // draw, so it can join a draw run.
        append('draw', spec.id, scale);
      }
      continue;
    }

    if (blend.readsDestination) {
      flush();
      scratch = 1;
      // A source produces its scratch contents out of nothing; a warp, colour op
      // or operator must still SAMPLE the accumulator to produce them. That is
      // exactly what `kind` encodes, so it cannot be hard-coded to 'draw' here —
      // a renderer switching on it would bind no input texture and the layer
      // would end up warping an empty frame, which reads as "the xor blend is
      // broken" rather than "the pass was mislabelled". Neither variant swaps:
      // both write scratch, and the accumulator is untouched until the composite.
      const kind: PassKind = spec.family === 'source' ? 'draw' : 'transform';
      passes.push({
        label: `${kind}:${spec.id}->scratch`,
        kind,
        layerIds: [spec.id],
        swapsAccumulator: false,
        usesScratch: true,
        resolutionScale: scale,
      });
      passes.push({
        label: `composite:${spec.id}`,
        kind: 'composite',
        layerIds: [spec.id],
        swapsAccumulator: true,
        usesScratch: true,
        resolutionScale: scale,
      });
      continue;
    }

    switch (spec.family) {
      case 'source':
        append('draw', spec.id, scale);
        break;
      case 'color':
        // The merged case. A colour run reads the accumulator once and writes
        // once regardless of how many layers are in it.
        append('transform', spec.id, scale);
        break;
      case 'warp':
      case 'operator':
        flush();
        passes.push({
          label: `${spec.family}:${spec.id}`,
          kind: 'transform',
          layerIds: [spec.id],
          swapsAccumulator: true,
          usesScratch: false,
          resolutionScale: scale,
        });
        break;
    }
  }
  flush();

  return {
    passes,
    feedbackSlots,
    scratchTargets: scratch,
    passCount: passes.length,
    targetCount: 2 + feedbackSlots.length * 2 + scratch,
  };
}

// ---------------------------------------------------------------------------
// LayerStack
// ---------------------------------------------------------------------------

/** Mute/solo by layer id. See `LayerStack.mixerSnapshot`. */
export interface LayerMixerSnapshot {
  readonly muted: readonly string[];
  readonly soloed: readonly string[];
}

/**
 * The ordered stack. Index is z-order: later layers composite over earlier ones.
 *
 * Mutation is by ID, never by index. Reorder-by-drag (Phase 3) means indices
 * move under the caller's feet between the moment it decides to mute something
 * and the moment it says so, and an index-addressed API turns that race into
 * "the wrong layer went quiet", which is maddening to reproduce.
 */
export class LayerStack {
  private layers: Layer[] = [];
  private solo = new Set<string>();
  private seed = 0;

  /** Rebuild from a preset. Existing runtime state (triggers, solo, mute) is discarded on purpose — see `Layer`. */
  load(preset: Preset): void {
    this.seed = preset.seed;
    this.layers = preset.layers.map((spec) => new Layer(spec, preset.seed));
    this.solo.clear();
  }

  get all(): readonly Layer[] { return this.layers; }
  get length(): number { return this.layers.length; }

  find(id: string): Layer | undefined {
    return this.layers.find((l) => l.id === id);
  }

  /** Append, or insert at `index`. */
  add(spec: LayerSpec, index?: number): Layer {
    if (this.find(spec.id)) {
      throw new Error(`Layer id '${spec.id}' is already in the stack. IDs seed per-layer variation and must be unique.`);
    }
    const layer = new Layer(spec, this.seed);
    if (index === undefined || index >= this.layers.length) this.layers.push(layer);
    else this.layers.splice(Math.max(0, index), 0, layer);
    return layer;
  }

  remove(id: string): boolean {
    const i = this.layers.findIndex((l) => l.id === id);
    if (i < 0) return false;
    this.layers.splice(i, 1);
    this.solo.delete(id);
    return true;
  }

  /** Move `id` to `toIndex` in the stack. Clamped rather than throwing; a drag past the end is a normal gesture. */
  reorder(id: string, toIndex: number): boolean {
    const from = this.layers.findIndex((l) => l.id === id);
    if (from < 0) return false;
    const [layer] = this.layers.splice(from, 1);
    if (!layer) return false;
    const to = Math.max(0, Math.min(this.layers.length, Math.trunc(toIndex)));
    this.layers.splice(to, 0, layer);
    return true;
  }

  setMuted(id: string, muted: boolean): void {
    const layer = this.find(id);
    if (layer) layer.muted = muted;
  }

  /**
   * Solo is a filter, not a mute of everything else.
   *
   * Implementing solo by muting the others destroys the user's own mute states,
   * and un-soloing then has to guess which of them to restore. Keeping the solo
   * set separate means solo and mute compose: a soloed layer that is also muted
   * stays silent, which is what every mixing desk does.
   */
  setSolo(id: string, soloed: boolean): void {
    if (soloed) this.solo.add(id); else this.solo.delete(id);
  }

  clearSolo(): void { this.solo.clear(); }
  isSoloed(id: string): boolean { return this.solo.has(id); }
  get soloActive(): boolean { return this.solo.size > 0; }

  /**
   * The mixing-desk state, as plain ids, in stack order.
   *
   * Mute and solo are deliberately not in the spec (see `Layer.muted`), so a
   * second window that rebuilds this stack from a preset has no other way to
   * learn them. Plain arrays so the snapshot is structured-cloneable.
   */
  mixerSnapshot(): LayerMixerSnapshot {
    return {
      muted: this.layers.filter((l) => l.muted).map((l) => l.id),
      soloed: this.layers.filter((l) => this.solo.has(l.id)).map((l) => l.id),
    };
  }

  /**
   * Adopt a snapshot wholesale: every layer not listed is unmuted and unsoloed.
   * Ids this stack does not hold are ignored, which is what a snapshot racing a
   * structural change should do. Render semantics are the setters' own.
   */
  applyMixerSnapshot(snapshot: LayerMixerSnapshot): void {
    const muted = new Set(snapshot.muted);
    for (const layer of this.layers) layer.muted = muted.has(layer.id);
    this.solo.clear();
    for (const id of snapshot.soloed) if (this.find(id)) this.solo.add(id);
  }

  /** §4.10. Seek, pause-to-a-new-position and track change all land here. */
  reset(): void {
    for (const layer of this.layers) layer.reset();
  }

  /** Advance every layer's trigger state to `nowBeats`. Call once per frame, before `resolve`. */
  update(nowBeats: number): void {
    for (const layer of this.layers) layer.update(nowBeats);
  }

  /**
   * The ordered list of layers that will actually render this frame, with their
   * envelope values.
   *
   * Filtering happens HERE and not in the renderer, because "a layer at 0 is a
   * true no-op" (Phase 5 DoD) is only true if a spent layer never reaches the
   * pass planner — an invisible layer that still owns a pass has cost the entire
   * pass budget for that pass and produced nothing.
   */
  resolve(nowBeats: number): ResolvedLayer[] {
    const out: ResolvedLayer[] = [];
    for (const layer of this.layers) {
      if (this.solo.size > 0 && !this.solo.has(layer.id)) continue;
      if (!layer.gateOpen) continue;
      const progress = layer.progress(nowBeats);
      if (progress <= 0) continue;
      out.push({
        layer,
        progress,
        opacity: clamp01(layer.spec.opacity * progress),
        blendConstant: blendConstantFor(layer.spec),
      });
    }
    return out;
  }

  /** Convenience: resolve and plan in one call, which is what a frame actually wants. */
  frame(nowBeats: number): { resolved: ResolvedLayer[]; plan: StackPlan } {
    const resolved = this.resolve(nowBeats);
    return { resolved, plan: planStack(resolved) };
  }
}

// ---------------------------------------------------------------------------

function clamp01(v: number): number {
  return v < 0 ? 0 : v > 1 ? 1 : v;
}
