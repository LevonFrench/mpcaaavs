import {build} from 'esbuild';
import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
// CPU check of src/render-sizer.ts (the stateful adapter: preferences, device box, Auto governor, debounce) and src/mpc-display.ts
// (DisplayPrefs: wire integers, storage names, tolerant parse, localStorage wrappers). docs/design/RESOLUTION-PIPELINE.md 5.5-5.9,
// CONTRACT 2.2.3, 2.2.6, 2.3.1. Fake clock, fake host and fake storage; no DOM, browser, GPU or timers.
async function load(path){const r=await build({entryPoints:[path],bundle:true,format:'esm',write:false});return import(`data:text/javascript;base64,${Buffer.from(r.outputFiles[0].text).toString('base64')}`);}
const C=await load('src/mpc-contract.ts'),R=await load('src/render-resolution.ts'),D=await load('src/mpc-display.ts'),S=await load('src/render-sizer.ts'),P=await load('src/avs-presentation.ts');
let assertions=0;const ok=(cond,label)=>{assertions++;assert.ok(cond,label);};
const same=(a,b,label)=>{assertions++;assert.deepStrictEqual(a,b,label);};

// ================================================================ mpc-display.ts
// ---- static shape and the contract tables
{
 const text=readFileSync('src/mpc-display.ts','utf8');
 const imports=[...text.matchAll(/^import\s(?:type\s)?[^;]*from\s+'([^']+)'/gm)].map(m=>m[1]).sort();
 same(imports,['./avs-presentation.ts','./mpc-contract.ts','./render-resolution.ts'],'mpc-display.ts imports');
 ok(/^import type .*avs-presentation/m.test(text)&&/^import type .*render-resolution/m.test(text),'the resolution imports are type-only, so the Player bundle stays small');
 for(const banned of ['Date.now','Math.random','performance.now'])ok(!text.includes(banned),`no ${banned}`);
 same(D.QUALITY_NAMES.length,C.QUALITY_COUNT);same(D.AVS_RESOLUTION_NAMES.length,C.AVS_RESOLUTION_COUNT);same(D.PIXEL_ART_NAMES.length,C.PIXEL_ART_COUNT);
 same(D.SHOW_FPS_NAMES.length,C.SHOW_FPS_COUNT);same(D.TIMING_OVERLAY_NAMES.length,C.TIMING_OVERLAY_COUNT);
 same([...D.QUALITY_NAMES],['auto','performance','balanced','high','native']);same([...D.AVS_RESOLUTION_NAMES],['classic','crisp','high']);
 same([...D.PIXEL_ART_NAMES],['auto','integer','smooth']);same([...D.SHOW_FPS_NAMES],['off','fps','detail']);same([...D.TIMING_OVERLAY_NAMES],['hover','always']);
 same([...D.QUALITY_NAMES.slice(1)],[...R.FIXED_TIERS],'quality names are auto plus the fixed tiers in cost order');
 same({...D.DEFAULT_PREFS},{quality:'auto',avsResolution:'classic',pixelArt:'auto',showFps:1,timingOverlay:0});
 same({...D.DEFAULT_PREFS},{...R.DEFAULT_DISPLAY,showFps:1,timingOverlay:0},'DEFAULT_PREFS extends DEFAULT_DISPLAY');
 ok(Object.isFrozen(D.DEFAULT_PREFS)&&Object.isFrozen(D.QUALITY_NAMES)&&Object.isFrozen(D.DISPLAY_FIELDS),'frozen tables');
 same(D.DISPLAY_FIELDS.map(f=>f.key),['quality','avsResolution','pixelArt','showFps','timingOverlay']);
 same(D.DISPLAY_FIELDS.map(f=>f.values.length),[C.QUALITY_COUNT,C.AVS_RESOLUTION_COUNT,C.PIXEL_ART_COUNT,C.SHOW_FPS_COUNT,C.TIMING_OVERLAY_COUNT]);
 for(const f of D.DISPLAY_FIELDS){same(f.labels.length,f.values.length,`labels for ${f.key}`);ok(f.label.length>0&&f.labels.every(l=>l.length>0&&/^[\x20-\x7e]+$/.test(l)),'ASCII labels');ok(Object.isFrozen(f));}
 same(D.DISPLAY_FIELDS.find(f=>f.key==='avsResolution').labels[2],'High (experimental)');
 same(Object.keys(D).sort(),['AVS_RESOLUTION_NAMES','DEFAULT_PREFS','DISPLAY_FIELDS','PIXEL_ART_NAMES','QUALITY_NAMES','SHOW_FPS_NAMES','TIMING_OVERLAY_NAMES','loadPrefs','mergePrefs','parseDisplayPrefs','prefsToStorage','prefsToWire','savePrefs'],'public surface: add new exports to this pin');
}
// ---- parse: wire integers, storage names, mixtures, garbage
{
 const base=D.DEFAULT_PREFS;
 same({...D.parseDisplayPrefs({quality:4,avsResolution:2,pixelArt:1,showFps:2,timingOverlay:1})},{quality:'native',avsResolution:'high',pixelArt:'integer',showFps:2,timingOverlay:1},'wire integers');
 same({...D.parseDisplayPrefs({quality:'performance',avsResolution:'crisp',pixelArt:'smooth',showFps:'detail',timingOverlay:'always'})},{quality:'performance',avsResolution:'crisp',pixelArt:'smooth',showFps:2,timingOverlay:1},'storage names');
 same({...D.parseDisplayPrefs({quality:'balanced',showFps:0,pixelArt:2})},{quality:'balanced',avsResolution:'classic',pixelArt:'smooth',showFps:0,timingOverlay:0},'mixed integers and names, missing keys keep the default');
 same({...D.parseDisplayPrefs({quality:' High ',showFps:'FPS'})},{...base,quality:'high',showFps:1},'names are trimmed and case-insensitive');
 // a missing or invalid key keeps `current`, key by key
 const current=Object.freeze({quality:'high',avsResolution:'crisp',pixelArt:'integer',showFps:2,timingOverlay:1});
 for(const bad of [-1,5,99,1.5,NaN,Infinity,-Infinity,'3','','bogus','auto ?',null,undefined,true,false,{},[],[1],()=>1])
  for(const key of ['quality','avsResolution','pixelArt','showFps','timingOverlay']){
   const r=D.parseDisplayPrefs({[key]:bad},current);
   if(typeof bad==='string'&&D.DISPLAY_FIELDS.find(f=>f.key===key).values.includes(bad.trim().toLowerCase()))continue;   // a valid name that happens to be in the list
   ok(r===current,`invalid ${key}=${String(bad)} keeps current (and returns the same object)`);
  }
 ok(D.parseDisplayPrefs({quality:'zzz',pixelArt:2},current).quality==='high'&&D.parseDisplayPrefs({quality:'zzz',pixelArt:2},current).pixelArt==='smooth','one bad key does not block the others');
 // ranges are exactly the contract counts
 for(const [key,count] of [['quality',C.QUALITY_COUNT],['avsResolution',C.AVS_RESOLUTION_COUNT],['pixelArt',C.PIXEL_ART_COUNT],['showFps',C.SHOW_FPS_COUNT],['timingOverlay',C.TIMING_OVERLAY_COUNT]]){
  for(let i=0;i<count;i++)ok(D.prefsToWire(D.parseDisplayPrefs({[key]:i}))[key]===i,`${key}=${i} is accepted`);
  ok(D.parseDisplayPrefs({[key]:count},current)===current&&D.parseDisplayPrefs({[key]:-1},current)===current,`${key} rejects ${count} and -1`);
 }
 // the input may be a JSON string (a `display:` payload) or anything else
 same({...D.parseDisplayPrefs('{"quality":3,"showFps":0}')},{...base,quality:'high',showFps:0});
 for(const junk of [null,undefined,0,1,'',' ','{','[]','null','5','"x"',[],[1,2],true,()=>1,Symbol.iterator])ok(D.parseDisplayPrefs(junk,current)===current,`garbage ${String(junk)} keeps current`);
 // no prototype leakage: only own properties count
 Object.prototype.quality='native';Object.prototype.showFps=2;
 try{ok(D.parseDisplayPrefs({},base)===base&&D.parseDisplayPrefs(JSON.parse('{"__proto__":{"quality":"native"}}'),base)===base,'inherited and __proto__ keys are ignored');}finally{delete Object.prototype.quality;delete Object.prototype.showFps;}
 // unknown keys are ignored and never copied
 same(Object.keys(D.parseDisplayPrefs({quality:1,extra:1,__x:2})).sort(),['avsResolution','pixelArt','quality','showFps','timingOverlay']);
 ok(Object.isFrozen(D.parseDisplayPrefs({quality:1})),'results are frozen');
 // mergePrefs
 const merged=D.mergePrefs(base,{quality:'native',showFps:0});same({...merged},{...base,quality:'native',showFps:0});
 ok(D.mergePrefs(base,{})===base&&D.mergePrefs(base,{quality:'auto'})===base&&D.mergePrefs(base,null)===base&&D.mergePrefs(base,undefined)===base,'merge with nothing new returns the same object');
 ok(D.mergePrefs(base,{quality:'nope',showFps:7})===base,'invalid patch values are ignored');
 same({...D.mergePrefs(current,{timingOverlay:0,pixelArt:'auto'})},{...current,timingOverlay:0,pixelArt:'auto'});
 ok(current.quality==='high','merge and parse never mutate their input');
}
// ---- wire and storage forms round-trip over the whole 5 x 3 x 3 x 3 x 2 space
{
 let n=0;
 for(const quality of D.QUALITY_NAMES)for(const avsResolution of D.AVS_RESOLUTION_NAMES)for(const pixelArt of D.PIXEL_ART_NAMES)for(const showFps of [0,1,2])for(const timingOverlay of [0,1]){
  const prefs={quality,avsResolution,pixelArt,showFps,timingOverlay},wire=D.prefsToWire(prefs),stored=D.prefsToStorage(prefs);
  same(Object.keys(wire),['quality','avsResolution','pixelArt','showFps','timingOverlay'],'wire key order');
  ok(Object.values(wire).every(Number.isInteger),'wire values are integers');
  same({...D.parseDisplayPrefs(wire,{quality:'native',avsResolution:'high',pixelArt:'smooth',showFps:2,timingOverlay:1})},prefs,'wire round trip');
  same({...D.parseDisplayPrefs(JSON.parse(JSON.stringify(stored)),{quality:'native',avsResolution:'high',pixelArt:'smooth',showFps:2,timingOverlay:1})},prefs,'storage round trip');
  same({...D.parseDisplayPrefs(`display:x`.slice(0,0)+JSON.stringify(wire))},prefs,'a `display:` JSON payload round trips');
  ok(Object.values(stored).every(v=>typeof v==='string'),'storage values are names');n++;
 }
 same(n,270);
 same(D.prefsToWire(D.DEFAULT_PREFS),{quality:0,avsResolution:0,pixelArt:0,showFps:1,timingOverlay:0});
 same(D.prefsToStorage({quality:'balanced',avsResolution:'crisp',pixelArt:'integer',showFps:2,timingOverlay:1}),{quality:'balanced',avsResolution:'crisp',pixelArt:'integer',showFps:'detail',timingOverlay:'always'});
 same(D.prefsToStorage(D.DEFAULT_PREFS),{quality:'auto',avsResolution:'classic',pixelArt:'auto',showFps:'fps',timingOverlay:'hover'});
}
// ---- localStorage wrappers: every access in try/catch, works with no storage at all
{
 const scope=globalThis,had=Object.getOwnPropertyDescriptor(scope,'localStorage');
 const install=impl=>Object.defineProperty(scope,'localStorage',{configurable:true,get:impl});
 const restore=()=>{delete scope.localStorage;if(had)Object.defineProperty(scope,'localStorage',had);};
 try{
  delete scope.localStorage;
  same(D.loadPrefs(),D.DEFAULT_PREFS,'no localStorage at all');assert.doesNotThrow(()=>D.savePrefs(D.DEFAULT_PREFS));
  install(()=>{throw new DOMException('blocked','SecurityError');});
  same(D.loadPrefs(),D.DEFAULT_PREFS,'a throwing localStorage getter');assert.doesNotThrow(()=>D.savePrefs(D.DEFAULT_PREFS));
  const data=new Map(),calls=[];
  const store={getItem:k=>{calls.push(['get',k]);return data.has(k)?data.get(k):null;},setItem:(k,v)=>{calls.push(['set',k,v]);data.set(k,v);}};
  install(()=>store);
  same(D.loadPrefs(),D.DEFAULT_PREFS,'nothing stored');
  const prefs={quality:'native',avsResolution:'crisp',pixelArt:'smooth',showFps:2,timingOverlay:1};
  D.savePrefs(prefs);
  same(calls.at(-1),['set','aaavs.mpcDisplay.v1','{"quality":"native","avsResolution":"crisp","pixelArt":"smooth","showFps":"detail","timingOverlay":"always"}'],'storage key and object');
  same(C.DISPLAY_STORAGE_KEY,'aaavs.mpcDisplay.v1');
  same({...D.loadPrefs()},prefs,'save then load');
  data.set('aaavs.mpcDisplay.v1','{not json');same(D.loadPrefs(),D.DEFAULT_PREFS,'corrupt JSON');
  data.set('aaavs.mpcDisplay.v1','[1,2]');same(D.loadPrefs(),D.DEFAULT_PREFS,'an array');
  data.set('aaavs.mpcDisplay.v1','"quality"');same(D.loadPrefs(),D.DEFAULT_PREFS,'a string');
  data.set('aaavs.mpcDisplay.v1','{"quality":"balanced","pixelArt":"bogus","showFps":2}');same({...D.loadPrefs()},{...D.DEFAULT_PREFS,quality:'balanced',showFps:2},'partial and partly invalid');
  data.set('aaavs.mpcDisplay.v1','{"quality":3,"timingOverlay":1}');same({...D.loadPrefs()},{...D.DEFAULT_PREFS,quality:'high',timingOverlay:1},'wire integers are also accepted in storage');
  install(()=>({getItem(){throw new Error('quota');},setItem(){throw new DOMException('full','QuotaExceededError');}}));
  same(D.loadPrefs(),D.DEFAULT_PREFS,'getItem throws');assert.doesNotThrow(()=>D.savePrefs(prefs),'setItem throws');
  install(()=>({getItem:()=>undefined,setItem(){}}));same(D.loadPrefs(),D.DEFAULT_PREFS,'getItem returns undefined');
  // every combination survives save -> load
  install(()=>store);
  for(const quality of D.QUALITY_NAMES)for(const showFps of [0,1,2]){const p={...D.DEFAULT_PREFS,quality,showFps};D.savePrefs(p);same({...D.loadPrefs()},p);}
 }finally{restore();}
}

