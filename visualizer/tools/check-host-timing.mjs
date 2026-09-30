import {build} from 'esbuild';
import assert from 'node:assert/strict';
// Host-level Timing System v2 assertions (CONTRACT 3.6: each stream's host checks live in its own check-host-<stream>.mjs).
// Written before the host is wired (Wave 1). It bundles the real src/mpc-host.ts against fake transport/worker surfaces, and never starts a
// WebView, a GPU, a server or audio. AAAVS_HOST_ENTRY may point at a scratch copy of the host for a wiring rehearsal (CPU only).
const entry=process.env.AAAVS_HOST_ENTRY||'src/mpc-host.ts';
const {compileSceneClock,defaultSceneTiming}=await load('src/mpc-scene-clock.ts');
const {pickFade,planFade,defaultFadeSpec}=await load('src/mpc-transition-timing.ts');
const {canonicalSettings,parseSetups}=await load('src/mpc-setups.ts');
const {FADE_FROM_BEATS}=await load('src/mpc-contract.ts');
async function load(path){const r=await build({entryPoints:[path],bundle:true,format:'esm',write:false});return import(`data:text/javascript;base64,${Buffer.from(r.outputFiles[0].text).toString('base64')}`);}

const scenes=['boot','magi','psycho','radar','harmonics','seele','battery','atfield','alert','plug','target','city','sync','berserk','impact','end'];
const catalog=scenes.map((scene,i)=>({kind:'nerv',scene,name:`NERV ${scene}`,sha256:i.toString(16).padStart(64,'0'),autoEligible:true}));
const result=await build({entryPoints:[entry],bundle:true,format:'esm',write:false,define:{'import.meta.url':'"https://aaavs.invalid/dist/mpc-host.js"'},plugins:[{name:'fixture',setup(b){
 b.onResolve({filter:/(local-collection|mpc-management|mpc-bitmap-dependencies)\.ts$/},args=>({path:args.path,namespace:'fixture'}));
 b.onLoad({filter:/.*/,namespace:'fixture'},args=>({contents:args.path.includes('local-collection')?`export async function fetchLocalAvsCatalog(){return globalThis.catalog;} export function fetchLocalAvsPreset(p){return globalThis.fetchPreset(p);} export const isSceneKind=p=>p?.kind==='nerv'||p?.kind==='hud'; export async function fetchLocalAvsSources(){return new Map();} export function parseLocalAvsSources(){return new Map();}`:args.path.includes('management')?`export class PresetManagement {open=false; constructor(a){globalThis.actions=a;} refresh(){} show(){} receive(){} noteCommit(){} playLastFolder(){}}`:`export async function loadPresetBitmaps(){throw Error('NERV must not fetch historical bitmap packages');}`}));
}}]});
const hostCode=result.outputFiles[0].text;

