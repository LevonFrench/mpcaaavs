// The 16-step trigger lane, assembled.
//
// One engine (`lane.ts`), one panel (`grid.ts`), and nothing else. The engine
// never touches the DOM and the panel never touches a clock; this file is the
// only place that knows both exist.
//
// Like the live-input bus, this subsystem starts nothing the performer did not
// ask for: an empty grid dispatches nothing, and the panel is hidden until S.

import { SequencerLanes, type SequencerLanesOptions } from './lane.ts';
import { SequencerGrid } from './grid.ts';

export { SequencerLanes, STEPS_PER_BAR } from './lane.ts';
export type { StepLane, SequencerStepEvent, SequencerChangeReason, LiveTargetDispatcher } from './lane.ts';
export { SequencerGrid } from './grid.ts';

export interface SequencerOptions extends Omit<SequencerLanesOptions, 'onChange' | 'onStep'> {
  readonly host?: HTMLElement;
  /** Is the AVS lane rendering? Greys out native-only targets. See `SequencerGridOptions`. */
  readonly isAvsLaneActive?: () => boolean;
}

export interface Sequencer {
  readonly lanes: SequencerLanes;
  readonly grid: SequencerGrid;
  /** Poll the grid. Call once per frame with the audio clock. */
  update: SequencerLanes['update'];
  /** Output latency compensation, mirroring the layer scheduler. */
  setOutputLatency(seconds: number): void;
  /** Flush grid state on seek / track change (§4.10). */
  reset(): void;
  /** Re-grey native-only targets after the rendering lane changed. */
  refreshLaneAvailability(): void;
  dispose(): void;
}

export function createSequencer(options: SequencerOptions): Sequencer {
  // `grid` is assigned after `lanes` because the engine's callbacks need it and
  // the panel needs the engine. Both callbacks only ever fire later.
  let grid: SequencerGrid | null = null;
  const { host, isAvsLaneActive, ...laneOptions } = options;
  const lanes = new SequencerLanes({
    ...laneOptions,
    onChange: (reason) => grid?.notify(reason),
    onStep: (event) => grid?.setStep(event.step),
  });
  grid = new SequencerGrid({
    lanes,
    ...(host ? { host } : {}),
    ...(isAvsLaneActive ? { isAvsLaneActive } : {}),
  });

  const panel = grid;
  return {
    lanes,
    grid: panel,
    update: (timeline, now) => lanes.update(timeline, now),
    setOutputLatency(seconds: number): void { lanes.outputLatency = seconds; },
    reset(): void {
      lanes.reset();
      panel.setStep(-1);
    },
    refreshLaneAvailability(): void { panel.refreshLaneAvailability(); },
    dispose(): void { panel.dispose(); },
  };
}
