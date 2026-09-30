import {build} from 'esbuild';
import assert from 'node:assert/strict';
import {baseManifest,allKindsManifest} from './fixtures-hud.mjs';
const contractText=(await build({entryPoints:['src/mpc-contract.ts'],bundle:true,format:'esm',write:false})).outputFiles[0].text;
const {AUDIO_DURATION_MAX}=await import(`data:text/javascript;base64,${Buffer.from(contractText).toString('base64')}`);
// Plumbing oracle uses real parsing/clock/transitions and records the engine input. Real engine drawing has its own check.
globalThis.hudCalls=[];globalThis.nervCalls=[];globalThis.runtimeResets=0;globalThis.constructed=[];globalThis.canvases=[];
const plugin={name:'record-plates',setup(b){
 b.onResolve({filter:/hud-engine\.ts$/},()=>({path:'engine',namespace:'fixture'}));
 b.onLoad({filter:/.*/,namespace:'fixture'},()=>({contents:`export class HudScene{static compile(manifest){return {manifest}}} export class HudRuntime{reset(){globalThis.runtimeResets++}}
 export function renderHudScene(scene,runtime,ctx,w,h,f,policy){if(runtime.revision!==f.revision){runtime.reset();runtime.revision=f.revision}globalThis.hudCalls.push({id:scene.manifest.id,w,h,frame:f,policy});ctx.canvas.plate=scene.manifest.id;ctx.fillRect(0,0,w,h);return {draws:1}}`}));
 b.onResolve({filter:/nerv-scenes\.ts$/},()=>({path:'nerv',namespace:'nerv'}));
 b.onLoad({filter:/.*/,namespace:'nerv'},()=>({contents:`export const NERV_SCENES=['boot','magi','psycho','radar','harmonics','seele','battery','atfield','alert','plug','target','city','sync','berserk','impact','end'];export function renderNervScene(ctx,w,h,f){globalThis.nervCalls.push({w,h,frame:f});ctx.canvas.plate=f.scene;ctx.fillRect(0,0,w,h)}`}));
}};
const text=(await build({entryPoints:[process.env.AAAVS_HUD_WORKER_ENTRY??'src/hud-render.worker.ts'],bundle:true,format:'esm',write:false,plugins:[plugin]})).outputFiles[0].text;
const replies=[],ops=[];let id=0;
class Context{
 constructor(canvas){this.canvas=canvas;this.globalAlpha=1;this.globalCompositeOperation='source-over';this.stack=[]}
 save(){this.stack.push([this.globalAlpha,this.globalCompositeOperation]);ops.push(['save'])} restore(){[this.globalAlpha,this.globalCompositeOperation]=this.stack.pop();ops.push(['restore'])}
 drawImage(s,...a){assert.notEqual(s,this.canvas,'never sample own writes');assert.ok(a.every(Number.isFinite));ops.push(['draw',s.plate??'scratch',this.globalAlpha,...a])}
 fillRect(...a){assert.ok(a.every(Number.isFinite));ops.push(['fill',...a])} clearRect(...a){ops.push(['clear',...a])}
 beginPath(){ops.push(['begin'])} closePath(){ops.push(['close'])} rect(...a){assert.ok(a.every(Number.isFinite));ops.push(['rect',...a])}
 moveTo(...a){assert.ok(a.every(Number.isFinite));ops.push(['move',...a])}lineTo(...a){assert.ok(a.every(Number.isFinite));ops.push(['line',...a])}
 arc(...a){assert.ok(a.filter(x=>typeof x==='number').every(Number.isFinite));ops.push(['arc',...a])}clip(){ops.push(['clip'])}fill(){ops.push(['pathfill'])}stroke(){ops.push(['stroke'])}
 fillText(s,...a){ops.push(['text',s,...a])}strokeText(s,...a){ops.push(['strokeText',s,...a])}setTransform(...a){ops.push(['transform',...a])}
 createPattern(){return {}}
 translate(...a){assert.ok(a.every(Number.isFinite));ops.push(['translate',...a])}scale(...a){assert.ok(a.every(Number.isFinite));ops.push(['scale',...a])}
 setLineDash(...a){ops.push(['dash',...a])}strokeRect(...a){assert.ok(a.every(Number.isFinite));ops.push(['strokeRect',...a])}
 createLinearGradient(...a){assert.ok(a.every(Number.isFinite));return {addColorStop(){}}}createRadialGradient(...a){assert.ok(a.every(Number.isFinite));return {addColorStop(){}}}
}
globalThis.OffscreenCanvas=class{constructor(w,h){this.id=id++;this.width=w;this.height=h;this.ctx=new Context(this);canvases.push(this)}getContext(){return this.ctx}transferToImageBitmap(){return {width:this.width,height:this.height}}};
globalThis.self={postMessage(m){replies.push(m)}};
await import(`data:text/javascript;base64,${Buffer.from(text).toString('base64')}`);
const send=data=>self.onmessage({data}),bytes=m=>new TextEncoder().encode(JSON.stringify(m)).buffer;
const a=baseManifest({id:'fixture-incoming'}),b=baseManifest({id:'fixture-outgoing'}),sha='a'.repeat(64);
const load=(m=a,generation=1)=>{send({type:'load',generation,preset:bytes(m),width:640,height:360,gpuLane:'cpu'});assert.equal(replies.at(-1).type,'ready',replies.at(-1).message)};
const signals=new Float32Array(64);signals[0]=2;
const frame={time:17,seed:13,revision:1,grid:{offset:.25,bpm:100,beatsPerBar:3,changes:[[5,140]]},sceneStart:16,sceneEnd:24,tempo:null,track:{position:17,duration:80},signals,motion:'full',flash:'strict'};
function render(hud=frame,extra={}){hudCalls.length=0;nervCalls.length=0;ops.length=0;send({type:'render',generation:1,sequence:3,pcm:new ArrayBuffer(4608),width:640,height:360,hud,...extra});assert.equal(replies.at(-1).type,'frame',replies.at(-1).message);return structuredClone({hudCalls,nervCalls,ops})}
load();const plain=render();assert.equal(plain.hudCalls.length,1);assert.deepEqual(plain.hudCalls[0].frame,frame);assert.deepEqual(plain.hudCalls[0].policy,{motion:'full',flash:'strict'});assert.equal(replies.at(-1).hudStats.draws,1);assert.ok(Number.isFinite(replies.at(-1).renderMs));assert.ok(replies.at(-1).renderMs>=0);
render({...frame,time:0,sceneStart:-2,sceneEnd:2,named:[{id:'countin',start:-4,end:-2}]});
for(const duration of [null, .001, AUDIO_DURATION_MAX]) {
 const accepted=render({...frame,track:{position:17,duration}});
 assert.equal(accepted.hudCalls[0].frame.track.duration,duration,'null and positive bounded durations reach the engine unchanged');
}
const resets=runtimeResets;render();assert.equal(runtimeResets,resets);render({...frame,revision:2});assert.equal(runtimeResets,resets+1);
const big=render(frame,{width:99999,height:99999});assert.equal(big.hudCalls[0].w,big.hudCalls[0].h);assert.ok(replies.at(-1).width*replies.at(-1).height<=8294400);assert.ok(replies.at(-1).width<=4096);
send({type:'stash',generation:1,sha256:sha,preset:bytes(b)});
const fade={...frame,previous:{sha256:sha,kind:'hud'},previousTime:16,previousLocalTime:8,previousSceneStart:8,previousSceneEnd:16,blend:.4,transitionMode:1,transitionSeed:42,transitionBeats:4,transitionBoundary:2,fadeSeconds:2};
const both=render(fade);assert.equal(both.hudCalls.length,2);assert.equal(both.hudCalls[0].id,'fixture-incoming');assert.equal(both.hudCalls[1].id,'fixture-outgoing');assert.equal(both.hudCalls[1].frame.sceneStart,8);assert.equal(both.hudCalls[1].frame.sceneEnd,16);assert.equal(both.hudCalls[1].frame.time,16);assert.deepEqual(render(fade),both,'seek/repeat reconstructs both plates');
for(let mode=0;mode<33;mode++)for(const blend of [0,.25,.75,1]){const f={...fade,transitionMode:mode,transitionSeed:mode*97+3,blend};const result=render(f);assert.deepEqual(render(f),result,`mode ${mode} replay at ${blend}`);if(blend===1)assert.equal(result.hudCalls.length,1)}
render({...fade,previous:{sha256:sha,kind:'nerv',scene:'boot'}});assert.equal(nervCalls[0].frame.scene,'boot');assert.equal(nervCalls[0].frame.sceneStart,8);assert.equal(nervCalls[0].frame.sceneEnd,16);assert.equal(nervCalls[0].frame.bpm,140);
render({...fade,blend:.5});const used=canvases.filter(c=>c.width===640&&c.height===360);render({...fade,blend:1});assert.ok(used.filter(c=>c.width===0&&c.height===0).length>=2,'fade plates release backing stores');
const malformed=[{time:NaN},{sceneEnd:15},{revision:-1},{seed:Infinity},{grid:{}},{track:{position:1,duration:NaN}},{motion:'bad'},{flash:'bad'},
 ...[0,-1,AUDIO_DURATION_MAX+1,1e9,Infinity,'80',undefined].map(duration=>({track:{position:1,duration}})),
 {signals:new Float32Array(63)},{signals:new Float32Array(64)},{tempo:{bpm:0,beatIndex:0,beatPhase:0,locked:true}},{named:[{id:'bad',start:2,end:1}]},
 {transitionMode:33},{transitionBeats:0},{transitionBeats:65},{transitionBoundary:4},{transitionAccent:2},{transitionReduced:1},{fadeSeconds:-1},{previousTime:Infinity},
 {previous:{sha256:sha,kind:'nerv',scene:'invalid'}},{previous:{sha256:'bad',kind:'hud'}}];
