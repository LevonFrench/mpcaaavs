// Final pass: HDR accumulation -> swapchain.
//
// Everything upstream is rgba16float and freely exceeds 1.0. This is the only
// place that becomes a displayable image, so it owns bloom, tone mapping and
// the vignette, and it is the only place that should.

struct Post {
  bloom    : f32,
  exposure : f32,
  vignette : f32,
  aspect   : f32,
  grain    : f32,
  time     : f32,
  pad0     : f32,
  pad1     : f32,
};

@group(0) @binding(0) var src : texture_2d<f32>;
@group(0) @binding(1) var samp : sampler;
@group(0) @binding(2) var<uniform> P : Post;

@vertex
fn vs(@builtin(vertex_index) vi : u32) -> @builtin(position) vec4<f32> {
  let p = array<vec2<f32>, 3>(
    vec2<f32>(-1.0, -1.0), vec2<f32>( 3.0, -1.0), vec2<f32>(-1.0,  3.0),
  );
  return vec4<f32>(p[vi], 0.0, 1.0);
}

// Narkowicz ACES. A *look*, not a correction — it rolls highlights off so
// additive accumulation stops clipping to flat white.
fn aces(x: vec3<f32>) -> vec3<f32> {
  let a = 2.51; let b = 0.03; let c = 2.43; let d = 0.59; let e = 0.14;
  return clamp((x * (a * x + b)) / (x * (c * x + d) + e), vec3<f32>(0.0), vec3<f32>(1.0));
}

fn hash21(p: vec2<f32>) -> f32 {
  var p3 = fract(vec3<f32>(p.xyx) * 0.1031);
  p3 = p3 + dot(p3, p3.yzx + 33.33);
  return fract((p3.x + p3.y) * p3.z);
}

@fragment
fn fs(@builtin(position) frag : vec4<f32>) -> @location(0) vec4<f32> {
  let dims = vec2<f32>(textureDimensions(src));
  let uv = frag.xy / dims;
  let texel = 1.0 / dims;

  var col = textureSampleLevel(src, samp, uv, 0.0).rgb;

  // Cheap threshold bloom. A real mip chain belongs here (plan §4.11) — this is
  // a fixed 12-tap ring, which is honest for a vertical slice and would be the
  // wrong answer at 2K120.
  if (P.bloom > 0.001) {
    var sum = vec3<f32>(0.0);
    let radius = 9.0;
    for (var i = 0; i < 12; i = i + 1) {
      let a = f32(i) * 0.5235988;           // 2pi/12
      let o = vec2<f32>(cos(a), sin(a)) * radius * texel;
      let s = textureSampleLevel(src, samp, uv + o, 0.0).rgb;
      sum = sum + max(s - vec3<f32>(0.6), vec3<f32>(0.0));
    }
    col = col + sum * (P.bloom / 12.0);
  }

  col = col * P.exposure;

  // Vignette. Multiplicative and gentle — art-direction §4.3 wants most of the
  // frame near-black, and this helps without eating the subject.
  let d = length((uv - 0.5) * vec2<f32>(P.aspect, 1.0));
  col = col * mix(1.0, smoothstep(1.05, 0.25, d), P.vignette);

  col = aces(col);

  // Grain after tone mapping, so it lives in display space and does not get
  // crushed by the curve.
  if (P.grain > 0.001) {
    let n = hash21(frag.xy + vec2<f32>(P.time * 60.0, P.time * 37.0)) - 0.5;
    col = col + vec3<f32>(n * P.grain * 0.06);
  }

  return vec4<f32>(col, 1.0);
}
