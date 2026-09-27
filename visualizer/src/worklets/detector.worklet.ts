// Onset detection on the audio thread (plan §6, "Threading").
//
// This is the same spectral-flux detector as `audio.ts` `detectOnset()`, moved
// off requestAnimationFrame. rAF gives ~16 ms granularity at 60 Hz and stalls
// outright whenever the GPU janks, so a transient can be reported anywhere up
// to a frame-and-a-bit late and occasionally not at all. An AudioWorklet runs
// on a 128-sample quantum — 2.67 ms at 48 kHz — never misses a block, and is
// completely immune to whatever the renderer is doing. Phase 0's DoD is "onset
// timing jitter under 5 ms against a click track", which rAF cannot meet on
// arithmetic alone.
//
// What this file deliberately does NOT do:
//   - tempo tracking, scheduling or any notion of the grid. Those live on the
//     main thread in `clock.ts` and want history and lookahead, neither of
//     which belongs in a realtime callback.
//   - the visual spectrum. The 512-point transform here is the ~10 ms tier of
//     the analysis bank and nothing else; the 2048 analyser in `audio.ts`
//     remains the authority for anything drawn (§6).
//   - anything at all with `performance.now()`. The worklet global
//     `currentTime` IS `audioContext.currentTime` (§4.6), which is precisely
//     why detection belongs here.
//
// The hard rule for everything below: NO ALLOCATION IN `process()`. Every
// buffer is sized once in the constructor. A GC pause on the audio thread is a
// dropout, and a dropout is worse than a late onset.

import {
  AdaptiveMultibandDetector,
  AUDIO_FEATURE_FLOATS,
  AUDIO_FEATURE_OFFSETS,
  ONSET_CLASS_NAMES,
  PERCEPTUAL_BAND_COUNT,
} from '../audio-features.ts';

// ---------------------------------------------------------------------------
// Ambient AudioWorklet scope
//
// TypeScript's DOM lib describes `AudioWorkletNode` (the main-thread half) but
// not the global scope the processor runs in, so the four names below have to
// be declared. They are ambient, module-scoped, and erased at build time.
// ---------------------------------------------------------------------------

declare const sampleRate: number;
/** Audio-clock seconds. The same clock as `audioContext.currentTime` (§4.6). */
declare const currentTime: number;
declare class AudioWorkletProcessor {
  readonly port: MessagePort;
  constructor();
}
declare function registerProcessor(
  name: string,
  ctor: new (options: AudioWorkletNodeOptions) => AudioWorkletProcessor,
): void;

// ---------------------------------------------------------------------------
// Ring buffer layout. Scalar/perceptual offsets live in audio-features.ts and
// are bundled into both halves, so changing the ABI cannot desynchronise them.
// ---------------------------------------------------------------------------

/** Frames the ring holds. ~0.68 s at 48 kHz — far more than a reader needs. */
const RING_FRAMES = 256;
/** Int32 control block, then the float frames. 16 B keeps the floats aligned. */
const HEADER_INTS = 4;
const HEADER_BYTES = HEADER_INTS * 4;
/** Monotonic count of frames ever written. The only synchronisation there is. */
const CTL_WRITE_COUNT = 0;

const FFT_N = 512;                // ~10 ms window, the transient tier of §6
const BINS = FFT_N / 2;

// AnalyserNode's dB mapping, reproduced deliberately. `audio.ts` reads
// `getByteFrequencyData`, which is `(dB - minDecibels) / (maxDecibels -
// minDecibels)` clamped to 0..1 and quantised to a byte. Every constant above
// was tuned against THAT curve, so a raw linear magnitude here would silently
// invalidate DETECT_FLOOR and the whitening floor together. Same curve, minus
// the byte quantisation — strictly more precision, identical scale.
const MIN_DB = -100;
const MAX_DB = -30;
const DB_RANGE = MAX_DB - MIN_DB;


class DetectorProcessor extends AudioWorkletProcessor {
  // --- shared output ------------------------------------------------------
  private readonly ctl: Int32Array | null;
  private readonly frames: Float32Array | null;
  private writeCount = 0;

  // --- rolling input windows ---------------------------------------------
  // Circular, FFT_N long, one per channel. `histPos` is the next slot to
  // write, which is also the OLDEST sample — the window is read from there.
  private readonly histL = new Float32Array(FFT_N);
  private readonly histR = new Float32Array(FFT_N);
  private histPos = 0;
  private primed = 0;

  // --- FFT scratch (allocated once, reused forever) -----------------------
  private readonly re = new Float32Array(FFT_N);
  private readonly im = new Float32Array(FFT_N);
  private readonly rev = new Uint16Array(FFT_N);
  private readonly twCos = new Float32Array(FFT_N / 2);
  private readonly twSin = new Float32Array(FFT_N / 2);
  private readonly window = new Float32Array(FFT_N);
  private readonly windowGain: number;

  // --- detector state -----------------------------------------------------
  private readonly spec = new Float32Array(BINS);
  private readonly detector = new AdaptiveMultibandDetector(sampleRate, BINS, sampleRate / 128);

