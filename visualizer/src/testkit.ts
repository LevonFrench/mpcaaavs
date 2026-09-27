// Golden-image harness (plan §11 Phase 0, §4.7).
//
// Its job: make one run of the app byte-reproducible against the next, so that
// ~40 sources x 5 operators can be regression-tested by a script instead of by
// eye. Phase 0 puts this before the sources on purpose — "it compiled" is not
// verification, and by the time forty looks exist it is far too late to start.
//
// Three things have to be nailed down at once, and leaving any one of them
// loose makes the other two pointless:
//
//   1. TIME. A fixed timestep, not a rAF delta. The vertical slice already
//      derives its motion from `dt` rather than from a frame count, which is
//      correct for playback and fatal for capture: two runs at 165 fps and
//      164 fps integrate the attractor to different places. Here `dt` is a
//      constant and `t` is `frame * dt` — computed, never accumulated, so it
//      cannot drift by float error over a long capture.
//   2. AUDIO. A synthetic source, not a file and not an AudioContext. See
//      `SyntheticAudio` below for why the real engine cannot be used headless.
//   3. RANDOMNESS. One integer seed, threaded through rng.ts. `forbidNondeterminism()`
//      is armed as soon as golden mode is entered, so a stray `Math.random()`
//      throws at the call site instead of surfacing weeks later as an
//      unreproducible one-pixel diff.
//
// What this module deliberately does NOT do: it does not render, own a device,
// or know what a layer is. It supplies a clock, an `AudioSnapshot` and a
// capture call; the render loop stays in `main.ts` and is the thing under test.
// It also does not diff images — that is `tools/golden.mjs`, off the critical
// path and outside the browser.
//
// ---------------------------------------------------------------------------
// WHAT STILL LEAKS NON-DETERMINISM — be honest about this, because a harness
// trusted past its actual guarantees is worse than no harness.
//
//   * THE GPU. Different vendors, and often different driver versions from one
//     vendor, disagree about: fp16 rounding in the RGBA16F accumulator,
//     whether a multiply-add is contracted into an FMA, the exact sample
//     weights of bilinear filtering, denormal flush-to-zero, and rasterisation
//     tie-breaking on shared triangle edges. None of these are bugs and none
//     are fixable from here. Golden images are therefore MACHINE-LOCAL: they
//     catch OUR regressions on one machine, and they will light up red if you
//     move them to another GPU, or upgrade a driver. That is expected. If CI
//     ever runs this, it must pin the runner, or accept a large tolerance and
//     lose most of the sensitivity that made it worth doing.
//   * Compositing. `toDataURL` goes through the canvas colour-space and
//     premultiplication path, which has changed between Chrome releases.
//     Pin the browser, or treat a browser upgrade as a baseline refresh.
//   * Anything still reading a wall clock. This harness controls the clock it
//     is given; it cannot stop a layer calling `performance.now()` behind its
//     back. §12's lint rule is the enforcement, not this file.
//   * The real audio path. `SyntheticAudio` REPLACES `AudioEngine`, so nothing
//     in the FFT, the detector or the tempo tracker is covered by a golden
//     image. Those need their own tests; do not read a green golden run as
//     evidence that onset detection works.
//
// So: byte-identical across two runs on one machine is the contract, and that
// is exactly the Phase 0 DoD. Cross-machine byte-identity is not claimed.
// ---------------------------------------------------------------------------

import { SPEC_N, SPECTROGRAM_ROWS, WAVE_N } from './audio.ts';
import { hash2, hashU32, forbidNondeterminism } from './rng.ts';
import type { AudioSnapshot, BandName, Onset, OnsetClass } from './contracts.ts';

/** Where the driver in `tools/golden.mjs` looks for the result. */
export const GOLDEN_GLOBAL = '__aaavsGolden';

/**
 * What the driver reads off `window`. A discriminated-ish shape rather than a
 * bare string: a capture that never happens and a capture that failed must not
 * look the same to a script, or a broken build reports as a timeout and the
 * real error is lost with the browser process.
 */
