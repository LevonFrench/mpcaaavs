// One parameter, declared once.
//
// Before this file the same knob was described three times: its range lived as
// a literal argument inside the code that wrote it (`integerInRange(value, 0,
// 3, 'Blur mode')` in `avs/editor-model.ts`, `num(p, 'segments', 0, 64)` in
// `ops/kaleido.ts`), its label and hint lived in whichever UI happened to draw
// it, and its 0..1 normalisation lived in whichever input surface happened to
// drive it. Three copies of one fact is three chances to disagree, and the
// disagreement is always silent — a slider that stops at 9 next to a knob that
// goes to 64 looks like a bug in the visual, not in the two numbers.
//
// So a descriptor is DATA, not behaviour. It says what the parameter is; it
// does not say how to read or write it (that is `ParamAccessor` in
// `registry.ts`) and it does not say what widget to draw (that is the surface's
// business). This is the smallest shape that lets an inspector pick a widget, a
// MIDI CC pick a range, and a step lane pick a value — and nothing more, because
// every extra field is another thing three surfaces have to agree about.
//
// Deliberately absent: curve/smoothing (a property of the wire, not the knob),
// a validation callback (the write path already throws — see
// `patchAvsEditorNodeFields`), and any notion of where the value is stored.

import type { ParamValue } from '../contracts.ts';

/**
 * The render lane a parameter reaches.
 *
 * The two lanes do not share an effect chain: the native V2 stack and the AVS
 * compatibility executor each own their own passes, and only display-space post
 * runs after both. So a layer parameter is honestly `native`, a post parameter
 * is honestly `both`, and there is no third answer to hide behind.
 */
export type ParamLane = 'native' | 'avs' | 'both';

export type { ParamValue };

/**
 * The field types that actually occur.
 *
 * `number`, `boolean` and `select` are the three the AVS inspector and the
 * layer panel already draw between them, and they are the only three a knob or
 * a step can write. `color` and `text` are here because they are real AVS field
 * types — a packed RGB int in `superscope.colors`, an EEL program in
 * `dynamic-movement.point` — and pretending otherwise would mean a descriptor
 * could not describe half of what the decoders return. Nothing emits them yet:
 * both have bespoke editors (a hex payload textarea, a read-only code block)
 * and `isKnobParam` excludes them, so declaring one is a description, not an
 * offer to drive it.
 *
 * `action` is not a parameter at all — it is a button, and it does not fit any
 * of the five. It is in the same union rather than a parallel type because the
 * surfaces that list knobs (the MIDI table, the step lane) list buttons too,
 * and splitting the union would put the second list straight back.
 */
export type ParamKind = 'number' | 'boolean' | 'select' | 'color' | 'text' | 'action';

/**
 * What one write costs.
 *
 * `live` writes a field on a running object. `reload` writes a byte into an AVS
 * payload, which re-serialises the preset and hands it back to the renderer —
 * fine when a human presses Apply, ruinous at MIDI rate. The registry throttles
 * `reload` writes rather than letting each surface remember to; see
 * `ParamRegistry.set`.
 */
export type ParamWriteCost = 'live' | 'reload';

/** Group id for the parameters that change which preset is showing. */
export const PRESET_PARAM_GROUP = 'preset';

export interface ParamDescriptor {
  /** Stable and unique. This is what a persisted MIDI binding or step lane stores. */
  readonly id: string;
  /** Human label, used verbatim by every surface that draws this parameter. */
  readonly label: string;
  readonly kind: ParamKind;
  readonly defaultValue: ParamValue;
  /** Inclusive bounds for `number`. Omitted means the 0..1 unit range. */
  readonly min?: number;
  readonly max?: number;
  /** Quantisation. 1 for an integer field; omitted means `kind`'s default. */
  readonly step?: number;
  /** Displayed after the label — `beats`, `segments`. Never parsed. */
  readonly unit?: string;
  /** `select` only: option labels in wire order. The VALUE is the index. */
  readonly values?: readonly string[];
  /** Display grouping, and how `sequencer/lane.ts` recognises a preset change. */
  readonly group?: string;
  /** One short line under the label. */
  readonly hint?: string;
  /**
   * Which render lane this parameter reaches. Defaults to `both`.
   *
   * A `native` parameter writes onto a native V2 layer, so it does nothing at
   * all while a Winamp `.avs` preset is playing — which is the shipped default.
   * A knob that silently does nothing reads as a broken knob, so the surfaces
   * say so rather than leaving the performer to work it out mid-set.
   */
  readonly lane?: ParamLane;
  /** Defaults to `live`. */
  readonly cost?: ParamWriteCost;
}

/**
 * Effective numeric bounds.
 *
 * `select` and `boolean` have bounds even though they are not numbers, because
 * a MIDI CC has to land somewhere: an N-option select is 0..N-1 and a boolean
 * is 0..1. Reading them here rather than at each call site is the only reason
 * `paramFromUnit` can be one function instead of one per surface.
 */
export function paramMin(descriptor: ParamDescriptor): number {
  if (descriptor.kind === 'select' || descriptor.kind === 'boolean') return 0;
  return descriptor.min ?? 0;
}

