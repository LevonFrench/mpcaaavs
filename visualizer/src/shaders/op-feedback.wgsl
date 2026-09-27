// The feedback operator — zoom, rotate, offset and decay of a layer's own
// previous output.
//
// This is the mechanism behind AVS's liquid depth (plan §2): a warp applied to
// the ACCUMULATED frame, recursively, forever. One pass; the recursion is the
// ping-pong the renderer hands us in `hist`.
//
// What this shader deliberately does NOT do:
//   - It does not composite itself onto the accumulator. `planStack` emits a
//     separate entry for that, which is what lets a feedback layer carry any
//     blend mode at all (layers.ts §"Pass and target allocation").
//   - It does not decide its own rates. Every number in `FeedbackParams`
//     arrives already converted from BEATS at the live tempo by
//     `ops/feedback.ts`. There is no `time * 0.37` here and there must never be
//     (art direction §3.1).
//   - It does not multiply the retained history by `C.opacity`, and that is the
//     one place it knowingly departs from `PASS_COMMON_WGSL`'s house rule. See
//     the note above `inject` below — it matters, and it compounds.

// Byte-for-byte with `writeUniforms` in ops/feedback.ts. No vec3, ever:
//   0  keep   4  inject   8  zoom   12 rot
//   16 offset.xy          24 centre.xy
//   32 knee   36 ceiling  40 edge   44 aspect      -> size 48
struct FeedbackParams {
  /** exp(-dtBeats / tauBeats). 1.0 when the transport is paused, so a trail holds. */
  keep    : f32,
  /**
   * How much of the frame beneath enters the trail THIS frame, opacity applied.
   *
   * Already scaled by (1 - keep) on the CPU, which is what makes the steady
   * state independent of frame rate. An accumulator with retention k reaches
   * B/(1-k); at 165 fps and a short tau that multiplier is ~36x, and a
   * per-frame contribution tuned as if each frame stood alone whites the frame
   * out in about a second. It has already happened once here.
   */
  inject  : f32,
  /** Magnification of the previous frame per FRAME. 1.0 is pure fade, no motion. */
  zoom    : f32,
  /** Radians of rotation per frame. Derived from turns per BAR. */
  rot     : f32,
  /** Translation per frame, in aspect-corrected half-widths. */
  offset  : vec2<f32>,
  /** Warp origin in uv. Feedback is art direction §4.1's deliberate exception: a centre IS the mechanism. */
  centre  : vec2<f32>,
  /** Soft clip starts here. Below it the transfer curve is exactly identity. */
  knee    : f32,
  /** Asymptote of the soft clip. Loud passages roll off towards it, never flat-top onto it. */
  ceiling : f32,
  /** Border fade width in uv. Stops a clamped edge texel smearing into a streak. */
  edge    : f32,
  aspect  : f32,
};

@group(PASS_GROUP_PLACEHOLDER) @binding(PASS_PARAMS_PLACEHOLDER) var<uniform> P : FeedbackParams;

@vertex
fn vs(@builtin(vertex_index) vi : u32) -> @builtin(position) vec4<f32> {
  return fullscreenTriangle(vi);
}

/**
 * Fade towards the border instead of relying on clamp-to-edge.
 *
 * The sampler clamps, so a warp that reads outside [0,1] returns the edge texel
 * — and a feedback loop re-reading its own edge texel every frame stretches it
 * into a hard radial streak within a second or two. Fading to nothing instead
 * means material that leaves the frame simply leaves.
 *
 * `smoothstep` is undefined when edge0 >= edge1 (Pulse learned that one twice),
 * so `edge` is clamped away from zero on the CPU and again here.
 */
fn borderMask(uv : vec2<f32>) -> f32 {
  let e = max(P.edge, 1.0e-4);
  let d = min(min(uv.x, 1.0 - uv.x), min(uv.y, 1.0 - uv.y));
  return smoothstep(0.0, e, d);
}

/**
 * Soft clip, applied to the PEAK channel so hue survives.
 *
 * Clipping per channel drags anything loud towards white, which is both a hue a
 * third layer did not ask for (art direction §2.2 — three hues, maximum) and a
 * flat-topped highlight that reads as broken rather than bright. Scaling the
 * whole triple by one factor keeps the ratio between channels exactly.
 *
 * The curve is knee + head * (1 - exp(-over/head)): value and first derivative
 * are both continuous at the knee, so there is no visible crease where the roll
 * off begins, and it approaches `ceiling` without ever reaching it.
 */
fn softClip(c : vec3<f32>) -> vec3<f32> {
  let peak = max(max(c.r, c.g), c.b);
  if (peak <= P.knee) { return c; }
  let head = max(P.ceiling - P.knee, 1.0e-4);
  let rolled = P.knee + head * (1.0 - exp(-(peak - P.knee) / head));
  return c * (rolled / max(peak, 1.0e-6));
}

@fragment
fn fs(@builtin(position) frag : vec4<f32>) -> @location(0) vec4<f32> {
  let uv = fragUV(frag);
  let stretch = vec2<f32>(P.aspect, 1.0);

  // The INVERSE warp. The image is to appear zoomed by `zoom` and rotated by
  // `rot`, so this fragment reads the history at the position that material has
  // just moved FROM — divide by the zoom, rotate the other way.
  //
  // All of it in aspect-corrected space, or a rotation shears and a zoom turns
  // circles into ellipses on a non-square canvas.
  var q = (uv - P.centre) * stretch;
  let cs = cos(P.rot);
  let sn = sin(P.rot);
  q = vec2<f32>(q.x * cs + q.y * sn, -q.x * sn + q.y * cs);
  q = q / max(P.zoom, 1.0e-4);
  q = q - P.offset;
  let huv = q / stretch + P.centre;

  // One bilinear tap. This is the line plan §2 is talking about when it lists
  // "bilinear feedback, sub-pixel stable" as a way we beat AVS: AVS resampled
  // its feedback nearest-neighbour, so any drift below half a texel per frame
  // quantised to no motion at all and the image locked to the pixel grid in
  // visible steps. A filtered tap moves by fractions of a texel, which is what
  // makes a slow zoom read as continuous rather than as a stack of jumps.
  let h = textureSampleLevel(hist, samp, huv, 0.0);

  // Retention is NOT multiplied by C.opacity, deliberately. Opacity is folded
  // into `inject` on the CPU instead. Applying it here too would multiply the
  // trail by opacity once per frame — opacity^n after n frames — so any value
  // below 1 would erase the trail entirely within a second while looking, for
  // the first few frames, like it was merely dimmer.
  var acc = h * (P.keep * borderMask(huv));

  // The frame beneath, entering the trail. `src` is the accumulator; a feedback
  // layer at the bottom of the stack gets a cleared one, which is correct.
  acc = acc + textureSampleLevel(src, samp, uv, 0.0) * P.inject;

  return vec4<f32>(softClip(acc.rgb), min(acc.a, 1.0));
}
