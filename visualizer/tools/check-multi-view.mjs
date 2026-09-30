// CPU only: real model, musical grid, compositor and lifecycle; injected Canvas/Worker/DOM, synthetic catalogs.
import {build} from 'esbuild';
import assert from 'node:assert/strict';
async function load(path){const result=await build({entryPoints:[path],bundle:true,format:'esm',write:false});return import(`data:text/javascript;base64,${Buffer.from(result.outputFiles[0].text).toString('base64')}`);}
const M=await load('src/multi-view-model.ts'), C=await load('src/multi-view-clock.ts'), P=await load('src/multi-view-compositor.ts'), R=await load('src/multi-view-runtime.ts'), W=await load('src/multi-view-worker.ts'), U=await load('src/multi-view-controls.ts');
let checks=0;const ok=(value,message)=>{checks++;assert.ok(value,message);},same=(actual,expected,message)=>{checks++;assert.deepEqual(actual,expected,message);};
const hash=i=>i.toString(16).padStart(64,'0');
const catalog=Array.from({length:20},(_,i)=>({sha256:hash(i+1),name:`Synthetic preset ${i}`,kind:i%3===0?'nerv':i%3===1?'hud':undefined,autoEligible:true,rating:i%6,scene:'radar'}));
const sets=[{id:'a',name:'Synthetic set A',order:[0,1,2,3]},{id:'b',name:'Synthetic set B',order:[4,5,6,7]},{id:'c',name:'Synthetic set C',order:[8,9,10,11]},{id:'d',name:'Synthetic set D',order:[12,13,14,15]}];
const make=(v={})=>M.parseMultiViewPlan({count:4,timing:{enabled:true,bpm:120,offsetSeconds:0,barsPerScene:8,seed:29},...v});
const plan=make();same(plan.panes.map(p=>p.auto),[true,true,true,true],'Auto is independent and enabled in every pane');
same(make({count:NaN,layout:'oops',source:{kind:'set',id:''},border:{color:'url(secret)',width:Infinity},privatePath:'private'}).count,2);
ok(!JSON.stringify(make({privatePath:'private'})).includes('private'),'unknown private fields dropped');
same(make({source:{kind:'presets',hashes:[hash(1),hash(1),'bad']}}).source.hashes,[hash(1)]);
same(make({panes:[{transition:999},{auto:false,bars:-2}]}).panes[1].bars,1);
for(const layout of M.MULTI_VIEW_LAYOUTS)for(const count of [1,2,3,4])for(const [w,h]of [[640,360],[641,359],[360,640],[1,1]]){
 const boxes=M.multiViewPixelRects(layout,count,w,h,0);same(boxes.length,count);
 for(const box of boxes)ok(Object.values(box).every(Number.isFinite)&&box.x>=0&&box.y>=0&&box.x+box.width<=w&&box.y+box.height<=h,'boxes remain finite and inside viewport');
 if(!['cards','picture-in-picture'].includes(layout))same(boxes.reduce((n,b)=>n+b.width*b.height,0),w*h,'every odd-sized split tiles the viewport without cracks');
}
const pip=M.multiViewPixelRects('picture-in-picture',4,1000,600,0);same(M.multiViewHitTest(pip,700,40),1,'topmost overlay picked');same(M.multiViewHitTest(pip,NaN,0),null);
const two=M.multiViewPixelRects('columns',2,641,359,0);same(two[0].width+two[1].width,641,'odd widths share one rounded split');
same(C.interleaveMultiViewSets([{...sets[0],order:[0,1]},{...sets[1],order:[1,2,3]}]),[0,1,2,3]);
const clock=new C.MultiViewClock(plan,catalog,sets);const initial=clock.at(0);same(new Set(initial.map(f=>f.phase.index)).size,4,'distinct initial library panes');
const atSeven=clock.at(7);same(clock.at(7),atSeven,'selection does not depend on read history');clock.at(100);same(clock.at(7),atSeven,'seek reconstructs lane plan');
const independently=make({panes:[{bars:1,phaseBars:0},{bars:3,phaseBars:0},{bars:5,phaseBars:0},{bars:7,phaseBars:0}],avoidDuplicates:false});
const independent=new C.MultiViewClock(independently,catalog,sets);same(independent.at(2.1).map(f=>f.phase.ordinal),[1,0,0,0],'one panel rotates while the others hold their own timing');
const grouped=new C.MultiViewClock(make({source:{kind:'all-sets',traversal:'sets',barsPerSet:2},panes:Array.from({length:4},()=>({phaseBars:0,bars:3})),avoidDuplicates:false}),catalog,sets);
same(grouped.at(0).map(f=>f.sourceLabel),sets.map(s=>s.name),'all sets assigns different groups to panes');
same(grouped.at(4).map(f=>f.sourceLabel),[sets[1].name,sets[2].name,sets[3].name,sets[0].name],'all sets cycles by musical set interval');
same(grouped.at(3.9)[0].phase.end,4,'set changes clip a longer preset span at the exact set boundary');
same(grouped.at(3.9)[0].next.index,grouped.at(4)[0].phase.index,'preload predicts the group change');
const missing=new C.MultiViewClock(make({source:{kind:'set',id:'missing'}}),catalog,sets);same(missing.at(0),[null,null,null,null],'missing set does not substitute the whole library');
const filtered=new C.MultiViewClock(make({source:{kind:'set',id:'a'},panes:Array.from({length:4},()=>({shuffle:true})),minimumRating:2}),catalog.map((p,i)=>i===2?{...p,notWorking:true}:p),sets,new Set([3]));same(filtered.at(0),[null,null,null,null],'shared ratings, not-working and failed exclusions apply');
const variable=new C.MultiViewClock(make({timing:{...plan.timing,tempoMap:[{at:5,bpm:90}],beatsPerBar:3},panes:Array.from({length:4},(_,i)=>({bars:i+1,phaseBars:i/4}))}),catalog,sets);
for(const t of [0,4.9,5,5.1,40,400]){const frames=variable.at(t);same(new Set(frames.map(f=>f.phase.beatPhase)).size,1,'every lane shares global beat phase through tempo changes');for(const f of frames)ok(f.phase.end>f.phase.start&&f.phase.start<=t||f.phase.countIn>0,'finite musical lane span');}
same(clock.at(NaN),[null,null,null,null]);same(clock.at(Infinity),[null,null,null,null]);
same(clock.at(1e30),[null,null,null,null],'unsafe song ordinals return empty lanes without throwing');
same(C.multiViewSetsFromSetups([{id:'partial',name:'Partial',presets:[hash(1),hash(1000)]}],catalog)[0].order,[0],'a missing member does not poison every set');

