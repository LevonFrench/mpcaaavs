// Thomas' cyclically symmetric attractor — vector field and seeded scatter.
// The rest comes from `attractor-flow-main.wgsl`.
//
//   dx/dt = sin(y) - b*x
//   dy/dt = sin(z) - b*y
//   dz/dt = sin(x) - b*z
//
// CANONICAL VALUE: b = 0.208186. That is the standard chaotic setting and the
// one every published picture uses.
//
// `b` is the dissipation, and it is the bifurcation parameter — this system's
// whole route to chaos is a single slide down it:
//
//   b > 0.32787   everything decays to the origin
//   b ~ 0.32      a single stable limit cycle
//   b ~ 0.25      period doubling
//   b = 0.208186  the canonical chaotic attractor
//   b -> 0.1      a much larger, more space-filling tangle
//   b = 0         conservative; the "labyrinth walk", unbounded diffusion
//
// Audio drives `b` DOWNWARD, so louder is more chaotic and more space-filling.
// That direction matters: driving it upward would collapse the figure to a ring
// on the loud parts, which is the opposite of what the ear expects.
//
// Note this system is bounded for any b > 0 without any guard of its own, and
// its speed is O(1) everywhere — no fast lobe transits, hence no chords. It is
// the quietest member of the family and the one that suits the `ink` look.
//
// P.pa = b. `P.pb` and `P.pc` are unused; the shared struct carries three
// coefficient slots because Rossler needs three, and a struct per attractor
// would be three uniform layouts to keep in step for no gain.

fn deriv(q : vec3<f32>) -> vec3<f32> {
  return vec3<f32>(
    sin(q.y) - P.pa * q.x,
    sin(q.z) - P.pa * q.y,
    sin(q.x) - P.pa * q.z,
  );
}

/**
 * The scatter. Thomas is globally bounded and the attractor fills a cube of
 * roughly +/-4.6 at the canonical `b`, so a uniform cloud slightly inside that
 * lands every trajectory on it within a few turns.
 *
 * The origin is a fixed point, so the scatter is deliberately not centred on a
 * point-symmetric range that could place a trajectory exactly there — the hash
 * makes that measure-zero anyway, but the offsets below keep it away from the
 * unstable equilibria at the same time.
 */
fn seedPoint(i : f32) -> vec3<f32> {
  return vec3<f32>(
    (hash11(i + 0.13) - 0.5) * 7.0 + 0.31,
    (hash11(i + 7.71) - 0.5) * 7.0 - 0.27,
    (hash11(i + 3.31) - 0.5) * 7.0 + 0.19,
  );
}