// ================================================================ render-sizer.ts
{
 const text=readFileSync('src/render-sizer.ts','utf8');
 const imports=[...text.matchAll(/^import\s(?:type\s)?[^;]*from\s+'([^']+)'/gm)].map(m=>m[1]).sort();
 same(imports,['./avs-presentation.ts','./mpc-display.ts','./render-resolution.ts'],'render-sizer.ts imports');
 for(const banned of ['Date.now','Math.random','performance.now','setTimeout','requestAnimationFrame','document.','window.','localStorage'])ok(!text.includes(banned),`the sizer's time and state come from the injected host, not ${banned}`);
 same(S.AVS_SETTLE_MS,250);same(S.VECTOR_SETTLE_MS,120);same(Object.keys(S).sort(),['AVS_SETTLE_MS','RenderSizer','SurfacePresenter','VECTOR_SETTLE_MS','sizeCanvas','watchDeviceBox'],'public surface: add new exports to this pin');
 ok(!text.includes('OffscreenCanvas')&&!text.includes('createElement'),'the presenter creates no surface itself: the host injects the scratch factory');
 ok((text.match(/\bResizeObserver\b/g)??[]).length>0&&!/\bnew ResizeObserver\b/.test(text),'ResizeObserver is only reached through the feature-detected constructor');
}
function rig(css={width:1920,height:1080},dpr=1,prefs){
 const host={css:{...css},dpr,now:0};
 const sizer=new S.RenderSizer({cssSize:()=>host.css,dpr:()=>host.dpr,now:()=>host.now},prefs);
 return {host,sizer,at(t){host.now=t;},size(w,h){host.css={width:w,height:h};}};
}
const dims=r=>[r.render.width,r.render.height];
const raw=(kind,w,h,d,extra={})=>R.resolveRender({kind,cssWidth:w,cssHeight:h,dpr:d,tier:'auto',...extra});

