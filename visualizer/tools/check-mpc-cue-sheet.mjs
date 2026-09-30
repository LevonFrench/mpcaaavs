import {build} from 'esbuild';
import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
async function load(path){const result=await build({entryPoints:[path],bundle:true,format:'esm',write:false});return import(`data:text/javascript;base64,${Buffer.from(result.outputFiles[0].text).toString('base64')}`);}
const C=await load('src/mpc-cue-sheet.ts');
const {exportCueSheet,importCueSheet,sceneCuesFromScript,bakeSessionCues,CUE_SHEET_FORMAT,CUE_SHEET_VERSION,CUE_SHEET_MAX_BYTES,CUE_NAME_MAX,CUE_NOTE_MAX}=C;
const {parseSceneTiming,defaultSceneTiming,scheduleSceneCue,compileSceneClock,MAX_SCENE_CUES,MAX_SCRIPT}=await load('src/mpc-scene-clock.ts');
const hash=n=>n.toString(16).padStart(64,'0');
const v1={enabled:true,bpm:128,offsetSeconds:.42,barsPerScene:8,seed:7};
const full={...v1,version:2,beatsPerBar:3,barsPattern:[4,4,8,16],patternHold:true,tempoMap:[{at:134.2,bpm:140},{at:300,bpm:90.5}],script:[{ordinal:0,preset:hash(1)},{ordinal:4,preset:hash(2)},{ordinal:9,preset:hash(3)}],intervals:[{id:'boss',startBeat:64,endBeat:192.5}]};
const fade={fadeTiming:6,fadeRandomSet:22,fadeAnchor:1,durationMs:1500};
const all=()=>0;
const refuses=(fn,pattern,message)=>assert.throws(fn,pattern,message);

assert.deepEqual([CUE_SHEET_FORMAT,CUE_SHEET_VERSION,CUE_SHEET_MAX_BYTES,CUE_NAME_MAX,CUE_NOTE_MAX],['aaavs-cue-sheet',1,262144,120,200]);

