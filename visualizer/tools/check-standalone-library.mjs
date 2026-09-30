import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { createServer, request as httpRequest } from 'node:http';
import { mkdtemp, mkdir, readFile, writeFile, rm, stat, utimes, symlink } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { build } from 'esbuild';
import { createLibraryHandler } from './standalone-library.mjs';

const root = await mkdtemp(join(tmpdir(),'aaavs-library-'));
const collection = join(root,'avs presets'), catalogPath = join(collection,'catalog','presets.json');
const presetDir = join(collection,'presets','unique');
const bytes = Buffer.from('exact fixture preset bytes'), hash = createHash('sha256').update(bytes).digest('hex');
const initial = {presets:[{sha256:hash,bytes:bytes.length,canonical_path:'presets/unique/fixture.avs',display_name:'Fixture'}]};
const defaults = {enabled:true,bars:0,shuffle:false,minimumRating:0,transition:1,beats:0,durationMs:2000,keepOld:true,manualFade:true,autoFade:true};
await mkdir(presetDir,{recursive:true}); await mkdir(join(collection,'catalog'),{recursive:true});
await writeFile(catalogPath,JSON.stringify(initial)); await writeFile(join(presetDir,'fixture.avs'),bytes);
const before = new Date('2001-01-01T00:00:00Z'); await utimes(join(presetDir,'fixture.avs'),before,before);
let handler = createLibraryHandler(root);
const server = createServer(async(req,res) => { if(await handler(req,res))return; res.writeHead(418);res.end('static fallback'); });
await new Promise(resolve => server.listen(0,'127.0.0.1',resolve));
const port = server.address().port, origin = `http://127.0.0.1:${port}`;
function request(value,headers={},path='/api/aaavs/library',method='POST') {
  const payload = typeof value === 'string' ? value : JSON.stringify(value);
  return new Promise((resolve,reject) => {
    const req=httpRequest({hostname:'127.0.0.1',port,path,method,headers:{Host:`127.0.0.1:${port}`,Origin:origin,'Content-Type':'application/json','Content-Length':Buffer.byteLength(payload),...headers}},res=>{
      const chunks=[];res.on('error',error=>{reject(new Error(`${error.message} (${method} ${path}; payload ${payload.length} bytes)`));});res.on('data',chunk=>chunks.push(chunk));res.on('end',()=>{const text=Buffer.concat(chunks).toString();let data;try{data=JSON.parse(text);}catch{data=text;}resolve({status:res.statusCode,data});});
    });req.on('error',error=>{error.message+=` (${method} ${path}; payload ${payload.length} bytes)`;reject(error);});req.end(payload);
  });
}
const post = async(value) => (await request(value)).data;
const readCatalog = async()=>JSON.parse(await readFile(catalogPath,'utf8'));
let checks=0;
function check(value,message){assert.ok(value,message);checks++;}
function same(a,b,message){assert.deepEqual(a,b,message);checks++;}
try {
  same((await post({op:'load-settings'})),{type:'settings',...defaults});
  const custom={...defaults,shuffle:true,minimumRating:3};
  same(await post({op:'configure',settings:custom}),{type:'settings',...custom});
  same(await post({op:'load-settings'}),{type:'settings',...custom});
  check((await post({op:'configure',settings:{...custom,durationMs:9000}})).type==='library-error');
  // Optional v2 fade fields are kept when present, absent otherwise, and rejected when present but invalid (contract 2.3.6).
  const fade={fadeTiming:6,fadeRandomSet:19,fadeAnchor:2,queueQuantize:3};
  same(await post({op:'configure',settings:{...custom,...fade}}),{type:'settings',...custom,...fade});
  same(await post({op:'load-settings'}),{type:'settings',...custom,...fade});
  same(JSON.parse(await readFile(join(collection,'.aaavs-private','settings.json'),'utf8')),{...custom,...fade});
  same(await post({op:'configure',settings:{...custom,fadeTiming:0}}),{type:'settings',...custom,fadeTiming:0},'fields absent from a request are absent from the file');
  for(const [key,values] of Object.entries({fadeTiming:[-1,7,1.5,null,'3'],fadeRandomSet:[0,32,1.5,null],fadeAnchor:[-1,3,null],queueQuantize:[-1,4,null]}))
    for(const value of values)same((await post({op:'configure',settings:{...custom,[key]:value}})).type,'library-error',`${key}=${String(value)}`);
  // Display preferences are device-local: extra keys never reach settings.json.
  same(await post({op:'configure',settings:{...custom,quality:3,showFps:2,type:'settings'}}),{type:'settings',...custom});
  same(JSON.parse(await readFile(join(collection,'.aaavs-private','settings.json'),'utf8')),custom);
  const installLock=join(collection,'catalog','nerv-install.lock');
  await writeFile(installLock,'installer owns this lock');
  same((await post({op:'rate',hash,rating:4})).type,'library-error');
  same((await post({op:'set-not-working',hash,notWorking:true})).type,'library-error');
  same(await readCatalog(),initial);same(await readFile(join(presetDir,'fixture.avs')),bytes);
  same(await readFile(installLock,'utf8'),'installer owns this lock');await rm(installLock);
  const privateLock=join(collection,'.aaavs-private','library.lock');
  await writeFile(privateLock,'another server owns this lock');
  same((await post({op:'rate',hash,rating:4})).type,'library-error');
  await assert.rejects(stat(installLock),{code:'ENOENT'});checks++;
  same(await readFile(privateLock,'utf8'),'another server owns this lock');await rm(privateLock);
  const rated=await post({op:'rate',hash,rating:4});
  same(rated.type,'rating-saved');same(rated.entry.canonical_path,'presets/unique/fixture [4 stars].avs');
  same(await readFile(join(presetDir,'fixture [4 stars].avs')),bytes);
  check((await stat(join(presetDir,'fixture [4 stars].avs'))).mtimeMs > before.getTime());
  same((await readCatalog()).presets[0].sha256,hash);
  // Serialized requests rate the newest catalog path, never a stale source name.
  const concurrent=await Promise.all([post({op:'rate',hash,rating:1}),post({op:'rate',hash,rating:5})]);
  check(concurrent.every(result=>result.type==='rating-saved'));
  let entry=(await readCatalog()).presets[0];same(entry.rating,5);
  await writeFile(join(presetDir,'fixture [2 stars].avs'),'collision');
  same((await post({op:'rate',hash,rating:2})).type,'library-error');same((await readCatalog()).presets[0].rating,5);
  same(await readFile(join(presetDir,'fixture [2 stars].avs'),'utf8'),'collision');
  // Existing transaction marker forces catalog-save failure after rename; rollback restores path and date.
  const oldPath=join(presetDir,'fixture [5 stars].avs'), oldTime=(await stat(oldPath)).mtimeMs;
  await writeFile(`${catalogPath}.writing`,'occupied');
  same((await post({op:'rate',hash,rating:3})).type,'library-error');
  same(await readFile(oldPath),bytes);check(Math.abs((await stat(oldPath)).mtimeMs-oldTime)<2);
  same(await readFile(`${catalogPath}.writing`,'utf8'),'occupied');await rm(`${catalogPath}.writing`);
  await writeFile(oldPath,'tampered');same((await post({op:'rate',hash,rating:3})).type,'library-error');await writeFile(oldPath,bytes);
  same((await post({op:'set-not-working',hash,notWorking:true})).type,'not-working-saved');
  same((await readCatalog()).presets[0].notWorking,true);
  same((await post({op:'set-not-working',hash,notWorking:false})).entry.notWorking,false);
  const setup={id:'test',name:' Test ',presets:[hash],settings:custom,timing:{enabled:true,bpm:109,offsetSeconds:1,barsPerScene:8,seed:4}};
  same((await post({op:'save-setups',setups:[setup]})).type,'setups-saved');
  same((await post({op:'load-setups'})).setups,[{...setup,name:'Test'}]);
  // Validate the server's dependency-free copy against the actual shared
  // TypeScript contract, so future schema changes cannot silently diverge.
  const built=await build({entryPoints:[fileURLToPath(new URL('../src/mpc-setups.ts',import.meta.url))],bundle:true,format:'esm',platform:'node',target:'es2022',write:false,logLevel:'silent'});
  const {parseSetups,defaultSettings}=await import(`data:text/javascript;base64,${Buffer.from(built.outputFiles[0].text).toString('base64')}`);
  same(defaultSettings,defaults);
  // Literal drift guard: the server and the native library cannot import src/mpc-contract.ts, so their copies are compared with it.
  {
    const table=await build({entryPoints:[fileURLToPath(new URL('../src/mpc-contract.ts',import.meta.url))],bundle:true,format:'esm',platform:'node',target:'es2022',write:false,logLevel:'silent'});
    const contract=await import(`data:text/javascript;base64,${Buffer.from(table.outputFiles[0].text).toString('base64')}`);
    const source=await readFile(fileURLToPath(new URL('./standalone-library.mjs',import.meta.url)),'utf8');
    same(JSON.parse(/const STATE_NAMES = (\[[^\]]*\])/.exec(source)[1].replaceAll("'",'"')),[...contract.STATE_NAMES],'server STATE_NAMES equals the contract');
    same(Number(/const STATE_MAX_BYTES = (\d+)/.exec(source)[1]),contract.STATE_MAX_BYTES,'server STATE_MAX_BYTES equals the contract');
    const fadeFields=[...source.matchAll(/\['(\w+)',(\d+),(\d+)\]/g)].map(m=>[m[1],Number(m[2]),Number(m[3])]);
    same(fadeFields,[['fadeTiming',0,contract.FADE_TIMING_COUNT-1],['fadeRandomSet',contract.FADE_RANDOM_SET_MIN,contract.FADE_RANDOM_SET_ALL],['fadeAnchor',0,contract.FADE_ANCHOR_COUNT-1],['queueQuantize',0,contract.QUEUE_QUANTIZE_COUNT-1]],'server fade field ranges equal the contract');
    // Native sources are absent in a stock checkout; the comparison then skips cleanly.
    const nativeDir=fileURLToPath(new URL('../../src/mpc-hc/',import.meta.url));
    let library=null,view=null;
    try{library=await readFile(`${nativeDir}AAAVSLibrary.h`,'utf8');view=await readFile(`${nativeDir}AAAVSView.cpp`,'utf8');}catch{library=view=null;}
    if(library&&view){
      same(Number(/kStateMaxBytes = (\d+)/.exec(library)[1]),contract.STATE_MAX_BYTES,'native kStateMaxBytes equals the contract');
      const names=/StateName\(const std::string& name\) \{ return ([^;]+);/.exec(library)[1];
      same([...names.matchAll(/"(\w+)"/g)].map(m=>m[1]),[...contract.STATE_NAMES],'native state names equal the contract');
      check(new RegExp(`duration / 10000000\\.0 <= ${contract.AUDIO_DURATION_MAX}\\.0`).test(view),'native audio duration cap equals AUDIO_DURATION_MAX');
      check(/duration > 0 &&/.test(view),'native sends duration only when positive');
      // Registry names the page-facing snapshot and the Player fields must agree on.
      for(const key of ['FadeTiming','FadeRandomSet','FadeAnchor','QueueQuantize','ShowFps','TimingOverlay','Quality','AvsResolution','PixelArt'])check(view.includes(`L"${key}"`),`native registry value ${key}`);
    }
  }
  const parityCases=[undefined,null,{},[],[setup],[{...setup,timing:undefined}],[{...setup,id:''}],[{...setup,id:'x'.repeat(101)}],[{...setup,name:'   '}],[{...setup,name:'x'.repeat(121)}],[setup,setup],[{...setup,presets:[hash,hash]}],[{...setup,presets:['z'.repeat(64)]}],Array(101).fill(setup)];
  for(const [key,values] of Object.entries({bars:[-1,0,2,3,4,8,12,16],beats:[-1,0,1,2,3,4,5],transition:[-1,0,15,32,33,1.5],durationMs:[249,250,8000,8001,250.5],minimumRating:[undefined,null,-1,0,5,6,1.5],enabled:[true,false,0,'true'],shuffle:[true,false,0],keepOld:[true,false,null],manualFade:[true,false,1],autoFade:[true,false,'false']})) {
    for(const value of values) parityCases.push([{...setup,settings:{...custom,[key]:value}}]);
  }
  // The four optional fade fields exist in the shared parseSettings today: full boundary matrix, absent and present.
  for(const [key,values] of Object.entries({fadeTiming:[-1,0,3,6,7,1.5,null,'3',true],fadeRandomSet:[0,1,19,31,32,1.5,null],fadeAnchor:[-1,0,1,2,3,null],queueQuantize:[-1,0,3,4,null]})) {
    for(const value of values) parityCases.push([{...setup,settings:{...custom,[key]:value}}]);
  }
  parityCases.push([{...setup,settings:{...custom,fadeTiming:4,fadeRandomSet:31,fadeAnchor:1,queueQuantize:2}}]);
  // Malformed shapes at every level, and name normalisation: accepted or rejected exactly like the shared parser.
  for(const shape of [[null],[5],['x'],[[]],[{}],[{...setup,settings:null}],[{...setup,settings:[]}],[{...setup,settings:5}],[{...setup,settings:'x'}],[{...setup,settings:undefined}],
    [{...setup,timing:null}],[{...setup,timing:[]}],[{...setup,timing:5}],[{...setup,timing:'x'}],[{...setup,timing:{}}],[{...setup,presets:'x'}],[{...setup,presets:null}],[{...setup,presets:[]}],
    [{...setup,name:'  padded  '}],[{...setup,name:5}],[{...setup,id:5}],[{...setup,id:'a'.repeat(100)}],[{...setup,settings:{...custom,fadeTiming:6,fadeRandomSet:1,fadeAnchor:2,queueQuantize:3},timing:{...setup.timing,version:2,beatsPerBar:16}}],
    [{...setup,id:'a'},{...setup,id:'b'}],[{...setup,id:'a'},{...setup,id:'a'}],Array(100).fill(0).map((_,i)=>({...setup,id:`s${i}`}))]) parityCases.push(shape);
  for(const [key,values] of Object.entries({bpm:[19.9,20,400,400.1,'120',null],offsetSeconds:[-3601,-3600,3600,3601],barsPerScene:[0,1,128,129,1.5],seed:[-1,0,0xffffffff,0x100000000,1.5],enabled:[true,false,0]})) {
    for(const value of values) parityCases.push([{...setup,timing:{...setup.timing,[key]:value}}]);
  }
  // Scene timing v2 (contract 2.2.2). The shared parser is TIM's; until it understands v2 these rows are checked against the
  // contract text alone and the shared-parser comparison is reported as pending instead of silently skipped.
  const v2Timing={...setup.timing,offsetSeconds:1};
  const sharedTimingV2=(()=>{try{return parseSetups([{...setup,timing:{...v2Timing,beatsPerBar:3}}])[0].timing.beatsPerBar===3;}catch{return false;}})();
  const hashB='b'.repeat(64), interval={id:'chorus',startBeat:16,endBeat:48};
  const timingV2Cases=[{version:2},{version:3,beatsPerBar:5},{version:1e300},{version:Number.MAX_SAFE_INTEGER,beatsPerBar:2},{version:-1},{version:Infinity},{version:1},{version:0},{version:1.5},{version:'2'},{version:null},
    {beatsPerBar:1},{beatsPerBar:3},{beatsPerBar:4},{beatsPerBar:16},{beatsPerBar:0},{beatsPerBar:17},{beatsPerBar:3.5},{beatsPerBar:null},{beatsPerBar:'4'},
    {barsPattern:[4]},{barsPattern:[4,4,8,16]},{barsPattern:Array(64).fill(128)},{barsPattern:Array(65).fill(1)},{barsPattern:[]},{barsPattern:[0]},{barsPattern:[129]},{barsPattern:[1.5]},{barsPattern:'4'},{barsPattern:null},
    {patternHold:true},{patternHold:false},{patternHold:1},{patternHold:null},
    {tempoMap:[{at:2,bpm:140}]},{tempoMap:[{at:2,bpm:20},{at:3,bpm:400}]},{tempoMap:[{at:1,bpm:140}]},{tempoMap:[{at:0.5,bpm:140}]},{tempoMap:[{at:2,bpm:140},{at:2,bpm:150}]},{tempoMap:[{at:3,bpm:140},{at:2,bpm:150}]},
    {tempoMap:[{at:1e6,bpm:100}]},{tempoMap:[{at:1e6+1,bpm:100}]},{tempoMap:[{at:2,bpm:19.9}]},{tempoMap:[{at:2,bpm:400.1}]},{tempoMap:[{at:2}]},{tempoMap:[{bpm:120}]},{tempoMap:[]},{tempoMap:[null]},{tempoMap:'x'},
    {tempoMap:Array.from({length:256},(_,i)=>({at:2+i,bpm:120}))},{tempoMap:Array.from({length:257},(_,i)=>({at:2+i,bpm:120}))},
    {script:[]},{script:[{ordinal:4,preset:hash}]},{script:[{ordinal:0,preset:hash},{ordinal:2,preset:hashB}]},{script:[{ordinal:2,preset:hash},{ordinal:2,preset:hashB}]},{script:[{ordinal:3,preset:hash},{ordinal:2,preset:hashB}]},
    {script:[{ordinal:-1,preset:hash}]},{script:[{ordinal:1.5,preset:hash}]},{script:[{ordinal:Number.MAX_SAFE_INTEGER,preset:hash}]},{script:[{ordinal:2**53,preset:hash}]},{script:[{ordinal:1e7+1,preset:hash}]},{script:[{ordinal:1,preset:'ABC'}]},{script:[{ordinal:1,preset:hash.toUpperCase()}]},{script:[{ordinal:1}]},{script:'x'},
    {script:Array.from({length:1024},(_,i)=>({ordinal:i,preset:hash}))},{script:Array.from({length:1025},(_,i)=>({ordinal:i,preset:hash}))},
    {intervals:[]},{intervals:[interval]},{intervals:[interval,{id:'bridge_2-a',startBeat:0,endBeat:1}]},{intervals:[interval,interval]},{intervals:[{...interval,id:'Chorus'}]},{intervals:[{...interval,id:''}]},{intervals:[{...interval,id:'x'.repeat(32)}]},{intervals:[{...interval,id:'x'.repeat(33)}]},
    {intervals:[{...interval,startBeat:-1}]},{intervals:[{...interval,startBeat:48}]},{intervals:[{...interval,endBeat:1e7}]},{intervals:[{...interval,endBeat:1e7+1}]},{intervals:[{id:'a',startBeat:0}]},{intervals:'x'},
    {intervals:Array.from({length:64},(_,i)=>({id:`i${i}`,startBeat:i,endBeat:i+1}))},{intervals:Array.from({length:65},(_,i)=>({id:`i${i}`,startBeat:i,endBeat:i+1}))},
    {beatsPerBar:3,barsPattern:[4,8],patternHold:true,tempoMap:[{at:2,bpm:130}],script:[{ordinal:1,preset:hash}],intervals:[interval],unknownKey:1,extra:{a:1}}];
  for(const extra of timingV2Cases) parityCases.push([{...setup,timing:{...v2Timing,...extra}}]);
  // Rows whose acceptance is fixed by the contract text (checked below regardless of the shared parser).
  const pendingParity=new Set(timingV2Cases.map((_,i)=>parityCases.length-timingV2Cases.length+i));
  let pendingRows=0;
  for(const [row,input] of parityCases.entries()) {
    // Match the JSON boundary, including omitted optional fields.
    const value=input===undefined?undefined:JSON.parse(JSON.stringify(input));
    if(pendingParity.has(row)&&!sharedTimingV2){
      // Shared parser predates scene timing v2: only the server's own contract is checked (below); parity is re-verified when TIM lands.
      pendingRows++;const result=await post({op:'save-setups',setups:value});
      if(result.type==='setups-saved'){const stored=(await post({op:'load-setups'})).setups;await post({op:'save-setups',setups:stored});same((await post({op:'load-setups'})).setups,stored,'Stored v2 timing is a fixed point');}
      continue;
    }
    let expected,accepted=true;try{expected=parseSetups(value);}catch{accepted=false;}
    const result=await post({op:'save-setups',setups:value});
    same(result.type,accepted?'setups-saved':'library-error','Shared setup validation parity');
    if(accepted)same((await post({op:'load-setups'})).setups,expected,'Shared setup normalization parity');
  }
  if(pendingRows)console.log(`PENDING: ${pendingRows} scene timing v2 rows were not compared with the shared parser (it has no v2 fields yet); server contract rows below still ran.`);
  // Seeded mutation fuzz against the shared parser (TIM's parseSceneTiming v2 and parseSettings): every mutant is accepted or rejected
  // by the server exactly like the shared parser, and an accepted one normalises to the same value. Deterministic: no Math.random.
  {
    let state=0x9e3779b9;
    const next=()=>{state=(state+0x6d2b79f5)>>>0;let n=state;n=Math.imul(n^(n>>>15),n|1);n^=n+Math.imul(n^(n>>>7),n|61);return((n^(n>>>14))>>>0)/4294967296;};
    const pick=list=>list[Math.floor(next()*list.length)];
    const richSetup={...setup,settings:{...custom,fadeTiming:4,fadeRandomSet:19,fadeAnchor:1,queueQuantize:2},timing:{...v2Timing,beatsPerBar:3,barsPattern:[4,8],patternHold:true,tempoMap:[{at:2,bpm:130},{at:9,bpm:90}],script:[{ordinal:1,preset:hash},{ordinal:4,preset:hashB}],intervals:[interval,{id:'bridge',startBeat:0,endBeat:2}]}};
    const bases=[setup,richSetup,{...richSetup,settings:defaults}];
    const interesting=[null,true,false,0,1,-1,2,3,4,5,6,7,12,16,17,31,32,33,64,65,100,128,129,250,8000,8001,0.5,1.5,1e6,1e6+1,1e7,1e7+1,1e300,-1e300,Number.MAX_SAFE_INTEGER,2**53,0xffffffff,0x100000000,'','x','0','4',hash,hashB,'ABC','z'.repeat(64),[],{},[1],{a:1},[null],[{}],[{at:2,bpm:100}],[{ordinal:0,preset:hash}],[{id:'a',startBeat:0,endBeat:1}]];
    const clone=x=>x===undefined?undefined:JSON.parse(JSON.stringify(x));
    const paths=(value,prefix=[])=>value&&typeof value==='object'?Object.keys(value).flatMap(key=>[[...prefix,key],...paths(value[key],[...prefix,key])]):[];
    const mutate=base=>{
      const target=clone([base]);let root=target[0];
      for(let round=0,rounds=1+Math.floor(next()*3);round<rounds;round++){
        const all=paths(root);if(!all.length)break;
        const path=pick(all),parent=path.slice(0,-1).reduce((node,key)=>node[key],root),key=path.at(-1),action=next();
        if(action<.25)delete parent[key];
        else if(action<.4&&Array.isArray(parent[key])&&parent[key].length){const list=parent[key],at=Math.floor(next()*list.length);if(next()<.5)list.splice(at,1);else list.splice(at,0,clone(list[at]));}
        else if(action<.5&&typeof parent[key]==='number'){parent[key]+=pick([-1,1,-0.5,0.5,1e-9]);}
        else parent[key]=clone(pick(interesting));
      }
      return target;
    };
    const boundaries=[['bars',[0,2,4,8,12]],['minimumRating',[0,5]],['transition',[0,32]],['durationMs',[250,8000]],['fadeTiming',[0,6]],['fadeRandomSet',[1,31]],['fadeAnchor',[0,2]],['queueQuantize',[0,3]]];
    let accepted=0,rejected=0;
    for(let i=0;i<2400;i++){
      let value=clone(mutate(pick(bases)));// wire form: a deleted array element is a hole in-process but arrives as null over JSON
      // Exercise the exact edges of each range on some mutants, which random picking rarely hits together.
      if(i%7===0){const [key,edges]=pick(boundaries);if(value[0]&&value[0].settings&&typeof value[0].settings==='object')value[0].settings[key]=pick(edges);}
      let expected,ok=true;try{expected=parseSetups(value);}catch{ok=false;}
      const result=await post({op:'save-setups',setups:value});
      same(result.type,ok?'setups-saved':'library-error',`mutation fuzz ${i} acceptance: ${JSON.stringify(value).slice(0,300)}`);
      if(ok){accepted++;same((await post({op:'load-setups'})).setups,expected,`mutation fuzz ${i} normalisation`);}else rejected++;
    }
    check(accepted>100&&rejected>100,`the fuzz exercises both outcomes (${accepted} accepted, ${rejected} rejected)`);
    await post({op:'save-setups',setups:[setup]});
  }
  // Scene timing v2 against the contract text itself (2.2.2): exact stored shape, default omission, ordering and limits.
  const stored=async timing=>{const r=await post({op:'save-setups',setups:[{...setup,timing}]});return r.type==='setups-saved'?(await post({op:'load-setups'})).setups[0].timing:null;};
  const five=['enabled','bpm','offsetSeconds','barsPerScene','seed'];
  same(Object.keys(await stored(v2Timing)),five,'a v1 timing serialises as exactly its five keys');
  same(await stored({...v2Timing,version:2}),v2Timing,'version alone (all defaults) writes nothing');
  same(await stored({...v2Timing,version:2,beatsPerBar:4,patternHold:false,script:[],intervals:[],junk:1,__proto__x:true}),v2Timing,'default-valued fields are omitted and unknown keys dropped');
  same(await stored({...v2Timing,beatsPerBar:3}),{...v2Timing,version:2,beatsPerBar:3},'version 2 is written only when a v2 field survives');
  same(await stored({...v2Timing,version:3,beatsPerBar:5,futureField:{a:1}}),{...v2Timing,version:2,beatsPerBar:5},'version above 2 is tolerated and normalised');
  const full={beatsPerBar:7,barsPattern:[4,4,8,16],patternHold:true,tempoMap:[{at:2,bpm:140,x:1},{at:9.5,bpm:90}],script:[{ordinal:0,preset:hash},{ordinal:5,preset:hashB,x:1}],intervals:[interval,{id:'b_2-a',startBeat:0,endBeat:2,x:1}]};
  same(await stored({...v2Timing,...full}),{...v2Timing,version:2,beatsPerBar:7,barsPattern:[4,4,8,16],patternHold:true,tempoMap:[{at:2,bpm:140},{at:9.5,bpm:90}],script:[{ordinal:0,preset:hash},{ordinal:5,preset:hashB}],intervals:[interval,{id:'b_2-a',startBeat:0,endBeat:2}]},'every v2 field is kept with only its known keys');
  same(await stored({...v2Timing,barsPattern:Array(64).fill(128),tempoMap:Array.from({length:256},(_,i)=>({at:2+i,bpm:400})),script:Array.from({length:1024},(_,i)=>({ordinal:i,preset:hash})),intervals:Array.from({length:64},(_,i)=>({id:`i${i}`,startBeat:i,endBeat:1e7}))}).then(t=>t&&[t.barsPattern.length,t.tempoMap.length,t.script.length,t.intervals.length]),[64,256,1024,64],'documented maxima are accepted');
  for(const bad of [{beatsPerBar:0},{beatsPerBar:17},{beatsPerBar:3.5},{beatsPerBar:null},{barsPattern:[]},{barsPattern:Array(65).fill(1)},{barsPattern:[0]},{barsPattern:[129]},{barsPattern:[1.5]},{patternHold:1},{patternHold:null},
    {tempoMap:[]},{tempoMap:[{at:1,bpm:140}]},{tempoMap:[{at:3,bpm:140},{at:2,bpm:150}]},{tempoMap:[{at:2,bpm:140},{at:2,bpm:150}]},{tempoMap:[{at:1e6+1,bpm:100}]},{tempoMap:[{at:2,bpm:19.9}]},{tempoMap:[{at:2,bpm:400.1}]},{tempoMap:[{at:'2',bpm:100}]},{tempoMap:Array.from({length:257},(_,i)=>({at:2+i,bpm:120}))},
    {script:[{ordinal:2,preset:hash},{ordinal:2,preset:hashB}]},{script:[{ordinal:3,preset:hash},{ordinal:2,preset:hashB}]},{script:[{ordinal:-1,preset:hash}]},{script:[{ordinal:1,preset:'ABC'}]},{script:Array.from({length:1025},(_,i)=>({ordinal:i,preset:hash}))},
    {intervals:[interval,interval]},{intervals:[{...interval,id:'Chorus'}]},{intervals:[{...interval,id:''}]},{intervals:[{...interval,id:'x'.repeat(33)}]},{intervals:[{...interval,startBeat:-1}]},{intervals:[{...interval,startBeat:48}]},{intervals:[{...interval,endBeat:1e7+1}]},{intervals:Array.from({length:65},(_,i)=>({id:`i${i}`,startBeat:i,endBeat:i+1}))}])
    same(await stored({...v2Timing,...bad}),null,`rejected: ${JSON.stringify(bad).slice(0,80)}`);
  same(await stored({...v2Timing,offsetSeconds:-5,tempoMap:[{at:-4,bpm:100}]}).then(t=>t&&t.tempoMap),[{at:-4,bpm:100}],'tempoMap entries need only be after the offset');
  await post({op:'save-setups',setups:[setup]});
  await post({op:'save-setups',setups:[setup]});
  for(const invalid of [[setup,setup],[{...setup,presets:[hash,hash]}],Array(101).fill(setup),[{...setup,timing:{...setup.timing,bpm:NaN}}]]) {
    same((await post({op:'save-setups',setups:invalid})).type,'library-error');
  }
  same((await post({op:'load-setups'})).setups,[{...setup,name:'Test'}]);
  for(const headers of [{Origin:'http://evil.invalid'},{Host:`evil.invalid:${port}`,Origin:`http://evil.invalid:${port}`},{Origin:'null'},{'Sec-Fetch-Site':'cross-site'}])same((await request({op:'load-settings'},headers)).status,403);
  same((await request('{}',{},'/api/aaavs/library','GET')).status,405);
  same((await request('{')).status,400);
  same((await request({op:'load-settings'},{'Content-Type':'text/plain'})).status,400);
  same((await request('x'.repeat(4*1024*1024+1))).status,400);
  for(const path of ['/avs%20presets/.aaavs-private/settings.json','/avs%20presets/.AAAVS-PRIVATE/setups.json','/avs%20presets/.aaavs-private./settings.json','/avs%20presets/catalog/presets.json.writing','/avs%20presets/setups.json'])same((await request('',{},path,'GET')).status,404);
  await symlink(join(collection,'.aaavs-private'),join(root,'state-alias'),'junction');
  same((await request('',{},'/state-alias/settings.json','GET')).status,404);
  same((await request('',{},'/index.html','GET')).status,418);
  const preserved=await readCatalog();
  for(const badPath of ['presets/unique/../../outside.avs','presets/unique/C:evil.avs','presets/unique/%2e%2e/evil.avs','presets/unique/evil.exe']) {
    await writeFile(catalogPath,JSON.stringify({presets:[{...preserved.presets[0],canonical_path:badPath}]}));
    same((await post({op:'set-not-working',hash,notWorking:true})).type,'library-error');
  }
  await writeFile(catalogPath,JSON.stringify({presets:[preserved.presets[0],preserved.presets[0]]}));
  same((await post({op:'rate',hash,rating:1})).type,'library-error');
  await writeFile(catalogPath,JSON.stringify(preserved));
  const outside=join(root,'outside');await mkdir(outside);await writeFile(join(outside,'escape.avs'),bytes);
  await symlink(outside,join(presetDir,'linked'),'junction');
  await writeFile(catalogPath,JSON.stringify({presets:[{...preserved.presets[0],canonical_path:'presets/unique/linked/escape.avs'}]}));
  same((await post({op:'rate',hash,rating:1})).type,'library-error');same(await readFile(join(outside,'escape.avs')),bytes);
  await writeFile(catalogPath,JSON.stringify(preserved));
  // HUD manifests (.hud) rate and mark exactly like AVS and NERV files; other extensions and traversal stay rejected.
  const hudBytes=Buffer.from('{"format":"fixture-hud"}'), hudHash=createHash('sha256').update(hudBytes).digest('hex');
  await writeFile(join(presetDir,'duel.hud'),hudBytes);
  await writeFile(catalogPath,JSON.stringify({presets:[{sha256:hudHash,bytes:hudBytes.length,canonical_path:'presets/unique/duel.hud',kind:'hud',display_name:'Duel'}]}));
  const hudRated=await post({op:'rate',hash:hudHash,rating:3});
  same(hudRated.type,'rating-saved');same(hudRated.entry.canonical_path,'presets/unique/duel [3 stars].hud');
  same(await readFile(join(presetDir,'duel [3 stars].hud')),hudBytes);
  same((await post({op:'set-not-working',hash:hudHash,notWorking:true})).entry.notWorking,true);
  same((await readCatalog()).presets[0].kind,'hud');
  for(const badPath of ['presets/unique/duel.hud.exe','presets/unique/duel.huds','presets/unique/../duel.hud','presets/other/duel.hud']) {
    await writeFile(catalogPath,JSON.stringify({presets:[{sha256:hudHash,bytes:hudBytes.length,canonical_path:badPath}]}));
    same((await post({op:'set-not-working',hash:hudHash,notWorking:true})).type,'library-error',badPath);
  }
  await writeFile(catalogPath,JSON.stringify(preserved));
  // Private page state (folders.json, stats.json): whitelisted names under .aaavs-private, atomic, bounded, shallow validation.
  const privateDir=join(collection,'.aaavs-private');
  same(await post({op:'load-state',name:'folders'}),{type:'state-loaded',name:'folders',data:null},'a missing state file is null');
  const folderState={version:1,rev:3,folders:[{id:'f1',name:'Late · night',parent:null,kind:'manual',presets:[hash,hashB],sort:[{key:'manual',dir:'asc'}],created:1790000000000},
    {id:'f2',name:'Fast',parent:'f1',kind:'smart',query:'rating:>=3',scope:null,sort:[],created:1}],
    playback:{'avs/src/c:visbot-legacy/a:tuggummi':{recursive:true,sort:[{key:'path',dir:'asc'}],settings:{...custom,transition:32},timing:{enabled:false,bpm:120,offsetSeconds:0,barsPerScene:8,seed:1}},'avs/newer':{opaque:{future:true}}},
    last:{key:'avs',recursive:true},ui:{expanded:['avs','avs/src'],selected:'avs',sort:[{key:'name',dir:'asc'}],scopeAll:false},futureField:{a:1}};
  same(await post({op:'save-state',name:'folders',data:folderState}),{type:'state-saved',name:'folders'});
  same(await post({op:'load-state',name:'folders'}),{type:'state-loaded',name:'folders',data:folderState},'state round-trips unchanged, unknown fields included');
  same(JSON.parse(await readFile(join(privateDir,'folders.json'),'utf8')),folderState);
  await assert.rejects(stat(join(collection,'folders.json')),{code:'ENOENT'});checks++;
  await assert.rejects(stat(join(privateDir,'folders.json.writing')),{code:'ENOENT'});checks++;
  const statsState={version:1,plays:{[hash]:[3,1790000000000],[hashB]:[1,0]}};
  same(await post({op:'save-state',name:'stats',data:statsState}),{type:'state-saved',name:'stats'});
  same((await post({op:'load-state',name:'stats'})).data,statsState);
  same((await post({op:'load-state',name:'folders'})).data,folderState,'the two state files are independent');
  const rejectState=async(request,message)=>{const r=await post(request);same(r.type,'library-error',message);same(r.operation,request.op,message);};
  for(const name of ['setups','settings','catalog/presets','..\\folders','../folders','folders.json','Folders','',null,undefined,7,['folders'],{}]) {
    await rejectState({op:'load-state',name},`load-state name ${JSON.stringify(name)}`);
    await rejectState({op:'save-state',name,data:folderState},`save-state name ${JSON.stringify(name)}`);
  }
  for(const data of [undefined,null,[],'x',7,{},{version:0},{version:'1'},{version:1.5},{version:-1}]) await rejectState({op:'save-state',name:'folders',data},`invalid body ${JSON.stringify(data)}`);
  const many=Array.from({length:201},(_,i)=>({id:`f${i}`,name:'x',kind:'manual'}));
  const shapes={
    tooManyFolders:{version:1,folders:many},badFolder:{version:1,folders:[null]},noId:{version:1,folders:[{name:'x'}]},longName:{version:1,folders:[{id:'a',name:'x'.repeat(121)}]},longId:{version:1,folders:[{id:'a'.repeat(101),name:'x'}]},
    badHash:{version:1,folders:[{id:'a',name:'x',presets:['nope']}]},upperHash:{version:1,folders:[{id:'a',name:'x',presets:[hash.toUpperCase()]}]},tooManyMembers:{version:1,folders:[{id:'a',name:'x',presets:Array(5001).fill(hash)}]},
    totalMembers:{version:1,folders:Array.from({length:7},(_,i)=>({id:`m${i}`,name:'x',presets:Array(5000).fill(hash)}))},
    longQuery:{version:1,folders:[{id:'a',name:'x',query:'q'.repeat(401)}]},playbackArray:{version:1,playback:[]},playbackKey:{version:1,playback:{['k'.repeat(401)]:{}}},
    playbackCount:{version:1,playback:Object.fromEntries(Array.from({length:301},(_,i)=>[`k${i}`,{}]))},lastKey:{version:1,last:{key:7}},uiExpanded:{version:1,ui:{expanded:Array(301).fill('a')}},uiSelected:{version:1,ui:{selected:7}},
  };
  for(const [label,data] of Object.entries(shapes)) await rejectState({op:'save-state',name:'folders',data},`folders shape ${label}`);
  for(const [label,data] of Object.entries({playsArray:{version:1,plays:[]},playsKey:{version:1,plays:{nope:[1,1]}},playsValue:{version:1,plays:{[hash]:[1]}},playsNegative:{version:1,plays:{[hash]:[-1,0]}},playsString:{version:1,plays:{[hash]:['1',0]}},
    playsCount:{version:1,plays:Object.fromEntries(Array.from({length:20001},(_,i)=>[i.toString(16).padStart(64,'0'),[1,1]]))}})) await rejectState({op:'save-state',name:'stats',data},`stats shape ${label}`);
  same((await post({op:'load-state',name:'folders'})).data,folderState,'rejected writes leave the saved file untouched');
  // Size: under the 4 MiB request cap but over STATE_MAX_BYTES is refused by the state limit, not by the transport.
  const oversize={version:1,folders:[{id:'a',name:'x',presets:[]}],ui:{selected:'ok'},filler:'z'.repeat(3670016)};
  const oversized=await request({op:'save-state',name:'folders',data:oversize});
  same(oversized.status,400);same(oversized.data.type,'library-error');same(oversized.data.operation,'save-state');
  const nearLimit={version:1,filler:'z'.repeat(3670016-64)};
  same((await post({op:'save-state',name:'stats',data:nearLimit})).type,'state-saved','a state just under STATE_MAX_BYTES is accepted');
  await writeFile(join(privateDir,'stats.json'),'{"version":1,"plays":');
  await rejectState({op:'load-state',name:'stats'},'a corrupt file is reported, not reset');
  await writeFile(join(privateDir,'stats.json'),JSON.stringify({version:1,plays:{bad:[1,1]}}));
  await rejectState({op:'load-state',name:'stats'},'a file that fails shallow validation is reported');
  await writeFile(join(privateDir,'stats.json'),JSON.stringify({version:1,filler:'z'.repeat(3670016)}));
  await rejectState({op:'load-state',name:'stats'},'an oversized file is reported');
  await post({op:'save-state',name:'stats',data:statsState});
  await writeFile(join(privateDir,'folders.json.writing'),'occupied');
  await rejectState({op:'save-state',name:'folders',data:folderState},'a leftover transaction file fails the write');
  same(await readFile(join(privateDir,'folders.json.writing'),'utf8'),'occupied');await rm(join(privateDir,'folders.json.writing'));
  same((await post({op:'load-state',name:'folders'})).data,folderState,'a failed write keeps the previous state');
  // Pathological nesting is an ordinary error, never a crash, and the server keeps serving afterwards.
  const nested=`{"op":"save-state","name":"folders","data":{"version":1,"x":${'['.repeat(200000)}${']'.repeat(200000)}}}`;
  const deep=await request(nested);check(deep.status===400||deep.status===200,'deep nesting is answered');
  if(deep.status===200)same(deep.data.type,'state-saved');else same(deep.data.type,'library-error');
  same((await post({op:'load-state',name:'folders'})).type,'state-loaded','the server survives deep nesting');
  const before2=(await post({op:'load-state',name:'folders'})).data;
  // A prototype-polluting body cannot reach the stored object.
  same((await request('{"op":"save-state","name":"folders","data":{"version":1,"__proto__":{"polluted":true},"constructor":{"prototype":{"polluted":true}}}}')).status,200);
  check(({}).polluted===undefined,'Object.prototype stays clean');
  await post({op:'save-state',name:'folders',data:before2??folderState});
  // State never becomes a static asset.
  for(const path of ['/avs%20presets/folders.json','/avs%20presets/stats.json','/avs%20presets/FOLDERS.JSON','/avs%20presets/.aaavs-private/folders.json','/avs%20presets/.aaavs-private/stats.json.writing'])same((await request('',{},path,'GET')).status,404,path);
  // Concurrent saves are serialised; the last request wins and the file is always whole.
  const rounds=await Promise.all([1,2,3,4,5].map(rev=>post({op:'save-state',name:'folders',data:{...folderState,rev}})));
  check(rounds.every(r=>r.type==='state-saved'));same((await post({op:'load-state',name:'folders'})).data.rev,5);
  // Everything the page serialises must be accepted (no third copy of the semantic rules). The folder store is BRW's; use it when present.
  const storePath=fileURLToPath(new URL('../src/mpc-folder-store.ts',import.meta.url));
  let storeModule=null;try{await stat(storePath);storeModule=await import(`data:text/javascript;base64,${Buffer.from((await build({entryPoints:[storePath],bundle:true,format:'esm',platform:'node',target:'es2022',write:false,logLevel:'silent'})).outputFiles[0].text).toString('base64')}`);}catch{storeModule=null;}
  if(storeModule?.serializeFolderState&&storeModule?.parseFolderState){
    // Whatever the page can serialise, up to its own documented maxima, must be accepted; the server has no semantic rules of its own.
    const viaPage=state=>JSON.parse(JSON.stringify(storeModule.serializeFolderState(storeModule.parseFolderState(JSON.parse(JSON.stringify(state))))));
    const roundTrip=viaPage(folderState);
    same((await post({op:'save-state',name:'folders',data:roundTrip})).type,'state-saved','server accepts the page serialisation');
    same((await post({op:'load-state',name:'folders'})).data,roundTrip);
    same((await post({op:'save-state',name:'folders',data:viaPage({version:1})})).type,'state-saved','server accepts an empty page state');
    const hashOf=i=>i.toString(16).padStart(64,'0');
    const maximal={version:1,rev:9007199254740991,
      folders:Array.from({length:200},(_,i)=>i<6?{id:`m${i}`,name:'n'.repeat(120),parent:null,kind:'manual',presets:Array.from({length:5000},(_,j)=>hashOf(i*5000+j)),created:1790000000000+i}
        :{id:`s${i}`,name:`Smart ${i}`,parent:null,kind:'smart',query:'q'.repeat(400),scope:null,sort:[{key:'name',dir:'asc'},{key:'rating',dir:'desc'},{key:'path',dir:'asc'}],created:1790000000000+i}),
      playback:Object.fromEntries(Array.from({length:300},(_,i)=>[`avs/${'k'.repeat(300)}${i}`,{recursive:i%2===0,sort:[{key:'path',dir:'asc'}],settings:{...custom,transition:i%33},timing:{enabled:false,bpm:120,offsetSeconds:0,barsPerScene:8,seed:1}}])),
      last:{key:'avs',recursive:true},ui:{expanded:Array.from({length:300},(_,i)=>`avs/${'e'.repeat(300)}${i}`),selected:'avs',sort:[],scopeAll:true}};
    const maximalPage=viaPage(maximal);
    check(Buffer.byteLength(JSON.stringify(maximalPage))<3670016,'the page maximum fits STATE_MAX_BYTES');
    same((await post({op:'save-state',name:'folders',data:maximalPage})).type,'state-saved','server accepts the page maximum');
    same((await post({op:'load-state',name:'folders'})).data.folders.length,200);
  } else console.log('PENDING: mpc-folder-store.ts is not present yet; the server-accepts-page-output check runs when BRW lands it.');
  try{
    const statsPath=fileURLToPath(new URL('../src/mpc-folder-stats.ts',import.meta.url));
    await stat(statsPath);
    const stats=await import(`data:text/javascript;base64,${Buffer.from((await build({entryPoints:[statsPath],bundle:true,format:'esm',platform:'node',target:'es2022',write:false,logLevel:'silent'})).outputFiles[0].text).toString('base64')}`);
    const tracked=stats.emptyStats();tracked.plays.set(hash,[3,1790000000000]);tracked.plays.set(hashB,[65535,0]);
    const page=JSON.parse(JSON.stringify(stats.serializeStats(tracked)));
    same((await post({op:'save-state',name:'stats',data:page})).type,'state-saved','server accepts the page stats serialisation');
    same((await post({op:'load-state',name:'stats'})).data,page);
  }catch(error){if(error instanceof assert.AssertionError)throw error;console.log('PENDING: mpc-folder-stats.ts is not loadable yet; the stats serialisation check runs in Wave 2.');}
  // The stats file at its documented maximum (20,000 entries) is accepted; one more is refused (checked above).
  const maxStats={version:1,plays:Object.fromEntries(Array.from({length:20000},(_,i)=>[i.toString(16).padStart(64,'0'),[i,1790000000000+i]]))};
  same((await post({op:'save-state',name:'stats',data:maxStats})).type,'state-saved','the stats maximum is accepted');
  await post({op:'save-state',name:'folders',data:folderState});
  // Data remains valid when a fresh handler is constructed (process-local state is not authority).
  handler=createLibraryHandler(root);
  same(await post({op:'load-settings'}),{type:'settings',...custom});
  same((await post({op:'load-setups'})).setups,[{...setup,name:'Test'}]);
  same(JSON.parse(await readFile(join(collection,'.aaavs-private','settings.json'),'utf8')),custom);
  console.log(`Standalone library CPU checks passed (${checks} assertions).`);
} finally {
  await new Promise(resolve=>server.close(resolve));
  // Only this test's freshly-created temporary directory is removed.
  check(root.startsWith(join(tmpdir(),'aaavs-library-')),'Temporary root must remain within the test prefix');
  await rm(root,{recursive:true,force:true});
}
