import {
  AVS_AUDIO_SAMPLES,
  AvsEffectRegistry,
  AvsExecutor,
  AvsFramebuffer,
  registerAvsCoreEffects,
  type AvsAudioFrame,
  type AvsComponent,
  type AvsEffectListSettings,
  type AvsPresetAst,
} from '../src/avs/index.ts';

let checks = 0;
const settings: AvsEffectListSettings = {
  mode: 0, enabled: true, clearEveryFrame: true,
  inputBlendMode: 0, outputBlendMode: 4,
  inputBlendValue: 128, outputBlendValue: 128,
  inputBuffer: 0, outputBuffer: 0,
  inputInvert: false, outputInvert: false,
  beatRender: false, beatRenderFrames: 1, byteLength: 1,
};
const paint = component(100, '1.1');
const beatOff = component(101, '1.2');
const observer = component(102, '2');
const list: AvsComponent = {
  effectId: -2, apeId: null, payload: new Uint8Array(), fileOffset: 0, path: '1',
  children: [paint, beatOff], list: settings, listCode: null,
};
const preset: AvsPresetAst = {
  version: 2, header: 'Nullsoft AVS Preset 0.2\u001a', clearEveryFrame: false,
  components: [list, observer], byteLength: 0,
};
const registry = new AvsEffectRegistry();
let observedBeat = true;
registry.registerBuiltin(100, ({ input }) => { input.pixels[0] = 0x102030; });
registry.registerBuiltin(101, () => ({ beat: false }));
registry.registerBuiltin(102, ({ input, beat }) => {
  observedBeat = beat;
  input.pixels[1] = 0x010101;
});

const audio = emptyAudio(true);
const output = new AvsFramebuffer(2, 1);
const executor = new AvsExecutor(preset, registry);
const stats = executor.render(output, audio);
equal(output.pixels[0], 0x102030, 'nested list output additive blend');
equal(output.pixels[1], 0x010101, 'later root effect executes');
equal(observedBeat, true, 'nested Effect List beat override is scoped to its children');
equal(stats.lists, 1, 'list counted');
equal(stats.rendered, 3, 'handlers counted');
equal(stats.unsupported, 0, 'no unsupported handlers');

const coreRegistry = registerAvsCoreEffects();
const corePreset: AvsPresetAst = {
  ...preset,
  components: [
    payloadComponent(25, '1', [1, 0x102030, 0, 0, 0]),
    payloadComponent(18, '2', [0, 7, 0, 128]),
    payloadComponent(37, '3', [1]),
    payloadComponent(44, '4', [1]),
  ],
};
const coreOutput = new AvsFramebuffer(1, 1);
const coreExecutor = new AvsExecutor(corePreset, coreRegistry);
coreExecutor.render(coreOutput, emptyAudio(false));
equal(coreOutput.pixels[0], (0x102030 ^ 0xffffff) >>> 1 & 0x7f7f7f, 'clear, buffer, invert, half-bright chain');
equal(coreExecutor.buffers.get(7, 1, 1, false)?.pixels[0], 0x102030, 'Buffer Save stores ordered framebuffer');