// ---- Export and import round trip ----
{
  const text=exportCueSheet({name:'Friday set',timing:full,fade,note:'Drop at bar 33'});
  assert.ok(text.startsWith('{"format":"aaavs-cue-sheet","version":1,'));
  const doc=JSON.parse(text);
  assert.deepEqual(Object.keys(doc),['format','version','name','timing','fade','note'],'documented key order');
  assert.deepEqual(doc.timing,parseSceneTiming(full));
  const back=importCueSheet(text,all);
  assert.deepEqual(back,{timing:parseSceneTiming(full),fade,name:'Friday set',note:'Drop at bar 33',dropped:0});
  assert.deepEqual(Object.keys(back.timing),Object.keys(parseSceneTiming(full)),'timing key order is the parser\'s');
  // A v1 timing stays five keys through a sheet; optional parts are omitted when absent or empty.
  const small=exportCueSheet({timing:v1});
  assert.deepEqual(Object.keys(JSON.parse(small)),['format','version','timing']);assert.equal(JSON.stringify(JSON.parse(small).timing),JSON.stringify(v1));
  assert.deepEqual(importCueSheet(small,all),{timing:v1,dropped:0});
  assert.deepEqual(Object.keys(JSON.parse(exportCueSheet({timing:v1,name:'',note:'   '}))),['format','version','timing'],'empty text is omitted');
  // Readable layout: one key per line.
  assert.equal(text.split('\n').length,5);assert.ok(!text.includes('\r'));
  // Export validates the timing exactly like a saved setup and states which field is wrong.
  refuses(()=>exportCueSheet({timing:{...v1,beatsPerBar:99}}),/beatsPerBar must be a whole number from 1 to 16/);
  refuses(()=>exportCueSheet({timing:{...v1,bpm:NaN}}),/Scene timing requires/);
  refuses(()=>exportCueSheet({timing:undefined}),/Nothing to export/);refuses(()=>exportCueSheet({timing:null}),/Invalid repeatable scene timing/);refuses(()=>exportCueSheet(null),/Nothing to export/);
  // The exported timing is the parsed copy: unknown keys never leak into a sheet.
  const leak=JSON.parse(exportCueSheet({timing:{...v1,secret:['C:','/Users/me/x.avs'].join(''),title:'Artist - Song'}}));assert.deepEqual(Object.keys(leak.timing),Object.keys(v1));
  // Round trips over many random valid timings.
  let seed=77;const rnd=()=>(seed=(Math.imul(seed,1664525)+1013904223)>>>0)/4294967296,pick=list=>list[Math.floor(rnd()*list.length)];
  for(let run=0;run<300;run++){
    const timing={enabled:rnd()<.5,bpm:20+Math.round(rnd()*38000)/100,offsetSeconds:Math.round((rnd()-.5)*7200*100)/100,barsPerScene:1+Math.floor(rnd()*128),seed:Math.floor(rnd()*4294967296)};
    if(rnd()<.6)timing.beatsPerBar=1+Math.floor(rnd()*16);
    if(rnd()<.6)timing.barsPattern=Array.from({length:1+Math.floor(rnd()*6)},()=>1+Math.floor(rnd()*128));
    if(rnd()<.4)timing.patternHold=true;
    if(rnd()<.5){let at=timing.offsetSeconds;timing.tempoMap=Array.from({length:1+Math.floor(rnd()*5)},()=>({at:at+=Math.round((1+rnd()*100)*1000)/1000,bpm:20+Math.round(rnd()*38000)/100}));}
    if(rnd()<.5){let ordinal=-1;timing.script=Array.from({length:Math.floor(rnd()*6)},()=>({ordinal:ordinal+=1+Math.floor(rnd()*5),preset:hash(Math.floor(rnd()*1e9))}));}
    if(rnd()<.4)timing.intervals=[{id:pick(['a','b_1','x-y']),startBeat:0,endBeat:1+rnd()*1000}];
    const input={timing,...(rnd()<.5?{fade}:{}),...(rnd()<.5?{name:'n'.repeat(1+Math.floor(rnd()*120))}:{}),...(rnd()<.5?{note:'x'.repeat(1+Math.floor(rnd()*200))}:{})};
    const back=importCueSheet(exportCueSheet(input),all);
    assert.deepEqual(back.timing,parseSceneTiming(timing));assert.deepEqual(back.fade,input.fade);assert.equal(back.name,input.name);assert.equal(back.note,input.note);assert.equal(back.dropped,0);
  }
}

// ---- Presets by hash: mapping and drop counts ----
{
  const text=exportCueSheet({timing:full});
  const known=new Map([[hash(1),11],[hash(3),13]]),seen=[];
  const result=importCueSheet(text,h=>{seen.push(h);return known.get(h);});
  assert.equal(result.dropped,1);assert.deepEqual(result.timing.script,[{ordinal:0,preset:hash(1)},{ordinal:9,preset:hash(3)}],'known presets keep their ordinals and order');
  assert.deepEqual(seen,[hash(1),hash(2),hash(3)],'resolve sees each script hash once, in order');
  assert.equal(result.timing.version,2);assert.deepEqual(result.timing.barsPattern,[4,4,8,16]);
  // Dropping every cue removes the script; with no other v2 field the version goes and the timing is exactly v1.
  const onlyScript={...v1,version:2,script:[{ordinal:1,preset:hash(5)}]};
  const bare=importCueSheet(exportCueSheet({timing:onlyScript}),()=>undefined);
  assert.equal(bare.dropped,1);assert.equal(JSON.stringify(bare.timing),JSON.stringify(v1),'a v1 timing again');
  const kept=importCueSheet(exportCueSheet({timing:{...onlyScript,beatsPerBar:5}}),()=>undefined);assert.equal(kept.timing.version,2);assert.equal('script' in kept.timing,false);assert.equal(kept.timing.beatsPerBar,5);
  // Indices that are not catalogue indices count as unknown.
  for(const bad of [-1,1.5,NaN,Infinity,'3',null,undefined,{},true])assert.equal(importCueSheet(exportCueSheet({timing:onlyScript}),()=>bad).dropped,1,`resolve gave ${String(bad)}`);
  assert.equal(importCueSheet(exportCueSheet({timing:onlyScript}),()=>0).dropped,0,'index 0 is a real preset');
  // No script, no resolve calls.
  let calls=0;importCueSheet(exportCueSheet({timing:v1}),()=>{calls++;return 1;});assert.equal(calls,0);
}

