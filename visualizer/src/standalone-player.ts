import { AUDIO_DURATION_MAX, BEATS_FROM_FADE, FADE_FROM_BEATS } from './mpc-contract.ts';
import { loadPrefs, parseDisplayPrefs, prefsToWire, savePrefs, type DisplayPrefs } from './mpc-display.ts';
import { defaultSettings, type SetupSettings } from './mpc-setups.ts';
import { TRANSITIONS } from './mpc-transition.ts';
import { contentId, decodeToSource, MAX_DECODE_SECONDS } from './song-map/decode.ts';
import { createHostSongMap, httpLibraryCall } from './song-map/host.ts';
import { createHostShowPacks, httpPackSource } from './show/pack-host.ts';

interface PcmPacket { epoch:number; time:number; sampleRate:number; samples:number; pcm:ArrayBuffer; discontinuity?:boolean }
interface AudioFrame { time:number; sampleRate:number; samples:number; pcm:number[] }
type Message = Record<string, unknown>;

/** Keeps source-time packets bounded and rejects frames from a previous file/seek. */
export class PlayerPcmQueue {
  private frames: AudioFrame[] = [];
  private epoch = 0;
  private contextOrigin = 0;
  private mediaOrigin = 0;
  private gap = true;
  reset(epoch:number, contextTime:number, mediaTime:number):void {
    this.epoch=epoch; this.contextOrigin=contextTime; this.mediaOrigin=mediaTime;
    this.frames=[]; this.gap=true;
  }
  push(packet:PcmPacket):void {
    if (packet.epoch!==this.epoch || !(packet.pcm instanceof ArrayBuffer) || packet.pcm.byteLength!==4608
      || !Number.isFinite(packet.time) || !Number.isInteger(packet.sampleRate) || packet.sampleRate<8000 || packet.sampleRate>384000
      || !Number.isInteger(packet.samples) || packet.samples<1 || packet.samples>576) return;
    const time=this.mediaOrigin+packet.time-this.contextOrigin;
    if(time<0 || !Number.isFinite(time))return;
    const previous=this.frames.at(-1);
    if(previous && time<=previous.time)return;
    this.frames.push({time,sampleRate:packet.sampleRate,samples:packet.samples,
      pcm:Array.from(new Float32Array(packet.pcm),value=>Number.isFinite(value)?Math.max(-1,Math.min(1,value)):0)});
    this.gap ||= packet.discontinuity===true;
    if(this.frames.length>64){this.frames.shift();this.gap=true;}
  }
  take(position:number):{frames:AudioFrame[];discontinuity:boolean;pcm:number[]} {
    const ready:AudioFrame[]=[];
    while(this.frames.length && this.frames[0]!.time<=position){
      const frame=this.frames.shift()!;
      if(position-frame.time<.25)ready.push(frame);else this.gap=true;
    }
    const discontinuity=this.gap;this.gap=false;
    return {frames:ready,discontinuity,pcm:ready.at(-1)?.pcm??new Array<number>(1152).fill(0)};
  }
}

/** Keys the library server persists (contract 2.3.6). Display preferences are device-local and never among them. */
const SETTINGS_KEYS=['enabled','bars','shuffle','minimumRating','transition','beats','durationMs','keepOld','manualFade','autoFade'] as const;
const FADE_KEYS=['fadeTiming','fadeRandomSet','fadeAnchor','queueQuantize'] as const;
const DISPLAY_KEYS=['quality','avsResolution','pixelArt','showFps','timingOverlay'] as const;
const isRecord=(value:unknown):value is Record<string,unknown>=>!!value&&typeof value==='object'&&!Array.isArray(value);
function storedPrefs():DisplayPrefs { try{return loadPrefs();}catch{return parseDisplayPrefs({});} }

