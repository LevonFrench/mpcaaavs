// Shared body for lightweight procedural sources. The later modes reconstruct
// the contour, wire-mesh, hyperboloid and tunnel grammar from classic AV rigs.
// Declarations for Common, audio, and Params are prepended by generative.ts.

struct Params {
  mode : f32, amount : f32, scale : f32, density : f32,
  detail : f32, speed : f32, spread : f32, pad : f32,
};

fn hash21(p : vec2<f32>) -> f32 {
  var q = fract(vec3<f32>(p.xyx) * 0.1031);
  q = q + dot(q, q.yzx + 33.33);
  return fract((q.x + q.y) * q.z);
}

fn hash22(p : vec2<f32>) -> vec2<f32> {
  return vec2<f32>(hash21(p), hash21(p + 17.17));
}

fn field(p : vec2<f32>) -> f32 {
  let a = sin(p.x + sin(p.y * 1.7));
  let b = cos(p.y - sin(p.x * 1.3));
  return 0.5 + 0.5 * a * b;
}

@vertex
fn vs(@builtin(vertex_index) vi : u32) -> @builtin(position) vec4<f32> {
  return fullscreenTriangle(vi);
}

@fragment
fn fs(@builtin(position) frag : vec4<f32>) -> @location(0) vec4<f32> {
  let uv = fragUV(frag);
  let p = vec2<f32>((uv.x * 2.0 - 1.0) * C.aspect, 1.0 - uv.y * 2.0);
  let beatTime = C.beats * P.speed;
  let bass = A.bands.y + A.bands.x * 0.55;
  let high = A.bands.w + A.air * 0.65;
  var ink = 0.0;

  if (P.mode < 0.5) {
    // Audio-pushed particle lattice: two nearest particles are enough to read
    // as an emitter field without a persistent particle buffer.
    let q = p * (4.0 + P.density * 8.0) / P.scale;
    let cell = floor(q);
    let local = fract(q) - 0.5;
    for (var y : i32 = -1; y <= 1; y = y + 1) {
      for (var x : i32 = -1; x <= 1; x = x + 1) {
        let o = vec2<f32>(f32(x), f32(y));
        let id = cell + o;
        let seed = hash22(id + C.seed * 0.0001);
        let drift = vec2<f32>(sin(beatTime + seed.x * 6.283), cos(beatTime * 0.73 + seed.y * 6.283));
        let d = length(local - o - (seed - 0.5) * P.spread * 0.75 - drift * (0.08 + bass * 0.22));
        ink = max(ink, smoothstep(0.10 + high * 0.055, 0.0, d));
      }
    }
  } else if (P.mode < 1.5) {
    // Stereo XY field: a pair of waveform-derived phases bends a Lissajous
    // interference curve through the frame. This keeps the classic vector
    // scope grammar but does not collapse to one dot when a track is quiet.
    let w = waveAt(fract(uv.x * 0.57 + uv.y * 0.43 + beatTime * 0.015));
    let ax = 5.0 + floor(P.detail * 3.0);
    let ay = 7.0 + floor(P.scale * 3.0);
    let curve = sin(p.x * ax + w.x * P.spread * 2.4 + beatTime * 0.18)
      - sin(p.y * ay + w.y * P.spread * 2.4 + 1.5708);
    let envelope = smoothstep(1.25, 0.16, length(p) / max(P.spread, 0.2));
    ink = smoothstep(0.08 + 0.06 * high, 0.0, abs(curve)) * envelope * (0.52 + A.level * 1.6);
  } else if (P.mode < 2.5) {
    // A reaction-diffusion-like interference field. It is procedural rather
    // than stateful, so it has no stale texture after seeking or a preset swap.
    let q = p * (3.0 + P.scale * 3.0);
    let a = field(q + vec2<f32>(beatTime * 0.11, -beatTime * 0.07));
    let b = field(q.yx * (1.8 + P.detail) - vec2<f32>(bass * 1.8, high));
    let reaction = abs(a - b);
    let rings = sin((reaction + bass * 0.45) * (16.0 + P.density * 20.0));
    ink = smoothstep(0.42, 0.92, rings * 0.5 + 0.5) * smoothstep(0.02, 0.55, reaction);
  } else if (P.mode < 3.5) {
    // Voronoi cells, biased by local spectrum energy so high-frequency content
    // shatters the edges while bass keeps the cells anchored.
    let q = p * (2.0 + P.density * 3.0) / P.scale;
    let cell = floor(q);
    let f = fract(q);
    var nearest = 8.0;
    var next = 8.0;
    for (var y : i32 = -1; y <= 1; y = y + 1) {
      for (var x : i32 = -1; x <= 1; x = x + 1) {
        let o = vec2<f32>(f32(x), f32(y));
        let h = hash22(cell + o + C.seed * 0.0001);
        let wobble = vec2<f32>(sin(beatTime * 0.45 + h.x * 6.283), cos(beatTime * 0.35 + h.y * 6.283)) * (0.08 + high * 0.18);
        let d = length(o + h - f + wobble);
        if (d < nearest) { next = nearest; nearest = d; } else if (d < next) { next = d; }
      }
    }
    let edge = next - nearest;
    ink = smoothstep(0.035 + bass * 0.035, 0.0, edge) + smoothstep(0.23, 0.0, nearest) * 0.22;
  } else if (P.mode < 4.5) {
    // Flow-map contours: a circular void biases an otherwise smooth domain
    // warp, making bands wrap and shear around a pronounced area of silence.
    let eye = p + vec2<f32>(0.78, 0.08);
    let eyeR = length(eye);
    let bend = eye / max(eyeR * eyeR, 0.14) * (0.15 + bass * 0.14);
    var q = p * (1.25 + P.scale * 0.85) + bend;
    q = q + vec2<f32>(
      sin(q.y * (2.2 + P.detail) + beatTime * 0.34),
      cos(q.x * (2.8 + P.detail * 0.8) - beatTime * 0.21),
    ) * (0.22 + high * 0.18) * P.spread;
    let phase = q.x * 2.3 + q.y * 5.1 + sin(q.x * 3.0 - q.y * 2.0);
    let bands = abs(fract(phase * (1.3 + P.density * 2.4)) - 0.5);
    let filaments = smoothstep(0.12 + high * 0.055, 0.0, bands);
    let wash = smoothstep(0.9, 0.18, abs(sin(phase * 0.8)));
    let voidMask = smoothstep(0.30, 0.72, eyeR);
    ink = (filaments * 1.25 + wash * 0.16) * voidMask;
  } else if (P.mode < 5.5) {
    // Perspective height mesh. Sampling a continuous height function instead
    // of a texture keeps the wire grid stable through seeks and preset cuts.
    let horizon = -0.16 + sin(beatTime * 0.11) * 0.035;
    // In this coordinate system positive Y is the top of the frame. Distance
    // therefore grows DOWNWARD from the horizon, putting the landscape in the
    // foreground instead of painting an accidental ceiling grid.
    let depth = clamp((horizon - p.y) * 0.78 + 0.06, 0.025, 1.15);
    let world = vec2<f32>(p.x / depth, 1.0 / depth - beatTime * 0.16);
    let height = sin(world.x * 1.45 + beatTime * 0.42)
      + cos(world.y * 1.12 - beatTime * 0.27)
      + sin((world.x + world.y) * 1.7 + bass * 3.0);
    let rows = abs(fract((world.y + height * 0.12) * (0.34 + P.density * 0.13)) - 0.5);
    let cols = abs(fract((world.x + sin(world.y * 0.5) * 0.16) * (0.24 + P.detail * 0.10)) - 0.5);
    let diagonal = abs(fract((world.x * 0.55 + world.y * 0.42 + height * 0.12) * (0.27 + P.detail * 0.08)) - 0.5);
    let line = max(
      max(smoothstep(0.050 + high * 0.020, 0.0, rows), smoothstep(0.030, 0.0, cols)),
      smoothstep(0.024, 0.0, diagonal),
    );
    let floorMask = smoothstep(horizon + 0.04, horizon - 0.03, p.y) * smoothstep(1.18, 0.16, depth);
    let relief = 0.52 + smoothstep(0.18, 1.5, abs(height)) * 0.42 + bass * 0.88;
    ink = line * floorMask * relief;
  } else if (P.mode < 6.5) {
    // A pinched cylinder viewed head-on. Angular and axial grid lines make a
    // real wire cage while a narrow moving band supplies the scan energy.
    let q = vec2<f32>(p.x * 0.82, p.y + sin(beatTime * 0.18) * 0.05);
    let halfWidth = 0.30 + abs(q.y) * (0.18 + P.spread * 0.12) + sin(q.y * 5.0 + beatTime * 0.3) * 0.04;
    let xNorm = q.x / max(halfWidth, 0.08);
    let inside = smoothstep(1.05, 0.94, abs(xNorm)) * smoothstep(1.26, 0.34, abs(q.y));
    let longitude = asin(clamp(xNorm, -0.999, 0.999)) / 3.14159265 + 0.5;
    let axial = abs(fract(longitude * (7.0 + P.detail * 8.0) + sin(q.y * 2.2) * 0.12) - 0.5);
    let rings = abs(fract(q.y * (4.0 + P.density * 5.0) + beatTime * 0.13 + longitude * 0.11) - 0.5);
    let wire = max(smoothstep(0.075, 0.0, axial), smoothstep(0.065, 0.0, rings));
    let silhouette = smoothstep(0.06 + high * 0.020, 0.0, abs(abs(xNorm) - 1.0));
    let scan = smoothstep(0.12, 0.0, abs(q.y - sin(beatTime * 0.68) * 0.22)) * (0.35 + bass);
    ink = inside * (wire * 0.92 + scan * 0.55) + silhouette * 0.88;
  } else if (P.mode < 7.5) {
    // Recursive tunnel: logarithmic rings converge at a moving vanishing point
    // while radial spokes supply the unmistakable neon-grid perspective.
    let center = vec2<f32>(sin(beatTime * 0.17) * 0.11, -0.06 + cos(beatTime * 0.13) * 0.06);
    let q = p - center;
    let r = max(length(q), 0.002);
    let angle = atan2(q.y, q.x);
    let rings = abs(fract(log(r) * (2.1 + P.density * 1.25) - beatTime * (0.34 + P.speed * 0.10)) - 0.5);
    let spokes = abs(fract((angle / 6.2831853 + 0.5) * (10.0 + P.detail * 14.0) + sin(log(r) * 2.0) * 0.18) - 0.5);
    let ringInk = smoothstep(0.075 + high * 0.025, 0.0, rings);
    let spokeInk = smoothstep(0.040 + high * 0.016, 0.0, spokes);
    let rails = smoothstep(0.045, 0.0, abs(q.x - sin(q.y * 3.0 + beatTime) * 0.22)) * smoothstep(0.35, 1.4, q.y);
    ink = (max(ringInk, spokeInk) + rails * 0.5) * smoothstep(1.72, 0.06, r) * (0.42 + bass * 1.05);
  } else if (P.mode < 8.5) {
    // Wide synthwave dome: large, evenly spaced arches compress into a small
    // central throat. It is deliberately separate from `gridtunnel` because
    // this composition needs a visible architectural background, not a camera
    // flying through a generic radial tunnel.
    let center = vec2<f32>(0.0, -0.18);
    let q = p - center;
    let r = max(length(q), 0.003);
    let angle = atan2(q.y, q.x);
    let domeRings = abs(fract(log(r) * (2.8 + P.density * 0.9) - beatTime * 0.08) - 0.5);
    let domeSpokes = abs(fract((angle / 6.2831853 + 0.5) * (12.0 + P.detail * 10.0)) - 0.5);
    let arches = max(
      smoothstep(0.038 + high * 0.016, 0.0, domeRings),
      smoothstep(0.018 + high * 0.009, 0.0, domeSpokes),
    );
    let dome = arches * smoothstep(1.62, 0.045, r);

    let throat = q - vec2<f32>(0.0, 0.08);
    let halfWidth = 0.075 + abs(throat.y) * 0.31;
    let normalizedX = throat.x / max(halfWidth, 0.05);
    let inside = smoothstep(1.02, 0.91, abs(normalizedX)) * smoothstep(0.78, 0.08, abs(throat.y));
    let longitude = asin(clamp(normalizedX, -0.999, 0.999)) / 3.14159265 + 0.5;
    let cageVertical = abs(fract(longitude * (10.0 + P.detail * 8.0)) - 0.5);
    let cageHorizontal = abs(fract((throat.y + 0.55) * (11.0 + P.density * 5.0)) - 0.5);
    let cage = inside * max(smoothstep(0.045, 0.0, cageVertical), smoothstep(0.038, 0.0, cageHorizontal));
    let eyes = max(
      smoothstep(0.15, 0.11, length(throat - vec2<f32>(-0.105, 0.02))),
      smoothstep(0.15, 0.11, length(throat - vec2<f32>(0.105, 0.02))),
    );
    ink = (dome * 0.80 + cage * 1.18) * (1.0 - eyes * 0.92) * (0.52 + bass * 0.92);
  } else {
    // Symmetrical spectrum pylons reserve the central vanishing point for the
    // tunnel and make the music read as architectural light at either side.
    let horizon = -0.14;
    let side = abs(p.x);
    let localX = clamp((side - 0.23) / 0.82, 0.0, 0.999);
    let barCount = 18.0 + floor(P.detail * 24.0);
    let band = floor(localX * barCount);
    let position = fract(localX * barCount);
    let spectrumEnergy = sqrt(max(fftAt(fract((band + 0.5) / barCount + C.seed * 0.000013)), 0.0));
    let shape = 0.14 + spectrumEnergy * (0.24 + P.density * 0.24) + bass * 0.13;
    let bar = smoothstep(0.16, 0.04, abs(position - 0.5));
    let aboveHorizon = smoothstep(horizon - 0.045, horizon + 0.010, p.y) * smoothstep(horizon + shape, horizon + shape - 0.025, p.y);
    let sideMask = smoothstep(0.22, 0.34, side) * smoothstep(1.20, 0.82, side);
    let reflection = smoothstep(horizon - 0.08, horizon - 0.19, p.y) * bar * sideMask * 0.18;
    ink = (bar * aboveHorizon * sideMask + reflection) * (0.82 + high * 0.72 + A.level * 0.55);
  }

  let energy = 0.32 + A.level * 1.45 + sqrt(max(fftAt(fract(uv.x)), 0.0)) * 0.45;
  return vec4<f32>(C.color.rgb * ink * energy * P.amount * C.opacity, ink * P.amount * C.opacity);
}
