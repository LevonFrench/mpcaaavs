// The 16-step trigger lane.
//
// A step sequencer is a clock problem before it is a UI problem, and aaavs
// already solved the clock: `Timeline` is the 240-slot-per-beat musical grid
// and `Scheduler` (timeline.ts) turns a division into a monotonic tick index
// that survives a seek, a pause and a tempo change. So this file introduces NO
// time source of its own. There is no `setInterval` here, no `performance.now`,
// and no accumulator counting frames — a 1/16 step is `SLOTS_PER_BEAT / 4 = 60`
// slots and the scheduler already knows what that means.
//
// The lane owns its own `Scheduler` instance rather than sharing the layer one,
// exactly the way `PresetDirector` does (director.ts). That keeps the tick
// cursor independent of preset churn: `rebuildRequests()` in main.ts replaces
// the layer request array wholesale on every preset load, and a lane whose
// cursor lived in that array would silently restart mid-track.
//
// What a fired step DOES is not this file's business. A step resolves to a
// PARAMETER id from the shared registry (`src/params/`) and goes out through
// the same dispatcher a MIDI note uses (`InputMappings.dispatch`, which is
// itself one call into that registry), so "next preset" means one thing in this
// program and not two. Nothing below knows what a kaleidoscope is.

import type { Timeline } from '../contracts.ts';
import { Scheduler, type ScheduleRequest } from '../timeline.ts';
import type { InputEvent } from '../input/events.ts';
import { paramInputTargets, type InputTarget } from '../input/mappings.ts';
import { PRESET_PARAM_GROUP } from '../params/descriptor.ts';
import type { ParamRegistry } from '../params/registry.ts';

/** One bar of sixteenths. The grid is a bar wide because the bar is the unit the directors already cut on. */
export const STEPS_PER_BAR = 16;

const STORAGE_KEY = 'aaavs.sequencer.lanes.v1';
const DEFAULT_LANE_COUNT = 4;

/**
 * One row of the grid.
 *
 * `target` is a parameter id from the shared registry (`src/params/`) — the
 * SAME namespace a MIDI binding stores, so the two surfaces cannot drift apart
 * and a lane pointing at a parameter that no longer exists is detectable rather
 * than mysterious. `amount` is the 0..1 value handed to that target when the step
 * fires; a continuous target reads it as its own knob position and a trigger
 * target ignores it, which is the same contract the wire has.
 */
export interface StepLane {
  channel: string;
  steps: boolean[];
  target: string;
  amount: number;
}

/** What fired on one 1/16 boundary. Emitted for the grid's playhead and for tests. */
export interface SequencerStepEvent {
  /** 0..15, position within the bar. */
  readonly step: number;
  /** Monotonic 1/16 index since slot 0. `Math.floor(tick / 16)` is the bar. */
  readonly tick: number;
  /** Audio-clock time the step LANDS (not the time it fired — see `Scheduler`). */
  readonly time: number;
  /** Lanes whose step was on. Empty is normal and is not an error: it is a rest. */
  readonly fired: readonly StepLane[];
}

/**
 * The subset of `InputMappings` a lane needs.
 *
 * Structural, not a class reference, so the lane can be driven by a stub in a
 * test without standing up MIDI, OSC and a panel. It is only the WRITE half:
 * what can be written is `ParamRegistry`, which the lane reads directly.
 */
export interface LiveTargetDispatcher {
  dispatch(targetId: string, value: number, event: InputEvent): boolean;
}

export interface SequencerLanesOptions {
  /**
   * The single parameter list. The lane's dropdown is this registry projected,
   * so a parameter declared once shows up here without editing `grid.ts` — the
   * same list the MIDI panel and the AVS inspector read.
   */
  readonly registry: ParamRegistry;
  readonly dispatcher: LiveTargetDispatcher;
  readonly laneCount?: number;
  /** Target a fresh lane points at. Should be the explicit rest parameter. */
  readonly defaultTarget?: string;
  /** Called after any edit that changed persisted state. */
  readonly onChange?: (reason: SequencerChangeReason) => void;
  /** Called on every 1/16 boundary, fired or not, so a playhead can move. */
  readonly onStep?: (event: SequencerStepEvent) => void;
}

/**
 * The one request. `1/16` is the division; everything else is the identity
 * setting, matching the single-request lane in `director.ts`.
 *
 * Zero envelope and a `start` anchor mean the only lead the scheduler adds is
 * the hardware output latency — which is right: a step is a cut, not a
 * 200 ms swell that has to peak on the beat.
 */
