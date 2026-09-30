import { build } from 'esbuild';
import assert from 'node:assert/strict';
import vm from 'node:vm';
import {readFileSync} from 'node:fs';

// Device-local storage stand-in: the bridge restores and persists display preferences through it (mpc-display.ts, try/catch inside).
const storage=new Map();
globalThis.localStorage={getItem:key=>storage.has(key)?storage.get(key):null,setItem:(key,value)=>{storage.set(key,String(value));},removeItem:key=>{storage.delete(key);}};

const adapter=await build({entryPoints:['src/standalone-player.ts'],bundle:true,format:'esm',write:false,plugins:[{name:'headless-host',setup(build){build.onResolve({filter:/mpc-host\.ts$/},()=>({path:'host',namespace:'test'}));build.onLoad({filter:/.*/,namespace:'test'},()=>({contents:'export {};',loader:'js'}));}}]});
const {PlayerPcmQueue,StandaloneBridge,startStandalonePlayer}=await import(`data:text/javascript;base64,${Buffer.from(adapter.outputFiles[0].text).toString('base64')}`);
const packet=(epoch,time,sampleRate=48000,samples=576)=>({epoch,time,sampleRate,samples,pcm:new Float32Array(1152).fill(.25).buffer});
const queue=new PlayerPcmQueue();queue.reset(1,100,10);
queue.push(packet(0,100));queue.push(packet(1,100));queue.push(packet(1,100.012));
let batch=queue.take(10.006);assert.equal(batch.frames.length,1);assert.equal(batch.frames[0].time,10);assert.equal(batch.frames[0].sampleRate,48000);assert.equal(batch.frames[0].pcm[600],.25);assert.equal(batch.discontinuity,true);
batch=queue.take(10.02);assert.equal(batch.frames.length,1);assert.equal(batch.discontinuity,false);
queue.reset(2,120,50);queue.push(packet(1,120));assert.equal(queue.take(50).frames.length,0);
queue.push(packet(2,120,96000,128));assert.equal(queue.take(50).frames[0].samples,128);
queue.push(packet(2,120.012));assert.equal(queue.take(51).frames.length,0);assert.equal(queue.take(51).discontinuity,false);
queue.reset(3,0,0);for(let i=0;i<80;i++)queue.push(packet(3,i*.001));batch=queue.take(.1);assert.equal(batch.frames.length,64);assert.equal(batch.discontinuity,true);
queue.reset(4,0,0);queue.push(packet(4,1));assert.equal(queue.take(.9).frames.length,0);assert.equal(queue.take(1).frames.length,1);

const requests=[],events=[],notices=[],settings=[];let playing=0,full=0,options=0;
const bridge=new StandaloneBridge({async library(value){requests.push(value);return value.op==='load-settings'?{type:'settings',shuffle:true,minimumRating:3}:{type:'settings',...value.settings};},playPause(){playing++;},fullscreen(){full++;},options(){options++;},notice(value){notices.push(value);},settings(value){settings.push(value);}});
bridge.addEventListener('message',event=>events.push(event.data));bridge.postMessage('host-ready');await new Promise(resolve=>setTimeout(resolve,0));assert.equal(requests[0].op,'load-settings');assert.equal(bridge.settings.minimumRating,3);
bridge.postMessage('rate-up');bridge.postMessage('rate-down');bridge.postMessage('mark-not-working');bridge.postMessage('show-manager');bridge.postMessage('show-manager');bridge.postMessage('show-setups');bridge.postMessage('panel-state:2');bridge.postMessage('panel-close');
assert.equal(bridge.panel,0);assert.deepEqual(events.filter(x=>x.type==='rate').map(x=>x.delta),[1,-1]);assert.ok(events.some(x=>x.type==='not-working'));assert.deepEqual(events.filter(x=>x.type==='panel').map(x=>x.panel),[1,0,2]);
bridge.configure({transition:15});await new Promise(resolve=>setTimeout(resolve,0));assert.equal(requests[1].settings.minimumRating,3);assert.equal(bridge.settings.transition,15);
bridge.configure({minimumRating:4});bridge.configure({bars:8});bridge.toggle('shuffle');bridge.toggle('shuffle');await new Promise(resolve=>setTimeout(resolve,0));
assert.equal(bridge.settings.minimumRating,4);assert.equal(bridge.settings.bars,8);assert.equal(bridge.settings.shuffle,true);assert.equal(requests.at(-1).settings.minimumRating,4);
bridge.postMessage('play-pause');bridge.postMessage('fullscreen');bridge.postMessage('options');assert.deepEqual([playing,full,options],[1,1,1]);

