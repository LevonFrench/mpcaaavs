// SPECTRAL CATHEDRAL — perspective arches with a fixed horizon. Forward travel
// is an explicit 1/4 cycle relation to the declared architectural period.

struct Params {
  cathedralGain : f32,
  frameScale : f32,
  bayDensity : f32,
  columnDetail : f32,
  travelPeriodBars : f32,
  horizonCenterX : f32,
  horizonCenterY : f32,
  architectureThickness : f32,
};

@fragment
fn fs(@builtin(position) frag : vec4<f32>) -> @location(0) vec4<f32> {
  let q = v2SubjectPoint(frag, P.horizonCenterX, P.horizonCenterY);
  let phase = v2PhaseBars(P.travelPeriodBars);
  let bass = A.bands.x * 0.65 + A.bands.y;
  let horizon = -0.22;
  let z = clamp((q.y - horizon + 0.05) * 0.72, 0.03, 1.2);
  let worldX = q.x / z;
  let depth = 1.0 / z + v2CycleRatio(phase, 1.0, 4.0);
  let bay = fract(depth * (0.48 + P.bayDensity * 0.16));
  let archRadius = 0.46 + bay * 0.38;
  let archY = q.y - horizon - 0.17;
  let archD = abs(length(vec2<f32>(
    q.x / max(archRadius, 0.1),
    archY / max(archRadius * 0.92, 0.1),
  )) - 1.0);
  let upperHalf = smoothstep(horizon - 0.01, horizon + 0.07, q.y);
  let arches = v2LineAA(archD, 0.014 * P.architectureThickness) * upperHalf;
  let columns = v2LineAA(
    abs(fract(worldX * (1.6 + P.columnDetail * 0.55)) - 0.5),
    0.035 * P.architectureThickness,
  ) * smoothstep(horizon - 0.04, horizon + 0.04, q.y);
  let aisle = (1.0 - smoothstep(0.12, 0.42, abs(q.x)))
    * smoothstep(horizon - 0.05, horizon + 0.03, q.y) * 0.16;
  let f = clamp(abs(worldX) * 0.24, 0.0, 1.0);
  let spectral = sqrt(max(fftAt(f), 0.0));
  let frameMask = v2EllipseMask(
    q - vec2<f32>(0.0, 0.10),
    vec2<f32>(1.08 * P.frameScale, 0.92 * P.frameScale),
  );
  let ink = (max(arches, columns) + aisle) * frameMask
    * (0.42 + spectral * 1.25 + bass * 0.35);
  let alpha = max(ink, 0.0) * P.cathedralGain * C.opacity;
  return vec4<f32>(C.color.rgb * alpha, alpha);
}
