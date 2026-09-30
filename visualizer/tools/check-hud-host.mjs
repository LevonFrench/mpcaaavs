import { build } from 'esbuild';
import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import { baseManifest,allKindsManifest } from './fixtures-hud.mjs';
import { recordingContext } from './check-hud-engine.mjs';
const load = async entry => import(`data:text/javascript;base64,${Buffer.from((await build({ entryPoints:[entry],bundle:true,format:'esm',write:false })).outputFiles[0].text).toString('base64')}`);
const H = await load('src/hud/hud-host.ts'), S = await load('src/hud/hud-signals.ts'), R = await load('src/render-resolution.ts'), P = await load('src/mpc-setups.ts');
assert.equal(H.sceneWorkerUrl('hud'),'hud-render.worker.js');assert.equal(H.sceneWorkerUrl('nerv'),'nerv-render.worker.js');assert.equal(H.sceneWorkerUrl(undefined),'avs-render.worker.js');
for(const kind of ['hud','nerv'])assert.ok(H.isSceneKind({kind}));for(const p of [null,undefined,{}, {kind:'avs'}])assert.equal(H.isSceneKind(p),false);
const meta={id:'fixture',pack:'Rhythm',family:'misc',tags:[],order:1,tier:'auto',canvas:{style:'pixel',w:320,h:180,par:[4,3]}};
assert.deepEqual(H.hudTraits(meta),{logical:{width:320,height:180},pixelGrid:{width:320,height:180,par:4/3}});
assert.deepEqual(H.hudTraits({...meta,canvas:{style:'vector',w:960,h:540}}),{logical:{width:960,height:540}});assert.deepEqual(H.hudTraits(null),{});
const sizing=R.resolveRender({kind:'hud',cssWidth:1920,cssHeight:1080,dpr:1,traits:H.hudTraits({...meta,canvas:{style:'pixel',w:320,h:180}})});
assert.deepEqual(sizing.render,{width:320,height:180});assert.equal(sizing.integerScale,6);
const audio={waveform:[new Uint8Array(576),new Uint8Array(576)],spectrum:[new Uint8Array(576).fill(100),new Uint8Array(576).fill(100)],beat:true,beatLevel:5000};
const feed=new H.HudFeed(),hop={time:0,pcm:new Float32Array(1152).fill(.1),sampleRate:44100,samples:576};
feed.pushHop(hop);const snap=feed.snapshot(0,audio),again=feed.snapshot(0,audio);
assert.equal(snap.length,64);assert.equal(snap[0],2);assert.deepEqual(snap,again);assert.notEqual(snap.buffer,again.buffer,'render slots must not share transferable storage');
assert.equal(S.unpackHudSignals(snap).beat.level,5000);assert.equal(feed.snapshot(0,audio,false)[3],0);
feed.reset();feed.pushHop(hop);assert.deepEqual(feed.snapshot(0,audio),snap,'reset and replay reproduce the signal feed');
const input={time:17,seed:13,revision:3,grid:{offset:.25,bpm:120,beatsPerBar:3},sceneStart:16,sceneEnd:24,tempo:null,track:{position:17,duration:80},signals:snap,
 named:[{id:'window',start:4,end:8}],previous:{sha256:'1'.repeat(64),kind:'nerv',scene:'boot'},previousTime:16,previousLocalTime:8,previousSceneStart:8,previousSceneEnd:16,
 blend:.5,transitionMode:32,transitionSeed:19,transitionBeats:4,transitionBoundary:2,fadeSeconds:2,transitionReduced:true};