// ---- Size and count limits ----
{
  const base=JSON.parse(exportCueSheet({timing:v1}));
  const sized=bytes=>{const text=JSON.stringify({...base,pad:''});const pad=bytes-Buffer.byteLength(text);assert.ok(pad>=0);return JSON.stringify({...base,pad:'x'.repeat(pad)});};
  const atLimit=sized(CUE_SHEET_MAX_BYTES);assert.equal(Buffer.byteLength(atLimit),CUE_SHEET_MAX_BYTES);
  assert.deepEqual(importCueSheet(atLimit,all).timing,v1,'exactly 256 KiB is accepted, and the unknown key is dropped');
  refuses(()=>importCueSheet(sized(CUE_SHEET_MAX_BYTES+1),all),/limited to 256 KiB/);
  // Bytes, not characters: 90,000 three-byte characters are fewer than 262,144 characters but more than 262,144 bytes.
  const wide=JSON.stringify({...base,pad:'€'.repeat(90000)});assert.ok(wide.length<CUE_SHEET_MAX_BYTES&&Buffer.byteLength(wide)>CUE_SHEET_MAX_BYTES);refuses(()=>importCueSheet(wide,all),/limited to 256 KiB/);
  // Counts follow the setup rules.
  const withKey=(key,value)=>JSON.stringify({...base,timing:{...v1,version:2,[key]:value}});
  refuses(()=>importCueSheet(withKey('script',Array.from({length:MAX_SCRIPT+1},(_,i)=>({ordinal:i,preset:hash(i)}))),all),/script/);
  refuses(()=>importCueSheet(withKey('tempoMap',Array.from({length:257},(_,i)=>({at:1+i,bpm:100}))),all),/tempoMap/);
  refuses(()=>importCueSheet(withKey('intervals',Array.from({length:65},(_,i)=>({id:`i${i}`,startBeat:0,endBeat:1}))),all),/intervals/);
  refuses(()=>importCueSheet(withKey('barsPattern',Array.from({length:65},()=>4)),all),/barsPattern/);
  // The largest legal sheet fits.
  const biggest={...v1,version:2,barsPattern:Array.from({length:64},(_,i)=>i+1),beatsPerBar:7,patternHold:true,tempoMap:Array.from({length:256},(_,i)=>({at:1+i*3.123456,bpm:20+i})),
    script:Array.from({length:MAX_SCRIPT},(_,i)=>({ordinal:i*3,preset:hash(i+1)})),intervals:Array.from({length:64},(_,i)=>({id:`interval-${i}`.padEnd(20,'x'),startBeat:i,endBeat:1e7-i}))};
  const text=exportCueSheet({name:'n'.repeat(120),timing:biggest,fade,note:'x'.repeat(200)});
  assert.ok(Buffer.byteLength(text)<CUE_SHEET_MAX_BYTES,`largest sheet ${Buffer.byteLength(text)} bytes`);
  const back=importCueSheet(text,all);assert.equal(back.timing.script.length,1024);assert.equal(back.dropped,0);
}

