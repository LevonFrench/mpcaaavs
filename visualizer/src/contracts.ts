// The shared type contract. Every module compiles against this one; this one
// compiles against nothing.
//
// Its job is to be the single place where two modules agree on a shape, so that
// the audio engine, the scheduler, the layer graph, the preset loader and the
// debug overlay can be written in parallel without any of them importing each
// other. That constraint is deliberate and load-bearing: the moment this file
// imports a sibling it stops being a contract and becomes a dependency, and the
// import graph acquires a cycle that only shows up as a confusing runtime
// `undefined` after bundling.
//
// So: types, plus a handful of pure arithmetic helpers with no state. What it
// deliberately does NOT contain — any class, any device or context handle, any
// I/O, any WebGPU object, any default preset data. Defaults belong to the module
// that owns the behaviour; a contract that carries data grows opinions.

// ---------------------------------------------------------------------------
// Clock grid
// ---------------------------------------------------------------------------

/**
 * Plan §3.1. 240 = LCM(16, 12, 5), so 64ths, triplets, sextuplets, dotted
 * values AND quintuplets all land on integer slots. `clock.ts` declares the
 * same two constants and is the authority at runtime; these exist so a module
 * can talk about slots without pulling the tempo tracker in with them. If one
 * ever changes, both change — they are not independently tunable.
 */
export const SLOTS_PER_BEAT = 240;
/** Four beats. 4/4 is assumed throughout v1; odd metres are not in scope. */
export const SLOTS_PER_BAR = SLOTS_PER_BEAT * 4;

/**
 * Named clock divisions, mirroring `DIVISIONS` in `clock.ts`. Duplicated as a
 * union rather than imported because `TriggerSpec` needs the *names* and
 * nothing here needs the strides. The two lists must stay identical; TypeScript
 * will not check that for us, so adding a division means editing both.
 */
export type DivisionName =
  | '1/64' | '1/32' | '1/16' | '1/8'
  | 'beat' | 'half' | 'bar' | '2bar' | '4bar'
  | '1/8T' | '1/16T'
  | '1/4quint'
  | '1/8dot';

// ---------------------------------------------------------------------------
// Timeline (plan §4.2)
// ---------------------------------------------------------------------------

/**
 * What kind of musical thing happened. Kept as a flat union rather than a class
 * hierarchy because the scheduler switches on it and nothing subclasses.
 *
 * `beat`/`downbeat`/`bar`/`division` are grid-locked and always schedulable.
 * `onset` is content-dependent — Tier A knows them ahead, Tier B does not.
 * `section`/`build`/`drop`/`breakdown` are structural, and in Tier B they are
 * predictions that may simply be wrong (§4.3).
 */
export type TimelineEventKind =
  | 'beat' | 'downbeat' | 'bar' | 'division'
  | 'onset'
  | 'section' | 'build' | 'drop' | 'breakdown';

/**
 * A musical event at a known audio-clock time.
 *
 * `time` is when the event LANDS, never when to fire it. The lead — anchor
 * offset plus output latency plus the user's audio offset — belongs to the
 * scheduler (§4.6), and baking it in here would make the same event mean
 * different things to two consumers.
 */
export interface TimelineEvent {
  /** Audio-clock seconds. `audioContext.currentTime` base, always (§4.6). */
  readonly time: number;
  /** Position on the 240-per-beat grid. Fractional for swung events. */
  readonly slot: number;
  readonly kind: TimelineEventKind;
  /** 0..1, for kinds that have a magnitude. Absent means "no opinion". */
  readonly strength?: number;
  /** Only meaningful when `kind === 'onset'`. Routes kick/hat to different layers. */
  readonly onsetClass?: OnsetClass;
  /** -1..1 stereo position at the event, for placing an effect at its screen-x. */
  readonly pan?: number;
  /** 0..1. Structural events carry their own confidence; §12 says never a boolean. */
  readonly confidence?: number;
}

/**
 * The one interface the scheduler sees (plan §4.2).
 *
 * Why this exists at all: there are two audio tiers with almost nothing in
 * common. Tier A decodes and analyses a whole file offline — it knows every
 * beat, section and onset before a sample is played. Tier B watches a live
 * input and guesses two bars ahead at best. The temptation is to write the
 * scheduler against Tier A and bolt Tier B on later, and the result of that is
 * always two engines that drift apart and have to be fixed twice.
 *
 * Forcing both behind one interface makes divergence impossible by
 * construction rather than by discipline, and it makes the Tier B → Tier A
 * upgrade (§5.3 — start playing immediately, swap when pre-analysis lands) a
 * pointer assignment instead of a rewrite. The scheduler must never be able to
 * tell which tier it holds; if it ever needs to, that is what `confidence` is
 * for, and the answer is a crossfade, not a branch.
 */
