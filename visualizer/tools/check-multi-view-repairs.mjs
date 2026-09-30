// CPU-only Multiview regression checks for the review defects: queued choices across refresh and seek, restored Play folder sources,
// per-panel Auto holds, runtime transition policy, queue precedence at clipped set boundaries, setup save acknowledgements, pane
// timing feedback and scratch release, deferred hidden preloads, and keyboard focus/Space handling.
// Real session, runtime, clock, compositor, controls and shared host; synthetic catalogs; injected DOM, canvas, storage and Workers.
// Every section runs; the summary names each defect that failed. No browser, GPU or application launch.
import {build} from 'esbuild';
import assert from 'node:assert/strict';
let variant=0;
async function load(path,options={}){const result=await build({entryPoints:[path],bundle:true,format:'esm',write:false,...options});return import(`data:text/javascript;base64,${Buffer.from(result.outputFiles[0].text+`\n// variant ${++variant}`).toString('base64')}`);}
const S=await load('src/multi-view-session.ts'),C=await load('src/multi-view-clock.ts'),M=await load('src/multi-view-model.ts'),R=await load('src/multi-view-runtime.ts'),P=await load('src/multi-view-compositor.ts'),U=await load('src/multi-view-controls.ts'),K=await load('src/keyboard-guard.ts');
let checks=0;const ok=(v,m)=>{checks++;assert.ok(v,m);},same=(a,b,m)=>{checks++;assert.deepEqual(a,b,m);};
const results=[];
async function section(name,fn){try{await fn();results.push([name,null]);}catch(error){results.push([name,error]);}}

// ------------------------------------------------------------------------------------------------ fake DOM, canvas and workers
const context=()=>new Proxy({globalAlpha:1,imageSmoothingEnabled:true},{get(t,k){if(k in t)return t[k];if(k==='getImageData')return(x,y,w,h)=>({data:new Uint8ClampedArray(w*h*4)});if(k==='createPattern')return()=>({});if(k==='createLinearGradient')return()=>({addColorStop(){}});return()=>{};},set(t,k,v){t[k]=v;return true;}});
class Element{constructor(tag){this.tag=tag;this.tagName=tag.toUpperCase();this.children=[];this.style={};this.hidden=false;this.textContent='';this.value='';}
 append(...items){for(const item of items){this.children.push(item);item.parentElement=this;}}prepend(...items){for(const item of items){this.children.unshift(item);item.parentElement=this;}}
 replaceChildren(...items){this.children=[];this.append(...items);}setAttribute(k,v){this[k]=String(v);}getAttribute(k){return this[k]??null;}focus(){globalThis.document.activeElement=this;}click(){this.onclick?.();}remove(){this.removed=true;}
 all(){return[this,...this.children.flatMap(c=>c.all())];}}
class Canvas extends Element{constructor(){super('canvas');this.width=300;this.height=150;this.ctx=context();}getContext(){return this.ctx;}}
const parent=new Element('main');globalThis.document={body:parent,activeElement:null,getElementById:()=>null,createElement:tag=>tag==='canvas'?new Canvas():new Element(tag)};
const hash=i=>i.toString(16).padStart(64,'0');
const avsCatalog=Array.from({length:12},(_,i)=>({sha256:hash(i+1),name:`Synthetic ${i}`,autoEligible:true,scene:'radar'}));
const nervCatalog=avsCatalog.map(p=>({...p,kind:'nerv'}));
const silence={waveform:[new Uint8Array(576),new Uint8Array(576)],spectrum:[new Uint8Array(576),new Uint8Array(576)],beat:false,beatLevel:0};
const flush=async(n=24)=>{for(let i=0;i<n;i++)await Promise.resolve();};
const pane=(v={})=>({bars:1,phaseBars:0,transition:'cut',...v});
/** One session on the real code with a fake host. `run(to)` advances media time in playing steps; `seekTo(t)` jumps like the host does. */
function harness({plan,catalog=avsCatalog,storage=new Map(),folders=[],view={width:1280,height:720,dpr:1},prefs={quality:'balanced',avsResolution:'classic',pixelArt:'auto',showFps:1,timingOverlay:0},clock}={}){
 const state={position:0,playing:true,now:0,messages:[],workers:[],presents:0};
 if(plan)storage.set('aaavs.multiView.v1',JSON.stringify(plan));
 const host={catalog:()=>catalog,presets:async()=>new Uint8Array([1,2,3]),bitmaps:async()=>[],view:()=>view,display:()=>prefs,audio:()=>silence,pcm:()=>new Float32Array(1152),
  hudFeed:{snapshot:()=>new Float32Array(64)},position:()=>state.position,duration:()=>600,playing:()=>state.playing,visible:()=>true,reducedMotion:()=>false,mode(){},announce:t=>state.messages.push(t),
  failed(){},failures:()=>new Set(),present:()=>{state.presents++;},folders:()=>folders,storage:()=>({getItem:k=>storage.has(k)?storage.get(k):null,setItem:(k,v)=>{storage.set(k,v);}}),
  now:clock??(()=>state.now),
  worker(url){const w={url,dead:false,requests:[],postMessage(request){this.requests.push(request);queueMicrotask(()=>{if(this.dead)return;if(request.type==='load')this.onmessage({data:{type:'ready',generation:request.generation}});else if(request.type==='render')this.onmessage({data:{type:'frame',generation:request.generation,sequence:request.sequence,bitmap:{width:request.width,height:request.height,close(){}}}});});},terminate(){this.dead=true;}};state.workers.push(w);return w;}};
 const session=new S.MultiViewSession(host);
 const tick=async()=>{state.now+=33;session.frame(state.now);await flush();};
 const run=async(to,step=.25)=>{while(state.position<to-1e-9){state.position=Math.min(to,+(state.position+step).toFixed(6));for(let i=0;i<3;i++)await tick();}for(let i=0;i<3;i++)await tick();};
 const seekTo=async t=>{state.position=t;session.seek();for(let i=0;i<6;i++)await tick();};
 return {session,state,host,storage,tick,run,seekTo};
}
const basePlan=(v={})=>({version:1,count:2,layout:'columns',source:{kind:'all-presets'},panes:[pane(),pane({transition:'dissolve'})],timing:{enabled:true,bpm:120,offsetSeconds:0,barsPerScene:8,seed:7},avoidDuplicates:false,...v});

// ------------------------------------------------------------------------------------------------ defect 1: queue survives refresh and seek
await section('1 queued panel choice survives unrelated refresh and seek replay',async()=>{
 const h=harness({plan:basePlan()});h.session.enable(true);await h.run(.5);
 same(h.session.currentIndex,0,'pane 1 starts on the first preset');
 ok(h.session.selectPreset(4),'choice inside the Auto pool is accepted');ok(h.state.messages.includes('Queued for panel 1'),'choice queued, not held');
 h.session.refreshSources();h.session.receiveSets([]);// settings/rating refresh and a set reload with unchanged sources
 await h.run(2.5);same(h.session.currentIndex,4,'queued preset wins the next boundary after an unrelated refresh');
 await h.run(4.5);same(h.session.currentIndex,5,'sequence continues from the queued preset');
 await h.seekTo(1);h.session.refreshSources();await h.run(2.5);same(h.session.currentIndex,4,'seek replay keeps the recorded choice after another recompilation');
 // Explicit reset: a changed lane identity (bars) starts that pane's history again; other panes keep theirs.
 const lanes=h.session['lanes'];ok(lanes&&lanes.cuesFor(0).length===1,'history is owned by the session');
 h.session.apply({...h.session['plan'],panes:h.session['plan'].panes.map((p,i)=>i===0?{...p,bars:2}:p)});same(lanes.cuesFor(0).length,0,'changing panel bars explicitly resets its cues');
 h.session.close();
});

// ------------------------------------------------------------------------------------------------ defect 2: Play folder survives reload
await section('2 saved Play folder source restores after reload',async()=>{
 const storage=new Map(),a=harness({plan:basePlan(),storage});a.session.enable(true);
 ok(a.session.useFolder({id:'fixture folder key',name:'Fixture folder',order:[2,3,4]}),'multiview accepts the folder');await a.run(.5);
 same(a.session.currentIndex,2,'folder plays from its first member');a.session.close();
 ok(!/[\\/]/.test(storage.get('aaavs.multiView.folders.v1')??''),'descriptor stores hashes and a name, never paths');
 const b=harness({storage});b.session.enable(true);await b.run(.5);
 same(b.session.currentIndex,2,'restored lane resupplies the folder descriptor instead of a missing set');
 same(b.session['clock'].at(.5)[1]?.sourceLabel,'Fixture folder','second panel shares the restored folder');
 b.session.close();
});

// ------------------------------------------------------------------------------------------------ defect 3: per-panel Auto off holds
await section('3 per-panel Auto off holds the current selection',async()=>{
 const h=harness({plan:basePlan()});h.session.enable(true);await h.run(3);
 same(h.session.currentIndex,1,'at second 3 panel 1 shows its second preset');
 const plan=h.session['plan'];h.session.apply({...plan,panes:plan.panes.map((p,i)=>i===0?{...p,auto:false}:p)});
 await h.run(3.5);same(h.session.currentIndex,1,'turning panel Auto off keeps the current preset');
 await h.run(6.5);same(h.session.currentIndex,1,'held through later boundaries');same(h.session['clock'].at(6.5)[1].phase.index,4,'other panels keep rotating');
 await h.seekTo(.2);same(h.session['clock'].at(.2)[0].phase.index,1,'hold survives a seek');
 const held=h.session['plan'];h.session.apply({...held,panes:held.panes.map((p,i)=>i===0?{...p,auto:true}:p)});await h.run(2.5);
 same(h.session.currentIndex,1,'Auto on resumes the song clock');await h.run(4.5);same(h.session.currentIndex,2);
 h.session.close();
});

// ------------------------------------------------------------------------------------------------ defect 4: transition policy reaches the runtime
await section('4 panel transition change reaches the runtime without discarding cues',async()=>{
 const h=harness({plan:basePlan()});h.session.enable(true);await h.run(2.25);
 same(h.session['runtime'].images(2.25)[0].outgoing,null,'Cut drops the outgoing face at once');
 ok(h.session.selectPreset(7),'queue before the policy change');
 const plan=h.session['plan'];h.session.apply({...plan,panes:plan.panes.map((p,i)=>i===0?{...p,transition:'dissolve'}:p)});
 await h.run(4.25);const image=h.session['runtime'].images(4.25)[0];
 ok(image.outgoing,'Dissolve keeps the outgoing face for the fade after the change');same(image.transition,'dissolve','runtime reports the new policy');ok(image.progress>0&&image.progress<1,'fade in progress');
 same(h.session.currentIndex,7,'policy update kept the queued choice');
 const back=h.session['plan'];h.session.apply({...back,panes:back.panes.map((p,i)=>i===0?{...p,transition:'cut'}:p)});
 same(h.session['runtime'].images(4.3)[0].outgoing,null,'switching back to Cut releases the outgoing bitmap at once');
 h.session.close();
});

// ------------------------------------------------------------------------------------------------ defect 5: queue precedence at set boundaries
await section('5 queued choice wins the next visible boundary, including shorter set boundaries',async()=>{
 const sets=[{id:'a',name:'Set A',order:[0,1]},{id:'b',name:'Set B',order:[2,3]}];
 const plan=(barsPerSet,bars)=>M.parseMultiViewPlan({count:1,layout:'single',source:{kind:'all-sets',traversal:'sets',barsPerSet},panes:[pane({bars})],timing:{enabled:true,bpm:120,offsetSeconds:0,barsPerScene:8,seed:3}});
 // 8-bar presets, 4-bar sets at 120 BPM: the next visible boundary is the set boundary at 8 s.
 let clock=new C.MultiViewClock(plan(4,8),avsCatalog,sets);same(clock.at(1)[0].phase.index,0);same(clock.at(1)[0].phase.end,8,'visible span clipped by the set');
 ok(clock.queue(0,1,1),'queue inside the current set');same(clock.at(1.5)[0].phase.index,0,'no immediate switch');
 same(clock.at(7.9)[0].next.index,1,'preload predicts the queued choice at the set boundary');same(clock.at(8.1)[0].phase.index,1,'queued choice wins the set boundary at 8 s');
 same(clock.at(15.9)[0].phase.index,1,'it owns exactly that visible span');const fresh=new C.MultiViewClock(plan(4,8),avsCatalog,sets);for(const t of [16.1,24.1,40.1])same(clock.at(t)[0].phase.index,fresh.at(t)[0].phase.index,'set traversal resumes afterwards');
 clock.at(100);same(clock.at(8.1)[0].phase.index,1,'seek replay');
 // Coinciding preset and set boundary where the set changes: the choice is not filtered out by the next set.
 clock=new C.MultiViewClock(plan(8,8),avsCatalog,sets);ok(clock.queue(0,1,1));same(clock.at(16.1)[0].phase.index,1,'choice wins a set-changing boundary');same(clock.at(32.1)[0].phase.index,new C.MultiViewClock(plan(8,8),avsCatalog,sets).at(32.1)[0].phase.index,'traversal resumes');
 // Shorter presets inside a set: ordinary lane cue, sequence continues from the choice.
 clock=new C.MultiViewClock(plan(4,2),avsCatalog,sets);ok(clock.queue(0,1,1));same(clock.at(4.1)[0].phase.index,1,'next preset boundary');same(clock.at(8.1)[0].sourceLabel,'Set B');
 // History outlives recompilation when the session supplies it.
 const state=new C.MultiViewLaneState();clock=new C.MultiViewClock(plan(4,8),avsCatalog,sets,new Set(),state);ok(clock.queue(0,1,1));
 same(new C.MultiViewClock(plan(4,8),avsCatalog,sets,new Set(),state).at(8.1)[0].phase.index,1,'recompiled clock keeps the boundary choice');
 // Through the real session and runtime.
 const h=harness({plan:{...plan(4,8)},folders:sets});h.session.enable(true);await h.run(1);ok(h.session.selectPreset(1));await h.run(8.5);same(h.session.currentIndex,1,'session shows the queued choice at 8 s');h.session.close();
});

// ------------------------------------------------------------------------------------------------ defect 6: setup save acknowledgement (shared host)
await section('6 setup save acknowledgement refreshes Multiview sources without a false error (native and browser shapes)',async()=>{
 const host=await loadHost();
 for(const shape of ['native','browser']){
  const run=await host(shape);const before=run.announcements.length;
  const saved=[{id:'fixture-set',name:'Saved fixture',presets:avsCatalog.slice(0,3).map(p=>p.sha256),settings:{enabled:true,bars:8,shuffle:false,minimumRating:0,transition:1,beats:0,durationMs:2000,keepOld:true,manualFade:true,autoFade:true}}];
  await run.save(saved);
  ok(!run.announcements.slice(before).some(t=>/Multiview sets unavailable/.test(t)),`${shape}: a successful save is not reported as an error`);
  ok(run.sourceNames().includes('Saved fixture'),`${shape}: saved setup appears in Multiview sources`);
  await run.save([]);ok(!run.sourceNames().includes('Saved fixture'),`${shape}: a delete acknowledgement refreshes the sources`);
  await run.save([{...saved[0],name:'Renamed fixture'}]);ok(run.sourceNames().includes('Renamed fixture'),`${shape}: an edit acknowledgement refreshes the sources`);
  run.close();
 }
});

// ------------------------------------------------------------------------------------------------ defect 7: performance feedback
await section('7 pane timings feed adaptive quality; scratch released and byte-bounded; frame age; hidden preloads deferred',async()=>{
 // Slow accepted pane frames (25 ms each) step the pane's Auto governor down, as the single-view host does.
 let ms=0;const h=harness({plan:basePlan({count:1,layout:'single',panes:[pane({bars:64})]}),catalog:nervCatalog,view:{width:3840,height:2160,dpr:1},prefs:{quality:'auto',avsResolution:'classic',pixelArt:'auto',showFps:1,timingOverlay:0},clock:()=>(ms+=25)});
 h.session.enable(true);await h.run(1);const first=h.state.workers[0].requests.find(r=>r.type==='render');
 for(let i=0;i<80;i++){h.state.position+=.01;h.state.now+=5000;h.session.frame(h.state.now);await flush();}
 ok(h.state.messages.some(t=>/^Panel 1 render quality: /.test(t)),'accepted pane timings reach the governor');
 const last=h.state.workers[0].requests.filter(r=>r.type==='render').at(-1);ok(last.width*last.height<first.width*first.height,'the pane renders at the lower tier');
 ok(typeof h.session.frameAge==='number'&&h.session.frameAge>=0,'pane frame age is reported apart from composite FPS');h.session.close();
 // Scratch planes: bounded while four 4K-grid numeric fades run, released when they finish.
 const made=[];const compositor=new P.MultiViewCompositor((w,h)=>{const c={width:w,height:h,getContext:()=>context()};made.push(c);return c;});
 const plate={image:{},width:1920,height:1080,smooth:true},plan=M.parseMultiViewPlan({count:4,layout:'grid',gutter:0});
 const draw=progress=>compositor.draw(context(),{...plan,width:3840,height:2160,images:Array.from({length:4},(_,i)=>({current:plate,outgoing:plate,progress,transition:1,seed:i})),beat:0,level:0,reducedMotion:false});
 draw(.5);ok(compositor.scratchBytes>0&&compositor.scratchBytes<=P.MULTI_VIEW_SCRATCH_BYTES,`four fades stay within the scratch byte budget (${compositor.scratchBytes} bytes)`);
 ok(4*3840/2*2160/2*4*P.MULTI_VIEW_SCRATCH_PLANES>P.MULTI_VIEW_SCRATCH_BYTES,'the unbounded model exceeds the budget');
 draw(1);same(compositor.scratchBytes,0,'finished fades release their scratch planes');ok(made.every(c=>c.width===0&&c.height===0),'released planes drop their backing stores');
 // Hidden preload: a worker that finishes loading while hidden renders nothing until visible.
 let release;const gate=new Promise(r=>{release=r;});const calls=[];
 const host={async create(index){await gate;return{render(frame){calls.push(frame);return Promise.resolve({width:8,height:8,close(){}});},dispose(){}};},changed(){},failed(){}};
 const runtime=new R.MultiViewRuntime(new C.MultiViewClock(M.parseMultiViewPlan({count:1,layout:'single',panes:[pane({bars:1})]}),avsCatalog,[]),host);
 runtime.tick(0,16,true,true);await flush();runtime.tick(0,32,true,false);release();await flush();same(calls.length,0,'no render dispatched while hidden');
 runtime.tick(0,48,true,true);await flush();ok(calls.length>=1,'the deferred render runs on the next visible tick');runtime.tick(.1,64,true,true);await flush();ok(runtime.frameAge()!==null,'committed pane reports its frame age');runtime.close();
});

// ------------------------------------------------------------------------------------------------ defect 8: keyboard focus, selection state, Space
await section('8 control focus survives structural redraws; selected pane and held timing are exposed; Space on controls is not play/pause',async()=>{
 const container=new Element('section');let plan=M.parseMultiViewPlan({count:4}),selected=0;
 const find=label=>container.all().find(n=>n['aria-label']===label);
 const handle=U.renderMultiViewControls(container,{plan:()=>plan,apply:p=>{plan=p;},sets:()=>[],enabled:()=>true,enable(){},selectPane:i=>{selected=i;handle.select(i);},selected:()=>selected});
 let count=find('Panels');count.focus();count.value='3';count.onchange();ok(find('Panels')!==count,'count change rebuilds the controls');same(document.activeElement,find('Panels'),'focus returns to the equivalent control');
 const src=find('Panel 2 source');src.focus();src.value='all-presets';src.onchange();same(document.activeElement,find('Panel 2 source'),'source change keeps focus');
 find('Select panel 2').click();same(find('Select panel 2')['aria-pressed'],'true','selected pane is pressed');same(find('Select panel 1')['aria-pressed'],'false');
 const auto=find('Panel 1 Auto');auto.focus();auto.checked=false;auto.onchange();same(document.activeElement,find('Panel 1 Auto'),'Auto change keeps focus');
 for(const name of ['Panel 1 bars per preset','Panel 1 stagger (bars)','Panel 1 shuffle']){const input=find(name);same(input['aria-disabled'],'true',`${name} is held`);const reason=container.all().find(n=>n.id===input['aria-describedby']);ok(reason&&/Auto is off/.test(reason.textContent),`${name} names a keyboard-readable reason`);}
 const bars=find('Panel 1 bars per preset'),kept=plan.panes[0].bars;bars.value=String(kept+8);bars.onchange();same(plan.panes[0].bars,kept,'held timing refuses edits');same(bars.value,String(kept));
 handle.refresh();same(find('Select panel 2')['aria-pressed'],'true','selection state persists across a refresh');handle();
 // Space ownership in the shared shortcut handler.
 for(const target of [{tagName:'BUTTON'},{tagName:'INPUT',type:'checkbox'},{tagName:'SELECT'},{tagName:'DIV',role:'button'},{tagName:'A',href:'#x'}])ok(K.isInteractiveTarget(target),`${target.tagName} owns Space`);
 for(const target of [null,{tagName:'BODY'},{tagName:'CANVAS'},{tagName:'DIV'}])ok(!K.isInteractiveTarget(target),'page surfaces leave Space to play/pause');
 const host=await loadHost();const run=await host('native');ok(run.space(run.launcher())===false,'Space on the embedded Multiview button is not play/pause');ok(run.space(null)===true,'Space elsewhere still toggles playback');run.close();
 // A set refresh while the controls are open keeps focus on the same control.
 const h=harness({plan:basePlan()});h.session.enable(true);h.session.showControls(parent);const layout=parent.all().find(n=>n['aria-label']==='Multiview layout'&&!n.removed);layout.focus();
 h.session.receiveSets([]);same(document.activeElement?.['aria-label'],'Multiview layout','set refresh does not steal focus');h.session.close();
});

// ------------------------------------------------------------------------------------------------ shared host loader for defects 6 and 8
async function loadHost(){
 const code=(await build({entryPoints:['src/mpc-host.ts'],bundle:true,format:'esm',write:false,define:{'import.meta.url':'"https://aaavs.invalid/dist/mpc-host.js"'},plugins:[{name:'synthetic-library',setup(b){
  b.onResolve({filter:/(local-collection|mpc-management|mpc-bitmap-dependencies)\.ts$/},args=>({path:args.path,namespace:'fixture'}));
  b.onLoad({filter:/.*/,namespace:'fixture'},args=>({contents:args.path.includes('local-collection')?`export async function fetchLocalAvsCatalog(){return globalThis.catalog;} export async function fetchLocalAvsPreset(){return new Uint8Array([1,2,3,4]);} export function isSceneKind(p){return p?.kind==='nerv'||p?.kind==='hud';} export async function fetchLocalAvsSources(){return new Map();} export function parseLocalAvsSources(){return new Map();}`
   :args.path.includes('management')?`export class PresetManagement{open=false;sets=[];loaded=false;pending=null;constructor(a){globalThis.actions=a;globalThis.manager=this;return new Proxy(this,{get:(t,k)=>k in t?t[k]:typeof k==='symbol'?undefined:()=>undefined});}
     receive(type,payload){if(type==='setups-loaded'){this.sets=payload;this.loaded=true;}if(type==='setups-saved'&&this.pending){this.sets=this.pending;this.pending=null;}}
     save(setups){this.pending=setups;globalThis.actions.send({op:'save-setups',setups});}
     acknowledgedSetups(){return this.loaded?this.sets:null;}}`:`export async function loadPresetBitmaps(){return [];}`}));
 }}]})).outputFiles[0].text;
 const standalone=await load('src/standalone-player.ts',{plugins:[{name:'headless-host',setup(b){b.onResolve({filter:/mpc-host\.ts$/},()=>({path:'host',namespace:'test'}));b.onLoad({filter:/.*/,namespace:'test'},()=>({contents:'export {};',loader:'js'}));}}]});
 return async shape=>{
  let now=0,raf,keydown,listener,pagehide;const posted=[],announcements=[],body=new Element('body'),stored=new Map();body.classList={add(){},remove(){}};
  const status=new Element('div');Object.defineProperty(status,'textContent',{get(){return this._t??'';},set(v){this._t=v;if(v)announcements.push(v);}});
  const nodes=new Map([['#visualizer',new Canvas()],['#timing',new Element('div')],['#preset',new Element('div')],['#status',status],['#management',new Element('section')]]);body.append(...nodes.values());
  const canvas=nodes.get('#visualizer');canvas.clientWidth=1280;canvas.clientHeight=720;canvas.getBoundingClientRect=()=>({left:0,top:0,width:1280,height:720});canvas.addEventListener=(t,f)=>{canvas['on'+t]=f;};
  globalThis.catalog=avsCatalog;globalThis.fetch=async()=>{throw Error('synthetic offline fixture');};
  Object.defineProperty(globalThis,'performance',{value:{now:()=>now},configurable:true});globalThis.setTimeout=(fn)=>0;globalThis.clearTimeout=()=>{};
  globalThis.document={body,hidden:false,getElementById:()=>null,baseURI:'https://aaavs.invalid/mpc.html',activeElement:null,createElement:tag=>tag==='canvas'?new Canvas():new Element(tag),querySelector:id=>nodes.get(id)??null,addEventListener(type,fn){if(type==='keydown')keydown=fn;}};
  globalThis.OffscreenCanvas=class extends Canvas{constructor(w,h){super();this.width=w;this.height=h;}};globalThis.devicePixelRatio=1;globalThis.requestAnimationFrame=fn=>{raf=fn;};
  globalThis.localStorage={getItem:k=>stored.get(k)??null,setItem:(k,v)=>stored.set(k,v)};
  globalThis.Worker=class{constructor(url){this.url=String(url);this.dead=false;}postMessage(m){queueMicrotask(()=>{if(this.dead)return;if(m.type==='load')this.onmessage({data:{type:'ready',generation:m.generation}});if(m.type==='render')this.onmessage({data:{type:'frame',generation:m.generation,sequence:m.sequence,bitmap:{width:m.width,height:m.height,close(){}}}});});}terminate(){this.dead=true;}};
  let bridge;
  if(shape==='native')bridge={postMessage(m){posted.push(m);if(typeof m==='string'&&m.startsWith('library:')){const r=JSON.parse(m.slice(8));
   // AAAVSView.cpp answers save-setups with the literal {"type":"setups-saved"} and load-setups with the stored array.
   if(r.op==='save-setups')queueMicrotask(()=>listener({data:{type:'setups-saved'}}));if(r.op==='load-setups')queueMicrotask(()=>listener({data:{type:'setups-loaded',setups:[]}}));}},addEventListener(t,fn){listener=fn;}};
  else{// The browser Player's real bridge; its library answers exactly as tools/standalone-library.mjs does.
   const real=new standalone.StandaloneBridge({async library(v){posted.push(`library:${JSON.stringify(v)}`);return v.op==='save-setups'?{type:'setups-saved'}:v.op==='load-setups'?{type:'setups-loaded',setups:[]}:{type:'settings',enabled:true,bars:8};},playPause(){posted.push('play-pause');},fullscreen(){},options(){},notice(){},settings(){}});
   bridge={postMessage(m){if(m==='play-pause'){posted.push(m);return;}real.postMessage(m);},addEventListener(t,fn){real.addEventListener(t,fn);}};}
  globalThis.window={...(shape==='native'?{chrome:{webview:bridge}}:{aaavsBridge:bridge}),setTimeout:globalThis.setTimeout,addEventListener(type,fn){if(type==='pagehide')pagehide=fn;},location:{reload(){}}};
  await import(`data:text/javascript;base64,${Buffer.from(code+`\n// host ${++variant}`).toString('base64')}`);await flush();
  const tick=async()=>{now+=50;raf?.(now);await flush();await new Promise(r=>setImmediate(r));};await tick();
  const launcher=()=>body.all().find(e=>e['aria-label']==='Multiview layouts and panel sources');
  launcher().click();const enable=body.all().find(e=>e['aria-label']==='Enable multiview');enable.checked=true;enable.onchange();
  globalThis.manager.receive('setups-loaded',[]);for(let i=0;i<4;i++)await tick();
  return {announcements,launcher,
   sourceNames:()=>{launcher().click();const select=body.all().filter(e=>e['aria-label']==='Multiview source').at(-1);return select.children.map(c=>c.textContent);},
   async save(setups){globalThis.manager.save(setups);for(let i=0;i<4;i++)await tick();},
   space(target){body.all().find(e=>e.textContent==='Close multiview controls · Esc')?.click();const before=posted.filter(m=>m==='play-pause').length;keydown({code:'Space',repeat:false,ctrlKey:false,altKey:false,shiftKey:false,target,preventDefault(){}});return posted.filter(m=>m==='play-pause').length>before;},
   close(){body.all().find(e=>e.textContent==='Close multiview controls · Esc')?.click();pagehide?.();}};
 };
}

const failed=results.filter(([,e])=>e);
for(const [name,error] of results)console.log(`${error?'FAIL':'PASS'}  defect ${name}${error?`\n      ${String(error.message).split('\n')[0]}`:''}`);
if(failed.length){console.error(`Multiview repair checks: ${failed.length} of ${results.length} defect sections FAILED.`);process.exit(1);}
console.log(`Multiview repair CPU checks passed (${results.length} defect sections, ${checks} assertions). No browser, GPU or application launched.`);