// ---- Forbidden keys, non-finite numbers, malformed input ----
{
  const sheet=(mutate)=>{const doc=JSON.parse(exportCueSheet({timing:full,fade,name:'x',note:'y'}));mutate(doc);return JSON.stringify(doc);};
  const pollute='{"format":"aaavs-cue-sheet","version":1,"timing":{"enabled":true,"bpm":120,"offsetSeconds":0,"barsPerScene":8,"seed":1,%KEY%},"fade":null}';
  for(const key of ['"__proto__":{"polluted":true}','"constructor":{"prototype":{"polluted":true}}']){
    refuses(()=>importCueSheet(pollute.replace('%KEY%',key),all),/forbidden key/,key);
    assert.equal({}.polluted,undefined);assert.equal(Object.prototype.polluted,undefined);
  }
  refuses(()=>importCueSheet('{"__proto__":{"x":1},"format":"aaavs-cue-sheet","version":1,"timing":{"enabled":true,"bpm":120,"offsetSeconds":0,"barsPerScene":8,"seed":1}}',all),/forbidden key/,'top level');
  refuses(()=>importCueSheet(sheet(d=>{d.fade.constructor=1;}),all),/forbidden key/,'inside fade');
  refuses(()=>importCueSheet(sheet(d=>{d.timing.tempoMap[0].constructor=1;}),all),/forbidden key/,'inside a tempo change');
  refuses(()=>importCueSheet(sheet(()=>{}).replace('{"ordinal":0,','{"__proto__":{"a":1},"ordinal":0,'),all),/forbidden key/,'inside a cue');
  refuses(()=>importCueSheet(sheet(d=>{d.timing.intervals[0].id='x';d.list=[{constructor:1}];}),all),/forbidden key/,'inside an unknown array');
  // The words are fine as values.
  assert.equal(importCueSheet(sheet(d=>{d.name='constructor __proto__';}),all).name,'constructor __proto__');
  // Non-finite numbers are refused by the timing rules; NaN and Infinity literals are not JSON.
  const raw=(key,value)=>sheet(d=>{d.timing[key]=0;}).replace(new RegExp(`"${key}":0`),`"${key}":${value}`);
  for(const [key,value] of [['bpm','1e999'],['bpm','-1e999'],['offsetSeconds','1e999'],['offsetSeconds','-1e999'],['seed','1e999'],['barsPerScene','1e999']])refuses(()=>importCueSheet(raw(key,value),all),/Scene timing requires/,`${key}=${value}`);
  refuses(()=>importCueSheet(sheet(d=>{d.timing.tempoMap[0].at=0;}).replace('"at":0','"at":1e999'),all),/tempoMap/);
  refuses(()=>importCueSheet(sheet(d=>{d.timing.intervals[0].endBeat=0;}).replace('"endBeat":0','"endBeat":1e999'),all),/intervals/);
  for(const bad of ['{"format":"aaavs-cue-sheet","version":1,"timing":{"bpm":NaN}}','{"bpm":Infinity}','','{','nonsense','undefined','[1,'])refuses(()=>importCueSheet(bad,all),/not valid JSON/,bad);
  for(const bad of ['[]','null','5','"aaavs-cue-sheet"','{}','{"format":"other","version":1}','{"format":"AAAVS-CUE-SHEET","version":1}'])refuses(()=>importCueSheet(bad,all),/not an AAAVS cue sheet/,bad);
  for(const bad of [undefined,null,5,{},[],true])refuses(()=>importCueSheet(bad,all),/A cue sheet is text/,String(bad));
  // A deeply nested document is refused cleanly, not with a stack overflow.
  refuses(()=>importCueSheet('['.repeat(100000)+']'.repeat(100000),all),/not valid JSON|not an AAAVS cue sheet/);
}

