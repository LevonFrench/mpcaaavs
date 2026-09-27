// Wavegrid: a perspective line grid displaced by the waveform — a rippled sheet
// travelling toward the viewer under a fixed horizon. Plan §8.1.
//
// Look: GRID (art-direction §1.2). Its discipline is one sentence: **the horizon
// does not move.** `P.horizon` is a constant screen height and nothing in this
// file writes to it; the sheet scrolls underneath it, and the fixed element is
// what makes the moving one read as fast.
//
// It is real GEOMETRY, not a raymarched plane. Every line is a quad with mitered
// joins, for the same reason `src-scope.wgsl` builds them that way, plus one
// that is specific to perspective: a screen-space stroke that keeps a constant
// WORLD width gets thinner with distance on its own, which is §4.4's "weight
// varies with depth" for free and is the single thing that stops a grid looking
// machine-drawn.
//
// The hard part of a converging grid is the far rows, where the spacing falls
// below a pixel. Three defences, and all three are needed:
//
//   - Width is clamped to half a pixel and the remainder is carried in ALPHA.
//     Without it the far rows do not thin, they FLICKER: whether a row lands on
//     a sample point becomes luck, and the luck changes every frame as the sheet
//     scrolls. This is the same sub-pixel argument as the scope, but here it is
//     load-bearing rather than a nicety.
//   - `fwidth`-based analytic AA across the stroke (§4.5), so what is left of a
//     far line is a correctly-weighted grey rather than a stair.
//   - Fog. Distance darkens toward the palette's floor, so the rows that are
//     beyond resolving are gone before they can alias at all (§2.3 — value range
//     is doing the work here, not hue).
//
// Rows scroll by a FRACTION of one row spacing, never by a modulo of the whole
// depth. A wrapping row index would tear every column line once per lap, because
// column segment (i,j)->(i,j+1) would span the wrap. Offsetting all rows by
// `travelFrac` instead makes the INTERIOR seamless: at 0 and at 1 the interior
// world positions are the same set, and every quantity drawn is a function of
// world z rather than of row index, so the interior picture is identical too.
// The two ENDS are not covered by that argument — at the wrap the nearest row is
// replaced and a new far row appears — which is what the near fade in `strokeAt`
// and the fog at the far end are for. Without the near fade the bottom row pops
// once per travel cycle.
//
// Stereo appears as a LEAN: the left of the sheet reads L, the right reads R. A
// mono signal ripples symmetrically, a wide one does not.
//
// ---------------------------------------------------------------------------
// BINDINGS ARE NOT DECLARED HERE. `sources/wavegrid.ts` prepends
// `PASS_COMMON_WGSL` (C), `AUDIO_WGSL` (A, waveAt, bandAt) and the `params`
// binding. No binding number is written in this file.
// ---------------------------------------------------------------------------

struct Params {
  rows       : f32,
  cols       : f32,
  amp        : f32,   // sheet displacement, world units
  halfWidth  : f32,   // half stroke width at unit depth. Perspective does the rest.
  spanX      : f32,   // half the sheet's world width
  zNear      : f32,
  zSpan      : f32,   // far - near
  travelFrac : f32,   // 0..1 of one row spacing, from a clock division (§3.1)
  horizon    : f32,   // screen height of the horizon, unit-y. FIXED.
  camY       : f32,   // camera height above the sheet, world units
  focal      : f32,
  window     : f32,   // fraction of the waveform window spanned across the sheet
  weightVar  : f32,   // 0 = uniform stroke (do not), 1 = strongly varying
  fog        : f32,   // extinction per world unit of depth
  scroll     : f32,   // phase offset into the wave window, from a clock division
  stereo     : f32,   // 0 = mono sum, 1 = L on the left edge and R on the right
  zWave      : f32,   // wave phase per world unit of depth — the ripple's wavelength
  depthAmp   : f32,   // height falloff with depth. Distant rows must go quiet.
  crest      : f32,   // brightness boost with |height|
  _pad0      : f32,
};

