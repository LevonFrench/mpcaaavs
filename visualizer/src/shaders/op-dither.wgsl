// The `dither` operator — quantise the accumulated frame through an ordered
// threshold pattern.
//
// Independently authored from standard ordered-dither concepts. Bayer uses a
// bit-interleaved threshold; the clustered screen below uses crossed cosine
// fields rather than copied/reference-project coordinate or distance code.
//
// Why an OPERATOR and not a source: dithering is multiplicative. It transforms
// whatever came before it, so one pass gives a dithered version of all 17
// sources (plan §7 — sources add, operators multiply).
//
// Three patterns, and the differences are not cosmetic:
//
//   BAYER      an ordered 4x4 matrix. Even, neutral, no visible structure of
//              its own. The default, and the right one under motion because a
//              fixed threshold grid does not crawl.
//   HALFTONE   crossed diagonal cosine carriers cluster lit cells into dots
//              that grow with brightness. Print-like and deterministic.
//   NOISE      a hashed per-cell threshold. Grain rather than pattern. Seeded
//              from the layer, never from a clock, so a show replays identically
//              (§4.7) — an unseeded noise dither is the fastest way to break the
//              golden harness.
//
// Deliberately NOT here: Floyd-Steinberg. Error diffusion is inherently serial
// — each pixel's error feeds its neighbour — so it cannot be done in a fragment
// shader without a multi-pass scan, and a fake version that samples neighbours
// is just a blurry ordered dither wearing its name.
//
// ---------------------------------------------------------------------------
// BINDINGS ARE NOT DECLARED HERE. `ops/dither.ts` prepends PASS_COMMON_WGSL,
// passBindingsWGSL (supplying `src` and `samp`) and the `Dither` uniform.
// ---------------------------------------------------------------------------

const TAU : f32 = 6.28318530718;

/**
 * Ordered 4x4 Bayer threshold, normalised to (0,1).
 *
 * Written as arithmetic on the index rather than a matrix constant: the classic
 * matrix is the bit-reversed interleave of x and y, and expressing it that way
 * means the 8x8 variant is one more term rather than sixteen more numbers.
 */
fn bayer4(p : vec2<i32>) -> f32 {
  let x = u32(p.x) & 3u;
  let y = u32(p.y) & 3u;
  // Bit-reverse-interleave: the standard recursive Bayer construction.
  var v = 0u;
  v = v | (((y >> 1u) & 1u) << 0u);
  v = v | (((x >> 1u) & 1u) << 1u);
  v = v | ((y & 1u) << 2u);
  v = v | ((x & 1u) << 3u);
  return (f32(v) + 0.5) / 16.0;
}

/** Clustered-dot screen from two independent diagonal cosine carriers. */
fn halftone(cell : vec2<f32>) -> f32 {
  let a = 0.5 + 0.5 * cos(TAU * (cell.x + cell.y));
  let b = 0.5 + 0.5 * cos(TAU * (cell.x - cell.y));
  return clamp(1.0 - a * b, 0.0, 1.0);
}

fn hash21(p : vec2<f32>) -> f32 {
  var p3 = fract(vec3<f32>(p.xyx) * 0.1031);
  p3 = p3 + dot(p3, p3.yzx + 33.33);
  return fract((p3.x + p3.y) * p3.z);
}

@vertex
fn vs(@builtin(vertex_index) vi : u32) -> @builtin(position) vec4<f32> {
  return fullscreenTriangle(vi);
}

@fragment
fn fs(@builtin(position) frag : vec4<f32>) -> @location(0) vec4<f32> {
  let uv = fragUV(frag);
  let plain = textureSampleLevel(src, samp, uv, 0.0);

  // A true no-op at zero, and a CROSSFADE rather than a fade to black, so the
  // operator can be dialled in without darkening the frame.
  if (D.amount < 0.001) { return plain * C.opacity; }

  // Quantise position FIRST. Dithering a full-resolution image just makes
  // per-pixel noise; the pattern only reads once several output pixels share a
  // source sample. This is the step that makes it look like a screen.
  let px = max(D.cellPx, 1.0);
  let cell = floor(frag.xy / px);
  let snapUv = (cell + 0.5) * px / C.resolution;
  var col = textureSampleLevel(src, samp, snapUv, 0.0).rgb;

  // Tone-map before quantising, not after. The accumulator is HDR and a
  // threshold test against an unbounded value is meaningless — everything above
  // 1.0 quantises to "on" regardless of pattern, and the dither disappears
  // exactly where the image is most interesting.
  col = col / (1.0 + col);

  var t : f32;
  if (D.pattern < 0.5) {
    t = bayer4(vec2<i32>(cell));
  } else if (D.pattern < 1.5) {
    t = halftone(cell * D.screenScale);
  } else {
    // Seeded from the LAYER, not from time. A per-frame reseed would crawl and
    // would break byte-identical replay (§4.7).
    t = hash21(cell + vec2<f32>(C.seed * 0.017, C.seed * 0.031));
  }

  // Bias the threshold so `levels` steps land evenly, then quantise per channel.
  // Monochrome collapses to luminance first — the two look very different and
  // both are wanted, so it is a parameter rather than a decision made here.
  let steps = max(D.levels, 2.0);
  var q : vec3<f32>;
  if (D.mono > 0.5) {
    let lum = dot(col, vec3<f32>(0.2126, 0.7152, 0.0722));
    let v = floor(lum * (steps - 1.0) + t) / (steps - 1.0);
    q = vec3<f32>(clamp(v, 0.0, 1.0));
  } else {
    q = clamp(floor(col * (steps - 1.0) + t) / (steps - 1.0), vec3<f32>(0.0), vec3<f32>(1.0));
  }

  // Back out of the tone map so the result composites in the same space it
  // arrived in. Quantised values at 1.0 would otherwise divide by zero.
  let safe = min(q, vec3<f32>(0.999));
  var outCol = safe / (1.0 - safe);

  // Tint toward the layer's palette slot. The frame arrives in whatever colours
  // its sources used; a dither that ignores the palette is a dither that fights
  // it (art-direction §2.5, layers reference slots rather than hardcoding).
  outCol = mix(outCol, C.color.rgb * (safe.r + safe.g + safe.b) * 0.5, clamp(D.tint, 0.0, 1.0));

  return vec4<f32>(mix(plain.rgb, outCol, D.amount), plain.a) * C.opacity;
}