// ---- Version gate, timing required, unknown keys, text fields, fade ----
{
  const sheet=(mutate)=>{const doc=JSON.parse(exportCueSheet({timing:v1,fade}));mutate(doc);return JSON.stringify(doc);};
  assert.equal(importCueSheet(sheet(()=>{}),all).dropped,0);
  refuses(()=>importCueSheet(sheet(d=>{d.version=2;}),all),/version 2.*reads version 1/);refuses(()=>importCueSheet(sheet(d=>{d.version=99;}),all),/version 99/);
  for(const bad of [0,-1,1.5,'1',null,true,undefined])refuses(()=>importCueSheet(sheet(d=>{d.version=bad;}),all),/no valid version/,String(bad));
  refuses(()=>importCueSheet(sheet(d=>{delete d.timing;}),all),/has no timing/);
  for(const bad of [null,5,'x',[],{}])refuses(()=>importCueSheet(sheet(d=>{d.timing=bad;}),all),/./,`timing ${JSON.stringify(bad)}`);
  // Unknown keys are dropped everywhere; the result is rebuilt from known fields.
  const noisy=importCueSheet(sheet(d=>{d.extra={a:1};d.timing.extra=[1];d.fade.extra=true;d.title='Artist - Song';d.path=['C:','\\Users\\me\\song.mp3'].join('');}),all);
  assert.deepEqual(noisy,{timing:v1,fade,dropped:0});
  assert.deepEqual(Object.keys(noisy).sort(),['dropped','fade','timing']);
  // Text fields: control characters removed, length limits, type checks.
  assert.equal(importCueSheet(sheet(d=>{d.name='  Fri\u0000day\u0007 \u2028set  ';}),all).name,'Friday set');
  assert.equal(importCueSheet(sheet(d=>{d.name='n'.repeat(120);}),all).name.length,120);refuses(()=>importCueSheet(sheet(d=>{d.name='n'.repeat(121);}),all),/name must be text of at most 120/);
  assert.equal(importCueSheet(sheet(d=>{d.note='x'.repeat(200);}),all).note.length,200);refuses(()=>importCueSheet(sheet(d=>{d.note='x'.repeat(201);}),all),/note must be text of at most 200/);
  for(const bad of [5,null,{},[],true])refuses(()=>importCueSheet(sheet(d=>{d.name=bad;}),all),/name must be text/,`name ${JSON.stringify(bad)}`);
  assert.equal('name' in importCueSheet(sheet(d=>{d.name='  ';d.note='';}),all),false);assert.equal('note' in importCueSheet(sheet(d=>{d.note='\u0001';}),all),false);
  refuses(()=>exportCueSheet({timing:v1,name:'n'.repeat(121)}),/name must be text of at most 120/);refuses(()=>exportCueSheet({timing:v1,note:'x'.repeat(201)}),/note must be text of at most 200/);refuses(()=>exportCueSheet({timing:v1,name:5}),/name must be text/);
  assert.equal(JSON.parse(exportCueSheet({timing:v1,name:'a\nb'})).name,'ab','control characters never reach the sheet');
  // Fade: every field validated, all four required.
  const badFades=[{fadeTiming:7},{fadeTiming:-1},{fadeTiming:1.5},{fadeRandomSet:0},{fadeRandomSet:32},{fadeAnchor:3},{fadeAnchor:-1},{durationMs:249},{durationMs:8001},{durationMs:1000.5},{fadeTiming:'2'},{durationMs:null}];
  for(const patch of badFades){
    refuses(()=>importCueSheet(sheet(d=>{Object.assign(d.fade,patch);}),all),/fade settings/,JSON.stringify(patch));
    refuses(()=>exportCueSheet({timing:v1,fade:{...fade,...patch}}),/fade settings/,JSON.stringify(patch));
  }
  for(const key of Object.keys(fade))refuses(()=>importCueSheet(sheet(d=>{delete d.fade[key];}),all),/fade settings/,`missing ${key}`);
  for(const bad of [null,5,'x',[]])refuses(()=>importCueSheet(sheet(d=>{d.fade=bad;}),all),/fade settings/,`fade ${JSON.stringify(bad)}`);
  assert.deepEqual(importCueSheet(sheet(d=>{d.fade={fadeTiming:0,fadeRandomSet:1,fadeAnchor:2,durationMs:250};}),all).fade,{fadeTiming:0,fadeRandomSet:1,fadeAnchor:2,durationMs:250});
  assert.deepEqual(importCueSheet(sheet(d=>{d.fade={fadeTiming:6,fadeRandomSet:31,fadeAnchor:0,durationMs:8000};}),all).fade,{fadeTiming:6,fadeRandomSet:31,fadeAnchor:0,durationMs:8000});
}

