import { build } from 'esbuild';
import assert from 'node:assert/strict';
async function load(path) {
 const r = await build({ entryPoints: [path], bundle: true, format: 'esm', write: false });
 return import(`data:text/javascript;base64,${Buffer.from(r.outputFiles[0].text).toString('base64')}`);
}
const { MpcAutoDirector } = await load('src/mpc-auto-director.ts');
for (const bars of [2,4,8,12]) {
 const d = new MpcAutoDirector(); d.configure(true,bars);
 assert.equal(d.grid(0,true).switch,false);
 assert.equal(d.grid(bars-1,true).prepare,true);
 assert.equal(d.grid(bars-.01,true).switch,false);
 assert.equal(d.grid(bars,true).switch,true);
 assert.equal(d.grid(bars+.01,true).switch,false);
 d.rearm(); assert.equal(d.grid(bars+.02,true).switch,false);
 d.grid(bars+2,false); assert.equal(d.grid(bars+3,true).switch,false);
}
for (const energy of [0,.5,1]) {
 const d = new MpcAutoDirector(); d.energy=energy;
 d.grid(0,true); assert.equal(d.remainingBars,Math.round(12-10*energy));
}
const d = new MpcAutoDirector(); d.configure(false,2);
assert.equal(d.grid(999,true).prepare,false);
const silence = new Float32Array(1152);
for(let i=0;i<900;i++) assert.equal(d.update(i/30,true,silence).switch,false);
const music = new MpcAutoDirector(); music.configure(true,2);
let switches=0;
for(let i=0;i<1200;i++) {
 const t=i/30, p=new Float32Array(1152);
 if (t%0.5 < .07) for(let k=0;k<p.length;k++) p[k]=.8*Math.sin(k*.13);
 if(music.update(t,true,p).switch) {switches++; music.rearm();}
}
assert.ok(music.tempo.locked,'synthetic 120 BPM pulse must lock');
assert.ok(Math.abs(music.tempo.bpm-120)<3);
assert.ok(switches>=3,'phrase switching must operate on pulse audio');
const quiet = new MpcAutoDirector();
for (let i=0;i<450;i++) {
 const t=i/30, p=new Float32Array(1152);
 if(t%0.5 < .07) for(let k=0;k<p.length;k++) p[k]=.08*Math.sin(k*.13);
 quiet.update(t,true,p);
}
assert.ok(quiet.tempo.locked && Math.abs(quiet.tempo.bpm-120)<3, 'quiet pulse must lock without changing playback audio');
assert.equal(music.update(41,false,silence).switch,false);
assert.equal(music.update(0,true,silence).switch,false,'seek rearms');
const calls=[];
// Fake 2D context with the path and text surface the new styles use (moveTo/lineTo/arc/fill/stroke/strokeText/fillText); every numeric argument must be finite.
const finite=(...a)=>assert.ok(a.every(v=>typeof v!=='number'||Number.isFinite(v)),'finite canvas arguments');
const context = { globalAlpha:1, imageSmoothingEnabled:false, imageSmoothingQuality:'low', globalCompositeOperation:'source-over', fillStyle:'', strokeStyle:'', lineWidth:1, lineJoin:'miter', font:'', textAlign:'start', textBaseline:'alphabetic',
 drawImage(...a){finite(...a.slice(1));calls.push(a);},save(){},restore(){},beginPath(){},closePath(){},rect:finite,clip(){},fillRect:finite,clearRect:finite,createPattern(){return {};},
 moveTo:finite,lineTo:finite,arc:finite,fill(){},stroke(){},fillText:(text,...a)=>{assert.equal(typeof text,'string');finite(...a);},strokeText:(text,...a)=>{assert.equal(typeof text,'string');finite(...a);},setTransform:finite};
globalThis.document={createElement(){return {width:0,height:0,getContext(){return context;}};}};
const { AvsTransition, transitionProgress, blockOrder, TRANSITIONS, TRANSITION_META, TRANSITION_COUNT, TRANSITION_CUT, transitionUnit } = await load('src/mpc-transition.ts');
assert.equal(TRANSITIONS.length,TRANSITION_COUNT); assert.equal(TRANSITION_COUNT,33); assert.equal(TRANSITION_META.length,TRANSITION_COUNT);
assert.equal(TRANSITION_CUT,15); assert.equal(TRANSITIONS[TRANSITION_CUT],'Cut');
assert.equal(new Set(blockOrder()).size,9);
assert.equal(transitionProgress(0),0); assert.equal(transitionProgress(1),1);
assert.ok(Math.abs(transitionProgress(.5)-.5)<1e-9);
const old={},next={};
for(let mode=1;mode<TRANSITION_COUNT;mode++) {
 const tr=new AvsTransition(mode);
 for(const t of [0,.2,.5,.9,1]) { calls.length=0; tr.draw(context,old,next,t,641,359); assert.ok(calls.length,`style ${mode} draws at t=${t}`); if(t===1) assert.equal(calls.at(-1)[0],next); }
}
const { checkTransitionRaster, checkTransitionScaling } = await import('./mpc-transition-raster-check.mjs');
checkTransitionRaster(AvsTransition);
checkTransitionScaling(AvsTransition,transitionUnit);
console.log(`Auto: fixed/adaptive phrases, silence, pause, seek, 120 BPM lock (${switches} switches) PASS; AVS: CPU raster geometry modes 1–13, resolution unit/smoothing/scratch-surface cases, all-style (1–${TRANSITION_COUNT-1}) draw-call/endpoints smoke PASS (browser raster acceptance pending)`);
