// The ten blend modes of plan §4.1 as WGSL, plus the composite pass that
// resolves the ones fixed-function blending cannot express.
//
// Nine of the ten ARE expressible as a `GPUBlendState` and the hardware should
// do them — see `blend.ts` for which, and why. This file exists for the tenth
// (`xor`), for the perceptual variants of the two crossfade modes, and so that
// there is exactly one written-down definition of what each mode MEANS. A blend
// mode implemented twice, once as a blend state and once in a shader, is a mode
// that drifts: the two agree until someone changes one of them, and the symptom
// is a preset that looks different depending on whether it happened to take the
// scratch-target path. The functions below are the reference; the blend states
// in `blend.ts` are the fast path that must match them.
//
// What this file deliberately does NOT do:
//
//   - It does not declare `Common`, `fullscreenTriangle` or `fragUV`. Prepend
//     `PASS_COMMON_WGSL` from `renderer.ts`, exactly as every other pass does.
//     `blend.ts` exposes `blendCompositeWGSL(common)` so no caller has to
//     remember.
//   - It does not decide WHEN a shader composite runs. `layers.ts` charges the
//     scratch target and the extra pass; `renderer.ts` encodes it.
//   - It does not tone map, clamp to display range, or otherwise have an
//     opinion about output. Everything here stays in linear HDR because
//     everything upstream is `rgba16float` and freely exceeds 1.0 (§3.2), and
//     `present.wgsl` owns display space alone.

// ---------------------------------------------------------------------------
// Bindings
//
// These numbers mirror `PASS_BINDING` in `renderer.ts` — `input`, `sampler`,
// `history`. They are written as literals rather than interpolated from the
// TypeScript constant because `blend.ts` must not import `renderer.ts`:
// `renderer.ts` imports `layers.ts`, and `layers.ts` is where the blend table
// belongs, so an import in that direction closes a cycle. If `PASS_BINDING`
// ever moves, these move with it; `blend.ts` re-states the numbers so a change
// fails loudly in one place instead of silently sampling the wrong texture.
//
// `src` is the layer's finished output (the scratch target, or a feedback
// layer's own history). `dst` is the accumulator. Both are inputs, which is the
// entire reason a shader blend costs a whole extra pass: a WebGPU render pass
// may not sample the attachment it is writing.
// ---------------------------------------------------------------------------

@group(0) @binding(1) var src  : texture_2d<f32>;
@group(0) @binding(2) var samp : sampler;
@group(0) @binding(3) var dst  : texture_2d<f32>;

// ---------------------------------------------------------------------------
// The mode constant
//
// A WebGPU pipeline-overridable constant, not a uniform. Two reasons, and the
// second is the one that matters:
//
//   1. The mode is per-pipeline anyway. `renderer.ts` already keys its pipeline
//      cache on the blend, so one specialised module per mode costs nothing
//      after the first frame and lets the compiler fold the switch away.
//   2. It needs NO extra binding. The renderer's composite bind group is
//      (common, input, sampler, history) with no params buffer, and a shader
//      that declares a binding its explicit layout does not have fails to
//      create. An override keeps this file drop-in for the existing composite.
//
// The default is `xor` (id 7) precisely so that a caller who passes no
// constants at all gets the behaviour the composite path has today.
//
// `BLEND_MIX` is the `adjustable` amount. Being an override it is baked at
// pipeline creation, so animating it smoothly means either quantising it (a
// pipeline per distinct value) or adding a params binding — which is a one-line
// change here. In practice `adjustable` is fixed-function and never reaches
// this file unless the perceptual variant was asked for deliberately.
// ---------------------------------------------------------------------------

override BLEND_MODE : u32 = 7u;
override BLEND_MIX  : f32 = 0.5;

// ---------------------------------------------------------------------------
// OKLab
//
// Factored out of `points.wgsl`, which had `oklabToLinear` on its own. This is
// now the one copy; anything that needs it prepends this file or is given these
// functions by `blend.ts`.
//
// Why it is here and not in a colour module of its own: the only operations in
// the engine that INTERPOLATE two colours are the crossfade blends, and
// interpolating two hues in linear sRGB walks a straight line through the
// middle of the cube — which desaturates on the way past and is the grey
// dead-zone art-direction §2.1 bans. OKLab's straight line is a perceptual one
// and stays saturated. Everything else here (add, max, min, subtract, multiply,
// alpha) is light transport or coverage, where linear IS the physically correct
// answer and converting to a perceptual space would be actively wrong.
// ---------------------------------------------------------------------------

/**
 * Cube root that survives a negative argument. `pow(x, 1/3)` is NaN for x < 0,
 * and negative linear values are not hypothetical — `subtract` produces them,
 * and one NaN pixel propagates through every subsequent feedback frame.
 */
