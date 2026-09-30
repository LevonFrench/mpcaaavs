import {build} from 'esbuild';
import assert from 'node:assert/strict';

// Real selection/clock/bridge code; only DOM, workers, disk and tempo acquisition
// are fixtures. This test never launches the player or creates a graphics device.
const bundle=await build({entryPoints:['src/mpc-host.ts'],bundle:true,format:'esm',write:false,define:{'import.meta.url':'"https://aaavs.invalid/dist/mpc-host.js"'},plugins:[{name:'selection-fixture',setup(b){
  b.onResolve({filter:/(local-collection|mpc-management|mpc-bitmap-dependencies|mpc-auto-director)\.ts$/},args=>({path:args.path,namespace:'fixture'}));
  b.onLoad({filter:/.*/,namespace:'fixture'},args=>({contents:args.path.includes('local-collection')
    ?`export async function fetchLocalAvsCatalog(){return globalThis.selectionCatalog;} export function fetchLocalAvsPreset(p){return globalThis.selectionFetch(p);} export function isSceneKind(p){return p?.kind==='nerv'||p?.kind==='hud'} export async function fetchLocalAvsSources(){return new Map()}`
    :args.path.includes('management')?`export class PresetManagement {open=false;constructor(a){globalThis.selectionActions=a;}refresh(){}show(){}receive(){}}`
    :args.path.includes('auto-director')?`export class MpcAutoDirector {enabled=true;bars=0;energy=1;tempo={locked:true,bpm:120};remainingBars=1;reset(){}rearm(){}configure(enabled,bars){this.enabled=enabled;this.bars=bars??0;}update(){const action=globalThis.selectionAutoAction;globalThis.selectionAutoAction={prepare:false,switch:false};return this.enabled?action:{prepare:false,switch:false};}}`
    :`export async function loadPresetBitmaps(){return [];}`}));
}}]});
const scenes=['boot','magi','psycho','radar','harmonics','seele','battery','atfield','alert'];
const defaults={enabled:false,bars:0,shuffle:true,minimumRating:0,transition:15,beats:0,durationMs:1000,keepOld:false,manualFade:false,autoFade:false};
let instance=0;
async function harness(nerv=false){
  const catalog=scenes.map((scene,index)=>({name:`Preset ${index}`,sha256:index.toString(16).padStart(64,'0'),fileName:`${index}.avs`,autoEligible:index!==7,rating:Math.min(index,5),notWorking:index===6,...(nerv?{kind:'nerv',scene}:{kind:'avs'})}));
  const nodes=new Map(),posted=[],workers=[],fetches=[];let listener,raf,pagehide,now=0;
  const ctx={clearRect(){},setTransform(){},globalAlpha:1,drawImage(){},getImageData(){return {data:new Uint8ClampedArray(256*144*4)};},save(){},restore(){},beginPath(){},rect(){},clip(){},fillRect(){},createPattern(){return {};}};
  const canvas=()=>({width:640,height:360,clientWidth:640,clientHeight:360,getContext(){return {...ctx,canvas:this};}});
  globalThis.fetch=async()=>{throw Error('offline fixture')};globalThis.selectionCatalog=catalog;globalThis.selectionAutoAction={prepare:false,switch:false};
  globalThis.selectionFetch=p=>new Promise((resolve,reject)=>fetches.push({p,resolved:false,resolve(){this.resolved=true;resolve(new Uint8Array([parseInt(p.sha256,16)+1,0,0,0]));},reject}));
  globalThis.OffscreenCanvas=class {constructor(){Object.assign(this,canvas());}};
  globalThis.document={hidden:false,baseURI:'https://aaavs.invalid/mpc.html',body:{append(){},classList:{add(){},remove(){}}},createElement:canvas,querySelector(id){if(!nodes.has(id))nodes.set(id,id==='#visualizer'?canvas():{textContent:''});return nodes.get(id);},addEventListener(){}};
  globalThis.window={chrome:{webview:{postMessage(m){posted.push(m);},addEventListener(_,fn){listener=fn;}}},setTimeout(){return 1;},addEventListener(t,fn){if(t==='pagehide')pagehide=fn;}};
  globalThis.clearTimeout=()=>{};globalThis.requestAnimationFrame=fn=>raf=fn;globalThis.devicePixelRatio=1;
  Object.defineProperty(globalThis,'performance',{value:{now:()=>now},configurable:true});
  globalThis.Worker=class {constructor(){this.requests=[];this.dead=false;workers.push(this);}postMessage(m){if(m.type==='load')this.index=new Uint8Array(m.preset)[0]-1;this.requests.push(m);}terminate(){this.dead=true;}send(type){const bitmap={width:640,height:360,closed:false,close(){this.closed=true;}};this.onmessage({data:{type,bitmap}});return bitmap;}};
  const flush=async()=>{for(let i=0;i<16;i++)await Promise.resolve();};
  const msg=data=>listener({data});
  const audio=(position,playing=false)=>msg({type:'audio',playing,position,epoch:1,pcm:Array(1152).fill(0)});
  const tick=()=>{now+=16;raf(now);};
  // Worker index is assigned by its load request before it reports ready.
  const finish=async()=>{const request=fetches.at(-1);assert.ok(request&&!request.resolved,'finish needs a fresh pending fetch');request.resolve();await flush();const worker=workers.at(-1);assert.equal(worker.index,parseInt(request.p.sha256,16));worker.send('ready');worker.send('frame');return worker;};
  await import(`data:text/javascript;base64,${Buffer.from(bundle.outputFiles[0].text+`\n// selection fixture ${instance++}`).toString('base64')}`);
  await flush();await finish();
  const actions=globalThis.selectionActions;
  const libraries=()=>posted.filter(m=>m.startsWith('library:')).map(m=>JSON.parse(m.slice(8)));
  const active=()=>workers.findLast(w=>!w.dead&&w.index===actions.current());
  const lastRender=worker=>worker.requests.filter(r=>r.type==='render').at(-1);
  const settings=extra=>msg({type:'settings',...defaults,...extra});
  const choose=async index=>{actions.load(index);await flush();return finish();};
  const markAck=(index,value)=>{msg({type:'not-working-saved',entry:{sha256:catalog[index].sha256,notWorking:value}});};
  const mark=(index,value)=>{actions.markNotWorking(index,value);markAck(index,value);};
  const setup=(indices,extra={},timing)=>({id:'selection-fixture',name:'Selection fixture',presets:indices.map(i=>catalog[i].sha256),settings:{...defaults,...extra},...(timing?{timing}: {})});
  return {catalog,nodes,posted,workers,fetches,msg,audio,tick,flush,finish,actions,libraries,active,lastRender,settings,choose,markAck,mark,setup,close:()=>pagehide()};
}
const originalRandom=Math.random;
Math.random=()=>0;
try{
  let h=await harness();
  // Every threshold is inclusive; broken, unparseable and lower-rated presets
  // remain excluded even when random selection samples both ends of the pool.
  for(let minimumRating=0;minimumRating<=5;minimumRating++){
    h.settings({minimumRating});await h.choose(0);
    h.msg({type:'next'});await h.flush();assert.equal(parseInt(h.fetches.at(-1).p.sha256,16),Math.max(1,minimumRating));await h.finish();
    for(const random of [.999,0,.5]){Math.random=()=>random;h.msg({type:'next'});await h.flush();const picked=h.fetches.at(-1).p;assert.ok(picked.rating>=minimumRating);assert.ok(!picked.notWorking&&picked.autoEligible);await h.finish();}
    Math.random=()=>0;
  }
  h.settings({minimumRating:0});await h.choose(1);h.msg({type:'next'});await h.flush();assert.equal(h.fetches.at(-1).p.rating,0,'All ratings includes unrated presets');await h.finish();
  // A sole eligible current preset and an empty pool both hold, with no fallback.
  h.settings({minimumRating:5});h.mark(8,true);await h.choose(5);let count=h.fetches.length;h.msg({type:'next'});await h.flush();assert.equal(h.fetches.length,count,'current-only pool holds');
  h.mark(5,true);h.msg({type:'next'});await h.flush();assert.equal(h.fetches.length,count,'empty pool never falls back to lower ratings');
  h.settings({minimumRating:5,enabled:true});globalThis.selectionAutoAction={prepare:true,switch:true};h.audio(.1,true);await h.flush();assert.equal(h.fetches.length,count,'adaptive Auto holds an empty pool');
  h.tick();assert.match(h.nodes.get('#timing').textContent,/no eligible/i);
  h.close();

  h=await harness();h.settings({minimumRating:0});
  // F8/native marking follows the displayed preset while another one loads.
  h.msg({type:'next'});await h.flush();const incoming=h.fetches.at(-1);assert.equal(incoming.p.name,'Preset 1');
  h.msg({type:'not-working'});h.msg({type:'not-working'});
  let requests=h.libraries().filter(r=>r.op==='set-not-working');assert.equal(requests.length,1);assert.equal(requests[0].hash,h.catalog[0].sha256);
  h.actions.markNotWorking(2,true);assert.equal(h.libraries().filter(r=>r.op==='set-not-working').length,1,'mark writes queue until acknowledgment');
  h.markAck(0,true);requests=h.libraries().filter(r=>r.op==='set-not-working');assert.equal(requests.length,2);assert.equal(requests[1].hash,h.catalog[2].sha256);h.markAck(2,true);await h.finish();assert.equal(h.actions.current(),1);
  h.mark(0,false);assert.equal(h.actions.catalog()[0].notWorking,false,'clearing a persisted flag restores the catalog entry');
  h.actions.markNotWorking(3,true);h.actions.markNotWorking(4,true);h.msg({type:'library-error',operation:'set-not-working',message:'Fixture disk is read-only'});
  assert.equal(h.actions.catalog()[3].notWorking,false,'failed writes do not change visible catalog state');
  count=h.libraries().filter(r=>r.op==='set-not-working').length;h.actions.markNotWorking(4,true);assert.equal(h.libraries().filter(r=>r.op==='set-not-working').length,count+1,'failed mark queue can be retried');h.markAck(4,true);h.mark(4,false);
  // A rating change invalidates a pending shuffle target before it renders.
  h.settings({minimumRating:4});await h.choose(0);h.msg({type:'next'});await h.flush();const stale=h.fetches.at(-1);assert.equal(stale.p.name,'Preset 4');
  h.actions.rate(4,1);h.msg({type:'rating-saved',entry:{sha256:h.catalog[4].sha256,rating:1,canonical_path:'presets/unique/4 [1 stars].avs'}});
  count=h.workers.length;stale.resolve();await h.flush();assert.equal(h.workers.length,count,'ineligible incoming preset is canceled before worker creation');assert.equal(h.actions.current(),0);
  h.close();

  h=await harness();h.settings({minimumRating:4,enabled:true});
  // Controlled phrase boundaries exercise the real adaptive host branch.
  globalThis.selectionAutoAction={prepare:true,switch:false};h.audio(.1,true);await h.flush();assert.equal(h.fetches.at(-1).p.name,'Preset 4');await h.finish();assert.equal(h.actions.current(),0,'prepared Auto preset waits for a musical boundary');
  globalThis.selectionAutoAction={prepare:false,switch:true};h.audio(.2,true);assert.equal(h.actions.current(),4);
  h.actions.activate(h.setup([2,3,5,6],{minimumRating:3,enabled:true}));await h.flush();await h.finish();assert.equal(h.actions.current(),3);
  h.msg({type:'next'});await h.flush();assert.equal(h.fetches.at(-1).p.name,'Preset 5');await h.finish();
  globalThis.selectionAutoAction={prepare:true,switch:false};h.audio(.3,true);await h.flush();assert.equal(h.fetches.at(-1).p.name,'Preset 3','adaptive setup shuffle respects both membership and rating');await h.finish();
  globalThis.selectionAutoAction={prepare:false,switch:true};h.audio(.4,true);assert.equal(h.actions.current(),3);
  // A successful manual retest clears a session failure and allows Auto to retry it.
  h.actions.activate(null);h.settings({minimumRating:4,enabled:true});const failedWorker=await h.choose(4);failedWorker.send('error');await h.choose(4);await h.choose(0);
  globalThis.selectionAutoAction={prepare:true,switch:false};h.audio(.5,true);await h.flush();assert.equal(h.fetches.at(-1).p.name,'Preset 4','successful retest restores automatic eligibility');await h.finish();
  h.close();

  h=await harness(true);
  const timing={enabled:true,bpm:120,offsetSeconds:0,barsPerScene:1,seed:89};
  assert.throws(()=>h.actions.activate(h.setup([0,1,2,3,4,5,6,7,8],{minimumRating:3,enabled:true},timing)),/unavailable/);
  // A quantized manual queue (here: next bar) queues scene-kind picks on the clock; the default (immediate) is checked below.
  h.actions.activate(h.setup([0,1,2,3,4,5,6,8],{minimumRating:3,enabled:true,queueQuantize:2},timing));await h.flush();await h.finish();
  const allowed=new Set([3,4,5,8]);
  async function seek(position){const before=h.fetches.length;h.audio(position);await h.flush();if(h.fetches.length>before)await h.finish();h.tick();const worker=h.active();if(worker.requests.at(-1)?.type==='render')worker.send('frame');assert.ok(allowed.has(h.actions.current()),'scene clock stays in the filtered pool');return structuredClone(h.lastRender(worker).nerv);}
  const first=await seek(4.25),firstIndex=h.actions.current();await seek(27.25);const repeated=await seek(4.25);assert.equal(h.actions.current(),firstIndex);assert.deepEqual(repeated,first,'seeded filtered clock repeats identical scene timing after seeks');
  // Queue an eligible scene, then mark it while its preload is in flight.
  const target=[...allowed].find(i=>i!==h.actions.current());h.actions.load(target);await h.flush();const queued=h.fetches.at(-1);assert.equal(parseInt(queued.p.sha256,16),target);
  h.mark(target,true);allowed.delete(target);queued.resolve();await h.flush();
  const latest=h.fetches.at(-1);if(!latest.resolved)await h.finish();h.tick();
  assert.ok(!h.workers.some(w=>!w.dead&&w.index===target),'marked queued scene is never committed');
  assert.ok(!h.nodes.get('#timing').textContent.includes(`queued Preset ${target}`),'ineligible cue is removed from the clock');
  for(const position of [6.25,16.25,4.25])await seek(position);
  // Making every remaining clock candidate ineligible must not crash cue validation
  // or silently select a low-rated preset.
  for(const index of allowed)h.mark(index,true);await h.flush();count=h.fetches.length;h.audio(40.25);h.tick();await h.flush();assert.equal(h.fetches.length,count);assert.match(h.nodes.get('#timing').textContent,/no eligible/i);
  h.close();

  // Default manual queue (immediate): a manual pick in a scene set switches now instead of waiting for the next scene boundary.
  h=await harness(true);
  h.actions.activate(h.setup([0,1,2,3,4,5,6,8],{minimumRating:3,enabled:true},{enabled:true,bpm:120,offsetSeconds:0,barsPerScene:8,seed:89}));await h.flush();await h.finish();
  {const start=h.actions.current(),pick=[3,4,5,8].find(i=>i!==start);h.actions.load(pick);await h.flush();await h.finish();
   assert.equal(h.actions.current(),pick,'immediate manual queue switches without waiting for a scene boundary');
   assert.ok(!h.nodes.get('#timing').textContent.includes('queued'),'immediate pick is not shown as queued');}
  h.close();
}finally{Math.random=originalRandom;}
console.log('Host selection: thresholds 0–5, unrated/broken exclusions, empty/current-only pools, committed marking/write queues, pending-rating cancellation, adaptive/setup shuffle, seeded clock seek/replay and cue pruning PASS');