// AVS 2.8 Effect List EEL: host variables are refreshed every render while
// arbitrary locals persist, and all list VMs share regXX/gmegabuf.
const eelRegistry = new AvsEffectRegistry();
const listInputs: number[] = [];
const listBeats: boolean[] = [];
let enabledByScriptRenders = 0;
eelRegistry.registerBuiltin(200, ({ input, beat }) => {
  listInputs.push(input.pixels[0]!);
  listBeats.push(beat);
  input.pixels[0] = 0xffffff;
});
eelRegistry.registerBuiltin(201, () => { enabledByScriptRenders++; });
const scriptedList = codedList(
  '1',
  [component(200, '1.1')],
  {
    ...settings,
    clearEveryFrame: false,
    inputBlendMode: 10,
    outputBlendMode: 10,
    inputBlendValue: 255,
    outputBlendValue: 255,
  },
  'ticks=40;reg00+=100;reg02=w;reg03=h',
  'ticks+=1;reg00+=1;reg01=ticks;reg05+=beat;beat=0;clear=1;alphain=.5;alphaout=.25;assign(gmegabuf(7),77);reg06=max(reg06,getosc(.5,.1,1))',
);
const enabledByScript = codedList(
  '2',
  [component(201, '2.1')],
  { ...settings, enabled: false, clearEveryFrame: false, inputBlendMode: 0, outputBlendMode: 0 },
  '',
  'enabled=1;reg20=reg00;reg21=gmegabuf(7)',
);
const eelPreset: AvsPresetAst = { ...preset, components: [scriptedList, enabledByScript] };
const eelExecutor = new AvsExecutor(eelPreset, eelRegistry);
const eelOutput = new AvsFramebuffer(1, 1);
eelOutput.pixels[0] = 0xffffff;
const signal = emptyAudio(true);
signal.waveform[0].fill(64);
eelExecutor.render(eelOutput, signal);
eelOutput.pixels[0] = 0xffffff;
eelExecutor.render(eelOutput, emptyAudio(false));
equal(eelRegistry.eelGlobal.registers[0], 102, 'Effect List init runs once and frame runs every render');
equal(eelRegistry.eelGlobal.registers[1], 42, 'per-list locals persist between frames');
equal(eelRegistry.eelGlobal.registers[2], 1, 'w is available to init code');
equal(eelRegistry.eelGlobal.registers[3], 1, 'h is available to init code');
equal(eelRegistry.eelGlobal.registers[5], 1, 'beat host variable is refreshed before frame code');
equal(listBeats[0], false, 'script-mutated beat reaches list children');
equal(listInputs[0], 0x7f7f7f, 'script-mutated clear and alphain control list input');
equal(listInputs[1], 0x7f7f7f, 'script-mutated clear applies every frame');
equal(enabledByScriptRenders, 2, 'script can enable a disabled list for the current frame');
equal(eelRegistry.eelGlobal.registers[20], 102, 'regXX is shared between list VMs');
equal(eelRegistry.eelGlobal.registers[21], 77, 'gmegabuf is shared between list VMs');
assert(eelRegistry.eelGlobal.registers[6]! > 0, 'list EEL getosc reads the current audio frame');

// Native fake_enabled is loaded on a beat and consumed only by rendered
// frames. A two-frame window includes the beat frame itself.
let beatWindowRenders = 0;
const beatRegistry = new AvsEffectRegistry();
beatRegistry.registerBuiltin(202, () => { beatWindowRenders++; });
const beatList = codedList(
  '1',
  [component(202, '1.1')],
  { ...settings, enabled: false, beatRender: true, beatRenderFrames: 2, clearEveryFrame: false },
  '',
  '',
  false,
);
const beatExecutor = new AvsExecutor({ ...preset, components: [beatList] }, beatRegistry);
const beatOutput = new AvsFramebuffer(1, 1);
beatExecutor.render(beatOutput, emptyAudio(true));
beatExecutor.render(beatOutput, emptyAudio(false));
beatExecutor.render(beatOutput, emptyAudio(false));
equal(beatWindowRenders, 2, 'render-on-beat frame window matches r_list.cpp');

const alphaRegistry = new AvsEffectRegistry();
alphaRegistry.registerBuiltin(204, ({ input }) => { input.pixels[0] = 0xffffff; });
const alphaList = codedList(
  '1',
  [component(204, '1.1')],
  { ...settings, clearEveryFrame: true, inputBlendMode: 0, outputBlendMode: 10 },
  '',
  'alphaout=.25',
);
const alphaOutput = new AvsFramebuffer(1, 1);
new AvsExecutor({ ...preset, components: [alphaList] }, alphaRegistry).render(alphaOutput, emptyAudio(false));
equal(alphaOutput.pixels[0], 0x3f3f3f, 'script alphaout is normalized, truncated, and clamped to a byte');

const preinitRegistry = new AvsEffectRegistry();
const preinitList = codedList(
  '1',
  [],
  { ...settings, clearEveryFrame: false, inputBlendMode: 0, outputBlendMode: 0 },
  'reg30+=1',
  'reg31+=1;reg32+=beat',
);
const preinitExecutor = new AvsExecutor({ ...preset, components: [preinitList] }, preinitRegistry);
const preinitOutput = new AvsFramebuffer(1, 1);
preinitExecutor.render(preinitOutput, emptyAudio(true), true);
preinitExecutor.render(preinitOutput, emptyAudio(true));
equal(preinitRegistry.eelGlobal.registers[30], 1, 'Effect List init executes once across preinit and live frames');
equal(preinitRegistry.eelGlobal.registers[31], 2, 'Effect List frame code executes during preinit and live frames');
equal(preinitRegistry.eelGlobal.registers[32], 1, 'Effect List beat variable is zero during preinit');

