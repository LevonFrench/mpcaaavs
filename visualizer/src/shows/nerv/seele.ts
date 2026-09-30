// Ported from bizarro/evangelion app/src/scenes/seele.ts (MIT, Copyright (c) 2026 Giacomo Magnanini, Luis Bizarro; see THIRD-PARTY-NERV.txt).
// seele — "SOUND ONLY" (break 1: bass + pads, no drums; bars 24–29, 48.02 – 57.02 s).
// The council in the void: twelve black monoliths floating in a ring over a black mirror floor,
// every face turned toward the accused (the camera). Each monolith is one pitch class of the
// harmonic stem (MEMBER 01 = C … 12 = B, clockwise like a chroma wheel): its red number, SOUND
// ONLY and edge glow brighten with that pitch class, and its face meter is the chroma level. The
// bass pitch class is the member speaking: it burns hot, pools red light on the floor, swings the
// clock hand drawn on the floor toward it, and the camera slowly turns to face it (C♯ → D♯ → F →
// G♯ in this break). Around it, a sparse terminal: the council roster, the speaker callout with
// its leader line and voice scope, the minutes typing out on each turn, a chromagram voice print.
// Ray traced in one fullscreen pass (12 boxes + a mirror floor); no pump, slow drift, ominous.
import * as THREE from 'three';
import { Scene, type Frame, type PostOverrides } from '../../show/scene.ts';
import { FSPass, Layer2D, SS_TAP, SS_TAP_GLSL, W, H } from '../../show/gl.ts';
import { LIN, rgba } from '../../show/palette.ts';
import { F, font } from '../../show/type.ts';
import { clamp, ease, frameIdx, hash, lerp, prog, pulse, smoothstep } from '../../show/util.ts';
import { barTime, brackets, chamferPath, condensed, evaLabel, jp, makeScanPass, sevenSeg, songBar, ticker } from './_eva.ts';
import {
  ATLAS, CAM, FLOOR_Y, MINUTES, MONO, PC, RING, faceCorners, makeCam, makeFaceAtlas, memberAngle, memberBase, memberPos, memberYaw,
  meterH, noteLabel, project, smoothChroma, speakWeights, speakerTurns, turnAt, vtext, type Cam, type Turn, type V3,
} from './seele-kit.ts';

