// The draw shared by every CONTINUOUS attractor in the family. One additive
// line SEGMENT per trajectory per frame, no vertex buffer — the vertex stage
// indexes the same storage buffer the compute prepass just wrote.
//
// This is `points.wgsl` generalised. The only thing that file hard-codes and
// this one does not is the projection: Lorenz wants its y axis as depth (the
// butterfly lives in x-z), whereas Rossler, Thomas and Halvorsen all read
// correctly with x-y as the picture plane and z as depth. Rather than carry an
// axis-permutation mode, the centring offset is a uniform and each source names
// its own — a wrong constant here is a blob, not an attractor.
//
// ---------------------------------------------------------------------------
// BINDINGS ARE NOT DECLARED HERE.
//
// The source module prepends `PASS_COMMON_WGSL` (struct Common as `C`), its own
// params struct at `PASS_BINDING.params`, and `passBindingsWGSL` supplies
// `var<storage, read> points : array<f32>` at `PASS_BINDING.storage0`. Every
// number comes from `PASS_BINDING` in renderer.ts.
//
// `points` is `array<f32>`, matching the generated declaration. Same bytes as a
// vec4 array, but both stages must index the same element type or the
// arithmetic silently diverges by a factor of four. Layout is in
// `attractor-flow-main.wgsl`.
//
// The params struct must expose these fields, identically named, in every
// source that uses this body: spin, scale, halfWidth, bright, hueShift,
// centreX, centreY, centreZ, depthK, hueSpread.
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
  var q = p - vec3<f32>(P.centreX, P.centreY, P.centreZ);

  // Rotation about the VERTICAL, which is what reveals the 3D structure of a
  // flow that would otherwise read as a flat scribble. `P.spin` is an absolute
  // angle derived from `bars`, never an integrated one — an integrated angle is
  // a function of frame history and two runs at different pacing end up
  // pointing different ways (§4.7).
  let c = cos(P.spin);
  let s = sin(P.spin);
  q = vec3<f32>(q.x * c - q.z * s, q.y, q.x * s + q.z * c);

  // Weak perspective. The clamp keeps the denominator away from zero: a point
  // far enough behind the eye would otherwise flip sign and throw the segment
  // across the frame. 0.6 caps the near gain at 2.5x.
  let k = max(P.depthK, 1e-4);
  let depth = 1.0 / (1.0 + max(q.z, -0.6 / k) * k);

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
  // happens on the frame after a reseed) would make normalize return NaN, so
  // fall back to a fixed direction.
  var dir = b.xy - a.xy;
  let len = length(dir);
  if (len < 1e-7) { dir = vec2<f32>(1.0, 0.0); } else { dir = dir / len; }
  let nrm = vec2<f32>(-dir.y, dir.x);

  // VARY LINE WEIGHT (art-direction §4.4). Uniform stroke reads flat and
  // machine-drawn. Two analytic terms, no noise: near segments are heavier than
  // far ones, and a segment crossing fast is drawn finer than one dwelling —
  // which is also the correct physical reading, since a fast segment covers the
  // same ink over more length.
  let w = P.halfWidth
        * (0.55 + 0.75 * b.z)
        * (1.0 - 0.35 * clamp(len * 30.0, 0.0, 1.0));
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

  // Hue walks with DEPTH only, over a narrow spread. That is one hue plus its
  // neighbours, not a rainbow — hue variety within a frame is the number one
  // amateur tell (art-direction §2.2), while slow rotation of the whole band
  // over bars is fine and is what `hueShift` does.
  let h = P.hueShift + b.z * P.hueSpread;
  let lab = vec3<f32>(0.82, 0.085 * cos(h), 0.085 * sin(h));

  // Fade long segments. A trajectory jumping between lobes moves fast, and
  // drawing that jump at full brightness paints a bright chord straight across
  // the figure — the same artefact that makes segment rendering wrong for the
  // iterated maps entirely.
  let speed = clamp(1.0 - len * 22.0, 0.05, 1.0);

  var out : VsOut;
  out.pos = vec4<f32>(pos, 0.0, 1.0);
  out.across = across;
  out.tint = max(oklabToLinear(lab), vec3<f32>(0.0)) * P.bright * b.z * speed;
  return out;
}

@fragment
fn fs(in : VsOut) -> @location(0) vec4<f32> {
  // Analytic AA: a gaussian across the width, so the segment has soft edges
  // instead of a hard ribbon. Aliased hairlines are the fastest way to look
  // 2003 (art-direction §4.5), and additive hard edges band where they overlap.
  let a = exp(-in.across * in.across * 3.0);
  // C.opacity is the one obligation PASS_COMMON_WGSL imposes: fixed-function
  // blending has no per-draw multiplier, so a pass that ignores it is a pass
  // whose opacity slider does nothing.
  return vec4<f32>(in.tint * a, a) * C.opacity;
}
