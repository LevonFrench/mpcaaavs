import {build} from 'esbuild';
import assert from 'node:assert/strict';
import {readFileSync,readdirSync} from 'node:fs';
const scenes=readdirSync('nerv-presets').filter(name=>name.endsWith('.nerv')).map(name=>name.slice(0,-5));
assert.equal(scenes.length,16);
const result=await build({entryPoints:['src/nerv-render.worker.ts'],bundle:true,format:'esm',write:false,plugins:[{name:'record-scene',setup(b){
 b.onResolve({filter:/nerv-scenes\.ts$/},()=>({path:'scene',namespace:'fixture'}));
 b.onLoad({filter:/.*/,namespace:'fixture'},()=>({contents:`export const NERV_SCENES=${JSON.stringify(scenes)};export function renderNervScene(ctx,w,h,frame){ctx.canvas.scene=frame.scene;globalThis.frames.push({w,h,frame});}`}));
}}]});
globalThis.frames=[];const replies=[],operations=[];
globalThis.self={postMessage(message){replies.push(message);}};
// Records geometry, alpha and source identity without Canvas, browsers or GPU work.
class Context {
 constructor(canvas){this.canvas=canvas;this.reset();}
 reset(){this.globalAlpha=1;this.globalCompositeOperation='source-over';this.stack=[];}
 save(){this.stack.push([this.globalAlpha,this.globalCompositeOperation]);operations.push(['save']);}
 restore(){[this.globalAlpha,this.globalCompositeOperation]=this.stack.pop();operations.push(['restore']);}
 beginPath(){operations.push(['beginPath']);}
 rect(...args){assert.ok(args.every(Number.isFinite));operations.push(['rect',...args]);}
 clip(){operations.push(['clip']);}
 drawImage(source,...args){
  assert.notEqual(source,this.canvas,'transition output must never be sampled as its own source');
  assert.ok(args.every(Number.isFinite));
  operations.push(['draw',source.scene??'mask',this.globalAlpha,this.globalCompositeOperation,...args]);
 }
 fillRect(...args){operations.push(['fill',this.globalCompositeOperation,...args]);}
 createPattern(source,repeat){assert.notEqual(source,this.canvas);operations.push(['pattern',source.width,source.height,repeat]);return {};}
}
globalThis.OffscreenCanvas=class {
 constructor(w,h){this._width=w;this._height=h;this.context=new Context(this);}
 get width(){return this._width;}set width(value){this._width=value;this.context.reset();}
 get height(){return this._height;}set height(value){this._height=value;this.context.reset();}
 getContext(){return this.context;}
 transferToImageBitmap(){return {width:this.width,height:this.height};}
};
await import(`data:text/javascript;base64,${Buffer.from(result.outputFiles[0].text).toString('base64')}`);
const send=data=>self.onmessage({data});
const bytes=name=>{const b=readFileSync(`nerv-presets/${name}.nerv`);return b.buffer.slice(b.byteOffset,b.byteOffset+b.byteLength);};
const load=(scene,generation=1)=>{send({type:'load',generation,preset:bytes(scene)});assert.equal(replies.at(-1).type,'ready');};
const clock={time:17,localTime:1,progress:.0625,bpm:120,seed:13,previousScene:'boot',previousTime:16,previousLocalTime:16,blend:.5,transitionMode:1,transitionSeed:121};
const frame={type:'render',generation:1,sequence:1,pcm:new ArrayBuffer(4608),width:640,height:360,nerv:clock};
function sample(nerv){frames.length=0;operations.length=0;send({...frame,nerv});assert.equal(replies.at(-1).type,'frame');return structuredClone({frames,operations});}
load('magi');
let captured=sample(clock);
assert.equal(captured.frames[0].frame.scene,'magi');assert.equal(captured.frames[1].frame.scene,'boot');
assert.equal(captured.frames[1].frame.time,16);assert.equal(captured.frames[1].frame.localTime,16);
assert.equal(captured.operations.at(-1)[1],'magi');assert.equal(captured.operations.at(-1)[2],.5);
sample({...clock,time:30});assert.deepEqual(sample(clock),captured,'media-time revisit reconstructs the same dissolve');

