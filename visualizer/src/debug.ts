// The debug overlay (plan §11, Phase 0: "debug view rendering each audio texture
// raw").
//
// Deliberately a 2D canvas laid over the WebGPU canvas, NOT extra render passes.
// Two reasons, and the second is the important one. First, at 2K120 the frame is
// 8.33 ms and nine compositing passes already eat 15-20% of it (§4.11) — an
// instrument that spends the budget it is there to measure is worse than no
// instrument. Second, the overlay must stay legible when the render graph is
// broken, and a pass inside the graph cannot draw a picture of the graph failing.
//
// What it is FOR: making the detector diagnosable. The kick-classification bug in
// README.md is not visible in a counter — "kicks: 0" says only that something is
// wrong. Flux against its adaptive threshold, plotted over time with the onsets
// it fired marked and coloured by class, says WHICH frame fired and what the
// spectrum looked like at that instant. A detector you cannot see the internals
// of is a detector you tune by superstition.
//
// What it deliberately does NOT do: own any audio or GPU state, keep any history
// that the engine already keeps (the spectrogram ring is read in place, never
// copied), or draw anything while hidden. It is not literally inert when hidden
// — `pushOnset` keeps recording, deliberately, so the markers are already on
// screen the moment it comes up — but that is a handful of writes a second and
// nothing else runs.
//
// On colour: art-direction §2.2's three-hue rule governs the SHOW. This is a
// bench instrument, and the four onset classes have to be told apart at a glance,
// so it uses four fixed hues on purpose.

import type { AudioSnapshot, BandName, GpuTiming, Onset, OnsetClass } from './contracts.ts';
import type { FlashDecision } from './flash-limiter.ts';
import { HISTOGRAM_BINS, type FrameReadout } from './frame-recorder.ts';

const FONT = '11px ui-monospace, "Cascadia Mono", Menlo, Consolas, monospace';
const FONT_BOLD = '600 11px ui-monospace, "Cascadia Mono", Menlo, Consolas, monospace';

// Lifted from index.html so the overlay and the page agree.
const FG = '#e9e9f2';
const DIM = '#8a8aa0';
const LINE = 'rgba(255,255,255,.12)';
const PANEL_BG = 'rgba(10,10,18,.82)';
const ACCENT = '#ff3d81';
const LEFT_CH = '#6ee7ff';
const RIGHT_CH = '#ff3d81';

const CLASS_COLOUR: Record<OnsetClass, string> = {
  kick:  '#ff3d81',
  snare: '#ffd166',
  hat:   '#6ee7ff',
  tonal: '#a78bfa',
};

/** Fixed order, low to high. `Object.keys` order on the bands record is not a contract. */
const BAND_ORDER: readonly BandName[] = ['sub', 'low', 'mid', 'high', 'air'];
const BAND_HZ: Record<BandName, string> = {
  sub: '20-80', low: '80-250', mid: '250-2k', high: '2k-8k', air: '8k-20k',
};

/** Seconds of flux/onset history on screen. Long enough to see a bar at any sane tempo. */
const PLOT_SEC = 4;
/** ~8 s at 120 fps. Overruns are dropped from the front, so the window is honest. */
const HISTORY = 1024;
const ONSET_HISTORY = 128;

/** Bottom of the log-frequency axis. Below this there is nothing but rumble and DC. */
const F_MIN = 30;

/** Vertical resolution of the spectrogram image. Independent of the bin count, since the y axis is log. */
const GRAM_ROWS = 128;

const PAD = 10;
const GAP = 8;
const COL_W = 330;
const TITLE_H = 15;

/** Everything the overlay draws that is not in `AudioSnapshot`. */
export interface DebugInputs {
  readonly audio: AudioSnapshot;
  /** `AudioEngine.debugFlux` — the raw onset detection function this frame. */
  readonly flux: number;
  /** `AudioEngine.debugThresh` — mean + k*stddev over the time window. */
  readonly threshold: number;
  /** From `GpuTimer.timings`. Empty when the adapter has no `timestamp-query`. */
  readonly timings: readonly GpuTiming[];
  readonly bpm: number;
  readonly tempoLocked: boolean;
  readonly confidence: number;
  readonly fps: number;
  /** Needed to put the frequency axes in Hz rather than bins. */
  readonly sampleRate: number;
}

