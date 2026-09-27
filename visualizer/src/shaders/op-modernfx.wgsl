// Shared post-effect body. The layer amount is always a crossfade with the
// untouched accumulator, so every effect is a true no-op at amount zero.

struct Params {
  mode : f32, amount : f32, strength : f32, radius : f32,
  speed : f32, detail : f32, mixAmount : f32, pad : f32,
};

fn hash21(p : vec2<f32>) -> f32 {
  var q = fract(vec3<f32>(p.xyx) * 0.1031);
  q = q + dot(q, q.yzx + 33.33);
  return fract((q.x + q.y) * q.z);
}

fn lum(c : vec3<f32>) -> f32 { return dot(c, vec3<f32>(0.2126, 0.7152, 0.0722)); }

@vertex
fn vs(@builtin(vertex_index) vi : u32) -> @builtin(position) vec4<f32> {
  return fullscreenTriangle(vi);
}

@fragment
fn fs(@builtin(position) frag : vec4<f32>) -> @location(0) vec4<f32> {
  let uv = fragUV(frag);
  let plain = textureSampleLevel(src, samp, uv, 0.0);
  let px = 1.0 / C.resolution;
  let beatTime = C.beats * P.speed;
  let audio = A.level + A.bands.y * 0.65 + A.bands.w * 0.25;
  var effect = plain.rgb;

  if (P.mode < 0.5) {
    // Bright-pass blur; the present pass still owns display bloom, while this
    // one is deliberately a composable HDR glow layer inside the stack.
    var glow = vec3<f32>(0.0);
    for (var y : i32 = -1; y <= 1; y = y + 1) {
      for (var x : i32 = -1; x <= 1; x = x + 1) {
        let c = textureSampleLevel(src, samp, uv + vec2<f32>(f32(x), f32(y)) * px * P.radius * 3.0, 0.0).rgb;
        glow = glow + max(c - vec3<f32>(0.55), vec3<f32>(0.0));
      }
    }
    effect = plain.rgb + glow / 9.0 * P.strength * (0.4 + audio);
  } else if (P.mode < 1.5) {
    let dir = normalize(vec2<f32>(cos(beatTime * 0.2), sin(beatTime * 0.17)) + vec2<f32>(0.001));
    let shift = dir * px * P.radius * (1.5 + P.strength * 9.0) * (0.45 + audio);
    effect = vec3<f32>(textureSampleLevel(src, samp, uv + shift, 0.0).r, plain.g, textureSampleLevel(src, samp, uv - shift, 0.0).b);
  } else if (P.mode < 2.5) {
    let n = hash21(floor(uv * P.detail * 30.0) + C.seed);
    let wave = sin((uv.y + beatTime * 0.03) * (18.0 + P.detail * 40.0));
    let offset = vec2<f32>((n - 0.5) + wave * 0.5, sin(uv.x * 12.0 + beatTime) * 0.35) * px * P.radius * 18.0 * P.strength * (0.2 + audio);
    effect = textureSampleLevel(src, samp, uv + offset, 0.0).rgb;
  } else if (P.mode < 3.5) {
    let rows = floor(uv.y * (16.0 + P.detail * 90.0));
    let gate = step(0.72, hash21(vec2<f32>(rows, floor(beatTime * 2.0) + C.seed)));
    let block = vec2<f32>(hash21(vec2<f32>(rows, C.seed)), hash21(vec2<f32>(rows + 4.0, C.seed))) - 0.5;
    let offset = vec2<f32>(block.x * gate * P.strength * (0.02 + audio * 0.06), 0.0);
    let dirty = textureSampleLevel(src, samp, uv + offset, 0.0).rgb;
    effect = mix(dirty, dirty.bgr, gate * P.mixAmount * 0.45);
  } else if (P.mode < 4.5) {
    let toned = plain.rgb / (1.0 + plain.rgb);
    let contrast = mix(toned, smoothstep(vec3<f32>(0.0), vec3<f32>(1.0), toned), P.strength);
    let tinted = mix(contrast, C.color.rgb * lum(contrast), P.mixAmount * 0.38);
    effect = tinted / max(vec3<f32>(0.02), vec3<f32>(1.0) - min(tinted, vec3<f32>(0.98)));
  } else if (P.mode < 5.5) {
    let scan = 0.86 + 0.14 * sin(frag.y * 3.14159265 * max(P.detail, 0.5));
    let grille = 0.92 + 0.08 * sin(frag.x * 3.14159265 * 0.9);
    let vignette = smoothstep(1.35, 0.28, length((uv - 0.5) * vec2<f32>(C.aspect, 1.0)));
    let warped = (uv - 0.5) * (1.0 + length(uv - 0.5) * P.strength * 0.16) + 0.5;
    let tube = textureSampleLevel(src, samp, warped, 0.0).rgb;
    effect = tube * scan * grille * mix(1.0, vignette, P.mixAmount);
  } else if (P.mode < 6.5) {
    // Quantised tone plus a cheap Sobel-like edge. This is the inked contour
    // treatment behind the flowing topographic reference rather than a blur.
    let east = lum(textureSampleLevel(src, samp, uv + vec2<f32>(px.x, 0.0) * P.radius, 0.0).rgb);
    let west = lum(textureSampleLevel(src, samp, uv - vec2<f32>(px.x, 0.0) * P.radius, 0.0).rgb);
    let north = lum(textureSampleLevel(src, samp, uv + vec2<f32>(0.0, px.y) * P.radius, 0.0).rgb);
    let south = lum(textureSampleLevel(src, samp, uv - vec2<f32>(0.0, px.y) * P.radius, 0.0).rgb);
    let edge = abs(east - west) + abs(north - south);
    let steps = 3.0 + floor(P.detail * 8.0);
    let quant = floor(lum(plain.rgb) * steps) / steps;
    let poster = plain.rgb * (0.34 + quant * (0.85 + P.strength * 0.55));
    let contourInk = smoothstep(0.035, 0.15 + P.strength * 0.20, edge);
    effect = mix(poster, C.color.rgb * (0.18 + quant * 0.72), P.mixAmount * 0.35)
      + vec3<f32>(contourInk) * (0.18 + P.strength * 0.82);
  } else if (P.mode < 7.5) {
    // Multi-tap threshold halo. Display bloom later in the chain still handles
    // the large glare; this adds the tight coloured tube around wire geometry.
    let direction = normalize(vec2<f32>(0.77, 0.64) + vec2<f32>(sin(beatTime * 0.19), cos(beatTime * 0.23)) * 0.2);
    let stepPx = direction * px * P.radius * (2.0 + P.detail * 3.5);
    let nearA = textureSampleLevel(src, samp, uv + stepPx, 0.0).rgb;
    let nearB = textureSampleLevel(src, samp, uv - stepPx, 0.0).rgb;
    let farA = textureSampleLevel(src, samp, uv + stepPx * 2.5, 0.0).rgb;
    let farB = textureSampleLevel(src, samp, uv - stepPx * 2.5, 0.0).rgb;
    let halo = max((nearA + nearB) * 0.5 - vec3<f32>(0.10), vec3<f32>(0.0))
      + max((farA + farB) * 0.25 - vec3<f32>(0.14), vec3<f32>(0.0));
    let tint = mix(vec3<f32>(1.0), C.color.rgb * 1.45, P.mixAmount * 0.45);
    effect = plain.rgb + halo * tint * P.strength * (0.65 + audio * 1.35);
  } else {
    // A rolling horizontal scan field re-samples the image in thin strips;
    // separate red/blue offsets keep it legible as a motion treatment, not a
    // full-frame glitch.
    let density = 28.0 + P.detail * 110.0;
    let row = floor(uv.y * density);
    let phase = hash21(vec2<f32>(row, floor(beatTime * 2.5) + C.seed));
    let beam = exp(-abs(fract(uv.y * density - beatTime * (0.55 + P.speed * 0.22)) - 0.5) * 10.0);
    let stripe = sin(uv.y * density * 0.75 + beatTime * 2.0 + phase * 6.283);
    let offset = vec2<f32>((stripe * 0.5 + phase - 0.5) * P.strength * (0.004 + audio * 0.012), 0.0);
    let shifted = textureSampleLevel(src, samp, uv + offset, 0.0).rgb;
    let split = px.x * P.radius * P.strength * (0.7 + beam * 2.0);
    effect = vec3<f32>(
      textureSampleLevel(src, samp, uv + offset + vec2<f32>(split, 0.0), 0.0).r,
      shifted.g,
      textureSampleLevel(src, samp, uv + offset - vec2<f32>(split, 0.0), 0.0).b,
    ) * (0.90 + beam * 0.22);
  }

  return vec4<f32>(mix(plain.rgb, effect, clamp(P.amount, 0.0, 1.0)), plain.a) * C.opacity;
}
