import {
  AVS_AUDIO_SAMPLES,
  AvsExecutor,
  AvsFramebuffer,
  createAvsCompatibilityRegistry,
  registerAvsLowCountBuiltins,
  type AvsAudioFrame,
  type AvsComponent,
  type AvsPresetAst,
} from '../src/avs/index.ts';

let checks = 0;

const gridPayload = ints(1, 0xffffff, 2, 0, 0, 0);
const grid = run(17, gridPayload, 5, 5);
equal(indices(grid), '0,2,4,10,12,14,20,22,24', 'Dot Grid places source-spaced replacement dots');
const movingRegistry = registerAvsLowCountBuiltins();
const movingExecutor = new AvsExecutor(preset(component(17, ints(1, 0xffffff, 4, 256, 0, 0), 'moving')), movingRegistry);
const moving = new AvsFramebuffer(6, 2);
movingExecutor.render(moving, audio(false));
equal(indices(moving), '0,4', 'Dot Grid initial phase');
moving.clear(); movingExecutor.render(moving, audio(false));
equal(indices(moving), '1,5', 'Dot Grid persists 8.8 movement phase');

const simpleAudio = audio(false);
simpleAudio.waveform[0].fill(0);
const simple = run(0, ints(66, 1, 0xffffff), 8, 8, simpleAudio);
assert(indices(simple).length > 0, 'Simple dot scope renders waveform samples');
const simplePreinit = run(0, ints(66, 1, 0xffffff), 4, 4, audio(false), true);
equal(indices(simplePreinit), '', 'Simple bypasses preinit');

const ring = run(14, ints(8, 1, 0xffffff, 8, 0), 32, 24);
assert(indices(ring).length > 10, 'Ring draws its 80-segment spectrum loop');

const grainPayload = ints(1, 0, 0, 100, 1);
const grainInput = new Uint32Array(64).fill(0x808080); grainInput[0] = 0;
const grainA = run(24, grainPayload, 8, 8, audio(false), false, grainInput);
const grainB = run(24, grainPayload, 8, 8, audio(false), false, grainInput);
equal(grainA.pixels[0], 0, 'Grain preserves black pixels');
equal(Array.from(grainA.pixels).join(','), Array.from(grainB.pixels).join(','), 'Grain fixture is deterministic per component path');
assert(grainA.pixels.some((pixel, index) => index > 0 && pixel !== 0x808080), 'Grain scales nonblack pixels');

for (const id of [0, 14, 17, 24]) {
  const framebuffer = new AvsFramebuffer(4, 4);
  const stats = new AvsExecutor(preset(component(id, id === 24 ? ints(0) : new Uint8Array())), createAvsCompatibilityRegistry()).render(framebuffer, audio(false));
  equal(stats.unsupported, 0, `default registry includes builtin ${id}`);
}

console.log(`avs-low-count-builtins-check: PASS (${checks} assertions)`);

function run(id: number, payload: Uint8Array, width: number, height: number, sound = audio(false), preinit = false, pixels?: Uint32Array): AvsFramebuffer {
  const framebuffer = new AvsFramebuffer(width, height, pixels?.slice());
  const stats = new AvsExecutor(preset(component(id, payload)), registerAvsLowCountBuiltins()).render(framebuffer, sound, preinit);
  equal(stats.unsupported, 0, `builtin ${id} dispatches`);
  return framebuffer;
}
function component(effectId: number, payload: Uint8Array, path = '1'): AvsComponent {
  return { effectId, apeId: null, payload, fileOffset: 0, path, children: [], list: null, listCode: null };
}
function preset(value: AvsComponent): AvsPresetAst {
  return { version: 2, header: 'Nullsoft AVS Preset 0.2\u001a', clearEveryFrame: false, components: [value], byteLength: 0 };
}
function audio(beat: boolean): AvsAudioFrame {
  return {
    waveform: [new Uint8Array(AVS_AUDIO_SAMPLES), new Uint8Array(AVS_AUDIO_SAMPLES)],
    spectrum: [new Uint8Array(AVS_AUDIO_SAMPLES), new Uint8Array(AVS_AUDIO_SAMPLES)], beat, beatLevel: 0,
  };
}
function ints(...values: readonly number[]): Uint8Array {
  const bytes = new Uint8Array(values.length * 4); const view = new DataView(bytes.buffer);
  values.forEach((value, index) => view.setInt32(index * 4, value, true)); return bytes;
}
function indices(framebuffer: AvsFramebuffer): string {
  return Array.from(framebuffer.pixels, (pixel, index) => pixel !== 0 ? index : -1).filter((index) => index >= 0).join(',');
}
function equal(actual: unknown, expected: unknown, label: string): void { checks++; if (actual !== expected) throw new Error(`${label}: got ${String(actual)}, expected ${String(expected)}`); }
function assert(value: unknown, label: string): void { checks++; if (!value) throw new Error(label); }
