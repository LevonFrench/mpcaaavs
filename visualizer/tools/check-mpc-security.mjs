import { build } from 'esbuild';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { execFileSync } from 'node:child_process';
import { webcrypto } from 'node:crypto';
globalThis.crypto ??= webcrypto;
async function load(path) { const r = await build({ entryPoints:[path],bundle:true,format:'esm',write:false }); return import(`data:text/javascript;base64,${Buffer.from(r.outputFiles[0].text).toString('base64')}`); }
const { parseLocalAvsCatalog, fetchLocalAvsPreset, isSceneKind } = await load('src/avs/local-collection.ts');
const { localAssetUrl, boundedBytes } = await load('src/avs/local-assets.ts');
const base = 'https://aaavs.invalid/mpc.html';
for (const path of ['../dist/mpc-host.js','presets/unique/../x','presets/unique/%2e%2e/x','presets/unique/a\\b','https://other/x']) assert.throws(()=>localAssetUrl(path,'presets',base));
assert.equal(localAssetUrl('presets/unique/a b.avs','presets',base),'https://aaavs.invalid/avs%20presets/presets/unique/a%20b.avs');
const payload = new Uint8Array([1,2,3,4]);
const digest = Buffer.from(await crypto.subtle.digest('SHA-256',payload)).toString('hex');
const row={sha256:digest.toUpperCase(),bytes:4,display_name:'fixture',canonical_path:'presets/unique/test.avs'};
const preset=parseLocalAvsCatalog({presets:[row]},{results:[]},base)[0];
assert.equal(preset.notWorking,false,'legacy catalog presets are not marked broken');
for(const notWorking of [false,true]){const parsed=parseLocalAvsCatalog({presets:[{...row,notWorking,rating:4}]},{results:[]},base)[0];assert.equal(parsed.notWorking,notWorking);assert.equal(parsed.rating,4);assert.equal(parsed.autoEligible,true,'a user flag does not prevent manual retesting');}
for(const notWorking of [0,1,'true',null,{}])assert.throws(()=>parseLocalAvsCatalog({presets:[{...row,notWorking}]},{results:[]},base),/Invalid local AVS catalog entry/);
// HUD rows (contract 2.2.5, C-17/C-18): kind, extension, canvas and folder rules on a synthetic row.
const hudRow={sha256:'e'.repeat(64),bytes:4,display_name:'HUD fixture',canonical_path:'presets/unique/HUD Fixture.hud',kind:'hud',folder:'Showcase/Duel',hud:{id:'fixture-duel',pack:'showcase',family:'fighting',tags:['pixel','amber'],tier:'tuned',order:3,canvas:{style:'pixel',w:384,h:224,par:[1,1]}}};
const parseHud=row=>parseLocalAvsCatalog({presets:[row]},{results:[]},base)[0];
const hud=parseHud(hudRow);
assert.equal(hud.kind,'hud');assert.equal(hud.folder,'Showcase/Duel');assert.equal(hud.scene,undefined);assert.equal(hud.autoEligible,true);assert.equal(hud.fileName,'HUD Fixture.hud');
assert.deepEqual(hud.hud,{id:'fixture-duel',pack:'showcase',family:'fighting',tags:['pixel','amber'],tier:'tuned',order:3,canvas:{style:'pixel',w:384,h:224,par:[1,1]}});
assert.ok(Object.isFrozen(hud)&&Object.isFrozen(hud.hud)&&Object.isFrozen(hud.hud.tags)&&Object.isFrozen(hud.hud.canvas)&&Object.isFrozen(hud.hud.canvas.par),'HUD metadata is frozen');
assert.equal(parseHud({...hudRow,hud:{...hudRow.hud,canvas:{style:'vector',w:960,h:540}}}).hud.canvas.par,undefined,'par is optional');
assert.equal(isSceneKind(hud),true);assert.equal(isSceneKind({kind:'nerv'}),true);assert.equal(isSceneKind({kind:'avs'}),false);assert.equal(isSceneKind({}),false);assert.equal(isSceneKind(null),false);assert.equal(isSceneKind(undefined),false);
assert.ok(!('hud' in preset)&&!('folder' in preset),'legacy AVS rows gain no hud or folder keys');
assert.equal(parseHud({...row,kind:'weird'}).kind,'avs','unknown kinds still parse as AVS');
assert.equal(parseHud({...row,folder:'Collections/Set'}).folder,'Collections/Set','any kind may carry a folder hint');
const dot=String.fromCharCode(0xb7);
assert.equal(parseHud({...hudRow,folder:`Arcade ${dot} Fighting/Duel`}).folder,`Arcade ${dot} Fighting/Duel`,'printable non-ASCII is allowed in a folder hint');
assert.equal(parseHud({...hudRow,folder:'a/b/c/d/e/f'}).folder,'a/b/c/d/e/f','six segments are allowed');
assert.equal(parseHud({...hudRow,folder:'x'.repeat(80)}).folder,'x'.repeat(80),'80 characters are allowed');
for(const folder of [7,'','/a','a/','a//b','a/'+'x'.repeat(81),'a/b/c/d/e/f/g','a/'+String.fromCharCode(7)+'b','a'+String.fromCharCode(0x2028)+'b','a'+String.fromCharCode(0x85)+'b',{},null,['a']])assert.equal(parseHud({...hudRow,folder}).folder,undefined,`invalid folder hint ${JSON.stringify(folder)} is dropped, not thrown`);
assert.deepEqual([...parseHud({...hudRow,hud:{...hudRow.hud,tags:['ok','x'.repeat(25),3,'',...Array(20).fill('t')]}}).hud.tags],['ok',...Array(7).fill('t')],'tags are sanitised and capped at eight');
assert.deepEqual([...parseHud({...hudRow,hud:{...hudRow.hud,tags:'pixel'}}).hud.tags],[]);
const goodHud=hudRow.hud;
for(const bad of [
  {canonical_path:'presets/unique/x.avs'},{canonical_path:'presets/unique/x.nerv'},{canonical_path:'presets/unique/x.HUD'},
  {hud:undefined},{hud:null},{hud:[]},{hud:'x'},
  {hud:{...goodHud,tier:'gold'}},{hud:{...goodHud,tier:undefined}},{hud:{...goodHud,order:1.5}},{hud:{...goodHud,order:'1'}},
  {hud:{...goodHud,id:''}},{hud:{...goodHud,id:7}},{hud:{...goodHud,pack:'x'.repeat(81)}},{hud:{...goodHud,family:undefined}},{hud:{...goodHud,pack:'a'+String.fromCharCode(0)+'b'}},
  {hud:{...goodHud,canvas:undefined}},{hud:{...goodHud,canvas:[]}},{hud:{...goodHud,canvas:{...goodHud.canvas,style:'raster'}}},
  {hud:{...goodHud,canvas:{...goodHud.canvas,w:63}}},{hud:{...goodHud,canvas:{...goodHud.canvas,w:1921}}},{hud:{...goodHud,canvas:{...goodHud.canvas,h:224.5}}},{hud:{...goodHud,canvas:{...goodHud.canvas,h:'224'}}},
  {hud:{...goodHud,canvas:{...goodHud.canvas,par:[0,1]}}},{hud:{...goodHud,canvas:{...goodHud.canvas,par:[1,17]}}},{hud:{...goodHud,canvas:{...goodHud.canvas,par:[1]}}},{hud:{...goodHud,canvas:{...goodHud.canvas,par:'1:1'}}},
])assert.throws(()=>parseHud({...hudRow,...bad}),/Invalid HUD/,`malformed HUD row ${JSON.stringify(bad).slice(0,80)}`);
globalThis.fetch=async()=>new Response(payload);
assert.equal((await fetchLocalAvsPreset(preset)).length,4);
await assert.rejects(fetchLocalAvsPreset({...preset,sha256:'0'.repeat(64)}),/SHA-256/);
await assert.rejects(fetchLocalAvsPreset({...preset,bytes:3}),/budget/);
await assert.rejects(fetchLocalAvsPreset({...preset,bytes:5}),/size mismatch/);
await assert.rejects(boundedBytes('fixture',3),/budget/);
globalThis.fetch=async()=>new Response(payload,{headers:{'content-length':'100'}});
await assert.rejects(boundedBytes('fixture',3),/budget/);
const {decodeAvsBmp,createAvsBitmapResolver}=await load('src/avs/effects/bitmap-assets.ts');
function bmp(w,h,length=54){const b=new Uint8Array(length),v=new DataView(b.buffer);b[0]=66;b[1]=77;v.setUint32(10,54,true);v.setUint32(14,40,true);v.setInt32(18,w,true);v.setInt32(22,h,true);v.setUint16(26,1,true);v.setUint16(28,24,true);return b;}
const RealUint32=globalThis.Uint32Array;let allocations=0;
globalThis.Uint32Array=class {constructor(){allocations++;throw Error('allocation reached')}};
try{assert.throws(()=>decodeAvsBmp(bmp(65536,65536)),/budget/);assert.throws(()=>decodeAvsBmp(bmp(10,10)),/Truncated/);const rle=bmp(65536,65536);new DataView(rle.buffer).setUint32(30,1,true);new DataView(rle.buffer).setUint16(28,8,true);assert.throws(()=>decodeAvsBmp(rle),/budget/);assert.equal(allocations,0);}finally{globalThis.Uint32Array=RealUint32;}
const valid=bmp(1,1,58);valid[54]=255;
assert.equal(decodeAvsBmp(valid).pixels[0],255);
const resolver=createAvsBitmapResolver(new Map([['a.bmp',new Uint8Array(valid.buffer)],['b.bmp',new Uint8Array(valid.buffer)]]));assert.equal(resolver('a.bmp'),resolver('b.bmp'));
// Optional local metadata compatibility check; does not execute any preset or worker.
try{const catalog=JSON.parse(await readFile('avs presets/catalog/presets.json','utf8'));const validation=JSON.parse(await readFile('avs presets/catalog/parser-validation.json','utf8'));assert.equal(parseLocalAvsCatalog(catalog,validation,base).length,catalog.presets.length);}catch(e){if(e.code!=='ENOENT')throw e;}
const {loadPresetBitmaps}=await load('src/mpc-bitmap-dependencies.ts');
const bitmapHash=Buffer.from(await crypto.subtle.digest('SHA-256',valid)).toString('hex');
const occurrence={package_id:'pack',original_path:'fixture.bmp'};
const legacy={sha256:digest,canonical_path:'presets/unique/test.avs',occurrences:[occurrence]};
const nerv={sha256:'a'.repeat(64),canonical_path:'presets/unique/NERV 01 - Boot.nerv',kind:'nerv',scene:'boot'};
const dependency={sha256:bitmapHash,canonical_path:'dependencies/unique/test.bmp',type:'bmp',occurrences:[occurrence]};
const hudRecord={sha256:'e'.repeat(64),canonical_path:'presets/unique/HUD Fixture.hud',kind:'hud'};
let fixturePresets=[legacy,nerv,hudRecord], fixtureDependencies=[dependency], bitmapRequests=0;
globalThis.fetch=async url=>{
 const path=String(url);
 if(path.endsWith('/presets.json'))return Response.json({presets:fixturePresets});
 if(path.endsWith('/dependencies.json'))return Response.json({dependencies:fixtureDependencies});
 assert.ok(path.endsWith('/dependencies/unique/test.bmp'),'only the package bitmap may be requested');bitmapRequests++;
 return new Response(valid);
};
// Mixed catalogs must not relax legacy origin validation or let manifest entries
// bypass the shared path/hash boundaries. Failed metadata loads must remain retryable.
for(const malformed of [
 {...legacy,occurrences:undefined}, {...legacy,occurrences:{}},
 {...legacy,occurrences:[{...occurrence,original_path:42}]}, {...legacy,occurrences:Array(1025).fill(occurrence)},
 {...nerv,sha256:'bad'}, {...nerv,canonical_path:'presets/unique/../escape.nerv'},
 {...nerv,canonical_path:'presets/unique/NERV.avs'}, {...nerv,scene:'unknown'},
 {...hudRecord,sha256:'bad'}, {...hudRecord,canonical_path:'presets/unique/../escape.hud'}, {...hudRecord,canonical_path:'presets/unique/HUD.avs'},
]){
 fixturePresets=[malformed];await assert.rejects(loadPresetBitmaps(digest),/Invalid/);
}
fixturePresets=[legacy,nerv,hudRecord];
for(const malformed of [{...dependency,occurrences:undefined},{...dependency,occurrences:[null]},{...dependency,kind:'nerv',scene:'boot',occurrences:undefined}]){
 fixtureDependencies=[malformed];await assert.rejects(loadPresetBitmaps(digest),/Invalid dependency record/);
}
assert.equal(bitmapRequests,0,'invalid metadata must not load bitmap bytes');
fixtureDependencies=[dependency];
const aliases=await loadPresetBitmaps(digest);
assert.equal(aliases.length,1);assert.equal(aliases[0].name,occurrence.original_path);
assert.deepEqual(new Uint8Array(aliases[0].bytes),valid,'legacy package bitmap survives a mixed AVS/NERV catalog');
assert.equal(bitmapRequests,1);
assert.deepEqual(await loadPresetBitmaps(nerv.sha256),[],'NERV manifests have no AVS bitmap package');
assert.equal(bitmapRequests,1,'NERV bitmap lookup requests no assets');
assert.deepEqual(await loadPresetBitmaps(hudRecord.sha256),[],'HUD manifests have no AVS bitmap package and never break bitmap parsing');
assert.equal(bitmapRequests,1,'HUD bitmap lookup requests no assets');
console.log('Mixed AVS/NERV/HUD catalog: legacy bitmap bytes, manifest isolation, HUD metadata/folder validation, malformed origin/path/hash guards PASS');
// Decode the available local BMP corpus without workers or GPU to preserve compatibility.
try {
 const data=JSON.parse(await readFile('avs presets/catalog/dependencies.json','utf8'));
 const baseline=execFileSync('git',['show','c83afe96bfe5dc543b60a69e8b05477b403c8acc:visualizer/src/avs/effects/bitmap-assets.ts'],{encoding:'utf8'});
 const compiled=await build({stdin:{contents:baseline,loader:'ts'},format:'esm',write:false});
 const old=await import(`data:text/javascript;base64,${Buffer.from(compiled.outputFiles[0].text).toString('base64')}`);
 let count=0, unchangedFailures=0;
 for(const entry of data.dependencies){localAssetUrl(entry.canonical_path,'dependencies',base);if(entry.type==='bmp'){const bytes=new Uint8Array(await readFile('avs presets/'+entry.canonical_path));let previous;try{previous=old.decodeAvsBmp(bytes);}catch{};if(previous){const current=decodeAvsBmp(bytes);assert.equal(current.width,previous.width);assert.equal(current.height,previous.height);assert.deepEqual(current.pixels,previous.pixels);count++;}else{unchangedFailures++;}}}
 console.log(`Local BMP CPU decode compatibility: ${count} files unchanged PASS (${unchangedFailures} baseline-unsupported files)`);
}catch(e){if(e.code!=='ENOENT')throw e;}
console.log('Local asset boundaries: traversal, byte budgets, preset digests, BMP allocation guards, alias deduplication PASS');
