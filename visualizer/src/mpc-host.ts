import { AUDIO_DURATION_MAX } from './mpc-contract.ts';
import { PcmNormalizer, AudioHold, type SourcePcm } from './mpc-audio-stream.ts';
import { AvsAudioAnalyser } from './avs/audio.ts';
import { fetchLocalAvsCatalog, fetchLocalAvsPreset } from './avs/local-collection.ts';
import type { AvsWorkerRequest, AvsWorkerResponse } from './avs-worker-protocol.ts';
import { FlashGate, canvasProbeSampler } from './flash-gate.ts';
import { RenderSizer, SurfacePresenter, sizeCanvas, watchDeviceBox } from './render-sizer.ts';
import { mergePrefs, parseDisplayPrefs, prefsToWire, type DisplayPrefs } from './mpc-display.ts';
import { describeResolved, transitionSurface, type RenderKind } from './render-resolution.ts';
import { PresetNavigation } from './mpc-preset-navigation.ts';
import { loadPresetBitmaps } from './mpc-bitmap-dependencies.ts';
import { MpcAutoDirector } from './mpc-auto-director.ts';
import { AvsTransition, TRANSITIONS, TRANSITION_CUT, bands16, hash32, transitionLevel, type TransitionEnv } from './mpc-transition.ts';
import { QUEUE_QUANTIZE_COUNT, TRANSITION_COUNT } from './mpc-contract.ts';
import { PresetManagement } from './mpc-management.ts';
import { parseSettings, setupIndices, stepSetup, fadeSpecOf, configureSettings, settingsWithFade, type PresetSetup } from './mpc-setups.ts';
import { localAssetUrl } from './avs/local-assets.ts';
import { defaultSceneTiming, parseSceneTiming, compileSceneClock, scheduleSceneCue, type ClockFrame, type SceneClock, type SceneTiming, type ScenePhase, type SessionSceneCue } from './mpc-scene-clock.ts';
import { FpsMeter } from './fps-meter.ts';
import { PerfRecorder, epochNow, parsePerfMode, validateWorkerPerf } from './perf-trace.ts';
import { FpsLabel, timingLabel } from './timing-label.ts';
import { boundaryLevel, defaultFadeSpec, parseFadeFields, pickFade, planFade, type FadeSpec } from './mpc-transition-timing.ts';
import { NERV_SCENES } from './nerv-scenes.ts';
import { HudFeed, buildHudFrame, hudTraits, hudSetup, isSceneKind, sceneWorkerLocation } from './hud/hud-host.ts';
import { eligiblePresets } from './mpc-preset-eligibility.ts';
import { PoolCache, sanitizeOrder, overlayText, type FolderPlayPlan, type PlaySource } from './mpc-folder-play.ts';
import { fetchLocalCategories, type TaxonMap } from './avs/preset-categories.ts';
import * as collectionApi from './avs/local-collection.ts';
import type { AvsAudioFrame } from './avs/types.ts';
import { MultiViewSession } from './multi-view-session.ts';
import { isInteractiveTarget } from './keyboard-guard.ts';
import { bridgeLibraryCall, createHostSongMap } from './song-map/host.ts';
import type { SongMapSession } from './song-map/session.ts';
interface Bridge { postMessage(message: string): void; addEventListener(type: 'message', listener: (event: MessageEvent) => void): void }
// Both players run this host. Only media transport and library persistence vary.
const platform = window as unknown as { chrome?: { webview?: Bridge }; aaavsBridge?: Bridge; aaavsSongMap?: SongMapSession | null };
const bridge = platform.chrome?.webview ?? platform.aaavsBridge;
// One song map per page: the standalone Player publishes its own (full-file scan); the MPC host builds one from the PCM it receives.
const songMap = platform.aaavsSongMap !== undefined ? platform.aaavsSongMap : (platform.aaavsSongMap = createHostSongMap({ call: bridge ? bridgeLibraryCall(bridge) : null, now: () => performance.now() }));
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
const presets = new PresetNavigation(catalog.length), director = new MpcAutoDirector(), flash = new FlashGate('limit', canvasProbeSampler({ smoothingQuality: 'medium' }));
// Device-local display preferences (contract C-14) and the render-resolution policy; the sizer reads the view on every resolve.
const sizer = new RenderSizer({ cssSize: () => ({ width: canvas.clientWidth, height: canvas.clientHeight }), dpr: () => devicePixelRatio || 1, now: () => performance.now() });
const presenter = new SurfacePresenter((width, height) => { const scratch = document.createElement('canvas'); scratch.width = width; scratch.height = height; return scratch; });
const stopDeviceWatch=watchDeviceBox(canvas, sizer);
const kindOf = (index: number): RenderKind => catalog[index]?.kind === 'hud' ? 'hud' : catalog[index]?.kind === 'nerv' ? 'nerv' : 'avs';
const resolveSlot=(index:number)=>sizer.resolve(kindOf(index),catalog[index]?.kind==='hud'?hudTraits(catalog[index]?.hud):undefined);
let presentedKey = '';
const composite = document.createElement('canvas'), cc = composite.getContext('2d', { alpha: false })!;
const normalizer = new PcmNormalizer(), analyser = new AvsAudioAnalyser(), hudFeed = new HudFeed();
let trackDuration:number|null=null;
interface Slot { stashed:Set<string>; stashPending:string|null; sentAt: number; sized: string; audio: AudioHold; worker: Worker; generation: number; index: number; busy: boolean; ready: boolean; bitmap: ImageBitmap | null; timeout: number; dead: boolean; start: number; renderRevision: number; renderedPosition: number; lastAudio:AvsAudioFrame }
let active: Slot | null = null, prepared: Slot | null = null, outgoing: Slot | null = null;
let retryAfter = 0;
let loading = false, ticket = 0, generation = 0, sequence = 0, autoPending = false;
let hostVisible = true;
let playing = false, epoch = -1, lastAudio = 0, position = 0, pcm = new Float32Array(1152);
let announceTimer = 0, transitionMode = 1, keepOld = true;
let manualFade = true, autoFade = true;
// Timing System v2: one stored fade spec (length family, Random set, anchor, Seconds fallback) replaces durationBeats and durationMs.
let fadeSpec: FadeSpec = defaultFadeSpec, queueQuantize = 0;
// Frame-rate channels: present (headline), display, render and clock. Timestamps are rAF time or performance.now(), one time base per meter.
const fps = { present: new FpsMeter(), display: new FpsMeter(), render: new FpsMeter(), clock: new FpsMeter() }, fpsLabel = new FpsLabel();
let timingText = '';
// Stage timing (src/perf-trace.ts, docs/PERFORMANCE.md): OFF unless ?perf=1|sync, localStorage mpcaaavs.perf, Ctrl+Alt+P or window.__aaavsPerf.enable().
// Every site below tests `perf.enabled` (one boolean) before it measures anything.
const perf = new PerfRecorder(() => performance.now());
let perfLineText: string | null = null, perfLineAt = -Infinity, lastRaf = 0;
function perfSet(mode: 0 | 1 | 2) {
  if (mode) perf.enable(mode); else perf.disable();
  perfLineText = null; perfLineAt = -Infinity; lastRaf = 0;
  try { if (mode) document.body.classList.add('timing-always'); else if (sizer.prefs.timingOverlay !== 1) document.body.classList.remove('timing-always'); } catch { /* minimal DOM */ }
}
/** The `perf` field of a render request: the mode, and the host's epoch time where the platform has one (the worker then reports the request's time in flight). */
function perfRequest() { const sent = epochNow(); return Number.isFinite(sent) ? { mode: perf.level, sent } : { mode: perf.level }; }
/** Trace metadata: the page and the existing FPS meter channels (present, display, render, clock) as they read now. */
function perfMeta(page: string) {
  const at = performance.now();
  return { page, fps: { present: fps.present.read(at), display: fps.display.read(at), render: fps.render.read(at), clock: fps.clock.read(at) } };
}
function perfTraceDownload() {
  try {
    const blob = new Blob([JSON.stringify(perf.trace(true, { ...perfMeta('mpc-host'), ua: navigator.userAgent, dpr: devicePixelRatio || 1 }))], { type: 'application/json' });
    const a = document.createElement('a');
    a.href = URL.createObjectURL(blob); a.download = `aaavs-perf-${Date.now()}.json`;
    document.body.append(a); a.click(); a.remove(); setTimeout(() => URL.revokeObjectURL(a.href), 5000);
  } catch (error) { announce(`Perf trace download failed: ${String(error)}`); }
}
{
  (window as unknown as { __aaavsPerf?: unknown }).__aaavsPerf = {
    enable: (mode: number | string = 1) => perfSet(parsePerfMode(mode) || 1), disable: () => perfSet(0), reset: () => perf.reset(),
    trace: (withSeries = true) => perf.trace(withSeries, perfMeta('mpc-host')), download: perfTraceDownload, get mode() { return perf.level; },
  };
  try {
    const query = (window as { location?: { search?: string } }).location?.search;
    const fromUrl = query ? parsePerfMode(new URLSearchParams(query).get('perf')) : 0;
    const mode = fromUrl || parsePerfMode(globalThis.localStorage?.getItem('mpcaaavs.perf'));
    if (mode) perfSet(mode);
  } catch { /* storage unavailable: stays off */ }
}
// Live Random picks: per-activation counter plus a session seed created once (tests replace Math.random before the host loads).
let liveFadeCount = 0;
const liveFadeSeed = Math.floor(Math.random() * 4294967296) >>> 0;
// Transition layer (TRX): reduced motion is read once from the platform and never assumed; a live transition freezes its band levels and accent at start.
let reducedMotion = false;
try { const g = globalThis as { matchMedia?: (query: string) => { matches?: boolean } }; reducedMotion = typeof g.matchMedia === 'function' && g.matchMedia('(prefers-reduced-motion: reduce)').matches === true; } catch { reducedMotion = false; }
let transitionBands: number[] | undefined, transitionAccent: 0 | 1 = 0;
let dirty = true, closed = false, lastPresentedPosition = -1;
let transition: AvsTransition | null = null, transitionStart = 0, transitionDuration = 2;
const failed = new Set<number>();
let setupOrder:number[]|null=null;
let playSource:PlaySource={kind:'library'}, failureRevision=0;
const poolCache=new PoolCache(), noFailures=new Set<number>();
let taxa:TaxonMap|null=null;
const wholeOrder=catalog.map((_,index)=>index);
let minimumRating=0, pendingFiltered=false;
let eligibleCount=eligiblePresets(catalog,wholeOrder,false,0).length;
let sceneTiming:SceneTiming={...defaultSceneTiming}, sceneClock:SceneClock|null=null, sequenceSuspended=false, clockRevision=0;
let pendingIndex:number|null=null;
let pendingClock=false;
let pendingPhase:ScenePhase|null=null, sceneCues:SessionSceneCue[]=[];
const silence=():AvsAudioFrame=>({waveform:[new Uint8Array(576),new Uint8Array(576)],spectrum:[new Uint8Array(576),new Uint8Array(576)],beat:false,beatLevel:0});
let latestAudio=silence();
function selectionPool(skipFailures=true){return poolCache.get(setupOrder??wholeOrder,catalog,presets.shuffle,minimumRating,skipFailures?failed:noFailures,failureRevision*2+(skipFailures?1:0));}
// The clock resolves end and hit anchors too, but this host acts on start-anchored windows only (the end anchor needs the wider lookahead,
// an early commit and director.rearm(origin): Wave 4). A stored anchor of 1 or 2 therefore reads as 0 here, exactly as C-06 says for `hit`.
const startAnchored=(spec:FadeSpec):FadeSpec=>spec.anchor===0?spec:{...spec,anchor:0};
function clockPhase(at=position,withFade=false):ClockFrame|null{
  if(!sceneClock||!director.enabled||sequenceSuspended||!setupOrder)return null;
  const pool=selectionPool();
  return poolCache.memoPhase(`${poolCache.poolRevision}:${clockRevision}:${at}:${withFade}`,()=>sceneClock!.at(at,pool,presets.shuffle,sceneCues.filter(c=>pool.includes(c.index)),withFade?startAnchored(fadeSpec):undefined));
}
function eligibilityChanged(){
  const pool=selectionPool();
  eligibleCount=pool.length;
  sceneCues=sceneCues.filter(c=>pool.includes(c.index));
  if(pendingIndex!==null&&(autoPending||pendingFiltered||pendingClock)&&!pool.includes(pendingIndex))cancelPrepared();
  presets.cancel();clockRevision++;syncSceneClock();management.refresh();multiView.refreshSources();
}
function setMinimumRating(value:number){
  if(!Number.isInteger(value)||value<0||value>5)return;
  minimumRating=value;eligibilityChanged();
  sendLibrary({op:'configure',settings:managementSettings()});
  announce(`Shuffle rating: ${value?`${value} stars or higher`:'all ratings'}${presets.shuffle&&!selectionPool().length?' · no eligible presets':''}`);
}
function manualSelection(index:number,filtered=false){
  if(multiView.selectPreset(index))return;
  const phase=clockPhase();
  // Queue on the scene clock only when the owner chose a quantized manual queue; the default (0) is immediate, as the
  // Manual queue control promises. An immediate pick suspends the clock sequence and Auto continues from the new preset.
  if(queueQuantize>0&&phase&&isSceneKind(catalog[phase.index])&&isSceneKind(catalog[index])&&selectionPool().includes(index)){
    if(failed.has(index)){announce('This scene could not be loaded; choose another preset.');return;}
    try{sceneCues=scheduleSceneCue(sceneCues,phase,index);}catch(error){announce(String(error));return;}
    clockRevision++;syncSceneClock();
    announce(`Queued: ${catalog[index]!.name} · next scene boundary`);return;
  }
  sequenceSuspended=sceneTiming.enabled;clockRevision++;director.rearm();void prepare(index,false,undefined,filtered);
}
function syncSceneClock(){
  if(multiView.enabled)return;
  const phase=clockPhase();
  const next=phase?clockPhase(phase.end):null;
  // Retain lookahead only while it still matches the next absolute boundary.
  if(pendingClock&&(!phase||!pendingPhase||!(phase.ordinal===pendingPhase.ordinal&&phase.index===pendingIndex||next?.ordinal===pendingPhase.ordinal&&next.index===pendingIndex)))cancelPrepared();
  if(!phase||management.open||!hostVisible||document.hidden)return;
  if(pendingClock&&pendingPhase?.ordinal===phase.ordinal&&prepared?.bitmap){
    if(prepared.busy)return;
    // A preloaded image is never presented with its future time-zero audio.
    if(prepared.renderedPosition<phase.start||prepared.renderRevision!==clockRevision){render(prepared);return;}
    commit();
  }
  if(active?.index!==phase.index){
    if(pendingIndex!==phase.index&&!failed.has(phase.index))void prepare(phase.index,false,phase);
    return;
  }
  const queued=sceneCues.some(c=>c.ordinal===phase.ordinal+1);
  const lookahead=Math.min(2,phase.beatsPerBar*60/phase.bpm,phase.duration/4);
  if(next&&isSceneKind(catalog[phase.index])&&isSceneKind(catalog[next.index])&&next.index!==phase.index&&!loading&&!prepared&&!outgoing&&!failed.has(next.index)&&(queued||phase.duration-phase.localTime<=lookahead))void prepare(next.index,true,next);
}
const ratings:{index:number;value:number}[]=[];
const marks:{index:number;value:boolean}[]=[];
const sendLibrary=(value:unknown)=>bridge?.postMessage(`library:${JSON.stringify(value)}`);
function markNotWorking(index:number,value:boolean){
  if(!catalog[index])return;
  const previous=[...marks].reverse().find(m=>m.index===index)?.value??catalog[index]!.notWorking??false;
  if(previous===value){announce(value?'Preset already marked not working.':'Preset is available.');return;}
  marks.push({index,value});
  if(marks.length===1)sendLibrary({op:'set-not-working',hash:catalog[index]!.sha256,notWorking:value});
}
function markCurrent(){
  const index=multiView.currentIndex??active?.index;
  if(index===undefined||index===null){announce('Load a preset before marking it.');return;}
  markNotWorking(index,true);
}
function updateLabel(){if(multiView.enabled){label.textContent=multiView.summary;return;}if(active){const p=catalog[active.index]!,pool=selectionPool();label.textContent=overlayText({source:playSource,index:active.index,catalogLength:catalog.length,name:p.name,rating:p.rating??0,notWorking:p.notWorking??false,position:pool.indexOf(active.index)+1,poolSize:pool.length,shuffle:presets.shuffle});}}
function rate(index:number,value:number){
  if(!catalog[index])return;
  value=Math.max(1,Math.min(5,value));
  const previous=[...ratings].reverse().find(r=>r.index===index)?.value??catalog[index]!.rating??0;
  if(previous===value)return;
  ratings.push({index,value});
  if(ratings.length===1)sendLibrary({op:'rate',hash:catalog[index]!.sha256,rating:ratings[0]!.value});
}
function rateCurrent(delta:number){
  const index=multiView.currentIndex??active?.index;
  if(index===undefined||index===null){announce('Load a preset before rating it.');return;}
  const pending=[...ratings].reverse().find(r=>r.index===index);
  rate(index,(pending?.value??catalog[index]!.rating??0)+delta);
}
function activateSetup(setup:PresetSetup|null){
  if(multiView.useSet(setup))return;
  const order=setup?setupIndices(setup,catalog):null;
  const nextTiming=parseSceneTiming(setup?.timing);
  const nextClock=nextTiming.enabled?compileSceneClock(nextTiming):null;
  if(setup&&!order?.length)throw Error('Add at least one preset before activating this setup.');
  if(order?.some(i=>!catalog[i]!.autoEligible))throw Error('Remove unavailable presets before activating this setup.');
  playSource=setup?{kind:'setup',label:setup.name}:{kind:'library'};
  setupOrder=order;sceneTiming=nextTiming;sceneClock=nextClock;liveFadeCount=0;director.beatsPerBar=nextTiming.beatsPerBar??4;sceneCues=[];sequenceSuspended=false;clockRevision++;cancelPrepared();director.rearm();presets.cancel();
  eligibleCount=selectionPool().length;
  if(setup){
    director.configure(setup.settings.enabled,setup.settings.bars);presets.shuffle=setup.settings.shuffle;minimumRating=setup.settings.minimumRating??0;
    transitionMode=setup.settings.transition;fadeSpec=fadeSpecOf(setup.settings);queueQuantize=setup.settings.queueQuantize??0;
    keepOld=setup.settings.keepOld;manualFade=setup.settings.manualFade;autoFade=setup.settings.autoFade;
    sendLibrary({op:'configure',settings:configureSettings(setup.settings)});
    const pool=selectionPool(),phase=clockPhase();
    eligibleCount=pool.length;
    if(pool.length)void prepare(phase?.index??pool[0]!,false,phase??undefined,true);
    else announce('No eligible presets in this setup. Lower the shuffle rating or restore a preset in Preset Manager.');
  }
}
function playFolder(plan:FolderPlayPlan):{ok:true;eligible:number}|{ok:false;reason:string}{
  try{
    const clean=sanitizeOrder(plan.order,catalog);
    if(!clean)return {ok:false,reason:'No playable presets in this folder.'};
    if(multiView.enabled){const eligible=eligiblePresets(catalog,clean.order,false,0,failed).length;
      if(!eligible)return {ok:false,reason:'No eligible presets in this folder.'};
      multiView.useFolder({id:plan.key,name:plan.label,order:clean.order});return {ok:true,eligible};}
    const settings=plan.settings?parseSettings(plan.settings):null;
    const nextTiming=parseSceneTiming(plan.timing??undefined),nextClock=nextTiming.enabled?compileSceneClock(nextTiming):null;
    const pool=eligiblePresets(catalog,clean.order,settings?.shuffle??presets.shuffle,settings?.minimumRating??minimumRating,failed);
    if(!pool.length)return {ok:false,reason:'No eligible presets in this folder. Lower the shuffle rating or restore a preset.'};
    const start=plan.startAt!==null&&pool.includes(plan.startAt)?plan.startAt:pool[0]!;
    setupOrder=clean.order;playSource={kind:'folder',key:plan.key,label:plan.label,total:clean.order.length};
    sceneTiming=nextTiming;sceneClock=nextClock;sceneCues=nextClock&&start!==pool[0]?[{ordinal:0,index:start}]:[];
    sequenceSuspended=false;clockRevision++;liveFadeCount=0;director.beatsPerBar=nextTiming.beatsPerBar??4;
    cancelPrepared();director.rearm();presets.cancel();
    if(settings){
      director.configure(settings.enabled,settings.bars);presets.shuffle=settings.shuffle;minimumRating=settings.minimumRating;
      transitionMode=settings.transition;fadeSpec=fadeSpecOf(settings);queueQuantize=settings.queueQuantize??0;
      keepOld=settings.keepOld;manualFade=settings.manualFade;autoFade=settings.autoFade;
      sendLibrary({op:'configure',settings:configureSettings(settings)});
    }
    eligibleCount=selectionPool().length;
    const phase=clockPhase();void prepare(phase?.index??start,false,phase??undefined,true);updateLabel();management.refresh();
    return {ok:true,eligible:eligibleCount};
  }catch(error){return {ok:false,reason:String(error instanceof Error?error.message:error)};}
}
function stopFolder(){if(playSource.kind!=='folder')return;activateSetup(null);updateLabel();management.refresh();announce('Stopped folder play.');}
// C-04: `beats` is the projection of the fade timing; the four v2 fields appear only when they differ from their defaults.
function managementSettings(){return settingsWithFade({enabled:director.enabled,bars:director.bars,shuffle:presets.shuffle,minimumRating,transition:transitionMode,beats:0,durationMs:fadeSpec.fixedMs,keepOld,manualFade,autoFade},fadeSpec,queueQuantize);}
const management=new PresetManagement({catalog:()=>catalog,current:()=>multiView.currentIndex??active?.index??presets.index,
  settings:managementSettings,hudSetup:()=>hudSetup(catalog),
  source:()=>playSource,playFolder,stopFolder,timing:()=>sceneTiming,failedIndices:()=>failed,
  sources:()=>typeof collectionApi.fetchLocalAvsSources==='function'?collectionApi.fetchLocalAvsSources():Promise.resolve(new Map()),taxa:()=>taxa,
  load:manualSelection,rate,markNotWorking,setMinimumRating,send:sendLibrary,activate:activateSetup,
  nervSetup:()=>({id:'nerv-scene-set',name:'NERV · repeatable sequence',presets:NERV_SCENES.map(id=>catalog.find(p=>p.kind==='nerv'&&p.scene===id)?.sha256).filter((h):h is string=>!!h),
    settings:{enabled:true,bars:8,shuffle:false,minimumRating:0,transition:1,beats:2,durationMs:1000,keepOld:true,manualFade:true,autoFade:true},
    timing:{...defaultSceneTiming,enabled:true,bpm:director.tempo.locked?Math.round(director.tempo.bpm*100)/100:120}}),
  display:()=>sizer.prefs,
  setDisplay:patch=>{const next=mergePrefs(sizer.prefs,patch);if(next===sizer.prefs)return;applyDisplay(next);bridge?.postMessage(`display:${JSON.stringify(prefsToWire(next))}`);},
  position:()=>position,playing:()=>playing,tempo:()=>({locked:director.tempo.locked,bpm:director.tempo.bpm,phase:director.tempo.phase}),
  panel:mode=>bridge?.postMessage(`panel-state:${mode}`),close:()=>{bridge?.postMessage('panel-close');syncSceneClock();}});
