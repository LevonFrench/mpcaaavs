// Chladni figures. Plan §8.6 — "the most audio-native visual there is".
//
// Look: LAB (art-direction §1.1). The document lists Chladni in Lab's source set
// and it belongs there for a reason: a Chladni figure is a MEASUREMENT. Sand on a
// bowed plate settles on the nodal lines of a standing wave, so what you are
// looking at is the shape of a frequency, drawn by physics rather than by taste.
// Thin bright lines on near-black, no fill, one hue. Lab's discipline — one line,
// drawn well — is the whole brief.
//
// The field is the square-plate mode superposition:
//
//     f(x, y) = cos(n*pi*x)*cos(m*pi*y) - cos(m*pi*x)*cos(n*pi*y)
//
// and the picture is its ZERO SET. Note the antisymmetry: swapping n and m negates
// f, and n == m makes it identically zero — the whole plate becomes a nodal line
// and the frame goes white. `chladni.ts` guarantees n != m; this shader does not
// re-check it, because a shader that silently repairs its uniforms hides the bug
// in the module that packed them.
//
// n and m arrive as INTEGERS, quantised on a clock division by the CPU. That is
// not a rounding convenience: the modes of a plate are discrete, so a fractional
// n is not a quieter version of the figure, it is a figure that does not exist.
// Interpolating between two mode numbers smears the two patterns over each other
// for the whole crossfade and reads as a wash of noise rather than as a shape
// changing. Snapping on a musical boundary means the plate visibly re-settles
// with the music, which is what the mechanism actually is.
//
// Two things this file spends its length on and the naive version does not:
//
//   - Distance, not magnitude. Thresholding |f| directly gives a line whose width
//     varies wildly with the local gradient — hairline where the field is steep,
//     a fat blob near a saddle. |f| / |grad f| is a first-order distance estimate
//     to the zero set, and dividing by `fwidth(f)` gives that distance in
//     FRAGMENTS, which is the unit a line width should be specified in. It is the
//     same analytic-AA argument as §4.5, applied to an implicit curve.
//   - Varying weight (art-direction §4.4). Weight rides the air band and the
//     local flatness of the field, so the line thickens where the plate is
//     lazily excited and where the music is bright. A constant stroke reads
//     machine-drawn.
//
// It deliberately does NOT fill the antinodes, tint by mode number, or draw the
// plate's border. The colour is `C.color` — the layer's palette slot — because a
// source that names its own hue breaks the three-hue rule from outside the
// palette (§2.2).

struct Params {
  n         : f32,   // mode number, INTEGRAL. Quantised on a clock division.
  m         : f32,   // the other mode number. Never equal to n — see the header.
  halfPx    : f32,   // half stroke width, in FRAGMENTS of the attachment
  size      : f32,   // plate half-extent in unit-y
  centreX   : f32,   // unit space, off-centre by default (art-direction §4.1)
  centreY   : f32,
  excite    : f32,   // 0..1, decaying from the last division boundary
  weightVar : f32,   // 0 = uniform stroke (do not), 1 = strongly varying
  spin      : f32,   // radians, from a clock division. Never wall-clock (§3.1)
  _pad0     : f32,
  _pad1     : f32,
  _pad2     : f32,
};

const PI = 3.14159265359;

/**
 * The field. `p` is plate coordinates in [0,1]^2 — the classical statement of the
 * square-plate mode, kept in exactly the form §8.6 writes it so the two can be
 * compared without translating between conventions.
 */
fn chladni(p : vec2<f32>) -> f32 {
  let a = P.n * PI;
  let b = P.m * PI;
  return cos(a * p.x) * cos(b * p.y) - cos(b * p.x) * cos(a * p.y);
}

@vertex
fn vs(@builtin(vertex_index) vi : u32) -> @builtin(position) vec4<f32> {
  return fullscreenTriangle(vi);
}

