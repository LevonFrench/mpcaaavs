// Halvorsen's cyclically symmetric attractor — vector field and seeded scatter.
// The rest comes from `attractor-flow-main.wgsl`.
//
//   dx/dt = -a*x - 4y - 4z - y^2
//   dy/dt = -a*y - 4z - 4x - z^2
//   dz/dt = -a*z - 4x - 4y - x^2
//
// CANONICAL VALUE: a = 1.4. The 4s and the squares are structural, not tuning —
// changing them gives a different system, not a different-looking Halvorsen.
//
// `a` is the damping and the bifurcation parameter, and it is the one audio
// drives:
//
//   a ~ 1.9      collapses toward a limit cycle
//   a = 1.4      the canonical three-lobed attractor
//   a ~ 1.2      broader, more open lobes
//   a < 1.1      the trajectory escapes; the basin is genuinely finite here
//
// The audio therefore pushes `a` DOWN from 1.4 and the range is clamped short
// of the escape, because this is the one member of the family with a real basin
// boundary — the quadratic terms diverge in finite time outside it, which is
// exactly what the guard in `attractor-flow-main.wgsl` exists for. Losing a few
// trajectories per frame to the guard at low `a` is fine and reads as sparkle;
// losing all of them is a black frame.
//
// P.pa = a. `P.pb` and `P.pc` are unused — see the note in `attr-thomas.wgsl`.

fn deriv(q : vec3<f32>) -> vec3<f32> {
  return vec3<f32>(
    -P.pa * q.x - 4.0 * q.y - 4.0 * q.z - q.y * q.y,
    -P.pa * q.y - 4.0 * q.z - 4.0 * q.x - q.z * q.z,
    -P.pa * q.z - 4.0 * q.x - 4.0 * q.y - q.x * q.x,
  );
}

/**
 * The scatter — TIGHT, and that is the whole point.
 *
 * (-1.48, -1.51, 2.04) is the standard published initial condition for this
 * system and is on the attractor. The basin is finite, so a loose cloud like
 * Rossler's would seed most trajectories outside it; they would diverge, hit
 * the guard, reseed to the same doomed point and strobe at the frame rate.
 * +/-0.8 stays comfortably inside.
 */
fn seedPoint(i : f32) -> vec3<f32> {
  return vec3<f32>(
    -1.48 + (hash11(i + 0.13) - 0.5) * 1.6,
    -1.51 + (hash11(i + 7.71) - 0.5) * 1.6,
     2.04 + (hash11(i + 3.31) - 0.5) * 1.6,
  );
}
