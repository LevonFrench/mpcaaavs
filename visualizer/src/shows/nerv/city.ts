// Ported from bizarro/evangelion app/src/scenes/city.ts (MIT, Copyright (c) 2026 Giacomo Magnanini, Luis Bizarro; see THIRD-PARTY-NERV.txt).
// city — "TOKYO-3" (breakdown, bars 65–72, 121.82 – 134.42 s; pads only, no drums, no pump).
// The fortress city at night as a hidden-line wireframe: orange hairline blocks on the street grid
// inside the Hakone caldera (contour-line mountains, Lake Ashi hatched), the camera slowly orbiting.
// The armament towers rise out of the geofront over the first bars, then breathe with the pads:
// every tower is a mel band by its bearing from the centre, so the skyline is a slow spectrum.
// A scan plane sweeps the city every two bars (alternating N–S / E–W), draping over the terrain and
// lighting the blocks it passes. District tags ride the projection. The weak vocal ghosts before
// bar 71 flicker an UNIDENTIFIED marker; the vocal chop at bar 71 lights the cyan beacon
// (PATTERN BLUE), with ground rings on each chop. Right column: armament deployment per district,
// the geofront section (towers hang from the cavity ceiling: above ground = the band's level),
// and the signal analyser (vocal stem = pattern, drum stem = seismic).
import * as THREE from 'three';
import { Scene, type Frame, type PostOverrides } from '../../show/scene.ts';
import { FSPass, Layer2D } from '../../show/gl.ts';
import { LineBatch } from '../../show/lines.ts';
import { LIN, rgba } from '../../show/palette.ts';
import { F, font } from '../../show/type.ts';
import { clamp, ease, frameIdx, hash, prog, pulse, smoothstep, TAU } from '../../show/util.ts';
import { GLSL_EVA, barTime, brackets, chamferPath, condensed, evaLabel, hexData, jp, makeScanPass, panel, segMeter, sevenSeg, W, H } from './_eva.ts';
import { chrome, meta } from './magi-hud.ts';
import {
  CITY_R, DISTRICTS, LAKE, boxGeometry, buildCity, contours, districtAngle, lakeHatch, lc, melSmooth, mixc, terrainGeometry, terrainH,
  type Bldg, type RGB, type Seg3,
} from './city-kit.ts';

const NB = 48; // mel bands used for the skyline
const TS = 520, TN = 150; // terrain half-size and grid
const LEVELS: number[] = [];
for (let L = 8; L <= 150; L += 8) LEVELS.push(L);
const DEPTHS = [-12, -28, -48];
// viewport (left of the right column) and the projection shift that centres the city in it
const VX0 = 56, VX1 = 1456, VY0 = 116, VY1 = 1016;
const SHIFT_X = 1 - (760 / 960), SHIFT_Y = -(1 - 600 / 540);

const BOX_VERT = /* glsl */ `
precision highp float;
in vec3 position; in vec3 normal; in vec4 iRect; in vec3 iH;
uniform mat4 projectionMatrix; uniform mat4 modelViewMatrix;
out vec3 vN; out float vGlow; out float vCy; out float vRel;
void main() {
  vec3 p = vec3(mix(iRect.x, iRect.z, position.x), position.y * iH.x, mix(iRect.y, iRect.w, position.z));
  vN = normal; vGlow = iH.y; vCy = iH.z; vRel = position.y;
  gl_Position = projectionMatrix * modelViewMatrix * vec4(p, 1.0);
}`;
const BOX_FRAG = /* glsl */ `
precision highp float;
in vec3 vN; in float vGlow; in float vCy; in float vRel;
uniform vec3 cOr, cCy, cInk;
out vec4 fragColor;
void main() {
  float top = vN.y > 0.5 ? 1.0 : 0.0;
  float side = 0.012 + 0.006 * abs(vN.x);
  vec3 c = cInk + cOr * mix(side, 0.034, top);
  c += cOr * vGlow * (0.05 + 0.07 * top) * (0.4 + 0.6 * vRel);
  c += cCy * vCy * (0.035 + 0.05 * top);
  fragColor = vec4(c, 1.0);
}`;
const TER_VERT = /* glsl */ `
precision highp float;
in vec3 position;
uniform mat4 projectionMatrix; uniform mat4 modelViewMatrix;
out float vY;
void main() { vY = position.y; gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0); }`;
const TER_FRAG = /* glsl */ `
precision highp float;
in float vY;
uniform vec3 cOr, cInk;
out vec4 fragColor;
void main() { fragColor = vec4(cInk * 0.8 + cOr * (0.004 + 0.00006 * vY), 1.0); }`;

type Tag = { en: string; jp: string; x: number; z: number; y: number; lift: number; val?: () => string; side: 1 | -1 };

export default class City extends Scene {
  bg = new FSPass(/* glsl */ `
    ${GLSL_EVA}
    uniform float a;
    void main() {
      vec2 p = FRAG_PX;
      vec4 h = hexCell(p, 34.0);
      float line = pxLine(hexEdge(h.xy, 34.0), 0.5, 1.5);
      vec2 uv = p / vec2(1920.0, 1080.0) - vec2(0.4, 0.55);
      float fall = 1.0 - smoothstep(0.2, 0.8, length(uv * vec2(1.0, 1.5)));
      fragColor = vec4(C_INK + C_ORANGE * line * a * (0.4 + 0.6 * fall), 1.0);
    }`, { a: { value: 0.04 } });
  scene3 = new THREE.Scene();
  cam = new THREE.PerspectiveCamera(33, W / H, 4, 3000);
  lb = new LineBatch(60000, { screen2D: false, blend: 'max', depthTest: true });
  glow = new LineBatch(6000, { screen2D: false, blend: 'add', depthTest: true });
  L = new Layer2D();
  scan = makeScanPass(0.22);
  mel = new Float32Array(NB);
  city: Bldg[] = [];
  cur = new Float32Array(0); // current heights
  box!: ReturnType<typeof boxGeometry>;
  topo: Seg3[] = [];
  hatch: [number, number, number][] = [];
  streets: [number, number, number, number, number][] = [];
  tags: Tag[] = [];
  towers: number[] = [];
  T = { s: 0, e: 0, b71: 0, strong: [] as number[], weak: [] as number[], beacon: 0 };
  B = { x: 0, z: 0, h: 0 };
  v = new THREE.Vector3();

