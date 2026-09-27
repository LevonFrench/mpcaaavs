// Transition composite — blends the OUTGOING preset's frame into the INCOMING
// one through a spatial mask.
//
// Every geometric transition is the same primitive: two rendered chains plus a
// mask(uv, mix) in 0..1, where 0 means show the old frame and 1 means the new.
// A crossfade is that with a constant mask. Writing them as one shader rather
// than nine means a new wipe is a new `case`, not a new pass.
//
// ---------------------------------------------------------------------------
// BINDINGS ARE NOT DECLARED HERE.
//
// The caller prepends `PASS_COMMON_WGSL`, the `TR_*` constants emitted by
// `transitionWgslConstants()` in src/director.ts, and:
//   `fromTex` at PASS_BINDING.input, `toTex` at PASS_BINDING.history,
//   `samp` at PASS_BINDING.sampler, `var<uniform> T : Trans` at PASS_BINDING.params.
//
// The TR_* ids are GENERATED from the TypeScript map, never hand-written here.
// Two hand-maintained copies of the same numbers is the drift that validates
// cleanly and then plays the wrong transition.
// ---------------------------------------------------------------------------
//
// COST. Two chains run for the transition's duration. Measured, the current
// stack is 0.16 ms of GPU against an 8.33 ms frame, so the second chain is
// affordable with room to spare — but it IS the one place the frame budget
// doubles, and the GPU timer will show it. A long fade between two heavy
// presets is a budget decision, not a free one.

struct Trans {
  kind     : f32,
  mix      : f32,   // 0..1, already curved by Transition.update()
  angle    : f32,   // radians
  softness : f32,   // UV units; 0 aliases, keep a pixel or two
  panels   : f32,
  seed     : f32,
  aspect   : f32,
  grow     : f32,   // iris: 1 opens, 0 closes
};

fn hash21(p: vec2<f32>) -> f32 {
  var p3 = fract(vec3<f32>(p.xyx) * 0.1031);
  p3 = p3 + dot(p3, p3.yzx + 33.33);
  return fract((p3.x + p3.y) * p3.z);
}

/**
 * Soft threshold. `edge` is where the boundary sits, `v` the field value.
 *
 * Widened by fwidth so the edge stays a constant number of PIXELS whatever the
 * geometry's gradient — a fixed UV softness looks razor-sharp on a slow sweep
 * and hopelessly blurry on a fast one.
 */
fn softEdge(v: f32, edge: f32, soft: f32) -> f32 {
  let w = max(soft, fwidth(v) * 1.5);
  return smoothstep(edge - w, edge + w, v);
}

/**
 * Mask in 0..1. 0 keeps the outgoing frame, 1 shows the incoming one.
 *
 * The progress term is expanded to (-soft .. 1+soft) in the swept kinds so the
 * transition genuinely reaches both ends. Left at 0..1, a soft edge means the
 * first and last sliver never fully commit and the old frame ghosts at the end.
 */