// Canvas spy validates crop/fit, clip isolation, transition costs and save/restore balancing. No raster fidelity claim.
const logs=[];let saves=0;
const context=()=>new Proxy({globalAlpha:1,imageSmoothingEnabled:true},{get(t,k){if(k in t)return t[k];if(k==='createPattern')return()=>({});if(k==='getImageData')return(x,y,w,h)=>({data:new Uint8ClampedArray(w*h*4)});if(k==='createLinearGradient')return()=>({addColorStop(){}});return(...args)=>{if(k==='save')saves++;if(k==='restore')saves--;logs.push([k,...args]);};},set(t,k,v){t[k]=v;logs.push(['set',k,v]);return true;}});
const surfaces=[];const canvas=(w,h)=>{const c={width:w,height:h,getContext:()=>context()};surfaces.push(c);return c;};
const compositor=new P.MultiViewCompositor(canvas), ctx=context();const plate={image:{tag:'current'},width:960,height:540,smooth:true},old={image:{tag:'old'},width:640,height:480,smooth:false};
for(const count of [2,3,4])for(const layout of M.MULTI_VIEW_LAYOUTS)for(const motion of M.MULTI_VIEW_MOTIONS)for(const progress of [0,.25,.5,.75,1]){
 const images=Array.from({length:count},(_,i)=>({current:plate,outgoing:old,progress,transition:motion,seed:i}));
 compositor.draw(ctx,{...plan,count,layout,width:641,height:359,images,beat:2.5,level:.8,reducedMotion:false});same(saves,0,'canvas state restored');
}
for(let mode=0;mode<33;mode++){compositor.draw(ctx,{...plan,count:2,width:320,height:180,images:[{current:plate,outgoing:old,progress:.4,transition:mode,seed:12}],beat:1,level:.5,reducedMotion:false});same(saves,0,'existing shared transition composes per pane');}
logs.length=0;compositor.draw(ctx,{...plan,count:2,layout:'columns',width:800,height:600,gutter:0,images:[{current:plate}],beat:0,level:0,reducedMotion:false});
const draw=logs.find(v=>v[0]==='drawImage');same(draw.slice(-2),[400,225],'contain preserves aspect ratio inside a tall pane');
logs.length=0;compositor.draw(ctx,{...plan,count:2,width:800,height:600,images:[{current:plate,outgoing:old,progress:.3,transition:'flip-x'}],beat:1,level:.8,reducedMotion:true});ok(!logs.some(v=>v[0]==='scale'),'reduced motion removes card rotation');
for(const layoutMotion of M.MULTI_VIEW_MOTIONS)compositor.draw(ctx,{...plan,count:4,width:641,height:359,layout:'grid',previousLayout:'rows',layoutProgress:.5,layoutMotion,images:Array.from({length:4},()=>({current:plate})),beat:1,level:.5,reducedMotion:false});same(saves,0,'layout transitions balanced');
compositor.clear();

