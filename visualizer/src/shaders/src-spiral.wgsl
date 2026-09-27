// Spiral: an Archimedean spiral whose radius grows with the sample INDEX and is
// perturbed by the sample itself. Plan §8.1.
//
// Look: LAB (art-direction §1.1) — one line, drawn well, on near-black. It is a
// radial source, which §4.1 explicitly permits: a spiral has a centre by
// construction, unlike a pulse that was bolted onto the middle of the frame. So
// there is deliberately NO centre-out flashing on top of it, and the centre
// itself sits slightly off the frame's own.
//
// The failure mode this file is written against is CROWDING. Turn n and turn
// n+1 are `(rOuter - rInner) / turns` apart, which at eight turns is ~0.05 unit
// — a stroke of constant width and constant brightness therefore fills the inner
// third solid long before it reaches the middle, and the source stops being a
// spiral and becomes a disc. Three things prevent it, and all three are needed:
//
//   - The stroke TAPERS toward the centre (`taperInner`), so weight varies along
//     the line instead of being uniform (§4.4).
//   - The brightness fades with it (`innerFade`). Taper alone still stacks
//     coverage from adjacent turns into a solid additive core.
//   - The radial wobble is CLAMPED on the CPU to a fraction of the turn spacing,
//     so loud passages cannot make adjacent turns cross. Crossing turns are what
//     turn a spiral into a scribble.
//
// Stereo is used rather than summed away: L displaces the radius, R displaces
// the ANGLE. A centred mono signal breathes in and out; a wide one shears, which
// is a shape the eye reads as stereo without being told.
//
// ---------------------------------------------------------------------------
// BINDINGS ARE NOT DECLARED HERE. `sources/spiral.ts` prepends
// `PASS_COMMON_WGSL` (C), `AUDIO_WGSL` (A, waveAt, bandAt) and the `params`
// binding. No binding number is written in this file.
// ---------------------------------------------------------------------------

struct Params {
  gain       : f32,   // radial wobble, unit. CPU-clamped against the turn spacing.
  halfWidth  : f32,   // half stroke width at the OUTER end, unit-y
  segments   : f32,
  turns      : f32,
  rInner     : f32,
  rOuter     : f32,
  centreX    : f32,   // unit space. Off-centre by default — §4.1
  centreY    : f32,
  spin       : f32,   // radians, from a clock division. Never wall-clock (§3.1)
  window     : f32,   // fraction of the waveform window traversed
  scroll     : f32,   // phase offset into that window, from a clock division
  weightVar  : f32,   // 0 = uniform stroke (do not), 1 = strongly varying
  taperInner : f32,   // stroke width at the centre, as a fraction of the outer
  innerFade  : f32,   // brightness at the centre, as a fraction of the outer
  swirl      : f32,   // angular wobble from R, radians. CPU-clamped.
  _pad0      : f32,
};

const TAU = 6.28318530718;

// Unit space: y in [-1,1], x in [-aspect, aspect]. Clip is x/aspect — which is
// what keeps the spiral ROUND on a wide frame instead of an ellipse.
fn toClip(p : vec2<f32>) -> vec4<f32> {
  return vec4<f32>(p.x / max(C.aspect, 1e-4), p.y, 0.0, 1.0);
}

/** L,R at path position t, phase-shifted by the scroll. */
fn spiralSample(t : f32) -> vec2<f32> {
  return waveAt(fract(clamp(t, 0.0, 1.0) * P.window + P.scroll));
}

/**
 * t = 0 at the centre, t = 1 at the outside. Radius grows linearly with t, which
 * IS the Archimedean condition (r proportional to theta, and theta is linear in
 * t) — the constant-pitch spiral, not a logarithmic one whose inner turns
 * collapse into a point no taper can rescue.
 */
fn spiralPoint(t : f32) -> vec2<f32> {
  let u = clamp(t, 0.0, 1.0);
  let s = spiralSample(u);
  let a = P.spin + u * P.turns * TAU + s.y * P.swirl;
  let r = mix(P.rInner, P.rOuter, u) + s.x * P.gain;
  return vec2<f32>(P.centreX, P.centreY) + vec2<f32>(cos(a), sin(a)) * max(r, 0.0);
}

/** (width multiplier, brightness multiplier) at t. Both taper toward the centre. */
fn strokeAt(t : f32) -> vec2<f32> {
  let u = clamp(t, 0.0, 1.0);
  let s = spiralSample(u);
  let amp = abs(s.x + s.y) * 0.5;
  let taper = mix(P.taperInner, 1.0, u);
  // Air rides the stroke a little so hats thicken the whole figure rather than
  // flashing as their own thing (§3.3).
  let w = taper * (1.0 + P.weightVar * (1.6 * amp + 0.6 * bandAt(4u) - 0.3));
  let glow = mix(P.innerFade, 1.0, u) * (0.5 + 0.85 * amp);
  return vec2<f32>(max(w, 0.05), glow);
}

