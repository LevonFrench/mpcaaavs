// HARMONIC KNOT — a projected (2,3) torus knot. Its two camera axes use
// explicit 1/32 and 1/64 divisions of the declared camera period.

struct Params {
  knotGain : f32,
  knotScale : f32,
  resonanceDetail : f32,
  tubeSpread : f32,
  cameraPeriodBars : f32,
  knotCenterX : f32,
  knotCenterY : f32,
  tubeThickness : f32,
};

fn knotPoint(t : f32, phase : f32, bass : f32) -> vec3<f32> {
  let major = 0.31 * P.knotScale;
  let minor = (0.072 + P.tubeSpread * 0.040 + bass * 0.032) * P.knotScale;
  let ring = major + minor * cos(3.0 * t);
  var v = vec3<f32>(ring * cos(2.0 * t), ring * sin(2.0 * t), minor * sin(3.0 * t));
  let tiltX = 0.72 + v2PhaseRatio(phase, 1.0, 32.0);
  let cx = cos(tiltX);
  let sx = sin(tiltX);
  v = vec3<f32>(v.x, v.y * cx - v.z * sx, v.y * sx + v.z * cx);
  let tiltY = -0.44 + v2PhaseRatio(phase, 1.0, 64.0);
  let cy = cos(tiltY);
  let sy = sin(tiltY);
  v = vec3<f32>(v.x * cy + v.z * sy, v.y, -v.x * sy + v.z * cy);
  let perspective = 1.0 / max(0.72, 1.0 - v.z * 0.72);
  return vec3<f32>(v.xy * perspective, v.z);
}

@fragment
fn fs(@builtin(position) frag : vec4<f32>) -> @location(0) vec4<f32> {
  let q = v2SubjectPoint(frag, P.knotCenterX, P.knotCenterY);
  let phase = v2PhaseBars(P.cameraPeriodBars);
  let bass = A.bands.x * 0.65 + A.bands.y;
  let mids = A.bands.z;
  let treble = A.bands.w + A.air * 0.65;
  var previous = knotPoint(0.0, phase, bass);
  var nearest = 8.0;
  var nearestDepth = 0.0;
  for (var i : i32 = 1; i <= 64; i = i + 1) {
    let current = knotPoint(f32(i) / 64.0 * V2_TAU, phase, bass);
    let d = v2SegmentDistance(q, previous.xy, current.xy);
    if (d < nearest) {
      nearest = d;
      nearestDepth = (previous.z + current.z) * 0.5;
    }
    previous = current;
  }
  let depthWeight = 0.54 + smoothstep(-0.16, 0.16, nearestDepth) * 0.56;
  let tubeWidth = (0.0035 + 0.0022 * P.tubeThickness) * (1.0 + treble * 0.22);
  let tube = v2LineAA(nearest, tubeWidth);
  let resonance = v2LineAA(
    nearest - (0.006 + P.resonanceDetail * 0.003),
    tubeWidth * 0.38,
  ) * (0.035 + P.resonanceDetail * 0.045);
  let ink = (tube + resonance) * depthWeight * (0.48 + bass * 0.7 + mids * 0.85);
  let alpha = max(ink, 0.0) * P.knotGain * C.opacity;
  return vec4<f32>(C.color.rgb * alpha, alpha);
}
