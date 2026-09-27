// The live parameters of the show itself, declared in one place.
//
// These were scattered: a range lived as a literal in the keydown handler
// (`Math.max(0.1, tau - 0.15)`), a second copy of the same range lived in the
// MIDI target list (`0.1 + value * 7.9`), the label lived in whichever of the
// two you were reading, and `post` had four numbers with no label, no range and
// no UI at all. Adding a knob meant editing at least three of those.
//
// Now it is one entry here. `main.ts` supplies the plumbing (`ParamHost`) and
// this file supplies everything a surface needs to draw and drive it.
//
// The split is deliberate: the DECLARATION is data and belongs next to the
// other declarations, while the ACCESSOR is a closure over `patchParams`, a
// field on `post`, or a whole AVS/native lane decision — plumbing that only
// `main.ts` can honestly own. A registry that tried to describe those locations
// instead of closing over them would have to know all of them.

import {
  PRESET_PARAM_GROUP,
  type ParamDescriptor,
  type ParamValue,
} from './descriptor.ts';
import type { ParamEntry } from './registry.ts';

/** The step lane's explicit silence. Named so a row can be parked without losing it. */
export const REST_PARAM_ID = 'sequencer.rest';

/**
 * The plumbing a global parameter needs, and nothing else.
 *
 * Every member is a function `main.ts` already had — these are the SAME calls
 * the keyboard shortcuts make, which is what keeps a pad bound to "next preset"
 * from becoming a second implementation of the AVS/native lane split.
 */
export interface ParamHost {
  patchParams(type: string, patch: Readonly<Record<string, ParamValue>>): void;
  readParam(type: string, key: string, fallback: number): number;
  /** Display-space post state. Mutated in place; read back every frame. */
  readonly post: { bloom: number; exposure: number; vignette: number; grain: number };
  toggleKaleidoscopeMix(): void;
  toggleAutoPresets(): void;
  stepPreset(direction: -1 | 1): void;
  randomPreset(): void;
  toggleTransport(): void;
  skipBar(direction: -1 | 1): void;
}

/** An `action` carries no value: firing it is the whole of its write. */
function action(
  id: string,
  label: string,
  group: string,
  hint: string,
  fire: () => void,
): ParamEntry {
  const descriptor: ParamDescriptor = { id, label, kind: 'action', defaultValue: false, group, hint };
  return { descriptor, accessor: { get: () => false, set: () => fire() } };
}

/** Restamp an entry as native-lane-only. Actions are built by `action`, which has no lane arm. */
function nativeLane(entry: ParamEntry): ParamEntry {
  return { ...entry, descriptor: { ...entry.descriptor, lane: 'native' } };
}

/** A layer param, written by TYPE onto every layer of that type — what the panel does. */
function layerParam(
  host: ParamHost,
  type: string,
  key: string,
  descriptor: ParamDescriptor,
): ParamEntry {
  return {
    descriptor,
    accessor: {
      get: () => host.readParam(type, key, Number(descriptor.defaultValue)),
      set: (value) => host.patchParams(type, { [key]: Number(value) }),
    },
  };
}

/** A field on the display-space post block. No clamp in the shader, so the range is here. */
function postParam(
  host: ParamHost,
  key: 'bloom' | 'exposure' | 'vignette' | 'grain',
  descriptor: ParamDescriptor,
): ParamEntry {
  return {
    descriptor,
    accessor: {
      get: () => host.post[key],
      set: (value) => { host.post[key] = Number(value); },
    },
  };
}

/**
 * Every global parameter and action, in the order a surface lists them.
 *
 * Ranges are the SAME limits the keyboard enforces — `2`–`9` segments, `0.1`–`8`
 * beats — because they are now the only copy. `post` gets bounds for the first
 * time: `present.wgsl` clamps nothing except through its tone map, so these are
 * the limits, and they are chosen to stay inside what that tone map survives.
 */
