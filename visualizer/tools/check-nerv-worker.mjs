import {build} from 'esbuild';
import assert from 'node:assert/strict';
import {readFileSync,readdirSync} from 'node:fs';
import {resolve} from 'node:path';
// CPU-only contract check of src/nerv-render.worker.ts (docs/design/CONTRACT.md 2.3.4): a recording Canvas double, no browser, no GPU.
const scenes=readdirSync('nerv-presets').filter(name=>name.endsWith('.nerv')).map(name=>name.slice(0,-5));
assert.equal(scenes.length,16);
const bundled=async(entry,plugins=[])=>(await build({entryPoints:[entry],bundle:true,format:'esm',write:false,plugins})).outputFiles[0].text;
const importText=text=>import(`data:text/javascript;base64,${Buffer.from(text).toString('base64')}`);
// AAAVS_WORKER_ENTRY points the check at a scratch copy of the worker (used to prove the assertions catch a broken worker).
// The worker is bundled with a scene fixture: renderNervScene only records what it was asked to draw (and on which surface).
// The worker's AvsTransition is a thin spy over the real class: what it is constructed with and the env of every draw are logged for white-box assertions.
const realTransition=resolve('src/mpc-transition.ts');
const workerText=await bundled(process.env.AAAVS_WORKER_ENTRY??'src/nerv-render.worker.ts',[{name:'record-scene',setup(b){
 b.onResolve({filter:/nerv-scenes\.ts$/},()=>({path:'scene',namespace:'fixture'}));
 b.onResolve({filter:/mpc-transition\.ts$/},args=>args.namespace==='spy'?{path:realTransition}:{path:'spy',namespace:'spy'});
 b.onLoad({filter:/.*/,namespace:'spy'},()=>({contents:`import {AvsTransition as Real} from './mpc-transition.ts';export * from './mpc-transition.ts';
export class AvsTransition extends Real{constructor(mode,options){super(mode,options);globalThis.transitionLog.push({event:'new',mode,options});}
 draw(ctx,old,next,progress,w,h,env){globalThis.transitionLog.push({event:'draw',progress,w,h,env});return super.draw(ctx,old,next,progress,w,h,env);}}`}));
 b.onLoad({filter:/.*/,namespace:'fixture'},()=>({contents:`export const NERV_SCENES=${JSON.stringify(scenes)};export function renderNervScene(ctx,w,h,frame){ctx.canvas.scene=frame.scene;globalThis.frames.push({w,h,frame});globalThis.canvasLog.push({scene:frame.scene,id:ctx.canvas.id});}`}));
}}]);
globalThis.frames=[];globalThis.transitionLog=[];globalThis.canvasLog=[];globalThis.smoothLog=[];globalThis.canvases=[];globalThis.trackCanvases=false;globalThis.lastTransferred=null;
const replies=[],operations=[];
let serial=0;
globalThis.self={postMessage(message){replies.push(message);}};
const finiteArgs=args=>assert.ok(args.every(Number.isFinite),'canvas arguments must be finite');
// Records geometry, alpha, colours and source identity. Every numeric argument must be finite; no surface may sample itself.
class Context {
 constructor(canvas){this.canvas=canvas;this.reset();}
 reset(){this.globalAlpha=1;this.globalCompositeOperation='source-over';this.stack=[];}
 save(){this.stack.push([this.globalAlpha,this.globalCompositeOperation]);operations.push(['save']);}
 restore(){[this.globalAlpha,this.globalCompositeOperation]=this.stack.pop();operations.push(['restore']);}
 beginPath(){operations.push(['beginPath']);}
 closePath(){operations.push(['closePath']);}
 rect(...args){finiteArgs(args);operations.push(['rect',...args]);}
 moveTo(...args){finiteArgs(args);operations.push(['moveTo',...args]);}
 lineTo(...args){finiteArgs(args);operations.push(['lineTo',...args]);}
 arc(...args){finiteArgs(args.filter(a=>typeof a==='number'));operations.push(['arc',...args]);}
 clip(){operations.push(['clip']);}
 fill(){operations.push(['fillPath']);}
 stroke(){operations.push(['stroke']);}
 clearRect(...args){finiteArgs(args);operations.push(['clear',...args]);}
 fillText(text,...args){assert.equal(typeof text,'string');finiteArgs(args);operations.push(['text',text,...args]);}
 strokeText(text,...args){assert.equal(typeof text,'string');finiteArgs(args);operations.push(['strokeText',text,...args]);}
 setTransform(...args){finiteArgs(args);operations.push(['setTransform',...args]);}
 drawImage(source,...args){
  assert.notEqual(source,this.canvas,'transition output must never be sampled as its own source');
  finiteArgs(args);
  smoothLog.push({id:this.canvas.id,enabled:this.imageSmoothingEnabled,quality:this.imageSmoothingQuality});
  operations.push(['draw',source.scene??'mask',this.globalAlpha,this.globalCompositeOperation,...args]);
 }
 fillRect(...args){finiteArgs(args);operations.push(['fill',this.globalCompositeOperation,...args]);}
 createPattern(source,repeat){assert.notEqual(source,this.canvas);operations.push(['pattern',source.width,source.height,repeat]);return {};}
 get fillStyle(){return this._fillStyle;}set fillStyle(value){this._fillStyle=value;operations.push(['fillStyle',value]);}
 get strokeStyle(){return this._strokeStyle;}set strokeStyle(value){this._strokeStyle=value;operations.push(['strokeStyle',value]);}
}
globalThis.OffscreenCanvas=class {
 constructor(w,h){this.id=serial++;if(globalThis.trackCanvases)canvases.push(this);this._width=w;this._height=h;this.context=new Context(this);}
 get width(){return this._width;}set width(value){this._width=value;this.context.reset();}
 get height(){return this._height;}set height(value){this._height=value;this.context.reset();}
 getContext(){return this.context;}
 transferToImageBitmap(){globalThis.lastTransferred=this;return {width:this.width,height:this.height};}
};
await importText(workerText);
const send=data=>self.onmessage({data});
const bytes=name=>{const b=readFileSync(`nerv-presets/${name}.nerv`);return b.buffer.slice(b.byteOffset,b.byteOffset+b.byteLength);};
const load=(scene,generation=1)=>{send({type:'load',generation,preset:bytes(scene)});assert.equal(replies.at(-1).type,'ready');};
const clock={time:17,localTime:1,progress:.0625,bpm:120,seed:13,previousScene:'boot',previousTime:16,previousLocalTime:16,blend:.5,transitionMode:1,transitionSeed:121};
const frame={type:'render',generation:1,sequence:1,pcm:new ArrayBuffer(4608),width:640,height:360,nerv:clock};
function sample(nerv,extra={}){
 frames.length=0;operations.length=0;canvasLog.length=0;smoothLog.length=0;transitionLog.length=0;
 send({...frame,...extra,nerv});assert.equal(replies.at(-1).type,'frame',String(replies.at(-1).message));
 return structuredClone({frames,operations});
}
const draws=captured=>captured.operations.filter(op=>op[0]==='draw');
// Modules the worker builds on, bundled on their own so the check can state the expected behaviour independently of the worker's wiring.
const {AvsTransition,TRANSITION_COUNT,TRANSITION_CUT,resolveTransitionMode,transitionLevel}=await importText(await bundled('src/mpc-transition.ts'));
const {compileClockGrid,timingSignals}=await importText(await bundled('src/mpc-beat-grid.ts'));
const {fitWithin,HARD_MAX_EDGE,HARD_MAX_PIXELS}=await importText(await bundled('src/render-resolution.ts'));
assert.equal(TRANSITION_COUNT,33);
const createCanvas=()=>new OffscreenCanvas(1,1);
/** The env contract 2.3.4 asks of the worker: beat and bar phase from timingSignals() of the incoming clock, the wire length, seconds, level and accent. */
function expectedEnv(n,audio=null){
 const signals=timingSignals(n.time,n.grid??null,n.sceneStart??null,n.sceneEnd??null,{bpm:Math.min(400,Math.max(20,n.bpm)),localTime:n.localTime});
 return {bpm:compileClockGrid(n.grid)?.bpmAt(n.time)??n.bpm,beatPhase:signals.beatPhase,barPhase:signals.barPhase,beatsTotal:n.transitionBeats??4,level:audio?transitionLevel(audio):0,accent:n.transitionAccent===0?0:1,
  reducedMotion:n.transitionReduced===true,...(n.fadeSeconds!==undefined?{seconds:n.fadeSeconds}:{})};
}
/** The construction options the contract asks of the worker. */
const expectedOptions=n=>({seed:(n.transitionSeed??n.seed)>>>0,smooth:true,context:{beatsTotal:n.transitionBeats??4,boundary:n.transitionBoundary??0,nervPair:true,reducedMotion:n.transitionReduced===true}});
/** White-box: the transition the worker built for the last sample, and the env of each draw it made. */
function checkSpy(n,audio,label,{fresh=true}={}){
 const created=transitionLog.filter(e=>e.event==='new'),drawn=transitionLog.filter(e=>e.event==='draw');
 assert.equal(created.length,fresh?1:0,`${label}: transition construction count`);
 if(created.length){
  const {options,mode}=created[0];assert.equal(mode,n.transitionMode??1,label);
  assert.equal(options.seed,expectedOptions(n).seed,`${label}: seed`);assert.equal(options.smooth,true,`${label}: smooth`);assert.deepEqual(options.context,expectedOptions(n).context,`${label}: context`);
  assert.equal(typeof options.createCanvas,'function');
 }
 assert.equal(drawn.length,1,`${label}: one draw`);
 assert.deepEqual(drawn[0].env,expectedEnv(n,audio),`${label}: env`);assert.equal(drawn[0].progress,n.blend);
}
/** What the worker must draw for a transition frame, stated from the contract: a fresh AvsTransition built with {seed, context, smooth} and the contract env.
 * `context` and `env` overrides let a test build the deliberately wrong reference. */
