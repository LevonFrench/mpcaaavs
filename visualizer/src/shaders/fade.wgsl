// Feedback fade — the trail, in its minimal form.
//
// Reads last frame's accumulation and writes it back slightly darker, so points
// drawn on top build up into a curve rather than a swarm of dots. This is the
// `feedback` layer type in miniature (plan §4.1).
//
// The decay is frame-rate independent: keep = exp(-dt/tau). Pulse originally
// exposed "fraction surviving one frame", which meant the look changed with the
// display refresh and the slider was unusable. Parameterise by TIME — and in
// this project by BEATS — always.
//
// ---------------------------------------------------------------------------
// STATUS: no `PassDescriptor` registers this file.
//
// `shaders/op-feedback.wgsl` + `ops/feedback.ts` subsume it completely: `keep`
// is the same exp(-dt/tau) expressed in beats, `drift` is `zoom` with a
// stability clamp this file does not have, and that pass additionally owns its
// history pair, injects at a derived steady state, soft-clips and fades its
// border. Shipping a second trail operator would mean two implementations of the
// same arithmetic drifting apart, so this one is deliberately NOT registered.
//
// It is renumbered to the binding contract rather than left on the old ad-hoc
// numbers so that it is not the one file in `shaders/` still claiming
// `@binding(0)` for a texture. It is a reference implementation and a deletion
// candidate the moment `main.ts` stops hard-coding the vertical slice.
//
// A consumer, if one is ever written, must prepend `PASS_COMMON_WGSL` and
// `passBindingsWGSL({ input: 'accumulator', ... })` — which supply `C`, `src`,
// `samp` and `fragUV` — and append
// `@group(PASS_GROUP) @binding(PASS_BINDING.params) var<uniform> F : Fade;`.
// ---------------------------------------------------------------------------

struct Fade {
  keep  : f32,   // already exp(-dtBeats/tauBeats) on the CPU
  drift : f32,   // slight zoom per frame — the classic feedback tunnel
  pad0  : f32,
  pad1  : f32,
};

@vertex
fn vs(@builtin(vertex_index) vi : u32) -> @builtin(position) vec4<f32> {
  return fullscreenTriangle(vi);
}

@fragment
fn fs(@builtin(position) frag : vec4<f32>) -> @location(0) vec4<f32> {
  var uv = fragUV(frag);

  // Zoom about the centre by a hair. Feedback is the one place a centre origin
  // is correct — it is the mechanism, not a "pulse from the middle".
  uv = (uv - 0.5) * F.drift + 0.5;

  let c = textureSampleLevel(src, samp, uv, 0.0);
  return vec4<f32>(c.rgb * F.keep * C.opacity, 1.0);
}