fn cbrtSigned(x : f32) -> f32 {
  return sign(x) * pow(abs(x), 0.3333333333);
}

/** Linear sRGB -> OKLab. Ottosson's matrices; unbounded, so HDR passes through. */
fn linearToOklab(c : vec3<f32>) -> vec3<f32> {
  let l = 0.4122214708 * c.r + 0.5363325363 * c.g + 0.0514459929 * c.b;
  let m = 0.2119034982 * c.r + 0.6806995451 * c.g + 0.1073969566 * c.b;
  let s = 0.0883024619 * c.r + 0.2817188376 * c.g + 0.6299787005 * c.b;
  let l_ = cbrtSigned(l);
  let m_ = cbrtSigned(m);
  let s_ = cbrtSigned(s);
  return vec3<f32>(
    0.2104542553 * l_ + 0.7936177850 * m_ - 0.0040720468 * s_,
    1.9779984951 * l_ - 2.4285922050 * m_ + 0.4505937099 * s_,
    0.0259040371 * l_ + 0.7827717662 * m_ - 0.8086757660 * s_,
  );
}

/** OKLab -> linear sRGB. The inverse of the above, character for character. */
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

/**
 * Perceptual mix of two LINEAR sRGB colours.
 *
 * Clamped at zero on the way out and NOT at one: a mix of two in-gamut colours
 * can land marginally outside sRGB, and negative light is meaningless, but the
 * headroom above 1.0 is what bloom looks for (art-direction §2.4) and crushing
 * it here would quietly cost the focal element its focus.
 */
fn oklabMix(a : vec3<f32>, b : vec3<f32>, t : f32) -> vec3<f32> {
  let lab = mix(linearToOklab(a), linearToOklab(b), t);
  return max(oklabToLinear(lab), vec3<f32>(0.0));
}

// ---------------------------------------------------------------------------
// The modes
//
// `s` is the source (the layer), `d` the destination (the accumulator). Each
// function is the exact arithmetic of the matching `GPUBlendState` in
// `blend.ts`, including its alpha channel — the alpha component of a blend
// state is separately specified and is where a mode most often goes quietly
// wrong, because nothing on screen changes until something later reads alpha.
// ---------------------------------------------------------------------------

/** Source only. The destination is discarded. */
fn blendReplace(s : vec4<f32>, d : vec4<f32>) -> vec4<f32> {
  return s;
}

/** S + D. On rgba16float this genuinely accumulates rather than clipping at 1. */
fn blendAdd(s : vec4<f32>, d : vec4<f32>) -> vec4<f32> {
  return s + d;
}

/** max(S, D), per channel. */
fn blendMax(s : vec4<f32>, d : vec4<f32>) -> vec4<f32> {
  return max(s, d);
}

/** min(S, D), per channel. */
fn blendMin(s : vec4<f32>, d : vec4<f32>) -> vec4<f32> {
  return min(s, d);
}

/**
 * D - S. The source DARKENS what is underneath, which is AVS's semantics and
 * the reason the blend state uses `reverse-subtract` rather than `subtract`
 * (which is S - D and looks like an inverted layer). Alpha is left alone.
 */
fn blendSubtract(s : vec4<f32>, d : vec4<f32>) -> vec4<f32> {
  return vec4<f32>(d.rgb - s.rgb, d.a);
}

/** S * D, per channel. */
fn blendMultiply(s : vec4<f32>, d : vec4<f32>) -> vec4<f32> {
  return vec4<f32>(s.rgb * d.rgb, s.a * d.a);
}

/**
 * Bitwise XOR of both sides quantised to 16 bits.
 *
 * The quantisation is arbitrary but it has to be SOMETHING: a bitwise XOR of
 * two floats is not a defined image operation, so the mode only means anything
 * once both sides are integers. 16 bits matches the target's storage and makes
 * the low-bit interference pattern fine enough to read as texture rather than
 * as banding.
 *
 * Values above 1.0 are CLAMPED, not wrapped. Wrapping HDR headroom into the low
 * bits turns a bright highlight into full-amplitude noise, which reads as a
 * broken effect rather than a stylised one.
 *
 * Alpha takes the union of coverage — XORing alpha would punch holes in the
 * frame wherever both layers happened to be opaque.
 */
fn blendXor(s : vec4<f32>, d : vec4<f32>) -> vec4<f32> {
  let qs = vec3<u32>(clamp(s.rgb, vec3<f32>(0.0), vec3<f32>(1.0)) * 65535.0);
  let qd = vec3<u32>(clamp(d.rgb, vec3<f32>(0.0), vec3<f32>(1.0)) * 65535.0);
  return vec4<f32>(vec3<f32>(qs ^ qd) / 65535.0, max(s.a, d.a));
}

