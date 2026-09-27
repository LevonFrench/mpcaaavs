// Radial bars: a log-frequency spectrum wrapped around a circle. Plan §8.2.
//
// Look: GRID (art-direction §1.2) — a ring of neon bars is that look's second
// piece of native furniture after the flat bar chart, and it sits over a horizon
// without competing with it. Rave will happily borrow it; lab will not.
//
// Two things decide whether this reads as a designed object or as a clock face:
//
//   - THE INNER RADIUS IS REAL. Bars that start at r = 0 all collide at the
//     origin: 64 wedges meeting at a point is a solid disc with a fringe, and
//     the low bars — the ones the eye is looking for — are the ones destroyed.
//     `innerRadius` is a hard floor and the bar grows OUTWARD from it.
//   - THE AXIS IS LOGARITHMIC. Angle is a frequency RATIO, so an octave is a
//     fixed number of degrees. On a linear axis the bottom octave gets one
//     wedge of the 360 and the top gets most of the ring (plan §6).
//
// The sweep is deliberately under a full turn by default. A closed ring puts the
// top of the axis immediately next to the bottom of it, and that seam — a hat
// bar hard against a kick bar — reads as a glitch. Leaving a gap makes the same
// discontinuity read as the start and end of a scale, which is what it is.
//
// ---------------------------------------------------------------------------
// Antialiasing without touching atan2's derivative
//
// The obvious polar AA — smoothstep on an ANGLE with `fwidth(angle)` — has a
// discontinuity wherever atan2 wraps, and the seam it draws is a full-radius
// blurred spoke. Everything here is measured as an ARC LENGTH instead
// (`|dtheta| * r`, a real distance in unit space) and antialiased against ONE
// epsilon: the size of a pixel in unit space, which is constant across the frame
// because unit space is an affine function of the fragment coordinate. No
// derivative of a wrapped quantity is ever taken.
// ---------------------------------------------------------------------------

struct Params {
  bars      : f32,
  gain      : f32,
  gamma     : f32,   // < 1 lifts the quiet end. Magnitude is not perceptual.
  fLo       : f32,   // normalised frequency at the start of the sweep
  fHi       : f32,   // normalised frequency at the end of it
  gap       : f32,   // 0..1 fraction of a cell left empty
  inner     : f32,   // inner radius, unit space. See the header — not optional.
  reach     : f32,   // radial length of a full-scale bar, unit space
  centreX   : f32,   // ring centre, unit space (x spans +/-aspect)
  centreY   : f32,
  capHalf   : f32,   // half thickness of the peak-hold cap, unit space
  bodyLevel : f32,
  capLevel  : f32,
  weightVar : f32,   // 0 = every bar the same width. Art-direction §4.4.
  sweep     : f32,   // turns covered by the axis. 1 closes the ring.
  spin      : f32,   // radians. Driven from a clock division on the CPU.
};

const TAU : f32 = 6.28318530717958647;
const PI  : f32 = 3.14159265358979323;

/** Signed angle difference in (-PI, PI]. The one place a wrap happens, and it is exact. */
fn wrapPi(a : f32) -> f32 {
  return a - TAU * floor((a + PI) / TAU);
}

/** Normalised frequency at axis position u. Geometric, so an octave is a fixed arc. */
fn logFreq(u : f32) -> f32 {
  return P.fLo * pow(max(P.fHi / P.fLo, 1.0), clamp(u, 0.0, 1.0));
}

/** Magnitude -> radial length. Gamma first, then the layer's reach. */
fn shape(m : f32) -> f32 {
  return clamp(pow(max(m * P.gain, 0.0), P.gamma), 0.0, 1.0) * P.reach;
}

/**
 * Cell magnitude and peak, taken as the MAX across the cell rather than at its
 * centre. A cell near the top of the axis spans dozens of bins; sampling one
 * point in it drops narrow spikes at random and the bar flickers on content that
 * is perfectly steady. `audio.ts` resamples by max for the same reason.
 */
fn cellMag(i : f32, n : f32) -> vec2<f32> {
  var m = 0.0;
  var pk = 0.0;
  for (var k = 0; k < 4; k = k + 1) {
    let f = logFreq((i + (f32(k) + 0.5) * 0.25) / n);
    m = max(m, fftAt(f));
    pk = max(pk, peakAt(f));
  }
  return vec2<f32>(m, pk);
}

@vertex
fn vs(@builtin(vertex_index) vi : u32) -> @builtin(position) vec4<f32> {
  return fullscreenTriangle(vi);
}