interface Sample { t: number; flux: number; thresh: number }

export class DebugOverlay {
  private readonly canvas: HTMLCanvasElement;
  private readonly ctx: CanvasRenderingContext2D;
  private vis = false;

  // Flux history is recorded only while visible. Toggling on therefore starts
  // with an empty plot that fills over PLOT_SEC, which is the price of the
  // overlay costing nothing when hidden — and it is the right trade, because a
  // ring being written every frame forever is exactly the kind of "small"
  // constant cost that the 8.33 ms budget cannot afford.
  private readonly hist: Sample[] = [];
  private readonly onsets: Onset[] = [];
  private lastTime = 0;

  // Spectrogram scratch. Sized once, reused; rebuilt per frame because the ring
  // rotates under us and a shift-and-append would have to reorder anyway.
  private gram: HTMLCanvasElement | null = null;
  private gramCtx: CanvasRenderingContext2D | null = null;
  private gramImg: ImageData | null = null;
  /** Output row -> source bin, for the log-frequency y axis. Rebuilt when the shape changes. */
  private gramBins: Int32Array | null = null;
  private gramKey = '';

  // Frame-pacing readout (src/frame-recorder.ts) and flash-limiter state. Held
  // by reference: the owner refills them, the overlay only reads. Null = the
  // panel is not drawn, so a window without a recorder loses nothing.
  private rum: FrameReadout | null = null;
  private flash: FlashDecision | null = null;

  constructor(host: HTMLElement = document.body) {
    const c = document.createElement('canvas');
    c.id = 'debug-overlay';
    c.style.cssText =
      'position:fixed;inset:0;width:100vw;height:100vh;' +
      'pointer-events:none;display:none;z-index:10';
    host.appendChild(c);
    const ctx = c.getContext('2d');
    if (!ctx) throw new Error('Could not acquire a 2d context for the debug overlay.');
    this.canvas = c;
    this.ctx = ctx;
  }

  get visible(): boolean { return this.vis; }

  setVisible(v: boolean): void {
    this.vis = v;
    this.canvas.style.display = v ? 'block' : 'none';
    if (!v) {
      // Held history would be stale by the time it is shown again, and stale
      // flux plotted against fresh onsets is actively misleading.
      this.hist.length = 0;
    }
  }

  toggle(): void { this.setVisible(!this.vis); }

  /**
   * Wire to `AudioEngine.onOnset`. Kept even while hidden — it is a handful of
   * writes a second, and it means the markers are already there the moment the
   * overlay comes up, which is when you want them.
   */
  pushOnset(o: Onset): void {
    this.onsets.push(o);
    if (this.onsets.length > ONSET_HISTORY) this.onsets.shift();
  }

  /**
   * Attach a `FrameRecorder` readout. Pass the object `createFrameReadout()`
   * returned and keep calling `recorder.readout(it)` — only while `visible`,
   * since the readout sorts — and the panel follows. Null removes the panel.
   */
  setFrameStats(readout: FrameReadout | null): void { this.rum = readout; }

  /** Attach the flash limiter's last decision (reused object; read each draw). Null hides the row. */
  setFlashStatus(decision: FlashDecision | null): void { this.flash = decision; }

  destroy(): void {
    this.canvas.remove();
  }

