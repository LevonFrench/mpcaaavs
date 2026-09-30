import {
  buildAvsEditorModel,
  dispatchAvsEditorAction,
  dispatchAvsEditorMove,
  dispatchAvsEditorSave,
  parseAvsPayloadHex,
  type AvsEditorNodeState,
} from '../src/avs-editor.ts';
import type { AvsComponent, AvsEffectListSettings, AvsPresetAst } from '../src/avs/types.ts';

let assertions = 0;
const equal = (actual: unknown, expected: unknown, label: string): void => {
  assertions++;
  if (actual !== expected) throw new Error(`${label}: expected ${String(expected)}, got ${String(actual)}`);
};

const listSettings: AvsEffectListSettings = {
  mode: 0, enabled: true, clearEveryFrame: false,
  inputBlendMode: 1, outputBlendMode: 4,
  inputBlendValue: 128, outputBlendValue: 128,
  inputBuffer: 0, outputBuffer: 0, inputInvert: false, outputInvert: false,
  beatRender: false, beatRenderFrames: 1, byteLength: 1,
};

const component = (
  path: string,
  effectId: number,
  children: readonly AvsComponent[] = [],
  apeId: string | null = null,
): AvsComponent => ({
  effectId, apeId, payload: new Uint8Array(effectId === -2 ? 12 : 4),
  fileOffset: Number(path.replaceAll('.', '')), path, children,
  list: effectId === -2 ? listSettings : null,
  listCode: effectId === -2 ? { enabled: true, init: 'seed=1;', frame: 'enabled=above(beat,0);', raw: new Uint8Array() } : null,
});

const preset: AvsPresetAst = {
  version: 2,
  header: 'Nullsoft AVS Preset 0.2\u001a',
  clearEveryFrame: false,
  components: [
    component('1', -2, [
      component('1.1', 36),
      component('1.2', -2, [component('1.2.1', 16_384, [], 'Acko.net: Texer II')]),
    ]),
    component('2', 6),
  ],
  byteLength: 100,
};

const states = new Map<string, AvsEditorNodeState>([
  ['1', { enabled: true, muted: false, soloed: false }],
  ['1.1', { enabled: true, muted: true, soloed: false }],
  ['1.2', { enabled: false, muted: false, soloed: false }],
  ['1.2.1', { enabled: true, muted: false, soloed: true, supported: false }],
  ['2', { enabled: true, muted: false, soloed: false }],
]);
const model = buildAvsEditorModel(preset, (_component, path) => states.get(path)!);

equal(model.flatNodes.map((node) => node.path).join(','), '1,1.1,1.2,1.2.1,2', 'recursive execution order');
equal(model.nodes[0]?.children[1]?.children[0]?.name, 'Acko.net: Texer II', 'nested APE name');
equal(model.flatNodes[1]?.name, 'SuperScope', 'builtin effect name');
equal(model.flatNodes[0]?.summary, '2 children · replace in / additive out · retain · EEL', 'list blend and code summary');
equal(model.flatNodes[3]?.state.soloed, true, 'host solo state');
equal(model.flatNodes[3]?.state.supported, false, 'host support state');
equal(model.effectCount, 3, 'effect count excludes Effect Lists');
equal(model.listCount, 2, 'recursive list count');
equal(model.maxDepth, 3, 'maximum hierarchy depth');

const calls: string[] = [];
const callbacks = {
  onSetEnabled: (_component: AvsComponent, path: string, value: boolean) => { calls.push(`power:${path}:${value}`); },
  onSetMuted: (_component: AvsComponent, path: string, value: boolean) => { calls.push(`mute:${path}:${value}`); },
  onSetSoloed: (_component: AvsComponent, path: string, value: boolean) => { calls.push(`solo:${path}:${value}`); },
  onMove: (_component: AvsComponent, path: string, parentPath: string | null, direction: -1 | 1) => {
    calls.push(`move:${path}:${parentPath}:${direction}`);
  },
  onSave: () => { calls.push('save'); },
};
dispatchAvsEditorAction(callbacks, model.flatNodes[1]!, { kind: 'muted', value: false });
dispatchAvsEditorAction(callbacks, model.flatNodes[2]!, { kind: 'enabled', value: true });
dispatchAvsEditorAction(callbacks, model.flatNodes[3]!, { kind: 'soloed', value: false });
dispatchAvsEditorMove(callbacks, model.flatNodes[3]!, -1);
dispatchAvsEditorSave(callbacks);
equal(
  calls.join(','),
  'mute:1.1:false,power:1.2:true,solo:1.2.1:false,move:1.2.1:1.2:-1,save',
  'control callbacks retain stable component and parent paths',
);
equal([...parseAvsPayloadHex('00 7f A5 ff')].join(','), '0,127,165,255', 'exact payload hex parser');
let rejectedPayload = false;
try { parseAvsPayloadHex('0 ff'); } catch { rejectedPayload = true; }
equal(rejectedPayload, true, 'payload parser rejects ambiguous one-digit bytes');

console.log(`avs-editor-check: ${assertions} assertions passed`);
