// Live fallback analysis for the show engine (AAAVS addition).
//
// Before a song map exists (the background scan is still running, or the source is a stream), a show still
// needs an AudioData. LiveAudioData is one built from:
//  - a tempo-only grid: beats every 60/bpm s from `firstBeat`, a downbeat every `beatsPerBar` beats (4 unless the host's clock says
//    otherwise: 3 for a waltz, see song-map/meter.ts), and a neutral arrangement
//    (intro 4 bars, groove, outro 4 bars) so planShow() opens on the intro plate and closes on the outro plate;
//  - live AvsAudioFrames pushed as they are played (push(t, frame)): 100 fps envelopes, a 64-band mel spectrogram and
//    12-bin chroma from the AVS spectrum bytes, the waveform, and kick / snare / hat onsets (AVS beat flag and band flux).
//
// Plates read it through the same API as a song map (env, mel, chroma, waveAt, hit, events, onsets, beatAt, barAt).
// Onsets not heard yet are predicted on the grid (a kick on every beat, a snare on the backbeats of the meter: 2 and 4 in 4/4,
// 2 and 3 in 3/4, see `backbeats()` in song-map/meter.ts; a hat on every off-beat),
// so plates that schedule their story from the onsets of their window when they are built (magi's vote, the alarms)
// still have one; each push replaces the predictions up to its time with what was detected. Other data not heard yet
// reads as silence: future envelopes, spectrum and waveform, the bass pitch and vocal onsets (psycho's scope bank,
// built at init, sees only what was pushed before). The data a given sequence of
// pushes produces is deterministic; a live source is not a pure function of media time, which is the point of the
// song map that replaces this.
import type { AvsAudioFrame } from '../avs/types.ts';
import { backbeats, beatsPerBarOf } from '../song-map/meter.ts';
import type { SongMapJSON, SongMapSection } from '../song-map/types.ts';
import { AudioData } from './audio.ts';

export interface LiveClock {
  /** Media duration (s). */
  duration: number;
  /** Tempo of the grid. */
  bpm: number;
  /** Time of any beat (the grid is extended both ways from it). Default 0. */
  firstBeat?: number;
  /** PCM rate the AVS frames were analysed at. Default 44100. */
  sampleRate?: number;
  /** Seconds of analysis kept from `origin` (arrays hold min(duration - origin, maxSeconds)). Default 1200. */
  maxSeconds?: number;
  /** Media time of the first analysis frame (a window around the playing scene). Default 0. */
  origin?: number;
  /** Beats per bar (the host clock grid's `beatsPerBar`): whole numbers 2..12, anything else reads as 4. The grid's downbeats, the
   *  neutral arrangement and the predicted backbeat snares follow it. Default 4. */
  beatsPerBar?: number;
}

const FPS = 100;
const MEL = 64;
const S = MEL + 12;
const FMIN = 30, FMAX = 16000;
/** Live waveform rate: a quarter of the song map's 11025 Hz keeps long media small; scopes read `waveRate`. */
export const LIVE_WAVE_RATE = 2756.25;
const SAMPLES = 576;

const hz2mel = (f: number) => 2595 * Math.log10(1 + f / 700);
const mel2hz = (m: number) => 700 * (Math.pow(10, m / 2595) - 1);
const signed = (v: number) => (v < 128 ? v : v - 256) / 128;
const clamp01 = (x: number) => (x < 0 ? 0 : x > 1 ? 1 : x);

/** The tempo grid and neutral arrangement of a live clock (no analysis data). */
export function liveSongMap(c: LiveClock): SongMapJSON {
  const duration = Math.max(1, c.duration), bpm = Math.min(400, Math.max(20, c.bpm));
  const period = 60 / bpm, perBar = beatsPerBarOf(c.beatsPerBar);
  const b0 = (((c.firstBeat ?? 0) % period) + period) % period;
  const beats: number[] = [];
  for (let t = b0; t < duration; t += period) beats.push(+t.toFixed(6));
  const downbeats = beats.filter((_, i) => i % perBar === 0);
  const sections: SongMapSection[] = [];
  const nb = downbeats.length;
  if (nb >= 16) {
    sections.push({ name: 'intro', role: 'intro', start: 0, end: downbeats[4]!, energy: 0.3 });
    sections.push({ name: 'live', role: 'groove', start: downbeats[4]!, end: downbeats[nb - 4]!, energy: 0.6 });
    sections.push({ name: 'outro', role: 'outro', start: downbeats[nb - 4]!, end: duration, energy: 0.3 });
  } else sections.push({ name: 'live', role: 'groove', start: 0, end: duration, energy: 0.6 });
  return {
    version: 1, duration, bpm, fps: FPS, beats, downbeats, ...(perBar !== 4 ? { beatsPerBar: perBar } : {}), bar0: downbeats[0], sections,
    features: { rms: [], low: [], mid: [], high: [], vocal: [], drums: [], bass: [], other: [] },
    onsets: { kick: [], snare: [], hat: [], vocal: [] },
    spectrum: { frames: 0, mel: MEL, chroma: 12, fmin: FMIN, fmax: FMAX },
    confidence: { tempo: 0.5, downbeat: 0, sections: 0 },
    approximations: ['live', 'tempo-grid', 'downbeats', 'sections', 'bass_midi', 'vocal', 'drums', 'onsets', 'onsets-predicted'],
  };
}

