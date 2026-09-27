// The Peter de Jong attractor — one iterate and the seeded scatter. The rest
// comes from `attractor-map-main.wgsl`.
//
//   x' = sin(a*y) - cos(b*x)
//   y' = sin(c*x) - cos(d*y)
//
// CANONICAL VALUES: a = 1.4, b = -2.3, c = 2.4, d = -2.1. The widely reproduced
// set, and the one that gives the four-armed web.
//
// A MAP, not a flow — plot points, never segments. See
// `attractor-map-main.wgsl`.
//
// Bounded by construction at |x|, |y| <= 2 for any coefficients, so like
// Clifford it can be swept hard with no risk of escape. All four coefficients
// are structural here (unlike Clifford, where c and d mostly stretch), and the
// useful range is roughly [-3, 3] for each — outside about 3 the sines alias
// against each other and the figure turns to even noise, which is why the
// clamps in the descriptor stop short of it.
//
// Audio drives `c`. `a` and `b` set the overall armature and `c` rearranges the
// filaments inside it, which is the change that reads as the figure MOVING
// rather than the figure being replaced.
//
// P.pa = a, P.pb = b, P.pc = c, P.pd = d.

fn mapStep(q : vec2<f32>) -> vec2<f32> {
  return vec2<f32>(
    sin(P.pa * q.y) - cos(P.pb * q.x),
    sin(P.pc * q.x) - cos(P.pd * q.y),
  );
}

/**
 * The scatter. Uniform over [-1, 1]^2; `BURN_IN` in the shared main discards the
 * transient so the square is never drawn.
 */
fn seedPoint(i : f32) -> vec2<f32> {
  return vec2<f32>(
    (hash11(i + 0.13) - 0.5) * 2.0,
    (hash11(i + 7.71) - 0.5) * 2.0,
  );
}