export interface Timeline {
  /** Tempo in effect at `atSec`. Not a constant — tracks change tempo (§4.10). */
  bpm(atSec: number): number;
  /**
   * Continuous grid position, 240 slots per beat, fractional.
   * Monotonic non-decreasing in `atSec` for the lifetime of one timeline: a
   * slot counter that can run backwards kills the grid silently, which is
   * exactly the bug Pulse's tempo tracker had (§3.2).
   */
  slotAt(atSec: number): number;
  /** Events with `a <= time < b`. Half-open, so a rolling window cannot double-fire. */
  eventsBetween(a: number, b: number): TimelineEvent[];
  /** How far past "now" `eventsBetween` is meaningful. Whole track for Tier A, ~2 bars for Tier B. */
  readonly horizonSec: number;
  /** 0..1. Crossfade scheduled against reactive by this, never switch on it (§4.3). */
  readonly confidence: number;
}

// ---------------------------------------------------------------------------
// Audio (mirrors src/audio.ts)
// ---------------------------------------------------------------------------

/** The five bands of §3.1. Three was not enough — the bottom two octaves need separating. */
export type BandName = 'sub' | 'low' | 'mid' | 'high' | 'air';

/** How an onset was classified (§6). Two extra numbers buy a lot of expressiveness. */
export type OnsetClass = 'kick' | 'snare' | 'hat' | 'tonal';

export interface Onset {
  /** Audio-clock seconds. */
  readonly time: number;
  /** 0..1, relative to the adaptive threshold that fired it. */
  readonly strength: number;
  readonly klass: OnsetClass;
  /** Broadband pan at trigger, -1..1. */
  readonly pan: number;
}

/**
 * Everything the renderer and the debug overlay are allowed to know about the
 * audio for one frame.
 *
 * Read ONCE per frame and passed down, rather than each layer reaching into the
 * audio engine when it happens to run. Two reasons, both of which have bitten
 * this kind of code before: layers that sample at different points in the frame
 * disagree about "now" and drift visibly apart, and per-layer reads make the
 * frame non-reproducible, which breaks the golden-image harness (§4.7).
 *
 * The typed arrays are LIVE REFERENCES into the engine's buffers, not copies —
 * copying ~8 KB per frame at 120 fps is real budget (§4.11). They are therefore
 * only valid for the frame in which the snapshot was taken. Never retain one
 * across frames; if you need history, that is what `spectrogram` is.
 * Lengths are owned by `audio.ts` (`WAVE_N`, `SPEC_N`, `SPECTROGRAM_ROWS`).
 */
export interface AudioSnapshot {
  /** Audio-clock seconds since playback began. The only clock (§4.6). */
  readonly time: number;
  /** Broadband RMS, 0..1. Do NOT drive every layer from this — §3.3 of the art direction. */
  readonly level: number;
  /** Onset envelope, 0..1, decaying. Reactive; grid-locked work uses `Timeline`. */
  readonly beat: number;
  readonly bands: Readonly<Record<BandName, number>>;
  /** Broadband pan, -1..1. */
  readonly pan: number;
  /** ‖S‖/(‖M‖+‖S‖). Spikes when wide material enters; feeds the tension score. */
  readonly width: number;
  /** peak/rms. Low means compressed, and a build compresses. */
  readonly crest: number;
  /** Spectral centroid, normalised 0..1. */
  readonly centroid: number;
  /** Wiener entropy — tonal (0) to noisy (1). */
  readonly flatness: number;
  /** Low-to-high perceptual-band energy envelopes. Currently 12 stable slots. */
  readonly perceptualBands: Float32Array;
  /** Perceptual-band adaptively whitened positive novelty envelopes. */
  readonly perceptualFlux: Float32Array;

