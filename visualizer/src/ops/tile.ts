// The `tile` operator — registration for `shaders/op-tile.wgsl`.
//
// Plan §7: operators are multiplicative, so this file's value is that every
// source ever written gets a tiled variant for free. All it owns is the CPU half
// of that: which params exist, what they default to, and the one decision the
// shader is deliberately not allowed to make — how many tiles there are.
//
// That decision rides a clock division (§4.4). The tile count is re-chosen from
// a seeded hash on each division tick and held constant in between, so the grid
// changes ON a musical boundary rather than sliding continuously through
// non-integer counts. A count that eases between 3 and 4 is a count that is
// wrong for the whole of the ease, and it changes at a moment the music did not
// ask for.
//
// What this module deliberately does NOT do:
//   - No GPU handles, no device, no textures. It is a `PassDescriptor` and a few
//     pure functions, so the preset validator and the golden harness can import
//     it on a machine with no adapter (contracts.ts, top of file).
//   - No wall clock. Everything is derived from `ctx.beats`, which is the audio
//     clock (§4.6); `ctx.time` is not read at all.
//   - No `Math.random`. The per-tick jitter comes from `rng.ts`'s `hash2`, and
//     the per-tile variation from the same hash ported into WGSL (§4.7).
//   - No opinion about z-order, blend or opacity. Those are the layer's, and
//     `renderer.ts` applies them.

import type { ParamValue, PassContext, PassDescriptor } from '../contracts.ts';
import { SLOTS_PER_BEAT } from '../contracts.ts';
import { DIVISIONS, type DivisionName } from '../clock.ts';
import { PASS_BINDING, PASS_COMMON_WGSL, PASS_GROUP, passBindingsWGSL } from '../renderer.ts';
import { hash2 } from '../rng.ts';
import TILE_WGSL from '../shaders/op-tile.wgsl';

/** f32 count of `struct Tile`. Mirrors the WGSL declaration, field for field. */
const TILE_FLOATS = 16;

// Offsets into the uniform block, in FLOATS. Named rather than written inline
// for the reason `renderer.ts` names its own: a bare index is how two adjacent
// scalars quietly swap places and the frame still looks plausible.
const U_GRID = 0;          // vec2 — columns, rows
const U_BRICK = 2;
const U_ROTATE_STEPS = 3;
const U_ROTATE_CHANCE = 4;
const U_ROTATE_DRIFT = 5;
const U_FLIP_CHANCE = 6;
const U_SCALE_JITTER = 7;
const U_BREATHE = 8;
const U_DECAY = 9;
const U_OFFSET_TICKS = 10;
const U_GUTTER = 11;
const U_MIX = 12;
const U_CYCLE_POS = 13;
const U_CYCLE = 14;
const U_TILE_ASPECT = 15;

/**
 * Tick counter wrap.
 *
 * `cyclePos` is a beat position divided down, and beats grow without bound over
 * a set. An f32 with a 24-bit mantissa holding 40 000 beats has ~1/512 of a beat
 * left for the fraction, and the per-tile pulse phase lives in that fraction —
 * so it quantises into steps partway through the second hour, which presents as
 * the animation slowly going stiff. Wrapping on the CPU, where the arithmetic is
 * double precision, keeps the value the shader receives small and exact.
 *
 * The cost is that the hashed pattern repeats every 4096 ticks. On `bar` at 128
 * BPM that is a little over two hours, which is longer than any set this is for.
 */
const CYCLE_WRAP = 4096;

/** Upper bounds. Not taste — a 4096 x 4096 grid is 16.7 M tiles of one pixel each. */
const MAX_TILES = 64;

// ---------------------------------------------------------------------------
// Params
// ---------------------------------------------------------------------------

/**
 * Defaults, and the authoritative list of what this operator understands.
 *
 * Chosen to look like something on first drop rather than to be neutral: a 3x3
 * grid with quarter-turn rotation on half the tiles, a quarter of them mirrored,
 * and each on its own beat. Zeroed defaults would make a new `tile` layer render
 * nine identical copies, which is the wallpaper failure the whole module exists
 * to avoid, and nobody would touch the parameter that fixes it because the layer
 * would already "work".
 */
