// Shared NERV preset rendering (moved out of src/nerv-render.worker.ts unchanged; see that file for the contract).
import type { AvsWorkerRequest, NervPlaybackFrame } from './avs-worker-protocol.ts';
import type { AvsAudioFrame } from './avs/types.ts';
import { NERV_SCENES, renderNervScene, type NervSceneFrame, type NervSceneId } from './nerv-scenes.ts';
import { parseNervPreset } from './nerv-preset.ts';
import { AvsTransition, TRANSITION_CUT, transitionLevel, type TransitionEnv } from './mpc-transition.ts';
import { TRANSITION_COUNT } from './mpc-contract.ts';
import { compileClockGrid, timingSignals } from './mpc-beat-grid.ts';
import { HARD_MAX_EDGE, HARD_MAX_PIXELS, fitWithin } from './render-resolution.ts';

export const NERV_SILENCE: AvsAudioFrame = {waveform:[new Uint8Array(576),new Uint8Array(576)],spectrum:[new Uint8Array(576),new Uint8Array(576)],beat:false,beatLevel:0};
const finite = (value: unknown): boolean => typeof value === 'number' && Number.isFinite(value);
const optional = (value: unknown): boolean => value === undefined || finite(value);
const nullable = (value: unknown): boolean => value === undefined || value === null || finite(value);
const integer = (value: unknown, low: number, high: number): boolean => typeof value === 'number' && Number.isInteger(value) && value >= low && value <= high;
/** Validate a NERV playback clock (throws 'Invalid scene clock' / 'Invalid transition clock' / 'Invalid previous scene' / 'Invalid scene transition'). */
export function validateNervClock(clock: NervPlaybackFrame): void {
  if (![clock.time,clock.localTime,clock.progress,clock.bpm,clock.seed].every(Number.isFinite)) throw Error('Invalid scene clock');
  if (![clock.previousTime,clock.previousLocalTime,clock.blend,clock.transitionMode,clock.transitionSeed,clock.transitionBeats,clock.fadeSeconds].every(optional)
    || ![clock.sceneStart,clock.sceneEnd,clock.previousSceneStart,clock.previousSceneEnd].every(nullable)
    || clock.fadeSeconds !== undefined && clock.fadeSeconds < 0
    || clock.grid != null && !compileClockGrid(clock.grid)) throw Error('Invalid transition clock');
  if (clock.previousScene !== undefined && !NERV_SCENES.includes(clock.previousScene)) throw Error('Invalid previous scene');
  const {transitionMode:mode = 1,transitionBeats:beats = 4,transitionBoundary:boundary = 0,transitionAccent:accent = 1,transitionReduced:reduced = false} = clock;
  if (!integer(mode,0,TRANSITION_COUNT - 1) || !(beats > 0 && beats <= 64) || !integer(boundary,0,3) || !integer(accent,0,1) || typeof reduced !== 'boolean') throw Error('Invalid scene transition');
}
/** One plate's frame: only NervSceneFrame keys, with the given scene bounds (never the other plate's). */
function plate(clock: NervPlaybackFrame, audio: AvsAudioFrame, scene: NervSceneId, time: number, localTime: number, progress: number, start: number | null | undefined, end: number | null | undefined): NervSceneFrame {
  return {scene,time,localTime,progress,bpm:clock.bpm,seed:clock.seed,audio,
    ...(clock.grid ? {grid:clock.grid} : {}),...(typeof start === 'number' ? {sceneStart:start} : {}),...(typeof end === 'number' ? {sceneEnd:end} : {})};
}
/** The AvsTransition of a clocked NERV change, kept between frames (keyed mode:seed:beats:boundary:reduced). */
export interface NervTransitionCache { transition: AvsTransition | null; key: string }

/**
 * Composite a clocked NERV change from `oldCanvas` (the previous plate) to `nextCanvas` into `ctx` with the host's
 * transition (style, beats, boundary, accent, reduced motion) at `clock.blend`, as the NERV worker always has.
 */
export function drawNervTransition(ctx: OffscreenCanvasRenderingContext2D, oldCanvas: OffscreenCanvas, nextCanvas: OffscreenCanvas, clock: NervPlaybackFrame, audio: AvsAudioFrame, width: number, height: number, cache: NervTransitionCache): void {
  const mode = clock.transitionMode ?? 1, seed = (clock.transitionSeed ?? clock.seed) >>> 0, blend = clock.blend ?? 1;
  const beats = clock.transitionBeats ?? 4, boundary = (clock.transitionBoundary ?? 0) as 0 | 1 | 2 | 3, reduced = clock.transitionReduced === true;
  const key = `${mode}:${seed}:${beats}:${boundary}:${reduced ? 1 : 0}`;
  if (!cache.transition || key !== cache.key) {
    cache.transition = new AvsTransition(mode,{seed,createCanvas:()=>new OffscreenCanvas(1,1),context:{beatsTotal:beats,boundary,nervPair:true,reducedMotion:reduced},smooth:true});
    cache.key = key;
  }
  if (blend <= 0 && mode !== TRANSITION_CUT) ctx.drawImage(oldCanvas,0,0,width,height);
  else {
    // Beat and bar phase come from the saved grid when the frame carries one, else from the legacy tempo (timingSignals is exact either way).
    const signals = timingSignals(clock.time,clock.grid ?? null,clock.sceneStart ?? null,clock.sceneEnd ?? null,{bpm:Math.min(400,Math.max(20,clock.bpm)),localTime:clock.localTime});
    const bpm = compileClockGrid(clock.grid)?.bpmAt(clock.time) ?? clock.bpm;
    const env: Partial<TransitionEnv> = {bpm,beatPhase:signals.beatPhase,barPhase:signals.barPhase,beatsTotal:beats,level:transitionLevel(audio),
      accent:clock.transitionAccent === 0 ? 0 : 1,reducedMotion:reduced,...(clock.fadeSeconds !== undefined ? {seconds:clock.fadeSeconds} : {})};
    cache.transition.draw(ctx,oldCanvas,nextCanvas,blend,width,height,env);
  }
}

