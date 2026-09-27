struct RankStretchParams {
  rankMix          : f32,
  extremaMix       : f32,
  searchRadiusPx   : f32,
  sampleSpread     : f32,
  contrastThreshold: f32,
  stripeWidthPx    : f32,
  axisRadians      : f32,
  _pad0            : f32,
};

@fragment
fn fs(@builtin(position) frag : vec4<f32>) -> @location(0) vec4<f32> {
  let uv = fragUV(frag);
  let plain = textureSampleLevel(src, samp, uv, 0.0);
  let px = 1.0 / C.resolution;
  let dir = normalize(rot2(P.axisRadians) * vec2<f32>(1.0, 0.0));
  var hi = plain.rgb;
  var lo = plain.rgb;
  var hiLum = luminance(hi);
  var loLum = hiLum;
  for (var i : i32 = -3; i <= 3; i = i + 1) {
    let distancePx = f32(i) * P.searchRadiusPx * (2.0 + P.sampleSpread * 3.0);
    let sampleRgb = safeSample(uv + dir * px * distancePx);
    let sampleLum = luminance(sampleRgb);
    if (sampleLum > hiLum) {
      hi = sampleRgb;
      hiLum = sampleLum;
    }
    if (sampleLum < loLum) {
      lo = sampleRgb;
      loLum = sampleLum;
    }
  }
  let stripe = step(0.5, fract(dot(uv * C.resolution, dir) / P.stripeWidthPx));
  let ranked = mix(lo, hi, stripe);
  let gateLow = P.contrastThreshold * 0.45;
  let gateHigh = max(P.contrastThreshold, gateLow + 0.0001);
  let gate = smoothstep(gateLow, gateHigh, abs(hiLum - loLum));
  let effect = mix(plain.rgb, ranked, gate * P.extremaMix);
  return finishEffect(plain, effect, P.rankMix);
}
