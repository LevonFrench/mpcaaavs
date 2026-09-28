import {build} from 'esbuild';
import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
const result=await build({entryPoints:['src/nerv-render.worker.ts'],bundle:true,format:'esm',write:false,plugins:[{name:'record-scene',setup(b){
 b.onResolve({filter:/nerv-scenes\.ts$/},()=>({path:'scene',namespace:'fixture'}));
 b.onLoad({filter:/.*/,namespace:'fixture'},()=>({contents:`export const NERV_SCENES=['boot','magi'];export function renderNervScene(ctx,w,h,frame){globalThis.frames.push({w,h,frame});}`}));
}}]});
globalThis.frames=[];const replies=[],composites=[];
globalThis.self={postMessage(message){replies.push(message);}};
globalThis.OffscreenCanvas=class {constructor(w,h){this.width=w;this.height=h;}getContext(){return {save(){},restore(){},drawImage(){composites.push(this.globalAlpha);}};}transferToImageBitmap(){return {width:this.width,height:this.height};}};
await import(`data:text/javascript;base64,${Buffer.from(result.outputFiles[0].text).toString('base64')}`);
const send=data=>self.onmessage({data});
const bytes=name=>{const b=readFileSync(`nerv-presets/${name}.nerv`);return b.buffer.slice(b.byteOffset,b.byteOffset+b.byteLength);};
send({type:'load',generation:1,preset:bytes('magi')});assert.equal(replies.at(-1).type,'ready');
const clock={time:17,localTime:1,progress:.0625,bpm:120,seed:13,previousScene:'boot',previousTime:16,previousLocalTime:16,blend:.5};
const frame={type:'render',generation:1,sequence:1,pcm:new ArrayBuffer(4608),width:640,height:360,nerv:clock};
send(frame);assert.equal(replies.at(-1).type,'frame');assert.equal(frames.at(-2).frame.scene,'magi');assert.equal(frames.at(-1).frame.scene,'boot');assert.equal(frames.at(-1).frame.time,16);assert.equal(frames.at(-1).frame.localTime,16);assert.equal(composites.at(-1),.5);
const repeat=structuredClone(frames.slice(-2));send({...frame,nerv:{...clock,time:30}});send(frame);assert.deepEqual(frames.slice(-2),repeat);
const before=frames.length;send({...frame,generation:0});assert.equal(frames.length,before,'old generation ignored');
send({...frame,width:99999,height:99999,nerv:{...clock,blend:1}});assert.equal(frames.at(-1).w,1280);assert.equal(frames.at(-1).h,720);
send({...frame,nerv:{...clock,time:NaN}});assert.equal(replies.at(-1).type,'error');
for(const data of [{format:'mpcaaavs-nerv',version:1,scene:'unknown'},{format:'mpcaaavs-nerv',version:2,scene:'boot'},{format:'arbitrary-code',version:1,scene:'boot'}]){
 send({type:'load',generation:2,preset:new TextEncoder().encode(JSON.stringify(data)).buffer});assert.equal(replies.at(-1).type,'error');
}
send({type:'load',generation:2,preset:new Uint8Array(4097).buffer});assert.equal(replies.at(-1).type,'error');
console.log('NERV worker CPU: manifest bounds/schema, scene dispatch, clock/previous-frame reconstruction, crossfade, replay, generation isolation, size cap PASS');
