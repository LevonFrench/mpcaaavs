import {build} from 'esbuild';
import assert from 'node:assert/strict';

// Exercise the real host with fake transport/worker surfaces; never starts WebView or a GPU.
const scenes=['boot','magi','psycho','radar','harmonics','seele','battery','atfield','alert','plug','target','city','sync','berserk','impact','end'];
const catalog=scenes.map((scene,i)=>({kind:'nerv',scene,name:`NERV ${scene}`,sha256:i.toString(16).padStart(64,'0'),autoEligible:true}));
const result=await build({entryPoints:['src/mpc-host.ts'],bundle:true,format:'esm',write:false,define:{'import.meta.url':'"https://aaavs.invalid/dist/mpc-host.js"'},plugins:[{name:'fixture',setup(b){
 b.onResolve({filter:/(local-collection|mpc-management|mpc-bitmap-dependencies)\.ts$/},args=>({path:args.path,namespace:'fixture'}));
 b.onLoad({filter:/.*/,namespace:'fixture'},args=>({contents:args.path.includes('local-collection')?`export async function fetchLocalAvsCatalog(){return globalThis.catalog;} export function fetchLocalAvsPreset(p){return globalThis.fetchPreset(p);} export function isSceneKind(p){return p?.kind==='nerv'||p?.kind==='hud'} export async function fetchLocalAvsSources(){return new Map()}`:args.path.includes('management')?`export class PresetManagement {open=false; constructor(a){globalThis.actions=a;} refresh(){} show(){} receive(){}}`:`export async function loadPresetBitmaps(){throw Error('NERV must not fetch historical bitmap packages');}`}));
}}]});
const nodes=new Map(),posted=[],workers=[],fetches=[];
let now=0,listener,raf,pagehide,draws=0;
const ctx={clearRect(){},setTransform(){},globalAlpha:1,drawImage(){draws++;},getImageData(){return {data:new Uint8ClampedArray(256*144*4)};},save(){},restore(){},beginPath(){},rect(){},clip(){},fillRect(){},createPattern(){return {};}};
const canvas=()=>({width:640,height:360,clientWidth:640,clientHeight:360,getContext(){return {...ctx,canvas:this};}});
globalThis.catalog=catalog;
globalThis.fetch=async()=>{throw Error('offline fixture')};globalThis.fetchPreset=p=>new Promise(resolve=>fetches.push({p,resolve:()=>resolve(new Uint8Array(4))}));
globalThis.OffscreenCanvas=class {constructor(){Object.assign(this,canvas());}};
globalThis.document={hidden:false,baseURI:'https://aaavs.invalid/mpc.html',body:{append(){},classList:{add(){},remove(){}}},createElement:canvas,querySelector(id){if(!nodes.has(id))nodes.set(id,id==='#visualizer'?canvas():{textContent:''});return nodes.get(id);},addEventListener(){}};
globalThis.window={chrome:{webview:{postMessage(m){posted.push(m);},addEventListener(_,fn){listener=fn;}}},setTimeout(){return 1;},addEventListener(t,fn){if(t==='pagehide')pagehide=fn;}};
globalThis.clearTimeout=()=>{};
Object.defineProperty(globalThis,'performance',{value:{now:()=>now},configurable:true});
globalThis.requestAnimationFrame=fn=>raf=fn;globalThis.devicePixelRatio=1;
globalThis.Worker=class {
 // NERV presets load the show engine's worker by default (same load/render protocol), with its fonts next to the page
 constructor(url){const u=new URL(String(url));assert.equal(u.pathname,'/dist/show-render.worker.js');assert.equal(u.searchParams.get('assets'),'https://aaavs.invalid/show-assets/');this.requests=[];this.dead=false;workers.push(this);}
 postMessage(m){this.requests.push(m);}terminate(){this.dead=true;}
 send(type){const bitmap={width:640,height:360,closed:false,close(){this.closed=true;}};this.onmessage({data:{type,bitmap}});return bitmap;}
};
const flush=async()=>{for(let i=0;i<12;i++)await Promise.resolve();};
const msg=data=>listener({data});
const audio=(position,playing=false,extra={})=>msg({type:'audio',playing,position,epoch:1,pcm:Array(1152).fill(0),...extra});
const tick=()=>{now+=16;raf(now);};
const lastRender=w=>w.requests.filter(r=>r.type==='render').at(-1);
const count=w=>w.requests.filter(r=>r.type==='render').length;
const load=async()=>{fetches.at(-1).resolve();await flush();const w=workers.at(-1);w.send('ready');w.send('frame');return w;};
await import(`data:text/javascript;base64,${Buffer.from(result.outputFiles[0].text).toString('base64')}`);
await flush();await load();
const setup=actions.nervSetup();assert.equal(setup.presets.length,16);assert.equal(setup.timing.enabled,true);
setup.timing={enabled:true,bpm:120,offsetSeconds:0,barsPerScene:1,seed:89};setup.settings.beats=1;
actions.activate(setup);await flush();let active=await load();
assert.equal(lastRender(active).nerv.localTime,0);
audio(4.25);await flush();assert.equal(fetches.at(-1).p.scene,'psycho');active=await load();
assert.equal(lastRender(active).nerv.localTime,.25);
assert.equal(lastRender(active).nerv.previousScene,'magi');assert.equal(lastRender(active).nerv.blend,.5);
assert.equal(lastRender(active).nerv.bpm,120);
// Arbitrary seeks/repeats are independent of history and live tempo acquisition.
const firstClock=structuredClone(lastRender(active).nerv);
audio(27);await flush();assert.equal(fetches.at(-1).p.scene,'berserk');await load();
audio(4.25);await flush();active=await load();assert.deepEqual(lastRender(active).nerv,firstClock);
audio(4.75);tick();assert.equal(lastRender(active).nerv.localTime,.75,'paused seek in same scene redraws');active.send('frame');
tick();const idle=count(active);tick();assert.equal(count(active),idle,'paused unchanged clock stays idle');
audio(4.8,true);tick();const staleCount=count(active);
audio(4.8,false,{epoch:2});const stale=active.send('frame');assert.equal(stale.closed,true,'same-position epoch discards old frame');
assert.equal(count(active),staleCount+1);active.send('frame');
// Short high percussion survives a later silent window in the same audio batch.
const frames=[];
for(let offset=0;offset<1728;offset+=576){const p=Array(1152).fill(0);if(offset===0)for(let i=0;i<576;i++)p[i]=.3*Math.sin(2*Math.PI*12000*i/44100);frames.push({time:4.81+offset/44100,sampleRate:44100,samples:576,pcm:p});}
audio(4.86,true,{epoch:2,frames});tick();assert.ok(Math.max(...lastRender(active).audio.spectrum[0].slice(260,300))>100,'NERV receives held treble');active.send('frame');
// Native Auto-off must cancel a not-yet-ready timeline scene.
audio(6.1,true,{epoch:2});await flush();const canceled=fetches.at(-1),before=workers.length;
msg({type:'settings',enabled:false,shuffle:false});canceled.resolve();await flush();assert.equal(workers.length,before);assert.equal(active.dead,false);
msg({type:'settings',enabled:true,shuffle:false,queueQuantize:2});await flush();active=await load();assert.ok(nodes.get('#preset').textContent.includes('radar'));
// With a quantized manual queue (next bar), NERV transport and arbitrary choices queue at the next clock boundary (default is immediate).
msg({type:'next'});await flush();const superseded=await load();assert.ok(nodes.get('#preset').textContent.includes('radar'),'preloading must not change the active scene');
msg({type:'next'});await flush();assert.equal(fetches.at(-1).p.scene,'seele','repeated Next steps from the pending choice');
const replaced=fetches.at(-1);actions.load(13);await flush();replaced.resolve();await flush();
assert.equal(superseded.dead,true);const queued=await load();assert.ok(nodes.get('#preset').textContent.includes('radar'));
assert.equal(lastRender(queued).nerv.localTime,0,'lookahead initializes the incoming scene at its boundary');
for(const time of [6.6,7.1,7.6])audio(time,false,{epoch:2});tick();active.send('frame');
assert.ok(nodes.get('#timing').textContent.includes('queued NERV berserk'));
const queuedIdle=count(queued);tick();assert.equal(count(queued),queuedIdle,'pause does not execute the queued transition');
// Refresh held audio/time at the boundary. Multiple bridge polls before the reply
// must not commit the old preloaded bitmap with a future request's timestamp.
audio(8.1,true,{epoch:2});assert.equal(count(queued),queuedIdle+1);
audio(8.12,true,{epoch:2});assert.ok(nodes.get('#preset').textContent.includes('radar'),'wait for completed boundary frame');
queued.send('frame');active=queued;assert.ok(nodes.get('#preset').textContent.includes('berserk'));assert.equal(lastRender(active).nerv.previousScene,'radar');
const cueFrame=structuredClone(lastRender(active).nerv);
audio(7.1,false,{epoch:2});await flush();await load();audio(8.1,false,{epoch:2});await flush();active=await load();assert.deepEqual(lastRender(active).nerv,cueFrame,'queued pair and transition replay after seeking');
audio(10.25,false,{epoch:2});await flush();active=await load();assert.ok(nodes.get('#preset').textContent.includes('impact'),'ordered clock continues after the chosen scene');
// Auto-off selections remain immediate; reactivation clears session cues.
msg({type:'settings',enabled:false,shuffle:false});actions.load(4);await flush();active=await load();assert.ok(nodes.get('#preset').textContent.includes('harmonics'));
audio(20,false,{epoch:2});tick();active.send('frame');
actions.activate(setup);await flush();active=await load();assert.ok(nodes.get('#preset').textContent.includes('target'));
// Cut and frozen outgoing scene settings are honored on repeatable fades.
msg({type:'settings',enabled:true,shuffle:false,transition:15,beats:1,keepOld:false});audio(20.25);tick();active.send('frame');assert.equal(lastRender(active).nerv.previousScene,undefined);
msg({type:'settings',enabled:true,shuffle:false,transition:1,beats:1,keepOld:false});tick();assert.equal(lastRender(active).nerv.previousLocalTime,2);active.send('frame');
// Existing transition style/duration controls feed the absolute clock, including Random.
for(const mode of [0,2,6,10,14]){msg({type:'settings',enabled:true,shuffle:false,transition:mode,beats:4});tick();assert.equal(lastRender(active).nerv.transitionMode,mode);assert.equal(lastRender(active).nerv.blend,.125,'four beats uses full scene duration, not quarter-scene cap');active.send('frame');}
// Range flag day (contract C-02): every stored index 0..32 reaches the worker; anything else falls back to Cross dissolve.
for(const [mode,expected] of [[16,16],[31,31],[32,32],[33,1],[-1,1],[1.5,1]]){msg({type:'settings',enabled:true,shuffle:false,transition:mode,beats:4});tick();assert.equal(lastRender(active).nerv.transitionMode,expected,`settings transition ${mode}`);active.send('frame');}
// Clock change back to displayed A invalidates pending B (without a media seek).
audio(22.1);await flush();const wrong=fetches.at(-1);const currentCount=workers.length;
const reordered=structuredClone(setup);[reordered.presets[10],reordered.presets[11]]=[reordered.presets[11],reordered.presets[10]];
actions.activate(reordered);wrong.resolve();await flush();assert.equal(workers.length,currentCount);active=await load();
pagehide();assert.ok(workers.every(w=>w.dead));
assert.ok(draws>0);
console.log('NERV host: absolute clock, seek/replay, held spectrum, queued choices/replacement, lookahead/late-frame isolation, Auto cancellation, all-style timing/duration, Cut/frozen geometry, teardown PASS');
