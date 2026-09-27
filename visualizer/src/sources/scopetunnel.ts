// The scope-tunnel source's registration — spectrogram history receding in Z.
// Look: GRID.
//
// Describes the pass and packs its params; the perspective argument (depth is
// 1/r from the vanishing point, and depth IS age) is in `src-scopetunnel.wgsl`.
// No device, no buffer, no pipeline: see `scope.ts` for why that matters.
//
// Two things belong on this side rather than in the shader.
//
// `span` is a FRACTION of the held history, not a duration in beats, for the
// reason set out at length in `waterfall.ts`: the ring gains one row per
// analysis frame and nothing in the current contract converts rows to beats. A
// dial that claimed beats would be claiming a musical grid the data does not
// have. `spin` is the opposite case — it is a genuine rotation, so it is
// expressed in BARS and derived from `ctx.bars`, absolute rather than
// integrated so that two runs over the same audio land at the same angle (§4.7).
//
// The horizon does not move. Art-direction §1.2 names that as the discipline of
// this whole look — a fixed element is what makes the moving ones read as fast —
// so `originY` is a preset value and nothing here modulates it with audio. If a
// preset wants the horizon to breathe, that is a warp layer over the top, not a
// term in this uniform block.

import { AUDIO_WGSL } from '../audiogpu.ts';
import type { ParamValue, PassContext, PassDescriptor } from '../contracts.ts';
import { PASS_BINDING, PASS_COMMON_WGSL, PASS_GROUP } from '../renderer.ts';
import body from '../shaders/src-scopetunnel.wgsl';

/** See the identical note in `scope.ts` — the binding number is generated, never typed. */
const PARAMS_WGSL = `@group(${PASS_GROUP}) @binding(${PASS_BINDING.params}) var<uniform> P : Params;`;

/** Field order. Must match `struct Params` in `src-scopetunnel.wgsl` float for float. */
const F_MODE = 0;
const F_ROWS = 1;
const F_SPAN = 2;
const F_GAIN = 3;
const F_GAMMA = 4;
const F_LO = 5;
const F_HI = 6;
const F_HEIGHT = 7;
const F_ORIGIN_X = 8;
const F_ORIGIN_Y = 9;
const F_FAR_R = 10;
const F_LINE_WIDTH = 11;
const F_FALLOFF = 12;
const F_WIDTH_SCALE = 13;
const F_WEIGHT_VAR = 14;
const F_HUE_SPREAD = 15;
const F_SPIN = 16;
// 17..19 are the struct's tail pad. Never written, never read.
const PARAM_FLOATS = 20;

const MODES = ['landscape', 'tunnel'] as const;

/** Same axis defaults as `spectrum.ts` and `waterfall.ts`; see either for the Hz figures. */
const DEFAULT_LO = 0.0013;
const DEFAULT_HI = 0.64;

/**
 * Rows drawn. The shader searches SEARCH rows either side of the fragment's own,
 * so this is a cost of storage reads per fragment only through the depth fade,
 * not linearly — but it is still the parameter that decides how much of the ring
 * is sampled per frame.
 *
 * 48 rows over 256 held ones means a feature crosses one row every ~5 analysis
 * frames, which reads as travel rather than as a slideshow. Far more rows than
 * this bunch below a pixel long before the far end and buy nothing.
 */
const DEFAULT_ROWS = 48;
const MAX_ROWS = 192;

/** See the identical cap in `waterfall.ts`: a rotation, not a rainbow (§2.2). */
const MAX_HUE_SPREAD = 0.9;

