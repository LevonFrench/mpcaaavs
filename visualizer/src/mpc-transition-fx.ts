/** Original transition styles for the AAAVS Player and the MPC-HC host: indices 16-30 of mpc-transition.ts, plus the pure helpers
 * they share (seeded streams, quantised progress, the resolution unit).
 *
 * Written for this project as Canvas2D compositions. Nothing here is derived from vis_avs or any other upstream code, and no game,
 * film or third-party asset, glyph set or logo is used; numerals use the monospace stack the NERV scenes already use. The hazard,
 * hexagon, octagon and radar vocabulary shares geometry with nerv-scenes.ts (plate concepts adapted from bizarro/evangelion, MIT,
 * see THIRD-PARTY-NERV.txt); the drawing code is independent and the hazard pitch is quoted as a ratio (40/960) instead of imported.
 * The classic modes 1-14 stay in mpc-transition.ts under the vis_avs notice (THIRD-PARTY-AVS-TRANSITIONS.txt), which covers only that switch.
 *
 * Contract (docs/design/TRANSITIONS-V2.md 2.1 and docs/design/CONTRACT.md 2.3.3): every mode is a pure function of
 * (t, env.beatsTotal/bpm/seconds, constructor seed, w, h). env.level, env.bands, env.beatPhase and env.barPhase only scale decoration or
 * the shape of a bounded envelope, so a seek replays the reveal geometry exactly. t <= 0 draws exactly `old`; t >= 1 is handled by the
 * caller (`next` only). Reveal-family modes switch each pixel from old to new at most once (S1), stripe patterns are constant along
 * the direction of motion (S2), stepped effects obey the rate caps of `ticks` (S3), decoration stays under 15% of the frame with bright
 * decoration under 1% (S4), and no pixel takes more than one dark excursion (S5). */
import type { TransitionEnv } from './mpc-transition.ts';

type Ctx = CanvasRenderingContext2D | OffscreenCanvasRenderingContext2D;
export type FxCanvas = HTMLCanvasElement | OffscreenCanvas;
type Pt = readonly [number, number];

// ---- pure helpers shared with mpc-transition.ts -------------------------------------------------------------------------------------------

/** Mulberry-style stream; the classic Random and block order depend on this exact sequence. */
export function seededRandom(seed: number): () => number {
  let state = seed >>> 0;
  return () => {
    state = (state + 0x6d2b79f5) >>> 0;
    let value = Math.imul(state ^ state >>> 15, state | 1);
    value ^= value + Math.imul(value ^ value >>> 7, value | 61);
    return ((value ^ value >>> 14) >>> 0) / 4294967296;
  };
}
const mix32 = (x: number): number => { let n = x >>> 0; n = Math.imul(n ^ n >>> 16, 0x45d9f3b); n = Math.imul(n ^ n >>> 16, 0x45d9f3b); return (n ^ n >>> 16) >>> 0; };
/** Independent stream per consumer: salt 0 is the raw seed (the legacy classic stream), 1 STYLE, 2 SMART, 0x100 + mode for parameter tables.
 * Salt 0x44 is retired (contract C-08). */
export const subSeed = (seed: number, salt: number): number => salt === 0 ? seed >>> 0 : mix32((seed ^ Math.imul(salt, 0x9e3779b1)) >>> 0);
/** Order-sensitive 32-bit hash of integer parts (fractions are floored). Used for boundary seeds. */
export const hash32 = (...parts: number[]): number => {
  let h = 0x811c9dc5;
  for (const part of parts) { h = Math.imul(h ^ (Math.floor(part) | 0), 0x01000193); h ^= h >>> 15; }
  return mix32(h);
};
/** Quantised progress: 0 at t <= 0, non-decreasing, exactly 1 for the last 1/n of the transition (n >= 2). */
export const stepQ = (t: number, n: number): number => {
  const k = Math.max(2, Math.floor(Number.isFinite(n) ? n : 2));
  return !(t > 0) ? 0 : Math.min(1, Math.floor(Math.min(t, 1 - 1e-9) * k) / (k - 1));
};
const secondsOf = (env: TransitionEnv): number => {
  if (env.seconds !== undefined && Number.isFinite(env.seconds) && env.seconds > 0) return env.seconds;
  const bpm = Number.isFinite(env.bpm) && env.bpm > 0 ? env.bpm : 120, beats = Number.isFinite(env.beatsTotal) && env.beatsTotal > 0 ? env.beatsTotal : 4;
  return beats * 60 / bpm;
};
/** Steps for a stepped effect: `perBeat` steps per beat, at most `hz` per second (S3), between `lo` and `hi`. `lo` wins for very short transitions. */
export function ticks(env: TransitionEnv, perBeat: number, hz: number, lo = 2, hi = 32): number {
  const beats = Number.isFinite(env.beatsTotal) && env.beatsTotal > 0 ? env.beatsTotal : 4;
  return Math.max(lo, Math.min(hi, Math.round(beats * perBeat), Math.floor(hz * secondsOf(env))));
}
/** 1 for every classic AVS surface (width 640), so classic output is bit-identical; grows with the render surface for hairlines and dots. */
export const transitionUnit = (w: number, h: number): number => { const u = Math.round(Math.min(w / 640, h / 360)); return Number.isFinite(u) && u >= 1 ? u : 1; };

