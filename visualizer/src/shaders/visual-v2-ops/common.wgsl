// Shared mechanics for the nine independent V2 spatial-operator modules.
// Resource bindings and PassCommon are prepended by ops/visual-v2.ts.

const PI : f32 = 3.14159265359;
const TAU : f32 = 6.28318530718;

fn rot2(angle : f32) -> mat2x2<f32> {
  let c = cos(angle);
  let s = sin(angle);
  return mat2x2<f32>(c, -s, s, c);
}

fn luminance(rgb : vec3<f32>) -> f32 {
  return dot(rgb, vec3<f32>(0.2126, 0.7152, 0.0722));
}

fn safeSample(uv : vec2<f32>) -> vec3<f32> {
  let bounded = clamp(uv, vec2<f32>(0.001), vec2<f32>(0.999));
  return textureSampleLevel(src, samp, bounded, 0.0).rgb;
}

fn finishEffect(plain : vec4<f32>, effect : vec3<f32>, authoredMix : f32) -> vec4<f32> {
  // The operator owns its crossfade. At an envelope of zero this returns the
  // accumulator byte-for-byte instead of dimming a replace layer.
  let t = clamp(authoredMix * C.opacity, 0.0, 1.0);
  return vec4<f32>(mix(plain.rgb, effect, t), plain.a);
}

@vertex
fn vs(@builtin(vertex_index) vi : u32) -> @builtin(position) vec4<f32> {
  return fullscreenTriangle(vi);
}
