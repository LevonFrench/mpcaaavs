// Ported from bizarro/evangelion app/src/scenes/sync-kit.ts (MIT, Copyright (c) 2026 Giacomo Magnanini, Luis Bizarro; see THIRD-PARTY-NERV.txt).
// Helpers for the sync plate (build 2): the hex ground that fills with the sync level, a HUD
// compositor with row glitches + tint + CRT collapse, colour mixes over palette tokens, the two
// heartbeat morphologies, and the glitch text scrambler for the bar-77 roll.
import * as THREE from 'three';
import { FSPass } from '../../show/gl.ts';
import { HEX, LIN, type PaletteKey } from '../../show/palette.ts';
import { clamp, hash } from '../../show/util.ts';
import { GLSL_EVA } from './_eva.ts';

/**
 * Pointy-top hex ground. `rad` = cell radius (tightens bar by bar), `lvl` 0..1 = the sync level:
 * every cell whose centre sits below the level line is faintly filled, the top row of filled
 * cells glows (a hex-stepped liquid line). colA → colB by `creep` for the hairlines.
 */
export function makeSyncGround() {
  return new FSPass(/* glsl */ `
    ${GLSL_EVA}
    uniform float t, rad, lvl, seed, kick, vis, creep, glow;
    uniform vec3 colA, colB, colC;
    void main() {
      vec2 p = vec2(FRAG_PX.x, 1080.0 - FRAG_PX.y);
      vec4 h = hexCell(p, rad);
      float e = hexEdge(h.xy, rad);
      float line = pxLine(e, 0.5, 1.5);
      vec2 cc = p - h.xy;
      float n = hash12(h.zw + seed * 1.37);
      float inner = smoothstep(1.5, 3.5, e);
      vec2 uv = p / vec2(1920.0, 1080.0) - 0.5;
      float fall = 1.0 - smoothstep(0.25, 0.8, length(uv * vec2(1.0, 1.4)));
      vec3 fc = mix(colA, colB, creep);
      vec3 c = C_INK + fc * line * 0.055 * (0.5 + 0.5 * fall) * (1.0 + 1.4 * kick);
      float yl = 1080.0 * (1.0 - lvl);
      float below = step(yl, cc.y);
      float rim = below * (1.0 - step(yl + rad * 1.6, cc.y));
      c += colC * inner * (below * 0.02 * (0.55 + 0.45 * n) + rim * 0.07 * (0.6 + 0.4 * glow) * (0.5 + 0.5 * n));
      c += fc * inner * step(0.988, n) * 0.06;
      fragColor = vec4(c * vis, 1.0);
    }`, {
    t: { value: 0 }, rad: { value: 38 }, lvl: { value: 0 }, seed: { value: 0 }, kick: { value: 0 }, vis: { value: 1 }, creep: { value: 0 }, glow: { value: 0 },
    colA: { value: [...LIN.orange] }, colB: { value: [...LIN.purple] }, colC: { value: [...LIN.lime] },
  });
}

/**
 * Composites a Layer2D texture over the target (straight alpha in, premultiplied over) with
 * horizontal row-band glitches, an RGB split, a tint, and a CRT collapse: `sq` squeezes the image
 * vertically towards the centre line (1 = normal, → 0 = a line) and `beam` adds the bright line.
 */