const TAU = Math.PI * 2;
const clamp = (v: number, lo = 0, hi = 1): number => v < lo ? lo : v > hi ? hi : v;
const clamp01 = (v: number): number => v > 0 ? v < 1 ? v : 1 : 0;
const ease = (t: number): number => (1 - Math.cos(clamp01(t) * Math.PI)) / 2;
const smoothstep = (a: number, b: number, x: number): number => { const k = clamp01((x - a) / (b - a)); return k * k * (3 - 2 * k); };
/** Decoration (rings, outlines, the radar trail) fades over the last 8% of the transition, so nothing pops when the caller switches to `next` at t = 1. Never used for reveal geometry. */
const tail = (t: number): number => 1 - smoothstep(.92, 1, t);
const noise = (...parts: number[]): number => hash32(...parts) / 4294967296;

// ---- state ---------------------------------------------------------------------------------------------------------------------------------

/** Per-transition state: the seed, lazily built parameter tables and the one scratch surface (Mosaic Drop). `draw` is otherwise stateless. */
export class FxState {
  private readonly tables = new Map<string, unknown>();
  scratch: FxCanvas | null = null;
  scratchW = 0;
  scratchH = 0;
  /** How many times the scratch surface changed size; Mosaic Drop keeps it at 12 or fewer per transition. */
  scratchResizes = 0;
  constructor(readonly mode: number, readonly seed: number, readonly createCanvas: () => FxCanvas) {}
  /** A table built once per key from the mode's parameter stream. Keys that include the frame size rebuild on resize. */
  table<T>(key: string, build: (random: () => number) => T): T {
    let value = this.tables.get(key) as T | undefined;
    if (value === undefined) {
      if (this.tables.size > 8) this.tables.clear();
      value = build(seededRandom(subSeed(this.seed, 0x100 + this.mode)));
      this.tables.set(key, value);
    }
    return value;
  }
}

const PALETTE = [
  { line: '#9fc4dc', hi: '#cfe3f0', ink: '#0b0d10' },
  { line: '#ff8526', hi: '#ffc15a', ink: '#050605' },
] as const;
const CRT_LINE = '#dfeaf5', BONE = '#eee4d1';

interface G { ctx: Ctx; old: CanvasImageSource; next: CanvasImageSource; t: number; w: number; h: number; env: TransitionEnv; u: number; st: FxState; pal: typeof PALETTE[number] }

const put = (g: G, source: CanvasImageSource, x = 0, y = 0, w = g.w, h = g.h): void => g.ctx.drawImage(source, x, y, w, h);
function clearSurface(c: Ctx, w: number, h: number): void { if (typeof c.clearRect === 'function') c.clearRect(0, 0, w, h); }
function dims(source: CanvasImageSource, w: number, h: number): [number, number] {
  const s = source as { width?: unknown; height?: unknown };
  return [typeof s.width === 'number' && s.width > 0 ? s.width : w, typeof s.height === 'number' && s.height > 0 ? s.height : h];
}
/** Slice of `source` (frame coordinates x, y, sw, sh) drawn at (dx, dy); sources of another size are scaled into frame space. */
function slice(g: G, source: CanvasImageSource, x: number, y: number, sw: number, sh: number, dx: number, dy: number): void {
  if (sw <= 0 || sh <= 0) return;
  const [pw, ph] = dims(source, g.w, g.h), fx = pw / g.w, fy = ph / g.h;
  g.ctx.drawImage(source, x * fx, y * fy, sw * fx, sh * fy, dx, dy, sw, sh);
}
function rects(ctx: Ctx, list: readonly (readonly [number, number, number, number])[]): void { ctx.beginPath(); for (const r of list) ctx.rect(r[0], r[1], r[2], r[3]); }
function tracePoly(ctx: Ctx, poly: readonly Pt[]): void { poly.forEach((p, i) => i ? ctx.lineTo(p[0], p[1]) : ctx.moveTo(p[0], p[1])); ctx.closePath(); }
/** Sutherland-Hodgman against the half-plane a*x + b*y <= c. */
function clipHalf(poly: readonly Pt[], a: number, b: number, c: number): Pt[] {
  const out: Pt[] = [];
  for (let i = 0; i < poly.length; i++) {
    const p = poly[i]!, q = poly[(i + 1) % poly.length]!, dp = a * p[0] + b * p[1] - c, dq = a * q[0] + b * q[1] - c;
    if (dp <= 0) out.push(p);
    if ((dp < 0 && dq > 0) || (dp > 0 && dq < 0)) { const k = dp / (dp - dq); out.push([p[0] + (q[0] - p[0]) * k, p[1] + (q[1] - p[1]) * k]); }
  }
  return out;
}
const frameRect = (w: number, h: number): Pt[] => [[0, 0], [w, 0], [w, h], [0, h]];
/** Reveal `next` through the path just built. */
function revealThrough(g: G): void { g.ctx.save(); g.ctx.clip(); put(g, g.next); g.ctx.restore(); }
const farthest = (cx: number, cy: number, w: number, h: number): number => Math.max(Math.hypot(cx, cy), Math.hypot(w - cx, cy), Math.hypot(cx, h - cy), Math.hypot(w - cx, h - cy));
function octagon(ctx: Ctx, x: number, y: number, r: number): void {
  ctx.moveTo(x + Math.cos(Math.PI / 8) * r, y + Math.sin(Math.PI / 8) * r);
  for (let i = 1; i < 8; i++) ctx.lineTo(x + Math.cos(Math.PI / 8 + i * Math.PI / 4) * r, y + Math.sin(Math.PI / 8 + i * Math.PI / 4) * r);
  ctx.closePath();
}