/**
 * Miter at `cur` between prev->cur and cur->next: (direction.xy, length scale).
 * Clamped, because the innermost turns bend hard and an unclamped 1/cos(theta/2)
 * fires one vertex across the whole frame.
 *
 * The degenerate cases are the two ENDS of the spiral: `spiralPoint` clamps its
 * parameter, so at seg 0 `prev == cur` and at the last segment `next == cur`.
 * Substituting an arbitrary direction there skews both caps; falling back to the
 * ONE real adjacent normal gives a square butt cap, exactly as `src-scope.wgsl`
 * does it.
 */
fn joinNormal(prev : vec2<f32>, cur : vec2<f32>, next : vec2<f32>) -> vec3<f32> {
  let e0 = cur - prev;
  let e1 = next - cur;
  let l0 = length(e0);
  let l1 = length(e1);
  if (l0 < 1e-7 && l1 < 1e-7) { return vec3<f32>(0.0, 1.0, 1.0); }
  if (l0 < 1e-7) {
    let d = e1 / l1;
    return vec3<f32>(-d.y, d.x, 1.0);
  }
  if (l1 < 1e-7) {
    let d = e0 / l0;
    return vec3<f32>(-d.y, d.x, 1.0);
  }
  let d0 = e0 / l0;
  let d1 = e1 / l1;
  let n0 = vec2<f32>(-d0.y, d0.x);
  let n1 = vec2<f32>(-d1.y, d1.x);
  var m = n0 + n1;
  let l = length(m);
  if (l < 1e-5) { return vec3<f32>(n1, 1.0); }
  m = m / l;
  return vec3<f32>(m, min(1.0 / max(dot(m, n1), 0.1), 4.0));
}

// OKLab -> linear sRGB. The brightness ramp along the spiral is a LIGHTNESS
// ramp, applied perceptually: scaling linear rgb toward black crushes the hue
// out of the inner turns, which is §2.1 in its least obvious costume.
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

@vertex
fn vs(@builtin(vertex_index) vi : u32) -> VsOut {
  let seg = f32(vi / 6u);
  let corner = vi % 6u;
  let n = max(P.segments, 2.0);

  let t1 = seg / n;
  let t2 = (seg + 1.0) / n;

  let p0 = spiralPoint((seg - 1.0) / n);
  let p1 = spiralPoint(t1);
  let p2 = spiralPoint(t2);
  let p3 = spiralPoint((seg + 2.0) / n);

  let j1 = joinNormal(p0, p1, p2);
  let j2 = joinNormal(p1, p2, p3);

  let s1 = strokeAt(t1);
  let s2 = strokeAt(t2);
  var w1 = P.halfWidth * s1.x;
  var w2 = P.halfWidth * s2.x;

  // One pixel is 2/resolution.y in unit-y, so half a pixel is 1/resolution.y.
  // The inner turns are exactly where the taper drives the stroke under that,
  // and below it a line stops being thin and starts being INTERMITTENT. Clamp
  // the geometry, carry the remainder in alpha, and the centre fades out
  // smoothly instead of dissolving into sparkle.
  let minW = 1.0 / max(C.resolution.y, 1.0);
  let fade1 = clamp(w1 / minW, 0.0, 1.0);
  let fade2 = clamp(w2 / minW, 0.0, 1.0);
  w1 = max(w1, minW);
  w2 = max(w2, minW);

  let o1 = j1.xy * (w1 * j1.z);
  let o2 = j2.xy * (w2 * j2.z);

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
  // Analytic AA (§4.5): the edge is one fragment-derivative wide in the same
  // parameter the edge is expressed in, so it holds at every width and every
  // resolution. Clamped, or a sub-fragment stroke smooths itself away.
  let e = clamp(fwidth(in.across), 1e-4, 0.9);
  let cov = 1.0 - smoothstep(1.0 - e, 1.0, d);

  // Soft shoulder across the width. A flat-topped stroke bands visibly wherever
  // the spiral passes close to its own previous turn, which is everywhere.
  let core = 0.32 + 0.68 * exp(-d * d * 2.4);

  // The glow ramp is a LIGHTNESS ramp in OKLab, so the dim inner turns keep the
  // palette's hue instead of graduating to grey. Chroma lifts slightly at the
  // bright end, which is what a phosphor actually does.
  let base = linearToOklab(C.color.rgb);
  let g = in.glow * core;
  let lab = vec3<f32>(base.x * g, base.y * (0.85 + 0.35 * g), base.z * (0.85 + 0.35 * g));
  let rgb = max(oklabToLinear(lab), vec3<f32>(0.0));

  let a = cov * in.fade * C.opacity;
  return vec4<f32>(rgb * a, a);
}
