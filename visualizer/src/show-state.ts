// The show state both windows apply.
//
// The control window (`main.ts`) and the projector (`projector-window.ts`) each
// hold their own `LayerStack`, renderer and `Transition`, because a GPU device
// cannot cross a browsing context (see the top of `link.ts`). What they must
// NOT each hold is their own copy of the rules for changing that state: the
// projector used to carry a hand-copied `applyPreset` and `patchParams`, and
// two copies of a rule disagree the first time one of them is edited. This
// file is the one copy.
//
// It owns no state itself. Each window keeps its `preset`/`plan` where the rest
// of its code reads them; these functions are the transitions between states,
// and the wire helpers that describe a change to the other window:
//
//   - `loadShowStack`      a whole new preset (structural): stack.load + reset
//   - `patchLayerParams`   a live param write on every layer of one TYPE
//   - `applyLayerFields`   in-place hot-field edits of existing layers, by id
//   - mixer snapshots      mute/solo, which the preset deliberately omits
//   - `ShowEditTracker`    the control side: turns "the panel edited
//                          something" into the cheapest correct message
//
// AVS load/clear is not here on purpose: the two windows share the WIRE for it
// (`avs-load`/`avs-clear`/`avs-controls` in `link.ts`) but not the mechanics —
// the control window owns the editor, the directors and a main-thread fallback
// the projector must never run.

import { needsBothChains, type Transition, type TransitionSpec } from './director.ts';
import type { LayerMixerSnapshot, LayerStack, StackPlan } from './layers.ts';
import type { LayerSpec, ParamValue, Preset } from './contracts.ts';

/**
 * Spec fields a live `Layer` re-reads every frame, so they can be written in
 * place without rebuilding it. Mirrors `HotField` in `ui.ts` (the panel's one
 * sanctioned in-place mutation); anything outside this set is structural.
 */
export const HOT_LAYER_FIELDS = [
  'family', 'blend', 'opacity', 'envelope', 'palette', 'enabled', 'resolutionScale', 'anchor', 'params',
] as const satisfies readonly (keyof LayerSpec)[];

export type HotLayerField = typeof HOT_LAYER_FIELDS[number];

/** One layer's hot fields, by id. Structured-cloneable. */
export interface ShowLayerFields {
  readonly id: string;
  readonly patch: Readonly<Partial<Pick<LayerSpec, HotLayerField>>>;
}

/** The slice of `Renderer` a preset load touches. */
export interface ShowRenderer {
  prune(ids: readonly string[]): void;
  resetLayerState(): void;
}

export interface ShowStackResult {
  readonly plan: StackPlan;
  /** True when the renderer must copy the outgoing frame before the next encode. */
  readonly captureOutgoing: boolean;
}

/**
 * Adopt a whole preset: rebuild the stack, drop per-layer GPU state for layers
 * that no longer exist, reset the rest, and start the transition if asked.
 * `captureOutgoing` is false when there is no `spec`: the caller keeps its own
 * flag in that case (a hard cut does not cancel a capture already pending).
 */
export function loadShowStack(
  stack: LayerStack,
  renderer: ShowRenderer,
  transition: Transition,
  next: Preset,
  spec: TransitionSpec | null | undefined,
  at: number,
  bpm: number,
): ShowStackResult {
  stack.load(next);
  renderer.prune(stack.all.map((layer) => layer.id));
  renderer.resetLayerState();
  let captureOutgoing = false;
  if (spec) {
    transition.begin(spec, at, bpm, next.seed);
    // The prior accumulator is copied into a held target at the start of the
    // next encoder, before the incoming preset writes over it.
    captureOutgoing = transition.active && needsBothChains(spec.kind);
  }
  return { plan: stack.frame(0).plan, captureOutgoing };
}

/**
 * Live param write, by TYPE, across the stack. Returns whether any layer had
 * that type. `params` is a hot field, so this never rebuilds a layer (which
 * would reset its trigger state and restart the effect mid-bar).
 */
export function patchLayerParams(
  stack: LayerStack,
  type: string,
  patch: Readonly<Record<string, ParamValue>>,
): boolean {
  let touched = false;
  for (const layer of stack.all) {
    if (layer.spec.type !== type) continue;
    (layer.spec as { params: Record<string, ParamValue> }).params = { ...layer.spec.params, ...patch };
    touched = true;
  }
  return touched;
}

