// Ten lightweight audio-native fields. They are fullscreen sources rather than
// simulations with persistent state, so a dense stack can still run at show
// rate while each field remains deterministic under the fixed-step renderer.

import { AUDIO_WGSL } from '../audiogpu.ts';
import type { ParamValue, PassContext, PassDescriptor } from '../contracts.ts';
import { PASS_BINDING, PASS_COMMON_WGSL, PASS_GROUP } from '../renderer.ts';
import body from '../shaders/src-generative.wgsl';

const PARAMS = `@group(${PASS_GROUP}) @binding(${PASS_BINDING.params}) var<uniform> P : Params;`;
const FLOATS = 8;

const MODES = {
  particles: 0, lissajous: 1, reaction: 2, voronoi: 3,
  flowfield: 4, heightmesh: 5, hypercylinder: 6, gridtunnel: 7, dometunnel: 8, pylons: 9,
} as const;
export type GenerativeType = keyof typeof MODES;

export const GENERATIVE_DEFAULTS = {
  amount: 1, scale: 1, density: 1, detail: 1, speed: 1, spread: 1,
};

function num(p: Readonly<Record<string, ParamValue>>, key: string, fallback: number): number {
  const value = p[key];
  return typeof value === 'number' && Number.isFinite(value) ? value : fallback;
}

function pass(type: GenerativeType): PassDescriptor {
  const shape = {
    type,
    family: 'source' as const,
    input: 'none' as const,
    usesAudio: true,
    uniformFloats: FLOATS,
    code: '',
  };
  return {
    ...shape,
    code: [PASS_COMMON_WGSL, AUDIO_WGSL, PARAMS, body].join('\n'),
    defaultResolutionScale: type === 'reaction' || type === 'flowfield' ? 0.5 : 1,
    writeUniforms(out: Float32Array, ctx: PassContext): void {
      const p = ctx.params;
      out[0] = MODES[type];
      // C.opacity already contains spec.opacity * progress. Multiplying by
      // progress here as well squared every attack/release in this ten-mode
      // compatibility pack and made its timing disagree with dedicated sources.
      out[1] = Math.max(0, num(p, 'amount', GENERATIVE_DEFAULTS.amount));
      out[2] = Math.max(0.05, num(p, 'scale', GENERATIVE_DEFAULTS.scale));
      out[3] = Math.max(0.05, num(p, 'density', GENERATIVE_DEFAULTS.density));
      out[4] = Math.max(0.05, num(p, 'detail', GENERATIVE_DEFAULTS.detail));
      out[5] = Math.max(0, num(p, 'speed', GENERATIVE_DEFAULTS.speed));
      out[6] = Math.max(0.05, num(p, 'spread', GENERATIVE_DEFAULTS.spread));
      out[7] = 0;
    },
  };
}

export const particlesPass = pass('particles');
export const lissajousPass = pass('lissajous');
export const reactionPass = pass('reaction');
export const voronoiPass = pass('voronoi');
/** Domain-warped contour bands with a large negative-space eye. */
export const flowfieldPass = pass('flowfield');
/** A perspective height-field wire mesh, driven by bass and spectral detail. */
export const heightmeshPass = pass('heightmesh');
/** A warped cylindrical wire cage with audio-scanning cross-sections. */
export const hypercylinderPass = pass('hypercylinder');
/** A recursive neon perspective grid and tunnel. */
export const gridtunnelPass = pass('gridtunnel');
/** A large receding dome grid with the narrow central throat of a synthwave stage. */
export const dometunnelPass = pass('dometunnel');
/** Mirrored spectral pylons rising from the horizon line. */
export const pylonsPass = pass('pylons');