function oracle(n,next,{width=640,height=360,audio=null,context={},env={}}={}){
 const beats=n.transitionBeats??4,boundary=n.transitionBoundary??0,reduced=n.transitionReduced===true,mode=n.transitionMode??1,seed=(n.transitionSeed??n.seed)>>>0;
 const full={...expectedEnv(n,audio),...env};
 operations.length=0;
 const target=new OffscreenCanvas(width,height),old=new OffscreenCanvas(width,height),now=new OffscreenCanvas(width,height);
 old.scene=n.previousScene;now.scene=next;
 const transition=new AvsTransition(mode,{seed,createCanvas,context:{beatsTotal:beats,boundary,nervPair:true,reducedMotion:reduced,...context},smooth:true});
 if(n.blend<=0&&mode!==TRANSITION_CUT)target.context.drawImage(old,0,0,width,height);else transition.draw(target.context,old,now,n.blend,width,height,full);
 return structuredClone(operations);
}
load('magi');
let captured=sample(clock);
assert.equal(captured.frames[0].frame.scene,'magi');assert.equal(captured.frames[1].frame.scene,'boot');
assert.equal(captured.frames[1].frame.time,16);assert.equal(captured.frames[1].frame.localTime,16);
assert.equal(captured.operations.filter(op=>op[0]==='draw').at(-1)[1],'magi');assert.equal(draws(captured).at(-1)[2],.5);
sample({...clock,time:30});assert.deepEqual(sample(clock),captured,'media-time revisit reconstructs the same dissolve');
assert.deepEqual(captured.operations,oracle(clock,'magi'),'a legacy frame (no grid, no new fields) draws exactly the default-context transition');
load('magi');sample(clock);checkSpy(clock,null,'legacy frame');