// Early toolbar clicks precede the dynamically imported host listener: replay only the final open panel at first readiness.
for(const [commands,wanted] of [
  [['show-manager'],1],[['show-setups'],2],[['show-manager','show-setups'],2],[['show-setups','show-manager'],1],
  [['show-manager','show-manager'],0],[['show-setups','panel-close'],0],
  [['panel-state:3'],0],[['panel-state:-1'],0],[['panel-state:1.5'],0],[['panel-state:Infinity'],0],
]){
  const seen=[];
  const early=new StandaloneBridge({library:async()=>({type:'settings'}),playPause(){},fullscreen(){},options(){},notice(){},settings(){}});
  for(const command of commands)early.postMessage(command);
  assert.equal(early.ready,false,'toolbar clicks do not make the host ready');
  early.addEventListener('message',event=>seen.push(event.data));
  early.postMessage('host-ready');
  assert.deepEqual(seen.filter(x=>x.type==='panel'),wanted?[{type:'panel',panel:wanted}]:[],`${commands}: early open replays, prior close/invalid stays closed`);
  early.postMessage('host-ready');
  assert.equal(seen.filter(x=>x.type==='panel').length,wanted?1:0,'repeated readiness never replays the early panel twice');
  if(wanted){early.postMessage(wanted===1?'show-manager':'show-setups');assert.equal(early.panel,0,'the next toolbar click closes the panel actually opened');}
}