  /** Interleaved L,R time domain: `[l0, r0, l1, r1, ...]`. Lissajous needs both. */
  readonly waveform: Float32Array;
  /** Interleaved L,R magnitudes 0..1, resampled by RMS energy. */
  readonly spectrum: Float32Array;
  /** Per-BIN pan, -1..1. This is what places an effect at the screen-x of its frequency. */
  readonly bandPan: Float32Array;
  /** Ring buffer, `SPEC_N * SPECTROGRAM_ROWS`, row-major. */
  readonly spectrogram: Float32Array;
  /** Row index the ring will write NEXT — subtract to unwrap into time order. */
  readonly spectrogramRow: number;
  /** Peak-hold per bin, with fall. */
  readonly peaks: Float32Array;
}

// ---------------------------------------------------------------------------
// Layer graph (plan §4.1)
// ---------------------------------------------------------------------------

/**
 * What a layer reads and writes. This is not cosmetic taxonomy — it decides
 * pass scheduling. Consecutive `color` layers have no spatial dependency and
 * compile into a single pass, and pass count is the frame budget (§4.11).
 */
export type LayerFamily = 'source' | 'warp' | 'color' | 'feedback' | 'operator';

/** The ten blend modes of §4.1. All on RGBA16F, so `add` genuinely accumulates rather than clipping. */
export type BlendMode =
  | 'replace' | 'add' | 'max' | 'min' | '50/50'
  | 'subtract' | 'multiply' | 'xor' | 'adjustable' | 'alpha';

/**
 * Which part of the effect the musical event is meant to land on (§4.3).
 *
 * `t − attack` is only correct when the effect's PEAK is the payload. For a
 * glitch cut or a strobe the payload is the onset itself, and compensating it
 * makes the cut happen early. Getting this wrong is the difference between "on
 * the beat" and "nearly on the beat", and it is not tunable after the fact.
 */
export type Anchor = 'start' | 'peak' | 'end';

/**
 * Envelope times in BEATS, never seconds.
 *
 * At 174 BPM a 200 ms release is most of a beat; at 90 BPM it is a third of
 * one. The same preset therefore reads as a different effect on a different
 * track, and every parameter has to be re-tuned per tempo — which is precisely
 * the failure that makes a visualiser look like it is playing *near* the music
 * rather than *with* it (art direction §3.1). Expressed in beats, a preset
 * transposes to any tempo unchanged, and a tempo change mid-track needs no
 * recalculation at all (§4.10).
 *
 * Shape, not just duration: attack fast, release 4–16× slower, both
 * exponential. Linear and symmetric envelopes are why a lot of audio-reactive
 * work feels like a bouncing progress bar (art direction §3.2).
 */
export interface Envelope {
  /** Beats to rise 0→1. Often a fraction of one. */
  readonly attackBeats: number;
  /** Beats held at 1 before release begins. May be 0. */
  readonly holdBeats: number;
  /** Beats to fall 1→0. Should be several times `attackBeats`. */
  readonly releaseBeats: number;
}

/**
 * When a layer fires. Divisions, Euclidean patterns and probability compose:
 * the division supplies the pulse, `E(k,n)` thins it into a rhythm, and
 * `probability` thins that. An empty pattern (k = 0) is a valid pattern —
 * silence has to be expressible or the show never rests (art direction §3.5).
 */
export interface TriggerSpec {
  /** The underlying pulse. */
  readonly division: DivisionName;
  /** Euclidean onsets. `E(k, n)` via Bjorklund; `k = 0` fires nothing, `k = n` fires every pulse. */
  readonly euclidK: number;
  /** Euclidean steps. `n = 1` with `k = 1` is a plain division. */
  readonly euclidN: number;
  /** 0..1, evaluated against a seeded hash of (preset seed, layer id, slot) — never `Math.random()` (§4.7). */
  readonly probability: number;
  /** Pattern rotation in steps. Lets two layers share a rhythm out of phase. */
  readonly offsetSteps: number;
}

/** Palette role a layer draws with, rather than a hardcoded colour (§4.8). */
export type PaletteSlot = 'bg' | 'primary' | 'secondary' | 'accent';

/** Layer parameters are flat and JSON-round-trippable, because presets are JSON. */
export type ParamValue = number | boolean | string;

/**
 * One entry in the ordered stack. Everything a layer needs to be scheduled,
 * composited and serialised — and nothing about how it draws, which belongs to
 * the layer implementation keyed by `type`.
 */
