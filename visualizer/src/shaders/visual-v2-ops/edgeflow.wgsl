struct EdgeflowParams {
  flowMix          : f32,
  advectionStrength: f32,
  gradientRadiusPx : f32,
  travelDetail     : f32,
  structureMix     : f32,
  forwardBias      : f32,
  reverseTravel    : f32,
  _pad0            : f32,
};

@fragment
fn fs(@builtin(position) frag : vec4<f32>) -> @location(0) vec4<f32> {
  let uv = fragUV(frag);
  let plain = textureSampleLevel(src, samp, uv, 0.0);
  let px = 1.0 / C.resolution;
  let ex = luminance(safeSample(uv + vec2<f32>(px.x, 0.0) * P.gradientRadiusPx))
    - luminance(safeSample(uv - vec2<f32>(px.x, 0.0) * P.gradientRadiusPx));
  let ey = luminance(safeSample(uv + vec2<f32>(0.0, px.y) * P.gradientRadiusPx))
    - luminance(safeSample(uv - vec2<f32>(0.0, px.y) * P.gradientRadiusPx));
  let tangentRaw = vec2<f32>(-ey, ex);
  let tangent = tangentRaw / max(length(tangentRaw), 0.0001);
  let audioTravel = A.bands.y + A.bands.z * 0.7 + A.bands.w * 0.35;
  let distancePx = P.advectionStrength
    * (2.0 + P.travelDetail * 7.0)
    * (0.35 + audioTravel);
  let forward = safeSample(uv + tangent * px * distancePx);
  let backward = safeSample(uv - tangent * px * distancePx * P.reverseTravel);
  let edge = min(1.0, length(vec2<f32>(ex, ey)) * 5.0);
  let advected = mix(backward, forward, P.forwardBias);
  let effect = mix(plain.rgb, advected, edge * P.structureMix);
  return finishEffect(plain, effect, P.flowMix);
}
