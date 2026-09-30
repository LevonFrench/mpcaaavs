// Show-state regression check (src/show-state.ts, LayerStack mixer snapshots).
//
// The projector mirrors the control window's native stack from messages. This
// drives two LayerStacks, "control" and "projector", through the same edits the
// panel makes, and checks the three defects the 2026-09-25 review found:
//   1. mute/solo must reach the projector (they are not in the preset);
//   2. a field edit (slider, select) must go in place and never reload the
//      projector's stack, which would reset triggers and feedback trails;
//   3. structural edits (add, remove, reorder, rebuild) must still reload.
import { LayerStack } from '../src/layers.ts';
import { Transition } from '../src/director.ts';
import {
  ShowEditTracker, applyLayerFields, loadShowStack, patchLayerParams, wirePreset, type ShowLayerFields,
} from '../src/show-state.ts';
import type { LayerSpec, Preset } from '../src/contracts.ts';

let checks = 0;
function assert(condition: unknown, message: string): asserts condition {
  checks++;
  if (!condition) throw new Error(`show-state-check: ${message}`);
}
function equal<T>(actual: T, expected: T, message: string): void {
  assert(JSON.stringify(actual) === JSON.stringify(expected), `${message}: got ${JSON.stringify(actual)}, expected ${JSON.stringify(expected)}`);
}

function layer(id: string, type: string, opacity = 1): LayerSpec {
  return {
    id, type, family: 'source', params: { mix: 0.5 }, blend: 'add', opacity,
    envelope: { attackBeats: 0.125, holdBeats: 0, releaseBeats: 1 },
    trigger: { division: '1/4', euclidK: 1, euclidN: 1, probability: 1, offsetSteps: 0 },
    anchor: 'start', palette: 'primary', enabled: true, resolutionScale: 0.5,
  } as LayerSpec;
}

// The stack never reads the palette; a real one would pull WGSL into this node bundle.
const preset = {
  version: 1, name: 'show-state-check', seed: 1234, palette: {},
  layers: [layer('a', 'lorenz'), layer('b', 'kaleidoscope'), layer('c', 'feedback')],
} as unknown as Preset;

/** The wire is a structured clone: the projector never shares objects with the control window. */
const wire = <T>(value: T): T => structuredClone(value);

class CountingRenderer {
  prunes = 0;
  resets = 0;
  prune(): void { this.prunes++; }
  resetLayerState(): void { this.resets++; }
}

function setup(): { control: LayerStack; projector: LayerStack; tracker: ShowEditTracker; projRenderer: CountingRenderer } {
  const control = new LayerStack();
  const projector = new LayerStack();
  const tracker = new ShowEditTracker();
  const projRenderer = new CountingRenderer();
  control.load(wire(preset));
  loadShowStack(projector, projRenderer, new Transition(), wire(wirePreset(preset, control)), null, 0, 120);
  tracker.rebase(control);
  projRenderer.prunes = 0;
  projRenderer.resets = 0;
  return { control, projector, tracker, projRenderer };
}

/** Apply one coalesced flush to the projector exactly as projector-window.ts does. */
function flush(control: LayerStack, projector: LayerStack, tracker: ShowEditTracker, renderer: CountingRenderer): string {
  const edit = tracker.take(control);
  if (edit.kind === 'structural') {
    loadShowStack(projector, renderer, new Transition(), wire(wirePreset(preset, control)), null, 0, 120);
    projector.applyMixerSnapshot(wire(edit.mixer));
  } else if (edit.kind === 'fields') {
    if (edit.fields.length) applyLayerFields(projector, wire(edit.fields));
    if (edit.mixer) projector.applyMixerSnapshot(wire(edit.mixer));
  }
  return edit.kind;
}

function sameStack(control: LayerStack, projector: LayerStack, message: string): void {
  equal(projector.all.map((l) => l.spec), control.all.map((l) => l.spec), `${message}: specs`);
  equal(projector.mixerSnapshot(), control.mixerSnapshot(), `${message}: mixer`);
}

// 1. Nothing changed: nothing is sent.
{
  const { control, projector, tracker, projRenderer } = setup();
  equal(flush(control, projector, tracker, projRenderer), 'none', 'an unchanged stack sends nothing');
}

// 2. A slider drag: in place, never a reload, the projector Layer objects survive.
{
  const { control, projector, tracker, projRenderer } = setup();
  const before = projector.all.slice();
  for (let step = 1; step <= 10; step++) {
    (control.find('b')!.spec as { opacity: number }).opacity = step / 10;
    equal(flush(control, projector, tracker, projRenderer), 'fields', `slider step ${step} is a field edit`);
  }
  equal(projRenderer.resets, 0, 'a slider drag never resets projector layer state');
  equal(projRenderer.prunes, 0, 'a slider drag never prunes the projector renderer');
  assert(projector.all.every((l, i) => l === before[i]), 'projector Layer instances survive a field edit (triggers keep running)');
  equal(projector.find('b')!.spec.opacity, 1, 'the last slider value reached the projector');
  sameStack(control, projector, 'after a slider drag');
}

