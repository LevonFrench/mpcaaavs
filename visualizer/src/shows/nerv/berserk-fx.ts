// Ported from bizarro/evangelion app/src/scenes/berserk-fx.ts (MIT, Copyright (c) 2026 Giacomo Magnanini, Luis Bizarro; see THIRD-PARTY-NERV.txt).
// Shared helpers for the last three plates (berserk, impact, end): a row-glitch compositor for the
// Canvas2D HUD layer, onset lookups on the real drum hits, a kick bounce on the actual kick onsets
// (drop 3's kick pattern sits off the quarter grid, so pump() would bounce between the kicks), and
// palette-token colour mixes for the red-shift.
import * as THREE from 'three';
import type { AudioData } from '../../show/audio.ts';
import { FSPass } from '../../show/gl.ts';
import { HEX, type PaletteKey } from '../../show/palette.ts';
import { clamp } from '../../show/util.ts';

/**
 * Composites a Layer2D texture over `out` (premultiplied normal blend) with horizontal row-band
 * glitches and an RGB split. amt 0..1 (0 = plain composite), seed changes the band pattern.
 */
export function makeGlitchComp() {
  const p = new FSPass(/* glsl */ `
    uniform sampler2D tex; uniform float amt, seed, split, opacity;
    vec4 tap(vec2 uv) { if (uv.x < 0.0 || uv.x > 1.0) return vec4(0.0); return texture(tex, uv); }
    void main() {
      vec2 uv = vUv;
      float y = (1.0 - vUv.y) * 1080.0;
      float bA = floor(y / 46.0), bB = floor(y / 9.0);
      float onA = step(1.0 - amt * 0.34, hash12(vec2(bA, seed)));
      float onB = step(1.0 - amt * 0.22, hash12(vec2(bB, seed + 3.1)));
      float dx = (hash12(vec2(bA, seed + 7.7)) - 0.5) * 0.16 * onA + (hash12(vec2(bB, seed + 1.3)) - 0.5) * 0.03 * onB;
      uv.x += dx * amt;
      float s = (split + amt * 5.0 * (onA + onB)) / 1920.0;
      vec4 r = tap(uv + vec2(s, 0.0)), g = tap(uv), b = tap(uv - vec2(s, 0.0));
      float a = max(g.a, max(r.a, b.a));
      vec3 c = vec3(r.r * r.a, g.g * g.a, b.b * b.a);
      fragColor = vec4(c, a) * opacity;
    }`, { tex: { value: null }, amt: { value: 0 }, seed: { value: 0 }, split: { value: 0 }, opacity: { value: 1 } }, { blending: THREE.CustomBlending, transparent: true });
  const m = p.mat;
  m.blendEquation = THREE.AddEquation;
  m.blendSrc = THREE.OneFactor; m.blendDst = THREE.OneMinusSrcAlphaFactor;
  m.blendSrcAlpha = THREE.OneFactor; m.blendDstAlpha = THREE.OneMinusSrcAlphaFactor;
  return {
    pass: p,
    draw(renderer: THREE.WebGLRenderer, tex: THREE.Texture, out: THREE.WebGLRenderTarget, amt: number, seed: number, split = 0, opacity = 1) {
      p.u.tex!.value = tex; p.u.amt!.value = amt; p.u.seed!.value = seed; p.u.split!.value = split; p.u.opacity!.value = opacity;
      p.render(renderer, out);
    },
  };
}

/** Index of the last onset of `kind` at or before t with strength >= minS (-1 if none). */
export function lastIdx(au: AudioData, kind: string, t: number, minS = 0): number {
  const L = au.onsets[kind] ?? [];
  let lo = 0, hi = L.length;
  while (lo < hi) { const m = (lo + hi) >> 1; if (L[m]![0] <= t) lo = m + 1; else hi = m; }
  for (let i = lo - 1; i >= 0; i--) if (L[i]![1] >= minS) return i;
  return -1;
}
/** Time of the last onset of `kind` (strength >= minS) at or before t, or -1e9. */
export function lastT(au: AudioData, kind: string, t: number, minS = 0): number {
  const i = lastIdx(au, kind, t, minS);
  return i < 0 ? -1e9 : au.onsets[kind]![i]![0];
}

/** Kick bounce 0..1 on the real kick onsets: 1 at the hit, eased recovery over `rec` s. */
export function kickDuck(au: AudioData, t: number, rec = 0.34, minS = 0.6) {
  const i = lastIdx(au, 'kick', t, minS);
  if (i < 0) return 0;
  const [kt, s] = au.onsets.kick![i]!;
  const x = clamp((t - kt) / rec);
  return (1 - x) * (1 - x) * Math.min(1, s);
}

const hexRGB = (k: PaletteKey) => { const n = parseInt(HEX[k].slice(1), 16); return [(n >> 16) & 255, (n >> 8) & 255, n & 255]; };
/** CSS colour mixing two palette tokens (k = 0 → a, 1 → b). */
export function mix(a: PaletteKey, b: PaletteKey, k: number, alpha = 1) {
  const A = hexRGB(a), B = hexRGB(b), u = clamp(k);
  return `rgba(${Math.round(A[0]! + (B[0]! - A[0]!) * u)},${Math.round(A[1]! + (B[1]! - A[1]!) * u)},${Math.round(A[2]! + (B[2]! - A[2]!) * u)},${alpha})`;
}