const f=H.buildHudFrame(input);assert.equal(f.motion,'full');assert.equal(f.flash,'strict');assert.equal(f.signals,snap);assert.deepEqual(f,{...input,motion:'full',flash:'strict'});
const unknown=H.buildHudFrame({time:10});assert.equal(unknown.sceneEnd,null);assert.equal(unknown.track.duration,null);assert.equal(unknown.signals[0],2);assert.equal(unknown.sceneStart,10);
assert.equal(H.buildHudFrame({time:NaN}).time,0);
const row=(n,pack='Rhythm')=>({id:`fixture-${n}`,name:'Neutral Scene',fileName:'fixture.hud',sha256:n.toString(16).padStart(64,'0'),bytes:100,url:'fixture.hud',parserStatus:'unknown',autoEligible:true,kind:'hud',hud:{...meta,pack,order:n},folder:pack+'/Neutral Scene'});
const catalog=[row(2),row(1),{...row(3),notWorking:true},{...row(4),kind:'avs'},row(5,'Cinema & TV')];
const setup=H.hudSetup(catalog,'Rhythm');assert.equal(setup.presets.length,2);assert.equal(setup.presets[0],row(1).sha256);assert.equal(setup.timing.enabled,true);assert.equal(setup.timing.barsPerScene,2);assert.equal(setup.settings.transition,16);
assert.equal(P.parseSetups([setup]).length,1);
assert.equal(H.hudSetup(catalog).presets.length,3);assert.equal(H.hudSetup([]),null);assert.equal(H.hudSetup(catalog,'unknown'),null);
assert.equal(H.hudSetup(Array.from({length:510},(_,i)=>row(i+10))).presets.length,500,'editable setup schema cap; Play folder uses its independent uncapped planner');
assert.equal(H.parseHudTitles({format:'aaavs-hud-titles',version:1,titles:{fixture:'Local title'}}).get('fixture'),'Local title');
assert.equal(baseManifest().format,'mpcaaavs-hud');
console.log('HUD host adapter CPU: kind/worker dispatch, vector/pixel traits and presentation, independent 64-float snapshots, reset/replay/pause, absolute timing/previous identity payload, unknown duration, pack defaults and bounded editable setup, local title loader PASS; real host integration checked after host edit ledger is applied.');

