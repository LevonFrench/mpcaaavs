import { StereoAnalysisBuffer } from './audio-buffer.ts';
import {
  AdaptiveMultibandDetector, ONSET_CLASS_NAMES,
} from '../audio-features.ts';
import type {
  OfflineAnalysisResult, OfflineAnchor, OfflineEventKind, OfflineFrameFeatures,
  OfflineMusicalEvent, OfflineSegment, OfflineTempoAuthority, PresetScheduleLedger,
} from './model.ts';
import { scheduleEntryAtSample } from './schedule.ts';
import { cumulativeBeatBoundarySample, OFFLINE_SAMPLE_RATE, type RationalTimebase } from './timebase.ts';

export interface OfflineAnalysisOptions {
  readonly tempo: OfflineTempoAuthority;
  readonly schedule: PresetScheduleLedger;
  readonly timebase: RationalTimebase;
  readonly segmentSeconds?: number;
}

/** Deterministic Tier-A baseline. It intentionally avoids wall time and platform FFT APIs. */
export function analyzeOfflineTrack(buffer: StereoAnalysisBuffer, options: OfflineAnalysisOptions): OfflineAnalysisResult {
  const { tempo, schedule, timebase } = options;
  validateTempo(tempo);
  const frameCount = timebase.frameCount(buffer.totalSamplesPerChannel);
  const spectral = analyzeSpectralFeatures(buffer, timebase, frameCount);
  const frames: OfflineFrameFeatures[] = [];
  const events: OfflineMusicalEvent[] = [];
  const samplesPerBeat = OFFLINE_SAMPLE_RATE * 60 / tempo.bpm;
  const alphaLow = Math.exp(-2 * Math.PI * 180 / OFFLINE_SAMPLE_RATE);
  const alphaMid = Math.exp(-2 * Math.PI * 2_500 / OFFLINE_SAMPLE_RATE);
  let lpLowL = 0, lpLowR = 0, lpMidL = 0, lpMidR = 0;
  let spectralEventIndex = 0;
  let nextBeat = Math.max(0, Math.ceil((-tempo.downbeatSample) / samplesPerBeat));

  for (let frame = 0; frame < frameCount; frame++) {
    const range = timebase.frameRange(frame, buffer.totalSamplesPerChannel);
    let sumL = 0, sumR = 0, peakL = 0, peakR = 0;
    let lowSq = 0, midSq = 0, highSq = 0;
    for (let sample = range.start; sample < range.end; sample++) {
      const left = buffer.sample(0, sample);
      const right = buffer.sample(1, sample);
      sumL += left * left; sumR += right * right;
      peakL = Math.max(peakL, Math.abs(left)); peakR = Math.max(peakR, Math.abs(right));
      lpLowL = (1 - alphaLow) * left + alphaLow * lpLowL;
      lpLowR = (1 - alphaLow) * right + alphaLow * lpLowR;
      lpMidL = (1 - alphaMid) * left + alphaMid * lpMidL;
      lpMidR = (1 - alphaMid) * right + alphaMid * lpMidR;
      const low = (lpLowL + lpLowR) * .5;
      const mid = ((lpMidL - lpLowL) + (lpMidR - lpLowR)) * .5;
      const high = ((left - lpMidL) + (right - lpMidR)) * .5;
      lowSq += low * low; midSq += mid * mid; highSq += high * high;
    }
    const count = Math.max(1, range.end - range.start);
    const rmsL = Math.sqrt(sumL / count), rmsR = Math.sqrt(sumR / count);
    const low = Math.sqrt(lowSq / count), mid = Math.sqrt(midSq / count), high = Math.sqrt(highSq / count);
    const centroid = spectral.centroid[frame]!;
    const flux = spectral.flux[frame]!;
    const onset = spectral.onset[frame]!;

    const frameEvents: Array<Readonly<{ kind: OfflineEventKind; confidence: number; sample: number }>> = [];
    while (spectralEventIndex < spectral.events.length && spectral.events[spectralEventIndex]!.sample < range.end) {
      const event = spectral.events[spectralEventIndex++]!;
      if (event.sample >= range.start) {
        pushEvent(events, frameEvents, event.kind, event.sample, frame, event.confidence, event.strength);
      }
    }
    while (true) {
      const beatSample = tempo.downbeatSample + cumulativeBeatBoundarySample(nextBeat, tempo.bpm);
      if (beatSample >= range.end || beatSample >= buffer.totalSamplesPerChannel) break;
      if (beatSample >= range.start) {
        const kind: OfflineEventKind = nextBeat % tempo.meterNumerator === 0 ? 'bar' : 'beat';
        pushEvent(events, frameEvents, kind, beatSample, frame, 1, 1);
      }
      nextBeat++;
    }

    const globalBeat = (range.start - tempo.downbeatSample) / samplesPerBeat;
    const beatPhase = positiveFract(globalBeat);
    const barPosition = globalBeat / tempo.meterNumerator;
    const entry = scheduleEntryAtSample(schedule, range.start);
    const previous = entry.index > 0 ? schedule.entries[entry.index - 1] : undefined;
    const transitionProgress = entry.transitionSamples > 0
      ? clamp01((range.start - entry.sampleStart) / entry.transitionSamples) : 1;
    const transitionActive = previous !== undefined && transitionProgress < 1;
    frames.push(Object.freeze({
      frame, sample_start: range.start, sample_end: range.end,
      time_seconds: timebase.timeSecondsAtFrame(frame), global_beat: globalBeat,
      bar: Math.floor(barPosition), slot_240: Math.floor(globalBeat * 240),
      beat_phase: beatPhase, bar_phase: positiveFract(barPosition), bpm: tempo.bpm,
      rms: Object.freeze({ master: Math.sqrt((sumL + sumR) / (count * 2)), left: rmsL, right: rmsR }),
      peak: Object.freeze({ master: Math.max(peakL, peakR), left: peakL, right: peakR }),
      energy: Object.freeze({ low, mid, high }), spectral_centroid: clamp01(centroid),
      spectral_flux: flux, onset_strength: onset, events: Object.freeze(frameEvents),
      active_preset: entry.presetId,
      // Classic AVS exposes one ordered preset tree rather than AAAVS's native
      // layer graph. Record that compatibility lane explicitly instead of
      // pretending individual effect nodes are native layers.
      active_layers: Object.freeze([`avs:${entry.presetId}`]),
      deterministic_seed: entry.seed,
      transition: Object.freeze(transitionActive
        ? { active: true, progress: transitionProgress, from: previous.presetId, to: entry.presetId }
        : { active: false, progress: 1 }),
    }));
  }

  const frozenEvents = Object.freeze(events.sort((a, b) => a.sample - b.sample || a.id.localeCompare(b.id)));
  const anchors = selectAnchors(frames, frozenEvents);
  const segments = buildSegments(buffer.totalSamplesPerChannel, frameCount, timebase, anchors, options.segmentSeconds ?? 6);
  return Object.freeze({
    analyzer: 'aaavs_tier_a_three_band_v1', tempo: Object.freeze({ ...tempo }),
    frames: Object.freeze(frames), events: frozenEvents,
    anchors: Object.freeze(anchors), segments: Object.freeze(segments),
  });
}

