struct DiffractionParams {
  flareMix           : f32,
  flareGain          : f32,
  sampleRadiusPx     : f32,
  sampleSpacing      : f32,
  luminanceThreshold : f32,
  spectralTint       : f32,
  axisRadians        : f32,
  _pad0              : f32,
};

@fragment
fn fs(@builtin(position) frag : vec4<f32>) -> @location(0) vec4<f32> {
  let uv = fragUV(frag);
  let plain = textureSampleLevel(src, samp, uv, 0.0);
  let px = 1.0 / C.resolution;
  let dir = normalize(rot2(P.axisRadians) * vec2<f32>(1.0, 0.0));
  var flare = vec3<f32>(0.0);
  var weight = 0.0;
  for (var i : i32 = -4; i <= 4; i = i + 1) {
    let fi = f32(i);
    let w = exp(-abs(fi) * 0.62);
    let distancePx = fi * P.sampleRadiusPx * (4.0 + P.sampleSpacing * 3.0);
    let sampleRgb = safeSample(uv + dir * px * distancePx);
    flare = flare + max(sampleRgb - vec3<f32>(P.luminanceThreshold), vec3<f32>(0.0)) * w;
    weight = weight + w;
  }
  flare = flare / max(weight, 0.001);
  let audioGain = A.bands.y + A.bands.z * 0.7 + A.bands.w * 0.35;
  let tint = mix(vec3<f32>(1.0), C.color.rgb, P.spectralTint * 0.55);
  let effect = plain.rgb + flare * tint * P.flareGain * (0.5 + audioGain * 0.9);
  return finishEffect(plain, effect, P.flareMix);
}