export interface GoldenResult {
  /** True once `png` is final. The driver polls this. */
  ready: boolean;
  /** `data:image/png;base64,...`, or empty until ready. */
  png: string;
  /** Non-empty if the run failed. Checked BEFORE `ready`. */
  error: string;
  /** Echoed back so the driver can assert it got the run it asked for. */
  config: GoldenConfig | null;
  /** Frames actually rendered. Should equal `config.frames`. */
  rendered: number;
}

export interface GoldenConfig {
  readonly frames: number;
  readonly seed: number;
  readonly bpm: number;
  /** Seconds per frame. Fixed. 1/60 unless overridden. */
  readonly dt: number;
  /** Capture size in device pixels. DPR is forced to 1 — see `main.ts` notes below. */
  readonly width: number;
  readonly height: number;
}

const DEFAULTS = { frames: 120, seed: 1, bpm: 128, fps: 60, width: 512, height: 512 };

/**
 * Parse `?golden=1&frames=N&seed=S&bpm=B` (plus optional `fps`, `w`, `h`).
 * Returns null when golden mode is off, which is the only signal `main.ts`
 * needs — normal runs pay nothing for this file existing.
 *
 * Arms `forbidNondeterminism()` as a side effect. That is deliberate: the one
 * moment we know determinism is required is the moment we know we are
 * capturing, and arming it anywhere else would break the debug overlay.
 */
export function goldenConfig(search: string = location.search): GoldenConfig | null {
  const q = new URLSearchParams(search);
  if (q.get('golden') !== '1') return null;

  const num = (key: string, fallback: number, lo: number, hi: number): number => {
    const raw = q.get(key);
    if (raw === null) return fallback;
    const v = Number(raw);
    if (!Number.isFinite(v)) return fallback;
    return Math.min(hi, Math.max(lo, v));
  };

  const fps = num('fps', DEFAULTS.fps, 1, 1000);
  const cfg: GoldenConfig = {
    frames: Math.round(num('frames', DEFAULTS.frames, 1, 100_000)),
    seed: Math.round(num('seed', DEFAULTS.seed, 0, 0xffffffff)),
    bpm: num('bpm', DEFAULTS.bpm, 20, 400),
    dt: 1 / fps,
    width: Math.round(num('w', DEFAULTS.width, 16, 8192)),
    height: Math.round(num('h', DEFAULTS.height, 16, 8192)),
  };

  forbidNondeterminism();
  publish({ ready: false, png: '', error: '', config: cfg, rendered: 0 });
  return cfg;
}

function slot(): GoldenResult {
  const g = globalThis as unknown as Record<string, GoldenResult | undefined>;
  return g[GOLDEN_GLOBAL] ?? { ready: false, png: '', error: '', config: null, rendered: 0 };
}

function publish(r: GoldenResult): void {
  (globalThis as unknown as Record<string, GoldenResult>)[GOLDEN_GLOBAL] = r;
}

/**
 * Report a failure to the driver. Safe to call before `goldenConfig()` and safe
 * to call twice; the FIRST error wins, because the first one is the cause and
 * everything after it is fallout.
 */
export function goldenFail(e: unknown): void {
  const cur = slot();
  if (cur.error) return;
  cur.error = e instanceof Error ? `${e.name}: ${e.message}\n${e.stack ?? ''}` : String(e);
  publish(cur);
}

// ---------------------------------------------------------------------------
// Synthetic audio
// ---------------------------------------------------------------------------

/**
 * A deterministic stand-in for `AudioEngine`, generating an `AudioSnapshot`
 * from `(seed, bpm, frame)` alone.
 *
 * Why not drive the real engine from a fixture file? Three independent
 * blockers, any one of which is fatal:
 *
 *   - `AudioContext` needs a TRUSTED user gesture. A synthetic `click()` will
 *     not resume it (README, "Notes worth keeping") — the clock silently stays
 *     at zero and the capture is a black frame with no error.
 *   - `AnalyserNode` cannot be read from an `OfflineAudioContext`, so the
 *     obvious offline route does not exist.
 *   - A realtime `AnalyserNode` samples whatever the audio thread happens to
 *     have produced when the render thread asks. That is a race by
 *     construction, and it is exactly the non-determinism we are trying to
 *     eliminate. Even with a perfect fixture the FFT frames would not line up
 *     between two runs.
 *
 * So the fixture is arithmetic, not a WAV. The pattern is kick, hat, snare, hat
 * on a four-beat cycle, so every field a layer might read is populated and
 * moving rather than zero. Note that this is NOT identical to
 * `AudioEngine.startTestSignal`, which alternates kick and hat only: the snare
 * is added here because a golden frame should exercise all three onset-routed
 * paths, and the synthetic source is not obliged to be limited by what a click
 * track happens to synthesise.
 *
 * Times are in BEATS throughout, per the plan's standing rule, so changing
 * `bpm` genuinely changes the music rather than just the playback rate of a
 * fixed animation.
 */