const COUNCIL_FRAG = /* glsl */ `
${SS_TAP_GLSL}
uniform vec3 camPos, camR, camU, camF;
uniform vec2 tanXY;
uniform vec4 mono[12];          // centre xyz, yaw
uniform float inten[12];        // chroma per member 0..1
uniform float speak[12];        // speaking weight 0..1
uniform float power[12];        // powered on 0..1 (flicker)
uniform sampler2D atlas;
uniform vec3 ringC;
uniform float t, pads, bassE, voice, handAng, handOn, ringOn;

const vec3 HE = vec3(${MONO.hw.toFixed(3)}, ${MONO.hh.toFixed(3)}, ${MONO.hd.toFixed(3)});
const float FLOORY = ${FLOOR_Y.toFixed(3)};
const float RR = ${RING.r.toFixed(3)};
const float TEXPU = ${(ATLAS.ch / (2 * MONO.hh)).toFixed(2)};  // atlas texels per world unit

// nearest monolith hit along the ray: returns distance (1e9 = miss), member, local hit point, local normal
float traceCouncil(vec3 ro, vec3 rd, out int hk, out vec3 hl, out vec3 hn) {
  float best = 1e9; hk = -1; hl = vec3(0.0); hn = vec3(0.0);
  for (int k = 0; k < 12; k++) {
    vec4 m = mono[k];
    float cy = cos(m.w), sy = sin(m.w);
    vec3 ax = vec3(cy, 0.0, -sy), az = vec3(sy, 0.0, cy);
    vec3 p = ro - m.xyz;
    vec3 o = vec3(dot(p, ax), p.y, dot(p, az));
    vec3 d = vec3(dot(rd, ax), rd.y, dot(rd, az));
    vec3 inv = 1.0 / (abs(d) + 1e-7) * sign(d + 1e-12);
    vec3 ta = (-HE - o) * inv, tb = (HE - o) * inv;
    vec3 tmn = min(ta, tb), tmx = max(ta, tb);
    float tn = max(max(tmn.x, tmn.y), tmn.z);
    float tf = min(min(tmx.x, tmx.y), tmx.z);
    if (tn < tf && tn > 0.0 && tn < best) {
      best = tn; hk = k; hl = o + d * tn;
      vec3 sel = vec3(tmn.x >= tn ? 1.0 : 0.0, tmn.y >= tn && tmn.x < tn ? 1.0 : 0.0, tmn.z >= tn && tmn.x < tn && tmn.y < tn ? 1.0 : 0.0);
      hn = -sign(d) * sel;
    }
  }
  return best;
}

// shade a monolith surface; dist = ray distance (for the texture LOD and hairline widths)
vec3 shadeMono(int k, vec3 L, vec3 N, float dist) {
  float I = inten[k], S = speak[k], P = power[k];
  float pw = dist * 2.0 * tanXY.y / (${H.toFixed(1)} * PX_SCALE);  // world units per physical px
  vec3 col;
  if (N.z > 0.5) {
    vec2 uv = vec2(0.5 - L.x / (2.0 * HE.x), 0.5 + L.y / (2.0 * HE.y));
    vec2 cell = vec2(float(k % 6), float(1 - k / 6));
    vec2 auv = (cell + clamp(uv, 0.002, 0.998)) / vec2(6.0, 2.0);
    float lod = max(0.0, log2(TEXPU * pw) - 0.35);
    vec3 m = textureLod(atlas, auv, lod).rgb;
    // black lacquer: faint vertical sheen, a touch of red spill from the text
    col = vec3(0.0022, 0.0017, 0.0016) * (0.45 + 0.9 * uv.y) * (0.35 + 0.65 * P);
    float lit = P * (0.07 + 1.25 * pow(I, 1.6)) + S * P * (1.1 + 1.9 * bassE);
    vec3 txt = mix(C_RED, mix(C_EMBER, C_BONE, 0.35), 0.3 * S);
    col += txt * m.r * lit;
    col += C_RED * m.g * P * (0.05 + 0.22 * I + 0.45 * S);
    col += C_RED * m.b * P * (0.08 + 0.3 * I + 0.5 * S);
    col += C_RED * 0.004 * lit * (1.0 - m.r);
    // voice meter: 16 segments in the framed slot (chroma level; the speaker's is its voice)
    vec2 mu = vec2((uv.x - 0.105) / 0.79, (uv.y - 0.14) / 0.08);
    if (mu.x > 0.0 && mu.x < 1.0 && mu.y > 0.0 && mu.y < 1.0) {
      float sgi = floor(mu.x * 16.0), sf = fract(mu.x * 16.0);
      float lvl = mix(I * 0.9, 0.55 + 0.45 * voice, S);
      float on = step(sgi + 0.5, lvl * 16.0) * step(0.14, sf) * step(sf, 0.86);
      col += mix(C_RED, C_EMBER, step(12.5, sgi)) * on * P * (0.12 + 0.5 * I + 1.4 * S) + C_RED * 0.01 * P;
    }
    // hairline rim around the face
    float e = min(min(uv.x, 1.0 - uv.x) * 2.0 * HE.x, min(uv.y, 1.0 - uv.y) * 2.0 * HE.y);
    float rim = pxLine(e / pw, 0.8, 2.2);
    col += C_RED * rim * P * (0.05 + 0.5 * I + 1.3 * S);
  } else {
    // sides / top / back: lacquer, a dim edge where it meets the front
    float up = N.y > 0.5 ? 1.0 : 0.0;
    col = vec3(0.0012, 0.001, 0.0009) * (1.0 + 2.5 * up) * (0.35 + 0.65 * P);
    float ez = (HE.z - L.z);
    col += C_RED * pxLine(ez / pw, 0.8, 2.0) * P * (0.03 + 0.25 * I + 0.8 * S);
  }
  return col;
}

vec3 shadeRay(vec2 px) {
  vec2 ndc = px / vec2(${W.toFixed(1)}, ${H.toFixed(1)}) * 2.0 - 1.0;
  vec3 rd = normalize(camF + ndc.x * tanXY.x * camR + ndc.y * tanXY.y * camU);
  vec3 ro = camPos;

  int hk; vec3 hl, hn;
  float th = traceCouncil(ro, rd, hk, hl, hn);

  // void: black with the faintest red breath at the horizon (the pads)
  vec3 col = C_INK * 0.25 + C_RED * 0.0035 * (0.4 + pads) * exp(-abs(rd.y + 0.12) * 9.0);

  // floor (computed for every ray so the derivatives are defined)
  float tfl = rd.y < -1e-4 ? (FLOORY - ro.y) / rd.y : 1e4;
  vec3 q = ro + rd * min(tfl, 400.0);
  vec2 v = q.xz - ringC.xz;
  float rr = length(v);
  float fw = max(length(fwidth(q.xz)), 1e-6);                     // world units per physical px
  float ang = atan(v.x, v.y);

  if (tfl < th && tfl < 1e3) {
    // mirror: trace the council again from the floor
    vec3 rr2 = vec3(rd.x, -rd.y, rd.z);
    int rk; vec3 rl, rn;
    float tr = traceCouncil(q + rr2 * 1e-3, rr2, rk, rl, rn);
    vec3 fc = vec3(0.0012, 0.001, 0.001);
    if (rk >= 0) {
      float hgt = (q.y + rr2.y * tr) - FLOORY;
      fc += shadeMono(rk, rl, rn, tfl + tr) * 0.16 * exp(-hgt * 0.55);
    }
    // red light pooled under the members (the speaker most)
    for (int k = 0; k < 12; k++) {
      vec2 d = q.xz - mono[k].xz;
      float g = dot(d, d);
      fc += C_RED * power[k] * (0.012 * inten[k] + 0.09 * speak[k] * (0.5 + bassE)) * exp(-g / 1.6);
    }
    // the clock on the floor: inner table ring with 60 ticks, member ticks lit by chroma, outer ring
    float R1 = RR - 1.9, R2 = RR + 1.25;
    float ringA = ringOn;
    float sweep = step(ang / 6.2831853 + 0.5, ringOn * 1.0001);
    float l1 = pxLine(abs(rr - R1) / fw, 0.5, 1.5) + pxLine(abs(rr - R2) / fw, 0.5, 1.5) * 0.7;
    float tk = ang / (6.2831853 / 60.0);
    float tkd = abs(fract(tk + 0.5) - 0.5) * (6.2831853 / 60.0) * rr;
    float isMaj = step(abs(fract((ang - ${RING.off.toFixed(5)}) / (6.2831853 / 12.0) + 0.5) - 0.5), 0.02);
    float band = step(R1 - 0.28 - 0.3 * isMaj, rr) * step(rr, R1);
    float ticks = pxLine(tkd / fw, 0.5, 1.4) * band;
    int mk = int(mod(floor((ang - ${RING.off.toFixed(5)}) / (6.2831853 / 12.0) + 0.5), 12.0));
    float mi = inten[mk], ms = speak[mk];
    vec3 rc = C_RED * (0.05 + 0.12 * pads);
    fc += (rc * l1 + C_RED * ticks * (0.05 + (0.5 * mi + 1.2 * ms) * isMaj)) * sweep * ringA;
    // arc segment on the outer ring under each member, lit by its chroma
    float seg = step(abs(fract((ang - ${RING.off.toFixed(5)}) / (6.2831853 / 12.0) + 0.5) - 0.5), 0.36);
    fc += C_RED * pxLine(abs(rr - R2 - 0.12) / fw, 1.0, 2.6) * seg * (0.04 + 0.6 * mi * mi + 1.0 * ms) * sweep * ringA;
    // the clock hand: points at the member speaking
    vec2 hd = vec2(sin(handAng), cos(handAng));
    float along = dot(v, hd), across = abs(v.x * hd.y - v.y * hd.x);
    float hand = step(0.0, along) * step(along, R1 - 0.35) * pxLine(across / fw, 0.9, 2.4);
    float handGlow = step(0.0, along) * step(along, R1) * exp(-across / 0.18) * 0.25;
    fc += mix(C_RED, C_EMBER, 0.3) * (hand * 1.4 + handGlow) * handOn * (0.6 + 0.8 * bassE);
    fc += C_RED * pxLine(abs(rr - 0.32) / fw, 0.6, 1.6) * 0.5 * ringA;
    fc += C_RED * 0.35 * exp(-rr / 0.12) * handOn;
    // distance fog into the void
    col = mix(col, fc, exp(-max(tfl - 8.0, 0.0) * 0.035));
  } else if (hk >= 0) {
    col = shadeMono(hk, hl, hn, th) * exp(-max(th - 12.0, 0.0) * 0.02);
  }

  // atmosphere: a halo around every lit member (the speaker's haze), not occluded
  for (int k = 0; k < 12; k++) {
    vec3 c = mono[k].xyz - ro;
    float tc = max(dot(c, rd), 0.0);
    vec3 dd = ro + rd * tc - mono[k].xyz;
    float dy = max(abs(dd.y) - HE.y * 0.6, 0.0);
    float d2 = dd.x * dd.x + dd.z * dd.z + dy * dy;
    col += C_RED * power[k] * (0.0006 * inten[k] + 0.012 * speak[k] * (0.4 + bassE)) * exp(-d2 / 1.6);
  }
  return col;
}

void main() {
  vec3 col = vec3(0.0);
  for (int k = ssK0(); k < ssK1(); k++) col += shadeRay(FRAG_PX + rgss(k) / PX_SCALE);
  fragColor = vec4(col * ssWeight(), 1.0);
}`;