/**
 * The NERV preset renderer of src/nerv-render.worker.ts (Canvas2D, src/nerv-scenes.ts) as a message handler, so the show
 * worker (src/show-render.worker.ts) can fall back to it when WebGL2 or the show engine is unavailable. `post` is the
 * worker's postMessage.
 */
export function createNervLegacyRenderer(post: (message: unknown, transfer?: Transferable[]) => void): (message: AvsWorkerRequest) => void {
  let generation = -1, scene: NervSceneId | null = null;
  let canvas: OffscreenCanvas | null = null, oldCanvas: OffscreenCanvas | null = null, nextCanvas: OffscreenCanvas | null = null;
  const cache: NervTransitionCache = {transition:null,key:''};
  function surface(current: OffscreenCanvas | null, width: number, height: number): OffscreenCanvas {
    const result = current ?? new OffscreenCanvas(width,height);
    if (result.width !== width) result.width = width;
    if (result.height !== height) result.height = height;
    return result;
  }
  /** Drop the transition-only state (both plate surfaces and the cached transition with its scratch surfaces). Zero-sized first, so the backing store goes now rather than at the next collection. */
  function release(): void {
    for (const c of [oldCanvas,nextCanvas]) if (c) { c.width = 0; c.height = 0; }
    oldCanvas = nextCanvas = null; cache.transition = null; cache.key = '';
  }
  return (message: AvsWorkerRequest): void => {
    try {
      if (message.type === 'load') {
        scene = parseNervPreset(message.preset); generation = message.generation;
        release();
        post({type:'ready',generation,unsupported:0}); return;
      }
      if (message.generation !== generation || message.type !== 'render' || !scene) return;
      const started = performance.now();
      if (!Number.isFinite(message.width) || !Number.isFinite(message.height)) throw Error('Invalid scene size');
      const {width,height} = fitWithin(message.width,message.height,HARD_MAX_EDGE,HARD_MAX_PIXELS);
      canvas = surface(canvas,width,height);
      const ctx = canvas.getContext('2d',{alpha:false}); if (!ctx) throw Error('NERV canvas unavailable');
      const clock: NervPlaybackFrame = message.nerv ?? {time:0,localTime:0,progress:0,bpm:120,seed:1};
      validateNervClock(clock);
      const audio = message.audio ?? NERV_SILENCE, previous = clock.previousScene, blend = clock.blend;
      // Reconstruct both sides from media time, including after a direct seek into a fade.
      // Sources remain separate from the output, so pushes never sample their own writes.
      if (previous && blend !== undefined && blend < 1) {
        nextCanvas = surface(nextCanvas,width,height); oldCanvas = surface(oldCanvas,width,height);
        const next = nextCanvas.getContext('2d',{alpha:false}); if (!next) throw Error('NERV transition canvas unavailable');
        const old = oldCanvas.getContext('2d',{alpha:false}); if (!old) throw Error('NERV transition canvas unavailable');
        renderNervScene(next,width,height,plate(clock,audio,scene,clock.time,clock.localTime,clock.progress,clock.sceneStart,clock.sceneEnd));
        renderNervScene(old,width,height,plate(clock,audio,previous,clock.previousTime ?? clock.time,clock.previousLocalTime ?? clock.localTime,1,clock.previousSceneStart,clock.previousSceneEnd));
        drawNervTransition(ctx,oldCanvas,nextCanvas,clock,audio,width,height,cache);
      } else {
        release();
        renderNervScene(ctx,width,height,plate(clock,audio,scene,clock.time,clock.localTime,clock.progress,clock.sceneStart,clock.sceneEnd));
      }
      const bitmap = canvas.transferToImageBitmap(), elapsed = performance.now() - started;
      post({type:'frame',generation,sequence:message.sequence,bitmap,pcm:message.pcm,width,height,unsupported:0,renderMs:elapsed > 0 ? elapsed : 0},[bitmap,message.pcm]);
    } catch (error) {
      post({type:'error',generation:message.generation,message:String(error),fatal:true});
    }
  };
}