export class SyntheticAudio implements AudioSnapshot {
  time = 0;
  level = 0;
  beat = 0;
  bands: Record<BandName, number> = { sub: 0, low: 0, mid: 0, high: 0, air: 0 };
  pan = 0;
  width = 0;
  crest = 1;
  centroid = 0;
  flatness = 0;
  readonly perceptualBands = new Float32Array(12);
  readonly perceptualFlux = new Float32Array(12);

  readonly waveform = new Float32Array(WAVE_N * 2);
  readonly spectrum = new Float32Array(SPEC_N * 2);
  readonly bandPan = new Float32Array(SPEC_N);
  readonly spectrogram = new Float32Array(SPEC_N * SPECTROGRAM_ROWS);
  spectrogramRow = 0;
  readonly peaks = new Float32Array(SPEC_N);

  /** Onsets whose time fell inside the frame most recently generated. */
  readonly onsets: Onset[] = [];

  private readonly seed: number;
  private readonly bpm: number;
  private beatIndex = -1;

  constructor(seed: number, bpm: number) {
    this.seed = hashU32(seed);
    this.bpm = bpm;
  }

  /**
   * Regenerate every field for the frame ending at `time`.
   *
   * The scalars, the waveform and the spectrum are pure functions of
   * `(seed, bpm, time)`, so re-running from any frame gives the same answer for
   * those. Three things are genuinely stateful and are NOT seekable: the
   * peak-hold fall, the spectrogram ring, and `beatIndex` — which exists so a
   * beat straddling a frame boundary is emitted exactly once. Calling
   * `generate` out of order, or twice for the same frame, therefore silently
   * drops onsets. Frames must be walked forward, once each, which is what
   * `GoldenHarness.advance()` does.
   */
  generate(time: number, dt: number): void {
    this.time = time;
    const beats = (time * this.bpm) / 60;
    const prevBeats = ((time - dt) * this.bpm) / 60;

    // --- onsets: the four-beat pattern of the built-in test signal ---------
    this.onsets.length = 0;
    for (let b = Math.max(0, Math.ceil(prevBeats)); b <= Math.floor(beats); b++) {
      if (b <= this.beatIndex) continue;
      this.beatIndex = b;
      const klass = PATTERN[b % PATTERN.length] ?? 'kick';
      this.onsets.push({
        time: (b * 60) / this.bpm,
        // Varied but reproducible — a constant strength makes every bar
        // identical and hides exactly the bugs a golden image is for.
        strength: 0.6 + 0.4 * hash2(this.seed, b),
        klass,
        // SIGN: `AudioEngine.pan` is (L-R)/(L+R), so POSITIVE IS LEFT — the
        // opposite of Web Audio's `StereoPanner.pan`, where +0.6 is right.
        // The engine's test signal pans hats +0.6 in the graph, which comes
        // back out of the analysers as a NEGATIVE broadband pan. This was
        // written with the Web Audio sign and so disagreed both with the
        // engine and with `bandPan` two dozen lines below, which was derived
        // correctly. A stand-in that inverts a field of the thing it stands in
        // for is worse than no stand-in.
        pan: klass === 'hat' ? -0.6 : klass === 'snare' ? 0.25 : 0,
      });
    }

    // --- envelopes, all measured in beats since the last hit of each class --
    const kick = envAt(since(beats, PATTERN, 'kick'), 0.02, 0.9);
    const snare = envAt(since(beats, PATTERN, 'snare'), 0.02, 0.7);
    const hat = envAt(since(beats, PATTERN, 'hat'), 0.01, 0.25);

    // A /8 breath so nothing in the frame is perfectly static. Musical rate,
    // not a wall-clock one, so it survives a tempo change unchanged (§4.4).
    const breath = 0.5 + 0.5 * Math.sin((beats / 8) * Math.PI * 2);

    this.beat = Math.max(kick, Math.max(snare, hat));
    this.bands.sub = clamp(kick * 0.95 + 0.02);
    this.bands.low = clamp(kick * 0.8 + breath * 0.12);
    this.bands.mid = clamp(snare * 0.7 + breath * 0.22);
    this.bands.high = clamp(hat * 0.85 + snare * 0.3 + 0.03);
    this.bands.air = clamp(hat * 0.7 + 0.02);
    this.level = clamp(0.08 + 0.7 * this.beat + 0.1 * breath);
    // Positive is LEFT — see the sign note on the onsets above.
    this.pan = 0.25 * snare - 0.6 * hat;
    this.width = clamp(0.18 + 0.35 * hat + 0.15 * breath);
    // Crest falls as things get loud, the way a compressed build does (§6).
    this.crest = 1.4 + 4.5 * (1 - this.beat);
    this.centroid = clamp(0.12 + 0.55 * hat + 0.2 * snare + 0.05 * breath);
    this.flatness = clamp(0.05 + 0.7 * hat + 0.25 * snare);

    // --- waveform: a kick sweep plus hashed noise under the hat -----------
    // Phase is derived from absolute beat position rather than integrated, so
    // frame N is identical whether it was reached in one step or a thousand.
    const secPerBeat = 60 / this.bpm;
    for (let i = 0; i < WAVE_N; i++) {
      const st = time + (i / WAVE_N) * (dt || 1 / 60);
      const sb = (st * this.bpm) / 60;
      const kb = since(sb, PATTERN, 'kick');
      // 180 Hz -> 45 Hz, the same sweep the test signal uses.
      const hz = 180 * Math.pow(45 / 180, Math.min(1, (kb * secPerBeat) / 0.09));
      const body = Math.sin(st * hz * Math.PI * 2) * envAt(kb, 0.02, 0.9);
      const fizz = (hash2(this.seed ^ 0x5bf03635, i + Math.round(st * 44100)) * 2 - 1) * hat * 0.35;
      // The hat sits 0.6 right, so L gets less of the noise than R. Without
      // this the two channels are identical and a Lissajous layer draws a line.
      this.waveform[i * 2] = clampSigned(body + fizz * 0.4);
      this.waveform[i * 2 + 1] = clampSigned(body + fizz);
    }

    // --- spectrum, per-bin pan, peaks, spectrogram -------------------------
    for (let i = 0; i < SPEC_N; i++) {
      const f = i / SPEC_N;
      // Rough band shaping: bass at the bottom, hat energy at the top, with a
      // seeded per-bin sparkle so neighbouring bins are not identical.
      const shape =
        kick * Math.exp(-f * 26) +
        snare * Math.exp(-Math.pow((f - 0.22) * 5.5, 2)) +
        hat * Math.pow(f, 1.6) * 0.9 +
        breath * 0.05 * Math.exp(-f * 4);
      const sparkle = 0.75 + 0.5 * hash2(this.seed ^ 0x9e3779b9, i);
      const mag = clamp(shape * sparkle);
      // `p` is a Web Audio-style POSITION (+ = right), used to shade L and R;
      // `bandPan` below is then derived as (L-R)/(L+R) exactly as the engine
      // does it, which flips the sign back. Hats sit right, snare slightly
      // left — the same placement as the onsets, so a stereo-field layer and
      // an onset-routed layer agree with each other.
      const p = clampSigned(0.6 * hat * f - 0.25 * snare * (1 - f));
      const l = clamp(mag * (1 - Math.max(0, p)));
      const r = clamp(mag * (1 + Math.min(0, p)));
      this.spectrum[i * 2] = l;
      this.spectrum[i * 2 + 1] = r;
      this.bandPan[i] = l + r > 0.01 ? (l - r) / (l + r) : 0;
      this.peaks[i] = Math.max(mag, (this.peaks[i] ?? 0) - dt * 0.6);
      this.spectrogram[this.spectrogramRow * SPEC_N + i] = mag;
    }
    this.spectrogramRow = (this.spectrogramRow + 1) % SPECTROGRAM_ROWS;
  }
}

