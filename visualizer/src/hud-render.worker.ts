/** Data-only HUD scene worker. Reconstructs both plates after seeks; the only compositor is AvsTransition. */
import type { HudWorkerRequest, HudPlaybackFrame } from './avs-worker-protocol.ts';
import { parseHudPreset } from './hud-preset.ts';
import { HudScene, HudRuntime, renderHudScene } from './hud/hud-engine.ts';
import { deriveHudTiming, validHudGrid } from './hud/hud-clock.ts';
import { HUD_SIGNAL_FLOATS, HUD_SIGNALS_VERSION } from './hud/hud-signals.ts';
import { NERV_SCENES, renderNervScene } from './nerv-scenes.ts';
import { AvsTransition, TRANSITION_COUNT, TRANSITION_CUT, transitionLevel, type TransitionEnv } from './mpc-transition.ts';
import { HARD_MAX_EDGE, HARD_MAX_PIXELS, fitWithin } from './render-resolution.ts';
import { AUDIO_DURATION_MAX } from './mpc-contract.ts';

const scope = self as unknown as { onmessage: ((event: MessageEvent<HudWorkerRequest>) => void) | null; postMessage(message: unknown, transfer?: Transferable[]): void };
type Cached = { scene: HudScene; runtime: HudRuntime };
let generation = -1, current: Cached | null = null;
let canvas: OffscreenCanvas | null = null, oldCanvas: OffscreenCanvas | null = null, nextCanvas: OffscreenCanvas | null = null;
let transition: AvsTransition | null = null, transitionKey = '';
const stash = new Map<string, Cached>();
const hash = (s: unknown): s is string => typeof s === 'string' && /^[a-f0-9]{64}$/.test(s);
const finite = (v: unknown): v is number => typeof v === 'number' && Number.isFinite(v);
const time = (v: unknown): v is number => finite(v) && v >= 0 && v <= 1e9;
const bound = (v: unknown): v is number => finite(v) && Math.abs(v) <= 1e9;
const integer = (v: unknown, lo: number, hi: number): v is number => finite(v) && Number.isInteger(v) && v >= lo && v <= hi;
function surface(c: OffscreenCanvas | null, w: number, h: number): OffscreenCanvas {
  const out = c ?? new OffscreenCanvas(w, h);
  if (out.width !== w) out.width = w; if (out.height !== h) out.height = h; return out;
}
function release(): void {
  for (const c of [oldCanvas, nextCanvas]) if (c) { c.width = 0; c.height = 0; }
  oldCanvas = nextCanvas = null; transition = null; transitionKey = '';
}
function compile(bytes: ArrayBuffer): Cached { const scene = HudScene.compile(parseHudPreset(bytes)); return { scene, runtime: new HudRuntime(scene) }; }
function validate(f: HudPlaybackFrame): void {
  if (!f || !time(f.time) || !bound(f.sceneStart) || f.sceneEnd !== null && (!bound(f.sceneEnd) || f.sceneEnd <= f.sceneStart)
    || !integer(f.seed, 0, 0xffffffff) || !integer(f.revision, 0, 0xffffffff) || f.grid !== null && !validHudGrid(f.grid)
    || !f.track || !time(f.track.position) || f.track.duration !== null && (!finite(f.track.duration) || f.track.duration <= 0 || f.track.duration > AUDIO_DURATION_MAX)
    || !['full', 'reduced'].includes(f.motion) || !['off', 'limit', 'strict'].includes(f.flash)) throw Error('Invalid scene clock');
  if (f.tempo !== null && (!f.tempo || !finite(f.tempo.bpm) || f.tempo.bpm < 20 || f.tempo.bpm > 400 || !finite(f.tempo.beatIndex)
    || !finite(f.tempo.beatPhase) || f.tempo.beatPhase < 0 || f.tempo.beatPhase > 1 || typeof f.tempo.locked !== 'boolean')) throw Error('Invalid scene clock');
  if (f.signals !== null && (!(f.signals instanceof Float32Array) || f.signals.length !== HUD_SIGNAL_FLOATS || f.signals[0] !== HUD_SIGNALS_VERSION || !f.signals.every(Number.isFinite))) throw Error('Invalid HUD signals');
  if (f.named !== undefined && (!Array.isArray(f.named) || f.named.length > 64 || new Set(f.named.map(i => i?.id)).size !== f.named.length
    || f.named.some(i => !i || !/^[a-z0-9_-]{1,32}$/.test(i.id) || !bound(i.start) || !bound(i.end) || i.end <= i.start))) throw Error('Invalid named intervals');
  for (const v of [f.previousTime, f.previousLocalTime, f.previousSceneStart, f.previousSceneEnd, f.blend, f.transitionSeed, f.fadeSeconds])
    if (v !== undefined && v !== null && !finite(v)) throw Error('Invalid transition clock');
  if (f.fadeSeconds !== undefined && f.fadeSeconds < 0) throw Error('Invalid transition clock');
  if (!integer(f.transitionMode ?? 1, 0, TRANSITION_COUNT - 1) || !finite(f.transitionBeats ?? 4) || !((f.transitionBeats ?? 4) > 0 && (f.transitionBeats ?? 4) <= 64)
    || !integer(f.transitionBoundary ?? 0, 0, 3) || !integer(f.transitionAccent ?? 1, 0, 1) || f.transitionReduced !== undefined && typeof f.transitionReduced !== 'boolean') throw Error('Invalid scene transition');
  if (f.previous && (!hash(f.previous.sha256) || !['hud', 'nerv'].includes(f.previous.kind)
    || f.previous.kind === 'nerv' && !NERV_SCENES.includes(f.previous.scene!))) throw Error('Invalid previous scene');
}
scope.onmessage = ({ data: m }) => {
  try {
    if (m.type === 'load') {
      const loaded = compile(m.preset); release(); stash.clear(); current = loaded; generation = m.generation;
      scope.postMessage({ type: 'ready', generation, unsupported: 0 }); return;
    }
    if (m.generation !== generation || !current) return;
    if (m.type === 'stash') {
      if (!hash(m.sha256)) throw Error('Invalid previous scene hash');
      const cached = compile(m.preset); stash.delete(m.sha256); stash.set(m.sha256, cached);
      while (stash.size > 4) stash.delete(stash.keys().next().value!); return;
    }
    if (m.type === 'clear') { release(); stash.clear(); current.runtime.reset(); return; }
    if (m.type !== 'render') return;
    const started = performance.now();
    if (!finite(m.width) || !finite(m.height)) throw Error('Invalid scene size');
    const { width, height } = fitWithin(m.width, m.height, HARD_MAX_EDGE, HARD_MAX_PIXELS), f = m.hud!;
    validate(f); canvas = surface(canvas, width, height);
    const ctx = canvas.getContext('2d', { alpha: false }); if (!ctx) throw Error('HUD canvas unavailable');
    const policy = { motion: f.motion, flash: f.flash }, previous = f.previous, blend = f.blend;
    let stats;
    if (previous && blend !== undefined && blend < 1) {
      nextCanvas = surface(nextCanvas, width, height); oldCanvas = surface(oldCanvas, width, height);
      const next = nextCanvas.getContext('2d', { alpha: false }), old = oldCanvas.getContext('2d', { alpha: false });
      if (!next || !old) throw Error('HUD transition canvas unavailable');
      stats = renderHudScene(current.scene, current.runtime, next, width, height, f, policy);
      const oldTime = f.previousTime ?? f.time, oldStart = f.previousSceneStart ?? oldTime - (f.previousLocalTime ?? 0), oldEnd = f.previousSceneEnd ?? null;
      if (previous.kind === 'hud') {
        const cached = stash.get(previous.sha256); if (!cached) throw Error('Previous HUD scene was not stashed');
        renderHudScene(cached.scene, cached.runtime, old, width, height, { ...f, time: oldTime, sceneStart: oldStart, sceneEnd: oldEnd }, policy);
      } else {
        const t = deriveHudTiming(f, current.scene.manifest.timing?.freeBars ?? 8);
        const audio = m.audio ?? { waveform: [new Uint8Array(576), new Uint8Array(576)] as const, spectrum: [new Uint8Array(576), new Uint8Array(576)] as const, beat: false, beatLevel: 0 };
        renderNervScene(old, width, height, { scene: previous.scene!, time: oldTime, localTime: f.previousLocalTime ?? Math.max(0, oldTime - oldStart), progress: 1,
          bpm: t.beat.bpm, seed: f.seed, audio, ...(f.grid ? { grid: f.grid } : {}), sceneStart: oldStart, ...(oldEnd !== null ? { sceneEnd: oldEnd } : {}) });
      }
      const mode = f.transitionMode ?? 1, seed = (f.transitionSeed ?? f.seed) >>> 0, beats = f.transitionBeats ?? 4, boundary = (f.transitionBoundary ?? 0) as 0 | 1 | 2 | 3;
      const reduced = f.transitionReduced ?? f.motion === 'reduced', smooth = current.scene.manifest.canvas.style !== 'pixel' || previous.kind === 'nerv' || stash.get(previous.sha256)?.scene.manifest.canvas.style !== 'pixel';
      const key = `${mode}:${seed}:${beats}:${boundary}:${reduced}:${smooth}`;
      if (!transition || key !== transitionKey) { transition = new AvsTransition(mode, { seed, createCanvas: () => new OffscreenCanvas(1, 1), context: { beatsTotal: beats, boundary, nervPair: true, reducedMotion: reduced }, smooth }); transitionKey = key; }
      if (blend <= 0 && mode !== TRANSITION_CUT) ctx.drawImage(oldCanvas, 0, 0, width, height);
      else {
        const timing = deriveHudTiming(f, current.scene.manifest.timing?.freeBars ?? 8), env: Partial<TransitionEnv> = { bpm: timing.beat.bpm, beatPhase: timing.beat.phase, barPhase: timing.beat.barPhase, beatsTotal: beats,
          level: transitionLevel(m.audio ?? null), accent: f.transitionAccent === 0 ? 0 : 1, reducedMotion: reduced, ...(f.fadeSeconds !== undefined ? { seconds: f.fadeSeconds } : {}) };
        transition.draw(ctx, oldCanvas, nextCanvas, blend, width, height, env);
      }
    } else { release(); stats = renderHudScene(current.scene, current.runtime, ctx, width, height, f, policy); }
    const bitmap = canvas.transferToImageBitmap();
    scope.postMessage({ type: 'frame', generation, sequence: m.sequence, bitmap, pcm: m.pcm, width, height, unsupported: 0,
      renderMs: Math.max(0, performance.now() - started), hudStats: stats }, [bitmap, m.pcm]);
  } catch (error) { scope.postMessage({ type: 'error', generation: m.generation, message: String(error), fatal: true }); }
};
