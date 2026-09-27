// MOIRE PORTAL — two line screens clipped to a tilted oval. Screen B follows
// an explicit 3/4 phase relation to screen A; the master turn is 1/32 of the
// declared source cycle.

struct Params {
  moireGain : f32,
  portalScale : f32,
  screenDensity : f32,
  screenDetune : f32,
  turnPeriodBars : f32,
  portalCenterX : f32,
  portalCenterY : f32,
  screenThickness : f32,
};

@fragment
fn fs(@builtin(position) frag : vec4<f32>) -> @location(0) vec4<f32> {
  let q = v2SubjectPoint(frag, P.portalCenterX, P.portalCenterY);
  let phase = v2PhaseBars(P.turnPeriodBars);
  let mids = A.bands.z;
  let treble = A.bands.w + A.air * 0.65;
  let turn = v2PhaseRatio(phase, 1.0, 32.0);
  let a = v2Rot2(0.31 + turn) * q;
  let b = v2Rot2(-0.37 + v2PhaseRatio(turn, 3.0, 4.0)) * q;
  let frequency = 15.0 + P.screenDensity * 28.0;
  let screenA = v2LineAA(
    abs(fract(a.x * frequency) - 0.5),
    0.052 * P.screenThickness,
  );
  let screenB = v2LineAA(
    abs(fract(b.x * frequency * (1.005 + P.screenDetune * 0.010)) - 0.5),
    0.052 * P.screenThickness,
  );
  let interference = screenA * screenB + max(screenA, screenB) * 0.13;
  let portal = v2EllipseMask(
    v2Rot2(-0.18) * q,
    vec2<f32>(0.54 * P.portalScale, 0.79 * P.portalScale),
  );
  let innerVoid = smoothstep(0.12, 0.28, length(q));
  let ink = interference * portal * innerVoid
    * (0.32 + mids * 0.92 + treble * 0.78);
  let alpha = max(ink, 0.0) * P.moireGain * C.opacity;
  return vec4<f32>(C.color.rgb * alpha, alpha);
}
