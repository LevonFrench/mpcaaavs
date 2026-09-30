import { TempoTracker } from './clock.ts';
import { MpcTempoEstimator } from './mpc-tempo-estimator.ts';

export interface TimedAudioFrame { time: number; pcm: Float32Array }

/** Media-clock scheduler. Tracked beats per bar default to four (the saved clock may set another meter); never invents a tempo. */
export class MpcAutoDirector {
  enabled = true;
  bars = 0;
  // Musical continuity: a fill or short breakdown must not replace the song clock.
  readonly tempo = new TempoTracker({ coastBeats: 16, recency: .9, tempoGain: .12, changeEvidence: 8 });
  private estimator = new MpcTempoEstimator();
  private last = -1;
  private lastSample = -1;
  private armedAt = NaN;
  private preparationStarted = false;
  private audible = -Infinity;
  private target = Infinity;
  private previousBar = -1;
  private pinned = NaN;
  private meter = 4;
  energy = 0;
  /** Beats per bar of the live grid (1..16, default 4). Changing it re-arms the phrase, since bars are measured in this unit. */
  get beatsPerBar() { return this.meter; }
  set beatsPerBar(value: number) { const next = Number.isInteger(value) && value >= 1 && value <= 16 ? value : 4; if (next !== this.meter) { this.meter = next; this.rearm(); } }
  reset() { this.tempo.reset(); this.estimator.reset(); this.last = -1; this.lastSample = -1; this.audible = -Infinity; this.energy = 0; this.rearm(); }
  /** Start a new phrase. `origin` (a bar position) pins the next phrase to the true boundary of the phrase that just ended: after an early
   * switch (`leadBars` > 0) the host passes `targetBar`, so the next target is `origin` plus one phrase rather than measured from the early
   * commit, and consecutive phrases stay exact multiples. The pin is discarded when it is not within twelve bars of the bar it meets. */
  rearm(origin?: number) { this.target = Infinity; this.previousBar = -1; this.armedAt = NaN; this.preparationStarted = false; this.pinned = origin !== undefined && Number.isFinite(origin) ? origin : NaN; }
  configure(enabled: boolean, bars: number) {
    if (enabled !== this.enabled || bars !== this.bars) this.rearm();
    this.enabled = enabled; this.bars = [2, 4, 8, 12].includes(bars) ? bars : 0;
  }
  update(position: number, playing: boolean, pcm: Float32Array, frames?: readonly TimedAudioFrame[], discontinuity = false, leadBars = 0): { prepare: boolean; switch: boolean } {
    if (!Number.isFinite(position) || !playing || position === this.last) return { prepare: false, switch: false };
    if (this.last >= 0 && (position < this.last || position - this.last > .75)) this.reset();
    else if (discontinuity) {
      // A producer/consumer drop is not a seek. Retain the measured beat grid and
      // phrase target; discard only detector history that straddles missing PCM.
      this.estimator.gap();
    }
    this.last = position;
    for (const frame of frames ?? [{ time: position, pcm }]) {
      if (!Number.isFinite(frame.time) || frame.time > position || position - frame.time >= .25 || frame.time <= this.lastSample || frame.pcm.length !== 1152) continue;
      this.analyse(frame.time, frame.pcm);
    }
    this.tempo.update(position);
    return this.grid((this.tempo.beatIndex + this.tempo.phase) / this.meter, this.tempo.locked && position - this.audible < 1.5, leadBars);
  }
  private analyse(position: number, pcm: Float32Array) {
    const dt = this.lastSample < 0 ? 1 / 30 : Math.max(0, Math.min(.25, position - this.lastSample));
    this.lastSample = position;
    let power = 0; for (const sample of pcm) power += sample * sample;
    const rms = Math.sqrt(power / pcm.length);
    if (rms > .004) this.audible = position;
    this.energy += (Math.min(1, rms * 4) - this.energy) * (1 - Math.exp(-dt / .539));
    const estimate = this.estimator.push(position, pcm);
    if (estimate) this.tempo.observeTempo(position, estimate.bpm, estimate.confidence, estimate.anchor);
  }

  /** Public for deterministic scheduler checks independent of audio estimation.
   * `leadBars` (default 0) starts the change that many bars before the phrase boundary, so a fade can end on it: `prepare` from
   * `target - 1 - leadBars`, `switch` from `target - leadBars` and level-triggered until the host re-arms with `rearm(targetBar)`. */
  grid(bar: number, trusted: boolean, leadBars = 0) {
    if (!this.enabled || !trusted) { this.rearm(); return { prepare: false, switch: false }; }
    if (!Number.isFinite(this.target)) this.armedAt = Number.isFinite(this.pinned) && Math.abs(this.pinned - bar) <= 12 ? this.pinned : bar;
    if (!this.preparationStarted) {
      const phrase = this.bars || Math.round(12 - 10 * Math.max(0, Math.min(1, this.energy)));
      // Whole bar boundary, at least two elapsed bars and no more than twelve.
      this.target = Math.min(Math.floor(this.armedAt + 12), Math.ceil(this.armedAt + phrase));
    }
    // A lead never reaches back past one bar after the phrase was armed: a fade as long as the phrase would otherwise switch on every bar.
    const lead = Number.isFinite(leadBars) && leadBars > 0 ? Math.min(leadBars, this.target - this.armedAt - 1) : 0;
    if (!this.preparationStarted && bar >= this.target - 1 - lead) this.preparationStarted = true;
    const boundary = Math.floor(bar) !== this.previousBar;
    this.previousBar = Math.floor(bar);
    return { prepare: bar >= this.target - 1 - lead, switch: lead > 0 ? this.preparationStarted && bar >= this.target - lead : boundary && bar >= this.target };
  }
  /** The bar position of the current phrase boundary, or null before the phrase is armed. Pass it to `rearm` after an early switch. */
  get targetBar() { return Number.isFinite(this.target) ? this.target : null; }
  get remainingBars() { return Number.isFinite(this.target) ? Math.max(0, this.target - this.previousBar) : null; }
}
