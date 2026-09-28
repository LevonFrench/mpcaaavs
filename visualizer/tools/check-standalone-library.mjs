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
  const parityCases=[undefined,null,{},[],[setup],[{...setup,timing:undefined}],[{...setup,id:''}],[{...setup,id:'x'.repeat(101)}],[{...setup,name:'   '}],[{...setup,name:'x'.repeat(121)}],[setup,setup],[{...setup,presets:[hash,hash]}],[{...setup,presets:['z'.repeat(64)]}],Array(101).fill(setup)];
  for(const [key,values] of Object.entries({bars:[-1,0,2,3,4,8,12,16],beats:[-1,0,1,2,3,4,5],transition:[-1,0,15,16,1.5],durationMs:[249,250,8000,8001,250.5],minimumRating:[undefined,null,-1,0,5,6,1.5],enabled:[true,false,0,'true'],shuffle:[true,false,0],keepOld:[true,false,null],manualFade:[true,false,1],autoFade:[true,false,'false']})) {
    for(const value of values) parityCases.push([{...setup,settings:{...custom,[key]:value}}]);
  }
  for(const [key,values] of Object.entries({bpm:[19.9,20,400,400.1,'120',null],offsetSeconds:[-3601,-3600,3600,3601],barsPerScene:[0,1,128,129,1.5],seed:[-1,0,0xffffffff,0x100000000,1.5],enabled:[true,false,0]})) {
    for(const value of values) parityCases.push([{...setup,timing:{...setup.timing,[key]:value}}]);
  }
  for(const input of parityCases) {
    // Match the JSON boundary, including omitted optional fields.
    const value=input===undefined?undefined:JSON.parse(JSON.stringify(input));
    let expected,accepted=true;try{expected=parseSetups(value);}catch{accepted=false;}
    const result=await post({op:'save-setups',setups:value});
    same(result.type,accepted?'setups-saved':'library-error','Shared setup validation parity');
    if(accepted)same((await post({op:'load-setups'})).setups,expected,'Shared setup normalization parity');
  }
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
