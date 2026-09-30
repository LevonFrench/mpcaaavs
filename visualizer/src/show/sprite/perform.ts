// Stage evaluation: a choreographed script (choreo.ts) at any time t becomes a list of sprite draws and post punches. Pure functions of
// (script, pack, beat grid, t): no state is carried between frames, so a seek renders the same frame as playing through (checked against an
// independent frame-by-frame integration in tools/check-sprite-layer.mjs).
//
// Coordinates are the plate's native pixels, y down. Sprites snap to whole native pixels. There are no drop shadows.
import type { AssetPack, ResolvedFrame } from '../../asset-packs/pack.ts';
import { clipFrameIndex } from '../../asset-packs/pack.ts';
import type { BlendMode, Rect } from '../../asset-packs/manifest.ts';
import type { ChoreoAudio, PerformerSpec, Script, ScriptAction, ScriptBase, ScriptFreeze, StagePlan } from './choreo.ts';
import { TICK_RATE, loopFrame, oneShotFrame, type Hitstop } from './clip.ts';
import { motionAt, type MotionClock } from './motion.ts';

export interface SpriteDraw {
  atlas: string;
  rect: Rect;
  /** Top-left on the native canvas, whole pixels. */
  x: number;
  y: number;
  /** Destination size in px; default rect size times `scale`. */
  w?: number;
  h?: number;
  flipX?: boolean;
  scale?: number;
  /** Palette id for indexed atlases (palette swap). */
  palette?: string;
  tint?: readonly [number, number, number];
  alpha?: number;
  blend?: BlendMode;
  /** Painter's order: lower first. */
  z: number;
  /** Rows at or below this y are not drawn (emerging from a floor). */
  clipY?: number;
}

export interface PostPunch { shake: [number, number]; zoom: number; flash: number }

export interface StageFrame {
  draws: SpriteDraw[];
  post: PostPunch;
  banners: { text: string; age: number; left: number }[];
  /** Everything is at rest: the song is silent. */
  silent: boolean;
}

const Z_ACTOR = 100, Z_SHOT = 300, Z_FX = 400;
const mulberry = (n: number) => { let h = (n ^ 0x9e3779b9) >>> 0; h = Math.imul(h ^ (h >>> 16), 0x85ebca6b); h = Math.imul(h ^ (h >>> 13), 0xc2b2ae35); return ((h ^ (h >>> 16)) >>> 0) / 4294967296; };

const SILENCE_RMS = 0.012;

export class Stage {
  private readonly byPerformer = new Map<string, ScriptAction[]>();
  private readonly basesBy = new Map<string, ScriptBase[]>();
  private readonly globalFreezes: ScriptFreeze[];
  private readonly performers: ReadonlyMap<string, PerformerSpec>;

  constructor(readonly pack: AssetPack, readonly plan: StagePlan, readonly script: Script, readonly au: ChoreoAudio) {
    this.performers = new Map(plan.performers.map((p) => [p.id, p] as const));
    for (const a of script.actions) (this.byPerformer.get(a.performer) ?? this.byPerformer.set(a.performer, []).get(a.performer)!).push(a);
    for (const b of script.bases) (this.basesBy.get(b.performer) ?? this.basesBy.set(b.performer, []).get(b.performer)!).push(b);
    this.globalFreezes = script.freezes.filter((f) => f.who === '*');
  }

  /** The action of a performer at t (actions are truncated when the next begins), or undefined. */
  actionAt(performer: string, t: number): ScriptAction | undefined {
    const list = this.byPerformer.get(performer);
    if (!list) return undefined;
    let found: ScriptAction | undefined;
    for (const a of list) { if (a.start > t) break; if (t < a.end) found = a; }
    return found;
  }

  /** Stops that freeze an action's clip: its own hitstops and every screen-wide freeze after it began. */
  stopsOf(a: ScriptAction): Hitstop[] {
    const extra = this.globalFreezes.filter((f) => f.t > a.start).map((f) => ({ t: f.t, ticks: f.ticks }));
    return extra.length ? [...a.hitstops, ...extra] : (a.hitstops as Hitstop[]);
  }

  /** Start of a freeze covering t for this performer (hold the frame there), or null. */
  frozenAt(performer: string, t: number): number | null {
    for (const f of this.script.freezes) if (t >= f.t && t < f.t + f.ticks / TICK_RATE && (f.who === '*' || f.who.includes(performer))) return f.t;
    return null;
  }