@fragment
fn fs(@builtin(position) frag : vec4<f32>) -> @location(0) vec4<f32> {
  let uv = fragUV(frag);
  // Unit space: y in [-1, 1], x in [-aspect, aspect], y up. Circles stay round
  // at any aspect and every length below is comparable to every other.
  let p = vec2<f32>((uv.x * 2.0 - 1.0) * C.aspect, 1.0 - uv.y * 2.0);
  let q = p - vec2<f32>(P.centreX, P.centreY);

  // One pixel, in unit space. Taken here in uniform control flow — inside the
  // cell loop it would sit under a branch that depends on the fragment's own
  // cell index, and a derivative under non-uniform control flow is undefined.
  // It is also constant across the frame (unit space is affine in `frag`), so
  // this is a shared epsilon rather than a per-fragment estimate.
  let e = max(max(fwidth(p.x), fwidth(p.y)), 1e-5);

  let r = length(q);
  let ang = atan2(q.y, q.x);

  let n = max(floor(P.bars), 1.0);
  let sweep = max(P.sweep, 1e-3);
  // Position along the axis, 0..1 across the sweep. Fragments in the gap land
  // above 1 and every cell rejects them.
  let u = fract((ang - P.spin) / TAU) / sweep;
  let i0 = floor(u * n);

  var body = 0.0;
  var cap = 0.0;
  var lit = 0.0;   // radial length of whatever is under this fragment, for shading

  // Neighbours as well as the nominal cell: a fragment one pixel inside cell i
  // still has to be antialiased against cell i+1's edge.
  for (var k : i32 = -1; k <= 1; k = k + 1) {
    let i = i0 + f32(k);
    let inRange = step(0.0, i) * step(i, n - 1.0);
    let cu = (i + 0.5) / n;

    // Vary the weight along the axis: heavy at the bottom, light at the top.
    // Uniform stroke width across a frame reads flat and machine-drawn
    // (art-direction §4.4), and tying the variation to frequency means the bass
    // — the thing the eye is already looking for — carries the weight.
    let wt = 1.0 + P.weightVar * (0.5 - cu);
    // Half a cell, in axis units -> radians -> arc length at this radius. The
    // wedge therefore keeps a constant ANGULAR width and fans out with r, which
    // is the honest polar object; the inner radius is what stops the narrow end
    // of it collapsing.
    let halfArc = max((1.0 - clamp(P.gap, 0.0, 0.95)) * 0.5 / n, 1e-5)
                * sweep * TAU * max(wt, 0.05) * r;

    // Arc length from the cell's centre line. A real distance, so it shares the
    // frame's one epsilon and never sees atan2's wrap.
    let d = abs(wrapPi(ang - (P.spin + cu * sweep * TAU))) * r;
    let sx = 1.0 - smoothstep(halfArc - e, halfArc + e, d);

    let m = inRange * sx;
    // Bail before `cellMag`, which is 8 buffer reads; three cells on a
    // FULLSCREEN pass is 24, and at most one of them normally covers the
    // fragment (§4.11). Exactly, not approximately, free: every term below is
    // multiplied by `m`, and `max(x, 0.0)` for these non-negative coverages is
    // `x`, so the output is bit-identical. `continue` rather than a mask is
    // legal because the uniformity rule governs DERIVATIVES alone and the only
    // one in this shader — `e` — is hoisted above the loop precisely for this.
    if (m <= 0.0) { continue; }

    let mp = cellMag(i, n);
    let h = shape(mp.x);
    let ph = shape(mp.y);

    // Grows outward from the inner radius, and is clipped by it on the inside —
    // the two smoothsteps together are the wedge.
    let sIn = smoothstep(P.inner - e, P.inner + e, r);
    let sOut = 1.0 - smoothstep(P.inner + h - e, P.inner + h + e, r);
    // The cap rides the peak-hold radius and falls because the analysis's peak
    // falls. Drawn even when the bar beneath it has collapsed — that gap IS the
    // peak-hold readout.
    let sc = 1.0 - smoothstep(P.capHalf - e, P.capHalf + e, abs(r - (P.inner + ph)));

    body = max(body, m * sIn * sOut);
    cap = max(cap, m * sc * sIn);
    lit = max(lit, m * h);
  }

  // Value range beats hue range (§2.3): the wedge darkens towards the hub so it
  // reads as a lit blade rather than a flat slab, and the floor stays near zero.
  // ONE hue — the layer's palette slot. Colouring a spectrum by frequency is the
  // rainbow anti-pattern wearing a hat (§2.2, §5).
  let along = clamp((r - P.inner) / max(lit, 1e-4), 0.0, 1.0);
  let base = 0.20 + 0.80 * along;
  let level = body * P.bodyLevel * base + cap * P.capLevel;
  let a = clamp(body + cap, 0.0, 1.0) * C.opacity;
  return vec4<f32>(C.color.rgb * level * C.opacity, a);
}
