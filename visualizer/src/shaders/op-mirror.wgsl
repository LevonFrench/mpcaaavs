// Mirror — 2/4/6/8-fold reflection of the accumulated frame about arbitrary
// axes, plus a plain horizontal and vertical mode.
//
// Plan §7 pairs this with the kaleidoscope, and art direction §1.1 explicitly
// allows a mirror in the Lab look where a kaleidoscope is "wrong". They are not
// the same operator and this file is not a subset of `kaleido.wgsl`:
//
//   - A KALEIDOSCOPE folds the frame into one wedge and replicates that wedge
//     everywhere. Whatever happens to be in the wedge becomes the entire image.
//   - A MIRROR reflects. `folds` reflection lines through the origin generate a
//     fundamental domain of 2*pi/folds, and the content of that domain keeps its
//     own orientation on the side it came from. Half the frame is untouched.
//
// The practical difference is that a mirror is legible at 2-fold — one axis,
// left half over right — which is a composition tool rather than an effect, and
// which a kaleidoscope cannot express at all.
//
// What it deliberately does NOT do: draw, tint, tile, or rotate content that it
// did not reflect. Rotation-plus-repeat is `tile`, and folding to a wedge is the
// kaleidoscope; keeping them apart is what stops all three converging into one
// unreadable parameter soup.
//
// Sampling, and the reason this file is longer than the maths:
//
//   - Every fetch is textureSampleGrad with derivatives taken from the
//     coordinate BEFORE the fold. A reflection preserves the magnitude of the
//     footprint and only flips its sign, so one output pixel is still one source
//     texel — but the implicit derivative is computed from the folded value,
//     which flips sign across the axis. A quad straddling the fold reports an
//     enormous derivative, the hardware picks the smallest mip, and a blurred
//     line is drawn down the mirror line. This bit Pulse and is documented in
//     its wiki. Explicit gradients cost two constants.
//   - The fold itself uses a rounded `abs`. A raw `abs` puts a
//     derivative-discontinuity exactly on a pixel row, which is an aliased
//     hairline by another name, and art direction bans those. `softAbs` rounds
//     the crease over `softenPx` pixels and is exact everywhere else.

// `struct Mirror` and the `M` binding are prepended by `src/ops/mirror.ts`,
// which is also where the matching `writeUniforms` lives. They are declared
// together there on purpose: a uniform struct and the code that packs it are one
// thing with two halves, and the halves drift apart the moment they live in two
// files.

const PI : f32 = 3.141592653589793;

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
 * Identity on `[0, period]` to within O(e^2), so a coordinate that never leaves
 * its domain is untouched — which matters, because the whole claim of this
 * operator is that half the frame passes through unmodified.
 *
 * Used twice: once on the angle to build the N-fold group, and once on the final
 * uv so that content pulled from outside the frame reflects back in rather than
 * clamping. Clamp-to-edge on an out-of-range fetch smears the border texel into
 * a radial streak, which reads as a bug.
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

  // Texel widths from the SOURCE (the accumulator, possibly a different size
  // from this attachment when the layer renders scaled); screen-space steps from
  // `C.resolution`.
  let sdim = vec2<f32>(textureDimensions(src));
  let bx = 1.0 / sdim.x;
  let by = 1.0 / sdim.y;

  let soften = max(M.softenPx, 0.0);
  let ex = soften / C.resolution.x;
  let ey = soften / C.resolution.y;

  // One output pixel is one source texel, in both directions, regardless of how
  // the coordinate is folded afterwards. See the header.
  let ddx = vec2<f32>(1.0 / C.resolution.x, 0.0);
  let ddy = vec2<f32>(0.0, 1.0 / C.resolution.y);

  var q = uv;

  if (M.mode < 0.5) {
    // ---- N-fold about an origin -------------------------------------------
    // `axes` reflection lines spaced pi/axes apart generate a dihedral group
    // whose fundamental domain is pi/axes wide, i.e. 2*pi/folds. Folding the
    // angle into that domain IS applying those reflections; doing it in one
    // `mirrorFold` rather than a loop is the same map with no branches.
    //
    // Aspect-corrected, or the axes are not perpendicular where they should be
    // and a 4-fold mirror comes out skewed.
    let origin = vec2<f32>(M.posX, M.posY);
    let asp = vec2<f32>(C.aspect, 1.0);
    let p = (uv - origin) * asp;
    let r = length(p);
    let w = PI / max(M.axes, 1.0);
    let a = atan2(p.y, p.x) - M.angle;

    // `soften` is in pixels and the fold is in radians, so convert at this
    // radius: one aspect-corrected unit spans `C.resolution.y` pixels. Near the
    // origin this widens without bound, which is correct — that is exactly where
    // the creases converge and where an unrounded fold aliases worst.
    let eA = soften / max(r * C.resolution.y, 1.0e-4);
    let a2 = mirrorFold(a, w, eA) + M.angle;

    q = (vec2<f32>(cos(a2), sin(a2)) * r) / asp + origin;
  } else if (M.mode < 1.5) {
    // ---- horizontal: reflect across a VERTICAL line, left-right symmetry ---
    // `flip` chooses which half survives. Default (-1) keeps the left half: for
    // uv.x < posX the map is the identity, and beyond it the coordinate walks
    // back the way it came.
    let s = select(-1.0, 1.0, M.flip > 0.5);
    q.x = M.posX + s * softAbs(uv.x - M.posX, ex);
  } else {
    // ---- vertical: reflect across a HORIZONTAL line, top-bottom symmetry ---
    let s = select(-1.0, 1.0, M.flip > 0.5);
    q.y = M.posY + s * softAbs(uv.y - M.posY, ey);
  }

  // Fold anything that left the frame back inside. Identity to O(texel^2) for
  // coordinates that never did, so the untouched half stays untouched.
  q = vec2<f32>(mirrorFold(q.x, 1.0, bx), mirrorFold(q.y, 1.0, by));

  let mapped = textureSampleGrad(src, samp, q, ddx, ddy);

  // Opacity as a CROSSFADE against the untouched frame, not as a multiplier —
  // see the same note in `op-polar.wgsl`. At opacity 0 this returns `plain`
  // exactly, which is what makes a mirror at progress 0 a true no-op rather than
  // a cheap one (Phase 5 DoD).
  return mix(plain, mapped, clamp(C.opacity, 0.0, 1.0));
}
