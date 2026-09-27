import { build } from 'esbuild';
import assert from 'node:assert/strict';
const result = await build({entryPoints:['src/mpc-host.ts'],bundle:true,format:'esm',write:false,define:{'import.meta.url':'"https://aaavs.invalid/dist/mpc-host.js"'},plugins:[{name:'fixture-catalog',setup(b){
 b.onResolve({filter:/local-collection\.ts$/},()=>({path:'catalog',namespace:'test'}));
 b.onResolve({filter:/mpc-bitmap-dependencies\.ts$/},()=>({path:'bitmaps',namespace:'test'}));
 b.onLoad({filter:/.*/,namespace:'test'},args=>({contents:args.path==='catalog'?`export async function fetchLocalAvsCatalog(){return [0,1,2].map(i=>({name:'preset '+i,sha256:''+i,autoEligible:true}));} export async function fetchLocalAvsPreset(){return new Uint8Array(4);}`:`export async function loadPresetBitmaps(){return [];}`}));
}}]});
const posted=[];
const timers=new Map(); let timer=0, listener, raf;
const nodes = new Map();
const ctx={globalAlpha:1,drawImage(){},getImageData(){return {data:new Uint8ClampedArray(256*144*4)};},save(){},restore(){},beginPath(){},rect(){},clip(){},fillRect(){},createPattern(){return {};}};
function canvas(){return {width:640,height:360,clientWidth:640,clientHeight:360,getContext(){return {...ctx,canvas:this};}};}
globalThis.document={baseURI:'https://aaavs.invalid/mpc.html',body:{classList:{add(){},remove(){}}},createElement:canvas,querySelector(id){if(!nodes.has(id)) nodes.set(id,id==='#visualizer'?canvas():{textContent:''});return nodes.get(id);},addEventListener(){}};
globalThis.window={chrome:{webview:{postMessage(message){posted.push(message);},addEventListener(_,fn){listener=fn;}}},setTimeout(fn){timers.set(++timer,fn);return timer;},addEventListener(){}};
globalThis.clearTimeout=id=>timers.delete(id);
globalThis.requestAnimationFrame=fn=>{raf=fn;}; globalThis.devicePixelRatio=1;
const workers=[];
globalThis.Worker=class {constructor(){this.dead=false;workers.push(this);} postMessage(m){this.last=m;} terminate(){this.dead=true;} send(type){this.onmessage({data:{type,bitmap:{width:640,height:360,close(){}}}});} };
await import(`data:text/javascript;base64,${Buffer.from(result.outputFiles[0].text).toString('base64')}`);
const flush=async()=>{for(let i=0;i<10;i++) await Promise.resolve();};
await flush(); const first=workers[0]; assert.ok(first); first.send('ready'); assert.ok(posted.includes('ready'),'initial GPU rendering requires a visible host');
// Establish playback epoch before selecting another preset.
listener({data:{type:'audio',playing:true,position:0,epoch:1,pcm:Array(1152).fill(0)}});
assert.equal(first.dead,false,'first native audio must not cancel initial preparation'); first.send('frame');
listener({data:{type:'next'}}); await flush(); const second=workers[1];
assert.equal(first.dead,false,'old preset must survive incoming load');
second.send('ready'); assert.equal(first.dead,false); second.send('frame');
assert.equal(first.dead,false,'old preset must animate during transition');
listener({data:{type:'next'}}); await flush();
assert.equal(first.dead,true,'interrupted transition must release outgoing worker');
const third=workers[2]; assert.equal(second.dead,false); third.send('error');
assert.equal(second.dead,false,'failed incoming preset must preserve current renderer');
assert.ok(nodes.get('#preset').textContent.includes('keeping current preset'));
listener({data:{type:'previous'}}); await flush(); const fourth=workers[3];
listener({data:{type:'next'}}); await flush();
assert.equal(fourth.dead,true,'superseded preparation must terminate worker');
assert.ok(workers.filter(w=>!w.dead).length<=2);
console.log('Host lifecycle: preload retention, dual rendering, interrupted transition, failed incoming preset, stale preparation, two-worker bound PASS');
