// The Clifford attractor — one iterate and the seeded scatter. The rest comes
// from `attractor-map-main.wgsl`.
//
//   x' = sin(a*y) + c*cos(a*x)
//   y' = sin(b*x) + d*cos(b*y)
//
// CANONICAL VALUES: a = -1.4, b = 1.6, c = 1.0, d = 0.7. Those are Clifford
// Pickover's own, and they give the familiar folded double-lobe.
//
// This is a MAP, not a flow. Successive iterates land far apart, so nothing here
// may be joined into a segment — see the header of `attractor-map-main.wgsl`.
//
// The system is bounded by construction: |x'| <= 1 + |c| and |y'| <= 1 + |d|,
// for any parameters at all. There is no divergence to guard against and no
// basin to fall out of, which is what makes it safe to sweep the coefficients
// hard from audio. Useful ranges:
//
//   a, b in [-2.2, 2.2]   the structural parameters. Small changes fold and
//                         unfold the lobes completely.
//   c, d in [-1.5, 1.5]   the offsets. These stretch it rather than refold it.
//
// Audio drives `a`, which is the one that reorganises the figure rather than
// scaling it (art-direction §3.3 — shape, not brightness).
//
// P.pa = a, P.pb = b, P.pc = c, P.pd = d.

fn mapStep(q : vec2<f32>) -> vec2<f32> {
  return vec2<f32>(
    sin(P.pa * q.y) + P.pc * cos(P.pa * q.x),
    sin(P.pb * q.x) + P.pd * cos(P.pb * q.y),
  );
}

/**
 * The scatter. Uniform over [-1, 1]^2, which is inside the bounding box for any
 * sane coefficients. The transient is discarded by `BURN_IN` in the shared main,
 * so the square this starts as is never drawn.
 */
fn seedPoint(i : f32) -> vec2<f32> {
  return vec2<f32>(
    (hash11(i + 0.13) - 0.5) * 2.0,
    (hash11(i + 7.71) - 0.5) * 2.0,
  );
}