// ---- 16 Beat Step Wipe ---------------------------------------------------------------------------------------------------------------------

function beatStep(g: G): void {
  const { ctx, w, h, u } = g, dir = g.st.table('dir', r => Math.floor(r() * 4));
  const q = stepQ(g.t, ticks(g.env, 4, 8)), horizontal = dir < 2, extent = horizontal ? w : h, front = Math.round(q * extent);
  put(g, g.old);
  if (front <= 0) return;
  const forward = dir % 2 === 0, from = forward ? 0 : extent - front;
  const band: [number, number, number, number] = horizontal ? [from, 0, front, h] : [0, from, w, front];
  rects(ctx, [band]);
  revealThrough(g);
  if (q < 1) {
    const edge = forward ? front : extent - front - 2 * u;
    ctx.fillStyle = g.pal.line;
    if (horizontal) ctx.fillRect(edge, 0, 2 * u, h); else ctx.fillRect(0, edge, w, 2 * u);
  }
}

// ---- 17 Hazard Stripe Wipe -----------------------------------------------------------------------------------------------------------------

function hazard(g: G): void {
  const { ctx, w, h, env } = g, p = g.st.table('dir', r => ({ k: r() < .5 ? 1 : -1, mirror: r() < .5 }));
  const sx = p.mirror ? -1 : 1, sy = sx * p.k;
  const corners = [0, sx * w, sy * h, sx * w + sy * h], vMin = Math.min(...corners), span = Math.max(...corners) - vMin;
  const band = .14 * w, c = -band + ease(g.t) * (span + 2 * band);
  put(g, g.old);
  const frame = frameRect(w, h);
  if (c - band > 0) {
    const revealed = clipHalf(frame, sx, sy, c - band + vMin);
    if (revealed.length > 2) { ctx.beginPath(); tracePoly(ctx, revealed); revealThrough(g); }
  }
  const strip = clipHalf(clipHalf(frame, sx, sy, c + vMin), -sx, -sy, -(c - band + vMin));
  if (strip.length < 3) return;
  ctx.globalAlpha = .9; ctx.fillStyle = g.pal.ink; ctx.beginPath(); tracePoly(ctx, strip); ctx.fill(); ctx.globalAlpha = 1;
  // Stripes are slabs of constant v = x - k*y: perpendicular to the sweep, so a fixed pixel keeps one stripe colour while the band passes (S2).
  // They are clipped to the very path the ink was filled with, so a pixel on the band edge cannot take the ink from one polygon and the stripe from another.
  const period = Math.max(40 / 960 * w, (w + h) / 48, 4 * g.u), phase = env.reducedMotion ? 0 : clamp01(env.beatPhase) * period;
  const vs = [0, w, -p.k * h, w - p.k * h], vLo = Math.min(...vs), vHi = Math.max(...vs);
  ctx.save(); ctx.clip();
  ctx.fillStyle = g.pal.line; ctx.beginPath();
  for (let a = vLo - period + phase; a < vHi; a += period) {
    const slab = clipHalf(clipHalf(frame, 1, -p.k, a + period / 2), -1, p.k, -a);
    if (slab.length > 2) tracePoly(ctx, slab);
  }
  ctx.fill(); ctx.restore();
}

// ---- 18 MAGI Hex Reveal --------------------------------------------------------------------------------------------------------------------