/**
 * Write hot fields into existing layers, by id. Unknown ids are skipped (a
 * patch can race a structural change) and non-hot keys are ignored, so a
 * malformed message cannot rewrite `id`, `type` or `trigger` in place.
 * Returns the number of layers touched.
 */
export function applyLayerFields(stack: LayerStack, fields: readonly ShowLayerFields[]): number {
  let touched = 0;
  for (const entry of fields) {
    const layer = stack.find(entry.id);
    if (!layer) continue;
    const spec = layer.spec as unknown as Record<string, unknown>;
    for (const key of HOT_LAYER_FIELDS) {
      if (!Object.prototype.hasOwnProperty.call(entry.patch, key)) continue;
      const value = (entry.patch as Record<string, unknown>)[key];
      if (value === undefined) continue;
      spec[key] = value;
    }
    touched++;
  }
  return touched;
}

/** The preset as the stack currently holds it: panel edits live on the layers' specs. */
export function wirePreset(preset: Preset, stack: LayerStack): Preset {
  return { ...preset, layers: stack.all.map((layer) => layer.spec) };
}

/** Everything about the stack that only a full reload can change. */
export function showStructureKey(stack: LayerStack): string {
  return JSON.stringify(stack.all.map((layer) => [layer.id, layer.spec.type, layer.spec.trigger]));
}

function hotFieldsOf(spec: LayerSpec): Partial<Pick<LayerSpec, HotLayerField>> {
  const out: Record<string, unknown> = {};
  for (const key of HOT_LAYER_FIELDS) {
    const value = spec[key];
    if (value !== undefined) out[key] = value;
  }
  return out as Partial<Pick<LayerSpec, HotLayerField>>;
}

function mixerKey(snapshot: LayerMixerSnapshot): string {
  return `${snapshot.muted.join('\u0000')}\u0001${snapshot.soloed.join('\u0000')}`;
}

/** What one coalesced flush should send. */
export type ShowEdit =
  | { readonly kind: 'none' }
  | { readonly kind: 'structural'; readonly mixer: LayerMixerSnapshot }
  | {
      readonly kind: 'fields';
      readonly fields: readonly ShowLayerFields[];
      /** Non-null only when mute/solo changed since the last flush. */
      readonly mixer: LayerMixerSnapshot | null;
    };

/**
 * The control window's side of mirroring panel edits.
 *
 * The panel reports only "something changed". This compares the stack against
 * what the projector was last told: a different structure key means a full
 * preset (and a mixer snapshot after it, because `stack.load` clears mute and
 * solo on the far side); otherwise only the layers whose hot fields changed go
 * out, plus the mixer when it changed. Called at most once per frame while
 * dirty, so the JSON comparison runs at frame rate only during an edit.
 */
export class ShowEditTracker {
  private structure = '';
  private readonly fields = new Map<string, string>();
  private mixer = '';

  /** The projector now holds exactly this stack (a full preset was sent, or none needs to be). */
  rebase(stack: LayerStack): void {
    this.structure = showStructureKey(stack);
    this.fields.clear();
    for (const layer of stack.all) this.fields.set(layer.id, JSON.stringify(hotFieldsOf(layer.spec)));
    this.mixer = mixerKey(stack.mixerSnapshot());
  }

  /** Classify and adopt the current stack as the new baseline. */
  take(stack: LayerStack): ShowEdit {
    const structure = showStructureKey(stack);
    const snapshot = stack.mixerSnapshot();
    if (structure !== this.structure) {
      this.rebase(stack);
      return { kind: 'structural', mixer: snapshot };
    }
    const changed: ShowLayerFields[] = [];
    for (const layer of stack.all) {
      const patch = hotFieldsOf(layer.spec);
      const key = JSON.stringify(patch);
      if (this.fields.get(layer.id) === key) continue;
      this.fields.set(layer.id, key);
      changed.push({ id: layer.id, patch });
    }
    const nextMixer = mixerKey(snapshot);
    const mixerChanged = nextMixer !== this.mixer;
    this.mixer = nextMixer;
    if (!changed.length && !mixerChanged) return { kind: 'none' };
    return { kind: 'fields', fields: changed, mixer: mixerChanged ? snapshot : null };
  }
}
