// Deterministic music-like audio fixtures for detector/tempo regression work.
//
// Everything here is synthesised from a seeded PRNG: no downloaded audio, no
// Math.random, no wall clock. The same seed always produces the same PCM, so a
// failing assertion is reproducible bit-for-bit on any machine.
//
// Ground truth is the list of instrument attack times the synthesiser placed.
// Attacks closer together than the native detector's 90 ms refractory gap are
// merged into one event (the earliest), because no causal detector with that
// gap can report them separately and scoring them as misses would only measure
// the gap, not the detector.
//
// `analyseNative()` reproduces the AudioWorklet front end (512-point Hann FFT
// hopped by one 128-sample quantum, AnalyserNode dB curve, spectral flatness)
// in front of the shared AdaptiveMultibandDetector, so these fixtures exercise
// the same numerical path the live worklet runs.

import { AdaptiveMultibandDetector, ONSET_CLASS_NAMES } from '../src/audio-features.ts';
import { TempoTracker } from '../src/clock.ts';

export const FIXTURE_SAMPLE_RATE = 48_000;
/** MIREX-style onset tolerance. The detector reports quantum start times. */
export const ONSET_TOLERANCE_SECONDS = 0.05;
const MERGE_GAP_SECONDS = 0.09;

export type FixtureEventKind = 'kick' | 'snare' | 'hat' | 'sub' | 'syllable';

export interface FixtureEvent { readonly time: number; readonly kind: FixtureEventKind }

export interface MusicFixture {
  readonly name: string;
  readonly description: string;
  readonly seconds: number;
  readonly left: Float32Array;
  readonly right: Float32Array;
  /** Merged ground-truth attack times the detector is scored against. */
  readonly events: readonly FixtureEvent[];
  /** Tempo the tracker must settle on (documented octave), or null if beatless. */
  readonly expectedBpm: number | null;
  /** Instantaneous tempo for gliding material; defaults to expectedBpm. */
  readonly bpmAt?: (time: number) => number;
  /** Time the first musical event sounds (lock-in time is measured from here). */
  readonly musicStart: number;
}

export interface NativeOnset { readonly time: number; readonly strength: number; readonly klass: string }

export interface TempoTrace {
  /** Audio time of the first lock whose tempo is in the expected octave. */
  readonly firstCorrectLock: number;
  /** Audio time of the first lock of any tempo. */
  readonly firstLock: number;
  readonly finalBpm: number;
  readonly finalLocked: boolean;
  /** Fraction of post-first-lock frames whose bpm is within tolerance. */
  readonly correctFraction: number;
  /** Fraction of all frames after musicStart spent locked. */
  readonly lockedFraction: number;
  /** Changes of half-octave class while locked (flip-flop detection). */
  readonly octaveSwitches: number;
  /** Locked frames whose bpm is NOT within tolerance of the expected tempo. */
  readonly wrongLockedFrames: number;
  /** Range of the locked bpm after the first correct lock. */
  readonly lockedBpmMin: number;
  readonly lockedBpmMax: number;
  /** Median |bpm - target| / target over frames after the first correct lock. */
  readonly medianRelativeError: number;
}

// ------------------------------------------------------------------ PRNG