const TICK = 'SOUND ONLY // 人類補完委員会 // HUMAN INSTRUMENTALITY COMMITTEE // CLOSED SESSION 非公開 // RECORDING PROHIBITED 記録禁止 // VIDEO FEED: NONE 映像なし // AUDIO CHANNEL 12/12 // ';

type Line = { t: number; k: number; jp: string; en: string };

export default class Seele extends Scene {
  pass!: FSPass;
  L = new Layer2D();
  scan = makeScanPass(0.2);
  T = { s: 0, e: 0 };
  turns: Turn[] = [];
  lines: Line[] = [];
  order: number[] = [];
  inten = new Array(12).fill(0);
  speak = new Array(12).fill(0);
  power = new Array(12).fill(0);
  mono = Array.from({ length: 12 }, () => new THREE.Vector4());
  ch = new Float32Array(12);

  override init() {
    const au = this.ctx.audio;
    this.T = { s: this.ctx.start, e: this.ctx.end };
    this.turns = speakerTurns(au, this.T.s - 0.6, this.T.e + 0.2);
    // power-on order: a fixed shuffle
    this.order = [...Array(12).keys()].sort((a, b) => hash(a, 41) - hash(b, 41));
    // the minutes: a line per turn, plus one per bar downbeat inside a long turn
    const ev: { t: number; k: number }[] = this.turns.filter((tr) => tr.t0 < this.T.e - 0.2).map((tr) => ({ t: Math.max(tr.t0, this.T.s + 0.15), k: tr.pc }));
    for (let b = 24; b < 29; b++) {
      const bt = barTime(au, b);
      if (ev.some((e) => Math.abs(e.t - bt) < 0.9)) continue;
      const sp = turnAt(this.turns, bt)?.pc ?? -1;
      const c = smoothChroma(au, bt + 0.2, new Array(12).fill(0));
      let best = 0, bv = -1;
      c.forEach((v, k) => { if (k !== sp && v > bv) { bv = v; best = k; } });
      ev.push({ t: bt, k: sp >= 0 ? sp : best }); // the speaker holds the floor; else the loudest member
    }
    ev.sort((a, b) => a.t - b.t);
    // the last event always gets the closing line
    const evs = ev.slice(0, MINUTES.length);
    this.lines = evs.map((e, i) => { const m = MINUTES[i === evs.length - 1 ? MINUTES.length - 1 : i]!; return { t: e.t, k: e.k, jp: m[0], en: m[1] }; });

    this.pass = new FSPass(COUNCIL_FRAG, {
      ssTap: SS_TAP,
      camPos: { value: new THREE.Vector3() }, camR: { value: new THREE.Vector3() }, camU: { value: new THREE.Vector3() }, camF: { value: new THREE.Vector3() },
      tanXY: { value: new THREE.Vector2(CAM.tanY * (W / H), CAM.tanY) },
      mono: { value: this.mono },
      inten: { value: this.inten }, speak: { value: this.speak }, power: { value: this.power },
      atlas: { value: makeFaceAtlas() },
      ringC: { value: new THREE.Vector3(RING.cx, FLOOR_Y, RING.cz) },
      t: { value: 0 }, pads: { value: 0 }, bassE: { value: 0 }, voice: { value: 0 }, handAng: { value: 0 }, handOn: { value: 0 }, ringOn: { value: 0 },
    });
  }

