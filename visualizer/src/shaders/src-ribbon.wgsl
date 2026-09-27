// Ribbon: the waveform extruded into a band with real width, twisted about its
// own path and SHADED FROM A NORMAL. Plan §8.1.
//
// Look: INK (art-direction §1.1/§1.3) — a single slow stroke with weight, on
// near-black. It is the one waveform source that is a surface rather than a
// line, and everything here follows from that:
//
//   - A stroked line has no normal and therefore no light. This one carries a
//     3D frame: the path is planar, but the band ROLLS about its tangent by
//     `phi`, so its across-direction has a z component and the surface normal
//     turns as the ribbon twists. That is what makes it read as a material
//     catching light instead of a filled polyline.
//   - The apparent half-width is `w * cos(phi)`. Not a stylisation — it is what
//     an orthographic view of a twisted band actually does, and it is where most
//     of the line-weight variation (§4.4) comes from for free. Edge-on the band
//     collapses to a bright hairline, which is correct and is why the sub-pixel
//     clamp below carries the remainder in ALPHA rather than widening the quad.
//   - Shading happens in OKLab (§2.1). Only lightness and chroma move; the HUE
//     is whatever the layer's palette slot is and never shifts, because a
//     surface that changes hue as it turns is a third hue nobody asked for
//     (§2.2). Shadows gain a little chroma, as real ones do.
//   - The specular lobe is the ONLY thing allowed above 1.0, it is gated by
//     `gloss` and by the air band, so bloom finds the ribbon's highlight on a
//     transient and nothing else (§2.4).
//
// Joins are mitered exactly as `src-scope.wgsl` does them, and for the same
// reason: a per-segment quad leaves a wedge on every outside corner, and an
// unclamped miter fires a spike across the frame at a hairpin.
//
// ---------------------------------------------------------------------------
// BINDINGS ARE NOT DECLARED HERE. `sources/ribbon.ts` prepends
// `PASS_COMMON_WGSL` (C), `AUDIO_WGSL` (A, waveAt, bandAt) and the `params`
// binding. No binding number is written in this file.
// ---------------------------------------------------------------------------

struct Params {
  gain        : f32,   // amplitude -> path displacement
  halfWidth   : f32,   // half band width, unit-y
  segments    : f32,
  spread      : f32,   // half the horizontal extent, aspect-corrected on the CPU
  centreX     : f32,   // unit space. Off-centre by default — §4.1
  centreY     : f32,
  twistTurns  : f32,   // total roll along the path, radians
  twistPhase  : f32,   // radians, from a clock division. Never wall-clock (§3.1)
  weightVar   : f32,   // 0 = uniform width (do not), 1 = strongly varying
  window      : f32,   // fraction of the waveform window traversed
  scroll      : f32,   // phase offset into that window, from a clock division
  stereoWidth : f32,   // how much |L-R| widens the band
  gloss       : f32,   // specular strength. The only HDR in this pass.
  shade       : f32,   // lightness of the fully-turned-away side, 0..1
  taper       : f32,   // end-taper exponent. The band starts and ends at nothing.
  _pad0       : f32,
};

const PI = 3.14159265359;

// The key light. Fixed, off-centre, from the upper left — art-direction §4.1
// rejects anything that radiates from the middle of the frame, and a light that
// tracked the audio would make the whole band flash rather than turn.
const KEY = vec3<f32>(-0.4472, 0.7208, 0.5298);
/** Curvature across the band, radians at the edge. A perfectly flat strip has one flat tone. */
const BEVEL = 0.85;

// Unit space: y in [-1,1], x in [-aspect, aspect]. Clip is x/aspect.
fn toClip(p : vec2<f32>) -> vec4<f32> {
  return vec4<f32>(p.x / max(C.aspect, 1e-4), p.y, 0.0, 1.0);
}

/** L,R at path position t, phase-shifted by the scroll. */
fn ribbonSample(t : f32) -> vec2<f32> {
  return waveAt(fract(clamp(t, 0.0, 1.0) * P.window + P.scroll));
}

fn ribbonPoint(t : f32) -> vec2<f32> {
  let s = ribbonSample(t);
  let mono = (s.x + s.y) * 0.5;
  return vec2<f32>(
    P.centreX + (clamp(t, 0.0, 1.0) - 0.5) * 2.0 * P.spread,
    P.centreY + mono * P.gain,
  );
}

