// The `mirror` operator's registration — the CPU half of `shaders/op-mirror.wgsl`.
//
// Plan §7 pairs this with the kaleidoscope and art direction §1.1 explicitly
// allows a mirror in the Lab look where a kaleidoscope is "wrong", so the
// distinction is a product decision and not a detail: a kaleidoscope folds the
// frame into ONE wedge and replicates it, a mirror REFLECTS and leaves half the
// frame untouched. The shader implements the reflection. This file owns the
// decisions the shader is not allowed to make:
//
//   - how many reflection axes there are, which is a fold COUNT the user thinks
//     in (2/4/6/8) and an axis count the maths wants (folds / 2),
//   - where the mirror line is and which side of it survives,
//   - how fast the axes rotate, in TURNS PER BAR and never in seconds,
//   - the crease softening width, which is a pixel figure and therefore belongs
//     to whoever knows the attachment size.
//
// What this module deliberately does NOT do:
//   - No GPU handles, no device, no textures. It is a `PassDescriptor` and a few
//     pure functions, so the preset validator and the golden harness can import
//     it on a machine with no adapter (contracts.ts, top of file).
//   - No wall clock. The rotation is integrated from `ctx.bars`, the audio clock
//     (§4.6); `ctx.time` is not read at all.
//   - No `Math.random`, no `Date.now`. A mirror is a deterministic function of
//     its params and the beat position (§4.7); there is nothing to jitter.
//   - No tiling, no rotation of content it did not reflect, no tint. Those are
//     `tile` and the colour ops, and keeping them apart is what stops all three
//     converging into one unreadable parameter soup.
//   - No opinion about z-order, blend or opacity. The shader crossfades on
//     `C.opacity` rather than multiplying by it, which is what makes this a true
//     no-op at progress 0 rather than a fade to black.

import type { ParamValue, PassContext, PassDescriptor } from '../contracts.ts';
import { PASS_BINDING, PASS_COMMON_WGSL, PASS_GROUP, passBindingsWGSL } from '../renderer.ts';
import MIRROR_WGSL from '../shaders/op-mirror.wgsl';

// ---------------------------------------------------------------------------
// The uniform block
// ---------------------------------------------------------------------------

/**
 * `struct Mirror` and its binding, declared HERE rather than in the .wgsl file.
 *
 * The binding number is `renderer.ts`'s to own — a hand-typed `@binding(4)`
 * validates perfectly right up until the layout changes, and then it samples the
 * wrong resource without complaining. And a uniform struct and the code that
 * packs it are one thing with two halves: keeping the field order and the `U_*`
 * offsets below in the same file is the only arrangement in which "add a field"
 * is a single edit rather than two edits that have to agree.
 *
 * All-scalar, deliberately — no `vec2` for the position, so no field's offset
 * depends on where the scalars before it happened to land. The trailing pad
 * exists because WGSL rounds a uniform struct's size up to a multiple of 16:
 * 7 floats is 28 bytes, which is not, and a struct whose declared size disagrees
 * with the buffer the renderer allocated fails at pipeline creation.
 */
const MIRROR_DECL = /* wgsl */`
struct Mirror {
  mode     : f32,   // < 0.5 = N-fold, < 1.5 = horizontal, else vertical
  axes     : f32,   // reflection lines through the origin = folds / 2
  angle    : f32,   // radians, already wrapped into one fold period
  posX     : f32,   // origin / mirror line in uv
  posY     : f32,
  flip     : f32,   // > 0.5 keeps the far side instead of the near one
  softenPx : f32,   // crease rounding width, in pixels
  _pad0    : f32,
};

@group(${PASS_GROUP}) @binding(${PASS_BINDING.params}) var<uniform> M : Mirror;
`;

/** f32 count of `struct Mirror`. Mirrors the declaration above, field for field. */
const MIRROR_FLOATS = 8;

// Offsets into the uniform block, in FLOATS. Named for the reason `renderer.ts`
// names its own: a bare index is how `posX` and `posY` quietly swap places and
// the frame still looks plausible.
const U_MODE = 0;
const U_AXES = 1;
const U_ANGLE = 2;
const U_POS_X = 3;
const U_POS_Y = 4;
const U_FLIP = 5;
const U_SOFTEN_PX = 6;
// 7 is the struct's tail padding. Never written, never read.

const TAU = Math.PI * 2;

/**
 * Upper bound on the fold count.
 *
 * Not taste. Beyond about 16 the fundamental domain is narrower than the
 * features in it, every wedge is a smear of the same few texels, and the result
 * is indistinguishable from a radial blur — at which point the operator has
 * stopped being a mirror and the user has lost the thing they were composing.
 */
const MAX_FOLDS = 16;

// ---------------------------------------------------------------------------
// Params
// ---------------------------------------------------------------------------

/**
 * Defaults, and the authoritative list of what this operator understands.
 *
 * `mode: 'horizontal'` rather than a 6-fold star, and that is the considered
 * choice: a 2-fold mirror about a vertical line is a COMPOSITION tool, it is
 * legible on any source whatsoever, and it is the one thing a kaleidoscope
 * cannot express. Dropping a `mirror` layer and getting a symmetric frame is a
 * result the user can immediately reason about; dropping one and getting a
 * mandala is an effect they then have to dismantle to find out what it does.
 */
