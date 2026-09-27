import { fetchLocalAvsCatalog, fetchLocalAvsPreset } from './avs/local-collection.ts';
import type { AvsWorkerRequest, AvsWorkerResponse } from './avs-worker-protocol.ts';
import { FlashGate } from './flash-gate.ts';
import { PresetNavigation } from './mpc-preset-navigation.ts';
import { loadPresetBitmaps } from './mpc-bitmap-dependencies.ts';
import { MpcAutoDirector } from './mpc-auto-director.ts';
import { AvsTransition, TRANSITIONS } from './mpc-transition.ts';
interface Bridge { postMessage(message: string): void; addEventListener(type: 'message', listener: (event: MessageEvent) => void): void }
const bridge = (window as unknown as { chrome?: { webview?: Bridge } }).chrome?.webview;
const canvas = document.querySelector<HTMLCanvasElement>('#visualizer')!;
const context = canvas.getContext('2d', { alpha: false })!;
const timing = document.querySelector<HTMLElement>('#timing')!;
const label = document.querySelector<HTMLElement>('#preset')!;
const catalog = await fetchLocalAvsCatalog().catch(error => {
  label.textContent = `Full preset collection unavailable: ${String(error)}`;
  document.body.classList.add('announce'); bridge?.postMessage('error'); throw error;
});
const presets = new PresetNavigation(catalog.length), director = new MpcAutoDirector(), flash = new FlashGate('limit');
const composite = document.createElement('canvas'), cc = composite.getContext('2d', { alpha: false })!;
interface Slot { worker: Worker; generation: number; index: number; busy: boolean; ready: boolean; bitmap: ImageBitmap | null; timeout: number; dead: boolean }
let active: Slot | null = null, prepared: Slot | null = null, outgoing: Slot | null = null;
let retryAfter = 0;
let loading = false, ticket = 0, generation = 0, sequence = 0, autoPending = false;
let playing = false, epoch = -1, lastAudio = 0, position = 0, pcm = new Float32Array(1152);
let announceTimer = 0, transitionMode = 1, durationBeats = 0, keepOld = true;
let transition: AvsTransition | null = null, transitionStart = 0, transitionDuration = 2;
const failed = new Set<number>();
function announce(text: string) {
  label.textContent = text; document.body.classList.add('announce'); clearTimeout(announceTimer);
  announceTimer = window.setTimeout(() => document.body.classList.remove('announce'), 3500);
}
function dispose(slot: Slot | null) {
  if (!slot) return; slot.dead = true; clearTimeout(slot.timeout); slot.worker.terminate(); slot.bitmap?.close(); slot.bitmap = null;
}
function cancelPrepared() { ticket++; loading = false; dispose(prepared); prepared = null; autoPending = false; }
function render(slot: Slot) {
  if (slot.dead || slot.busy || !slot.ready) return;
  slot.busy = true;
  const data = pcm.slice().buffer;
  const width = 640, height = Math.max(64, Math.min(640, Math.round(width * canvas.clientHeight / Math.max(1, canvas.clientWidth))));
  const request: AvsWorkerRequest = { type: 'render', generation: slot.generation, sequence: ++sequence, pcm: data, width, height };
  slot.worker.postMessage(request, [data]);
  slot.timeout = window.setTimeout(() => fail(slot, 'Preset render timed out'), 5000);
}
function fail(slot: Slot, reason: string) {
  if (slot.dead) return;
  failed.add(slot.index); retryAfter = performance.now() + 1000; dispose(slot);
  if (slot === prepared) { prepared = null; loading = false; }
  if (slot === outgoing) { outgoing = null; transition = null; }
  if (slot === active) {
    active = outgoing; outgoing = null; transition = null;
    if (active) presets.select(active.index);
  }
  announce(`${catalog[slot.index]!.name}: ${reason}; ${active ? 'keeping current preset' : 'choose another preset'}`);
  if (!active) bridge?.postMessage('error');
}
function commit() {
  if (!prepared?.bitmap) return;
  dispose(outgoing); outgoing = active; active = prepared; prepared = null; loading = false;
  presets.select(active.index); autoPending = false; director.rearm();
  transition = outgoing ? new AvsTransition(transitionMode) : null;
  transitionStart = position;
  transitionDuration = durationBeats && director.tempo.locked ? durationBeats * 60 / director.tempo.bpm : 2;
  if (transitionMode === 15) { dispose(outgoing); outgoing = null; transition = null; }
  announce(`${active.index + 1} / ${catalog.length} · ${catalog[active.index]!.name}`);
  bridge?.postMessage('ready');
}
async function prepare(index: number, automatic: boolean) {
  cancelPrepared(); dispose(outgoing); outgoing = null; transition = null; const current = ticket; loading = true; autoPending = automatic;
  try {
    const preset = catalog[index]!;
    let fetchTimer = 0;
    const [bytes, bitmaps] = await Promise.race([
      Promise.all([fetchLocalAvsPreset(preset), loadPresetBitmaps(preset.sha256)]),
      new Promise<never>((_, reject) => { fetchTimer = window.setTimeout(() => reject(new Error('Preset fetch timed out')), 15000); }),
    ]).finally(() => clearTimeout(fetchTimer));
    if (current !== ticket) return;
    const worker = new Worker(new URL('./avs-render.worker.js', import.meta.url), { type: 'module' });
    const slot: Slot = { worker, generation: ++generation, index, busy: false, ready: false, bitmap: null, timeout: 0, dead: false };
    prepared = slot;
    slot.timeout = window.setTimeout(() => fail(slot, 'Preset initialization timed out'), 15000);
    worker.onerror = event => fail(slot, event.message);
    worker.onmessage = (event: MessageEvent<AvsWorkerResponse>) => {
      const message = event.data;
      if (slot.dead) { if (message.type === 'frame') message.bitmap.close(); return; }
      if (message.type === 'ready') { clearTimeout(slot.timeout); slot.ready = true; if (!active) bridge?.postMessage('ready'); render(slot); }
      if (message.type === 'error') fail(slot, message.message || 'Preset failed');
      if (message.type === 'frame') {
        clearTimeout(slot.timeout); slot.busy = false; slot.bitmap?.close(); slot.bitmap = message.bitmap;
        if (slot === prepared && !autoPending) commit();
      }
    };
    const request: AvsWorkerRequest = { type: 'load', generation: slot.generation, preset: bytes.buffer as ArrayBuffer, bitmaps, width: 640, height: 360, gpuLane: 'exact' };
    worker.postMessage(request, [request.preset]);
  } catch (error) {
    if (current !== ticket) return;
    loading = false; retryAfter = performance.now() + 1000; failed.add(index); announce(`Preset unavailable: ${String(error)}`);
    if (!active) bridge?.postMessage('error');
  }
}
function candidate(): number | null {
  const start = presets.shuffle ? Math.floor(Math.random() * catalog.length) : (presets.index + 1) % catalog.length;
  for (let n = 0; n < catalog.length; n++) { const index = (start + n) % catalog.length; if (index !== presets.index && !failed.has(index) && catalog[index]!.autoEligible) return index; }
  return null;
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
    if (Number.isFinite(message.position)) {
      const seek = epoch !== -1 && (epoch !== message.epoch || message.position < position || message.position - position > .75);
      epoch = message.epoch;
      position = message.position;
      if (seek) { epoch = message.epoch; director.reset(); cancelPrepared(); dispose(outgoing); outgoing = null; transition = null; if (!active) void prepare(presets.index, false); }
      const action = director.update(position, playing, pcm);
      if (active && !outgoing && action.prepare && !loading && !prepared) { const index = candidate(); if (index !== null) void prepare(index, true); }
      if (autoPending && action.switch && prepared?.bitmap) commit();
    }
    bridge.postMessage('ack');
  } else if (message.type === 'next' || message.type === 'previous') {
    director.rearm(); const index = message.type === 'next' ? presets.next() : presets.previous(); void prepare(index, false);
  } else if (message.type === 'shuffle') {
    presets.shuffle = message.enabled === true; if (autoPending) cancelPrepared();
    announce(`Preset shuffle ${presets.shuffle ? 'on' : 'off'}`);
  } else if (message.type === 'settings') {
    director.configure(message.enabled === true, Number(message.bars));
    transitionMode = Number.isInteger(message.transition) && message.transition >= 0 && message.transition <= 15 ? message.transition : 1;
    durationBeats = [1, 2, 4].includes(message.beats) ? message.beats : 0;
    keepOld = message.keepOld !== false;
    if (!director.enabled && autoPending) cancelPrepared();
    announce(`Auto ${director.enabled ? (director.bars ? `${director.bars} bars` : 'adaptive 2–12 bars') : 'off'} · ${TRANSITIONS[transitionMode]}`);
  }
});
function frame(now: number) {
  const bars = director.remainingBars;
  timing.textContent = !director.enabled ? 'Auto off' : !playing ? 'Auto paused' : !director.tempo.locked ? (director.energy < .001 ? 'Auto · waiting for audio signal' : 'Auto · listening for tempo') : `${Math.round(director.tempo.bpm)} BPM · ${bars === null ? 'waiting for music' : `${bars} bars`} ${prepared ? '· ready' : loading ? '· preparing' : ''}`;
  const fresh = playing && now - lastAudio < 500;
  if (active?.bitmap) {
    const w = active.bitmap.width, h = active.bitmap.height;
    if (composite.width !== w || composite.height !== h) { composite.width = w; composite.height = h; }
    if (transition && outgoing?.bitmap) {
      const t = Math.max(0, (position - transitionStart) / transitionDuration);
      transition.draw(cc, outgoing.bitmap, active.bitmap, t, w, h);
      if (t >= 1) { dispose(outgoing); outgoing = null; transition = null; }
    } else cc.drawImage(active.bitmap, 0, 0, w, h);
    const cw = Math.max(1, Math.round(canvas.clientWidth * devicePixelRatio)), ch = Math.max(1, Math.round(canvas.clientHeight * devicePixelRatio));
    if (canvas.width !== cw || canvas.height !== ch) { canvas.width = cw; canvas.height = ch; flash.reset(); }
    context.imageSmoothingEnabled = false;
    flash.present(context, composite, now / 1000, () => context.drawImage(composite, 0, 0, cw, ch));
  }
  if (fresh && director.enabled && !active && !loading && !prepared && now >= retryAfter) { const index = candidate(); if (index !== null) void prepare(index, false); }
  if (fresh) { if (active) render(active); if (outgoing && keepOld) render(outgoing); }
  requestAnimationFrame(frame);
}
document.addEventListener('dblclick', () => bridge?.postMessage('fullscreen'));
document.addEventListener('keydown', event => { if (event.code === 'Space') { event.preventDefault(); bridge?.postMessage('play-pause'); } });
window.addEventListener('pagehide', () => { cancelPrepared(); dispose(active); dispose(outgoing); });
bridge?.postMessage('host-ready');
void prepare(0, false); requestAnimationFrame(frame);
