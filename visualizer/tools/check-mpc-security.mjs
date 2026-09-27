import { build } from 'esbuild';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { execFileSync } from 'node:child_process';
import { webcrypto } from 'node:crypto';
globalThis.crypto ??= webcrypto;
async function load(path) { const r = await build({ entryPoints:[path],bundle:true,format:'esm',write:false }); return import(`data:text/javascript;base64,${Buffer.from(r.outputFiles[0].text).toString('base64')}`); }
const { parseLocalAvsCatalog, fetchLocalAvsPreset } = await load('src/avs/local-collection.ts');
const { localAssetUrl, boundedBytes } = await load('src/avs/local-assets.ts');
const base = 'https://aaavs.invalid/mpc.html';
for (const path of ['../dist/mpc-host.js','presets/unique/../x','presets/unique/%2e%2e/x','presets/unique/a\\b','https://other/x']) assert.throws(()=>localAssetUrl(path,'presets',base));
assert.equal(localAssetUrl('presets/unique/a b.avs','presets',base),'https://aaavs.invalid/avs%20presets/presets/unique/a%20b.avs');
const payload = new Uint8Array([1,2,3,4]);
const digest = Buffer.from(await crypto.subtle.digest('SHA-256',payload)).toString('hex');
const row={sha256:digest.toUpperCase(),bytes:4,display_name:'fixture',canonical_path:'presets/unique/test.avs'};
const preset=parseLocalAvsCatalog({presets:[row]},{results:[]},base)[0];
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
globalThis.fetch=async url=>{
 const path=String(url);
 if(path.endsWith('/presets.json'))return Response.json({presets:[{sha256:digest,canonical_path:'presets/unique/test.avs',occurrences:[occurrence]}]});
 if(path.endsWith('/dependencies.json'))return Response.json({dependencies:[{sha256:bitmapHash,canonical_path:'dependencies/unique/test.bmp',type:'bmp',occurrences:[occurrence]}]});
 return new Response(valid);
};
assert.equal((await loadPresetBitmaps(digest)).length,1);
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