interface Hex { R: number; cx: Float64Array; cy: Float64Array; tau: Float64Array }
function hexTable(random: () => number, w: number, h: number): Hex {
  let R = Math.max(4, w / 14), cols = 0, rows = 0, dx = 0, dy = 0;
  for (;;) { dx = R * Math.sqrt(3); dy = R * 1.5; cols = Math.ceil(w / dx) + 1; rows = Math.ceil(h / dy) + 1; if (cols * rows <= 128) break; R *= 1.1; }
  const n = cols * rows, cx = new Float64Array(n), cy = new Float64Array(n), tau = new Float64Array(n), e = Math.floor(random() * n);
  for (let i = 0; i < n; i++) { cx[i] = (i % cols) * dx + (Math.floor(i / cols) % 2) * dx / 2; cy[i] = Math.floor(i / cols) * dy; }
  let far = 1;
  for (let i = 0; i < n; i++) far = Math.max(far, Math.hypot(cx[i]! - cx[e]!, cy[i]! - cy[e]!));
  for (let i = 0; i < n; i++) tau[i] = Math.min(.999, .7 * Math.hypot(cx[i]! - cx[e]!, cy[i]! - cy[e]!) / far + .3 * random());
  return { R, cx, cy, tau };
}
function hexPath(ctx: Ctx, hex: Hex, scale: number, keep: (tau: number) => boolean): void {
  ctx.beginPath();
  for (let i = 0; i < hex.tau.length; i++) {
    if (!keep(hex.tau[i]!)) continue;
    for (let k = 0; k < 6; k++) {
      const a = Math.PI / 6 + k * Math.PI / 3, x = hex.cx[i]! + Math.cos(a) * hex.R * scale, y = hex.cy[i]! + Math.sin(a) * hex.R * scale;
      if (k) ctx.lineTo(x, y); else ctx.moveTo(x, y);
    }
    ctx.closePath();
  }
}
function magiHex(g: G): void {
  const { ctx, w, h } = g, hex = g.st.table(`hex${w}x${h}`, r => hexTable(r, w, h)), q = stepQ(g.t, ticks(g.env, 2, 4));
  put(g, g.old);
  if (q <= 0) return;
  hexPath(ctx, hex, 1.02, tau => tau < q); revealThrough(g);
  const fade = tail(g.t);
  if (fade < .004) return;
  ctx.lineJoin = 'round'; ctx.strokeStyle = g.pal.line; ctx.lineWidth = 1.5 * g.u; ctx.globalAlpha = fade;
  hexPath(ctx, hex, 1, tau => tau < q && tau >= q - .12); ctx.stroke();
  ctx.globalAlpha = .35 * fade; ctx.lineWidth = g.u;
  hexPath(ctx, hex, 1, tau => tau >= q && tau < q + .06); ctx.stroke(); ctx.globalAlpha = 1;
}

// ---- 19 AT Field Iris ----------------------------------------------------------------------------------------------------------------------

function atField(g: G): void {
  const { ctx, w, h, env, u } = g, p = g.st.table('iris', r => ({ open: r() < .5, offset: r() < .5, jx: r() * 2 - 1, jy: r() * 2 - 1 }));
  const cx = w / 2 + (p.offset ? p.jx * .15 * w : 0), cy = h / 2 + (p.offset ? p.jy * .15 * h : 0);
  const rMax = farthest(cx, cy, w, h) / Math.cos(Math.PI / 8) + 2, s = ease(g.t), R = (p.open ? s : 1 - s) * rMax;
  if (p.open) put(g, g.old); else put(g, g.next);
  if (R < .5) return;
  ctx.beginPath(); octagon(ctx, cx, cy, R); ctx.save(); ctx.clip(); put(g, p.open ? g.next : g.old); ctx.restore();
  const pulse = env.reducedMotion ? 0 : env.level + (1 - clamp01(env.beatPhase)), fade = tail(g.t);
  if (fade < .004) return;
  ctx.strokeStyle = g.pal.line; ctx.lineJoin = 'round';
  const rings: readonly (readonly [number, number])[] = [[1, .9], [p.open ? .9 : 1.1, .5], [p.open ? .8 : 1.2, .25]];
  for (const [scale, alpha] of rings) { ctx.globalAlpha = alpha * fade; ctx.lineWidth = (2 + pulse) * u; ctx.beginPath(); octagon(ctx, cx, cy, R * scale); ctx.stroke(); }
  ctx.globalAlpha = 1;
}

// ---- 20 Radar Sweep ------------------------------------------------------------------------------------------------------------------------

function radar(g: G): void {
  const { ctx, w, h, u } = g, p = g.st.table('radar', r => ({ a0: Math.floor(r() * 8) * Math.PI / 4, dir: r() < .5 ? 1 : -1 }));
  const cx = w / 2, cy = h / 2, R = farthest(cx, cy, w, h) + 2, theta = TAU * g.t, arm = p.a0 + p.dir * theta, ccw = p.dir < 0;
  put(g, g.old);
  if (theta * R < .5) return;   // a wedge narrower than half a pixel at the far corner reveals nothing visible (and would only be antialiasing noise)
  ctx.beginPath(); ctx.moveTo(cx, cy); ctx.arc(cx, cy, R, p.a0, arm, ccw); ctx.closePath(); revealThrough(g);
  const end = tail(g.t);
  if (end < .004) return;
  ctx.fillStyle = g.pal.line; ctx.globalAlpha = .1 * end;
  for (const width of [.1, .2, .3]) {
    ctx.beginPath(); ctx.moveTo(cx, cy); ctx.arc(cx, cy, R, arm - p.dir * Math.min(width, theta), arm, ccw); ctx.closePath(); ctx.fill();
  }
  const fade = Math.min(1, g.t / .04) * end;   // the arm and rings ease in at the start and out at the end, so nothing pops
  ctx.globalAlpha = fade; ctx.strokeStyle = g.pal.hi; ctx.lineWidth = 2 * u;
  ctx.beginPath(); ctx.moveTo(cx, cy); ctx.lineTo(cx + Math.cos(arm) * R, cy + Math.sin(arm) * R); ctx.stroke();
  ctx.globalAlpha = .2 * fade; ctx.strokeStyle = g.pal.line; ctx.lineWidth = u;
  ctx.beginPath(); ctx.arc(cx, cy, R / 3, 0, TAU); ctx.moveTo(cx + R * 2 / 3, cy); ctx.arc(cx, cy, R * 2 / 3, 0, TAU); ctx.stroke(); ctx.globalAlpha = 1;
}

