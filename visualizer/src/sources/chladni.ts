// The Chladni source's registration (plan §8.6). Look: LAB.
//
// Describes the pass and packs its params; the drawing argument is in
// `src-chladni.wgsl`. No device, no buffer, no pipeline — see `scope.ts` for the
// full statement of why that matters.
//
// The one job this file has that the other two sources do not is CHOOSING THE
// MODE NUMBERS, and getting that right is most of what makes the layer work.
//
// n and m must be integers: the modes of a plate are discrete, so a fractional
// mode number is not a quieter figure, it is a figure that does not exist. And
// they must be HELD between musical boundaries. Recomputing them per frame from
// the live spectrum sounds like the responsive thing to do and is the failure —
// the dominant band changes several times a second on any real mix, so the
// figure would spend its whole life crossfading between two patterns, which
// reads as a wash of noise rather than as a shape changing. Quantising the
// *value* without quantising the *time* fixes nothing; both have to snap.
//
// So the mode pair is latched once per clock division and held. The consequence
// is that this module carries state, which every other pass module deliberately
// does not — see `latch` below for what that costs and why the alternatives are
// worse.

import { AUDIO_WGSL } from '../audiogpu.ts';
import type { BandName, ParamValue, PassContext, PassDescriptor } from '../contracts.ts';
import { PASS_BINDING, PASS_COMMON_WGSL, PASS_GROUP } from '../renderer.ts';
import { hash2 } from '../rng.ts';
import body from '../shaders/src-chladni.wgsl';

/** See the identical note in `scope.ts` — the binding number is generated, never typed. */
const PARAMS_WGSL = `@group(${PASS_GROUP}) @binding(${PASS_BINDING.params}) var<uniform> P : Params;`;

/** Field order. Must match `struct Params` in `src-chladni.wgsl` float for float. */
const F_N = 0;
const F_M = 1;
const F_HALF_PX = 2;
const F_SIZE = 3;
const F_CENTRE_X = 4;
const F_CENTRE_Y = 5;
const F_EXCITE = 6;
const F_WEIGHT_VAR = 7;
const F_SPIN = 8;
// 9..11 are the struct's tail pad. Never written, never read.
const PARAM_FLOATS = 12;

/** Band order, low to high. The index IS the pitch axis the mode number rides. */
const BAND_ORDER: readonly BandName[] = ['sub', 'low', 'mid', 'high', 'air'];

/**
 * Default mode range. Below ~3 the figure is a cross and reads as a graphic
 * rather than as a plate; above ~13 the nodal lines are closer together than the
 * stroke is wide at 1080p and the whole thing greys out. The range is a preset
 * parameter because that ceiling moves with resolution.
 */
const DEFAULT_N_MIN = 3;
const DEFAULT_N_MAX = 11;

/** A held mode pair. One per layer id. */
interface Held {
  /** `floor(beats / div)` at the moment of the latch. */
  step: number;
  /**
   * The division the step was counted in.
   *
   * Held as well as `step` because `step` alone does NOT identify a boundary: at
   * `beats = 12`, a division of 4 and a division of 3.5 both give step 3, so a
   * preset edit between those two would keep the stale figure until the next
   * boundary instead of re-striking the plate — which is the one thing the user
   * just asked for by moving the control.
   */
  div: number;
  n: number;
  m: number;
}

/**
 * The latch, keyed by layer id.
 *
 * Per layer, not per type: two `chladni` layers in one stack are two plates and
 * must be free to sit on different figures, exactly as two `lorenz` layers are
 * two attractors (see `StorageSpec`).
 *
 * What this costs, stated plainly rather than buried: the pair is sampled from
 * the audio on whichever frame first observes the new division, so the figure
 * depends on the frame CADENCE and not only on (preset, audio, t). Under the
 * golden harness's fixed timestep that cadence is deterministic and the layer
 * reproduces; under a variable-rate live session two runs over the same track can
 * latch a different frame's spectrum and pick a different figure. Both
 * alternatives are worse. Deriving n and m per frame smears (see the header).
 * Sampling the spectrogram at the boundary's own age would be stateless, but the
 * ring advances one row per RENDERED frame rather than per unit of time
 * (`audio.ts`), so "the row at the boundary" is not a musical quantity either —
 * it would trade a visible artefact for an invisible one.
 *
 * If §4.7 ever needs this to be exact, the fix is for the audio engine to expose
 * a time-indexed history, not for this module to guess harder.
 *
 * Two failure modes were removed rather than merely documented, because both
 * were latch bugs rather than the underlying sampling one:
 *
 *   - A held pair now expires when the DIVISION changes, not only when the step
 *     number does (see `Held.div`).
 *   - Overflow evicts the OLDEST entry rather than clearing the map. A clear
 *     re-latches every live layer at once, on whichever frame happened to be the
 *     256th distinct id — so a plate that was nowhere near a boundary visibly
 *     jumps to a new figure, and it does so on a frame number that depends on
 *     the editing history rather than on the music.
 *
 * One residual case is left, deliberately, because closing it needs a caller
 * this module does not have: the map outlives a preset reload, so a second run
 * in the same process that reuses a layer id AND lands on the same step number
 * inherits the first run's pair. Every rewind past a boundary re-latches (the
 * step comparison is equality, not monotonicity), so this only bites a run that
 * both starts and ends inside step 0 of the same division.
 */