// Every directed pair supports every transition, including seeded Random and Cut.
let pairs=0;
for(const next of scenes){
 load(next);
 for(const previous of scenes){
  if(previous===next)continue;pairs++;
  for(let mode=0;mode<=15;mode++){
   const boundary={...clock,previousScene:previous,transitionMode:mode,transitionSeed:6157+pairs};
   const start=sample({...boundary,blend:0});
   assert.equal(start.operations.filter(op=>op[0]==='draw').at(-1)[1],mode===15?next:previous,'exact boundary preserves old image until the selected transition begins');
   const quarter=sample({...boundary,blend:.25});
   assert.equal(quarter.frames[0].frame.scene,next);assert.equal(quarter.frames[1].frame.scene,previous);
   assert.ok(quarter.operations.some(op=>op[0]==='draw'));
   sample({...boundary,blend:.75});
   assert.deepEqual(sample({...boundary,blend:.25}),quarter,`seek replay ${previous} -> ${next}, mode ${mode}`);
   const end=sample({...boundary,blend:1});
   assert.equal(end.frames.length,1);assert.equal(end.frames[0].frame.scene,next);assert.equal(end.operations.length,0);
  }
 }
}
assert.equal(pairs,240);
// A new worker load cannot change the seeded Random style or the block reveal order.
for(const mode of [0,6,14]){
 load('magi');const state={...clock,transitionMode:mode,blend:.45};const expected=sample(state);
 sample({...state,transitionSeed:955});load('magi');assert.deepEqual(sample(state),expected,'recreating transition reproduces output');
}
const transitionModule=await build({entryPoints:['src/mpc-transition.ts'],bundle:true,format:'esm',write:false});
const {AvsTransition}=await import(`data:text/javascript;base64,${Buffer.from(transitionModule.outputFiles[0].text).toString('base64')}`);
const createCanvas=()=>new OffscreenCanvas(1,1), selected=new Set(), orders=new Set();
for(let seed=0;seed<256;seed++){
 const a=new AvsTransition(0,{seed,createCanvas}),b=new AvsTransition(0,{seed,createCanvas});
 assert.equal(a.mode,b.mode);assert.deepEqual(a.order,b.order);assert.equal(new Set(a.order).size,9);
 selected.add(a.mode);orders.add(a.order.join(','));
}
assert.equal(selected.size,14,'seeded Random must reach every animated style');assert.ok(orders.size>200,'block order varies across boundary seeds');
const before=frames.length;send({...frame,generation:0});assert.equal(frames.length,before,'old generation ignored');
send({...frame,width:99999,height:99999,nerv:{...clock,blend:1}});assert.equal(frames.at(-1).w,1280);assert.equal(frames.at(-1).h,720);
for(const invalid of [{time:NaN},{blend:NaN},{previousTime:Infinity},{previousLocalTime:NaN},{transitionMode:16},{transitionMode:.5},{transitionSeed:NaN},{previousScene:'unknown'}]){
 send({...frame,nerv:{...clock,...invalid}});assert.equal(replies.at(-1).type,'error');
}
for(const data of [{format:'mpcaaavs-nerv',version:1,scene:'unknown'},{format:'mpcaaavs-nerv',version:2,scene:'boot'},{format:'arbitrary-code',version:1,scene:'boot'}]){
 send({type:'load',generation:2,preset:new TextEncoder().encode(JSON.stringify(data)).buffer});assert.equal(replies.at(-1).type,'error');
}
send({type:'load',generation:2,preset:new Uint8Array(4097).buffer});assert.equal(replies.at(-1).type,'error');
console.log('NERV worker CPU: 240 directed pairs x 16 transition modes, endpoints/quarter-progress/seek replay, seeded style/block recreation, no self-sampling, manifest/clock bounds, generation isolation PASS (visual raster acceptance pending)');