export const TILE_DEFAULTS: Readonly<Record<string, ParamValue>> = {
  /** Columns and rows, independently. */
  cols: 3,
  rows: 3,
  /** Extra columns/rows, 0..N, re-hashed on each `division` tick. 0 = fixed grid. */
  colsJitter: 0,
  rowsJitter: 0,
  /** The boundary the count and the pattern are allowed to change on. */
  division: 'bar',
  /** Per-row horizontal shift, in tiles. 0 = straight grid, 0.5 = brick bond. */
  brick: 0,
  /** Quantise rotation to N turns. 4 = quarter turns and no resampling softness. */
  rotateSteps: 4,
  /** Fraction of tiles that rotate at all. 1 = all of them, which reads busier. */
  rotateChance: 0.5,
  /** Continuous drift in turns per tick, signed per tile. Small values only. */
  rotateDrift: 0,
  /** Mirror chance, per axis. */
  flipChance: 0.25,
  /** Scale variation in octaves either side of 1. 0.25 is ~0.84x to 1.19x. */
  scaleJitter: 0.25,
  /** Extra scale at the peak of a tile's own pulse. */
  breathe: 0.06,
  /** Release rate of that pulse, per tick. Higher is snappier. */
  decay: 6,
  /** Maximum per-tile phase offset in BEATS. This is the anti-blob control. */
  offsetBeats: 1,
  /** Panel inset as a fraction of the tile. 0 = tiles abut with sub-pixel AA. */
  gutter: 0,
  /** Blend against the untiled frame. */
  mix: 1,
};

/**
 * A numeric param, clamped, with the default as the floor of last resort.
 *
 * Clamped rather than validated because a preset is user data arriving over a
 * URL hash: `cols: 100000` is a plausible typo and must cost the layer its
 * intent, not the frame its budget.
 */
function num(params: Readonly<Record<string, ParamValue>>, key: string, lo: number, hi: number): number {
  const fallback = TILE_DEFAULTS[key];
  const raw = params[key] ?? fallback;
  const v = typeof raw === 'number' ? raw : Number(raw);
  if (!Number.isFinite(v)) return typeof fallback === 'number' ? fallback : lo;
  return Math.min(hi, Math.max(lo, v));
}

/**
 * Read the division name, falling back rather than throwing.
 *
 * A preset arrives from a URL hash and may have been written by hand or by an
 * older build (`migrate` in contracts.ts covers the schema, not the values). A
 * bad division name should cost the layer its clock, not the show its frame.
 */
function divisionOf(params: Readonly<Record<string, ParamValue>>): DivisionName {
  const raw = params['division'];
  if (typeof raw === 'string' && raw in DIVISIONS) return raw as DivisionName;
  return 'bar';
}

/**
 * Tile count for this tick.
 *
 * `base + hash(salt, cycle) * (jitter + 1)`, floored. `cycle` is an integer that
 * only advances on a division boundary, which is the entire mechanism: the same
 * tick always yields the same count, and the count can only change where the
 * music does.
 */
function countFor(base: number, jitter: number, salt: number, cycle: number): number {
  const extra = jitter > 0 ? Math.floor(hash2(salt, cycle) * (Math.floor(jitter) + 1)) : 0;
  return Math.min(MAX_TILES, Math.max(1, Math.floor(base) + extra));
}

/** Positive modulo. `%` on a negative left operand is negative in JS. */
function wrap(v: number, m: number): number {
  return ((v % m) + m) % m;
}

// ---------------------------------------------------------------------------
// The descriptor
// ---------------------------------------------------------------------------

/**
 * The shape fields, declared once.
 *
 * `passBindingsWGSL` needs a descriptor to generate the `src`/`samp`
 * declarations, and the descriptor needs those declarations to have its `code` —
 * so the shape is hoisted out and both read it. Writing the shape twice would
 * compile perfectly and generate a binding set that does not match the layout
 * `renderer.ts` builds from the real descriptor, which is a validation error at
 * best and the wrong texture at worst.
 */