const STEP_REQUEST: ScheduleRequest = {
  key: 'sequencer.16',
  trigger: { division: '1/16', euclidK: 1, euclidN: 1, probability: 1, offsetSteps: 0 },
  anchor: 'start',
  envelope: { attackBeats: 0, holdBeats: 0, releaseBeats: 0 },
};

function emptySteps(): boolean[] {
  return new Array<boolean>(STEPS_PER_BAR).fill(false);
}

function clamp01(value: number): number {
  return value < 0 ? 0 : value > 1 ? 1 : value;
}

interface StoredLane {
  readonly channel?: unknown;
  readonly steps?: unknown;
  readonly target?: unknown;
  readonly amount?: unknown;
}

/**
 * Read persisted lanes, repairing rather than rejecting.
 *
 * A stored grid is a performer's work; refusing the whole file because one row
 * has fifteen steps would throw away the other three. Every field falls back
 * independently and the step array is padded/truncated to sixteen.
 */
function readStored(): StepLane[] | null {
  let raw: string | null = null;
  try { raw = localStorage.getItem(STORAGE_KEY); }
  catch { return null; }
  if (!raw) return null;
  try {
    const parsed: unknown = JSON.parse(raw);
    if (!Array.isArray(parsed)) return null;
    const out: StepLane[] = [];
    for (const entry of parsed as StoredLane[]) {
      if (typeof entry !== 'object' || entry === null) continue;
      const steps = emptySteps();
      if (Array.isArray(entry.steps)) {
        for (let i = 0; i < STEPS_PER_BAR; i++) steps[i] = entry.steps[i] === true;
      }
      out.push({
        channel: typeof entry.channel === 'string' ? entry.channel : `lane ${out.length + 1}`,
        steps,
        target: typeof entry.target === 'string' ? entry.target : '',
        amount: typeof entry.amount === 'number' && Number.isFinite(entry.amount) ? clamp01(entry.amount) : 1,
      });
    }
    return out.length ? out : null;
  } catch {
    return null;
  }
}

/**
 * N lanes on one 1/16 grid.
 *
 * Determinism: what a step is, is a pure function of the tick index, and the
 * tick index is a pure function of the timeline. There is no internal counter
 * that could drift, so `reset()` (called from the transport reset in main.ts)
 * puts the lane back to a known state and the first poll after it deliberately
 * fires nothing — the scheduler's priming behaviour, which is what stops a seek
 * from dumping the whole skipped gap into one frame.
 */
/**
 * What an edit touched.
 *
 * `'value'` means the control the performer is touching already shows the new
 * value, so the panel must NOT rebuild its rows: replacing an `<input
 * type=range>` mid-drag drops its implicit pointer capture and the slider stops
 * following the pointer after the first movement. `'layout'` means rows changed
 * structurally and a rebuild is the only correct response.
 */
export type SequencerChangeReason = 'layout' | 'value';

export class SequencerLanes {
  private readonly scheduler = new Scheduler();
  private readonly registry: ParamRegistry;
  private readonly dispatcher: LiveTargetDispatcher;
  private readonly onChange: (reason: SequencerChangeReason) => void;
  private readonly onStep: (event: SequencerStepEvent) => void;
  private readonly list: StepLane[];
  private step = -1;

  /** Master switch. Off means the playhead still moves but nothing dispatches. */
  enabled = true;

  constructor(options: SequencerLanesOptions) {
    this.registry = options.registry;
    this.dispatcher = options.dispatcher;
    this.onChange = options.onChange ?? ((): void => {});
    this.onStep = options.onStep ?? ((): void => {});

    const count = Math.max(1, Math.round(options.laneCount ?? DEFAULT_LANE_COUNT));
    const fallback = options.defaultTarget ?? '';
    // `laneCount` is the shape of the grid and the stored file is its content,
    // so the count wins: extra stored rows are dropped and missing ones are
    // padded, the same repair `readStored` applies to a row's sixteen steps.
    // Without this a grid persisted at four lanes could never grow to five.
    const stored = readStored() ?? [];
    this.list = Array.from({ length: count }, (_unused, i): StepLane => stored[i] ?? {
      channel: `lane ${i + 1}`,
      steps: emptySteps(),
      target: fallback,
      amount: 1,
    });
  }

  get lanes(): readonly StepLane[] {
    return this.list;
  }

  /**
   * Rows for the grid's per-lane dropdown. Never a hard-coded list, and never a
   * second projection of the registry: this is the same `paramInputTargets`
   * the MIDI panel lists, so the two surfaces cannot offer different sets.
   */
  get targets(): readonly InputTarget[] {
    return paramInputTargets(this.registry);
  }