// ---- Bridge v2 behaviour: play-folder, display:, fade fields and duration (contract 2.2.3, 2.2.4, 2.3.6) ----
const STORAGE_KEY='aaavs.mpcDisplay.v1';
const LEGACY_KEYS=['enabled','bars','shuffle','minimumRating','transition','beats','durationMs','keepOld','manualFade','autoFade'];
const FADE_KEYS=['fadeTiming','fadeRandomSet','fadeAnchor','queueQuantize'];
const DISPLAY_WIRE=['quality','avsResolution','pixelArt','showFps','timingOverlay'];
const fileSettings={type:'settings',enabled:true,bars:0,shuffle:false,minimumRating:0,transition:1,beats:2,durationMs:2000,keepOld:true,manualFade:true,autoFade:true};
{
  const seen=[],sent=[],reqs=[];
  const v2=new StandaloneBridge({async library(value){reqs.push(value);return value.op==='configure'?{type:'settings',...value.settings}:value.op==='load-settings'?{...fileSettings}:{type:'library-error',message:'refused',operation:value.op};},
    playPause(){},fullscreen(){},options(){},notice(){},settings(value,prefs){seen.push({value,prefs});}});
  v2.addEventListener('message',event=>sent.push(event.data));
  const tick=()=>new Promise(resolve=>setTimeout(resolve,0));
  const last=type=>sent.filter(x=>x.type===type).at(-1);
  // A settings response from the library always carries the current display wire integers, like the native snapshot.
  v2.postMessage('host-ready');await tick();
  const loaded=last('settings');
  assert.deepEqual(DISPLAY_WIRE.map(key=>loaded[key]),[0,0,0,1,0],'defaults: auto, classic, auto, FPS on, overlay on hover');
  assert.equal(seen.at(-1).prefs.showFps,1);assert.equal(loaded.fadeTiming,undefined,'an old settings file carries no fade fields');
  // play-folder mirrors native: the page posts the string, the bridge answers with the message.
  v2.postMessage('play-folder');assert.equal(sent.filter(x=>x.type==='play-folder').length,1);assert.deepEqual(last('play-folder'),{type:'play-folder'});
  // configure: settings only; fadeTiming is authoritative and beats is always its projection (C-03).
  const payload=async patch=>{v2.configure(patch);await tick();return reqs.at(-1).settings;};
  let body=await payload({fadeTiming:4});assert.equal(body.fadeTiming,4);assert.equal(body.beats,4);
  for(const [fade,beats] of [[0,0],[1,0],[2,1],[3,2],[4,4],[5,0],[6,0]]){body=await payload({fadeTiming:fade});assert.equal(body.beats,beats,`fadeTiming ${fade} projects to beats ${beats}`);}
  body=await payload({beats:2});assert.equal(body.fadeTiming,3,'a legacy beats patch derives fadeTiming');assert.equal(body.beats,2);
  body=await payload({fadeRandomSet:19,fadeAnchor:2,queueQuantize:3});
  assert.deepEqual(FADE_KEYS.map(key=>body[key]),[3,19,2,3]);
  assert.ok(Object.keys(body).every(key=>[...LEGACY_KEYS,...FADE_KEYS].includes(key)),'no type or display key reaches the library');
  assert.equal(reqs.at(-1).op,'configure');
  v2.toggle('shuffle');await tick();assert.equal(reqs.at(-1).settings.shuffle,true);assert.equal(reqs.at(-1).settings.fadeRandomSet,19);
  // The fade fields are a full snapshot: a settings message without them resets them; the legacy ten still merge.
  v2.emit({type:'settings',enabled:false});
  assert.equal(v2.settings.enabled,false);assert.equal(v2.settings.bars,0);assert.ok(FADE_KEYS.every(key=>!(key in v2.settings)),'absent fade fields mean defaults');
  assert.ok(!('type' in v2.settings));
  // display: clamps, persists, and answers with the whole snapshot including the wire integers.
  v2.postMessage('display:{"quality":3,"showFps":2}');
  let snapshot=last('settings');
  assert.deepEqual(DISPLAY_WIRE.map(key=>snapshot[key]),[3,0,0,2,0]);assert.equal(snapshot.enabled,false);
  assert.deepEqual(JSON.parse(storage.get(STORAGE_KEY)),{quality:'high',avsResolution:'classic',pixelArt:'auto',showFps:'detail',timingOverlay:'hover'});
  assert.equal(seen.at(-1).prefs.quality,'high');assert.ok(DISPLAY_WIRE.every(key=>!(key in v2.settings)),'display prefs never enter the library settings');
  v2.postMessage('display:{"timingOverlay":1,"pixelArt":2,"avsResolution":1}');
  assert.deepEqual(DISPLAY_WIRE.map(key=>last('settings')[key]),[3,1,2,2,1]);
  const before=sent.length;
  for(const bad of ['display:{','display:[1]','display:null','display:7','display:'+'x'.repeat(600),'display:{"quality":"bogus"}'.replace('bogus','x'.repeat(600))])v2.postMessage(bad);
  assert.equal(sent.length,before,'malformed or oversized patches emit nothing');
  v2.postMessage('display:{"quality":9,"showFps":-1,"timingOverlay":1.5,"pixelArt":"1"}');
  assert.deepEqual(DISPLAY_WIRE.map(key=>last('settings')[key]),[3,1,2,2,1],'out-of-range, fractional and non-name values keep the current value');
  // Preferences survive a restart through storage, and unavailable storage falls back to defaults.
  const restored=new StandaloneBridge({library:async()=>({type:'settings'}),playPause(){},fullscreen(){},options(){},notice(){},settings(){}});
  assert.deepEqual([restored.prefs.quality,restored.prefs.avsResolution,restored.prefs.pixelArt,restored.prefs.showFps,restored.prefs.timingOverlay],['high','crisp','smooth',2,1]);
  const original=globalThis.localStorage;globalThis.localStorage={getItem(){throw Error('blocked');},setItem(){throw Error('blocked');}};
  const blocked=new StandaloneBridge({library:async()=>({type:'settings'}),playPause(){},fullscreen(){},options(){},notice(){},settings(){}});
  assert.equal(blocked.prefs.quality,'auto');blocked.postMessage('display:{"quality":1}');assert.equal(blocked.prefs.quality,'performance','the choice still applies for the session when storage is blocked');
  globalThis.localStorage=original;storage.delete(STORAGE_KEY);
}

