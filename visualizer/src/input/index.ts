// The live input bus.
//
// One emitter, two adapters, one mapping table, one panel. Everything a source
// produces is an `InputEvent`; everything a consumer receives is a target
// callback that main.ts wrote. Nothing in this directory knows what a
// kaleidoscope is, and nothing in main.ts knows what a CC number is — that
// separation is the whole point of the normalised event.
//
// The bus never starts anything the performer did not ask for. MIDI is
// requested at boot ONLY when the origin already holds the permission, so a
// first visit does not open with a permission prompt over the visuals; the
// panel's ENABLE MIDI button is the gesture for every other case. The OSC
// bridge is attempted quietly and its absence is the normal state.

import { Emitter, type InputEvent } from './events.ts';
import { MidiInputs } from './midi.ts';
import { OscBridge, oscBridgeReachable, oscBridgeUrl } from './osc.ts';
import { InputMappings } from './mappings.ts';
import { InputPanel } from './panel.ts';
import type { ParamRegistry } from '../params/registry.ts';

export type {
  InputEvent,
  InputEventKind,
  InputSource,
} from './events.ts';
export type { InputTarget, InputTargetMode, InputBinding } from './mappings.ts';
export { InputMappings, paramInputTargets, targetInert } from './mappings.ts';
export { Emitter } from './events.ts';

export interface InputBusOptions {
  /** Override the bridge port. Defaults to the port that served the page. */
  readonly oscPort?: number;
  readonly host?: HTMLElement;
  /** Is the AVS lane rendering? Greys out native-only rows. See `InputPanelOptions`. */
  readonly isAvsLaneActive?: () => boolean;
}

export interface InputBus {
  readonly panel: InputPanel;
  readonly midi: MidiInputs;
  readonly osc: OscBridge;
  readonly mappings: InputMappings;
  /** Feed a synthetic event in. Used by tests and by the dev handle. */
  emit(event: InputEvent): void;
  dispose(): void;
}

/**
 * Does this origin already hold MIDI permission?
 *
 * `navigator.permissions` does not know the `midi` name everywhere, and Firefox
 * rejects the query outright. Either way the answer is "do not auto-start",
 * which is the safe default rather than a degraded one.
 */
async function midiAlreadyGranted(): Promise<boolean> {
  try {
    const status = await navigator.permissions.query({ name: 'midi' as PermissionName });
    return status.state === 'granted';
  } catch {
    return false;
  }
}

/**
 * `registry` is the whole of what this bus is allowed to touch. There is no
 * reflection into the layer graph here, so a stray CC can only reach a
 * parameter somebody deliberately declared.
 */
export function createInputBus(
  registry: ParamRegistry,
  options: InputBusOptions = {},
): InputBus {
  const bus = new Emitter<InputEvent>();
  // `refresh` is assigned below; the adapters are constructed first because the
  // panel needs them, and they only ever call it asynchronously.
  let refresh = (): void => {};
  const mappings = new InputMappings(registry, () => refresh());
  const midi = new MidiInputs(bus, () => refresh());
  const osc = new OscBridge(bus, oscBridgeUrl(options.oscPort), () => refresh());
  const panel = new InputPanel({
    mappings,
    midi,
    osc,
    onEnableMidi: () => { void midi.start(); },
    ...(options.host ? { host: options.host } : {}),
    ...(options.isAvsLaneActive ? { isAvsLaneActive: options.isAvsLaneActive } : {}),
  });
  refresh = () => panel.refresh();

  const unsubscribe = bus.subscribe((event) => {
    mappings.handle(event);
    panel.noteEvent(event);
  });

  void midiAlreadyGranted().then((granted) => {
    if (granted) void midi.start();
  });
  if (oscBridgeReachable()) osc.connect();
  else osc.disable('an https page cannot reach a ws:// bridge');

  return {
    panel,
    midi,
    osc,
    mappings,
    emit(event: InputEvent): void { bus.emit(event); },
    dispose(): void {
      unsubscribe();
      bus.dispose();
      midi.dispose();
      osc.dispose();
      panel.dispose();
    },
  };
}
