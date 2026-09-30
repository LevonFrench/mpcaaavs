import { build } from 'esbuild';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
const html = readFileSync('mpc.html', 'utf8');
for (const id of ['visualizer', 'preset', 'timing', 'status']) assert.ok(html.includes(`id="${id}"`), `real page includes ${id}`);
const result = await build({entryPoints:['src/mpc-host.ts'],bundle:true,format:'esm',write:false,define:{'import.meta.url':'"https://aaavs.invalid/dist/mpc-host.js"'},plugins:[{name:'fixture-catalog',setup(b){
 b.onResolve({filter:/local-collection\.ts$/},()=>({path:'catalog',namespace:'test'}));
 b.onResolve({filter:/mpc-bitmap-dependencies\.ts$/},()=>({path:'bitmaps',namespace:'test'}));
 b.onLoad({filter:/.*/,namespace:'test'},args=>({contents:args.path==='catalog'?`export async function fetchLocalAvsCatalog(){if(globalThis.fixtureCatalogFailure)throw Error('catalog missing');return [0,1,2,3].map(i=>({name:'preset '+i,sha256:''+i,autoEligible:true}));} export function fetchLocalAvsPreset(p){return globalThis.fixtureFetch(p);} export function isSceneKind(p){return p?.kind==='nerv'||p?.kind==='hud'} export async function fetchLocalAvsSources(){return new Map()}`:`export async function loadPresetBitmaps(){return [];}`}));
}}]});
const posted=[], fetches=[], workers=[], nodes=new Map(), timers=new Map();
let retryButton, reloaded=false;
let timer=0, now=0, listener, raf, keydown, pagehide, draws=0, probeFailed=false;
Object.defineProperty(globalThis,'performance',{value:{now:()=>now},configurable:true});
globalThis.fetch=async()=>{throw Error('offline fixture')};globalThis.fixtureFetch=preset=>new Promise((resolve,reject)=>fetches.push({preset,resolve:()=>resolve(new Uint8Array(4)),reject}));
const ctx={clearRect(){},setTransform(){},globalAlpha:1,drawImage(){draws++;},getImageData(){if(probeFailed)throw Error('probe unavailable');return {data:new Uint8ClampedArray(256*144*4)};},save(){},restore(){},beginPath(){},rect(){},clip(){},fillRect(){},createPattern(){return {};}};
class Element {
 constructor(tag){this.tagName=tag;this.children=[];this.attributes={};this.textContent='';this.value='';}
 append(...items){this.children.push(...items);}prepend(...items){this.children.unshift(...items);}
 replaceChildren(...items){this.children=items;}setAttribute(k,v){this.attributes[k]=v;}
 addEventListener(_,fn){this.click=fn;}focus(){this.focused=true;}
 all(){return [this,...this.children.flatMap(c=>c.all())];}
 querySelector(selector){return this.all().find(e=>selector==='button'?e.tagName==='button':e.tagName==='input'&&e.type==='search');}
}
function canvas(){return {width:640,height:360,clientWidth:640,clientHeight:360,getContext(){return {...ctx,canvas:this};}};}
globalThis.OffscreenCanvas=class {constructor(w,h){Object.assign(this,canvas(),{width:w,height:h});}};
const classes=new Set();
globalThis.document={hidden:false,baseURI:'https://aaavs.invalid/mpc.html',body:{append(button){retryButton=button;},classList:{add(x){classes.add(x);},remove(x){classes.delete(x);}}},createElement(tag){return tag==='canvas'?canvas():new Element(tag);},querySelector(id){if(!nodes.has(id))nodes.set(id,id==='#visualizer'?canvas():id==='#management'?new Element('section'):{textContent:''});return nodes.get(id);},addEventListener(type,fn){if(type==='keydown')keydown=fn;}};
globalThis.window={location:{reload(){reloaded=true;}},chrome:{webview:{postMessage(message){posted.push(message);},addEventListener(_,fn){listener=fn;}}},setTimeout(fn,delay){timers.set(++timer,{fn,at:now+delay});return timer;},addEventListener(type,fn){if(type==='pagehide')pagehide=fn;}};
globalThis.clearTimeout=id=>timers.delete(id);
globalThis.requestAnimationFrame=fn=>{raf=fn;};globalThis.devicePixelRatio=1;
function bitmap(){return {width:640,height:360,closed:false,close(){this.closed=true;}};}
globalThis.Worker=class {
 constructor(){this.dead=false;this.requests=[];workers.push(this);}
 postMessage(m){this.requests.push(m);}
 terminate(){this.dead=true;}
 send(type,frame=bitmap()){this.onmessage({data:{type,bitmap:frame}});return frame;}
};
const flush=async()=>{for(let i=0;i<12;i++)await Promise.resolve();};
const message=data=>listener({data});
const audio=(position,playing=true,extra={})=>message({type:'audio',playing,position,epoch:1,pcm:Array(1152).fill(0),...extra});
const tick=(ms=16)=>{now+=ms;raf(now);};
const renderCount=w=>w.requests.filter(r=>r.type==='render').length;
const live=()=>workers.filter(w=>!w.dead);
async function loadLatest(){fetches.at(-1).resolve();await flush();const w=workers.at(-1);w.send('ready');assert.ok(renderCount(w)>0,'ready worker receives its first render request');w.send('frame');return w;}
await import(`data:text/javascript;base64,${Buffer.from(result.outputFiles[0].text).toString('base64')}`);
await flush();const first=await loadLatest();
assert.ok(posted.includes('host-ready'));assert.ok(posted.includes('ready'));
audio(0);tick();assert.ok(renderCount(first)>=2,'fresh audio drives actual rendering');first.send('frame');
// Audio batches, including a treble burst followed by silence, reach the render request.
const inputFrames=[];
for(let offset=0;offset<1728;offset+=576){const p=Array(1152).fill(0);if(offset===0)for(let k=0;k<576;k++)p[k]=.3*Math.sin(2*Math.PI*12000*k/44100);inputFrames.push({time:offset/44100,sampleRate:44100,samples:576,pcm:p});}
audio(.04,true,{frames:inputFrames});tick();
const wired=first.requests.filter(r=>r.type==='render').at(-1).audio;
assert.ok(wired&&Math.max(...wired.spectrum[0].slice(260,300))>100,'held treble spectrum must reach worker');
assert.equal(Math.max(...wired.spectrum[1]),0,'right channel stays independent');first.send('frame');
// Superseded asynchronous fetches may resolve in either order without entering history.
message({type:'next'});await flush();const stale=fetches.at(-1);
message({type:'next'});await flush();assert.equal(fetches.at(-1).preset.name,'preset 2');
const second=await loadLatest();const count=workers.length;stale.resolve();await flush();
assert.equal(workers.length,count,'stale fetch must not create a worker');
assert.equal(first.dead,false,'old renderer survives incoming transition');
assert.ok(live().length<=2);
// Complete the transition through media time, avoiding seek discontinuities.
for(const position of [.5,1,1.5,2.1]){audio(position);tick(50);}
assert.equal(first.dead,true,'transition completion releases outgoing renderer');
message({type:'previous'});await flush();assert.equal(fetches.at(-1).preset.name,'preset 0','Previous skips canceled preset 1');
audio(2.1,false);const third=await loadLatest();
assert.equal(second.dead,true,'paused manual selection cuts immediately');
assert.ok(nodes.get('#preset').textContent.includes('preset 0'));
tick();const pausedDraws=draws;tick();assert.equal(draws,pausedDraws,'unchanged paused image is not recomposited');
// Failure preserves displayed identity and the Previous cursor.
message({type:'next'});await flush();fetches.at(-1).reject(Error('missing fixture'));await flush();
assert.ok(nodes.get('#preset').textContent.includes('preset 0'));assert.equal(third.dead,false);
message({type:'next'});await flush();assert.equal(fetches.at(-1).preset.name,'preset 1','failed request does not advance committed navigation');
const fourth=await loadLatest();assert.equal(third.dead,true);
// Native settings restore shuffle and manual fade policy.
message({type:'settings',enabled:false,shuffle:false,manualFade:false,autoFade:true,durationMs:3000});
audio(2.1);message({type:'next'});await flush();const fifth=await loadLatest();
assert.equal(fourth.dead,true,'manualFade false releases outgoing even while playing');
tick();fifth.send('frame');const beforeStale=renderCount(fifth);tick(600);
assert.equal(renderCount(fifth),beforeStale,'stale audio must not submit another render');
// Both native and document visibility suppress presentation and rendering.
audio(2.1,false,{visible:false});nodes.get('#visualizer').clientWidth=9000;const hiddenDraws=draws;tick();assert.equal(draws,hiddenDraws);
audio(2.1,false,{visible:true});document.hidden=true;tick();assert.equal(draws,hiddenDraws);document.hidden=false;
nodes.get('#visualizer').clientHeight=8000;globalThis.devicePixelRatio=4;tick();
assert.ok(nodes.get('#visualizer').width<=1920&&nodes.get('#visualizer').height<=1080,'presentation pixels are bounded');
// Protection failure remains visible after announcements expire.
probeFailed=true;fifth.send('frame');tick();assert.ok(nodes.get('#status').textContent.includes('flash protection unavailable'));assert.ok(classes.has('protection-error'));
keydown({code:'F10',shiftKey:true,preventDefault(){}});assert.ok(posted.includes('options'));
// An unresponsive incoming render times out deterministically without losing the active preset.
message({type:'next'});await flush();fetches.at(-1).resolve();await flush();
const stalled=workers.at(-1);stalled.send('ready');now+=5001;
for(const [id,t] of [...timers]) if(t.at<=now){timers.delete(id);t.fn();}
assert.equal(stalled.dead,true);assert.equal(fifth.dead,false);
assert.ok(nodes.get('#status').textContent.includes('timed out'));
tick();assert.ok(nodes.get('#status').textContent.includes('flash protection unavailable'),'protection failure overrides transient announcements');
// Rating keys and queued writes target the committed preset, never an incoming one.
keydown({code:'F7',preventDefault(){}});assert.ok(posted.includes('rate-up'));
keydown({code:'F8',preventDefault(){}});assert.ok(posted.includes('mark-not-working'));
const marksPosted=posted.filter(m=>m==='mark-not-working').length;
keydown({code:'F8',repeat:true,preventDefault(){}});assert.equal(posted.filter(m=>m==='mark-not-working').length,marksPosted,'holding F8 must not repeat writes');
keydown({code:'F6',ctrlKey:true,preventDefault(){}});assert.ok(posted.includes('show-manager'));
message({type:'rate',delta:1});message({type:'rate',delta:1});
const request=JSON.parse(posted.filter(m=>m.startsWith('library:')).at(-1).slice(8));
assert.equal(request.rating,1);assert.equal(request.hash,'2');
message({type:'rating-saved',entry:{sha256:'2',canonical_path:'presets/unique/test [1 stars].avs',rating:1}});
const queued=JSON.parse(posted.filter(m=>m.startsWith('library:')).at(-1).slice(8));assert.equal(queued.rating,2);
message({type:'rating-saved',entry:{sha256:'2',canonical_path:'presets/unique/test [2 stars].avs',rating:2}});
assert.ok(nodes.get('#status').textContent.includes('filename and Date modified saved'));
// Teardown invalidates in-flight fetches and closes late transferred frames.
message({type:'next'});await flush();const teardownFetch=fetches.at(-1);pagehide();assert.equal(live().length,0);
const late=bitmap();fifth.send('frame',late);assert.equal(late.closed,true);
const beforeTeardownResolve=workers.length;teardownFetch.resolve();await flush();assert.equal(workers.length,beforeTeardownResolve);
const afterTeardown=draws;tick();assert.equal(draws,afterTeardown,'teardown stops pending animation callbacks');
// An initial fetch failure must not bury a recovery panel opened while loading.
await import(`data:text/javascript;base64,${Buffer.from(result.outputFiles[0].text+'\n// open panel during first load fixture').toString('base64')}`);
await flush();message({type:'panel',panel:2});
const errorsBefore=posted.filter(m=>m==='error').length;
fetches.at(-1).reject(Error('Invalid dependency record'));await flush();
assert.equal(posted.filter(m=>m==='error').length,errorsBefore,'late fetch failure must not hide Setup Builder');
assert.equal(nodes.get('#management').hidden,false);assert.ok(nodes.get('#status').textContent.includes('Invalid dependency record'));
pagehide();
globalThis.fixtureCatalogFailure=true;
const beforeBootstrap=workers.length;
await assert.rejects(import(`data:text/javascript;base64,${Buffer.from(result.outputFiles[0].text+'\n// bootstrap failure fixture').toString('base64')}`), /catalog missing/);
assert.equal(workers.length,beforeBootstrap);assert.ok(posted.includes('bootstrap-error'));assert.ok(classes.has('bootstrap-error'));
assert.equal(retryButton.textContent,'Retry visualizer');assert.equal(retryButton.focused,true);retryButton.click();assert.equal(reloaded,true);
console.log('Host lifecycle: out-of-order loads, committed history, transition completion, paused/manual cuts, stale audio, hidden/idle presentation, pixel cap, flash feedback, timeout, teardown PASS');
