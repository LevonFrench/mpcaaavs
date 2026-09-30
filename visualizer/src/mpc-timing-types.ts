/** Types-only seed shared by the worker protocol, the scene clock, NERV scenes and the HUD engine.
 * No runtime code and no imports, so the protocol can name timing shapes before their owners exist
 * (docs/design/CONTRACT.md C-12 and 2.4). mpc-beat-grid.ts re-exports ClockGrid and TimingSignals,
 * nerv-scenes.ts re-exports ClockGrid as NervClockGrid, and hud-clock.ts re-exports the HUD shapes. */

/** A saved musical grid: beat zero at `offset` seconds, constant `bpm`, optional tempo changes (at most 256 pairs). */
export interface ClockGrid { readonly offset: number; readonly beatsPerBar: number; readonly bpm: number; readonly changes?: readonly (readonly [at: number, bpm: number])[] }
/** The scene interval [start, end) in absolute media seconds, with progress 0..1 and remaining/elapsed seconds at the frame's time (TIM 5.4). */
export interface IntervalSignals { readonly start: number; readonly end: number; readonly progress: number; readonly remaining: number; readonly elapsed: number }
/** Pure per-frame musical signals derived from a grid, or from the legacy tempo when no grid exists. */
export interface TimingSignals { readonly beat: number; readonly sceneBeat: number; readonly bar: number; readonly beatInBar: number; readonly beatPhase: number;
  readonly barPhase: number; readonly beatsPerBar: number; readonly interval: IntervalSignals | null }
/** Live or clocked tempo as the HUD engine sees it. */
export interface HudTempo { readonly bpm: number; readonly beatIndex: number; readonly beatPhase: number; readonly locked: boolean }
/** Track position and (when the host knows it) duration, in seconds. */
export interface HudTrack { readonly position: number; readonly duration: number | null }
/** A named interval from the saved scene timing (`id` matches ^[a-z0-9_-]{1,32}$). */
export interface HudNamedInterval { readonly id: string; readonly start: number; readonly end: number }