  /** The camera: a slow orbit + push-in, turning toward the member speaking (eased over 1.4 s per turn). */
  camera(t: number): Cam {
    const p = clamp((t - this.T.s) / (this.T.e - this.T.s));
    const th = lerp(-0.075, 0.075, p);
    const dist = lerp(CAM.dist + 0.5, CAM.dist - 0.9, ease.inOutQuad(p));
    const pos: V3 = [RING.cx + Math.sin(th) * dist, CAM.h - 0.3 * p + 0.04 * Math.sin(t * 0.7), RING.cz - Math.cos(th) * dist];
    // look target: the ring centre pulled 30 % toward the speaker
    let lx = 0, lz = 0, first = true;
    for (const tr of this.turns) {
      if (tr.t0 > t) break;
      const b = memberBase(tr.pc), tx = (b[0] - RING.cx) * 0.3, tz = (b[2] - RING.cz) * 0.18;
      if (first) { lx = tx; lz = tz; first = false; continue; }
      const k = ease.inOutCubic(clamp((t - tr.t0) / 1.4));
      lx = lerp(lx, tx, k); lz = lerp(lz, tz, k);
    }
    return makeCam(pos, [RING.cx + lx, -1.2, RING.cz + lz]);
  }

  /** Clock hand angle: eased toward the speaker on each turn. */
  hand(t: number) {
    let a = 0, first = true;
    for (const tr of this.turns) {
      if (tr.t0 > t) break;
      let target = memberAngle(tr.pc);
      if (first) { a = target; first = false; continue; }
      while (target - a > Math.PI) target -= Math.PI * 2;
      while (target - a < -Math.PI) target += Math.PI * 2;
      a = lerp(a, target, ease.outBack(clamp((t - tr.t0) / 0.5)));
    }
    return a;
  }