// Every directed pair supports every classic transition, including seeded Random and Cut.
let pairs=0;
for(const next of scenes){
 load(next);
 for(const previous of scenes){
  if(previous===next)continue;pairs++;
  for(let mode=0;mode<=15;mode++){
   const boundary={...clock,previousScene:previous,transitionMode:mode,transitionSeed:6157+pairs};
   const start=sample({...boundary,blend:0});
   assert.equal(draws(start).at(-1)[1],mode===15?next:previous,'exact boundary preserves old image until the selected transition begins');
   const quarter=sample({...boundary,blend:.25});
   assert.equal(quarter.frames[0].frame.scene,next);assert.equal(quarter.frames[1].frame.scene,previous);
   assert.ok(quarter.operations.some(op=>op[0]==='draw'));
   sample({...boundary,blend:.75});
   assert.deepEqual(sample({...boundary,blend:.25}),quarter,`seek replay ${previous} -> ${next}, mode ${mode}`);
   const end=sample({...boundary,blend:1});
   assert.equal(end.frames.length,1);assert.equal(end.frames[0].frame.scene,next);assert.equal(end.operations.length,0);
  }
 }
}
assert.equal(pairs,240);

// The 17 newer indices (16-30 styles, 31 and 32 selectors) on 24 directed pairs that cover every scene on both sides, with every wire field varied.
const fxPairs=[];
for(let k=0;k<16;k++)fxPairs.push([scenes[k],scenes[(k+1)%16]]);
for(let k=0;k<8;k++)fxPairs.push([scenes[2*k+1],scenes[(2*k+5)%16]]);
assert.equal(fxPairs.length,24);
assert.equal(new Set(fxPairs.map(p=>p[0])).size,16);assert.equal(new Set(fxPairs.map(p=>p[1])).size,16);
assert.ok(fxPairs.every(([a,b])=>a!==b));
let fxRuns=0;
const timedFields={grid:{offset:.25,bpm:120,beatsPerBar:4},sceneStart:16,sceneEnd:32,previousSceneStart:0,previousSceneEnd:16};
for(const [next,previous] of fxPairs){
 load(next);
 for(let mode=16;mode<=32;mode++){
  const k=fxRuns++;
  const boundary={...clock,previousScene:previous,transitionMode:mode,transitionSeed:9001+k,transitionBeats:[4,1,8,2,.5,16][k%6],transitionBoundary:k%4,transitionAccent:k%2,transitionReduced:k%7===3,
   ...(k%3===0?{fadeSeconds:.75+k%5}:{}),...(k%2?timedFields:{})};
  const start=sample({...boundary,blend:0});
  assert.equal(draws(start).at(-1)[1],previous,`mode ${mode}: the exact boundary keeps the old plate`);
  const quarter=sample({...boundary,blend:.25});
  assert.equal(quarter.frames[0].frame.scene,next);assert.equal(quarter.frames[1].frame.scene,previous);
  const count=draws(quarter).length;assert.ok(count>=1&&count<=48,`mode ${mode}: ${count} draws`);
  assert.deepEqual(quarter.operations,oracle({...boundary,blend:.25},next),`mode ${mode}: worker draws what the contract env and context describe`);
  sample({...boundary,blend:.75});
  assert.deepEqual(sample({...boundary,blend:.25}),quarter,`seek replay ${previous} -> ${next}, mode ${mode}`);
  const end=sample({...boundary,blend:1});
  assert.equal(end.frames.length,1);assert.equal(end.frames[0].frame.scene,next);assert.equal(end.operations.length,0);
 }
}
assert.equal(fxRuns,24*17);

// A new worker load cannot change the seeded Random style or the block reveal order; nor a selector's pick or a style's parameter table.
for(const mode of [0,6,14,17,18,24,26,29,31,32]){
 load('magi');const state={...clock,transitionMode:mode,blend:.45,transitionBeats:4,transitionBoundary:2};const expected=sample(state);
 sample({...state,transitionSeed:955});load('magi');assert.deepEqual(sample(state),expected,`recreating transition reproduces output (mode ${mode})`);
}

// The classic styles never read the new wire fields: any grid, length, boundary, accent, reduced flag or fadeSeconds draws the same operations.
load('magi');
for(let mode=0;mode<=15;mode++){
 const base={...clock,transitionMode:mode,transitionSeed:77,blend:.4},plain=sample(base).operations;
 for(const extra of [{transitionBeats:1,transitionBoundary:3,transitionAccent:0,transitionReduced:true,fadeSeconds:.5},{transitionBeats:64,fadeSeconds:9,...timedFields}]){
  assert.deepEqual(sample({...base,...extra}).operations,plain,`classic mode ${mode} ignores the new fields`);
 }
}

// Defaults for an absent field: Cross dissolve, four beats, free boundary, NERV accent, full motion, no fadeSeconds, no grid.
{
 load('magi');
 const bare={time:17,localTime:1,progress:.0625,bpm:120,seed:13,previousScene:'boot',blend:.5};
 const result=sample(bare);checkSpy({...bare,transitionSeed:undefined},null,'defaults');
 assert.deepEqual(result.operations,oracle({...bare,transitionMode:1,transitionSeed:13,transitionBeats:4,transitionBoundary:0,transitionAccent:1,transitionReduced:false},'magi'));
 assert.equal(result.frames[1].frame.time,17,'previousTime defaults to time');assert.equal(result.frames[1].frame.localTime,1,'previousLocalTime defaults to localTime');
 send({...frame,nerv:undefined});assert.equal(replies.at(-1).type,'frame','a frame without a clock renders the plain scene');
}

