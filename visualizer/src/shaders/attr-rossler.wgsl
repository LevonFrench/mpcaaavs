// Rossler attractor — the vector field and the seeded scatter. Everything else
// (storage layout, per-beat step, divergence guard, entry point) comes from
// `attractor-flow-main.wgsl`, concatenated after this.
//
//   dx/dt = -y - z
//   dy/dt =  x + a*y
//   dz/dt =  b + z*(x - c)
//
// CANONICAL VALUES: a = 0.2, b = 0.2, c = 5.7. That is the classic single-scroll
// band, and it is the one every published picture of this system uses.
//
// `c` is the bifurcation parameter and the one audio drives. The period-doubling
// cascade is legible in it and lands inside a range a band meter can reach:
//
//   c = 2.5   a single closed loop (period 1)
//   c = 3.5   period 2
//   c = 4.0   period 4
//   c = 4.23  chaos begins
//   c = 5.7   the canonical attractor
//   c = 9-18  a progressively wider, flatter chaotic band
//
// So pushing `c` genuinely changes the figure's SHAPE — a loop opening into a
// ribbon and then into a broad band — rather than merely making it brighter,
// which is what art-direction §3.3 asks an audio driver to do.
//
// P.pa = a, P.pb = b, P.pc = c.

fn deriv(q : vec3<f32>) -> vec3<f32> {
  return vec3<f32>(
    -q.y - q.z,
     q.x + P.pa * q.y,
     P.pb + q.z * (q.x - P.pc),
  );
}

/**
 * The scatter. Rossler at these parameters is globally attracting from a wide
 * neighbourhood of the origin, so a loose cloud is safe — every trajectory
 * spirals onto the band within a couple of turns and there is no basin edge to
 * fall off.
 *
 * `z` is kept small and positive because the z excursion is the fast part of the
 * orbit; seeding into it starts trajectories mid-spike and briefly draws a
 * curtain of long segments.
 */
fn seedPoint(i : f32) -> vec3<f32> {
  return vec3<f32>(
    (hash11(i + 0.13) - 0.5) * 16.0,
    (hash11(i + 7.71) - 0.5) * 16.0,
     hash11(i + 3.31) * 3.0,
  );
}