const latch = new Map<string, Held>();

/** Latch ceiling. A long editing session churns layer ids; nothing here prunes. */
const LATCH_LIMIT = 256;

export const chladniPass: PassDescriptor = {
  type: 'chladni',
  family: 'source',
  // A source draws INTO the accumulator, so it cannot sample it. Explicit
  // because the default is easy to assume the other way round.
  input: 'none',
  usesAudio: true,
  code: [PASS_COMMON_WGSL, AUDIO_WGSL, PARAMS_WGSL, body].join('\n'),

  // Fullscreen geometry, issued as a vertex count so that progress 0 draws
  // literally nothing (Phase 5 DoD). The vertex shader is still
  // `fullscreenTriangle`; only the count is conditional.
  draw: {
    kind: 'vertices',
    vertexCount: (ctx) => (ctx.progress > 0 ? 3 : 0),
  },

  /**
   * The stroke is specified in FRAGMENTS of the attachment, so at half res it is
   * a half-res hairline smeared back up — and a Chladni figure is nothing but
   * hairlines. Advisory only; §4.11 says the scale is a budget decision and the
   * budget belongs to the show.
   */
  defaultResolutionScale: 1,

  uniformFloats: PARAM_FLOATS,
  writeUniforms(out: Float32Array, ctx: PassContext): void {
    const p = ctx.params;

    // The division, in beats. A bar by default: the figure changing once per bar
    // is legible as a change, and Lab's motion vocabulary is `/4` and `/8`
    // (art-direction §1.1) — a plate that re-settles every sixteenth is a strobe.
    const divBeats = Math.max(num(p, 'divisionBeats', 4), 1e-3);
    const step = Math.floor(ctx.beats / divBeats);
    const [n, m] = modesFor(ctx, step, divBeats, p);
    out[F_N] = n;
    out[F_M] = m;

    out[F_HALF_PX] = Math.max(num(p, 'thicknessPx', 1.6), 0.05) * 0.5;
    out[F_SIZE] = Math.max(num(p, 'size', 0.62), 1e-3);
    // Off-centre by default. Art-direction §4.1: the plate is a square object and
    // pinning it dead centre in a 16:9 frame is the composition the document
    // rejects. The figure's own symmetry still has a centre — that is the
    // mechanism — it just does not have to be the frame's.
    out[F_CENTRE_X] = num(p, 'centreX', -0.10);
    out[F_CENTRE_Y] = num(p, 'centreY', 0.04);

    // The strike, decaying in BEATS from the boundary. A plate that snaps to a
    // new figure with no re-excitation reads as a cut; one that brightens and
    // settles reads as having been struck, which is the thing being depicted.
    // Exponential and asymmetric, per art-direction §3.2.
    const settleBeats = Math.max(num(p, 'settleBeats', 0.75), 1e-3);
    const intoStep = ctx.beats - step * divBeats;
    out[F_EXCITE] = clamp01(num(p, 'excite', 0.6)) * Math.exp(-intoStep / settleBeats);

    out[F_WEIGHT_VAR] = clamp01(num(p, 'weightVar', 0.7));

    // Rotation on a clock division, never on wall-clock seconds (§3.1). The
    // fractional part is taken before scaling so the angle never grows large
    // enough for f32 to lose the low bits of a slow spin. 0 disables it, which is
    // the honest default for a plate — Lab motion is slow and continuous, and a
    // figure that is already changing every bar does not also need to turn.
    const spinBeats = num(p, 'spinBeats', 0);
    out[F_SPIN] = spinBeats > 1e-3 ? fract(ctx.beats / spinBeats) * Math.PI * 2 : 0;
  },
};

/**
 * The held mode pair for this layer at this division step.
 *
 * n comes from the DOMINANT band and m from the runner-up, both scaled by the
 * band's own energy, so a bass-led bar draws a low-order figure and a bar that
 * opens up on top draws a dense one. The mapping is deliberately coarse — five
 * bands over ~9 mode numbers — because the point is that the figure is legibly
 * different, not that it encodes the spectrum precisely.
 */
