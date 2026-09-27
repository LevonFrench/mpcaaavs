// AAAVS V2 temporal operators. These are real history passes, not spatial
// smears pretending to be time. The renderer owns/clears/swaps their rgba16f
// ping-pong targets and composites them in a separate pass.

import { AUDIO_WGSL } from '../audiogpu.ts';
import type { ParamValue, PassContext, PassDescriptor } from '../contracts.ts';
import { PASS_BINDING, PASS_COMMON_WGSL, PASS_GROUP, passBindingsWGSL } from '../renderer.ts';
import body from '../shaders/op-temporal-v2.wgsl';

const PARAMS = `@group(${PASS_GROUP}) @binding(${PASS_BINDING.params}) var<uniform> P : Params;`;
const UNIFORM_FLOATS = 12;
const MODES = { 'temporal-prism': 0, 'slit-memory': 1 } as const;
export type TemporalV2Type = keyof typeof MODES;

export const TEMPORAL_V2_DEFAULTS: Readonly<Record<string, ParamValue>> = {
  tauBeats: 1.5,
  gain: 0.72,
  driftX: 0,
  driftY: 0,
  splitPx: 2,
  rate: 0.25,
  detail: 1,
  focusX: -0.18,
  focusY: 0.08,
  clipKnee: 0.78,
  clipCeiling: 1.24,
};

function num(
  params: Readonly<Record<string, ParamValue>>,
  key: string,
  fallback: number,
  lo: number,
  hi: number,
): number {
  const raw = params[key];
  const value = typeof raw === 'number' && Number.isFinite(raw) ? raw : fallback;
  return value < lo ? lo : value > hi ? hi : value;
}

function pass(type: TemporalV2Type): PassDescriptor {
  const shape = {
    type,
    family: 'feedback' as const,
    input: 'accumulator' as const,
    history: true,
    usesAudio: true,
    uniformFloats: UNIFORM_FLOATS,
    code: '',
  };
  return {
    ...shape,
    code: [PASS_COMMON_WGSL, AUDIO_WGSL, passBindingsWGSL(shape), PARAMS, body].join('\n'),
    defaultResolutionScale: 0.5,
    writeUniforms(out: Float32Array, ctx: PassContext): void {
      const p = ctx.params;
      const dt = Math.max(0, Math.min(Number.isFinite(ctx.dtBeats) ? ctx.dtBeats : 0, 0.5));
      const tau = num(p, 'tauBeats', 1.5, 0.05, 32);
      const keep = Math.exp(-dt / tau);
      const gain = num(p, 'gain', 0.72, 0, 2.5);
      const energy = ctx.audio.bands.mid + ctx.audio.bands.high * 0.45;
      const knee = num(p, 'clipKnee', 0.78, 0, 4);

      out[0] = MODES[type];
      out[1] = keep;
      // Steady-state injection. Opacity belongs to the later composite, not to
      // pixels retained in history.
      out[2] = gain * (1 - keep) * (0.62 + energy * 0.72);
      const barStep = dt / 4;
      out[3] = num(p, 'driftX', 0, -2, 2) * barStep;
      out[4] = num(p, 'driftY', 0, -2, 2) * barStep;
      out[5] = num(p, 'splitPx', 2, 0, 64) / Math.max(1, Math.min(ctx.width, ctx.height));
      out[6] = num(p, 'rate', 0.25, -4, 4);
      out[7] = num(p, 'detail', 1, 0.1, 6);
      out[8] = num(p, 'focusX', -0.18, -1.5, 1.5);
      out[9] = num(p, 'focusY', 0.08, -1.5, 1.5);
      out[10] = knee;
      out[11] = Math.max(num(p, 'clipCeiling', 1.24, 0, 6), knee + 0.05);
    },
  };
}

export const temporalPrismPass = pass('temporal-prism');
export const slitMemoryPass = pass('slit-memory');

export const TEMPORAL_V2_PASSES: readonly PassDescriptor[] = [temporalPrismPass, slitMemoryPass];
