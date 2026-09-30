// Streaming, chunk-exact frame stage of the song-map scanner.
//
// Every stored value (100 fps envelopes, mel frames, chroma, bass pitch, band-onset candidates,
// the 11025 Hz waveform) is a function of a bounded PCM window around its own timestamp. A region
// therefore reproduces a continuous pass exactly once its pre-roll has flushed filter state, and
// regions that partition the track never emit the same frame or onset twice. Stateful IIR
// filters restart per region; with REGION_CONTEXT_SECONDS of pre-roll their state has converged.
import { Butter4, GrowF32, GrowU8, RealFft, SincTable, firLowpass, hann, melBank, type MelBank } from './dsp.ts';

export const FPS = 100;
export const BIN_RATE = 400;
export const MEL_BANDS = 64;
export const MEL_FMIN = 30;
export const MEL_FMAX = 16000;
export const CHROMA_BINS = 12;
/** Waveform, chroma and low-band path rate. */
export const LOW_RATE = 11025;
export const PITCH_RATE = LOW_RATE / 4;
/** Pre-roll and post-roll fed around every region core. */
export const REGION_CONTEXT_SECONDS = 2;
/** dB quantisation of stored mel frames: q = round((dB + 120) * 2). */
export const MEL_DB_FLOOR = -120;

const BIN_RING = 1024;
const ONSET_LOOKAHEAD = 200; // bins (0.5 s) of look-ahead for the median floor
const PITCH_WINDOW = 256;
const PITCH_TAU_MIN = 9;   // ~306 Hz
const PITCH_TAU_MAX = 92;  // ~30 Hz
const DECIM_HALF = 32;
const HIST_SLOTS = 320;    // 0.5 dB slots from -140 dB

export type BandOnsetKind = 'kick' | 'snare' | 'hat';
/** Band-onset candidate: time, peak dB, and a kind-specific measure (snare tail dB, kick decay dB). */
export interface OnsetCandidate { readonly t: number; readonly db: number; readonly extra: number }

interface BandRule { readonly relDb: number; readonly gapBins: number }
const BAND_RULES: Record<BandOnsetKind, BandRule> = {
  kick: { relDb: 6, gapBins: 60 },
  snare: { relDb: 10, gapBins: 24 },
  hat: { relDb: 9, gapBins: 24 },
};
/** binVals channel behind each binDb slot: kick band, snare band, hat band, snare tail band, mid band, bass-harmonic (400-800 Hz) band. */
const DB_CHANNELS = [7, 2, 4, 3, 6, 8] as const;
const BAND_KINDS: readonly BandOnsetKind[] = ['kick', 'snare', 'hat'];

/** Compact per-track feature storage. Only this survives a region; PCM never does. */
export class FeatureStore {
  readonly sampleRate: number;
  readonly totalSamples: number | null;
  readonly frameCount: number | null;
  readonly fftSize: number;
  readonly bank: MelBank;
  readonly maxWaveFrames: number;
  /** bit 1: mel frame, bit 2: envelope frame. */
  readonly have: GrowU8;
  readonly rms: GrowF32; readonly low: GrowF32; readonly mid: GrowF32; readonly high: GrowF32;
  readonly mel: GrowU8;
  readonly pitchHz: GrowF32; readonly pitchAper: GrowF32; readonly pitchHave: GrowU8;
  readonly chroma: GrowU8; readonly chromaHave: GrowU8;
  wave: Float32Array;
  waveHave: GrowU8;
  readonly onsets: Record<BandOnsetKind, OnsetCandidate[]> = { kick: [], snare: [], hat: [] };
  /** Highest frame index written + 1. */
  extent = 0;

