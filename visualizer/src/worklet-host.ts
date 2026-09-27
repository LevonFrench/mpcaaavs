// Main-thread half of the AudioWorklet detection path (plan §6, §4.9).
//
// Its job is to load `worklets/detector.worklet.ts`, wire the node into an
// existing graph, and hand the renderer two things: discrete onset events, and
// the most recent per-quantum feature frame.
//
// Those two travel by deliberately different routes, and the split is the whole
// point of the file:
//
//   - Onsets go over `postMessage`. They are rare (a few a second), each one
//     matters individually, and structured cloning a small object at that rate
//     costs nothing.
//   - Features go through a lock-free SPSC ring in a `SharedArrayBuffer`. The
//     worklet produces one every 2.67 ms — roughly 375 a second — and the
//     renderer consumes at frame rate. `postMessage` at that rate allocates on
//     the audio thread, and allocation on the audio thread is what causes
//     dropouts (§4.9). The ring never allocates and never blocks: the producer
//     writes the payload and then publishes a monotonic count, and a reader
//     that observes the new count is guaranteed to see the payload behind it.
//
// What this file deliberately does NOT do: build the AudioContext, own the
// transport, track tempo, or expose the spectrum. It attaches to a node it is
// given and reports. `audio.ts` remains the owner of the graph and of the
// analysis bank; this replaces only `detectOnset()`'s timing characteristics.

import type { BandName, Onset, OnsetClass } from './contracts.ts';
import {
  AUDIO_FEATURE_FLOATS,
  AUDIO_FEATURE_OFFSETS,
  ONSET_CLASS_NAMES,
  PERCEPTUAL_BAND_COUNT,
} from './audio-features.ts';

// ---------------------------------------------------------------------------
// Ring scalar/perceptual offsets are centralized in audio-features.ts. It is a
// DOM-free module and is bundled independently into each side.
// ---------------------------------------------------------------------------

const RING_FRAMES = 256;
const HEADER_INTS = 4;
const HEADER_BYTES = HEADER_INTS * 4;
const CTL_WRITE_COUNT = 0;

const BAND_ORDER: readonly BandName[] = ['sub', 'low', 'mid', 'high', 'air'];

/** Processor name, and the only string the two halves have to agree on. */
export const DETECTOR_PROCESSOR = 'aaavs-detector';
/**
 * Where the worklet bundle is expected, relative to the document. It is a
 * SEPARATE entry point on purpose — a worklet cannot be part of the main
 * bundle, because `registerProcessor` does not exist on the main thread and the
 * module would throw on import.
 *
 * That second entry point has to exist in `package.json` for any of this to
 * run; the main `build` script alone does not produce it:
 *
 *   esbuild src/worklets/detector.worklet.ts --bundle --format=esm
 *     --target=es2022 --outfile=dist/detector.worklet.js
 */
export const DETECTOR_MODULE_URL = 'dist/detector.worklet.js';

/** One decoded feature frame. Scalars only; the spectrum stays in `audio.ts`. */
export interface WorkletFeatures {
  /** Audio-clock seconds, already relative to `timeOrigin` (§4.6). */
  time: number;
  /** Raw spectral flux this quantum. Exposed so the detector can be watched. */
  flux: number;
  /** Adaptive threshold it was compared against. */
  thresh: number;
  level: number;
  crest: number;
  pan: number;
  width: number;
  centroid: number;
  flatness: number;
  bands: Record<BandName, number>;
  /** Stable, low-to-high perceptual-band energy envelopes. Reused in place. */
  perceptualBands: Float32Array;
  /** Per-band adaptively whitened positive-flux envelopes. Reused in place. */
  perceptualFlux: Float32Array;
  /**
   * Class carried by this frame, or null if nothing fired in it. For the debug
   * overlay. The onset CALLBACK is driven by `postMessage`, not by this, so
   * that the event path survives a missing `SharedArrayBuffer`.
   */
  onsetClass: OnsetClass | null;
}

/** Decode one ring frame into caller-owned storage without allocating. */
export function decodeWorkletFeatureFrame(
  frames: ArrayLike<number>,
  base: number,
  target: WorkletFeatures,
  timeOrigin = 0,
): void {
  const offsets = AUDIO_FEATURE_OFFSETS;
  target.time = (frames[base + offsets.time] ?? 0) - timeOrigin;
  target.flux = frames[base + offsets.flux] ?? 0;
  target.thresh = frames[base + offsets.threshold] ?? 0;
  target.level = frames[base + offsets.level] ?? 0;
  target.crest = frames[base + offsets.crest] ?? 1;
  target.pan = frames[base + offsets.pan] ?? 0;
  target.width = frames[base + offsets.width] ?? 0;
  target.centroid = frames[base + offsets.centroid] ?? 0;
  target.flatness = frames[base + offsets.flatness] ?? 0;
  for (let band = 0; band < BAND_ORDER.length; band++) {
    target.bands[BAND_ORDER[band]!] = frames[base + offsets.publicBands + band] ?? 0;
  }
  for (let band = 0; band < PERCEPTUAL_BAND_COUNT; band++) {
    target.perceptualBands[band] = frames[base + offsets.perceptualBands + band] ?? 0;
    target.perceptualFlux[band] = frames[base + offsets.perceptualFlux + band] ?? 0;
  }
  target.onsetClass = ONSET_CLASS_NAMES[(frames[base + offsets.onsetClass] ?? 0) | 0] ?? null;
}