// ---- 21 Venetian Blinds --------------------------------------------------------------------------------------------------------------------

function blinds(g: G): void {
  const { w, h } = g, p = g.st.table('blinds', r => {
    const count = [8, 10, 12, 16][Math.floor(r() * 4)]!, horizontal = r() < .5, turning = r() < .5;
    return { count, horizontal, turning, rnd: Array.from({ length: 16 }, () => r()) };
  });
  const extent = p.horizontal ? h : w, n = Math.max(1, Math.min(p.count, extent)), s = ease(g.t), list: [number, number, number, number][] = [];
  put(g, g.old);
  for (let i = 0; i < n; i++) {
    const a = Math.round(i * extent / n), b = Math.round((i + 1) * extent / n), size = b - a;
    const f = clamp01((s - .5 * (.7 * (n > 1 ? i / (n - 1) : 0) + .3 * p.rnd[i]!)) / .5), fill = f >= 1 ? size : Math.round(f * size);
    if (fill <= 0 || size <= 0) continue;
    const at = p.turning ? a + Math.floor((size - fill) / 2) : a;
    list.push(p.horizontal ? [0, at, w, fill] : [at, 0, fill, h]);
  }
  if (!list.length) return;
  rects(g.ctx, list); revealThrough(g);
}

// ---- 22 CRT Off / 23 CRT On ----------------------------------------------------------------------------------------------------------------

function crtLine(g: G, x: number, width: number): void {
  if (width < 1) return;
  g.ctx.globalAlpha = .85; g.ctx.fillStyle = CRT_LINE; g.ctx.fillRect(x, Math.round((g.h - 2 * g.u) / 2), width, 2 * g.u); g.ctx.globalAlpha = 1;
}
function crtOff(g: G): void {
  const { ctx, w, h, u, t } = g, split = .55;
  put(g, g.next);
  ctx.save(); ctx.imageSmoothingEnabled = true;
  let bright = false;
  if (t <= split) {
    const p = t / split, hh = Math.round(Math.max(2 * u, h * (1 - p * p * p)));
    put(g, g.old, 0, Math.round((h - hh) / 2), w, hh); bright = hh <= 6 * u;
    ctx.restore(); if (bright) crtLine(g, 0, w);
  } else {
    const p = (t - split) / (1 - split), ww = Math.round(w * (1 - p * p));
    if (ww >= 1) { put(g, g.old, Math.round((w - ww) / 2), Math.round((h - 2 * u) / 2), ww, 2 * u); }
    ctx.restore(); crtLine(g, Math.round((w - ww) / 2), ww);
  }
}
function crtOn(g: G): void {
  const { ctx, w, h, u, t } = g, split = .45;
  put(g, g.old);
  ctx.save(); ctx.imageSmoothingEnabled = true;
  if (t <= split) {
    const p = t / split, ww = Math.round(w * p * p), x = Math.round((w - ww) / 2);
    if (ww >= 1) put(g, g.next, x, Math.round((h - 2 * u) / 2), ww, 2 * u);
    ctx.restore(); crtLine(g, x, ww);
  } else {
    const p = (t - split) / (1 - split), hh = Math.round(2 * u + (h - 2 * u) * p * p * (3 - 2 * p));
    put(g, g.next, 0, Math.round((h - hh) / 2), w, hh);
    ctx.restore(); if (hh <= 6 * u) crtLine(g, 0, w);
  }
}

// ---- 24 Glitch Stutter ---------------------------------------------------------------------------------------------------------------------

