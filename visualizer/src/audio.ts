// Audio analysis (plan §6).
//
// The analysis BANK, not one analyser — you cannot get time and frequency
// resolution from a single FFT:
//
//   512   ~10 ms   onsets, transients            (unsmoothed)
//   2048  ~43 ms   the visual spectrum           (smoothed, stereo)
//   8192  ~170 ms  bass pitch, chroma, key       (mono, for later)
//
// Stereo is a first-class requirement, not a nicety: Lissajous needs L and R
// separately, and per-BAND pan is what lets an effect fire at the screen-x of
// the frequency that triggered it.
//
// Detection lessons carried from Pulse, each of which cost real time there:
//   - flux, not band energy — energy fires on anything loud, so it fires
//     continuously under a sustained bassline and never through a breakdown
//   - a SECOND, unsmoothed analyser — smoothing is precisely the operation
//     that erases the transient you are looking for
//   - threshold mean + k·stddev over a TIME window, never a frame count

import {
  AdaptiveMultibandDetector,
  ONSET_CLASS_NAMES,
  PERCEPTUAL_BAND_COUNT,
} from './audio-features.ts';

export const BANDS = {
  sub:  [20, 80],
  low:  [80, 250],
  mid:  [250, 2000],
  high: [2000, 8000],
  air:  [8000, 20000],
} as const;

export type BandName = keyof typeof BANDS;
export const BAND_NAMES = Object.keys(BANDS) as BandName[];

export const WAVE_N = 1024;   // waveform samples exposed to shaders
export const SPEC_N = 256;    // spectrum bins exposed to shaders
export const SPECTROGRAM_ROWS = 256;

/** How an onset was classified. Two extra numbers buy a lot of expressiveness. */
export type OnsetClass = 'kick' | 'snare' | 'hat' | 'tonal';

export interface Onset {
  time: number;
  strength: number;
  klass: OnsetClass;
  /** Broadband pan at trigger, -1..1. */
  pan: number;
}

export class AudioEngine {
  ctx: AudioContext | null = null;

  private input: GainNode | null = null;
  private monitor: GainNode | null = null;
  private splitter: ChannelSplitterNode | null = null;

  private anL: AnalyserNode | null = null;    // smoothed, left
  private anR: AnalyserNode | null = null;    // smoothed, right
  private detector: AnalyserNode | null = null; // unsmoothed, mono, fast
  private coarse: AnalyserNode | null = null;   // 8192, mono — chroma later

  private source: AudioBufferSourceNode | null = null;
  private buffer: AudioBuffer | null = null;

  // --- exposed to the GPU ------------------------------------------------
  /** Interleaved L,R time-domain, WAVE_N frames. */
  readonly waveform = new Float32Array(WAVE_N * 2);
  /** Interleaved L,R magnitudes 0..1, SPEC_N bins. */
  readonly spectrum = new Float32Array(SPEC_N * 2);
  /** Per-bin pan, -1..1. Beyond broadband pan — this is what places effects. */
  readonly bandPan = new Float32Array(SPEC_N);
  /** Scrolling magnitude history, SPEC_N x SPECTROGRAM_ROWS, ring-written. */
  readonly spectrogram = new Float32Array(SPEC_N * SPECTROGRAM_ROWS);
  spectrogramRow = 0;
  /** Peak-hold with fall, per bin. */
  readonly peaks = new Float32Array(SPEC_N);
  /** Low-to-high perceptual-band energy envelopes. Stable live buffer. */
  readonly perceptualBands = new Float32Array(PERCEPTUAL_BAND_COUNT);
  /** Perceptual-band adaptively whitened novelty envelopes. Stable live buffer. */
  readonly perceptualFlux = new Float32Array(PERCEPTUAL_BAND_COUNT);

  bands: Record<BandName, number> = { sub: 0, low: 0, mid: 0, high: 0, air: 0 };
  level = 0;
  beat = 0;
  /** Broadband pan, -1..1. */
  pan = 0;
  /** ‖S‖/(‖M‖+‖S‖) — spikes when wide material enters. Feeds tension later. */
  width = 0;
  /** peak/rms. Low = compressed; a build compresses. */
  crest = 1;
  /** Spectral centroid, normalised. */
  centroid = 0;
  /** Spectral flatness — tonal (0) to noisy (1). */
  flatness = 0;

  onOnset: ((o: Onset) => void) | null = null;