export const scopetunnelPass: PassDescriptor = {
  type: 'scopetunnel',
  family: 'source',
  // A source draws INTO the accumulator, so it cannot sample it.
  input: 'none',
  usesAudio: true,
  code: [PASS_COMMON_WGSL, AUDIO_WGSL, PARAMS_WGSL, body].join('\n'),

  // Fullscreen geometry, issued as a vertex count so progress 0 draws literally
  // nothing (Phase 5 DoD).
  draw: {
    kind: 'vertices',
    vertexCount: (ctx) => (ctx.progress > 0 ? 3 : 0),
  },

  /**
   * Full resolution. The strokes are clamped to one ATTACHMENT pixel and carry
   * their remainder in alpha, so a half-res pass is a half-res line bilinearly
   * smeared back up — and most of the frame is far rows, which is exactly the
   * part that clamp is holding together. Advisory only (§4.11).
   */
  defaultResolutionScale: 1,

  uniformFloats: PARAM_FLOATS,
  writeUniforms(out: Float32Array, ctx: PassContext): void {
    const p = ctx.params;

    const tunnel = mode(p, 'mode', 'landscape') === 'tunnel';
    out[F_MODE] = tunnel ? 1 : 0;
    out[F_ROWS] = clamp(Math.round(num(p, 'rows', DEFAULT_ROWS)), 2, MAX_ROWS);
    out[F_SPAN] = clamp(num(p, 'span', 1), 0.02, 1);

    out[F_GAIN] = Math.max(num(p, 'gain', 1.6), 0);
    out[F_GAMMA] = Math.max(num(p, 'gamma', 0.6), 1e-3);

    const lo = clamp(num(p, 'fLo', DEFAULT_LO), 1e-5, 0.98);
    out[F_LO] = lo;
    out[F_HI] = clamp(num(p, 'fHi', DEFAULT_HI), lo * 1.01, 1);

    // Amplitude at the NEAR plane, in unit-y. Rows further away scale it by
    // their own r in the shader, which is what perspective does to a height.
    out[F_HEIGHT] = clamp(num(p, 'height', 0.24), 0, 2);

    // The vanishing point. Off-centre by default: §4.1 rejects the centred
    // radial composition, and a tunnel whose mouth sits dead centre is that
    // composition however good the data in it is. A preset that wants the
    // symmetric version sets both to 0 deliberately.
    out[F_ORIGIN_X] = clamp(num(p, 'originX', tunnel ? -0.14 : 0), -2, 2);
    // Landscape: the horizon, above the middle so the sky is the negative space
    // (§1.2 puts it at ~50%). Tunnel: the vanishing point's height.
    out[F_ORIGIN_Y] = clamp(num(p, 'originY', tunnel ? 0.06 : 0.34), -1, 1);

    // Where the far end stops — and, because rows are evenly spaced in DEPTH,
    // the parameter that actually decides how they distribute on screen. It is
    // the near/far RATIO that matters: rNear/farR is the depth range, and rows
    // land uniformly across 1/r, so a very small farR crams most of them into
    // the last few percent of the frame and leaves the near field empty. At the
    // default horizon the ratio here is ~11:1, which puts the first row near the
    // bottom edge and the last one short of the horizon — the gap between them
    // reading as distance rather than as a missing row.
    out[F_FAR_R] = clamp(num(p, 'farR', 0.12), 5e-3, 1);

    // Half stroke width at the near plane, in unit-y — ~3 px at 1440p. The
    // shader clamps it up to one fragment for the far rows and carries the
    // remainder in alpha, so this is the NEAR weight and nothing else.
    out[F_LINE_WIDTH] = clamp(num(p, 'lineWidth', 0.0028), 0, 0.2);

    // The far end must go quiet or it fights the near end for the eye (§4.2).
    // Below ~1 the fade is too gentle to do that.
    out[F_FALLOFF] = clamp(num(p, 'falloff', 2.2), 0, 12);

    // Lateral extent of a landscape row at the near plane, as a multiple of the
    // frame width. Ignored in tunnel mode, where the axis is the angle.
    out[F_WIDTH_SCALE] = clamp(num(p, 'widthScale', 1), 0.05, 8);

    // Uniform stroke reads flat and machine-drawn (§4.4). 0 is available and is
    // not recommended.
    out[F_WEIGHT_VAR] = clamp(num(p, 'weightVar', 0.8), 0, 4);

    out[F_HUE_SPREAD] = clamp(num(p, 'hueSpread', 0.28), 0, MAX_HUE_SPREAD);

    // Rotation on a clock division, never on wall-clock seconds (§3.1), and
    // absolute rather than integrated so it is reproducible frame-pacing and all
    // (§4.7). The fractional part is taken BEFORE scaling so the angle never
    // grows large enough for f32 to lose the low bits of a slow spin.
    const spinBars = Math.max(num(p, 'spinBars', 64), 1e-3);
    out[F_SPIN] = tunnel ? fract(ctx.bars / spinBars) * Math.PI * 2 : 0;
  },
};

function num(p: Readonly<Record<string, ParamValue>>, key: string, fallback: number): number {
  const v = p[key];
  return typeof v === 'number' && Number.isFinite(v) ? v : fallback;
}

function mode(
  p: Readonly<Record<string, ParamValue>>,
  key: string,
  fallback: (typeof MODES)[number],
): (typeof MODES)[number] {
  const v = p[key];
  const found = MODES.find((m) => m === v);
  return found ?? fallback;
}

function clamp(v: number, lo: number, hi: number): number {
  return v < lo ? lo : v > hi ? hi : v;
}

/** Positive fractional part. `%` keeps the sign of the dividend and bars can be negative on a pre-roll. */
function fract(v: number): number {
  return v - Math.floor(v);
}