export interface LayerSpec {
  /** Stable across reorder and reload. Seeds per-layer hashed variation, so it must not be the array index. */
  readonly id: string;
  /** Implementation key, e.g. `'lorenz'`, `'kaleidoscope'`, `'gray-scott'`. */
  readonly type: string;
  readonly family: LayerFamily;
  readonly params: Readonly<Record<string, ParamValue>>;
  readonly blend: BlendMode;
  /** 0..1. A layer at 0 must be a true no-op, not a cheap one — it is a Phase 5 DoD. */
  readonly opacity: number;
  readonly envelope: Envelope;
  /**
   * Plan §4.1 lists `clock` and `trigger` as two fields. They are one here,
   * because the "clock" a layer subscribes to (§4.1's phrasing: layers subscribe
   * to a clock, not "the beat") is exactly `TriggerSpec.division`. Two fields
   * would be two sources of truth for one number, and the first preset where
   * they disagree is undebuggable — the layer fires on one grid and its
   * Euclidean pattern is rotated against another.
   */
  readonly trigger: TriggerSpec;
  readonly anchor: Anchor;
  readonly palette: PaletteSlot;
  readonly enabled: boolean;
  /**
   * Fraction of full resolution this layer renders at. A quarter-res pass is
   * 1/16 the bandwidth, and at 2K120 compositing traffic alone is 15–20% of the
   * budget (§4.11). New layers default to 0.5 and get promoted deliberately.
   */
  readonly resolutionScale: number;
}

// ---------------------------------------------------------------------------
// Palette (plan §4.8, art direction §2)
// ---------------------------------------------------------------------------

/**
 * A colour in OKLCH, not sRGB. Mixing two hues in sRGB passes through a
 * desaturated grey dead-zone, which is the single most common reason a gradient
 * looks cheap (art direction §2.1).
 */
export interface PaletteColor {
  /** Lightness, 0..1. */
  readonly l: number;
  /** Chroma, roughly 0..0.4. */
  readonly c: number;
  /** Hue in degrees, 0..360. */
  readonly h: number;
  /**
   * Multiplier applied after conversion to linear RGB. Above 1.0 is HDR
   * headroom and is what bloom looks for — so only the focal element gets it.
   * Three layers above 1.0 means the frame has no focal point (art direction §2.4).
   */
  readonly intensity: number;
}

export interface PaletteStop {
  /** Position along the ramp, 0..1. */
  readonly at: number;
  readonly color: PaletteColor;
}

/**
 * Four named slots plus a ramp. Layers reference the slots by role, which is
 * what lets a whole show re-grade from one control and lets layers agree with
 * each other instead of each picking its own colours.
 */
export interface Palette {
  readonly name: string;
  /** The floor. Near-black, and most of the frame. */
  readonly bg: PaletteColor;
  /** The subject. */
  readonly primary: PaletteColor;
  /** The counterpoint — used less than primary, always. */
  readonly secondary: PaletteColor;
  /** Peaks and transients. On screen under ~10% of the time or it is not an accent. */
  readonly accent: PaletteColor;
  /** Ordered stops for continuous mapping (spectrum colouring, heat ramps). Interpolated in OKLCH. */
  readonly ramp: readonly PaletteStop[];
}

// ---------------------------------------------------------------------------
// Presets
// ---------------------------------------------------------------------------

/**
 * Bump when a change to `Preset` cannot be read by the previous loader, and add
 * a case to `migrate`. Presets are shared by URL hash, so an old one outliving
 * its schema is the normal case, not the exception.
 */
export const PRESET_VERSION = 1;

export interface Preset {
  readonly version: typeof PRESET_VERSION;
  readonly name: string;
  /**
   * Every hashed decision in the show derives from this. Two runs of the same
   * preset over the same audio must produce identical pixels (§4.7), which is
   * only true if nothing anywhere reaches for `Math.random()` or a wall clock.
   */
  readonly seed: number;
  /** Ordered. Index is z-order: later layers composite over earlier ones. */
  readonly layers: readonly LayerSpec[];
  readonly palette: Palette;
}

/** Thrown by `migrate` rather than returning null, so a bad preset cannot half-load. */
export class PresetVersionError extends Error {}