interface BridgeActions {
  library(value:Message):Promise<Message>;
  playPause():void;
  fullscreen():void;
  options():void;
  notice(text:string):void;
  settings(value:SetupSettings,prefs:DisplayPrefs):void;
}
/** Native protocol adapter; the visualizer and all preset rules remain in mpc-host. */
export class StandaloneBridge {
  private listeners = new Set<(event:MessageEvent)=>void>();
  private requests:Promise<void> = Promise.resolve();
  ready=false;
  panel=0;
  settings:SetupSettings={...defaultSettings};
  /** Device-local display preferences (contract C-14); persisted by the Player, sent to the page as wire integers. */
  prefs:DisplayPrefs=storedPrefs();
  constructor(private actions:BridgeActions) {}
  addEventListener(type:'message',listener:(event:MessageEvent)=>void):void { if(type==='message')this.listeners.add(listener); }
  emit(data:Message):void {
    if(data.type==='settings'){
      // The fade fields are a full-state snapshot (absent means default); the legacy ten merge as before.
      const next:Record<string,unknown>={...this.settings};
      for(const key of FADE_KEYS)delete next[key];
      for(const key of [...SETTINGS_KEYS,...FADE_KEYS])if(data[key]!==undefined)next[key]=data[key];
      this.settings=next as unknown as SetupSettings;
      if(DISPLAY_KEYS.some(key=>data[key]!==undefined))this.prefs=parseDisplayPrefs(data,this.prefs);
      this.actions.settings(this.settings,this.prefs);
    }
    for(const listener of this.listeners)listener(new MessageEvent('message',{data}));
  }
  /** Library `configure` payload: settings only, with `fadeTiming` authoritative and `beats` always its legacy projection (C-03). */
  private payload(patch:Partial<SetupSettings>):Message {
    const merged:Record<string,unknown>={...this.settings,...patch};
    if(typeof patch.fadeTiming==='number')merged.beats=BEATS_FROM_FADE[patch.fadeTiming]??0;
    else if(typeof patch.beats==='number')merged.fadeTiming=FADE_FROM_BEATS[patch.beats]??0;
    const out:Record<string,unknown>={};
    for(const key of [...SETTINGS_KEYS,...FADE_KEYS])if(merged[key]!==undefined)out[key]=merged[key];
    return out;
  }
  configure(patch:Partial<SetupSettings>):void { this.library(()=>({op:'configure',settings:this.payload(patch)})); }
  toggle(key:'shuffle'|'enabled'):void {this.library(()=>({op:'configure',settings:this.payload({[key]:!this.settings[key]})}));}
  /** Apply a page-to-host `display:` patch as native does: clamp, persist, and re-send the settings snapshot. */
  private display(value:unknown):void {
    if(!isRecord(value))return;
    this.prefs=parseDisplayPrefs(value,this.prefs);
    try{savePrefs(this.prefs);}catch{/* storage may be unavailable; the choice still applies for this session */}
    this.emit({type:'settings',...this.settings,...prefsToWire(this.prefs)});
  }
  private library(value:Message|(()=>Message)):void {
    this.requests=this.requests.then(async()=>{
      const request=typeof value==='function'?value():value;
      try{const response=await this.actions.library(request);this.emit(response.type==='settings'?{...response,...prefsToWire(this.prefs)}:response);if(response.type==='library-error'){this.actions.notice(String(response.message));this.actions.settings(this.settings,this.prefs);}}
      catch(error){this.emit({type:'library-error',operation:request.op,message:String(error)});this.actions.notice(String(error));this.actions.settings(this.settings,this.prefs);}
    });
  }
  postMessage(message:string):void {
    if(message.startsWith('library:')){
      try{const value:unknown=JSON.parse(message.slice(8));if(value&&typeof value==='object'&&!Array.isArray(value))this.library(value as Message);}
      catch(error){this.actions.notice(String(error));}return;
    }
    if(message.startsWith('panel-state:')){this.panel=Number(message.slice(12))||0;return;}
    if(message.startsWith('display:')){
      if(message.length>512)return;
      try{this.display(JSON.parse(message.slice(8)));}catch{/* malformed patches are ignored, as native ignores them */}
      return;
    }
    switch(message){
      case 'host-ready':{
        const firstReady=!this.ready;this.ready=true;
        // Toolbar requests can precede the shared host's listener during the dynamic import.
        if(firstReady&&(this.panel===1||this.panel===2))this.emit({type:'panel',panel:this.panel});
        this.library({op:'load-settings'});break;
      }
      case 'show-manager':this.panel=this.panel===1?0:1;this.emit({type:'panel',panel:this.panel});break;
      case 'show-setups':this.panel=this.panel===2?0:2;this.emit({type:'panel',panel:this.panel});break;
      case 'panel-close':this.panel=0;break;
      case 'play-folder':this.emit({type:'play-folder'});break;
      case 'rate-up':this.emit({type:'rate',delta:1});break;
      case 'rate-down':this.emit({type:'rate',delta:-1});break;
      case 'mark-not-working':this.emit({type:'not-working'});break;
      case 'play-pause':this.actions.playPause();break;
      case 'fullscreen':this.actions.fullscreen();break;
      case 'options':this.actions.options();break;
      case 'bootstrap-error':this.actions.notice('Preset collection unavailable. Check the local server and reload.');break;
    }
  }
}

