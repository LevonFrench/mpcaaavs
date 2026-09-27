// The compute entry point shared by the 2D ITERATED MAPS (Clifford, De Jong).
//
// These are NOT flows and must not be treated as such. A flow's step is a small
// displacement along a smooth curve, so consecutive samples can be joined into a
// segment. A map's step jumps a long way across the figure — successive iterates
// of x' = sin(a*y) + c*cos(a*x) are essentially uncorrelated in position — so
// joining them paints chords straight across the picture and destroys exactly
// the structure the map is famous for. We plot POINTS and let the density build
// the image through the accumulator instead.
//
// Concatenated LAST, after `attractor-common.wgsl` (hash11) and after the
// per-map body, which supplies:
//
//   fn mapStep(q : vec2<f32>) -> vec2<f32>   one iterate
//   fn seedPoint(i : f32)     -> vec2<f32>   a starting point in the basin
//
// BUFFER LAYOUT — a contract with `attractor-map.wgsl`:
//   [i*4 + 0..1] current xy
//   [i*4 + 2]    seeded flag (0 = never seeded)
//   [i*4 + 3]    iterations performed so far, absolute
//
// ---------------------------------------------------------------------------
// WHY AN ABSOLUTE ITERATION COUNTER
//
// A map has no dt to scale, so the musical-time obligation (§3.1) lands on the
// iteration RATE instead: the orbit must advance a fixed number of iterates per
// BEAT at any refresh rate. Deriving the count from `dtBeats` per frame fails
// outright — at 900 iterates/beat and 165 fps that is 11.6 per frame, and
// `floor` of a per-frame figure below 1 never advances at all.
//
// So the CPU sends an ABSOLUTE target (`floor(beats * itersPerBeat)`) and each
// thread walks its own counter up to it. The fractional part is carried in the
// buffer for free, the rate is exact over any window, and nothing depends on
// frame pacing. `maxSteps` bounds the catch-up: after a tab switch the deficit
// is enormous, and the counter is snapped forward rather than the shader
// grinding through ten thousand iterates in one dispatch.
// ---------------------------------------------------------------------------

/**
 * Iterates discarded when a point is first seeded.
 *
 * The seed scatter is uniform over a square; the attractor is not. Without a
 * burn-in the first frames show that square, which is a rectangle of noise
 * fading out of the accumulator — a visible, wrong, and completely avoidable
 * first impression. 64 iterates is far past the transient for both maps.
 */
const BURN_IN : i32 = 64;

fn storeMap(base: u32, cur: vec2<f32>, flag: f32, iter: f32) {
  points[base + 0u] = cur.x;
  points[base + 1u] = cur.y;
  points[base + 2u] = flag;
  points[base + 3u] = iter;
}

@compute @workgroup_size(64)
fn main(@builtin(global_invocation_id) gid : vec3<u32>) {
  let i = gid.x;
  if (f32(i) >= P.count) { return; }

  let base = i * 4u;

  if (points[base + 2u] < 0.5 || P.reseed > 0.5) {
    var s = seedPoint(f32(i));
    for (var k = 0; k < BURN_IN; k = k + 1) { s = mapStep(s); }
    storeMap(base, s, 1.0, P.iterTarget);
    return;
  }

  var q = vec2<f32>(points[base + 0u], points[base + 1u]);

  // Bounded catch-up. Never falls permanently behind, never spends an unbounded
  // dispatch getting even.
  var it = points[base + 3u];
  if (P.iterTarget - it > P.maxSteps) { it = P.iterTarget - P.maxSteps; }
  let n = i32(max(P.iterTarget - it, 0.0));

  for (var k = 0; k < n; k = k + 1) {
    q = mapStep(q);
  }

  // Both maps are bounded by construction (|x| <= 1 + |c| for Clifford), so
  // this cannot fire on the arithmetic alone — but a non-finite uniform would
  // poison the buffer permanently and this is the only place that can catch it.
  // Negated form, because a NaN compares false against everything.
  if (!(all(abs(q) < vec2<f32>(1000.0)))) {
    var s = seedPoint(f32(i) + 91.7);
    for (var k = 0; k < BURN_IN; k = k + 1) { s = mapStep(s); }
    storeMap(base, s, 1.0, P.iterTarget);
    return;
  }

  storeMap(base, q, 1.0, P.iterTarget);
}
