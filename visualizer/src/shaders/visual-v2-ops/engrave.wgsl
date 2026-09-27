struct EngraveParams {
  engravingMix    : f32,
  edgeGain        : f32,
  gradientRadiusPx: f32,
  hatchDefinition : f32,
  markThreshold   : f32,
  hatchRadians    : f32,
  _pad0           : f32,
  _pad1           : f32,
};

@fragment
fn fs(@builtin(position) frag : vec4<f32>) -> @location(0) vec4<f32> {
  let uv = fragUV(frag);
  let plain = textureSampleLevel(src, samp, uv, 0.0);
  let px = 1.0 / C.resolution;
  let east = luminance(safeSample(uv + vec2<f32>(px.x, 0.0) * P.gradientRadiusPx));
  let west = luminance(safeSample(uv - vec2<f32>(px.x, 0.0) * P.gradientRadiusPx));
  let north = luminance(safeSample(uv + vec2<f32>(0.0, px.y) * P.gradientRadiusPx));
  let south = luminance(safeSample(uv - vec2<f32>(0.0, px.y) * P.gradientRadiusPx));
  let grad = vec2<f32>(east - west, north - south);
  let edge = length(grad);
  let tone = luminance(plain.rgb / (vec3<f32>(1.0) + plain.rgb));
  // atan2(0, 0) is outside WGSL's defined domain. Flat/black regions use a
  // stable horizontal fallback so one adapter cannot turn the hatch NaN.
  let safeGrad = select(vec2<f32>(1.0, 0.0), grad, dot(grad, grad) > 0.00000001);
  let hatchAngle = atan2(safeGrad.y, safeGrad.x) + P.hatchRadians;
  let hatchUv = rot2(hatchAngle) * (uv * C.resolution / max(P.gradientRadiusPx, 0.25));
  let spacing = 3.0 + P.hatchDefinition * 3.0;
  let hatch = 1.0 - smoothstep(0.0, 0.18, abs(fract(hatchUv.x / spacing) - 0.5));
  let markLow = P.markThreshold * 0.30;
  let markHigh = max(max(P.markThreshold, 0.05), markLow + 0.0001);
  let markGate = smoothstep(markLow, markHigh, edge * 2.5 + (1.0 - tone) * 0.45);
  let paper = C.color.rgb * (0.06 + tone * 0.72);
  let effect = paper
    + C.color.rgb * edge * (1.8 + P.edgeGain * 4.0)
    + hatch * markGate * (1.0 - tone) * C.color.rgb * 0.16;
  return finishEffect(plain, effect, P.engravingMix);
}
