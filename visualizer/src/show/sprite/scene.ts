// A sprite plate as an engine Scene: one class per PlateSpec. The scene is stateless (a pure function of the frame's time, the analysis and the
// seed): init() builds the procedural pack, choreographs the plate's window into a script and uploads the atlases; render() evaluates the
// stage at f.t, draws backdrop + stage + HUD at the plate's native resolution, presents it with the pixel scaling policy and returns the post
// overrides (hit shake and zoom as whole native pixels, flash).
import type * as THREE from 'three';
import { Scene, type Frame, type PostOverrides, type SceneClass, type SceneCtx } from '../scene.ts';
import { SCALE, W, H } from '../gl.ts';
import type { AudioData } from '../audio.ts';
import type { AssetPack } from '../../asset-packs/pack.ts';
import type { SectionRole } from '../../song-map/types.ts';
import { choreograph, type Script, type StagePlan } from './choreo.ts';
import { SpriteLayer } from './layer.ts';
import { PixelPresenter, type BorderTheme } from './present.ts';
import { backgroundDraws, Stage, type BackgroundLayer, type SpriteDraw, type StageFrame } from './perform.ts';
import { scaleLayout, type ScaleLayout, type ScaleMode } from './scaling.ts';
import { buildTestPack } from './test-pack.ts';

export interface PlateSpec {
  readonly id: string;
  readonly native: readonly [number, number];
  readonly scaleMode?: ScaleMode;
  readonly border: BorderTheme;
  /** Linear clear colour behind the backdrop layers. */
  readonly bg: readonly [number, number, number];
  readonly backdrop: { readonly layers: readonly BackgroundLayer[]; readonly barsPerScreen: number; readonly dir?: 1 | -1 };
  readonly plan: StagePlan;
  /** HUD and set dressing drawn over the stage, from musical signals only. */
  readonly hud: (h: HudContext) => SpriteDraw[];
  /** Extra draws under the stage actors (props and set dressing). */
  readonly dressing?: (h: HudContext) => SpriteDraw[];
}

export interface HudContext {
  readonly pack: AssetPack;
  readonly au: AudioData;
  readonly t: number;
  readonly beat: number;
  readonly bar: number;
  readonly start: number;
  readonly end: number;
  /** 0..1 through the plate's window. */
  readonly p: number;
  readonly nativeW: number;
  readonly nativeH: number;
  readonly section: { role: SectionRole; p: number; start: number; end: number };
  readonly stage: StageFrame;
  readonly script: Script;
  readonly params: Record<string, unknown>;
  /** Plate number in the show (1-based) and the plate's display name. */
  readonly plateNo: number;
  readonly plateName: string;
}

let packCache: ReturnType<typeof buildTestPack> | null = null;
/** The procedural test pack, built once per worker. */
export function sharedTestPack() { return (packCache ??= buildTestPack()); }

const POST: PostOverrides = { bloom: 0.3, bloomThreshold: 1.05, bloomKnee: 0.4, bloomRadius: 0.6, halation: 0, ca: 0, grain: 0.012, vignette: 0.1, hud: 0, exposure: 1 };

export function makeSpritePlate(spec: PlateSpec, name: string): SceneClass {
  return class SpritePlate extends Scene {
    private layer!: SpriteLayer;
    private presenter = new PixelPresenter();
    private stage!: Stage;
    private layout: ScaleLayout;
    private plateNo: number;
    constructor(ctx: SceneCtx) {
      super(ctx);
      // the output is the logical canvas times the output scale; the native canvas is scaled by the pixel policy inside it
      this.layout = scaleLayout(spec.native[0], spec.native[1], W * SCALE, H * SCALE, spec.scaleMode ?? 'integer');
      this.plateNo = Number(ctx.params.plateNo ?? 1);
    }

    override init() {
      const tp = sharedTestPack();
      this.layer = new SpriteLayer(this.ctx.renderer, tp.pack, spec.native[0], spec.native[1]);
      const seed = Number(this.ctx.params.seed ?? 1) + Math.round(this.ctx.start * 100);
      const script = choreograph(this.ctx.audio, tp.pack, spec.plan, [this.ctx.start, this.ctx.end], seed);
      this.stage = new Stage(tp.pack, spec.plan, script, this.ctx.audio);
    }

    render(f: Frame, out: THREE.WebGLRenderTarget): PostOverrides {
      const { audio: au, renderer } = this.ctx;
      const sf = this.stage.evaluate(f.t);
      const sec = au.sectionAt(f.t);
      const h: HudContext = {
        pack: this.stage.pack, au, t: f.t, beat: f.beat, bar: au.songBarAt(f.t), start: this.ctx.start, end: this.ctx.end, p: f.p, nativeW: spec.native[0], nativeH: spec.native[1],
        section: { role: sec.role, p: sec.p, start: sec.start, end: sec.end }, stage: sf, script: this.stage.script, params: this.ctx.params, plateNo: this.plateNo, plateName: name,
      };
      const draws: SpriteDraw[] = [...backgroundDraws(this.stage.pack, spec.backdrop.layers, h.bar, spec.native[0], spec.backdrop.barsPerScreen, spec.backdrop.dir ?? 1), ...(spec.dressing?.(h) ?? []), ...sf.draws, ...spec.hud(h)];
      this.layer.begin(spec.bg, f.beat);
      this.layer.draw(draws);
      const pulse = Math.max(au.hit('kick', f.t, 0.1), sf.post.flash);
      this.presenter.present(renderer, this.layer.target.texture, this.layout, spec.border, f.beat, pulse * 0.8, out);
      // hit shake is in whole native pixels; post shakes in logical px, so scale by the native pixel's logical size
      const k = this.layout.scale / SCALE;
      return { ...POST, shake: [sf.post.shake[0] * k, -sf.post.shake[1] * k], zoom: sf.post.zoom, flash: sf.post.flash };
    }

    override dispose() { this.layer?.dispose(); }
  };
}