/** One bar of the built-in test signal, as onset classes. */
const PATTERN: readonly OnsetClass[] = ['kick', 'hat', 'snare', 'hat'];

/** Beats elapsed since the most recent occurrence of `klass` at or before `beats`. */
function since(beats: number, pattern: readonly OnsetClass[], klass: OnsetClass): number {
  if (beats < 0) return 1e6;
  const n = pattern.length;
  for (let back = 0; back < n; back++) {
    const b = Math.floor(beats) - back;
    if (b < 0) break;
    if (pattern[((b % n) + n) % n] === klass) return beats - b;
  }
  return 1e6;
}

/**
 * Exponential attack/release in BEATS (contracts.ts `Envelope` rationale).
 * Fast up, several times slower down — linear symmetric envelopes are what make
 * audio-reactive work read as a bouncing progress bar.
 */
function envAt(sinceBeats: number, attack: number, release: number): number {
  if (!Number.isFinite(sinceBeats) || sinceBeats < 0 || sinceBeats > 1e5) return 0;
  if (sinceBeats < attack) return attack > 0 ? sinceBeats / attack : 1;
  return Math.exp(-(sinceBeats - attack) / Math.max(release, 1e-4));
}

// ---------------------------------------------------------------------------
// The harness
// ---------------------------------------------------------------------------

