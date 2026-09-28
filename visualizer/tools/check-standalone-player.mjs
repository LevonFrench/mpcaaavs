import { build } from 'esbuild';
import assert from 'node:assert/strict';
import vm from 'node:vm';

const adapter=await build({entryPoints:['src/standalone-player.ts'],bundle:true,format:'esm',write:false,plugins:[{name:'headless-host',setup(build){build.onResolve({filter:/mpc-host\.ts$/},()=>({path:'host',namespace:'test'}));build.onLoad({filter:/.*/,namespace:'test'},()=>({contents:'export {};',loader:'js'}));}}]});
const {PlayerPcmQueue,StandaloneBridge}=await import(`data:text/javascript;base64,${Buffer.from(adapter.outputFiles[0].text).toString('base64')}`);
const packet=(epoch,time,sampleRate=48000,samples=576)=>({epoch,time,sampleRate,samples,pcm:new Float32Array(1152).fill(.25).buffer});
const queue=new PlayerPcmQueue();queue.reset(1,100,10);
queue.push(packet(0,100));queue.push(packet(1,100));queue.push(packet(1,100.012));
let batch=queue.take(10.006);assert.equal(batch.frames.length,1);assert.equal(batch.frames[0].time,10);assert.equal(batch.frames[0].sampleRate,48000);assert.equal(batch.frames[0].pcm[600],.25);assert.equal(batch.discontinuity,true);
batch=queue.take(10.02);assert.equal(batch.frames.length,1);assert.equal(batch.discontinuity,false);
queue.reset(2,120,50);queue.push(packet(1,120));assert.equal(queue.take(50).frames.length,0);
queue.push(packet(2,120,96000,128));assert.equal(queue.take(50).frames[0].samples,128);
queue.push(packet(2,120.012));assert.equal(queue.take(51).frames.length,0);assert.equal(queue.take(51).discontinuity,false);
queue.reset(3,0,0);for(let i=0;i<80;i++)queue.push(packet(3,i*.001));batch=queue.take(.1);assert.equal(batch.frames.length,64);assert.equal(batch.discontinuity,true);
queue.reset(4,0,0);queue.push(packet(4,1));assert.equal(queue.take(.9).frames.length,0);assert.equal(queue.take(1).frames.length,1);

const requests=[],events=[],notices=[],settings=[];let playing=0,full=0,options=0;
const bridge=new StandaloneBridge({async library(value){requests.push(value);return value.op==='load-settings'?{type:'settings',shuffle:true,minimumRating:3}:{type:'settings',...value.settings};},playPause(){playing++;},fullscreen(){full++;},options(){options++;},notice(value){notices.push(value);},settings(value){settings.push(value);}});
bridge.addEventListener('message',event=>events.push(event.data));bridge.postMessage('host-ready');await new Promise(resolve=>setTimeout(resolve,0));assert.equal(requests[0].op,'load-settings');assert.equal(bridge.settings.minimumRating,3);
bridge.postMessage('rate-up');bridge.postMessage('rate-down');bridge.postMessage('mark-not-working');bridge.postMessage('show-manager');bridge.postMessage('show-manager');bridge.postMessage('show-setups');bridge.postMessage('panel-state:2');bridge.postMessage('panel-close');
assert.equal(bridge.panel,0);assert.deepEqual(events.filter(x=>x.type==='rate').map(x=>x.delta),[1,-1]);assert.ok(events.some(x=>x.type==='not-working'));assert.deepEqual(events.filter(x=>x.type==='panel').map(x=>x.panel),[1,0,2]);
bridge.configure({transition:15});await new Promise(resolve=>setTimeout(resolve,0));assert.equal(requests[1].settings.minimumRating,3);assert.equal(bridge.settings.transition,15);
bridge.configure({minimumRating:4});bridge.configure({bars:8});bridge.toggle('shuffle');bridge.toggle('shuffle');await new Promise(resolve=>setTimeout(resolve,0));
assert.equal(bridge.settings.minimumRating,4);assert.equal(bridge.settings.bars,8);assert.equal(bridge.settings.shuffle,true);assert.equal(requests.at(-1).settings.minimumRating,4);
bridge.postMessage('play-pause');bridge.postMessage('fullscreen');bridge.postMessage('options');assert.deepEqual([playing,full,options],[1,1,1]);

const built=await build({entryPoints:['src/worklets/player-pcm.worklet.ts'],bundle:true,format:'iife',write:false});
let Processor;const output=[];
const scope={Float32Array,ArrayBuffer,Math,Number,currentFrame:0,sampleRate:48000,AudioWorkletProcessor:class{port={onmessage:null,postMessage(message){output.push(message);}};},registerProcessor(name,constructor){assert.equal(name,'aaavs-player-pcm');Processor=constructor;}};
vm.runInNewContext(built.outputFiles[0].text,scope);const worklet=new Processor();
worklet.port.onmessage({data:{type:'reset',epoch:9,active:true}});
for(let i=0;i<5;i++){scope.currentFrame=i*128;const l=new Float32Array(128).fill(i/10),r=new Float32Array(128).fill(-i/10),out=[new Float32Array(128),new Float32Array(128)];worklet.process([[l,r]],[out]);assert.deepEqual(out,[l,r]);}
assert.equal(output.length,1);assert.equal(output[0].epoch,9);assert.equal(output[0].time,0);assert.equal(output[0].samples,576);assert.equal(output[0].sampleRate,48000);const pcm=new Float32Array(output[0].pcm);assert.equal(pcm[0],0);assert.ok(Math.abs(pcm[575]-.4)<1e-6);assert.ok(Math.abs(pcm[1151]+.4)<1e-6);
for(let i=5;i<80;i++){scope.currentFrame=i*128;worklet.process([[new Float32Array(128).fill(.8)]],[[new Float32Array(128),new Float32Array(128)]]);}
assert.equal(output.length,8,'Only eight in-flight buffers are permitted');
worklet.port.onmessage({data:{type:'recycle',pcm:output[0].pcm}});
for(let i=80;i<85;i++){scope.currentFrame=i*128;worklet.process([[new Float32Array(128).fill(.6)]],[[new Float32Array(128),new Float32Array(128)]]);}
assert.equal(output.length,9);assert.equal(output[8].discontinuity,true);assert.deepEqual(new Float32Array(output[8].pcm).slice(0,576),new Float32Array(output[8].pcm).slice(576));
worklet.port.onmessage({data:{type:'reset',epoch:10,active:false}});scope.currentFrame=100000;worklet.process([[new Float32Array(128).fill(.1)]],[[new Float32Array(128),new Float32Array(128)]]);assert.equal(output.length,9);
console.log('Standalone Player CPU checks PASS: shared bridge protocol, settings, bounded PCM, source-time mapping, stale epochs, stereo/mono pass-through, backpressure and discontinuities.');
