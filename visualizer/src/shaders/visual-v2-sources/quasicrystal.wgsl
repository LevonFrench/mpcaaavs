// QUASICRYSTAL — a bounded five-axis interference specimen. The drift period
// is explicit; every slower axis/translation term is a rational subdivision.

struct Params {
  crystalGain : f32,
  specimenScale : f32,
  axisDensity : f32,
  ridgeDetail : f32,
  driftPeriodBars : f32,
  specimenCenterX : f32,
  specimenCenterY : f32,
  ridgeThickness : f32,
  nodeBias : f32,
  pad0 : f32,
  pad1 : f32,
  pad2 : f32,
};

@fragment
fn fs(@builtin(position) frag : vec4<f32>) -> @location(0) vec4<f32> {
  let q = v2SubjectPoint(frag, P.specimenCenterX, P.specimenCenterY);
  let phase = v2PhaseBars(P.driftPeriodBars);
  let mids = A.bands.z;
  let treble = A.bands.w + A.air * 0.65;
  let z = q * (4.0 + P.axisDensity * 3.2) / P.specimenScale;
  var overlap = 0.0;
  var closest = 1.0;
  for (var i : i32 = 0; i < 5; i = i + 1) {
    let fi = f32(i);
    let axisAngle = fi * V2_TAU / 5.0
      + v2PhaseRatio(phase, 1.0, 16.0)
      + fi * v2PhaseRatio(phase, 1.0, 256.0);
    let dir = vec2<f32>(cos(axisAngle), sin(axisAngle));
    let d = abs(fract(dot(z, dir) + fi * 0.173
      + v2PhaseRatio(phase, 1.0, 128.0)
      + fi * v2PhaseRatio(phase, 1.0, 1024.0)) - 0.5);
    closest = min(closest, d);
    overlap = overlap + (1.0 - smoothstep(0.035, 0.11, d));
  }
  let nodes = smoothstep(
    mix(1.05, 1.65, P.nodeBias),
    mix(1.55, 2.25, P.nodeBias),
    overlap,
  );
  let wireWidth = (0.018 + P.ridgeDetail * 0.013) * P.ridgeThickness;
  let wires = v2LineAA(closest, wireWidth) * smoothstep(0.20, 1.15, overlap)
    * (0.38 + P.ridgeDetail * 0.18);
  let specimen = v2EllipseMask(q, vec2<f32>(0.72 * P.specimenScale, 0.55 * P.specimenScale));
  let quietCore = smoothstep(0.12, 0.28, length(q));
  let ink = (nodes + wires) * specimen * quietCore * (0.35 + mids * 1.4 + treble * 0.55);
  let alpha = max(ink, 0.0) * P.crystalGain * C.opacity;
  return vec4<f32>(C.color.rgb * alpha, alpha);
}
