// ECLIPSE CORONA — a black disk with a spectrum-fed practical corona. The
// angular spectrum scan is an explicit 1/64 division of the declared period.

struct Params {
  coronaGain : f32,
  diskScale : f32,
  rayDensity : f32,
  haloDetail : f32,
  scanPeriodBars : f32,
  coronaSpread : f32,
  diskCenterX : f32,
  diskCenterY : f32,
  rimThickness : f32,
  pad0 : f32,
  pad1 : f32,
  pad2 : f32,
};

@fragment
fn fs(@builtin(position) frag : vec4<f32>) -> @location(0) vec4<f32> {
  let q = v2SubjectPoint(frag, P.diskCenterX, P.diskCenterY);
  let phase = v2PhaseBars(P.scanPeriodBars);
  let treble = A.bands.w + A.air * 0.65;
  let r = length(q);
  let a = v2Atan2(q);
  let f = fract(a / V2_TAU + 0.5 + v2CycleRatio(phase, 1.0, 64.0));
  let spectral = sqrt(max(fftAt(f), 0.0));
  let disk = 0.30 * P.diskScale;
  let rim = v2LineAA(r - disk, 0.0035 * P.rimThickness) * (0.62 + spectral * 1.5);
  let rayCell = abs(fract(f * (28.0 + P.rayDensity * 56.0)) - 0.5);
  let ray = v2LineAA(rayCell, 0.055 * P.rimThickness);
  let coronaExtent = disk + 0.055 + spectral * (0.11 + P.coronaSpread * 0.08);
  let radial = smoothstep(disk - 0.004, disk + 0.008, r)
    * (1.0 - smoothstep(coronaExtent, coronaExtent + 0.045, r));
  let halo = exp(-abs(r - disk) * (30.0 / max(P.haloDetail, 0.25))) * 0.22;
  let ink = rim + ray * radial * (0.18 + treble * 0.75) + halo;
  let alpha = max(ink, 0.0) * P.coronaGain * C.opacity;
  return vec4<f32>(C.color.rgb * alpha, alpha);
}