export function paramMax(descriptor: ParamDescriptor): number {
  if (descriptor.kind === 'select') return Math.max(0, (descriptor.values?.length ?? 1) - 1);
  if (descriptor.kind === 'boolean') return 1;
  return descriptor.max ?? 1;
}

export function paramStep(descriptor: ParamDescriptor): number {
  if (descriptor.step !== undefined && descriptor.step > 0) return descriptor.step;
  return descriptor.kind === 'number' ? 0 : 1;
}

/**
 * Can a knob or a step write this?
 *
 * False for `color` and `text`: both are real field types with real editors,
 * and neither has a meaningful position between two endpoints. A surface that
 * lists drivable parameters filters on this, which is why adding a `text`
 * descriptor cannot accidentally put an EEL program on a fader.
 */
export function isKnobParam(descriptor: ParamDescriptor): boolean {
  return descriptor.kind !== 'color' && descriptor.kind !== 'text';
}

/**
 * How an input surface should treat this parameter.
 *
 * An action has no position, so it fires on the rising edge and never on
 * release — a pad that stepped the preset on both edges would step twice per
 * hit. Everything else follows the control continuously.
 */
export function paramMode(descriptor: ParamDescriptor): 'continuous' | 'trigger' {
  return descriptor.kind === 'action' ? 'trigger' : 'continuous';
}

function quantize(value: number, step: number, min: number): number {
  if (!(step > 0)) return value;
  return min + Math.round((value - min) / step) * step;
}

/** Coerce anything into what this descriptor accepts. The last gate before a write. */
export function clampParam(descriptor: ParamDescriptor, value: ParamValue): ParamValue {
  switch (descriptor.kind) {
    case 'action':
      return true;
    case 'boolean':
      return typeof value === 'boolean' ? value : Number(value) >= 0.5;
    case 'color':
    case 'text':
      return value;
    case 'select':
    case 'number': {
      const raw = typeof value === 'boolean' ? (value ? 1 : 0) : Number(value);
      if (!Number.isFinite(raw)) return descriptor.defaultValue;
      const min = paramMin(descriptor);
      const max = paramMax(descriptor);
      const snapped = quantize(raw, paramStep(descriptor), min);
      return snapped < min ? min : snapped > max ? max : snapped;
    }
  }
}

/**
 * 0..1 in, a value of this parameter out.
 *
 * This is the whole of MIDI normalisation, and it lives here rather than in the
 * mapping table on purpose: a binding is to a control, not to a range, so a
 * persisted mapping keeps meaning the same thing after the target's bounds are
 * edited. `Math.min(n - 1, …)` rather than a clamp after the fact so that a CC
 * at exactly 1.0 lands on the last option instead of one past it.
 */
export function paramFromUnit(descriptor: ParamDescriptor, unit: number): ParamValue {
  const u = unit < 0 ? 0 : unit > 1 ? 1 : unit;
  switch (descriptor.kind) {
    case 'action':
      return true;
    case 'boolean':
      return u >= 0.5;
    case 'color':
    case 'text':
      return descriptor.defaultValue;
    case 'select': {
      const count = descriptor.values?.length ?? 0;
      if (count < 1) return 0;
      return Math.min(count - 1, Math.floor(u * count));
    }
    case 'number': {
      const min = paramMin(descriptor);
      const max = paramMax(descriptor);
      return clampParam(descriptor, min + u * (max - min));
    }
  }
}

/** The inverse, for a surface that wants to draw the control's current position. */
export function paramToUnit(descriptor: ParamDescriptor, value: ParamValue): number {
  if (descriptor.kind === 'action') return 0;
  if (descriptor.kind === 'boolean') return value === true ? 1 : 0;
  if (descriptor.kind === 'color' || descriptor.kind === 'text') return 0;
  const min = paramMin(descriptor);
  const max = paramMax(descriptor);
  if (!(max > min)) return 0;
  const raw = typeof value === 'boolean' ? (value ? 1 : 0) : Number(value);
  if (!Number.isFinite(raw)) return 0;
  const u = (raw - min) / (max - min);
  return u < 0 ? 0 : u > 1 ? 1 : u;
}

/** Label plus unit, the form every surface shows. Kept here so they all agree. */
export function paramTitle(descriptor: ParamDescriptor): string {
  return descriptor.unit ? `${descriptor.label} (${descriptor.unit})` : descriptor.label;
}

/** Readable current value, for a hint line or a HUD row. */
export function formatParamValue(descriptor: ParamDescriptor, value: ParamValue): string {
  if (descriptor.kind === 'action') return '—';
  if (descriptor.kind === 'boolean') return value === true ? 'on' : 'off';
  if (descriptor.kind === 'select') {
    const index = Number(value);
    return descriptor.values?.[index] ?? String(value);
  }
  if (typeof value !== 'number' || !Number.isFinite(value)) return String(value);
  const step = paramStep(descriptor);
  const digits = step > 0 && step < 1 ? Math.min(4, Math.ceil(-Math.log10(step))) : 0;
  const text = value.toFixed(digits);
  return descriptor.unit ? `${text} ${descriptor.unit}` : text;
}