const multiView=new MultiViewSession({catalog:()=>catalog,presets:fetchLocalAvsPreset,bitmaps:loadPresetBitmaps,
  worker:url=>new Worker(new URL('./'+url,import.meta.url),{type:'module'}),
  view:()=>({width:canvas.clientWidth,height:canvas.clientHeight,dpr:devicePixelRatio||1}),display:()=>sizer.prefs,
  audio:()=>latestAudio,pcm:()=>pcm,hudFeed,position:()=>position,duration:()=>trackDuration,playing:()=>playing,
  visible:()=>hostVisible&&!document.hidden,reducedMotion:()=>reducedMotion,
  storage:()=>{try{return globalThis.localStorage;}catch{return undefined;}},requestSets:()=>sendLibrary({op:'load-setups'}),
  mode:enabled=>{cancelPrepared();dispose(active);active=null;dispose(outgoing);outgoing=null;transition=null;director.rearm();dirty=true;
    if(enabled)label.textContent='Multiview · loading panels';else void prepare(presets.index,false);},
  announce,failed:index=>{failed.add(index);failureRevision++;},failures:()=>failed,now:()=>performance.now(),
  present:(surface,now)=>{if(canvas.width!==surface.width||canvas.height!==surface.height){canvas.width=surface.width;canvas.height=surface.height;flash.reset();}
    if(canvas.style)canvas.style.imageRendering='auto';
    const presentFrom=perf.enabled?performance.now():0;
    flash.present(context,surface,now/1000,()=>{context.imageSmoothingEnabled=true;context.drawImage(surface,0,0,canvas.width,canvas.height);});
    if(perf.enabled)perf.record('host.present',performance.now()-presentFrom);
    label.textContent=multiView.summary;fps.present.mark(now);
    if(!flash.available){status.textContent='Visualizer paused: flash protection unavailable';document.body.classList.add('protection-error');}
    else document.body.classList.remove('protection-error');}});
