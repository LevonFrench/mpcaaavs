// Optional CPU-only local-media probe. PCM must be stereo interleaved f32le at 44.1 kHz.
import { build } from 'esbuild';
import { readFileSync } from 'node:fs';
import assert from 'node:assert/strict';
const bundle=await build({entryPoints:['src/mpc-auto-director.ts'],bundle:true,format:'esm',write:false});
const {MpcAutoDirector}=await import(`data:text/javascript;base64,${Buffer.from(bundle.outputFiles[0].text).toString('base64')}`);
for(const argument of process.argv.slice(2)) {
 const [path, expectedText] = argument.split('='); const expected=Number(expectedText);
 const bytes=readFileSync(path), data=new Float32Array(bytes.buffer,bytes.byteOffset,bytes.length/4), d=new MpcAutoDirector();
 let nextReport=30, checked=0, bad=0, min=Infinity, max=0, firstLock=null, switches=0;
 d.configure(true,2);
 for(let offset=0;offset+1152<=data.length;offset+=1152) {
  const pcm=new Float32Array(1152),time=offset/2/44100;
  for(let i=0;i<576;i++){pcm[i]=data[offset+i*2];pcm[576+i]=data[offset+i*2+1];}
  if(d.update(time,true,pcm,[{time,pcm}]).switch){switches++;d.rearm();}
  if(d.tempo.locked && firstLock===null)firstLock=time;
  if(time>=10 && expected){checked++;if(!d.tempo.locked || Math.abs(d.tempo.bpm-expected)>2)bad++;min=Math.min(min,d.tempo.bpm);max=Math.max(max,d.tempo.bpm);}
 if(time>=nextReport){console.log(`${path} ${nextReport}s: ${d.tempo.bpm.toFixed(2)} BPM, locked=${d.tempo.locked}, confidence=${d.tempo.confidence.toFixed(2)}`);nextReport+=30;}
 }
 console.log({path,firstLock,min,max,checked,bad,switches});
 if(expected) {assert.ok(checked>0);assert.equal(bad,0,'every post-acquisition frame must hold the reference tempo');assert.ok(switches>0);}
}