  render(f: Frame, out: THREE.WebGLRenderTarget): PostOverrides {
    const { renderer, audio: au, comp } = this.ctx;
    const T = this.T, t = f.t, lt = t - T.s;
    const fi = frameIdx(t);
    const pads = clamp(au.env('other', t) * 1.4);
    const bassE = clamp(au.env('bass', t) * 1.4);
    const turn = turnAt(this.turns, t);
    const endK = prog(t, T.e - 0.42, T.e - 0.05);

    // ---- audio → council
    smoothChroma(au, t, this.inten);
    for (let k = 0; k < 12; k++) this.inten[k] = smoothstep(0.08, 1, this.inten[k]!);
    speakWeights(this.turns, t, this.speak);
    // voice: the recent waveform peak (the speaker's meter)
    const smp: [number, number] = [0, 0];
    let pk = 0;
    for (let i = 0; i < 24; i++) { au.waveAt(t - i * 0.0025, smp); pk = Math.max(pk, Math.abs(smp[0] + smp[1]) * 0.5); }
    const voice = clamp(pk * 1.6);
    // power: each member flickers on in turn over the first bar; at the end all but the speaker cut out
    for (let i = 0; i < 12; i++) {
      const k = this.order[i]!;
      const t0 = 0.1 + i * 0.07;
      let pw = lt < t0 ? 0 : lt < t0 + 0.14 ? (hash(fi, k, 3) < (lt - t0) / 0.14 ? 1 : 0.12) : 1;
      if (endK > 0 && k !== turn?.pc) { const off = (11 - i) / 12; pw *= endK > off ? (hash(fi, k, 9) < 0.3 ? 0.4 : 0) : 1; }
      this.power[k] = pw;
    }
    const cam = this.camera(t);
    for (let k = 0; k < 12; k++) { const p = memberPos(k, t); this.mono[k]!.set(p[0], p[1], p[2], memberYaw(k)); }

    const u = this.pass.u;
    (u.camPos!.value as THREE.Vector3).set(...cam.pos);
    (u.camR!.value as THREE.Vector3).set(...cam.right);
    (u.camU!.value as THREE.Vector3).set(...cam.up);
    (u.camF!.value as THREE.Vector3).set(...cam.fwd);
    u.t!.value = t; u.pads!.value = pads; u.bassE!.value = bassE; u.voice!.value = voice;
    u.handAng!.value = this.hand(t);
    u.handOn!.value = turn ? clamp((t - this.turns[0]!.t0) / 0.3) : 0;
    u.ringOn!.value = prog(lt, 0.05, 1.1, ease.inOutCubic);
    this.pass.render(renderer, out);

    // ---- terminal overlay
    const L = this.L; L.clear();
    const c = L.ctx;
    const on = (g: number) => {
      const p = (lt - 0.25 - g * 0.09) / 0.2;
      if (p >= 1) return endK > 0.6 ? (hash(fi, g, 5) < 0.5 ? 0.25 : 0.7) : 1;
      if (p <= 0) return 0;
      return hash(fi, g) < p ? 1 : 0.12;
    };
    const RED = rgba('red', 1), OR = rgba('orange', 1);

    // header
    c.globalAlpha = on(0);
    this.header(c, t, lt);

    // left: council roster
    c.globalAlpha = on(1);
    this.roster(c, t, turn);

    // bottom-left: voice print (chromagram) + bass pitch trace
    c.globalAlpha = on(2);
    this.voicePrint(c, t, turn);

    // speaker callout + leader line + target brackets
    c.globalAlpha = on(3);
    if (turn) this.callout(c, cam, t, turn, voice);

    // right: the minutes
    c.globalAlpha = on(4);
    this.minutes(c, t);

    // bottom-right: title card
    c.globalAlpha = on(5);
    {
      const x = W - 60;
      condensed(c, 'HUMAN INSTRUMENTALITY', x, 900, 46, { sx: 0.62, color: rgba('bone', 0.9), align: 'right', tracking: 2 });
      condensed(c, 'COMMITTEE', x, 1010, 128, { sx: 0.58, color: rgba('bone', 1), align: 'right' });
      c.font = jp(22, 700, true); c.fillStyle = RED; c.textAlign = 'right';
      c.fillText('人類補完委員会　特別審議', x, 842);
      c.textAlign = 'left';
    }
    vtext(c, '人類補完計画', 30, 180, 20, rgba('red', 0.55));
    // footer ticker
    c.globalAlpha = on(6) * 0.9;
    c.fillStyle = rgba('red', 0.45); c.fillRect(40, 1040, 1180, 1);
    ticker(c, 40, 1062, 1180, TICK, t, { speed: 55, color: rgba('red', 0.55), size: 11 });
    c.globalAlpha = 1;
    void OR;

    comp.draw(renderer, L.upload(), out);
    this.scan.u.t!.value = t;
    this.scan.render(renderer, out);

    const tp = turn ? pulse(t, turn.t0, 0.1) : 0;
    return {
      bloom: 0.75, bloomThreshold: 0.58, bloomRadius: 0.8, halation: 0.1, vignette: 0.62, grain: 0.06,
      ca: 0.7 + 1.6 * tp, flash: 0,
      zoom: 1 + 0.004 * tp,
    };
  }

