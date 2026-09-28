import {build} from 'esbuild';
import assert from 'node:assert/strict';
async function load(path){const r=await build({entryPoints:[path],bundle:true,format:'esm',write:false});return import(`data:text/javascript;base64,${Buffer.from(r.outputFiles[0].text).toString('base64')}`);}
const {parseSetups,setupIndices,stepSetup,defaultSettings}=await load('src/mpc-setups.ts');
assert.equal(stepSetup([8,2,7],2,1,false),7);assert.equal(stepSetup([8,2,7],8,-1,false),7);
assert.equal(stepSetup([8,2,7],99,1,false),8);assert.equal(stepSetup([8],8,1,false),null);
assert.equal(stepSetup([8,2,7],8,1,true,()=>0),2);
const catalog=[0,1].map(i=>({sha256:String(i).repeat(64),name:`Preset ${i}`,fileName:`${i}.avs`,autoEligible:true,rating:i+1}));
const saved={id:'test',name:'Set',presets:catalog.map(p=>p.sha256).reverse(),settings:defaultSettings};
assert.deepEqual(setupIndices(parseSetups([saved])[0],catalog),[1,0]);
assert.throws(()=>parseSetups([{...saved,presets:['../escape']}]));
assert.throws(()=>parseSetups([{...saved,presets:[catalog[0].sha256,catalog[0].sha256]}]));
assert.throws(()=>parseSetups([{...saved,settings:{...defaultSettings,bars:3}}]));
assert.throws(()=>setupIndices(saved,[catalog[0]]));
class Element {
 constructor(tag){this.tagName=tag;this.children=[];this.attributes={};this.textContent='';this.value='';}
 append(...children){this.children.push(...children);}prepend(...children){this.children.unshift(...children);}
 replaceChildren(...children){this.children=children;}setAttribute(k,v){this.attributes[k]=v;}focus(){this.focused=true;}
 all(){return [this,...this.children.flatMap(c=>c.all())];}
 querySelector(selector){return this.all().find(e=>selector==='button'?e.tagName==='button':e.tagName==='input'&&e.type==='search');}
}
const root=new Element('section'),requests=[],rates=[],activated=[],loaded=[];
globalThis.document={querySelector:()=>root,createElement:tag=>new Element(tag)};
globalThis.window={confirm:()=>true};
const {PresetManagement}=await load('src/mpc-management.ts');
const manager=new PresetManagement({catalog:()=>catalog,current:()=>0,settings:()=>defaultSettings,load:i=>loaded.push(i),rate:(i,n)=>rates.push([i,n]),send:r=>requests.push(r),activate:s=>activated.push(s),panel(){},close(){}});
const click=text=>{const b=root.all().find(e=>e.tagName==='button'&&e.textContent===text);assert.ok(b,`button ${text}`);assert.ok(!b.disabled);b.onclick();};
manager.show(2);assert.equal(requests.at(-1).op,'load-setups');
manager.receive('setups-loaded',[]);click('New setup');click('Add to setup');
const other=root.all().find(e=>e.tagName==='button'&&e.textContent.includes('Preset 1'));other.onclick();click('Add to setup');
click('Save setup');assert.equal(requests.at(-1).op,'save-setups');assert.deepEqual(requests.at(-1).setups[0].presets,catalog.map(p=>p.sha256));
const persisted=JSON.parse(JSON.stringify(requests.at(-1).setups));manager.receive('setups-saved');
click('Activate setup');assert.deepEqual(activated.at(-1).presets,catalog.map(p=>p.sha256));
click('Use entire library');assert.equal(activated.at(-1),null);
click('Load preset');assert.deepEqual(loaded,[1]);click('5 ★');assert.deepEqual(rates,[[1,5]]);
manager.receive('library-error','Disk is read-only');assert.ok(root.all().some(e=>e.textContent==='Disk is read-only'));
manager.show(0);assert.ok(root.hidden);manager.show(2);manager.receive('setups-loaded',persisted);
assert.ok(root.all().some(e=>e.tagName==='option'&&e.textContent==='New setup'));
console.log('Management CPU DOM: search/list mount, rating/load actions, setup composition, save/ack, reload, activation, errors, close PASS; model bounds and missing IDs PASS');
