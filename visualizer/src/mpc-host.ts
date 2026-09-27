import { PcmNormalizer, AudioHold, type SourcePcm } from './mpc-audio-stream.ts';
import { AvsAudioAnalyser } from './avs/audio.ts';
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
const status = document.querySelector<HTMLElement>('#status')!;
const catalog = await fetchLocalAvsCatalog().catch(error => {
  label.textContent = 'Visualizer unavailable: preset collection could not be loaded.';
  status.textContent = String(error);
  const retry = document.createElement('button');
  retry.id = 'retry'; retry.textContent = 'Retry visualizer';
  retry.addEventListener('click', () => window.location.reload());
  document.body.append(retry); document.body.classList.add('bootstrap-error');
  retry.focus(); bridge?.postMessage('bootstrap-error'); throw error;
});
const presets = new PresetNavigation(catalog.length), director = new MpcAutoDirector(), flash = new FlashGate('limit');
const composite = document.createElement('canvas'), cc = composite.getContext('2d', { alpha: false })!;
const normalizer = new PcmNormalizer(), analyser = new AvsAudioAnalyser();
interface Slot { audio: AudioHold; worker: Worker; generation: number; index: number; busy: boolean; ready: boolean; bitmap: ImageBitmap | null; timeout: number; dead: boolean }
let active: Slot | null = null, prepared: Slot | null = null, outgoing: Slot | null = null;
let retryAfter = 0;
let loading = false, ticket = 0, generation = 0, sequence = 0, autoPending = false;
let hostVisible = true;
let playing = false, epoch = -1, lastAudio = 0, position = 0, pcm = new Float32Array(1152);
let announceTimer = 0, transitionMode = 1, durationBeats = 0, keepOld = true;
let manualFade = true, autoFade = true, durationMs = 2000;
let dirty = true, closed = false, lastPresentedPosition = -1;
let transition: AvsTransition | null = null, transitionStart = 0, transitionDuration = 2;
const failed = new Set<number>();
function announce(text: string) {
  status.textContent = text; document.body.classList.add('announce'); clearTimeout(announceTimer);
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
  const request: AvsWorkerRequest = { type: 'render', generation: slot.generation, sequence: ++sequence, pcm: data, audio: slot.audio.consume(), width, height };
  slot.worker.postMessage(request, [data]);
  slot.timeout = window.setTimeout(() => fail(slot, 'Preset render timed out'), 5000);
}
function fail(slot: Slot, reason: string) {
  if (slot.dead) return;
  failed.add(slot.index); retryAfter = performance.now() + 1000; dispose(slot);
  if (slot === prepared) { prepared = null; loading = false; presets.cancel(); }
  if (slot === outgoing) { outgoing = null; transition = null; }
  if (slot === active) {
    active = outgoing; outgoing = null; transition = null;
    if (active) presets.select(active.index);
  }
  dirty = true;
  announce(`${catalog[slot.index]!.name}: ${reason}; ${active ? 'keeping current preset' : 'choose another preset'}`);
  if (!active) bridge?.postMessage('error');
}
function commit() {
  if (!prepared?.bitmap) return;
  const fade = autoPending ? autoFade : manualFade && playing;
  dispose(outgoing); outgoing = active; active = prepared; prepared = null; loading = false;
  presets.select(active.index); autoPending = false; director.rearm();
  transition = outgoing ? new AvsTransition(transitionMode) : null;
  transitionStart = position;
  transitionDuration = durationBeats && director.tempo.locked ? durationBeats * 60 / director.tempo.bpm : durationMs / 1000;
  if (!fade || transitionMode === 15) { dispose(outgoing); outgoing = null; transition = null; }
  label.textContent = `${active.index + 1} / ${catalog.length} · ${catalog[active.index]!.name}`;
  dirty = true; announce(`Preset ready: ${catalog[active.index]!.name}`);
  bridge?.postMessage('ready');
}
async function prepare(index: number, automatic: boolean) {
  cancelPrepared(); dispose(outgoing); outgoing = null; transition = null; const current = ticket; loading = true; autoPending = automatic; dirty = true;
  announce(`Loading preset: ${catalog[index]!.name}...`);
  try {
    const preset = catalog[index]!;
    let fetchTimer = 0;
    const [bytes, bitmaps] = await Promise.race([
      Promise.all([fetchLocalAvsPreset(preset), loadPresetBitmaps(preset.sha256)]),
      new Promise<never>((_, reject) => { fetchTimer = window.setTimeout(() => reject(new Error('Preset fetch timed out')), 15000); }),
    ]).finally(() => clearTimeout(fetchTimer));
    if (current !== ticket) return;
    const worker = new Worker(new URL('./avs-render.worker.js', import.meta.url), { type: 'module' });
    const slot: Slot = { audio: new AudioHold(), worker, generation: ++generation, index, busy: false, ready: false, bitmap: null, timeout: 0, dead: false };
    prepared = slot;
    slot.timeout = window.setTimeout(() => fail(slot, 'Preset initialization timed out'), 15000);
    worker.onerror = event => fail(slot, event.message);
    worker.onmessage = (event: MessageEvent<AvsWorkerResponse>) => {
      const message = event.data;
      if (slot.dead) { if (message.type === 'frame') message.bitmap.close(); return; }
      if (message.type === 'ready') { clearTimeout(slot.timeout); slot.ready = true; if (!active) bridge?.postMessage('ready'); render(slot); }
      if (message.type === 'error') fail(slot, message.message || 'Preset failed');
      if (message.type === 'frame') {
        clearTimeout(slot.timeout); slot.busy = false; slot.bitmap?.close(); slot.bitmap = message.bitmap; dirty = true;
        if (slot === prepared && !autoPending) commit();
      }
    };
    const request: AvsWorkerRequest = { type: 'load', generation: slot.generation, preset: bytes.buffer as ArrayBuffer, bitmaps, width: 640, height: 360, gpuLane: 'exact' };
    worker.postMessage(request, [request.preset]);
  } catch (error) {
    if (current !== ticket) return;
    loading = false; presets.cancel(); retryAfter = performance.now() + 1000; failed.add(index); announce(`Preset unavailable: ${String(error)}`);
    if (!active) bridge?.postMessage('error');
  }
}
function candidate(): number | null {
  const start = presets.shuffle ? Math.floor(Math.random() * catalog.length) : (presets.index + 1) % catalog.length;
  for (let n = 0; n < catalog.length; n++) { const index = (start + n) % catalog.length; if (index !== presets.index && !failed.has(index) && catalog[index]!.autoEligible) return index; }
  return null;
}
bridge?.addEventListener('message', event => {
  if (closed) return;
  const message = event.data;
  if (!message || typeof message !== 'object') return;
  if (message.type === 'audio') {
    playing = message.playing === true;
    hostVisible = message.visible !== false;
    if (Array.isArray(message.pcm) && message.pcm.length === 1152) {
      pcm = Float32Array.from(message.pcm, x => typeof x === 'number' && Number.isFinite(x) ? Math.max(-1, Math.min(1, x)) : 0);
      lastAudio = performance.now();
    }
    if (Number.isFinite(message.position)) {
      const seek = epoch !== -1 && (epoch !== message.epoch || message.position < position || message.position - position > .75);
      epoch = message.epoch;
      position = message.position;
      if (seek) { epoch = message.epoch; director.reset(); normalizer.reset(); analyser.reset(); active?.audio.reset(); outgoing?.audio.reset(); cancelPrepared(); presets.cancel(); dirty = true; dispose(outgoing); outgoing = null; transition = null; if (!active) void prepare(presets.index, false); }
      const frames = Array.isArray(message.frames) ? message.frames.slice(0, 64).filter((frame: {time?: number; pcm?: unknown[]}) => Number.isFinite(frame?.time) && frame.time! <= position && Array.isArray(frame.pcm) && frame.pcm.length === 1152).map((frame: {time: number; pcm: unknown[]; sampleRate?: number; samples?: number}) => ({ time: frame.time, sampleRate: frame.sampleRate, samples: frame.samples, pcm: Float32Array.from(frame.pcm, x => typeof x === 'number' && Number.isFinite(x) ? Math.max(-1, Math.min(1, x)) : 0) })) : undefined;
      if (message.discontinuity === true) { normalizer.reset(); analyser.reset(); active?.audio.reset(); outgoing?.audio.reset(); prepared?.audio.reset(); }
      const normalized = playing ? frames?.flatMap((frame: SourcePcm) => normalizer.push(frame)) : [];
      for (const frame of normalized ?? (playing ? [{ time:position, pcm }] : [])) {
        const audio = analyser.analyse({left:frame.pcm.subarray(0,576),right:frame.pcm.subarray(576)});
        active?.audio.push(audio); outgoing?.audio.push(audio); prepared?.audio.push(audio);
      }
      const action = director.update(position, playing, pcm, normalized, message.discontinuity === true);
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
    if (typeof message.shuffle === 'boolean' && presets.shuffle !== message.shuffle) { presets.shuffle = message.shuffle; if (autoPending) cancelPrepared(); }
    manualFade = message.manualFade !== false; autoFade = message.autoFade !== false;
    durationMs = Number.isFinite(message.durationMs) ? Math.max(250, Math.min(80000, message.durationMs)) : 2000;
    director.configure(message.enabled === true, Number(message.bars));
    transitionMode = Number.isInteger(message.transition) && message.transition >= 0 && message.transition <= 15 ? message.transition : 1;
    durationBeats = [1, 2, 4].includes(message.beats) ? message.beats : 0;
    keepOld = message.keepOld !== false;
    if (!director.enabled && autoPending) cancelPrepared();
    announce(`Auto ${director.enabled ? (director.bars ? `${director.bars} bars` : 'adaptive 2–12 bars') : 'off'} · ${TRANSITIONS[transitionMode]}`);
  }
});
function frame(now: number) {
  if (closed) return;
  if (!flash.available) { status.textContent = 'Visualizer paused: flash protection unavailable'; document.body.classList.add('protection-error'); }
  const bars = director.remainingBars;
  timing.textContent = !director.enabled ? 'Auto off' : !playing ? 'Auto paused' : !director.tempo.locked ? (director.energy < .001 ? 'Auto · waiting for audio signal' : 'Auto · listening for tempo') : `${Math.round(director.tempo.bpm)} BPM · ${bars === null ? 'waiting for music' : `${bars} bars`} ${prepared?.bitmap ? '· ready' : loading ? '· preparing' : ''}`;
  const fresh = playing && now - lastAudio < 500;
  const visible = hostVisible && !document.hidden;
  const scale = Math.min(devicePixelRatio || 1, 1920 / Math.max(1, canvas.clientWidth), 1080 / Math.max(1, canvas.clientHeight));
  const cw = Math.max(1, Math.round(canvas.clientWidth * scale)), ch = Math.max(1, Math.round(canvas.clientHeight * scale));
  const resized = canvas.width !== cw || canvas.height !== ch;
  if (visible && active?.bitmap && (dirty || resized || (transition && position !== lastPresentedPosition))) {
    const w = active.bitmap.width, h = active.bitmap.height;
    if (composite.width !== w || composite.height !== h) { composite.width = w; composite.height = h; }
    if (transition && outgoing?.bitmap) {
      const t = Math.max(0, (position - transitionStart) / transitionDuration);
      transition.draw(cc, outgoing.bitmap, active.bitmap, t, w, h);
      if (t >= 1) { dispose(outgoing); outgoing = null; transition = null; }
    } else cc.drawImage(active.bitmap, 0, 0, w, h);
    if (canvas.width !== cw || canvas.height !== ch) { canvas.width = cw; canvas.height = ch; flash.reset(); }
    context.imageSmoothingEnabled = false;
    flash.present(context, composite, now / 1000, () => context.drawImage(composite, 0, 0, cw, ch));
    dirty = false; lastPresentedPosition = position;
    if (!flash.available) { status.textContent = 'Visualizer paused: flash protection unavailable'; document.body.classList.add('protection-error'); }
    else document.body.classList.remove('protection-error');
  }
  if (fresh && director.enabled && !active && !loading && !prepared && now >= retryAfter) { const index = candidate(); if (index !== null) void prepare(index, false); }
  if (fresh && visible) { if (active) render(active); if (outgoing && keepOld) render(outgoing); }
  requestAnimationFrame(frame);
}
document.addEventListener('dblclick', () => bridge?.postMessage('fullscreen'));
document.addEventListener('keydown', event => { if (event.code === 'F10' && event.shiftKey || event.code === 'ContextMenu') { event.preventDefault(); bridge?.postMessage('options'); return; } if (event.code === 'Space' && !event.repeat) { event.preventDefault(); bridge?.postMessage('play-pause'); } });
window.addEventListener('pagehide', () => { closed = true; clearTimeout(announceTimer); cancelPrepared(); dispose(active); dispose(outgoing); });
bridge?.postMessage('host-ready');
void prepare(0, false); requestAnimationFrame(frame);
