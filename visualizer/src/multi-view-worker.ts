/** Existing AVS/NERV/HUD protocol adapter. Asset confinement and SHA verification remain in the host loaders. */
import { AudioHold } from './mpc-audio-stream.ts';
import { sceneWorkerUrl } from './hud/hud-host.ts';
import type { LocalAvsPreset } from './avs/local-collection.ts';
import type { AvsAudioFrame } from './avs/types.ts';
import type { AvsWorkerRequest, AvsWorkerResponse, AvsWorkerRenderMessage } from './avs-worker-protocol.ts';
import type { MultiViewRenderer, MultiViewRenderFrame } from './multi-view-runtime.ts';
export interface MultiViewWorkerHost {
  catalog: readonly LocalAvsPreset[];
  fetchPreset(preset: LocalAvsPreset): Promise<Uint8Array>;
  bitmaps(hash: string): Promise<readonly { name: string; bytes: ArrayBuffer }[]>;
  size(index: number, pane: number): { width: number; height: number };
  worker(url: string): Worker;
  /** Optional: the worker for a scene kind at a pane size (the host's choice of renderer, e.g. NERV lanes on the show
   *  engine at the scale the pane needs). Without it, `worker(sceneWorkerUrl(kind))`. */
  sceneWorker?(kind: string | undefined, size: { width: number; height: number }): Worker;
  /** Reuse the host's PCM, shared HudFeed, reduced motion, track duration and scene-frame construction. */
  frame(input: MultiViewRenderFrame, index: number, audio: AvsAudioFrame): Omit<AvsWorkerRenderMessage, 'type' | 'generation' | 'sequence' | 'width' | 'height'>;
  initialAudio(): AvsAudioFrame;
}
let generation = 0;
/** One renderer; abort closes the worker, rejects waits and closes any late transferred frame. */
export async function createMultiViewWorker(host: MultiViewWorkerHost, index: number, pane: number, signal: AbortSignal): Promise<MultiViewRenderer> {
  if (signal.aborted) throw Error('Pane load canceled');
  const preset = host.catalog[index]; if (!preset) throw Error('Unknown pane preset');
  const gen = ++generation;
  let worker: Worker | null = null, dead = false, sequence = 0, timer: ReturnType<typeof setTimeout> | undefined;
  let rejectReady: ((error: Error) => void) | null = null;
  let waiting: { sequence: number; resolve: (image: ImageBitmap) => void; reject: (error: Error) => void } | null = null;
  const rejectWaiting = (error: Error) => { waiting?.reject(error); };
  const hold = new AudioHold(); let lastAudio = host.initialAudio(); hold.push(lastAudio);
  const dispose = () => {
    if (dead) return; dead = true; clearTimeout(timer); worker?.terminate(); signal.removeEventListener('abort', dispose);
    const error = Error('Pane renderer closed'); rejectReady?.(error); rejectReady = null; waiting?.reject(error); waiting = null;
  };
  signal.addEventListener('abort', dispose, { once: true });
  try {
    // The race bounds even a host loader that cannot cancel an underlying asset fetch.
    const [bytes, bitmaps] = await new Promise<readonly [Uint8Array, readonly { name: string; bytes: ArrayBuffer }[]]>((resolve, reject) => {
      rejectReady = reject; timer = setTimeout(() => reject(Error('Pane asset fetch timed out')), 15000);
      Promise.all([host.fetchPreset(preset), preset.kind === 'nerv' || preset.kind === 'hud' ? Promise.resolve([]) : host.bitmaps(preset.sha256)]).then(resolve, reject);
    });
    clearTimeout(timer); rejectReady = null;
    if (dead || signal.aborted) throw Error('Pane load canceled');
    const size = host.size(index, pane);
    worker = host.sceneWorker ? host.sceneWorker(preset.kind, size) : host.worker(sceneWorkerUrl(preset.kind));
    const ready = new Promise<void>((resolve, reject) => {
      rejectReady = reject; timer = setTimeout(() => reject(Error('Pane worker initialization timed out')), 15000);
      worker!.onerror = event => { const error = Error(event.message || 'Pane worker failed'); rejectReady?.(error); waiting?.reject(error); dispose(); };
      worker!.onmessage = (event: MessageEvent<AvsWorkerResponse>) => {
        const message = event.data;
        if (dead || message.generation !== gen) { if (message.type === 'frame') message.bitmap.close(); return; }
        if (message.type === 'ready') { clearTimeout(timer); rejectReady = null; resolve(); }
        else if (message.type === 'error') { const error = Error(message.message || 'Pane preset failed'); rejectReady?.(error); waiting?.reject(error); dispose(); }
        else if (message.type === 'frame') {
          if (waiting?.sequence === message.sequence) { clearTimeout(timer); const job = waiting; waiting = null; job.resolve(message.bitmap); }
          else message.bitmap.close();
        }
      };
    });
    const copy = bytes.slice();
    const load: AvsWorkerRequest = { type: 'load', generation: gen, preset: copy.buffer as ArrayBuffer, bitmaps, ...size, gpuLane: 'exact' };
    worker.postMessage(load, [load.preset]); await ready;
    return {
      pushAudio(audio) { hold.push(audio); },
      resetAudio() { hold.reset(); lastAudio = { waveform: [new Uint8Array(576), new Uint8Array(576)], spectrum: [new Uint8Array(576), new Uint8Array(576)], beat: false, beatLevel: 0 }; },
      render(input) {
        if (dead) return Promise.reject(Error('Pane renderer closed'));
        if (waiting) return Promise.reject(Error('Pane already rendering'));
        const audio = input.playing ? hold.consume() : lastAudio; lastAudio = audio;
        const request: AvsWorkerRequest = { ...host.frame(input, index, audio), type: 'render', generation: gen, sequence: ++sequence, ...host.size(index, pane) };
        const result = new Promise<ImageBitmap>((resolve, reject) => { waiting = { sequence, resolve, reject }; timer = setTimeout(() => { reject(Error('Pane render timed out')); dispose(); }, 5000); });
        try { worker!.postMessage(request, [request.pcm]); } catch (error) { rejectWaiting(error instanceof Error ? error : Error(String(error))); dispose(); }
        return result;
      },
      dispose,
    };
  } catch (error) { dispose(); throw error; }
}