  baseAt(performer: string, t: number): ScriptBase | undefined {
    const list = this.basesBy.get(performer);
    if (!list?.length) return undefined;
    let found = list[0]!;
    for (const b of list) if (t >= b.t0 - 1e-9) found = b;
    return found;
  }

  hiddenAt(performer: string, t: number): boolean {
    for (const h of this.script.hidden) if (h.performer === performer && t >= h.t0 && t < h.t1) return true;
    return false;
  }

  /** The frame index a performer shows at t, with the clip it comes from (for checks and the renderer). */
  poseAt(p: PerformerSpec, t: number, silent = false): { clip: string; frame: number; action: ScriptAction | null; loop: boolean } | null {
    const a = silent ? undefined : this.actionAt(p.id, t);
    if (a) return { clip: a.clip, frame: oneShotFrame(a.timing, a.start, this.stopsOf(a), t), action: a, loop: false };
    const b = this.baseAt(p.id, t);
    if (!b) return null;
    const fz = this.frozenAt(p.id, t);
    const beat = this.au.beatAt(fz ?? t) - (p.beatOffset ?? 0);
    return { clip: b.clip, frame: loopFrame(b.timing.hold, b.beats, 0, beat), action: null, loop: true };
  }

  evaluate(t: number): StageFrame {
    const au = this.au, draws: SpriteDraw[] = [];
    const beat = au.beatAt(t), clock: MotionClock = { beat, bar: au.songBarAt(t) };
    const silent = au.env('rms', t) < SILENCE_RMS && t > 0.5;
    for (const p of this.plan.performers) {
      if (this.hiddenAt(p.id, t)) continue;
      const pose = this.poseAt(p, t, silent);
      if (!pose) continue;
      const region = this.pack.regionOf(p.actor, 'actor');
      const frames = this.pack.clipFrames(pose.clip);
      const f = frames?.[pose.frame];
      if (!region || !f) continue;
      const s = p.scale ?? 1;
      let px = p.x, py = p.y;
      if (p.path) { const u = Math.min(1, Math.max(0, (t - this.script.window[0]) / Math.max(1e-6, this.script.window[1] - this.script.window[0]))); [px, py] = p.path(u); }
      if (p.hover) { const m = motionAt({ model: 'hover', from: [px, py], to: [px, py], beat0: 0, beat1: 1, amp: p.hover }, clock); px = m.x; py = m.y; }
      if (pose.action && (pose.action.verb === 'hurt' || pose.action.verb === 'guard')) {
        const ticks = (t - pose.action.bigTime) * TICK_RATE;
        px -= (p.facing === 'right' ? 1 : -1) * Math.max(0, 3 - Math.max(0, ticks) * 0.4);
      }
      pushFrame(draws, f, px, py, p.facing !== region.facing, s, p.palette ?? region.palette, Z_ACTOR + py, 'normal');
    }
    if (!silent) {
      for (const sh of this.script.shots) {
        if (t < sh.t0 || t >= sh.t1) continue;
        const reg = this.pack.regionOf(sh.region, 'projectile');
        if (!reg) continue;
        const frames = reg.clip ? this.pack.clipFrames(reg.clip) : undefined, clip = reg.clip ? this.pack.clip(reg.clip) : undefined;
        for (let k = 0; k < 3; k++) {
          // the shot and two fading afterimages 3 and 6 ticks behind it
          const tk = t - k * 3 / TICK_RATE;
          if (tk < sh.t0) continue;
          const st = motionAt(sh.spec, { beat: au.beatAt(tk), bar: au.songBarAt(tk) });
          const idx = clip && frames ? clipFrameIndex(clip.hold, true, (t - sh.t0) * TICK_RATE) : 0;
          const f = frames?.[idx];
          if (f) pushFrame(draws, f, st.x, st.y, Math.cos(st.angle) < -0.2, 1, reg.palette, Z_SHOT - k * 0.1, k === 0 ? 'normal' : 'add', k === 0 ? 1 : 0.4 / k, st.clipY ?? undefined);
          else draws.push({ atlas: reg.atlas, rect: reg.rect, x: Math.round(st.x - reg.anchor[0]), y: Math.round(st.y - reg.anchor[1]), palette: reg.palette, z: Z_SHOT });
        }
      }
    }
    for (const fx of this.script.fx) {
      const reg = this.pack.regionOf(fx.region, 'effect');
      if (!reg || t < fx.t) continue;
      const frames = reg.clip ? this.pack.clipFrames(reg.clip) : undefined, clip = reg.clip ? this.pack.clip(reg.clip) : undefined;
      if (!frames || !clip) continue;
      const ticks = (t - fx.t) * TICK_RATE;
      if (ticks >= clip.hold.reduce((a, b) => a + b, 0)) continue;
      const f = frames[clipFrameIndex(clip.hold, false, ticks)]!;
      pushFrame(draws, f, fx.x, fx.y, !!fx.flip, fx.scale ?? 1, reg.palette, Z_FX, reg.blend);
    }
    return { draws, post: this.punchAt(t), banners: this.script.banners.filter((b) => t >= b.t0 && t < b.t1).map((b) => ({ text: b.text, age: t - b.t0, left: b.t1 - t })), silent };
  }