/**
 * Half-width at t, before the twist foreshortens it.
 *
 * `env` is the brush taper: zero at both ends, so the stroke has a start and a
 * finish instead of being clipped by the frame edge. `taper` below 1 makes the
 * shoulders fuller, above 1 makes it a needle.
 */
fn ribbonWidth(t : f32) -> f32 {
  let s = ribbonSample(t);
  let amp = abs(s.x + s.y) * 0.5;
  let stereo = abs(s.x - s.y);
  let env = pow(clamp(sin(clamp(t, 0.0, 1.0) * PI), 0.0, 1.0), max(P.taper, 0.05));
  let w = 1.0 + P.weightVar * (1.7 * amp - 0.28) + P.stereoWidth * stereo;
  return P.halfWidth * env * max(w, 0.05);
}

/**
 * Roll about the tangent. Stereo divergence tilts the band on top of the steady
 * twist, so a wide stereo image reads as the surface turning into and out of the
 * light rather than as a brightness change (§5, "full-frame brightness swings").
 */
fn ribbonRoll(t : f32) -> f32 {
  let s = ribbonSample(t);
  return P.twistPhase + clamp(t, 0.0, 1.0) * P.twistTurns + (s.x - s.y) * 1.4;
}

fn safeDir(v : vec2<f32>) -> vec2<f32> {
  let l = length(v);
  if (l < 1e-7) { return vec2<f32>(1.0, 0.0); }
  return v / l;
}

