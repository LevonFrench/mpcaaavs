// Draws each trajectory's step as an additive line SEGMENT — the render body of
// the `lorenz` source.
//
// No vertex buffer — the vertex shader indexes the same storage buffer the
// compute prepass just wrote. In WebGL2 this needs transform feedback and a real
// VBO; here it is one binding.
//
// Segments, not points, is the whole visual argument. 24k gaussian dots average
// into a nebula; 24k short segments resolve into the filaments the attractor is
// actually made of. Each segment is a quad (6 verts) built from prev -> cur,
// which also gives it area to antialias across.
//
// ---------------------------------------------------------------------------
// BINDINGS ARE NOT DECLARED HERE.
//
// `sources/lorenz.ts` prepends `PASS_COMMON_WGSL` (struct Common as `C`,
// `fullscreenTriangle`, `fragUV`), the shared `struct Lorenz` + `var<uniform> P`
// at `PASS_BINDING.params`, and `passBindingsWGSL` supplies
// `var<storage, read> points : array<f32>` at `PASS_BINDING.storage0`.
//
// `points` is `array<f32>`, not `array<vec4<f32>>`: the renderer generates that
// declaration and generates it as floats. Same bytes, but see the layout note in
// `lorenz.wgsl` — both stages must index the same element type.
//   [i*8 + 0..2] current xyz, [i*8 + 3] seeded flag,
//   [i*8 + 4..6] previous xyz, [i*8 + 7] unused.
//
// The aspect ratio comes from `C.aspect` rather than from a param, because the
// renderer already knows the attachment size and a second copy of it is a second
// thing that can disagree with the attachment this pass is actually writing.
// ---------------------------------------------------------------------------

struct VsOut {
  @builtin(position) pos : vec4<f32>,
  @location(0) across : f32,        // -1..1 across the segment's width
  @location(1) tint   : vec3<f32>,
};

fn posAt(i : u32) -> vec3<f32> {
  let b = i * 8u;
  return vec3<f32>(points[b + 0u], points[b + 1u], points[b + 2u]);
}

fn prevAt(i : u32) -> vec3<f32> {
  let b = i * 8u;
  return vec3<f32>(points[b + 4u], points[b + 5u], points[b + 6u]);
}

// OKLab -> linear sRGB. Perceptual mixing matters even for two stops:
// interpolating in sRGB passes through a grey dead-zone (art-direction §2.1).
fn oklabToLinear(c: vec3<f32>) -> vec3<f32> {
  let l_ = c.x + 0.3963377774 * c.y + 0.2158037573 * c.z;
  let m_ = c.x - 0.1055613458 * c.y - 0.0638541728 * c.z;
  let s_ = c.x - 0.0894841775 * c.y - 1.2914855480 * c.z;
  let l = l_ * l_ * l_;
  let m = m_ * m_ * m_;
  let s = s_ * s_ * s_;
  return vec3<f32>(
    4.0767416621 * l - 3.3077115913 * m + 0.2309699292 * s,
   -1.2684380046 * l + 2.6097574011 * m - 0.3413193965 * s,
   -0.0041960863 * l - 0.7034186147 * m + 1.7076147010 * s,
  );
}

/** World -> clip. Returns xy in NDC and the depth factor used for shading. */
fn project(p: vec3<f32>) -> vec3<f32> {
  // Centre on the attractor and view the x-z plane — the classic butterfly.
  // Lorenz y becomes depth, so the spin below reveals its 3D structure.
  var q = vec3<f32>(p.x, p.z - 25.0, p.y);
  let c = cos(P.spin);
  let s = sin(P.spin);
  q = vec3<f32>(q.x * c - q.z * s, q.y, q.x * s + q.z * c);

  let depth = 1.0 / (1.0 + max(q.z, -55.0) * 0.012);
  var ndc = vec2<f32>(q.x, q.y) * P.scale * depth;
  ndc.x = ndc.x / C.aspect;
  return vec3<f32>(ndc, depth);
}

@vertex
fn vs(@builtin(vertex_index) vi : u32) -> VsOut {
  let idx = vi / 6u;
  let corner = vi % 6u;

  let a = project(prevAt(idx));
  let b = project(posAt(idx));

  // Perpendicular to the segment, in NDC. A degenerate segment (a == b, which
  // happens on the frame after a reseed) would produce NaN from normalize, so
  // fall back to a fixed direction.
  var dir = b.xy - a.xy;
  let len = length(dir);
  if (len < 1e-7) { dir = vec2<f32>(1.0, 0.0); } else { dir = dir / len; }
  let nrm = vec2<f32>(-dir.y, dir.x);

  let w = P.halfWidth;
  let off = nrm * vec2<f32>(w / C.aspect, w);

  // Two triangles: a-, a+, b-, b-, a+, b+
  var pos : vec2<f32>;
  var across : f32;
  switch (corner) {
    case 0u: { pos = a.xy - off; across = -1.0; }
    case 1u: { pos = a.xy + off; across =  1.0; }
    case 2u: { pos = b.xy - off; across = -1.0; }
    case 3u: { pos = b.xy - off; across = -1.0; }
    case 4u: { pos = a.xy + off; across =  1.0; }
    default: { pos = b.xy + off; across =  1.0; }
  }

  // Hue walks with depth so the two lobes separate. Low chroma on purpose —
  // three hues maximum, and this is one of them (art-direction §2.2).
  let h = P.hueShift + b.z * 0.9;
  let lab = vec3<f32>(0.80, 0.10 * cos(h), 0.10 * sin(h));

  // Fade very long segments. A trajectory crossing between lobes moves fast,
  // and drawing that jump at full brightness paints a bright chord straight
  // across the middle of the butterfly.
  let speed = clamp(1.0 - len * 22.0, 0.05, 1.0);

  var out : VsOut;
  out.pos = vec4<f32>(pos, 0.0, 1.0);
  out.across = across;
  out.tint = max(oklabToLinear(lab), vec3<f32>(0.0)) * P.bright * b.z * speed;
  return out;
}

@fragment
fn fs(in : VsOut) -> @location(0) vec4<f32> {
  // Gaussian across the width, so the segment has soft edges instead of a hard
  // 1px ribbon. Additive hard edges band visibly where segments overlap.
  let a = exp(-in.across * in.across * 3.0);
  // C.opacity is the one obligation PASS_COMMON_WGSL imposes: fixed-function
  // blending has no per-draw multiplier, so a pass that ignores it is a pass
  // whose opacity slider does nothing.
  return vec4<f32>(in.tint * a, a) * C.opacity;
}
