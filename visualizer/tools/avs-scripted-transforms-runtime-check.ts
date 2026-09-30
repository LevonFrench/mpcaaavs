import {
  AVS_AUDIO_SAMPLES,
  AvsEffectRegistry,
  AvsExecutor,
  AvsFramebuffer,
  decodeAvsDynamicColorModifier,
  decodeAvsDynamicDistanceModifier,
  decodeAvsDynamicShift,
  decodeAvsUniqueTone,
  registerAvsScriptedTransforms,
  type AvsAudioFrame,
  type AvsComponent,
  type AvsPresetAst,
} from '../src/avs/index.ts';

let checks = 0;

const colorPayload = scriptedPayload(['red=1-red', 'f=f+1', 'f=f+10', 'f=1'], [1]);
const colorConfig = decodeAvsDynamicColorModifier(colorPayload);
equal(colorConfig.level, 'red=1-red', 'color modifier level script');
equal(colorConfig.recompute, true, 'color modifier recompute flag');

const legacyShift = legacyScriptedPayload(['x=2', 'x=x+1', 'x=x+10'], [0, 0]);
const shiftConfig = decodeAvsDynamicShift(legacyShift);
equal(shiftConfig.init, 'x=2', 'dynamic shift legacy init script');
equal(shiftConfig.subpixel, false, 'dynamic shift legacy subpixel flag');

const distanceConfig = decodeAvsDynamicDistanceModifier(scriptedPayload(['d=0', '', '', ''], [1, 1]));
equal(distanceConfig.point, 'd=0', 'distance modifier point script');
equal(distanceConfig.blend, true, 'distance modifier blend flag');
equal(distanceConfig.subpixel, true, 'distance modifier subpixel flag');

const toneConfig = decodeAvsUniqueTone(intPayload([1, 0x123456, 1, 0, 1]));
equal(toneConfig.color, 0x123456, 'unique tone packed color');
equal(toneConfig.invert, true, 'unique tone invert flag');

const color = render(
  45,
  scriptedPayload(['red=1-red;green=green/2;blue=getspec(0,0,1)', '', '', ''], [1]),
  1, 1, [0x804020], audio(false, 255),
);
equal(color[0], 0x7f20ff, 'dynamic color LUT and getspec host');

const shiftRegistry = registerAvsScriptedTransforms(new AvsEffectRegistry());
shiftRegistry.eelGlobal.registers[0] = 1;
const shifted = render(
  42,
  scriptedPayload(['', 'x=reg00;y=0', ''], [0, 0]),
  3, 2, [1, 2, 3, 4, 5, 6], audio(false), shiftRegistry,
);
arrayEqual(shifted, [0, 1, 2, 0, 4, 5], 'dynamic shift reads shared EEL register');

const subpixel = render(
  42,
  scriptedPayload(['', 'x=.5;y=-.5', ''], [0, 1]),
  3, 3,
  [0x000000, 0xffffff, 0x000000, 0x000000, 0xffffff, 0x000000, 0x000000, 0xffffff, 0x000000],
  audio(false),
);
equal(subpixel[4], 0x7f7f7f, 'dynamic shift portable bilinear sample');

const radialInput = Array.from({ length: 16 }, (_, index) => index + 1);
const radial = render(
  35,
  scriptedPayload(['d=0', '', '', ''], [0, 0]),
  4, 4, radialInput, audio(false),
);
arrayEqual(radial, new Array(16).fill(11), 'dynamic distance zero maps every radius to center');

const tone = render(38, intPayload([1, 0xff0000, 0, 0, 0]), 2, 1, [0x204080, 0xffffff], audio(false));
arrayEqual(tone, [0x800000, 0xff0000], 'unique tone uses maximum input channel depth');

const invertedTone = render(38, intPayload([1, 0x00ff00, 0, 0, 1]), 1, 1, [0x000000], audio(false));
equal(invertedTone[0], 0x00ff00, 'unique tone inverted depth');

const additiveTone = render(38, intPayload([1, 0xff0000, 1, 1, 0]), 1, 1, [0x808080], audio(false));
equal(additiveTone[0], 0xff8080, 'unique tone additive takes precedence over average');

console.log(`avs-scripted-transforms-runtime-check: PASS (${checks} assertions)`);

function render(
  effectId: number,
  payload: Uint8Array,
  width: number,
  height: number,
  pixels: readonly number[],
  frame: AvsAudioFrame,
  registry = registerAvsScriptedTransforms(new AvsEffectRegistry()),
): Uint32Array {
  const component: AvsComponent = {
    effectId, apeId: null, payload, fileOffset: 0, path: `effect-${effectId}`,
    children: [], list: null, listCode: null,
  };
  const preset: AvsPresetAst = {
    version: 2, header: 'Nullsoft AVS Preset 0.2\u001a', clearEveryFrame: false,
    components: [component], byteLength: payload.length + 32,
  };
  const framebuffer = new AvsFramebuffer(width, height, Uint32Array.from(pixels));
  new AvsExecutor(preset, registry).render(framebuffer, frame);
  return framebuffer.pixels;
}

function scriptedPayload(scripts: readonly string[], integers: readonly number[]): Uint8Array {
  const encoded = scripts.map((script) => new TextEncoder().encode(`${script}\0`));
  const length = 1 + encoded.reduce((sum, bytes) => sum + 4 + bytes.length, 0) + integers.length * 4;
  const payload = new Uint8Array(length);
  const view = new DataView(payload.buffer);
  let offset = 0;
  payload[offset++] = 1;
  for (const bytes of encoded) {
    view.setInt32(offset, bytes.length, true); offset += 4;
    payload.set(bytes, offset); offset += bytes.length;
  }
  for (const value of integers) { view.setInt32(offset, value, true); offset += 4; }
  return payload;
}

function legacyScriptedPayload(scripts: readonly string[], integers: readonly number[]): Uint8Array {
  const payload = new Uint8Array(scripts.length * 256 + integers.length * 4);
  for (let i = 0; i < scripts.length; i++) {
    payload.set(new TextEncoder().encode(scripts[i]!).subarray(0, 255), i * 256);
  }
  const view = new DataView(payload.buffer);
  let offset = scripts.length * 256;
  for (const value of integers) { view.setInt32(offset, value, true); offset += 4; }
  return payload;
}

function intPayload(values: readonly number[]): Uint8Array {
  const payload = new Uint8Array(values.length * 4);
  const view = new DataView(payload.buffer);
  values.forEach((value, index) => view.setInt32(index * 4, value, true));
  return payload;
}

function audio(beat: boolean, firstSpectrum = 0): AvsAudioFrame {
  const spectrum = [new Uint8Array(AVS_AUDIO_SAMPLES), new Uint8Array(AVS_AUDIO_SAMPLES)] as const;
  spectrum[0][0] = firstSpectrum;
  return {
    waveform: [new Uint8Array(AVS_AUDIO_SAMPLES), new Uint8Array(AVS_AUDIO_SAMPLES)],
    spectrum, beat, beatLevel: 0,
  };
}

function equal(actual: unknown, expected: unknown, label: string): void {
  checks++;
  if (actual !== expected) throw new Error(`${label}: got ${String(actual)}, expected ${String(expected)}`);
}

function arrayEqual(actual: ArrayLike<number>, expected: readonly number[], label: string): void {
  checks++;
  const values = Array.from(actual);
  if (values.length !== expected.length || values.some((value, index) => value !== expected[index])) {
    throw new Error(`${label}: got [${values.join(',')}], expected [${expected.join(',')}]`);
  }
}