/**
 * t*S + (1-t)*D, mixed through OKLab.
 *
 * This is the one place the perceptual space earns its keep and the one place
 * this file DIVERGES from its own fixed-function equivalent. The blend state
 * for `50/50` and `adjustable` mixes in linear light, because that is all the
 * hardware can do; magenta crossfading to cyan through linear light passes
 * through a washed-out near-white, and through OKLab it walks the hues. The
 * divergence is deliberate and is why `blend.ts` marks these modes
 * `wgslIsPerceptual` — a caller choosing the shader path is choosing the better
 * image at the cost of a pass, and must not be surprised that it looks
 * different.
 *
 * Alpha is mixed linearly regardless. Alpha is coverage, not colour, and there
 * is no perceptual space for "how much of this pixel exists".
 */
fn blendMixPerceptual(s : vec4<f32>, d : vec4<f32>, t : f32) -> vec4<f32> {
  return vec4<f32>(oklabMix(d.rgb, s.rgb, t), mix(d.a, s.a, t));
}

/**
 * Straight (non-premultiplied) source-over.
 *
 * Linear, not perceptual, and that is not an oversight: `alpha` is an occlusion
 * operator. The source is IN FRONT of the destination and covers `s.a` of the
 * pixel; the result is a weighted sum of light arriving from two places, which
 * is a linear-light quantity. Mixing it through OKLab would make a half-covered
 * edge a different colour from the average of the two things either side of it,
 * and every antialiased edge in the frame would acquire a fringe.
 *
 * Alpha accumulates with `S + D*(1-S)` so compositing two partly transparent
 * layers builds coverage correctly rather than saturating.
 */
fn blendAlpha(s : vec4<f32>, d : vec4<f32>) -> vec4<f32> {
  return vec4<f32>(
    s.rgb * s.a + d.rgb * (1.0 - s.a),
    s.a + d.a * (1.0 - s.a),
  );
}

/**
 * Dispatch. `mode` is the id from `BLEND_MODE_ID` in `blend.ts` — the ids are
 * the declaration order of plan §4.1 and are baked into pipeline constants, so
 * they are stable numbers and not a free choice.
 *
 * Written as assignments into a `var` rather than a `return` per case because
 * WGSL's uniformity analysis is happier with a single exit and because a
 * missing `default` is a compile error worth having exactly once, here, rather
 * than at every call site.
 */
fn blendApply(mode : u32, s : vec4<f32>, d : vec4<f32>, t : f32) -> vec4<f32> {
  var out = s;
  switch (mode) {
    case 0u:  { out = blendReplace(s, d); }
    case 1u:  { out = blendAdd(s, d); }
    case 2u:  { out = blendMax(s, d); }
    case 3u:  { out = blendMin(s, d); }
    case 4u:  { out = blendMixPerceptual(s, d, 0.5); }
    case 5u:  { out = blendSubtract(s, d); }
    case 6u:  { out = blendMultiply(s, d); }
    case 7u:  { out = blendXor(s, d); }
    case 8u:  { out = blendMixPerceptual(s, d, t); }
    case 9u:  { out = blendAlpha(s, d); }
    default:  { out = blendReplace(s, d); }
  }
  return out;
}

// ---------------------------------------------------------------------------
// The composite pass
// ---------------------------------------------------------------------------

@vertex
fn vs(@builtin(vertex_index) vi : u32) -> @builtin(position) vec4<f32> {
  return fullscreenTriangle(vi);
}

/**
 * Writes the finished composite with `replace` blend state, so the whole result
 * — including the layer's opacity — has to be produced here.
 *
 * Opacity is a CROSSFADE back to the untouched destination, not a scale on the
 * source. Scaling the source is what the fixed-function path does (every pass
 * multiplies its output by `C.opacity`), and for half these modes it is simply
 * the wrong operation: a `min` layer at opacity 0 would scale its source to
 * black and min(D, 0) is black, so fading the layer out would fade the whole
 * frame out. Crossfading makes opacity 0 a true no-op for every mode, which is
 * a Phase 5 DoD and not a nicety. `blend.ts` records per mode which of the two
 * the fixed-function path can get away with.
 */
@fragment
fn fs(@builtin(position) frag : vec4<f32>) -> @location(0) vec4<f32> {
  let uv = fragUV(frag);
  let s = textureSampleLevel(src, samp, uv, 0.0);
  let d = textureSampleLevel(dst, samp, uv, 0.0);
  return mix(d, blendApply(BLEND_MODE, s, d, BLEND_MIX), C.opacity);
}