/**
 * Bring a parsed preset up to `PRESET_VERSION`.
 *
 * A stub today because there is only one version — but it exists now so that
 * every load path already goes through it. Retrofitting a migration hook after
 * presets are in the wild means finding all the callers that skipped it, and
 * one of them always gets missed.
 *
 * Deliberately refuses FUTURE versions. Silently loading a preset written by a
 * newer build gives a plausible-looking frame with a few fields quietly
 * missing, which is far harder to diagnose than an outright failure.
 */
export function migrate(raw: unknown): Preset {
  if (typeof raw !== 'object' || raw === null) {
    throw new PresetVersionError('Preset is not an object.');
  }
  const version = (raw as { version?: unknown }).version;
  if (typeof version !== 'number' || !Number.isInteger(version) || version < 1) {
    throw new PresetVersionError(`Preset has no usable version field (got ${String(version)}).`);
  }
  if (version > PRESET_VERSION) {
    throw new PresetVersionError(
      `Preset version ${version} is newer than this build understands ` +
      `(${PRESET_VERSION}). Refusing to guess at the missing fields.`,
    );
  }
  // No historical versions yet. Each future one gets its own step here,
  // applied in order, so a v1 preset walks all the way up rather than needing
  // a v1 -> vN case of its own.
  return raw as Preset;
}

// ---------------------------------------------------------------------------
// Instrumentation
// ---------------------------------------------------------------------------

/**
 * One GPU timestamp-query result. Per PASS, not per frame — a budget reported
 * as a single number tells you it was blown but not by what, and §4.11 says a
 * budget nobody measures is a budget nobody keeps.
 */
export interface GpuTiming {
  /** Matches the pass/pipeline label, so the overlay needs no separate mapping. */
  readonly label: string;
  /** Milliseconds. Resolved a frame or two late; `timestamp-query` is asynchronous. */
  readonly ms: number;
}

// ---------------------------------------------------------------------------
// Pure helpers
//
// Arithmetic only. Anything that needs a tempo tracker, a device or a clock
// belongs in the module that owns one — see the file header.
// ---------------------------------------------------------------------------

/** Beats to grid slots. Fractional in, fractional out; slots are not quantised here. */
export function beatsToSlots(beats: number): number {
  return beats * SLOTS_PER_BEAT;
}

export function slotsToBeats(slots: number): number {
  return slots / SLOTS_PER_BEAT;
}

/** Seconds one slot occupies at `bpm`. At 200 BPM this is 1.25 ms — finer than perception (§3.1). */
export function secondsPerSlot(bpm: number): number {
  return 60 / bpm / SLOTS_PER_BEAT;
}

/** Total envelope length in beats. */
export function envelopeBeats(env: Envelope): number {
  return env.attackBeats + env.holdBeats + env.releaseBeats;
}

/**
 * How far BEFORE the event this layer must fire, in beats (§4.3).
 *
 * Output latency and the user's persisted offsets are deliberately not here —
 * they are wall-clock seconds and do not scale with tempo, so mixing them into
 * a beats-domain figure loses that distinction. The scheduler adds them in
 * seconds after converting this.
 */
export function anchorLeadBeats(anchor: Anchor, env: Envelope): number {
  switch (anchor) {
    case 'start': return 0;
    case 'peak':  return env.attackBeats;
    case 'end':   return envelopeBeats(env);
  }
}

// ---------------------------------------------------------------------------
// Pass descriptors (plan §4.1, §4.11)
//
// The registration contract for every source, warp, colour op, feedback system
// and operator. `layers.ts` decides WHICH passes run and in what order;
// `renderer.ts` executes them; this is what an individual pass has to say about
// itself so that both can do their jobs without importing it.
//
// It is deliberately data plus pure functions: WGSL source as a string, a
// uniform writer that fills a caller-owned Float32Array, and sizes as functions
// of the layer's params. Nothing here holds a GPUDevice, a buffer, a pipeline or
// a texture, for exactly the reason stated at the top of this file — a pass
// module must be importable by the preset validator and the golden harness
// without dragging a GPU in behind it.
//
// The BINDING LAYOUT these types describe lives in `renderer.ts`
// (`PASS_BINDING`, `PASS_COMMON_WGSL`). A pass author prepends
// `PASS_COMMON_WGSL` — and `AUDIO_WGSL` from `audiogpu.ts` when `usesAudio` —
// to their shader source and gets the declarations for free, in the same way
// every audio-reading shader already does. Hand-writing those bindings is
// possible and is how a shader ends up one binding number out of step with the
// bind group the renderer builds, which validates cleanly and samples the wrong
// texture.
// ---------------------------------------------------------------------------

