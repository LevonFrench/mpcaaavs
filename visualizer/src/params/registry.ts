// The one list.
//
// A descriptor (`descriptor.ts`) says what a parameter is. An accessor says
// where it lives. This file is the only place the two are paired, and it is
// therefore the only list of live parameters in the program: the MIDI mapping
// table (`src/input/mappings.ts`), the step lane's target dropdown
// (`src/sequencer/lane.ts`) and the AVS inspector's parameter form
// (`src/avs-editor.ts`) all read it rather than each carrying their own.
//
// The split between descriptor and accessor is what makes that possible. A
// descriptor is data and can be written next to the thing it describes; an
// accessor is a pair of closures over whatever plumbing that particular
// parameter needs — `patchParams` for a layer, `patchAvsEditorNodeFields` for
// an AVS payload byte, a plain field assignment for `post`. A registry that
// tried to describe the LOCATION instead of closing over it would have to know
// all three write paths, which is the framework this deliberately is not.
//
// One dispatcher. `set` is the only function that ever writes a parameter, so a
// step, a CC and a form submit are the same write by the time they land, and
// there is no second copy of "what does this control do" to drift from the
// first.

import {
  clampParam,
  paramFromUnit,
  paramToUnit,
  type ParamDescriptor,
  type ParamValue,
} from './descriptor.ts';

/**
 * Minimum spacing between two `reload`-cost writes, in ms.
 *
 * A `reload` write re-serialises an AVS preset and hands it back to the
 * renderer. A CC sweep is ~100 events a second and would queue a hundred
 * preset loads; a human pressing Apply never notices 120 ms. The last value
 * always lands, because the throttle is trailing-edge — a knob left at 0.7
 * ends at 0.7 and not at wherever the last unthrottled event happened to be.
 */
const RELOAD_MIN_INTERVAL_MS = 120;

export interface ParamAccessor {
  get(): ParamValue;
  /** Writes are fire-and-forget: a knob has no way to wait, and nothing reads a result. */
  set(value: ParamValue): void;
}

export interface ParamEntry {
  readonly descriptor: ParamDescriptor;
  readonly accessor: ParamAccessor;
}

/** Removes everything the matching `register`/`registerAll` call added. */
export type ParamUnregister = () => void;

export class ParamRegistry {
  private readonly entries = new Map<string, ParamEntry>();
  private readonly listeners = new Set<() => void>();
  private readonly lastWrite = new Map<string, number>();
  private readonly queued = new Map<string, ParamValue>();
  private flushTimer: ReturnType<typeof setTimeout> | null = null;
  private revision = 0;

  /**
   * Bumped on every add or removal, never on a value change.
   *
   * A surface caches its rendered rows against this rather than rebuilding per
   * frame: values move at MIDI rate, the LIST moves when an AVS preset loads.
   */
  get version(): number {
    return this.revision;
  }

  get size(): number {
    return this.entries.size;
  }

  /** Re-registering an id replaces it, which is how a reloaded preset keeps its bindings. */
  register(descriptor: ParamDescriptor, accessor: ParamAccessor): ParamUnregister {
    return this.registerAll([{ descriptor, accessor }]);
  }

  registerAll(entries: readonly ParamEntry[]): ParamUnregister {
    if (!entries.length) return (): void => {};
    for (const entry of entries) this.entries.set(entry.descriptor.id, entry);
    this.changed();
    let done = false;
    return (): void => {
      if (done) return;
      done = true;
      let removed = false;
      for (const entry of entries) {
        // Only remove what is still ours: a later `register` of the same id
        // owns it now, and dropping it here would delete a live parameter.
        if (this.entries.get(entry.descriptor.id) !== entry) continue;
        this.entries.delete(entry.descriptor.id);
        this.queued.delete(entry.descriptor.id);
        removed = true;
      }
      if (removed) this.changed();
    };
  }

  get(id: string): ParamEntry | undefined {
    return this.entries.get(id);
  }

  has(id: string): boolean {
    return this.entries.has(id);
  }

