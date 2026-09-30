// Real shared Player host, real multiview session/runtime/controls, synthetic catalog, injected DOM and Workers. CPU only.
import {build} from 'esbuild';
import assert from 'node:assert/strict';
import {resolve} from 'node:path';
const catalog=Array.from({length:12},(_,i)=>({name:`Synthetic preset ${i}`,sha256:(i+1).toString(16).padStart(64,'0'),autoEligible:true,kind:i%3===0?'nerv':i%3===1?'hud':undefined,scene:'radar',folder:`Fixture set ${Math.floor(i/4)}`,...(i%3===1?{hud:{pack:'Fixture HUD',canvas:{w:960,h:540,style:'vector'}}}:{})}));
const result=await build({entryPoints:['src/mpc-host.ts'],bundle:true,format:'esm',write:false,define:{'import.meta.url':'"https://aaavs.invalid/dist/mpc-host.js"'},plugins:[{name:'synthetic-library',setup(b){
 b.onResolve({filter:/(local-collection|mpc-management|mpc-bitmap-dependencies)\.ts$/},args=>({path:args.path,namespace:'fixture'}));
 b.onLoad({filter:/.*/,namespace:'fixture'},args=>({contents:args.path.includes('local-collection')?`export async function fetchLocalAvsCatalog(){return globalThis.catalog;} export async function fetchLocalAvsPreset(){return new Uint8Array([1,2,3,4]);} export function isSceneKind(p){return p?.kind==='nerv'||p?.kind==='hud';} export async function fetchLocalAvsSources(){return new Map();} export function parseLocalAvsSources(){return new Map();}`:args.path.includes('management')?`export class PresetManagement{open=false;constructor(a){globalThis.actions=a;return new Proxy(this,{get:(t,k)=>k in t?t[k]:typeof k==='symbol'?undefined:()=>undefined});}}`:`export async function loadPresetBitmaps(){return [];}`}));
}}]});
let checks=0;const ok=(v,m)=>{checks++;assert.ok(v,m);},same=(a,b,m)=>{checks++;assert.deepEqual(a,b,m);};
globalThis.catalog=catalog;globalThis.fetch=async()=>{throw Error('synthetic offline fixture');};
let now=0,raf,listener,pagehide,keydown,timer=0;const timers=new Map(),posted=[],workers=[],images=[];
Object.defineProperty(globalThis,'performance',{value:{now:()=>now},configurable:true});
globalThis.setTimeout=(fn,ms)=>{timers.set(++timer,{fn,at:now+ms});return timer;};globalThis.clearTimeout=id=>timers.delete(id);
const context=()=>new Proxy({globalAlpha:1,imageSmoothingEnabled:true},{get(t,k){if(k in t)return t[k];if(k==='getImageData')return(x,y,w,h)=>({data:new Uint8ClampedArray(w*h*4)});if(k==='createPattern')return()=>({});if(k==='createLinearGradient')return()=>({addColorStop(){}});return()=>{};},set(t,k,v){t[k]=v;return true;}});
class Element{constructor(tag){this.tag=tag;this.tagName=tag;this.children=[];this.style={};this.hidden=false;this.value='';this.textContent='';}append(...items){for(const item of items){this.children.push(item);item.parentElement=this;}}prepend(...items){this.children.unshift(...items);}replaceChildren(...items){this.children=[];this.append(...items);}setAttribute(k,v){this[k]=v;}focus(){document.activeElement=this;}click(){this.onclick?.();}remove(){this.removed=true;}addEventListener(type,fn){this[type]=fn;}all(){return[this,...this.children.flatMap(c=>c.all())];}}
class Canvas extends Element{constructor(){super('canvas');this.width=640;this.height=360;this.clientWidth=1280;this.clientHeight=720;this.context=context();}getContext(){return this.context;}getBoundingClientRect(){return{left:0,top:0,width:1280,height:720};}}
const body=new Element('body'),classes=new Set();body.classList={add:x=>classes.add(x),remove:x=>classes.delete(x)};
const nodes=new Map([['#visualizer',new Canvas()],['#timing',new Element('div')],['#preset',new Element('div')],['#status',new Element('div')],['#management',new Element('section')]]);body.append(...nodes.values());
globalThis.document={body,hidden:false,baseURI:'https://aaavs.invalid/mpc.html',activeElement:null,createElement:tag=>tag==='canvas'?new Canvas():new Element(tag),querySelector:id=>nodes.get(id)??null,addEventListener(type,fn){if(type==='keydown')keydown=fn;}};
globalThis.OffscreenCanvas=class extends Canvas{constructor(w,h){super();this.width=w;this.height=h;}};
globalThis.window={chrome:{webview:{postMessage:m=>posted.push(m),addEventListener(type,fn){listener=fn;}}},setTimeout:globalThis.setTimeout,addEventListener(type,fn){if(type==='pagehide')pagehide=fn;},location:{reload(){}}};
globalThis.devicePixelRatio=1;globalThis.requestAnimationFrame=fn=>{raf=fn;};
const persisted={count:4,layout:'grid',source:{kind:'all-presets'},panes:Array.from({length:4},(_,i)=>({bars:i+1,phaseBars:0}))};
globalThis.localStorage={getItem:()=>JSON.stringify(persisted),setItem(){}};
globalThis.Worker=class{constructor(url){this.url=String(url);this.requests=[];this.dead=false;workers.push(this);}postMessage(m){this.requests.push(m);queueMicrotask(()=>{if(m.type==='load')this.onmessage({data:{type:'ready',generation:m.generation}});if(m.type==='render'){const bitmap={width:m.width,height:m.height,closed:false,close(){ok(!this.closed,'bitmap ownership');this.closed=true;}};images.push(bitmap);this.onmessage({data:{type:'frame',generation:m.generation,sequence:m.sequence,bitmap}});}});}terminate(){this.dead=true;}};
const flush=async()=>{for(let i=0;i<24;i++)await Promise.resolve();};
const message=data=>listener({data});
const tick=async(ms=100)=>{now+=ms;raf(now);await flush();};
await import(`data:text/javascript;base64,${Buffer.from(result.outputFiles[0].text).toString('base64')}`);await flush();await tick();
same(workers.filter(w=>!w.dead).length,1,'existing single-preset startup');
const launcher=body.all().find(e=>e['aria-label']==='Multiview layouts and panel sources');ok(launcher,'both hosts have the shared launcher');launcher.click();
ok(posted.some(m=>m.includes('load-setups')),'opening asks for saved sets without writing them');
const control=name=>body.all().find(e=>e['aria-label']===name);const enable=control('Enable multiview');enable.checked=true;enable.onchange();
ok(workers[0].dead,'single renderer stops on multiview enable');
body.all().find(e=>e.textContent==='Close multiview controls · Esc').click();
message({type:'settings',enabled:true,bars:8,shuffle:false,transition:1});
message({type:'audio',position:0,epoch:1,playing:true,pcm:Array(1152).fill(0)});
for(let i=0;i<14;i++)await tick();
same(workers.filter(w=>!w.dead).length,4,'real shared host starts only four panel workers');ok(nodes.get('#preset').textContent.includes('Multiview · 4 panels'));ok(nodes.get('#timing').textContent.includes('Multiview'));
const loaded=workers.filter(w=>!w.dead);for(const w of loaded){const request=w.requests.find(r=>r.type==='render');ok(request.audio,'shared audio snapshot reaches every panel');ok(request.pcm.byteLength===4608,'shared PCM is copied before transfer');}
// Click panel four and target its native navigation/rating commands, rather than the retained single-view cursor.
nodes.get('#visualizer').click({clientX:1000,clientY:600});
const current=globalThis.actions.current();ok(current!==0,'manager follows selected panel');message({type:'rate',delta:1});ok(posted.some(m=>m.includes('"op":"rate"')&&m.includes(catalog[current].sha256)),'rating targets the displayed panel');
const before=workers.length;message({type:'next'});await tick();same(workers.length,before,'Auto panel queues a choice rather than starting a single-view worker');
for(let t=.25;t<2.5;t+=.25){message({type:'audio',position:t,epoch:1,playing:true,pcm:Array(1152).fill(0)});await tick();}
ok(workers.filter(w=>!w.dead).length<=5,'shared host obeys incoming-worker ceiling through independent Auto');
// Native seek path must not accidentally restart the separate single-view renderer.
message({type:'audio',position:.1,epoch:2,playing:false,pcm:Array(1152).fill(0)});for(let i=0;i<12;i++)await tick();ok(workers.filter(w=>!w.dead).length<=5,'seek remains inside multiview');
message({type:'setups-loaded',setups:[{id:'fixture-set',name:'Saved fixture',presets:catalog.slice(0,3).map(p=>p.sha256),settings:{enabled:true,bars:8,shuffle:false,minimumRating:0,transition:1,beats:0,durationMs:2000,keepOld:true,manualFade:true,autoFade:true}}]});
launcher.click();ok(control('Multiview source').children.some(c=>c.textContent==='Saved fixture'),'saved sets reach multiview UI through existing bridge');
const toggle=control('Enable multiview');toggle.checked=false;toggle.onchange();await flush();same(workers.filter(w=>!w.dead).length,1,'disable restores the single-preset host');
pagehide();await flush();ok(workers.every(w=>w.dead),'shared pagehide closes every worker');ok(images.every(i=>i.closed),'shared pagehide closes transferred frames');
console.log(`Shared host multiview CPU checks passed (${checks} assertions). No browser, GPU or application launched.`);
