// Tile / repeat with per-tile variation — operator, plan §7.
//
// Operators are multiplicative: this one turns any source into a field of that
// source, and unlike the kaleidoscope it has no centre, so art-direction §4.1
// leaves it alone. Its job is to make one motif read as a composed surface, and
// the whole difference between "composed surface" and "wallpaper" is that no two
// tiles are quite the same tile.
//
// Four axes of per-tile variation, all from a SEEDED hash of the tile index
// (plan §4.7 — nothing here may reach for a random number, and the golden
// harness checks): rotation, flip, scale, and a temporal phase offset. The last
// is the important one. Without it every tile breathes on the same frame and the
// field reads as a single pulsing object, which is exactly the blob failure of
// art-direction §3.3.
//
// What this deliberately does NOT do:
//   - It does not TINT tiles. Per-tile hue would be the fastest possible route
//     past art-direction §2.2's three-hue ceiling, and a tiling that needs
//     colour variety to be interesting is a tiling of a boring source.
//   - It does not sample its neighbours. Everything below is one texture fetch
//     plus arithmetic; a seam resolved by blending two tiles would double the
//     fetch count of an operator that may run over 3.7 megapixels.
//   - It does not decide its own tile count. The count arrives already
//     quantised to a clock division from `ops/tile.ts`, because a count that
//     changes continuously is a count that changes off the beat.
//   - It does not declare its own uniform binding. `ops/tile.ts` appends that
//     line, so no binding number is ever typed in this file. See
//     `PASS_BINDING` in `renderer.ts` for why that matters.
//
// `PASS_COMMON_WGSL` (struct Common as `C`, `fullscreenTriangle`, `fragUV`) and
// the `src`/`samp` declarations are prepended by `ops/tile.ts`.

const TAU = 6.2831853;

struct Tile {
  grid         : vec2<f32>,  // columns, rows. Integral; already division-quantised.
  brick        : f32,        // per-row horizontal shift in tiles. 0.5 = half-drop bond.
  rotateSteps  : f32,        // quantise rotation to N turns. < 1 = continuous.
  rotateChance : f32,        // 0..1 fraction of tiles that rotate at all.
  rotateDrift  : f32,        // turns per division tick, direction hashed per tile.
  flipChance   : f32,        // 0..1 per axis.
  scaleJitter  : f32,        // octaves either side of 1. 1.0 = half to double.
  breathe      : f32,        // extra scale at the peak of a tile's own pulse.
  decay        : f32,        // release rate of that pulse, per division tick.
  offsetTicks  : f32,        // max per-tile phase offset, in division ticks.
  gutter       : f32,        // 0 = tiles abut. > 0 = panels with negative space.
  mixAmount    : f32,        // 0..1 against the untiled frame.
  cyclePos     : f32,        // continuous position in division ticks, CPU-wrapped.
  cycle        : f32,        // floor(cyclePos). Re-rolls the hash on the boundary.
  tileAspect   : f32,        // pixel aspect of ONE tile, not of the frame.
};

// ---------------------------------------------------------------------------
// Hash
//
// A port of `hashU32`/`hash2` from `rng.ts`. The integer arithmetic is identical
// — WGSL u32 multiply wraps exactly as `Math.imul` does — so a test on the CPU
// can predict which way any given tile is turned. Only the final conversion to
// f32 rounds, and nothing here depends on that last bit.
// ---------------------------------------------------------------------------

fn hashU32(x : u32) -> u32 {
  var h = x;
  h = (h ^ (h >> 16u)) * 0x7feb352du;
  h = (h ^ (h >> 15u)) * 0x846ca68bu;
  h = h ^ (h >> 16u);
  return h;
}

fn hash01(x : u32) -> f32 {
  return f32(hashU32(x)) * 2.3283064365386963e-10; // / 2^32
}

fn hash2(a : u32, b : u32) -> f32 {
  return hash01(hashU32(a) ^ (b * 0x9e3779b9u));
}

/** Positive modulo. `%` on a negative i32 is negative, and a negative tile index
 *  would hash to a different tile than the one it is a copy of. */
fn wrapi(v : i32, n : i32) -> i32 {
  let m = v % n;
  return select(m, m + n, m < 0);
}

@vertex
fn vs(@builtin(vertex_index) vi : u32) -> @builtin(position) vec4<f32> {
  return fullscreenTriangle(vi);
}