/**
 * What the pass reads as its main texture input.
 *
 * - `none` — reads nothing. Sources that draw out of audio and arithmetic.
 * - `accumulator` — reads the frame composited so far. Warps, colour ops and
 *   operators are all this, and it is the property that makes them cost a pass
 *   rather than a draw call: a WebGPU render pass may not sample the attachment
 *   it writes, so reading the accumulator forces a ping-pong (§4.11).
 *
 * A `source` may NOT declare `accumulator`. It is drawn straight into the
 * accumulator with fixed-function blending, so sampling it would be sampling
 * its own attachment. A source that genuinely wants the frame underneath is a
 * `warp` or an `operator` wearing the wrong family.
 */
export type PassInput = 'none' | 'accumulator';

/**
 * How the geometry is produced.
 *
 * `fullscreen` is the covering triangle every warp/colour/operator uses — three
 * vertices, no vertex buffer, position derived from `vertex_index`. `vertices`
 * is the generative case: the vertex shader indexes a storage buffer the
 * compute prepass just wrote, which is how §4.5's attractors and particles draw
 * 100k+ primitives with no VBO plumbing at all.
 */
export type DrawSpec =
  | { readonly kind: 'fullscreen' }
  | {
      readonly kind: 'vertices';
      /** Total vertices. For quad-per-primitive geometry this is 6 x primitives. */
      vertexCount(ctx: PassContext): number;
    };

/**
 * A persistent GPU buffer the pass owns across frames.
 *
 * Persistence within one transport run is the point: a Lorenz trajectory is
 * `p[n+1] = f(p[n])` and cannot be recomputed from scratch each frame, so the
 * state has to live somewhere that survives (§4.5). The renderer allocates one
 * per LAYER (not per type — two Lorenz layers are two independent systems),
 * then recreates it at seek, preset, type, or seed boundaries so deterministic
 * playback never inherits a previous run's simulation state.
 *
 * Bound at `PASS_BINDING.storage0 + index`, as `var<storage, read_write>` in the
 * compute shader and `var<storage, read>` in the render shader. That asymmetry
 * is not a choice: a read-only binding is the only kind visible to a vertex
 * stage, and the vertex stage is precisely what reads it.
 */
export interface StorageSpec {
  readonly label: string;
  /** Size in bytes. Rounded up to 4 by the renderer; a size of 0 is an error. */
  bytes(params: Readonly<Record<string, ParamValue>>): number;
  /**
   * Seed the buffer once, at allocation. `view` is zero-filled on entry.
   *
   * Seeded from the preset, never from whatever was in the buffer and never
   * from `Math.random()` — §4.7 names feedback and particle seeding explicitly,
   * because it is the one place non-determinism hides in plain sight and still
   * looks correct.
   */
  init?(view: Float32Array, seed: number, params: Readonly<Record<string, ParamValue>>): void;
}

/**
 * A compute prepass. Runs before ANY render pass in the frame, so a source may
 * assume its storage is current by the time its draw is encoded.
 *
 * Before, not immediately-before: a merged draw run holds several layers and
 * there is no "immediately before" that is true for all of them. Hoisting them
 * all to the top of the frame is the only ordering that is the same for every
 * member, and it costs nothing — the GPU is free to overlap them anyway.
 */
export interface ComputeSpec {
  readonly code: string;
  /** Defaults to `main`. */
  readonly entryPoint?: string;
  /** Workgroup counts. A bare number means (n, 1, 1). */
  workgroups(ctx: PassContext): number | readonly [number, number, number];
}

/**
 * Everything a pass is told about the frame it is being asked to draw.
 *
 * Every field is derived from the audio clock or from data the caller already
 * had (§4.6) — there is no wall clock anywhere in here, and a pass that wants
 * one is a pass that will drift against the music. Rates are supplied in BEATS
 * and BARS as well as seconds so that the natural thing to write is the
 * musically correct thing; `dtSeconds` exists for exponential decay constants
 * and for nothing else.
 */
