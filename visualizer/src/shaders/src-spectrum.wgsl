// Spectrum: bars, filled ribbon, peak-hold caps. Plan §8.2.
//
// Look: GRID (art-direction §1.2) — bars are that look's native furniture, and
// the horizon-under-bars composition is what it is for. Lab gets the scope; this
// is not a lab source.
//
// The axis is LOGARITHMIC and that is not a preference. At 2048/48 kHz the bottom
// octave gets one bin and the top gets 427 (plan §6), so a linear axis draws the
// bass — the part of the music the eye is looking for — as a single bar and
// spends four fifths of the frame on cymbals. Every x here is a frequency
// ratio, not a bin index.
//
// A fragment shader rather than geometry, deliberately: the bar edges, the cap
// edges and the ribbon's own contour are all analytic distances, so they
// antialias exactly (§4.5) at any bar count, including counts where a bar is
// under a pixel wide. A vertex-built bar chart cannot do the last one at all.
//
// Peak-hold needs no state here — `audioPeak` already holds and falls in the
// analysis, so the cap is a second read of the same bin.
//
// It deliberately does NOT draw an octave grid, labels or a mirrored butterfly.
// Those are separate layers, and stacking them into one pass is how a source
// stops being composable.

struct Params {
  mode      : f32,   // 0 bars, 1 filled ribbon
  bars      : f32,
  gain      : f32,
  gamma     : f32,   // < 1 lifts the quiet end. Magnitude is not perceptual.
  fLo       : f32,   // normalised frequency at x = 0
  fHi       : f32,   // normalised frequency at x = 1
  gap       : f32,   // 0..1 fraction of a bar cell left empty
  panAmount : f32,   // 0 = fixed grid, 1 = a band sits at its stereo position
  capHalf   : f32,   // half thickness of the peak cap / ribbon contour, in uv-y
  bodyLevel : f32,
  capLevel  : f32,
  height    : f32,   // full-scale bar height, 0..1 of the frame
  // --- LED ladder (modes 2..4) ----------------------------------------------
  segments  : f32,   // rows in the ladder. 0 = continuous, i.e. not an LED.
  segGap    : f32,   // 0..1 of each row cell left dark
  ledOff    : f32,   // UNLIT row level. The ghost is what makes it read as hardware.
  ledStyle  : f32,   // 0 solid, 1 segment, 2 dot, 3 capsule, 4 VU, 5 diamond, 6 matrix, 7 split
  // --- peak, independently drivable -----------------------------------------
  peakGlow  : f32,   // halo around the cap, in cap-thicknesses
  peakPulse : f32,   // how much the layer envelope drives the cap alone
  pad0      : f32,
  pad1      : f32,   // 20 floats = 80 bytes, a multiple of 16 (WGSL alignment)
};

/**
 * The LED ladder.
 *
 * A bar quantised into rows, with the UNLIT rows left faintly visible. That
 * ghost is the whole illusion: a real EQ is a fixed grid of lamps and you can
 * see the dark ones, so a ladder that draws only the lit rows reads as a bar
 * chart with gaps rather than as hardware.
 *
 * Returns (lit, unlit) coverage so the caller can light them from different
 * levels — the same reason the body and cap are separate.
 */
