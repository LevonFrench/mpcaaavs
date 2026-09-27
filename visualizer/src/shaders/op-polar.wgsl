// Polar swap — the cartesian <-> polar remap of the accumulated frame.
//
// Plan §7 lists this second among the operators and calls it free, which it is.
// It makes ANY visualiser radial without that visualiser knowing anything about
// it: a spectrum becomes a radial spectrum, a scope becomes a circular scope, a
// landscape grid becomes a tunnel. Operators are multiplicative, and this is the
// one with the highest ratio of new looks to lines in the whole document.
//
// What it deliberately does NOT do: draw anything of its own, touch colour, or
// have any opinion about what is underneath it. It is a coordinate map and a
// crossfade, and every pixel it emits came out of the accumulator.
//
// Art direction §4.1 forbids radiating from the screen centre by default. A
// polar swap IS a centre in exactly the way a kaleidoscope and a feedback zoom
// are — the centre is the mechanism, not decoration — so it inherits the same
// warning, and it takes a centre offset so the origin can be pinned to something
// meaningful (a band's pan, a source's own focus) rather than always the middle.
//
// Two hard-won details, both about sampling rather than about maths:
//
//   - Every fetch uses textureSampleGrad with ANALYTIC derivatives. The implicit
//     ones are computed from the neighbouring fragment's final coordinate, and
//     the final coordinate here goes through `floor`/`fract` at the angular
//     seam. One quad straddling the seam therefore reports a derivative of
//     nearly a whole texture, the hardware selects the smallest mip, and a
//     blurred line is drawn down the image. This is the Pulse bug, it is in that
//     project's wiki, and it costs nothing to avoid: the derivative of the
//     UNWRAPPED coordinate is continuous everywhere and is four dot products.
//   - The angular seam still needs blending even with correct derivatives,
//     because the source is not periodic in x. Clamp-to-edge duplicates the edge
//     texel on both sides of the seam, which reads as a hairline. The band below
//     crossfades the two edges across the sub-pixel width of the seam, which is
//     what a periodic bilinear filter would have done.

// `struct Polar` and the `P` binding are prepended by `src/ops/polar.ts`, which
// is also where the matching `writeUniforms` lives. They are declared together
// there on purpose: a uniform struct and the code that packs it are one thing
// with two halves, and the halves drift apart the moment they live in two files.

const TAU : f32 = 6.283185307179586;

@vertex
fn vs(@builtin(vertex_index) vi : u32) -> @builtin(position) vec4<f32> {
  return fullscreenTriangle(vi);
}

/** |x| with the corner rounded over `e`. Exact for |x| >> e, and C1 at zero. */
fn softAbs(x : f32, e : f32) -> f32 {
  return sqrt(x * x + e * e) - e;
}

/**
 * Reflect `x` into `[0, period]`, both creases rounded over `e`.
 *
 * Identity on `[0, period]` to within O(e^2), so the common case — a coordinate
 * that never leaves the frame — is untouched. Used here to fold the unwrapped
 * sample position back inside the source rather than clamping it: clamping
 * smears the border texel into a streak, which is the one artefact that makes an
 * operator look broken rather than stylised.
 */
fn mirrorFold(x : f32, period : f32, e : f32) -> f32 {
  let p2 = 2.0 * period;
  let t = x - floor(x / p2) * p2 - period;
  return softAbs(softAbs(t, e) - period, e);
}