  constructor(sampleRate: number, totalSamples: number | null, maxWaveSeconds: number) {
    if (!Number.isInteger(sampleRate) || sampleRate < 8000 || sampleRate > 384000) throw new RangeError('Unsupported sample rate');
    if (totalSamples !== null && (!Number.isSafeInteger(totalSamples) || totalSamples < 1)) throw new RangeError('Invalid sample count');
    this.sampleRate = sampleRate;
    this.totalSamples = totalSamples;
    this.frameCount = totalSamples === null ? null : Math.ceil(totalSamples * FPS / sampleRate);
    this.fftSize = sampleRate > 24000 ? 2048 : sampleRate > 12000 ? 1024 : 512;
    this.bank = melBank(MEL_BANDS, MEL_FMIN, MEL_FMAX, this.fftSize, sampleRate);
    const frames = this.frameCount ?? FPS * 600;
    this.have = new GrowU8(frames);
    this.rms = new GrowF32(frames); this.low = new GrowF32(frames); this.mid = new GrowF32(frames); this.high = new GrowF32(frames);
    this.mel = new GrowU8(frames * MEL_BANDS);
    this.pitchHz = new GrowF32(frames); this.pitchAper = new GrowF32(frames); this.pitchHave = new GrowU8(frames);
    this.chroma = new GrowU8(Math.ceil(frames / 4) * CHROMA_BINS); this.chromaHave = new GrowU8(Math.ceil(frames / 4));
    const waveLimit = Math.floor(Math.max(0, maxWaveSeconds) * LOW_RATE);
    const trackWave = totalSamples === null ? waveLimit : Math.min(waveLimit, Math.ceil(totalSamples * LOW_RATE / sampleRate));
    this.maxWaveFrames = trackWave;
    this.wave = new Float32Array(totalSamples === null ? Math.min(trackWave, LOW_RATE * 60) * 2 : trackWave * 2);
    this.waveHave = new GrowU8(Math.ceil(trackWave / LOW_RATE) + 1);
  }

  frameCenter(frame: number): number { return Math.floor(frame * this.sampleRate / FPS); }

  ensureWave(frames: number): void {
    const need = Math.min(frames, this.maxWaveFrames) * 2;
    if (need <= this.wave.length) return;
    const next = new Float32Array(Math.min(this.maxWaveFrames * 2, Math.max(need, Math.ceil(this.wave.length * 1.5))));
    next.set(this.wave); this.wave = next;
  }

  /** Bytes held by typed arrays (exact accounting for budgets and benchmarks). */
  bytes(): number {
    return this.have.data.byteLength + this.rms.data.byteLength * 4 + this.mel.data.byteLength
      + this.pitchHz.data.byteLength * 2 + this.pitchHave.data.byteLength + this.chroma.data.byteLength
      + this.chromaHave.data.byteLength + this.wave.byteLength + this.waveHave.data.byteLength
      + (this.onsets.kick.length + this.onsets.snare.length + this.onsets.hat.length) * 40;
  }
}

/**
 * Analyses one contiguous PCM run [feedStart, feedEnd) and stores the items whose timestamps fall
 * in [coreStart, coreEnd). Feed with push(); call finish() once. The last region of a track is
 * finished with atTrackEnd=true, which zero-pads exactly like a continuous pass over the whole file.
 */
export class RegionScanner {
  private readonly s: FeatureStore;
  private readonly sr: number;
  private readonly coreStart: number;
  private readonly coreEnd: number;
  private pos: number;
  // Full-rate rings.
  private readonly ringMask: number;
  private readonly ringL: Float64Array; private readonly ringR: Float64Array; private readonly ringM: Float64Array;
  private readonly lp5000: Butter4; private readonly hp1500: Butter4; private readonly hp500: Butter4;
  private readonly hp4000: Butter4; private readonly hp7000: Butter4;
  // Full-rate bins.
  private binFull: number; private binFullEnd: number;
  private accM = 0; private accHigh = 0; private accSnare = 0; private accTail = 0; private accHat = 0; private accCount = 0;
  // 11025 path.
  private readonly sinc: SincTable;
  private next11: number;
  private readonly ring11: Float64Array; private readonly ring11Mask: number;
  private readonly lp150: Butter4; private readonly hp150: Butter4; private readonly lp2000: Butter4; private readonly lp120: Butter4;
  private readonly hpHarm: Butter4; private readonly lpHarm: Butter4;
  private bin11: number; private bin11End: number;
  private accLow = 0; private accMid = 0; private accKick = 0; private accHarm = 0; private acc11Count = 0;
  // Combined bins.
  private readonly binVals = new Float64Array(BIN_RING * 9);
  private readonly binDb = new Float64Array(BIN_RING * 6);
  private binDone: number;
  private readonly hist = new Int32Array(3 * HIST_SLOTS);
  private readonly histCount = new Int32Array(3);
  // Frames.
  private nextFrame: number;
  private nextEnvFrame: number;
  private readonly fft: RealFft; private readonly window: Float64Array; private readonly frameBuf: Float64Array;
  // Chroma.
  private nextChroma: number;
  private readonly chromaFft = new RealFft(2048);
  private readonly chromaWindow = hann(2048);
  private readonly chromaBuf = new Float64Array(2048);
  private readonly chromaMap: { bin: number; pc: number; w: number }[] = [];
  private readonly chromaAcc = new Float64Array(CHROMA_BINS);
  // Pitch.
  private readonly decim = firLowpass(500, LOW_RATE, DECIM_HALF);
  private nextDecim: number;
  private readonly ringP = new Float64Array(2048);
  private nextPitch: number;
  private readonly yinDiff = new Float64Array(PITCH_TAU_MAX + 2);
  private finished = false;