  override init() {
    const au = this.ctx.audio, s = this.ctx.start, e = this.ctx.end;
    const b71 = barTime(au, 71);
    const voc = au.events('vocal', s, e + 0.01);
    this.T = { s, e, b71, strong: voc.filter(([vt, k]) => vt >= b71 - 0.05 && k >= 0.6).map((x) => x[0]), weak: voc.filter(([vt, k]) => !(vt >= b71 - 0.05 && k >= 0.6)).map((x) => x[0]), beacon: 0 };
    if (!this.T.strong.length) this.T.strong = [b71];
    this.T.beacon = this.T.strong[0]!;

    // ---- city
    this.city = buildCity(NB);
    this.cur = new Float32Array(this.city.length);
    this.towers = this.city.map((b, i) => (b.tower ? i : -1)).filter((i) => i >= 0);
    this.box = boxGeometry(this.city.length);
    const rect = this.box.rect.array as Float32Array;
    this.city.forEach((b, i) => { rect[i * 4] = b.x0; rect[i * 4 + 1] = b.z0; rect[i * 4 + 2] = b.x1; rect[i * 4 + 3] = b.z1; });
    this.box.rect.needsUpdate = true;
    const u3 = (k: keyof typeof LIN) => new THREE.Vector3(...LIN[k]);
    const boxMat = new THREE.RawShaderMaterial({
      glslVersion: THREE.GLSL3, vertexShader: BOX_VERT, fragmentShader: BOX_FRAG,
      uniforms: { cOr: { value: u3('orange') }, cCy: { value: u3('cyan') }, cInk: { value: u3('ink') } },
      depthTest: true, depthWrite: true, polygonOffset: true, polygonOffsetFactor: 1, polygonOffsetUnits: 2,
    });
    const boxMesh = new THREE.Mesh(this.box.g, boxMat);
    boxMesh.frustumCulled = false;
    this.scene3.add(boxMesh);

    // ---- terrain
    const { segs, grid } = contours(TS, TN, [...LEVELS, ...DEPTHS, -0.6]);
    this.topo = segs;
    this.hatch = lakeHatch(5);
    const terMat = new THREE.RawShaderMaterial({
      glslVersion: THREE.GLSL3, vertexShader: TER_VERT, fragmentShader: TER_FRAG,
      uniforms: { cOr: { value: u3('orange') }, cInk: { value: u3('ink') } },
      depthTest: true, depthWrite: true, polygonOffset: true, polygonOffsetFactor: 2, polygonOffsetUnits: 8,
    });
    const ter = new THREE.Mesh(terrainGeometry(TS, TN, grid), terMat);
    ter.frustumCulled = false;
    this.scene3.add(ter);

    // ---- streets: grid lines clipped to the city disc (avenues every 4th)
    for (let k = -8; k <= 8; k++) {
      const c = k * 13, hl = Math.sqrt(Math.max(0, CITY_R * CITY_R - c * c));
      if (hl < 4) continue;
      const av = k % 4 === 0 ? 1 : 0;
      this.streets.push([c, -hl, c, hl, av], [-hl, c, hl, c, av]);
    }

    // ---- the beacon: the tower nearest a point in front-left of the centre at the chop
    const az = this.camAz(this.T.beacon) + 0.62;
    const px = Math.cos(az) * 58, pz = Math.sin(az) * 58;
    let best = this.towers[0]!, bd = 1e9;
    for (const i of this.towers) { const b = this.city[i]!; const d = Math.hypot((b.x0 + b.x1) / 2 - px, (b.z0 + b.z1) / 2 - pz); if (d < bd) { bd = d; best = i; } }
    const bb = this.city[best]!;
    this.B = { x: (bb.x0 + bb.x1) / 2, z: (bb.z0 + bb.z1) / 2, h: best };

    // ---- tags: the six sectors, the centre, the lake, and the three tallest towers
    // side: text away from the city centre, fixed for the plate (from the mid-plate camera)
    const azMid = this.camAz((s + e) / 2);
    const sideOf = (x: number, z: number): 1 | -1 => (x * Math.sin(azMid) - z * Math.cos(azMid) > 0 ? 1 : -1);
    for (let d = 1; d <= 6; d++) {
      const a = districtAngle(d), r = 114;
      const x = Math.cos(a) * r, z = Math.sin(a) * r;
      this.tags.push({ en: DISTRICTS[d]!.en, jp: DISTRICTS[d]!.jp, x, z, y: 0, lift: 36, side: sideOf(x, z), val: () => `${DISTRICTS[d]!.code}  DEPLOY ${String(Math.round(this.deploy(d) * 100)).padStart(3, '0')}%` });
    }
    this.tags.push({ en: 'LAKE ASHI', jp: '芦ノ湖', x: LAKE.x, z: LAKE.z, y: 0, lift: 30, side: sideOf(LAKE.x, LAKE.z), val: () => 'ELEV 723 M  WATER' });
    const tall = [...this.towers].sort((a, b) => this.city[b]!.h - this.city[a]!.h).filter((i) => i !== best).slice(0, 0);
    tall.forEach((i, k) => {
      const b = this.city[i]!;
      this.tags.push({ en: `ARM. BLDG ${['A', 'B', 'C'][k]}-${String(10 + (b.id % 80)).padStart(2, '0')}`, jp: '兵装ビル', x: (b.x0 + b.x1) / 2, z: (b.z0 + b.z1) / 2, y: -1 - i, lift: 34, side: -1 });
    });
  }

  /** Camera azimuth (world xz angle of the camera around the centre) at time t: a slow orbit. */
  camAz(t: number) { return 0.9 + (t - this.ctx.start) * 0.042; }

  /** Mean raised fraction of a district's towers. */
  deploy(d: number) {
    let s = 0, n = 0;
    for (const i of this.towers) { const b = this.city[i]!; if (b.d !== d) continue; s += this.cur[i]! / b.h; n++; }
    return n ? s / n : 0;
  }

  project(x: number, y: number, z: number): [number, number, boolean] {
    const v = this.v.set(x, y, z).project(this.cam);
    return [(v.x + 1) * 0.5 * W, (1 - v.y) * 0.5 * H, v.z < 1 && v.z > -1];
  }