  /** Reused onset payload. postMessage structured-clones it, so one is enough. */
  private readonly onsetMsg = {
    type: 'onset' as const,
    time: 0,
    strength: 0,
    klass: 'kick' as NonNullable<(typeof ONSET_CLASS_NAMES)[number]>,
    pan: 0,
  };

  constructor(options: AudioWorkletNodeOptions) {
    super();

    const opts = options.processorOptions as { ring?: SharedArrayBuffer } | undefined;
    const ring = opts?.ring;
    if (ring) {
      this.ctl = new Int32Array(ring, 0, HEADER_INTS);
      this.frames = new Float32Array(ring, HEADER_BYTES, RING_FRAMES * AUDIO_FEATURE_FLOATS);
    } else {
      // No SharedArrayBuffer means no per-quantum features, but onsets still
      // work over postMessage. Degrading rather than throwing matters because
      // the onsets are the part with a timing requirement.
      this.ctl = null;
      this.frames = null;
    }

    // Hann window. AnalyserNode uses Blackman; the ~1.5 dB coherent-gain
    // difference is divided straight back out below, and the detector reads
    // frame-to-frame DIFFERENCES anyway, so the choice is immaterial here.
    let gain = 0;
    for (let i = 0; i < FFT_N; i++) {
      const w = 0.5 - 0.5 * Math.cos((2 * Math.PI * i) / FFT_N);
      this.window[i] = w;
      gain += w;
    }
    this.windowGain = gain;

    // Bit-reversal permutation and twiddles, precomputed so `process()` does
    // no transcendental maths at all.
    let bits = 0;
    while (1 << bits < FFT_N) bits++;
    for (let i = 0; i < FFT_N; i++) {
      let r = 0;
      for (let b = 0; b < bits; b++) r |= ((i >>> b) & 1) << (bits - 1 - b);
      this.rev[i] = r;
    }
    for (let k = 0; k < FFT_N / 2; k++) {
      this.twCos[k] = Math.cos((2 * Math.PI * k) / FFT_N);
      this.twSin[k] = Math.sin((2 * Math.PI * k) / FFT_N);
    }

    // Transport changes invalidate every running statistic (§4.10). Seeking
    // without this leaves a whitening curve and a flux mean from a passage we
    // jumped away from, and the first bar after a seek either floods with
    // false onsets or reports none at all.
    this.port.onmessage = (e: MessageEvent) => {
      if ((e.data as { type?: string } | null)?.type === 'reset') this.reset();
    };
  }

  private reset(): void {
    this.histL.fill(0);
    this.histR.fill(0);
    this.histPos = 0;
    this.primed = 0;
    this.spec.fill(0);
    this.detector.reset();
  }

  process(inputs: Float32Array[][]): boolean {
    const input = inputs[0];
    // Returning true with nothing to do keeps the node alive across a source
    // swap. Returning false would retire the processor permanently, and the
    // next track would then be analysed by a node that no longer exists.
    if (!input || input.length === 0) return true;
    const chL = input[0];
    if (!chL || chL.length === 0) return true;
    const chR = input[1] ?? chL;

    const n = chL.length;
    for (let i = 0; i < n; i++) {
      this.histL[this.histPos] = chL[i]!;
      this.histR[this.histPos] = chR[i]!;
      this.histPos = (this.histPos + 1) % FFT_N;
    }
    if (this.primed < FFT_N) {
      this.primed += n;
      if (this.primed < FFT_N) return true;
    }

    this.analyse(currentTime);
    return true;
  }