  draw(d: DebugInputs): void {
    if (!this.vis) return;

    const a = d.audio;
    // A seek, a track change or the test signal restarting rewinds the audio
    // clock. History from the old timeline would plot to the right of "now"
    // and read as the future.
    if (a.time < this.lastTime - 1e-3) {
      this.hist.length = 0;
      this.onsets.length = 0;
    }
    this.lastTime = a.time;

    this.hist.push({ t: a.time, flux: d.flux, thresh: d.threshold });
    if (this.hist.length > HISTORY) this.hist.shift();

    const dpr = Math.min(window.devicePixelRatio || 1, 2);
    const w = window.innerWidth;
    const h = window.innerHeight;
    const pw = Math.round(w * dpr);
    const ph = Math.round(h * dpr);
    if (this.canvas.width !== pw || this.canvas.height !== ph) {
      this.canvas.width = pw;
      this.canvas.height = ph;
    }
    const ctx = this.ctx;
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    ctx.clearRect(0, 0, w, h);
    ctx.font = FONT;
    ctx.textBaseline = 'top';

    const specN = a.spectrum.length >> 1;
    const nyquist = d.sampleRate / 2;

    // Flow panels down a column, wrapping into the next one. Beats a fixed
    // layout: the panel list grows every phase and the window is never the
    // size the layout was designed for.
    let x = PAD;
    let y = PAD;
    const panel = (title: string, ph2: number, body: (bx: number, by: number, bw: number, bh: number) => void): void => {
      if (y + ph2 + TITLE_H > h - PAD && y > PAD) { x += COL_W + GAP; y = PAD; }
      if (x + COL_W > w) return;  // out of room; drop the panel rather than overlap
      const total = ph2 + TITLE_H;
      ctx.fillStyle = PANEL_BG;
      ctx.strokeStyle = LINE;
      ctx.lineWidth = 1;
      ctx.beginPath();
      ctx.roundRect(x + 0.5, y + 0.5, COL_W - 1, total - 1, 6);
      ctx.fill();
      ctx.stroke();
      ctx.fillStyle = DIM;
      ctx.font = FONT_BOLD;
      ctx.fillText(title, x + 8, y + 4);
      ctx.font = FONT;
      body(x + 8, y + TITLE_H, COL_W - 16, ph2 - 6);
      y += total + GAP;
    };

    panel('state', 74, (bx, by, bw) => this.drawScalars(bx, by, bw, d));
    panel('waveform  L / R', 92, (bx, by, bw, bh) => this.drawWaveform(bx, by, bw, bh, a));
    panel('spectrum  L up / R down  (log f)', 108, (bx, by, bw, bh) =>
      this.drawSpectrum(bx, by, bw, bh, a, specN, nyquist));
    panel('spectrogram  (oldest left, log f)', 116, (bx, by, bw, bh) =>
      this.drawSpectrogram(bx, by, bw, bh, a, specN, nyquist));
    panel('bands', 78, (bx, by, bw, bh) => this.drawBands(bx, by, bw, bh, a));
    panel('stereo field  (per-bin pan)', 74, (bx, by, bw, bh) =>
      this.drawStereoField(bx, by, bw, bh, a, specN, nyquist));
    panel('flux vs threshold  +  onsets', 132, (bx, by, bw, bh) =>
      this.drawFlux(bx, by, bw, bh, a.time));
    const rows = Math.max(1, d.timings.length) + 1;
    panel('gpu passes  (rolling avg)', 6 + rows * 13, (bx, by, bw, bh) =>
      this.drawTimings(bx, by, bw, bh, d.timings));
    const rum = this.rum;
    if (rum || this.flash) {
      panel('frame pacing  (delivered)', (rum ? 4 * 13 + 32 : 0) + (this.flash ? 13 : 0) + 6, (bx, by, bw) =>
        this.drawPacing(bx, by, bw, rum, this.flash));
    }
  }

  // -- panels ---------------------------------------------------------------