const SHAPE = {
  type: 'tile',
  family: 'operator',
  input: 'accumulator',
  uniformFloats: TILE_FLOATS,
} as const;

/**
 * The pass's own uniform binding, generated rather than typed.
 *
 * `passBindingsWGSL` covers every binding whose declaration the renderer can
 * know — input, sampler, history, storage — but not this one, because the struct
 * is the pass's own. Appending it here is the closest available thing to the
 * same guarantee: `PASS_BINDING.params` is imported, so the number cannot drift
 * out of step. It goes after the shader source because that is where `struct
 * Tile` is declared, and reading top to bottom is one less thing to be sure of.
 */
const PARAMS_DECL =
  `@group(${PASS_GROUP}) @binding(${PASS_BINDING.params}) var<uniform> T : Tile;`;

export const tilePass: PassDescriptor = {
  ...SHAPE,
  code: [
    PASS_COMMON_WGSL,
    passBindingsWGSL({ ...SHAPE, code: '' }),
    TILE_WGSL,
    PARAMS_DECL,
  ].join('\n'),

  /**
   * Full resolution by default, unlike most transforms.
   *
   * A tiled field is high-frequency by construction — N x M copies of the source
   * means N x M times the spatial frequency — so it is the worst possible
   * candidate for the half-res path of §4.11. Advisory only; a preset that needs
   * the bandwidth back can still ask, and will see the tiles go soft.
   */
  defaultResolutionScale: 1,

  writeUniforms(out: Float32Array, ctx: PassContext): void {
    const p = ctx.params;

    // The division tick, in beats. Everything temporal below is in ticks.
    const division = divisionOf(p);
    const beatsPerTick = DIVISIONS[division] / SLOTS_PER_BEAT;

    // Wrapped in double precision here so the shader never sees a large float.
    const cyclePos = wrap(ctx.beats / beatsPerTick, CYCLE_WRAP);
    const cycle = Math.floor(cyclePos);

    // Salts keep the two axes independent — one hash would make a jittered grid
    // always square, which is a correlation nobody asked for and which shows up
    // as the tiling only ever being 3x3, 4x4, 5x5.
    const cols = countFor(num(p, 'cols', 1, MAX_TILES), num(p, 'colsJitter', 0, 8), ctx.seed ^ 0x7ea1, cycle);
    const rows = countFor(num(p, 'rows', 1, MAX_TILES), num(p, 'rowsJitter', 0, 8), ctx.seed ^ 0x31b9, cycle);

    out[U_GRID] = cols;
    out[U_GRID + 1] = rows;
    out[U_BRICK] = num(p, 'brick', -1, 1);
    out[U_ROTATE_STEPS] = num(p, 'rotateSteps', 0, 64);
    out[U_ROTATE_CHANCE] = num(p, 'rotateChance', 0, 1);
    out[U_ROTATE_DRIFT] = num(p, 'rotateDrift', -4, 4);
    out[U_FLIP_CHANCE] = num(p, 'flipChance', 0, 1);
    out[U_SCALE_JITTER] = num(p, 'scaleJitter', 0, 2);
    out[U_BREATHE] = num(p, 'breathe', 0, 1);
    out[U_DECAY] = num(p, 'decay', 0, 64);
    // Converted to ticks on the CPU: the shader's clock is the division, and
    // handing it a beats figure would mean it had to know the tempo grid too.
    out[U_OFFSET_TICKS] = num(p, 'offsetBeats', 0, 16) / beatsPerTick;
    out[U_GUTTER] = num(p, 'gutter', 0, 0.5);
    out[U_MIX] = num(p, 'mix', 0, 1);
    out[U_CYCLE_POS] = cyclePos;
    out[U_CYCLE] = cycle;
    // The pixel aspect of ONE tile, not of the frame. Rotating in frame aspect
    // shears every tile that is not square, which most of them are not.
    out[U_TILE_ASPECT] = (ctx.aspect * rows) / cols;
  },
};