const OFFLINE_FFT_SIZE = 512;
const OFFLINE_FFT_BINS = OFFLINE_FFT_SIZE / 2;
const OFFLINE_FFT_HOP = 128;
const OFFLINE_MIN_DB = -100;
const OFFLINE_DB_RANGE = 70;
// Offline manifests describe sparse editorial events. Collapse the spectral
// detector's occasional release-tail re-trigger without changing its state.
const OFFLINE_EVENT_REFRACTORY_SAMPLES = Math.round(.13 * OFFLINE_SAMPLE_RATE);

interface OfflineSpectralEvent {
  readonly kind: OfflineEventKind;
  readonly sample: number;
  readonly confidence: number;
  readonly strength: number;
}

interface OfflineSpectralFeatures {
  readonly flux: Float32Array;
  readonly onset: Float32Array;
  readonly centroid: Float32Array;
  readonly events: readonly OfflineSpectralEvent[];
}

/**
 * Translate the realtime 512/128 spectral detector onto the sample-authority
 * offline ledger. The novelty/classification math is shared verbatim; waveform
 * RMS/peak and three-band energy remain sample-domain measurements above.
 */
function analyzeSpectralFeatures(
  buffer: StereoAnalysisBuffer,
  timebase: RationalTimebase,
  frameCount: number,
): OfflineSpectralFeatures {
  const flux = new Float32Array(frameCount);
  const onset = new Float32Array(frameCount);
  const centroid = new Float32Array(frameCount);
  const centroidCounts = new Uint16Array(frameCount);
  const events: OfflineSpectralEvent[] = [];
  const fft = new DeterministicFft512();
  const detector = new AdaptiveMultibandDetector(
    OFFLINE_SAMPLE_RATE, OFFLINE_FFT_BINS, OFFLINE_SAMPLE_RATE / OFFLINE_FFT_HOP,
  );
  const spectrum = new Float32Array(OFFLINE_FFT_BINS);

  for (let end = OFFLINE_FFT_SIZE; end <= buffer.totalSamplesPerChannel; end += OFFLINE_FFT_HOP) {
    fft.load(buffer, end - OFFLINE_FFT_SIZE);
    fft.transform();
    let centroidNumerator = 0;
    let centroidDenominator = 0;
    let logSum = 0;
    let linearSum = 0;
    for (let bin = 0; bin < OFFLINE_FFT_BINS; bin++) {
      const magnitude = fft.magnitude(bin);
      const db = 20 * Math.log10(magnitude + 1e-12);
      const value = clamp01((db - OFFLINE_MIN_DB) / OFFLINE_DB_RANGE);
      spectrum[bin] = value;
      centroidNumerator += value * bin;
      centroidDenominator += value;
      logSum += Math.log(value + 1e-6);
      linearSum += value;
    }
    const spectralCentroid = centroidDenominator > 0
      ? centroidNumerator / centroidDenominator / OFFLINE_FFT_BINS
      : 0;
    const flatness = linearSum > 0
      ? Math.exp(logSum / OFFLINE_FFT_BINS) / (linearSum / OFFLINE_FFT_BINS)
      : 0;
    const time = end / OFFLINE_SAMPLE_RATE;
    const features = detector.analyse(
      spectrum, 1, time, OFFLINE_FFT_HOP / OFFLINE_SAMPLE_RATE, flatness,
    );
    const frame = Math.min(frameCount - 1, timebase.frameAtSample(end - 1, 'floor'));
    if (frame < 0) continue;
    flux[frame] = Math.max(flux[frame] ?? 0, features.flux);
    onset[frame] = Math.max(onset[frame] ?? 0, features.onsetStrength);
    centroid[frame] = (centroid[frame] ?? 0) + spectralCentroid;
    centroidCounts[frame] = (centroidCounts[frame] ?? 0) + 1;

    if (features.onsetClassCode !== 0) {
      const liveClass = ONSET_CLASS_NAMES[features.onsetClassCode] ?? 'tonal';
      const kind: OfflineEventKind = liveClass === 'tonal' ? 'onset' : liveClass;
      const sample = strongestTransientSample(buffer, Math.max(1, end - OFFLINE_FFT_HOP), end);
      const previous = events[events.length - 1];
      if (!previous || sample - previous.sample >= OFFLINE_EVENT_REFRACTORY_SAMPLES) {
        events.push(Object.freeze({ kind, sample, confidence: features.onsetStrength, strength: features.flux }));
      }
    }
  }
  for (let frame = 0; frame < frameCount; frame++) {
    centroid[frame] = centroidCounts[frame]! > 0
      ? centroid[frame]! / centroidCounts[frame]!
      : frame > 0 ? centroid[frame - 1]! : 0;
  }
  return { flux, onset, centroid, events: Object.freeze(events) };
}