  private drawScalars(x: number, y: number, w: number, d: DebugInputs): void {
    const a = d.audio;
    const rows: Array<[string, string]> = [
      ['clock', `${a.time.toFixed(2)}s`],
      ['fps', d.fps.toFixed(0)],
      ['bpm', d.tempoLocked ? `${d.bpm.toFixed(1)} (${(d.confidence * 100) | 0}%)` : 'listening'],
      ['level', a.level.toFixed(3)],
      ['beat', a.beat.toFixed(3)],
      ['pan', signed(a.pan)],
      ['width', a.width.toFixed(3)],
      ['crest', a.crest.toFixed(2)],
      ['centroid', a.centroid.toFixed(3)],
      ['flatness', a.flatness.toFixed(3)],
    ];
    const ctx = this.ctx;
    const half = w / 2;
    for (let i = 0; i < rows.length; i++) {
      const row = rows[i]!;
      const cx = x + (i % 2) * half;
      const cy = y + Math.floor(i / 2) * 13;
      ctx.fillStyle = DIM;
      ctx.fillText(row[0], cx, cy);
      ctx.fillStyle = FG;
      ctx.fillText(row[1], cx + 62, cy);
    }
  }

  private drawWaveform(x: number, y: number, w: number, h: number, a: AudioSnapshot): void {
    const ctx = this.ctx;
    const n = a.waveform.length >> 1;
    const half = h / 2;
    for (let ch = 0; ch < 2; ch++) {
      const mid = y + half * ch + half / 2;
      ctx.strokeStyle = LINE;
      ctx.beginPath();
      ctx.moveTo(x, mid + 0.5);
      ctx.lineTo(x + w, mid + 0.5);
      ctx.stroke();

      ctx.strokeStyle = ch === 0 ? LEFT_CH : RIGHT_CH;
      ctx.lineWidth = 1;
      ctx.beginPath();
      for (let i = 0; i < w; i++) {
        // One sample per pixel column. Peak-picking would be more honest for a
        // waveform overview, but this is a scope trace: what the shader sees.
        const s = a.waveform[(((i / w) * n) | 0) * 2 + ch] ?? 0;
        const py = mid - clampSigned(s) * (half / 2 - 2);
        if (i === 0) ctx.moveTo(x + i, py); else ctx.lineTo(x + i, py);
      }
      ctx.stroke();
      ctx.fillStyle = DIM;
      ctx.fillText(ch === 0 ? 'L' : 'R', x + 2, mid - half / 2 + 1);
    }
  }

  private drawSpectrum(
    x: number, y: number, w: number, h: number,
    a: AudioSnapshot, specN: number, nyquist: number,
  ): void {
    const ctx = this.ctx;
    const mid = y + h / 2;
    const half = h / 2 - 7;

    this.freqGrid(x, y, w, h, nyquist);

    for (let i = 0; i < specN; i++) {
      const f0 = (i * nyquist) / specN;
      const f1 = ((i + 1) * nyquist) / specN;
      const x0 = x + logX(f0, nyquist) * w;
      const x1 = x + logX(f1, nyquist) * w;
      const bw = Math.max(1, x1 - x0);
      const L = a.spectrum[i * 2] ?? 0;
      const R = a.spectrum[i * 2 + 1] ?? 0;
      ctx.fillStyle = LEFT_CH;
      ctx.fillRect(x0, mid - L * half, bw, L * half);
      ctx.fillStyle = RIGHT_CH;
      ctx.fillRect(x0, mid, bw, R * half);
      // Peak-hold caps, drawn on the L side only — two sets of falling caps
      // read as noise rather than as a measurement.
      const p = a.peaks[i] ?? 0;
      if (p > 0.01) {
        ctx.fillStyle = FG;
        ctx.fillRect(x0, mid - p * half - 1, bw, 1);
      }
    }
    ctx.strokeStyle = LINE;
    ctx.beginPath();
    ctx.moveTo(x, mid + 0.5);
    ctx.lineTo(x + w, mid + 0.5);
    ctx.stroke();
  }

