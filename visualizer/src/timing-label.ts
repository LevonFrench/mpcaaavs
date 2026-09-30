/** Text of the top-right timing overlay (docs/design/TIMING-SYSTEM-V2.md 3.3, CONTRACT C-34).
 * `timingLabel` is a pure function of the operands of the host's former nested ternary, so with `fps`, `barBeat` and `resolution`
 * absent its output is byte-identical to that ternary (tools/check-timing-label.mjs keeps a verbatim oracle). The host writes the
 * result to `#timing` only when it changed. `FpsLabel` turns meter readings into the "60 fps" segment.
 */
import type { FpsReading } from './fps-meter.ts';

export interface FpsChannels {
  /** Frames actually composed to the canvas: the headline number. */
  present: FpsReading | null;
  /** requestAnimationFrame callbacks (detail mode). */
  display?: FpsReading | null;
  /** Accepted worker frames for the active slot (detail mode). */
  render?: FpsReading | null;
  /** Media clock messages that moved the position (detail mode). */
  clock?: FpsReading | null;
}

const rate = (value: number): string => value >= 999.5 ? '999+' : value >= 10 ? String(Math.round(value)) : value.toFixed(1);

/** The "60 fps" segment, refreshed at most every `refreshMs`. Integer at 10 fps or more, one decimal below, `999+` above.
 * A one-count wobble of the rounded value does not change the text (hysteresis), so the overlay does not flicker. */
export class FpsLabel {
  private text: string | null = null;
  private refreshedAt = -Infinity;
  private shown = NaN;
  constructor(private readonly refreshMs = 500) {}
  /** `mode` 0 off, 1 fps, 2 detail. Null when off, not playing, or the present meter has no fresh reading (the label then omits the segment). */
  segment(now: number, channels: FpsChannels, mode: 0 | 1 | 2, playing: boolean): string | null {
    const present = channels.present;
    if (!mode || !playing || !present || !Number.isFinite(present.fps)) { this.text = null; this.refreshedAt = -Infinity; this.shown = NaN; return null; }
    if (this.text !== null && now >= this.refreshedAt && now - this.refreshedAt < this.refreshMs) return this.text;
    const step = present.fps >= 10 ? 1 : .1;
    let value = present.fps >= 10 ? Math.round(present.fps) : Math.round(present.fps * 10) / 10;
    if (Number.isFinite(this.shown) && this.shown !== value && Math.abs(present.fps - this.shown) < step * .75 && (this.shown >= 10) === (present.fps >= 10)) value = this.shown;
    this.shown = value;
    const head = present.fps >= 999.5 ? '999+' : value >= 10 ? String(value) : value.toFixed(1);
    let text = `${head} fps`;
    if (mode === 2) {
      const parts: string[] = [];
      const { display, render, clock } = channels;
      if (display && rate(display.fps) !== head) parts.push(`display ${rate(display.fps)}`);
      if (render) parts.push(`render ${rate(render.fps)}`);
      if (clock) parts.push(`clock ${rate(clock.fps)} Hz`);
      if (parts.length) text += ` (${parts.join(' · ')})`;
    }
    this.text = text; this.refreshedAt = now;
    return text;
  }
}

/** One field per operand of the host's former nested ternary, plus the v2 additions. */
export interface TimingLabelInput {
  /** `director.enabled` */
  autoEnabled: boolean;
  /** `eligibleCount` */
  eligibleCount: number;
  /** A scene-clock frame exists (`clockPhase()` was not null). */
  clock: boolean;
  /** `sceneTiming.bpm` printed as is, or the instantaneous tempo of the frame. */
  sceneBpm: number;
  /** Whole bars left in the scene: the frame's `barsRemaining`. */
  clockBarsLeft: number;
  /** `playing` */
  playing: boolean;
  /** Name of the preset queued for the next boundary, or null. */
  queuedName: string | null;
  /** `sceneTiming.enabled` */
  clockEnabled: boolean;
  /** `sequenceSuspended` */
  sequenceSuspended: boolean;
  /** `director.tempo.locked` */
  tempoLocked: boolean;
  /** `director.energy` */
  energy: number;
  /** `director.tempo.bpm` */
  tempoBpm: number;
  /** `director.remainingBars` */
  remainingBars: number | null;
  /** `!!prepared?.bitmap` */
  ready: boolean;
  /** `loading` */
  loading: boolean;
  /** The `FpsLabel` segment, or null. Ignored while paused or with no eligible presets. */
  fps: string | null;
  /** 1-based bar and beat from the scene clock (`SceneClock.barBeat`), shown only on the scene clock. */
  barBeat: { bar: number; beat: number } | null;
  /** Render resolution text; the host supplies it only in `showFps === 2` detail mode (C-34). Placed beside the fps segment. */
  resolution?: string;
}

export const LABEL_NO_ELIGIBLE = 'Auto · no eligible presets — lower the shuffle rating or restore a preset';
export const LABEL_CLOCK_HELD = 'Scene clock held · activate setup or toggle Auto off/on to resume';

export function timingLabel(i: TimingLabelInput): string {
  // The frame rate is a playing-state reading: while paused the text already says so, and a stale rate would only mislead.
  const extra = [i.playing ? i.fps : null, i.resolution].filter((part): part is string => typeof part === 'string' && part.length > 0);
  const slot = extra.length ? ` · ${extra.join(' · ')}` : '';
  if (i.autoEnabled && !i.eligibleCount) return LABEL_NO_ELIGIBLE;
  if (i.clock) return `Scene clock · ${i.sceneBpm} BPM${slot}${i.barBeat ? ` · bar ${i.barBeat.bar}.${i.barBeat.beat}` : ''} · ${i.clockBarsLeft} bars · ${i.playing ? 'playing' : 'paused'}${i.queuedName !== null ? ` · queued ${i.queuedName}` : ''}`;
  if (i.clockEnabled && i.sequenceSuspended) return LABEL_CLOCK_HELD + slot;
  if (!i.autoEnabled) return `Auto off${slot}`;
  if (!i.playing) return 'Auto paused';
  if (!i.tempoLocked) return (i.energy < .001 ? 'Auto · waiting for audio signal' : 'Auto · listening for tempo') + slot;
  return `${Math.round(i.tempoBpm)} BPM${slot} · ${i.remainingBars === null ? 'waiting for music' : `${i.remainingBars} bars`} ${i.ready ? '· ready' : i.loading ? '· preparing' : ''}`;
}