// ---- defaults and equivalence with the pure policy
{
 const {sizer}=rig();
 same({...sizer.prefs},{...D.DEFAULT_PREFS});
 same(sizer.resolve('nerv').key,raw('nerv',1920,1080,1).key,'the sizer at defaults is the pure policy');
 same(sizer.resolve('avs').key,raw('avs',1920,1080,1).key);same(dims(sizer.resolve('avs')),[640,360],'AVS classic at 1080p');
 const {sizer:custom}=rig({width:1280,height:720},1,{...D.DEFAULT_PREFS,quality:'performance',avsResolution:'crisp',pixelArt:'integer'});
 same(custom.prefs.quality,'performance');
 same(dims(custom.resolve('nerv')),[1280,720]);same(custom.resolve('avs').integerScale,2,'constructor preferences apply');
 const {sizer:garbage}=rig({width:800,height:600},1,{quality:'nope',showFps:9});same({...garbage.prefs},{...D.DEFAULT_PREFS},'constructor sanitises preferences');
}

// ---- debounce: vector 120 ms, AVS 250 ms, on the injected clock
for(const [kind,settle] of [['nerv',120],['hud',120],['avs',250]]){
 const r=rig({width:1920,height:1080}),first=r.sizer.resolve(kind);
 r.at(1000);same(r.sizer.resolve(kind).key,first.key,`${kind}: a live surface resolved again at the same size`);r.size(1280,720);
 const held=r.sizer.resolve(kind);same(held.key,first.key,`${kind}: a size change is held at first`);
 r.at(1000+settle-1);same(r.sizer.resolve(kind).key,first.key,`${kind}: still held ${settle-1} ms later`);
 r.at(1000+settle);const adopted=r.sizer.resolve(kind);
 same(adopted.key,raw(kind,1280,720,1).key,`${kind}: adopted at ${settle} ms`);
 ok(adopted.key!==first.key,'the adopted size differs');
 // the adopted value stays until something changes again
 r.at(5000);same(r.sizer.resolve(kind).key,adopted.key);
 // a change that keeps moving keeps waiting: the timer restarts on each new size
 const j=rig({width:1920,height:1080}),start=j.sizer.resolve(kind);
 j.at(0);j.size(1000,600);j.sizer.resolve(kind);
 j.at(settle-10);j.size(1001,600);same(j.sizer.resolve(kind).key,start.key,`${kind}: a further change restarts the wait`);
 j.at(settle+100);same(j.sizer.resolve(kind).key,start.key,`${kind}: still held ${100+10} ms after the restart`);
 j.at(settle-10+settle);same(j.sizer.resolve(kind).key,raw(kind,1001,600,1).key,`${kind}: adopted once stable for ${settle} ms`);
 // returning to the committed size cancels the pending change
 const c=rig({width:1920,height:1080}),base=c.sizer.resolve(kind);
 c.at(0);c.size(1000,600);c.sizer.resolve(kind);c.at(50);c.size(1920,1080);same(c.sizer.resolve(kind).key,base.key);
 c.at(60);c.size(1000,600);c.sizer.resolve(kind);c.at(60+settle-1);same(c.sizer.resolve(kind).key,base.key,`${kind}: the wait restarted from the second change`);
 c.at(60+settle);same(c.sizer.resolve(kind).key,raw(kind,1000,600,1).key);
}
// A scene nobody resolved for its whole settle time protects no live surface: its next resolve is the current size at once, not a size
// remembered from before (an AVS preset preloaded while a NERV scene plays; a backgrounded tab).
for(const [kind,settle] of [['nerv',120],['hud',120],['avs',250]]){
 const r=rig({width:1920,height:1080}),before=r.sizer.resolve(kind);
 r.at(settle-1);r.size(1280,720);same(r.sizer.resolve(kind).key,before.key,`${kind}: ${settle-1} ms of silence is still a live surface, so the change is held`);
 const idle=rig({width:1920,height:1080}),old=idle.sizer.resolve(kind);
 idle.at(settle);idle.size(1280,720);
 same(idle.sizer.resolve(kind).key,raw(kind,1280,720,1).key,`${kind}: after ${settle} ms unresolved the next resolve is the current size at once`);
 same(idle.sizer.resolve(kind).key,raw(kind,1280,720,1).key,`${kind}: and it stays`);
 ok(idle.sizer.resolve(kind).key!==old.key);
 // once it is being resolved again it is a live surface and debounces as usual
 idle.at(settle+10);idle.size(1000,600);same(idle.sizer.resolve(kind).key,raw(kind,1280,720,1).key,`${kind}: a change right after a resolve is held`);
 idle.at(settle+10+settle);same(idle.sizer.resolve(kind).key,raw(kind,1000,600,1).key,`${kind}: and adopted after the wait`);
 // a long gap that ends at an unchanged view changes nothing; a pending change that outlives the gap is adopted, never resurrected stale
 const same_=rig({width:1920,height:1080}),k0=same_.sizer.resolve(kind);same_.at(100000);same(same_.sizer.resolve(kind).key,k0.key,`${kind}: an idle gap at an unchanged view returns the same surface`);
 // a clock that runs backwards (a host clock reset) never counts as idle
 const back=rig({width:1920,height:1080}),b0=back.sizer.resolve(kind);back.at(-5000);back.size(1280,720);same(back.sizer.resolve(kind).key,b0.key,`${kind}: a backwards clock is not idle`);
}
{ // the AVS preload case end to end: an AVS scene resolved live, NERV takes over for seconds while the view changes, then an AVS preset loads
 const r=rig({width:1920,height:1080});
 same(dims(r.sizer.resolve('avs')),[640,360]);
 for(let t=16;t<=3000;t+=16){r.at(t);r.sizer.resolve('nerv');}
 r.size(1000,500);r.at(3016);
 same(dims(r.sizer.resolve('nerv')),[1920,1080],'the live NERV scene is held for its own wait, as always');
 same(dims(r.sizer.resolve('avs')),[640,320],'the AVS load carries the classic size of the current view, not the one from seconds ago');
 r.at(3100);r.size(1000,600);same(dims(r.sizer.resolve('avs')),[640,320],'and from then on the AVS surface is live and debounced');
 r.at(3100+250);same(dims(r.sizer.resolve('avs')),[640,384]);
}
// AVS: the first resolve is the settled size, so the `load` message and every later `render` agree while the window is dragged (the 640x360 warm-up fix)
{
 const r=rig({width:1000,height:1000}),loadSize=dims(r.sizer.resolve('avs'));
 same(loadSize,[640,640],'the load message would carry the classic 640x640 of a square view');
 for(let t=0;t<200;t+=20){r.at(t);r.size(1000,1000-t);same(dims(r.sizer.resolve('avs')),loadSize,'no size change reaches the worker during the drag');}
 r.at(180+249);same(dims(r.sizer.resolve('avs')),loadSize,'the last change was at t=180: still held 249 ms later');
 r.at(180+250);same(dims(r.sizer.resolve('avs')),[640,Math.round(640*820/1000)],'after the drag settles the worker receives exactly one new size');
}
// the canvas is debounced with the render size: the presenter stretches the previous frame in the meantime
{
 const r=rig({width:1920,height:1080}),a=r.sizer.resolve('avs');r.at(10);r.size(1280,720);const b=r.sizer.resolve('avs');
 same({...b.canvas},{...a.canvas});same({...b.box},{...a.box},'canvas and box are held with the render size');
}

