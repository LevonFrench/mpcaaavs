import { fetchLocalAvsCatalog, fetchLocalAvsPreset } from './avs/local-collection.ts';
import type { AvsWorkerRequest, AvsWorkerResponse } from './avs-worker-protocol.ts';
import { FlashGate } from './flash-gate.ts';
import { PresetNavigation } from './mpc-preset-navigation.ts';
import { loadPresetBitmaps } from './mpc-bitmap-dependencies.ts';

interface Bridge { postMessage(message: string): void; addEventListener(type: 'message', listener: (event: MessageEvent) => void): void }
const bridge = (window as unknown as { chrome?: { webview?: Bridge } }).chrome?.webview;
const canvas = document.querySelector<HTMLCanvasElement>('#visualizer')!;
const context = canvas.getContext('2d', { alpha: false })!;
const label = document.querySelector<HTMLElement>('#preset')!;
// Full canonical collection, including all curated picks. Do not substitute
// the small bundled showcase bank or silently filter historical presets out.
const catalog = await fetchLocalAvsCatalog().catch(error => {
  label.textContent = `Full preset collection unavailable: ${String(error)}`;
  document.body.classList.add('announce');
  bridge?.postMessage('error');
  throw error;
});
const presets = new PresetNavigation(catalog.length);
const flash = new FlashGate('limit');
let worker: Worker | null = null, generation = 0, sequence = 0;
let busy = false, loaded = false, playing = false, epoch = -1, lastAudio = 0;
let pcm = new Float32Array(1152), bitmap: ImageBitmap | null = null;
let announceTimer = 0, watchdog = 0;

function announce(text: string) {
  label.textContent = text; document.body.classList.add('announce');
  clearTimeout(announceTimer);
  announceTimer = window.setTimeout(() => document.body.classList.remove('announce'), 3000);
}
function fail(message: string) {
  loaded = false; busy = false; worker?.terminate(); worker = null;
  clearTimeout(watchdog); announce(message); bridge?.postMessage('error');
}
async function load() {
  const current = ++generation;
  clearTimeout(watchdog);
  loaded = busy = false;
  worker?.terminate(); worker = null;
  bitmap?.close(); bitmap = null;
  flash.reset();
  const preset = catalog[presets.index]!;
  announce(`${presets.index + 1} / ${catalog.length} · ${preset.name}`);
  try {
    const [bytes, bitmaps] = await Promise.all([fetchLocalAvsPreset(preset), loadPresetBitmaps(preset.sha256)]);
    if (current !== generation) return;
    const port = new Worker(new URL('./avs-render.worker.js', import.meta.url), { type: 'module' });
    worker = port;
    port.onerror = event => { if (current === generation) fail(event.message); };
    port.onmessage = (event: MessageEvent<AvsWorkerResponse>) => {
      const message = event.data;
      if (current !== generation) { if (message.type === 'frame') message.bitmap.close(); return; }
      if (message.type === 'ready') { loaded = true; bridge?.postMessage('ready'); }
      if (message.type === 'error') { fail('AAAVS preset failed'); return; }
      if (message.type === 'frame') {
        clearTimeout(watchdog); busy = false;
        bitmap?.close(); bitmap = message.bitmap;
      }
    };
    const request: AvsWorkerRequest = { type: 'load', generation: current, preset: bytes.buffer as ArrayBuffer, bitmaps, width: 640, height: 360, gpuLane: 'exact' };
    port.postMessage(request, [request.preset]);
  } catch (error) { if (current === generation) fail(String(error)); }
}
bridge?.addEventListener('message', event => {
  const message = event.data;
  if (!message || typeof message !== 'object') return;
  if (message.type === 'audio') {
    playing = message.playing === true;
    if (Array.isArray(message.pcm) && message.pcm.length === 1152) {
      pcm = Float32Array.from(message.pcm, x => typeof x === 'number' && Number.isFinite(x) ? Math.max(-1, Math.min(1, x)) : 0);
      lastAudio = performance.now();
    }
    if (epoch !== message.epoch) { epoch = message.epoch; void load(); }
    bridge.postMessage('ack');
  } else if (message.type === 'next') { presets.next(); void load(); }
  else if (message.type === 'previous') { presets.previous(); void load(); }
  else if (message.type === 'shuffle') { presets.shuffle = message.enabled === true; announce(`Preset shuffle ${presets.shuffle ? 'on' : 'off'}`); }
});
function frame(now: number) {
  if (bitmap) {
    const w = Math.max(1, Math.round(canvas.clientWidth * devicePixelRatio));
    const h = Math.max(1, Math.round(canvas.clientHeight * devicePixelRatio));
    if (canvas.width !== w || canvas.height !== h) { canvas.width = w; canvas.height = h; flash.reset(); }
    const source = bitmap;
    context.imageSmoothingEnabled = false;
    flash.present(context, source, now / 1000, () => context.drawImage(source, 0, 0, canvas.width, canvas.height));
    source.close(); bitmap = null;
  }
  if (loaded && !busy && playing && now - lastAudio < 500 && worker) {
    busy = true;
    const data = pcm.slice().buffer;
    // Match the display aspect at a bounded classic raster. No stretching of a 16:9 frame.
    const width = 640, height = Math.max(64, Math.min(640, Math.round(width * canvas.clientHeight / Math.max(1, canvas.clientWidth))));
    const request: AvsWorkerRequest = { type: 'render', generation, sequence: ++sequence, pcm: data, width, height };
    worker.postMessage(request, [data]);
    watchdog = window.setTimeout(() => fail('Preset timed out'), 5000);
  }
  requestAnimationFrame(frame);
}
document.addEventListener('dblclick', () => bridge?.postMessage('fullscreen'));
document.addEventListener('keydown', event => {
  if (event.code === 'Space') { event.preventDefault(); bridge?.postMessage('play-pause'); }
});
window.addEventListener('pagehide', () => { worker?.terminate(); bitmap?.close(); });
void load(); requestAnimationFrame(frame);
