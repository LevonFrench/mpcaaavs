// Kaleidoscope — the one operator in the vertical slice.
//
// Operators are MULTIPLICATIVE (plan §7): eight sources times five operators is
// forty looks. This one is ~15 lines of real work and transforms literally
// every source, which is why operators are built before sources.
//
// Note the deliberate exception in art-direction §4.1: nothing else in the
// project radiates from the centre, because that reads as a cheap "pulse from
// the middle". A kaleidoscope's entire point IS a centre — which is exactly why
// it should not be applied to everything.
//
// ---------------------------------------------------------------------------
// BINDINGS ARE NOT DECLARED HERE.
//
// `ops/kaleido.ts` prepends `PASS_COMMON_WGSL` (struct Common as `C`,
// `fullscreenTriangle`, `fragUV`) and `passBindingsWGSL`, which supply `src` and
// `samp`, and appends the `var<uniform> K : Kal` declaration at
// `PASS_BINDING.params`. No binding number is typed in this file; renderer.ts
// owns the layout and a hand-written number is how a shader ends up one binding
// out of step, which validates cleanly and samples the wrong texture.
//
// The aspect ratio comes from `C.aspect` — the renderer already knows the
// attachment size, and a param copy of it is a second value that can disagree
// with the attachment actually being written when a resolution scale changes.
// ---------------------------------------------------------------------------

struct Kal {
  segments : f32,   // 0 = bypass
  rotate   : f32,   // radians
  mix      : f32,   // 0..1 blend against the untransformed source
  pad      : f32,
};

@vertex
fn vs(@builtin(vertex_index) vi : u32) -> @builtin(position) vec4<f32> {
  return fullscreenTriangle(vi);
}

@fragment
fn fs(@builtin(position) frag : vec4<f32>) -> @location(0) vec4<f32> {
  let uv = fragUV(frag);
  let plain = textureSampleLevel(src, samp, uv, 0.0);

  if (K.segments < 1.5) { return plain * C.opacity; }

  // Work in aspect-corrected polar space, or the wedges are sheared.
  var p = (uv - 0.5) * vec2<f32>(C.aspect, 1.0);
  let r = length(p);
  var a = atan2(p.y, p.x) + K.rotate;

  // Fold the angle into one wedge, then mirror alternate wedges so the seams
  // meet instead of hard-cutting. The mirror is what makes it read as a
  // kaleidoscope rather than a pie chart.
  let wedge = 6.2831853 / K.segments;
  a = a - floor(a / wedge) * wedge;
  a = abs(a - wedge * 0.5);

  var q = vec2<f32>(cos(a), sin(a)) * r;
  q = q / vec2<f32>(C.aspect, 1.0) + 0.5;

  // Outside the source, fold back rather than clamping — clamping smears the
  // edge texel into a visible streak.
  q = abs(fract(q * 0.5) * 2.0 - 1.0);

  let folded = textureSampleLevel(src, samp, q, 0.0);
  return mix(plain, folded, K.mix) * C.opacity;
}