  render(f: Frame, out: THREE.WebGLRenderTarget): PostOverrides {
    const { renderer, audio: au, comp } = this.ctx;
    const T = this.T, t = f.t, lt = t - T.s, p = clamp(lt / (T.e - T.s));
    const pad = clamp(au.env('other', t) * 1.25);
    const fi = frameIdx(t);
    melSmooth(au, t, this.mel, 0.35, 7);

    // ---- beacon state (the vocal stem)
    let lastStrong = -1e9; for (const s of T.strong) if (s <= t) lastStrong = s;
    const lit = t >= T.beacon;
    const vEnv = clamp(au.env('vocal', t) * 1.6);
    const bI = lit ? 0.6 + 1.8 * pulse(t, lastStrong, 0.3) + 0.7 * vEnv : 0;
    let ghost = 0; for (const w of T.weak) if (w <= t) ghost = Math.max(ghost, pulse(t, w, 0.16));
    const litOn = lit ? (t - T.beacon > 0.16 ? 1 : hash(fi, 41) < (t - T.beacon) / 0.16 ? 1 : 0.2) : 0;

    // ---- camera: slow orbit, easing lower and closer over the plate
    const az = this.camAz(t), el = 0.54 - 0.06 * p, dist = 455 - 45 * ease.inOutQuad(p);
    const cam = this.cam;
    cam.position.set(Math.cos(az) * Math.cos(el) * dist, Math.sin(el) * dist, Math.sin(az) * Math.cos(el) * dist);
    cam.lookAt(0, 4, 0);
    cam.updateProjectionMatrix();
    cam.projectionMatrix.elements[8] = SHIFT_X;
    cam.projectionMatrix.elements[9] = SHIFT_Y;
    cam.projectionMatrixInverse.copy(cam.projectionMatrix).invert();
    cam.updateMatrixWorld();
    const cx = cam.position.x, cy = cam.position.y, cz = cam.position.z;
    const fade = (x: number, y: number, z: number) => clamp(1.45 - Math.hypot(x - cx, y - cy, z - cz) / 900, 0.1, 1);

    // ---- scan plane: one sweep per 2 bars, alternating axes
    const SW = 3.6, k = Math.floor(lt / SW), su = (lt - k * SW) / SW;
    const psi = 0.35 + k * (Math.PI / 2);
    const Dx = Math.cos(psi), Dz = Math.sin(psi);
    const spos = -150 + 300 * ease.inOutQuad(su);

    // ---- building heights (towers rise from the geofront, then breathe with their band)
    const hg = this.box.hg.array as Float32Array;
    const cyanR = lit ? 4 + (t - lastStrong) * 58 : -1;
    for (let i = 0; i < this.city.length; i++) {
      const b = this.city[i]!;
      const m = smoothstep(0.22, 0.95, this.mel[b.band]!);
      let h: number;
      if (b.tower) {
        const dep = ease.outCubic(clamp((lt - b.delay) / 1.2));
        h = b.h * dep * (0.42 + 0.58 * m);
      } else h = b.h * (0.9 + 0.14 * m);
      this.cur[i] = h;
      const mx = (b.x0 + b.x1) / 2, mz = (b.z0 + b.z1) / 2;
      const sd = mx * Dx + mz * Dz - spos;
      const g = sd > 0 ? Math.exp(-(sd * sd) / 30) : Math.exp(-(sd * sd) / 30) * 0.6 + 0.4 * Math.exp(sd / 22);
      let cyv = 0;
      if (lit) {
        const dB = Math.hypot(mx - this.B.x, mz - this.B.z);
        cyv = (i === this.B.h ? 1 : 0) * (0.5 + 0.5 * bI) + Math.exp(-((dB - cyanR) ** 2) / 20) * Math.exp(-(t - lastStrong) / 0.9) * 0.8;
      }
      hg[i * 3] = h; hg[i * 3 + 1] = g * (0.5 + 0.5 * pad); hg[i * 3 + 2] = cyv * litOn;
    }
    this.box.hg.needsUpdate = true;

    // ================================================================ GL
    this.bg.u.a!.value = 0.035 + 0.015 * pad;
    this.bg.render(renderer, out);
    renderer.setRenderTarget(out);
    renderer.clear(false, true, false);
    renderer.render(this.scene3, cam);

    const lb = this.lb; lb.clear();
    const gw = this.glow; gw.clear();
    const O = lc('orange', 1), A = lc('amber', 1.3), CYN = lc('cyan', 1);
    const seg = (ax: number, ay: number, az_: number, bx: number, by: number, bz: number, w: number, c: RGB, a: number) => lb.seg(ax, ay, az_, bx, by, bz, w, c[0], c[1], c[2], a);
    const lineA = 0.75 + 0.25 * pad;

    // terrain contours (index contour every 4th level), bathymetry dotted-dim, the shoreline bright
    for (const s of this.topo) {
      const L = s[6], mxp = (s[0] + s[3]) / 2, mzp = (s[2] + s[5]) / 2;
      const fd = fade(mxp, s[1], mzp);
      let a: number, w = 1, c = O;
      if (L < -1) { a = 0.16; }
      else if (L < 1) { a = 0.7; w = 1.25; c = A; }
      else { const idx = Math.round(L / 8) % 4 === 0; a = idx ? 0.42 : 0.18; w = idx ? 1.1 : 1; }
      seg(s[0], s[1], s[2], s[3], s[4], s[5], w, c, a * fd * lineA);
    }
    for (const [x0, x1, z] of this.hatch) seg(x0, 0.05, z, x1, 0.05, z, 1, O, 0.2 * fade((x0 + x1) / 2, 0, z));
    // streets, city limit ring road, bearing ticks
    for (const [ax, az_, bx, bz, av] of this.streets) seg(ax, 0, az_, bx, 0, bz, av ? 1.2 : 1, O, (av ? 0.3 : 0.14) * lineA);
    for (const r of [CITY_R + 3, CITY_R + 7]) {
      const n = 180;
      for (let i = 0; i < n; i++) {
        const a0 = (i / n) * TAU, a1 = ((i + 1) / n) * TAU;
        seg(Math.cos(a0) * r, 0, Math.sin(a0) * r, Math.cos(a1) * r, 0, Math.sin(a1) * r, 1.2, O, 0.55 * lineA);
      }
    }
    for (let i = 0; i < 72; i++) {
      const a = (i / 72) * TAU, r0 = CITY_R + 9, r1 = r0 + (i % 6 === 0 ? 9 : 4);
      seg(Math.cos(a) * r0, 0, Math.sin(a) * r0, Math.cos(a) * r1, 0, Math.sin(a) * r1, 1, O, 0.5);
    }
    // the plaza: geofront access hexagon
    for (let i = 0; i < 6; i++) {
      const a0 = (i / 6) * TAU + Math.PI / 6, a1 = ((i + 1) / 6) * TAU + Math.PI / 6;
      for (const r of [5, 8]) seg(Math.cos(a0) * r, 0, Math.sin(a0) * r, Math.cos(a1) * r, 0, Math.sin(a1) * r, 1.2, A, 0.7);
    }

    // buildings: 12 edges each, floor lines and roof insets on the towers
    for (let i = 0; i < this.city.length; i++) {
      const b = this.city[i]!, h = this.cur[i]!;
      if (h < 0.05) continue;
      const g = hg[i * 3 + 1]!, cyv = hg[i * 3 + 2]!;
      const mx = (b.x0 + b.x1) / 2, mz = (b.z0 + b.z1) / 2;
      const fd = fade(mx, h * 0.5, mz);
      let col = mixc(O, A, clamp(g));
      if (cyv > 0.02) col = mixc(col, lc('cyan', 1.4), clamp(cyv));
      const a = (b.tower ? 0.95 : 0.6) * fd * lineA + 0.3 * g;
      const w = b.tower ? 1.15 : 1;
      const X0 = b.x0, X1 = b.x1, Z0 = b.z0, Z1 = b.z1;
      // verticals
      seg(X0, 0, Z0, X0, h, Z0, w, col, a); seg(X1, 0, Z0, X1, h, Z0, w, col, a);
      seg(X1, 0, Z1, X1, h, Z1, w, col, a); seg(X0, 0, Z1, X0, h, Z1, w, col, a);
      // roof + base
      for (const y of [h, 0]) {
        const aa = y ? a : a * 0.6;
        seg(X0, y, Z0, X1, y, Z0, w, col, aa); seg(X1, y, Z0, X1, y, Z1, w, col, aa);
        seg(X1, y, Z1, X0, y, Z1, w, col, aa); seg(X0, y, Z1, X0, y, Z0, w, col, aa);
      }
      if (b.tower) {
        const fa = a * 0.32;
        for (let y = 4; y < h - 1.5; y += 4) {
          seg(X0, y, Z0, X1, y, Z0, 1, col, fa); seg(X1, y, Z0, X1, y, Z1, 1, col, fa);
          seg(X1, y, Z1, X0, y, Z1, 1, col, fa); seg(X0, y, Z1, X0, y, Z0, 1, col, fa);
        }
        const ix = (X1 - X0) * 0.22, iz = (Z1 - Z0) * 0.22;
        seg(X0 + ix, h, Z0 + iz, X1 - ix, h, Z0 + iz, 1, col, a * 0.6); seg(X1 - ix, h, Z0 + iz, X1 - ix, h, Z1 - iz, 1, col, a * 0.6);
        seg(X1 - ix, h, Z1 - iz, X0 + ix, h, Z1 - iz, 1, col, a * 0.6); seg(X0 + ix, h, Z1 - iz, X0 + ix, h, Z0 + iz, 1, col, a * 0.6);
      }
    }

    // scan line: drapes over the terrain; a faint curtain over the city chord; fading wake lines
    {
      const Px = -Dz, Pz = Dx, n = 160, Lh = 470;
      let prev: [number, number, number] | null = null;
      for (let i = 0; i <= n; i++) {
        const s = -Lh + (2 * Lh * i) / n;
        const x = Dx * spos + Px * s, z = Dz * spos + Pz * s;
        const y = Math.max(0, terrainH(x, z)) + 0.4;
        if (prev) {
          const fd = fade(x, y, z) * (1 - smoothstep(104, 126, Math.hypot(x, z)));
          gw.seg(prev[0], prev[1], prev[2], x, y, z, 1.6, A[0] * 1.3, A[1] * 1.3, A[2] * 1.3, 0.8 * fd);
        }
        prev = [x, y, z];
      }
      const ch = Math.sqrt(Math.max(0, (CITY_R + 7) ** 2 - spos * spos));
      if (ch > 1) {
        const ax = Dx * spos - Px * ch, az_ = Dz * spos - Pz * ch, bx = Dx * spos + Px * ch, bz = Dz * spos + Pz * ch;
        seg(ax, 0.2, az_, bx, 0.2, bz, 1.4, A, 0.7);
        for (let j = 1; j <= 3; j++) {
          const sp = spos - j * 7, cj = Math.sqrt(Math.max(0, (CITY_R + 7) ** 2 - sp * sp));
          if (cj < 1) continue;
          seg(Dx * sp - Px * cj, 0.2, Dz * sp - Pz * cj, Dx * sp + Px * cj, 0.2, Dz * sp + Pz * cj, 1, A, 0.4 / j);
        }
      }
    }

    // the beacon (cyan): ghosts on the weak vocal onsets, then the lit beam and chop rings
    {
      const bx = this.B.x, bz = this.B.z, bh = this.cur[this.B.h]!;
      if (ghost > 0.02 && !lit) {
        gw.seg(bx, bh, bz, bx, bh + 40 + 60 * ghost, bz, 1.2, CYN[0] * 1.2, CYN[1] * 1.2, CYN[2] * 1.2, 0.6 * ghost);
        const r = 6 + 10 * (1 - ghost);
        for (let i = 0; i < 24; i++) { const a0 = (i / 24) * TAU, a1 = ((i + 1) / 24) * TAU; if (i % 2) continue; gw.seg(bx + Math.cos(a0) * r, 0.3, bz + Math.sin(a0) * r, bx + Math.cos(a1) * r, 0.3, bz + Math.sin(a1) * r, 1.2, CYN[0], CYN[1], CYN[2], 0.7 * ghost); }
      }
      if (lit) {
        const I = bI * litOn;
        gw.seg(bx, bh, bz, bx, 260, bz, 2.2, CYN[0] * 2.2 * I, CYN[1] * 2.2 * I, CYN[2] * 2.2 * I, 1);
        gw.seg(bx, bh, bz, bx, 260, bz, 12, CYN[0] * 0.35 * I, CYN[1] * 0.35 * I, CYN[2] * 0.35 * I, 0.6);
        // octagonal ground marker
        for (const r of [9, 13]) for (let i = 0; i < 8; i++) {
          const a0 = (i / 8) * TAU + Math.PI / 8, a1 = ((i + 1) / 8) * TAU + Math.PI / 8;
          gw.seg(bx + Math.cos(a0) * r, 0.3, bz + Math.sin(a0) * r, bx + Math.cos(a1) * r, 0.3, bz + Math.sin(a1) * r, 1.4, CYN[0] * 1.4 * I, CYN[1] * 1.4 * I, CYN[2] * 1.4 * I, 0.9);
        }
        // expanding rings, three per chop
        for (const s of T.strong) {
          if (s > t) continue;
          for (let j = 0; j < 3; j++) {
            const tt = t - s - j * 0.14;
            if (tt < 0) continue;
            const r = 6 + 70 * ease.outCubic(clamp(tt / 1.6)) + tt * 8, a = Math.exp(-tt / 0.8) * (1 - j * 0.25);
            if (a < 0.02) continue;
            const n = 72;
            for (let i = 0; i < n; i++) {
              const a0 = (i / n) * TAU, a1 = ((i + 1) / n) * TAU;
              gw.seg(bx + Math.cos(a0) * r, 0.3, bz + Math.sin(a0) * r, bx + Math.cos(a1) * r, 0.3, bz + Math.sin(a1) * r, 1.6, CYN[0] * 1.5, CYN[1] * 1.5, CYN[2] * 1.5, a);
            }
          }
        }
      }
    }
    lb.render(renderer, out, cam);
    gw.render(renderer, out, cam);

    // ================================================================ Canvas HUD
    const Lr = this.L; Lr.clear();
    const c = Lr.ctx;
    const on = (g: number) => {
      const q = (lt - g * 0.06) / 0.24;
      if (q >= 1) return 1;
      if (q <= 0) return 0;
      return hash(fi, g) < q ? 1 : 0.15;
    };
    const cyanUI = lit && litOn > 0.5;

    chrome(c, t, au, {
      no: '12', en: 'TOKYO-3', jpText: '第3新東京市', reveal: prog(lt, 0, 0.3, ease.outCubic),
      sub: 'FORTRESS CITY  //  ARMAMENT BUILDINGS ONLINE  //  迎撃要塞都市  //  CAM 03 AERIAL',
      tick: 'TOKYO-3 // ARMAMENT BUILDINGS DEPLOYED // CIVILIAN EVACUATION COMPLETE: SHELTERS SEALED // 市民避難完了 // GEOFRONT GATE 07 SEALED // UN FORCES STANDBY // 第3新東京市 迎撃システム 稼働中 // HAKONE CALDERA 35°14′N 139°02′E //',
    });

    // ---- viewport frame
    c.globalAlpha = on(0);
    brackets(c, VX0, VY0 + 4, VX1 - VX0, VY1 - VY0 - 4, 26, rgba('orange', 0.9), 2);
    c.fillStyle = rgba('orange', 0.5);
    for (let x = VX0 + 60; x < VX1 - 40; x += 40) c.fillRect(x, VY1, 1, x % 200 === 16 ? 8 : 4);
    for (let y = VY0 + 60; y < VY1 - 40; y += 40) c.fillRect(VX1 - 1, y, 8 * 0 + (y % 200 === 36 ? 8 : 4), 1);

    // ---- title card (top-left of the viewport)
    evaLabel(c, 80, 162, 'fortress city  //  tactical map', undefined, { alpha: 0.9 });
    condensed(c, 'TOKYO-3', 74, 306, 158, { sx: 0.58, color: rgba('bone', 1) });
    c.font = jp(40, 700, true); c.fillStyle = rgba('orange', 1); c.fillText('第3新東京市', 82, 360);
    // status chips
    const chip = (x: number, y: number, en: string, j: string, col: string, solid: boolean) => {
      c.font = font(F.mono(700), 12); c.letterSpacing = '2px';
      const w = c.measureText(en).width + 26 + j.length * 15;
      chamferPath(c, x, y, w, 24, [0, 8, 0, 8]);
      if (solid) { c.fillStyle = col; c.fill(); } else { c.strokeStyle = col; c.lineWidth = 1.2; c.stroke(); }
      c.fillStyle = solid ? rgba('ink', 1) : col; c.textBaseline = 'middle';
      c.fillText(en, x + 10, y + 13); const ew = c.measureText(en).width; c.letterSpacing = '0px';
      c.font = jp(13, 700, false); c.fillText(j, x + 16 + ew, y + 13); c.textBaseline = 'alphabetic';
      return w;
    };
    {
      let x = 82;
      x += chip(x, 382, 'ALERT LVL 2', '警戒態勢', rgba('orange', 1), true) + 10;
      x += chip(x, 382, 'EVACUATION', '避難完了', rgba('orange', 0.9), false) + 10;
      if (lit) chip(82, 414, 'PATTERN BLUE', '使徒', rgba('cyan', 1), fi % 30 < 20);
    }

    // tag anchors (the bearing numbers keep clear of them)
    const anchors: [number, number][] = this.tags.map((tg) => { const [ax, ay] = this.project(tg.x, 0, tg.z); return [ax, ay]; });
    // ---- projected: bearing numbers on the ring
    c.font = font(F.mono(600), 11); c.textAlign = 'center'; c.textBaseline = 'middle'; c.letterSpacing = '1px';
    for (let i = 0; i < 12; i++) {
      const a = (i / 12) * TAU, r = CITY_R + 26;
      const [sx, sy, ok] = this.project(Math.cos(a) * r, 0, Math.sin(a) * r);
      if (!ok || sx < VX0 + 30 || sx > VX1 - 30 || sy < VY0 + 30 || sy > VY1 - 150) continue;
      if (Math.cos(a - az) < -0.15) continue; // far half: would sit on the towers
      if (anchors.some(([ax, ay]) => Math.abs(ax - sx) < 190 && sy > ay - 60 && sy < ay + 20)) continue;
      const deg = ((90 - i * 30 + 360) % 360);
      c.fillStyle = rgba('orange', 0.75 * fade(Math.cos(a) * r, 0, Math.sin(a) * r) + 0.1);
      c.fillText(String(deg).padStart(3, '0'), sx, sy);
    }
    c.textAlign = 'left'; c.textBaseline = 'alphabetic'; c.letterSpacing = '0px';

    // ---- projected: district tags
    c.globalAlpha = on(2);
    for (const tg of this.tags) {
      let y = tg.y;
      if (y < 0) { const i = -y - 1; y = this.cur[i]!; }
      const [sx, sy0, ok] = this.project(tg.x, y, tg.z);
      if (!ok || sx < VX0 + 20 || sx > VX1 - 60 || sy0 < VY0 + 30 || sy0 > VY1) continue;
      const sy = sy0 - tg.lift;
      const al = clamp(0.35 + 0.8 * fade(tg.x, y, tg.z));
      c.globalAlpha = on(2) * al;
      c.strokeStyle = rgba('orange', 0.9); c.lineWidth = 1;
      c.beginPath(); c.moveTo(sx, sy0); c.lineTo(sx, sy); c.lineTo(sx + 14 * tg.side, sy); c.stroke();
      c.fillStyle = rgba('orange', 1); c.fillRect(sx - 2, sy0 - 2, 4, 4);
      const tx = sx + 20 * tg.side;
      c.font = font(F.mono(700), 12); c.letterSpacing = '2px';
      const pw = Math.max(c.measureText(tg.en).width, tg.val ? 124 : 60) + 12;
      c.fillStyle = 'rgba(5,4,3,0.72)';
      c.fillRect(tg.side > 0 ? tx - 6 : tx - pw + 6, sy - 10, pw, tg.val ? 54 : 38);
      c.textAlign = tg.side > 0 ? 'left' : 'right';
      c.font = font(F.mono(700), 12); c.letterSpacing = '2px'; c.fillStyle = rgba('orange', 1);
      c.fillText(tg.en, tx, sy + 4);
      c.letterSpacing = '0px';
      c.font = jp(13, 700, false); c.fillStyle = rgba('orange', 0.85);
      c.fillText(tg.jp, tx, sy + 22);
      if (tg.val) { c.font = font(F.mono(500), 10); c.letterSpacing = '1px'; c.fillStyle = rgba('amber', 0.85); c.fillText(tg.val(), tx, sy + 38); c.letterSpacing = '0px'; }
    }
    c.textAlign = 'left'; c.globalAlpha = 1;

    // ---- projected: beacon callout (ghost: UNIDENTIFIED; lit: PATTERN BLUE)
    {
      const bh = this.cur[this.B.h]!;
      const [sx, sy, ok] = this.project(this.B.x, bh + 36, this.B.z);
      const [gx, gy] = this.project(this.B.x, 0, this.B.z);
      if (ok && (ghost > 0.05 || lit)) {
        const col = lit ? rgba('cyan', 1) : rgba('amber', 1);
        const al = lit ? litOn : ghost;
        c.globalAlpha = al;
        const s = lit ? 30 + 18 * pulse(t, lastStrong, 0.12) : 26;
        brackets(c, gx - s, gy - s * 0.6, 2 * s, s * 1.2, 8, col, 1.5);
        const w = lit ? 272 : 210, h = lit ? 92 : 48;
        const bx = clamp(sx + 90, VX0 + 20, VX1 - w - 20), by = clamp(sy - 250, VY0 + 60, VY1 - h - 120);
        c.strokeStyle = col; c.lineWidth = 1.2;
        c.beginPath(); c.moveTo(sx, sy); c.lineTo(bx - 14, by + h / 2); c.lineTo(bx, by + h / 2); c.stroke();
        chamferPath(c, bx, by, w, h, [0, 12, 0, 12]);
        c.fillStyle = lit ? 'rgba(0,14,22,0.82)' : 'rgba(10,6,0,0.8)'; c.fill();
        c.strokeStyle = col; c.lineWidth = 1.5; c.stroke();
        c.fillStyle = col; c.fillRect(bx, by, w, 22);
        c.fillStyle = rgba('ink', 1); c.font = font(F.mono(700), 12); c.letterSpacing = '2px'; c.textBaseline = 'middle';
        c.fillText(lit ? 'PATTERN BLUE' : 'UNIDENTIFIED', bx + 10, by + 12); c.letterSpacing = '0px';
        c.font = jp(13, 800, false); c.textAlign = 'right'; c.fillText(lit ? '使徒 確認' : '未確認信号', bx + w - 10, by + 12); c.textAlign = 'left';
        c.textBaseline = 'alphabetic'; c.fillStyle = col;
        if (lit) {
          c.font = font(F.mono(600), 12); c.letterSpacing = '1.5px';
          c.fillText('BLOOD TYPE: BLUE', bx + 10, by + 44);
          const brg = ((90 - (Math.atan2(this.B.z, this.B.x) * 180) / Math.PI) + 360) % 360;
          c.fillText(`BRG ${brg.toFixed(1).padStart(5, '0')}°  RNG ${(Math.hypot(this.B.x, this.B.z) * 0.01).toFixed(2)} KM`, bx + 10, by + 62);
          c.fillText(`SIG ${(-40 + 38 * vEnv).toFixed(1)} DB  ${hexData(fi >> 3, 5, 6)}`, bx + 10, by + 80);
          c.letterSpacing = '0px';
        } else {
          c.font = font(F.mono(600), 11); c.letterSpacing = '1.5px';
          c.fillText(`ANALYSING ${hexData(fi >> 2, 9, 6)}`, bx + 10, by + 40); c.letterSpacing = '0px';
        }
        c.globalAlpha = 1;
      }
    }

    // ---- bottom of the viewport: heading tape + camera metadata
    c.globalAlpha = on(3);
    {
      const hdg = (((90 - ((az + Math.PI) * 180) / Math.PI) % 360) + 360) % 360; // camera looks toward the centre
      const x0 = 520, x1 = 1180, y = 978, mid = (x0 + x1) / 2, pxd = 5;
      c.save(); c.beginPath(); c.rect(x0, y - 30, x1 - x0, 44); c.clip();
      c.fillStyle = rgba('orange', 0.8); c.font = font(F.mono(500), 11); c.textAlign = 'center';
      const d0 = Math.floor(hdg - (mid - x0) / pxd);
      for (let d = d0; d <= hdg + (x1 - mid) / pxd + 1; d++) {
        const x = mid + (d - hdg) * pxd;
        const mj = ((d % 15) + 15) % 15 === 0;
        if (((d % 5) + 5) % 5 === 0) c.fillRect(x, y - (mj ? 14 : 7), 1, mj ? 14 : 7);
        if (mj) { const dd = ((d % 360) + 360) % 360; c.fillText(dd % 90 === 0 ? ['N', 'E', 'S', 'W'][dd / 90]! : String(dd).padStart(3, '0'), x, y - 20); }
      }
      c.restore();
      c.fillStyle = rgba('orange', 0.6); c.fillRect(x0, y, x1 - x0, 1);
      c.fillStyle = rgba('amber', 1);
      c.beginPath(); c.moveTo(mid, y + 2); c.lineTo(mid - 6, y + 12); c.lineTo(mid + 6, y + 12); c.closePath(); c.fill();
      c.font = font(F.mono(700), 12); c.letterSpacing = '2px'; c.textAlign = 'center';
      c.fillText(`HDG ${hdg.toFixed(1).padStart(5, '0')}°`, mid, y + 30); c.letterSpacing = '0px'; c.textAlign = 'left';
      meta(c, 82, 928, [
        ['CAM 03', `ALT ${(cy * 10).toFixed(0)} M  EL ${((el * 180) / Math.PI).toFixed(1)}°`],
        ['SCAN', `${['N–S', 'E–W'][k % 2]} ${String(Math.round(su * 100)).padStart(3, '0')}%  PASS ${String(k + 1).padStart(2, '0')}`],
        ['AMBIENT', `${(20 * Math.log10(Math.max(1e-3, au.env('rms', t)))).toFixed(1)} DB  PAD ${(pad * 100).toFixed(0).padStart(3, '0')}`],
      ], { size: 11, lead: 18, keyW: 70, color: rgba('orange', 0.85) });
      c.font = jp(12, 600, false); c.fillStyle = rgba('orange', 0.7); c.fillText('上空監視カメラ  走査  環境音', 82, 994);
    }
    c.globalAlpha = 1;

    // ================= right column
    const RX = 1480, RW = 384;
    // ---- armament deployment
    c.globalAlpha = on(4);
    const dp = panel(c, RX, 120, RW, 322, { title: 'ARMAMENT', jp: '兵装ビル', cut: 16 });
    {
      const order = [0, 1, 2, 3, 4, 5, 6];
      order.forEach((d, i) => {
        const y = dp.y + 6 + i * 29, v = this.deploy(d);
        c.fillStyle = rgba('orange', 1); c.font = font(F.mono(700), 12); c.letterSpacing = '1.5px';
        c.fillText(DISTRICTS[d]!.en, dp.x, y + 12); c.letterSpacing = '0px';
        c.font = jp(12, 600, false); c.fillStyle = rgba('orange', 0.65); c.fillText(DISTRICTS[d]!.jp, dp.x + 112, y + 12);
        segMeter(c, dp.x + 162, y + 2, 150, 12, 20, v, { hotFrom: 2, color: rgba(v > 0.85 ? 'amber' : 'orange', 1) });
        c.fillStyle = rgba('amber', 1); c.font = font(F.mono(600), 12); c.textAlign = 'right';
        c.fillText(`${String(Math.round(v * 100)).padStart(3, '0')}%`, dp.x + dp.w, y + 12); c.textAlign = 'left';
      });
      let up = 0; for (const i of this.towers) if (lt >= this.city[i]!.delay + 1.2) up++;
      const y = dp.y + 214;
      c.fillStyle = rgba('orange', 0.3); c.fillRect(dp.x, y - 6, dp.w, 1);
      c.fillStyle = rgba('orange', 1); c.font = font(F.mono(600), 11); c.letterSpacing = '2px';
      c.fillText('UNITS RAISED', dp.x, y + 14); c.letterSpacing = '0px';
      c.font = jp(12, 600, false); c.fillStyle = rgba('orange', 0.7); c.fillText('展開完了', dp.x, y + 32);
      const col = up === this.towers.length ? rgba('amber', 1) : rgba('orange', 1);
      const w7 = sevenSeg(c, String(up).padStart(3, '0'), dp.x + 128, y + 2, 40, col, rgba('orange', 0.07));
      c.fillStyle = rgba('orange', 0.8); c.font = font(F.mono(600), 16);
      c.fillText(`/${this.towers.length}`, dp.x + 136 + w7, y + 40);
    }
    // ---- geofront section
    c.globalAlpha = on(5);
    const gp = panel(c, RX, 458, RW, 290, { title: 'GEOFRONT', jp: 'ジオフロント断面', cut: 16 });
    {
      const x0 = gp.x, w = gp.w, gy = gp.y + 94, n = 40, pitch = w / n, colW = pitch - 3, Lc = 60;
      // cavity: half-ellipse under the armour plates
      const cavT = gy + 14, cavB = gp.y + gp.h;
      c.save();
      c.beginPath(); c.ellipse(x0 + w / 2, cavT, w / 2 - 2, cavB - cavT, 0, 0, Math.PI); c.closePath();
      c.fillStyle = 'rgba(20,10,2,0.6)'; c.fill();
      c.setLineDash([4, 4]); c.strokeStyle = rgba('orange', 0.45); c.lineWidth = 1; c.stroke(); c.setLineDash([]);
      c.clip();
      // hanging (retracted) towers
      for (let i = 0; i < n; i++) {
        const m = smoothstep(0.22, 0.95, this.mel[Math.floor((i / n) * NB)]!);
        const rise = i % 3 === 1 ? 1 : 0.55;
        const hang = Lc * (1 - m) * rise;
        const x = x0 + i * pitch + 1.5;
        c.strokeStyle = rgba('orange', 0.5); c.lineWidth = 1;
        if (hang > 1) c.strokeRect(x + 0.5, cavT + 0.5, colW - 1, hang);
      }
      // NERV HQ pyramid on the cavity floor
      const pyx = x0 + w / 2, pyb = cavB - 4;
      c.beginPath(); c.moveTo(pyx - 34, pyb); c.lineTo(pyx, pyb - 34); c.lineTo(pyx + 34, pyb); c.closePath();
      c.strokeStyle = rgba('orange', 0.9); c.lineWidth = 1.2; c.stroke();
      c.restore();
      c.font = font(F.mono(600), 9); c.fillStyle = rgba('orange', 0.8); c.letterSpacing = '1px'; c.textAlign = 'center';
      c.fillText('CENTRAL DOGMA', x0 + w / 2, cavB + 10); c.textAlign = 'left'; c.letterSpacing = '0px';
      // armour plates band
      c.save(); c.beginPath(); c.rect(x0, gy, w, 14); c.clip();
      c.strokeStyle = rgba('orange', 0.45); c.lineWidth = 1;
      c.beginPath(); for (let x = x0 - 14; x < x0 + w + 14; x += 6) { c.moveTo(x, gy + 14); c.lineTo(x + 14, gy); } c.stroke();
      c.restore();
      c.fillStyle = rgba('orange', 1); c.fillRect(x0, gy, w, 1.5); c.fillRect(x0, gy + 14, w, 1);
      // deployed towers above ground
      for (let i = 0; i < n; i++) {
        const m = smoothstep(0.22, 0.95, this.mel[Math.floor((i / n) * NB)]!);
        const rise = i % 3 === 1 ? 1 : 0.55;
        const hh = Lc * m * rise, x = x0 + i * pitch + 1.5;
        if (hh < 1) continue;
        c.fillStyle = rgba(m > 0.9 && rise === 1 ? 'amber' : 'orange', 0.85);
        for (let yy = 0; yy < hh; yy += 5) c.fillRect(x, gy - Math.min(hh, yy + 4), colW, Math.min(4, hh - yy));
      }
      meta(c, x0, gp.y + 12, [['DEPTH', '-0.70 KM']], { size: 10, keyW: 44, color: rgba('orange', 0.75) });
      meta(c, x0 + 150, gp.y + 12, [['ARMOUR', '22 PLATES']], { size: 10, keyW: 50, color: rgba('orange', 0.75) });
      c.font = jp(11, 600, false); c.fillStyle = rgba('orange', 0.75); c.textAlign = 'right';
      c.fillText('特殊装甲 22層', x0 + w, gp.y + 12); c.textAlign = 'left';
    }
    // ---- signal analysis (vocal = pattern, drums = seismic)
    c.globalAlpha = on(6);
    const sgCol = cyanUI ? rgba('cyan', 1) : rgba('orange', 1);
    const sg = panel(c, RX, 764, RW, 252, { title: 'SIGNAL', jp: '信号解析', cut: 16, color: sgCol });
    {
      // status plate
      const st = lit ? 2 : ghost > 0.05 ? 1 : 0;
      const labels = [['NO CONTACT', '反応なし'], ['UNIDENTIFIED', '未確認'], ['PATTERN BLUE', '使徒 確認']] as const;
      const scol = st === 2 ? rgba('cyan', 1) : st === 1 ? rgba('amber', 1) : rgba('orange', 0.55);
      chamferPath(c, sg.x, sg.y, sg.w, 30, [0, 10, 0, 10]);
      if (st === 2 && fi % 24 < 16) { c.fillStyle = scol; c.fill(); } else { c.strokeStyle = scol; c.lineWidth = 1.2; c.stroke(); }
      c.fillStyle = st === 2 && fi % 24 < 16 ? rgba('ink', 1) : scol;
      c.font = font(F.mono(700), 14); c.letterSpacing = '3px'; c.textBaseline = 'middle';
      c.fillText(labels[st][0], sg.x + 12, sg.y + 16); c.letterSpacing = '0px';
      c.font = jp(15, 800, false); c.textAlign = 'right'; c.fillText(labels[st][1], sg.x + sg.w - 12, sg.y + 16); c.textAlign = 'left';
      c.textBaseline = 'alphabetic';
      // traces (6 s history, newest at the right)
      const trace = (y: number, h: number, name: string, j: string, fn: (tt: number) => number, col: string, marks: number[]) => {
        const x = sg.x + 70, w = sg.w - 70, span = 6;
        c.strokeStyle = rgba('orange', 0.14); c.lineWidth = 1;
        c.beginPath();
        for (let i = 0; i <= 6; i++) { c.moveTo(x + (w * i) / 6, y); c.lineTo(x + (w * i) / 6, y + h); }
        c.moveTo(x, y + h); c.lineTo(x + w, y + h); c.stroke();
        for (const mt of marks) {
          if (mt > t || mt < t - span) continue;
          const mx = x + w * (1 - (t - mt) / span);
          c.fillStyle = col; c.fillRect(mx, y - 4, 1, h + 4);
        }
        c.strokeStyle = col; c.lineWidth = 1.4; c.beginPath();
        for (let i = 0; i <= 160; i++) {
          const tt = t - span + (span * i) / 160, v = clamp(fn(tt));
          const px = x + (w * i) / 160, py = y + h - v * (h - 2);
          if (i) c.lineTo(px, py); else c.moveTo(px, py);
        }
        c.stroke();
        c.fillStyle = rgba('orange', 0.9); c.font = font(F.mono(700), 11); c.letterSpacing = '1.5px';
        c.fillText(name, sg.x, y + 12); c.letterSpacing = '0px';
        c.font = jp(11, 600, false); c.fillStyle = rgba('orange', 0.6); c.fillText(j, sg.x, y + 28);
      };
      const vocMarks = [...T.weak, ...T.strong];
      trace(sg.y + 44, 70, 'PATTERN', '波形パターン', (tt) => au.env('vocal', tt) * 1.6, lit ? rgba('cyan', 1) : rgba('amber', 1), vocMarks);
      c.setLineDash([3, 4]); c.strokeStyle = rgba('red', 0.5); c.lineWidth = 1;
      c.beginPath(); c.moveTo(sg.x + 70, sg.y + 44 + 70 * 0.4); c.lineTo(sg.x + sg.w, sg.y + 44 + 70 * 0.4); c.stroke(); c.setLineDash([]);
      trace(sg.y + 132, 44, 'SEISMIC', '地震計', (tt) => au.env('drums', tt) * 1.4 + au.env('low', tt) * 0.3, rgba('orange', 0.9), []);
      c.fillStyle = sgCol; c.font = font(F.mono(500), 10); c.letterSpacing = '1px';
      c.fillText('-6.0 S', sg.x + 70, sg.y + sg.h + 4); c.textAlign = 'right'; c.fillText('NOW', sg.x + sg.w, sg.y + sg.h + 4); c.textAlign = 'left'; c.letterSpacing = '0px';
    }
    c.globalAlpha = 1;

    comp.draw(renderer, Lr.upload(), out);
    this.scan.u.t!.value = t;
    this.scan.render(renderer, out);

    const cut = Math.exp(-lt / 0.12);
    const bp = lit ? pulse(t, lastStrong, 0.1) : 0;
    return {
      bloom: 0.6, bloomThreshold: 0.7, halation: 0.1, vignette: 0.45, grain: 0.05,
      ca: 0.7 + 2.2 * cut + 1.6 * bp,
      flash: 0.03 * cut,
    };
  }
}

void H;