  constructor(store: FeatureStore, feedStart: number, coreStart: number, coreEnd: number) {
    if (!Number.isSafeInteger(feedStart) || feedStart < 0 || !(coreStart >= feedStart) || !(coreEnd > coreStart)) throw new RangeError('Invalid region');
    this.s = store; this.sr = store.sampleRate;
    this.coreStart = coreStart; this.coreEnd = coreEnd;
    this.pos = feedStart;
    const sr = this.sr, N = store.fftSize;
    let ring = 8192; while (ring < 4 * N + 4 * Math.ceil(16 * sr / LOW_RATE)) ring <<= 1;
    this.ringMask = ring - 1;
    this.ringL = new Float64Array(ring); this.ringR = new Float64Array(ring); this.ringM = new Float64Array(ring);
    this.lp5000 = new Butter4('low', 5000, sr); this.hp1500 = new Butter4('high', 1500, sr); this.hp500 = new Butter4('high', 500, sr);
    this.hp4000 = new Butter4('high', 4000, sr); this.hp7000 = new Butter4('high', 7000, sr);
    this.binFull = Math.floor(feedStart * BIN_RATE / sr); this.binFullEnd = this.binBoundary(this.binFull + 1, sr);
    this.sinc = new SincTable(sr, LOW_RATE);
    this.next11 = Math.ceil(feedStart * LOW_RATE / sr);
    this.ring11 = new Float64Array(8192); this.ring11Mask = 8191;
    this.lp150 = new Butter4('low', 150, LOW_RATE); this.hp150 = new Butter4('high', 150, LOW_RATE);
    this.lp2000 = new Butter4('low', 2000, LOW_RATE); this.lp120 = new Butter4('low', 120, LOW_RATE);
    this.hpHarm = new Butter4('high', 400, LOW_RATE); this.lpHarm = new Butter4('low', 800, LOW_RATE);
    this.bin11 = Math.floor(this.next11 * BIN_RATE / LOW_RATE); this.bin11End = this.binBoundary(this.bin11 + 1, LOW_RATE);
    this.binDone = Math.max(this.binFull, this.bin11);
    this.fft = new RealFft(N); this.window = hann(N); this.frameBuf = new Float64Array(N);
    const firstFrame = Math.max(0, Math.ceil(coreStart * FPS / sr) - 1);
    this.nextFrame = firstFrame; this.nextEnvFrame = firstFrame;
    this.nextChroma = firstFrame - (firstFrame % 4);
    this.nextDecim = Math.ceil(this.next11 / 4);
    this.nextPitch = firstFrame - (firstFrame % 2);
    // Chroma filterbank on the 2048-point low-rate FFT (librosa-style octave weighting).
    const df = LOW_RATE / 2048;
    for (let bin = 1; bin <= 1024; bin++) {
      const f = bin * df;
      if (f < 55 || f > 4200) continue;
      const pcf = ((69 + 12 * Math.log2(f / 440)) % 12 + 12) % 12;
      const oct = Math.exp(-.5 * ((Math.log2(f / 27.5) - 5) / 2) ** 2);
      for (let pc = 0; pc < 12; pc++) {
        let d = Math.abs(pcf - pc); d = Math.min(d, 12 - d);
        if (d < 1) this.chromaMap.push({ bin, pc, w: oct * Math.cos(Math.PI * d / 2) ** 2 });
      }
    }
  }