/**
 * Drives a fixed number of fixed-length frames and then captures the canvas.
 *
 * The render loop keeps ownership of rAF. This deliberately does not take the
 * loop over: a harness that renders differently from the app is a harness that
 * passes while the app is broken.
 */
export class GoldenHarness {
  readonly cfg: GoldenConfig;
  readonly audio: SyntheticAudio;
  /** Index of the frame about to be rendered. */
  frame = 0;

  constructor(cfg: GoldenConfig) {
    this.cfg = cfg;
    this.audio = new SyntheticAudio(cfg.seed, cfg.bpm);
    this.audio.generate(0, cfg.dt);
  }

  /** The fixed timestep. Pass this to the renderer INSTEAD of a rAF delta. */
  get dt(): number { return this.cfg.dt; }

  /**
   * Synthetic audio-clock seconds. Multiplied, not accumulated: summing `dt`
   * ten thousand times accumulates float error, and two runs that disagree in
   * the last bit of `t` produce two different pictures of a chaotic system.
   */
  get time(): number { return this.frame * this.cfg.dt; }

  /** True once every requested frame has been rendered. Stop the loop. */
  get done(): boolean { return this.frame >= this.cfg.frames; }

  /** Call once per rendered frame, AFTER submitting that frame's work. */
  advance(): void {
    this.frame++;
    this.audio.generate(this.time, this.cfg.dt);
    const cur = slot();
    cur.rendered = this.frame;
    publish(cur);
  }

  /**
   * Capture the canvas and publish the PNG for the driver.
   *
   * `onSubmittedWorkDone` first, because `toDataURL` reads the canvas image and
   * the last frame's work may still be queued. The caller MUST stop rendering
   * before awaiting this: WebGPU canvas contents live until the next
   * `getCurrentTexture()`, so one more frame between here and the read
   * silently captures the wrong picture — and it would look plausible, which
   * is the worst kind of wrong.
   */
  async capture(device: GPUDevice, canvas: HTMLCanvasElement): Promise<void> {
    try {
      await device.queue.onSubmittedWorkDone();
      const png = canvas.toDataURL('image/png');
      if (!png.startsWith('data:image/png')) throw new Error(`toDataURL gave "${png.slice(0, 32)}"`);
      const cur = slot();
      cur.png = png;
      cur.ready = true;
      publish(cur);
    } catch (e) {
      goldenFail(e);
    }
  }
}

function clamp(v: number): number { return v < 0 ? 0 : v > 1 ? 1 : v; }
function clampSigned(v: number): number { return v < -1 ? -1 : v > 1 ? 1 : v; }
