import {build} from 'esbuild';
import assert from 'node:assert/strict';
// Host-level folder playback and persistence assertions (CONTRACT 3.6: each stream's host checks live in its own check-host-<stream>.mjs).
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
 b.onLoad({filter:/.*/,namespace:'fixture'},args=>({contents:args.path.includes('local-collection')?`export async function fetchLocalAvsCatalog(){return globalThis.catalog;} export function fetchLocalAvsPreset(p){return globalThis.fetchPreset(p);} export const isSceneKind=p=>p?.kind==='nerv'||p?.kind==='hud'; export async function fetchLocalAvsSources(){return new Map();} export function parseLocalAvsSources(){return new Map();}`:args.path.includes('management')?`export class PresetManagement {open=false; constructor(a){globalThis.actions=a;} refresh(){} show(){} receive(...a){(globalThis.managementMessages ||= []).push(a);} noteCommit(...a){(globalThis.managementCommits ||= []).push(a);} playLastFolder(){globalThis.lastFolderCalls=(globalThis.lastFolderCalls||0)+1;}}`:`export async function loadPresetBitmaps(){throw Error('NERV must not fetch historical bitmap packages');}`}));
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

// A real host with fake transport: folder activation is atomic and follows its own ordered pool.
const env=await boot();
assert.equal(env.actions.source().kind,'library');
const makePlan=(patch={})=>({ok:true,key:'nerv',label:'Fixture folder',order:[4,2,8],total:3,skipped:{unavailable:0,missing:0,partial:0},startAt:null,settings:null,timing:null,options:'live',note:'',...patch});
let response=env.actions.playFolder(makePlan());
assert.deepEqual(response,{ok:true,eligible:3});
await env.flush();await env.load();
assert.equal(env.fetches.at(-1).p,catalog[4]);
assert.deepEqual(env.actions.source(),{kind:'folder',key:'nerv',label:'Fixture folder',total:3});
env.msg({type:'next'});await env.flush();await env.load();assert.equal(env.fetches.at(-1).p,catalog[2]);
const source=structuredClone(env.actions.source()),before=env.fetches.length;
for(const order of [[],[9999],['bad'],null]){
 response=env.actions.playFolder(makePlan({order}));assert.equal(response.ok,false);assert.deepEqual(env.actions.source(),source);assert.equal(env.fetches.length,before);
}
response=env.actions.playFolder(makePlan({startAt:8}));assert.equal(response.ok,true);await env.flush();await env.load();assert.equal(env.fetches.at(-1).p,catalog[8]);
assert.equal(env.actions.timing().enabled,false);
env.actions.stopFolder();assert.equal(env.actions.source().kind,'library');
const setup=env.actions.nervSetup();env.actions.activate(setup);assert.equal(env.actions.source().kind,'setup');
await env.flush();await env.load();env.actions.activate(null);assert.equal(env.actions.source().kind,'library');
const routed=[{type:'state-loaded',name:'folders',data:null},{type:'state-saved',name:'stats'},{type:'library-error',operation:'load-state',name:'folders',message:'Unknown library request'}];
const posted=env.posted.length;
for(const m of routed)env.msg(m);
assert.equal(globalThis.managementMessages.length,3);assert.equal(env.posted.length,posted,'state errors do not issue unsolicited host commands');
env.msg({type:'play-folder'});assert.equal(globalThis.lastFolderCalls,1);
assert.ok(globalThis.managementCommits.length>0,'commits reach play statistics');
assert.ok(typeof env.actions.sources==='function'&&typeof env.actions.taxa==='function');
env.pagehide();
console.log('Host folders PASS: real host ordered playback, start-at, invalid plan atomicity, Stop/library/setup source, clock reset, persisted-state routing, old-host errors, last-folder command and commit statistics');