@fragment
fn fs(@builtin(position) frag : vec4<f32>) -> @location(0) vec4<f32> {
  let uv = fragUV(frag);
  let plain = textureSampleLevel(src, samp, uv, 0.0);

  // The input is the accumulator and may be a different size from this
  // attachment when the layer renders at reduced resolution, so texel widths
  // come from the SOURCE and screen-space derivatives from `C.resolution`.
  let sdim = vec2<f32>(textureDimensions(src));

  let centre = vec2<f32>(P.centreX, P.centreY);
  // Aspect correction on the way in and out, or the circle is an ellipse and
  // every radial thing built on top of it is sheared.
  let asp = vec2<f32>(C.aspect, 1.0);
  let zoom = max(P.zoom, 1.0e-4);

  var q : vec2<f32>;
  var ddx : vec2<f32>;
  var ddy : vec2<f32>;
  // Negative means "this path has no periodic seam". Only `wrap` does.
  var seamU = -1.0;

  if (P.direction < 0.5) {
    // ---- wrap: the SCREEN is polar, the SOURCE stays cartesian. -----------
    // Output (x, y) is read as (angle, radius) and fetched from the source at
    // (angle -> u, radius -> v). A bar chart along the bottom of the source
    // therefore lands on the rim; a scope line lands on a ring.
    let p = (uv - centre) * asp;
    let r2 = max(dot(p, p), 1.0e-12);
    let r = sqrt(r2);
    let a = atan2(p.y, p.x) + P.angle;

    var u = a / TAU;
    u = u - floor(u);
    // `minRadius` is the singularity guard. At r -> 0 the angular sampling rate
    // is unbounded — every source texel in one row competes for one screen pixel
    // — and the result is a screaming cluster of aliased colour at the origin.
    // Flooring the radius turns that into a smooth disc of the innermost ring.
    let v = clamp(max(r, P.minRadius) * 2.0 * zoom, 0.0, 1.0);
    q = vec2<f32>(u, v);

    // Analytic derivatives of (u, v) with respect to screen pixels. Continuous
    // through the seam, because they are taken before `u` is wrapped.
    let dpx = vec2<f32>(C.aspect / C.resolution.x, 0.0);
    let dpy = vec2<f32>(0.0, 1.0 / C.resolution.y);
    let dadp = vec2<f32>(-p.y, p.x) / r2;
    let drdp = p / r;
    let k = 2.0 * zoom;
    ddx = vec2<f32>(dot(dadp, dpx) / TAU, dot(drdp, dpx) * k);
    ddy = vec2<f32>(dot(dadp, dpy) / TAU, dot(drdp, dpy) * k);
    seamU = u;
  } else {
    // ---- unwrap: the SCREEN is cartesian, the SOURCE is read radially. ----
    // The inverse map. A circular scope straightens into a line, a tunnel
    // flattens into a strip. Useful on its own and essential as the way back
    // out of `wrap` when two polar layers are stacked.
    let a = (uv.x - 0.5) * TAU + P.angle;
    let r = uv.y * 0.5 / zoom;
    let dir = vec2<f32>(cos(a), sin(a));
    let raw = (dir * r) / asp + centre;

    let bx = 1.0 / sdim.x;
    let by = 1.0 / sdim.y;
    q = vec2<f32>(mirrorFold(raw.x, 1.0, bx), mirrorFold(raw.y, 1.0, by));

    // d(source)/d(angle) and d(source)/d(radius), then chain onto pixels.
    let dspdu = vec2<f32>(-dir.y, dir.x) * r * TAU;
    let dspdv = dir * (0.5 / zoom);
    ddx = (dspdu / C.resolution.x) / asp;
    ddy = (dspdv / C.resolution.y) / asp;
  }

  var mapped = textureSampleGrad(src, samp, q, ddx, ddy);

  if (seamU >= 0.0) {
    // The angular seam. `d` is the signed distance to it in u, and the band is
    // the seam's own width on screen — at least half a texel, so the blend never
    // collapses to nothing near the rim where the angular rate is lowest.
    let half = 0.5 / sdim.x;
    let band = max(P.seamPx * max(abs(ddx.x), abs(ddy.x)), half);
    let d = select(seamU - 1.0, seamU, seamU < 0.5);
    if (abs(d) < band) {
      let e0 = textureSampleGrad(src, samp, vec2<f32>(half, q.y), ddx, ddy);
      let e1 = textureSampleGrad(src, samp, vec2<f32>(1.0 - half, q.y), ddx, ddy);
      let t = clamp(d / (2.0 * band) + 0.5, 0.0, 1.0);
      let wrapped = mix(e1, e0, t);
      // Fade back to the ordinary fetch at the edges of the band so the join is
      // continuous rather than trading one hairline for another.
      mapped = mix(wrapped, mapped, clamp(abs(d) / band, 0.0, 1.0));
    }
  }

  // Opacity as a CROSSFADE against the untouched frame, not as a multiplier.
  // An operator that multiplied by `C.opacity` would fade the whole picture to
  // black rather than fading its own effect out, and "a layer at 0 is a true
  // no-op" (Phase 5 DoD) would be false in the most visible way possible. At
  // opacity 0 this returns `plain` exactly.
  return mix(plain, mapped, clamp(C.opacity, 0.0, 1.0));
}