// Unit space: y in [-1,1], x in [-aspect, aspect]. Clip is x/aspect, so the
// sheet spans the frame at any aspect without the perspective going oval.
fn toClip(p : vec2<f32>) -> vec4<f32> {
  return vec4<f32>(p.x / max(C.aspect, 1e-4), p.y, 0.0, 1.0);
}

fn gridRows() -> f32 { return max(floor(P.rows), 2.0); }
fn gridCols() -> f32 { return max(floor(P.cols), 2.0); }

/**
 * Sheet height at (ux across the sheet 0..1, world depth z).
 *
 * The wave index folds BOTH axes: `ux` spreads the waveform across the sheet and
 * `z * zWave` phases it with depth, so the ripple is a travelling wave rather
 * than the same curve stamped on every row. Phasing on world z rather than on
 * the row INDEX is what stops the ripple swimming as the rows scroll — the
 * height belongs to the place, not to the row that happens to be there.
 */
fn heightAt(ux : f32, z : f32) -> f32 {
  let t = fract(ux * P.window + z * P.zWave + P.scroll);
  let s = waveAt(t);
  let mono = (s.x + s.y) * 0.5;
  let lean = mix(s.x, s.y, clamp(ux, 0.0, 1.0));
  // Distant rows go quiet. Without this the far half of the sheet is a solid
  // band of noise at the horizon — the one place the eye is least able to
  // resolve it and most able to see it flicker.
  let att = 1.0 / (1.0 + max(z, 0.0) * P.depthAmp);
  return mix(mono, lean, clamp(P.stereo, 0.0, 1.0)) * P.amp * att;
}

/** Node (fi, fj) -> (unit-space xy, world depth z). Indices may be fractional or out of range. */
fn nodeAt(fi : f32, fj : f32) -> vec3<f32> {
  let ux = fi / (gridCols() - 1.0);
  let x = (ux - 0.5) * 2.0 * P.spanX;
  let z = P.zNear + (fj + P.travelFrac) * (P.zSpan / gridRows());
  let y = heightAt(ux, z);

  // Weak perspective about a fixed horizon. As z grows the sheet converges to
  // `horizon` from below and stays there — which is the discipline of §1.2.
  let invZ = P.focal / max(z, 1e-3);
  return vec3<f32>(x * invZ, P.horizon + (y - P.camY) * invZ, z);
}

/**
 * Neighbour for a miter, extrapolated in SCREEN space when the index falls off
 * the sheet.
 *
 * Extrapolating in world space instead would put the phantom node behind the
 * camera at the near edge (z <= 0), and one divide by a near-zero depth throws
 * that vertex off the frame — a single bright spike from the corner of the grid,
 * once per scroll cycle.
 */
fn neighbour(fi : f32, fj : f32, ok : bool, p1 : vec2<f32>, p2 : vec2<f32>) -> vec2<f32> {
  if (ok) { return nodeAt(fi, fj).xy; }
  return 2.0 * p1 - p2;
}

fn safeDir(v : vec2<f32>) -> vec2<f32> {
  let l = length(v);
  if (l < 1e-7) { return vec2<f32>(1.0, 0.0); }
  return v / l;
}

/** Miter at `cur`: (direction.xy, length scale). Clamped — a hairpin sends 1/cos to infinity. */
fn joinNormal(prev : vec2<f32>, cur : vec2<f32>, next : vec2<f32>) -> vec3<f32> {
  let d0 = safeDir(cur - prev);
  let d1 = safeDir(next - cur);
  let n0 = vec2<f32>(-d0.y, d0.x);
  let n1 = vec2<f32>(-d1.y, d1.x);
  var m = n0 + n1;
  let l = length(m);
  if (l < 1e-5) { return vec3<f32>(n1, 1.0); }
  m = m / l;
  return vec3<f32>(m, min(1.0 / max(dot(m, n1), 0.1), 4.0));
}