// ---- immediate commits: preferences, tiers, traits, kinds
{
 const r=rig({width:3840/1.5,height:2160/1.5},1.5);
 same(dims(r.sizer.resolve('nerv')),[2560,1440],'Auto = High');
 r.at(1);r.sizer.setPrefs({...r.sizer.prefs,quality:'performance'});same(dims(r.sizer.resolve('nerv')),[1280,720],'a quality change is immediate');
 r.sizer.setPrefs({...r.sizer.prefs,quality:'native'});same(dims(r.sizer.resolve('nerv')),[3840,2160]);
 r.sizer.setPrefs({...r.sizer.prefs,quality:'auto'});same(dims(r.sizer.resolve('nerv')),[2560,1440]);
 const pre=r.sizer.resolve('avs');r.sizer.setPrefs({...r.sizer.prefs,avsResolution:'crisp'});
 const crisp=r.sizer.resolve('avs');same(crisp.integerScale,6,'an AVS resolution change is immediate');ok(crisp.key!==pre.key);
 r.sizer.setPrefs({...r.sizer.prefs,avsResolution:'high'});same(dims(r.sizer.resolve('avs')),[1280,720]);
 r.sizer.setPrefs({...r.sizer.prefs,showFps:2,timingOverlay:1});same(r.sizer.prefs.showFps,2,'overlay preferences are stored without touching the surfaces');
 // sanitised
 r.sizer.setPrefs({quality:'bogus',avsResolution:'x',pixelArt:5,showFps:7,timingOverlay:-1});same({...r.sizer.prefs},{...D.DEFAULT_PREFS,avsResolution:'high',showFps:2,timingOverlay:1,quality:'auto'},'invalid values keep the current preference');
}
{ // traits: a different scene commits at once, and two scenes debounce independently while both are resolved every frame
 const r=rig({width:1920,height:1080}),grid=(w,h)=>({pixelGrid:{width:w,height:h}});
 const a=r.sizer.resolve('hud',grid(320,180)),b=r.sizer.resolve('hud',grid(256,224)),v=r.sizer.resolve('hud');
 same([a.smoothing,b.smoothing,v.smoothing],['nearest','sharp-bilinear','bilinear'],'three scenes, three surfaces');
 ok(new Set([a.key,b.key,v.key]).size===3);
 r.at(0);r.size(1280,720);
 for(let t=0;t<120;t+=20){r.at(t);same(r.sizer.resolve('hud',grid(320,180)).key,a.key,'scene A held');same(r.sizer.resolve('hud',grid(256,224)).key,b.key,'scene B held');same(r.sizer.resolve('hud').key,v.key,'vector scene held');}
 r.at(120);same(r.sizer.resolve('hud',grid(320,180)).key,raw('hud',1280,720,1,{traits:grid(320,180)}).key,'each scene adopts after its own wait');
 same(r.sizer.resolve('hud',grid(256,224)).key,raw('hud',1280,720,1,{traits:grid(256,224)}).key);
 const logical=r.sizer.resolve('hud',{logical:{width:640,height:360}});near(logical.metrics.scale,2,1e-12);
 function near(x,y,e){ok(Math.abs(x-y)<=e,`${x} vs ${y}`);}
}

