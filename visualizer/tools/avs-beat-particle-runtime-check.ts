import {
  AVS_AUDIO_SAMPLES,
  AvsEffectRegistry,
  AvsExecutor,
  AvsFramebuffer,
  decodeAvsCustomBpm,
  decodeAvsMovingParticle,
  decodeAvsStarfield,
  registerAvsBeatParticleEffects,
  registerAvsCoreEffects,
  type AvsAudioFrame,
  type AvsComponent,
  type AvsPresetAst,
} from '../src/avs/index.ts';

let checks = 0;

const particleConfig = decodeAvsMovingParticle(intPayload([3, 0x123456, 24, 5, 17, 2]));
equal(particleConfig.enabled, 3, 'particle enabled bits');
equal(particleConfig.color, 0x123456, 'particle packed color');
equal(particleConfig.beatSize, 17, 'particle beat size');
equal(particleConfig.blend, 2, 'particle blend mode');

const bpmConfig = decodeAvsCustomBpm(intPayload([1, 0, 1, 0, 600, 3, 2]));
equal(bpmConfig.arbitrary, false, 'BPM arbitrary mode');
equal(bpmConfig.skip, true, 'BPM skip mode');
equal(bpmConfig.arbitraryMilliseconds, 600, 'BPM arbitrary period');
equal(bpmConfig.skipFirst, 2, 'BPM skip-first count');

const starConfig = decodeAvsStarfield(starPayload(1, 0xabcdef, 0, 1, 2.5, 350, 1, 7.5, 12));
equal(starConfig.color, 0xabcdef, 'starfield packed color');
equal(starConfig.speed, 2.5, 'starfield float speed');
equal(starConfig.beatSpeed, 7.5, 'starfield float beat speed');

const single = renderParticle(
  intPayload([1, 0x123456, 0, 1, 1, 0]),
  5, 5, new Array(25).fill(0), false,
);
equal(single[12], 0x123456, 'particle size one draws at center');
equal(Array.from(single).filter(Boolean).length, 1, 'particle size one changes one pixel');

let randomCalls = 0;
const particleRegistry = registerAvsBeatParticleEffects(new AvsEffectRegistry(), {
  random: () => { randomCalls++; return randomCalls === 1 ? 0 : 32; },
});
const beatParticle = renderParticle(
  intPayload([3, 0xffffff, 0, 1, 4, 0]),
  9, 9, new Array(81).fill(0), true, particleRegistry,
);
equal(randomCalls, 2, 'particle beat consumes two deterministic random values');
equal(Array.from(beatParticle).filter((pixel) => pixel === 0xffffff).length, 14, 'particle beat-size circle raster');

const lineRegistry = registerAvsBeatParticleEffects(registerAvsCoreEffects(new AvsEffectRegistry()));
const lineBlend = renderComponents(
  [
    component(40, intPayload([0x80000001]), 'line-mode'),
    component(8, intPayload([1, 0x020202, 0, 1, 1, 3]), 'particle-line'),
  ],
  3, 3, [0, 0, 0, 0, 0x010101, 0, 0, 0, 0], audio(false), lineRegistry,
);
equal(lineBlend[4], 0x030303, 'particle blend 3 honors global line mode');

const starRandom = [4, 4, 128, 0];
let starRandomIndex = 0;
const starRegistry = registerAvsBeatParticleEffects(new AvsEffectRegistry(), {
  random: () => starRandom[starRandomIndex++] ?? 0,
});
const starfield = renderComponents(
  [component(27, starPayload(1, 0xffffff, 0, 0, 0, 3072, 0, 4, 15), 'starfield')],
  8, 8, new Array(64).fill(0), audio(false), starRegistry,
);
equal(starRandomIndex, 4, 'one scaled star consumes four deterministic random values');
equal(starfield[36], 0x0c0c0c, 'starfield projects and shades source star');

arrayEqual(
  beatSequence(intPayload([1, 0, 1, 0, 500, 1, 0]), [true, true, true, false]),
  [false, true, false, false],
  'BPM skip emits every skipCount+1 input beat',
);

arrayEqual(
  beatSequence(intPayload([1, 0, 0, 1, 500, 1, 0]), [false, true, false]),
  [true, false, true],
  'BPM invert overrides downstream beat state',
);

