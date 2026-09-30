import assert from 'node:assert/strict';
import { performance } from 'node:perf_hooks';
import { existsSync, readFileSync, readdirSync } from 'node:fs';
import { join, resolve } from 'node:path';
import {
  AVS_AUDIO_SAMPLES, AvsCompatibilityRuntime, AvsEelGlobalState, parseAvsPreset,
  type AvsAudioFrame, type AvsComponent, type AvsPresetAst,
} from '../src/avs/index.ts';
import { decodeAvsDynamicMovement } from '../src/avs/effects/dynamic-movement.ts';
import { AvsDynamicMovementGpuMapGenerator, type AvsDynamicMovementGpuMap } from '../src/avs/effects/dynamic-movement-gpu.ts';
import { planTerminalEnhancedDynamicMovement } from '../src/avs/dynamic-movement-gpu-plan.ts';

const audio: AvsAudioFrame = {
  waveform: [new Uint8Array(AVS_AUDIO_SAMPLES), new Uint8Array(AVS_AUDIO_SAMPLES)],
  spectrum: [new Uint8Array(AVS_AUDIO_SAMPLES), new Uint8Array(AVS_AUDIO_SAMPLES)], beat: false, beatLevel: 0,
};
const fixtures = [
  { bilinear: false, blend: false, wrap: false }, { bilinear: false, blend: true, wrap: true },
  { bilinear: true, blend: false, wrap: false }, { bilinear: true, blend: true, wrap: true },
] as const;
for (const [fixtureIndex, fixture] of fixtures.entries()) {
  const width = 23 + fixtureIndex * 2, height = 15 + fixtureIndex;
  const component = dynamicComponent(fixture);
  const source = deterministicPixels(width * height, 0x44594e41 + fixtureIndex);
  const runtime = new AvsCompatibilityRuntime(preset(component, false), width, height);
  runtime.framebuffer.pixels.set(source);
  const expected = runtime.render(audio).framebuffer.pixels.slice();
  const config = decodeAvsDynamicMovement(component.payload);
  const generator = new AvsDynamicMovementGpuMapGenerator(config, new AvsEelGlobalState(), hashPath(component.path));
  const map = generator.generate(audio, width, height);
  assert.deepEqual(emulate(source, width, map), expected, `Dynamic Movement GPU map differential ${fixtureIndex}`);
}

const rejectedBuffer = dynamicComponent({ bilinear: true, blend: false, wrap: false, buffer: 1 });
assert.equal(planTerminalEnhancedDynamicMovement(preset(rejectedBuffer, true)).component, null);
const rejectedNoMove = dynamicComponent({ bilinear: true, blend: true, wrap: false, noMove: true });
assert.equal(planTerminalEnhancedDynamicMovement(preset(rejectedNoMove, true)).component, null);
assert.equal(planTerminalEnhancedDynamicMovement(preset(dynamicComponent(fixtures[0]), false)).component, null);

const benchmarkComponent = dynamicComponent({ bilinear: true, blend: true, wrap: true });
const benchmarkConfig = decodeAvsDynamicMovement(benchmarkComponent.payload);
const generator = new AvsDynamicMovementGpuMapGenerator(benchmarkConfig, new AvsEelGlobalState(), hashPath(benchmarkComponent.path));
const benchmarkSource = deterministicPixels(640 * 360, 0x444d4750);
for (let index = 0; index < 5; index++) generator.generate(audio, 640, 360);
const mapSamples: number[] = [], resampleSamples: number[] = [];
let map = generator.generate(audio, 640, 360);
for (let index = 0; index < 30; index++) {
  let started = performance.now(); map = generator.generate(audio, 640, 360); mapSamples.push(performance.now() - started);
  started = performance.now(); emulate(benchmarkSource, 640, map); resampleSamples.push(performance.now() - started);
}
mapSamples.sort((a, b) => a - b); resampleSamples.sort((a, b) => a - b);

const audit = auditCorpus();
console.log(`avs-dynamic-movement-gpu-check: ${fixtures.length} exact map/resample differentials; ` +
  `640x360 CPU map ${median(mapSamples).toFixed(3)} ms, CPU resample ${median(resampleSamples).toFixed(3)} ms; ` +
  `${audit.bundled}/${audit.bundledFiles} bundled and ${audit.privateEligible}/${audit.privateParsed} private presets eligible`);