// ---- resolution: one uniform fit inside HARD_MAX_EDGE and HARD_MAX_PIXELS, reported back ----------------------------------------------------
load('magi');
const applied=(width,height)=>{
 frames.length=0;send({...frame,width,height,nerv:{...clock,blend:1}});
 const reply=replies.at(-1);assert.equal(reply.type,'frame',String(reply.message));
 assert.equal(frames.at(-1).w,reply.width);assert.equal(frames.at(-1).h,reply.height);
 assert.equal(lastTransferred.width,reply.width);assert.equal(lastTransferred.height,reply.height);
 return {width:reply.width,height:reply.height};
};
for(const [w,h] of [[99999,99999],[7680,2160],[3840,2160],[4096,2160],[2560,1440],[1920,1080],[1280,720],[640,360],[1366,768],[1001,563],[5000,300],[300,5000],[10,10],[64.9,64.2],[0,0],[-5,300],[1e9,3]]){
 const got=applied(w,h),expected=fitWithin(w,h,HARD_MAX_EDGE,HARD_MAX_PIXELS);
 assert.deepEqual(got,expected,`${w}x${h} follows the shared fit`);
 assert.ok(got.width*got.height<=HARD_MAX_PIXELS&&Math.max(got.width,got.height)<=HARD_MAX_EDGE&&Math.min(got.width,got.height)>=64,`${w}x${h} -> ${got.width}x${got.height}`);
}
{
 const huge=applied(99999,99999);assert.equal(huge.width,huge.height,'a square request stays square');assert.ok(huge.width>1280,'the old per-axis 1280x720 clamp is gone');
 const wide=applied(7680,2160);assert.ok(Math.abs(wide.width/wide.height-7680/2160)<.01,'aspect is preserved by the uniform fit');
 // Every size the resolution policy hands to a worker is applied unchanged (16:9 tiers and a few window shapes).
 for(const [w,h] of [[640,360],[1280,720],[1920,1080],[2560,1440],[3840,2160],[1366,768],[1600,900],[2048,1152],[1000,1000],[800,450]])assert.deepEqual(applied(w,h),{width:w,height:h},`${w}x${h} is inside the caps and stays as asked`);
 for(const bad of [NaN,Infinity,-Infinity,'640',undefined,null]){
  send({...frame,width:bad,nerv:{...clock,blend:1}});assert.equal(replies.at(-1).type,'error');assert.match(replies.at(-1).message,/Invalid scene size/);
  send({...frame,height:bad,nerv:{...clock,blend:1}});assert.equal(replies.at(-1).type,'error');assert.match(replies.at(-1).message,/Invalid scene size/);
 }
 assert.equal(sample(clock).frames.length,2,'still serving after rejected sizes');
}
// A size change during a transition rebuilds every plate at the applied size and replays exactly at the original size.
for(const mode of [14,29,24,19,26,25]){
 load('magi');
 const first=sample({...clock,transitionMode:mode,transitionSeed:5,blend:.6});
 for(const [w,h] of [[1280,720],[3840,2160],[64,64],[1920,1080],[640,360]]){
  const result=sample({...clock,transitionMode:mode,transitionSeed:5,blend:.6},{width:w,height:h});
  const want=fitWithin(w,h,HARD_MAX_EDGE,HARD_MAX_PIXELS);
  assert.ok(result.frames.every(f=>f.w===want.width&&f.h===want.height),`both plates at ${want.width}x${want.height} (mode ${mode})`);
 }
 assert.deepEqual(sample({...clock,transitionMode:mode,transitionSeed:5,blend:.6}),first,`mode ${mode} is stateless across size changes`);
}

// ---- renderMs is a real measurement ---------------------------------------------------------------------------------------------------------
{
 load('magi');
 send({...frame,nerv:{...clock,blend:1}});assert.equal(typeof replies.at(-1).renderMs,'number');assert.ok(Number.isFinite(replies.at(-1).renderMs)&&replies.at(-1).renderMs>=0);
 const original=Object.getOwnPropertyDescriptor(globalThis,'performance');
 try{
  let ticks=0,calls=0;
  Object.defineProperty(globalThis,'performance',{configurable:true,writable:true,value:{now:()=>{calls++;return ticks+=3.5;}}});
  send({...frame,nerv:{...clock,blend:1}});assert.equal(replies.at(-1).renderMs,3.5,'plain frame: end minus start');assert.equal(calls,2,'two clock reads per frame');
  calls=0;send({...frame,nerv:{...clock,blend:.5}});assert.equal(replies.at(-1).renderMs,3.5,'transition frame');assert.equal(calls,2);
  calls=0;send({...frame,generation:0,nerv:clock});assert.equal(calls,0,'an ignored generation costs no measurement');
  Object.defineProperty(globalThis,'performance',{configurable:true,writable:true,value:{now:()=>{ticks-=1;return ticks;}}});
  send({...frame,nerv:{...clock,blend:1}});assert.equal(replies.at(-1).renderMs,0,'a clock that went backwards reports 0, never a negative');
  Object.defineProperty(globalThis,'performance',{configurable:true,writable:true,value:{now:()=>NaN}});
  send({...frame,nerv:{...clock,blend:1}});assert.equal(replies.at(-1).renderMs,0,'NaN reports 0');
 }finally{
  if(original)Object.defineProperty(globalThis,'performance',original);else delete globalThis.performance;
 }
}

