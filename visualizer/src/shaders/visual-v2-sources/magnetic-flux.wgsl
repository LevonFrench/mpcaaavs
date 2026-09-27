// MAGNETIC FLUX — two-pole scalar-field contours around one off-centre
// subject. Rotation and contour drift are rational divisions of one period.

struct Params {
  fluxGain : f32,
  fieldScale : f32,
  contourDensity : f32,
  poleSeparation : f32,
  rotationPeriodBars : f32,
  fieldCenterX : f32,
  fieldCenterY : f32,
  contourThickness : f32,
};

@fragment
fn fs(@builtin(position) frag : vec4<f32>) -> @location(0) vec4<f32> {
  let q = v2SubjectPoint(frag, P.fieldCenterX, P.fieldCenterY);
  let phase = v2PhaseBars(P.rotationPeriodBars);
  let bass = A.bands.x * 0.65 + A.bands.y;
  let treble = A.bands.w + A.air * 0.65;
  let axis = v2Rot2(v2PhaseRatio(phase, 1.0, 32.0))
    * vec2<f32>(0.24 * P.poleSeparation, 0.0);
  let qa = q - axis;
  let qb = q + axis;
  let ra = max(length(qa), 0.015);
  let rb = max(length(qb), 0.015);
  let potential = (v2Atan2(qa) - v2Atan2(qb)) / V2_TAU
    + log(ra / rb) * 0.17;
  let bands = abs(fract(potential * (5.0 + P.contourDensity * 11.0)
    + v2PhaseRatio(phase, 1.0, 128.0)) - 0.5);
  let flux = v2LineAA(bands, 0.025 * P.contourThickness);
  let poleA = v2LineAA(ra - 0.035, 0.006 * P.contourThickness);
  let poleB = v2LineAA(rb - 0.035, 0.006 * P.contourThickness);
  let envelope = v2EllipseMask(q, vec2<f32>(0.86 * P.fieldScale, 0.68 * P.fieldScale));
  let ink = (flux * 0.82 + poleA + poleB) * envelope
    * (0.48 + bass * 1.1 + treble * 0.35);
  let alpha = max(ink, 0.0) * P.fluxGain * C.opacity;
  return vec4<f32>(C.color.rgb * alpha, alpha);
}
