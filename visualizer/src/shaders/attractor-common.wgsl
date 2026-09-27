// Shared compute-side helper for the strange-attractor family (plan §8.3).
//
// Prepended by every attractor source AFTER its params block and its
// `var<storage, read_write> points` declaration, and BEFORE the per-attractor
// body — WGSL resolves module-scope identifiers in declaration order, so the
// concatenation order in the TypeScript descriptor is load-bearing.
//
// One function, deliberately. Anything that touches the storage buffer differs
// between the two halves of the family: the continuous flows keep 8 floats per
// trajectory (current xyz, flag, previous xyz) because they draw SEGMENTS, and
// the iterated maps keep 4 (xy, flag, iteration count) because they draw POINTS.
// A "shared" store function would have to know which, which is one branch more
// than either case needs.
//
// This is byte-identical to `lorenz.wgsl`'s hash on purpose. The seeded scatter
// is what makes the first frame reproducible without a CPU init hook (§4.7), and
// two hashes that are nearly the same is how two sources that should agree
// quietly stop agreeing.

fn hash11(p: f32) -> f32 {
  var x = fract(p * 0.1031);
  x = x * (x + 33.33);
  return fract((x + x) * x);
}