  /** One 512-point frame, hopped by one quantum. 4x overlap at 128/512. */
  private analyse(t: number): void {
    const { histL, histR, re, im, window } = this;
    const start = this.histPos; // oldest sample in the circular window

    // --- windowed mono into the transform, stereo stats on the way through --
    let peak = 0, mSq = 0, sSq = 0, sumL = 0, sumR = 0;
    for (let i = 0; i < FFT_N; i++) {
      const j = (start + i) % FFT_N;
      const l = histL[j]!, r = histR[j]!;
      const m = (l + r) * 0.5, s = (l - r) * 0.5;
      mSq += m * m; sSq += s * s;
      sumL += l * l; sumR += r * r;
      const a = m < 0 ? -m : m;
      if (a > peak) peak = a;
      re[i] = m * window[i]!;
      im[i] = 0;
    }
    const rms = Math.sqrt(mSq / FFT_N);
    const level = clamp(rms * 4);
    const crest = peak / (rms > 1e-5 ? rms : 1e-5);
    const mN = Math.sqrt(mSq), sN = Math.sqrt(sSq);
    const width = sN / Math.max(mN + sN, 1e-6);
    const rmsL = Math.sqrt(sumL / FFT_N), rmsR = Math.sqrt(sumR / FFT_N);
    // Broadband pan. §6's per-BAND pan needs the wider 2048 transform to be
    // meaningful at the bottom, so it stays on the main thread.
    const pan = rmsL + rmsR > 1e-5 ? clampSigned((rmsL - rmsR) / (rmsL + rmsR)) : 0;

    this.fft();

    // --- magnitudes on AnalyserNode's dB curve ------------------------------
    const scale = 2 / this.windowGain;
    let centroidNumerator = 0, centroidDenominator = 0, logSum = 0, linearSum = 0;
    for (let i = 0; i < BINS; i++) {
      const mag = Math.sqrt(re[i]! * re[i]! + im[i]! * im[i]!) * scale;
      const db = 20 * Math.log10(mag + 1e-12);
      const value = clamp((db - MIN_DB) / DB_RANGE);
      this.spec[i] = value;
      centroidNumerator += value * i;
      centroidDenominator += value;
      logSum += Math.log(value + 1e-6);
      linearSum += value;
    }
    const centroid = centroidDenominator > 0
      ? centroidNumerator / centroidDenominator / BINS
      : 0;
    const flatness = linearSum > 0
      ? Math.exp(logSum / BINS) / (linearSum / BINS)
      : 0;
    const features = this.detector.analyse(this.spec, 1, t, 128 / sampleRate, flatness);

    if (features.onsetClassCode !== 0) {
      // postMessage for the discrete event only. It allocates inside the
      // structured clone, which is exactly why per-quantum features go through
      // the ring instead — 375 messages a second would put the audio thread
      // permanently in the allocator's way.
      this.onsetMsg.time = t;
      this.onsetMsg.strength = features.onsetStrength;
      this.onsetMsg.klass = ONSET_CLASS_NAMES[features.onsetClassCode] ?? 'tonal';
      this.onsetMsg.pan = pan;
      this.port.postMessage(this.onsetMsg);
    }

    this.publish(t, level, crest, pan, width, centroid, flatness);
  }

  /** Write one feature frame and publish it with a single release store. */
  private publish(
    t: number, level: number, crest: number, pan: number, width: number,
    centroid: number, flatness: number,
  ): void {
    const frames = this.frames;
    if (!frames || !this.ctl) return;

    const base = (this.writeCount % RING_FRAMES) * AUDIO_FEATURE_FLOATS;
    const offsets = AUDIO_FEATURE_OFFSETS;
    const features = this.detector.result;
    frames[base + offsets.time] = t;
    frames[base + offsets.flux] = features.flux;
    frames[base + offsets.threshold] = features.threshold;
    frames[base + offsets.level] = level;
    frames[base + offsets.crest] = crest;
    frames[base + offsets.pan] = pan;
    frames[base + offsets.width] = width;
    frames[base + offsets.centroid] = centroid;
    frames[base + offsets.flatness] = flatness;
    for (let band = 0; band < 5; band++) {
      frames[base + offsets.publicBands + band] = features.publicBands[band]!;
    }
    frames[base + offsets.onsetStrength] = features.onsetStrength;
    frames[base + offsets.onsetClass] = features.onsetClassCode;
    for (let band = 0; band < PERCEPTUAL_BAND_COUNT; band++) {
      frames[base + offsets.perceptualBands + band] = features.bands[band]!;
      frames[base + offsets.perceptualFlux + band] = features.bandFlux[band]!;
    }

    // Single producer, single consumer, and the count is published AFTER the
    // payload. That ordering is the entire synchronisation protocol: a reader
    // that sees the new count is guaranteed to see the frame behind it, so no
    // lock is needed in either direction and the audio thread never blocks.
    this.writeCount++;
    Atomics.store(this.ctl, CTL_WRITE_COUNT, this.writeCount | 0);
  }

  /** In-place iterative radix-2, decimation in time. */
  private fft(): void {
    const { re, im, rev, twCos, twSin } = this;

    for (let i = 0; i < FFT_N; i++) {
      const j = rev[i]!;
      if (j > i) {
        const tr = re[i]!; re[i] = re[j]!; re[j] = tr;
        const ti = im[i]!; im[i] = im[j]!; im[j] = ti;
      }
    }

    for (let size = 2; size <= FFT_N; size <<= 1) {
      const half = size >> 1;
      const step = FFT_N / size;
      for (let i = 0; i < FFT_N; i += size) {
        for (let j = i, k = 0; j < i + half; j++, k += step) {
          const l = j + half;
          const c = twCos[k]!, s = twSin[k]!;
          // Forward transform, e^(-i2pik/N): the sign lives here and nowhere
          // else. Getting it wrong mirrors the spectrum, which for a real
          // input is invisible in the magnitudes and therefore very expensive
          // to find later.
          const tr = re[l]! * c + im[l]! * s;
          const ti = im[l]! * c - re[l]! * s;
          re[l] = re[j]! - tr; im[l] = im[j]! - ti;
          re[j] = re[j]! + tr; im[j] = im[j]! + ti;
        }
      }
    }
  }
}

function clamp(v: number): number { return v < 0 ? 0 : v > 1 ? 1 : v; }
function clampSigned(v: number): number { return v < -1 ? -1 : v > 1 ? 1 : v; }

registerProcessor('aaavs-detector', DetectorProcessor);