function strongestTransientSample(buffer: StereoAnalysisBuffer, start: number, end: number): number {
  let bestSample = start;
  let bestDelta = -1;
  let previous = (buffer.sample(0, start - 1) + buffer.sample(1, start - 1)) * .5;
  for (let sample = start; sample < end; sample++) {
    const current = (buffer.sample(0, sample) + buffer.sample(1, sample)) * .5;
    const delta = Math.abs(current - previous);
    if (delta > bestDelta) { bestDelta = delta; bestSample = sample; }
    previous = current;
  }
  return bestSample;
}

/** Fixed-size radix-2 FFT; storage is allocated once per offline pass. */
class DeterministicFft512 {
  private readonly re = new Float32Array(OFFLINE_FFT_SIZE);
  private readonly im = new Float32Array(OFFLINE_FFT_SIZE);
  private readonly reverse = new Uint16Array(OFFLINE_FFT_SIZE);
  private readonly cos = new Float32Array(OFFLINE_FFT_SIZE / 2);
  private readonly sin = new Float32Array(OFFLINE_FFT_SIZE / 2);
  private readonly window = new Float32Array(OFFLINE_FFT_SIZE);
  private readonly magnitudeScale: number;

  constructor() {
    let windowGain = 0;
    for (let i = 0; i < OFFLINE_FFT_SIZE; i++) {
      let value = i;
      let reversed = 0;
      for (let bit = 0; bit < 9; bit++) { reversed = (reversed << 1) | (value & 1); value >>>= 1; }
      this.reverse[i] = reversed;
      const w = .5 - .5 * Math.cos(2 * Math.PI * i / (OFFLINE_FFT_SIZE - 1));
      this.window[i] = w;
      windowGain += w;
    }
    for (let i = 0; i < OFFLINE_FFT_SIZE / 2; i++) {
      const angle = -2 * Math.PI * i / OFFLINE_FFT_SIZE;
      this.cos[i] = Math.cos(angle);
      this.sin[i] = Math.sin(angle);
    }
    this.magnitudeScale = 2 / windowGain;
  }

