// Mirrored butterfly spectrum. Plan §8.2.
//
// Look: GRID (art-direction §1.2) — it is a spectrum, it is horizon-shaped, and
// it sits on the same furniture as `src-spectrum.wgsl`. It is deliberately NOT a
// mode of that shader: stacking a second composition into one pass is how a
// source stops being composable, and the two want different params.
//
// The composition, and why each half of it is the way it is:
//
//   - LOW FREQUENCIES AT THE CENTRE LINE, mirrored outward to both edges. The
//     bass is where the eye lands, and putting it in the middle makes the shape
//     a body with wings rather than a ramp. The axis is logarithmic in both
//     directions, so an octave is a fixed width and the fold is symmetric.
//   - THE UPPER WING IS LEFT, THE LOWER WING IS RIGHT. A mirror about the
//     horizontal is free symmetry and free symmetry is decoration; driving the
//     two halves from the two CHANNELS makes the asymmetry mean something. A
//     mono mix draws a perfectly symmetric moth, wide material breathes, and a
//     hard-panned hat lifts one wing on its own. `stereo` at 0 restores the
//     plain mirror for material that has no width worth showing.
//
// Antialiasing: every edge is an analytic distance in y, and each wing's own
// `fwidth` is taken on `y - h` rather than on `y` — so the contour includes the
// slope of the spectrum and stays crisp where the curve is steep, which near a
// bass transient is everywhere.
//
// The one honest wart: `d` folds at the centre line (`abs(uv.x - 0.5)`), and a
// fold has no well-defined derivative on the quad that straddles it. The field
// is CONTINUOUS across the fold (both sides evaluate the same frequency there),
// so the artifact is at most one column of slightly wide AA, not the blurred
// seam that folding a TEXTURE coordinate produces — there is no sampler here to
// pick the wrong mip.

struct Params {
  gain      : f32,
  gamma     : f32,   // < 1 lifts the quiet end. Magnitude is not perceptual.
  fLo       : f32,   // normalised frequency at the centre line
  fHi       : f32,   // normalised frequency at the wing tips
  span      : f32,   // full-scale wing height, 0..1 of the frame
  spread    : f32,   // fraction of the frame width the wings occupy
  centreY   : f32,   // 0..1 from the bottom
  capHalf   : f32,   // half thickness of the wing contour at the tips
  bodyLevel : f32,
  capLevel  : f32,
  stereo    : f32,   // 0 = mirror the mono sum, 1 = L above / R below
  weightVar : f32,   // how much heavier the contour is at the body. §4.4.
};

/** Normalised frequency at distance d from the centre line. Geometric. */
fn logFreq(d : f32) -> f32 {
  return P.fLo * pow(max(P.fHi / P.fLo, 1.0), clamp(d, 0.0, 1.0));
}

/** Magnitude -> wing height. Gamma first, then the layer's span. */
fn shape(m : f32) -> f32 {
  return clamp(pow(max(m * P.gain, 0.0), P.gamma), 0.0, 1.0) * P.span;
}

@vertex
fn vs(@builtin(vertex_index) vi : u32) -> @builtin(position) vec4<f32> {
  return fullscreenTriangle(vi);
}

@fragment
fn fs(@builtin(position) frag : vec4<f32>) -> @location(0) vec4<f32> {
  let uv = fragUV(frag);
  // Bottom-origin y, measured from the layer's centre line. Positive is the
  // upper wing.
  let y = (1.0 - uv.y) - P.centreY;
  // Distance from the centre line, 0 at the body and 1 at the wing tip.
  //
  // `dRaw` is kept unclamped so the wing can actually END at `spread`. Clamping
  // alone maps every column past the tip to fHi, which does not stop the wing —
  // it draws the top bin's magnitude flat from the tip to the frame edge. At the
  // default 0.92 that is a small ledge; at `spread` 0.3 it is a horizontal slab
  // across the outer 70% of the frame, which is not what the param says it does.
  let dRaw = abs(uv.x - 0.5) * 2.0 / max(P.spread, 1e-3);
  let d = clamp(dRaw, 0.0, 1.0);
  // Taken here, in uniform control flow, with the rest of the derivatives.
  let eSpan = max(fwidth(dRaw), 1e-5);
  let within = 1.0 - smoothstep(1.0 - eSpan, 1.0 + eSpan, dRaw);

  let f = logFreq(d);
  let s = fftStereoAt(f);
  let mono = (s.x + s.y) * 0.5;
  let ps = peakAt(f);

  // The channel split is a MIX towards mono, not a switch: a preset can dial the
  // stereo asymmetry down without the shape changing under it.
  let hUp = shape(mix(mono, s.x, P.stereo));
  let hDn = shape(mix(mono, s.y, P.stereo));
  // One peak height for both wings: `audioPeak` is held per bin on the mono sum,
  // so a per-channel peak would be a number the analysis does not have.
  let pk = shape(ps);

  let dU = y - hUp;
  let dD = -y - hDn;
  let eU = max(fwidth(dU), 1e-5);
  let eD = max(fwidth(dD), 1e-5);
  let ey = max(fwidth(y), 1e-5);

  // Each wing is bounded by the centre line on one side and by its own height on
  // the other. SUMMED rather than maxed: at the centre line both masks read 0.5
  // and a max would draw a dark seam straight through the body of the moth,
  // which is the one place the shape must be solid.
  let upIn = smoothstep(-ey, ey, y);
  let dnIn = 1.0 - upIn;
  let bodyUp = upIn * (1.0 - smoothstep(-eU, eU, dU));
  let bodyDn = dnIn * (1.0 - smoothstep(-eD, eD, dD));
  let body = clamp(bodyUp + bodyDn, 0.0, 1.0) * within;

  // Contour weight varies along the wing — heavy at the body, fine at the tips.
  // Uniform stroke reads flat and machine-drawn (art-direction §4.4), and tying
  // the variation to frequency puts the weight where the energy is.
  let cw = P.capHalf * (1.0 + P.weightVar * (1.0 - d));
  let cUp = 1.0 - smoothstep(cw - eU, cw + eU, abs(dU));
  let cDn = 1.0 - smoothstep(cw - eD, cw + eD, abs(dD));

  // Peak-hold sits above each wing and is deliberately dimmer, so the eye reads
  // one shape with a marker rather than two competing outlines (§4.2).
  let qU = y - pk;
  let qD = -y - pk;
  let eQU = max(fwidth(qU), 1e-5);
  let eQD = max(fwidth(qD), 1e-5);
  let pkUp = (1.0 - smoothstep(cw - eQU, cw + eQU, abs(qU))) * upIn;
  let pkDn = (1.0 - smoothstep(cw - eQD, cw + eQD, abs(qD))) * dnIn;

  let cap = max(max(cUp, cDn), max(pkUp, pkDn) * 0.55) * within;

  // Value range beats hue range (§2.3): the fill darkens towards the centre line
  // so the wings read as lit surfaces with a bright edge rather than as two
  // slabs. One hue throughout — colouring by frequency is the rainbow
  // anti-pattern wearing a hat (§2.2, §5).
  let h = max(select(hDn, hUp, y >= 0.0), 1e-4);
  let base = 0.16 + 0.84 * clamp(abs(y) / h, 0.0, 1.0);
  let level = body * P.bodyLevel * base + cap * P.capLevel;
  let a = clamp(body + cap, 0.0, 1.0) * C.opacity;
  return vec4<f32>(C.color.rgb * level * C.opacity, a);
}