function emulate(source: Uint32Array, width: number, map: AvsDynamicMovementGpuMap): Uint32Array {
  const output = new Uint32Array(source.length); const table = (a: number, b: number) => Math.trunc((a / 255) * b);
  for (let index = 0; index < source.length; index++) {
    const offset = map.packed[index * 2]!, extra = map.packed[index * 2 + 1]!;
    let sampled = source[offset]!;
    if (map.bilinear) {
      const fx = extra & 255, fy = (extra >>> 8) & 255;
      const weights = [table(255 - fx, 255 - fy), table(fx, 255 - fy), table(255 - fx, fy), table(fx, fy)];
      const pixels = [source[offset]!, source[offset + 1]!, source[offset + width]!, source[offset + width + 1]!];
      const channel = (shift: number) => pixels.reduce((sum, pixel, sample) => sum + table((pixel >>> shift) & 255, weights[sample]!), 0) & 255;
      sampled = channel(0) | (channel(8) << 8) | (channel(16) << 16);
    }
    if (!map.blend) { output[index] = sampled; continue; }
    const alpha = (extra >>> 16) & 255, inverse = 255 - alpha, current = source[index]!;
    const channel = (shift: number) => table((sampled >>> shift) & 255, alpha) + table((current >>> shift) & 255, inverse);
    output[index] = channel(0) | (channel(8) << 8) | (channel(16) << 16);
  }
  return output;
}
function auditCorpus(): { bundled: number; bundledFiles: number; privateEligible: number; privateParsed: number } {
  const roots = [resolve('assets/avs-presets/community-picks'), resolve('assets/avs-presets/winamp-5-picks')];
  let bundled = 0, bundledFiles = 0;
  for (const root of roots) for (const name of readdirSync(root).filter(value => value.endsWith('.avs'))) {
    bundledFiles++; const bytes = readFileSync(join(root, name));
    if (planTerminalEnhancedDynamicMovement(parseAvsPreset(bytes)).component) bundled++;
  }
  const privateRoot = resolve('avs presets/presets/unique'); let privateEligible = 0, privateParsed = 0;
  if (existsSync(privateRoot)) for (const name of readdirSync(privateRoot).filter(value => value.endsWith('.avs'))) try {
    const ast = parseAvsPreset(readFileSync(join(privateRoot, name))); privateParsed++;
    if (planTerminalEnhancedDynamicMovement(ast).component) privateEligible++;
  } catch { /* known parser exclusions */ }
  return { bundled, bundledFiles, privateEligible, privateParsed };
}
function dynamicComponent(options: { bilinear: boolean; blend: boolean; wrap: boolean; buffer?: number; noMove?: boolean }): AvsComponent {
  const strings = ['x=x+0.05*sin(d*5);y=y+0.03*cos(r);alpha=0.25+0.5*d', '', '', ''].map(value => new TextEncoder().encode(value));
  const payload = new Uint8Array(1 + strings.reduce((sum, value) => sum + 4 + value.length, 0) + 32); const view = new DataView(payload.buffer); let offset = 0; payload[offset++] = 1;
  for (const value of strings) { view.setUint32(offset, value.length, true); offset += 4; payload.set(value, offset); offset += value.length; }
  for (const value of [options.bilinear, true, 16, 16, options.blend, options.wrap, options.buffer ?? 0, options.noMove ?? false]) { view.setInt32(offset, Number(value), true); offset += 4; }
  return { effectId: 43, apeId: null, payload, fileOffset: 0, path: '1', children: [], list: null, listCode: null };
}
function preset(component: AvsComponent, clearEveryFrame: boolean): AvsPresetAst { return { version: 2, header: 'Nullsoft AVS Preset 0.2\u001a', clearEveryFrame, components: [component], byteLength: component.payload.length }; }
function deterministicPixels(length: number, seed: number): Uint32Array { const output = new Uint32Array(length); let state = seed; for (let i = 0; i < length; i++) { state ^= state << 13; state ^= state >>> 17; state ^= state << 5; output[i] = state & 0xffffff; } return output; }
function hashPath(path: string): number { let hash = 0x811c9dc5; for (let i = 0; i < path.length; i++) hash = Math.imul(hash ^ path.charCodeAt(i), 0x01000193); return hash >>> 0; }
function median(values: readonly number[]): number { return values[Math.trunc(values.length / 2)]!; }