// ---- Generic state ops and message hygiene: the bridge forwards them verbatim and never interprets them ----
{
  const sent=[],reqs=[],notes=[];
  const bridge2=new StandaloneBridge({async library(value){reqs.push(value);
      if(value.op==='load-state')return value.name==='folders'?{type:'state-loaded',name:'folders',data:{version:1}}:{type:'library-error',operation:'load-state',message:'Unknown library request'};
      if(value.op==='save-state')return {type:'state-saved',name:value.name};
      return {type:'library-error',operation:value.op,message:'unsupported'};},
    playPause(){},fullscreen(){},options(){},notice(text){notes.push(text);},settings(){}});
  bridge2.addEventListener('message',event=>sent.push(event.data));
  const flush=()=>new Promise(resolve=>setTimeout(resolve,0));
  bridge2.postMessage('library:{"op":"load-state","name":"folders"}');await flush();
  assert.deepEqual(reqs.at(-1),{op:'load-state',name:'folders'},'load-state is forwarded as sent');
  assert.deepEqual(sent.at(-1),{type:'state-loaded',name:'folders',data:{version:1}},'the host answer reaches the page unchanged');
  bridge2.postMessage('library:{"op":"save-state","name":"stats","data":{"version":1,"plays":{}}}');await flush();
  assert.deepEqual(reqs.at(-1).data,{version:1,plays:{}});assert.deepEqual(sent.at(-1),{type:'state-saved',name:'stats'});
  // An old server answers Unknown library request: the error is passed on (the page decides to stay session-only) and settings are re-shown.
  bridge2.postMessage('library:{"op":"load-state","name":"stats"}');await flush();
  assert.equal(sent.at(-1).type,'library-error');assert.equal(sent.at(-1).operation,'load-state');
  // Non-object and malformed library payloads are dropped without a request; nothing throws.
  const count=reqs.length;
  for(const bad of ['library:','library:{','library:[]','library:null','library:7','library:"x"'])bridge2.postMessage(bad);
  await flush();assert.equal(reqs.length,count,'malformed library strings issue no request');
  // Commands are exact strings: near misses do nothing.
  const before=sent.length;
  for(const near of ['play-folder ','Play-Folder','play-folder:1','','display','displays:{}','host-ready '])bridge2.postMessage(near);
  await flush();assert.equal(sent.length,before,'near-miss messages emit nothing');assert.equal(reqs.length,count);
}

