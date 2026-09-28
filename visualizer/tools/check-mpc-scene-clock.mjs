import {build} from 'esbuild';
import assert from 'node:assert/strict';
async function load(path){const result=await build({entryPoints:[path],bundle:true,format:'esm',write:false});return import(`data:text/javascript;base64,${Buffer.from(result.outputFiles[0].text).toString('base64')}`);}
const {sceneAt,scheduleSceneCue,MAX_SCENE_CUES,parseSceneTiming,validateSceneTiming,defaultSceneTiming}=await load('src/mpc-scene-clock.ts');
const {parseSetups,defaultSettings}=await load('src/mpc-setups.ts');
const timing={...defaultSceneTiming,enabled:true},order=[8,2,7,4];
const snapshot=JSON.stringify({timing,order});
assert.deepEqual(sceneAt(0,order,timing,false),{index:8,previousIndex:8,ordinal:0,start:0,localTime:0,progress:0,duration:16});
assert.deepEqual(sceneAt(19,order,timing,false),{index:2,previousIndex:8,ordinal:1,start:16,localTime:3,progress:3/16,duration:16});
assert.equal(sceneAt(64,order,timing,false).index,8);
assert.equal(sceneAt(64,order,timing,false).previousIndex,4);
assert.equal(sceneAt(17,order,{...timing,offsetSeconds:3},false).index,8);
assert.equal(sceneAt(2,order,{...timing,offsetSeconds:3},false).localTime,0);
assert.equal(sceneAt(0,order,{...timing,offsetSeconds:-17},false).index,2);
assert.equal(sceneAt(-10,order,timing,false).ordinal,0);
assert.equal(sceneAt(Infinity,order,timing,false),null);
assert.equal(sceneAt(NaN,order,timing,false),null);
assert.equal(sceneAt(Number.MAX_VALUE,order,timing,false),null);
assert.equal(sceneAt(10,[],timing,false),null);
assert.equal(sceneAt(10,order,defaultSceneTiming,false),null);
assert.throws(()=>sceneAt(10,[1,1],timing,true));
assert.throws(()=>sceneAt(10,[-1],timing,false));
assert.throws(()=>sceneAt(10,[1.5],timing,false));
assert.equal(JSON.stringify({timing,order}),snapshot,'clock must not mutate setup data');

for(const bpm of [20,92,109,133.33,400])for(const barsPerScene of [1,8,128]){
  const config={...timing,bpm,barsPerScene,offsetSeconds:.375},duration=240*barsPerScene/bpm;
  for(let ordinal=0;ordinal<100;ordinal++){
    const position=.375+ordinal*duration,phase=sceneAt(position,order,config,false);
    assert.equal(phase.ordinal,ordinal,`${bpm} BPM, ${barsPerScene} bars, boundary ${ordinal}`);
    assert.ok(phase.localTime<1e-8);
    if(ordinal)assert.equal(sceneAt(position-1e-5,order,config,false).ordinal,ordinal-1);
  }
}
// Reevaluate arbitrary positions after pauses and long forward/backward seeks.
for(const shuffle of [false,true])for(const seed of [0,1,4294967295]){
  const config={...timing,seed};
  const positions=[0,8,16,63.5,64,1031,1600000,15,16,0];
  const phases=positions.map(position=>sceneAt(position,order,config,shuffle));
  positions.forEach((position,i)=>{assert.deepEqual(sceneAt(position,order,config,shuffle),phases[i]);assert.deepEqual(sceneAt(position,order,config,shuffle),phases[i],'a paused clock cannot advance');});
}
// Every cycle uses every scene exactly once. Crossing any cycle boundary never repeats.
for(let count=1;count<=16;count++)for(const seed of [0,1,27,4294967295]){
  const indices=Array.from({length:count},(_,i)=>i*3),config={...timing,seed};let previous;
  for(let cycle=0;cycle<40;cycle++){
    const seen=[];
    for(let n=0;n<count;n++){
      const phase=sceneAt((cycle*count+n)*16,indices,config,true);seen.push(phase.index);
      if(previous!==undefined){if(count>1)assert.notEqual(phase.index,previous,'shuffle cannot repeat at cycle boundary');assert.equal(phase.previousIndex,previous);}
      previous=phase.index;
    }
    assert.deepEqual([...seen].sort((a,b)=>a-b),indices);
  }
}
assert.notDeepEqual(Array.from({length:32},(_,i)=>sceneAt(i*16,order,{...timing,seed:5},true).index),Array.from({length:32},(_,i)=>sceneAt(i*16,order,{...timing,seed:17},true).index),'seed affects the sequence');