multiView.mount(canvas.parentElement??document.body);
canvas.addEventListener?.('click',event=>{if(!multiView.enabled)return;const box=canvas.getBoundingClientRect();multiView.pick((event.clientX-box.left)*canvas.width/box.width,(event.clientY-box.top)*canvas.height/box.height);updateLabel();});
void fetchLocalCategories(undefined,catalog).then(map=>{if(closed)return;taxa=map;management.refresh();});
function applyDisplay(next: DisplayPrefs) {
  const before = sizer.prefs;
  sizer.setPrefs(next);
  const now = sizer.prefs;
  if (now.timingOverlay === 1) document.body.classList.add('timing-always'); else document.body.classList.remove('timing-always');
  dirty = true;
  if (before.quality !== now.quality || before.avsResolution !== now.avsResolution || before.pixelArt !== now.pixelArt) announce(`Display: ${describeResolved(active?resolveSlot(active.index):sizer.resolve('avs'))}`);
}
function announce(text: string) {
  status.textContent = text; document.body.classList.add('announce'); clearTimeout(announceTimer);
  announceTimer = window.setTimeout(() => document.body.classList.remove('announce'), 3500);
}
function dispose(slot: Slot | null) {
  if (!slot) return; slot.dead = true; clearTimeout(slot.timeout); slot.worker.terminate(); slot.bitmap?.close(); slot.bitmap = null;
}
function cancelPrepared() { ticket++; loading = false; pendingIndex=null;pendingClock=false;pendingPhase=null;pendingFiltered=false; dispose(prepared); prepared = null; autoPending = false; }
function render(slot: Slot) {
  if (slot.dead || slot.busy || !slot.ready) return;
  const phase=clockPhase(position,true);
  if(slot===active&&phase&&phase.index!==slot.index)return;

  const { width, height } = resolveSlot(slot.index).render;
  const isNerv=catalog[slot.index]!.kind==='nerv', isHud=catalog[slot.index]!.kind==='hud';
  const clocked=slot===prepared&&pendingClock&&pendingPhase&&phase&&pendingPhase.ordinal>phase.ordinal?clockPhase(pendingPhase.start,true):phase?.index===slot.index?phase:null;
  const future=!!clocked&&clocked.start>position;
  const bpm=clocked?clocked.bpm:director.tempo.locked?director.tempo.bpm:120;
  const localTime=clocked?clocked.localTime:Math.max(0,position-slot.start);
  const previous=clocked&&clocked.ordinal>0?catalog[clocked.previousIndex]?.scene:undefined;
  const fade=clocked?.fade??null, at=future?clocked!.start:position;
  const fadeBeats=fade?Math.min(64,Math.max(.25,fade.beats>0?fade.beats:fade.seconds*bpm/60)):4, boundary=clocked?boundaryLevel(clocked.startBeat/clocked.beatsPerBar):0;
  const transitionSeed=clocked?(sceneTiming.seed^Math.imul(clocked.ordinal+1,0x9e3779b1)^parseInt(catalog[clocked.previousIndex]!.sha256.slice(0,8),16)^Math.imul(parseInt(catalog[clocked.index]!.sha256.slice(0,8),16),0x85ebca6b))>>>0:sceneTiming.seed;
  const previousRow=clocked&&clocked.ordinal>0?catalog[clocked.previousIndex]:undefined;
  const fading=!!(previousRow&&isSceneKind(previousRow)&&autoFade&&transitionMode!==TRANSITION_CUT&&fade&&fade.seconds>0);
  // Stash verified immutable bytes before transferring PCM; FIFO messages initialize the previous plate first.
  if(isHud&&fading&&previousRow!.kind==='hud'&&!slot.stashed.has(previousRow!.sha256)){
    const hash=previousRow!.sha256;
    if(slot.stashPending)return;
    slot.stashPending=hash;const revision=clockRevision,gen=slot.generation;
    let timer=0;
    const stillNeeded=()=>{
      if(slot.dead||slot.generation!==gen||clockRevision!==revision)return false;
      const now=clockPhase(position,true);
      const target=slot===prepared&&pendingClock&&pendingPhase&&now&&pendingPhase.ordinal>now.ordinal?clockPhase(pendingPhase.start,true):now;
      return !!(target&&target.ordinal>0&&catalog[target.previousIndex]?.sha256===hash);
    };
    void Promise.race([fetchLocalAvsPreset(previousRow!),new Promise<never>((_,reject)=>{timer=window.setTimeout(()=>reject(new Error('Previous HUD fetch timed out')),15000);})]).then(bytes=>{
      if(slot.dead||slot.generation!==gen)return;
      slot.stashPending=null;
      if(!stillNeeded()){render(slot);return;}
      const copy=bytes.slice();slot.worker.postMessage({type:'stash',generation:gen,sha256:hash,preset:copy.buffer},[copy.buffer]);
      slot.stashed.add(hash);if(slot.stashed.size>4)slot.stashed.delete(slot.stashed.values().next().value!);
      render(slot);
    }).catch(error=>{if(!slot.dead&&slot.generation===gen){slot.stashPending=null;if(stillNeeded())fail(slot,String(error));else render(slot);}}).finally(()=>clearTimeout(timer));
    return;
  }
  slot.busy=true;const data=pcm.slice().buffer;
  const audio=isSceneKind(catalog[slot.index])&&!playing?slot.lastAudio:slot.audio.consume();slot.lastAudio=audio;
  const request: AvsWorkerRequest = { type: 'render', generation: slot.generation, sequence: ++sequence, pcm: data, audio, width, height,
    ...(isNerv&&perf.enabled?{perf:perfRequest()}:{}),
    ...(isNerv?{nerv:{time:at,localTime,progress:clocked?.progress??((localTime*bpm/240)%8)/8,bpm,seed:sceneTiming.seed,transitionMode,transitionSeed,
      ...(clocked&&sceneClock?{grid:sceneClock.clockGrid,sceneStart:clocked.start,sceneEnd:clocked.end}:{}),
      ...(previous&&autoFade&&transitionMode!==TRANSITION_CUT&&fade&&fade.seconds>0?{previousScene:previous,previousTime:keepOld?at:clocked!.start,previousLocalTime:keepOld?at-clocked!.previousStart:clocked!.previousFrozen,
        previousSceneStart:clocked!.previousStart,previousSceneEnd:clocked!.start,blend:Math.min(1,fade.progress),fadeSeconds:fade.seconds,
        transitionBeats:fadeBeats,transitionBoundary:boundary,transitionAccent:1,transitionReduced:reducedMotion}:{})}}:{}),
    ...(isHud?{hud:buildHudFrame({time:at,seed:sceneTiming.seed,revision:clockRevision,
      grid:clocked&&sceneClock?sceneClock.clockGrid:null,sceneStart:clocked?.start??slot.start,sceneEnd:clocked?.end??null,
      tempo:director.tempo.locked?{bpm:director.tempo.bpm,beatIndex:director.tempo.beatIndex,beatPhase:director.tempo.phase,locked:true}:null,
      named:sceneClock?.intervals,track:{position:at,duration:trackDuration},signals:hudFeed.snapshot(at,audio,playing&&!future),motion:reducedMotion?'reduced':'full',flash:'limit',transitionMode,transitionSeed,
      ...(fading?{previous:{sha256:previousRow!.sha256,kind:previousRow!.kind as 'hud'|'nerv',...(previousRow!.kind==='nerv'?{scene:previousRow!.scene}:{})},
        previousTime:keepOld?at:clocked!.start,previousLocalTime:keepOld?at-clocked!.previousStart:clocked!.previousFrozen,previousSceneStart:clocked!.previousStart,previousSceneEnd:clocked!.start,
        blend:Math.min(1,fade!.progress),fadeSeconds:fade!.seconds,transitionBeats:fadeBeats,transitionBoundary:boundary,transitionAccent:1,transitionReduced:reducedMotion}:{})})}:{}) };
  slot.renderRevision=clockRevision;slot.renderedPosition=position;slot.sentAt=performance.now();slot.sized=`${width}x${height}`;
  if (perf.enabled) { perf.add('host.render.messages'); perf.add('host.render.bytes', data.byteLength + 4 * 576 + 256 + (isHud ? 64 * 4 : 0)); }
  slot.worker.postMessage(request, [data]);
  // A NERV preset's first frame on the show engine compiles shaders and builds its plate in the worker; inside the MPC
  // WebView that can exceed the steady-state budget, and a timeout here marks the preset failed so navigation skips it.
  slot.timeout = window.setTimeout(() => fail(slot, 'Preset render timed out'), isNerv && slot.bitmap === null ? 20000 : 5000);
}
function fail(slot: Slot, reason: string) {
  if (slot.dead) return;
  failed.add(slot.index);failureRevision++; retryAfter = performance.now() + 1000; dispose(slot);
  eligibleCount=selectionPool().length;
  if (slot === prepared) { prepared = null; loading = false; pendingIndex=null;pendingClock=false;pendingPhase=null; presets.cancel(); }
  if (slot === outgoing) { outgoing = null; transition = null; }
  if (slot === active) {
    active = outgoing; outgoing = null; transition = null;
    if (active) presets.select(active.index);
  }
  dirty = true;
  announce(`${catalog[slot.index]!.name}: ${reason}; ${active ? 'keeping current preset' : 'choose another preset'}`);
  if (!active && !management.open) bridge?.postMessage('error');
}
/** The live compositor transition. Seed, context and the frozen band levels are fixed here, so every frame is a pure function of media time. */
function startTransition(automatic: boolean) {
  const scene = (s: Slot | null) => isSceneKind(catalog[s!.index]), sha8 = (s: Slot | null) => parseInt(catalog[s!.index]!.sha256.slice(0, 8), 16) >>> 0;
  const bpm = director.tempo.locked ? director.tempo.bpm : 120, nervPair = scene(outgoing) && scene(active), level = transitionLevel(latestAudio);
  transitionBands = bands16(latestAudio); transitionAccent = nervPair ? 1 : 0;
  transition = new AvsTransition(transitionMode, {
    seed: hash32(sceneTiming.seed, sha8(outgoing), sha8(active), Math.round(position * 1000)),
    context: { beatsTotal: Math.min(64, Math.max(.25, transitionDuration * bpm / 60)), boundary: automatic ? boundaryLevel(null, director.bars) : 0, nervPair, reducedMotion, energy: Math.min(3, Math.round(level * 4)) as 0 | 1 | 2 | 3 },
    smooth: kindOf(outgoing!.index) !== 'avs' || kindOf(active!.index) !== 'avs' });
}
function envNow(): TransitionEnv {
  const tempo = director.tempo, locked = tempo.locked, bpm = locked ? tempo.bpm : 120, fract = (v: number) => v - Math.floor(v);
  return { bpm, beatPhase: locked ? fract(tempo.phase) : 0, barPhase: locked ? fract((tempo.beatIndex + tempo.phase) / director.beatsPerBar) : 0, beatsTotal: transitionDuration * bpm / 60, seconds: transitionDuration,
    level: transitionLevel(latestAudio), ...(transitionBands ? { bands: transitionBands } : {}), accent: transitionAccent, reducedMotion };
}
function commit() {
  if (!prepared?.bitmap) return;
  if(pendingClock){const phase=clockPhase();if(!phase||phase.ordinal!==pendingPhase?.ordinal||phase.index!==prepared.index)return;}
  const fade = autoPending ? autoFade : manualFade && playing, automatic = autoPending;
  dispose(outgoing); outgoing = active; active = prepared; prepared = null; loading = false; pendingIndex=null;pendingClock=false;pendingPhase=null;
  failed.delete(active.index);failureRevision++;eligibleCount=selectionPool().length;
  presets.select(active.index); autoPending = false; director.rearm();
  transition = null;
  transitionStart = position;
  // Live fades resolve like clocked ones: a seeded pick, then a length from the locked tempo (Seconds when there is none), limited to the phrase.
  const fades = !!outgoing && fade && transitionMode !== TRANSITION_CUT && clockPhase()?.index !== active.index;
  if (fades) {
    const locked = director.tempo.locked, phrase = director.bars > 0 && locked ? director.bars * director.beatsPerBar * 60 / director.tempo.bpm : undefined;
    transitionDuration = planFade(fadeSpec, pickFade(fadeSpec, liveFadeCount++, setupOrder ? sceneTiming.seed : liveFadeSeed),
      { bpm: locked ? director.tempo.bpm : null, beatsPerBar: director.beatsPerBar, ...(phrase !== undefined ? { capSeconds: phrase } : {}) }).seconds;
  }
  if (!fades || !(transitionDuration > 0)) { dispose(outgoing); outgoing = null; transition = null; } else startTransition(automatic);
  updateLabel();
  management.noteCommit?.(active.index,playing);management.refresh();
  dirty = true; announce(`Preset ready: ${catalog[active.index]!.name}`);
  bridge?.postMessage('ready');
}
async function prepare(index: number, automatic: boolean, clockTarget?:ScenePhase, filtered=false) {
  cancelPrepared(); dispose(outgoing); outgoing = null; transition = null; const current = ticket; loading = true; pendingIndex=index;pendingPhase=clockTarget??null;pendingClock=!!clockTarget; autoPending = automatic; dirty = true;
  pendingFiltered=filtered;
  announce(`Loading preset: ${catalog[index]!.name}...`);
  try {
    const preset = catalog[index]!;
    let fetchTimer = 0;
    const [bytes, bitmaps] = await Promise.race([
      Promise.all([fetchLocalAvsPreset(preset), isSceneKind(preset)?Promise.resolve([]):loadPresetBitmaps(preset.sha256)]),
      new Promise<never>((_, reject) => { fetchTimer = window.setTimeout(() => reject(new Error('Preset fetch timed out')), 15000); }),
    ]).finally(() => clearTimeout(fetchTimer));
    if (current !== ticket) return;
    const worker = new Worker(sceneWorkerLocation(preset.kind, import.meta.url), { type: 'module' });
    const slot: Slot = { stashed:new Set(),stashPending:null,sentAt: 0, sized: '', audio: new AudioHold(), worker, generation: ++generation, index, busy: false, ready: false, bitmap: null, timeout: 0, dead: false, start:position,renderRevision:clockRevision,renderedPosition:NaN,lastAudio:latestAudio };
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
        if(slot.renderRevision!==clockRevision&&isSceneKind(preset)){clearTimeout(slot.timeout);slot.busy=false;message.bitmap.close();render(slot);return;}
        clearTimeout(slot.timeout); slot.busy = false; slot.bitmap?.close(); slot.bitmap = message.bitmap; dirty = true;
        if (perf.enabled) {
          perf.add('host.frame.messages');
          if (slot === active && slot.sentAt > 0) {
            perf.record('host.rtt', performance.now() - slot.sentAt);
            try { if (message.perf) perf.recordWorker(validateWorkerPerf(message.perf), epochNow()); else perf.record('frame.total', message.renderMs); } catch { /* a malformed report is dropped */ }
          }
        }
        if (slot === active) fps.render.mark(performance.now());
        if (slot === active && playing && slot.sentAt > 0 && sizer.recordFrame(kindOf(slot.index), performance.now() - slot.sentAt)) announce(`Render quality: ${describeResolved(resolveSlot(slot.index))}`);
        if (slot === prepared){if(pendingClock)syncSceneClock();else if(!autoPending)commit();}
      }
    };
    const size = resolveSlot(index).render;
    const request: AvsWorkerRequest = { type: 'load', generation: slot.generation, preset: bytes.buffer as ArrayBuffer, bitmaps, width: size.width, height: size.height, gpuLane: 'exact' };
    worker.postMessage(request, [request.preset]);
  } catch (error) {
    if (current !== ticket) return;
    loading = false; pendingIndex=null;pendingClock=false;pendingPhase=null; presets.cancel(); retryAfter = performance.now() + 1000; failed.add(index);failureRevision++; announce(`Preset unavailable: ${String(error)}`);
    eligibleCount=selectionPool().length;
    if (!active && !management.open) bridge?.postMessage('error');
  }
}
function candidate(): number | null {
  return stepSetup(selectionPool(),presets.index,1,presets.shuffle);
}
bridge?.addEventListener('message', event => {
  if (closed) return;
  const message = event.data;
  if (!message || typeof message !== 'object') return;
  if (message.type === 'audio') {
    const audioStart = perf.enabled ? performance.now() : 0;
    if (perf.enabled) { const n = Array.isArray(message.frames) ? message.frames.length : 0; perf.add('host.audio.messages'); perf.add('host.audio.frames', n); perf.add('host.audio.floats', (n + (Array.isArray(message.pcm) ? 1 : 0)) * 1152); }
    if(message.epoch!==epoch)trackDuration=null;
    if(message.duration!==undefined)trackDuration=typeof message.duration==='number'&&Number.isFinite(message.duration)&&message.duration>0&&message.duration<=AUDIO_DURATION_MAX?message.duration:null;
    playing = message.playing === true;management.notePlaying?.(playing);
    if (!playing) songMap?.pauseLive();
    hostVisible = message.visible !== false;
    if (Array.isArray(message.pcm) && message.pcm.length === 1152) {
      pcm = Float32Array.from(message.pcm, x => typeof x === 'number' && Number.isFinite(x) ? Math.max(-1, Math.min(1, x)) : 0);
      lastAudio = performance.now();
    }
    if (Number.isFinite(message.position)) {
      const seek = epoch !== -1 && (epoch !== message.epoch || message.position < position || message.position - position > .75);
      epoch = message.epoch;
      if (message.position !== position) fps.clock.mark(performance.now());
      position = message.position;
      if (seek) { songMap?.pauseLive(); epoch = message.epoch; clockRevision++;latestAudio=silence();if(active)active.lastAudio=silence();director.reset(); normalizer.reset(); analyser.reset();hudFeed.reset(); active?.audio.reset(); outgoing?.audio.reset();multiView.seek(); cancelPrepared(); presets.cancel(); dirty = true; dispose(outgoing); outgoing = null; transition = null; if (!active&&!clockPhase()&&!multiView.enabled) void prepare(presets.index, false); }
      const frames = Array.isArray(message.frames) ? message.frames.slice(0, 64).filter((frame: {time?: number; pcm?: unknown[]}) => Number.isFinite(frame?.time) && frame.time! <= position && Array.isArray(frame.pcm) && frame.pcm.length === 1152).map((frame: {time: number; pcm: unknown[]; sampleRate?: number; samples?: number}) => ({ time: frame.time, sampleRate: frame.sampleRate, samples: frame.samples, pcm: Float32Array.from(frame.pcm, x => typeof x === 'number' && Number.isFinite(x) ? Math.max(-1, Math.min(1, x)) : 0) })) : undefined;
      if (message.discontinuity === true) { latestAudio=silence();normalizer.reset(); analyser.reset();hudFeed.reset(); active?.audio.reset(); outgoing?.audio.reset(); prepared?.audio.reset();multiView.seek(); }
      const normalized = playing ? frames?.flatMap((frame: SourcePcm) => normalizer.push(frame)) : [];
      normalized?.forEach((frame: SourcePcm, i: number) => songMap?.feedLive(frame.time, frame.pcm.subarray(0, 576), frame.pcm.subarray(576), 44100, i === 0 && message.discontinuity === true));
      for (const frame of normalized ?? (playing ? [{ time:position, pcm }] : [])) {
        const audio = analyser.analyse({left:frame.pcm.subarray(0,576),right:frame.pcm.subarray(576)});
        hudFeed.pushHop(frame);latestAudio=audio;
        active?.audio.push(audio); outgoing?.audio.push(audio); prepared?.audio.push(audio);multiView.feed(audio);
      }
      const action = director.update(position, playing, pcm, normalized, message.discontinuity === true);
      if (!sceneTiming.enabled&&!management.open && active && !outgoing && action.prepare && !loading && !prepared) { const index = candidate(); if (index !== null) void prepare(index, true); }
      if (!sceneTiming.enabled&&!management.open && autoPending && action.switch && prepared?.bitmap) commit();
      syncSceneClock();
    }
    if (perf.enabled) perf.record('host.audio.msg', performance.now() - audioStart);
    bridge.postMessage('ack');
  } else if(message.type==='track') {
    // Native track identity (docs/SONG-MAP.md): a 64-hex content id names the cache entry; without it the live map is not persisted.
    if (typeof message.id === 'string') void songMap?.openTrack({ id: message.id, source: null });
  } else if(message.type==='panel') {management.show(message.panel===1||message.panel===2?message.panel:0);
  } else if(message.type==='rate') {rateCurrent(message.delta===1?1:-1);
  } else if(message.type==='not-working') {markCurrent();
  } else if(message.type==='not-working-saved') {
    const request=marks.shift(),entry=message.entry;
    if(request&&entry?.sha256===catalog[request.index]?.sha256&&typeof entry.notWorking==='boolean'){
      catalog=catalog.map((p,i)=>i===request.index?{...p,notWorking:entry.notWorking}:p);
      eligibilityChanged();updateLabel();
      announce(`${catalog[request.index]!.name} · ${entry.notWorking?'marked not working; excluded from automatic selection':'restored to selection'}`);
    }
    if(marks.length)sendLibrary({op:'set-not-working',hash:catalog[marks[0]!.index]!.sha256,notWorking:marks[0]!.value});
  } else if(message.type==='rating-saved') {
    const request=ratings.shift(),entry=message.entry;
    if(request&&entry?.sha256===catalog[request.index]?.sha256&&typeof entry.canonical_path==='string'&&Number.isInteger(entry.rating)&&entry.rating>=1&&entry.rating<=5){
      const old=catalog[request.index]!;
      catalog=catalog.map((p,i)=>i===request.index?{...old,rating:entry.rating,fileName:entry.canonical_path.split('/').at(-1),url:localAssetUrl(entry.canonical_path,'presets',document.baseURI)}:p);
      eligibilityChanged();updateLabel();
      announce(`${old.name} · ${'★'.repeat(entry.rating)} · filename and Date modified saved`);management.refresh();
    }
    if(ratings.length)sendLibrary({op:'rate',hash:catalog[ratings[0]!.index]!.sha256,rating:ratings[0]!.value});
  } else if(message.type==='setups-loaded') {management.receive(message.type,message.setups);multiView.receiveSets(message.setups);
  } else if(message.type==='setups-saved') {
    // A save acknowledgement, not setup data: native and browser hosts send no setups. The manager's acknowledged list (the saved,
    // edited or deleted contents) refreshes Multiview; an acknowledgement that does echo its setups is used as sent.
    management.receive(message.type,message.setups);
    const acknowledged=Array.isArray(message.setups)?message.setups:management.acknowledgedSetups();
    if(acknowledged)multiView.receiveSets(acknowledged);
  } else if(message.type==='state-loaded'||message.type==='state-saved') {management.receive(message.type,{name:message.name,data:message.data});
  } else if(message.type==='play-folder') {management.playLastFolder();
  } else if(message.type==='library-error'&&(message.operation==='load-state'||message.operation==='save-state')) {management.receive(message.type,{name:message.name,message:message.message},message.operation);
  } else if(message.type==='library-error') {if(message.operation==='rate')ratings.length=0;if(message.operation==='set-not-working')marks.length=0;announce(`Library: ${message.message}`);management.receive(message.type,message.message,message.operation);
  } else if (message.type === 'next' || message.type === 'previous') {
    if(multiView.step(message.type==='next'?1:-1))return;
    const phase=clockPhase(), queued=phase?sceneCues.find(c=>c.ordinal===phase.ordinal+1):undefined;
    const clockNavigation=!!(phase&&isSceneKind(catalog[phase.index])&&setupOrder);
    const index=clockNavigation?stepSetup(selectionPool(),queued?.index??phase!.index,message.type==='next'?1:-1,message.type==='next'&&presets.shuffle)
      :message.type==='next'?(setupOrder?candidate():presets.next(selectionPool(presets.shuffle)))
      :setupOrder?stepSetup(eligiblePresets(catalog,setupOrder,false,0),presets.index,-1,false):presets.previous();
    if(index!==null)manualSelection(index,message.type==='next');
    else announce('No other eligible presets. Lower the shuffle rating or restore a preset in Preset Manager.');
  } else if (message.type === 'shuffle') {
    presets.shuffle = message.enabled === true; if (autoPending) cancelPrepared();
    eligibilityChanged();
    announce(`Preset shuffle ${presets.shuffle ? 'on' : 'off'}`);
  } else if (message.type === 'settings') {
    if (typeof message.shuffle === 'boolean' && presets.shuffle !== message.shuffle) { presets.shuffle = message.shuffle; if (autoPending) cancelPrepared(); }
    manualFade = message.manualFade !== false; autoFade = message.autoFade !== false;
    if(message.enabled===true&&!director.enabled)sequenceSuspended=false;
    director.configure(message.enabled === true, Number(message.bars));
    multiView.setAuto(message.enabled === true);
    transitionMode = Number.isInteger(message.transition) && message.transition >= 0 && message.transition < TRANSITION_COUNT ? message.transition : 1;
    fadeSpec = parseFadeFields(message);
    queueQuantize = Number.isInteger(message.queueQuantize) && message.queueQuantize >= 0 && message.queueQuantize < QUEUE_QUANTIZE_COUNT ? message.queueQuantize : 0;
    keepOld = message.keepOld !== false;
    if(Number.isInteger(message.minimumRating)&&message.minimumRating>=0&&message.minimumRating<=5)minimumRating=message.minimumRating;
    eligibilityChanged();
    if (!director.enabled && autoPending) cancelPrepared();
    announce(`Auto ${director.enabled ? (director.bars ? `${director.bars} bars` : 'adaptive 2–12 bars') : 'off'} · ${TRANSITIONS[transitionMode] ?? `Style ${transitionMode}`}`);
    const display = parseDisplayPrefs(message, sizer.prefs);
    if (display !== sizer.prefs) applyDisplay(display);
  }
});
function frame(now: number) {
  if (!perf.enabled) { frameBody(now); return; }
  if (lastRaf > 0) perf.record('host.raf.interval', now - lastRaf);
  lastRaf = now;
  const busyFrom = performance.now();
  frameBody(now);
  perf.record('host.raf.busy', performance.now() - busyFrom);
}
/** The perf segment of the timing line, recomputed twice a second. */
function perfSegment(now: number): string | null {
  if (!perf.enabled) return null;
  if (now - perfLineAt >= 500) { perfLineAt = now; perfLineText = perf.line(); }
  return perfLineText;
}
function frameBody(now: number) {
  if (closed) return;
  fps.display.mark(now);
  if (!flash.available) { status.textContent = 'Visualizer paused: flash protection unavailable'; document.body.classList.add('protection-error'); }
  if(multiView.frame(now)){
    const fpsText=fpsLabel.segment(now,{present:fps.present.read(now),display:fps.display.read(now),render:fps.render.read(now),clock:fps.clock.read(now)},sizer.prefs.showFps,playing&&hostVisible&&!document.hidden);
    // Composite submission FPS and pane frame age are separate channels: a smooth composite can still show stale pane frames.
    const age=multiView.frameAge,ageText=sizer.prefs.showFps&&playing&&age!==null?` · panes ${Math.round(age)} ms old`:'';
    const perfText=perfSegment(now);
    const line=`Multiview · ${multiView.bpm.toFixed(1)} BPM${fpsText?` · ${fpsText}`:''}${ageText}${perfText?` · ${perfText}`:''}`;
    if(timing.textContent!==line)timing.textContent=line;
    requestAnimationFrame(frame);return;
  }
  const bars = director.remainingBars;
  const phase=clockPhase();
  const queued=phase?sceneCues.find(c=>c.ordinal===phase.ordinal+1):undefined;
  const fresh = playing && now - lastAudio < 500;
  const visible = hostVisible && !document.hidden;
  const r = active?resolveSlot(active.index):sizer.resolve('avs');
  const fpsText = fpsLabel.segment(now, { present: fps.present.read(now), display: fps.display.read(now), render: fps.render.read(now), clock: fps.clock.read(now) }, sizer.prefs.showFps, playing && visible);
  const line = timingLabel({ autoEnabled: director.enabled, eligibleCount, clock: !!phase, sceneBpm: phase ? phase.bpm : sceneTiming.bpm, clockBarsLeft: phase ? phase.barsRemaining : 0,
    playing, queuedName: queued ? catalog[queued.index]!.name : null, clockEnabled: sceneTiming.enabled, sequenceSuspended, tempoLocked: director.tempo.locked, energy: director.energy,
    tempoBpm: director.tempo.bpm, remainingBars: bars, ready: !!prepared?.bitmap, loading, fps: fpsText, ...(sizer.prefs.showFps === 2 ? { resolution: describeResolved(r) } : {}), barBeat: phase && sceneClock ? sceneClock.barBeat(position) : null });
  const perfText = perfSegment(now), shown = perfText ? `${line} · ${perfText}` : line;
  if (shown !== timingText) timing.textContent = timingText = shown;
  const resized = canvas.width !== r.canvas.width || canvas.height !== r.canvas.height || presentedKey !== r.key;
  if (visible && active?.bitmap && (dirty || resized || (transition && position !== lastPresentedPosition))) {
    // No transition: sample the worker bitmap directly. A transition composites into a surface sized by the larger plate.
    let source: CanvasImageSource = active.bitmap, sw = active.bitmap.width, sh = active.bitmap.height;
    if (transition && outgoing?.bitmap) {
      const surface = transitionSurface({ render: { width: outgoing.bitmap.width, height: outgoing.bitmap.height }, kind: kindOf(outgoing.index) }, { render: { width: sw, height: sh }, kind: kindOf(active.index) }).size;
      if (composite.width !== surface.width || composite.height !== surface.height) { composite.width = surface.width; composite.height = surface.height; }
      const t = Math.max(0, (position - transitionStart) / transitionDuration);
      const transitionFrom = perf.enabled ? performance.now() : 0;
      transition.draw(cc, outgoing.bitmap, active.bitmap, t, surface.width, surface.height, envNow());
      if (perf.enabled) perf.record('host.transition', performance.now() - transitionFrom);
      if (t >= 1) { dispose(outgoing); outgoing = null; transition = null; }
      source = composite; sw = surface.width; sh = surface.height;
    }
    if (sizeCanvas(canvas, r)) flash.reset();
    const presentFrom = perf.enabled ? performance.now() : 0;
    flash.present(context, source, now / 1000, () => presenter.draw(context, source, { width: sw, height: sh }, r));
    if (perf.enabled) perf.record('host.present', performance.now() - presentFrom);
    dirty = false; lastPresentedPosition = position; presentedKey = r.key; fps.present.mark(now);
    if (!flash.available) { status.textContent = 'Visualizer paused: flash protection unavailable'; document.body.classList.add('protection-error'); }
    else document.body.classList.remove('protection-error');
  }
  if (fresh && director.enabled && !active && !loading && !prepared && now >= retryAfter&&!phase) { const index = candidate(); if (index !== null) void prepare(index, false); }
  if (fresh && visible) { if (active) render(active); if (outgoing && keepOld) render(outgoing); }
  // Paused seeks still update deterministic geometry without advancing an animation clock.
  else if(visible&&active&&isSceneKind(catalog[active.index])&&(active.renderedPosition!==position||active.renderRevision!==clockRevision||active.sized!==((s)=>`${s.width}x${s.height}`)(resolveSlot(active.index).render)))render(active);
  requestAnimationFrame(frame);
}
document.addEventListener('dblclick', () => {if(!management.open&&!multiView.controlsOpen)bridge?.postMessage('fullscreen');});
document.addEventListener('keydown', event => {
  // Stage timing toggle: Ctrl+Alt+P cycles off -> CPU timestamps -> GL-synchronised (distorts pipelining) -> off; Ctrl+Alt+Shift+P downloads the trace.
  if(event.ctrlKey&&event.altKey&&event.code==='KeyP'){event.preventDefault();if(event.repeat)return;
    if(event.shiftKey){perfTraceDownload();return;}
    const next=(perf.level===0?1:perf.level===1?2:0) as 0|1|2;perfSet(next);announce(next===0?'Stage timing off':next===1?'Stage timing on (CPU timestamps)':'Stage timing on (GL-synchronised: distorts pipelining)');return;}
  if(event.ctrlKey&&!event.altKey&&!event.shiftKey&&event.code==='F9'){event.preventDefault();if(!event.repeat)multiView.showControls();return;}
  if(multiView.controlsOpen)return;
  if(event.ctrlKey&&!event.altKey&&!event.shiftKey){const command=({F6:'show-manager',F7:'show-setups',F8:'play-folder'} as Record<string,string>)[event.code];if(command){event.preventDefault();if(!event.repeat)bridge?.postMessage(command);return;}}
  if(!event.ctrlKey&&!event.altKey&&!event.shiftKey&&(event.code==='F6'||event.code==='F7')){event.preventDefault();if(!event.repeat)bridge?.postMessage(event.code==='F7'?'rate-up':'rate-down');return;}
  if(!event.ctrlKey&&!event.altKey&&!event.shiftKey&&event.code==='F8'){event.preventDefault();if(!event.repeat)bridge?.postMessage('mark-not-working');return;}
  if(management.open){if(event.code==='Escape'){event.preventDefault();management.show(0);bridge?.postMessage('panel-close');}return;}
  if (event.code === 'F10' && event.shiftKey || event.code === 'ContextMenu') { event.preventDefault(); bridge?.postMessage('options'); return; }
  // Space activates a focused control (the embedded Multiview launcher, a checkbox, a field); only elsewhere is it play/pause.
  if (event.code === 'Space' && !event.repeat && !isInteractiveTarget(event.target)) { event.preventDefault(); bridge?.postMessage('play-pause'); }
});
window.addEventListener('pagehide', () => { closed = true;songMap?.close();stopDeviceWatch?.();management.dispose?.();multiView.close(); clearTimeout(announceTimer); cancelPrepared(); dispose(active); dispose(outgoing); });
bridge?.postMessage('host-ready');
const initial=eligiblePresets(catalog,wholeOrder,false,0)[0];
if(initial!==undefined)void prepare(initial,false);
else announce('No working presets available. Open Preset Manager to restore a preset.');
requestAnimationFrame(frame);
