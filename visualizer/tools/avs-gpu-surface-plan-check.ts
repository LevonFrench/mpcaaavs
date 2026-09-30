import {
  planAvsResidentSurfaces,
  type AvsResidentOperation,
} from '../src/avs/gpu-surface-plan.ts';
import type { AvsComponent, AvsEffectListSettings, AvsPresetAst } from '../src/avs/types.ts';

let assertions = 0;
const assert = (condition: unknown, message: string): asserts condition => {
  assertions++;
  if (!condition) throw new Error(message);
};

const exact = { id: 'test-exact-u32', byteExact: true, readbackFree: true } as const;
const nested = list('0', settings({ inputBlendMode: 12, inputBuffer: 2, outputBlendMode: 4 }), [
  list('0/0', settings({ inputBlendMode: 1, outputBlendMode: 1 }), [
    effect('0/0/0', 6),
    bufferSave('0/0/1', 2, 3, 11, 77),
  ]),
  bufferSave('0/1', 1, 5, 0, 128),
], true);
const plan = planAvsResidentSurfaces(preset([nested], false), {
  effectCapability: component => component.effectId === 6 ? exact : null,
});

assert(plan.eligible, 'nested list/buffer plan should be eligible with an exact effect capability');
assert(plan.framebufferReadbacks === 0, 'resident plan must never introduce a framebuffer readback');
assert(plan.rootFeedbackResident, 'non-clearing root must remain resident across frames');
const ids = new Set(plan.surfaces.map(surface => surface.id));
for (const id of [
  '$root', '$root:alternate', '$list:0:retained', '$list:0:alternate',
  '$list:0/0:fast-alternate', '$global:2', '$global:3', '$global:5',
]) assert(ids.has(id as never), `missing resident surface ${id}`);
assert(plan.residentBytesPerPixel === plan.surfaces.length * 4, 'resident byte upper bound must be packed u32 per surface');
const outerScope = plan.scopes.find(scope => scope.id === '$list:0');
const innerScope = plan.scopes.find(scope => scope.id === '$list:0/0');
assert(outerScope?.primary === '$list:0:retained', 'retained list scope must own its physical primary');
assert(innerScope?.primary === null && innerScope.aliasesParentCurrent === '$list:0', 'fast list scope must alias the parent current slot');

const enterOuter = operation(plan.operations, 'list-enter', '0');
assert(!enterOuter.direct && enterOuter.target === '$list:0:retained', 'non-fast list must target retained local surface');
assert(enterOuter.blend?.mode === 'buffer-depth', 'list input must preserve buffer-depth blend');
assert(enterOuter.blend.depth === '$global:2', 'list input must bind the selected global depth buffer');
assert(enterOuter.cpuControl, 'script/list gating must remain an explicit CPU control dependency');
const enterInner = operation(plan.operations, 'list-enter', '0/0');
assert(enterInner.direct && enterInner.target === '$list:0:retained', 'replace/replace list must alias its parent');
assert(enterInner.blend === null, 'replace/replace fast path must not schedule redundant blend passes');
const alternating = operation(plan.operations, 'buffer-save', '0/0/1');
assert(alternating.buffer === '$global:3', 'Buffer Save must bind the clamped global buffer identity');
assert(alternating.framebufferScope === '$list:0/0', 'Buffer Save must resolve the logical current slot at execution time');
assert(alternating.alternatesEachFrame, 'direction >= 2 must retain native alternating direction state');
assert(alternating.possibleDirections.join(',') === 'store,load', 'alternating Buffer Save must model both dependencies');
assert(alternating.createsBuffer, 'alternating Buffer Save lazily creates its buffer');
assert(alternating.blendMode === 'adjustable' && alternating.amount === 77, 'Buffer Save blend configuration must be exact');
const loadOnly = operation(plan.operations, 'buffer-save', '0/1');
assert(loadOnly.possibleDirections.join(',') === 'load', 'direction 1 must be load-only');
assert(!loadOnly.createsBuffer, 'load-only Buffer Save must preserve absent-buffer no-op semantics');

const unsupported = planAvsResidentSurfaces(preset([effect('0', 15)]), { effectCapability: () => null });
assert(!unsupported.eligible, 'missing renderer capability must fail closed');
assert(unsupported.issues[0]?.code === 'unsupported-renderer', 'missing capability must identify renderer issue');
const approximate = planAvsResidentSurfaces(preset([effect('0', 15)]), {
  effectCapability: () => ({ id: 'approximate', byteExact: false, readbackFree: true }),
});
assert(!approximate.eligible, 'approximate capability must be rejected from exact resident plan');
const readback = planAvsResidentSurfaces(preset([effect('0', 15)]), {
  effectCapability: () => ({ id: 'readback', byteExact: true, readbackFree: false }),
});
assert(!readback.eligible, 'capability requiring readback must be rejected');

const invalidBlend = planAvsResidentSurfaces(preset([
  list('0', settings({ inputBlendMode: 99, outputBlendMode: 1 }), []),
]));
assert(!invalidBlend.eligible, 'unknown list blend must fail closed');
assert(invalidBlend.issues.some(issue => issue.code === 'unsupported-list-blend'), 'unknown list blend issue missing');

const controls = planAvsResidentSurfaces(preset([
  effect('0', 21), effect('1', 33), effect('2', 40), bufferSave('3'),
]));
assert(controls.eligible, 'CPU controls and Buffer Save resource operations need no visual effect capability');
assert(controls.operations.filter(op => op.kind === 'cpu-control').length === 3, 'all CPU control operations must be retained');

console.log(`AVS GPU resident surface plan: ${assertions} assertions passed`);

function operation<K extends AvsResidentOperation['kind']>(
  operations: readonly AvsResidentOperation[], kind: K, path: string,
): Extract<AvsResidentOperation, { kind: K }> {
  const result = operations.find(op => op.kind === kind && 'path' in op && op.path === path);
  assert(result, `missing ${kind} operation ${path}`);
  return result as Extract<AvsResidentOperation, { kind: K }>;
}

function preset(components: readonly AvsComponent[], clearEveryFrame = true): AvsPresetAst {
  return { version: 2, header: 'test', clearEveryFrame, components, byteLength: 0 };
}

function effect(path: string, effectId: number): AvsComponent {
  return { effectId, apeId: null, payload: new Uint8Array(), fileOffset: 0, path, children: [], list: null, listCode: null };
}

function list(
  path: string, config: AvsEffectListSettings, children: readonly AvsComponent[], code = false,
): AvsComponent {
  return {
    effectId: -2, apeId: null, payload: new Uint8Array(), fileOffset: 0, path, children,
    list: config,
    listCode: code ? { enabled: true, init: '', frame: 'enabled=1;', raw: new Uint8Array() } : null,
  };
}

function settings(patch: Partial<AvsEffectListSettings> = {}): AvsEffectListSettings {
  return {
    mode: 0, enabled: true, clearEveryFrame: false,
    inputBlendMode: 1, outputBlendMode: 1,
    inputBlendValue: 128, outputBlendValue: 128,
    inputBuffer: 0, outputBuffer: 0,
    inputInvert: false, outputInvert: false,
    beatRender: false, beatRenderFrames: 0, byteLength: 24,
    ...patch,
  };
}

function bufferSave(path: string, direction = 0, buffer = 0, blend = 0, amount = 128): AvsComponent {
  const payload = new Uint8Array(16);
  const view = new DataView(payload.buffer);
  view.setInt32(0, direction, true);
  view.setInt32(4, buffer, true);
  view.setInt32(8, blend, true);
  view.setInt32(12, amount, true);
  return { ...effect(path, 18), payload };
}