// OKLab -> linear sRGB. The fog is a LIGHTNESS ramp: scaling linear rgb toward
// black drags the hue out with it, which is the grey dead-zone of §2.1 arriving
// through the back door.
fn oklabToLinear(c : vec3<f32>) -> vec3<f32> {
  let l_ = c.x + 0.3963377774 * c.y + 0.2158037573 * c.z;
  let m_ = c.x - 0.1055613458 * c.y - 0.0638541728 * c.z;
  let s_ = c.x - 0.0894841775 * c.y - 1.2914855480 * c.z;
  let l = l_ * l_ * l_;
  let m = m_ * m_ * m_;
  let s = s_ * s_ * s_;
  return vec3<f32>(
    4.0767416621 * l - 3.3077115913 * m + 0.2309699292 * s,
   -1.2684380046 * l + 2.6097574011 * m - 0.3413193965 * s,
   -0.0041960863 * l - 0.7034186147 * m + 1.7076147010 * s,
  );
}

fn linearToOklab(c : vec3<f32>) -> vec3<f32> {
  let r = max(c.x, 0.0);
  let g = max(c.y, 0.0);
  let b = max(c.z, 0.0);
  let l = 0.4122214708 * r + 0.5363325363 * g + 0.0514459929 * b;
  let m = 0.2119034982 * r + 0.6806995451 * g + 0.1073969566 * b;
  let s = 0.0883024619 * r + 0.2817188376 * g + 0.6299787005 * b;
  let l_ = pow(l, 1.0 / 3.0);
  let m_ = pow(m, 1.0 / 3.0);
  let s_ = pow(s, 1.0 / 3.0);
  return vec3<f32>(
    0.2104542553 * l_ + 0.7936177850 * m_ - 0.0040720468 * s_,
    1.9779984951 * l_ - 2.4285922050 * m_ + 0.4505937099 * s_,
    0.0259040371 * l_ + 0.7827717662 * m_ - 0.8086757660 * s_,
  );
}

struct VsOut {
  @builtin(position) pos : vec4<f32>,
  @location(0) across : f32,   // -1..1 across the stroke
  @location(1) fade   : f32,   // sub-pixel width compensation
  @location(2) glow   : f32,
};

/** Stroke half-width and brightness for a node at depth z. */
fn strokeAt(z : f32, height : f32) -> vec2<f32> {
  // Constant WORLD width -> screen width falls as 1/z. Depth varies the weight
  // without anyone choosing a curve for it (§4.4).
  let w = P.halfWidth * (P.focal / max(z, 1e-3));
  let crest = abs(height) / max(P.amp, 1e-4);
  let vary = 1.0 + P.weightVar * (0.9 * crest + 0.5 * bandAt(1u) - 0.25);
  // Beer-Lambert fog from the near plane, so the sheet reaches the horizon dark
  // rather than being cut off there.
  let att = exp(-max(P.fog, 0.0) * max(z - P.zNear, 0.0));
  // The NEAR edge is a real edge and it is where the travel wrap shows. Row j
  // lives at `zNear + (j + travelFrac) * spacing`, so when `travelFrac` wraps
  // 0 -> 1 every row jumps back by exactly one spacing: the interior is
  // identical (height and glow are functions of world z, not of row index) but
  // the nearest row is REPLACED, and at the bottom of the frame that is a
  // visible pop once per `travelBeats` — every beat, by default. Fading over
  // precisely one row spacing makes the swap invisible, because the row
  // arriving at `zNear + spacing` is then exactly as bright as the one that
  // just left it. The far end needs no equivalent: fog has already taken it.
  let spacing = P.zSpan / gridRows();
  let near = smoothstep(0.0, max(spacing, 1e-4), z - P.zNear);
  let glow = att * near * (0.55 + P.crest * crest);
  return vec2<f32>(w * max(vary, 0.15), glow);
}