  /** 0..15, or -1 before the first step of this transport position. */
  get currentStep(): number {
    return this.step;
  }

  /** Output latency compensation, mirroring the layer scheduler (`director.ts`). */
  set outputLatency(value: number) {
    this.scheduler.outputLatency = value;
  }

  /**
   * Does the grid own preset changes right now?
   *
   * True when an enabled lane has at least one step on and points at a
   * preset-changing parameter. main.ts reads this to hold the automatic
   * directors off — see the precedence rule documented at the call site.
   *
   * "Preset-changing" is the descriptor's own `group`, not a list of ids kept
   * here: adding a fourth way to change the preset means declaring it in that
   * group, and this answer follows without an edit.
   */
  get ownsPresetChanges(): boolean {
    if (!this.enabled) return false;
    return this.list.some((lane) =>
      this.registry.descriptor(lane.target)?.group === PRESET_PARAM_GROUP
      && lane.steps.some((on) => on));
  }

  /** Flush grid state (§4.10). Called from the transport reset, never on pause. */
  reset(): void {
    this.scheduler.reset();
    this.step = -1;
  }

  /**
   * Poll the grid. Call once per frame with the SAME timeline and the same
   * audio-clock `now` the layer scheduler is polled with.
   *
   * Nothing fires before tempo lock, because `Scheduler.due` returns nothing
   * while `timeline.bpm(now)` is 0. That is deliberate and not a fallback
   * candidate: a 16-step lane running against an assumed 120 BPM would place
   * cuts on a grid the music is not on, and would then jump when the real tempo
   * arrived.
   *
   * A backlog collapses to its last tick. If a stalled tab hands back thirty
   * queued sixteenths, firing all thirty means flashing through thirty presets;
   * the last one is the state the grid would have reached anyway. This is the
   * same rule `PresetDirector.update` applies to its own backlog.
   */
  update(timeline: Timeline, now: number): void {
    const fired = this.scheduler.due(timeline, now, STEP_REQUEST);
    const latest = fired.at(-1);
    if (!latest) return;

    const step = ((latest.tick % STEPS_PER_BAR) + STEPS_PER_BAR) % STEPS_PER_BAR;
    this.step = step;

    const hit: StepLane[] = [];
    if (this.enabled) {
      for (let i = 0; i < this.list.length; i++) {
        const lane = this.list[i]!;
        if (!lane.target || !lane.steps[step]) continue;
        hit.push(lane);
        // The fabricated event is a first-class `InputEvent`: the target sees a
        // step and a pad as the same thing, and the panel's "last event" line
        // can describe it without a special case.
        this.dispatcher.dispatch(lane.target, lane.amount, {
          source: 'step',
          kind: 'trigger',
          channel: 0,
          id: `${i + 1}.${step + 1}`,
          value: lane.amount,
          raw: latest.tick,
          // The audio-clock time the step lands, in ms. NOT `performance.now()`:
          // this module has no wall clock, and a step's arrival IS its landing
          // time. See `InputEvent.atMs` for why the base differs per source.
          atMs: latest.time * 1000,
        });
      }
    }

    this.onStep({ step, tick: latest.tick, time: latest.time, fired: hit });
  }

  toggleStep(laneIndex: number, step: number): void {
    const lane = this.list[laneIndex];
    if (!lane || step < 0 || step >= STEPS_PER_BAR) return;
    lane.steps[step] = !lane.steps[step];
    this.persist();
    this.onChange('value');
  }

  setTarget(laneIndex: number, targetId: string): void {
    const lane = this.list[laneIndex];
    if (!lane || lane.target === targetId) return;
    lane.target = targetId;
    this.persist();
    this.onChange('value');
  }

  setAmount(laneIndex: number, amount: number): void {
    const lane = this.list[laneIndex];
    if (!lane) return;
    lane.amount = clamp01(amount);
    this.persist();
    this.onChange('value');
  }

  clearLane(laneIndex: number): void {
    const lane = this.list[laneIndex];
    if (!lane || !lane.steps.some((on) => on)) return;
    lane.steps = emptySteps();
    this.persist();
    this.onChange('layout');
  }

  clearAll(): void {
    for (const lane of this.list) lane.steps = emptySteps();
    this.persist();
    this.onChange('layout');
  }

  /** Persist now. Public because the grid has no other reason to reach in. */
  persist(): void {
    try { localStorage.setItem(STORAGE_KEY, JSON.stringify(this.list)); }
    catch {
      // Storage denied. The grid still works for this session.
    }
  }
}