const GLITCH_SOFT = .18;
function glitch(g: G): void {
  const { w, h, t, env } = g, p = g.st.table(`glitch${h}`, r => {
    const count = 10 + Math.floor(r() * 7), n = Math.max(1, Math.min(count, h)), weight = Array.from({ length: n }, () => { const v = r(); return .05 + v * v; });
    const total = weight.reduce((a, b) => a + b, 0), edge = [0]; let acc = 0;
    for (let i = 0; i < n; i++) { acc += weight[i]!; edge.push(i === n - 1 ? h : Math.round(acc / total * h)); }
    return { edge, tau: Array.from({ length: n }, () => .05 + r() * .75) };
  });
  const amplitude = env.reducedMotion ? 0 : .1 * w * 4 * t * (1 - t), tick = Math.floor(t * ticks(env, 2, 4, 1)), settled: [number, number, number, number][] = [];
  const shifted: { i: number; y: number; bh: number; dx: number; source: CanvasImageSource }[] = [];
  put(g, g.old);
  for (let i = 0; i < p.tau.length; i++) {
    const y = p.edge[i]!, bh = p.edge[i + 1]! - y, tau = p.tau[i]!;
    if (bh <= 0 || t < tau - GLITCH_SOFT) continue;
    if (t >= tau + GLITCH_SOFT) { settled.push([0, y, w, bh]); continue; }
    const before = t < tau, decay = before ? 1 : 1 - (t - tau) / GLITCH_SOFT, dx = Math.round((noise(i, tick, g.st.seed) - .5) * 2 * amplitude * decay);
    if (dx === 0) { if (!before) settled.push([0, y, w, bh]); continue; }
    shifted.push({ i, y, bh, dx, source: before ? g.old : g.next });
  }
  if (settled.length) { rects(g.ctx, settled); revealThrough(g); }
  for (const s of shifted) {
    slice(g, s.source, 0, s.y, w, s.bh, s.dx, s.y);
    slice(g, s.source, 0, s.y, w, s.bh, s.dx > 0 ? s.dx - w : s.dx + w, s.y);
  }
}

// ---- 25 Datamosh Smear ---------------------------------------------------------------------------------------------------------------------

const MOSH_SOFT = .22;
const DIRECTIONS: readonly Pt[] = [[1, 0], [-1, 0], [0, 1], [0, -1], [1, 1], [-1, 1], [1, -1], [-1, -1]];
function datamosh(g: G): void {
  const { w, h } = g, cols = Math.max(1, Math.min(12, w)), rows = Math.max(1, Math.min(7, h)), count = cols * rows;
  const p = g.st.table('mosh', r => {
    const dominant = DIRECTIONS[Math.floor(r() * 8)]!, rank = Array.from({ length: count }, (_, i) => i);
    for (let i = count - 1; i > 0; i--) { const j = Math.floor(r() * (i + 1)); [rank[i], rank[j]] = [rank[j]!, rank[i]!]; }
    return {
      // Stratified thresholds keep at most about a third of the blocks dragging at once (bounded draw count).
      tau: rank.map(k => MOSH_SOFT + (.96 - MOSH_SOFT) * (k + r() * .95) / count),
      mv: Array.from({ length: count }, () => [dominant[0] * .6 + (r() < .5 ? -.4 : .4), dominant[1] * .6 + (r() < .5 ? -.4 : .4)] as Pt),
    };
  });
  const q = stepQ(g.t, ticks(g.env, 2, 4, 4, 16)), [pw, ph] = dims(g.old, w, h), settled: [number, number, number, number][] = [];
  put(g, g.old);
  for (let i = 0; i < count; i++) {
    const c = i % cols, r = Math.floor(i / cols), x = Math.round(c * w / cols), y = Math.round(r * h / rows), bw = Math.round((c + 1) * w / cols) - x, bh = Math.round((r + 1) * h / rows) - y, tau = p.tau[i]!;
    if (bw <= 0 || bh <= 0 || q < tau - MOSH_SOFT) continue;
    if (q >= tau) { settled.push([x, y, bw, bh]); continue; }
    const drag = (q - (tau - MOSH_SOFT)) / MOSH_SOFT, mv = p.mv[i]!;
    const fx = pw / w, fy = ph / h, sx = clamp(x - mv[0] * drag * bw * 2, 0, Math.max(0, w - bw)), sy = clamp(y - mv[1] * drag * bh * 2, 0, Math.max(0, h - bh));
    g.ctx.drawImage(g.old, sx * fx, sy * fy, bw * fx, bh * fy, x, y, bw, bh);
  }
  if (settled.length) { rects(g.ctx, settled); revealThrough(g); }
}

// ---- 26 Tile Flip --------------------------------------------------------------------------------------------------------------------------

