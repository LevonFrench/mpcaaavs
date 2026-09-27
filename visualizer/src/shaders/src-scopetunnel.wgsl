// Scope tunnel: successive rows of the spectrogram history receding in Z, so
// the past trails away from the viewer.
//
// Look: GRID (art-direction §1.2). `landscape` mode IS the look's landscape grid
// — a fixed horizon with everything else travelling towards it, which is exactly
// the discipline that section names. `tunnel` mode is the same machinery with
// the vanishing point pulled off the horizon and into the frame.
//
// ---------------------------------------------------------------------------
// Depth is 1/r from the vanishing point, and that is the whole construction
// ---------------------------------------------------------------------------
//
// A plane at depth z projects to a screen offset r = f/z from the vanishing
// point. So z is proportional to 1/r, and a set of rows EVENLY SPACED IN DEPTH
// is a set of rows evenly spaced in 1/r — bunching towards the vanishing point
// on their own, without a single hand-placed constant. Every row here therefore
// lives at a fixed position on the 1/r axis, and that same position is its AGE
// in the history: depth and age are one coordinate, which is what makes a
// feature visibly travel away from the viewer as it gets older.
//
// Heights follow from the same identity. A world-space height h projects to
// h * f/z on screen, and f/z is exactly r — so a row's amplitude is scaled by
// its own r and shrinks with distance for free. Scaling the height by a constant
// instead is the usual mistake and produces far rows that tower over near ones.
//
// ---------------------------------------------------------------------------
// Three more things this file is careful about
// ---------------------------------------------------------------------------
//
//   - THE RING OFFSET IS NOT MINE TO COMPUTE. Every history read goes through
//     `spectrogramAt` (`audiogpu.ts`), whose uv.y is AGE and which addresses
//     rows relative to the write head. Indexing `audioGram` directly makes the
//     whole tunnel JUMP once per 256-row lap — invisible in a screenshot and
//     obvious in motion, which is the worst combination.
//   - LINE WEIGHT VARIES, deliberately (§4.4). With depth, because that is what
//     perspective does, and with the row's own energy. It is also clamped to one
//     pixel with the remainder carried in ALPHA: a stroke thinner than a fragment
//     does not draw a thin line, it draws an intermittent one, and a tunnel is
//     mostly far rows.
//   - THE FAR END FADES OUT. Not atmosphere for its own sake: rows bunch
//     towards the vanishing point until they are sub-pixel, and a far end that
//     stays bright is both aliased AND a second thing competing with the near
//     rows for the eye (§4.2). One focal point means the near rows.
//
// Radial by construction, which §4.1 permits — a tunnel has a centre the way a
// circular scope does. What it does NOT do is add centre-out pulsing on top of
// that; nothing here breathes from the origin on the beat.

struct Params {
  mode       : f32,   // 0 landscape (horizon), 1 tunnel (vanishing point)
  rows       : f32,   // history rows drawn
  span       : f32,   // fraction of the held history the far end reaches
  gain       : f32,
  gamma      : f32,   // < 1 lifts the quiet end
  fLo        : f32,   // normalised frequency at the near/left end of a row
  fHi        : f32,
  height     : f32,   // amplitude, in screen units at the near plane
  originX    : f32,   // vanishing point / horizon centre, unit space
  originY    : f32,   // landscape: the horizon's height. It does not move.
  farR       : f32,   // r at which the far end is cut off
  lineWidth  : f32,   // half stroke width at the near plane
  falloff    : f32,   // exponent on the depth fade
  widthScale : f32,   // lateral extent of a landscape row
  weightVar  : f32,   // 0 = uniform stroke (do not), 1 = strongly varying
  hueSpread  : f32,   // radians of hue rotation between near and far
  spin       : f32,   // tunnel only. From a clock division, never wall-clock (§3.1).
  _pad0      : f32,
  _pad1      : f32,
  _pad2      : f32,
};

const TAU = 6.28318530718;
const PI = 3.14159265359;

/**
 * Rows searched either side of the one under the fragment.
 *
 * A row can be displaced by its own amplitude, so the row visible at a given
 * screen position is not always the one that position indexes. Three either side
 * covers the default height at the default row count; more is a straight cost of
 * four storage loads per row per fragment, and the ones beyond this contribute
 * nothing because the depth fade has already taken them to zero.
 */
const SEARCH : i32 = 3;

/** Normalised frequency along a row. Geometric, so an octave is a fixed width. */
fn logFreq(x : f32) -> f32 {
  return P.fLo * pow(max(P.fHi / P.fLo, 1.0), clamp(x, 0.0, 1.0));
}

// OKLab -> linear sRGB, and back. The tint ramp is built FROM the layer's
// palette slot, and building it in sRGB would pass through the grey dead-zone
// (§2.1). Identical arithmetic to `points.wgsl` and `src-waterfall.wgsl`.
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

