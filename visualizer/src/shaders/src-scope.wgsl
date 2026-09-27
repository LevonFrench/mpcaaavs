// Oscilloscope: line, circular and Lissajous/vectorscope. Plan §8.1.
//
// Look: LAB (art-direction §1.1) — one line, drawn well, on near-black. Which is
// why this file spends most of its length on the line and none of it on fill.
//
// Geometry is a quad per segment, indexed straight out of `vertex_index` with no
// vertex buffer, exactly as `points.wgsl` does. Three things the naive version of
// this shader gets wrong and this one does not:
//
//   - Joins. A per-segment quad built from the segment normal alone leaves a
//     wedge-shaped gap on every outside corner, and a scope at 512 segments is
//     512 corners. Each endpoint is therefore offset along the MITER of its two
//     adjacent segments, with the miter length clamped — an unclamped miter at a
//     hairpin goes to infinity and fires one spike across the whole frame.
//   - Sub-pixel width. A half-width below half a pixel does not draw a thin
//     line, it draws a dashed one, because whether a given segment lands on a
//     sample point becomes luck. The width is clamped to one pixel and the
//     ALPHA carries the remainder instead, which is what keeps a quiet scope
//     quiet rather than sparkly.
//   - Uniform stroke. Weight varies with local amplitude and with the air band
//     (art-direction §4.4); a constant stroke reads machine-drawn.
//
// It deliberately does NOT: fill, glow beyond the stroke's own shoulder, or pick
// a colour. The colour is `C.color` — the layer's palette slot — because a source
// that names its own hue is a source that breaks the three-hue rule from outside
// the palette (§2.2).

struct Params {
  mode      : f32,   // 0 line, 1 circular, 2 Lissajous
  gain      : f32,   // amplitude scale
  halfWidth : f32,   // half stroke width, in unit-y (see the space note below)
  segments  : f32,
  radius    : f32,   // circular base radius / Lissajous extent
  centreX   : f32,   // unit space. Off-centre by default — art-direction §4.1
  centreY   : f32,
  spread    : f32,   // half the line-mode horizontal extent, aspect-corrected on the CPU
  weightVar : f32,   // 0 = uniform stroke (do not), 1 = strongly varying
  window    : f32,   // fraction of the waveform window traversed
  spin      : f32,   // radians, from a clock division. Never wall-clock (§3.1)
  _pad0     : f32,
};

const TAU = 6.28318530718;

// Everything below works in UNIT space: y in [-1,1], x in [-aspect, aspect].
// Clip space is `vec2(p.x / C.aspect, p.y)`. Keeping the two apart is what makes
// a circle round and a Lissajous square without every expression carrying an
// aspect divide of its own.

fn toClip(p : vec2<f32>) -> vec4<f32> {
  return vec4<f32>(p.x / max(C.aspect, 1e-4), p.y, 0.0, 1.0);
}

/** Path parameter, wrapped for the closed (circular) path and clamped otherwise. */
fn pathT(t : f32) -> f32 {
  if (P.mode > 0.5 && P.mode < 1.5) { return fract(t + 1.0); }
  return clamp(t, 0.0, 1.0);
}

fn scopePoint(t : f32) -> vec2<f32> {
  let s = waveAt(t * P.window);
  let mono = (s.x + s.y) * 0.5;
  let c = vec2<f32>(P.centreX, P.centreY);

  if (P.mode < 0.5) {
    // Line. `spread` already carries the aspect, so the trace spans the frame.
    return c + vec2<f32>((t - 0.5) * 2.0 * P.spread, mono * P.gain);
  }
  if (P.mode < 1.5) {
    // Circular: radius = 1 + v. The spin comes from a clock division, so the
    // figure rotates WITH the music rather than at some chosen constant.
    let a = t * TAU + P.spin;
    let r = P.radius * (1.0 + mono * P.gain);
    return c + vec2<f32>(cos(a), sin(a)) * r;
  }
  // Lissajous / vectorscope: x = L, y = R. This is the one mode that genuinely
  // needs true stereo, which is why stereo was a Phase 0 requirement rather than
  // a refinement — from a mono sum it collapses to the line y = x and says
  // nothing at all.
  return c + vec2<f32>(s.x, s.y) * P.gain * P.radius;
}

