import { TempoTracker } from './clock.ts';
import { MpcTempoEstimator } from './mpc-tempo-estimator.ts';

export interface TimedAudioFrame { time: number; pcm: Float32Array }

/** Media-clock scheduler. Four tracked beats per bar; never invents a tempo. */
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
  energy = 0;
  reset() { this.tempo.reset(); this.estimator.reset(); this.last = -1; this.lastSample = -1; this.audible = -Infinity; this.energy = 0; this.rearm(); }
  rearm() { this.target = Infinity; this.previousBar = -1; this.armedAt = NaN; this.preparationStarted = false; }
  configure(enabled: boolean, bars: number) {
    if (enabled !== this.enabled || bars !== this.bars) this.rearm();
    this.enabled = enabled; this.bars = [2, 4, 8, 12].includes(bars) ? bars : 0;
  }
  update(position: number, playing: boolean, pcm: Float32Array, frames?: readonly TimedAudioFrame[], discontinuity = false): { prepare: boolean; switch: boolean } {
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
    return this.grid((this.tempo.beatIndex + this.tempo.phase) / 4, this.tempo.locked && position - this.audible < 1.5);
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

  /** Public for deterministic scheduler checks independent of audio estimation. */
  grid(bar: number, trusted: boolean) {
    if (!this.enabled || !trusted) { this.rearm(); return { prepare: false, switch: false }; }
    if (!Number.isFinite(this.target)) this.armedAt = bar;
    if (!this.preparationStarted) {
      const phrase = this.bars || Math.round(12 - 10 * Math.max(0, Math.min(1, this.energy)));
      // Whole bar boundary, at least two elapsed bars and no more than twelve.
      this.target = Math.min(Math.floor(this.armedAt + 12), Math.ceil(this.armedAt + phrase));
      if (bar >= this.target - 1) this.preparationStarted = true;
    }
    const boundary = Math.floor(bar) !== this.previousBar;
    this.previousBar = Math.floor(bar);
    return { prepare: bar >= this.target - 1, switch: boundary && bar >= this.target };
  }
  get remainingBars() { return Number.isFinite(this.target) ? Math.max(0, this.target - this.previousBar) : null; }
}