  // Exposed for the debug overlay — a detector you cannot see the internals of
  // is a detector you tune by superstition.
  debugFlux = 0;
  debugThresh = 0;

  // --- internals ---------------------------------------------------------
  private freqL = new Uint8Array(0);
  private freqR = new Uint8Array(0);
  private timeL = new Float32Array(0);
  private timeR = new Float32Array(0);
  private detSpec = new Uint8Array(0);
  private multiband: AdaptiveMultibandDetector | null = null;

  /** Short white-noise burst, reused for test-signal hats. */
  private noiseBuf: AudioBuffer | null = null;
  private startedAt = 0;
  /** Stable transport position while the AudioContext is suspended. */
  private position = 0;
  private playing = false;
  private testBpm = 0;
  private nextClick = 0;
  private clickTimer: number | null = null;
  private readonly testSources = new Set<AudioScheduledSourceNode>();

  get isPlaying(): boolean { return this.playing; }
  get canTransport(): boolean { return this.buffer !== null || this.testBpm > 0; }
  get isPaused(): boolean { return this.canTransport && !this.playing; }
  get duration(): number { return this.buffer?.duration ?? 0; }

  /** Audio-clock seconds since playback began. The only clock (§4.6). */
  get currentTime(): number {
    if (!this.ctx || !this.playing) return this.position;
    return Math.max(0, this.ctx.currentTime - this.startedAt);
  }

  /** Real output latency, for scheduler compensation. Can change; read often. */
  get outputLatency(): number { return this.ctx?.outputLatency ?? 0; }

  /**
   * The node an external analyser should TAP.
   *
   * This is the pre-monitor input gain — everything played goes through it,
   * including the built-in test signal, and it sits before the stereo split so
   * a tap sees the same signal the analysers do. Exposed (rather than the
   * analysers) because `worklet-host.ts` needs a source to connect FROM, and
   * `null` until the first trusted gesture has created the context.
   */
  get tap(): AudioNode | null { return this.input; }

  private ensure(): AudioContext {
    if (this.ctx) return this.ctx;
    const ctx = new AudioContext({ latencyHint: 'interactive' });
    this.ctx = ctx;

    this.input = ctx.createGain();
    this.monitor = ctx.createGain();
    this.monitor.gain.value = 1;
    this.input.connect(this.monitor);
    this.monitor.connect(ctx.destination);

    // Stereo split. Everything per-channel hangs off this.
    this.splitter = ctx.createChannelSplitter(2);
    this.input.connect(this.splitter);

    this.anL = ctx.createAnalyser();
    this.anR = ctx.createAnalyser();
    for (const a of [this.anL, this.anR]) {
      a.fftSize = 2048;
      a.smoothingTimeConstant = 0.72;
    }
    this.splitter.connect(this.anL, 0);
    this.splitter.connect(this.anR, 1);

    this.detector = ctx.createAnalyser();
    this.detector.fftSize = 512;          // ~10 ms — transients
    this.detector.smoothingTimeConstant = 0;
    this.input.connect(this.detector);

    this.coarse = ctx.createAnalyser();
    this.coarse.fftSize = 8192;           // ~170 ms — pitch/chroma later
    this.coarse.smoothingTimeConstant = 0.5;
    this.input.connect(this.coarse);

    this.freqL = new Uint8Array(this.anL.frequencyBinCount);
    this.freqR = new Uint8Array(this.anR.frequencyBinCount);
    this.timeL = new Float32Array(this.anL.fftSize);
    this.timeR = new Float32Array(this.anR.fftSize);
    this.detSpec = new Uint8Array(this.detector.frequencyBinCount);
    this.multiband = new AdaptiveMultibandDetector(ctx.sampleRate, this.detector.frequencyBinCount, 240);
    return ctx;
  }

  async loadFile(file: File): Promise<void> {
    const ctx = this.ensure();
    await ctx.resume();
    this.buffer = await ctx.decodeAudioData(await file.arrayBuffer());
    this.testBpm = 0;
    this.play();
  }

  play(): void {
    if (!this.ctx || !this.buffer || !this.input) return;
    this.stop();
    this.startBufferAt(0);
    this.resetDetector();
  }

  private startBufferAt(position: number): void {
    if (!this.ctx || !this.buffer || !this.input) return;
    this.disconnectSource();
    const src = this.ctx.createBufferSource();
    src.buffer = this.buffer;
    src.loop = true;
    src.connect(this.input);
    this.position = Math.max(0, position);
    this.startedAt = this.ctx.currentTime - this.position;
    const offset = this.buffer.duration > 0 ? this.position % this.buffer.duration : 0;
    src.start(this.ctx.currentTime, offset);
    this.source = src;
    this.playing = true;
  }

