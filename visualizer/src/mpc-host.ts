import { PcmNormalizer, AudioHold, type SourcePcm } from './mpc-audio-stream.ts';
import { AvsAudioAnalyser } from './avs/audio.ts';
import { fetchLocalAvsCatalog, fetchLocalAvsPreset } from './avs/local-collection.ts';
import type { AvsWorkerRequest, AvsWorkerResponse } from './avs-worker-protocol.ts';
import { FlashGate } from './flash-gate.ts';
import { PresetNavigation } from './mpc-preset-navigation.ts';
import { loadPresetBitmaps } from './mpc-bitmap-dependencies.ts';
import { MpcAutoDirector } from './mpc-auto-director.ts';
import { AvsTransition, TRANSITIONS } from './mpc-transition.ts';
import { PresetManagement } from './mpc-management.ts';
import { setupIndices, stepSetup, type PresetSetup } from './mpc-setups.ts';
import { localAssetUrl } from './avs/local-assets.ts';
import { defaultSceneTiming, parseSceneTiming, sceneAt, type SceneTiming } from './mpc-scene-clock.ts';
import { NERV_SCENES } from './nerv-scenes.ts';
import type { AvsAudioFrame } from './avs/types.ts';
interface Bridge { postMessage(message: string): void; addEventListener(type: 'message', listener: (event: MessageEvent) => void): void }
const bridge = (window as unknown as { chrome?: { webview?: Bridge } }).chrome?.webview;
const canvas = document.querySelector<HTMLCanvasElement>('#visualizer')!;
const context = canvas.getContext('2d', { alpha: false })!;
const timing = document.querySelector<HTMLElement>('#timing')!;
const label = document.querySelector<HTMLElement>('#preset')!;
const status = document.querySelector<HTMLElement>('#status')!;
let catalog = await fetchLocalAvsCatalog().catch(error => {
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
interface Slot { audio: AudioHold; worker: Worker; generation: number; index: number; busy: boolean; ready: boolean; bitmap: ImageBitmap | null; timeout: number; dead: boolean; start: number; renderRevision: number; renderedPosition: number; lastAudio:AvsAudioFrame }
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
let setupOrder:number[]|null=null;
let sceneTiming:SceneTiming={...defaultSceneTiming}, sequenceSuspended=false, clockRevision=0;
let pendingIndex:number|null=null;
let pendingClock=false;
const silence=():AvsAudioFrame=>({waveform:[new Uint8Array(576),new Uint8Array(576)],spectrum:[new Uint8Array(576),new Uint8Array(576)],beat:false,beatLevel:0});
let latestAudio=silence();
function clockPhase(){return director.enabled&&!sequenceSuspended&&setupOrder?sceneAt(position,setupOrder,sceneTiming,presets.shuffle):null;}
function manualSelection(index:number){
  sequenceSuspended=sceneTiming.enabled;clockRevision++;director.rearm();void prepare(index,false);
}
function syncSceneClock(){
  const phase=clockPhase();
  if(pendingClock&&(!phase||phase.index!==pendingIndex))cancelPrepared();
  if(!phase||management.open||!hostVisible||document.hidden)return;
  if(active?.index!==phase.index&&pendingIndex!==phase.index&&!failed.has(phase.index))void prepare(phase.index,false);
}
const ratings:{index:number;value:number}[]=[];
const sendLibrary=(value:unknown)=>bridge?.postMessage(`library:${JSON.stringify(value)}`);
function rate(index:number,value:number){
  if(!catalog[index])return;
  value=Math.max(1,Math.min(5,value));
  const previous=[...ratings].reverse().find(r=>r.index===index)?.value??catalog[index]!.rating??0;
  if(previous===value)return;
  ratings.push({index,value});
  if(ratings.length===1)sendLibrary({op:'rate',hash:catalog[index]!.sha256,rating:ratings[0]!.value});
}
function rateCurrent(delta:number){
  if(!active){announce('Load a preset before rating it.');return;}
  const index=active.index, pending=[...ratings].reverse().find(r=>r.index===index);
  rate(index,(pending?.value??catalog[index]!.rating??0)+delta);
}
function activateSetup(setup:PresetSetup|null){
  const order=setup?setupIndices(setup,catalog):null;
  const nextTiming=parseSceneTiming(setup?.timing);
  if(setup&&!order?.length)throw Error('Add at least one preset before activating this setup.');
  if(order?.some(i=>!catalog[i]!.autoEligible))throw Error('Remove unavailable presets before activating this setup.');
  setupOrder=order;sceneTiming=nextTiming;sequenceSuspended=false;clockRevision++;cancelPrepared();director.rearm();presets.cancel();
  if(setup){
    director.configure(setup.settings.enabled,setup.settings.bars);presets.shuffle=setup.settings.shuffle;
    transitionMode=setup.settings.transition;durationBeats=setup.settings.beats;durationMs=setup.settings.durationMs;
    keepOld=setup.settings.keepOld;manualFade=setup.settings.manualFade;autoFade=setup.settings.autoFade;
    sendLibrary({op:'configure',settings:setup.settings});
    if(order?.length)void prepare(clockPhase()?.index??order[0]!,false);
  }
}
const management=new PresetManagement({catalog:()=>catalog,current:()=>active?.index??presets.index,
  settings:()=>({enabled:director.enabled,bars:director.bars,shuffle:presets.shuffle,transition:transitionMode,beats:durationBeats,durationMs:Math.min(8000,durationMs),keepOld,manualFade,autoFade}),
  load:manualSelection,rate,send:sendLibrary,activate:activateSetup,
  nervSetup:()=>({id:'nerv-scene-set',name:'NERV · repeatable sequence',presets:NERV_SCENES.map(id=>catalog.find(p=>p.kind==='nerv'&&p.scene===id)?.sha256).filter((h):h is string=>!!h),
    settings:{enabled:true,bars:8,shuffle:false,transition:1,beats:2,durationMs:1000,keepOld:true,manualFade:true,autoFade:true},
    timing:{...defaultSceneTiming,enabled:true,bpm:director.tempo.locked?Math.round(director.tempo.bpm*100)/100:120}}),
  panel:mode=>bridge?.postMessage(`panel-state:${mode}`),close:()=>{bridge?.postMessage('panel-close');syncSceneClock();}});
function announce(text: string) {
  status.textContent = text; document.body.classList.add('announce'); clearTimeout(announceTimer);
  announceTimer = window.setTimeout(() => document.body.classList.remove('announce'), 3500);
}
function dispose(slot: Slot | null) {
  if (!slot) return; slot.dead = true; clearTimeout(slot.timeout); slot.worker.terminate(); slot.bitmap?.close(); slot.bitmap = null;
}
function cancelPrepared() { ticket++; loading = false; pendingIndex=null;pendingClock=false; dispose(prepared); prepared = null; autoPending = false; }
function render(slot: Slot) {
  if (slot.dead || slot.busy || !slot.ready) return;
  slot.busy = true;
  const data = pcm.slice().buffer;
  const width = 640, height = Math.max(64, Math.min(640, Math.round(width * canvas.clientHeight / Math.max(1, canvas.clientWidth))));
  const isNerv=catalog[slot.index]!.kind==='nerv';
  const phase=clockPhase(), clocked=phase?.index===slot.index?phase:null;
  const bpm=clocked?sceneTiming.bpm:director.tempo.locked?director.tempo.bpm:120;
  const localTime=clocked?clocked.localTime:Math.max(0,position-slot.start);
  const previous=clocked&&clocked.ordinal>0?catalog[clocked.previousIndex]?.scene:undefined;
  const fadeSeconds=clocked?Math.min(clocked.duration/4,durationBeats?durationBeats*60/bpm:durationMs/1000):0;
  const audio=isNerv&&!playing?slot.lastAudio:slot.audio.consume();slot.lastAudio=audio;
  const request: AvsWorkerRequest = { type: 'render', generation: slot.generation, sequence: ++sequence, pcm: data, audio, width, height,
    ...(isNerv?{nerv:{time:position,localTime,progress:clocked?.progress??((localTime*bpm/240)%8)/8,bpm,seed:sceneTiming.seed,
      ...(previous&&autoFade&&transitionMode!==15?{previousScene:previous,previousTime:keepOld?position:clocked!.start,previousLocalTime:clocked!.duration+(keepOld?localTime:0),blend:Math.min(1,localTime/fadeSeconds)}:{})}}:{}) };
  slot.renderRevision=clockRevision;slot.renderedPosition=position;
  slot.worker.postMessage(request, [data]);
  slot.timeout = window.setTimeout(() => fail(slot, 'Preset render timed out'), 5000);
}
function fail(slot: Slot, reason: string) {
  if (slot.dead) return;
  failed.add(slot.index); retryAfter = performance.now() + 1000; dispose(slot);
  if (slot === prepared) { prepared = null; loading = false; pendingIndex=null; presets.cancel(); }
  if (slot === outgoing) { outgoing = null; transition = null; }
  if (slot === active) {
    active = outgoing; outgoing = null; transition = null;
    if (active) presets.select(active.index);
  }
  dirty = true;
  announce(`${catalog[slot.index]!.name}: ${reason}; ${active ? 'keeping current preset' : 'choose another preset'}`);
  if (!active && !management.open) bridge?.postMessage('error');
}
function commit() {
  if (!prepared?.bitmap) return;
  if(pendingClock&&clockPhase()?.index!==prepared.index){cancelPrepared();return;}
  const fade = autoPending ? autoFade : manualFade && playing;
  dispose(outgoing); outgoing = active; active = prepared; prepared = null; loading = false; pendingIndex=null;pendingClock=false;
  presets.select(active.index); autoPending = false; director.rearm();
  transition = outgoing ? new AvsTransition(transitionMode) : null;
  transitionStart = position;
  transitionDuration = durationBeats && director.tempo.locked ? durationBeats * 60 / director.tempo.bpm : durationMs / 1000;
  if (!fade || transitionMode === 15 || clockPhase()?.index===active.index) { dispose(outgoing); outgoing = null; transition = null; }
  label.textContent = `${active.index + 1} / ${catalog.length} · ${catalog[active.index]!.name} ${'★'.repeat(catalog[active.index]!.rating??0)}`;
  management.refresh();
  dirty = true; announce(`Preset ready: ${catalog[active.index]!.name}`);
  bridge?.postMessage('ready');
}
async function prepare(index: number, automatic: boolean) {
  cancelPrepared(); dispose(outgoing); outgoing = null; transition = null; const current = ticket; loading = true; pendingIndex=index;pendingClock=clockPhase()?.index===index; autoPending = automatic; dirty = true;
  announce(`Loading preset: ${catalog[index]!.name}...`);
  try {
    const preset = catalog[index]!;
    let fetchTimer = 0;
    const [bytes, bitmaps] = await Promise.race([
      Promise.all([fetchLocalAvsPreset(preset), preset.kind==='nerv'?Promise.resolve([]):loadPresetBitmaps(preset.sha256)]),
      new Promise<never>((_, reject) => { fetchTimer = window.setTimeout(() => reject(new Error('Preset fetch timed out')), 15000); }),
    ]).finally(() => clearTimeout(fetchTimer));
    if (current !== ticket) return;
    const worker = new Worker(new URL(preset.kind==='nerv'?'./nerv-render.worker.js':'./avs-render.worker.js', import.meta.url), { type: 'module' });
    const slot: Slot = { audio: new AudioHold(), worker, generation: ++generation, index, busy: false, ready: false, bitmap: null, timeout: 0, dead: false, start:position,renderRevision:clockRevision,renderedPosition:NaN,lastAudio:latestAudio };
    slot.audio.push(latestAudio);
    prepared = slot;
    slot.timeout = window.setTimeout(() => fail(slot, 'Preset initialization timed out'), 15000);
    worker.onerror = event => fail(slot, event.message);
    worker.onmessage = (event: MessageEvent<AvsWorkerResponse>) => {
      const message = event.data;
      if (slot.dead) { if (message.type === 'frame') message.bitmap.close(); return; }
      if (message.type === 'ready') { clearTimeout(slot.timeout); slot.ready = true; if (!active) bridge?.postMessage('ready'); render(slot); }
      if (message.type === 'error') fail(slot, message.message || 'Preset failed');
      if (message.type === 'frame') {
        if(slot.renderRevision!==clockRevision&&preset.kind==='nerv'){clearTimeout(slot.timeout);slot.busy=false;message.bitmap.close();render(slot);return;}
        clearTimeout(slot.timeout); slot.busy = false; slot.bitmap?.close(); slot.bitmap = message.bitmap; dirty = true;
        if (slot === prepared && !autoPending) commit();
      }
    };
    const request: AvsWorkerRequest = { type: 'load', generation: slot.generation, preset: bytes.buffer as ArrayBuffer, bitmaps, width: 640, height: 360, gpuLane: 'exact' };
    worker.postMessage(request, [request.preset]);
  } catch (error) {
    if (current !== ticket) return;
    loading = false; pendingIndex=null; presets.cancel(); retryAfter = performance.now() + 1000; failed.add(index); announce(`Preset unavailable: ${String(error)}`);
    if (!active) bridge?.postMessage('error');
  }
}
function candidate(): number | null {
  if(setupOrder){
    const pool=setupOrder.filter(i=>!failed.has(i)&&catalog[i]!.autoEligible);
    return stepSetup(pool,presets.index,1,presets.shuffle);
  }
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
      if (seek) { epoch = message.epoch; clockRevision++;latestAudio=silence();if(active)active.lastAudio=silence();director.reset(); normalizer.reset(); analyser.reset(); active?.audio.reset(); outgoing?.audio.reset(); cancelPrepared(); presets.cancel(); dirty = true; dispose(outgoing); outgoing = null; transition = null; if (!active&&!clockPhase()) void prepare(presets.index, false); }
      const frames = Array.isArray(message.frames) ? message.frames.slice(0, 64).filter((frame: {time?: number; pcm?: unknown[]}) => Number.isFinite(frame?.time) && frame.time! <= position && Array.isArray(frame.pcm) && frame.pcm.length === 1152).map((frame: {time: number; pcm: unknown[]; sampleRate?: number; samples?: number}) => ({ time: frame.time, sampleRate: frame.sampleRate, samples: frame.samples, pcm: Float32Array.from(frame.pcm, x => typeof x === 'number' && Number.isFinite(x) ? Math.max(-1, Math.min(1, x)) : 0) })) : undefined;
      if (message.discontinuity === true) { latestAudio=silence();normalizer.reset(); analyser.reset(); active?.audio.reset(); outgoing?.audio.reset(); prepared?.audio.reset(); }
      const normalized = playing ? frames?.flatMap((frame: SourcePcm) => normalizer.push(frame)) : [];
      for (const frame of normalized ?? (playing ? [{ time:position, pcm }] : [])) {
        const audio = analyser.analyse({left:frame.pcm.subarray(0,576),right:frame.pcm.subarray(576)});
        latestAudio=audio;
        active?.audio.push(audio); outgoing?.audio.push(audio); prepared?.audio.push(audio);
      }
      const action = director.update(position, playing, pcm, normalized, message.discontinuity === true);
      if (!sceneTiming.enabled&&!management.open && active && !outgoing && action.prepare && !loading && !prepared) { const index = candidate(); if (index !== null) void prepare(index, true); }
      if (!sceneTiming.enabled&&!management.open && autoPending && action.switch && prepared?.bitmap) commit();
      syncSceneClock();
    }
    bridge.postMessage('ack');
  } else if(message.type==='panel') {management.show(message.panel===1||message.panel===2?message.panel:0);
  } else if(message.type==='rate') {rateCurrent(message.delta===1?1:-1);
  } else if(message.type==='rating-saved') {
    const request=ratings.shift(),entry=message.entry;
    if(request&&entry?.sha256===catalog[request.index]?.sha256&&typeof entry.canonical_path==='string'&&Number.isInteger(entry.rating)&&entry.rating>=1&&entry.rating<=5){
      const old=catalog[request.index]!;
      catalog=catalog.map((p,i)=>i===request.index?{...old,rating:entry.rating,fileName:entry.canonical_path.split('/').at(-1),url:localAssetUrl(entry.canonical_path,'presets',document.baseURI)}:p);
      if(active?.index===request.index)label.textContent=`${active.index+1} / ${catalog.length} · ${old.name} ${'★'.repeat(entry.rating)}`;
      announce(`${old.name} · ${'★'.repeat(entry.rating)} · filename and Date modified saved`);management.refresh();
    }
    if(ratings.length)sendLibrary({op:'rate',hash:catalog[ratings[0]!.index]!.sha256,rating:ratings[0]!.value});
  } else if(message.type==='setups-loaded'||message.type==='setups-saved') {management.receive(message.type,message.setups);
  } else if(message.type==='library-error') {if(message.operation==='rate')ratings.length=0;announce(`Library: ${message.message}`);management.receive(message.type,message.message,message.operation);
  } else if (message.type === 'next' || message.type === 'previous') {
    const index = message.type === 'next' ? (setupOrder?candidate():presets.next()) : (setupOrder?stepSetup(setupOrder,presets.index,-1,false):presets.previous()); if(index!==null)manualSelection(index);
  } else if (message.type === 'shuffle') {
    presets.shuffle = message.enabled === true; if (autoPending) cancelPrepared();
    clockRevision++;syncSceneClock();
    announce(`Preset shuffle ${presets.shuffle ? 'on' : 'off'}`);
  } else if (message.type === 'settings') {
    if (typeof message.shuffle === 'boolean' && presets.shuffle !== message.shuffle) { presets.shuffle = message.shuffle; if (autoPending) cancelPrepared(); }
    manualFade = message.manualFade !== false; autoFade = message.autoFade !== false;
    durationMs = Number.isFinite(message.durationMs) ? Math.max(250, Math.min(80000, message.durationMs)) : 2000;
    if(message.enabled===true&&!director.enabled)sequenceSuspended=false;
    director.configure(message.enabled === true, Number(message.bars));
    transitionMode = Number.isInteger(message.transition) && message.transition >= 0 && message.transition <= 15 ? message.transition : 1;
    durationBeats = [1, 2, 4].includes(message.beats) ? message.beats : 0;
    keepOld = message.keepOld !== false;
    clockRevision++;syncSceneClock();
    if (!director.enabled && autoPending) cancelPrepared();
    announce(`Auto ${director.enabled ? (director.bars ? `${director.bars} bars` : 'adaptive 2–12 bars') : 'off'} · ${TRANSITIONS[transitionMode]}`);
  }
});
function frame(now: number) {
  if (closed) return;
  if (!flash.available) { status.textContent = 'Visualizer paused: flash protection unavailable'; document.body.classList.add('protection-error'); }
  const bars = director.remainingBars;
  const phase=clockPhase();
  timing.textContent = phase?`Scene clock · ${sceneTiming.bpm} BPM · ${Math.ceil((phase.duration-phase.localTime)*sceneTiming.bpm/240)} bars · ${playing?'playing':'paused'}`:sceneTiming.enabled&&sequenceSuspended?'Scene clock held · activate setup or toggle Auto off/on to resume':!director.enabled ? 'Auto off' : !playing ? 'Auto paused' : !director.tempo.locked ? (director.energy < .001 ? 'Auto · waiting for audio signal' : 'Auto · listening for tempo') : `${Math.round(director.tempo.bpm)} BPM · ${bars === null ? 'waiting for music' : `${bars} bars`} ${prepared?.bitmap ? '· ready' : loading ? '· preparing' : ''}`;
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
  if (fresh && director.enabled && !active && !loading && !prepared && now >= retryAfter&&!phase) { const index = candidate(); if (index !== null) void prepare(index, false); }
  if (fresh && visible) { if (active) render(active); if (outgoing && keepOld) render(outgoing); }
  // Paused seeks still update deterministic geometry without advancing an animation clock.
  else if(visible&&active&&catalog[active.index]?.kind==='nerv'&&(active.renderedPosition!==position||active.renderRevision!==clockRevision))render(active);
  requestAnimationFrame(frame);
}
document.addEventListener('dblclick', () => {if(!management.open)bridge?.postMessage('fullscreen');});
document.addEventListener('keydown', event => {
  if(event.ctrlKey&&!event.altKey&&!event.shiftKey){const command=({F6:'show-manager',F7:'show-setups'} as Record<string,string>)[event.code];if(command){event.preventDefault();if(!event.repeat)bridge?.postMessage(command);return;}}
  if(!event.ctrlKey&&!event.altKey&&!event.shiftKey&&(event.code==='F6'||event.code==='F7')){event.preventDefault();if(!event.repeat)bridge?.postMessage(event.code==='F7'?'rate-up':'rate-down');return;}
  if(management.open){if(event.code==='Escape'){event.preventDefault();management.show(0);bridge?.postMessage('panel-close');}return;}
  if (event.code === 'F10' && event.shiftKey || event.code === 'ContextMenu') { event.preventDefault(); bridge?.postMessage('options'); return; } if (event.code === 'Space' && !event.repeat) { event.preventDefault(); bridge?.postMessage('play-pause'); }
});
window.addEventListener('pagehide', () => { closed = true; clearTimeout(announceTimer); cancelPrepared(); dispose(active); dispose(outgoing); });
bridge?.postMessage('host-ready');
void prepare(0, false); requestAnimationFrame(frame);