  private binBoundary(k: number, rate: number): number { return Math.floor(k * rate / BIN_RATE); }
  private inCore(sample: number): boolean { return sample >= this.coreStart && sample < this.coreEnd; }

  /** Contiguous stereo samples starting at the current position. */
  push(left: Float32Array, right: Float32Array): void {
    if (this.finished) throw new Error('Region already finished');
    const n = Math.min(left.length, right.length);
    for (let i = 0; i < n; i++) {
      const l = left[i]!, r = right[i]!;
      this.sample(Number.isFinite(l) ? l : 0, Number.isFinite(r) ? r : 0);
    }
  }

  /** Flushes the region. At the track end, zero-pads so trailing frames and onsets complete. */
  finish(atTrackEnd: boolean): void {
    if (this.finished) return;
    if (atTrackEnd) {
      const pad = Math.ceil(1.5 * this.sr) + this.s.fftSize;
      for (let i = 0; i < pad; i++) this.sample(0, 0);
    }
    this.finished = true;
  }

  get position(): number { return this.pos; }

  private sample(l: number, r: number): void {
    const s = this.pos, mask = this.ringMask, m = (l + r) * .5;
    this.ringL[s & mask] = l; this.ringR[s & mask] = r; this.ringM[s & mask] = m;
    const lp = this.lp5000.push(m);
    const snare = this.hp1500.push(lp), tail = this.hp500.push(lp);
    const high = this.hp4000.push(m), hat = this.hp7000.push(m);
    this.accM += m * m; this.accHigh += high * high; this.accSnare += snare * snare; this.accTail += tail * tail; this.accHat += hat * hat; this.accCount++;
    this.pos = s + 1;
    if (this.pos >= this.binFullEnd) this.closeFullBin();
    // Resample to the low-rate path when the kernel's look-ahead is available.
    const sinc = this.sinc, half = sinc.half, ratio = this.sr / LOW_RATE;
    while (true) {
      const p = this.next11 * ratio, base = Math.floor(p);
      if (base + half >= this.pos) break;
      const kernel = sinc.kernels[Math.min(255, Math.floor((p - base) * 256))]!;
      let ol = 0, or = 0;
      for (let k = -half; k <= half; k++) {
        const idx = (base + k) & mask, w = kernel[k + half]!;
        ol += this.ringL[idx]! * w; or += this.ringR[idx]! * w;
      }
      this.lowSample(this.next11, ol, or);
      this.next11++;
    }
    // Main FFT frames.
    const N = this.s.fftSize;
    while (this.s.frameCenter(this.nextFrame) + N / 2 <= this.pos) this.melFrame(this.nextFrame++);
  }

  private closeFullBin(): void {
    const k = this.binFull, o = (k & (BIN_RING - 1)) * 9, c = Math.max(1, this.accCount);
    this.binVals[o] = this.accM / c; this.binVals[o + 1] = this.accHigh / c; this.binVals[o + 2] = this.accSnare / c;
    this.binVals[o + 3] = this.accTail / c; this.binVals[o + 4] = this.accHat / c;
    this.accM = this.accHigh = this.accSnare = this.accTail = this.accHat = 0; this.accCount = 0;
    this.binFull = k + 1; this.binFullEnd = this.binBoundary(k + 2, this.sr);
    this.combineBins();
  }

