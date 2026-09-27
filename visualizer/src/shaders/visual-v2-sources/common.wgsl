// Shared geometry/math for the authored V2 source modules. This file contains
// no source modes and no source uniforms. Every animated phase starts from an
// explicit rational period in bars supplied by its descriptor.

const V2_TAU : f32 = 6.28318530718;

fn v2PhaseBars(periodBars : f32) -> f32 {
  if (abs(periodBars) < 0.00001) {
    return 0.0;
  }
  let direction = select(1.0, -1.0, periodBars < 0.0);
  // Keep the base phase unwrapped: a 1/32 child phase must complete after 32
  // parent cycles, not jump back to zero at every parent-cycle boundary.
  return (C.bars / abs(periodBars)) * V2_TAU * direction;
}

fn v2PhaseRatio(phase : f32, numerator : f32, denominator : f32) -> f32 {
  return phase * numerator / max(denominator, 1.0);
}

fn v2CycleRatio(phase : f32, numerator : f32, denominator : f32) -> f32 {
  return (phase / V2_TAU) * numerator / max(denominator, 1.0);
}

fn v2Rot2(a : f32) -> mat2x2<f32> {
  let c = cos(a);
  let s = sin(a);
  return mat2x2<f32>(c, -s, s, c);
}

fn v2Hash11(x : f32) -> f32 {
  return fract(sin(x * 127.1 + C.seed * 0.013) * 43758.5453);
}

fn v2Atan2(p : vec2<f32>) -> f32 {
  // atan2(0, 0) is indeterminate in WGSL. A fragment can land exactly on the
  // subject centre on odd-sized attachments, so choose +X deterministically.
  let safe = select(vec2<f32>(0.000001, 0.0), p, dot(p, p) > 0.000000000001);
  return atan2(safe.y, safe.x);
}

fn v2LineAA(d : f32, width : f32) -> f32 {
  let aa = max(fwidth(d) * 1.35, 0.00045);
  return 1.0 - smoothstep(width, width + aa, abs(d));
}

fn v2SegmentDistance(p : vec2<f32>, a : vec2<f32>, b : vec2<f32>) -> f32 {
  let pa = p - a;
  let ba = b - a;
  let h = clamp(dot(pa, ba) / max(dot(ba, ba), 0.00001), 0.0, 1.0);
  return length(pa - ba * h);
}

fn v2EllipseMask(p : vec2<f32>, radii : vec2<f32>) -> f32 {
  let d = length(p / max(radii, vec2<f32>(0.001)));
  return 1.0 - smoothstep(0.92, 1.0, d);
}

fn v2SubjectPoint(frag : vec4<f32>, centerX : f32, centerY : f32) -> vec2<f32> {
  let uv = fragUV(frag);
  let p = vec2<f32>((uv.x * 2.0 - 1.0) * C.aspect, 1.0 - uv.y * 2.0);
  return p - vec2<f32>(centerX * C.aspect, centerY);
}

@vertex
fn vs(@builtin(vertex_index) vi : u32) -> @builtin(position) vec4<f32> {
  return fullscreenTriangle(vi);
}