export interface PassContext {
  readonly spec: LayerSpec;
  /** `spec.params`, hoisted because every pass reaches for it. */
  readonly params: Readonly<Record<string, ParamValue>>;
  /** Envelope value 0..1 (`ResolvedLayer.progress`). Never 0 — a spent layer never reaches a pass. */
  readonly progress: number;
  /** `spec.opacity * progress`. The pass is responsible for applying it; see `PASS_COMMON_WGSL`. */
  readonly opacity: number;
  /** `layerSeed(preset.seed, spec.id)`. Stable across reorder and reload. */
  readonly seed: number;
  readonly audio: AudioSnapshot;
  readonly palette: Palette;
  /** The palette slot named by `spec.palette`, already resolved. */
  readonly color: PaletteColor;
  /** Audio-clock seconds (§4.6). */
  readonly time: number;
  /** Continuous beat position. Fractional. */
  readonly beats: number;
  /** `beats / 4`. */
  readonly bars: number;
  readonly bpm: number;
  /** Beats elapsed since the previous frame — the correct step for anything that integrates. */
  readonly dtBeats: number;
  /** Seconds elapsed since the previous frame. For `exp(-dt/tau)` decay and nothing else. */
  readonly dtSeconds: number;
  /** Attachment width in PIXELS, after this layer's resolution scale. Not the canvas width. */
  readonly width: number;
  /** Attachment height in pixels, after this layer's resolution scale. */
  readonly height: number;
  /** `width / height`. */
  readonly aspect: number;
  /** Monotonic frame counter. Deterministic; in fixed-timestep mode it is the only counter that is. */
  readonly frame: number;
}

/**
 * What a layer implementation registers with the renderer.
 *
 * One descriptor per layer TYPE, shared by every layer of that type in the
 * stack. Anything per-instance — uniforms, storage, history targets — is keyed
 * by `LayerSpec.id` inside the renderer, so two `lorenz` layers are two
 * independent systems that share one pipeline. That split is what makes the
 * pipeline cache worth having: creating a `GPURenderPipeline` per frame is
 * catastrophic, creating one per (type, format, blend) is free after the first
 * frame.
 */
export interface PassDescriptor {
  /** Matches `LayerSpec.type`. The registry key. */
  readonly type: string;
  /** Must agree with `LayerSpec.family`; the renderer refuses the pass if it does not, because family decides scheduling. */
  readonly family: LayerFamily;
  /** WGSL for the render stage. Entry points are `vs` and `fs`, always. */
  readonly code: string;
  /** Defaults to `{ kind: 'fullscreen' }`. */
  readonly draw?: DrawSpec;
  /** Defaults to `none` for `source`, `accumulator` for everything else. */
  readonly input?: PassInput;
  /**
   * Give this layer its own ping-pong pair, bound at `PASS_BINDING.history`.
   * Defaults to `family === 'feedback'`. Always `rgba16float` — 8-bit feedback
   * compounds and dies (§3.2), and that is not negotiable per-pass.
   */
  readonly history?: boolean;
  /** Bind the audio group. Costs one bind group set per draw and nothing else. */
  readonly usesAudio?: boolean;
  /** Size of the pass's own uniform block, in f32. 0 means it has none and binding 4 is absent. */
  readonly uniformFloats?: number;
  /**
   * Fill the uniform block. `out` is a caller-owned zero-filled view of exactly
   * `uniformFloats` floats, reused every frame — do not retain it, and do not
   * assume anything about its contents on entry beyond the zeroes.
   *
   * Pack it to match the WGSL struct BYTE FOR BYTE. WGSL rounds a uniform
   * struct's alignment up to 16 and aligns `vec4` to 16, and a `vec3` is 12
   * bytes wide at 16-byte alignment, which drags four invisible bytes after it.
   * `audiogpu.ts` has the long version of this lesson; the short version is: no
   * `vec3` in a uniform, ever.
   */
  writeUniforms?(out: Float32Array, ctx: PassContext): void;
  /** Persistent buffers, bound in declaration order from `PASS_BINDING.storage0`. */
  readonly storage?: readonly StorageSpec[];
  /** Optional compute prepass. */
  readonly compute?: ComputeSpec;
  /**
   * What this type WANTS to render at, if the preset has no opinion. Advisory
   * only — `LayerSpec.resolutionScale` always wins, because scaling is a budget
   * decision and the budget belongs to the show, not to the effect (§4.11).
   */
  readonly defaultResolutionScale?: number;
}

/** The renderer's view of the registered types. Keyed by `PassDescriptor.type`. */
export type PassRegistry = ReadonlyMap<string, PassDescriptor>;