// ---- transition surfaces are released as soon as a frame does not need them --------------------------------------------------------------------
{
 globalThis.trackCanvases=true;canvases.length=0;
 load('magi');
 sample({...clock,blend:.5});
 const [nextA,oldA]=canvasLog.map(entry=>entry.id),main=lastTransferred.id;
 assert.notEqual(nextA,oldA);assert.ok(main!==nextA&&main!==oldA,'the output surface is separate from both plates');
 const surfaces=canvases.length;
 sample({...clock,blend:.6});assert.deepEqual(canvasLog.map(entry=>entry.id),[nextA,oldA],'plate surfaces are reused while the transition runs');assert.equal(canvases.length,surfaces,'no allocation while the key is unchanged');
 const byId=id=>canvases.find(c=>c.id===id);
 assert.ok(byId(nextA).width>0&&byId(oldA).width>0);
 sample({...clock,blend:1});
 assert.equal(byId(nextA).width,0);assert.equal(byId(oldA).width,0);assert.equal(byId(nextA).height,0,'blend >= 1 releases both plate surfaces');
 assert.equal(lastTransferred.id,main,'the output surface is kept');
 const plain=canvases.length;for(let i=0;i<5;i++)sample({...clock,blend:1});assert.equal(canvases.length,plain,'steady state allocates nothing');
 sample({...clock,blend:.5});
 const [nextB,oldB]=canvasLog.map(entry=>entry.id);assert.ok(nextB!==nextA&&oldB!==oldA,'the next boundary allocates fresh plate surfaces');assert.equal(lastTransferred.id,main);
 // No outgoing plate, or an outgoing plate without a blend, is a plain frame as well.
 const {previousScene,...noPrevious}=clock;
 sample(noPrevious);assert.equal(byId(nextB).width,0);assert.equal(byId(oldB).width,0);
 sample({...clock,blend:.5});const [nextC,oldC]=canvasLog.map(entry=>entry.id);
 const {blend,...noBlend}=clock;sample(noBlend);assert.equal(byId(nextC).width,0);assert.equal(byId(oldC).width,0);assert.equal(canvasLog.length,1);
 // A new load drops them too, and so does the cached transition (a fresh key allocates a fresh transition and its scratch surfaces).
 sample({...clock,blend:.5});const [nextD,oldD]=canvasLog.map(entry=>entry.id);load('magi');assert.equal(byId(nextD).width,0);assert.equal(byId(oldD).width,0);
 // The transition is cached while the key holds and rebuilt (two new scratch surfaces) when mode, seed, beats, boundary or reduced changes.
 sample({...clock,blend:.5});
 const count=()=>canvases.length;let before=count();
 sample({...clock,blend:.6});assert.equal(count(),before,'same key, no new transition');
 for(const change of [{transitionMode:2},{transitionSeed:122},{transitionBeats:2},{transitionBoundary:1},{transitionReduced:true}]){
  before=count();sample({...clock,blend:.6,...change});assert.equal(count(),before+2,`${JSON.stringify(change)} builds a new transition`);
  before=count();sample({...clock,blend:.7,...change});assert.equal(count(),before,`${JSON.stringify(change)} is cached`);
  sample({...clock,blend:.5});
 }
 // A plain frame drops the cached transition and its scratch surfaces along with the plates: the next boundary allocates two plates and two scratch surfaces again.
 sample({...clock,blend:.5});before=count();sample({...clock,blend:1});sample({...clock,blend:.5});assert.equal(count(),before+4,'plates and transition are rebuilt after a plain frame');
 globalThis.trackCanvases=false;canvases.length=0;
}

// ---- classic modes take the high-quality smoothing on the output surface -----------------------------------------------------------------------
{
 load('magi');
 for(const mode of [1,2,9,14]){
  sample({...clock,transitionMode:mode,blend:.4});
  const rows=smoothLog.filter(row=>row.id===lastTransferred.id);
  assert.ok(rows.length>0&&rows.every(row=>row.enabled===true&&row.quality==='high'),`mode ${mode}: smooth transition surfaces`);
 }
 const reference=oracle({...clock,transitionMode:9,blend:.4},'magi');assert.deepEqual(sample({...clock,transitionMode:9,blend:.4}).operations,reference);
}