const toggleInputs: number[] = [];
const toggleRegistry = new AvsEffectRegistry();
toggleRegistry.registerBuiltin(205, ({ input }) => {
  toggleInputs.push(input.pixels[0]!);
  input.pixels[0] = 0xabcdef;
});
const toggleList = codedList(
  '1',
  [component(205, '1.1')],
  { ...settings, clearEveryFrame: false, inputBlendMode: 0, outputBlendMode: 1 },
  '',
  'frame+=1;enabled=bnot(equal(frame,2))',
);
const toggleExecutor = new AvsExecutor({ ...preset, components: [toggleList] }, toggleRegistry);
const toggleOutput = new AvsFramebuffer(1, 1);
toggleExecutor.render(toggleOutput, emptyAudio(false));
toggleExecutor.render(toggleOutput, emptyAudio(false));
toggleExecutor.render(toggleOutput, emptyAudio(false));
equal(toggleInputs.join(','), '0,0', 'script-disabled list releases its retained framebuffer');

// Replace-in/replace-out is the source fast path: even EEL clear=1 does not
// clear the parent because blendin()==replace bypasses the retained surface.
let fastInput = 0;
const fastRegistry = new AvsEffectRegistry();
fastRegistry.registerBuiltin(203, ({ input }) => { fastInput = input.pixels[0]!; });
const fastList = codedList(
  '1',
  [component(203, '1.1')],
  { ...settings, clearEveryFrame: true, inputBlendMode: 1, outputBlendMode: 1 },
  '',
  'clear=1',
);
const fastOutput = new AvsFramebuffer(1, 1);
fastOutput.pixels[0] = 0x123456;
new AvsExecutor({ ...preset, components: [fastList] }, fastRegistry).render(fastOutput, emptyAudio(false));
equal(fastInput, 0x123456, 'replace fast path does not clear the parent framebuffer');

// Editor controls operate on the real nested AVS graph. Paths are parser-
// stable; solo retains ancestors, list solo includes descendants, multiple
// solos union their branches, and mute/disable always win.
const controlRegistry = new AvsEffectRegistry();
let visits: string[] = [];
controlRegistry.registerBuiltin(300, ({ component: visited }) => { visits.push(visited.path); });
const innerControlList = codedList(
  '2.2', [component(300, '2.2.1')],
  { ...settings, clearEveryFrame: false, inputBlendMode: 1, outputBlendMode: 1 }, '', '', false,
);
const outerControlList = codedList(
  '2', [component(300, '2.1'), innerControlList, component(300, '2.3')],
  { ...settings, clearEveryFrame: false, inputBlendMode: 1, outputBlendMode: 1 }, '', '', false,
);
const controlPreset: AvsPresetAst = {
  ...preset,
  components: [component(300, '1'), outerControlList, component(300, '3')],
};
const controlExecutor = new AvsExecutor(controlPreset, controlRegistry);
const controlOutput = new AvsFramebuffer(1, 1);
const renderVisits = (): string => {
  visits = [];
  controlExecutor.render(controlOutput, emptyAudio(false));
  return visits.join(',');
};
equal(renderVisits(), '1,2.1,2.2.1,2.3,3', 'default controls preserve full traversal');
controlExecutor.setControls([{ path: '2.1', muted: true }]);
equal(renderVisits(), '1,2.2.1,2.3,3', 'muted leaf is bypassed in its real list');
controlExecutor.setControls([{ path: '2', muted: true }]);
equal(renderVisits(), '1,3', 'muted Effect List bypasses its complete subtree');
controlExecutor.setControls([{ path: '2.2.1', solo: true }]);
equal(renderVisits(), '2.2.1', 'solo leaf retains both ancestor lists and filters siblings');
equal(controlExecutor.stats.lists, 2, 'solo leaf executes its ancestor lists');
controlExecutor.setControls([{ path: '2.2', solo: true }]);
equal(renderVisits(), '2.2.1', 'solo Effect List includes its complete subtree');
controlExecutor.setControls([{ path: '2.1', solo: true }, { path: '3', solo: true }]);
equal(renderVisits(), '2.1,3', 'multiple solos compose as a union of branches');
controlExecutor.setControls([{ path: '2', solo: true }, { path: '2.3', muted: true }]);
equal(renderVisits(), '2.1,2.2.1', 'mute wins inside a soloed list');
controlExecutor.setControls([{ path: '2.2.1', solo: true, muted: true }]);
equal(renderVisits(), '', 'mute wins when the same leaf is soloed');
controlExecutor.setControls([{ path: '2.1', enabled: false }]);
equal(renderVisits(), '1,2.2.1,2.3,3', 'disabled leaf uses the same executor bypass boundary');
controlExecutor.setComponentControl('2.1', { muted: true, solo: true });
equal(controlExecutor.controls.length, 1, 'single-path patches replace only that path state');
equal(renderVisits(), '', 'single-path control patch updates live solo selection');
assertThrows(() => controlExecutor.setControls([{ path: 'missing', muted: true }]), /Unknown AVS component path/, 'unknown paths are rejected');
equal(controlExecutor.controls[0]?.path, '2.1', 'rejected control batches are atomic');
assertThrows(
  () => controlExecutor.setControls([{ path: '1', muted: true }, { path: '1', solo: true }]),
  /Duplicate AVS component control path/,
  'duplicate paths are rejected',
);
controlExecutor.setControls([]);
equal(renderVisits(), '1,2.1,2.2.1,2.3,3', 'clearing controls restores the untouched graph');

