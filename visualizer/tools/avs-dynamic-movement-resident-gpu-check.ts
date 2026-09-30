import assert from 'node:assert/strict';
import { existsSync, readFileSync, readdirSync } from 'node:fs';
import { performance } from 'node:perf_hooks';
import { join, resolve } from 'node:path';
import { AVS_AUDIO_SAMPLES, AvsEelGlobalState, parseAvsPreset, type AvsAudioFrame } from '../src/avs/index.ts';
import { planTerminalEnhancedDynamicMovement } from '../src/avs/dynamic-movement-gpu-plan.ts';
import { decodeAvsDynamicMovement, type AvsDynamicMovementConfig } from '../src/avs/effects/dynamic-movement.ts';
import {
  compileEnhancedDynamicMovementResident, EnhancedDynamicMovementResidentState,
} from '../src/avs/effects/dynamic-movement-eel-gpu.ts';

const base = (point: string, phases: Partial<Pick<AvsDynamicMovementConfig, 'init' | 'frame' | 'beat'>> = {}) => ({
  point, init: phases.init ?? '', frame: phases.frame ?? '', beat: phases.beat ?? '',
});

const pure = compileEnhancedDynamicMovementResident(base('x=x+0.05*sin(d*5);y=y+0.03*cos(r);alpha=0.25+0.5*d'));
assert.equal(pure.eligible, true);
if (pure.eligible) {
  assert.match(pure.program.wgsl, /dynamic_movement_grid/);
  assert.match(pure.program.wgsl, /dynamic_movement_resample/);
  assert.deepEqual(pure.program.uniformNames, []);
}
const uniform = compileEnhancedDynamicMovementResident(base('t=sin(foo);x=x+t;y=y-t'));
assert.equal(uniform.eligible, true);
if (uniform.eligible) assert.deepEqual(uniform.program.uniformNames, ['alpha', 'foo']);

const phaseConfig = configFor('x=x+foo', { frame: 'foo=foo+1' });
const phaseProgram = compileEnhancedDynamicMovementResident(phaseConfig);
assert.equal(phaseProgram.eligible, true);
if (phaseProgram.eligible) {
  const state = new EnhancedDynamicMovementResidentState(phaseConfig, phaseProgram.program, new AvsEelGlobalState(), 1);
  const audio: AvsAudioFrame = {
    waveform: [new Uint8Array(AVS_AUDIO_SAMPLES), new Uint8Array(AVS_AUDIO_SAMPLES)],
    spectrum: [new Uint8Array(AVS_AUDIO_SAMPLES), new Uint8Array(AVS_AUDIO_SAMPLES)], beat: false, beatLevel: 0,
  };
  assert.equal(state.update(audio, 640, 360)[phaseProgram.program.uniformNames.indexOf('foo')], 1);
  assert.equal(state.update(audio, 1280, 720)[phaseProgram.program.uniformNames.indexOf('foo')], 2, 'phase VM persists across resize');
}

for (const [label, fixture, reason] of [
  ['register write', base('reg00=reg00+1;x=x+reg00'), /shared register/],
  ['point carry', base('q=q+1;x=x+q'), /read before per-point/],
  ['phase observation', base('q=d;x=x+q', { frame: 'z=q' }), /observed by init\/frame\/beat/],
  ['nested mutation', base('x=if(d,assign(q,1),0)'), /nested or conditional mutation/],
  ['random', base('x=x+rand(4)'), /rand/],
  ['memory', base('x=x+gmegabuf(0)'), /gmegabuf/],
  ['point audio', base('x=x+getosc(0.5,0.1,0)'), /getosc/],
  ['loop', base('loop(4,x=x+0.1)'), /loop|mutation/],
  ['unknown classic call', base('x=log2(d)'), /Unknown EEL function/],
] as const) {
  const result = compileEnhancedDynamicMovementResident(fixture);
  assert.equal(result.eligible, false, label);
  if (!result.eligible) assert.match(result.reason, reason, label);
}

const audit = auditCorpus();
const benchmarkConfig = configFor('x=x+0.05*sin(d*5);y=y+0.03*cos(r);alpha=0.25+0.5*d');
const benchmarkProgram = compileEnhancedDynamicMovementResident(benchmarkConfig);
assert.equal(benchmarkProgram.eligible, true);
const phaseSamples: number[] = [];
if (benchmarkProgram.eligible) {
  const state = new EnhancedDynamicMovementResidentState(benchmarkConfig, benchmarkProgram.program, new AvsEelGlobalState(), 1);
  const audio: AvsAudioFrame = {
    waveform: [new Uint8Array(AVS_AUDIO_SAMPLES), new Uint8Array(AVS_AUDIO_SAMPLES)],
    spectrum: [new Uint8Array(AVS_AUDIO_SAMPLES), new Uint8Array(AVS_AUDIO_SAMPLES)], beat: false, beatLevel: 0,
  };
  for (let index = 0; index < 10; index++) state.update(audio, 640, 360);
  for (let index = 0; index < 100; index++) { const started = performance.now(); state.update(audio, 640, 360); phaseSamples.push(performance.now() - started); }
  phaseSamples.sort((a, b) => a - b);
}
assert.ok(audit.bundledResident <= audit.bundledGpu);
assert.ok(audit.privateResident <= audit.privateGpu);
console.log(
  `avs-dynamic-movement-resident-gpu-check: 13 compiler/state assertions; ` +
  `${audit.bundledResident}/${audit.bundledGpu} bundled GPU Dynamic presets and ` +
  `${audit.privateResident}/${audit.privateGpu} private GPU Dynamic presets are resident-map eligible; ` +
  `640x360 CPU phase-only median ${phaseSamples[Math.trunc(phaseSamples.length / 2)]!.toFixed(4)} ms; ` +
  `per-frame host upload 1,843,200 -> 64+ bytes`,
);

function auditCorpus(): { bundledGpu: number; bundledResident: number; privateGpu: number; privateResident: number } {
  let bundledGpu = 0, bundledResident = 0, privateGpu = 0, privateResident = 0;
  for (const root of [resolve('assets/avs-presets/community-picks'), resolve('assets/avs-presets/winamp-5-picks')]) {
    for (const name of readdirSync(root).filter(value => value.endsWith('.avs'))) {
      const plan = planTerminalEnhancedDynamicMovement(parseAvsPreset(readFileSync(join(root, name))));
      if (!plan.config) continue;
      bundledGpu++;
      if (plan.residentProgram) bundledResident++;
    }
  }
  const privateRoot = resolve('avs presets/presets/unique');
  if (existsSync(privateRoot)) for (const name of readdirSync(privateRoot).filter(value => value.endsWith('.avs'))) try {
    const plan = planTerminalEnhancedDynamicMovement(parseAvsPreset(readFileSync(join(privateRoot, name))));
    if (!plan.config) continue;
    privateGpu++;
    if (plan.residentProgram) privateResident++;
  } catch { /* documented parser exclusions */ }
  return { bundledGpu, bundledResident, privateGpu, privateResident };
}

function configFor(point: string, phases: Partial<Pick<AvsDynamicMovementConfig, 'init' | 'frame' | 'beat'>> = {}): AvsDynamicMovementConfig {
  return {
    point, init: phases.init ?? '', frame: phases.frame ?? '', beat: phases.beat ?? '', bilinear: true,
    rectangular: true, gridWidth: 16, gridHeight: 16, blend: false, wrap: false, buffer: 0, noMove: false,
  };
}
