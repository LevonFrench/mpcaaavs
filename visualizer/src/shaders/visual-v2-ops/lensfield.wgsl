struct LensfieldParams {
  lensMix           : f32,
  refractionStrength: f32,
  lensRadius        : f32,
  rimDefinition     : f32,
  refractionMix     : f32,
  centreX           : f32,
  centreY           : f32,
  _pad0             : f32,
};

@fragment
fn fs(@builtin(position) frag : vec4<f32>) -> @location(0) vec4<f32> {
  let uv = fragUV(frag);
  let plain = textureSampleLevel(src, samp, uv, 0.0);
  let centreUv = vec2<f32>(0.5 + P.centreX * 0.5, 0.5 - P.centreY * 0.5);
  let q = (uv - centreUv) * vec2<f32>(C.aspect, 1.0);
  let radius = 0.18 + P.lensRadius * 0.17;
  let r = length(q);
  let inside = 1.0 - smoothstep(radius * 0.94, radius, r);
  let normal = q / max(r, 0.001);
  let bulge = sqrt(max(0.0, 1.0 - (r / radius) * (r / radius)));
  let offset = normal / vec2<f32>(C.aspect, 1.0)
    * bulge * P.refractionStrength * 0.035;
  let refracted = safeSample(uv - offset);
  let rim = exp(-abs(r - radius) * (90.0 / max(P.rimDefinition, 0.2)));
  let audioRim = A.bands.y + A.bands.z * 0.7 + A.bands.w * 0.35;
  let effect = mix(plain.rgb, refracted, inside * P.refractionMix)
    + C.color.rgb * rim * (0.08 + audioRim * 0.12);
  return finishEffect(plain, effect, P.lensMix);
}