// ---- the env: beat and bar phase from the saved grid or the legacy tempo, length, seconds, level and accent -----------------------------------------------
{
 load('magi');
 const loud={waveform:[new Uint8Array(576),new Uint8Array(576)],spectrum:[new Uint8Array(576).fill(200),new Uint8Array(576).fill(200)],beat:false,beatLevel:0};
 const mapped={offset:.25,bpm:100,beatsPerBar:3,changes:[[5,140]]};
 const scenarios=[
  ['legacy tempo',{...clock,bpm:100,time:20,localTime:2.3},null],
  ['gridded, tempo map, fadeSeconds',{...clock,bpm:140,time:6.1,localTime:2.6,grid:mapped,sceneStart:3.5,sceneEnd:12,previousSceneStart:0,previousSceneEnd:3.5,transitionBeats:6,transitionBoundary:2,fadeSeconds:2.4},null],
  ['legacy tempo, loud audio',{...clock,bpm:126,time:41,localTime:5.15},loud],
  ['gridded, loud audio, neutral accent',{...clock,bpm:100,time:2.9,localTime:.4,grid:{offset:.1,bpm:97,beatsPerBar:5},sceneStart:2.5,sceneEnd:20,transitionAccent:0,transitionBeats:2},loud],
  ['tempo-map step, stale frame tempo',{...clock,bpm:60,time:17,localTime:1,grid:{offset:.25,bpm:100,beatsPerBar:3,changes:[[5,140]]},sceneStart:16,sceneEnd:24,transitionBeats:8},loud],
 ];
 load('magi');   // a fresh cache: the first frame of every mode builds its transition, the second reuses it
 for(const [name,nerv,audio] of scenarios)for(let mode=0;mode<TRANSITION_COUNT;mode++)for(const blend of [.3,.7]){
  const n={...nerv,transitionMode:mode,transitionSeed:31337+mode,blend};
  assert.deepEqual(sample(n,audio?{audio}:{}).operations,oracle(n,'magi',{audio}),`${name}: mode ${mode} at ${blend}`);
  checkSpy(n,audio,`${name}: mode ${mode} at ${blend}`,{fresh:blend===.3});
 }
 // Sensitivity: each input really reaches the drawing (a wrong env produces different operations).
 const beatPhased={...clock,bpm:100,time:20,localTime:2.3,transitionMode:28,transitionSeed:5,blend:.5};
 const worker=sample(beatPhased).operations;
 assert.notDeepEqual(worker,oracle(beatPhased,'magi',{env:{beatPhase:0}}),'beat phase reaches Kick-Punch Zoom');
 assert.notDeepEqual(sample(beatPhased,{audio:loud}).operations,worker,'audio level reaches Kick-Punch Zoom');
 assert.notDeepEqual(sample({...beatPhased,grid:{offset:.31,bpm:100,beatsPerBar:4}}).operations,worker,'a saved grid moves the beat phase');
 const stepped={...clock,bpm:120,transitionMode:16,transitionSeed:8,transitionBeats:8,blend:.3};
 assert.notDeepEqual(sample({...stepped,fadeSeconds:.5}).operations,sample(stepped).operations,'fadeSeconds is the transition length in seconds (step rate cap)');
 const mappedRate={...stepped,bpm:60,grid:{offset:.25,bpm:100,beatsPerBar:3,changes:[[5,140]]}};
 const mappedOps=sample(mappedRate).operations;
 assert.equal(transitionLog.find(e=>e.event==='draw').env.bpm,140,'the saved grid supplies the current tempo after a tempo-map step');
 assert.notDeepEqual(mappedOps,oracle(mappedRate,'magi',{env:{bpm:60}}),'a stale frame tempo must not change the rate cap of a mapped transition');
 const hazard={...clock,transitionMode:17,transitionSeed:8,blend:.4};
 const orange=sample({...hazard,transitionAccent:1}).operations,cool=sample({...hazard,transitionAccent:0}).operations;
 assert.notDeepEqual(orange,cool,'accent selects the palette');assert.ok(JSON.stringify(orange).includes('#ff8526')&&!JSON.stringify(cool).includes('#ff8526'));
 assert.deepEqual(sample(hazard).operations,orange,'accent defaults to the NERV palette');
 const reduced=sample({...clock,transitionMode:24,transitionSeed:8,transitionReduced:true,blend:.4}).operations;
 assert.deepEqual(reduced,sample({...clock,transitionMode:1,transitionSeed:8,transitionReduced:false,blend:.4}).operations.map(op=>op),'a non-calm style under reduced motion is Cross dissolve');
 assert.notDeepEqual(reduced,sample({...clock,transitionMode:24,transitionSeed:8,blend:.4}).operations);
}

// ---- selectors: the context (length, boundary, NERV pair, reduced) reaches the pick, and every part of the cache key matters ------------------------------
{
 const base={beatsTotal:4,boundary:1,nervPair:true,reducedMotion:false};
 const find=(mode,a,b)=>{for(let seed=1;seed<600;seed++)if(resolveTransitionMode(mode,seed,a)!==resolveTransitionMode(mode,seed,b))return seed;assert.fail(`no discriminating seed for mode ${mode}`);};
 const dimensions=[
  ['beats',32,{...base,beatsTotal:.5},{...base,beatsTotal:16},{transitionBeats:.5},{transitionBeats:16}],
  ['boundary',32,{...base,boundary:0},{...base,boundary:3},{transitionBoundary:0},{transitionBoundary:3}],
  ['reduced',31,{...base,reducedMotion:false},{...base,reducedMotion:true},{transitionReduced:false},{transitionReduced:true}],
 ];
 for(const [name,mode,ctxA,ctxB,wireA,wireB] of dimensions){
  const seed=find(mode,ctxA,ctxB);
  const a={...clock,transitionMode:mode,transitionSeed:seed,blend:.45,transitionBeats:4,transitionBoundary:1,...wireA};
  const b={...clock,transitionMode:mode,transitionSeed:seed,blend:.45,transitionBeats:4,transitionBoundary:1,...wireB};
  load('magi');const fresh=sample(b);
  load('magi');const first=sample(a);assert.notDeepEqual(first.operations,fresh.operations,`${name}: the two contexts pick different styles`);
  assert.deepEqual(sample(b),fresh,`${name}: a changed ${name} rebuilds the transition (cache key)`);
  assert.deepEqual(sample(a),first,`${name}: and back`);
 }
 // The plates are NERV scenes, so Smart random is called with nervPair true: the pick is the NERV-pair pick, not the generic one.
 const seed=find(32,base,{...base,nervPair:false});
 const wire={...clock,transitionMode:32,transitionSeed:seed,blend:.45,transitionBeats:4,transitionBoundary:1};
 load('magi');
 assert.deepEqual(sample(wire).operations,oracle(wire,'magi'));
 assert.notDeepEqual(sample(wire).operations,oracle(wire,'magi',{context:{nervPair:false}}),'nervPair is true on the NERV worker');
 for(const mode of [31,32])for(let seed=1;seed<=120;seed++)for(const [beats,boundary,reduced] of [[.5,0,false],[2,2,false],[4,3,true],[8,1,false],[64,3,false]]){
  const wired={...clock,transitionMode:mode,transitionSeed:seed,transitionBeats:beats,transitionBoundary:boundary,transitionReduced:reduced,blend:.35};
  const concrete=resolveTransitionMode(mode,seed,{beatsTotal:beats,boundary,nervPair:true,reducedMotion:reduced});
  assert.ok(concrete!==0&&concrete!==15&&concrete!==31&&concrete!==32);
  if(seed%20===1)assert.deepEqual(sample(wired).operations,oracle({...wired,transitionMode:concrete},'magi'),`selector ${mode} (seed ${seed}, ${beats} beats) equals its concrete style ${concrete}`);
 }
}