  private drawSpectrogram(
    x: number, y: number, w: number, h: number,
    a: AudioSnapshot, specN: number, nyquist: number,
  ): void {
    const rows = specN > 0 ? Math.floor(a.spectrogram.length / specN) : 0;
    if (rows < 2) return;
    const ctx = this.ctx;
    const img = this.ensureGram(rows, specN, nyquist);
    if (!img || !this.gram || !this.gramCtx || !this.gramBins) return;

    const bins = this.gramBins;
    const px = img.data;
    // Column 0 is the OLDEST row, and the oldest row is the one about to be
    // overwritten — i.e. `spectrogramRow` itself. Getting this off by one row
    // is invisible; getting the direction wrong makes the waterfall run
    // backwards, which is the usual bug here.
    const start = a.spectrogramRow;
    for (let c = 0; c < rows; c++) {
      const srcRow = ((start + c) % rows) * specN;
      for (let r = 0; r < GRAM_ROWS; r++) {
        const v = a.spectrogram[srcRow + (bins[r] ?? 0)] ?? 0;
        const o = (r * rows + c) * 4;
        heat(v, px, o);
      }
    }
    this.gramCtx.putImageData(img, 0, 0);
    ctx.save();
    ctx.imageSmoothingEnabled = false;
    ctx.drawImage(this.gram, x, y, w, h);
    ctx.restore();
    ctx.strokeStyle = LINE;
    ctx.strokeRect(x + 0.5, y + 0.5, w - 1, h - 1);
  }

  private drawBands(x: number, y: number, w: number, h: number, a: AudioSnapshot): void {
    const ctx = this.ctx;
    const rowH = h / BAND_ORDER.length;
    for (let i = 0; i < BAND_ORDER.length; i++) {
      const name = BAND_ORDER[i]!;
      const v = a.bands[name];
      const by = y + i * rowH;
      ctx.fillStyle = DIM;
      ctx.fillText(name, x, by);
      ctx.fillText(BAND_HZ[name], x + 34, by);
      const barX = x + 96;
      const barW = w - 96 - 34;
      ctx.fillStyle = LINE;
      ctx.fillRect(barX, by + 1, barW, rowH - 4);
      ctx.fillStyle = ACCENT;
      ctx.fillRect(barX, by + 1, barW * clamp01(v), rowH - 4);
      ctx.fillStyle = FG;
      ctx.fillText(v.toFixed(2), barX + barW + 4, by);
    }
  }

  private drawStereoField(
    x: number, y: number, w: number, h: number,
    a: AudioSnapshot, specN: number, nyquist: number,
  ): void {
    const ctx = this.ctx;
    const mid = y + h / 2;
    const half = h / 2 - 2;
    this.freqGrid(x, y, w, h, nyquist);
    ctx.strokeStyle = LINE;
    ctx.beginPath();
    ctx.moveTo(x, mid + 0.5);
    ctx.lineTo(x + w, mid + 0.5);
    ctx.stroke();

    for (let i = 0; i < specN; i++) {
      const L = a.spectrum[i * 2] ?? 0;
      const R = a.spectrum[i * 2 + 1] ?? 0;
      const mag = (L + R) * 0.5;
      if (mag < 0.02) continue;   // pan of silence is a meaningless number
      const f = ((i + 0.5) * nyquist) / specN;
      const px = x + logX(f, nyquist) * w;
      // Up is left, matching the spectrum panel above it.
      const py = mid - clampSigned(a.bandPan[i] ?? 0) * half;
      ctx.fillStyle = `rgba(233,233,242,${(0.25 + mag * 0.75).toFixed(3)})`;
      ctx.fillRect(px, py - 1, 2, 2);
    }
    ctx.fillStyle = DIM;
    ctx.fillText('L', x + 2, y);
    ctx.fillText('R', x + 2, y + h - 12);
  }

