// The mapping table: one normalised event in, one registered parameter out.
//
// The table is deliberately flat and small. There is no curve, no smoothing, no
// scaling factor and no per-binding inversion, because every one of those is a
// property of the PARAMETER (which knows what its own range means) rather than
// of the wire. A binding is a name and a control signature; the descriptor owns
// the interpretation. That is what keeps `handle` five lines long and what makes
// a persisted mapping still mean the same thing after the ranges are edited.
//
// The list of what can be bound is NOT written here. It is
// `ParamRegistry.list()` (`src/params/registry.ts`), the same list the step
// lane's dropdown and the AVS inspector's parameter form read, so a parameter
// declared once appears in all three without any of them being edited. An
// `InputTarget` below is a derived row, not a source of truth: it is a
// descriptor with the two things this surface needs precomputed.
//
// Bindings persist to localStorage keyed on the control signature, so a
// controller that comes back on a different USB port keeps its knobs — the key
// is the channel and CC number, not the device id.

import { describeInputEvent, inputEventKey, type InputEvent } from './events.ts';
import { isKnobParam, paramMode } from '../params/descriptor.ts';
import type { ParamRegistry } from '../params/registry.ts';

const STORAGE_KEY = 'aaavs.input.mappings.v1';

/** Half-scale, the usual MIDI note/pad convention. */
const TRIGGER_THRESHOLD = 0.5;

/**
 * `continuous` targets take the 0..1 value on every event. `trigger` targets
 * fire once on the rising edge and are never called on release — a pad that
 * stepped the preset on both edges would step twice per hit.
 */
export type InputTargetMode = 'continuous' | 'trigger';

/**
 * One bindable row, derived from a registered parameter.
 *
 * There is no `apply` here on purpose. A row is what the panel and the step
 * grid DRAW; the write itself belongs to the registry, which is the only thing
 * that ever calls an accessor.
 */
export interface InputTarget {
  /** The parameter id. This is what a persisted binding stores. */
  readonly id: string;
  readonly label: string;
  readonly mode: InputTargetMode;
  /** Short note shown under the label in the panel. */
  readonly hint?: string;
  readonly group?: string;
  /**
   * True when the parameter reaches the native V2 lane only, and so does
   * nothing while an AVS preset plays. The surfaces grey out AND disable such
   * rows while the AVS lane is active (`targetInert`); the label suffix alone
   * was too easy to miss mid-set.
   */
  readonly nativeOnly?: boolean;
}

/**
 * Is this row a dead control right now?
 *
 * One rule, shared by the step-lane dropdown and the mapping panel, so the two
 * can never disagree about which knob is inert. `avsLaneActive` is injected by
 * main.ts, which is the only place that knows which lane is rendering.
 */
export function targetInert(target: InputTarget, avsLaneActive: boolean): boolean {
  return avsLaneActive && target.nativeOnly === true;
}

/**
 * The bindable rows of a registry, in registration order.
 *
 * Exported because the step grid lists exactly the same rows and must not
 * derive them a second way — `color` and `text` parameters are filtered out
 * here, and a grid that filtered differently would offer a lane a target the
 * mapping panel says cannot be bound.
 */
export function paramInputTargets(registry: ParamRegistry): readonly InputTarget[] {
  const rows: InputTarget[] = [];
  for (const entry of registry.list()) {
    const descriptor = entry.descriptor;
    if (!isKnobParam(descriptor)) continue;
    // A native-lane parameter is inert while an AVS preset plays, which is the
    // shipped default. Say it in the label — a knob bound to a dead target is
    // indistinguishable from a broken knob, and the panel is where that gets
    // found out, not the wall. Marked once here so both the mapping list and
    // the step-lane dropdown carry it without either knowing about lanes.
    const native = descriptor.lane === 'native';
    const hint = native
      ? `${descriptor.hint ? `${descriptor.hint} · ` : ''}native lane only — inert while a .avs preset plays`
      : descriptor.hint;
    rows.push({
      id: descriptor.id,
      label: native ? `${descriptor.label} (native)` : descriptor.label,
      mode: paramMode(descriptor),
      ...(hint ? { hint } : {}),
      ...(descriptor.group ? { group: descriptor.group } : {}),
      ...(native ? { nativeOnly: true } : {}),
    });
  }
  return rows;
}

export interface InputBinding {
  /** `inputEventKey` of the control. */
  readonly key: string;
  readonly targetId: string;
  /** How the control read when it was bound, for display. */
  readonly label: string;
}

interface StoredBinding {
  readonly key?: unknown;
  readonly targetId?: unknown;
  readonly label?: unknown;
}

function readStored(): InputBinding[] {
  let raw: string | null = null;
  try { raw = localStorage.getItem(STORAGE_KEY); }
  catch { return []; }
  if (!raw) return [];
  try {
    const parsed: unknown = JSON.parse(raw);
    if (!Array.isArray(parsed)) return [];
    const out: InputBinding[] = [];
    for (const entry of parsed as StoredBinding[]) {
      if (typeof entry?.key !== 'string' || typeof entry.targetId !== 'string') continue;
      out.push({
        key: entry.key,
        targetId: entry.targetId,
        label: typeof entry.label === 'string' ? entry.label : entry.key,
      });
    }
    return out;
  } catch {
    return [];
  }
}

