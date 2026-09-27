// Lorenz attractor — compute prepass body.
//
// A trajectory is p[n+1] = f(p[n]): inherently SERIAL. It cannot be split
// across GPU threads. So we run M *independent* trajectories with different
// seeds — parallel across trajectories, serial along each — and advance every
// one by K steps per dispatch.
//
// This is why the project is WebGPU (plan §4.5). On WebGL2 the same thing needs
// transform feedback and a vertex shader pretending to be a compute kernel.
//
// ---------------------------------------------------------------------------
// BINDINGS ARE NOT DECLARED HERE.
//
// `sources/lorenz.ts` prepends `PASS_COMMON_WGSL` (struct Common as `C`), the
// shared `struct Lorenz` + its `var<uniform> P` at `PASS_BINDING.params`, and
// the `var<storage, read_write> points` declaration at `PASS_BINDING.storage0`.
// Every one of those numbers comes from `PASS_BINDING` in renderer.ts. This file
// used to hand-write `@binding(0)` / `@binding(1)`, which is exactly the drift
// that validates cleanly and then reads the wrong resource.
// ---------------------------------------------------------------------------
//
// BUFFER LAYOUT — unchanged, and it is a contract with `points.wgsl`:
// 8 floats per trajectory, i.e. two vec4s' worth.
//   [i*8 + 0..2] = xyz current position
//   [i*8 + 3]    = seeded flag (0 = never seeded)
//   [i*8 + 4..6] = xyz previous position (start of this frame's step)
//   [i*8 + 7]    = unused
//
// It is declared as `array<f32>` rather than `array<vec4<f32>>` because
// `passBindingsWGSL` generates the render-side declaration and generates it as
// `array<f32>`. The memory is identical either way — a vec4 array has a 16-byte
// stride, which is these same four floats — but the two stages must AGREE about
// the element type they index or the arithmetic silently diverges by a factor of
// four. So both sides index floats.
//
// Keeping the previous position is what lets the renderer draw a *segment*
// rather than a dot. Dots from 24k trajectories average into fog; segments
// resolve into the filaments the attractor is actually made of.

fn hash11(p: f32) -> f32 {
  var x = fract(p * 0.1031);
  x = x * (x + 33.33);
  return fract((x + x) * x);
}

/**
 * The seeded scatter. A pure function of the trajectory INDEX, which is what
 * makes the first frame reproducible without a CPU-side init hook: the renderer
 * zero-fills a new storage buffer, `w == 0` fails the seeded test below, and
 * every thread scatters itself to the same place it did last run (§4.7).
 */
fn seedPoint(i: f32) -> vec3<f32> {
  return vec3<f32>(
    (hash11(i + 0.13) - 0.5) * 24.0,
    (hash11(i + 7.71) - 0.5) * 30.0,
     hash11(i + 3.31) * 45.0 + 2.0,
  );
}

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

  if (points[base + 3u] < 0.5 || P.reseed > 0.5) {
    let s = seedPoint(f32(i));
    storePoint(base, s, 1.0, s);
    return;
  }

  let start = vec3<f32>(points[base + 0u], points[base + 1u], points[base + 2u]);

  // Forward Euler is enough: the step is tiny and the attractor is
  // structurally stable, so integration error reads as texture, not as the
  // wrong shape.
  //
  // P.dt is Lorenz time per SUBSTEP, and it was derived on the CPU from
  // `dtBeats` — the ribbons therefore travel a fixed distance per BEAT at any
  // refresh rate, which is the whole of art-direction §3.1. A fixed step per
  // frame ran the attractor faster at 165 fps than at 60 and meant nothing
  // musically.
  var q = start;
  let n = i32(P.steps);
  for (var s = 0; s < n; s = s + 1) {
    let d = vec3<f32>(
      P.sigma * (q.y - q.x),
      q.x * (P.rho - q.z) - q.y,
      q.x * q.y - P.beta * q.z,
    );
    q = q + d * P.dt;
  }

  // Divergence guard. Driving rho from audio can push the system unstable, and
  // without this one NaN poisons the buffer permanently. Written as `!(all(...))`
  // rather than `any(... >= limit)` deliberately: a NaN compares false against
  // everything, so only the negated form catches it.
  if (!(all(abs(q) < vec3<f32>(1000.0)))) {
    let s = seedPoint(f32(i) + 91.7);
    storePoint(base, s, 1.0, s);
    return;
  }

  storePoint(base, q, 1.0, start);
}
