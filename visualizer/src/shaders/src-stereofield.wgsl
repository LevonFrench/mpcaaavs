// Stereo field scope: every frequency drawn at its OWN pan position. Plan §6, §8.2.
//
// Look: LAB (art-direction §1.1) — this is an instrument, not decoration. Thin
// bright filament on near-black, no fill worth the name, and it reads as
// measurement. It is the display a mastering engineer stares at for hours, and
// the reason it survives that is that it is honest: nothing here is an effect.
//
// x = pan, y = log frequency, brightness = magnitude.
//
// `panAt(f)` is `(L-R)/(L+R)` per BIN — the one piece of analysis in the project
// that nothing else consumes yet. A broadband pan number says "the mix leans
// left"; a per-bin one says "the bass is centred, the pad is wide and the hat is
// 70% right", which is a completely different picture and is the whole point of
// having done the stereo work in Phase 0.
//
// ---------------------------------------------------------------------------
// Why a filament and not a cloud of dots
//
// The obvious rendering is one dot per bin. 256 gaussian dots average into fog —
// the same lesson the attractor learned at 24k points, where drawing each step
// as a SEGMENT rather than a point was most of the visual quality in it. Here
// the continuum is already there: pan is a function of frequency, and frequency
// is the vertical axis, so the bins form a CURVE x(y). Drawing it as a
// continuous stroke resolves the structure that dots bury.
//
// The stroke's WIDTH carries magnitude (art-direction §4.4). A quiet bin is a
// hairline and a loud one swells, so level is read as weight rather than as
// another brightness ramp, and the two loud bands in a mix become the two things
// the eye lands on without any hue variety at all.
//
// AA: `fwidth` is taken on the signed horizontal distance to the curve, not on
// `uv.x` — so it includes the curve's own slope. Where a band's pan swings hard
// across a narrow frequency range the stroke is nearly horizontal, and an edge
// antialiased with `fwidth(uv.x)` there goes visibly stepped.
// ---------------------------------------------------------------------------

struct Params {
  gain      : f32,
  gamma     : f32,   // < 1 lifts the quiet end. Magnitude is not perceptual.
  fLo       : f32,   // normalised frequency at the bottom of the frame
  fHi       : f32,   // normalised frequency at the top
  spread    : f32,   // fraction of the frame width a full L/R pan reaches
  halfWidth : f32,   // hairline half-width, uv units, at zero magnitude
  widthVar  : f32,   // how much magnitude swells the stroke. §4.4.
  bodyLevel : f32,
  fillLevel : f32,   // the lean bar from the mono axis out to the curve
  axisLevel : f32,   // centre and hard-L/R guides
  peakLevel : f32,   // peak-hold ghost around the stroke
  gate      : f32,   // magnitude below which a bin draws nothing
};

/** Normalised frequency at vertical position t (0 at the bottom). Geometric. */
fn logFreq(t : f32) -> f32 {
  return P.fLo * pow(max(P.fHi / P.fLo, 1.0), clamp(t, 0.0, 1.0));
}

/** Magnitude -> 0..1 weight. Gamma only; this axis has no height to scale into. */
fn shape(m : f32) -> f32 {
  return clamp(pow(max(m * P.gain, 0.0), P.gamma), 0.0, 1.0);
}

@vertex
fn vs(@builtin(vertex_index) vi : u32) -> @builtin(position) vec4<f32> {
  return fullscreenTriangle(vi);
}

@fragment
fn fs(@builtin(position) frag : vec4<f32>) -> @location(0) vec4<f32> {
  let uv = fragUV(frag);
  // Bass at the bottom. The alternative reads as a waterfall running the wrong
  // way, because every other spectrum display in the project puts it low.
  let t = 1.0 - uv.y;
  let f = logFreq(t);

  let m = shape(fftAt(f));
  let pk = shape(peakAt(f));
  // Plan §6, and the only consumer of this buffer in the project.
  let pan = clamp(panAt(f), -1.0, 1.0);

  // Half a frame of travel is a full pan, scaled by `spread`. Beyond that the
  // axis stops being readable as a pan axis at all.
  let cx = 0.5 + pan * 0.5 * clamp(P.spread, 0.0, 1.0);
  let dx = uv.x - cx;
  // Includes the slope of cx(t) — see the header. Uniform control flow: nothing
  // below branches before this is taken.
  let e = max(fwidth(dx), 1e-5);
  let ex = max(fwidth(uv.x), 1e-5);

  // A silent bin has a pan of whatever 0/0 resolved to, and drawing it puts a
  // meaningless line through the quiet half of the frame. The gate is soft so
  // the filament fades in rather than switching on.
  let live = smoothstep(P.gate, P.gate + 0.06, m);

  // Weight carries magnitude. This is the layer's one non-negotiable idea.
  let hw = max(P.halfWidth * (1.0 + P.widthVar * m), 1e-5);
  let stroke = (1.0 - smoothstep(hw - e, hw + e, abs(dx))) * live;

  // Peak-hold as a ghost OUTSIDE the stroke rather than as a second line: the
  // recent maximum width of the same filament, so it reads as a decay envelope
  // around the live one instead of competing with it (§4.2).
  //
  // Gated on the PEAK, not on the live magnitude and not at all. Ungated, the
  // ghost defeats the gate outright: `hwPk >= hw` by construction, so a bin
  // below the gate contributes `coverage(hw) - 0` and every silent bin draws a
  // full-strength hairline at whatever 0/0 resolved its pan to — which is
  // exactly the dead line down the middle of the frame this layer exists to
  // prove is NOT there. The peak is the right gate because the ghost's whole
  // job is to show where a band was a moment ago, and `pk >= m` keeps it a
  // superset of the stroke so the subtraction below never goes negative.
  let livePk = smoothstep(P.gate, P.gate + 0.06, pk);
  let hwPk = max(P.halfWidth * (1.0 + P.widthVar * pk), hw);
  let ghost = max((1.0 - smoothstep(hwPk - e, hwPk + e, abs(dx))) * livePk - stroke, 0.0);

  // The lean: a dim bar from the mono axis out to the curve, so a band that sits
  // off-centre reads as a displacement and not just as a wiggle. Kept low —
  // this look is 80% negative space (§1.1) and the fill is the first thing that
  // would eat it.
  let a0 = min(0.5, cx);
  let b0 = max(0.5, cx);
  let fill = smoothstep(a0 - ex, a0 + ex, uv.x)
           * (1.0 - smoothstep(b0 - ex, b0 + ex, uv.x)) * live * m;

  // Guides at mono and at hard L/R. Furniture, drawn at a level that admits it.
  let gw = ex * 1.5;
  let edge = 0.5 * clamp(P.spread, 0.0, 1.0);
  var axis = 1.0 - smoothstep(gw, gw * 2.0, abs(uv.x - 0.5));
  axis = max(axis, (1.0 - smoothstep(gw, gw * 2.0, abs(abs(uv.x - 0.5) - edge))) * 0.6);

  // One hue — the layer's palette slot — with everything expressed as value
  // (§2.3). The stroke brightens with magnitude on top of thickening, which is
  // what makes the loud band the focal element without any second colour.
  let level = stroke * P.bodyLevel * (0.35 + 0.65 * m)
            + ghost * P.peakLevel
            + fill * P.fillLevel
            + axis * P.axisLevel;
  let a = clamp(stroke + ghost * 0.5 + fill * 0.5 + axis * 0.5, 0.0, 1.0) * C.opacity;
  return vec4<f32>(C.color.rgb * level * C.opacity, a);
}
