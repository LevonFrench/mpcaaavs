import assert from 'node:assert/strict';
import {createHash} from 'node:crypto';
import {build} from 'esbuild';

// Exercise the actual legacy source adapter with a mixed catalog; no private
// collection, browser, IndexedDB or historical bitmap assets are needed.
const result = await build({entryPoints:['src/avs/preset-sources.ts'],bundle:true,format:'esm',write:false,
  plugins:[{name:'catalog-fixture',setup(b){
    b.onResolve({filter:/(bundled-presets|local-collection|personal-bank)\.ts$/},a=>({path:a.path,namespace:'fixture'}));
    b.onLoad({filter:/.*/,namespace:'fixture'},a=>({contents:a.path.includes('bundled-presets')
      ? 'export const BUNDLED_AVS_PRESETS=[]; export async function fetchBundledAvsPreset(){throw Error("unused");}'
      :a.path.includes('personal-bank')
      ? 'export class AvsPersonalBank { async list(){return [];} }'
      : `export async function fetchLocalAvsCatalog(){return globalThis.fixtureCatalog;} export async function fetchLocalAvsPreset(p){globalThis.loaded.push(p.id);return new Uint8Array([1,2]);}` }));
  }}]});
const fixtureHash=createHash('sha256').update(new Uint8Array([1,2])).digest('hex');
globalThis.fixtureCatalog=[
  {id:'avs',name:'Legacy',fileName:'legacy.avs',kind:'avs',autoEligible:true,sha256:fixtureHash,bytes:2},
  {id:'broken',name:'Retest',fileName:'retest.avs',kind:'avs',notWorking:true,autoEligible:true,sha256:fixtureHash,bytes:2},
  {id:'nerv',name:'NERV',fileName:'boot.nerv',kind:'nerv',autoEligible:true,sha256:'c'.repeat(64),bytes:2},
  {id:'hud',name:'HUD',fileName:'duel.hud',kind:'hud',autoEligible:true,sha256:'d'.repeat(64),bytes:2,hud:{id:'fixture-duel',pack:'showcase',family:'fighting',tags:[],tier:'tuned',order:1,canvas:{style:'pixel',w:384,h:224}}},
];
globalThis.loaded=[];
const {AVS_PRESET_SOURCES:registry}=await import(`data:text/javascript;base64,${Buffer.from(result.outputFiles[0].text).toString('base64')}`);
assert.deepEqual((await registry.list('local')).map(p=>p.id),['avs','broken']);
assert.deepEqual((await registry.autoBank('local')).map(p=>p.id),['avs']);
await (await registry.require('local','broken')).load();
assert.deepEqual(globalThis.loaded,['broken'],'not-working AVS remains manually retestable');
await assert.rejects(registry.require('local','nerv'),/Unknown/);
assert.deepEqual(globalThis.loaded,['broken'],'a NERV manifest never enters the AVS executor');
await assert.rejects(registry.require('local','hud'),/Unknown/);
assert.deepEqual(globalThis.loaded,['broken'],'a HUD manifest never enters the AVS executor or the Studio registry');
registry.invalidate('local');
assert.equal((await registry.list('local')).length,2);
// A catalog made only of scene manifests (or of an unrecognised kind) leaves the Studio registry empty rather than failing.
const scene=(id,kind,fileName,sha)=>({id,name:id,fileName,kind,autoEligible:true,sha256:sha.repeat(64),bytes:2});
globalThis.fixtureCatalog=[scene('n1','nerv','a.nerv','1'),scene('h1','hud','b.hud','2'),scene('h2','hud','c.hud','3'),scene('x1','future-kind','d.future','4')];
registry.invalidate('local');
assert.deepEqual(await registry.list('local'),[],'scene-only catalog: no Studio presets');
assert.deepEqual(await registry.autoBank('local'),[],'scene-only catalog: empty Auto bank');
for(const id of ['n1','h1','h2','x1']) await assert.rejects(registry.require('local',id),/Unknown/,`${id} is never an AVS preset`);
assert.deepEqual(globalThis.loaded,['broken'],'nothing further reached the AVS loader');
// Folder hints and origins ride on catalog rows without changing what the Studio registry lists.
globalThis.fixtureCatalog=[{id:'avs',name:'Legacy',fileName:'legacy.avs',kind:'avs',autoEligible:true,sha256:fixtureHash,bytes:2,folder:'HUD packs/Showcase',origins:[{package:'p',path:'a/b.avs'}]},scene('h1','hud','b.hud','2')];
registry.invalidate('local');
assert.deepEqual((await registry.list('local')).map(p=>p.id),['avs'],'folder hints do not change Studio membership');
console.log('Mixed catalog: NERV and HUD isolation, failure exclusions, manual retest and refresh PASS');
