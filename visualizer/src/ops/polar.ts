// The `polar` operator's registration — the CPU half of `shaders/op-polar.wgsl`.
//
// Plan §7 calls the operators multiplicative and this is the clearest case of
// it: every source ever written gets a radial variant for free, and none of them
// has to know. The shader owns the coordinate map. This file owns the four
// things the shader is deliberately not allowed to decide:
//
//   - which direction the map runs (`wrap` makes the screen polar, `unwrap`
//     makes it cartesian again),
//   - where the origin is, because art direction §4.1 forbids radiating from the
//     screen centre by default and the exception is only earned when the centre
//     is the mechanism — which it is here, but a preset must still be able to
//     pin it somewhere meaningful,
//   - how fast the map rotates, expressed in TURNS PER BAR and never in seconds,
//   - the seam width, which is a pixel figure and therefore belongs to whoever
//     knows the attachment size.
//
// What this module deliberately does NOT do:
//   - No GPU handles, no device, no textures. It is a `PassDescriptor` and a few
//     pure functions, so the preset validator and the golden harness can import
//     it on a machine with no adapter (contracts.ts, top of file).
//   - No wall clock. The spin is integrated from `ctx.bars`, which is the audio
//     clock (§4.6); `ctx.time` is not read at all.
//   - No `Math.random`, no `Date.now`. There is nothing stochastic here — a
//     polar swap is a deterministic function of its params and the beat position
//     (§4.7).
//   - No opinion about z-order, blend or opacity. Those are the layer's, and
//     `renderer.ts` applies them. The shader crossfades on `C.opacity` rather
//     than multiplying by it, which is what makes this operator a true no-op at
//     progress 0 instead of a fade to black.

import type { ParamValue, PassContext, PassDescriptor } from '../contracts.ts';
import { PASS_BINDING, PASS_COMMON_WGSL, PASS_GROUP, passBindingsWGSL } from '../renderer.ts';
import POLAR_WGSL from '../shaders/op-polar.wgsl';

// ---------------------------------------------------------------------------
// The uniform block
// ---------------------------------------------------------------------------

/**
 * `struct Polar` and its binding, declared HERE rather than in the .wgsl file.
 *
 * Two reasons, and they pull in the same direction. The binding number is
 * `renderer.ts`'s to own — a hand-typed `@binding(4)` validates perfectly right
 * up until the layout changes, and then it samples the wrong resource without
 * complaining. And a uniform struct and the code that packs it are one thing
 * with two halves: keeping the field order and the `U_*` offsets below in the
 * same file is the only arrangement in which "add a field" is a single edit
 * rather than two edits that have to agree.
 *
 * All-scalar, deliberately. `centreX`/`centreY` are two f32 rather than a
 * `vec2` because a vec2 aligns to 8 and would make the offsets below depend on
 * where the preceding scalars happened to land. The trailing pad exists because
 * WGSL rounds a uniform struct's size up to a multiple of 16: 7 floats is 28
 * bytes, which is not, and a struct whose declared size disagrees with the
 * buffer the renderer allocated is a validation error at pipeline creation.
 */
const POLAR_DECL = /* wgsl */`
struct Polar {
  direction : f32,   // < 0.5 = wrap (screen is polar), else unwrap
  angle     : f32,   // radians, already wrapped into one turn
  zoom      : f32,   // radial magnification
  minRadius : f32,   // singularity guard, in aspect-corrected uv
  centreX   : f32,
  centreY   : f32,
  seamPx    : f32,   // angular seam blend width, in pixels
  _pad0     : f32,
};

@group(${PASS_GROUP}) @binding(${PASS_BINDING.params}) var<uniform> P : Polar;
`;

/** f32 count of `struct Polar`. Mirrors the declaration above, field for field. */
const POLAR_FLOATS = 8;

// Offsets into the uniform block, in FLOATS. Named rather than written inline
// for the reason `renderer.ts` names its own: a bare index is how two adjacent
// scalars quietly swap places and the frame still looks plausible.
const U_DIRECTION = 0;
const U_ANGLE = 1;
const U_ZOOM = 2;
const U_MIN_RADIUS = 3;
const U_CENTRE_X = 4;
const U_CENTRE_Y = 5;
const U_SEAM_PX = 6;
// 7 is the struct's tail padding. Never written, never read.

const TAU = Math.PI * 2;

// ---------------------------------------------------------------------------
// Params
// ---------------------------------------------------------------------------

/**
 * Defaults, and the authoritative list of what this operator understands.
 *
 * Neutral where neutrality is the honest answer and opinionated where it is
 * not. `zoom: 1` and `spinTurnsPerBar: 0` are genuinely the right first look —
 * an unrotated full-frame swap is already a completely different image, so
 * there is no wallpaper failure to design around the way `tile` has. The two
 * that are NOT neutral are `minRadius` and `seamPx`, both of which are artefact
 * guards: at 0 the origin aliases into a screaming cluster and the seam shows
 * as a hairline, and a user who left them at zero would reasonably conclude the
 * operator was broken rather than unconfigured.
 */