  // ---------------------------------------------------------------- overlay pieces
  header(c: CanvasRenderingContext2D, t: number, lt: number) {
    const x = 40, y = 34, h = 34;
    const rw = prog(lt, 0.2, 0.7, ease.outCubic);
    c.save();
    c.font = font(F.mono(700), 17); c.letterSpacing = '3px';
    const tag = 'SOUND ONLY';
    const tw = c.measureText(tag).width;
    c.letterSpacing = '0px';
    const bw = tw + 118;
    c.fillStyle = rgba('red', 1);
    c.beginPath(); c.moveTo(x, y); c.lineTo(x + bw, y); c.lineTo(x + bw + h * 0.7, y + h); c.lineTo(x, y + h); c.closePath(); c.fill();
    c.fillStyle = rgba('ink', 1); c.textBaseline = 'middle';
    c.font = font(F.mono(700), 17); c.letterSpacing = '3px';
    c.fillText(tag, x + 14, y + h / 2 + 1);
    c.letterSpacing = '0px';
    c.font = jp(19, 700, false); c.fillText('音声のみ', x + 28 + tw, y + h / 2 + 1);
    const x1 = x + bw + h * 0.7 + 8, X = W - 40;
    c.fillStyle = rgba('red', 0.8);
    c.fillRect(x1, y + h - 2, (X - x1) * rw, 2);
    c.fillRect(X - 60, y + h - 8, 60 * rw, 6);
    c.textBaseline = 'alphabetic';
    c.font = font(F.mono(500), 13); c.letterSpacing = '2.5px'; c.fillStyle = rgba('orange', 0.8);
    c.fillText('HUMAN INSTRUMENTALITY COMMITTEE  //  CLOSED SESSION  //  VIDEO FEED: NONE', x1 + 12, y + h - 10);
    // session clock (red 7-seg) + bar
    const au = this.ctx.audio;
    const b = songBar(au, t), bi = Math.floor(b + 1e-4);
    const s = Math.max(0, lt), ss = Math.floor(s), cs = Math.floor((s - ss) * 100);
    sevenSeg(c, `00:${String(ss).padStart(2, '0')}:${String(cs).padStart(2, '0')}`, X - 250, y + 48, 38, rgba('red', 1), rgba('red', 0.07), { thick: 4.4 });
    c.font = font(F.mono(600), 11); c.letterSpacing = '2px'; c.fillStyle = rgba('orange', 0.75); c.textAlign = 'right';
    c.fillText(`SESSION  BAR ${String(bi).padStart(2, '0')}/29`, X, y + 106);
    c.font = jp(12, 600, false); c.letterSpacing = '0px';
    c.fillText('審議経過時間', X, y + 124);
    c.restore();
  }

  roster(c: CanvasRenderingContext2D, t: number, turn: Turn | null) {
    const x = 64, y0 = 150, lead = 30;
    c.save();
    evaLabel(c, x, y0 - 14, 'council  12/12', '委員会 出席', { color: rgba('orange', 0.9), size: 0.9 });
    for (let k = 0; k < 12; k++) {
      const y = y0 + 34 + k * lead;
      const I = this.inten[k]!, S = this.speak[k]!, P = this.power[k]!;
      const col = S > 0.5 ? rgba('red', 1) : rgba('orange', 0.85);
      if (S > 0.5) { c.fillStyle = rgba('red', 0.9); c.fillRect(x - 8, y - 16, 252, 22); }
      c.fillStyle = S > 0.5 ? rgba('ink', 1) : col;
      c.font = font(F.mono(700), 14); c.letterSpacing = '1.5px'; c.textBaseline = 'alphabetic';
      c.fillText(String(k + 1).padStart(2, '0'), x, y);
      c.font = font(F.mono(500), 12);
      c.fillText(PC[k]!.padEnd(2, ' '), x + 30, y);
      c.letterSpacing = '0px';
      meterH(c, x + 62, y - 11, 110, 9, 14, I * P, S > 0.5 ? rgba('ink', 1) : rgba('red', 0.9), S > 0.5 ? 'rgba(0,0,0,0.25)' : rgba('red', 0.1), S > 0.5 ? undefined : rgba('amber', 1));
      c.font = jp(12, 700, false); c.fillStyle = S > 0.5 ? rgba('ink', 1) : rgba('orange', P > 0.5 ? 0.5 : 0.25);
      c.fillText(S > 0.5 ? '発言中' : P > 0.5 ? '在席' : '待機', x + 186, y);
    }
    c.restore();
    void t; void turn;
  }

