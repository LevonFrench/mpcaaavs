import { defaultSettings, type SetupSettings } from './mpc-setups.ts';
import { TRANSITIONS } from './mpc-transition.ts';

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

interface BridgeActions {
  library(value:Message):Promise<Message>;
  playPause():void;
  fullscreen():void;
  options():void;
  notice(text:string):void;
  settings(value:SetupSettings):void;
}
/** Native protocol adapter; the visualizer and all preset rules remain in mpc-host. */
export class StandaloneBridge {
  private listeners = new Set<(event:MessageEvent)=>void>();
  private requests:Promise<void> = Promise.resolve();
  ready=false;
  panel=0;
  settings:SetupSettings={...defaultSettings};
  constructor(private actions:BridgeActions) {}
  addEventListener(type:'message',listener:(event:MessageEvent)=>void):void { if(type==='message')this.listeners.add(listener); }
  emit(data:Message):void {
    if(data.type==='settings'){
      this.settings={...this.settings,...data} as SetupSettings;
      this.actions.settings(this.settings);
    }
    for(const listener of this.listeners)listener(new MessageEvent('message',{data}));
  }
  configure(patch:Partial<SetupSettings>):void { this.library(()=>({op:'configure',settings:{...this.settings,...patch}})); }
  toggle(key:'shuffle'|'enabled'):void {this.library(()=>({op:'configure',settings:{...this.settings,[key]:!this.settings[key]}}));}
  private library(value:Message|(()=>Message)):void {
    this.requests=this.requests.then(async()=>{
      const request=typeof value==='function'?value():value;
      try{const response=await this.actions.library(request);this.emit(response);if(response.type==='library-error'){this.actions.notice(String(response.message));this.actions.settings(this.settings);}}
      catch(error){this.emit({type:'library-error',operation:request.op,message:String(error)});this.actions.notice(String(error));this.actions.settings(this.settings);}
    });
  }
  postMessage(message:string):void {
    if(message.startsWith('library:')){
      try{const value:unknown=JSON.parse(message.slice(8));if(value&&typeof value==='object'&&!Array.isArray(value))this.library(value as Message);}
      catch(error){this.actions.notice(String(error));}return;
    }
    if(message.startsWith('panel-state:')){this.panel=Number(message.slice(12))||0;return;}
    switch(message){
      case 'host-ready':this.ready=true;this.library({op:'load-settings'});break;
      case 'show-manager':this.panel=this.panel===1?0:1;this.emit({type:'panel',panel:this.panel});break;
      case 'show-setups':this.panel=this.panel===2?0:2;this.emit({type:'panel',panel:this.panel});break;
      case 'panel-close':this.panel=0;break;
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
  const settingsFields=['enabled','bars','shuffle','minimumRating','transition','beats','durationMs','keepOld','manualFade','autoFade'] as const;
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
    settings(value){
      for(const key of settingsFields){const input=element<HTMLInputElement|HTMLSelectElement>(`setting-${key}`);if(!input)continue;
        if(input instanceof HTMLInputElement&&input.type==='checkbox')input.checked=value[key]===true;else input.value=String(value[key]);}
      element<HTMLButtonElement>('player-shuffle').setAttribute('aria-pressed',String(value.shuffle));
      element<HTMLButtonElement>('player-auto').setAttribute('aria-pressed',String(value.enabled));
    },
  });
  (window as unknown as {aaavsBridge:StandaloneBridge}).aaavsBridge=bridge;
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
  });
  audio.addEventListener('playing',()=>{reset(true);notice('');play.textContent='Pause';});
  for(const event of ['pause','waiting','ended','seeking','emptied'])audio.addEventListener(event,()=>{reset(false);play.textContent=audio.paused?'Play':'Pause';});
  audio.addEventListener('seeked',()=>reset(!audio.paused&&!audio.ended&&audio.readyState>=3));
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
  element('player-manager').addEventListener('click',()=>bridge.postMessage('show-manager'));
  element('player-setups').addEventListener('click',()=>bridge.postMessage('show-setups'));
  element('player-options-button').addEventListener('click',()=>bridge.postMessage('options'));
  element('player-fullscreen').addEventListener('click',()=>void fullscreen());
  element('player-options-close').addEventListener('click',()=>options.close());
  const transition=element<HTMLSelectElement>('setting-transition');
  TRANSITIONS.forEach((label,index)=>{const item=document.createElement('option');item.value=String(index);item.textContent=label;transition.append(item);});
  for(const key of settingsFields)element(`setting-${key}`).addEventListener('change',()=>{
    const input=element<HTMLInputElement|HTMLSelectElement>(`setting-${key}`);
    const value=input instanceof HTMLInputElement&&input.type==='checkbox'?input.checked:Number(input.value);
    bridge.configure({[key]:value});
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
    if(bridge.ready){const batch=queue.take(position);bridge.emit({type:'audio',playing:active&&!audio.paused&&!audio.seeking,visible:!document.hidden,position,epoch,...batch});}
  }
  ticker=window.setInterval(tick,33);
  document.addEventListener('visibilitychange',()=>{reset(!document.hidden&&!audio.paused&&!audio.seeking);tick();});
  window.addEventListener('pagehide',()=>{
    disposed=true;playIntent++;window.clearInterval(ticker);audio.pause();reset(false);node?.disconnect();gain?.disconnect();
    if(context)void context.close();if(objectUrl)URL.revokeObjectURL(objectUrl);audio.removeAttribute('src');audio.load();
  },{once:true});
  bridge.emit({type:'settings',...defaultSettings});
  try{await import('./mpc-host.ts');}catch(error){notice(`Visualizer startup failed: ${String(error)}`);}
}

if(typeof document!=='undefined'&&document.getElementById('player-audio'))void startStandalonePlayer();
