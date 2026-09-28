import type { AvsWorkerRequest } from './avs-worker-protocol.ts';
import type { AvsAudioFrame } from './avs/types.ts';
import { NERV_SCENES, renderNervScene, type NervSceneId } from './nerv-scenes.ts';
import { parseNervPreset } from './nerv-preset.ts';
import { AvsTransition } from './mpc-transition.ts';

const scope = self as unknown as {
  onmessage: ((event: MessageEvent<AvsWorkerRequest>) => void) | null;
  postMessage(message: unknown, transfer?: Transferable[]): void;
};
const silence: AvsAudioFrame = {waveform:[new Uint8Array(576),new Uint8Array(576)],spectrum:[new Uint8Array(576),new Uint8Array(576)],beat:false,beatLevel:0};
let generation = -1, scene: NervSceneId | null = null;
let canvas: OffscreenCanvas | null = null, oldCanvas: OffscreenCanvas | null = null, nextCanvas: OffscreenCanvas | null = null;
let transition: AvsTransition | null = null, transitionKey = '';
function surface(current: OffscreenCanvas | null, width: number, height: number): OffscreenCanvas {
  const result = current ?? new OffscreenCanvas(width,height);
  if (result.width !== width) result.width = width;
  if (result.height !== height) result.height = height;
  return result;
}
scope.onmessage = ({data: message}) => {
  try {
    if (message.type === 'load') {
      scene = parseNervPreset(message.preset); generation = message.generation;
      transition = null; transitionKey = '';
      scope.postMessage({type:'ready',generation,unsupported:0}); return;
    }
    if (message.generation !== generation || message.type !== 'render' || !scene) return;
    const width = Math.max(64,Math.min(1280,Math.floor(message.width))), height = Math.max(64,Math.min(720,Math.floor(message.height)));
    if (!Number.isFinite(width) || !Number.isFinite(height)) throw Error('Invalid scene size');
    canvas = surface(canvas,width,height);
    const ctx = canvas.getContext('2d',{alpha:false}); if (!ctx) throw Error('NERV canvas unavailable');
    const clock = message.nerv ?? {time:0,localTime:0,progress:0,bpm:120,seed:1};
    if (![clock.time,clock.localTime,clock.progress,clock.bpm,clock.seed].every(Number.isFinite)) throw Error('Invalid scene clock');
    if ([clock.previousTime,clock.previousLocalTime,clock.blend,clock.transitionMode,clock.transitionSeed].some(value => value !== undefined && !Number.isFinite(value))) throw Error('Invalid transition clock');
    if (clock.previousScene !== undefined && !NERV_SCENES.includes(clock.previousScene)) throw Error('Invalid previous scene');
    const mode = clock.transitionMode ?? 1, seed = (clock.transitionSeed ?? clock.seed) >>> 0;
    if (!Number.isInteger(mode) || mode < 0 || mode > 15) throw Error('Invalid scene transition');
    const audio = message.audio ?? silence;
    // Reconstruct both sides from media time, including after a direct seek into a fade.
    // Sources remain separate from the output, so pushes never sample their own writes.
    if (clock.previousScene && clock.blend !== undefined && clock.blend < 1) {
      nextCanvas = surface(nextCanvas,width,height); oldCanvas = surface(oldCanvas,width,height);
      const next = nextCanvas.getContext('2d',{alpha:false}); if (!next) throw Error('NERV transition canvas unavailable');
      const old = oldCanvas.getContext('2d',{alpha:false}); if (!old) throw Error('NERV transition canvas unavailable');
      renderNervScene(next,width,height,{...clock,scene,audio});
      renderNervScene(old,width,height,{...clock,time:clock.previousTime??clock.time,scene:clock.previousScene,localTime:clock.previousLocalTime ?? clock.localTime,progress:1,audio});
      const key = `${mode}:${seed}`;
      if (!transition || key !== transitionKey) {
        transition = new AvsTransition(mode,{seed,createCanvas:()=>new OffscreenCanvas(1,1)});
        transitionKey = key;
      }
      if (clock.blend <= 0 && mode !== 15) ctx.drawImage(oldCanvas,0,0,width,height);
      else transition.draw(ctx,oldCanvas,nextCanvas,clock.blend,width,height);
    } else renderNervScene(ctx,width,height,{...clock,scene,audio});
    const bitmap = canvas.transferToImageBitmap();
    scope.postMessage({type:'frame',generation,sequence:message.sequence,bitmap,pcm:message.pcm,width,height,unsupported:0,renderMs:0},[bitmap,message.pcm]);
  } catch (error) {
    scope.postMessage({type:'error',generation:message.generation,message:String(error),fatal:true});
  }
};