/** mulberry32: tiny, fast, and fully deterministic across JS engines. */
export function seededRandom(seed: number): () => number {
  let state = seed >>> 0;
  return () => {
    state = (state + 0x6d2b79f5) >>> 0;
    let t = state;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

// ------------------------------------------------------------- synthesiser

class Mixer {
  readonly frames: number;
  readonly left: Float32Array;
  readonly right: Float32Array;
  readonly events: FixtureEvent[] = [];
  constructor(readonly seconds: number, readonly random: () => number) {
    this.frames = Math.round(seconds * FIXTURE_SAMPLE_RATE);
    this.left = new Float32Array(this.frames);
    this.right = new Float32Array(this.frames);
  }

  add(sample: number, left: number, right = left): void {
    if (sample < 0 || sample >= this.frames) return;
    this.left[sample] = this.left[sample]! + left;
    this.right[sample] = this.right[sample]! + right;
  }

  noise(): number { return this.random() * 2 - 1; }

  kick(time: number, gain = 0.9): void {
    const start = Math.round(time * FIXTURE_SAMPLE_RATE);
    const count = Math.round(0.3 * FIXTURE_SAMPLE_RATE);
    let phase = 0;
    for (let i = 0; i < count; i++) {
      const t = i / FIXTURE_SAMPLE_RATE;
      const frequency = 48 + 110 * Math.exp(-t * 38);
      phase += 2 * Math.PI * frequency / FIXTURE_SAMPLE_RATE;
      const click = i < 96 ? this.noise() * 0.25 * (1 - i / 96) : 0;
      const value = gain * (Math.exp(-t * 16) * Math.sin(phase) * tail(i, count) + click);
      this.add(start + i, value, value * 0.97);
    }
    this.events.push({ time, kind: 'kick' });
  }

  snare(time: number, gain = 0.55): void {
    const start = Math.round(time * FIXTURE_SAMPLE_RATE);
    let previous = 0;
    const count = Math.round(0.2 * FIXTURE_SAMPLE_RATE);
    for (let i = 0; i < count; i++) {
      const t = i / FIXTURE_SAMPLE_RATE;
      const raw = this.noise();
      const bright = raw - previous * 0.9;
      previous = raw;
      const body = Math.sin(2 * Math.PI * 185 * t) * Math.exp(-t * 30) * 0.5;
      const value = gain * (Math.exp(-t * 24) * bright * 0.8 + body) * tail(i, count);
      this.add(start + i, value, value * 0.92);
    }
    this.events.push({ time, kind: 'snare' });
  }

  hat(time: number, gain = 0.22, open = false): void {
    const start = Math.round(time * FIXTURE_SAMPLE_RATE);
    const decay = open ? 14 : 70;
    let a = 0, b = 0;
    const count = Math.round((open ? 0.3 : 0.06) * FIXTURE_SAMPLE_RATE);
    for (let i = 0; i < count; i++) {
      const t = i / FIXTURE_SAMPLE_RATE;
      const raw = this.noise();
      // Two first-difference stages: a cheap, deterministic high-pass.
      const first = raw - a; a = raw;
      const second = first - b; b = first;
      const value = gain * Math.exp(-t * decay) * second * 0.5 * tail(i, count);
      this.add(start + i, value * 0.8, value);
    }
    this.events.push({ time, kind: 'hat' });
  }

  /** Sustained 808-style sub: soft attack, long decay, optional pitch glide. */
  sub(time: number, seconds: number, hz: number, gain = 0.6, glideTo = hz, glideAt = seconds): void {
    const start = Math.round(time * FIXTURE_SAMPLE_RATE);
    let phase = 0;
    const count = Math.round(seconds * FIXTURE_SAMPLE_RATE);
    for (let i = 0; i < count; i++) {
      const t = i / FIXTURE_SAMPLE_RATE;
      const glide = t < glideAt ? 0 : Math.min(1, (t - glideAt) / 0.12);
      const frequency = hz * Math.pow(glideTo / hz, glide);
      phase += 2 * Math.PI * frequency / FIXTURE_SAMPLE_RATE;
      const attack = Math.min(1, t / 0.004);
      const release = Math.min(1, (seconds - t) / 0.03);
      const envelope = attack * release * (0.35 + 0.65 * Math.exp(-t * 0.9));
      const value = gain * Math.tanh(1.6 * Math.sin(phase)) * envelope;
      this.add(start + i, value);
    }
    this.events.push({ time, kind: 'sub' });
  }

  /** Detuned-saw chord whose gain follows `envelope(time)` (sidechain pump). */
  pad(from: number, to: number, roots: readonly number[], gain: number, envelope: (time: number) => number): void {
    const start = Math.round(from * FIXTURE_SAMPLE_RATE), end = Math.round(to * FIXTURE_SAMPLE_RATE);
    const phases = new Float64Array(roots.length * 2);
    for (let i = start; i < end; i++) {
      const time = i / FIXTURE_SAMPLE_RATE;
      let sum = 0;
      for (let voice = 0; voice < roots.length * 2; voice++) {
        const hz = roots[voice >> 1]! * (voice & 1 ? 1.004 : 0.996);
        phases[voice] = (phases[voice]! + hz / FIXTURE_SAMPLE_RATE) % 1;
        // Three-harmonic saw: bright enough to occupy mid bands, not a click.
        const p = phases[voice]! * 2 * Math.PI;
        sum += Math.sin(p) + Math.sin(2 * p) / 2 + Math.sin(3 * p) / 3;
      }
      const fade = Math.min(1, (time - from) / 0.05, (to - time) / 0.05);
      const value = gain * fade * envelope(time) * sum / (roots.length * 2);
      this.add(i, value, value * 0.95);
    }
  }

  /** Low-level pinkish room noise (one-pole smoothed white plus a little white). */
  room(from: number, to: number, gain: number): void {
    let smooth = 0;
    for (let i = Math.round(from * FIXTURE_SAMPLE_RATE); i < Math.round(to * FIXTURE_SAMPLE_RATE); i++) {
      const white = this.noise();
      smooth = smooth * 0.97 + white * 0.03;
      const value = gain * (smooth * 4 + white * 0.15);
      this.add(i, value, value * 0.9);
    }
  }

  /** A voiced syllable: harmonic buzz shaped by two formants and a soft envelope. */
  syllable(time: number, seconds: number, pitch: number, f1: number, f2: number, gain: number): void {
    const start = Math.round(time * FIXTURE_SAMPLE_RATE);
    const count = Math.round(seconds * FIXTURE_SAMPLE_RATE);
    const harmonics = Math.floor(3400 / pitch);
    const weights = new Float64Array(harmonics + 1);
    for (let h = 1; h <= harmonics; h++) {
      const hz = h * pitch;
      weights[h] = (Math.exp(-(((hz - f1) / 110) ** 2)) + 0.6 * Math.exp(-(((hz - f2) / 180) ** 2)) + 0.03) / h;
    }
    for (let i = 0; i < count; i++) {
      const t = i / FIXTURE_SAMPLE_RATE;
      const envelope = Math.sin(Math.PI * Math.min(1, t / seconds)) ** 1.5;
      const vibrato = pitch * (1 + 0.02 * Math.sin(2 * Math.PI * 5 * t));
      let sum = 0;
      for (let h = 1; h <= harmonics; h++) sum += weights[h]! * Math.sin(2 * Math.PI * h * vibrato * t);
      const value = gain * envelope * sum;
      this.add(start + i, value, value);
    }
    this.events.push({ time, kind: 'syllable' });
  }

  finish(): { left: Float32Array; right: Float32Array; events: FixtureEvent[] } {
    for (let i = 0; i < this.frames; i++) {
      this.left[i] = Math.tanh(this.left[i]!);
      this.right[i] = Math.tanh(this.right[i]!);
    }
    return { left: this.left, right: this.right, events: mergeEvents(this.events) };
  }
}

/** 20 ms linear release. A truncated voice is itself an attack-like step, and
 *  the detector is right to report it; fixtures must not plant such clicks. */
function tail(index: number, count: number): number {
  return Math.min(1, (count - index) / (0.02 * FIXTURE_SAMPLE_RATE));
}

function mergeEvents(events: readonly FixtureEvent[]): FixtureEvent[] {
  const sorted = [...events].sort((a, b) => a.time - b.time);
  const merged: FixtureEvent[] = [];
  for (const event of sorted) {
    const last = merged[merged.length - 1];
    if (last && event.time - last.time < MERGE_GAP_SECONDS) continue;
    merged.push(event);
  }
  return merged;
}

// ---------------------------------------------------------------- fixtures

/** EDM four-on-the-floor, 124 BPM: kick every beat, clap on 2/4, open offbeat
 *  hats, and a sustained saw pad sidechained so it pumps on every kick. */
export function fourOnTheFloor(seed = 0x4f10): MusicFixture {
  const bpm = 124, beat = 60 / bpm, seconds = 16, lead = 0.5;
  const mix = new Mixer(seconds, seededRandom(seed));
  const kicks: number[] = [];
  for (let index = 0; lead + index * beat < seconds - 0.3; index++) {
    const time = lead + index * beat;
    kicks.push(time);
    mix.kick(time);
    if (index % 2 === 1) mix.snare(time, 0.35);
    mix.hat(time + beat / 2, 0.16, true);
  }
  mix.pad(0, seconds, [110, 138.6, 164.8, 220], 0.32, time => {
    // Classic sidechain: duck to 15% on the kick, recover over ~80% of a beat.
    let since = Infinity;
    for (const kick of kicks) if (kick <= time) since = time - kick;
    return since === Infinity ? 1 : 0.15 + 0.85 * Math.min(1, since / (beat * 0.8)) ** 2;
  });
  return finish('four-on-the-floor', 'EDM 124 BPM, sidechain-pumped pad, offbeat open hats', mix, bpm, lead);
}

/** Trap, 140 BPM DAW tempo with half-time drums: sustained 808 sub notes that
 *  glide, kick/808 on 1 and the and-of-2, snare on 3, 8th hats with rolls. */
export function trap808(seed = 0x7a4b): MusicFixture {
  const bpm = 140, beat = 60 / bpm, bar = beat * 4, seconds = 18, lead = 0.4;
  const mix = new Mixer(seconds, seededRandom(seed));
  const random = seededRandom(seed ^ 0x5555);
  const roots = [43.65, 49, 38.9, 41.2];
  for (let barIndex = 0; lead + barIndex * bar < seconds - bar; barIndex++) {
    const t0 = lead + barIndex * bar;
    const root = roots[barIndex % roots.length]!;
    mix.kick(t0, 0.7);
    mix.sub(t0, beat * 1.4, root, 0.55);
    mix.kick(t0 + beat * 1.5, 0.6);
    // Long 808 that glides up a fourth mid-note: a sustained sub is the case the
    // old detector comment says collapses the threshold.
    mix.sub(t0 + beat * 1.5, beat * 2.4, root, 0.55, root * 1.335, beat * 1.2);
    mix.snare(t0 + beat * 2, 0.6);
    for (let eighth = 0; eighth < 8; eighth++) {
      const time = t0 + eighth * beat / 2;
      if (eighth === 7 && random() < 0.5) {
        // Hat roll: 1/16 triplets. Only the first survives the 90 ms merge.
        for (let r = 0; r < 3; r++) mix.hat(time + r * beat / 6, 0.12);
      } else mix.hat(time, eighth % 2 ? 0.1 : 0.14);
    }
  }
  return finish('trap-808', 'Trap 140 BPM half-time drums, sustained gliding 808, hat rolls', mix, bpm, lead);
}

/** Half-time ambiguity: kick/snare alternate on a 75 BPM pulse; a ghost hat
 *  lands on the 150 BPM subdivision in ~35% of pulses. From roughly p=0.27 up
 *  the slow and fast readings score within the tracker's OCTAVE_TIE, which is
 *  exactly where an unregularised tracker flips octave from bar to bar. */
export function halfTime(seed = 0x0a75): MusicFixture {
  const slow = 60 / 75, seconds = 24, lead = 0.4;
  const mix = new Mixer(seconds, seededRandom(seed));
  const random = seededRandom(seed ^ 0x2222);
  for (let index = 0; lead + index * slow < seconds - 0.4; index++) {
    const time = lead + index * slow;
    if (index % 2 === 0) mix.kick(time, 0.85); else mix.snare(time, 0.6);
    if (random() < 0.35) mix.hat(time + slow / 2, 0.2);
  }
  mix.pad(0, seconds, [98, 146.8, 196], 0.12, () => 1);
  // Documented octave rule (src/clock.ts): tied octaves fold toward 120 BPM,
  // so 75-vs-150 resolves to 150.
  return finish('half-time', '75/150 BPM ambiguity with sparse ghost hats', mix, 150, lead);
}

/** Rubato: a live-feel groove whose tempo glides ±8% around 100 BPM. */
export function rubato(seed = 0x3b0b): MusicFixture {
  const base = 100, seconds = 28, lead = 0.4, period = 14;
  const bpmAt = (time: number): number => base * (1 + 0.08 * Math.sin(2 * Math.PI * Math.max(0, time - lead) / period));
  const mix = new Mixer(seconds, seededRandom(seed));
  const random = seededRandom(seed ^ 0x9999);
  let time = lead, index = 0;
  while (time < seconds - 0.5) {
    const beat = 60 / bpmAt(time);
    // Human timing: ±6 ms per hit on top of the glide.
    const jitter = (random() - 0.5) * 0.012;
    if (index % 2 === 0) mix.kick(time + jitter, 0.8); else mix.snare(time + jitter, 0.55);
    mix.hat(time + beat / 2 + (random() - 0.5) * 0.012, 0.12);
    time += beat; index++;
  }
  return { ...finish('rubato', 'Live-feel groove gliding 92-108 BPM', mix, base, lead), bpmAt };
}

/** Swung hip-hop, 90 BPM: 62% swing on 8th hats, syncopated kick, snare 2/4. */
export function swungHipHop(seed = 0x5a1b): MusicFixture {
  const bpm = 90, beat = 60 / bpm, seconds = 20, lead = 0.4, swing = 0.62;
  const mix = new Mixer(seconds, seededRandom(seed));
  for (let index = 0; lead + index * beat < seconds - 0.5; index++) {
    const time = lead + index * beat;
    const inBar = index % 4;
    if (inBar === 0 || inBar === 2) mix.kick(time, 0.8);
    if (inBar === 1) mix.kick(time + beat * swing, 0.6);
    if (inBar === 1 || inBar === 3) mix.snare(time, 0.55);
    mix.hat(time, 0.13);
    mix.hat(time + beat * swing, 0.09);
  }
  mix.sub(lead, seconds - lead - 0.6, 55, 0.18);
  return finish('swung-hip-hop', 'Hip-hop 90 BPM with 62% swing and a sustained bass bed', mix, bpm, lead);
}

/** Quiet room tone with speech-like syllable bursts and no beat. */
export function roomSpeech(seed = 0x5bee): MusicFixture {
  const seconds = 24;
  const mix = new Mixer(seconds, seededRandom(seed));
  const random = seededRandom(seed ^ 0x7777);
  mix.room(0, seconds, 0.006);
  let time = 1.2;
  while (time < seconds - 2) {
    const syllables = 3 + Math.floor(random() * 6);
    const pitch = 105 + random() * 70;
    for (let s = 0; s < syllables && time < seconds - 1; s++) {
      const length = 0.11 + random() * 0.16;
      mix.syllable(time, length, pitch * (0.92 + random() * 0.16), 450 + random() * 350, 1100 + random() * 900, 0.18);
      time += length + 0.04 + random() * 0.14;
    }
    time += 0.6 + random() * 1.4;
  }
  return finish('room-speech', 'Quiet room noise with speech-like bursts, no beat', mix, null, 1.2);
}

/** Digital silence, then a full 128 BPM drop at 6 s. With `roomTone`, the
 *  last 2 s before the drop carry near-silent (-60 dBFS) room tone instead. */
export function silenceToDrop(seed = 0xd409, roomTone = false): MusicFixture {
  const bpm = 128, beat = 60 / bpm, seconds = 16, drop = 6;
  const mix = new Mixer(seconds, seededRandom(seed));
  if (roomTone) mix.room(4, seconds, 0.0015);
  const kicks: number[] = [];
  for (let index = 0; drop + index * beat < seconds - 0.3; index++) {
    const time = drop + index * beat;
    kicks.push(time);
    mix.kick(time, 0.9);
    if (index % 2 === 1) mix.snare(time, 0.4);
    mix.hat(time + beat / 2, 0.14);
    if (index % 4 === 0) mix.sub(time, beat * 3.6, 41.2, 0.4);
  }
  mix.pad(drop, seconds, [130.8, 164.8, 196], 0.25, time => {
    let since = Infinity;
    for (const kick of kicks) if (kick <= time) since = time - kick;
    return since === Infinity ? 1 : 0.2 + 0.8 * Math.min(1, since / (beat * 0.7));
  });
  return roomTone
    ? finish('room-tone-to-drop', '4 s digital silence, 2 s room tone, 128 BPM drop at 6 s', mix, bpm, drop)
    : finish('silence-to-drop', '6 s digital silence, 128 BPM drop at 6 s', mix, bpm, drop);
}

export function allFixtures(): MusicFixture[] {
  return [fourOnTheFloor(), trap808(), halfTime(), rubato(), swungHipHop(), roomSpeech(), silenceToDrop(), silenceToDrop(0xd409, true)];
}

function finish(name: string, description: string, mix: Mixer, expectedBpm: number | null, musicStart: number): MusicFixture {
  const { left, right, events } = mix.finish();
  return { name, description, seconds: mix.seconds, left, right, events, expectedBpm, musicStart };
}

// ------------------------------------------------------ native front end

const FFT_N = 512;
const BINS = FFT_N / 2;
const HOP = 128;
const MIN_DB = -100;
const DB_RANGE = 70;

/**
 * Offline replica of detector.worklet.ts's analysis loop. The detector object
 * is the real shared one; only the PCM→spectrum front end is duplicated here
 * because the worklet file cannot be imported outside an AudioWorklet scope.
 * Onset times are block-start audio times, matching the worklet's currentTime.
 */
export function analyseNative(left: Float32Array, right: Float32Array, sampleRate = FIXTURE_SAMPLE_RATE): NativeOnset[] {
  const detector = new AdaptiveMultibandDetector(sampleRate, BINS, sampleRate / HOP);
  const re = new Float64Array(FFT_N), im = new Float64Array(FFT_N);
  const window = new Float64Array(FFT_N);
  let windowGain = 0;
  for (let i = 0; i < FFT_N; i++) {
    window[i] = 0.5 - 0.5 * Math.cos((2 * Math.PI * i) / FFT_N);
    windowGain += window[i]!;
  }
  const spec = new Float32Array(BINS);
  const onsets: NativeOnset[] = [];
  const scale = 2 / windowGain;
  for (let block = 0; (block + 1) * HOP <= left.length; block++) {
    const end = (block + 1) * HOP;
    if (end < FFT_N) continue;
    const start = end - FFT_N;
    for (let i = 0; i < FFT_N; i++) {
      const m = (left[start + i]! + right[start + i]!) * 0.5;
      re[i] = m * window[i]!;
      im[i] = 0;
    }
    fft(re, im);
    let logSum = 0, linearSum = 0;
    for (let i = 0; i < BINS; i++) {
      const mag = Math.sqrt(re[i]! * re[i]! + im[i]! * im[i]!) * scale;
      const db = 20 * Math.log10(mag + 1e-12);
      const value = Math.max(0, Math.min(1, (db - MIN_DB) / DB_RANGE));
      spec[i] = value;
      logSum += Math.log(value + 1e-6);
      linearSum += value;
    }
    const flatness = linearSum > 0 ? Math.exp(logSum / BINS) / (linearSum / BINS) : 0;
    const time = block * HOP / sampleRate;
    const frame = detector.analyse(spec, 1, time, HOP / sampleRate, flatness);
    if (frame.onsetClassCode !== 0) {
      onsets.push({ time, strength: frame.onsetStrength, klass: ONSET_CLASS_NAMES[frame.onsetClassCode] ?? 'tonal' });
    }
  }
  return onsets;
}

function fft(re: Float64Array, im: Float64Array): void {
  const n = re.length;
  for (let i = 1, j = 0; i < n; i++) {
    let bit = n >> 1;
    for (; j & bit; bit >>= 1) j ^= bit;
    j ^= bit;
    if (i < j) {
      const tr = re[i]!; re[i] = re[j]!; re[j] = tr;
      const ti = im[i]!; im[i] = im[j]!; im[j] = ti;
    }
  }
  for (let size = 2; size <= n; size <<= 1) {
    const half = size >> 1, step = -2 * Math.PI / size;
    for (let i = 0; i < n; i += size) for (let k = 0; k < half; k++) {
      const c = Math.cos(step * k), s = Math.sin(step * k);
      const l = i + k + half, j = i + k;
      const tr = re[l]! * c - im[l]! * s, ti = re[l]! * s + im[l]! * c;
      re[l] = re[j]! - tr; im[l] = im[j]! - ti;
      re[j] = re[j]! + tr; im[j] = im[j]! + ti;
    }
  }
}

// --------------------------------------------------------------- scoring

export interface MatchStats {
  readonly matched: number;
  readonly reference: number;
  readonly detected: number;
  readonly recall: number;
  readonly precision: number;
  /** Signed detected-minus-reference offsets of matched pairs, seconds. */
  readonly offsets: readonly number[];
}

/** Greedy one-to-one matching in time order within ±tolerance. */
export function matchEvents(reference: readonly number[], detected: readonly number[], tolerance = ONSET_TOLERANCE_SECONDS): MatchStats {
  const used = new Uint8Array(detected.length);
  const offsets: number[] = [];
  let cursor = 0;
  for (const ref of reference) {
    while (cursor < detected.length && detected[cursor]! < ref - tolerance) cursor++;
    let best = -1, bestDistance = Infinity;
    for (let i = cursor; i < detected.length && detected[i]! <= ref + tolerance; i++) {
      if (used[i]) continue;
      const distance = Math.abs(detected[i]! - ref);
      if (distance < bestDistance) { best = i; bestDistance = distance; }
    }
    if (best >= 0) { used[best] = 1; offsets.push(detected[best]! - ref); }
  }
  const matched = offsets.length;
  return {
    matched,
    reference: reference.length,
    detected: detected.length,
    recall: reference.length ? matched / reference.length : 1,
    precision: detected.length ? matched / detected.length : 1,
    offsets,
  };
}

/**
 * Feed onsets into a TempoTracker exactly as main.ts does (every onset, one
 * update per 60 Hz frame) and summarise the lock behaviour.
 */
export function traceTempo(fixture: MusicFixture, onsets: readonly number[], tolerance = 0.04): TempoTrace {
  const tracker = new TempoTracker();
  const frameDt = 1 / 60;
  let cursor = 0, firstLock = Infinity, firstCorrectLock = Infinity;
  let afterLockFrames = 0, correctFrames = 0, lockedFrames = 0, musicFrames = 0;
  let octaveSwitches = 0, lastOctave: number | null = null, wrongLockedFrames = 0;
  let lockedBpmMin = Infinity, lockedBpmMax = -Infinity;
  const errors: number[] = [];
  const expected = fixture.expectedBpm;
  for (let frame = 0; frame * frameDt < fixture.seconds; frame++) {
    const now = frame * frameDt;
    while (cursor < onsets.length && onsets[cursor]! <= now) tracker.addOnset(onsets[cursor++]!);
    tracker.update(now);
    if (now >= fixture.musicStart) {
      musicFrames++;
      if (tracker.locked) lockedFrames++;
    }
    if (!tracker.locked) continue;
    if (!Number.isFinite(firstLock)) firstLock = now;
    if (expected !== null) {
      const target = fixture.bpmAt ? fixture.bpmAt(now) : expected;
      const correct = Math.abs(tracker.bpm - target) / target <= tolerance;
      if (!correct) wrongLockedFrames++;
      if (correct && !Number.isFinite(firstCorrectLock)) firstCorrectLock = now;
      if (Number.isFinite(firstCorrectLock)) {
        afterLockFrames++;
        if (correct) correctFrames++;
        lockedBpmMin = Math.min(lockedBpmMin, tracker.bpm);
        lockedBpmMax = Math.max(lockedBpmMax, tracker.bpm);
        errors.push(Math.abs(tracker.bpm - target) / target);
      }
      // Half-octave classes: 1x=0, 1.5x=1, 2x=2, 0.5x=-2. Small drift stays 0.
      const octave = Math.round(Math.log2(tracker.bpm / target) * 2);
      if (lastOctave !== null && octave !== lastOctave) octaveSwitches++;
      lastOctave = octave;
    }
  }
  return {
    firstLock, firstCorrectLock,
    finalBpm: tracker.bpm, finalLocked: tracker.locked,
    correctFraction: afterLockFrames ? correctFrames / afterLockFrames : 0,
    lockedFraction: musicFrames ? lockedFrames / musicFrames : 0,
    octaveSwitches, wrongLockedFrames, lockedBpmMin, lockedBpmMax,
    medianRelativeError: errors.length ? errors.sort((a, b) => a - b)[errors.length >> 1]! : Infinity,
  };
}