/**
 * Miter at `cur` between prev->cur and cur->next: (direction.xy, length scale).
 * The scale is 1/cos(theta/2) and is clamped — a hairpin sends it to infinity.
 *
 * The degenerate cases are the ENDPOINTS, not exotica: `ribbonPoint` clamps its
 * parameter, so at seg 0 `prev == cur` and at the last segment `next == cur`.
 * Falling back to `safeDir`'s arbitrary (1,0) there would tilt the miter toward
 * vertical and visibly skew the first and last cap — the same trap `src-scope.wgsl`
 * documents. Use the ONE real adjacent normal instead, which is a square butt cap.
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

// OKLab <-> linear sRGB. Both directions, because the shading modulates the
// palette colour PERCEPTUALLY: scaling linear rgb darkens through mud, and
// mixing toward white in sRGB is the grey dead-zone of §2.1 in another costume.
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
  @location(0) across : f32,          // -1..1 across the band
  @location(1) fade   : f32,          // sub-pixel width compensation
  @location(2) nrm    : vec3<f32>,    // surface normal at the band's midline
  @location(3) acr    : vec3<f32>,    // the band's across-direction, in 3D
};

@vertex
fn vs(@builtin(vertex_index) vi : u32) -> VsOut {
  let seg = f32(vi / 6u);
  let corner = vi % 6u;
  let n = max(P.segments, 2.0);

  let t1 = seg / n;
  let t2 = (seg + 1.0) / n;

  // Four points, because a miter needs the segment on each side of the joint.
  let p0 = ribbonPoint((seg - 1.0) / n);
  let p1 = ribbonPoint(t1);
  let p2 = ribbonPoint(t2);
  let p3 = ribbonPoint((seg + 2.0) / n);

  let j1 = joinNormal(p0, p1, p2);
  let j2 = joinNormal(p1, p2, p3);

  let phi1 = ribbonRoll(t1);
  let phi2 = ribbonRoll(t2);

  // Signed, so a roll past 90 degrees genuinely flips the band over rather than
  // folding it back on itself.
  let a1 = ribbonWidth(t1) * cos(phi1);
  let a2 = ribbonWidth(t2) * cos(phi2);

  // One pixel is 2/resolution.y in unit-y. Below half of that a band does not
  // draw thin, it draws INTERMITTENT — coverage becomes a question of whether a
  // sample point happens to land inside it. Clamp the geometry, carry the
  // remainder in alpha, and an edge-on ribbon dims instead of sparkling.
  let minW = 1.0 / max(C.resolution.y, 1.0);
  let fade1 = clamp(abs(a1) / minW, 0.0, 1.0);
  let fade2 = clamp(abs(a2) / minW, 0.0, 1.0);
  let w1 = max(abs(a1), minW) * select(-1.0, 1.0, a1 >= 0.0);
  let w2 = max(abs(a2), minW) * select(-1.0, 1.0, a2 >= 0.0);

  let o1 = j1.xy * (w1 * j1.z);
  let o2 = j2.xy * (w2 * j2.z);

  // The 3D frame. The tangent is planar (z = 0); the across-direction is the
  // in-plane miter rolled by phi out of the plane. The normal is their cross
  // product, which is what the fragment stage lights.
  let t3a = normalize(vec3<f32>(safeDir(p2 - p0), 0.0));
  let t3b = normalize(vec3<f32>(safeDir(p3 - p1), 0.0));
  let acr1 = vec3<f32>(j1.xy * cos(phi1), sin(phi1));
  let acr2 = vec3<f32>(j2.xy * cos(phi2), sin(phi2));
  let nrm1 = normalize(cross(t3a, acr1));
  let nrm2 = normalize(cross(t3b, acr2));

  var pos : vec2<f32>;
  var across : f32;
  var fade : f32;
  var nrm : vec3<f32>;
  var acr : vec3<f32>;
  switch (corner) {
    case 0u: { pos = p1 - o1; across = -1.0; fade = fade1; nrm = nrm1; acr = acr1; }
    case 1u: { pos = p1 + o1; across =  1.0; fade = fade1; nrm = nrm1; acr = acr1; }
    case 2u: { pos = p2 - o2; across = -1.0; fade = fade2; nrm = nrm2; acr = acr2; }
    case 3u: { pos = p2 - o2; across = -1.0; fade = fade2; nrm = nrm2; acr = acr2; }
    case 4u: { pos = p1 + o1; across =  1.0; fade = fade1; nrm = nrm1; acr = acr1; }
    default: { pos = p2 + o2; across =  1.0; fade = fade2; nrm = nrm2; acr = acr2; }
  }

  var out : VsOut;
  out.pos = toClip(pos);
  out.across = across;
  out.fade = fade;
  out.nrm = nrm;
  out.acr = acr;
  return out;
}

@fragment
fn fs(in : VsOut) -> @location(0) vec4<f32> {
  let d = abs(in.across);
  // Analytic AA (§4.5), in the same parameter the edge is expressed in, so it
  // holds at any width and any resolution. Clamped because a band thinner than a
  // fragment would otherwise smooth its own coverage away to nothing.
  let e = clamp(fwidth(in.across), 1e-4, 0.9);
  let cov = 1.0 - smoothstep(1.0 - e, 1.0, d);

  // Bend the normal across the width so the band is a shallow cylinder, not a
  // flat strip. A flat strip has exactly one tone and stops reading as a surface.
  let bend = in.across * BEVEL;
  let nrm = normalize(in.nrm * cos(bend) + normalize(in.acr) * sin(bend));

  // Wrapped diffuse: the far side goes to `shade`, not to black. A hard
  // terminator on a band this thin reads as a hole punched in the stroke.
  let lam = dot(nrm, KEY);
  let diff = mix(P.shade, 1.0, clamp(lam * 0.5 + 0.5, 0.0, 1.0));

  // Perceptual shading. Lightness carries the light; chroma rises slightly in
  // shadow, as it does on real material. The hue never moves (§2.2).
  let base = linearToOklab(C.color.rgb);
  let lab = vec3<f32>(base.x * diff, base.y * (1.0 + 0.22 * (1.0 - diff)), base.z * (1.0 + 0.22 * (1.0 - diff)));
  let rgb = max(oklabToLinear(lab), vec3<f32>(0.0));

  // The one HDR term (§2.4). Blinn-Phong against a fixed view, gated by gloss
  // and ridden by the air band so it lands on transients and is otherwise absent.
  // `hv`, not `half` — `half` is a WGSL reserved word and the error it produces
  // points at the next line.
  let hv = normalize(KEY + vec3<f32>(0.0, 0.0, 1.0));
  let spec = pow(max(dot(nrm, hv), 0.0), 48.0) * P.gloss * (0.35 + 1.15 * bandAt(4u));

  let a = cov * in.fade * C.opacity;
  return vec4<f32>((rgb + vec3<f32>(spec)) * a, a);
}
