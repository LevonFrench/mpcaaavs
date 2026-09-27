// Waterfall: the scrolling spectrogram. Time on one axis, LOG frequency on the
// other, magnitude through an OKLab ramp.
//
// Look: GRID (art-direction §1.2). A spectrogram is a readout — instrument
// furniture — and the horizon/panel composition is what that look is for. It is
// legible in LAB too if the palette's chroma is near zero, because the ramp is
// built from the layer's own palette slot rather than from a fixed hue.
//
// Four decisions this file exists to get right, all of which are easy to get
// wrong in a way that still produces a picture:
//
//   - THE RING OFFSET IS NOT MINE TO COMPUTE. `spectrogramAt(uv)` in
//     `audiogpu.ts` addresses rows relative to the write head and wraps. Row 0
//     of the buffer is NOT the oldest row, it is wherever the writer happened to
//     be, so indexing `audioGram` directly makes the history JUMP once per lap —
//     a bug that shows up every 256 analysis frames and is invisible in a
//     screenshot. Every read here goes through the accessor. uv.y is AGE: 0 is
//     now, 1 is the oldest row still held.
//   - THE FREQUENCY AXIS IS LOGARITHMIC. `audio.ts` resamples the FFT into
//     SPEC_N bins LINEARLY, so bin space is linear in frequency: the bottom
//     octave gets one bin and the top gets hundreds (plan §6). Drawn on a linear
//     axis the bass — the part of the music the eye is looking for — is one
//     pixel wide. Every x here is a frequency RATIO.
//   - MAGNITUDE IS RESAMPLED BY MAX ACROSS THE PIXEL. At the top of a log axis
//     one pixel covers many bins, and sampling the centre of that footprint
//     drops narrow spikes at random. Peaks are what the eye reads; averaging
//     buries them under their quiet neighbours.
//   - THE RAMP IS OKLab AND CARRIES AT MOST ONE HUE ROTATION. A spectrogram
//     coloured by a rainbow LUT is the number-one amateur tell (§2.2, §5). The
//     ramp here runs dark -> the palette slot's own hue -> a lighter, slightly
//     rotated version of it: value range doing the work, hue range staying still
//     (§2.3). HDR headroom is reached only by the hottest few percent of cells,
//     and only if the palette slot was given any (§2.4).
//
// It deliberately does NOT draw octave gridlines, labels, or a mirrored second
// panel. Those are separate layers; stacking them in here is how a source stops
// being composable — the same argument `src-spectrum.wgsl` makes.

struct Params {
  orient     : f32,   // 0 vertical (freq across X), 1 horizontal (freq up Y)
  flip       : f32,   // > 0.5 reverses the direction time scrolls
  span       : f32,   // fraction of the held history the panel shows, 0..1
  gain       : f32,
  gamma      : f32,   // < 1 lifts the quiet end. Magnitude is not perceptual.
  fLo        : f32,   // normalised frequency at the low end of the axis
  fHi        : f32,   // normalised frequency at the high end
  floorKnee  : f32,   // below this, cells fall to true black (§2.3)
  cx         : f32,   // panel centre, uv
  cy         : f32,
  hw         : f32,   // panel half extent, uv
  hh         : f32,
  hueSpread  : f32,   // radians. The WHOLE hue excursion of the ramp.
  edgeLevel  : f32,   // brightness of the "now" edge. 0 turns it off.
  topLevel   : f32,   // multiplier on the palette's HDR headroom at the hot end
  _pad0      : f32,
};

/**
 * Sub-taps across the pixel's own frequency footprint. Three is enough: the
 * footprint is one pixel wide, and the fourth tap costs another four storage
 * loads to refine a maximum that has already stopped moving.
 */
const TAPS : i32 = 3;

/** Normalised frequency at axis position x. Geometric, so an octave is a fixed width. */
fn logFreq(x : f32) -> f32 {
  return P.fLo * pow(max(P.fHi / P.fLo, 1.0), clamp(x, 0.0, 1.0));
}

