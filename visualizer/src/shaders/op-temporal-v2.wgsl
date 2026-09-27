// AAAVS V2 history operators. Common/audio/input/history bindings and Params
// are prepended by ops/temporal-v2.ts. Opacity is applied by the composite pass.

struct Params {
  mode : f32, keep : f32, inject : f32, driftX : f32,
  driftY : f32, split : f32, rate : f32, detail : f32,
  focusX : f32, focusY : f32, knee : f32, ceiling : f32,
};

const TAU : f32 = 6.28318530718;
const CLOCK_HALF : f32 = 1.0 / 2.0;

fn hash21(p : vec2<f32>) -> f32 {
  var q = fract(vec3<f32>(p.xyx) * 0.1031);
  q = q + dot(q, q.yzx + 33.33);
  return fract((q.x + q.y) * q.z);
}

fn softClip(v : vec3<f32>) -> vec3<f32> {
  let head = max(v - vec3<f32>(P.knee), vec3<f32>(0.0));
  let room = max(P.ceiling - P.knee, 0.05);
  return min(v, vec3<f32>(P.knee)) + (vec3<f32>(1.0) - exp(-head / room)) * room;
}

@vertex
fn vs(@builtin(vertex_index) vi : u32) -> @builtin(position) vec4<f32> {
  return fullscreenTriangle(vi);
}

@fragment
fn fs(@builtin(position) frag : vec4<f32>) -> @location(0) vec4<f32> {
  let uv = fragUV(frag);
  let plain = textureSampleLevel(src, samp, uv, 0.0).rgb;
  let baseShift = vec2<f32>(P.driftX, -P.driftY);
  var memory = vec3<f32>(0.0);

  if (P.mode < 0.5) {
    // TEMPORAL PRISM — the three channels follow subtly different history
    // paths around one off-centre origin. This creates time separation, not a
    // one-frame chromatic aberration.
    let focus = vec2<f32>(0.5 + P.focusX * 0.5, 0.5 - P.focusY * 0.5);
    let q = uv - focus;
    let radial = q / max(length(q), 0.0001);
    let tangent = vec2<f32>(-radial.y, radial.x);
    let pulse = 0.65 + 0.35 * sin(C.bars * P.rate * TAU + length(q) * (8.0 + P.detail * 4.0));
    let split = tangent * P.split * pulse * (0.55 + A.width * 0.9);
    let oldR = textureSampleLevel(hist, samp, clamp(uv + baseShift + split, vec2<f32>(0.001), vec2<f32>(0.999)), 0.0).r;
    let oldG = textureSampleLevel(hist, samp, clamp(uv + baseShift, vec2<f32>(0.001), vec2<f32>(0.999)), 0.0).g;
    let oldB = textureSampleLevel(hist, samp, clamp(uv + baseShift - split, vec2<f32>(0.001), vec2<f32>(0.999)), 0.0).b;
    memory = vec3<f32>(oldR, oldG, oldB) * P.keep + plain * P.inject;
  } else {
    // SLIT MEMORY — vertical strips sample different positions from one
    // recursively accumulated history texture. This is spatially offset
    // feedback, not a multi-age history atlas. The sweep is bar-locked.
    let strips = 8.0 + floor(P.detail * 18.0);
    let strip = floor(uv.x * strips);
    let seed = hash21(vec2<f32>(strip, C.seed));
    let sweep = fract(C.bars * P.rate + seed);
    let ageOffset = vec2<f32>(0.0, (sweep - 0.5) * P.split * (8.0 + P.detail * 4.0));
    let old = textureSampleLevel(hist, samp, clamp(uv + baseShift + ageOffset, vec2<f32>(0.001), vec2<f32>(0.999)), 0.0).rgb;
    let slit = exp(-abs(fract(uv.x * strips - C.bars * P.rate * CLOCK_HALF) - 0.5) * 14.0);
    memory = old * P.keep + plain * P.inject * (0.48 + slit * 1.35);
  }

  return vec4<f32>(softClip(max(memory, vec3<f32>(0.0))), 1.0);
}
