// The compute entry point shared by every CONTINUOUS attractor (Rossler,
// Thomas, Halvorsen — and structurally the same thing `lorenz.wgsl` writes out
// longhand).
//
// Concatenated LAST, after `attractor-common.wgsl` (hash11) and after the
// per-attractor body, which supplies exactly two functions:
//
//   fn deriv(q : vec3<f32>) -> vec3<f32>   the vector field, dp/dt
//   fn seedPoint(i : f32)   -> vec3<f32>   a scatter inside the basin
//
// Splitting it this way is the whole reason the family is cheap: a new flow is
// ~15 lines of arithmetic plus a parameter table, and it inherits the storage
// layout, the per-beat step, the divergence guard and the segment renderer
// without restating any of them.
//
// BUFFER LAYOUT — a contract with `attractor-flow.wgsl`:
//   [i*8 + 0..2] current xyz
//   [i*8 + 3]    seeded flag (0 = never seeded)
//   [i*8 + 4..6] previous xyz — the START of this dispatch's step
//   [i*8 + 7]    unused
//
// Keeping the previous position is what lets the draw emit a SEGMENT rather
// than a dot, and that single choice is most of the visual quality in the whole
// family: N gaussian dots average into fog, N short segments resolve into the
// filaments the attractor is actually made of.

fn storePoint(base: u32, cur: vec3<f32>, flag: f32, prev: vec3<f32>) {
  points[base + 0u] = cur.x;
  points[base + 1u] = cur.y;
  points[base + 2u] = cur.z;
  points[base + 3u] = flag;
  points[base + 4u] = prev.x;
  points[base + 5u] = prev.y;
  points[base + 6u] = prev.z;
  points[base + 7u] = 0.0;
}

@compute @workgroup_size(64)
fn main(@builtin(global_invocation_id) gid : vec3<u32>) {
  let i = gid.x;
  if (f32(i) >= P.count) { return; }

  let base = i * 8u;

  // A zero-filled buffer fails the seeded test, so the first dispatch after
  // allocation scatters every trajectory from a pure function of its index —
  // no CPU seeding step, and identical on every run (§4.7).
  if (points[base + 3u] < 0.5 || P.reseed > 0.5) {
    let s = seedPoint(f32(i));
    storePoint(base, s, 1.0, s);
    return;
  }

  let start = vec3<f32>(points[base + 0u], points[base + 1u], points[base + 2u]);

  // Forward Euler. The step is tiny and these systems are structurally stable,
  // so integration error reads as texture rather than as the wrong shape.
  //
  // `P.dt` is simulation time per SUBSTEP and was derived on the CPU from
  // `dtBeats`, so a ribbon travels a fixed distance per BEAT at any refresh
  // rate (art-direction §3.1). A fixed step per frame runs the attractor faster
  // at 165 fps than at 60 and means nothing musically.
  var q = start;
  let n = i32(P.steps);
  for (var s = 0; s < n; s = s + 1) {
    q = q + deriv(q) * P.dt;
  }

  // Divergence guard. Audio drives a bifurcation parameter, which can and does
  // push these systems outside their attracting set; without this, one NaN
  // poisons the storage buffer permanently. Written as `!(all(...))` rather
  // than `any(... >= limit)` deliberately — a NaN compares false against
  // everything, so only the negated form catches it.
  //
  // The reseed offset differs from the initial one so a trajectory that keeps
  // escaping does not land on the same doomed point every frame and strobe.
  if (!(all(abs(q) < vec3<f32>(1000.0)))) {
    let s = seedPoint(f32(i) + 91.7);
    storePoint(base, s, 1.0, s);
    return;
  }

  storePoint(base, q, 1.0, start);
}