// OKLab <-> linear sRGB. Both directions, because the ramp is BUILT from the
// palette slot: the slot arrives as linear rgb (`C.color`), and mixing a ramp
// from it in sRGB passes through the grey dead-zone this project exists to avoid
// (§2.1). `points.wgsl` carries the same forward transform; the two are
// deliberately identical arithmetic.
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

/** Cube root that survives a negative argument. `pow` returns NaN for one. */
fn cbrt(x : f32) -> f32 {
  return sign(x) * pow(abs(x), 1.0 / 3.0);
}

fn linearToOklab(c : vec3<f32>) -> vec3<f32> {
  let l = 0.4122214708 * c.x + 0.5363325363 * c.y + 0.0514459929 * c.z;
  let m = 0.2119034982 * c.x + 0.6806995451 * c.y + 0.1073969566 * c.z;
  let s = 0.0883024619 * c.x + 0.2817188376 * c.y + 0.6299787005 * c.z;
  let l_ = cbrt(l);
  let m_ = cbrt(m);
  let s_ = cbrt(s);
  return vec3<f32>(
    0.2104542553 * l_ + 0.7936177850 * m_ - 0.0040720468 * s_,
    1.9779984951 * l_ - 2.4285922050 * m_ + 0.4505937099 * s_,
    0.0259040371 * l_ + 0.7827717662 * m_ - 0.8086757660 * s_,
  );
}

@vertex
fn vs(@builtin(vertex_index) vi : u32) -> @builtin(position) vec4<f32> {
  return fullscreenTriangle(vi);
}