export function makeSyncComp() {
  const p = new FSPass(/* glsl */ `
    uniform sampler2D tex; uniform float amt, seed, split, opacity, sq, beam; uniform vec3 tint;
    vec4 tap(vec2 uv) { if (uv.x < 0.0 || uv.x > 1.0 || uv.y < 0.0 || uv.y > 1.0) return vec4(0.0); return texture(tex, uv); }
    void main() {
      vec2 uv = vUv;
      uv.y = (uv.y - 0.5) / max(sq, 1e-3) + 0.5;
      float y = (1.0 - vUv.y) * 1080.0;
      float bA = floor(y / 38.0), bB = floor(y / 7.0);
      float onA = step(1.0 - amt * 0.34, hash12(vec2(bA, seed)));
      float onB = step(1.0 - amt * 0.22, hash12(vec2(bB, seed + 3.1)));
      float dx = (hash12(vec2(bA, seed + 7.7)) - 0.5) * 0.14 * onA + (hash12(vec2(bB, seed + 1.3)) - 0.5) * 0.03 * onB;
      uv.x += dx * amt;
      float s = (split + amt * 6.0 * (onA + onB)) / 1920.0;
      vec4 r = tap(uv + vec2(s, 0.0)), g = tap(uv), b = tap(uv - vec2(s, 0.0));
      float a = max(g.a, max(r.a, b.a));
      vec3 c = vec3(r.r * r.a, g.g * g.a, b.b * b.a) * tint;
      float ln = beam * exp(-abs(vUv.y - 0.5) * 1080.0 / 2.2) * (1.0 - smoothstep(0.2, 0.62, abs(vUv.x - 0.5)));
      c += vec3(1.6, 1.4, 2.2) * ln;
      a = max(a, clamp(ln, 0.0, 1.0));
      fragColor = vec4(c, a) * opacity;
    }`, {
    tex: { value: null }, amt: { value: 0 }, seed: { value: 0 }, split: { value: 0 }, opacity: { value: 1 }, sq: { value: 1 }, beam: { value: 0 },
    tint: { value: new THREE.Vector3(1, 1, 1) },
  }, { blending: THREE.CustomBlending, transparent: true });
  const m = p.mat;
  m.blendEquation = THREE.AddEquation;
  m.blendSrc = THREE.OneFactor; m.blendDst = THREE.OneMinusSrcAlphaFactor;
  m.blendSrcAlpha = THREE.OneFactor; m.blendDstAlpha = THREE.OneMinusSrcAlphaFactor;
  return {
    pass: p,
    draw(renderer: THREE.WebGLRenderer, tex: THREE.Texture, out: THREE.WebGLRenderTarget, o: { amt?: number; seed?: number; split?: number; opacity?: number; sq?: number; beam?: number; tint?: [number, number, number] } = {}) {
      const u = p.u;
      u.tex!.value = tex; u.amt!.value = o.amt ?? 0; u.seed!.value = o.seed ?? 0; u.split!.value = o.split ?? 0;
      u.opacity!.value = o.opacity ?? 1; u.sq!.value = o.sq ?? 1; u.beam!.value = o.beam ?? 0;
      (u.tint!.value as THREE.Vector3).set(...(o.tint ?? [1, 1, 1]));
      p.render(renderer, out);
    },
  };
}

const RGB = {} as Record<PaletteKey, [number, number, number]>;
for (const k of Object.keys(HEX) as PaletteKey[]) { const n = parseInt(HEX[k].slice(1), 16); RGB[k] = [(n >> 16) & 255, (n >> 8) & 255, n & 255]; }

/** CSS colour: palette token a → b by k1, then → c by k2 (the Unit-01 creep, then the red-shift). */
export function mix3(a: PaletteKey, b: PaletteKey, k1: number, c: PaletteKey = 'red', k2 = 0, alpha = 1) {
  const A = RGB[a], B = RGB[b], C = RGB[c], u = clamp(k1), v = clamp(k2);
  const ch = (i: number) => Math.round((A[i]! + (B[i]! - A[i]!) * u) * (1 - v) + C[i]! * v);
  return `rgba(${ch(0)},${ch(1)},${ch(2)},${alpha})`;
}

/** Pilot ECG complex (P, Q, R, S, T), dt = seconds from the beat. */
export const qrsPilot = (dt: number) =>
  0.12 * Math.exp(-(((dt + 0.08) / 0.022) ** 2)) - 0.16 * Math.exp(-(((dt + 0.016) / 0.007) ** 2))
  + 1.0 * Math.exp(-((dt / 0.008) ** 2)) - 0.32 * Math.exp(-(((dt - 0.02) / 0.009) ** 2)) + 0.18 * Math.exp(-(((dt - 0.13) / 0.035) ** 2));

/** Eva-01 complex: a broader, biphasic beast of a heartbeat. */
export const qrsEva = (dt: number) =>
  -0.2 * Math.exp(-(((dt + 0.03) / 0.014) ** 2)) + 0.85 * Math.exp(-((dt / 0.013) ** 2))
  - 0.55 * Math.exp(-(((dt - 0.032) / 0.016) ** 2)) + 0.26 * Math.exp(-(((dt - 0.1) / 0.03) ** 2));

const GLYPHS = '0123456789ABCDEF#%?/*=<>ERR:;_';
/** Replace characters of `s` by glitch glyphs with probability `amt`, stable for (seed). Keeps spaces. */
export function scramble(s: string, seed: number, amt: number) {
  if (amt <= 0) return s;
  let o = '';
  for (let i = 0; i < s.length; i++) {
    const ch = s[i]!;
    o += ch !== ' ' && hash(seed, i, 41) < amt ? GLYPHS[Math.floor(hash(seed, i, 42) * GLYPHS.length)]! : ch;
  }
  return o;
}
