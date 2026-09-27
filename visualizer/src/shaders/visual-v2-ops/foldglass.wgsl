struct FoldglassParams {
  glassMix           : f32,
  refractionStrength : f32,
  creaseWidth        : f32,
  foldSlope          : f32,
  centreX            : f32,
  centreY            : f32,
  axisRadians        : f32,
  _pad0              : f32,
};

@fragment
fn fs(@builtin(position) frag : vec4<f32>) -> @location(0) vec4<f32> {
  let uv = fragUV(frag);
  let plain = textureSampleLevel(src, samp, uv, 0.0);
  let centreUv = vec2<f32>(0.5 + P.centreX * 0.5, 0.5 - P.centreY * 0.5);
  let aspectQ = (uv - centreUv) * vec2<f32>(C.aspect, 1.0);
  let q = rot2(P.axisRadians) * aspectQ;
  let slope = 0.46 + P.foldSlope * 0.16;
  let diagonal = q.y - abs(q.x) * slope;
  let side = select(-1.0, 1.0, diagonal > 0.0);
  let normal = normalize(vec2<f32>(-side * slope, 1.0));
  let fold = exp(-abs(diagonal) * (22.0 / max(P.creaseWidth, 0.2)));
  let audioRefraction = A.bands.y + A.bands.z * 0.7 + A.bands.w * 0.35;
  let offset = normal / vec2<f32>(C.aspect, 1.0)
    * fold * P.refractionStrength * (0.008 + audioRefraction * 0.010);
  let refracted = safeSample(uv + offset);
  let caustic = C.color.rgb * fold * (0.12 + P.refractionStrength * 0.24);
  return finishEffect(plain, refracted + caustic, P.glassMix);
}