  load(buffer: StereoAnalysisBuffer, start: number): void {
    for (let i = 0; i < OFFLINE_FFT_SIZE; i++) {
      const mono = (buffer.sample(0, start + i) + buffer.sample(1, start + i)) * .5;
      this.re[i] = mono * this.window[i]!;
      this.im[i] = 0;
    }
  }

  transform(): void {
    for (let i = 0; i < OFFLINE_FFT_SIZE; i++) {
      const j = this.reverse[i]!;
      if (j <= i) continue;
      const real = this.re[i]!; this.re[i] = this.re[j]!; this.re[j] = real;
      const imaginary = this.im[i]!; this.im[i] = this.im[j]!; this.im[j] = imaginary;
    }
    for (let size = 2; size <= OFFLINE_FFT_SIZE; size <<= 1) {
      const half = size >>> 1;
      const twiddleStep = OFFLINE_FFT_SIZE / size;
      for (let base = 0; base < OFFLINE_FFT_SIZE; base += size) {
        for (let offset = 0; offset < half; offset++) {
          const twiddle = offset * twiddleStep;
          const cosine = this.cos[twiddle]!;
          const sine = this.sin[twiddle]!;
          const upper = base + offset;
          const lower = upper + half;
          const lowerRe = this.re[lower]! * cosine - this.im[lower]! * sine;
          const lowerIm = this.re[lower]! * sine + this.im[lower]! * cosine;
          const upperRe = this.re[upper]!;
          const upperIm = this.im[upper]!;
          this.re[upper] = upperRe + lowerRe;
          this.im[upper] = upperIm + lowerIm;
          this.re[lower] = upperRe - lowerRe;
          this.im[lower] = upperIm - lowerIm;
        }
      }
    }
  }

  magnitude(bin: number): number {
    return Math.sqrt(this.re[bin]! * this.re[bin]! + this.im[bin]! * this.im[bin]!) * this.magnitudeScale;
  }
}

function pushEvent(
  events: OfflineMusicalEvent[],
  frameEvents: Array<Readonly<{ kind: OfflineEventKind; confidence: number; sample: number }>>,
  kind: OfflineEventKind, sample: number, frame: number, confidence: number, strength: number,
): void {
  const event = Object.freeze({ id: `event_${events.length.toString().padStart(6, '0')}`, kind, sample, frame, confidence, strength });
  events.push(event);
  frameEvents.push(Object.freeze({ kind, confidence, sample }));
}