// Any NERV scene can cue any other scene on the same musical boundary. The
// outgoing scene and local transition time are recoverable after arbitrary seeks.
const nervOrder=Array.from({length:16},(_,i)=>i*7+3);
for(const shuffle of [false,true])for(const source of nervOrder)for(const target of nervOrder.filter(index=>index!==source)){
  const history=[{ordinal:2,index:source}],phase=sceneAt(35,nervOrder,timing,shuffle,history);
  const cues=scheduleSceneCue(history,phase,target),snapshot=JSON.stringify(cues);
  assert.deepEqual(cues,[{ordinal:2,index:source},{ordinal:3,index:target}]);
  assert.equal(sceneAt(48-1e-5,nervOrder,timing,shuffle,cues).index,source,'a manual cue must wait for the boundary');
  const boundary=sceneAt(48,nervOrder,timing,shuffle,cues);
  assert.equal(boundary.index,target);assert.equal(boundary.previousIndex,source);assert.equal(boundary.localTime,0);
  assert.equal(boundary.start,48);assert.equal(boundary.ordinal,3);assert.equal(boundary.duration,16);
  const frames=[48,50,47,8000,48,0,50].map(position=>sceneAt(position,nervOrder,timing,shuffle,cues));
  [48,50,47,8000,48,0,50].forEach((position,i)=>assert.deepEqual(sceneAt(position,nervOrder,timing,shuffle,cues),frames[i],'cue replay must not depend on traversal order'));
  if(!shuffle)assert.equal(sceneAt(64,nervOrder,timing,shuffle,cues).index,nervOrder[(nervOrder.indexOf(target)+1)%16],'ordered cues continue from the chosen scene');
  assert.equal(JSON.stringify(cues),snapshot);assert.deepEqual(history,[{ordinal:2,index:source}]);
}
// Each cued shuffle cycle remains a full permutation, with no automatic repeats
// within or across cycles, including the two-preset and singleton edge cases.
for(let count=1;count<=16;count++)for(const seed of [0,1,29,4294967295]){
  const indices=nervOrder.slice(0,count),config={...timing,seed};
  for(const target of indices){
    const cues=[{ordinal:7,index:target}];let previous;
    for(let cycle=0;cycle<8;cycle++){
      const seen=[];
      for(let n=0;n<count;n++){
        const phase=sceneAt((7+cycle*count+n)*16,indices,config,true,cues);seen.push(phase.index);
        if(previous!==undefined&&count>1)assert.notEqual(phase.index,previous,'cued shuffle cannot repeat across cycles');
        if(previous!==undefined)assert.equal(phase.previousIndex,previous);
        previous=phase.index;
      }
      assert.deepEqual([...seen].sort((a,b)=>a-b),indices);
    }
    assert.equal(sceneAt(112,indices,config,true,cues).index,target,'the chosen scene anchors the cued shuffle');
  }
}
const originalCues=[{ordinal:1,index:8},{ordinal:4,index:2},{ordinal:9,index:7}];
const requeued=scheduleSceneCue(originalCues,{ordinal:3},4);
assert.deepEqual(requeued,[{ordinal:1,index:8},{ordinal:4,index:4},{ordinal:9,index:7}],'reselecting while paused replaces only the next boundary cue');
assert.deepEqual(originalCues,[{ordinal:1,index:8},{ordinal:4,index:2},{ordinal:9,index:7}]);
assert.notEqual(requeued[0],originalCues[0],'queued history is copied');
assert.deepEqual(scheduleSceneCue(originalCues,{ordinal:2},4),[{ordinal:1,index:8},{ordinal:3,index:4},{ordinal:4,index:2},{ordinal:9,index:7}]);
assert.deepEqual(sceneAt(70,order,timing,false,[]),sceneAt(70,order,timing,false),'reactivating with an empty history restores the saved sequence');
const offsetTiming={...timing,bpm:109,offsetSeconds:2.75,barsPerScene:12};
const offsetPhase=sceneAt(31,order,offsetTiming,false),offsetCues=scheduleSceneCue([],offsetPhase,4);
const due=offsetTiming.offsetSeconds+(offsetPhase.ordinal+1)*offsetPhase.duration;
assert.equal(sceneAt(due-1e-5,order,offsetTiming,false,offsetCues).index,offsetPhase.index);
assert.equal(sceneAt(due,order,offsetTiming,false,offsetCues).index,4,'cues retain exact BPM, bar length and offset');
for(const cues of [null,{},[{ordinal:-1,index:8}],[{ordinal:0.5,index:8}],[{ordinal:Infinity,index:8}],[{ordinal:2,index:8},{ordinal:1,index:2}],[{ordinal:2,index:8},{ordinal:2,index:2}],[{ordinal:2,index:-1}],[{ordinal:2,index:2.5}],[{ordinal:2,index:999}]]){
  assert.throws(()=>sceneAt(70,order,timing,false,cues));
}
for(const [phase,target] of [[{ordinal:-1},8],[{ordinal:1.5},8],[{ordinal:Infinity},8],[{ordinal:Number.MAX_SAFE_INTEGER},8],[{ordinal:1},-1],[{ordinal:1},1.5]])assert.throws(()=>scheduleSceneCue([],phase,target));
const fullCues=Array.from({length:MAX_SCENE_CUES},(_,ordinal)=>({ordinal,index:order[ordinal%order.length]}));
assert.equal(scheduleSceneCue(fullCues,{ordinal:2},7).length,MAX_SCENE_CUES,'a full history can still replace a pending cue');
assert.throws(()=>scheduleSceneCue(fullCues,{ordinal:MAX_SCENE_CUES},7),'never discard replay history when full');
assert.throws(()=>sceneAt(70,order,timing,false,[...fullCues,{ordinal:MAX_SCENE_CUES,index:7}]));

