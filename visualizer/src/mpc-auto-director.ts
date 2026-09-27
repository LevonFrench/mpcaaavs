import { TempoTracker } from './clock.ts';
import { AvsAudioAnalyser } from './avs/audio.ts';

/** Media-clock scheduler. Four tracked beats per bar; never invents a tempo. */
export class MpcAutoDirector {
  enabled = true;
  bars = 0;
  readonly tempo = new TempoTracker();
  private analyser = new AvsAudioAnalyser();
  private last = -1;
  private onset = -Infinity;
  private audible = -Infinity;
  private target = Infinity;
  private previousBar = -1;
  energy = 0;
  private level = .08;
  private previousRms = 0;
  reset() { this.tempo.reset(); this.analyser.reset(); this.last = -1; this.onset = -Infinity; this.audible = -Infinity; this.energy = 0; this.level = .08; this.previousRms = 0; this.rearm(); }
  rearm() { this.target = Infinity; this.previousBar = -1; }
  configure(enabled: boolean, bars: number) {
    if (enabled !== this.enabled || bars !== this.bars) this.rearm();
    this.enabled = enabled; this.bars = [2, 4, 8, 12].includes(bars) ? bars : 0;
  }
  update(position: number, playing: boolean, pcm: Float32Array): { prepare: boolean; switch: boolean } {
    if (!Number.isFinite(position) || !playing || position === this.last) return { prepare: false, switch: false };
    if (this.last >= 0 && (position < this.last || position - this.last > .75)) this.reset();
    this.last = position;
    let power = 0; for (const sample of pcm) power += sample * sample;
    const rms = Math.sqrt(power / pcm.length);
    if (rms > .004) this.audible = position;
    this.energy += (Math.min(1, rms * 4) - this.energy) * .06;
    // Normalize only the scheduler detector, preserving preset audio and quiet-track transients.
    this.level += (rms - this.level) * .025;
    const gain = Math.min(8, .3 / Math.max(.02, this.level));
    const analysisPcm = pcm.map(value => Math.max(-1, Math.min(1, value * gain)));
    const audio = this.analyser.analyse({ left: analysisPcm.subarray(0, 576), right: analysisPcm.subarray(576) });
    // Ignore repeated high-level triggers on a sustained/decaying sound.
    if (audio.beat && rms > this.previousRms * 1.12 && position - this.onset >= .22 && rms > .008) { this.onset = position; this.tempo.addOnset(position); }
    this.previousRms = rms;
    this.tempo.update(position);
    return this.grid((this.tempo.beatIndex + this.tempo.phase) / 4, this.tempo.locked && position - this.audible < 1.5);
  }
  /** Public for deterministic scheduler checks independent of audio estimation. */
  grid(bar: number, trusted: boolean) {
    if (!this.enabled || !trusted) { this.rearm(); return { prepare: false, switch: false }; }
    if (!Number.isFinite(this.target)) this.target = Math.ceil(bar) + (this.bars || Math.round(12 - 10 * this.energy));
    const boundary = Math.floor(bar) !== this.previousBar;
    this.previousBar = Math.floor(bar);
    return { prepare: bar >= this.target - 1, switch: boundary && bar >= this.target };
  }
  get remainingBars() { return Number.isFinite(this.target) ? Math.max(0, this.target - this.previousBar) : null; }
}