export async function startStandalonePlayer():Promise<void> {
  const element=<T extends HTMLElement>(id:string)=>document.getElementById(id) as T;
  const audio=element<HTMLAudioElement>('player-audio'), file=element<HTMLInputElement>('player-file');
  const seek=element<HTMLInputElement>('player-seek'), volume=element<HTMLInputElement>('player-volume');
  const play=element<HTMLButtonElement>('player-play'), options=element<HTMLDialogElement>('player-options');
  const note=element<HTMLElement>('player-notice'), name=element<HTMLElement>('player-track'), clock=element<HTMLElement>('player-clock');
  const queue=new PlayerPcmQueue();
  let context:AudioContext|null=null, node:AudioWorkletNode|null=null, gain:GainNode|null=null;
  let graph:Promise<void>|null=null, objectUrl:string|null=null, epoch=0, active=false, disposed=false, ticker=0, playIntent=0;
  const optional=<T extends HTMLElement>(id:string)=>document.getElementById(id) as T|null;
  const settingsFields=['enabled','bars','shuffle','minimumRating','transition','durationMs','keepOld','manualFade','autoFade','fadeTiming','fadeAnchor','queueQuantize'] as const;
  const displayFields=DISPLAY_KEYS;
  const notice=(text:string)=>{note.textContent=text;};
  const fullscreen=async()=>{try{if(document.fullscreenElement)await document.exitFullscreen();else await document.documentElement.requestFullscreen();}catch(error){notice(String(error));}};
  const bridge=new StandaloneBridge({
    async library(value){
      const response=await fetch('/api/aaavs/library',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify(value),signal:AbortSignal.timeout(15000)});
      const result:unknown=await response.json();
      if(!result||typeof result!=='object'||Array.isArray(result)||typeof (result as Message).type!=='string')throw Error(`Library server returned an invalid response (${response.status}).`);
      if(!response.ok&&(result as Message).type!=='library-error')throw Error(`Library request failed (${response.status}).`);
      return result as Message;
    },
    playPause:()=>void togglePlayback(),fullscreen:()=>void fullscreen(),options:()=>{if(!options.open)options.showModal();},notice,
    settings(value,prefs){
      const fadeTiming=Number.isInteger(value.fadeTiming)?value.fadeTiming!:(FADE_FROM_BEATS[value.beats]??0);
      const shown:Record<string,unknown>={...value,fadeTiming,fadeAnchor:value.fadeAnchor??0,queueQuantize:value.queueQuantize??0};
      for(const key of settingsFields){const input=optional<HTMLInputElement|HTMLSelectElement>(`setting-${key}`);if(!input)continue;
        if(input instanceof HTMLInputElement&&input.type==='checkbox')input.checked=shown[key]===true;else input.value=String(shown[key]);}
      // Random timing mask: one checkbox per concrete duration, meaningful only while Random is selected.
      const mask=Number.isInteger(value.fadeRandomSet)?value.fadeRandomSet!:31;
      for(let bit=0;bit<5;bit++){const box=optional<HTMLInputElement>(`setting-fadeSet${bit}`);if(!box)continue;box.checked=((mask>>bit)&1)===1;box.disabled=fadeTiming!==6;}
      const wire:Record<string,number>=prefsToWire(prefs);
      for(const key of displayFields){const input=optional<HTMLSelectElement>(`setting-${key}`);if(input)input.value=String(wire[key]);}
      element<HTMLButtonElement>('player-shuffle').setAttribute('aria-pressed',String(value.shuffle));
      element<HTMLButtonElement>('player-auto').setAttribute('aria-pressed',String(value.enabled));
    },
  });
  (window as unknown as {aaavsBridge:StandaloneBridge}).aaavsBridge=bridge;
  // The song map: a background scan of each opened file, shared with the host and shows through window.aaavsSongMap.
  const songMap=createHostSongMap({call:httpLibraryCall(),now:()=>performance.now()});
  (window as unknown as {aaavsSongMap:unknown}).aaavsSongMap=songMap;
  // The private show asset pack named by the device-local setting (none by default), read through the library server.
  (window as unknown as {aaavsShowPacks:unknown}).aaavsShowPacks=createHostShowPacks({source:id=>httpPackSource(id)});
  let fileToken=0;
  /** Cache lookup by content hash, then decode and scan on a miss. Never blocks playback; a superseded file is abandoned. */
  async function startSongMap(selected:File,token:number):Promise<void> {
    if(!songMap)return;
    const generation=songMap.hold();
    try{
      const duration=await new Promise<number>(resolve=>{
        if(audio.readyState>=1)resolve(audio.duration);
        else{const done=()=>resolve(audio.duration);audio.addEventListener('loadedmetadata',done,{once:true});audio.addEventListener('error',done,{once:true});}
      });
      if(token!==fileToken)return;
      if(!Number.isFinite(duration)||duration>MAX_DECODE_SECONDS){songMap.release(generation,'File too long or unreadable for the browser decoder; live map only');return;}
      const bytes=await selected.arrayBuffer();
      if(token!==fileToken)return;
      const id=await contentId(bytes);
      if(token!==fileToken)return;
      await songMap.openTrack({id,source:()=>decodeToSource(bytes),playhead:()=>audio.currentTime});
    }catch(error){if(token===fileToken)songMap.release(generation,String(error));}
  }
  function reset(running:boolean):void {
    active=running;epoch++;
    queue.reset(epoch,context?.currentTime??0,Number.isFinite(audio.currentTime)?audio.currentTime:0);
    node?.port.postMessage({type:'reset',epoch,active:running});
  }
  async function ensureGraph():Promise<void> {
    if(graph)return graph;
    graph=(async()=>{
      context=new AudioContext({latencyHint:'interactive'});
      await context.audioWorklet.addModule(new URL('./player-pcm.worklet.js',import.meta.url));
      if(disposed){await context.close();return;}
      node=new AudioWorkletNode(context,'aaavs-player-pcm',{numberOfInputs:1,numberOfOutputs:1,outputChannelCount:[2],channelCount:2,channelCountMode:'explicit'});
      node.port.onmessage=({data})=>{
        if(data?.type!=='pcm'||!(data.pcm instanceof ArrayBuffer))return;
        if(active&&!disposed)queue.push(data as PcmPacket);
        node?.port.postMessage({type:'recycle',pcm:data.pcm},[data.pcm]);
      };
      gain=context.createGain();gain.gain.value=Number(volume.value);
      // Creating the source reroutes media playback. There is one output path,
      // through the tap and gain, with no second direct-to-destination connection.
      context.createMediaElementSource(audio).connect(node).connect(gain).connect(context.destination);
    })().catch(error=>{graph=null;if(context)void context.close();context=null;notice(`Audio input unavailable: ${String(error)}`);throw error;});
    return graph;
  }
  async function togglePlayback():Promise<void> {
    const intent=++playIntent;
    if(!audio.src){file.click();return;}
    if(!audio.paused){audio.pause();return;}
    try{await ensureGraph();if(disposed||intent!==playIntent)return;await context!.resume();if(disposed||intent!==playIntent)return;await audio.play();}catch(error){notice(String(error));}
  }
  file.addEventListener('change',()=>{
    const selected=file.files?.[0];if(!selected)return;
    playIntent++;
    audio.pause();reset(false);
    if(objectUrl)URL.revokeObjectURL(objectUrl);
    objectUrl=URL.createObjectURL(selected);audio.src=objectUrl;audio.playbackRate=1;audio.load();
    name.textContent=selected.name;notice('Ready. Press Play.');file.value='';
    void startSongMap(selected,++fileToken);
  });
  audio.addEventListener('playing',()=>{reset(true);notice('');play.textContent='Pause';});
  for(const event of ['pause','waiting','ended','seeking','emptied'])audio.addEventListener(event,()=>{reset(false);play.textContent=audio.paused?'Play':'Pause';});
  audio.addEventListener('seeked',()=>{songMap?.seek(audio.currentTime);reset(!audio.paused&&!audio.ended&&audio.readyState>=3);});
  audio.addEventListener('ratechange',()=>{if(audio.playbackRate!==1){audio.playbackRate=1;notice('The shared visualizer currently uses normal playback speed.');}reset(!audio.paused&&!audio.seeking);});
  audio.addEventListener('error',()=>{reset(false);notice('This audio file could not be decoded by the browser. Try a supported audio format.');});
  audio.addEventListener('loadedmetadata',()=>{seek.disabled=!Number.isFinite(audio.duration);seek.max=Number.isFinite(audio.duration)?String(audio.duration):'0';});
  play.addEventListener('click',()=>void togglePlayback());
  element('player-open').addEventListener('click',()=>file.click());
  element('player-stop').addEventListener('click',()=>{playIntent++;audio.pause();if(audio.src)audio.currentTime=0;reset(false);});
  seek.addEventListener('input',()=>{if(audio.src&&Number.isFinite(audio.duration)){reset(false);audio.currentTime=Math.max(0,Math.min(audio.duration,Number(seek.value)));}});
  volume.addEventListener('input',()=>{if(gain)gain.gain.setValueAtTime(Number(volume.value),context!.currentTime);});
  element('player-previous').addEventListener('click',()=>bridge.emit({type:'previous'}));
  element('player-next').addEventListener('click',()=>bridge.emit({type:'next'}));
  element('player-shuffle').addEventListener('click',()=>bridge.toggle('shuffle'));
  element('player-auto').addEventListener('click',()=>bridge.toggle('enabled'));
  optional('player-play-folder')?.addEventListener('click',()=>bridge.postMessage('play-folder'));
  element('player-manager').addEventListener('click',()=>bridge.postMessage('show-manager'));
  element('player-setups').addEventListener('click',()=>bridge.postMessage('show-setups'));
  element('player-options-button').addEventListener('click',()=>bridge.postMessage('options'));
  element('player-fullscreen').addEventListener('click',()=>void fullscreen());
  element('player-options-close').addEventListener('click',()=>options.close());
  const transition=element<HTMLSelectElement>('setting-transition');
  TRANSITIONS.forEach((label,index)=>{const item=document.createElement('option');item.value=String(index);item.textContent=label;transition.append(item);});
  for(const key of settingsFields)optional<HTMLInputElement|HTMLSelectElement>(`setting-${key}`)?.addEventListener('change',()=>{
    const input=optional<HTMLInputElement|HTMLSelectElement>(`setting-${key}`)!;
    const value=input instanceof HTMLInputElement&&input.type==='checkbox'?input.checked:Number(input.value);
    bridge.configure({[key]:value});
  });
  // The Random mask has dedicated binding: bit i is `setting-fadeSet<i>`, and the last set bit can never be cleared.
  for(let bit=0;bit<5;bit++)optional<HTMLInputElement>(`setting-fadeSet${bit}`)?.addEventListener('change',()=>{
    let mask=0;const known=bridge.settings.fadeRandomSet??31;
    for(let i=0;i<5;i++){const box=optional<HTMLInputElement>(`setting-fadeSet${i}`);if(box?box.checked:(known>>i)&1)mask|=1<<i;}
    if(!mask){mask=1<<bit;optional<HTMLInputElement>(`setting-fadeSet${bit}`)!.checked=true;}
    bridge.configure({fadeRandomSet:mask});
  });
  // Display preferences take the same path as native: a `display:` string that the bridge persists and echoes.
  for(const key of displayFields)optional<HTMLSelectElement>(`setting-${key}`)?.addEventListener('change',()=>{
    const value=Number(optional<HTMLSelectElement>(`setting-${key}`)!.value);
    if(Number.isInteger(value))bridge.postMessage(`display:${JSON.stringify({[key]:value})}`);
  });
  // Keep typing/space in forms local; the shared host owns the documented F keys.
  document.addEventListener('keydown',event=>{const target=event.target as HTMLElement|null;
    if((options.open||target?.matches('input,select,textarea,button'))&&event.code==='Space')event.stopImmediatePropagation();},true);
  document.addEventListener('dblclick',event=>{if(!(event.target as HTMLElement|null)?.closest('#stage'))event.stopImmediatePropagation();},true);
  function time(value:number):string {const seconds=Math.max(0,Math.floor(Number.isFinite(value)?value:0));return `${Math.floor(seconds/60)}:${String(seconds%60).padStart(2,'0')}`;}
  function tick():void {
    if(disposed)return;
    const position=Number.isFinite(audio.currentTime)?audio.currentTime:0;
    seek.value=String(position);clock.textContent=`${time(position)} / ${time(audio.duration)}`;
    if(bridge.ready){
      const batch=queue.take(position),duration=Number.isFinite(audio.duration)&&audio.duration>0&&audio.duration<=AUDIO_DURATION_MAX?audio.duration:null;
      bridge.emit({type:'audio',playing:active&&!audio.paused&&!audio.seeking,visible:!document.hidden,position,epoch,...(duration===null?{}:{duration}),...batch});
    }
  }
  ticker=window.setInterval(tick,33);
  document.addEventListener('visibilitychange',()=>{reset(!document.hidden&&!audio.paused&&!audio.seeking);tick();});
  window.addEventListener('pagehide',()=>{
    disposed=true;playIntent++;fileToken++;songMap?.close();window.clearInterval(ticker);audio.pause();reset(false);node?.disconnect();gain?.disconnect();
    if(context)void context.close();if(objectUrl)URL.revokeObjectURL(objectUrl);audio.removeAttribute('src');audio.load();
  },{once:true});
  bridge.emit({type:'settings',...defaultSettings,...prefsToWire(bridge.prefs)});
  try{await import('./mpc-host.ts');}catch(error){notice(`Visualizer startup failed: ${String(error)}`);}
}

if(typeof document!=='undefined'&&document.getElementById('player-audio'))void startStandalonePlayer();