function modesFor(
  ctx: PassContext,
  step: number,
  divBeats: number,
  p: Readonly<Record<string, ParamValue>>,
): [number, number] {
  // A preset may pin either mode. Pinning both is a static figure and is a
  // legitimate thing to want — Lab's discipline is one line drawn well, and a
  // still plate under a moving light is a whole look.
  const nMin = Math.max(1, Math.round(num(p, 'nMin', DEFAULT_N_MIN)));
  // At least nMin + 1: n == m makes the field identically zero, which is not a
  // degenerate figure but a white frame. The shader trusts this and does not
  // re-check it.
  const nMax = Math.max(nMin + 1, Math.round(num(p, 'nMax', DEFAULT_N_MAX)));
  const pinnedN = intOrNull(p, 'n');
  const pinnedM = intOrNull(p, 'm');
  if (pinnedN !== null && pinnedM !== null) {
    return separate(clampInt(pinnedN, nMin, nMax), clampInt(pinnedM, nMin, nMax), nMin, nMax);
  }

  const id = ctx.spec.id;
  const held = latch.get(id);
  if (held && held.step === step && held.div === divBeats) {
    // Re-pinned and re-clamped on the way OUT, not only on the way in. `n`, `m`,
    // `nMin` and `nMax` are all live preset params, and a control moved mid-hold
    // has to take effect now rather than at the next boundary — that is the one
    // thing the user just asked for by moving it. Reading the pins only on the
    // latch frame would leave a plate whose mode number the preset just fixed
    // sitting on the audio-derived one for up to a bar.
    //
    // The clamp matters for a second reason: narrowing the range mid-hold can
    // collapse n and m onto the same number, and n == m makes the field
    // identically zero and the frame WHITE. `separate` is what the shader trusts
    // and does not re-check, so it runs on this path too.
    return separate(
      clampInt(pinnedN ?? held.n, nMin, nMax),
      clampInt(pinnedM ?? held.m, nMin, nMax),
      nMin,
      nMax,
    );
  }

  const bands = ctx.audio.bands;
  let i0 = 0;
  let i1 = 1;
  let v0 = -1;
  let v1 = -1;
  for (let i = 0; i < BAND_ORDER.length; i++) {
    const name = BAND_ORDER[i];
    const v = name === undefined ? 0 : bands[name];
    if (v > v0) { i1 = i0; v1 = v0; i0 = i; v0 = v; }
    else if (v > v1) { i1 = i; v1 = v; }
  }

  const span = nMax - nMin;
  // (band index + that band's energy) / 5 puts the dominant band's octave in the
  // integer part and lets its level slide the figure within that octave's share
  // of the range.
  let n = nMin + Math.round(clamp01((i0 + clamp01(v0)) / BAND_ORDER.length) * span);
  let m = nMin + Math.round(clamp01((i1 + clamp01(v1)) / BAND_ORDER.length) * span);

  // Seeded variation, so two chladni layers over the same audio are two plates
  // rather than one drawn twice. `hash2`, never `Math.random` (§4.7).
  m += Math.floor(hash2(ctx.seed, step) * 3) - 1;
  const pair = separate(
    pinnedN !== null ? clampInt(pinnedN, nMin, nMax) : n,
    pinnedM !== null ? clampInt(pinnedM, nMin, nMax) : clampInt(m, nMin, nMax),
    nMin,
    nMax,
  );
  n = pair[0];
  m = pair[1];

  // Evict the single oldest entry rather than clearing. See the note on `latch`.
  if (latch.size >= LATCH_LIMIT && !latch.has(id)) {
    const oldest = latch.keys().next();
    if (!oldest.done) latch.delete(oldest.value);
  }
  latch.set(id, { step, div: divBeats, n, m });
  return [n, m];
}

/** Force n != m without leaving [nMin, nMax]. See `modesFor` on why this matters. */
function separate(n: number, m: number, nMin: number, nMax: number): [number, number] {
  if (m !== n) return [n, m];
  if (n + 1 <= nMax) return [n, n + 1];
  return [n, n - 1 >= nMin ? n - 1 : nMax];
}

function clampInt(v: number, lo: number, hi: number): number {
  const r = Math.round(v);
  return r < lo ? lo : r > hi ? hi : r;
}

function intOrNull(p: Readonly<Record<string, ParamValue>>, key: string): number | null {
  const v = p[key];
  return typeof v === 'number' && Number.isFinite(v) ? v : null;
}

function num(p: Readonly<Record<string, ParamValue>>, key: string, fallback: number): number {
  const v = p[key];
  return typeof v === 'number' && Number.isFinite(v) ? v : fallback;
}

function clamp01(v: number): number {
  return v < 0 ? 0 : v > 1 ? 1 : v;
}

/** Positive fractional part. `%` keeps the sign of the dividend and beats can be negative on a pre-roll. */
function fract(v: number): number {
  return v - Math.floor(v);
}