fn cbrt(x : f32) -> f32 {
  return sign(x) * pow(abs(x), 1.0 / 3.0);
}

fn linearToOklab(c : vec3<f32>) -> vec3<f32> {
  let l = 0.4122214708 * c.x + 0.5363325363 * c.y + 0.0514459929 * c.z;
  let m = 0.2119034982 * c.x + 0.6806995451 * c.y + 0.1073969566 * c.z;
  let s = 0.0883024619 * c.x + 0.2817188376 * c.y + 0.6299787005 * c.z;
  let l_ = cbrt(l);
  let m_ = cbrt(m);
  let s_ = cbrt(s);
  return vec3<f32>(
    0.2104542553 * l_ + 0.7936177850 * m_ - 0.0040720468 * s_,
    1.9779984951 * l_ - 2.4285922050 * m_ + 0.4505937099 * s_,
    0.0259040371 * l_ + 0.7827717662 * m_ - 0.8086757660 * s_,
  );
}

@vertex
fn vs(@builtin(vertex_index) vi : u32) -> @builtin(position) vec4<f32> {
  return fullscreenTriangle(vi);
}

@fragment
fn fs(@builtin(position) frag : vec4<f32>) -> @location(0) vec4<f32> {
  let uv = fragUV(frag);
  // Unit space: y in [-1,1] and UP, x in [-aspect, aspect]. Keeping the aspect
  // in the coordinate rather than in every expression is what makes the tunnel
  // round instead of egg-shaped.
  let p = vec2<f32>((uv.x - 0.5) * 2.0 * C.aspect, 1.0 - uv.y * 2.0);
  let o = vec2<f32>(P.originX, P.originY);
  let d = p - o;
  let tunnel = P.mode > 0.5;

  // r from the vanishing point. For the landscape that is the distance BELOW the
  // horizon line, which is the same quantity in one dimension — the horizon is a
  // vanishing point smeared sideways.
  let rr = select(o.y - p.y, length(d), tunnel);

  // The only derivative in this shader, taken here in uniform control flow. `rr`
  // changes by roughly one screen pixel's worth per fragment, so this is the
  // exact width to antialias a line expressed in r against — and it stays
  // correct at every depth, which a constant edge width does not.
  let er = max(fwidth(rr), 1e-6);

  // The near plane: the bottom edge of the frame for a landscape, the far corner
  // for a tunnel. Derived rather than a param — a param copy of it disagrees with
  // the attachment the moment the aspect changes.
  let rNear = select(o.y + 1.0, length(vec2<f32>(C.aspect, 1.0)) + length(o), tunnel);
  // The far cutoff has to stay inside the near plane or the field below is empty
  // and the layer renders nothing at all, silently. That is not hypothetical: a
  // landscape with `originY` near the bottom of the frame leaves only a sliver
  // below the horizon, and the default `farR` of 0.12 is larger than the sliver.
  // Half of rNear is the ceiling because a depth range narrower than 2:1 is not
  // a recession, and it is far above anything a sane preset asks for — at the
  // default horizon the ratio is ~11:1, so this clamp is inert there.
  let farR = clamp(P.farR, 1e-3, max(rNear * 0.5, 1e-3));

  // Outside the field entirely: above the horizon, or inside the vanishing
  // point's cutoff. Masked rather than returned early so that nothing below sits
  // under a branch on the fragment's own position.
  let field = step(farR, rr) * step(rr, max(rNear, farR * 2.0));

  let qNear = 1.0 / max(rNear, 1e-3);
  let qFar = 1.0 / farR;
  // Depth, normalised. Linear in 1/r, hence linear in z: rows evenly spaced in
  // this are rows evenly spaced in the world.
  let t = clamp((1.0 / max(rr, 1e-4) - qNear) / max(qFar - qNear, 1e-4), 0.0, 1.0);

  // Angle for the tunnel, wrapped and MIRRORED. Mapping frequency onto a full
  // turn would put fHi hard against fLo at the seam, and a spectrogram with a
  // discontinuity in it reads as a rendering fault rather than as data.
  var th = atan2(d.y, d.x) + P.spin;
  th = th - TAU * floor((th + PI) / TAU);
  let ang = abs(th) / PI;

  // The tint ramp's endpoints, resolved once. `C.color.rgb` carries the slot's
  // intensity, so it is divided back out to recover the unit hue — otherwise a
  // slot with HDR headroom returns an out-of-gamut chroma and the ramp clips on
  // its way through OKLab.
  let unit = max(C.color.rgb / max(C.color.a, 1e-3), vec3<f32>(0.0));
  let base = linearToOklab(unit);
  let h0 = atan2(base.z, base.y);
  let c0 = length(base.yz);

  let n = max(floor(P.rows), 2.0);
  let k0 = floor(t * n - 0.5);
  let span = clamp(P.span, 0.02, 1.0);

  var col = vec3<f32>(0.0);
  var cov = 0.0;

  for (var j = -SEARCH; j <= SEARCH; j = j + 1) {
    let k = k0 + f32(j);
    let inRange = step(0.0, k) * step(k, n - 1.0);
    // Clamped, then masked by `inRange`. Out-of-range rows are still EVALUATED —
    // the loop is uniform and stays that way — so their arithmetic has to stay
    // finite: an unclamped depth outside [0,1] can put `mix(qNear, qFar, tk)`
    // through zero, and the resulting infinity multiplied by a mask of zero is a
    // NaN, not a nothing.
    let tk = clamp((k + 0.5) / n, 0.0, 1.0);

    // This row's baseline r, from its depth. Not from an interpolation in r —
    // that would space the rows evenly on SCREEN, which is a flat stack of
    // stripes rather than a receding one.
    let rk = 1.0 / mix(qNear, qFar, tk);

    // Lateral position along the row. For a landscape the row is a plane at
    // depth, so a fixed world x lands at a screen x proportional to r: dividing
    // by rk is what makes the rows converge towards the horizon.
    let s = select(
      0.5 + (d.x * rNear) / max(rk * 2.0 * C.aspect * max(P.widthScale, 1e-3), 1e-4),
      ang,
      tunnel,
    );
    // Soft ends rather than a hard cut. A landscape row runs out of frequency
    // axis before it runs out of screen, and a hard edge there is a vertical
    // line the eye reads as structure.
    let ends = select(
      smoothstep(0.0, 0.04, s) * smoothstep(0.0, 0.04, 1.0 - s),
      1.0,
      tunnel,
    );

    // Depth IS age: this row shows the history as it was `tk` of the way back.
    let raw = spectrogramAt(vec2<f32>(logFreq(clamp(s, 0.0, 1.0)), tk * span));
    let m = pow(clamp(raw * P.gain, 0.0, 1.0), max(P.gamma, 1e-3));

    // Height in screen units, scaled by the row's own r — see the header. The
    // landscape rises towards the horizon (smaller r); the tunnel bulges
    // outwards (larger r), which is what makes it read as a pipe rather than as
    // a set of flat discs.
    let amp = m * max(P.height, 0.0) * rk;
    let rc = select(rk - amp, rk + amp, tunnel);

    // Weight varies with depth AND with this row's energy (§4.4). Clamped to a
    // fragment; below that the remainder goes into alpha as `thin`, because a
    // sub-fragment stroke drawn at full brightness is a dashed line.
    // The energy term is floored at zero: a strong `weightVar` against a silent
    // row would otherwise ask for a negative width, which reads as a hole in the
    // line rather than as a thin one.
    let want = max(P.lineWidth, 0.0) * rk * max(1.0 + P.weightVar * (m - 0.35), 0.0);
    let w = max(want, er);
    let thin = clamp(want / er, 0.0, 1.0);

    // Analytic AA, in the same coordinate the edge is expressed in (§4.5).
    let cvg = 1.0 - smoothstep(w - er, w + er, abs(rr - rc));

    // The far end goes quiet. One focal point (§4.2), and it also disposes of
    // the rows that have bunched below a pixel.
    let fade = pow(1.0 - tk, max(P.falloff, 0.0)) * thin;

    // Hue rotates by at most `hueSpread` from near to far and lightness falls:
    // value range carrying the depth cue, hue range barely moving (§2.2, §2.3).
    let hu = h0 + P.hueSpread * tk;
    let ch = c0 * mix(1.0, 0.55, tk);
    var tint = max(oklabToLinear(vec3<f32>(mix(0.90, 0.52, tk), ch * cos(hu), ch * sin(hu))), vec3<f32>(0.0));
    // HDR headroom for the near, loud rows alone, and only if the palette slot
    // was given any (§2.4).
    tint = tint * mix(1.0, max(C.color.a, 1.0), smoothstep(0.65, 1.0, m) * (1.0 - tk));

    let mask = cvg * inRange * ends * fade;
    // `max`, not `+`. Rows overlap wherever a loud one is displaced across its
    // neighbour, and accumulating there blows the crossing out to white — the
    // same steady-state arithmetic that whited the attractor's trail out.
    col = max(col, tint * (0.35 + 0.9 * m) * mask);
    cov = max(cov, mask);
  }

  let a = clamp(cov, 0.0, 1.0) * field;
  // C.opacity is the one obligation `PASS_COMMON_WGSL` imposes: fixed-function
  // blending has no per-draw multiplier, so a pass that ignores it is a pass
  // whose opacity slider does nothing.
  return vec4<f32>(col * field * C.opacity, a * C.opacity);
}