/** Per-band adaptive normalisation: a slowly decaying peak and a slowly rising floor. */
class Norm {
  peak: Float32Array; floor: Float32Array;
  constructor(n: number, readonly decay = 0.9985, readonly rise = 0.002) { this.peak = new Float32Array(n).fill(1e-3); this.floor = new Float32Array(n).fill(1); }
  apply(i: number, v: number): number {
    this.peak[i] = Math.max(v, this.peak[i]! * this.decay);
    this.floor[i] = Math.min(v, this.floor[i]! + this.rise * (this.peak[i]! - this.floor[i]!));
    const span = this.peak[i]! - this.floor[i]!;
    return span > 1e-4 ? clamp01((v - this.floor[i]!) / span) : 0;
  }
}

export class LiveAudioData extends AudioData {
  readonly live = true;
  readonly capacityFrames: number;
  readonly sampleRate: number;
  /** Increments on every push that changed data. */
  revision = 0;
  private dirty: { f0: number; f1: number; w0: number; w1: number } | null = null;
  private lastT = -1;
  private lastFrame = -1;
  private readonly bandLo = new Int16Array(MEL);
  private readonly bandHi = new Int16Array(MEL);
  private readonly melNorm = new Norm(MEL);
  private readonly envNorm = new Norm(8, 0.999, 0.001);
  private readonly prevMel = new Float32Array(MEL);
  private readonly fluxMean = new Float32Array(3).fill(0.02);
  private readonly lastOnset = { kick: -1e9, snare: -1e9, hat: -1e9 };
  /** Index where each onset list's grid predictions start (detected onsets come before it). */
  private readonly predFrom = { kick: 0, snare: 0, hat: 0 };
  private readonly windowEnd: number;
  private readonly backbeat: readonly number[];

  constructor(clock: LiveClock) {
    const map = liveSongMap(clock);
    super(map);
    this.backbeat = backbeats(this.beatsPerBar);
    this.sampleRate = clock.sampleRate ?? 44100;
    this.origin = Math.max(0, Math.min(map.duration, clock.origin ?? 0));
    const seconds = Math.max(1, Math.min(map.duration - this.origin, clock.maxSeconds ?? 1200));
    this.capacityFrames = Math.max(1, Math.ceil(seconds * FPS) + 1);
    for (const k of ['rms', 'low', 'mid', 'high', 'vocal', 'drums', 'bass', 'other']) this.feat[k] = new Float32Array(this.capacityFrames);
    this.spec = new Uint8Array(this.capacityFrames * S);
    this.specFrames = this.capacityFrames;
    this.waveRate = LIVE_WAVE_RATE;
    this.wave = new Float32Array(Math.ceil(seconds * LIVE_WAVE_RATE + 1) * 2);
    map.spectrum!.frames = this.capacityFrames;
    this.windowEnd = this.origin + seconds;
    this.predict(this.origin);
    map.wave = { rate: LIVE_WAVE_RATE, channels: 2, frames: this.wave.length >> 1 };
    // mel band edges on the AVS spectrum bytes (byte i ~ i * sampleRate / 1024 Hz)
    const m0 = hz2mel(FMIN), m1 = hz2mel(Math.min(FMAX, this.sampleRate / 2));
    const idx = (f: number) => Math.round((f * 1024) / this.sampleRate);
    for (let b = 0; b < MEL; b++) {
      const lo = idx(mel2hz(m0 + ((m1 - m0) * b) / MEL)), hi = idx(mel2hz(m0 + ((m1 - m0) * (b + 1)) / MEL));
      this.bandLo[b] = Math.min(511, Math.max(0, lo));
      this.bandHi[b] = Math.min(511, Math.max(this.bandLo[b]!, hi - 1));
    }
  }