@vertex
fn vs(@builtin(vertex_index) vi : u32) -> VsOut {
  let seg = f32(vi / 6u);
  let corner = vi % 6u;

  let rows = gridRows();
  let cols = gridCols();
  let rowSegs = rows * (cols - 1.0);

  // Two line families out of one index range. Rows run across the sheet, columns
  // run into the distance; both are polylines, so both get real joins.
  var i1 : f32;
  var j1 : f32;
  var i2 : f32;
  var j2 : f32;
  var i0 : f32;
  var j0 : f32;
  var i3 : f32;
  var j3 : f32;
  var okPrev : bool;
  var okNext : bool;

  if (seg < rowSegs) {
    let j = floor(seg / (cols - 1.0));
    let i = seg - j * (cols - 1.0);
    i1 = i;       j1 = j;
    i2 = i + 1.0; j2 = j;
    i0 = i - 1.0; j0 = j;
    i3 = i + 2.0; j3 = j;
    okPrev = i - 1.0 >= 0.0;
    okNext = i + 2.0 <= cols - 1.0;
  } else {
    let s2 = seg - rowSegs;
    let i = floor(s2 / (rows - 1.0));
    let j = s2 - i * (rows - 1.0);
    i1 = i; j1 = j;
    i2 = i; j2 = j + 1.0;
    i0 = i; j0 = j - 1.0;
    i3 = i; j3 = j + 2.0;
    okPrev = j - 1.0 >= 0.0;
    okNext = j + 2.0 <= rows - 1.0;
  }

  let n1 = nodeAt(i1, j1);
  let n2 = nodeAt(i2, j2);
  let p1 = n1.xy;
  let p2 = n2.xy;
  let p0 = neighbour(i0, j0, okPrev, p1, p2);
  let p3 = neighbour(i3, j3, okNext, p2, p1);

  let jn1 = joinNormal(p0, p1, p2);
  let jn2 = joinNormal(p1, p2, p3);

  // The height is recoverable from the projection, but recomputing it is one
  // waveAt and keeps `strokeAt` independent of the projection's algebra.
  let h1 = heightAt(i1 / (cols - 1.0), n1.z);
  let h2 = heightAt(i2 / (cols - 1.0), n2.z);
  let s1 = strokeAt(n1.z, h1);
  let s2 = strokeAt(n2.z, h2);

  var w1 = s1.x;
  var w2 = s2.x;

  // Half a pixel in unit-y is 1/resolution.y. See the header: this clamp is what
  // separates a grid that thins into the distance from one that flickers there.
  let minW = 1.0 / max(C.resolution.y, 1.0);
  let fade1 = clamp(w1 / minW, 0.0, 1.0);
  let fade2 = clamp(w2 / minW, 0.0, 1.0);
  w1 = max(w1, minW);
  w2 = max(w2, minW);

  let o1 = jn1.xy * (w1 * jn1.z);
  let o2 = jn2.xy * (w2 * jn2.z);

  var pos : vec2<f32>;
  var across : f32;
  var fade : f32;
  var glow : f32;
  switch (corner) {
    case 0u: { pos = p1 - o1; across = -1.0; fade = fade1; glow = s1.y; }
    case 1u: { pos = p1 + o1; across =  1.0; fade = fade1; glow = s1.y; }
    case 2u: { pos = p2 - o2; across = -1.0; fade = fade2; glow = s2.y; }
    case 3u: { pos = p2 - o2; across = -1.0; fade = fade2; glow = s2.y; }
    case 4u: { pos = p1 + o1; across =  1.0; fade = fade1; glow = s1.y; }
    default: { pos = p2 + o2; across =  1.0; fade = fade2; glow = s2.y; }
  }

  var out : VsOut;
  out.pos = toClip(pos);
  out.across = across;
  out.fade = fade;
  out.glow = glow;
  return out;
}

@fragment
fn fs(in : VsOut) -> @location(0) vec4<f32> {
  let d = abs(in.across);
  // Analytic AA in the stroke's own parameter (§4.5). This is the term that
  // keeps the grid alive where the lines converge: coverage becomes a fraction
  // rather than a decision.
  let e = clamp(fwidth(in.across), 1e-4, 0.9);
  let cov = 1.0 - smoothstep(1.0 - e, 1.0, d);
  // A soft shoulder as well as a hard edge, so crossings of a row and a column
  // do not read as a bright dot at every single intersection.
  let core = 0.45 + 0.55 * exp(-d * d * 2.0);

  let base = linearToOklab(C.color.rgb);
  let g = in.glow * core;
  let lab = vec3<f32>(base.x * g, base.y * (0.9 + 0.25 * g), base.z * (0.9 + 0.25 * g));
  let rgb = max(oklabToLinear(lab), vec3<f32>(0.0));

  let a = cov * in.fade * C.opacity;
  return vec4<f32>(rgb * a, a);
}
