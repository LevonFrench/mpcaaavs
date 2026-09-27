// Compact post stack: nine independent layer types share one well-tested
// fullscreen binding contract, while their mode remains explicit in presets.

import { AUDIO_WGSL } from '../audiogpu.ts';
import type { ParamValue, PassContext, PassDescriptor } from '../contracts.ts';
import { PASS_BINDING, PASS_COMMON_WGSL, PASS_GROUP, passBindingsWGSL } from '../renderer.ts';
import body from '../shaders/op-modernfx.wgsl';

const PARAMS = `@group(${PASS_GROUP}) @binding(${PASS_BINDING.params}) var<uniform> P : Params;`;
const FLOATS = 8;
const MODES = {
  bloom: 0, chromatic: 1, displace: 2, glitch: 3, grade: 4, crt: 5,
  contour: 6, neon: 7, scanwarp: 8,
} as const;
export type ModernFxType = keyof typeof MODES;

export const MODERN_FX_DEFAULTS = { amount: 1, strength: 0.5, radius: 1, speed: 1, detail: 1, mix: 1 };

function num(p: Readonly<Record<string, ParamValue>>, key: string, fallback: number): number {
  const value = p[key];
  return typeof value === 'number' && Number.isFinite(value) ? value : fallback;
}

function pass(type: ModernFxType): PassDescriptor {
  const shape = {
    type,
    family: 'operator' as const,
    input: 'accumulator' as const,
    usesAudio: true,
    uniformFloats: FLOATS,
    code: '',
  };
  return {
    ...shape,
    code: [PASS_COMMON_WGSL, AUDIO_WGSL, passBindingsWGSL(shape), PARAMS, body].join('\n'),
    defaultResolutionScale: type === 'bloom' ? 0.5 : 1,
    writeUniforms(out: Float32Array, ctx: PassContext): void {
      const p = ctx.params;
      out[0] = MODES[type];
      out[1] = Math.max(0, num(p, 'amount', MODERN_FX_DEFAULTS.amount)) * ctx.progress;
      out[2] = Math.max(0, num(p, 'strength', MODERN_FX_DEFAULTS.strength));
      out[3] = Math.max(0.1, num(p, 'radius', MODERN_FX_DEFAULTS.radius));
      out[4] = Math.max(0, num(p, 'speed', MODERN_FX_DEFAULTS.speed));
      out[5] = Math.max(0.05, num(p, 'detail', MODERN_FX_DEFAULTS.detail));
      out[6] = Math.max(0, Math.min(1, num(p, 'mix', MODERN_FX_DEFAULTS.mix)));
      out[7] = 0;
    },
  };
}

export const bloomPass = pass('bloom');
export const chromaticPass = pass('chromatic');
export const displacePass = pass('displace');
export const glitchPass = pass('glitch');
export const gradePass = pass('grade');
export const crtPass = pass('crt');
/** Posterized luminance bands plus a detected ink edge. */
export const contourPass = pass('contour');
/** Chromatic multi-tap halo for emissive wire geometry. */
export const neonPass = pass('neon');
/** Rolling scan-band displacement and cross-channel persistence. */
export const scanwarpPass = pass('scanwarp');
