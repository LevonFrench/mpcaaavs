import assert from 'node:assert/strict';
import { existsSync, readFileSync, readdirSync } from 'node:fs';
import { performance } from 'node:perf_hooks';
import { join, resolve } from 'node:path';
import {
  AVS_AUDIO_SAMPLES, AvsEffectRegistry, AvsExecutor, AvsFramebuffer, parseAvsPreset, registerAvsMovement,
  type AvsAudioFrame, type AvsComponent, type AvsPresetAst,
} from '../src/avs/index.ts';
import { compileEnhancedMovementEelGpu } from '../src/avs/effects/movement-eel-gpu.ts';
import { decodeAvsMovement } from '../src/avs/effects/movement.ts';
import { planTerminalEnhancedMovementEel } from '../src/avs/movement-eel-gpu-plan.ts';

const pure = compileEnhancedMovementEelGpu(config('x=x+0.03*sin(d*8);y=y+0.02*cos(r)'));
assert.equal(pure.eligible, true);
if (pure.eligible) {
  assert.match(pure.program.wgsl, /movement_eel_map/);
  assert.match(pure.program.wgsl, /movement_eel_sample/);
  assert.deepEqual(pure.program.uniformNames, []);
}
const globals = compileEnhancedMovementEelGpu(config('x=x+reg00;y=y'));
assert.equal(globals.eligible, true);
if (globals.eligible) assert.deepEqual(globals.program.uniformNames, ['reg00']);

for (const [label, movement, reason] of [
  ['forward', config('x=x', { sourceMapped: 1 }), /forward|source mapping/],
  ['toggle', config('x=x', { sourceMapped: 2 }), /forward|beat-toggled/],
  ['register mutation', config('reg00=reg00+1;x=x+reg00'), /shared register/],
  ['point carry', config('q=q+1;x=x+q'), /read before per-point/],
  ['dimension mutation', config('sw=sw+1;x=x/sw'), /loop-carried dimension/],
  ['nested mutation', config('x=if(d,assign(q,1),0)'), /nested or conditional mutation/],
  ['random', config('x=x+rand(4)'), /rand/],
  ['memory', config('x=x+gmegabuf(0)'), /gmegabuf/],
  ['audio', config('x=x+getosc(0.5,0.1,0)'), /getosc/],
  ['loop', config('loop(4,x=x+0.1)'), /loop|mutation/],
] as const) {
  const result = compileEnhancedMovementEelGpu(movement);
  assert.equal(result.eligible, false, label);
  if (!result.eligible) assert.match(result.reason, reason, label);
}

const root = preset(component(config('x=x+1/sw;y=y')), true);
assert.ok(planTerminalEnhancedMovementEel(root).component);
assert.equal(planTerminalEnhancedMovementEel(preset(component(config('x=x')), false)).component, null);

const cpu = benchmarkCpuTable();
const audit = auditCorpus();
console.log(
  `avs-movement-eel-gpu-check: 14 compiler/planner assertions; ` +
  `640x360 CPU first render ${cpu.first.toFixed(3)} ms vs cached sample ${cpu.cached.toFixed(3)} ms ` +
  `(map estimate ${Math.max(0, cpu.first - cpu.cached).toFixed(3)} ms); ` +
  `pure compiler ${audit.bundledPure}/${audit.bundledInverse} bundled inverse and ${audit.privatePure}/${audit.privateInverse} private inverse; ` +
  `live fail-closed ${audit.bundledEligible}/${audit.bundledCustom} bundled and ${audit.privateEligible}/${audit.privateCustom} private root-terminal custom Movement`,
);

function benchmarkCpuTable(): { first: number; cached: number } {
  const first: number[] = [], cached: number[] = [], audio = emptyAudio(), source = pixels(640 * 360);
  for (let sample = 0; sample < 12; sample++) {
    const presetAst = preset(component(config('x=x+0.03*sin(d*8);y=y+0.02*cos(r)', { subpixel: true, wrap: true, blend: true })), true);
    const executor = new AvsExecutor(presetAst, registerAvsMovement(new AvsEffectRegistry()));
    let frame = new AvsFramebuffer(640, 360, source);
    let started = performance.now(); executor.render(frame, audio); first.push(performance.now() - started);
    frame = new AvsFramebuffer(640, 360, source);
    started = performance.now(); executor.render(frame, audio); cached.push(performance.now() - started);
  }
  first.sort((a, b) => a - b); cached.sort((a, b) => a - b);
  return { first: first[Math.trunc(first.length / 2)]!, cached: cached[Math.trunc(cached.length / 2)]! };
}