// Real runtime, fake asynchronous renderers: resource ceiling, late/stale frames, failure retention, hide, seek and close.
const all=[];let changed=0, failures=[];const image=()=>({width:64,height:36,closed:false,close(){ok(!this.closed,'each bitmap closes once');this.closed=true;}});
const renderers=[];let block=null;
const host={async create(index,pane,signal){const renderer={index,pane,dead:false,calls:[],async render(frame){this.calls.push(frame);const b=image();all.push(b);if(block){await block.promise;}return b;},dispose(){this.dead=true;},pushAudio(){},resetAudio(){}};renderers.push(renderer);return renderer;},changed(){changed++;},failed(...args){failures.push(args);}};
const runtime=new R.MultiViewRuntime(new C.MultiViewClock(independently,catalog,sets),host);
const flush=async()=>{for(let n=0;n<15;n++)await Promise.resolve();};
let time=0,now=0;const tick=async(t=time,visible=true,playing=true)=>{time=t;now+=16;runtime.tick(t,now,playing,visible);await flush();ok(runtime.workerCount<=5,'four current workers plus one incoming ceiling');};
for(let i=0;i<12;i++)await tick();ok(runtime.images(0).every(p=>p.current),'all four lanes display independent frames');
const calls=renderers.reduce((n,r)=>n+r.calls.length,0);await tick(.1,false);same(renderers.reduce((n,r)=>n+r.calls.length,0),calls,'hidden panes dispatch no renders');
for(let t=.2;t<3;t+=.2)await tick(t);ok(renderers.some(r=>r.dead),'replaced workers stop while outgoing faces use bitmaps');
runtime.seek();for(let i=0;i<6;i++)await tick(.25);ok(runtime.images(.25).every(p=>p.current),'seek rebuilds current selections');
let release;block={promise:new Promise(resolve=>{release=resolve;})};await tick(.3);runtime.seek();release();block=null;await flush();ok(all.filter(b=>!b.closed).length<=8,'stale frames are rejected and closed');
runtime.configure(new C.MultiViewClock(make({count:2}),catalog,sets));for(let i=0;i<8;i++)await tick(.3);same(runtime.images(.3).length,2,'shrinking closes removed lanes');
runtime.close();runtime.close();await flush();ok(renderers.every(r=>r.dead),'close stops every worker');ok(all.every(b=>b.closed),'close releases all transferred bitmaps');