@fragment
fn fs(@builtin(position) frag : vec4<f32>) -> @location(0) vec4<f32> {
  let uv = fragUV(frag);

  // Unit space: y in [-1,1], x in [-aspect, aspect], y up. Isotropic, which is
  // what keeps the plate square at any aspect without a divide in every term.
  let unit = vec2<f32>((uv.x * 2.0 - 1.0) * C.aspect, 1.0 - uv.y * 2.0);
  let d = unit - vec2<f32>(P.centreX, P.centreY);

  // Rotate the PLATE, not the field. Rotating inside `chladni` would shear the
  // mode itself into something that is no longer a solution.
  let cs = cos(P.spin);
  let sn = sin(P.spin);
  let rot = vec2<f32>(d.x * cs + d.y * sn, -d.x * sn + d.y * cs);
  let q = rot / max(P.size, 1e-4);              // plate coords, -1..1

  let f = chladni(q * 0.5 + vec2<f32>(0.5, 0.5));

  // Every derivative in this shader is taken HERE, at the top level, in uniform
  // control flow. A derivative under a branch that depends on the fragment's own
  // position is undefined, and the symptom is AA that works everywhere except
  // exactly at the edges it was added for.
  let g = max(fwidth(f), 1e-6);
  let edge = max(abs(q.x), abs(q.y));
  let ge = max(fwidth(edge), 1e-5);

  // Distance to the zero set, in fragments.
  let dist = abs(f) / g;

  // Reference gradient: the field's dominant spatial frequency is ~(n+m)/2 cycles
  // across the plate, and the plate spans `size * resolution.y` fragments. Where
  // the true gradient is below this the field is locally flat — a shallow node,
  // where a real plate piles the most sand — so the line widens there. Clamped
  // hard: this is a look, not a simulation, and an unclamped ratio at a saddle
  // point goes to infinity and fills the frame.
  let platePx = max(P.size * C.resolution.y, 1.0);
  let gRef = max((P.n + P.m) * 0.5 * PI / platePx, 1e-6);
  let flat = clamp(sqrt(gRef / g), 0.7, 1.8);

  // Air rides the stroke so hats read as a thickening of the line rather than as
  // a separate flashing thing (art-direction §3.3).
  let audioW = 1.0 + P.weightVar * (0.9 * bandAt(4u) + 0.5 * A.level - 0.35);
  var halfW = P.halfPx * flat * max(audioW, 0.25);

  // Sub-pixel width. Below half a fragment the line does not get thinner, it gets
  // INTERMITTENT — whether a given stretch lands on a sample point becomes luck,
  // and a quiet plate sparkles instead of staying quiet. Clamp the width and let
  // the alpha carry the remainder. Same treatment as `src-scope.wgsl`.
  let fade = clamp(halfW / 0.5, 0.0, 1.0);
  halfW = max(halfW, 0.5);

  let cov = 1.0 - smoothstep(halfW - 0.5, halfW + 0.5, dist);

  // Phosphor shoulder: bright core, soft falloff across the width. A flat-topped
  // stroke bands visibly wherever nodal lines cross, and on a Chladni figure they
  // cross constantly.
  let across = dist / halfW;
  let core = 0.30 + 0.70 * exp(-across * across * 2.4);

  // The plate has an edge, and it is a hard one — outside it there is no plate,
  // not a faded one. Antialiased, then multiplied in rather than branched on, so
  // the derivatives above stay uniform.
  let plate = 1.0 - smoothstep(1.0 - ge, 1.0, edge);

  // The strike. `excite` decays from the last division boundary, so the figure
  // does not merely change on the beat, it visibly re-settles — which is what a
  // bowed plate does and is the only reason to quantise in the first place.
  let glow = 0.55 + 0.55 * A.level + 0.9 * P.excite;

  let a = cov * fade * plate * C.opacity;
  return vec4<f32>(C.color.rgb * core * glow * a, a);
}