fn transitionMask(uv: vec2<f32>) -> f32 {
  let k = T.kind;
  let m = T.mix;
  let soft = max(T.softness, 1e-4);

  if (k == TR_CROSSFADE) { return m; }

  if (k == TR_DISSOLVE) {
    // Per-pixel threshold. The seed offset stops successive dissolves using an
    // identical grain, which reads as the same "shape" every time.
    let n = hash21(floor(uv * vec2<f32>(1920.0, 1080.0)) + vec2<f32>(T.seed, T.seed * 1.7));
    return softEdge(m, n, soft * 0.5);
  }

  // Aspect-corrected, centred coordinates for everything geometric, or the
  // circles are ellipses and the angles are sheared.
  let p = (uv - 0.5) * vec2<f32>(T.aspect, 1.0);
  let dir = vec2<f32>(cos(T.angle), sin(T.angle));
  let span = m * (1.0 + 2.0 * soft) - soft;

  if (k == TR_WIPE) {
    // Project onto the sweep direction, normalised so 0..1 covers the frame
    // corner to corner at any angle.
    let half = 0.5 * (abs(T.aspect * dir.x) + abs(dir.y));
    let d = (dot(p, dir) + half) / max(2.0 * half, 1e-5);
    return softEdge(span, d, soft);
  }

  if (k == TR_RADIAL) {
    let a = atan2(p.y, p.x) - T.angle;
    let turn = fract(a / 6.2831853 + 1.0);   // 0..1 clockwise from `angle`
    return softEdge(span, turn, soft);
  }

  if (k == TR_IRIS) {
    let r = length(p);
    // Corner distance, so a full open genuinely clears the frame.
    let rMax = length(vec2<f32>(T.aspect, 1.0) * 0.5);
    let d = r / rMax;
    if (T.grow > 0.5) { return softEdge(span, 1.0 - d, soft); }
    return softEdge(span, d, soft);
  }

  if (k == TR_PANELWIPE) {
    // Strips perpendicular to `angle`, each starting slightly after the last.
    let n = max(T.panels, 1.0);
    let across = dot(p, vec2<f32>(-dir.y, dir.x)) + 0.5;
    let idx = floor(clamp(across, 0.0, 0.9999) * n);
    let along = dot(p, dir) + 0.5;
    // Stagger by half a panel's worth so the sweep reads as a cascade rather
    // than n independent wipes finishing at once.
    let lag = (idx / n) * 0.5;
    let local = clamp((m * 1.5) - lag, 0.0, 1.0);
    return softEdge(local * (1.0 + 2.0 * soft) - soft, along, soft);
  }

  if (k == TR_SLICE) {
    // Bands hand over in alternating directions — the classic slice cut.
    let n = max(T.panels, 1.0);
    let band = floor(clamp(dot(p, vec2<f32>(-dir.y, dir.x)) + 0.5, 0.0, 0.9999) * n);
    let flip = select(-1.0, 1.0, (band % 2.0) < 0.5);
    let along = (dot(p, dir) + 0.5) * flip + select(1.0, 0.0, flip > 0.0);
    return softEdge(span, along, soft);
  }

  return m;
}

/**
 * PANEL FLIP needs the UVs, not just a mask: a card turning has to SQUEEZE.
 * Returns the sample coordinate and, in .z, which frame to read (0 = from).
 *
 * Each strip scales toward its own axis, reaching zero width at the midpoint —
 * which is exactly when the content swaps, so the flip hides the cut.
 */
fn flipSample(uv: vec2<f32>) -> vec3<f32> {
  let n = max(T.panels, 1.0);
  let dir = vec2<f32>(cos(T.angle), sin(T.angle));
  let across = vec2<f32>(-dir.y, dir.x);

  let a = dot(uv - 0.5, across) + 0.5;
  let idx = floor(clamp(a, 0.0, 0.9999) * n);
  // Stagger so panels turn in sequence rather than as one slab.
  let lag = (idx / n) * 0.45;
  let t = clamp((T.mix * 1.45) - lag, 0.0, 1.0);

  let second = t > 0.5;
  // 1 -> 0 -> 1. cos gives the ease-in/ease-out a real hinge has for free.
  let squeeze = max(abs(cos(t * 3.14159265)), 0.02);

  // Local coordinate within the strip, scaled about the strip's centre.
  let centre = (idx + 0.5) / n;
  let local = (a - centre) / squeeze + centre;
  let outUv = uv + across * (local - a);

  return vec3<f32>(outUv, select(0.0, 1.0, second));
}

@vertex
fn vs(@builtin(vertex_index) vi : u32) -> @builtin(position) vec4<f32> {
  return fullscreenTriangle(vi);
}

@fragment
fn fs(@builtin(position) frag : vec4<f32>) -> @location(0) vec4<f32> {
  let uv = fragUV(frag);

  if (T.kind == TR_PANELFLIP) {
    let s = flipSample(uv);
    // Outside the strip after squeezing: nothing to show, so let the frame's
    // own background stand rather than clamping an edge texel into a streak.
    if (s.x < 0.0 || s.x > 1.0 || s.y < 0.0 || s.y > 1.0) {
      return vec4<f32>(0.0, 0.0, 0.0, 1.0) * C.opacity;
    }
    let a = textureSampleLevel(fromTex, samp, s.xy, 0.0);
    let b = textureSampleLevel(toTex, samp, s.xy, 0.0);
    return mix(a, b, s.z) * C.opacity;
  }

  let a = textureSampleLevel(fromTex, samp, uv, 0.0);
  let b = textureSampleLevel(toTex, samp, uv, 0.0);
  return mix(a, b, transitionMask(uv)) * C.opacity;
}