  /** Suspend the audio clock without discarding the source or its exact phase. */
  async pause(): Promise<void> {
    if (!this.ctx || !this.playing) return;
    this.position = this.currentTime;
    this.playing = false;
    await this.ctx.suspend();
  }

  /** Resume the source frozen by `pause()`, or restart a retained file source. */
  async resume(): Promise<void> {
    if (!this.ctx || this.playing || !this.canTransport) return;
    if (!this.source && this.testBpm === 0) this.startBufferAt(this.position);
    await this.ctx.resume();
    this.startedAt = this.ctx.currentTime - this.position;
    this.playing = true;
  }

  /** Seek the active file/click transport while preserving its running state. */
  seek(seconds: number): void {
    if (!this.ctx || !this.canTransport) return;
    const wasPlaying = this.playing;
    const target = Number.isFinite(seconds) ? Math.max(0, seconds) : 0;
    this.position = target;
    this.startedAt = this.ctx.currentTime - target;
    if (this.testBpm > 0) {
      this.clearTestSources();
      if (this.clickTimer !== null) { clearTimeout(this.clickTimer); this.clickTimer = null; }
      this.nextClick = 0;
      this.scheduleClicks();
    } else {
      this.startBufferAt(target);
      this.playing = wasPlaying;
    }
    this.resetDetector();
  }

  /**
   * Synthetic click track. Exists so the clock and scheduler can be verified
   * without a file — with a known tempo, "did it lock correctly" becomes an
   * assertion rather than a vibe.
   */
  startTestSignal(bpm = 128): void {
    const ctx = this.ensure();
    void ctx.resume();
    this.stop();
    this.testBpm = bpm;
    this.position = 0;
    this.startedAt = ctx.currentTime;
    this.playing = true;
    this.resetDetector();
    this.scheduleClicks();
  }

  private scheduleClicks(): void {
    const ctx = this.ctx!;
    const period = 60 / this.testBpm;
    if (!this.nextClick) {
      const elapsed = Math.max(0, ctx.currentTime - this.startedAt);
      this.nextClick = this.startedAt + Math.ceil((elapsed + 0.01) / period) * period;
    }

    // Schedule ahead on the audio clock, top up on a coarse timer — the
    // standard Web Audio pattern, and the same shape as the visual scheduler.
    while (this.nextClick < ctx.currentTime + 0.5) {
      const t = this.nextClick;
      const beat = Math.round((t - this.startedAt) / period);
      // Alternate kick and hat so onset classification has something to do.
      const isHat = beat % 2 === 1;
      const env = ctx.createGain();
      const pan = ctx.createStereoPanner();
      pan.pan.value = isHat ? 0.6 : 0;    // hats off to one side, kick centred
      env.connect(pan); pan.connect(this.input!);

      if (isHat) {
        // A NOISE burst, not a square oscillator. Real hi-hats are noise, and
        // the classifier keys on spectral flatness — a tonal square gets
        // (correctly) classified as 'tonal', which made the test signal useless
        // for validating classification.
        const src = ctx.createBufferSource();
        src.buffer = this.noise(ctx);
        const hp = ctx.createBiquadFilter();
        hp.type = 'highpass';
        hp.frequency.value = 6000;
        env.gain.setValueAtTime(0.0001, t);
        env.gain.exponentialRampToValueAtTime(0.5, t + 0.002);
        env.gain.exponentialRampToValueAtTime(0.0001, t + 0.045);
        src.connect(hp); hp.connect(env);
        this.trackTestSource(src);
        src.start(t);
        src.stop(t + 0.06);
      } else {
        const osc = ctx.createOscillator();
        osc.frequency.setValueAtTime(180, t);
        osc.frequency.exponentialRampToValueAtTime(45, t + 0.09);
        env.gain.setValueAtTime(0.0001, t);
        env.gain.exponentialRampToValueAtTime(0.9, t + 0.004);
        env.gain.exponentialRampToValueAtTime(0.0001, t + 0.16);
        osc.connect(env);
        this.trackTestSource(osc);
        // start() MUST precede stop(): calling stop() first throws
        // InvalidStateError, which killed this loop on its first iteration and
        // left the whole graph silent while the clock ran on happily.
        osc.start(t);
        osc.stop(t + 0.2);
      }
      // NO SUSTAINED VOICE HERE, and that is deliberate — it was tried twice.
      //
      // The motivation was real: a purely percussive signal is silent between
      // transients, so sources reading instantaneous magnitude sit at zero
      // while peak-hold sources look fine, and that asymmetry caused three
      // false bug reports.
      //
      // But a pad breaks the thing this signal exists FOR. Attempt one
      // retriggered every beat with a 20 ms ramp, which is a transient: false
      // snares went 7 -> 92. Attempt two moved it to once per bar with a 250 ms
      // linear attack and it got WORSE, 194 false snares, because the failure
      // is not the attack at all — a sustained tone RAISES the flux floor and
      // LOWERS its variance, and the detector thresholds on mean + k*stddev, so
      // a smaller stddev drops the bar and it starts firing on noise. At 110 Hz
      // the pad also sits exactly where the detector weights hardest
      // (w = 1 + 3*exp(-i/5)). Tempo confidence fell to 0.095 and the grid
      // never locked.
      //
      // So: this signal's job is validating the CLOCK, and it does that
      // exactly. Validate SUSTAINED-content sources against real music instead
      // — drop a file. Do not put a pad back without re-checking the onset
      // class counts; k/s/h should read roughly 1:0.3:1, not 1:7:5.

      this.nextClick += period;
    }
    this.clickTimer = window.setTimeout(() => {
      if (this.testBpm) this.scheduleClicks();
    }, 200);
  }