  /** Shake, zoom and flash at t from the script's punches: each decays over a quarter second. */
  punchAt(t: number): PostPunch {
    let sx = 0, sy = 0, zoom = 1, flash = 0;
    this.script.punches.forEach((p, i) => {
      const age = t - p.t;
      if (age < 0 || age > 0.25) return;
      const k = (1 - age / 0.25) ** 2, tick = Math.floor(age * TICK_RATE + 1e-6);
      const a = mulberry(i * 131 + tick) * Math.PI * 2, amp = p.shake * k;
      sx += Math.round(Math.cos(a) * amp); sy += Math.round(Math.sin(a) * amp);
      zoom = Math.max(zoom, 1 + (p.zoom - 1) * k); flash = Math.max(flash, p.flash * k * k);
    });
    return { shake: [sx, sy], zoom, flash };
  }
}

/** Pushes one clip frame (and its detached parts) anchored at (x, y), with the anchor/trim and facing rules of the manifest. */
export function pushFrame(out: SpriteDraw[], f: ResolvedFrame, x: number, y: number, flip: boolean, scale: number, palette: string | undefined, z: number, blend: BlendMode, alpha = 1, clipY?: number) {
  const [rx, ry, rw, rh] = f.rect, ax = f.anchor[0] - f.trim[0], ay = f.anchor[1] - f.trim[1];
  const px = Math.round(x), py = Math.round(y);
  const add = (atlas: string, rect: Rect, dx: number, dy: number, pal: string | undefined, zz: number) => {
    const w = rect[2], gx = flip ? px - (dx + w) * scale : px + dx * scale;
    out.push({ atlas, rect, x: gx, y: py + dy * scale, flipX: flip, scale, palette: pal, blend, alpha, z: zz, ...(clipY === undefined ? {} : { clipY }) });
  };
  for (const part of f.parts) if (part.layer === 'back') add(part.atlas, part.rect, part.offset[0], part.offset[1], part.palette ?? palette, z - 0.01);
  add(f.atlas, [rx, ry, rw, rh], -ax, -ay, palette, z);
  for (const part of f.parts) if (part.layer === 'front') add(part.atlas, part.rect, part.offset[0], part.offset[1], part.palette ?? palette, z + 0.01);
}

// ------------------------------------------------------------------------------------------------ backgrounds
export interface BackgroundLayer {
  readonly region: string;
  /** Top of the layer on the native canvas. */
  readonly y: number;
  /** Extra tint (HDR multiplier). */
  readonly tint?: readonly [number, number, number];
  readonly palette?: string;
  /** Repeat the layer vertically until this y (for tall fills). */
  readonly fillTo?: number;
}

/** Draws parallax layers that scroll one screen width per `barsPerScreen` bars (scroll factor from the region): tempo-locked, a pure function of the bar. */
export function backgroundDraws(pack: AssetPack, layers: readonly BackgroundLayer[], bar: number, nativeW: number, barsPerScreen = 1, dir: 1 | -1 = 1): SpriteDraw[] {
  const out: SpriteDraw[] = [];
  layers.forEach((l, i) => {
    const r = pack.regionOf(l.region, 'background');
    if (!r) return;
    const loop = r.loopWidth ?? r.rect[2], offset = Math.floor((((bar / barsPerScreen) * nativeW * r.scroll * dir) % loop + loop) % loop);
    for (let y = l.y; y < (l.fillTo ?? l.y + 1); y += r.rect[3])
      for (let x = -offset; x < nativeW; x += loop) out.push({ atlas: r.atlas, rect: r.rect, x, y, palette: l.palette ?? r.palette, tint: l.tint, z: -100 + i });
  });
  return out;
}