// ---- A sheet carries no paths, titles or tags ----
{
  const doc=JSON.parse(exportCueSheet({name:'Set',timing:full,fade,note:'n'}));
  assert.deepEqual(Object.keys(doc).sort(),['fade','format','name','note','timing','version']);
  assert.deepEqual(Object.keys(doc.timing).sort(),['barsPattern','barsPerScene','beatsPerBar','bpm','enabled','intervals','offsetSeconds','patternHold','script','seed','tempoMap','version']);
  for(const cue of doc.timing.script)assert.deepEqual(Object.keys(cue),['ordinal','preset']),assert.match(cue.preset,/^[0-9a-f]{64}$/);
  const text=exportCueSheet({timing:full});assert.ok(!/[A-Za-z]:[\\/]|\.avs|\.nerv|\.hud|title|path|rating|tags/i.test(text.replace('"format":"aaavs-cue-sheet"','')),'no path, extension, title, rating or tag wording in a sheet');
}

// ---- Script cues become session cues and share the 1024 budget ----
{
  const order=[3,4,5,6],known=new Map([[hash(1),3],[hash(2),5],[hash(3),99],[hash(4),6]]),resolve=h=>known.get(h);
  const script=[{ordinal:1,preset:hash(1)},{ordinal:2,preset:hash(3)},{ordinal:5,preset:hash(2)},{ordinal:8,preset:hash(9)},{ordinal:9,preset:hash(4)}];
  assert.deepEqual(sceneCuesFromScript(script,resolve,order),[{ordinal:1,index:3},{ordinal:5,index:5},{ordinal:9,index:6}],'unknown hashes and presets outside the pool are dropped');
  assert.deepEqual(sceneCuesFromScript(script,resolve,new Set(order)),sceneCuesFromScript(script,resolve,order),'a Set or an array');
  assert.deepEqual(sceneCuesFromScript(script,resolve),[{ordinal:1,index:3},{ordinal:2,index:99},{ordinal:5,index:5},{ordinal:9,index:6}],'no pool: every known preset');
  assert.deepEqual(sceneCuesFromScript(undefined,resolve,order),[]);assert.deepEqual(sceneCuesFromScript([],resolve,order),[]);
  for(const bad of [-1,1.5,NaN,'3',null])assert.deepEqual(sceneCuesFromScript([{ordinal:0,preset:hash(1)}],()=>bad,order),[]);
  // The clock accepts them: the cued scene plays from its ordinal, then the sequence continues from it.
  const timing={...defaultSceneTiming,enabled:true,bpm:120,barsPerScene:1,seed:3},clock=compileSceneClock(timing);
  const cues=sceneCuesFromScript([{ordinal:2,preset:hash(2)}],resolve,order);
  assert.equal(clock.at(1,order,false,cues).index,order[0]);assert.equal(clock.at(3,order,false,cues).index,order[1]);assert.equal(clock.at(4.5,order,false,cues).index,5,'ordinal 2 plays the scripted preset');assert.equal(clock.at(6.5,order,false,cues).index,6,'and the order continues after it');
  assert.equal(clock.at(4.5,order,true,cues).index,5,'also when shuffled');
  // The budget is shared with live choices: scripted cues fill it, a replacement of a pending cue still fits, a new one is refused.
  const big=Array.from({length:MAX_SCENE_CUES},(_,i)=>({ordinal:i+1,preset:hash(1)}));
  const filled=sceneCuesFromScript(big,()=>3,order);assert.equal(filled.length,MAX_SCENE_CUES);
  assert.doesNotThrow(()=>scheduleSceneCue(filled,{ordinal:0},4),'the next ordinal already holds a scripted cue: replaced, not added');
  assert.equal(scheduleSceneCue(filled,{ordinal:0},4)[0].index,4);
  assert.throws(()=>scheduleSceneCue(filled,{ordinal:MAX_SCENE_CUES+5},4),/1024 scene cues/);
  const nearly=sceneCuesFromScript(big.slice(0,MAX_SCENE_CUES-1),()=>3,order);assert.equal(scheduleSceneCue(nearly,{ordinal:MAX_SCENE_CUES+9},5).length,MAX_SCENE_CUES);
  assert.equal(sceneCuesFromScript([...big,{ordinal:5000,preset:hash(1)}],()=>3,order).length,MAX_SCENE_CUES,'never more than the budget');
}