  /** Deterministic noise, per plan §4.7 — no Math.random anywhere. */
  private noise(ctx: AudioContext): AudioBuffer {
    if (this.noiseBuf) return this.noiseBuf;
    const n = Math.floor(ctx.sampleRate * 0.12);
    const buf = ctx.createBuffer(1, n, ctx.sampleRate);
    const d = buf.getChannelData(0);
    let h = 0x9e3779b9;
    for (let i = 0; i < n; i++) {
      h = Math.imul(h ^ (h >>> 15), 0x846ca68b) >>> 0;
      d[i] = (h / 2147483648) - 1;
    }
    this.noiseBuf = buf;
    return buf;
  }

  stop(): void {
    this.testBpm = 0;
    this.nextClick = 0;
    if (this.clickTimer !== null) { clearTimeout(this.clickTimer); this.clickTimer = null; }
    this.clearTestSources();
    this.disconnectSource();
    this.position = 0;
    this.playing = false;
  }

  private disconnectSource(): void {
    if (!this.source) return;
    try { this.source.stop(); } catch { /* already stopped */ }
    this.source.disconnect();
    this.source = null;
  }

  private trackTestSource(source: AudioScheduledSourceNode): void {
    this.testSources.add(source);
    source.addEventListener('ended', () => this.testSources.delete(source), { once: true });
  }

  private clearTestSources(): void {
    for (const source of this.testSources) {
      try { source.stop(); } catch { /* already stopped */ }
    }
    this.testSources.clear();
  }

  /**
   * Final page teardown. `stop()` handles the current source, while closing the
   * context guarantees that a just-scheduled test click cannot escape a tab
   * close and keep playing in a background browser process.
   */
  dispose(): void {
    this.stop();
    const ctx = this.ctx;
    if (!ctx || ctx.state === 'closed') return;
    void ctx.close().catch(() => { /* the document may already be unloading */ });
  }

  private resetDetector(): void {
    this.multiband?.reset();
    this.perceptualBands.fill(0);
    this.perceptualFlux.fill(0);
    this.beat = 0;
    this.spectrogram.fill(0);
    this.spectrogramRow = 0;
  }