  /**
   * The panel the kick bug is diagnosed in. Flux, its adaptive threshold, and
   * the onsets that actually fired, on one time axis — so "it fired here, and
   * it was classified as that" is a single glance rather than an inference from
   * two counters.
   */
  private drawFlux(x: number, y: number, w: number, h: number, now: number): void {
    const ctx = this.ctx;
    const t0 = now - PLOT_SEC;
    const laneH = 16;
    const plotY = y + laneH;
    const plotH = h - laneH - 12;

    // Autoscale. A fixed scale is useless here: flux is whitened and its
    // absolute magnitude depends on the material, which is the whole reason
    // the threshold is adaptive in the first place.
    let peak = 0.02;
    for (const s of this.hist) {
      if (s.t < t0) continue;
      if (s.flux > peak) peak = s.flux;
      if (s.thresh > peak) peak = s.thresh;
    }
    peak *= 1.15;

    const px = (t: number) => x + ((t - t0) / PLOT_SEC) * w;
    const py = (v: number) => plotY + plotH - clamp01(v / peak) * plotH;

    ctx.strokeStyle = LINE;
    ctx.strokeRect(x + 0.5, plotY + 0.5, w - 1, plotH - 1);

    // Onset markers first, so the traces sit on top of them.
    for (const o of this.onsets) {
      if (o.time < t0) continue;
      const ox = px(o.time);
      ctx.strokeStyle = CLASS_COLOUR[o.klass];
      ctx.globalAlpha = 0.35 + o.strength * 0.5;
      ctx.beginPath();
      ctx.moveTo(ox + 0.5, plotY);
      ctx.lineTo(ox + 0.5, plotY + plotH);
      ctx.stroke();
      ctx.globalAlpha = 1;
      ctx.fillStyle = CLASS_COLOUR[o.klass];
      ctx.fillRect(ox - 1, y + laneH - 6 - o.strength * 8, 3, 4 + o.strength * 8);
    }

    for (const [key, colour] of [['thresh', ACCENT], ['flux', FG]] as const) {
      ctx.strokeStyle = colour;
      ctx.lineWidth = 1;
      ctx.beginPath();
      let started = false;
      for (const s of this.hist) {
        if (s.t < t0) continue;
        const vy = py(key === 'flux' ? s.flux : s.thresh);
        if (!started) { ctx.moveTo(px(s.t), vy); started = true; }
        else ctx.lineTo(px(s.t), vy);
      }
      ctx.stroke();
    }

    // Legend and per-class tally over the visible window — the counts are what
    // says "kicks report zero" without waiting for the HUD to update.
    const counts: Record<OnsetClass, number> = { kick: 0, snare: 0, hat: 0, tonal: 0 };
    for (const o of this.onsets) if (o.time >= t0) counts[o.klass]++;
    let lx = x;
    const legendY = plotY + plotH + 1;
    for (const k of ['kick', 'snare', 'hat', 'tonal'] as const) {
      ctx.fillStyle = CLASS_COLOUR[k];
      ctx.fillRect(lx, legendY + 4, 6, 6);
      ctx.fillStyle = counts[k] ? FG : DIM;
      const label = `${k} ${counts[k]}`;
      ctx.fillText(label, lx + 9, legendY);
      lx += 12 + ctx.measureText(label).width;
    }
    ctx.fillStyle = DIM;
    ctx.textAlign = 'right';
    ctx.fillText(`peak ${peak.toFixed(3)} · ${PLOT_SEC}s`, x + w, legendY);
    ctx.textAlign = 'left';
  }

  private drawTimings(x: number, y: number, w: number, h: number, timings: readonly GpuTiming[]): void {
    void h;
    const ctx = this.ctx;
    if (timings.length === 0) {
      ctx.fillStyle = DIM;
      ctx.fillText('no timestamp-query, or no samples yet', x, y);
      return;
    }
    let total = 0;
    for (const t of timings) total += t.ms;
    // 8.33 ms is the 2K120 frame (§4.11). Colouring against it is the point —
    // a table of milliseconds with no budget beside it is just trivia.
    const scale = Math.max(total, 8.33);
    const barX = x + 110;
    const barW = w - 110 - 46;
    for (let i = 0; i < timings.length; i++) {
      const t = timings[i]!;
      const ty = y + i * 13;
      ctx.fillStyle = DIM;
      ctx.fillText(t.label.slice(0, 16), x, ty);
      ctx.fillStyle = LINE;
      ctx.fillRect(barX, ty + 2, barW, 7);
      ctx.fillStyle = LEFT_CH;
      ctx.fillRect(barX, ty + 2, barW * clamp01(t.ms / scale), 7);
      ctx.fillStyle = FG;
      ctx.textAlign = 'right';
      ctx.fillText(t.ms.toFixed(3), x + w, ty);
      ctx.textAlign = 'left';
    }
    const ty = y + timings.length * 13;
    ctx.fillStyle = total > 8.33 ? ACCENT : DIM;
    ctx.fillText('total / budget', x, ty);
    ctx.textAlign = 'right';
    ctx.fillText(`${total.toFixed(3)} / 8.33 ms`, x + w, ty);
    ctx.textAlign = 'left';
  }