const hash='a'.repeat(64),legacy={id:'legacy',name:'Legacy',presets:[hash],settings:defaultSettings};
assert.deepEqual(parseSetups([legacy])[0].timing,defaultSceneTiming);
assert.notEqual(parseSceneTiming(undefined),defaultSceneTiming,'default is copied for editing');
const configured={...legacy,timing:{...timing,bpm:109,offsetSeconds:2.75,barsPerScene:12,seed:73}};
assert.deepEqual(parseSetups(JSON.parse(JSON.stringify([configured])))[0],configured);
assert.equal(validateSceneTiming(configured.timing),true);assert.equal(validateSceneTiming(undefined),false);
for(const invalid of [null,{}, {...timing,enabled:1}, {...timing,bpm:0}, {...timing,bpm:Infinity}, {...timing,bpm:401}, {...timing,offsetSeconds:NaN}, {...timing,offsetSeconds:3601}, {...timing,barsPerScene:1.5}, {...timing,barsPerScene:129}, {...timing,seed:-1}, {...timing,seed:4294967296}, {...timing,seed:2.1}]){
  assert.throws(()=>parseSceneTiming(invalid));assert.equal(validateSceneTiming(invalid),false);assert.throws(()=>parseSetups([{...legacy,timing:invalid}]));
}

