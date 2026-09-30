import {
  AVS_AUDIO_SAMPLES,
  AVS_CHANNEL_SHIFT_APE_ID,
  AVS_COLOR_REDUCTION_APE_ID,
  AVS_MULTIPLIER_APE_ID,
  AvsExecutor,
  AvsFramebuffer,
  createAvsCompatibilityRegistry,
  decodeAvsChannelShift,
  decodeAvsColorReduction,
  decodeAvsMultiplier,
  registerAvsNamedApeEffects,
  type AvsAudioFrame,
  type AvsComponent,
  type AvsPresetAst,
} from '../src/avs/index.ts';

let checks = 0;

const shift = decodeAvsChannelShift(intPayload(1021, 0));
equal(shift.mode, 1021, 'Channel Shift mode decoded');
equal(shift.randomizeOnBeat, false, 'Channel Shift beat randomization decoded');
equal(decodeAvsChannelShift(intPayload(1018)).randomizeOnBeat, true, 'partial Channel Shift payload preserves native default');
equal(decodeAvsChannelShift(new Uint8Array(9)).mode, 1020, 'oversized Channel Shift payload is ignored');

const shiftCases: ReadonlyArray<readonly [number, number]> = [
  [1183, 0x112233], // RGB
  [1020, 0x113322], // RBG
  [1018, 0x223311], // GBR
  [1022, 0x221133], // GRB
  [1019, 0x331122], // BRG
  [1021, 0x332211], // BGR
  [1023, 0x112233], // unknown corpus value: native default branch is RGB
];
for (const [mode, expected] of shiftCases) {
  const output = runApe(AVS_CHANNEL_SHIFT_APE_ID, intPayload(mode, 0), [0x112233, 0x112233, 0x112233, 0x112233]);
  equal(output.pixels[0], expected, `Channel Shift resource mode ${mode}`);
}

const randomRegistry = registerAvsNamedApeEffects();
const randomPreset = preset(ape(AVS_CHANNEL_SHIFT_APE_ID, intPayload(1020, 1), 'random'));
const randomExecutor = new AvsExecutor(randomPreset, randomRegistry);
const randomOutput = new AvsFramebuffer(4, 1);
randomOutput.pixels.fill(0x112233);
randomExecutor.render(randomOutput, audio(true));
assert(new Set(shiftCases.slice(0, 6).map((entry) => entry[1])).has(randomOutput.pixels[0]!), 'beat randomization selects a native channel permutation');

const reductionPayload = new Uint8Array(264);
new TextEncoder().encodeInto('unused.bmp', reductionPayload);
new DataView(reductionPayload.buffer).setInt32(260, 2, true);
const reduction = decodeAvsColorReduction(reductionPayload);
equal(reduction.legacyFilename, 'unused.bmp', 'Color Reduction legacy filename decoded');
equal(reduction.levels, 2, 'Color Reduction levels decoded');
equal(decodeAvsColorReduction(new Uint8Array(4)).levels, 0, 'malformed Color Reduction struct is zeroed');
const reduced = runApe(
  AVS_COLOR_REDUCTION_APE_ID,
  reductionPayload,
  new Array<number>(8).fill(0xabcdef),
);
equal(reduced.pixels[0], 0xabcdef, 'Color Reduction preserves native first-four-pixel quirk');
equal(reduced.pixels[3], 0xabcdef, 'Color Reduction preserves all four leading pixels');
equal(reduced.pixels[4], 0x80c0c0, 'Color Reduction masks remaining RGB channels');