  voicePrint(c: CanvasRenderingContext2D, t: number, turn: Turn | null) {
    const au = this.ctx.audio;
    const x = W - 440, y = 470, w = 400, rowH = 13, h = rowH * 12;
    c.save();
    evaLabel(c, x, y - 34, 'voice print  //  chroma  2 bars', '声紋分析', { color: rgba('orange', 0.9), size: 0.9 });
    const gx = x + 34, gw = w - 34;
    const N = 72, span = 3.6, dt = span / N;
    const colI = Math.floor(t / dt);
    for (let i = 0; i < N; i++) {
      const tc = (colI - (N - 1) + i) * dt;
      au.chroma(tc, this.ch);
      const age = (N - 1 - i) / N;
      for (let k = 0; k < 12; k++) {
        const v = smoothstep(0.2, 1, this.ch[k]!);
        if (v < 0.04) continue;
        c.fillStyle = rgba('red', v * (0.95 - 0.55 * age));
        c.fillRect(gx + i * (gw / N) + 0.5, y + (11 - k) * rowH + 1, gw / N - 1, rowH - 2);
      }
    }
    // bass pitch trace (the speaker) over the grid
    c.strokeStyle = rgba('amber', 0.9); c.lineWidth = 1.5; c.beginPath();
    let pen = false;
    for (let i = 0; i <= 144; i++) {
      const tc = t - span + (span * i) / 144, m = au.bassMidi(tc);
      if (m <= 0) { pen = false; continue; }
      const pc = ((Math.round(m) % 12) + 12) % 12;
      const px = gx + (gw * i) / 144, py = y + (11 - pc) * rowH + rowH / 2;
      if (pen) c.lineTo(px, py); else c.moveTo(px, py);
      pen = true;
    }
    c.stroke();
    // labels + grid
    c.font = font(F.mono(600), 10); c.textBaseline = 'middle';
    for (let k = 0; k < 12; k++) {
      c.fillStyle = turn?.pc === k ? rgba('red', 1) : rgba('orange', 0.6);
      c.fillText(PC[k]!, x, y + (11 - k) * rowH + rowH / 2 + 1);
    }
    c.strokeStyle = rgba('orange', 0.35); c.lineWidth = 1;
    c.strokeRect(gx - 0.5, y - 0.5, gw + 1, h + 1);
    // bar lines
    const au2 = this.ctx.audio, b = songBar(au2, t);
    for (let bb = Math.floor(b) - 2; bb <= Math.floor(b); bb++) {
      const bt = barTime(au2, bb), px = gx + gw * (1 - (t - bt) / span);
      if (px < gx || px > gx + gw) continue;
      c.fillStyle = rgba('orange', 0.5); c.fillRect(px, y - 6, 1, h + 12);
      c.font = font(F.mono(600), 10); c.textBaseline = 'alphabetic'; c.fillText(`${bb}`, px + 3, y - 2);
    }
    c.fillStyle = rgba('red', 1); c.fillRect(gx + gw, y - 8, 2, h + 16);
    c.restore();
  }

  callout(c: CanvasRenderingContext2D, cam: Cam, t: number, turn: Turn, voice: number) {
    const au = this.ctx.audio;
    const k = turn.pc, age = t - turn.t0;
    const bx = W - 440, by = 176, bw = 400, bh = 214;
    const cr = faceCorners(cam, k, t);
    const xs = cr.map((p) => p[0]), ys = cr.map((p) => p[1]);
    const fx0 = Math.min(...xs), fx1 = Math.max(...xs), fy0 = Math.min(...ys), fy1 = Math.max(...ys);
    const blinkOn = age > 0.3 || ((age * 16) | 0) % 2 === 0;
    c.save();
    // target brackets on the speaking face: snap in
    const g = 1 + 0.35 * (1 - ease.outCubic(clamp(age / 0.18)));
    const cx = (fx0 + fx1) / 2, cy = (fy0 + fy1) / 2, hw = (fx1 - fx0) / 2 * g + 14, hh = (fy1 - fy0) / 2 * g + 14;
    if (blinkOn) brackets(c, cx - hw, cy - hh, hw * 2, hh * 2, 22, rgba('red', 1), 2);
    // leader: from the face's top edge up, then across to the box
    const ax = cx, ay = cy - hh;
    c.strokeStyle = rgba('red', 0.85); c.lineWidth = 1.5;
    c.beginPath(); c.moveTo(ax, ay); c.lineTo(ax, by + 60); c.lineTo(bx, by + 60); c.stroke();
    c.fillStyle = rgba('red', 1); c.fillRect(ax - 3, ay - 3, 6, 6);
    c.font = font(F.mono(600), 11); c.letterSpacing = '2px'; c.fillStyle = rgba('red', 0.9);
    c.fillText(`M-${String(k + 1).padStart(2, '0')}  Z ${project(cam, memberPos(k, t))[2].toFixed(2)}`, ax + 8, by + 52);
    c.letterSpacing = '0px';
    // the box
    chamferPath(c, bx, by, bw, bh, [0, 18, 0, 18]);
    c.fillStyle = 'rgba(10,2,2,0.78)'; c.fill();
    c.strokeStyle = rgba('red', 1); c.lineWidth = 1.5; c.stroke();
    c.fillStyle = rgba('red', 1); c.fillRect(bx, by, 170, 26);
    c.fillStyle = rgba('ink', 1); c.font = font(F.mono(700), 13); c.letterSpacing = '2px'; c.textBaseline = 'middle';
    c.fillText('SPEAKER', bx + 10, by + 14); c.letterSpacing = '0px';
    c.font = jp(14, 700, false); c.fillText('発言者', bx + 106, by + 14);
    c.textBaseline = 'alphabetic';
    const numCol = blinkOn ? rgba('red', 1) : rgba('red', 0.3);
    sevenSeg(c, String(k + 1).padStart(2, '0'), bx + 16, by + 44, 92, numCol, rgba('red', 0.07), { thick: 10 });
    const tx = bx + 150;
    c.fillStyle = rgba('red', 1); c.font = font(F.mono(700), 15); c.letterSpacing = '2px';
    c.fillText(`MEMBER ${String(k + 1).padStart(2, '0')}  /  ${PC[k]}`, tx, by + 58);
    c.font = font(F.mono(500), 12); c.fillStyle = rgba('orange', 0.85);
    c.fillText(`BASS  ${noteLabel(au.bassMidi(t))}`, tx, by + 80);
    c.fillText(`TURN  ${age.toFixed(2).padStart(5, '0')} S`, tx, by + 98);
    c.letterSpacing = '0px';
    c.font = jp(13, 700, false); c.fillStyle = rgba('red', 0.8);
    c.fillText('映像なし　音声のみ', tx, by + 120);
    // voice scope (the real waveform, 45 ms)
    const sx = bx + 16, sy = by + 150, sw = bw - 32, sh = 50, mid = sy + sh / 2;
    c.strokeStyle = rgba('red', 0.2); c.lineWidth = 1;
    c.beginPath();
    for (let i = 0; i <= 10; i++) { c.moveTo(sx + (sw * i) / 10, sy); c.lineTo(sx + (sw * i) / 10, sy + sh); }
    c.moveTo(sx, mid); c.lineTo(sx + sw, mid);
    c.stroke();
    const smp: [number, number] = [0, 0];
    c.strokeStyle = rgba('red', 1); c.lineWidth = 1.6; c.beginPath();
    for (let i = 0; i <= 200; i++) {
      const v = au.waveAt(t - 0.045 + (0.045 * i) / 200, smp);
      const px = sx + (sw * i) / 200, py = mid - (v[0] + v[1]) * 0.5 * sh * 0.9;
      if (i) c.lineTo(px, py); else c.moveTo(px, py);
    }
    c.stroke();
    meterH(c, bx + bw - 16 - 120, by + 32, 120, 8, 12, voice, rgba('red', 1), rgba('red', 0.12), rgba('amber', 1));
    c.restore();
  }