export class WorkletDetectorError extends Error {}

/**
 * Whether the ring path is available at all.
 *
 * `SharedArrayBuffer` needs `crossOriginIsolated`, which needs COOP/COEP.
 * `tools/serve.mjs` sends both; any other host has to be configured to do the
 * same or this silently returns false and the ring path never engages. If
 * this is false the worklet still runs and still reports onsets; only the
 * per-quantum features are lost, and that is the right thing to degrade,
 * because the onsets are the half with a timing requirement.
 */
export function ringAvailable(): boolean {
  return typeof SharedArrayBuffer !== 'undefined' && crossOriginIsolated;
}

export class WorkletDetector {
  private node: AudioWorkletNode | null = null;
  private sink: GainNode | null = null;
  /**
   * Kept solely so `detach()` can undo the tap. `node.disconnect()` severs
   * OUTGOING edges only — the source's connection into the node survives it,
   * and a processor with a live input keeps running (and keeps writing the
   * ring) after the object that owns it has been thrown away. Attach/detach
   * across a few track changes then leaves several detectors analysing at once.
   */
  private source: AudioNode | null = null;

  private ctl: Int32Array | null = null;
  private frames: Float32Array | null = null;
  private readCount = 0;

  /**
   * Audio-clock time playback started, subtracted from everything reported.
   * The worklet's `currentTime` is the raw context clock, which starts when the
   * context does and not when the track does; `audio.ts` exposes its own
   * `currentTime` the same way. Set this at `play()`, and again on seek.
   */
  timeOrigin = 0;

  onOnset: ((o: Onset) => void) | null = null;

  /** Latest decoded frame. Overwritten in place — do not retain it. */
  readonly features: WorkletFeatures = {
    time: 0, flux: 0, thresh: 0, level: 0, crest: 1,
    pan: 0, width: 0, centroid: 0, flatness: 0,
    bands: { sub: 0, low: 0, mid: 0, high: 0, air: 0 },
    perceptualBands: new Float32Array(PERCEPTUAL_BAND_COUNT),
    perceptualFlux: new Float32Array(PERCEPTUAL_BAND_COUNT),
    onsetClass: null,
  };

  /** Onset envelope, 0..1, decaying. The reactive counterpart to `Timeline`. */
  beat = 0;

  /**
   * Frames the reader missed because it fell more than a ring behind. Should
   * be 0. A non-zero value means the main thread stalled for ~0.68 s, which is
   * worth seeing in the HUD rather than silently papering over.
   */
  dropped = 0;

  get attached(): boolean { return this.node !== null; }