export function globalParamEntries(host: ParamHost): readonly ParamEntry[] {
  return [
    layerParam(host, 'kaleidoscope', 'segments', {
      id: 'kaleido.segments',
      lane: 'native',
      label: 'kaleidoscope segments',
      kind: 'number',
      defaultValue: 6,
      min: 2,
      max: 9,
      step: 1,
      unit: 'segments',
      group: 'kaleidoscope',
      hint: '2–9, same range as the number keys',
    }),
    layerParam(host, 'kaleidoscope', 'mix', {
      id: 'kaleido.mixAmount',
      lane: 'native',
      label: 'kaleidoscope mix',
      kind: 'number',
      defaultValue: 0.55,
      min: 0,
      max: 1,
      step: 0.01,
      group: 'kaleidoscope',
      hint: 'continuous, where K is the two-position version',
    }),
    nativeLane(action('kaleido.bypass', 'kaleidoscope bypass', 'kaleidoscope', 'segments to 0, same as 1',
      () => host.patchParams('kaleidoscope', { segments: 0 }))),
    nativeLane(action('kaleido.mix', 'kaleidoscope mix toggle', 'kaleidoscope', 'same as K',
      () => host.toggleKaleidoscopeMix())),

    layerParam(host, 'feedback', 'tauBeats', {
      id: 'feedback.tauBeats',
      lane: 'native',
      label: 'feedback length',
      kind: 'number',
      defaultValue: 1.2,
      min: 0.1,
      max: 8,
      step: 0.01,
      unit: 'beats',
      group: 'feedback',
      hint: '0.1–8 beats, same range as [ and ]',
    }),
    layerParam(host, 'feedback', 'gain', {
      id: 'feedback.gain',
      lane: 'native',
      label: 'feedback gain',
      kind: 'number',
      defaultValue: 0.85,
      min: 0,
      max: 4,
      step: 0.01,
      group: 'feedback',
      hint: 'above 1 the trail grows rather than decays',
    }),

    postParam(host, 'bloom', {
      id: 'post.bloom',
      label: 'bloom',
      kind: 'number',
      defaultValue: 0.28,
      min: 0,
      max: 1.5,
      step: 0.01,
      group: 'post',
      hint: 'threshold bloom in display space',
    }),
    postParam(host, 'exposure', {
      id: 'post.exposure',
      label: 'exposure',
      kind: 'number',
      defaultValue: 1,
      min: 0.25,
      max: 3,
      step: 0.01,
      group: 'post',
      hint: 'before the tone map, so it bends rather than clips',
    }),
    postParam(host, 'vignette', {
      id: 'post.vignette',
      label: 'vignette',
      kind: 'number',
      defaultValue: 0.7,
      min: 0,
      max: 1,
      step: 0.01,
      group: 'post',
    }),
    postParam(host, 'grain', {
      id: 'post.grain',
      label: 'grain',
      kind: 'number',
      defaultValue: 0.35,
      min: 0,
      max: 1,
      step: 0.01,
      group: 'post',
    }),

    action('preset.next', 'next preset', PRESET_PARAM_GROUP, 'same as .',
      () => host.stepPreset(1)),
    action('preset.prev', 'previous preset', PRESET_PARAM_GROUP, 'same as ,',
      () => host.stepPreset(-1)),
    action('preset.random', 'random preset', PRESET_PARAM_GROUP,
      'anything but the one showing, from the active bank',
      () => host.randomPreset()),

    // A rest is not an unassigned lane. Silence has to be expressible as a
    // choice (contracts.ts, `TriggerSpec`; art direction §3.5), and naming it
    // means a lane can be parked without losing the row it was written on. It
    // is deliberately NOT in the preset group: a lane of rests owns nothing.
    action(REST_PARAM_ID, 'rest', 'sequencer',
      'fires nothing — a deliberate silence, like the Rave bank’s final bar',
      () => {}),

    action('preset.auto', 'auto preset changes', 'director', 'same as P',
      () => host.toggleAutoPresets()),

    action('transport.toggle', 'play / pause', 'transport', 'same as Space',
      () => host.toggleTransport()),
    action('transport.barForward', 'skip forward one bar', 'transport', 'same as →',
      () => host.skipBar(1)),
    action('transport.barBack', 'skip back one bar', 'transport', 'same as ←',
      () => host.skipBar(-1)),
  ];
}