  descriptor(id: string): ParamDescriptor | undefined {
    return this.entries.get(id)?.descriptor;
  }

  /** Registration order, which is authoring order — the order a surface lists them in. */
  list(): readonly ParamEntry[] {
    return [...this.entries.values()];
  }

  groups(): readonly string[] {
    const seen: string[] = [];
    for (const entry of this.entries.values()) {
      const group = entry.descriptor.group ?? '';
      if (!seen.includes(group)) seen.push(group);
    }
    return seen;
  }

  byGroup(group: string): readonly ParamEntry[] {
    return [...this.entries.values()].filter((entry) => (entry.descriptor.group ?? '') === group);
  }

  /** Current value, or the declared default when the id names nothing. */
  value(id: string): ParamValue | undefined {
    const entry = this.entries.get(id);
    if (!entry) return undefined;
    try { return entry.accessor.get(); }
    catch { return entry.descriptor.defaultValue; }
  }

  /**
   * THE write. Everything that changes a parameter goes through here.
   *
   * Returns false when the id names nothing, which is the normal state of a
   * persisted binding or step lane that outlived the preset it was written
   * against — not an error, and deliberately not a throw.
   */
  set(id: string, value: ParamValue): boolean {
    const entry = this.entries.get(id);
    if (!entry) return false;
    const next = clampParam(entry.descriptor, value);
    if ((entry.descriptor.cost ?? 'live') === 'live') {
      this.write(id, entry, next);
      return true;
    }
    const now = performance.now();
    if (now - (this.lastWrite.get(id) ?? -Infinity) >= RELOAD_MIN_INTERVAL_MS) {
      this.lastWrite.set(id, now);
      this.write(id, entry, next);
      return true;
    }
    this.queued.set(id, next);
    this.arm();
    return true;
  }

  /** 0..1 in, one typed write out. What a CC, a pad and a step all call. */
  applyUnit(id: string, unit: number): boolean {
    const entry = this.entries.get(id);
    if (!entry) return false;
    return this.set(id, paramFromUnit(entry.descriptor, unit));
  }

  /** Where the control currently sits, 0..1. For a surface that draws positions. */
  unitValue(id: string): number {
    const entry = this.entries.get(id);
    if (!entry) return 0;
    const value = this.value(id);
    return value === undefined ? 0 : paramToUnit(entry.descriptor, value);
  }

  /**
   * Put a parameter back to its declared default.
   *
   * An `action` has no value to put back — it is a button, and `clampParam`
   * turns every write to one into a press. Resetting it would FIRE it (a
   * "reset all" that stepped the preset), so it is a no-op that returns false.
   */
  reset(id: string): boolean {
    const entry = this.entries.get(id);
    if (!entry || entry.descriptor.kind === 'action') return false;
    return this.set(id, entry.descriptor.defaultValue);
  }

  subscribe(listener: () => void): () => void {
    this.listeners.add(listener);
    return (): void => { this.listeners.delete(listener); };
  }

  dispose(): void {
    if (this.flushTimer !== null) clearTimeout(this.flushTimer);
    this.flushTimer = null;
    this.queued.clear();
    this.listeners.clear();
    this.entries.clear();
  }

  private write(id: string, entry: ParamEntry, value: ParamValue): void {
    this.queued.delete(id);
    try { entry.accessor.set(value); }
    catch (error) { console.warn(`[aaavs] param ${id} rejected a write:`, error); }
  }

  private arm(): void {
    if (this.flushTimer !== null) return;
    this.flushTimer = setTimeout(() => {
      this.flushTimer = null;
      const pending = [...this.queued];
      this.queued.clear();
      const now = performance.now();
      for (const [id, value] of pending) {
        const entry = this.entries.get(id);
        if (!entry) continue;
        this.lastWrite.set(id, now);
        this.write(id, entry, value);
      }
    }, RELOAD_MIN_INTERVAL_MS);
  }

  private changed(): void {
    this.revision++;
    for (const listener of [...this.listeners]) {
      try { listener(); }
      catch (error) { console.warn('[aaavs] param registry listener failed:', error); }
    }
  }
}