function auditCorpus(): { bundledCustom: number; bundledInverse: number; bundledPure: number; bundledEligible: number; privateCustom: number; privateInverse: number; privatePure: number; privateEligible: number } {
  let bundledCustom = 0, bundledInverse = 0, bundledPure = 0, bundledEligible = 0;
  let privateCustom = 0, privateInverse = 0, privatePure = 0, privateEligible = 0;
  const inspect = (ast: AvsPresetAst, bundled: boolean): void => {
    const last = ast.components.at(-1);
    if (!last || last.list || last.apeId || last.effectId !== 15) return;
    const movement = decodeAvsMovement(last.payload); if (movement.effect !== 32_767) return;
    if (bundled) bundledCustom++; else privateCustom++;
    if (movement.sourceMapped === 0) {
      if (bundled) bundledInverse++; else privateInverse++;
      if (compileEnhancedMovementEelGpu(movement).eligible) { if (bundled) bundledPure++; else privatePure++; }
    }
    if (planTerminalEnhancedMovementEel(ast).component) { if (bundled) bundledEligible++; else privateEligible++; }
  };
  for (const root of [resolve('assets/avs-presets/community-picks'), resolve('assets/avs-presets/winamp-5-picks')]) {
    for (const name of readdirSync(root).filter(value => value.endsWith('.avs'))) inspect(parseAvsPreset(readFileSync(join(root, name))), true);
  }
  const privateRoot = resolve('avs presets/presets/unique');
  if (existsSync(privateRoot)) for (const name of readdirSync(privateRoot).filter(value => value.endsWith('.avs'))) try {
    inspect(parseAvsPreset(readFileSync(join(privateRoot, name))), false);
  } catch { /* documented parser exclusions */ }
  return { bundledCustom, bundledInverse, bundledPure, bundledEligible, privateCustom, privateInverse, privatePure, privateEligible };
}

function config(expression: string, options: Partial<ReturnType<typeof decodeAvsMovement>> = {}): ReturnType<typeof decodeAvsMovement> {
  return { effect: 32_767, expression, blend: false, sourceMapped: 0, rectangular: true, subpixel: false, wrap: false, ...options };
}
function component(movement: ReturnType<typeof decodeAvsMovement>): AvsComponent {
  const expression = new TextEncoder().encode(`${movement.expression}\0`), payload = new Uint8Array(4 + 1 + 4 + expression.length + 20), view = new DataView(payload.buffer); let offset = 0;
  view.setInt32(offset, movement.effect, true); offset += 4; payload[offset++] = 1; view.setInt32(offset, expression.length, true); offset += 4; payload.set(expression, offset); offset += expression.length;
  for (const value of [movement.blend, movement.sourceMapped, movement.rectangular, movement.subpixel, movement.wrap]) { view.setInt32(offset, Number(value), true); offset += 4; }
  return { effectId: 15, apeId: null, payload, fileOffset: 0, path: '1', children: [], list: null, listCode: null };
}
function preset(value: AvsComponent, clearEveryFrame: boolean): AvsPresetAst { return { version: 2, header: 'Nullsoft AVS Preset 0.2\u001a', clearEveryFrame, components: [value], byteLength: value.payload.length }; }
function emptyAudio(): AvsAudioFrame { return { waveform: [new Uint8Array(AVS_AUDIO_SAMPLES), new Uint8Array(AVS_AUDIO_SAMPLES)], spectrum: [new Uint8Array(AVS_AUDIO_SAMPLES), new Uint8Array(AVS_AUDIO_SAMPLES)], beat: false, beatLevel: 0 }; }
function pixels(length: number): Uint32Array { const output = new Uint32Array(length); let state = 0x4d4f5645; for (let i = 0; i < length; i++) { state ^= state << 13; state ^= state >>> 17; state ^= state << 5; output[i] = state & 0xffffff; } return output; }