// The actual builder must carry clock settings through save, native acknowledgement,
// activation and a new management instance. This fake DOM never starts a renderer.
class Element{
  constructor(tag){this.tagName=tag;this.children=[];this.attributes={};this.textContent='';this.value='';}
  append(...children){this.children.push(...children);}prepend(...children){this.children.unshift(...children);}
  replaceChildren(...children){this.children=children;}setAttribute(k,v){this.attributes[k]=v;}focus(){}
  all(){return [this,...this.children.flatMap(c=>c.all())];}
  querySelector(selector){return this.all().find(e=>selector==='button'?e.tagName==='button':e.tagName==='input'&&e.type==='search');}
}
const root=new Element('section'),requests=[],activated=[];
let discard=true;
globalThis.document={querySelector:()=>root,createElement:tag=>new Element(tag)};
globalThis.window={confirm:()=>discard};
const catalog=[{sha256:hash,name:'NERV boot',fileName:'boot.nerv',autoEligible:true,rating:0}];
const nerv={...configured,id:'nerv',name:'NERV scene set'};
const actions={catalog:()=>catalog,current:()=>0,settings:()=>defaultSettings,load(){},rate(){},send:r=>requests.push(r),activate:s=>activated.push(s),nervSetup:()=>nerv,panel(){},close(){}};
const {PresetManagement}=await load('src/mpc-management.ts');
const manager=new PresetManagement(actions);
const click=text=>{const button=root.all().find(e=>e.tagName==='button'&&e.textContent===text);assert.ok(button,`button ${text}`);assert.ok(!button.disabled);button.onclick();};
const field=label=>{const input=root.all().find(e=>e.attributes['aria-label']===label);assert.ok(input,`field ${label}`);return input;};
const set=(label,value)=>{const input=field(label);assert.ok(!input.disabled);input.value=String(value);input.oninput();};
manager.show(2);manager.receive('setups-loaded',[]);click('New setup');
assert.equal(field('Repeatable scene timing').checked,false);assert.equal(field('Song BPM').disabled,true);
discard=false;click('NERV scene set');assert.equal(field('Setup name').value,'New setup','built-in cannot discard an unsaved setup without confirmation');
discard=true;click('NERV scene set');assert.equal(field('Repeatable scene timing').checked,true);
set('Song BPM',92);set('First scene offset (seconds)',1.25);set('Bars per scene',4);set('Shuffle seed',28);
click('Save setup');assert.equal(requests.at(-1).op,'save-setups');
const persisted=JSON.parse(JSON.stringify(requests.at(-1).setups));
assert.deepEqual(persisted[0].timing,{enabled:true,bpm:92,offsetSeconds:1.25,barsPerScene:4,seed:28});
assert.equal(nerv.timing.bpm,109,'built-in factory result must not be mutated');
manager.receive('setups-saved');click('Activate setup');assert.deepEqual(activated.at(-1),persisted[0]);
const restored=new PresetManagement(actions);restored.show(2);restored.receive('setups-loaded',persisted);
const savedPicker=field('Saved setups');savedPicker.value='nerv';savedPicker.onchange();
assert.equal(field('Song BPM').value,'92');assert.equal(field('First scene offset (seconds)').value,'1.25');assert.equal(field('Shuffle seed').value,'28');
const requestsBefore=requests.length;set('Song BPM','');click('Save setup');assert.equal(requests.length,requestsBefore,'invalid timing must never be sent to disk');
assert.ok(root.all().some(e=>e.textContent.includes('Scene timing requires')));
console.log('Scene clock CPU: musical boundaries, all 240 any-to-any NERV cues, queued replacement, deterministic seeks/replays/pauses, seeded cycles without boundary repeats, bounded cue history, malformed inputs, legacy setup defaults, saved clock round trip and builder actions PASS');