// ---- The real standalone.html against a small fake DOM: every id the adapter needs exists, the null guards hold, the mask is bound ----
{
  const html=readFileSync(new URL('../standalone.html',import.meta.url),'utf8');
  class FakeElement{
    constructor(tag,attrs){this.tag=tag;this.id=attrs.id;this.listeners={};this.attrs={};this.children=[];this.textContent='';this.type=attrs.type??'';
      this.value=attrs.value??(tag==='select'?'0':'');this.checked=attrs.checked;this.disabled=attrs.disabled;this.open=false;this.paused=true;this.ended=false;this.seeking=false;this.readyState=0;this.currentTime=0;this.duration=NaN;this.playbackRate=1;this.src='';this.max='0';this.files=null;}
    addEventListener(type,fn){(this.listeners[type]??=[]).push(fn);}
    dispatch(type){for(const fn of this.listeners[type]??[])fn({target:this});}
    setAttribute(key,value){this.attrs[key]=value;} removeAttribute(){} append(child){this.children.push(child);} click(){this.dispatch('click');}
    showModal(){this.open=true;} close(){this.open=false;} pause(){this.paused=true;} load(){} matches(){return false;} closest(){return null;}
  }
  class FakeInput extends FakeElement{}
  globalThis.HTMLInputElement=FakeInput;
  const build=(omit=[])=>{
    const elements=new Map();
    for(const match of html.matchAll(/<(\w+)([^>]*?)>/g)){
      const attrs=match[2],id=/\sid="([^"]+)"/.exec(attrs)?.[1];if(!id||omit.includes(id))continue;
      const type=/\stype="(\w+)"/.exec(attrs)?.[1]??'',value=/\svalue="([^"]*)"/.exec(attrs)?.[1];
      const element=new (match[1]==='input'?FakeInput:FakeElement)(match[1],{id,type,value,checked:/\schecked(?:\s|$)/.test(attrs),disabled:/\sdisabled(?:\s|$)/.test(attrs)});
      elements.set(id,element);
    }
    return elements;
  };
  const saved={};
  const run=async(omit)=>{
    const elements=build(omit),requests=[],bodies=[];let store={...fileSettings},tickFn=null,pagehide=null;
    const documentListeners={};
    globalThis.window=globalThis;saved.setInterval??=globalThis.setInterval;saved.clearInterval??=globalThis.clearInterval;
    globalThis.document={hidden:false,fullscreenElement:null,documentElement:{requestFullscreen:async()=>{}},getElementById:id=>elements.get(id)??null,createElement:tag=>new FakeElement(tag,{}),addEventListener:(type,fn)=>{(documentListeners[type]??=[]).push(fn);}};
    globalThis.setInterval=fn=>{tickFn=fn;return 7;};globalThis.clearInterval=()=>{};
    globalThis.addEventListener=(type,fn)=>{if(type==='pagehide')pagehide=fn;};
    globalThis.fetch=async(url,init)=>{
      const request=JSON.parse(init.body);requests.push(request);
      let response;
      if(request.op==='configure'){store={type:'settings',...request.settings};response=store;}
      else if(request.op==='load-settings')response=store;else response={type:'library-error',operation:request.op,message:'unsupported'};
      return {ok:response.type!=='library-error',status:200,json:async()=>response};
    };
    await startStandalonePlayer();
    const bridge=globalThis.aaavsBridge,events=[];bridge.addEventListener('message',event=>events.push(event.data));
    const flush=async()=>{for(let i=0;i<4;i++)await new Promise(resolve=>setTimeout(resolve,0));};
    return {elements,requests,events,bridge,flush,tick:()=>tickFn(),hide:()=>pagehide&&pagehide(),get store(){return store;}};
  };
  storage.clear();
  const app=await run([]);
  const {elements,requests,events,bridge,flush}=app;
  const el=id=>elements.get(id);
  // Startup carries the display wire integers and the transition list is filled from the shared table.
  assert.ok(el('setting-transition').children.length>=16);
  bridge.postMessage('host-ready');await flush();
  assert.equal(requests[0].op,'load-settings');
  assert.equal(el('setting-fadeTiming').value,'3','an old file with beats 2 shows fadeTiming 2 beats');
  assert.equal(el('setting-fadeAnchor').value,'0');assert.equal(el('setting-queueQuantize').value,'0');
  assert.ok([0,1,2,3,4].every(bit=>el(`setting-fadeSet${bit}`).checked&&el(`setting-fadeSet${bit}`).disabled),'the mask is shown, enabled only for Random');
  assert.deepEqual(['quality','avsResolution','pixelArt','showFps','timingOverlay'].map(key=>el(`setting-${key}`).value),['0','0','0','1','0']);
  // Changing Transition timing goes through configure with fadeTiming and the legacy projection.
  el('setting-fadeTiming').value='6';el('setting-fadeTiming').dispatch('change');await flush();
  let sent=requests.at(-1);assert.equal(sent.op,'configure');assert.equal(sent.settings.fadeTiming,6);assert.equal(sent.settings.beats,0);
  assert.equal(el('setting-fadeTiming').value,'6');assert.ok([0,1,2,3,4].every(bit=>!el(`setting-fadeSet${bit}`).disabled),'Random enables the mask');
  // The mask: bit i is checkbox i, and the last set bit can never be cleared.
  const toggle=async(bit,checked)=>{el(`setting-fadeSet${bit}`).checked=checked;el(`setting-fadeSet${bit}`).dispatch('change');await flush();return requests.at(-1).settings.fadeRandomSet;};
  assert.equal(await toggle(0,false),30);assert.equal(await toggle(1,false),28);assert.equal(await toggle(2,false),24);assert.equal(await toggle(3,false),16);
  const count=requests.length;
  assert.equal(await toggle(4,false),16,'clearing the last bit is refused');assert.equal(el('setting-fadeSet4').checked,true,'and the box is restored');
  assert.equal(await toggle(0,true),17);assert.equal(el('setting-fadeSet0').checked,true);
  assert.ok(requests.length>count);
  // Anchor and quantize are plain settings fields.
  el('setting-fadeAnchor').value='2';el('setting-fadeAnchor').dispatch('change');await flush();assert.equal(requests.at(-1).settings.fadeAnchor,2);assert.equal(el('setting-fadeAnchor').value,'2');
  el('setting-queueQuantize').value='3';el('setting-queueQuantize').dispatch('change');await flush();assert.equal(requests.at(-1).settings.queueQuantize,3);
  el('setting-durationMs').value='4000';el('setting-durationMs').dispatch('change');await flush();
  const final=requests.at(-1).settings;assert.equal(final.durationMs,4000);assert.equal(final.fadeTiming,6);assert.equal(final.fadeRandomSet,17,'unrelated edits keep the fade fields');
  assert.ok(!('quality' in final)&&!('showFps' in final),'display prefs never reach the library');
  // The legacy Transition timing select is gone from the page and from the bound fields.
  assert.equal(html.includes('id="setting-beats"'),false);
  // Display selects use the display: path and never call the library.
  const libraryCalls=requests.length;
  el('setting-quality').value='4';el('setting-quality').dispatch('change');await flush();
  el('setting-timingOverlay').value='1';el('setting-timingOverlay').dispatch('change');await flush();
  el('setting-showFps').value='2';el('setting-showFps').dispatch('change');await flush();
  assert.equal(requests.length,libraryCalls,'display changes are not library requests');
  const shown=events.filter(x=>x.type==='settings').at(-1);
  assert.deepEqual(['quality','avsResolution','pixelArt','showFps','timingOverlay'].map(key=>shown[key]),[4,0,0,2,1]);
  assert.equal(shown.fadeTiming,6);assert.equal(shown.fadeRandomSet,17,'the display echo repeats the current fade snapshot');
  assert.equal(JSON.parse(storage.get('aaavs.mpcDisplay.v1')).quality,'native');
  assert.equal(el('setting-quality').value,'4');
  // Play folder: the toolbar button and the message both reach the page.
  const folders=events.filter(x=>x.type==='play-folder').length;
  el('player-play-folder').click();assert.equal(events.filter(x=>x.type==='play-folder').length,folders+1);
  // The tick carries the track duration only when the media reports a finite positive length.
  const audioEvents=()=>events.filter(x=>x.type==='audio');
  const audio=el('player-audio');
  app.tick();assert.ok(!('duration' in audioEvents().at(-1)),'unknown duration is omitted');
  audio.duration=215.5;app.tick();assert.equal(audioEvents().at(-1).duration,215.5);audio.duration=86400;app.tick();assert.equal(audioEvents().at(-1).duration,86400,'the documented maximum is accepted');
  for(const bad of [Infinity,-1,0,NaN,86400.5,1e9]){audio.duration=bad;app.tick();assert.ok(!('duration' in audioEvents().at(-1)),`duration ${bad} is omitted`);}
  app.hide();
  // A page that lacks the new controls (an older cached standalone.html) must still start and work: every lookup is null-guarded.
  const older=await run(['setting-fadeSet2','setting-queueQuantize','setting-quality','player-play-folder','setting-showFps','setting-fadeAnchor']);
  older.bridge.postMessage('host-ready');await older.flush();
  older.elements.get('setting-fadeTiming').value='2';older.elements.get('setting-fadeTiming').dispatch('change');await older.flush();
  assert.equal(older.requests.at(-1).settings.fadeTiming,2);assert.equal(older.requests.at(-1).settings.beats,1);
  older.elements.get('setting-fadeSet1').checked=false;older.elements.get('setting-fadeSet1').dispatch('change');await older.flush();
  assert.equal(older.requests.at(-1).settings.fadeRandomSet,29,'the mask ignores missing boxes');
  older.bridge.postMessage('play-folder');older.tick();older.hide();
  // Stored display preferences reach the page at startup (the first settings message carries prefsToWire(loadPrefs())), and a blocked or corrupt store falls back to defaults.
  storage.set('aaavs.mpcDisplay.v1',JSON.stringify({quality:'high',avsResolution:'crisp',pixelArt:'smooth',showFps:'detail',timingOverlay:'always'}));
  const restored=await run([]);
  assert.deepEqual(['quality','avsResolution','pixelArt','showFps','timingOverlay'].map(key=>restored.elements.get(`setting-${key}`).value),['3','1','2','2','1'],'stored display preferences are shown at startup');
  assert.deepEqual([restored.bridge.prefs.quality,restored.bridge.prefs.showFps],['high',2]);restored.hide();
  storage.set('aaavs.mpcDisplay.v1','{not json');
  const corrupt=await run([]);
  assert.deepEqual(['quality','avsResolution','pixelArt','showFps','timingOverlay'].map(key=>corrupt.elements.get(`setting-${key}`).value),['0','0','0','1','0'],'a corrupt store falls back to the defaults');corrupt.hide();storage.clear();
  globalThis.setInterval=saved.setInterval;globalThis.clearInterval=saved.clearInterval;delete globalThis.window;delete globalThis.document;delete globalThis.aaavsBridge;delete globalThis.addEventListener;delete globalThis.HTMLInputElement;
}