const FLIP = .4;
function tileFlip(g: G): void {
  const { ctx, w, h, t } = g, cols = Math.max(1, Math.min(8, w)), rows = Math.max(1, Math.min(5, h)), count = cols * rows;
  const p = g.st.table('flip', r => {
    const corner = Math.floor(r() * 5), ox = corner === 4 ? (cols - 1) / 2 : corner % 2 ? cols - 1 : 0, oy = corner === 4 ? (rows - 1) / 2 : corner < 2 ? 0 : rows - 1;
    const wave = Array.from({ length: count }, (_, i) => Math.hypot(i % cols - ox, Math.floor(i / cols) - oy)), far = Math.max(1e-6, ...wave);
    return { delay: wave.map(d => (1 - FLIP) * (.8 * d / far + .2 * r())) };
  });
  const settled: [number, number, number, number][] = [];
  put(g, g.old);
  const flipping: { x: number; y: number; tw: number; th: number; k: number; source: CanvasImageSource }[] = [];
  for (let i = 0; i < count; i++) {
    const c = i % cols, r = Math.floor(i / cols), x = Math.round(c * w / cols), y = Math.round(r * h / rows), tw = Math.round((c + 1) * w / cols) - x, th = Math.round((r + 1) * h / rows) - y;
    const k = clamp01((t - p.delay[i]!) / FLIP);
    if (tw <= 0 || th <= 0 || k <= 0) continue;
    if (k >= 1) { settled.push([x, y, tw, th]); continue; }
    flipping.push({ x, y, tw, th, k, source: k < .5 ? g.old : g.next });
  }
  if (settled.length) { rects(ctx, settled); revealThrough(g); }
  if (!flipping.length) return;
  ctx.save(); ctx.imageSmoothingEnabled = true;
  for (const f of flipping) {
    ctx.fillStyle = g.pal.ink; ctx.fillRect(f.x, f.y, f.tw, f.th);
    const width = f.tw * Math.abs(Math.cos(Math.PI * f.k)), left = f.x + (f.tw - width) / 2;
    if (width >= .5) { const [sw, sh] = dims(f.source, w, h), fx = sw / w, fy = sh / h; ctx.drawImage(f.source, f.x * fx, f.y * fy, f.tw * fx, f.th * fy, left, f.y, width, f.th); }
  }
  ctx.restore();
}

// ---- 27 Countdown Iris ---------------------------------------------------------------------------------------------------------------------

function countdown(g: G): void {
  const { ctx, w, h, u, t, env } = g, cx = w / 2, cy = h / 2, rMax = farthest(cx, cy, w, h) / Math.cos(Math.PI / 8) + 2, R = ease(t) * rMax;
  put(g, g.old);
  if (R < .5) return;
  ctx.beginPath(); ctx.arc(cx, cy, R, 0, TAU); revealThrough(g);
  ctx.strokeStyle = g.pal.line; ctx.lineWidth = 2 * u; ctx.beginPath(); ctx.arc(cx, cy, R, 0, TAU); ctx.stroke();
  const tick = 6 * u; ctx.beginPath();
  for (const [dx, dy] of [[1, 0], [0, 1], [-1, 0], [0, -1]] as const) { ctx.moveTo(cx + dx * (R - tick), cy + dy * (R - tick)); ctx.lineTo(cx + dx * (R + tick), cy + dy * (R + tick)); }
  ctx.stroke();
  const secs = secondsOf(env), beats = env.beatsTotal;
  if (beats < 2 || secs < .5) return;
  const K = Math.max(2, Math.min(clamp(Math.round(beats), 2, 9), Math.floor(4 * secs))), digit = K - Math.floor(Math.min(t, 1 - 1e-9) * K), alpha = clamp01((1 - t) / Math.min(.12, .5 / K));
  if (alpha < .02) return;
  ctx.globalAlpha = alpha; ctx.font = `600 ${Math.max(6, Math.round(.28 * h))}px Consolas, "Courier New", monospace`; ctx.textAlign = 'center'; ctx.textBaseline = 'middle';
  ctx.lineJoin = 'round'; ctx.lineWidth = 3 * u; ctx.strokeStyle = g.pal.ink; ctx.strokeText(String(digit), cx, cy);
  ctx.fillStyle = BONE; ctx.fillText(String(digit), cx, cy); ctx.globalAlpha = 1;
}

// ---- 28 Kick-Punch Zoom --------------------------------------------------------------------------------------------------------------------

function kickPunch(g: G): void {
  const { ctx, w, h, t, env } = g, amplitude = env.level > 0 ? .03 * env.level : .02;
  // The punch is geometric only, at most 3%, and fades to zero at both ends so the endpoints stay exact and continuous.
  const punch = env.reducedMotion ? 0 : amplitude * Math.pow(1 - clamp01(env.beatPhase), 3) * 4 * t * (1 - t);
  const so = 1 + .35 * Math.pow(t, 2.2) + punch, sn = 1.18 - .18 * (1 - (1 - t) * (1 - t)) + punch, a = smoothstep(.30, .70, t);
  const scaled = (source: CanvasImageSource, s: number): void => put(g, source, w / 2 - w * s / 2, h / 2 - h * s / 2, w * s, h * s);
  ctx.save(); ctx.imageSmoothingEnabled = true;
  if (a < 1) scaled(g.old, so);
  if (a > 0) { ctx.globalAlpha = a; scaled(g.next, sn); }
  ctx.restore();
}

// ---- 29 Mosaic Drop ------------------------------------------------------------------------------------------------------------------------