// ---- no layout: never commit nothing, never replace a committed size with nothing
{
 const r=rig({width:0,height:0});
 const hidden=r.sizer.resolve('nerv');same(dims(hidden),[64,64],'a view with no size resolves to the minimum');
 r.at(1);r.size(1920,1080);same(dims(r.sizer.resolve('nerv')),[1920,1080],'the first real size is adopted at once (the zero size was not committed)');
 r.at(2);r.size(0,0);same(dims(r.sizer.resolve('nerv')),[1920,1080],'a minimised view keeps the committed surfaces');
 r.at(3);r.size(800,0);same(dims(r.sizer.resolve('nerv')),[1920,1080]);
 r.at(4);r.size(1920,1080);r.at(5);same(dims(r.sizer.resolve('nerv')),[1920,1080],'and restoring the same size changes nothing');
 r.at(6);r.size(NaN,-5);assert.doesNotThrow(()=>r.sizer.resolve('avs'));
}

// ---- observed device box
{
 const r=rig({width:1000,height:600},1.5);
 same(dims(r.sizer.resolve('nerv')),[1500,900],'no observation: css * dpr');
 const q=rig({width:1000,height:600},1.5);q.sizer.observeDevice(1499,899);
 same(dims(q.sizer.resolve('nerv')),[1499,899],'the observed device box wins on a fractional DPR');
 const stale=rig({width:1000,height:600},1.5);stale.sizer.observeDevice(5000,3000);
 same(dims(stale.sizer.resolve('nerv')),[1500,900],'a device box 3x off is stale and ignored');
 const half=rig({width:1000,height:600},1.5);half.sizer.observeDevice(1500*0.4,900);same(dims(half.sizer.resolve('nerv')),[1500,900]);
 for(const bad of [[0,0],[NaN,5],[5,NaN],[-1,-1],[Infinity,1],[undefined,undefined]]){const b=rig({width:1000,height:600},1.5);b.sizer.observeDevice(1499,899);b.sizer.observeDevice(...bad);same(dims(b.sizer.resolve('nerv')),[1500,900],`observeDevice(${bad}) clears the observation`);}
 // classic AVS ignores it (the shipped rule); crisp uses it
 const avs=rig({width:1000,height:600},1.5);avs.sizer.observeDevice(1499,899);
 same(avs.sizer.resolve('avs').key,raw('avs',1000,600,1.5).key,'classic AVS ignores the device box');
 avs.sizer.setPrefs({...avs.sizer.prefs,avsResolution:'crisp'});
 same(avs.sizer.resolve('avs').key,R.resolveRender({kind:'avs',cssWidth:1000,cssHeight:600,dpr:1.5,deviceWidth:1499,deviceHeight:899,tier:'auto',avs:{mode:'crisp'}}).key,'crisp uses the device box');
 // an observation changes the surface like any size change: debounced
 const d=rig({width:1000,height:600},1.5),before=d.sizer.resolve('nerv');d.at(10);d.sizer.observeDevice(1400,840);
 same(d.sizer.resolve('nerv').key,before.key);d.at(130);same(dims(d.sizer.resolve('nerv')),[1400,840]);
 // hidden view: an observation without css is not trusted
 const h=rig({width:0,height:0},1);h.sizer.observeDevice(800,600);assert.doesNotThrow(()=>h.sizer.resolve('nerv'));
}

// ---- Auto governor through the sizer
{
 const r=rig({width:3840/1.5,height:2160/1.5},1.5);
 same(dims(r.sizer.resolve('nerv')),[2560,1440]);
 let changed=0,t=0;const heavy=()=>{t+=16.7;r.at(t);return r.sizer.recordFrame('nerv',30);};
 for(let k=0;k<41;k++)ok(!heavy(),'warm-up and confirmation samples do not change the tier');
 ok(heavy(),'the 42nd overloaded frame steps the tier down');changed++;
 same(dims(r.sizer.resolve('nerv')),[1920,1080],'the next resolve is the Balanced surface at once (not debounced)');
 same(r.sizer.resolve('nerv').tier,'balanced');
 // the governor does not run for fixed tiers, AVS or pixel-art scenes
 const f=rig({width:1920,height:1080},1,{...D.DEFAULT_PREFS,quality:'high'});f.sizer.resolve('nerv');
 for(let k=0;k<500;k++){f.at(k*17);ok(!f.sizer.recordFrame('nerv',50),'fixed tier: never changes');}
 same(f.sizer.resolve('nerv').tier,'high');
 const a=rig({width:1920,height:1080});a.sizer.resolve('avs');for(let k=0;k<500;k++){a.at(k*17);ok(!a.sizer.recordFrame('avs',500),'AVS classic: no change');}
 same(dims(a.sizer.resolve('avs')),[640,360]);
 const px=rig({width:1920,height:1080}),grid={pixelGrid:{width:320,height:180}};px.sizer.resolve('hud',grid);
 for(let k=0;k<500;k++){px.at(k*17);ok(!px.sizer.recordFrame('hud',50),'a pixel-art scene has no tier to change');}
 px.sizer.resolve('hud');    // vector HUD resolved afterwards: the governor is live again for the kind
 let stepped=false;for(let k=0;k<500&&!stepped;k++){px.at(10000+k*17);stepped=px.sizer.recordFrame('hud',50);}ok(stepped,'a vector HUD scene feeds the governor');
 // changing the quality preference restarts Auto at High; switching back to auto from a fixed tier too
 const s=rig({width:3840,height:2160},1);s.sizer.resolve('nerv');t=0;for(let k=0;k<60;k++){t+=16.7;s.at(t);s.sizer.recordFrame('nerv',40);}
 same(s.sizer.resolve('nerv').tier,'balanced');s.sizer.setPrefs({...s.sizer.prefs,quality:'native'});s.sizer.setPrefs({...s.sizer.prefs,quality:'auto'});
 same(s.sizer.resolve('nerv').tier,'high','a fresh Auto starts at High again');
 // Auto never reaches Native however the governor is driven
 const n=rig({width:3840,height:2160},1);n.sizer.resolve('nerv');t=0;for(let k=0;k<200000;k++){t+=16.7;n.at(t);n.sizer.recordFrame('nerv',1);}
 same(n.sizer.resolve('nerv').tier,'high');ok(n.sizer.resolve('nerv').render.width<=2560);
}
// AVS `high`: the Studio governor steps the raster scale down, once per dwell, and never back up
{
 const r=rig({width:1920,height:1080},1,{...D.DEFAULT_PREFS,avsResolution:'high'});
 same(dims(r.sizer.resolve('avs')),[1280,720],'high starts at 2x the classic raster');
 let t=0;const feed=(ms)=>{t+=16.7;r.at(t);return r.sizer.recordFrame('avs',ms);};
 for(let k=0;k<3;k++)ok(!feed(80),'the first samples are warm-up');
 ok(feed(80),'a very slow frame steps 2x -> 1.5x at once');
 same(dims(r.sizer.resolve('avs')),[960,540],'the next resolve uses 1.5x and commits immediately');
 ok(!feed(80),'the 2 s dwell blocks an immediate second step');
 t+=2100;let second=0;for(let k=1;k<=8&&!second;k++)if(feed(80))second=k;ok(second>=1&&second<=4,`after the 2 s dwell and the remaining warm-up samples it steps again (1.5x -> 1x); sample ${second}`);
 same(dims(r.sizer.resolve('avs')),[640,360]);
 for(let k=0;k<50;k++){t+=2100;ok(!feed(80),'and there is nothing below classic');}
 same(dims(r.sizer.resolve('avs')),[640,360],'it bottoms out at the classic raster');
 for(let k=0;k<5000;k++){t+=2100;ok(!feed(1),'and never steps back up');}
 same(dims(r.sizer.resolve('avs')),[640,360]);
 r.sizer.setPrefs({...r.sizer.prefs,avsResolution:'classic'});ok(!feed(500),'classic never changes');
 r.sizer.setPrefs({...r.sizer.prefs,avsResolution:'high'});same(dims(r.sizer.resolve('avs')),[1280,720],'re-selecting high restarts at 2x');
}

