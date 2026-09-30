import { readFileSync, readdirSync } from 'node:fs';
import { basename, extname, join, resolve } from 'node:path';
import {
  AVS_AUDIO_SAMPLES,
  AvsAudioAccumulator,
  AvsAudioAnalyser,
  AvsBufferBank,
  AvsFramebuffer,
  avsAudioSample,
  blendPixel,
  parseAvsPreset,
  serializeAvsPreset,
  type AvsComponent,
} from '../src/avs/index.ts';
import { runAvsEelRuntimeFixture } from './avs-eel-runtime-check.ts';

interface CollectionExpectation {
  readonly root: string;
  readonly presets: number;
  readonly components: number;
  readonly listCodeRecords?: number;
}

const collections: readonly CollectionExpectation[] = [
  { root: 'assets/avs-presets/community-picks', presets: 50, components: 1731 },
  // The research inventory's 1,362 raw records include the 2.8+ list-code
  // sentinels. They are metadata records, not renderable child components.
  { root: 'assets/avs-presets/winamp-5-picks', presets: 74, components: 1345, listCodeRecords: 22 },
];

let checks = 0;
runAvsEelRuntimeFixture();
for (const expected of collections) {
  const files = avsFiles(resolve(expected.root));
  equal(files.length, expected.presets, `${basename(expected.root)} preset count`);
  let components = 0;
  let listCodeRecords = 0;
  for (const file of files) {
    const bytes = readFileSync(file);
    let preset;
    try {
      preset = parseAvsPreset(bytes);
    } catch (error) {
      throw new Error(`${file}: ${error instanceof Error ? error.message : String(error)}`, { cause: error });
    }
    equal(preset.byteLength, bytes.byteLength, `${basename(file)} byte length`);
    assert(equalBytes(serializeAvsPreset(preset), bytes), `${basename(file)} lossless round trip`);
    components += count(preset.components);
    listCodeRecords += countListCode(preset.components);
  }
  equal(components, expected.components, `${basename(expected.root)} recursive component count`);
  if (expected.listCodeRecords !== undefined) {
    equal(listCodeRecords, expected.listCodeRecords, `${basename(expected.root)} Effect List code records`);
  }
}

const analyser = new AvsAudioAnalyser();
const left = new Float32Array(AVS_AUDIO_SAMPLES);
const right = new Float32Array(AVS_AUDIO_SAMPLES);
for (let i = 0; i < left.length; i++) {
  left[i] = Math.sin(2 * Math.PI * 12 * i / 512) * 0.8;
  right[i] = Math.sin(2 * Math.PI * 31 * i / 512) * 0.5;
}
const frame = analyser.analyse({ left, right });
equal(frame.waveform[0].length, 576, 'waveform width');
equal(frame.spectrum[0].length, 576, 'spectrum width');
assert(Math.abs(argmaxOddBins(frame.spectrum[0]) - 12) <= 1, 'left FFT peak is in bin 12 Hann lobe');
assert(Math.abs(argmaxOddBins(frame.spectrum[1]) - 31) <= 1, 'right FFT peak is in bin 31 Hann lobe');
const silentFrame = analyser.analyse({ left: new Float32Array(576), right: new Float32Array(576) });
equal(silentFrame.spectrum[0][24], 0, 'Winamp inter-bin interpolation has no temporal spectrum leak');

const accumulator = new AvsAudioAccumulator();
const rawWave = [new Uint8Array(576), new Uint8Array(576)] as const;
const rawSpec = [new Uint8Array(576), new Uint8Array(576)] as const;
rawWave[0][288] = 0x40; rawWave[1][288] = 0xc0;
rawSpec[0][288] = 200; rawSpec[1][288] = 100;
accumulator.push(rawWave, rawSpec);
rawSpec[0].fill(0); rawSpec[1].fill(0);
accumulator.push(rawWave, rawSpec);
const held = accumulator.consume();
assert(held.spectrum[0][288]! > held.spectrum[1][288]!, 'spectrum max-hold preserves channel magnitude');
assert(avsAudioSample(held, 'osc', 0.5, 0, 1) > 0, 'getosc left channel is signed');
assert(avsAudioSample(held, 'osc', 0.5, 0, 2) < 0, 'getosc right channel is signed');
equal(accumulator.consume().spectrum[0][288], 0, 'spectrum hold clears after consume');

equal(blendPixel(0xf02010, 0x3020f0, 'additive'), 0xff40ff, 'AVS saturating add');
equal(blendPixel(0xf02010, 0x3020f0, 'source-minus-destination'), 0xc00000, 'AVS source minus destination');
equal(blendPixel(0xf02010, 0x3020f0, 'destination-minus-source'), 0x0000e0, 'AVS destination minus source');
equal(blendPixel(0xffffff, 0x000000, 'adjustable', 128), 0x808080, 'AVS blend table alpha');
const parent = new AvsFramebuffer(2, 2, new Uint32Array([0, 0, 0, 0]));
const local = new AvsFramebuffer(2, 2, new Uint32Array([1, 2, 3, 4]));
parent.blendFrom(local, 'every-other-pixel');
equal([...parent.pixels].join(','), '1,0,0,4', 'AVS checkerboard interleave');
const bank = new AvsBufferBank();
assert(bank.get(7, 2, 2) === bank.get(7, 2, 2), 'AVS global buffer is persistent');
assert(bank.get(8, 2, 2) === null, 'AVS exposes exactly eight global buffers');

console.log(`avs-compat-runtime-check: PASS (${checks} assertions; 124 presets)`);

function avsFiles(directory: string): string[] {
  const out: string[] = [];
  for (const entry of readdirSync(directory, { withFileTypes: true })) {
    const path = join(directory, entry.name);
    if (entry.isDirectory()) out.push(...avsFiles(path));
    else if (entry.isFile() && extname(entry.name).toLowerCase() === '.avs') out.push(path);
  }
  return out.sort((a, b) => a.localeCompare(b));
}

function count(components: readonly AvsComponent[]): number {
  let total = 0;
  for (const component of components) total += 1 + count(component.children);
  return total;
}

function countListCode(components: readonly AvsComponent[]): number {
  let total = 0;
  for (const component of components) {
    total += (component.listCode ? 1 : 0) + countListCode(component.children);
  }
  return total;
}

function argmaxOddBins(spectrum: Uint8Array): number {
  let best = -1;
  let value = -1;
  for (let bin = 0; bin < 256; bin++) {
    const next = spectrum[bin * 2 + 1]!;
    if (next > value) { value = next; best = bin; }
  }
  return best;
}

function equal(actual: unknown, expected: unknown, label: string): void {
  checks++;
  if (actual !== expected) throw new Error(`${label}: got ${String(actual)}, expected ${String(expected)}`);
}

function assert(condition: boolean, label: string): void {
  checks++;
  if (!condition) throw new Error(label);
}

function equalBytes(a: Uint8Array, b: Uint8Array): boolean {
  if (a.length !== b.length) return false;
  for (let i = 0; i < a.length; i++) if (a[i] !== b[i]) return false;
  return true;
}
