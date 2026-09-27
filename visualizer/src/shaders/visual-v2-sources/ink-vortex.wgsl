// INK VORTEX — logarithmic streamlines around a displaced void. Evolution and
// eddy phases are explicit 1/32 and 1/16 divisions of the declared period.

struct Params {
  inkGain : f32,
  vortexScale : f32,
  filamentDensity : f32,
  curlDetail : f32,
  evolutionPeriodBars : f32,
  vortexCenterX : f32,
  vortexCenterY : f32,
  filamentThickness : f32,
};

@fragment
fn fs(@builtin(position) frag : vec4<f32>) -> @location(0) vec4<f32> {
  let q = v2SubjectPoint(frag, P.vortexCenterX, P.vortexCenterY);
  let phase = v2PhaseBars(P.evolutionPeriodBars);
  let bass = A.bands.x * 0.65 + A.bands.y;
  let mids = A.bands.z;
  let r = max(length(q), 0.008);
  let a = v2Atan2(q);
  let evolution = v2PhaseRatio(phase, 1.0, 32.0);
  let flow = a / V2_TAU + log(r) * (0.42 + P.curlDetail * 0.17)
    + sin(a * 3.0 + log(r) * 4.2 + evolution) * 0.085
    + sin(q.x * 2.3 - q.y * 1.7) * 0.035
    - v2CycleRatio(phase, 1.0, 32.0);
  let bands = abs(fract(flow * (6.0 + P.filamentDensity * 8.0)) - 0.5);
  let filament = v2LineAA(bands, 0.035 * P.filamentThickness);
  let eddy = sin(
    (a + log(r) * 2.1) * 3.0 + v2PhaseRatio(phase, 1.0, 16.0),
  ) * 0.5 + 0.5;
  let ringMask = smoothstep(0.12, 0.25, r)
    * (1.0 - smoothstep(0.72 * P.vortexScale, 1.08 * P.vortexScale, r));
  let ink = filament * ringMask
    * (0.12 + eddy * 0.22 + bass * 0.32 + mids * 0.24);
  let alpha = max(ink, 0.0) * P.inkGain * C.opacity;
  return vec4<f32>(C.color.rgb * alpha, alpha);
}