// Protocol adapter exercises AVS, NERV, HUD, transfer ownership, wrong generations and cancellation without real workers.
const workers=[];let fetches=0;
const silence={waveform:[new Uint8Array(576),new Uint8Array(576)],spectrum:[new Uint8Array(576),new Uint8Array(576)],beat:false,beatLevel:0};
const workerHost={catalog,async fetchPreset(){fetches++;return new Uint8Array([1,2,3,4]);},async bitmaps(){return[];},size(){return{width:64,height:36};},initialAudio(){return silence;},frame(input,index,audio){return{pcm:new Float32Array(1152).buffer,audio};},worker(url){const worker={url,dead:false,requests:[],postMessage(m){this.requests.push(m);queueMicrotask(()=>{if(m.type==='load')this.onmessage({data:{type:'ready',generation:m.generation}});else if(m.type==='render'){const bitmap=image();all.push(bitmap);this.onmessage({data:{type:'frame',generation:m.generation,sequence:m.sequence,bitmap}});}});},terminate(){this.dead=true;}};workers.push(worker);return worker;}};
for(let index=0;index<3;index++){const abort=new AbortController(),renderer=await W.createMultiViewWorker(workerHost,index,index,abort.signal);const bitmap=await renderer.render({lane:clock.at(0)[index],time:0,playing:true,future:false,revision:0});ok(bitmap.width===64);bitmap.close();renderer.dispose();ok(workers.at(-1).dead);}
same(workers.map(w=>w.url),['nerv-render.worker.js','hud-render.worker.js','avs-render.worker.js']);
// a host that chooses scene workers (mpc-host: NERV lanes on the show engine) is asked with the kind and the pane size
{const asked=[];const chooser={...workerHost,sceneWorker(kind,size){asked.push([kind,size.width,size.height]);return workerHost.worker(`chosen:${kind}`);}};
 for(let index=0;index<3;index++){const abort=new AbortController(),renderer=await W.createMultiViewWorker(chooser,index,index,abort.signal);const bitmap=await renderer.render({lane:clock.at(0)[index],time:0,playing:true,future:false,revision:0});ok(bitmap.width===64);bitmap.close();renderer.dispose();}
 same(asked,[['nerv',64,36],['hud',64,36],[undefined,64,36]]);same(workers.slice(-3).map(w=>w.url),['chosen:nerv','chosen:hud','chosen:undefined']);}
const abort=new AbortController(),promise=W.createMultiViewWorker({...workerHost,fetchPreset:()=>new Promise(()=>{})},0,0,abort.signal);abort.abort();await assert.rejects(promise,/closed|canceled/);checks++;
const off=new AbortController();off.abort();await assert.rejects(W.createMultiViewWorker(workerHost,0,0,off.signal),/canceled/);checks++;
const emptyStorage={getItem(){throw Error('blocked');},setItem(){throw Error('blocked');}};same(U.readMultiViewPlan(emptyStorage),M.defaultMultiViewPlan());same(U.saveMultiViewPlan(plan,emptyStorage),false);

class Element{constructor(tag){this.tag=tag;this.children=[];}append(...items){this.children.push(...items);}prepend(...items){this.children.unshift(...items);}replaceChildren(...items){this.children=items;}setAttribute(k,v){this[k]=v;}all(){return[this,...this.children.flatMap(c=>c.all())];}}
globalThis.document={createElement:tag=>new Element(tag)};const container=new Element('section');let uiPlan=plan,enabled=false,selected=0;
const cleanup=U.renderMultiViewControls(container,{plan:()=>uiPlan,apply:p=>{uiPlan=p;},sets:()=>sets.map(s=>({id:s.id,name:s.name})),enabled:()=>enabled,enable:v=>{enabled=v;},selectPane:i=>{selected=i;}});
const control=name=>container.all().find(n=>n['aria-label']===name);ok(control('Panel 4 Auto').checked,'each Auto is available');const count=control('Panels');count.value='3';count.onchange();same(uiPlan.count,3);ok(!control('Panel 4 Auto'),'controls follow visible count');
const src=control('Multiview source');src.value='all-sets:sets';src.onchange();same(uiPlan.source.kind,'all-sets');ok(control('Bars per set'));const panel=control('Panel 2 transition');panel.value='flip-y';panel.onchange();same(uiPlan.panes[1].transition,'flip-y');
cleanup();same(container.children.length,0,'control teardown');
console.log(`Multiview CPU checks passed (${checks} assertions). No browser, GPU or application launched.`);