/** Stroke weight and brightness at t. Returns (weight multiplier, glow multiplier). */
fn strokeAt(t : f32) -> vec2<f32> {
  let s = waveAt(t * P.window);
  let amp = abs(s.x + s.y) * 0.5;
  // Air rides the whole stroke a little, so hats read as a thickening of the
  // trace rather than as a separate flashing thing (art-direction §3.3).
  let w = 1.0 + P.weightVar * (1.8 * amp + 0.7 * bandAt(4u) - 0.35);
  return vec2<f32>(max(w, 0.25), 0.55 + 0.75 * amp);
}

/**
 * Miter at `cur` between the segments prev->cur and cur->next.
 * Returns (direction.xy, length scale). The scale is 1/cos(theta/2), clamped:
 * a hairpin sends it to infinity and one vertex shoots off screen.
 *
 * The two degenerate cases are the ENDPOINTS of an open path, not exotica: the
 * line and Lissajous modes clamp `pathT`, so at seg 0 `prev == cur` and at the
 * last segment `next == cur`. Substituting an arbitrary direction there (the
 * obvious `safeDir` fallback of (1,0)) tilts the miter towards vertical and
 * visibly skews the first and last caps. Falling back to the ONE real adjacent
 * normal instead gives a square butt cap, which is what an open stroke wants.
 */
fn joinNormal(prev : vec2<f32>, cur : vec2<f32>, next : vec2<f32>) -> vec3<f32> {
  let e0 = cur - prev;
  let e1 = next - cur;
  let l0 = length(e0);
  let l1 = length(e1);
  // Both degenerate: a zero-length trace. Any consistent normal will do, and the
  // quad it produces has zero extent along the path anyway.
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
  // A 180-degree reversal has no miter. Fall back to the outgoing normal; the
  // segment simply butts, which is invisible at these lengths.
  if (l < 1e-5) { return vec3<f32>(n1, 1.0); }
  m = m / l;
  return vec3<f32>(m, min(1.0 / max(dot(m, n1), 0.1), 4.0));
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

  let t1 = pathT(seg / n);
  let t2 = pathT((seg + 1.0) / n);

  let p0 = scopePoint(pathT((seg - 1.0) / n));
  let p1 = scopePoint(t1);
  let p2 = scopePoint(t2);
  let p3 = scopePoint(pathT((seg + 2.0) / n));

  let j1 = joinNormal(p0, p1, p2);
  let j2 = joinNormal(p1, p2, p3);

  let s1 = strokeAt(t1);
  let s2 = strokeAt(t2);
  var w1 = P.halfWidth * s1.x;
  var w2 = P.halfWidth * s2.x;

  // One pixel is 2/resolution.y in unit-y, so half a pixel is 1/resolution.y.
  // Below that the stroke stops being thin and starts being intermittent.
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
  // Analytic AA (art-direction §4.5): the edge is one fragment-derivative wide in
  // the SAME parameter the edge is expressed in, so it holds at every stroke
  // width and every resolution. `fwidth` is clamped because a stroke thinner
  // than a fragment would otherwise smooth its own coverage away to nothing.
  let e = clamp(fwidth(in.across), 1e-4, 0.9);
  let cov = 1.0 - smoothstep(1.0 - e, 1.0, d);

  // Phosphor shoulder: a bright core with a soft falloff across the width. A
  // flat-topped stroke bands visibly wherever the trace crosses itself, which on
  // a Lissajous is constantly.
  let core = 0.30 + 0.70 * exp(-d * d * 2.4);

  let a = cov * in.fade * C.opacity;
  return vec4<f32>(C.color.rgb * core * in.glow * a, a);
}