const built=await build({entryPoints:['src/worklets/player-pcm.worklet.ts'],bundle:true,format:'iife',write:false});
let Processor;const output=[];
const scope={Float32Array,ArrayBuffer,Math,Number,currentFrame:0,sampleRate:48000,AudioWorkletProcessor:class{port={onmessage:null,postMessage(message){output.push(message);}};},registerProcessor(name,constructor){assert.equal(name,'aaavs-player-pcm');Processor=constructor;}};
vm.runInNewContext(built.outputFiles[0].text,scope);const worklet=new Processor();
worklet.port.onmessage({data:{type:'reset',epoch:9,active:true}});
for(let i=0;i<5;i++){scope.currentFrame=i*128;const l=new Float32Array(128).fill(i/10),r=new Float32Array(128).fill(-i/10),out=[new Float32Array(128),new Float32Array(128)];worklet.process([[l,r]],[out]);assert.deepEqual(out,[l,r]);}
assert.equal(output.length,1);assert.equal(output[0].epoch,9);assert.equal(output[0].time,0);assert.equal(output[0].samples,576);assert.equal(output[0].sampleRate,48000);const pcm=new Float32Array(output[0].pcm);assert.equal(pcm[0],0);assert.ok(Math.abs(pcm[575]-.4)<1e-6);assert.ok(Math.abs(pcm[1151]+.4)<1e-6);
for(let i=5;i<80;i++){scope.currentFrame=i*128;worklet.process([[new Float32Array(128).fill(.8)]],[[new Float32Array(128),new Float32Array(128)]]);}
assert.equal(output.length,8,'Only eight in-flight buffers are permitted');
worklet.port.onmessage({data:{type:'recycle',pcm:output[0].pcm}});
for(let i=80;i<85;i++){scope.currentFrame=i*128;worklet.process([[new Float32Array(128).fill(.6)]],[[new Float32Array(128),new Float32Array(128)]]);}
assert.equal(output.length,9);assert.equal(output[8].discontinuity,true);assert.deepEqual(new Float32Array(output[8].pcm).slice(0,576),new Float32Array(output[8].pcm).slice(576));
worklet.port.onmessage({data:{type:'reset',epoch:10,active:false}});scope.currentFrame=100000;worklet.process([[new Float32Array(128).fill(.1)]],[[new Float32Array(128),new Float32Array(128)]]);assert.equal(output.length,9);
console.log('Standalone Player CPU checks PASS: shared bridge protocol, settings, v2 fade fields and beats projection, display: prefs, play-folder, track duration, the real standalone.html ids and mask binding, null-guarded older pages, bounded PCM, source-time mapping, stale epochs, stereo/mono pass-through, backpressure and discontinuities.');