// ---- timing reaches both plates: the saved grid and each plate's own scene bounds ----------------------------------------------------------------------
{
 load('magi');
 const grid={offset:.25,bpm:100,beatsPerBar:3,changes:[[5,140]]};
 const timed={...clock,blend:.4,grid,sceneStart:16,sceneEnd:24,previousSceneStart:8,previousSceneEnd:16};
 const result=sample(timed),[nextPlate,oldPlate]=result.frames.map(f=>f.frame);
 assert.equal(nextPlate.scene,'magi');assert.equal(nextPlate.time,17);assert.equal(nextPlate.localTime,1);assert.equal(nextPlate.progress,.0625);
 assert.equal(nextPlate.sceneStart,16);assert.equal(nextPlate.sceneEnd,24);assert.deepEqual(nextPlate.grid,grid);
 assert.equal(oldPlate.scene,'boot');assert.equal(oldPlate.time,16);assert.equal(oldPlate.localTime,16);assert.equal(oldPlate.progress,1);
 assert.equal(oldPlate.sceneStart,8,'the outgoing plate has its own interval');assert.equal(oldPlate.sceneEnd,16);assert.deepEqual(oldPlate.grid,grid);
 const keys=['audio','bpm','grid','localTime','progress','scene','sceneEnd','sceneStart','seed','time'];
 assert.deepEqual(Object.keys(nextPlate).sort(),keys);assert.deepEqual(Object.keys(oldPlate).sort(),keys,'plates carry scene-frame keys only');
 // Without its own bounds the outgoing plate never inherits the incoming scene's interval.
 const {previousSceneStart,previousSceneEnd,...partial}=timed;
 const inherit=sample(partial).frames[1].frame;assert.ok(!('sceneStart' in inherit)&&!('sceneEnd' in inherit),'no inherited bounds');assert.deepEqual(inherit.grid,grid);
 const onlyEnd=sample({...partial,previousSceneEnd:16}).frames[1].frame;assert.ok(!('sceneStart' in onlyEnd));assert.equal(onlyEnd.sceneEnd,16);
 // null means absent; no grid means no grid key (the plates then use the legacy tempo derivation).
 const nulls=sample({...timed,grid:null,sceneStart:null,sceneEnd:null,previousSceneStart:null,previousSceneEnd:null});
 for(const plate of nulls.frames.map(f=>f.frame))for(const key of ['grid','sceneStart','sceneEnd'])assert.ok(!(key in plate),`null ${key} is dropped`);
 const legacy=sample(clock).frames.map(f=>f.frame);for(const plate of legacy)assert.deepEqual(Object.keys(plate).sort(),['audio','bpm','localTime','progress','scene','seed','time']);
 // A plain frame carries the incoming scene's grid and bounds.
 const plain=sample({...timed,blend:1}).frames[0].frame;assert.equal(plain.sceneStart,16);assert.equal(plain.sceneEnd,24);assert.deepEqual(plain.grid,grid);
 // The saved grid is not mutated and is shared by both plates.
 assert.deepEqual(grid,{offset:.25,bpm:100,beatsPerBar:3,changes:[[5,140]]});
}