function selectAnchors(frames: readonly OfflineFrameFeatures[], events: readonly OfflineMusicalEvent[]): OfflineAnchor[] {
  if (frames.length === 0) return [];
  const selected = new Map<number, { role: OfflineAnchor['role']; reason: string; sourceEventId?: string }>();
  selected.set(0, { role: 'first', reason: 'first authoritative frame' });
  const last = frames.length - 1;
  selected.set(last, { role: 'last', reason: 'last authoritative frame' });
  const windowFrames = 6 * 24;
  for (let start = 0; start < frames.length; start += windowFrames) {
    let best = frames[start]!;
    for (let i = start + 1; i < Math.min(frames.length, start + windowFrames); i++) {
      if (frames[i]!.onset_strength > best.onset_strength) best = frames[i]!;
    }
    const event = events.find((candidate) => candidate.frame === best.frame && candidate.kind !== 'beat' && candidate.kind !== 'bar');
    if (!selected.has(best.frame)) selected.set(best.frame, {
      role: 'reference', reason: event ? `strong ${event.kind} event` : 'strongest onset in six-second segment', sourceEventId: event?.id,
    });
  }
  return [...selected.entries()].sort((a, b) => a[0] - b[0]).map(([frame, selection], index) => Object.freeze({
    id: `anchor_${index.toString().padStart(4, '0')}`, role: selection.role, frame,
    sample: frames[frame]!.sample_start, reason: selection.reason,
    ...(selection.sourceEventId ? { sourceEventId: selection.sourceEventId } : {}),
    pngPath: `frames/frame_${frame.toString().padStart(6, '0')}.png`,
  }));
}

function buildSegments(
  totalSamples: number, frameCount: number, timebase: RationalTimebase,
  anchors: readonly OfflineAnchor[], segmentSeconds: number,
): OfflineSegment[] {
  const span = Math.max(1, Math.round(segmentSeconds * OFFLINE_SAMPLE_RATE));
  const segments: OfflineSegment[] = [];
  for (let sampleStart = 0; sampleStart < totalSamples; sampleStart += span) {
    const sampleEnd = Math.min(totalSamples, sampleStart + span);
    const frameStart = timebase.frameAtSample(sampleStart, 'nearest');
    const frameEnd = sampleEnd === totalSamples ? frameCount : timebase.frameAtSample(sampleEnd, 'nearest');
    const inputs = anchors.filter((anchor) => anchor.sample >= sampleStart && anchor.sample < sampleEnd).map((anchor) => anchor.pngPath).slice(0, 3);
    segments.push(Object.freeze({
      id: `segment_${segments.length.toString().padStart(4, '0')}`,
      sampleStart, sampleEnd, frameStart, frameEnd,
      editorialFrameCount: frameEnd - frameStart,
      imageInputs: Object.freeze(inputs),
      audioInputs: Object.freeze([`audio/segment_${segments.length.toString().padStart(4, '0')}.wav`]),
      promptSlot: segments.length,
      // The authoritative spec does not define MiniMax's legal frame grid. The
      // adapter must resolve this against the installed H3 node instead of this
      // core inventing a number that looks valid but is not.
      h3GenerationFrameRequest: null,
      h3FramePolicy: 'unresolved_requires_minimax_adapter',
    }));
  }
  return segments;
}

function validateTempo(tempo: OfflineTempoAuthority): void {
  if (!Number.isFinite(tempo.bpm) || tempo.bpm <= 0) throw new RangeError('tempo bpm must be positive');
  if (!Number.isInteger(tempo.meterNumerator) || tempo.meterNumerator <= 0) throw new RangeError('meter numerator must be positive');
  if (!Number.isInteger(tempo.meterDenominator) || tempo.meterDenominator <= 0) throw new RangeError('meter denominator must be positive');
  if (!Number.isSafeInteger(tempo.downbeatSample)) throw new RangeError('downbeat sample must be an integer');
}
function clamp01(value: number): number { return Math.max(0, Math.min(1, value)); }
function positiveFract(value: number): number { return ((value % 1) + 1) % 1; }