  private lowSample(j: number, l: number, r: number): void {
    const m = (l + r) * .5;
    this.ring11[j & this.ring11Mask] = m;
    const store = this.s;
    if (j < store.maxWaveFrames && this.inCore(Math.floor(j * this.sr / LOW_RATE))) {
      store.ensureWave(j + 1);
      store.wave[2 * j] = l; store.wave[2 * j + 1] = r;
      const block = Math.floor(j / LOW_RATE); store.waveHave.ensure(block + 1); store.waveHave.data[block] = 1;
    }
    const low = this.lp150.push(m), mid = this.lp2000.push(this.hp150.push(m)), kick = this.lp120.push(m), harm = this.lpHarm.push(this.hpHarm.push(m));
    this.accLow += low * low; this.accMid += mid * mid; this.accKick += kick * kick; this.accHarm += harm * harm; this.acc11Count++;
    if (j + 1 >= this.bin11End) {
      const k = this.bin11, o = (k & (BIN_RING - 1)) * 9, c = Math.max(1, this.acc11Count);
      this.binVals[o + 5] = this.accLow / c; this.binVals[o + 6] = this.accMid / c; this.binVals[o + 7] = this.accKick / c; this.binVals[o + 8] = this.accHarm / c;
      this.accLow = this.accMid = this.accKick = this.accHarm = 0; this.acc11Count = 0;
      this.bin11 = k + 1; this.bin11End = this.binBoundary(k + 2, LOW_RATE);
      this.combineBins();
    }
    while (Math.floor(this.nextChroma * LOW_RATE / FPS) + 1024 <= j + 1) { this.chromaFrame(this.nextChroma); this.nextChroma += 4; }
    while (4 * this.nextDecim + DECIM_HALF <= j) {
      const d = this.nextDecim, taps = this.decim; let acc = 0;
      for (let i = -DECIM_HALF; i <= DECIM_HALF; i++) acc += taps[i + DECIM_HALF]! * this.ring11[(4 * d + i) & this.ring11Mask]!;
      this.ringP[d & 2047] = acc;
      this.nextDecim = d + 1;
      while (Math.floor(this.nextPitch * PITCH_RATE / FPS) - PITCH_WINDOW / 2 + PITCH_WINDOW + PITCH_TAU_MAX <= d + 1) {
        this.pitchFrame(this.nextPitch); this.nextPitch += 2;
      }
    }
  }

  /** Bins closed in both rate domains feed the envelope and onset stages. */
  private combineBins(): void {
    const ready = Math.min(this.binFull, this.bin11);
    while (this.binDone < ready) {
      const k = this.binDone++;
      // Envelope frames: bins [4f-9, 4f+9).
      while (4 * this.nextEnvFrame + 8 <= k) this.envFrame(this.nextEnvFrame++);
      // Band log energies centred on boundary kb = k - 1 (10 ms: bins kb-2..kb+1).
      const kb = k - 1;
      const o = (kb & (BIN_RING - 1)) * 6;
      for (let ch = 0; ch < 6; ch++) {
        const channel = DB_CHANNELS[ch]!;
        let e = 0;
        for (let q = kb - 2; q <= kb + 1; q++) e += this.binVals[(q & (BIN_RING - 1)) * 9 + channel]!;
        this.binDb[o + ch] = 10 * Math.log10(e / 4 + 1e-10);
      }
      for (let band = 0; band < 3; band++) {
        this.histAdd(band, this.dbAt(kb, band), 1);
        if (this.histCount[band]! > 2 * ONSET_LOOKAHEAD + 1) this.histAdd(band, this.dbAt(kb - 2 * ONSET_LOOKAHEAD - 1, band), -1);
      }
      this.onsetCandidates(kb - ONSET_LOOKAHEAD);
    }
  }

  private dbAt(k: number, ch: number): number { return this.binDb[(k & (BIN_RING - 1)) * 6 + ch]!; }
  private histSlot(db: number): number { return Math.max(0, Math.min(HIST_SLOTS - 1, Math.round((db + 140) * 2))); }
  private histAdd(band: number, db: number, delta: number): void {
    this.hist[band * HIST_SLOTS + this.histSlot(db)]! += delta; this.histCount[band]! += delta;
  }
  private histMedian(band: number): number {
    const target = this.histCount[band]! / 2; let acc = 0;
    for (let i = 0; i < HIST_SLOTS; i++) { acc += this.hist[band * HIST_SLOTS + i]!; if (acc >= target) return i / 2 - 140; }
    return -140;
  }