for(const patch of malformed){send({type:'render',generation:1,sequence:4,pcm:new ArrayBuffer(4608),width:640,height:360,hud:{...frame,...patch}});assert.equal(replies.at(-1).type,'error',JSON.stringify(patch));assert.equal(replies.at(-1).fatal,true)}
const count=replies.length;send({type:'render',generation:0,hud:frame});send({type:'stash',generation:0,sha256:sha,preset:bytes(b)});assert.equal(replies.length,count,'stale generation ignored');
// Cache bounded at four manifests; the fifth evicts the oldest, and the worker explains a missing seek prerequisite.
for(let i=1;i<=5;i++)send({type:'stash',generation:1,sha256:i.toString().repeat(64),preset:bytes(baseManifest({id:`fixture-${i}`}))});
send({type:'render',generation:1,sequence:4,pcm:new ArrayBuffer(4608),width:640,height:360,hud:{...fade,previous:{sha256:'1'.repeat(64),kind:'hud'}}});assert.match(replies.at(-1).message,/not stashed/);
send({type:'clear',generation:1});render();
send({type:'load',generation:2,preset:new ArrayBuffer(0)});assert.equal(replies.at(-1).type,'error');load(a,2);const before=replies.length;send({type:'render',generation:1,hud:frame});assert.equal(replies.length,before);
// Real module graph and real procedural engine: all instruments draw through actual worker plumbing, including NERV previous plates.
const real=(await build({entryPoints:['src/hud-render.worker.ts'],bundle:true,format:'esm',write:false})).outputFiles[0].text;
await import(`data:text/javascript;base64,${Buffer.from(real).toString('base64')}`);
load(allKindsManifest());send({type:'stash',generation:1,sha256:sha,preset:bytes(baseManifest({id:'fixture-outgoing'}))});
for(const [width,height] of [[320,180],[960,540],[1920,1080]])for(const previous of [undefined,{sha256:sha,kind:'hud'},{sha256:sha,kind:'nerv',scene:'boot'}]){
 const f={...fade,previous};const first=render(f,{width,height}).ops;assert.ok(first.length>0);
 assert.deepEqual(render(f,{width,height}).ops,first,'actual engine worker replay');
 render({...f,time:80,revision:2},{width,height});assert.deepEqual(render({...f,revision:3},{width,height}).ops,first,'actual engine seek reconstruction');
 assert.ok(replies.at(-1).hudStats.instruments>0);assert.ok(replies.at(-1).hudStats.draws<=512,'actual engine budget');
}
console.log('HUD worker CPU: real parser/clock/transition module graph, 33 styles x endpoints/quarter-progress seek replay, distinct previous HUD/NERV bounds, grid tempo, ABI/policy/revision, uniform hard caps/telemetry, released fade surfaces, bounded four-manifest stash, malformed inputs and generation isolation PASS; procedural engine raster and live acceptance remain separate.');