// ---- reset
{
 const r=rig({width:1920,height:1080});r.sizer.resolve('nerv');r.sizer.observeDevice(1900,1000);
 r.at(1);r.size(1280,720);r.sizer.reset();same(dims(r.sizer.resolve('nerv')),[1280,720],'reset forgets committed sizes and the device box');
 r.sizer.setPrefs({...r.sizer.prefs,quality:'balanced'});r.sizer.reset();same(r.sizer.prefs.quality,'balanced','reset keeps preferences');
}

// ---- determinism and bounded memory
{
 const script=(sizer,at,size)=>{const out=[];for(let i=0;i<400;i++){at(i*37);if(i%9===0)size(800+((i*131)%1200),500+((i*71)%600));if(i===150)sizer.setPrefs({...sizer.prefs,quality:'balanced'});if(i%13===0)sizer.recordFrame(i%2?'nerv':'avs',(i*7)%40);out.push(sizer.resolve(i%3?'nerv':'avs').key);}return out;};
 const a=rig(),b=rig();same(script(a.sizer,a.at,a.size),script(b.sizer,b.at,b.size),'two sizers on the same clock and view agree exactly');
 const many=rig();
 for(let i=0;i<500;i++)many.sizer.resolve('hud',{pixelGrid:{width:100+i,height:100}});
 ok(many.sizer.entries.size<=64,`entries stay bounded (${many.sizer.entries.size})`);
 same(dims(many.sizer.resolve('hud',{pixelGrid:{width:600,height:100}})).length,2);
 // garbage from the host never throws
 const g=rig();for(const css of [{width:NaN,height:NaN},{width:-1,height:5},{width:Infinity,height:1e9},{width:1e300,height:1e300},{width:0.4,height:0.4}])for(const dpr of [NaN,0,-1,Infinity,1e9,0.001]){g.host.css=css;g.host.dpr=dpr;g.at(g.host.now+1000);for(const kind of ['nerv','hud','avs']){const r=g.sizer.resolve(kind);ok(Number.isFinite(r.render.width)&&Number.isFinite(r.canvas.height),'finite');}}
 assert.doesNotThrow(()=>g.sizer.recordFrame('nerv',NaN));assert.doesNotThrow(()=>g.sizer.recordFrame('bogus',5));
}
// ================================================================ host glue: watchDeviceBox, sizeCanvas, SurfacePresenter
// ---- watchDeviceBox: feature detected, guarded, fed by the device-pixel content box
{
 const calls=[];
 const sink={observeDevice:(w,h)=>calls.push([w,h])};
 class FakeObserver{constructor(cb){FakeObserver.instances.push(this);this.cb=cb;this.observed=[];this.disconnected=0;}observe(target,options){this.observed.push([target,options]);}disconnect(){this.disconnected++;}}
 FakeObserver.instances=[];
 const target={id:'canvas'};
 // no ResizeObserver anywhere: null, nothing thrown
 const had=Object.getOwnPropertyDescriptor(globalThis,'ResizeObserver');
 try{
  delete globalThis.ResizeObserver;
  same(S.watchDeviceBox(target,sink),null,'no ResizeObserver: null (the sizer keeps css * dpr)');
  same(S.watchDeviceBox(target,sink,undefined),null);
  // the global is picked up when present
  globalThis.ResizeObserver=FakeObserver;
  const stop=S.watchDeviceBox(target,sink);ok(typeof stop==='function','the global ResizeObserver is used when no constructor is injected');
  same(FakeObserver.instances.at(-1).observed,[[target,{box:'device-pixel-content-box'}]],'observes the canvas with the device-pixel content box');
  stop();same(FakeObserver.instances.at(-1).disconnected,1,'the returned function disconnects');
 }finally{delete globalThis.ResizeObserver;if(had)Object.defineProperty(globalThis,'ResizeObserver',had);}
 // callback shapes: array box, bare box, missing box, several entries, garbage
 FakeObserver.instances.length=0;const stop=S.watchDeviceBox(target,sink,FakeObserver),obs=FakeObserver.instances.at(-1);
 obs.cb([{devicePixelContentBoxSize:[{inlineSize:1499,blockSize:899}]}]);same(calls.at(-1),[1499,899],'array form (the standard shape)');
 obs.cb([{devicePixelContentBoxSize:{inlineSize:1000,blockSize:600}}]);same(calls.at(-1),[1000,600],'bare object form (older Chromium)');
 obs.cb([{devicePixelContentBoxSize:[{inlineSize:1,blockSize:1}]},{devicePixelContentBoxSize:[{inlineSize:1280,blockSize:720}]}]);same(calls.at(-1),[1280,720],'the last entry wins');
 obs.cb([{}]);same(calls.at(-1),[0,0],'an entry without the device box clears the observation');
 obs.cb([{devicePixelContentBoxSize:[]}]);same(calls.at(-1),[0,0],'an empty box list clears it too');
 assert.doesNotThrow(()=>obs.cb([]));assert.doesNotThrow(()=>obs.cb([undefined]));same(calls.at(-1),[0,0]);
 stop();stop();same(obs.disconnected,2,'disconnect may be called twice without harm');
 // failures: the constructor throws, observe throws (unsupported box), disconnect throws
 class Throws{constructor(){throw new Error('unsupported');}}
 same(S.watchDeviceBox(target,sink,Throws),null,'a throwing constructor gives null');
 class BadBox{observe(){throw new TypeError('The provided value is not a valid enum value of type ResizeObserverBoxOptions');}disconnect(){}}
 same(S.watchDeviceBox(target,sink,BadBox),null,'a browser that rejects the device-pixel box gives null');
 class BadStop{observe(){}disconnect(){throw new Error('gone');}}
 const bad=S.watchDeviceBox(target,sink,BadStop);assert.doesNotThrow(()=>bad());
 // end to end with a real sizer: the observation moves a NERV surface on a fractional DPR after the wait
 const r=rig({width:1000,height:600},1.5);FakeObserver.instances.length=0;
 const live=S.watchDeviceBox(target,r.sizer,FakeObserver),o2=FakeObserver.instances.at(-1);
 const before=r.sizer.resolve('nerv');same(dims(before),[1500,900]);
 o2.cb([{devicePixelContentBoxSize:[{inlineSize:1499,blockSize:899}]}]);r.at(50);same(r.sizer.resolve('nerv').key,before.key,'held during the wait');
 r.at(50+119);same(r.sizer.resolve('nerv').key,before.key);r.at(50+120);same(dims(r.sizer.resolve('nerv')),[1499,899],'adopted 120 ms after the first differing resolve');
 o2.cb([{}]);r.at(1000);r.sizer.resolve('nerv');r.at(1120);same(dims(r.sizer.resolve('nerv')),[1500,900],'clearing the observation returns to css * dpr');
 live();
}
// ---- sizeCanvas
{
 const nerv=R.resolveRender({kind:'nerv',cssWidth:1920,cssHeight:1080,dpr:1,tier:'auto'}),avs=raw('avs',1920,1080,1);
 const styled=()=>{const writes=[];let v='pixelated';return {width:640,height:360,style:{get imageRendering(){return v;},set imageRendering(x){writes.push(x);v=x;}},writes};};
 const c=styled();
 ok(S.sizeCanvas(c,nerv)===true&&c.width===1920&&c.height===1080,'a different backing size is applied and reported');
 same(c.writes,['auto'],'the inline image-rendering is written when it differs');
 ok(S.sizeCanvas(c,nerv)===false&&c.writes.length===1,'nothing changes and nothing is rewritten the second time');
 ok(S.sizeCanvas(c,avs)===false,'the AVS classic canvas at 1080p has the same size: only the style changes');
 same([c.width,c.height,c.style.imageRendering],[avs.canvas.width,avs.canvas.height,'pixelated'],'AVS classic: its canvas and pixelated');
 same(c.writes,['auto','pixelated']);
 // no style at all (fixtures, old embeddings), a frozen style, and a size-only change
 const bare={width:1,height:1};ok(S.sizeCanvas(bare,nerv)&&bare.width===1920,'a canvas without style is fine');
 const flat={width:1920,height:1080,style:{imageRendering:'auto'}};ok(S.sizeCanvas(flat,nerv)===false&&flat.style.imageRendering==='auto');
 const tall=R.resolveRender({kind:'nerv',cssWidth:900,cssHeight:1200,dpr:1,tier:'auto'});ok(S.sizeCanvas(flat,tall)===true&&flat.width===900&&flat.height===1200);
 // the resolved size is what the canvas gets, for every kind and tier (no clamping in the glue)
 for(const kind of ['nerv','hud','avs'])for(const q of ['auto','performance','balanced','high','native']){const res=R.resolveRender({kind,cssWidth:2048,cssHeight:1152,dpr:1.25,tier:q}),cv={width:0,height:0};S.sizeCanvas(cv,res);same([cv.width,cv.height],[res.canvas.width,res.canvas.height],`${kind} ${q}`);}
}
// ---- SurfacePresenter
{
 function fakeContext(){
  const log=[],c={log};
  for(const [key,initial] of [['imageSmoothingEnabled',true],['imageSmoothingQuality','low'],['fillStyle','#fff']]){let v=initial;Object.defineProperty(c,key,{get:()=>v,set:x=>{v=x;log.push([key,x]);}});}
  c.drawImage=(...a)=>log.push(['drawImage',...a]);c.fillRect=(...a)=>log.push(['fillRect',...a]);return c;
 }
 const scratches=[];
 const factory=(w,h)=>{const ctx=fakeContext(),s={width:w,height:h,getContext:kind=>{s.kinds.push(kind);return ctx;},kinds:[],ctx};scratches.push(s);return s;};
 const src={tag:'bitmap'};
 const presenter=new S.SurfacePresenter(factory);
 // AVS classic: nearest, full box, no bars
 {const r=raw('avs',1280,720,1),ctx=fakeContext();presenter.draw(ctx,src,{width:640,height:360},r);
  same(ctx.log,[['imageSmoothingEnabled',false],['drawImage',src,0,0,1280,720]],'AVS classic: nearest, drawn over the whole canvas, no bar clear');}
 // NERV: smooth, 'high' quality, full box
 {const r=R.resolveRender({kind:'nerv',cssWidth:1920,cssHeight:1080,dpr:1,tier:'auto'}),ctx=fakeContext();presenter.draw(ctx,src,{width:1920,height:1080},r);
  same(ctx.log,[['imageSmoothingEnabled',true],['imageSmoothingQuality','high'],['drawImage',src,0,0,1920,1080]],'NERV: bilinear at high quality straight from the source');}
 // a stale-sized source (worker frame from before a resize) is stretched into the box, never cropped
 {const r=R.resolveRender({kind:'nerv',cssWidth:1920,cssHeight:1080,dpr:1,tier:'auto'}),ctx=fakeContext();presenter.draw(ctx,src,{width:640,height:360},r);
  same(ctx.log.at(-1),['drawImage',src,0,0,1920,1080],'the box is the destination whatever the source size');}
 // pixel-art integer with bars: black bars first, then nearest into the centred box
 {const r=R.resolveRender({kind:'hud',cssWidth:1920,cssHeight:900,dpr:1,tier:'auto',traits:{pixelGrid:{width:320,height:180}}}),ctx=fakeContext();presenter.draw(ctx,src,{width:320,height:180},r);
  same([r.smoothing,r.integerScale,r.box.x,r.box.y,r.box.width,r.box.height],['nearest',5,160,0,1600,900]);
  same(ctx.log,[['fillStyle','#000'],['fillRect',0,0,1920,900],['imageSmoothingEnabled',false],['drawImage',src,160,0,1600,900]],'pixel art: bars, nearest, centred integer box');}
 // AVS crisp overscans the canvas (negative offsets): covered, no clear
 {const r=R.resolveRender({kind:'avs',cssWidth:1366,cssHeight:768,dpr:1,tier:'auto',avs:{mode:'crisp'}}),ctx=fakeContext();presenter.draw(ctx,src,r.render,r);
  ok(r.box.x<=0&&r.box.y<=0&&!ctx.log.some(e=>e[0]==='fillRect'),'a covering (overscanning) box needs no bar clear');
  same(ctx.log.at(-1),['drawImage',src,r.box.x,r.box.y,r.box.width,r.box.height]);}
 // sharp-bilinear: nearest prescale into a reused scratch, then a smooth draw of the scratch
 {scratches.length=0;const p=new S.SurfacePresenter(factory),r=R.resolveRender({kind:'hud',cssWidth:1920,cssHeight:1080,dpr:1,tier:'auto',traits:{pixelGrid:{width:256,height:224}}}),ctx=fakeContext();
  same([r.smoothing,r.prescale],['sharp-bilinear',4]);
  p.draw(ctx,src,{width:256,height:224},r);
  same(scratches.length,1,'one scratch surface');same([scratches[0].width,scratches[0].height],[1024,896],'scratch = source * prescale');
  same(scratches[0].ctx.log,[['imageSmoothingEnabled',false],['drawImage',src,0,0,1024,896]],'nearest enlargement into the scratch');
  same(ctx.log.filter(e=>e[0]==='drawImage'),[['drawImage',scratches[0],r.box.x,r.box.y,r.box.width,r.box.height]],'the final draw samples the scratch into the box');
  same(ctx.log.filter(e=>e[0]==='imageSmoothingEnabled').at(-1),['imageSmoothingEnabled',true]);same(ctx.log.filter(e=>e[0]==='imageSmoothingQuality').at(-1),['imageSmoothingQuality','high']);
  const before=scratches[0].ctx.log.length;p.draw(fakeContext(),src,{width:256,height:224},r);
  same(scratches.length,1,'the scratch is reused across frames');same(scratches[0].kinds,['2d'],'and its context is fetched once');ok(scratches[0].ctx.log.length>before,'but it is redrawn every frame');
  // a different source size only resizes the scratch
  p.draw(fakeContext(),src,{width:128,height:112},r);same(scratches.length,1);same([scratches[0].width,scratches[0].height],[512,448],'resized in place');
  // disposal recreates lazily
  p.dispose();p.draw(fakeContext(),src,{width:256,height:224},r);same(scratches.length,2,'dispose releases the scratch; the next draw makes a new one');}
 // scratch failures and limits fall back to a plain smooth draw of the source
 {const r=R.resolveRender({kind:'hud',cssWidth:1920,cssHeight:1080,dpr:1,tier:'auto',traits:{pixelGrid:{width:256,height:224}}});
  for(const [label,make] of [['factory returns null',()=>null],['no 2d context',(w,h)=>({width:w,height:h,getContext:()=>null})],['factory throws is not swallowed by the presenter',null]]){
   if(!make)continue;const p=new S.SurfacePresenter(make),ctx=fakeContext();assert.doesNotThrow(()=>p.draw(ctx,src,{width:256,height:224},r),label);
   same(ctx.log.filter(e=>e[0]==='drawImage'),[['drawImage',src,r.box.x,r.box.y,r.box.width,r.box.height]],`${label}: the source is drawn directly`);}
  const huge=new S.SurfacePresenter(factory),ctx=fakeContext();scratches.length=0;huge.draw(ctx,src,{width:20000,height:20000},r);same(scratches.length,0,'an absurd prescale is refused, not allocated');
  for(const size of [{width:NaN,height:NaN},{width:0,height:0},{width:-5,height:10},{width:Infinity,height:1}]){scratches.length=0;const p=new S.SurfacePresenter(factory),c=fakeContext();assert.doesNotThrow(()=>p.draw(c,src,size,r));same(scratches.length,0,`bad source size ${JSON.stringify(size)} skips the prescale`);}}
 // smooth mode of a pixel-art scene below its grid size is a plain bilinear shrink
 {const r=R.resolveRender({kind:'hud',cssWidth:200,cssHeight:100,dpr:1,tier:'auto',traits:{pixelGrid:{width:320,height:180}}}),ctx=fakeContext();new S.SurfacePresenter(factory).draw(ctx,src,{width:320,height:180},r);
  same([r.smoothing,r.prescale],['bilinear',1]);same(ctx.log.filter(e=>e[0]==='imageSmoothingEnabled').at(-1),['imageSmoothingEnabled',true]);ok(ctx.log.some(e=>e[0]==='fillRect'),'the aspect-preserving shrink leaves bars');}
 // every resolved render draws exactly one final image and only into its canvas
 {const p=new S.SurfacePresenter(factory);let n=0;
  for(const kind of ['nerv','hud','avs'])for(const [w,h,d] of [[480,480,1],[1280,720,1],[1920,900,1],[2048,1152,1.25],[2560,1440,1.5]])for(const grid of kind==='hud'?[undefined,{width:320,height:180},{width:256,height:224}]:[undefined])for(const q of ['auto','native'])for(const mode of kind==='avs'?['classic','crisp','high']:['classic']){
   const r=R.resolveRender({kind,cssWidth:w,cssHeight:h,dpr:d,tier:q,...(grid?{traits:{pixelGrid:grid}}:{}),avs:{mode}}),ctx=fakeContext();p.draw(ctx,src,r.render,r);
   const draws=ctx.log.filter(e=>e[0]==='drawImage');ok(draws.length===1,'one final draw');const [,,dx,dy,dw,dh]=draws[0];
   ok(dw===r.box.width&&dh===r.box.height&&dx===r.box.x&&dy===r.box.y,'into the box');
   if(kind!=='avs'||mode!=='crisp')ok(dx>=0&&dy>=0&&dx+dw<=r.canvas.width&&dy+dh<=r.canvas.height,'inside the canvas');n++;}
  same(n,70,"presenter sweep size");}
}
console.log(`Render sizer and display prefs: parse/merge/wire/storage (270 combinations, hostile input), localStorage wrappers, debounce 120/250 ms, immediate commits, device box, Auto and AVS-high governors, determinism, device-box observer, canvas sizing, surface presenter PASS (${assertions} assertions)`);
