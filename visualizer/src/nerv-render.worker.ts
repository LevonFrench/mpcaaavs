import type { AvsWorkerRequest } from './avs-worker-protocol.ts';
import type { AvsAudioFrame } from './avs/types.ts';
import { renderNervScene, type NervSceneId } from './nerv-scenes.ts';
import { parseNervPreset } from './nerv-preset.ts';

const scope = self as unknown as {
  onmessage: ((event: MessageEvent<AvsWorkerRequest>) => void) | null;
  postMessage(message: unknown, transfer?: Transferable[]): void;
};
const silence: AvsAudioFrame = {waveform:[new Uint8Array(576),new Uint8Array(576)],spectrum:[new Uint8Array(576),new Uint8Array(576)],beat:false,beatLevel:0};
let generation = -1, scene: NervSceneId | null = null;
let canvas: OffscreenCanvas | null = null, oldCanvas: OffscreenCanvas | null = null;
scope.onmessage = ({data: message}) => {
  try {
    if (message.type === 'load') {
      scene = parseNervPreset(message.preset); generation = message.generation;
      scope.postMessage({type:'ready',generation,unsupported:0}); return;
    }
    if (message.generation !== generation || message.type !== 'render' || !scene) return;
    const width = Math.max(64,Math.min(1280,Math.floor(message.width))), height = Math.max(64,Math.min(720,Math.floor(message.height)));
    if (!Number.isFinite(width) || !Number.isFinite(height)) throw Error('Invalid scene size');
    if (!canvas) canvas = new OffscreenCanvas(width,height);
    if (canvas.width !== width) canvas.width = width;
    if (canvas.height !== height) canvas.height = height;
    const ctx = canvas.getContext('2d',{alpha:false}); if (!ctx) throw Error('NERV canvas unavailable');
    const clock = message.nerv ?? {time:0,localTime:0,progress:0,bpm:120,seed:1};
    if (![clock.time,clock.localTime,clock.progress,clock.bpm,clock.seed].every(Number.isFinite)) throw Error('Invalid scene clock');
    const audio = message.audio ?? silence;
    renderNervScene(ctx,width,height,{...clock,scene,audio});
    // Reconstruct both sides from media time, including after a direct seek into a fade.
    // A fixed dissolve avoids random transitions depending on visitation history.
    if (clock.previousScene && clock.blend !== undefined && clock.blend < 1) {
      if (!oldCanvas) oldCanvas = new OffscreenCanvas(width,height);
      if (oldCanvas.width !== width) oldCanvas.width = width;
      if (oldCanvas.height !== height) oldCanvas.height = height;
      const old = oldCanvas.getContext('2d',{alpha:false}); if (!old) throw Error('NERV transition canvas unavailable');
      renderNervScene(old,width,height,{...clock,time:clock.previousTime??clock.time,scene:clock.previousScene,localTime:clock.previousLocalTime ?? clock.localTime,progress:1,audio});
      ctx.save(); ctx.globalAlpha = 1-Math.max(0,clock.blend); ctx.drawImage(oldCanvas,0,0); ctx.restore();
    }
    const bitmap = canvas.transferToImageBitmap();
    scope.postMessage({type:'frame',generation,sequence:message.sequence,bitmap,pcm:message.pcm,width,height,unsupported:0,renderMs:0},[bitmap,message.pcm]);
  } catch (error) {
    scope.postMessage({type:'error',generation:message.generation,message:String(error),fatal:true});
  }
};