// The editor contract is visual, not merely a traversal callback. Each leaf
// paints a separate pixel so power/mute/solo can be checked against the exact
// framebuffer bytes a presenter receives.
const pixelRegistry = new AvsEffectRegistry();
pixelRegistry.registerBuiltin(301, ({ input }) => { input.pixels[0] = 0xff0000; });
pixelRegistry.registerBuiltin(302, ({ input }) => { input.pixels[1] = 0x00ff00; });
pixelRegistry.registerBuiltin(303, ({ input }) => { input.pixels[2] = 0x0000ff; });
const pixelExecutor = new AvsExecutor({
  ...preset,
  components: [component(301, '1'), component(302, '2'), component(303, '3')],
}, pixelRegistry);
const pixelOutput = new AvsFramebuffer(3, 1);
const renderPixels = (): string => {
  pixelOutput.clear();
  pixelExecutor.render(pixelOutput, emptyAudio(false));
  return [...pixelOutput.pixels].map((pixel) => pixel.toString(16).padStart(6, '0')).join(',');
};
equal(renderPixels(), 'ff0000,00ff00,0000ff', 'default leaf controls reach rendered pixels');
pixelExecutor.setControls([{ path: '2', muted: true }]);
equal(renderPixels(), 'ff0000,000000,0000ff', 'mute changes rendered pixels');
pixelExecutor.setControls([{ path: '2', enabled: false }]);
equal(renderPixels(), 'ff0000,000000,0000ff', 'power changes rendered pixels');
pixelExecutor.setControls([{ path: '2', solo: true }]);
equal(renderPixels(), '000000,00ff00,000000', 'solo changes rendered pixels');

console.log(`avs-executor-runtime-check: PASS (${checks} assertions)`);

function component(effectId: number, path: string): AvsComponent {
  return {
    effectId, apeId: null, payload: new Uint8Array(), fileOffset: 0, path,
    children: [], list: null, listCode: null,
  };
}

function payloadComponent(effectId: number, path: string, values: readonly number[]): AvsComponent {
  const payload = new Uint8Array(values.length * 4);
  const view = new DataView(payload.buffer);
  values.forEach((value, index) => view.setInt32(index * 4, value, true));
  return { ...component(effectId, path), payload };
}

function codedList(
  path: string,
  children: readonly AvsComponent[],
  list: AvsEffectListSettings,
  init: string,
  frame: string,
  codeEnabled = true,
): AvsComponent {
  return {
    effectId: -2, apeId: null, payload: new Uint8Array(), fileOffset: 0, path,
    children, list,
    listCode: { enabled: codeEnabled, init, frame, raw: new Uint8Array() },
  };
}

function emptyAudio(beat: boolean): AvsAudioFrame {
  return {
    waveform: [new Uint8Array(AVS_AUDIO_SAMPLES), new Uint8Array(AVS_AUDIO_SAMPLES)],
    spectrum: [new Uint8Array(AVS_AUDIO_SAMPLES), new Uint8Array(AVS_AUDIO_SAMPLES)],
    beat, beatLevel: 0,
  };
}

function equal(actual: unknown, expected: unknown, label: string): void {
  checks++;
  if (actual !== expected) throw new Error(`${label}: got ${String(actual)}, expected ${String(expected)}`);
}
function assert(value: unknown, label: string): void {
  checks++;
  if (!value) throw new Error(label);
}
function assertThrows(fn: () => void, pattern: RegExp, label: string): void {
  checks++;
  try {
    fn();
  } catch (error) {
    if (pattern.test(error instanceof Error ? error.message : String(error))) return;
    throw new Error(`${label}: wrong error ${String(error)}`);
  }
  throw new Error(`${label}: did not throw`);
}