// 3. Only the edited layer goes on the wire.
{
  const { control, tracker } = setup();
  (control.find('c')!.spec as { params: Record<string, unknown> }).params = { mix: 0.9 };
  const edit = tracker.take(control);
  assert(edit.kind === 'fields', 'a params edit is a field edit');
  equal(edit.fields.map((f) => f.id), ['c'], 'only the touched layer is sent');
  equal(edit.mixer, null, 'no mixer message when mute/solo did not change');
}

// 4. Mute and solo reach the projector, without a reload.
{
  const { control, projector, tracker, projRenderer } = setup();
  control.setMuted('a', true);
  equal(flush(control, projector, tracker, projRenderer), 'fields', 'mute is not structural');
  assert(projector.find('a')!.muted, 'mute reached the projector');
  control.setSolo('c', true);
  flush(control, projector, tracker, projRenderer);
  assert(projector.isSoloed('c') && projector.soloActive, 'solo reached the projector');
  control.setSolo('c', false);
  control.setMuted('a', false);
  flush(control, projector, tracker, projRenderer);
  assert(!projector.find('a')!.muted && !projector.soloActive, 'unmute and unsolo reached the projector');
  equal(projRenderer.resets, 0, 'mute/solo never resets projector layer state');
}

// 5. Structural edits still reload, and the mixer follows the reload.
{
  const { control, projector, tracker, projRenderer } = setup();
  control.setMuted('b', true);
  control.setSolo('a', true);
  flush(control, projector, tracker, projRenderer);
  control.reorder('c', 0);
  equal(flush(control, projector, tracker, projRenderer), 'structural', 'reorder is structural');
  equal(projRenderer.resets, 1, 'a structural edit reloads the projector once');
  sameStack(control, projector, 'after reorder (load cleared the far mixer; the snapshot restored it)');
  control.add(layer('d', 'spectrum'));
  equal(flush(control, projector, tracker, projRenderer), 'structural', 'add is structural');
  control.remove('a');
  equal(flush(control, projector, tracker, projRenderer), 'structural', 'remove is structural');
  // ui.ts `rebuild`: same id, new trigger (Layer caches the division).
  const d = control.find('d')!.spec;
  control.remove('d');
  control.add({ ...d, trigger: { ...d.trigger, division: '1/8' } });
  equal(flush(control, projector, tracker, projRenderer), 'structural', 'a trigger rebuild is structural');
  sameStack(control, projector, 'after add/remove/rebuild');
}

// 6. The applier ignores non-hot keys and unknown ids.
{
  const { projector } = setup();
  const hostile = [
    { id: 'a', patch: { opacity: 0.25, id: 'zzz', type: 'evil', trigger: { division: '4bar' } } },
    { id: 'missing', patch: { opacity: 0 } },
  ] as unknown as ShowLayerFields[];
  equal(applyLayerFields(projector, hostile), 1, 'unknown ids are skipped');
  const a = projector.find('a')!.spec;
  equal([a.opacity, a.id, a.type, a.trigger.division], [0.25, 'a', 'lorenz', '1/4'], 'only hot fields are written in place');
}

// 7. Params by type, and a whole-preset load.
{
  const { control } = setup();
  assert(patchLayerParams(control, 'kaleidoscope', { segments: 6 }), 'patchLayerParams reports a touched type');
  equal(control.find('b')!.spec.params['segments'], 6, 'param written');
  equal(control.find('b')!.spec.params['mix'], 0.5, 'other params kept');
  assert(!patchLayerParams(control, 'no-such-type', { x: 1 }), 'an absent type touches nothing');

  const stack = new LayerStack();
  const renderer = new CountingRenderer();
  const transition = new Transition();
  stack.load(wire(preset));
  stack.setMuted('a', true);
  const hard = loadShowStack(stack, renderer, transition, wire(preset), null, 0, 120);
  equal([renderer.prunes, renderer.resets, hard.captureOutgoing, stack.mixerSnapshot().muted.length], [1, 1, false, 0],
    'a load prunes, resets, clears mute and needs no capture without a transition');
  assert(hard.plan !== undefined, 'a load returns a plan');
  const faded = loadShowStack(stack, renderer, transition, wire(preset), { kind: 'crossfade', beats: 4, curve: 'equalPower' }, 0, 120);
  assert(faded.captureOutgoing, 'a crossfade asks for the outgoing frame');
}

console.log(`show-state-check: PASS (${checks} assertions)`);
