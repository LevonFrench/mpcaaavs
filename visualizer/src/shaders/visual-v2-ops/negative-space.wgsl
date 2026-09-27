struct NegativeSpaceParams {
  apertureMix    : f32,
  outsideDim     : f32,
  apertureRadius : f32,
  edgeDefinition : f32,
  centreX        : f32,
  centreY        : f32,
  _pad0          : f32,
  _pad1          : f32,
};

@fragment
fn fs(@builtin(position) frag : vec4<f32>) -> @location(0) vec4<f32> {
  let uv = fragUV(frag);
  let plain = textureSampleLevel(src, samp, uv, 0.0);
  let centreUv = vec2<f32>(0.5 + P.centreX * 0.5, 0.5 - P.centreY * 0.5);
  let q = (uv - centreUv) * vec2<f32>(C.aspect, 1.0);
  let radii = vec2<f32>(
    0.30 + P.apertureRadius * 0.20,
    0.24 + P.apertureRadius * 0.15,
  );
  let d = length(q / radii);
  let mask = 1.0 - smoothstep(0.88, 1.03, d);
  let edge = exp(-abs(d - 1.0) * (42.0 / max(P.edgeDefinition, 0.2)));
  let outside = mix(1.0, 1.0 - clamp(P.outsideDim, 0.0, 1.0), 1.0 - mask);
  let audioEdge = A.bands.y + A.bands.z * 0.7 + A.bands.w * 0.35;
  let effect = plain.rgb * outside
    + C.color.rgb * edge * 0.08 * (0.35 + audioEdge);
  return finishEffect(plain, effect, P.apertureMix);
}