  update(dt: number): void {
    const t = this.currentTime;
    if (!this.anL || !this.anR || !this.ctx || !this.playing) {
      this.beat *= Math.exp(-dt * 7);
      return;
    }

    this.anL.getByteFrequencyData(this.freqL);
    this.anR.getByteFrequencyData(this.freqR);
    this.anL.getFloatTimeDomainData(this.timeL);
    this.anR.getFloatTimeDomainData(this.timeR);

    // --- waveform (decimated to WAVE_N) ---------------------------------
    const wStep = this.timeL.length / WAVE_N;
    for (let i = 0; i < WAVE_N; i++) {
      const j = Math.floor(i * wStep);
      this.waveform[i * 2] = this.timeL[j]!;
      this.waveform[i * 2 + 1] = this.timeR[j]!;
    }

    // --- level, crest, mid/side -----------------------------------------
    let sq = 0, peak = 0, mSq = 0, sSq = 0;
    for (let i = 0; i < this.timeL.length; i++) {
      const l = this.timeL[i]!, r = this.timeR[i]!;
      const m = (l + r) * 0.5, s = (l - r) * 0.5;
      sq += m * m; mSq += m * m; sSq += s * s;
      const a = Math.abs(m);
      if (a > peak) peak = a;
    }
    const rms = Math.sqrt(sq / this.timeL.length);
    this.level = clamp(rms * 4);
    this.crest = peak / Math.max(rms, 1e-5);
    const mN = Math.sqrt(mSq), sN = Math.sqrt(sSq);
    this.width = sN / Math.max(mN + sN, 1e-6);

    // --- spectrum, per-bin pan, peaks, spectrogram ------------------------
    // Resample by RMS energy, not MAX. A visual bin represents several analyser
    // bins; taking their maximum made one narrow loud partial rail the whole
    // visual bar at 1.0, then the source's perceptual gamma made the rest look
    // pinned too. RMS keeps transients present while giving the band enough
    // headroom to move with the music.
    const step = this.freqL.length / SPEC_N;
    let cenNum = 0, cenDen = 0, logSum = 0, linSum = 0;
    for (let i = 0; i < SPEC_N; i++) {
      const a = Math.floor(i * step);
      const b = Math.min(this.freqL.length, Math.floor((i + 1) * step));
      let eL = 0, eR = 0;
      for (let j = a; j < b; j++) {
        const l = this.freqL[j]! / 255;
        const r = this.freqR[j]! / 255;
        eL += l * l;
        eR += r * r;
      }
      const n = Math.max(1, b - a);
      const L = Math.sqrt(eL / n), R = Math.sqrt(eR / n);
      this.spectrum[i * 2] = L;
      this.spectrum[i * 2 + 1] = R;

      const sum = L + R;
      this.bandPan[i] = sum > 0.01 ? (L - R) / sum : 0;

      const mag = sum * 0.5;
      this.peaks[i] = Math.max(mag, this.peaks[i]! - dt * 0.6);
      this.spectrogram[this.spectrogramRow * SPEC_N + i] = mag;

      cenNum += mag * i; cenDen += mag;
      logSum += Math.log(mag + 1e-6); linSum += mag;
    }
    this.spectrogramRow = (this.spectrogramRow + 1) % SPECTROGRAM_ROWS;
    this.centroid = cenDen > 0 ? cenNum / cenDen / SPEC_N : 0;
    // Wiener entropy: geometric mean / arithmetic mean.
    this.flatness = linSum > 0
      ? Math.exp(logSum / SPEC_N) / (linSum / SPEC_N)
      : 0;

    // --- broadband pan ----------------------------------------------------
    let panNum = 0, panDen = 0;
    for (let bin = 0; bin < this.freqL.length; bin++) {
      const left = this.freqL[bin]!, right = this.freqR[bin]!;
      panNum += left - right;
      panDen += left + right;
    }
    this.pan = panDen > 0 ? clampSigned(panNum / panDen) : 0;

    this.detectOnset(dt, t);
  }

  private detectOnset(dt: number, t: number): void {
    const det = this.detector!;
    det.getByteFrequencyData(this.detSpec);
    const features = this.multiband!.analyse(this.detSpec, 1 / 255, t, dt, this.flatness);
    this.debugFlux = features.flux;
    this.debugThresh = features.threshold;
    this.perceptualBands.set(features.bands);
    this.perceptualFlux.set(features.bandFlux);
    for (let band = 0; band < BAND_NAMES.length; band++) {
      this.bands[BAND_NAMES[band]!] = features.publicBands[band]!;
    }

    this.beat *= Math.exp(-dt * 7);

    if (features.onsetClassCode !== 0) {
      const strength = features.onsetStrength;
      this.beat = Math.max(this.beat, strength);
      const klass = ONSET_CLASS_NAMES[features.onsetClassCode] ?? 'tonal';
      this.onOnset?.({ time: t, strength, klass, pan: this.pan });
    }
  }
}

function clamp(v: number): number { return v < 0 ? 0 : v > 1 ? 1 : v; }
function clampSigned(v: number): number { return v < -1 ? -1 : v > 1 ? 1 : v; }