  /**
   * What the viewer got, as opposed to what the GPU spent: delivered fps and
   * drops against the display rate, the rAF percentiles, preset-switch
   * latency, and a 1 ms-bin histogram of deltas with the display interval
   * marked — a bimodal histogram is judder that an fps average hides.
   */
  private drawPacing(x: number, y: number, w: number, r: FrameReadout | null, f: FlashDecision | null): void {
    const ctx = this.ctx;
    let row = 0;
    const line = (k: string, v: string, hot = false): void => {
      const ty = y + row * 13;
      ctx.fillStyle = DIM;
      ctx.fillText(k, x, ty);
      ctx.fillStyle = hot ? ACCENT : FG;
      ctx.fillText(v, x + 62, ty);
      row++;
    };
    if (r) {
      const hz = r.displayHz > 0 ? `${r.displayHz.toFixed(0)} Hz` : 'hz ?';
      line('fps', `${r.fps.toFixed(1)} / ${hz}   drops ${r.droppedWindow} (${r.droppedTotal} total)`, r.droppedWindow > 0);
      line('rAF ms', `p50 ${ms(r.p50)}  p95 ${ms(r.p95)}  p99 ${ms(r.p99)}  max ${ms(r.maxMs)}`);
      line('work ms', `render ${ms(r.renderMeanMs)}/${ms(r.renderP95Ms)}  gpu ${ms(r.gpuMeanMs)}/${ms(r.gpuP95Ms)}`);
      line('switch', Number.isFinite(r.ttffMs)
        ? `first frame ${ms(r.ttffMs)} ms  (worst ${ms(r.ttffMaxMs)})`
        : 'no preset switch measured');

      const hy = y + row * 13 + 2;
      const hh = 24;
      let peak = 1;
      for (let i = 0; i < HISTOGRAM_BINS; i++) peak = Math.max(peak, r.histogram[i] ?? 0);
      const bw = w / HISTOGRAM_BINS;
      ctx.fillStyle = LINE;
      ctx.fillRect(x, hy, w, hh);
      ctx.fillStyle = LEFT_CH;
      for (let i = 0; i < HISTOGRAM_BINS; i++) {
        const v = r.histogram[i] ?? 0;
        if (v === 0) continue;
        // sqrt scale: the drop tail is a handful of frames next to thousands.
        const bh = Math.max(1, Math.sqrt(v / peak) * hh);
        ctx.fillStyle = i === HISTOGRAM_BINS - 1 ? ACCENT : LEFT_CH;
        ctx.fillRect(x + i * bw, hy + hh - bh, Math.max(1, bw - 1), bh);
      }
      if (r.displayHz > 0) {
        const vx = x + Math.min(1, 1000 / r.displayHz / HISTOGRAM_BINS) * w;
        ctx.fillStyle = FG;
        ctx.fillRect(Math.round(vx), hy, 1, hh);
      }
      row += 2;
      y += 6;
    }
    if (f) {
      const state = f.mode === 'off' ? 'off' : f.limited ? `LIMITING  blend ${f.blend.toFixed(2)}` : `on  blend ${f.blend.toFixed(2)}`;
      line('flash', `${f.mode}: ${state}  ${f.flashRate.toFixed(1)}/s  red ${f.redFlashRate.toFixed(1)}/s`, f.limited);
    }
  }