// Optional integrated checkpoint for root: AAAVS_HOST_ENTRY may name the root-owned rehearsal. Never mutate or auto-apply host edits here.
const hostEntry=process.env.AAAVS_HOST_ENTRY??'src/mpc-host.ts';
if(readFileSync(hostEntry,'utf8').includes('buildHudFrame')){
 const fixtures=[row(1),row(2),{...row(3),kind:'nerv',scene:'boot'}];
 const bundle=await build({entryPoints:[hostEntry],bundle:true,format:'esm',write:false,define:{'import.meta.url':'"https://aaavs.invalid/dist/mpc-host.js"'},plugins:[{name:'host-fixture',setup(b){
  b.onResolve({filter:/(local-collection|mpc-management|mpc-bitmap-dependencies)\.ts$/},a=>({path:a.path,namespace:'host-fixture'}));
  b.onLoad({filter:/.*/,namespace:'host-fixture'},a=>({contents:a.path.includes('local-collection')?`export async function fetchLocalAvsCatalog(){return globalThis.fixtureCatalog}export function fetchLocalAvsPreset(p){return globalThis.fetchPreset(p)}export function isSceneKind(p){return p?.kind==='nerv'||p?.kind==='hud'} export async function fetchLocalAvsSources(){return new Map()}`:a.path.includes('management')?`export class PresetManagement{open=false;constructor(a){globalThis.hostActions=a}refresh(){}show(){}receive(){}}`:`export async function loadPresetBitmaps(){throw Error('scene must not fetch AVS bitmap packages')}`}));
 }}]});
 const nodes=new Map(),workers=[],fetched=[],posted=[];let listener,raf,hide,now=0;
 const context={globalAlpha:1,drawImage(){},save(){},restore(){},fillRect(){},clearRect(){},beginPath(){},rect(){},clip(){},createPattern(){return {}},getImageData(){return {data:new Uint8ClampedArray(256*144*4)}}};
 const surface=()=>({width:640,height:360,style:{},clientWidth:640,clientHeight:360,getContext(){return {...context,canvas:this}}});
 globalThis.fixtureCatalog=fixtures;globalThis.fetch=async()=>{throw Error('offline fixture')};globalThis.fetchPreset=p=>{fetched.push(p);return Promise.resolve(new Uint8Array([1,2,3,4]))};
 globalThis.OffscreenCanvas=class{constructor(){Object.assign(this,surface())}};
 globalThis.document={hidden:false,baseURI:'https://aaavs.invalid/mpc.html',body:{append(){},classList:{add(){},remove(){},contains(){return false}}},createElement:surface,querySelector(id){if(!nodes.has(id))nodes.set(id,id==='#visualizer'?surface():{textContent:''});return nodes.get(id)},addEventListener(){}};
 globalThis.window={chrome:{webview:{postMessage(m){posted.push(m)},addEventListener(_,fn){listener=fn}}},setTimeout(){return 1},addEventListener(t,fn){if(t==='pagehide')hide=fn}};
 globalThis.clearTimeout=()=>{};globalThis.requestAnimationFrame=fn=>raf=fn;globalThis.devicePixelRatio=1;
 Object.defineProperty(globalThis,'performance',{value:{now:()=>now},configurable:true});
 globalThis.Worker=class{constructor(url){this.url=String(url);this.requests=[];this.dead=false;workers.push(this)}postMessage(m){this.requests.push(m)}terminate(){this.dead=true}send(type){const bitmap={width:640,height:360,close(){}};this.onmessage({data:{type,bitmap,renderMs:1}})}};
 const flush=async()=>{for(let i=0;i<32;i++)await Promise.resolve()};
 const finish=async()=>{await flush();const w=workers.at(-1);w.send('ready');await flush();w.send('frame');await flush();return w};
 const last=w=>w.requests.filter(r=>r.type==='render').at(-1),audio=(position,extra={})=>listener({data:{type:'audio',position,epoch:1,playing:false,pcm:Array(1152).fill(0),...extra}});
 await import(`data:text/javascript;base64,${Buffer.from(bundle.outputFiles[0].text).toString('base64')}`);let active=await finish();
 assert.ok(active.url.endsWith('hud-render.worker.js'));assert.ok(last(active).hud);assert.equal(last(active).hud.signals.length,64);
 const template=hostActions.hudSetup();assert.equal(template.presets.length,2);template.settings.shuffle=false;template.settings.transition=1;template.settings.beats=1;template.timing={enabled:true,bpm:120,offsetSeconds:0,barsPerScene:1,seed:13};
 hostActions.activate(template);active=await finish();audio(2.25,{duration:80});await flush();active=await finish();
 const payload=last(active).hud;assert.equal(payload.track.duration,80);assert.equal(payload.sceneStart,2);assert.equal(payload.sceneEnd,4);assert.equal(payload.previous.kind,'hud');assert.equal(payload.previousSceneStart,0);assert.equal(payload.previousSceneEnd,2);
 const stashIndex=active.requests.findIndex(r=>r.type==='stash'),renderIndex=active.requests.findIndex(r=>r.type==='render');assert.ok(stashIndex>=0&&stashIndex<renderIndex,'previous manifest reaches worker before fade render');
 const captured=structuredClone(payload);audio(.25);await flush();await finish();audio(2.25,{duration:80});await flush();active=await finish();
 const replay=last(active).hud,clockOnly=f=>{const {revision,signals,...clock}=f;return clock};
 assert.deepEqual(clockOnly(replay),clockOnly(captured),'clocked HUD timing, identity and fade reconstruct independently of revision transport');
 assert.ok(replay.revision>captured.revision,'seeks invalidate decoration with a newer revision');
 for(const f of [captured,replay]){assert.equal(f.signals[3],0,'paused snapshots hold live decoration at rest');assert.ok(f.signals.every(Number.isFinite));assert.ok(f.signals[2]>=.001&&f.signals[2]<=.25,'analysis dt stays in the ABI range')}
 // dt measures host analysis history, not media-clock state. The procedural engine must reproduce identical output at a paused position even across different dt/revision values.
 const E=await load('src/hud/hud-engine.ts'),scene=E.HudScene.compile(allKindsManifest());
 const draw=f=>{const rec=recordingContext(960,540);const stats=E.renderHudScene(scene,new E.HudRuntime(scene),rec.ctx,960,540,f,{motion:f.motion,flash:f.flash});rec.finish();return {calls:rec.calls,stats}};
 assert.deepEqual(draw(replay),draw(captured),'paused procedural rendering ignores host dt/revision history');
 audio(2.5,{duration:80});now+=16;raf(now);await flush();assert.equal(last(active).hud.time,2.5,'paused same-scene seek redraw');active.send('frame');
 // The lookahead worker needs the NEXT scene's previous identity while the media clock remains in the current scene.
 audio(.25);await flush();await finish();const fetchCount=fetched.length;
 audio(1.8);await flush();const preloaded=await finish();
 assert.equal(last(preloaded).hud.sceneStart,2);assert.equal(last(preloaded).hud.time,2);
 assert.ok(preloaded.requests.findIndex(r=>r.type==='stash')<preloaded.requests.findIndex(r=>r.type==='render'));
 assert.ok(fetched.length-fetchCount<=2,'future fade stash does not refetch in a microtask loop');
 // Commit a fresh current HUD without a fade/cache, then enable its fade. The old
 // predecessor request must not blacklist this active slot if it rejects after a seek.
 audio(2.25,{duration:80});await flush();
 hostActions.activate({...template,settings:{...template.settings,autoFade:false}});active=await finish();
 assert.equal(last(active).hud.sceneStart,2);assert.equal(active.requests.some(r=>r.type==='stash'),false);
 const originalFetch=globalThis.fetchPreset,previousHash=fixtures[0].sha256,workerCount=workers.length;
 let rejectObsolete,previousFetches=0;
 globalThis.fetchPreset=p=>{
  if(p.sha256===previousHash&&++previousFetches===1){fetched.push(p);return new Promise((_,reject)=>rejectObsolete=reject)}
  return originalFetch(p);
 };
 listener({data:{type:'settings',...template.settings,autoFade:true}});now+=16;raf(now);await flush();
 assert.equal(typeof rejectObsolete,'function','current HUD starts a deferred predecessor fetch');
 const oldRevision=last(active).hud.revision;
 audio(2.1,{duration:80});now+=16;raf(now);await flush();
 assert.equal(active.dead,false,'same-slot seek keeps the active worker');
 rejectObsolete(new Error('obsolete predecessor network failure'));await flush();
 assert.equal(active.dead,false,'obsolete fetch rejection must not fail/blacklist the current HUD');
 assert.equal(workers.length,workerCount,'obsolete rejection does not start recovery on another preset');
 assert.equal(previousFetches,2,'current revision refetches its still-required predecessor');
 assert.equal(last(active).hud.time,2.1);assert.ok(last(active).hud.revision>oldRevision);
 assert.equal(last(active).hud.previous.sha256,previousHash);
 const refreshedStash=active.requests.findIndex(r=>r.type==='stash');assert.ok(refreshedStash>=0&&refreshedStash<active.requests.length-1);
 active.send('frame');globalThis.fetchPreset=originalFetch;
 assert.ok(fetched.every(p=>p.kind==='hud'||p.kind==='nerv'));hide();assert.ok(workers.every(w=>w.dead));
 console.log('HUD integrated host CPU: HUD worker/ABI, editable template, interval/grid/duration, previous manifest stash before render, clocked seek/replay, paused redraw, obsolete stash rejection after same-slot seek and teardown PASS');
}else if(process.env.AAAVS_HOST_ENTRY)throw Error('Supplied HUD rehearsal host is not wired (buildHudFrame missing)');
