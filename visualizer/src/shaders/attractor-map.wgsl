// The draw shared by the 2D ITERATED MAPS. One additive POINT sprite per orbit
// per frame — no vertex buffer, the vertex stage indexes the storage buffer the
// compute prepass just wrote.
//
// Points, not segments, and that is the single most important decision in this
// half of the family. See the header of `attractor-map-main.wgsl`: successive
// iterates are far apart, so a segment between them is a chord across the
// figure rather than a piece of it.
//
// The picture is therefore a DENSITY, not a set of strokes: N orbits each
// deposit one faint dot per frame, and the accumulator integrates them into the
// map's invariant measure. Two consequences worth stating because they are easy
// to get wrong:
//
//   - the per-frame contribution must be tuned FOR the accumulator. With
//     retention k the steady state is B/(1-k), which at a one-beat tau is ~50x
//     the per-frame value. Tuning `bright` as though each frame stood alone
//     whites the frame out in about a second.
//   - the layer needs a trail underneath it to look like anything at all. A
//     single frame of this source is a faint dust of dots.
//
// ---------------------------------------------------------------------------
// BINDINGS ARE NOT DECLARED HERE. The source module prepends
// `PASS_COMMON_WGSL`, its own params struct at `PASS_BINDING.params`, and
// `passBindingsWGSL` supplies `var<storage, read> points : array<f32>` at
// `PASS_BINDING.storage0`.
//
// Layout: [i*4 + 0..1] xy, [i*4 + 2] seeded flag, [i*4 + 3] iteration count.
//
// The params struct must expose, identically named: spin, scale, halfWidth,
// bright, hueShift, hueSpread.
// ---------------------------------------------------------------------------

struct VsOut {
  @builtin(position) pos : vec4<f32>,
  @location(0) local : vec2<f32>,   // -1..1 within the sprite
  @location(1) tint  : vec3<f32>,
};

fn ptAt(i : u32) -> vec2<f32> {
  let b = i * 4u;
  return vec2<f32>(points[b + 0u], points[b + 1u]);
}

// Same hash as the compute side. The render stage needs it for per-orbit weight
// variation and must not invent a second one.
fn hashR(p: f32) -> f32 {
  var x = fract(p * 0.1031);
  x = x * (x + 33.33);
  return fract((x + x) * x);
}

// OKLab -> linear sRGB (art-direction §2.1 — never lerp in sRGB).
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

@vertex
fn vs(@builtin(vertex_index) vi : u32) -> VsOut {
  let idx = vi / 6u;
  let corner = vi % 6u;

  var p = ptAt(idx);

  // A rigid rotation of the whole figure, absolute from `bars`. Not a radial
  // pulse and not centre-out motion — the figure simply turns, very slowly
  // (art-direction §4.1 forbids the former, not the latter).
  let c = cos(P.spin);
  let s = sin(P.spin);
  p = vec2<f32>(p.x * c - p.y * s, p.x * s + p.y * c);

  var ndc = p * P.scale;
  ndc.x = ndc.x / C.aspect;

  // VARY LINE WEIGHT (art-direction §4.4). Every orbit gets a stable size drawn
  // from its index, so the density field is built from a mixture of fine and
  // coarse grain instead of one uniform dot — the difference between a printed
  // stipple and a screen door.
  let w = P.halfWidth * (0.55 + 1.10 * hashR(f32(idx) * 0.37 + 5.0));

  let q = array<vec2<f32>, 6>(
    vec2<f32>(-1.0, -1.0), vec2<f32>( 1.0, -1.0), vec2<f32>(-1.0,  1.0),
    vec2<f32>(-1.0,  1.0), vec2<f32>( 1.0, -1.0), vec2<f32>( 1.0,  1.0),
  );
  let l = q[corner];
  let pos = ndc + l * vec2<f32>(w / C.aspect, w);

  // Hue walks along the figure's x — a linear gradient, deliberately, so it does
  // not read as radiating from the centre. It turns with the figure, because `p`
  // is already rotated.
  //
  // The 0.25 normalises by the figure's extent: both maps are bounded at
  // |x| <= 2, so `hueSpread` is radians across the WHOLE width rather than per
  // world unit. Without it the default 0.55 walks 2.2 rad — 126 degrees of hue
  // inside one frame, which is the hue variety art-direction §2.2 forbids, not
  // the "one hue and its neighbours" this is documented as.
  let h = P.hueShift + p.x * 0.25 * P.hueSpread;
  let lab = vec3<f32>(0.80, 0.090 * cos(h), 0.090 * sin(h));

  // Energy per point held constant as the weight varies. Without this the size
  // jitter above would double as a brightness jitter, and the coarse grain
  // would dominate the density it is supposed to texture.
  let area = max(w, 1e-6) / max(P.halfWidth, 1e-6);
  let gain = P.bright / (area * area);

  var out : VsOut;
  out.pos = vec4<f32>(pos, 0.0, 1.0);
  out.local = l;
  out.tint = max(oklabToLinear(lab), vec3<f32>(0.0)) * gain;
  return out;
}

@fragment
fn fs(in : VsOut) -> @location(0) vec4<f32> {
  // Analytic AA — a radial gaussian, so the sprite has no edge to alias
  // (art-direction §4.5).
  let a = exp(-dot(in.local, in.local) * 3.0);
  // C.opacity, always. See PASS_COMMON_WGSL.
  return vec4<f32>(in.tint * a, a) * C.opacity;
}
