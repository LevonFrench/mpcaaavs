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
const {minimumRating:unusedRating,...legacySettings}=defaultSettings;
assert.equal(parseSetups([{...saved,settings:legacySettings}])[0].settings.minimumRating,0,'legacy setups include unrated presets');
for(let minimumRating=0;minimumRating<=5;minimumRating++)assert.equal(parseSetups([{...saved,settings:{...defaultSettings,minimumRating}}])[0].settings.minimumRating,minimumRating);
for(const minimumRating of [-1,6,1.5,'3',null,NaN])assert.throws(()=>parseSetups([{...saved,settings:{...defaultSettings,minimumRating}}]),/minimum rating/);
class Element {
 constructor(tag){this.tagName=tag;this.children=[];this.attributes={};this.textContent='';this.value='';}
 append(...children){this.children.push(...children);}prepend(...children){this.children.unshift(...children);}
 replaceChildren(...children){this.children=children;}setAttribute(k,v){this.attributes[k]=v;}focus(){this.focused=true;}
 all(){return [this,...this.children.flatMap(c=>c.all())];}
 querySelector(selector){return this.all().find(e=>selector==='button'?e.tagName==='button':e.tagName==='input'&&e.type==='search');}
}
const root=new Element('section'),requests=[],rates=[],marked=[],minimumRatings=[],activated=[],loaded=[],settings={...defaultSettings};
globalThis.document={querySelector:()=>root,createElement:tag=>new Element(tag)};
globalThis.window={confirm:()=>true};
const {PresetManagement}=await load('src/mpc-management.ts');
const manager=new PresetManagement({catalog:()=>catalog,current:()=>0,settings:()=>settings,load:i=>loaded.push(i),rate:(i,n)=>rates.push([i,n]),markNotWorking:(i,value)=>marked.push([i,value]),setMinimumRating:value=>{minimumRatings.push(value);settings.minimumRating=value;},send:r=>requests.push(r),activate:s=>activated.push(s),panel(){},close(){}});
const click=text=>{const b=root.all().find(e=>e.tagName==='button'&&e.textContent===text);assert.ok(b,`button ${text}`);assert.ok(!b.disabled);b.onclick();};
const change=(label,value)=>{const el=root.all().find(e=>e.attributes['aria-label']===label);assert.ok(el,`control ${label}`);el.value=String(value);el.onchange();};
manager.show(2);assert.equal(requests.at(-1).op,'load-setups');
change('Shuffle minimum rating',3);assert.deepEqual(minimumRatings,[3]);manager.refresh();assert.equal(root.all().find(e=>e.attributes['aria-label']==='Shuffle minimum rating').value,'3');
change('List minimum star rating',2);assert.equal(minimumRatings.length,1,'search filter does not change shuffle settings');change('List minimum star rating',0);
manager.receive('setups-loaded',[]);click('New setup');click('Add to setup');
const other=root.all().find(e=>e.tagName==='button'&&e.textContent.includes('Preset 1'));other.onclick();click('Add to setup');
change('Setup shuffle minimum rating',4);click('Save setup');assert.equal(requests.at(-1).op,'save-setups');assert.deepEqual(requests.at(-1).setups[0].presets,catalog.map(p=>p.sha256));assert.equal(requests.at(-1).setups[0].settings.minimumRating,4);
const persisted=JSON.parse(JSON.stringify(requests.at(-1).setups));manager.receive('setups-saved');
click('Activate setup');assert.deepEqual(activated.at(-1).presets,catalog.map(p=>p.sha256));
click('Use entire library');assert.equal(activated.at(-1),null);
click('Load preset');assert.deepEqual(loaded,[1]);click('5 ★');assert.deepEqual(rates,[[1,5]]);
click('Mark not working');assert.deepEqual(marked,[[1,true]]);assert.equal(catalog[1].notWorking,undefined,'flag waits for native persistence acknowledgment');
catalog[1].notWorking=true;manager.refresh();assert.ok(root.all().some(e=>e.textContent.includes('Preset 1 · not working')));
click('Load preset');assert.deepEqual(loaded,[1,1],'marked presets can be manually retested');
change('Preset status','broken');assert.ok(!root.all().some(e=>e.tagName==='button'&&e.className?.includes('preset-row')&&e.textContent.includes('Preset 0')));
click('Clear not-working mark');assert.deepEqual(marked,[[1,true],[1,false]]);catalog[1].notWorking=false;manager.refresh();assert.ok(root.all().some(e=>e.textContent==='No presets match.'));change('Preset status','all');
manager.receive('library-error','Disk is read-only');assert.ok(root.all().some(e=>e.textContent==='Disk is read-only'));
manager.show(0);assert.ok(root.hidden);manager.show(2);manager.receive('setups-loaded',persisted);
assert.ok(root.all().some(e=>e.tagName==='option'&&e.textContent==='New setup'));
assert.equal(parseSetups(persisted)[0].settings.minimumRating,4,'shuffle threshold survives setup serialization');
console.log('Management CPU DOM: independent search/shuffle filters, mark/clear and retest actions, setup threshold save/reload, rating/load actions, errors, close PASS; legacy settings and validation bounds PASS');