fn ledLadder(y : f32, h : f32, cellX : f32, eyPix : f32, exPix : f32) -> vec2<f32> {
  let segs = max(P.segments, 1.0);
  let cell = P.height / segs;
  let idx = floor(y / max(cell, 1e-5));
  let within = fract(y / max(cell, 1e-5));

  // Row coverage along y.
  //
  // The edge widths are PASSED IN, not taken with fwidth() here. This function
  // runs inside the cell loop, which is behind a `continue`, and WGSL forbids
  // derivative builtins in non-uniform control flow — the pipeline fails to
  // create, and the app renders black with no shader error surfaced anywhere
  // except getCompilationInfo. The file's own note above the loop says every
  // fwidth is hoisted "precisely so that this is legal"; this broke that.
  //
  // The gradients are analytic anyway: y/cell scales the caller's dy by 1/cell,
  // and the lamp coordinates scale it again by 2/fill and 1/halfCell.
  let fill = clamp(1.0 - P.segGap, 0.05, 1.0);
  let ey = max(eyPix / max(cell, 1e-5), 1e-5);
  var cov = (1.0 - smoothstep(fill - ey, fill + ey, within));
  // Re-centred row coordinates, shared by every non-rectangular lamp shape.
  let cy = (within - fill * 0.5) / max(fill, 1e-5) * 2.0;

  // Lamp SHAPE is independent of band count and of bar/ribbon mode — that is
  // the point of keeping it its own axis. 16 dots and 64 capsules are both
  // reachable, and neither needs a new mode.
  if (P.ledStyle > 1.5 && P.ledStyle < 3.5) {
    if (P.ledStyle < 2.5) {
      // DOT: circular lamp. cellX is -1..1 across the bar, so folding it in
      // with the re-centred row keeps the dot round rather than elliptical.
      let r = length(vec2<f32>(cellX, cy));
      // Worst-case of the two axis gradients: exact enough for an edge a pixel
      // wide, and free of a derivative.
      let er = max(max(exPix, ey * 2.0 / max(fill, 1e-5)), 1e-5);
      cov = 1.0 - smoothstep(0.85 - er, 0.85 + er, r);
    } else {
      // CAPSULE: a rounded rect, wider than tall. The classic hi-fi ladder.
      let q = max(abs(vec2<f32>(cellX, cy)) - vec2<f32>(0.45, 0.0), vec2<f32>(0.0));
      let d = length(q) - 0.42;
      let ed = max(max(exPix, ey * 2.0 / max(fill, 1e-5)), 1e-5);
      cov = 1.0 - smoothstep(-ed, ed, d);
    }
  } else if (P.ledStyle > 4.5 && P.ledStyle < 5.5) {
    // DIAMOND: an angular lozenge. It gives the otherwise soft ladder a
    // deliberately technical, faceted character without adding a new colour.
    let d = abs(cellX) + abs(cy) - 0.86;
    let ed = max(max(exPix, ey * 2.0 / max(fill, 1e-5)), 1e-5);
    cov = 1.0 - smoothstep(-ed, ed, d);
  } else if (P.ledStyle > 5.5 && P.ledStyle < 6.5) {
    // MATRIX: three tiny diodes in each row. The discrete grid remains legible
    // at low band counts, while high counts resolve into a dense LED texture.
    let r = min(
      length(vec2<f32>(cellX + 0.52, cy)),
      min(length(vec2<f32>(cellX, cy)), length(vec2<f32>(cellX - 0.52, cy))),
    );
    let er = max(max(exPix, ey * 2.0 / max(fill, 1e-5)), 1e-5);
    cov = 1.0 - smoothstep(0.25 - er, 0.25 + er, r);
  } else if (P.ledStyle > 6.5) {
    // SPLIT: paired pill lamps with a central dark seam — a compact modern
    // meter face that still reads as physical hardware when it is unlit.
    let q = max(
      abs(vec2<f32>(abs(cellX) - 0.48, cy)) - vec2<f32>(0.24, 0.0),
      vec2<f32>(0.0),
    );
    let d = length(q) - 0.34;
    let ed = max(max(exPix, ey * 2.0 / max(fill, 1e-5)), 1e-5);
    cov = 1.0 - smoothstep(-ed, ed, d);
  }

  // A row is lit when its BASE is under the bar height, not its centre —
  // otherwise the top row flickers on and off around the half-row mark.
  let base = idx * cell;
  let lit = select(0.0, 1.0, base < h);
  return vec2<f32>(cov * lit, cov * (1.0 - lit));
}

/** How many bar cells either side to consider once pan can shift them. */
const PAN_SPAN : i32 = 2;

/** Normalised frequency at horizontal position x. Geometric, so an octave is a fixed width. */
fn logFreq(x : f32) -> f32 {
  return P.fLo * pow(max(P.fHi / P.fLo, 1.0), clamp(x, 0.0, 1.0));
}

/** Magnitude -> height. Gamma first, then the layer's full-scale height. */
fn shape(m : f32) -> f32 {
  return clamp(pow(max(m * P.gain, 0.0), P.gamma), 0.0, 1.0) * P.height;
}

/**
 * Bar magnitude, taken as the MAX over the cell rather than its centre.
 *
 * A cell at the top of the axis spans dozens of bins, and sampling one point in
 * it drops narrow spikes at random — the bar then flickers on content that is
 * perfectly steady. `audio.ts` resamples by max for the same reason.
 */