// ---- Bake session choices into the script ----
{
  const names=new Map([[3,hash(3)],[4,hash(4)],[5,hash(5)],[6,'not-a-hash']]),hashOf=i=>names.get(i);
  const timing=parseSceneTiming({...v1,version:2,script:[{ordinal:1,preset:hash(9)},{ordinal:6,preset:hash(8)}]});
  const cues=[{ordinal:3,index:4},{ordinal:6,index:5},{ordinal:7,index:6},{ordinal:12,index:77}];
  const {timing:baked,dropped}=bakeSessionCues(timing,cues,hashOf);
  assert.equal(dropped,2,'a cue whose preset has no valid hash is dropped and counted');
  assert.deepEqual(baked.script,[{ordinal:1,preset:hash(9)},{ordinal:3,preset:hash(4)},{ordinal:6,preset:hash(5)}],'sorted by ordinal; a session cue wins over a script entry');
  assert.deepEqual(timing.script,[{ordinal:1,preset:hash(9)},{ordinal:6,preset:hash(8)}],'the input is untouched');
  assert.doesNotThrow(()=>parseSceneTiming(baked));assert.equal(baked.version,2);
  // From a v1 timing: the script appears and the version follows; nothing baked leaves it v1.
  const fromV1=bakeSessionCues(v1,[{ordinal:2,index:3}],hashOf).timing;assert.deepEqual(fromV1,{...v1,version:2,script:[{ordinal:2,preset:hash(3)}]});
  assert.equal(JSON.stringify(bakeSessionCues(v1,[],hashOf).timing),JSON.stringify(v1));assert.equal(JSON.stringify(bakeSessionCues(v1,[{ordinal:2,index:1234}],hashOf).timing),JSON.stringify(v1));
  // The script keeps at most 1024 entries, the earliest ordinals first.
  const many=Array.from({length:1030},(_,i)=>({ordinal:i,index:3})),capped=bakeSessionCues(v1,many,hashOf);
  assert.equal(capped.timing.script.length,MAX_SCRIPT);assert.equal(capped.dropped,6);assert.equal(capped.timing.script.at(-1).ordinal,1023);assert.doesNotThrow(()=>parseSceneTiming(capped.timing));
  // A baked script survives export and import, and comes back as the same session cues.
  const text=exportCueSheet({timing:baked}),lookup=new Map([[hash(9),9],[hash(4),4],[hash(5),5]]);
  const round=importCueSheet(text,h=>lookup.get(h));assert.deepEqual(round.timing,baked);
  assert.deepEqual(sceneCuesFromScript(round.timing.script,h=>lookup.get(h),[4,5,9]),[{ordinal:1,index:9},{ordinal:3,index:4},{ordinal:6,index:5}]);
}

// ---- Purity ----
{
  const source=readFileSync('src/mpc-cue-sheet.ts','utf8').replace(/\/\*[\s\S]*?\*\//g,'').replace(/\/\/.*$/gm,'');
  for(const forbidden of [/Math\.random/,/Date\.now/,/performance\.now/,/\bnew Date\b/,/\bdocument\b/,/\bwindow\b/,/navigator/,/localStorage/,/\bfetch\b/])assert.ok(!forbidden.test(source),`${forbidden} must not appear in mpc-cue-sheet.ts`);
}
console.log('Cue sheet CPU: export/import round trips (300 random timings), hash mapping and drop counts, 256 KiB and count limits, forbidden keys anywhere, non-finite numbers, version gate, text and fade validation, no path or title fields, script cues as session cues under the shared 1024 budget, baking session choices, purity PASS');