export class InputMappings {
  private list: InputBinding[];
  private readonly last = new Map<string, number>();
  private armed = '';
  private rows: readonly InputTarget[] = [];
  private rowsVersion = -1;

  constructor(
    private readonly registry: ParamRegistry,
    private readonly onChange: () => void = () => {},
  ) {
    // Bindings whose parameter is absent are KEPT, not dropped. The registry is
    // dynamic — an AVS preset registers its renderer fields when it loads and
    // takes them away when it unloads — so an absent id usually means "that
    // preset is not showing", and deleting the binding would lose the
    // performer's work every time they switched preset. An inert binding costs
    // one string; `dispatch` returns false and nothing happens.
    this.list = readStored();
    this.registry.subscribe(() => this.onChange());
  }

  /**
   * The bindable rows. Rebuilt only when the registry's membership changes,
   * because values move at MIDI rate and the LIST moves at preset rate.
   */
  get targets(): readonly InputTarget[] {
    if (this.rowsVersion !== this.registry.version) {
      this.rows = paramInputTargets(this.registry);
      this.rowsVersion = this.registry.version;
    }
    return this.rows;
  }

  get bindings(): readonly InputBinding[] {
    return this.list;
  }

  /** Target id currently waiting for a control, or `''`. */
  get learning(): string {
    return this.armed;
  }

  bindingFor(targetId: string): InputBinding | undefined {
    return this.list.find((binding) => binding.targetId === targetId);
  }

  targetFor(targetId: string): InputTarget | undefined {
    return this.targets.find((target) => target.id === targetId);
  }

  /**
   * Fire a parameter by id, with a 0..1 value.
   *
   * `handle` calls it after it has resolved a binding and settled the trigger
   * edge; the 16-step sequencer calls it directly with a fabricated `step`
   * event. Neither knows anything the other does not, which is the point — a
   * step and a MIDI note are the same event by the time they arrive here.
   *
   * It is one line because the write itself belongs to the registry: 0..1 to a
   * value is `paramFromUnit`, and that lives with the descriptor that declares
   * the range. `event` is accepted and ignored so that a caller which has one
   * does not have to know that nothing downstream reads it.
   *
   * The edge rule deliberately does NOT live here. A sequencer step has no
   * release, so it has no edge; `handle` owns that because only the wire has it.
   *
   * Returns false when the id names no registered parameter, which happens
   * whenever a persisted lane or binding outlives the preset it was written
   * against.
   */
  dispatch(targetId: string, value: number, _event: InputEvent): boolean {
    return this.registry.applyUnit(targetId, value);
  }

  /** Arm MIDI-learn. Passing the already-armed id (or `''`) disarms. */
  arm(targetId: string): void {
    this.armed = this.armed === targetId ? '' : targetId;
    this.onChange();
  }

  clear(targetId: string): void {
    const next = this.list.filter((binding) => binding.targetId !== targetId);
    if (next.length === this.list.length) return;
    this.list = next;
    this.persist();
    this.onChange();
  }

  clearAll(): void {
    if (!this.list.length && !this.armed) return;
    this.list = [];
    this.armed = '';
    this.persist();
    this.onChange();
  }

  /**
   * Route one event. Returns true when it was consumed by learn — the panel
   * uses that to flash the row, and nothing else depends on it.
   */
  handle(event: InputEvent): boolean {
    if (this.armed) {
      // A note-off carries value 0; binding on it would capture the release of
      // whatever pad the performer just let go of.
      if (event.kind === 'cc' || event.value > 0) {
        this.bind(this.armed, event);
        return true;
      }
      return false;
    }
    const key = inputEventKey(event);
    const binding = this.list.find((entry) => entry.key === key);
    if (!binding) return false;
    const target = this.targetFor(binding.targetId);
    if (!target) return false;

    if (target.mode === 'trigger') {
      // A bare OSC trigger has no release, so it has no edge to detect either.
      if (event.kind === 'trigger') {
        this.dispatch(binding.targetId, 1, event);
        return false;
      }
      const previous = this.last.get(key) ?? 0;
      this.last.set(key, event.value);
      if (previous < TRIGGER_THRESHOLD && event.value >= TRIGGER_THRESHOLD) {
        this.dispatch(binding.targetId, event.value, event);
      }
      return false;
    }
    this.last.set(key, event.value);
    this.dispatch(binding.targetId, event.value, event);
    return false;
  }

  private bind(targetId: string, event: InputEvent): void {
    const key = inputEventKey(event);
    // One control drives one target, and one target is driven by one control.
    // Both directions are enforced here so the table can never hold a pair the
    // panel cannot display as a single row.
    this.list = this.list.filter((entry) => entry.key !== key && entry.targetId !== targetId);
    this.list.push({ key, targetId, label: describeInputEvent(event) });
    this.last.set(key, event.value);
    this.armed = '';
    this.persist();
    this.onChange();
  }

  private persist(): void {
    try { localStorage.setItem(STORAGE_KEY, JSON.stringify(this.list)); }
    catch {
      // Storage denied. Mappings still work for this session.
    }
  }
}