arrayEqual(
  beatSequence(intPayload([1, 0, 1, 0, 500, 0, 1]), [true, true]),
  [false, true],
  'BPM skip-first suppresses initial input beats',
);

let milliseconds = 0;
const timed = beatSequence(
  intPayload([1, 1, 0, 0, 500, 1, 0]),
  [false, false, false, false],
  () => milliseconds,
  () => { milliseconds = milliseconds === 0 ? 500 : milliseconds === 500 ? 501 : 501; },
);
arrayEqual(timed, [false, false, true, false], 'BPM arbitrary timer uses native strict deadline');

arrayEqual(
  beatSequence(intPayload([1, 1, 1, 1, 500, 0, 0]), [false]),
  [false],
  'BPM arbitrary mode takes precedence over skip and invert',
);

console.log(`avs-beat-particle-runtime-check: PASS (${checks} assertions)`);

function renderParticle(
  payload: Uint8Array,
  width: number,
  height: number,
  pixels: readonly number[],
  beat: boolean,
  registry = registerAvsBeatParticleEffects(new AvsEffectRegistry()),
): Uint32Array {
  return renderComponents([component(8, payload, 'particle')], width, height, pixels, audio(beat), registry);
}

function beatSequence(
  payload: Uint8Array,
  input: readonly boolean[],
  now: () => number = () => 0,
  afterFrame?: () => void,
): boolean[] {
  const observed: boolean[] = [];
  const registry = registerAvsBeatParticleEffects(new AvsEffectRegistry(), { now });
  registry.registerBuiltin(100, (context) => { observed.push(context.beat); });
  const executor = executorFor(
    [component(33, payload, 'bpm'), component(100, new Uint8Array(), 'probe')],
    registry,
  );
  for (const beat of input) {
    executor.render(new AvsFramebuffer(1, 1), audio(beat));
    afterFrame?.();
  }
  return observed;
}

function renderComponents(
  components: readonly AvsComponent[],
  width: number,
  height: number,
  pixels: readonly number[],
  frame: AvsAudioFrame,
  registry: AvsEffectRegistry,
): Uint32Array {
  const framebuffer = new AvsFramebuffer(width, height, Uint32Array.from(pixels));
  executorFor(components, registry).render(framebuffer, frame);
  return framebuffer.pixels;
}

function executorFor(components: readonly AvsComponent[], registry: AvsEffectRegistry): AvsExecutor {
  const preset: AvsPresetAst = {
    version: 2, header: 'Nullsoft AVS Preset 0.2\u001a', clearEveryFrame: false,
    components, byteLength: components.reduce((sum, item) => sum + item.payload.length + 32, 0),
  };
  return new AvsExecutor(preset, registry);
}

function component(effectId: number, payload: Uint8Array, path: string): AvsComponent {
  return { effectId, apeId: null, payload, fileOffset: 0, path, children: [], list: null, listCode: null };
}

function intPayload(values: readonly number[]): Uint8Array {
  const payload = new Uint8Array(values.length * 4);
  const view = new DataView(payload.buffer);
  values.forEach((value, index) => view.setInt32(index * 4, value, true));
  return payload;
}

function starPayload(
  enabled: number,
  color: number,
  additive: number,
  average: number,
  speed: number,
  stars: number,
  onBeat: number,
  beatSpeed: number,
  duration: number,
): Uint8Array {
  const payload = new Uint8Array(36);
  const view = new DataView(payload.buffer);
  view.setInt32(0, enabled, true); view.setInt32(4, color, true);
  view.setInt32(8, additive, true); view.setInt32(12, average, true);
  view.setFloat32(16, speed, true); view.setInt32(20, stars, true);
  view.setInt32(24, onBeat, true); view.setFloat32(28, beatSpeed, true);
  view.setInt32(32, duration, true);
  return payload;
}

function audio(beat: boolean): AvsAudioFrame {
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

function arrayEqual(actual: readonly boolean[], expected: readonly boolean[], label: string): void {
  checks++;
  if (actual.length !== expected.length || actual.some((value, index) => value !== expected[index])) {
    throw new Error(`${label}: got [${actual.join(',')}], expected [${expected.join(',')}]`);
  }
}
