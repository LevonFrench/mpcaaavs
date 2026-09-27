struct DropRestParams {
  restMix : f32,
  blackout: f32,
  _pad0   : f32,
  _pad1   : f32,
};

@fragment
fn fs(@builtin(position) frag : vec4<f32>) -> @location(0) vec4<f32> {
  let uv = fragUV(frag);
  let plain = textureSampleLevel(src, samp, uv, 0.0);
  let effect = plain.rgb * (1.0 - clamp(P.blackout, 0.0, 1.0));
  return finishEffect(plain, effect, P.restMix);
}