  // -- helpers --------------------------------------------------------------

  /** Octave-ish gridlines, so a log axis is readable as frequencies rather than as a smear. */
  private freqGrid(x: number, y: number, w: number, h: number, nyquist: number): void {
    const ctx = this.ctx;
    ctx.strokeStyle = 'rgba(255,255,255,.06)';
    ctx.fillStyle = 'rgba(138,138,160,.7)';
    for (const f of [100, 1000, 10000]) {
      if (f >= nyquist) continue;
      const gx = Math.round(x + logX(f, nyquist) * w) + 0.5;
      ctx.beginPath();
      ctx.moveTo(gx, y);
      ctx.lineTo(gx, y + h);
      ctx.stroke();
      ctx.fillText(f >= 1000 ? `${f / 1000}k` : `${f}`, gx + 2, y + h - 12);
    }
  }

  private ensureGram(rows: number, specN: number, nyquist: number): ImageData | null {
    const key = `${rows}:${specN}:${nyquist}`;
    if (this.gramKey === key && this.gramImg) return this.gramImg;
    const c = this.gram ?? document.createElement('canvas');
    c.width = rows;
    c.height = GRAM_ROWS;
    const cx = c.getContext('2d');
    if (!cx) return null;
    this.gram = c;
    this.gramCtx = cx;
    this.gramImg = cx.createImageData(rows, GRAM_ROWS);
    // Precomputed log-frequency lookup. The engine's spectrogram is linear in
    // bin index, which puts the bottom octave in one row and the top octave in
    // half the panel — the wrong shape for music (§6).
    const bins = new Int32Array(GRAM_ROWS);
    for (let r = 0; r < GRAM_ROWS; r++) {
      const u = 1 - r / (GRAM_ROWS - 1);           // row 0 is the top = highest frequency
      const f = F_MIN * Math.pow(nyquist / F_MIN, u);
      bins[r] = Math.min(specN - 1, Math.max(0, Math.round((f / nyquist) * specN)));
    }
    this.gramBins = bins;
    this.gramKey = key;
    return this.gramImg;
  }
}

/** Position of `freq` on a log axis running F_MIN..nyquist, 0..1. */
function logX(freq: number, nyquist: number): number {
  if (freq <= F_MIN) return 0;
  return Math.min(1, Math.log(freq / F_MIN) / Math.log(nyquist / F_MIN));
}

/**
 * Magnitude ramp for the spectrogram: near-black, violet, hot pink, amber,
 * white. Interpolated in sRGB, deliberately — art-direction §2.1's OKLCH rule
 * is about gradients the audience sees, and this one is a heat map that has to
 * be cheap enough to evaluate 32k times a frame.
 */
const RAMP: readonly (readonly [number, number, number, number])[] = [
  [0.00, 6, 6, 16],
  [0.30, 52, 22, 84],
  [0.60, 255, 61, 129],
  [0.85, 255, 209, 102],
  [1.00, 255, 255, 240],
];

function heat(v: number, out: Uint8ClampedArray, o: number): void {
  const t = clamp01(v);
  let i = 0;
  while (i < RAMP.length - 2 && t > (RAMP[i + 1]![0])) i++;
  const a = RAMP[i]!;
  const b = RAMP[i + 1]!;
  const span = b[0] - a[0];
  const k = span > 0 ? (t - a[0]) / span : 0;
  out[o] = a[1] + (b[1] - a[1]) * k;
  out[o + 1] = a[2] + (b[2] - a[2]) * k;
  out[o + 2] = a[3] + (b[3] - a[3]) * k;
  out[o + 3] = 255;
}

function clamp01(v: number): number { return v < 0 ? 0 : v > 1 ? 1 : v; }
function clampSigned(v: number): number { return v < -1 ? -1 : v > 1 ? 1 : v; }
function signed(v: number): string { return (v >= 0 ? '+' : '') + v.toFixed(3); }
function ms(v: number): string { return Number.isFinite(v) ? v.toFixed(1) : '-'; }