  /** Upstream band_onsets: 20 ms rise >= relDb, local maximum, steepest-rise time, 3 dB above the 1 s median floor. */
  private onsetCandidates(k: number): void {
    const lag = 8;
    for (let band = 0; band < 3; band++) {
      const kind = BAND_KINDS[band]!, rule = BAND_RULES[kind];
      const rise = this.dbAt(k, band) - this.dbAt(k - lag, band);
      if (rise < rule.relDb) continue;
      let isMax = true;
      for (let q = k - rule.gapBins; q <= k + rule.gapBins && isMax; q++) {
        if (q === k) continue;
        const other = this.dbAt(q, band) - this.dbAt(q - lag, band);
        if (other > rise || (other === rise && q < k)) isMax = false;
      }
      if (!isMax) continue;
      let peak = -Infinity;
      for (let q = k; q <= k + 12; q++) peak = Math.max(peak, this.dbAt(q, band));
      if (peak < this.histMedian(band) + 3) continue;
      // Steepest rise inside the lag window (3-tap smoothed first difference).
      let best = k, bestD = -Infinity;
      for (let q = k - lag; q <= k; q++) {
        const d = (this.dbAt(q + 1, band) - this.dbAt(q - 2, band)) / 3;
        if (d > bestD) { bestD = d; best = q; }
      }
      const sample = Math.floor(best * this.sr / BIN_RATE);
      if (!this.inCore(sample)) continue;
      let extra = 0;
      if (kind === 'snare') {
        let e = 0;
        for (let q = best + 16; q < best + 48; q++) e += this.binVals[(q & (BIN_RING - 1)) * 9 + 3]!;
        extra = 10 * Math.log10(e / 32 + 1e-10);
      } else if (kind === 'kick') {
        // A bass note keeps its 400-800 Hz harmonics up after the attack and sustains below 120 Hz;
        // a kick's sweep leaves the harmonic band within ~40 ms and decays faster below 120 Hz.
        const sustainH = this.dbAt(best + 16, 5) - this.dbAt(best - 8, 5);
        const decay = this.dbAt(best + 16, 0) - this.dbAt(best + 60, 0), decayH = this.dbAt(best + 16, 5) - this.dbAt(best + 60, 5);
        if (sustainH >= 6 && decay - decayH < 4) continue;
        extra = peak - this.dbAt(best + 60, 0);
      }
      this.s.onsets[kind].push({ t: best / BIN_RATE, db: peak, extra });
    }
  }

  private envFrame(f: number): void {
    const s = this.s, center = s.frameCenter(f);
    if (!this.inCore(center) || (s.frameCount !== null && f >= s.frameCount)) return;
    let m = 0, lo = 0, mi = 0, hi = 0;
    for (let q = 4 * f - 9; q < 4 * f + 9; q++) {
      const o = (q & (BIN_RING - 1)) * 9;
      m += this.binVals[o]!; hi += this.binVals[o + 1]!; lo += this.binVals[o + 5]!; mi += this.binVals[o + 6]!;
    }
    s.rms.set(f, Math.sqrt(m / 18)); s.low.set(f, Math.sqrt(lo / 18)); s.mid.set(f, Math.sqrt(mi / 18)); s.high.set(f, Math.sqrt(hi / 18));
    s.have.ensure(f + 1); s.have.data[f]! |= 2;
    if (f + 1 > s.extent) s.extent = f + 1;
  }

