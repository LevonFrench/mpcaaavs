import { build } from 'esbuild';
import assert from 'node:assert/strict';
const r=await build({entryPoints:['src/mpc-auto-director.ts'],bundle:true,format:'esm',write:false});
const {MpcAutoDirector}=await import(`data:text/javascript;base64,${Buffer.from(r.outputFiles[0].text).toString('base64')}`);
const silence=new Float32Array(1152);
for(const offset of [0,.005,.018,.031]) {
 const d=new MpcAutoDirector();let next=0;
 for(let poll=0;poll<900;poll++) {
  const position=poll*.033, frames=[];
  while(next*.012<=position) {
   const time=next++*.012,pcm=new Float32Array(1152);
   for(let i=0;i<576;i++){const t=time+i/48000-offset;if(t>=0&&t%.5<.005)pcm[i]=pcm[576+i]=.8*Math.sin(i*.2);}
   frames.push({time,pcm});
  }
  d.update(position,true,silence,frames);
 }
 assert.ok(d.tempo.locked&&Math.abs(d.tempo.bpm-120)<3,`5ms pulse phase ${offset}, got ${d.tempo.bpm}`);
 d.update(31,true,silence,[]);assert.equal(d.tempo.locked,false);
}
const d=new MpcAutoDirector();d.grid(.01,true);assert.equal(d.grid(12,true).switch,true);
const adaptive=new MpcAutoDirector();adaptive.energy=0;adaptive.grid(0,true);adaptive.energy=1;
assert.equal(adaptive.grid(1,true).prepare,true);assert.equal(adaptive.grid(2,true).switch,true);
const duplicate=new MpcAutoDirector(),pcm=new Float32Array(1152).fill(.2);
duplicate.update(0,true,pcm,[{time:0,pcm}]);const energy=duplicate.energy;
duplicate.update(.033,true,pcm,[{time:0,pcm}]);assert.equal(duplicate.energy,energy);
duplicate.update(.066,true,pcm,[{time:1,pcm}]);assert.equal(duplicate.energy,energy);
console.log('Timestamped audio: short-pulse polling phases, duplicate/future rejection, gap reset, adaptive targets PASS');
