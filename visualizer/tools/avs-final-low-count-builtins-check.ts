import { AVS_AUDIO_SAMPLES, AvsExecutor, AvsFramebuffer, createAvsCompatibilityRegistry, registerAvsFinalLowCountBuiltins, type AvsAudioFrame, type AvsComponent, type AvsPresetAst } from '../src/avs/index.ts';

let checks = 0;

const source = Uint32Array.from({ length: 16 }, (_, index) => index * 0x010101);
const roto = run(9, ints(31, 32, 0, 0, 0, 31, 0, 0), 4, 4, audio(false), source);
equal(Array.from(roto.pixels).join(','), '0,65793,131586,0,263172,328965,394758,263172,526344,592137,657930,526344,0,65793,131586,0', 'Roto Blitter preserves native width-minus-one wrapping');
const blendedRoto = run(9, ints(31, 32, 1, 0, 0, 31, 0, 0), 4, 4, audio(false), source);
equal(blendedRoto.pixels[5], 0x040404, 'Roto Blitter average path uses native half-sum rounding');
assert(blendedRoto.pixels[3] !== source[3], 'Roto Blitter average path blends wrapped edge samples');

const interferenceSource = Uint32Array.from({ length: 9 }, (_, index) => (index + 1) * 0x10101);
const interferencePayload = floatTail([1, 1, 0, 0, 255, 0, 0, 0, 0, 255, 0, 0, 0], 0);
const interference = run(41, interferencePayload, 3, 3, audio(false), interferenceSource);
equal(Array.from(interference.pixels).join(','), Array.from(interferenceSource).join(','), 'Interferences one-point zero-distance compositor');

const sound = audio(true); sound.waveform[0].fill(127, 0, 30);
const fountain = run(19, ints(16, 0x000000, 0x0000ff, 0x00ff00, 0xff0000, 0xffffff, -20, 0), 64, 48, sound);
assert(fountain.pixels.some((pixel) => pixel !== 0), 'Dot Fountain projects newly emitted audio particles');
const fountainExecutor = new AvsExecutor(preset(component(19, ints(16, 0, 0xff, 0xff00, 0xff0000, 0xffffff, -20, 0), 'persistent')), registerAvsFinalLowCountBuiltins());
const first = new AvsFramebuffer(64, 48), second = new AvsFramebuffer(64, 48);
fountainExecutor.render(first, sound); fountainExecutor.render(second, audio(false));
assert(indices(first) !== indices(second), 'Dot Fountain persists and ages its 7,680-particle field');

for (const id of [9, 19, 41]) {
  const stats = new AvsExecutor(preset(component(id, id === 41 ? ints(0) : new Uint8Array())), createAvsCompatibilityRegistry()).render(new AvsFramebuffer(4, 4), audio(false));
  equal(stats.unsupported, 0, `default registry includes builtin ${id}`);
}

console.log(`avs-final-low-count-builtins-check: PASS (${checks} assertions)`);

function run(id: number, payload: Uint8Array, width: number, height: number, sound: AvsAudioFrame, pixels?: Uint32Array): AvsFramebuffer {
  const framebuffer = new AvsFramebuffer(width, height, pixels?.slice());
  const stats = new AvsExecutor(preset(component(id, payload)), registerAvsFinalLowCountBuiltins()).render(framebuffer, sound);
  equal(stats.unsupported, 0, `builtin ${id} dispatches`); return framebuffer;
}
function component(effectId: number, payload: Uint8Array, path = '1'): AvsComponent { return { effectId, apeId: null, payload, fileOffset: 0, path, children: [], list: null, listCode: null }; }
function preset(value: AvsComponent): AvsPresetAst { return { version: 2, header: 'Nullsoft AVS Preset 0.2\u001a', clearEveryFrame: false, components: [value], byteLength: 0 }; }
function audio(beat: boolean): AvsAudioFrame { return { waveform: [new Uint8Array(AVS_AUDIO_SAMPLES), new Uint8Array(AVS_AUDIO_SAMPLES)], spectrum: [new Uint8Array(AVS_AUDIO_SAMPLES), new Uint8Array(AVS_AUDIO_SAMPLES)], beat, beatLevel: 0 }; }
function ints(...values: readonly number[]): Uint8Array { const bytes = new Uint8Array(values.length * 4), view = new DataView(bytes.buffer); values.forEach((value, index) => view.setInt32(index * 4, value, true)); return bytes; }
function floatTail(values: readonly number[], value: number): Uint8Array { const bytes = ints(...values), extended = new Uint8Array(bytes.length + 4); extended.set(bytes); new DataView(extended.buffer).setFloat32(bytes.length, value, true); return extended; }
function indices(framebuffer: AvsFramebuffer): string { return Array.from(framebuffer.pixels, (pixel, index) => pixel ? index : -1).filter((index) => index >= 0).join(','); }
function equal(actual: unknown, expected: unknown, label: string): void { checks++; if (actual !== expected) throw new Error(`${label}: got ${String(actual)}, expected ${String(expected)}`); }
function assert(value: unknown, label: string): void { checks++; if (!value) throw new Error(label); }