let instance=0;
/** A fresh host on fake surfaces. `random` replaces Math.random for the session seed of live Random picks. */
async function boot({random=()=>.5}={}){
 const nodes=new Map(),posted=[],workers=[],fetches=[],timingWrites=[];
 const env={nodes,posted,workers,fetches,timingWrites,now:0,draws:0,listener:null,raf:null,pagehide:null,hidden:false,actions:null};
 const ctx={globalAlpha:1,drawImage(){env.draws++;},getImageData(){return {data:new Uint8ClampedArray(256*144*4)};},save(){},restore(){},beginPath(){},rect(){},clip(){},fillRect(){},createPattern(){return {};},clearRect(){},setTransform(){},scale(){},translate(){}};
 const canvas=()=>({width:640,height:360,clientWidth:640,clientHeight:360,style:{},getContext(){return {...ctx,canvas:this};}});
 globalThis.catalog=catalog;
 globalThis.fetch=async()=>{throw Error('offline fixture')};globalThis.fetchPreset=p=>new Promise(resolve=>fetches.push({p,resolve:()=>resolve(new Uint8Array(4))}));
 globalThis.OffscreenCanvas=class {constructor(){Object.assign(this,canvas());}};
 const bodyClasses=new Set();
 globalThis.document={get hidden(){return env.hidden;},baseURI:'https://aaavs.invalid/mpc.html',body:{append(){},classList:{add:c=>bodyClasses.add(c),remove:c=>bodyClasses.delete(c),toggle:(c,on)=>on===false?bodyClasses.delete(c):bodyClasses.add(c),contains:c=>bodyClasses.has(c)}},createElement:canvas,
  querySelector(id){if(!nodes.has(id)){
   if(id==='#visualizer')nodes.set(id,canvas());
   else if(id==='#timing'){let text='';nodes.set(id,{get textContent(){return text;},set textContent(value){text=String(value);timingWrites.push(text);}});}
   else nodes.set(id,{textContent:''});
  }return nodes.get(id);},addEventListener(){}};
 env.bodyClasses=bodyClasses;
 globalThis.window={chrome:{webview:{postMessage(m){posted.push(m);},addEventListener(_,fn){env.listener=fn;}}},setTimeout(){return 1;},addEventListener(t,fn){if(t==='pagehide')env.pagehide=fn;}};
 globalThis.clearTimeout=()=>{};
 Object.defineProperty(globalThis,'performance',{value:{now:()=>env.now},configurable:true});
 globalThis.requestAnimationFrame=fn=>env.raf=fn;globalThis.devicePixelRatio=1;
 delete globalThis.matchMedia;delete globalThis.ResizeObserver;
 globalThis.Worker=class {
  // NERV presets load the show engine's worker by default (same load/render protocol as nerv-render.worker.js)
  constructor(url){assert.ok(new URL(String(url)).pathname.endsWith('/show-render.worker.js'));this.requests=[];this.dead=false;workers.push(this);}
  postMessage(m){this.requests.push(m);}terminate(){this.dead=true;}
  send(type){const bitmap={width:640,height:360,closed:false,close(){this.closed=true;}};this.onmessage({data:{type,bitmap}});return bitmap;}
 };
 const originalRandom=Math.random;Math.random=random;
 try{await import(`data:text/javascript;base64,${Buffer.from(`${hostCode}\n// instance ${++instance}`).toString('base64')}`);}finally{Math.random=originalRandom;}
 env.actions=globalThis.actions;
 env.flush=async()=>{for(let i=0;i<12;i++)await Promise.resolve();};
 env.msg=data=>env.listener({data});
 env.audio=(position,playing=false,extra={})=>env.msg({type:'audio',playing,position,epoch:1,pcm:Array(1152).fill(0),...extra});
 env.tick=(dt=16)=>{env.now+=dt;env.raf(env.now);};
 env.lastRender=w=>w.requests.filter(r=>r.type==='render').at(-1);
 env.count=w=>w.requests.filter(r=>r.type==='render').length;
 env.load=async()=>{fetches.at(-1).resolve();await env.flush();const w=workers.at(-1);w.send('ready');w.send('frame');return w;};
 env.timing=()=>nodes.get('#timing').textContent;
 env.configures=()=>posted.filter(m=>typeof m==='string'&&m.startsWith('library:')).map(m=>JSON.parse(m.slice(8))).filter(m=>m.op==='configure');
 await env.flush();
 env.active=await env.load();
 return env;
}
const CLOCK={enabled:true,bpm:120,offsetSeconds:0,barsPerScene:1,seed:89};
/** Activate the 16-scene NERV setup with the given timing and settings patch; returns the first plate's worker. */
async function activate(env,timing,settings={}){
 const setup=env.actions.nervSetup();setup.timing={...timing};Object.assign(setup.settings,{beats:0,durationMs:2000},settings);
 env.actions.activate(setup);await env.flush();env.active=await env.load();return setup;
}
/** Move the paused clock to `t` and return the plate frame the active worker was asked for (loading a new scene when the clock crossed one). */
async function seek(env,t,extra={}){
 const before=env.fetches.length;env.audio(t,false,extra);await env.flush();
 if(env.fetches.length>before)env.active=await env.load();
 else {env.tick();env.active.send('frame');}
 return structuredClone(env.lastRender(env.active).nerv);
}
const near=(a,b,eps=1e-9)=>Math.abs(a-b)<=eps;
const verbose=(...a)=>{if(process.env.AAAVS_CHECK_VERBOSE)console.log(...a);};

// ---- 1. Legacy compatibility: a message and a setup that only know `beats` behave exactly as before. ----
{
 const env=await boot();
 const setup=await activate(env,{...CLOCK},{beats:1});
 const frame=await seek(env,4.25);
 assert.equal(frame.previousScene,'magi');assert.equal(frame.blend,.5);assert.equal(frame.localTime,.25);assert.equal(frame.bpm,120);
 assert.equal(frame.fadeSeconds,.5,'1 beat at 120 BPM');
 // Legacy `beats` messages map onto the new families: 2 beats, 1 bar (was "4 beats").
 for(const [beats,seconds] of [[1,.5],[2,1],[4,2]]){
  env.msg({type:'settings',enabled:true,shuffle:false,transition:1,beats});env.tick();const f=structuredClone(env.lastRender(env.active).nerv);env.active.send('frame');
  assert.equal(f.fadeSeconds,seconds,`legacy beats ${beats}`);assert.equal(f.blend,.25/seconds);
 }
 // Seconds (beats 0 or absent) uses durationMs, capped by the incoming scene.
 for(const [durationMs,seconds] of [[500,.5],[1000,1],[8000,2]]){
  env.msg({type:'settings',enabled:true,shuffle:false,transition:1,beats:0,durationMs});env.tick();const f=structuredClone(env.lastRender(env.active).nerv);env.active.send('frame');
  assert.equal(f.fadeSeconds,seconds,`Seconds ${durationMs} ms`);assert.equal(f.blend,.25/seconds);
 }
 // The Seconds fallback is 8 s at most on every layer (C-05): a hand-edited 80000 reads as 8000.
 env.msg({type:'settings',enabled:true,shuffle:false,transition:1,beats:0,durationMs:80000});assert.equal(env.actions.settings().durationMs,8000);
 env.msg({type:'settings',enabled:true,shuffle:false,transition:1,beats:0,durationMs:'x'});assert.equal(env.actions.settings().durationMs,2000);
}

// ---- 2. Every fade family reaches the worker as `blend` and `fadeSeconds`; Instant sends no outgoing plate. ----
{
 const env=await boot();
 await activate(env,{...CLOCK,barsPerScene:4});   // 8 s scenes at 120 BPM, so 1 bar (2 s) and 2 bars (4 s) fit
 await seek(env,16.25);                            // ordinal 2 (16..24), localTime .25
 const at=async settings=>{env.msg({type:'settings',enabled:true,shuffle:false,transition:1,...settings});env.tick();const f=structuredClone(env.lastRender(env.active).nerv);env.active.send('frame');return f;};
 const expect=[[0,{durationMs:500},.5],[2,{},.5],[3,{},1],[4,{},2],[5,{},4]];
 for(const [fadeTiming,extra,seconds] of expect){
  const f=await at({fadeTiming,beats:0,...extra});
  assert.equal(f.fadeSeconds,seconds,`fadeTiming ${fadeTiming}`);assert.equal(f.blend,.25/seconds,`blend for fadeTiming ${fadeTiming}`);assert.equal(f.previousScene,'magi');
 }
 // Instant: the outgoing plate is not sent at all (the same as Cut).
 const instant=await at({fadeTiming:1,beats:0});
 for(const key of ['previousScene','previousTime','previousLocalTime','previousSceneStart','previousSceneEnd','blend','fadeSeconds'])assert.equal(key in instant,false,`Instant omits ${key}`);
 // An out-of-range family falls back to the legacy field, and a missing one to Seconds.
 assert.equal((await at({fadeTiming:9,beats:2})).fadeSeconds,1,'invalid fadeTiming derives from beats');
 assert.equal((await at({fadeTiming:-1,beats:0,durationMs:1000})).fadeSeconds,1);
 assert.equal((await at({beats:0})).fadeSeconds,2,'absent fields are the defaults (Seconds, 2000 ms)');
 // Full-state snapshot: a message without the fade keys resets them (absent means default).
 await at({fadeTiming:3,fadeRandomSet:22,fadeAnchor:0,beats:0});assert.equal((await at({beats:0})).fadeSeconds,2);
 // Stored anchors 1 and 2 (end, hit) behave as the start anchor until the Wave-4 host wiring lands.
 for(const anchor of [1,2]){const f=await at({fadeTiming:3,fadeAnchor:anchor,beats:0});assert.equal(f.fadeSeconds,1);assert.equal(f.blend,.25);assert.equal(f.previousScene,'magi');}
}

// ---- 3. The clock's signals reach the plate: grid, scene bounds, previous plate bounds, keepOld. ----
{
 const env=await boot();
 await activate(env,{...CLOCK,offsetSeconds:0},{beats:1});
 const frame=await seek(env,4.25);
 assert.deepEqual(frame.grid,{offset:0,bpm:120,beatsPerBar:4},'a constant clock sends no tempo changes');
 assert.equal(frame.sceneStart,4);assert.equal(frame.sceneEnd,6);assert.equal(frame.previousSceneStart,2);assert.equal(frame.previousSceneEnd,4);
 assert.equal(frame.time,4.25);assert.equal(frame.previousTime,4.25,'keepOld: the outgoing plate keeps running');assert.equal(frame.previousLocalTime,2.25);
 env.msg({type:'settings',enabled:true,shuffle:false,transition:1,beats:1,keepOld:false});env.tick();
 const frozen=structuredClone(env.lastRender(env.active).nerv);env.active.send('frame');
 assert.equal(frozen.previousLocalTime,2,'frozen at its own duration');assert.equal(frozen.previousTime,4);
 assert.equal(frozen.previousSceneStart,2);assert.equal(frozen.previousSceneEnd,4);
 // A scene interval is one number shared with its neighbour: end of scene n is the start of n + 1, bitwise.
 const next=await seek(env,6.1);assert.equal(next.sceneStart,frame.sceneEnd);assert.equal(next.previousSceneEnd,next.sceneStart);
 // Before the offset the first scene holds; it has no outgoing plate.
 const early=await activate(env,{...CLOCK,offsetSeconds:3},{beats:1});
 const hold=await seek(env,1);assert.equal(hold.localTime,0);assert.equal('previousScene' in hold,false);assert.equal(hold.sceneStart,3);assert.equal(hold.sceneEnd,5);
}

// ---- 4. Scene clock v2 in a setup: bars pattern, meter, tempo map. ----
{
 const env=await boot();
 const timing={...CLOCK,offsetSeconds:1,barsPerScene:1,barsPattern:[1,2],beatsPerBar:3,tempoMap:[{at:20,bpm:150}]};
 await activate(env,timing,{beats:1});
 const clock=compileSceneClock({...timing,version:2}),order=env.actions.nervSetup().presets.map((_,i)=>i);
 // Pattern [1,2] bars of 3 beats at 120 BPM: scenes of 1.5 s and 3 s, alternating, starting at the 1 s offset.
 let frame=await seek(env,3.25);
 assert.equal(frame.sceneStart,2.5);assert.equal(frame.sceneEnd,5.5);assert.equal(frame.localTime,.75);assert.equal(frame.grid.beatsPerBar,3);
 assert.deepEqual(frame.grid.changes,[[20,150]]);assert.equal(frame.bpm,120);
 const expected=clock.at(3.25,order,false,[]);assert.equal(expected.start,frame.sceneStart);assert.equal(expected.end,frame.sceneEnd);
 // After the tempo change the frame reports the instantaneous tempo, and scene bounds stay on beats.
 frame=await seek(env,22);
 const at22=clock.at(22,order,false,[]);
 assert.equal(frame.bpm,150);assert.equal(frame.sceneStart,at22.start);assert.equal(frame.sceneEnd,at22.end);assert.ok(near(frame.localTime,at22.localTime,1e-9));
 assert.ok(near(frame.progress,at22.progress,1e-12));
 // Beat-length fades follow the tempo at the boundary: one beat is 0.4 s at 150 BPM, and the window ends on a grid beat.
 const boundary=at22.end,after=clock.at(boundary+.1,order,false,[]);
 env.msg({type:'settings',enabled:true,shuffle:false,transition:1,fadeTiming:2,beats:0});
 const f=await seek(env,boundary+.1);
 assert.equal(after.bpm,150);assert.ok(near(f.fadeSeconds,.4,1e-9),`one beat at 150 BPM is 0.4 s (got ${f.fadeSeconds})`);
 assert.ok(near(f.blend,.1/.4,1e-9));assert.equal(f.sceneStart,boundary,'the scene starts exactly where the previous one ended');
}

// ---- 5. Random families: seeded bag on the clock, replays after seeking away and back, each member of the set. ----
{
 const env=await boot();
 const spec={...defaultFadeSpec,timing:6,randomSet:22,anchor:0,fixedMs:2000};   // bits 1, 2, 4: 1 beat, 2 beats, 2 bars
 await activate(env,{...CLOCK,barsPerScene:4},{});
 env.msg({type:'settings',enabled:true,shuffle:false,transition:1,beats:0,fadeTiming:6,fadeRandomSet:22});
 // The bag is indexed by the incoming ordinal: ordinals 3..11 are three whole cycles of the three-member set.
 const seen=[],first=new Map(),ordinals=[3,4,5,6,7,8,9,10,11];
 for(const n of ordinals){
  const f=await seek(env,n*8+.25);
  const expectedSeconds=planFade(spec,pickFade(spec,n,89),{bpm:120,beatsPerBar:4,capSeconds:8}).seconds;
  assert.equal(f.fadeSeconds,expectedSeconds,`ordinal ${n}`);seen.push(f.fadeSeconds);first.set(n,f);
 }
 for(let cycle=0;cycle<3;cycle++)assert.deepEqual([...seen.slice(cycle*3,cycle*3+3)].sort((a,b)=>a-b),[.5,1,4],`cycle ${cycle} is a permutation of the set`);
 for(let i=3;i<seen.length;i+=3)assert.notEqual(seen[i],seen[i-1],'no repeat across a cycle seam');
 // Replay: seeking away and back reproduces every frame, in any order.
 for(const n of [7,4,11,3,9,5,10,6,8]){const again=await seek(env,n*8+.25);assert.deepEqual(again,first.get(n),`ordinal ${n} replays`);}
 // A single-member set behaves as that fixed family; Instant-only never sends an outgoing plate.
 env.msg({type:'settings',enabled:true,shuffle:false,transition:1,beats:0,fadeTiming:6,fadeRandomSet:8});
 for(const n of [2,5,6])assert.equal((await seek(env,n*8+.25)).fadeSeconds,2,'set {1 bar}');
 env.msg({type:'settings',enabled:true,shuffle:false,transition:1,beats:0,fadeTiming:6,fadeRandomSet:1});
 for(const n of [2,5,6]){const f=await seek(env,n*8+.25);assert.equal('previousScene' in f,false,'set {Instant}');}
}

// ---- 6. Setups: `configure` is always complete (C-13), display preferences never travel in it (C-14), managementSettings follows C-04. ----
{
 const env=await boot();
 const legacyKeys=['enabled','bars','shuffle','minimumRating','transition','beats','durationMs','keepOld','manualFade','autoFade'];
 const displayKeys=['showFps','timingOverlay','quality','avsResolution','pixelArt'];
 // A legacy setup still activates and configures with all four fade fields filled in from its legacy `beats`.
 for(const beats of [0,1,2,4]){
  await activate(env,{...CLOCK},{beats});
  const sent=env.configures().at(-1).settings;
  assert.deepEqual(Object.keys(sent),[...legacyKeys,'fadeTiming','fadeRandomSet','fadeAnchor','queueQuantize'],'ten legacy keys then the four fade fields');
  assert.equal(sent.fadeTiming,FADE_FROM_BEATS[beats]);assert.equal(sent.fadeRandomSet,31);assert.equal(sent.fadeAnchor,0);assert.equal(sent.queueQuantize,0);assert.equal(sent.beats,beats);
  for(const key of displayKeys)assert.equal(key in sent,false,`configure never carries ${key}`);
 }
 // A v2 setup carries its values; `beats` is the projection (Random projects to 0).
 await activate(env,{...CLOCK},{beats:0,fadeTiming:6,fadeRandomSet:22,fadeAnchor:1,queueQuantize:2});
 let sent=env.configures().at(-1).settings;
 assert.deepEqual([sent.fadeTiming,sent.fadeRandomSet,sent.fadeAnchor,sent.queueQuantize,sent.beats],[6,22,1,2,0]);
 await activate(env,{...CLOCK},{beats:0,fadeTiming:5});sent=env.configures().at(-1).settings;assert.deepEqual([sent.fadeTiming,sent.beats],[5,0]);
 // Activating one setup after another never depends on the previous one: the second sends its own defaults.
 await activate(env,{...CLOCK},{beats:0});sent=env.configures().at(-1).settings;assert.deepEqual([sent.fadeTiming,sent.fadeRandomSet,sent.fadeAnchor,sent.queueQuantize],[0,31,0,0]);
 // managementSettings: legacy exactly ten keys; v2 fields only when they differ from their defaults (C-04).
 const legacy=await boot();
 assert.deepEqual(Object.keys(legacy.actions.settings()),legacyKeys);
 legacy.msg({type:'settings',enabled:true,shuffle:false,transition:1,beats:2});
 assert.deepEqual(Object.keys(legacy.actions.settings()),legacyKeys,'a legacy beats value is its own projection, so no v2 field is written');
 assert.equal(legacy.actions.settings().beats,2);
 legacy.msg({type:'settings',enabled:true,shuffle:false,transition:1,beats:0,fadeTiming:6,fadeRandomSet:22,fadeAnchor:2,queueQuantize:3});
 const stored=legacy.actions.settings();
 assert.deepEqual(Object.keys(stored),[...legacyKeys,'fadeTiming','fadeRandomSet','fadeAnchor','queueQuantize']);
 assert.deepEqual([stored.beats,stored.fadeTiming,stored.fadeRandomSet,stored.fadeAnchor,stored.queueQuantize],[0,6,22,2,3]);
 legacy.msg({type:'settings',enabled:true,shuffle:false,transition:1,beats:0,fadeTiming:1});
 assert.deepEqual([legacy.actions.settings().fadeTiming,legacy.actions.settings().beats],[1,0],'Instant projects to beats 0 and is written');
 legacy.msg({type:'settings',enabled:true,shuffle:false,transition:1,beats:0,fadeTiming:3});
 assert.deepEqual(Object.keys(legacy.actions.settings()),legacyKeys,'fadeTiming equal to FADE_FROM_BEATS[beats] counts as default');assert.equal(legacy.actions.settings().beats,2);
 // The saved setup round trips through the shared parser, whatever the host produced.
 const parsed=parseSetups([{id:'x',name:'x',presets:[],settings:stored,timing:{...CLOCK}}])[0].settings;assert.deepEqual(parsed,stored);
 assert.deepEqual(canonicalSettings(stored),stored);
 // The Preset Manager tools read live transport and tempo through the host.
 legacy.audio(12.5,true);assert.equal(legacy.actions.position(),12.5);assert.equal(legacy.actions.playing(),true);
 const tempo=legacy.actions.tempo();assert.deepEqual(Object.keys(tempo).sort(),['bpm','locked','phase']);assert.equal(tempo.locked,false);
}

// ---- 7. Activation is atomic: an invalid clock changes nothing; reactivating the same setup replays the same frames. ----
{
 const env=await boot();
 const setup=await activate(env,{...CLOCK,barsPattern:[2,1]},{beats:1});
 const before=await seek(env,5.1);
 const bad=env.actions.nervSetup();bad.timing={...CLOCK,tempoMap:[{at:-5,bpm:100}]};
 assert.throws(()=>env.actions.activate(bad));
 assert.deepEqual(await seek(env,5.1),before,'a rejected setup left the running clock untouched');
 env.actions.activate(setup);await env.flush();env.active=await env.load();
 assert.deepEqual(await seek(env,5.1),before,'reactivating replays the same frame');
}

// ---- 8. Timing overlay text: FPS beside the BPM, byte-identical to the shipped strings when it is off, written only on change. ----
{
 const env=await boot();
 const step=(playing=true,extra={})=>{env.now+=1000/60;env.audio(env.position=(env.position??10)+1/60,playing,extra);env.raf(env.now);env.active.send('frame');};
 // Not playing: the shipped strings, no fps.
 env.audio(10,false);env.tick();assert.equal(env.timing(),'Auto paused');
 // Playing with silence: 60 fps (16.67 ms rAF spacing, a fresh frame each time) after the state name.
 for(let i=0;i<90;i++)step();
 assert.equal(env.timing(),'Auto · waiting for audio signal · 60 fps');
 // Off: the exact shipped string.
 env.msg({type:'settings',enabled:true,shuffle:false,transition:1,beats:0,showFps:0});for(let i=0;i<10;i++)step();
 assert.equal(env.timing(),'Auto · waiting for audio signal');
 // Detail adds the worker render rate and the clock rate; once the RES column is wired it also ends with the render-resolution text (C-34), which never appears in fps mode.
 env.msg({type:'settings',enabled:true,shuffle:false,transition:1,beats:0,showFps:2});for(let i=0;i<70;i++)step();
 assert.match(env.timing(),/^Auto · waiting for audio signal · 60 fps \(render 60 · clock 60 Hz\)(?: · [^·]+)?$/);
 // A missing or invalid showFps keeps the current value.
 env.msg({type:'settings',enabled:true,shuffle:false,transition:1,beats:0});for(let i=0;i<5;i++)step();assert.match(env.timing(),/fps \(render/);
 env.msg({type:'settings',enabled:true,shuffle:false,transition:1,beats:0,showFps:7});for(let i=0;i<5;i++)step();assert.match(env.timing(),/fps \(render/);
 env.msg({type:'settings',enabled:true,shuffle:false,transition:1,beats:0,showFps:1});for(let i=0;i<70;i++)step();assert.equal(env.timing(),'Auto · waiting for audio signal · 60 fps');
 // Paused and hidden hosts show no fps.
 env.audio(env.position,false);env.tick();assert.equal(env.timing(),'Auto paused');
 for(let i=0;i<90;i++)step(true,{visible:false});assert.equal(env.timing(),'Auto · waiting for audio signal','a hidden host shows no fps');
 for(let i=0;i<90;i++)step();assert.equal(env.timing(),'Auto · waiting for audio signal · 60 fps');
 env.hidden=true;for(let i=0;i<5;i++)step();assert.equal(env.timing(),'Auto · waiting for audio signal');env.hidden=false;
 // Auto off keeps the shipped string with the fps appended while playing.
 env.msg({type:'settings',enabled:false,shuffle:false,transition:1,beats:0});for(let i=0;i<90;i++)step();assert.equal(env.timing(),'Auto off · 60 fps');
 env.msg({type:'settings',enabled:false,shuffle:false,transition:1,beats:0,showFps:0});for(let i=0;i<5;i++)step();assert.equal(env.timing(),'Auto off');
 env.msg({type:'settings',enabled:true,shuffle:false,transition:1,beats:0,showFps:1});
 // Slower presentation reads slower: 30 fps.
 for(let i=0;i<120;i++){env.now+=1000/30;env.audio(env.position+=1/30,true);env.raf(env.now);env.active.send('frame');}
 assert.equal(env.timing(),'Auto · waiting for audio signal · 30 fps');
 // Written only on change: a long run of identical frames adds few writes.
 const writes=env.timingWrites.length;
 for(let i=0;i<300;i++){env.now+=1000/30;env.audio(env.position+=1/30,true);env.raf(env.now);env.active.send('frame');}
 assert.ok(env.timingWrites.length-writes<=2,`unchanged text is not rewritten (${env.timingWrites.length-writes} writes)`);
}

// ---- 9. Scene clock overlay: bar:beat readout and fps after the BPM. ----
{
 const env=await boot();
 await activate(env,{...CLOCK,barsPerScene:4},{beats:0});
 let p=8.25;env.audio(p,true);await env.flush();
 // Reach a stable playing state on scene 1 (8..16 s at 120 BPM).
 if(env.fetches.length){env.active=await env.load();}
 const step=()=>{env.now+=1000/60;p+=1/60;env.audio(p,true);env.raf(env.now);env.active.send('frame');};
 for(let i=0;i<120;i++)step();
 const text=env.timing();
 assert.match(text,/^Scene clock · 120 BPM · 60 fps · bar 6\.\d · \d+ bars · playing$/,text);
 env.msg({type:'settings',enabled:true,shuffle:false,transition:1,beats:0,showFps:0});for(let i=0;i<5;i++)step();
 assert.match(env.timing(),/^Scene clock · 120 BPM · bar 6\.\d · \d+ bars · playing$/);
 env.audio(p,false);env.tick();assert.match(env.timing(),/^Scene clock · 120 BPM · bar 6\.\d · \d+ bars · paused$/);
}


// ---- 10. Live path: a locked tempo makes beat and bar fades; Instant is a cut; no tempo falls back to Seconds; Random picks are seeded. ----
const pulse=t=>{const p=Array(1152).fill(0);if(t%.5<.07)for(let k=0;k<1152;k++)p[k]=.8*Math.sin(k*.13);return p;};
/** Play a 120 BPM pulse through the host and measure, per committed change, how long the outgoing plate stays alive. */
async function live(env,{commits,limit=2400}){
 const events=[];let t=env.livePosition??0,activeWorker=env.active,pending=null;
 const label=()=>env.nodes.get('#preset').textContent;let last=label();
 for(let i=0;i<limit&&events.filter(e=>e.doneAt!==null).length<commits;i++){
  t+=1/30;env.now+=1000/30;env.audio(t,true,{pcm:pulse(t)});
  const fetch=env.fetches.at(-1);
  if(fetch&&!fetch.settled){fetch.settled=true;fetch.resolve();await env.flush();const w=env.workers.at(-1);w.send('ready');w.send('frame');}
  env.raf(env.now);
  const now=label();
  if(now!==last){last=now;const incoming=env.workers.at(-1);pending={commitAt:t,outgoing:activeWorker,doneAt:null};if(incoming!==activeWorker){activeWorker=incoming;events.push(pending);if(pending.outgoing.dead)pending.doneAt=t;}}
  for(const e of events)if(e.doneAt===null&&e.outgoing.dead)e.doneAt=t;
 }
 env.livePosition=t;
 return events.filter(e=>e.doneAt!==null).map(e=>({seconds:e.doneAt-e.commitAt,commitAt:e.commitAt}));
}
{
 const step=1/30+1e-9;
 // Tempo locked at 120 BPM: 1 beat 0.5 s, 2 beats 1 s, 1 bar 2 s, 2 bars 4 s; Seconds uses the fixed length.
 for(const [fadeTiming,durationMs,seconds] of [[2,2000,.5],[3,2000,1],[4,2000,2],[5,2000,4],[0,1000,1],[0,500,.5]]){
  const env=await boot();
  env.msg({type:'settings',enabled:true,shuffle:false,transition:1,beats:0,bars:4,fadeTiming,durationMs,showFps:0});
  const events=await live(env,{commits:2});
  assert.ok(events.length>=2,`fadeTiming ${fadeTiming}: two committed changes (${events.length})`);
  assert.match(env.timing(),/^120 BPM · /,'the pulse locks at 120 BPM');
  verbose('live',fadeTiming,durationMs,events.map(e=>[e.commitAt.toFixed(2),e.seconds.toFixed(3)]));
  for(const e of events)assert.ok(Math.abs(e.seconds-seconds)<=step+.05,`fadeTiming ${fadeTiming}/${durationMs} ms: ${e.seconds} s, expected ${seconds}`);
 }
 // Instant is a cut: the outgoing plate is gone at the commit itself.
 {
  const env=await boot();env.msg({type:'settings',enabled:true,shuffle:false,transition:1,beats:0,bars:4,fadeTiming:1,showFps:0});
  const events=await live(env,{commits:2});assert.ok(events.length>=2);for(const e of events)assert.equal(e.seconds,0,'Instant');
 }
 // A setup's meter reaches the live path even with the song clock off: a bar of 3/4 at 120 BPM is 1.5 s, two bars 3 s, and the phrase is counted in the same bars.
 for(const [fadeTiming,seconds] of [[4,1.5],[5,3],[2,.5]]){
  const env=await boot(),setup=env.actions.nervSetup();
  setup.timing={...CLOCK,enabled:false,beatsPerBar:3,version:2};Object.assign(setup.settings,{beats:0,durationMs:2000,bars:4,fadeTiming,fadeRandomSet:31});
  env.actions.activate(setup);await env.flush();env.active=await env.load();env.msg({type:'settings',enabled:true,shuffle:false,transition:1,beats:0,bars:4,fadeTiming,showFps:0});
  const events=await live(env,{commits:2});assert.ok(events.length>=2,`meter 3, fadeTiming ${fadeTiming}: two committed changes (${events.length})`);
  for(const e of events)assert.ok(Math.abs(e.seconds-seconds)<=step+.05,`3/4 fadeTiming ${fadeTiming}: ${e.seconds} s, expected ${seconds}`);
 }
 // A fade never outlasts the fixed phrase: 2 bars inside a 2-bar phrase is at most 4 s (the phrase is 4 s long at 120 BPM).
 {
  const env=await boot();env.msg({type:'settings',enabled:true,shuffle:false,transition:1,beats:0,bars:2,fadeTiming:5,showFps:0});
  const events=await live(env,{commits:2});assert.ok(events.length>=2);for(const e of events)assert.ok(e.seconds<=4+step,`capped by the phrase (${e.seconds})`);
 }
 // No tempo lock: every non-Instant family is the Seconds length, and Instant is still zero. A manual change fades because the host is playing.
 for(const [fadeTiming,seconds] of [[2,1],[4,1],[6,1],[1,0]]){
  const env=await boot();env.msg({type:'settings',enabled:true,shuffle:false,transition:1,beats:0,bars:4,fadeTiming,fadeRandomSet:fadeTiming===6?30:31,durationMs:1000,showFps:0});
  let t=5;env.audio(t,true);env.msg({type:'next'});await env.flush();
  const before=env.active,fetch=env.fetches.at(-1);fetch.settled=true;fetch.resolve();await env.flush();const incoming=env.workers.at(-1);incoming.send('ready');incoming.send('frame');
  assert.equal(before.dead,seconds===0,`Instant disposes the outgoing plate at once (fadeTiming ${fadeTiming})`);
  let done=null;for(let i=1;i<=120&&done===null;i++){t+=1/30;env.now+=1000/30;env.audio(t,true);env.raf(env.now);if(before.dead)done=i/30;}
  verbose('no tempo',fadeTiming,done);
  assert.ok(Math.abs((done??0)-seconds)<=step+.05,`no tempo, fadeTiming ${fadeTiming}: ${done} s, expected ${seconds}`);
 }
 // Random on the live path: a bag seeded from the injected session source; the same source gives the same sequence.
 {
  const spec={...defaultFadeSpec,timing:6,randomSet:22,anchor:0,fixedMs:2000},seed=(Math.floor(.5*4294967296)>>>0);
  const measure=async()=>{
   const env=await boot({random:()=>.5});
   env.msg({type:'settings',enabled:true,shuffle:false,transition:1,beats:0,bars:8,fadeTiming:6,fadeRandomSet:22,showFps:0});
   return live(env,{commits:3,limit:3600});
  };
  const a=await measure(),b=await measure();
  verbose('random',a.map(e=>e.seconds.toFixed(3)),[0,1,2].map(k=>planFade(spec,pickFade(spec,k,seed),{bpm:120,beatsPerBar:4,capSeconds:16}).seconds));
  assert.equal(a.length,3);assert.deepEqual(a.map(e=>e.seconds),b.map(e=>e.seconds),'same session seed, same picks');
  const expected=[0,1,2].map(k=>planFade(spec,pickFade(spec,k,seed),{bpm:120,beatsPerBar:4,capSeconds:16}).seconds);
  a.forEach((e,k)=>assert.ok(Math.abs(e.seconds-expected[k])<=step+.05,`pick ${k}: ${e.seconds} s, expected ${expected[k]}`));
  assert.deepEqual([...expected].sort((x,y)=>x-y),[.5,1,4],'the first three picks are a permutation of the set');
 }
}
console.log('Host timing: legacy beats/durationMs parity, all fade families as blend/fadeSeconds, Instant without an outgoing plate, clock signals (grid, scene and previous bounds, tempo map, patterns, meters), seeded Random replay, setup and configure contract (C-04, C-13, C-14), atomic activation, overlay text (fps placement, byte-identical when off, write-on-change, bar:beat), live-path beat/bar/Seconds fades, Instant cut, phrase cap, no-tempo fallback, seeded live Random PASS');
