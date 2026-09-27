// SPECTRAL LOOM — stereo spectrum becomes a bounded woven plane. Pan offsets
// the warp, waveform bends the weft, and motion follows one declared period.

struct Params {
  loomGain : f32,
  loomScale : f32,
  warpDensity : f32,
  weftDensity : f32,
  weavePeriodBars : f32,
  stereoSpread : f32,
  loomCenterX : f32,
  loomCenterY : f32,
  threadThickness : f32,
  pad0 : f32,
  pad1 : f32,
  pad2 : f32,
};

@fragment
fn fs(@builtin(position) frag : vec4<f32>) -> @location(0) vec4<f32> {
  let q = v2SubjectPoint(frag, P.loomCenterX, P.loomCenterY);
  let phase = v2PhaseBars(P.weavePeriodBars);
  let treble = A.bands.w + A.air * 0.65;
  let local = q / vec2<f32>(0.86 * P.loomScale, 0.58 * P.loomScale);
  let inside = v2EllipseMask(q, vec2<f32>(0.90 * P.loomScale, 0.62 * P.loomScale));
  let fx = clamp(local.x * 0.5 + 0.5, 0.0, 1.0);
  let fy = clamp(local.y * 0.5 + 0.5, 0.0, 1.0);
  let eX = sqrt(max(fftAt(fx), 0.0));
  let eY = sqrt(max(fftAt(fy), 0.0));
  let panShift = panAt(fx) * 0.16 * P.stereoSpread;
  let warpX = local.x + panShift
    + sin(local.y * 4.0 + v2PhaseRatio(phase, 1.0, 8.0)) * eY * 0.08;
  let warpY = local.y + waveAt(fx).x * 0.12 * P.stereoSpread;
  let warpCount = 18.0 + floor(P.warpDensity * 20.0);
  let weftCount = 12.0 + floor(P.weftDensity * 18.0);
  let warp = v2LineAA(abs(fract(warpX * warpCount) - 0.5), 0.055 * P.threadThickness)
    * (0.25 + eX * 1.4);
  let weft = v2LineAA(abs(fract(warpY * weftCount) - 0.5), 0.055 * P.threadThickness)
    * (0.22 + eY * 1.15);
  let overUnder = step(0.5, fract(floor(warpX * warpCount) + floor(warpY * weftCount)));
  let ink = mix(warp, weft, overUnder) * inside
    * (0.48 + A.width * 0.8 + treble * 0.35);
  let alpha = max(ink, 0.0) * P.loomGain * C.opacity;
  return vec4<f32>(C.color.rgb * alpha, alpha);
}
