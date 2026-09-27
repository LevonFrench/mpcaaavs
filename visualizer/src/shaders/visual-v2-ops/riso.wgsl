struct RisoParams {
  printMix            : f32,
  registrationStrength: f32,
  registrationRadiusPx: f32,
  dotDefinition       : f32,
  plateBalance        : f32,
  inkThreshold        : f32,
  registrationRadians : f32,
  _pad0               : f32,
};

@fragment
fn fs(@builtin(position) frag : vec4<f32>) -> @location(0) vec4<f32> {
  let uv = fragUV(frag);
  let plain = textureSampleLevel(src, samp, uv, 0.0);
  let px = 1.0 / C.resolution;
  let shift = rot2(P.registrationRadians) * px * P.registrationRadiusPx
    * (1.0 + P.registrationStrength * 6.0)
    * vec2<f32>(1.0 + A.width, 1.0);
  let plateAValue = luminance(safeSample(uv + shift));
  let plateBValue = luminance(safeSample(uv - shift));
  let cell = uv * C.resolution / (2.5 + P.dotDefinition * 3.5);
  let dotScreen = 1.0 - smoothstep(0.16, 0.44, length(fract(cell) - 0.5));
  let plateA = C.color.rgb
    * smoothstep(0.05, max(P.inkThreshold, 0.06), plateAValue)
    * (0.54 + dotScreen * 0.46);
  let plateBColor = mix(
    vec3<f32>(0.92, 0.20, 0.10),
    vec3<f32>(0.10, 0.56, 0.82),
    P.plateBalance,
  );
  let plateB = plateBColor
    * smoothstep(0.04, max(P.inkThreshold * 1.12, 0.06), plateBValue)
    * (0.45 + (1.0 - dotScreen) * 0.55);
  return finishEffect(plain, plateA + plateB + plain.rgb * 0.08, P.printMix);
}