  /**
   * Load the module, create the node, and splice it into the graph.
   *
   * `source` is tapped, not intercepted — the node's own output is silent and
   * goes to a zero-gain sink. That sink is not optional: a worklet whose output
   * reaches no destination is not guaranteed to be pulled, and the processor
   * then simply never runs while everything else looks correctly wired.
   */
  async attach(
    ctx: AudioContext,
    source: AudioNode,
    moduleUrl: string = DETECTOR_MODULE_URL,
  ): Promise<void> {
    if (this.node) this.detach();

    // The ring is built before the node because it has to travel in
    // `processorOptions`, but the VIEWS are not published onto `this` until the
    // node exists. A failed `addModule` would otherwise leave a reader pointed
    // at a buffer with no producer, which polls forever and returns 0 — a
    // symptom indistinguishable from a stalled audio thread.
    let ring: SharedArrayBuffer | undefined;
    if (ringAvailable()) {
      ring = new SharedArrayBuffer(HEADER_BYTES + RING_FRAMES * AUDIO_FEATURE_FLOATS * 4);
    }

    try {
      await ctx.audioWorklet.addModule(moduleUrl);
    } catch (e) {
      throw new WorkletDetectorError(
        `Could not load the detector worklet from "${moduleUrl}". It is a ` +
        `separate esbuild entry point; check that the build produced it. ` +
        `(${String(e)})`,
      );
    }

    const node = new AudioWorkletNode(ctx, DETECTOR_PROCESSOR, {
      numberOfInputs: 1,
      numberOfOutputs: 1,
      outputChannelCount: [1],
      // Downmixing to stereo here rather than in the processor keeps the
      // channel logic in one place, and the detector's pan/width need L and R
      // separately (§3.1).
      channelCount: 2,
      channelCountMode: 'explicit',
      channelInterpretation: 'speakers',
      processorOptions: ring ? { ring } : {},
    });

    node.port.onmessage = (e: MessageEvent) => {
      const d = e.data as { type?: string; time?: number; strength?: number; klass?: OnsetClass; pan?: number } | null;
      if (!d || d.type !== 'onset') return;
      const strength = d.strength ?? 0;
      this.beat = Math.max(this.beat, strength);
      this.onOnset?.({
        time: (d.time ?? 0) - this.timeOrigin,
        strength,
        klass: d.klass ?? 'tonal',
        pan: d.pan ?? 0,
      });
    };

    const sink = ctx.createGain();
    sink.gain.value = 0;
    source.connect(node);
    node.connect(sink);
    sink.connect(ctx.destination);

    this.node = node;
    this.sink = sink;
    this.source = source;
    if (ring) {
      this.ctl = new Int32Array(ring, 0, HEADER_INTS);
      this.frames = new Float32Array(ring, HEADER_BYTES, RING_FRAMES * AUDIO_FEATURE_FLOATS);
    }
    this.readCount = this.ctl ? Atomics.load(this.ctl, CTL_WRITE_COUNT) : 0;
  }

  /**
   * Drain the ring and advance the onset envelope. Call once per frame, with
   * the frame's `dt`, before anything reads `features`.
   *
   * Returns how many feature frames were consumed — at 120 fps and 48 kHz that
   * is about 3, and a sustained 0 means the audio thread is not running.
   */
  poll(dt: number): number {
    this.beat *= Math.exp(-dt * 7);
    // Exponential decay is asymptotic, so without this the envelope sits at
    // 1e-8 forever and every layer gated on `beat > 0` stays faintly lit
    // between hits. Snap the tail to a hard zero.
    if (this.beat < 1e-4) this.beat = 0;

    const ctl = this.ctl, frames = this.frames;
    if (!ctl || !frames) return 0;

    // Acquire side of the protocol: read the published count first, then the
    // payload behind it. Everything below that count is already committed.
    const write = Atomics.load(ctl, CTL_WRITE_COUNT);
    let count = write - this.readCount;
    if (count <= 0) return 0;
    if (count > RING_FRAMES) {
      // Fell further behind than the ring is deep. The old frames are gone;
      // reporting the loss beats decoding whatever overwrote them.
      this.dropped += count - RING_FRAMES;
      this.readCount = write - RING_FRAMES;
      count = RING_FRAMES;
    }

    // Only the newest frame is decoded in full — the renderer wants "now", not
    // a history. The intermediate frames still matter for their onset flags,
    // so the envelope is raised from any of them that fired, which is what
    // keeps a hit between two rAF ticks from being invisible.
    for (let i = 0; i < count; i++) {
      const base = ((this.readCount + i) % RING_FRAMES) * AUDIO_FEATURE_FLOATS;
      const s = frames[base + AUDIO_FEATURE_OFFSETS.onsetStrength]!;
      if (s > this.beat) this.beat = s;
    }
    this.readCount = write;

    const base = ((write - 1) % RING_FRAMES) * AUDIO_FEATURE_FLOATS;
    const f = this.features;
    decodeWorkletFeatureFrame(frames, base, f, this.timeOrigin);

    return count;
  }

  /**
   * Clear every running statistic in the detector. Required on seek and on
   * track change (§4.10): a whitening curve and a flux mean carried over from a
   * passage we jumped away from either floods the next bar with false onsets or
   * suppresses it entirely.
   */
  reset(): void {
    this.beat = 0;
    this.dropped = 0;
    this.node?.port.postMessage({ type: 'reset' });
    if (this.ctl) this.readCount = Atomics.load(this.ctl, CTL_WRITE_COUNT);
  }

  detach(): void {
    if (this.node) {
      this.node.port.onmessage = null;
      // Incoming edge first: see the note on `source`. Disconnecting a specific
      // destination throws if the edge is not there, and a caller that already
      // rewired the graph is a legitimate case, so it is not fatal here.
      try { this.source?.disconnect(this.node); } catch { /* already rewired */ }
      this.node.disconnect();
      this.node = null;
    }
    this.source = null;
    if (this.sink) { this.sink.disconnect(); this.sink = null; }
    this.ctl = null;
    this.frames = null;
    this.readCount = 0;
    this.beat = 0;
    this.dropped = 0;
  }
}
