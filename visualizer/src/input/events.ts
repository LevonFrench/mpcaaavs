// The normalised live-input event.
//
// MIDI, OSC and (potentially) the keyboard are three wire formats for the same
// idea: something on a control surface moved, and it moved by a knowable
// amount. Rather than let each adapter grow its own vocabulary and force every
// consumer to learn all three, each adapter flattens to ONE payload shape here
// and the mapping table downstream only ever sees `InputEvent`.
//
// The normalisation rule is deliberately narrow: `value` is always 0..1, and
// `raw` carries whatever the wire actually said. A consumer that needs the
// original 7-bit number can have it; a consumer that just wants a knob position
// never has to know that MIDI counts to 127 and OSC usually does not.

/**
 * `note` and `cc` mirror the two MIDI messages worth mapping. `trigger` is for
 * a source that carries no value at all — a bare OSC address, a button press —
 * and always arrives with `value === 1`.
 */
export type InputEventKind = 'note' | 'cc' | 'trigger';

/**
 * `step` is the internal 16-step sequencer (`src/sequencer/`). It is a source
 * like any other precisely so a step and a MIDI note reach a target through
 * identical code — the lane fabricates one of these and hands it to the same
 * dispatcher the wire uses, rather than owning a second copy of the routing.
 */
export type InputSource = 'midi' | 'osc' | 'key' | 'step';

export interface InputEvent {
  readonly source: InputSource;
  readonly kind: InputEventKind;
  /** 1..16 for MIDI. 0 for sources that have no channel concept. */
  readonly channel: number;
  /** Note number / CC number for MIDI; the OSC address for OSC. */
  readonly id: number | string;
  /** 0..1, always. Velocity/127, CC/127, or 1 for a bare trigger. */
  readonly value: number;
  /** What the wire said, before normalisation. Absent for `trigger`. */
  readonly raw?: number;
  /**
   * Arrival time in ms, on the SOURCE's own clock: `performance.now()` for the
   * wire adapters (MIDI, OSC), the audio-clock landing time (`time * 1000`) for
   * a `step`, which never reads a wall clock. Not comparable across sources.
   * Display and diagnostics only — never a musical decision.
   */
  readonly atMs: number;
}

/** A listener that has been handed an event. Return value is ignored. */
export type EmitterListener<T> = (value: T) => void;

/**
 * The smallest emitter that is still safe to use.
 *
 * `subscribe` returns its own unsubscribe rather than exposing `off`, because
 * an unsubscribe that has to re-find the function by identity is the usual way
 * a listener leaks. A listener that throws is logged and skipped so one bad
 * consumer cannot stop the rest of the surface from receiving input.
 */
export class Emitter<T> {
  private readonly listeners = new Set<EmitterListener<T>>();

  subscribe(listener: EmitterListener<T>): () => void {
    this.listeners.add(listener);
    return () => { this.listeners.delete(listener); };
  }

  emit(value: T): void {
    // Copy first: a listener is allowed to unsubscribe itself while dispatching.
    for (const listener of [...this.listeners]) {
      try { listener(value); }
      catch (error) { console.warn('[aaavs] input listener failed:', error); }
    }
  }

  get size(): number {
    return this.listeners.size;
  }

  dispose(): void {
    this.listeners.clear();
  }
}

/** Convenience alias — the bus every adapter writes into. */
export type InputEmitter = Emitter<InputEvent>;

/** 7-bit MIDI value to 0..1. Kept in one place so the two adapters cannot disagree. */
export function normalize7bit(raw: number): number {
  return Math.min(1, Math.max(0, raw / 127));
}

export function clamp01(value: number): number {
  return value < 0 ? 0 : value > 1 ? 1 : value;
}

/**
 * The stable signature a mapping is keyed on.
 *
 * Note-off is folded into note-on (the kind is the same) so a pad binds once
 * and both edges reach the target. Velocity/value is deliberately NOT part of
 * the key — a mapping is to a control, not to a position of that control.
 */
export function inputEventKey(event: InputEvent): string {
  return `${event.source}:${event.kind}:${event.channel}:${event.id}`;
}

/** Human-readable form of an event key, for the mapping list. */
export function describeInputEvent(event: InputEvent): string {
  if (event.source === 'midi') {
    const what = event.kind === 'cc' ? `CC ${event.id}` : `note ${event.id}`;
    return `MIDI ch${event.channel} ${what}`;
  }
  if (event.source === 'osc') return `OSC ${event.id}`;
  if (event.source === 'step') return `step ${event.id}`;
  return `key ${event.id}`;
}