// ---- wire validation ---------------------------------------------------------------------------------------------------------------------------------
{
 load('magi');
 const okGrid={offset:.5,bpm:120,beatsPerBar:4};
 const changes=n=>Array.from({length:n},(_,i)=>[1+i,100+i%100]);
 const CLOCK='Invalid transition clock',TRANSITION='Invalid scene transition',SCENE='Invalid scene clock';
 const invalid=[
  [SCENE,{time:NaN}],[SCENE,{localTime:Infinity}],[SCENE,{progress:NaN}],[SCENE,{bpm:NaN}],[SCENE,{seed:NaN}],
  [CLOCK,{previousTime:Infinity}],[CLOCK,{previousLocalTime:NaN}],[CLOCK,{blend:NaN}],[CLOCK,{transitionSeed:NaN}],[CLOCK,{transitionMode:NaN}],[CLOCK,{transitionMode:'1'}],[CLOCK,{previousTime:null}],
  [TRANSITION,{transitionMode:33}],[TRANSITION,{transitionMode:-1}],[TRANSITION,{transitionMode:.5}],[TRANSITION,{transitionMode:TRANSITION_COUNT}],
  ['Invalid previous scene',{previousScene:'unknown'}],
  [TRANSITION,{transitionBeats:0}],[TRANSITION,{transitionBeats:-1}],[TRANSITION,{transitionBeats:65}],[TRANSITION,{transitionBeats:64.0001}],
  [CLOCK,{transitionBeats:NaN}],[CLOCK,{transitionBeats:Infinity}],[CLOCK,{transitionBeats:'4'}],[CLOCK,{transitionBeats:null}],
  [TRANSITION,{transitionBoundary:4}],[TRANSITION,{transitionBoundary:-1}],[TRANSITION,{transitionBoundary:1.5}],[TRANSITION,{transitionBoundary:NaN}],[TRANSITION,{transitionBoundary:'1'}],[TRANSITION,{transitionBoundary:null}],
  [TRANSITION,{transitionAccent:2}],[TRANSITION,{transitionAccent:-1}],[TRANSITION,{transitionAccent:.5}],[TRANSITION,{transitionAccent:NaN}],[TRANSITION,{transitionAccent:'1'}],[TRANSITION,{transitionAccent:null}],
  [TRANSITION,{transitionReduced:1}],[TRANSITION,{transitionReduced:0}],[TRANSITION,{transitionReduced:'true'}],[TRANSITION,{transitionReduced:null}],
  [CLOCK,{fadeSeconds:-1}],[CLOCK,{fadeSeconds:-1e-9}],[CLOCK,{fadeSeconds:NaN}],[CLOCK,{fadeSeconds:Infinity}],[CLOCK,{fadeSeconds:'1'}],[CLOCK,{fadeSeconds:null}],
  ...['sceneStart','sceneEnd','previousSceneStart','previousSceneEnd'].flatMap(key=>[NaN,Infinity,-Infinity,'1',true].map(value=>[CLOCK,{[key]:value}])),
  ...[5,'grid',true,[],{...okGrid,offset:NaN},{...okGrid,offset:Infinity},{...okGrid,offset:'1'},{...okGrid,bpm:19.9},{...okGrid,bpm:400.1},{...okGrid,bpm:NaN},{...okGrid,bpm:undefined},
   {...okGrid,beatsPerBar:0},{...okGrid,beatsPerBar:17},{...okGrid,beatsPerBar:1.5},{...okGrid,beatsPerBar:NaN},{...okGrid,beatsPerBar:undefined},
   {...okGrid,changes:5},{...okGrid,changes:'abc'},{...okGrid,changes:{length:1}},{...okGrid,changes:[[1]]},{...okGrid,changes:[null]},{...okGrid,changes:[5]},{...okGrid,changes:[[NaN,130]]},{...okGrid,changes:[[2,NaN]]},
   {...okGrid,changes:[[2,10]]},{...okGrid,changes:[[2,401]]},{...okGrid,changes:[[.5,130]]},{...okGrid,changes:[[.4,130]]},{...okGrid,changes:[[1,130],[1,140]]},{...okGrid,changes:[[3,130],[2,140]]},{...okGrid,changes:changes(257)}]
   .map(value=>[CLOCK,{grid:value}]),
 ];
 for(const [message,patch] of invalid){
  send({...frame,nerv:{...clock,...patch}});
  const reply=replies.at(-1);
  assert.equal(reply.type,'error',`${JSON.stringify(patch)} is rejected`);assert.equal(reply.fatal,true);assert.equal(reply.generation,1);assert.ok(reply.message.includes(message),`${JSON.stringify(patch)}: ${reply.message}`);
  assert.equal(sample(clock).frames.length,2,'the worker keeps serving after a rejected frame');
 }
 // The same values are rejected when no transition is in flight (a plain frame validates its whole clock).
 for(const patch of [{transitionBeats:0},{transitionBoundary:4},{transitionAccent:2},{transitionReduced:'no'},{fadeSeconds:-1},{grid:{...okGrid,bpm:0}},{sceneStart:NaN}]){
  send({...frame,nerv:{...clock,...patch,blend:1}});assert.equal(replies.at(-1).type,'error',`${JSON.stringify(patch)} on a plain frame`);
 }
 const valid=[{},{transitionBeats:.25},{transitionBeats:64},{transitionBeats:1e-9},{transitionBoundary:0},{transitionBoundary:3},{transitionAccent:0},{transitionAccent:1},{transitionReduced:true},{transitionReduced:false},
  {fadeSeconds:0},{fadeSeconds:1e6},{grid:null},{grid:okGrid},{grid:{...okGrid,changes:[]}},{grid:{...okGrid,changes:changes(256)}},{grid:{offset:-3,bpm:20,beatsPerBar:1}},{grid:{offset:0,bpm:400,beatsPerBar:16}},
  {sceneStart:null,sceneEnd:null,previousSceneStart:null,previousSceneEnd:null},{sceneStart:-5,sceneEnd:-1},{sceneStart:9,sceneEnd:3},{previousSceneEnd:null},
  {transitionMode:0},{transitionMode:15},{transitionMode:32},{blend:-1},{blend:0},{blend:2}];
 for(const patch of valid){send({...frame,nerv:{...clock,...patch}});assert.equal(replies.at(-1).type,'frame',`${JSON.stringify(patch).slice(0,80)} is accepted: ${replies.at(-1).message}`);}
}

// Direct look at the transition module: seeded Random must reach every animated style and its block order varies across boundary seeds.
const selected=new Set(),orders=new Set();
for(let seed=0;seed<256;seed++){
 const a=new AvsTransition(0,{seed,createCanvas}),b=new AvsTransition(0,{seed,createCanvas});
 assert.equal(a.mode,b.mode);assert.deepEqual(a.order,b.order);assert.equal(new Set(a.order).size,9);
 selected.add(a.mode);orders.add(a.order.join(','));
}
assert.equal(selected.size,14,'seeded Random must reach every animated style');assert.ok(orders.size>200,'block order varies across boundary seeds');
load('magi');
const before=frames.length;send({...frame,generation:0});assert.equal(frames.length,before,'old generation ignored');
send({...frame,generation:7,nerv:{...clock,blend:1}});assert.equal(frames.length,before,'a future generation is ignored as well');
// Range flag day (contract C-02) and the newer styles: stored indices 16..32 are valid on the wire.
for(const mode of [16,31,32])sample({...clock,transitionMode:mode});
for(const invalid of [{time:NaN},{blend:NaN},{previousTime:Infinity},{previousLocalTime:NaN},{transitionMode:33},{transitionMode:-1},{transitionMode:.5},{transitionSeed:NaN},{previousScene:'unknown'}]){
 send({...frame,nerv:{...clock,...invalid}});assert.equal(replies.at(-1).type,'error');
}
for(const data of [{format:'mpcaaavs-nerv',version:1,scene:'unknown'},{format:'mpcaaavs-nerv',version:2,scene:'boot'},{format:'arbitrary-code',version:1,scene:'boot'}]){
 send({type:'load',generation:2,preset:new TextEncoder().encode(JSON.stringify(data)).buffer});assert.equal(replies.at(-1).type,'error');
}
send({type:'load',generation:2,preset:new Uint8Array(4097).buffer});assert.equal(replies.at(-1).type,'error');
console.log('NERV worker CPU: 240 directed pairs x 16 classic modes and 24 pairs x modes 16-32 (endpoints, quarter progress, seek replay, contract env and context oracle), uniform HARD_MAX fit with applied size, real renderMs, surface and transition release, smoothing, timing plates and grid, cache key (mode:seed:beats:boundary:reduced), selector context, wire validation, seeded style/block recreation, no self-sampling, manifest/clock bounds, generation isolation PASS (visual raster acceptance pending)');