export const MIRROR_DEFAULTS: Readonly<Record<string, ParamValue>> = {
  /** `'horizontal'` | `'vertical'` | `'fold'`. The first two ignore `folds` and `angle`. */
  mode: 'horizontal',
  /**
   * Reflection count for `'fold'`. Even values are the ones that close: 2, 4, 6,
   * 8. An odd count is rounded up rather than rejected, because a preset from a
   * URL hash should cost the layer its exact look and not the frame.
   */
  folds: 6,
  /** Mirror line / origin, in uv. */
  posX: 0.5,
  posY: 0.5,
  /** Static rotation of the axes, in TURNS. `'fold'` only. */
  offsetTurns: 0,
  /**
   * Rotation of the axes, in turns per BAR. Bars rather than beats because a
   * rotation at bar rate phrases with the music instead of ticking with it
   * (art direction §3.3). `'fold'` only.
   */
  spinTurnsPerBar: 0,
  /** Which half survives. False keeps the near side (left / top); true keeps the far one. */
  flip: false,
  /**
   * Crease rounding, in pixels. A raw `abs` puts a derivative discontinuity
   * exactly on a pixel row, which is an aliased hairline by another name and
   * which art direction bans. Below ~0.5 the rounding is narrower than the
   * pixel it is meant to cover and stops doing anything.
   */
  softenPx: 1,
};

/**
 * A numeric param, clamped, with the default as the floor of last resort.
 *
 * Clamped rather than validated because a preset is user data arriving over a
 * URL hash: `folds: 100000` is a plausible typo and must cost the layer its
 * intent, not the frame its budget.
 */
function num(params: Readonly<Record<string, ParamValue>>, key: string, lo: number, hi: number): number {
  const fallback = MIRROR_DEFAULTS[key];
  const raw = params[key] ?? fallback;
  const v = typeof raw === 'number' ? raw : Number(raw);
  if (!Number.isFinite(v)) return typeof fallback === 'number' ? fallback : lo;
  return Math.min(hi, Math.max(lo, v));
}

/** A boolean param, accepting the `0`/`1` a serialised UI toggle may arrive as. */
function flag(params: Readonly<Record<string, ParamValue>>, key: string): boolean {
  const raw = params[key];
  if (typeof raw === 'boolean') return raw;
  if (typeof raw === 'number') return raw > 0.5;
  if (typeof raw === 'string') return raw === 'true' || raw === '1';
  return false;
}

/**
 * The three modes, as the number the shader branches on.
 *
 * Falls back rather than throwing: a preset may have been written by hand or by
 * an older build (`migrate` in contracts.ts covers the schema, not the values),
 * and an unknown mode should cost the layer its shape, not the show its frame.
 */
function modeOf(params: Readonly<Record<string, ParamValue>>): number {
  const raw = params['mode'];
  if (raw === 'fold') return 0;
  if (raw === 'vertical') return 2;
  return 1;
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
  type: 'mirror',
  family: 'operator',
  /** The accumulated frame. This operator draws nothing of its own. */
  input: 'accumulator',
  uniformFloats: MIRROR_FLOATS,
  code: '',
} as const satisfies PassDescriptor;

export const mirrorPass: PassDescriptor = {
  ...SHAPE,
  code: [
    PASS_COMMON_WGSL,
    passBindingsWGSL(SHAPE),
    MIRROR_DECL,
    MIRROR_WGSL,
  ].join('\n'),

  /**
   * Full resolution, and for a blunter reason than most.
   *
   * A reflection is a one-to-one map: one output pixel is one source texel, so
   * there is no resampling softness to hide a half-res pass behind. Running this
   * at 0.5 does not buy a cheaper mirror, it buys a blurred copy of the frame
   * that happens to be symmetric, and §4.11's trade is not worth making for a
   * pass that is two texture fetches wide. Advisory only.
   */
  defaultResolutionScale: 1,

  writeUniforms(out: Float32Array, ctx: PassContext): void {
    const p = ctx.params;

    out[U_MODE] = modeOf(p);

    // Folds -> axes. `folds` reflection lines through the origin would be the
    // naive reading, but a dihedral group with a fundamental domain of 2*pi/N is
    // generated by N/2 lines spaced pi/(N/2) apart — the shader's `w = PI/axes`.
    // Rounding UP to even keeps an odd count from producing a domain that does
    // not close on itself, which shows as one wedge being a different width from
    // all the others.
    const folds = Math.max(2, Math.min(MAX_FOLDS, Math.ceil(num(p, 'folds', 2, MAX_FOLDS) / 2) * 2));
    out[U_AXES] = folds / 2;

    // Turns, accumulated in double precision and WRAPPED before it becomes a
    // float the shader sees. `ctx.bars` grows without bound over a set, and an
    // f32 mantissa holding a few thousand bars has nothing left for the
    // fraction — the spin would quantise into visible steps partway through the
    // second hour, which presents as the rotation going juddery for no reason
    // anyone can point at. The wrap is exact rather than an approximation: one
    // turn is `folds` fold periods, so shifting the angle by 2*pi maps the
    // fundamental domain onto itself.
    const turns = num(p, 'offsetTurns', -64, 64) + ctx.bars * num(p, 'spinTurnsPerBar', -8, 8);
    out[U_ANGLE] = fract(turns) * TAU;

    out[U_POS_X] = num(p, 'posX', -1, 2);
    out[U_POS_Y] = num(p, 'posY', -1, 2);
    out[U_FLIP] = flag(p, 'flip') ? 1 : 0;
    out[U_SOFTEN_PX] = num(p, 'softenPx', 0, 8);
  },
};