@fragment
fn fs(@builtin(position) frag : vec4<f32>) -> @location(0) vec4<f32> {
  let uv = fragUV(frag);
  let plain = textureSampleLevel(src, samp, uv, 0.0);
  if (T.mixAmount <= 0.0) { return plain * C.opacity; }

  let cols = max(1.0, floor(T.grid.x));
  let rows = max(1.0, floor(T.grid.y));

  // Grid space, then the brick shift.
  //
  // The shift is a running shear (offset x by brick * row), not an alternating
  // one. `brick = 0.5` gives the classic half-drop bond because every second row
  // lands back where it started; `1/3` gives a third bond; anything else gives a
  // valid tiling too, because only the columns move and the row boundaries are
  // untouched.
  let g = uv * vec2<f32>(cols, rows);
  let row = floor(g.y);
  let gx = g.x + T.brick * row;
  let col = floor(gx);
  let q = vec2<f32>(gx - col, g.y - row);

  // Wrapped so the shifted tiles at the edges hash as the tiles they are copies
  // of, and so the pattern is the same width as the grid rather than the width
  // of the shear.
  let ci = wrapi(i32(col), i32(cols));
  let ri = wrapi(i32(row), i32(rows));
  let tileId = u32(ri) * u32(cols) + u32(ci);

  // `cycle` is in the key, so the whole pattern re-rolls on a musical boundary
  // and holds still in between. Re-rolling per frame would be a different image
  // every frame, which is noise; never re-rolling is the visible loop of
  // art-direction §5.
  let key = hashU32(u32(C.seed) ^ hashU32(tileId ^ (u32(T.cycle) << 20u)));

  let hRot   = hash2(key, 1u);
  let hRotOn = hash2(key, 2u);
  let hFlipX = hash2(key, 3u);
  let hFlipY = hash2(key, 4u);
  let hScale = hash2(key, 5u);
  let hPhase = hash2(key, 6u);
  let hSpin  = hash2(key, 7u);

  // -- the tile's own clock ------------------------------------------------
  //
  // Every rate here is in DIVISION TICKS, never seconds (§4.6 / art-direction
  // §3.1). `offsetTicks` staggers the tiles against each other: at 1.0 a tile
  // can be a whole tick behind its neighbour, which is what stops the field
  // pulsing in unison.
  let pos = T.cyclePos - hPhase * T.offsetTicks;
  let ph = pos - floor(pos);
  // Instant attack, exponential release (art-direction §3.2). A linear or
  // symmetric shape here reads as a metronome rather than as a transient.
  // Scaled by the layer's envelope, so the whole field still obeys its trigger.
  let pulse = exp(-ph * max(T.decay, 0.0)) * C.progress;

  // -- scale ---------------------------------------------------------------
  //
  // Jitter in LOG space: half and double are then equal-magnitude changes,
  // whereas a linear +/- j makes shrinking look far weaker than growing. The
  // side effect is the point of art-direction §4.4 — a source drawn at four
  // different scales has four different apparent line weights, for free.
  let jitter = exp2(mix(-T.scaleJitter, T.scaleJitter, hScale));
  let scale = max(jitter * (1.0 + T.breathe * pulse), 0.0001);

  // -- rotation ------------------------------------------------------------
  var turns = 0.0;
  if (hRotOn < T.rotateChance) {
    // Quantised by default. When `rotateSteps` is a multiple of 4 the content
    // stays axis-aligned, which resamples exactly and keeps a crisp source
    // crisp; an arbitrary angle costs a bilinear softening on every tile. The
    // continuous case is deliberately reachable (steps < 1), not an oversight.
    let steps = max(floor(T.rotateSteps), 1.0);
    turns = select(hRot, floor(hRot * steps) / steps, T.rotateSteps >= 1.0);
  }
  // Drift is per tick and signed per tile, so neighbours counter-rotate instead
  // of the whole field turning as one object.
  turns = turns + T.rotateDrift * pos * select(-1.0, 1.0, hSpin < 0.5);

  // -- transform -----------------------------------------------------------
  var p = q - 0.5;

  // Flip BEFORE rotating. A flip is not a rotation by another name: it changes
  // handedness, and no amount of rotation produces a mirrored motif. A field of
  // rotations alone still reads as one shape spun about.
  p.x = p.x * select(1.0, -1.0, hFlipX < T.flipChance);
  p.y = p.y * select(1.0, -1.0, hFlipY < T.flipChance);

  // Rotate in a square space or the tile shears. A tile is width/cols by
  // height/rows pixels and is almost never square, which is why the frame's
  // aspect is the wrong number to use here.
  p.x = p.x * T.tileAspect;
  let a = turns * TAU;
  let ca = cos(a);
  let sa = sin(a);
  p = vec2<f32>(p.x * ca - p.y * sa, p.x * sa + p.y * ca);
  p.x = p.x / T.tileAspect;

  p = p / scale;
  var s = p + 0.5;
  // Fold rather than clamp outside the tile. Clamping smears one edge texel into
  // a streak; folding mirrors, which is at least made of picture.
  s = abs(fract(s * 0.5) * 2.0 - 1.0);

  let tiled = textureSampleLevel(src, samp, s, 0.0);

  // -- seams ---------------------------------------------------------------
  //
  // Analytic coverage, and NOT fwidth().
  //
  // fwidth is the obvious tool and is wrong here. The tile-local coordinate
  // jumps from 1 back to 0 across a boundary, so a 2x2 quad straddling one
  // measures a derivative of a whole tile instead of a pixel and reports a seam
  // several hundred times too wide. Per-tile rotation makes it worse: the
  // sampled coordinate is discontinuous in DIRECTION as well as in value, so
  // even a quad that stays inside one tile disagrees with its neighbour about
  // which way is up. Either way the artefact is a line at every seam that
  // shimmers whenever the grid changes — the exact thing the AA was added for.
  //
  // The width needs no derivatives at all: one pixel is exactly
  // grid / resolution in tile-local units, which is correct at every tile count
  // and continuous everywhere.
  let px = vec2<f32>(cols, rows) / C.resolution;
  let inset = T.gutter * 0.5;
  let dx = (min(q.x, 1.0 - q.x) - inset) / max(px.x, 1e-6);
  let dy = (min(q.y, 1.0 - q.y) - inset) / max(px.y, 1e-6);
  let coverage = clamp(min(dx, dy) + 0.5, 0.0, 1.0);

  // What the seam fades TO, and this is the subtle part.
  //
  // With no gutter the fade is sub-pixel and its only job is to kill the alias
  // on a hard content discontinuity — so it falls back to the UNTILED frame,
  // which is real picture and therefore invisible. Fading to black instead would
  // draw a dark grid over the whole image, one half-pixel wide, at every tile
  // boundary. That is a worse artefact than the one being fixed and it is the
  // easy mistake to make here.
  //
  // With a gutter the fade is the whole point: the tiles become panels and the
  // gutters are negative space (art-direction §4.3), so they go to nothing.
  let fill = plain * step(T.gutter, 0.0);
  let composed = mix(fill, tiled, coverage);

  return mix(plain, composed, T.mixAmount) * C.opacity;
}