  /** The council's lines: film subtitles under the ring (typed), and the minutes log bottom-left. */
  minutes(c: CanvasRenderingContext2D, t: number) {
    const vis = this.lines.filter((l) => l.t <= t);
    c.save();
    // log
    const x = 64, y0 = 640;
    evaLabel(c, x, y0, 'minutes  //  proceedings', '議事録', { color: rgba('orange', 0.9), size: 0.9 });
    c.fillStyle = rgba('orange', 0.4); c.fillRect(x, y0 + 30, 250, 1);
    vis.slice(-8).forEach((l, i, arr) => {
      const y = y0 + 54 + i * 22, newest = i === arr.length - 1;
      c.font = font(F.mono(700), 11); c.letterSpacing = '1.5px'; c.textBaseline = 'alphabetic';
      c.fillStyle = newest ? rgba('red', 1) : rgba('red', 0.55);
      c.fillText(`${String(l.k + 1).padStart(2, '0')}`, x, y);
      c.fillStyle = newest ? rgba('orange', 0.9) : rgba('orange', 0.45);
      c.font = font(F.mono(500), 11);
      c.fillText(`${(l.t - this.T.s).toFixed(2).padStart(5, '0')}  ${PC[l.k]!.padEnd(2, ' ')}  ${l.en.split(' ').slice(0, 2).join(' ')}…`, x + 30, y);
    });
    // subtitle
    const l = vis[vis.length - 1];
    if (l) {
      const age = t - l.t;
      const nj = Math.floor(clamp(age / 0.5) * l.jp.length), ne = Math.floor(clamp((age - 0.12) / 0.5) * l.en.length);
      const cx = W / 2, y = 978;
      c.font = jp(34, 700, true); c.letterSpacing = '2px';
      const jw = c.measureText(l.jp).width;
      const x0 = cx - jw / 2;
      c.fillStyle = 'rgba(4,1,1,0.72)'; c.fillRect(x0 - 90, y - 44, jw + 130, 90);
      c.fillStyle = rgba('red', 1); c.fillRect(x0 - 76, y - 32, 52, 34);
      c.fillStyle = rgba('ink', 1); c.font = font(F.mono(700), 20); c.textAlign = 'center'; c.textBaseline = 'middle';
      c.fillText(String(l.k + 1).padStart(2, '0'), x0 - 50, y - 14);
      c.textAlign = 'left'; c.textBaseline = 'alphabetic';
      c.font = jp(34, 700, true); c.fillStyle = rgba('bone', 1);
      c.fillText(l.jp.slice(0, nj), x0, y);
      if (nj < l.jp.length && ((t * 3) % 1) < 0.6) { c.fillStyle = rgba('red', 1); c.fillRect(x0 + c.measureText(l.jp.slice(0, nj)).width + 4, y - 30, 12, 34); }
      c.letterSpacing = '2.5px'; c.font = font(F.mono(500), 14); c.fillStyle = rgba('orange', 0.9);
      c.fillText(l.en.slice(0, ne), x0, y + 30);
      c.letterSpacing = '0px';
    }
    c.restore();
  }
}

void LIN; void memberBase;