export const POLAR_DEFAULTS: Readonly<Record<string, ParamValue>> = {
  /**
   * `'wrap'` reads the screen as (angle, radius) and fetches the source in
   * cartesian — a bar chart along the bottom of the frame lands on the rim.
   * `'unwrap'` is the inverse: a circular scope straightens into a line, and it
   * is also the way back out when two polar layers are stacked.
   */
  direction: 'wrap',
  /** Origin in uv. 0.5, 0.5 is the centre; §4.1 would rather it were not, when there is somewhere better. */
  centreX: 0.5,
  centreY: 0.5,
  /** Static angular offset, in TURNS. 0.25 puts the source's left edge at the top. */
  offsetTurns: 0,
  /**
   * Rotation of the map, in turns per BAR. Bars rather than beats because a
   * rotation at bar rate phrases with the music instead of ticking with it
   * (art direction §3.3). ±0.05 is a drift; ±0.25 is a visible spin.
   */
  spinTurnsPerBar: 0,
  /** Radial magnification. Above 1 the source's outer rows fall off the rim. */
  zoom: 1,
  /**
   * Radial floor, in aspect-corrected uv. The angular sampling rate is unbounded
   * as r -> 0 — every texel of one source row competing for one screen pixel —
   * and this turns that into a smooth disc of the innermost ring. Only meaningful
   * for `wrap`.
   */
  minRadius: 0.02,
  /** Width of the angular seam crossfade, in pixels. Only meaningful for `wrap`. */
  seamPx: 1.5,
};

/**
 * A numeric param, clamped, with the default as the floor of last resort.
 *
 * Clamped rather than validated because a preset is user data arriving over a
 * URL hash: `zoom: 100000` is a plausible typo and must cost the layer its
 * intent, not the frame its budget.
 */
function num(params: Readonly<Record<string, ParamValue>>, key: string, lo: number, hi: number): number {
  const fallback = POLAR_DEFAULTS[key];
  const raw = params[key] ?? fallback;
  const v = typeof raw === 'number' ? raw : Number(raw);
  if (!Number.isFinite(v)) return typeof fallback === 'number' ? fallback : lo;
  return Math.min(hi, Math.max(lo, v));
}

/**
 * Read the direction, falling back rather than throwing.
 *
 * A preset arrives from a URL hash and may have been written by hand or by an
 * older build (`migrate` in contracts.ts covers the schema, not the values). A
 * bad direction should cost the layer its orientation, not the show its frame.
 * `true` accepts the boolean form a UI toggle would naturally produce.
 */
function isUnwrap(params: Readonly<Record<string, ParamValue>>): boolean {
  const raw = params['direction'];
  if (typeof raw === 'boolean') return raw;
  if (typeof raw === 'string') return raw === 'unwrap';
  return false;
}

/** Positive fractional part. `%` on a negative left operand is negative in JS. */
function fract(v: number): number {
  return v - Math.floor(v);
}

// ---------------------------------------------------------------------------
// The descriptor
// ---------------------------------------------------------------------------

/**
 * Everything that decides the bind group layout, declared once.
 *
 * `passBindingsWGSL` needs a descriptor to generate the `src`/`samp`
 * declarations, and the descriptor needs those declarations to have its `code` —
 * so the shape is hoisted out and both read it. Writing the shape twice would
 * compile perfectly and generate a binding set that does not match the layout
 * `renderer.ts` builds from the real descriptor, which is a validation error at
 * best and the wrong texture at worst.
 */
const SHAPE = {
  type: 'polar',
  family: 'operator',
  /** The accumulated frame. This operator draws nothing of its own. */
  input: 'accumulator',
  uniformFloats: POLAR_FLOATS,
  code: '',
} as const satisfies PassDescriptor;

export const polarPass: PassDescriptor = {
  ...SHAPE,
  code: [
    PASS_COMMON_WGSL,
    passBindingsWGSL(SHAPE),
    POLAR_DECL,
    POLAR_WGSL,
  ].join('\n'),

  /**
   * Full resolution, and this one is not a preference.
   *
   * The `wrap` map magnifies enormously near the origin and compresses near the
   * rim, so a half-res pass is not "the same picture, softer" — it is a picture
   * whose angular detail was thrown away before being stretched across the
   * widest part of the frame, and §4.11's usual trade does not apply. Advisory
   * only; a preset that needs the bandwidth back can still ask, and will see the
   * rim go to mush first.
   */
  defaultResolutionScale: 1,

  writeUniforms(out: Float32Array, ctx: PassContext): void {
    const p = ctx.params;

    // Turns, accumulated in double precision and WRAPPED before it becomes a
    // float the shader sees. `ctx.bars` grows without bound over a set, and an
    // f32 mantissa holding a few thousand bars has nothing left for the
    // fraction — so the rotation would quantise into visible steps partway
    // through the second hour, which presents as the spin going juddery for no
    // reason anyone can point at. Every use of `angle` downstream is periodic in
    // one turn (atan2 sum, then cos/sin), so this wrap is exact rather than an
    // approximation.
    const turns = num(p, 'offsetTurns', -64, 64) + ctx.bars * num(p, 'spinTurnsPerBar', -8, 8);
    out[U_ANGLE] = fract(turns) * TAU;

    out[U_DIRECTION] = isUnwrap(p) ? 1 : 0;
    out[U_ZOOM] = num(p, 'zoom', 0.05, 8);
    out[U_MIN_RADIUS] = num(p, 'minRadius', 0, 0.5);
    out[U_CENTRE_X] = num(p, 'centreX', -1, 2);
    out[U_CENTRE_Y] = num(p, 'centreY', -1, 2);
    // Floored at half a pixel: the shader widens the band to half a source texel
    // anyway, and a value of 0 here would only mean the seam blend depended
    // entirely on that floor rather than on the parameter.
    out[U_SEAM_PX] = num(p, 'seamPx', 0.5, 8);
  },
};
