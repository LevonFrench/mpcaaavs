// PHOSPHOR ORBIT — a closed cathode trace whose radius is bent by waveform
// samples. The orbit cycle is the declared period; scan/after-motion ratios are
// written as rational divisions of that cycle.

struct Params {
  orbitGain : f32,
  orbitScale : f32,
  harmonicDetail : f32,
  waveformBend : f32,
  orbitPeriodBars : f32,
  orbitCenterX : f32,
  orbitCenterY : f32,
  traceThickness : f32,
};

const ORBIT_SEAM_FRACTION : f32 = 1.0 / 32.0;

@fragment
fn fs(@builtin(position) frag : vec4<f32>) -> @location(0) vec4<f32> {
  let q = v2SubjectPoint(frag, P.orbitCenterX, P.orbitCenterY);
  let phase = v2PhaseBars(P.orbitPeriodBars);
  let treble = A.bands.w + A.air * 0.65;
  let r = length(q);
  let a = v2Atan2(q);
  let t = fract(a / V2_TAU + 0.5 + v2CycleRatio(phase, 1.0, 32.0));
  // waveAt is a finite, non-periodic analysis buffer. Mapping its unmatched
  // endpoints directly around a closed polar curve creates a radial scar.
  // This C1 window returns both displacement channels and their endpoint slope
  // to zero before the wrap while leaving 15/16 of the trace unmodified.
  let seamWindow = smoothstep(0.0, ORBIT_SEAM_FRACTION, t)
    * (1.0 - smoothstep(1.0 - ORBIT_SEAM_FRACTION, 1.0, t));
  let wave = waveAt(t) * seamWindow;
  let harmonicOrder = 3.0 + floor(P.harmonicDetail * 2.0);
  let harmonic = sin(a * harmonicOrder + phase) * 0.052
    + sin(a * 2.0 - v2PhaseRatio(phase, 3.0, 8.0)) * 0.022;
  let orbitRadius = (0.30 + harmonic + wave.x * 0.055 * P.waveformBend) * P.orbitScale;
  let width = (0.0015 + 0.0017 * P.traceThickness) * (1.0 + treble * 0.35);
  let trace = v2LineAA(r - orbitRadius, width);
  let afterglow = v2LineAA(r - orbitRadius - wave.y * 0.012, width * 2.4) * 0.16;
  let aperture = 1.0 - smoothstep(0.74 * P.orbitScale, 0.96 * P.orbitScale, r);
  let ink = (trace + afterglow) * aperture * (0.58 + A.level * 1.25 + A.crest * 0.08);
  let alpha = max(ink, 0.0) * P.orbitGain * C.opacity;
  return vec4<f32>(C.color.rgb * alpha, alpha);
}