  /** Replace the grid predictions with predictions after t (kick every beat, snare on the backbeats of the meter, hat on the off-beats). */
  private predict(t: number) {
    const beats = this.map.beats, half = 30 / this.bpm;
    for (const k of ['kick', 'snare', 'hat'] as const) this.onsets[k]!.length = this.predFrom[k];
    for (let i = 0; i < beats.length; i++) {
      const b = beats[i]!;
      if (b > this.windowEnd) break;
      if (b > t) {
        const inBar = i % this.beatsPerBar;
        this.onsets.kick!.push([b, inBar === 0 ? 0.85 : 0.6]);
        if (this.backbeat.includes(inBar)) this.onsets.snare!.push([b, 0.65]);
      }
      if (b + half > t && b + half <= this.windowEnd) this.onsets.hat!.push([b + half, 0.35]);
    }
  }

  /** Changed frame and wave-sample ranges since the last call (for the GPU copies), or null. */
  takeDirty(): { f0: number; f1: number; w0: number; w1: number } | null {
    const d = this.dirty;
    this.dirty = null;
    return d;
  }

  /**
   * Add one AVS audio frame played at media time t (the end of its 576-sample window). A jump back in time drops the
   * onsets after t (the arrays are simply overwritten as playback continues).
   */
  push(t: number, frame: AvsAudioFrame): void {
    if (!Number.isFinite(t) || t < this.origin) return;
    const fi = Math.round((t - this.origin) * FPS);
    if (fi >= this.capacityFrames) return;
    if (this.lastT >= 0 && t < this.lastT - 0.05) {
      // seek back: drop the detections after t and predict again from t
      for (const k of ['kick', 'snare', 'hat'] as const) {
        const l = this.onsets[k]!;
        l.length = this.predFrom[k];
        while (l.length && l[l.length - 1]![0] >= t) l.pop();
        this.predFrom[k] = l.length;
      }
      this.predict(t);
      this.lastFrame = -1;
      this.lastOnset.kick = this.lastOnset.snare = this.lastOnset.hat = -1e9;
    }
    this.lastT = t;
    // predictions up to now are superseded by what was heard
    for (const k of ['kick', 'snare', 'hat'] as const) {
      const l = this.onsets[k]!, p = this.predFrom[k];
      let n = 0;
      while (p + n < l.length && l[p + n]![0] <= t) n++;
      if (n) l.splice(p, n);
    }

    // spectrum: mean of both channels, AVS log-magnitude bytes (0..1)
    const sp = frame.spectrum;
    const melRaw = new Float32Array(MEL);
    for (let b = 0; b < MEL; b++) {
      let s = 0;
      const lo = this.bandLo[b]!, hi = this.bandHi[b]!;
      for (let i = lo; i <= hi; i++) s += sp[0][i]! + sp[1][i]!;
      melRaw[b] = s / (2 * 255 * (hi - lo + 1));
    }
    const mel = new Uint8Array(MEL);
    for (let b = 0; b < MEL; b++) mel[b] = Math.round(255 * this.melNorm.apply(b, melRaw[b]!));
    // chroma from bytes between 65 Hz and 2 kHz (energy per pitch class, normalised to the frame's max)
    const chroma = new Float32Array(12);
    for (let i = Math.max(1, Math.round((65 * 1024) / this.sampleRate)); i <= Math.min(511, Math.round((2000 * 1024) / this.sampleRate)); i++) {
      const f = (i * this.sampleRate) / 1024, v = (sp[0][i]! + sp[1][i]!) / 510;
      const pc = ((Math.round(12 * Math.log2(f / 440) + 69) % 12) + 12) % 12;
      chroma[pc] = chroma[pc]! + v * v;
    }
    const cmax = Math.max(1e-6, ...chroma);

    // envelopes
    let sq = 0;
    for (let i = 0; i < SAMPLES; i++) { const l = signed(frame.waveform[0][i]!), r = signed(frame.waveform[1][i]!); sq += (l * l + r * r) / 2; }
    const band = (a: number, b: number) => { let s = 0; for (let k = a; k <= b; k++) s += melRaw[k]!; return s / (b - a + 1); };
    const lowB = this.bandOf(250), midB = this.bandOf(2000), vHi = this.bandOf(3000), vLo = this.bandOf(300), hatB = this.bandOf(6000), snLo = this.bandOf(1500), snHi = this.bandOf(5000);
    const raw = [Math.sqrt(sq / SAMPLES), band(0, lowB), band(lowB + 1, midB), band(midB + 1, MEL - 1)];
    const rms = this.envNorm.apply(0, raw[0]!), low = this.envNorm.apply(1, raw[1]!), mid = this.envNorm.apply(2, raw[2]!), high = this.envNorm.apply(3, raw[3]!);
    const vocal = this.envNorm.apply(4, band(vLo, vHi));
    // band flux (positive differences of the raw mel) for drums and the snare / hat onsets
    const flux = (a: number, b: number) => { let s = 0; for (let k = a; k <= b; k++) s += Math.max(0, melRaw[k]! - this.prevMel[k]!); return s / (b - a + 1); };
    const fLow = flux(0, lowB), fSn = flux(snLo, snHi), fHat = flux(hatB, MEL - 1);
    const drums = this.envNorm.apply(5, fLow + fSn + fHat);
    this.prevMel.set(melRaw);
    const values: Record<string, number> = { rms, low, mid, high, vocal, drums, bass: low, other: mid };

    // write frames (a gap of up to 10 frames since the last push is filled with this frame)
    const from = this.lastFrame >= 0 && fi > this.lastFrame && fi - this.lastFrame <= 10 ? this.lastFrame + 1 : fi;
    for (let f = Math.max(0, from); f <= fi; f++) {
      for (const k in values) this.feat[k]![f] = values[k]!;
      this.spec.set(mel, f * S);
      for (let c = 0; c < 12; c++) this.spec[f * S + MEL + c] = Math.round((255 * chroma[c]!) / cmax);
    }
    this.lastFrame = fi;

    // waveform: the 576 samples end at t, resampled to LIVE_WAVE_RATE
    const dur = SAMPLES / this.sampleRate, wn = this.wave.length >> 1;
    const rt = t - this.origin; // window-relative time of the frame's end
    const w0 = Math.max(0, Math.ceil((rt - dur) * LIVE_WAVE_RATE)), w1 = Math.min(wn - 1, Math.floor(rt * LIVE_WAVE_RATE));
    for (let s = w0; s <= w1; s++) {
      const x = Math.min(SAMPLES - 1, Math.max(0, (s / LIVE_WAVE_RATE - (rt - dur)) * this.sampleRate)), i = Math.floor(x), fr = x - i, j = Math.min(SAMPLES - 1, i + 1);
      this.wave[2 * s] = signed(frame.waveform[0][i]!) * (1 - fr) + signed(frame.waveform[0][j]!) * fr;
      this.wave[2 * s + 1] = signed(frame.waveform[1][i]!) * (1 - fr) + signed(frame.waveform[1][j]!) * fr;
    }

    // onsets: kicks from AVS's beat detector, snares and hats from band flux above its running mean
    const on = (kind: 'kick' | 'snare' | 'hat', s: number, gap: number) => {
      if (t - this.lastOnset[kind] < gap) return;
      this.lastOnset[kind] = t;
      this.onsets[kind]!.splice(this.predFrom[kind]++, 0, [t, clamp01(s)]);
    };
    if (frame.beat) on('kick', frame.beatLevel / (SAMPLES * 64), 0.1);
    const fl = [fSn, fHat];
    (['snare', 'hat'] as const).forEach((kind, k) => {
      const v = fl[k]!, m = this.fluxMean[k + 1]!;
      if (v > 2.2 * m && v > 0.015) on(kind, v / (4 * m), kind === 'hat' ? 0.06 : 0.12);
      this.fluxMean[k + 1] = m * 0.97 + v * 0.03;
    });

    this.revision++;
    const d = this.dirty;
    const f0 = Math.max(0, from);
    this.dirty = d ? { f0: Math.min(d.f0, f0), f1: Math.max(d.f1, fi), w0: Math.min(d.w0, w0), w1: Math.max(d.w1, w1) } : { f0, f1: fi, w0, w1 };
  }

  private bandOf(hz: number): number {
    const m0 = hz2mel(FMIN), m1 = hz2mel(Math.min(FMAX, this.sampleRate / 2));
    return Math.max(0, Math.min(MEL - 1, Math.floor(((hz2mel(hz) - m0) / (m1 - m0)) * MEL)));
  }
}

/** Duck-typed test (the engine does not import this module). */
export function isLive(a: AudioData): a is LiveAudioData {
  return (a as Partial<LiveAudioData>).live === true;
}