function pixelate(g: G, source: CanvasImageSource, p: number): void {
  const { ctx, st } = g, sw = Math.ceil(g.w / p), sh = Math.ceil(g.h / p);
  st.scratch ??= st.createCanvas();
  if (st.scratchW !== sw || st.scratchH !== sh) { st.scratch.width = sw; st.scratch.height = sh; st.scratchW = sw; st.scratchH = sh; st.scratchResizes++; }
  const sc = st.scratch.getContext('2d') as Ctx | null;
  if (!sc) throw Error('Transition canvas unavailable');
  clearSurface(sc, sw, sh); sc.globalAlpha = 1; sc.imageSmoothingEnabled = true; sc.imageSmoothingQuality = 'high'; sc.drawImage(source, 0, 0, sw, sh);
  ctx.save(); ctx.imageSmoothingEnabled = false; ctx.drawImage(st.scratch, 0, 0, sw, sh, 0, 0, sw * p, sh * p); ctx.restore();
}
function mosaic(g: G): void {
  const { ctx, w, h, t, env } = g, beats = env.beatsTotal, secs = secondsOf(env), bmax = Math.max(2, Math.round(w / 16)), drop = clamp(1 - 1 / beats, .5, .9);
  if (t < drop) {
    const steps = Math.max(2, Math.min(8, Math.ceil(beats) - 1, Math.floor(8 * secs * drop))), j = Math.min(steps - 1, Math.floor(t / drop * steps));
    const p = Math.max(1, Math.round(bmax * Math.pow(j / steps, 1.6)));
    if (p <= 1) put(g, g.old); else pixelate(g, g.old, p);
    return;
  }
  const k = Math.min(3, Math.floor((t - drop) / (1 - drop) * 4)), p = [bmax, Math.max(1, Math.round(bmax / 2)), Math.max(1, Math.round(bmax / 4)), 1][k]!;
  if (p <= 1) put(g, g.next); else pixelate(g, g.next, p);
  const R = farthest(w / 2, h / 2, w, h) * (t - drop) / (1 - drop);
  if (R >= 1 && tail(t) >= .004) { ctx.globalAlpha = .6 * tail(t); ctx.strokeStyle = g.pal.line; ctx.lineWidth = 2 * g.u; ctx.beginPath(); ctx.arc(w / 2, h / 2, R, 0, TAU); ctx.stroke(); ctx.globalAlpha = 1; }
}

// ---- 30 Spectrum Bars Wipe -----------------------------------------------------------------------------------------------------------------

function spectrumBars(g: G): void {
  const { ctx, w, h, u, env } = g, n = Math.max(1, Math.min(16, w)), q = ease(g.t);
  const seeded = g.st.table('spectrum', r => Array.from({ length: 16 }, (_, i) => clamp01(r() * (1.15 - .6 * i / 15))));
  const list: [number, number, number, number][] = [], caps: [number, number, number, number][] = [];
  put(g, g.old);
  for (let i = 0; i < n; i++) {
    const level = env.bands && Number.isFinite(env.bands[i]) ? clamp01(env.bands[i]!) : seeded[i]!;
    const f = clamp01(q + .35 * (level - .5) * 4 * q * (1 - q)), x0 = Math.round(i * w / n), x1 = Math.round((i + 1) * w / n), fill = Math.round(f * h);
    if (fill <= 0 || x1 <= x0) continue;
    list.push([x0, h - fill, x1 - x0, fill]);
    if (fill < h) caps.push([x0, h - fill - 2 * u, x1 - x0, 2 * u]);
  }
  if (!list.length) return;
  rects(ctx, list); revealThrough(g);
  if (caps.length) { ctx.fillStyle = g.pal.hi; rects(ctx, caps); ctx.fill(); }
}

// ---- dispatch ------------------------------------------------------------------------------------------------------------------------------

export const FX_FIRST = 16, FX_LAST = 30;
const MODES: Record<number, (g: G) => void> = {
  16: beatStep, 17: hazard, 18: magiHex, 19: atField, 20: radar, 21: blinds, 22: crtOff, 23: crtOn, 24: glitch, 25: datamosh, 26: tileFlip,
  27: countdown, 28: kickPunch, 29: mosaic, 30: spectrumBars,
};
/** Steps used by the stepped modes (0 for the others), so tests can check the rate caps of S3. */
export function fxSteps(mode: number, env: TransitionEnv): number {
  return mode === 16 ? ticks(env, 4, 8) : mode === 18 ? ticks(env, 2, 4) : mode === 24 ? ticks(env, 2, 4, 1) : mode === 25 ? ticks(env, 2, 4, 4, 16) : 0;
}
/** Draw one frame of styles 16-30. Each mode draws its own base, so the caller must not draw `old` first. `t` is in (0, 1); t <= 0 draws `old` only. */
export function drawFx(state: FxState, ctx: Ctx, old: CanvasImageSource, next: CanvasImageSource, t: number, w: number, h: number, env: TransitionEnv): void {
  const g: G = { ctx, old, next, t, w, h, env, u: transitionUnit(w, h), st: state, pal: PALETTE[env.accent === 1 ? 1 : 0] };
  const mode = MODES[state.mode];
  if (!mode || !(t > 0)) { put(g, old); return; }
  mode(g);
  ctx.globalAlpha = 1;
}
