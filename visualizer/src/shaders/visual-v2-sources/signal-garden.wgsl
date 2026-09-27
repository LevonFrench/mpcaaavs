// SIGNAL GARDEN — a bounded stand of waveform-fed stems. All plants share a
// single rational sway phase so the subject reads as one organism.

struct Params {
  gardenGain : f32,
  gardenScale : f32,
  stemDensity : f32,
  branchDetail : f32,
  swayPeriodBars : f32,
  swaySpread : f32,
  gardenCenterX : f32,
  gardenCenterY : f32,
  stemThickness : f32,
  pad0 : f32,
  pad1 : f32,
  pad2 : f32,
};

@fragment
fn fs(@builtin(position) frag : vec4<f32>) -> @location(0) vec4<f32> {
  let q = v2SubjectPoint(frag, P.gardenCenterX, P.gardenCenterY);
  let phase = v2PhaseBars(P.swayPeriodBars);
  let mids = A.bands.z;
  let treble = A.bands.w + A.air * 0.65;
  let width = 1.02 * P.gardenScale;
  let baseY = -0.70;
  let count = 7.0 + floor(P.stemDensity * 8.0);
  let cell = floor((q.x / width * 0.5 + 0.5) * count);
  var garden = 0.0;
  for (var ox : i32 = -1; ox <= 1; ox = ox + 1) {
    let id = cell + f32(ox);
    let seed = v2Hash11(id);
    let x = ((id + 0.5) / count * 2.0 - 1.0) * width;
    let f = fract((id + 0.5) / count);
    let energy = sqrt(max(fftAt(f), 0.0));
    let top = baseY + 0.34 + energy * 0.75 + seed * 0.14;
    let sway = sin(v2PhaseRatio(phase, 1.0, 16.0) + seed * V2_TAU)
      * 0.035 * P.swaySpread;
    let stem = v2SegmentDistance(q, vec2<f32>(x, baseY), vec2<f32>(x + sway, top));
    let branchY = mix(baseY, top, 0.56 + seed * 0.18);
    let side = select(-1.0, 1.0, fract(id * 0.618) > 0.5);
    let branchReach = 0.065 + P.branchDetail * 0.055;
    let branch = v2SegmentDistance(
      q,
      vec2<f32>(x + sway * 0.55, branchY),
      vec2<f32>(
        x + side * (branchReach + energy * 0.10),
        branchY + branchReach + energy * 0.08,
      ),
    );
    garden = max(garden, v2LineAA(
      min(stem, branch),
      (0.0025 + energy * 0.003) * P.stemThickness,
    ));
  }
  let bounds = 1.0 - smoothstep(width - 0.03, width + 0.10, abs(q.x));
  let ink = garden * bounds * (0.34 + mids * 0.75 + treble * 0.46);
  let alpha = max(ink, 0.0) * P.gardenGain * C.opacity;
  return vec4<f32>(C.color.rgb * alpha, alpha);
}