  private melFrame(f: number): void {
    const s = this.s, center = s.frameCenter(f);
    if (!this.inCore(center) || (s.frameCount !== null && f >= s.frameCount)) return;
    const N = s.fftSize, start = center - N / 2, mask = this.ringMask, buf = this.frameBuf, win = this.window;
    for (let i = 0; i < N; i++) { const idx = start + i; buf[i] = idx < 0 ? 0 : this.ringM[idx & mask]! * win[i]!; }
    const power = this.fft.power(buf);
    const norm = 4 / (N * N); // Hann coherent gain 0.5: a full-scale sine peaks near 0 dB
    const bank = s.bank, df = s.sampleRate / N;
    s.mel.ensure((f + 1) * 64);
    const out = s.mel.data, o = f * 64;
    for (let b = 0; b < 64; b++) {
      const w = bank.weights[b]!, first = bank.first[b]!;
      let e = 0;
      for (let k = 0; k < w.length; k++) e += w[k]! * power[first + k]!;
      const db = 10 * Math.log10(e * norm * df + 1e-12);
      out[o + b] = Math.max(0, Math.min(255, Math.round((db - MEL_DB_FLOOR) * 2)));
    }
    s.have.ensure(f + 1); s.have.data[f]! |= 1;
    if (f + 1 > s.extent) s.extent = f + 1;
  }

  private chromaFrame(f: number): void {
    const s = this.s;
    if (f < 0 || !this.inCore(s.frameCenter(f)) || (s.frameCount !== null && f >= s.frameCount)) return;
    const center = Math.floor(f * LOW_RATE / FPS), buf = this.chromaBuf, win = this.chromaWindow;
    for (let i = 0; i < 2048; i++) { const idx = center - 1024 + i; buf[i] = idx < 0 ? 0 : this.ring11[idx & this.ring11Mask]! * win[i]!; }
    const power = this.chromaFft.power(buf), acc = this.chromaAcc;
    acc.fill(0);
    for (const { bin, pc, w } of this.chromaMap) acc[pc]! += w * power[bin]!;
    let max = 0; for (let i = 0; i < 12; i++) max = Math.max(max, acc[i]!);
    const slot = f >> 2;
    s.chroma.ensure((slot + 1) * 12); s.chromaHave.ensure(slot + 1);
    for (let i = 0; i < 12; i++) s.chroma.data[slot * 12 + i] = max > 1e-12 ? Math.round(acc[i]! / max * 255) : 0;
    s.chromaHave.data[slot] = 1;
  }

  /** YIN on the 2756 Hz bass path: f0 in Hz and aperiodicity (CMNDF minimum). */
  private pitchFrame(f: number): void {
    const s = this.s;
    if (f < 0 || !this.inCore(s.frameCenter(f)) || (s.frameCount !== null && f >= s.frameCount)) return;
    const start = Math.floor(f * PITCH_RATE / FPS) - PITCH_WINDOW / 2, ring = this.ringP, d = this.yinDiff;
    let energy = 0;
    for (let i = 0; i < PITCH_WINDOW; i++) { const v = ring[(start + i) & 2047]!; energy += v * v; }
    let hz = 0, aper = 1;
    if (energy > 1e-9) {
      d[0] = 1;
      let running = 0;
      for (let tau = 1; tau <= PITCH_TAU_MAX; tau++) {
        let sum = 0;
        for (let i = 0; i < PITCH_WINDOW; i++) { const x = ring[(start + i) & 2047]! - ring[(start + i + tau) & 2047]!; sum += x * x; }
        running += sum;
        d[tau] = running > 0 ? sum * tau / running : 1;
      }
      let tau = -1;
      for (let t = PITCH_TAU_MIN; t <= PITCH_TAU_MAX; t++) {
        if (d[t]! < .15) { while (t + 1 <= PITCH_TAU_MAX && d[t + 1]! < d[t]!) t++; tau = t; break; }
      }
      if (tau < 0) { let best = PITCH_TAU_MIN; for (let t = PITCH_TAU_MIN; t <= PITCH_TAU_MAX; t++) if (d[t]! < d[best]!) best = t; tau = best; }
      let refined = tau;
      if (tau > PITCH_TAU_MIN && tau < PITCH_TAU_MAX) {
        const a = d[tau - 1]!, b = d[tau]!, c = d[tau + 1]!, den = a - 2 * b + c;
        if (Math.abs(den) > 1e-12) refined = tau + Math.max(-.5, Math.min(.5, .5 * (a - c) / den));
      }
      aper = d[tau]!; hz = PITCH_RATE / refined;
    }
    s.pitchHz.set(f, hz); s.pitchAper.set(f, aper);
    s.pitchHave.ensure(f + 1); s.pitchHave.data[f] = 1;
  }
}