equal(decodeAvsMultiplier(intPayload(3)).mode, 3, 'Multiplier mode decoded');
equal(decodeAvsMultiplier(new Uint8Array(3)).mode, 0, 'malformed Multiplier struct is zeroed');
const scalarInvert = runApe(AVS_MULTIPLIER_APE_ID, intPayload(0), [0x123456, 0, 1, 0x010000]);
equal(scalarInvert.pixels[0], 0x123456, 'Multiplier scalar mode preserves native pixel-zero quirk');
equal(Array.from(scalarInvert.pixels.slice(1)).join(','), '0,16777215,16777215', 'Multiplier invert maps nonblack to white');
const scalarStar = runApe(AVS_MULTIPLIER_APE_ID, intPayload(7), [0x123456, 0xffffff, 0xfffffe, 0]);
equal(Array.from(scalarStar.pixels.slice(1)).join(','), '16777215,0,0', 'Multiplier star mode keeps only exact white');

const multiplierCases: ReadonlyArray<readonly [number, number]> = [
  [1, 0xffffff],
  [2, 0x80ffff],
  [3, 0x4080ff],
  [4, 0x102040],
  [5, 0x081020],
  [6, 0x040810],
];
for (const [mode, expected] of multiplierCases) {
  const output = runApe('mUlTiPlIeR', intPayload(mode), [0x204080, 0x204080, 0x123456]);
  equal(output.pixels[0], expected, `Multiplier mode ${mode}`);
  equal(output.pixels[2], 0x123456, `Multiplier mode ${mode} preserves odd trailing pixel`);
}

const preinit = runApe(AVS_MULTIPLIER_APE_ID, intPayload(3), [0x204080, 0x204080], false, true);
equal(preinit.pixels[0], 0x204080, 'named APEs bypass preinit');

const defaultOutput = new AvsFramebuffer(2, 1, Uint32Array.from([0x204080, 0x204080]));
const defaultStats = new AvsExecutor(
  preset(ape(AVS_MULTIPLIER_APE_ID, intPayload(3))),
  createAvsCompatibilityRegistry(),
).render(defaultOutput, audio(false));
equal(defaultStats.unsupported, 0, 'default compatibility registry includes named APEs');
equal(defaultOutput.pixels[0], 0x4080ff, 'default registry executes named APE implementation');

console.log(`avs-named-apes-runtime-check: PASS (${checks} assertions)`);

function runApe(
  apeId: string,
  payload: Uint8Array,
  pixels: readonly number[],
  beat = false,
  preinit = false,
): AvsFramebuffer {
  const output = new AvsFramebuffer(pixels.length, 1, Uint32Array.from(pixels));
  const executor = new AvsExecutor(preset(ape(apeId, payload)), registerAvsNamedApeEffects());
  const stats = executor.render(output, audio(beat), preinit);
  equal(stats.unsupported, 0, `${apeId} dispatches through registerApe`);
  return output;
}

function ape(apeId: string, payload: Uint8Array, path = '1'): AvsComponent {
  return {
    effectId: 16_384, apeId, payload, fileOffset: 0, path,
    children: [], list: null, listCode: null,
  };
}

function preset(component: AvsComponent): AvsPresetAst {
  return {
    version: 2, header: 'Nullsoft AVS Preset 0.2\u001a', clearEveryFrame: false,
    components: [component], byteLength: 0,
  };
}

function audio(beat: boolean): AvsAudioFrame {
  return {
    waveform: [new Uint8Array(AVS_AUDIO_SAMPLES), new Uint8Array(AVS_AUDIO_SAMPLES)],
    spectrum: [new Uint8Array(AVS_AUDIO_SAMPLES), new Uint8Array(AVS_AUDIO_SAMPLES)],
    beat, beatLevel: 0,
  };
}

function intPayload(...values: readonly number[]): Uint8Array {
  const payload = new Uint8Array(values.length * 4);
  const view = new DataView(payload.buffer);
  values.forEach((value, index) => view.setInt32(index * 4, value, true));
  return payload;
}

function equal(actual: unknown, expected: unknown, label: string): void {
  checks++;
  if (actual !== expected) throw new Error(`${label}: got ${String(actual)}, expected ${String(expected)}`);
}
function assert(value: unknown, label: string): void {
  checks++;
  if (!value) throw new Error(label);
}