fn cellMag(i : f32, n : f32) -> vec2<f32> {
  var m = 0.0;
  var pk = 0.0;
  for (var k = 0; k < 4; k = k + 1) {
    let f = logFreq((i + (f32(k) + 0.5) * 0.25) / n);
    m = max(m, fftAt(f));
    pk = max(pk, peakAt(f));
  }
  return vec2<f32>(m, pk);
}

@vertex
fn vs(@builtin(vertex_index) vi : u32) -> @builtin(position) vec4<f32> {
  return fullscreenTriangle(vi);
}

@fragment
fn fs(@builtin(position) frag : vec4<f32>) -> @location(0) vec4<f32> {
  let uv = fragUV(frag);
  // Height reads from the bottom of the frame; `fragUV` has y = 0 at the top.
  let y = 1.0 - uv.y;

  // Derivatives are taken ONCE, here, in uniform control flow. Called inside the
  // bar loop below they would sit under a branch that depends on the fragment's
  // own cell index, and a derivative under non-uniform control flow is undefined
  // — which shows up as AA that works everywhere except at the bar edges.
  let ex = max(fwidth(uv.x), 1e-5);
  let ey = max(fwidth(y), 1e-5);

  var body = 0.0;
  var cap = 0.0;
  var lit = 0.0;   // normalised height of whatever is under this fragment, for shading
  var ghost = 0.0; // UNLIT LED rows. Drawn faintly — see ledLadder().
  var capGlow = 0.0; // Wide, dim halo around the cap. Its own channel (see below).

  if (P.mode < 0.5) {
    let n = max(floor(P.bars), 1.0);
    // `halfCell`, not `half`: this is half a CELL and the loop below compares it
    // against a distance in x, so the unit matters. (`half` is legal WGSL —
    // `op-polar.wgsl` uses it and compiles — so this is naming, not a fix.)
    let halfCell = max((1.0 - clamp(P.gap, 0.0, 0.95)) * 0.5 / n, 1e-5);
    let i0 = floor(clamp(uv.x, 0.0, 1.0) * n);

    // Neighbours as well as the nominal cell: with pan positioning on, a cell's
    // rectangle no longer contains the x that selected it.
    for (var k = -PAN_SPAN; k <= PAN_SPAN; k = k + 1) {
      let i = i0 + f32(k);
      let inRange = step(0.0, i) * step(i, n - 1.0);
      let centre = (i + 0.5) / n;
      // Plan §6: a band sits at its own stereo position. Scaled by the cell
      // width so a full-left band moves exactly one cell, not across the frame —
      // beyond that the axis stops being a frequency axis.
      let cx = centre + panAt(logFreq(centre)) * P.panAmount / n;
      let m = inRange * (1.0 - smoothstep(halfCell - ex, halfCell + ex, abs(uv.x - cx)));

      // Bail before `cellMag`, which is 24 buffer reads (4 sub-samples x 6).
      // Unbailed, the five cells cost 120 of those per fragment on a FULLSCREEN
      // pass, and at most one cell normally covers the fragment — the cells are
      // narrower than their spacing, so they do not overlap. Stated honestly:
      // `panAt` above the bail is still paid five times, so the loop's reads go
      // from ~130 to ~34. That is a cut to this loop (§4.11), not to the whole
      // pass.
      //
      // It is exactly, not approximately, free: every term skipped is
      // multiplied by `m`, `m` is non-negative here, and the accumulators only
      // ever `max` against it. The output is bit-identical.
      //
      // `continue` rather than the mask it replaces because the uniformity rule
      // only governs DERIVATIVES, and every `fwidth` in this shader is hoisted
      // above the branch precisely so that this is legal.
      if (m <= 0.0) { continue; }

      let mp = cellMag(i, n);
      let h = shape(mp.x);
      let ph = shape(mp.y);
      // Solid bar, or an LED ladder. `ghost` carries the UNLIT rows so they can
      // be lit from their own level further down.
      var sy = 1.0 - smoothstep(h - ey, h + ey, y);
      var gh = 0.0;
      if (P.ledStyle > 0.5) {
        // -1..1 across this bar cell, for the lamp shapes.
        let cellX = (uv.x - cx) / max(halfCell, 1e-6);
        // ey / ex are the hoisted screen-space derivatives from the top of the
        // fragment function; exPix is rescaled into bar-cell units here.
        let lad = ledLadder(y, h, cellX, ey, ex / max(halfCell, 1e-6));
        sy = lad.x;
        gh = lad.y;
      }
      // The cap is a band at the peak-hold height, and it falls because the
      // analysis's peak falls. Drawn even when the bar itself has collapsed
      // beneath it — that gap IS the peak-hold readout.
      let dCap = abs(y - ph);
      let sc = 1.0 - smoothstep(P.capHalf - ey, P.capHalf + ey, dCap);
      // Exponential rather than a second smoothstep, so the halo reads as light
      // spilling off the marker rather than as a fatter line.
      let sg = exp(-dCap / max(P.capHalf * 4.0, 1e-4));

      body = max(body, m * sy);
      ghost = max(ghost, m * gh);
      cap = max(cap, m * sc);
      capGlow = max(capGlow, m * sg);
      lit = max(lit, m * h);
    }
  } else {
    // Filled ribbon. `h` is a function of uv.x alone, so `fwidth(y - h)` is the
    // true screen-space width of the contour including its slope — an edge
    // antialiased with fwidth(y) instead goes visibly stepped wherever the
    // spectrum is steep, which near a bass transient is everywhere.
    let f = logFreq(uv.x);
    let h = shape(fftAt(f));
    let d = y - h;
    let e = max(fwidth(d), 1e-5);
    body = 1.0 - smoothstep(-e, e, d);
    let contour = 1.0 - smoothstep(P.capHalf - e, P.capHalf + e, abs(d));
    let ph = shape(peakAt(f));
    let dp = y - ph;
    let ep = max(fwidth(dp), 1e-5);
    let peakLine = 1.0 - smoothstep(P.capHalf - ep, P.capHalf + ep, abs(dp));
    // The contour is the ribbon's own lit edge; the peak line sits above it and
    // is deliberately dimmer, so the eye reads one shape with a marker rather
    // than two competing lines (§4.2).
    cap = max(contour, peakLine * 0.6);
    capGlow = exp(-abs(dp) / max(P.capHalf * 4.0, 1e-4));
    lit = h;
  }

  // Value range beats hue range (§2.3): the body darkens towards its base so the
  // fill reads as a gradient with a lit top edge rather than as a flat slab, and
  // the frame keeps a floor near zero. One hue throughout — the layer's palette
  // slot — because a spectrum that colours by frequency is the rainbow
  // anti-pattern wearing a hat (§2.2, §5).
  let base = 0.18 + 0.82 * clamp(y / max(lit, 1e-4), 0.0, 1.0);

  // THE PEAK IS ITS OWN CHANNEL. It can pulse, glow and hold independently of
  // the bar under it, because in a real meter the peak marker is the thing the
  // eye tracks and the bar is context.
  //
  // `peakPulse` folds the layer's envelope into the CAP alone, so a preset can
  // put the cap on a beat trigger while the body breathes on a bar.
  let pulse = mix(1.0, 0.35 + 1.65 * C.progress, clamp(P.peakPulse, 0.0, 1.0));
  // Halo: a second, wider, dimmer band around the cap. Cheap because the
  // distance to the cap is already computed; the falloff is exponential rather
  // than a second smoothstep so it reads as light rather than a fatter line.
  let glow = capGlow * P.peakGlow;
  let capLevel = (cap + glow) * P.capLevel * pulse;

  var level = body * P.bodyLevel * base + capLevel;
  // Unlit lamps last, and never brighter than the dimmest lit one — the ghost
  // is meant to be legible, not to compete (§4.2, one focal point).
  level = level + ghost * P.ledOff * P.bodyLevel;

  let a = clamp(body + cap + glow + ghost * P.ledOff, 0.0, 1.0) * C.opacity;

  // VU: the lamp gets HOTTER as it climbs — a level readout, which is what a
  // VU ladder is for.
  //
  // Done as intensity within ONE hue, not as a green/amber/red ramp. The
  // palette lives on the CPU and shaders only receive their slot's resolved
  // colour, so a three-colour ladder would mean hardcoding hues here — which is
  // the rainbow anti-pattern (§2.2) and would ignore the preset's palette
  // entirely. Value range beats hue range (§2.3).
  if (P.ledStyle > 3.5 && P.ledStyle < 4.5) {
    let climb = clamp(y / max(P.height, 1e-4), 0.0, 1.0);
    level = level * (0.55 + 1.45 * climb * climb);
  }
  return vec4<f32>(C.color.rgb * level * C.opacity, a);
}