@fragment
fn fs(@builtin(position) frag : vec4<f32>) -> @location(0) vec4<f32> {
  let uv = fragUV(frag);

  // Panel-local coordinates, -1..1 inside the panel on both axes.
  let px = (uv.x - P.cx) / max(P.hw, 1e-4);
  let py = (uv.y - P.cy) / max(P.hh, 1e-4);

  // `orient` and `flip` come from a uniform, so branching on them would still be
  // uniform control flow — but `select` keeps the derivatives below trivially
  // provably so, and costs nothing.
  let vert = P.orient < 0.5;

  // Vertical: frequency runs left to right, age runs down the panel.
  // Horizontal: frequency runs bottom to top (uv.y grows DOWNWARD, hence the
  // sign), age runs right to left, so the newest column is the right edge.
  let fq = select(0.5 - 0.5 * py, 0.5 + 0.5 * px, vert);
  let agRaw = select(0.5 - 0.5 * px, 0.5 + 0.5 * py, vert);
  let ag = select(agRaw, 1.0 - agRaw, P.flip > 0.5);

  // Every derivative is taken HERE, in uniform control flow, before any branch
  // on the fragment's own data. A derivative under non-uniform control flow is
  // undefined, and the symptom is AA that works everywhere except at the edges —
  // which is the only place it was needed.
  let ef = max(fwidth(fq), 1e-6);
  let ea = max(fwidth(ag), 1e-6);
  let epx = max(fwidth(px), 1e-5);
  let epy = max(fwidth(py), 1e-5);

  // The panel's own edges, analytically antialiased (§4.5).
  let panel = (1.0 - smoothstep(1.0 - epx, 1.0 + epx, abs(px)))
            * (1.0 - smoothstep(1.0 - epy, 1.0 + epy, abs(py)));

  // Age 0 is now; `span` decides how far back the far end reaches. Age is fed to
  // the accessor unwrapped — the ring arithmetic is its job, not this shader's.
  let age = clamp(ag, 0.0, 1.0) * clamp(P.span, 0.0, 1.0);

  var m = 0.0;
  for (var k = 0; k < TAPS; k = k + 1) {
    let o = (f32(k) / f32(TAPS - 1) - 0.5) * ef;
    m = max(m, spectrogramAt(vec2<f32>(logFreq(fq + o), age)));
  }

  // Gamma below 1 lifts the quiet end; the knee then pushes the very bottom back
  // to true black, so the panel's floor is zero rather than a grey haze (§2.3).
  var v = pow(clamp(m * P.gain, 0.0, 1.0), max(P.gamma, 1e-3));
  v = v * smoothstep(0.0, max(P.floorKnee, 1e-4), v);

  // The ramp is built from the layer's palette slot, so a preset re-grades the
  // whole spectrogram from one control (§2.5). `C.color.rgb` already has the
  // slot's intensity applied, so it is divided back out to recover the unit hue
  // — otherwise a slot with HDR headroom would come back as an out-of-gamut
  // chroma and the ramp would clip on its way through OKLab.
  let unit = max(C.color.rgb / max(C.color.a, 1e-3), vec3<f32>(0.0));
  let base = linearToOklab(unit);
  let h0 = atan2(base.z, base.y);
  // A greyscale palette slot has no hue to rotate. Chroma of zero falls straight
  // through everything below and the ramp is a value ramp, which is correct.
  let c0 = length(base.yz);

  // The two ends of the rotation, split 5:3 either side of the slot's own hue so
  // the dark end moves further than the bright one. The split is normalised so
  // that hLo - hHi is EXACTLY `hueSpread` — the .ts caps that dial at 0.9 rad on
  // the understanding that it is the whole excursion, and a shader that spent
  // 1.6x of it would be running a 82-degree sweep against a 52-degree budget.
  let hLo = h0 + P.hueSpread * 0.625;
  let hHi = h0 - P.hueSpread * 0.375;

  // Three stops, and the hue excursion across all of them is `hueSpread`. This
  // is a hue ROTATION, which §2.2 allows; a per-magnitude hue SWEEP is the
  // rainbow anti-pattern and is what this shape exists to refuse.
  var L : f32;
  var ch : f32;
  var hu : f32;
  if (v < 0.55) {
    let u = v / 0.55;
    L = mix(0.04, 0.58, u);
    ch = mix(0.20, 0.90, u) * c0;
    hu = mix(hLo, h0, u);
  } else {
    let u = (v - 0.55) / 0.45;
    L = mix(0.58, 0.94, u);
    ch = mix(0.90, 0.55, u) * c0;
    hu = mix(h0, hHi, u);
  }
  var rgb = max(oklabToLinear(vec3<f32>(L, ch * cos(hu), ch * sin(hu))), vec3<f32>(0.0));

  // HDR is for the focal element only (§2.4), so the headroom is reached by the
  // hottest few percent of cells and by nothing else — and only if the palette
  // slot was given any. A slot at intensity 1 leaves this a no-op.
  rgb = rgb * mix(1.0, max(C.color.a, 1.0) * max(P.topLevel, 0.0), smoothstep(0.86, 1.0, v));

  // The leading edge: a thin bright line at age 0, which is where the newest row
  // enters. It gives the panel one lit edge to read as its "now", and it is the
  // only line in this source, so it is the only place line weight can vary —
  // it thickens with broadband level (§4.4).
  let edgeHalf = ea * (1.0 + 1.6 * clamp(A.level, 0.0, 1.0));
  let edge = (1.0 - smoothstep(edgeHalf, edgeHalf * 2.2, abs(ag))) * max(P.edgeLevel, 0.0);

  // Below the knee nothing is drawn at all: the ramp's darkest stop is not black,
  // and a full panel of near-black under `add` is a grey wash over the frame.
  let gate = smoothstep(0.0, 0.03, v);

  let col = (rgb * gate + C.color.rgb * edge) * panel;
  let a = clamp(gate + edge, 0.0, 1.0) * panel;
  // C.opacity is the one obligation `PASS_COMMON_WGSL` imposes: fixed-function
  // blending has no per-draw multiplier, so a pass that ignores it is a pass
  // whose opacity slider does nothing.
  return vec4<f32>(col * C.opacity, a * C.opacity);
}
