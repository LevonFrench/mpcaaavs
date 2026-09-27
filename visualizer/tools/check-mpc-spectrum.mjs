import { build } from 'esbuild';
import assert from 'node:assert/strict';
async function load(path){const r=await build({entryPoints:[path],bundle:true,format:'esm',write:false});return import(`data:text/javascript;base64,${Buffer.from(r.outputFiles[0].text).toString('base64')}`);}
const {PcmNormalizer,AudioHold}=await load('src/mpc-audio-stream.ts');
const {AvsAudioAnalyser,avsAudioSample}=await load('src/avs/audio.ts');
const {MpcAutoDirector}=await load('src/mpc-auto-director.ts');
for(const rate of [44100,48000,96000,192000,384000]) {
 for(const hz of [100,1000,6000,12000,18000]) {
  const normalizer=new PcmNormalizer(), analyser=new AvsAudioAnalyser();let latest;
  for(let offset=0;offset<rate*.08;offset+=317) {
   const samples=Math.min(317,Math.ceil(rate*.08)-offset),pcm=new Float32Array(1152);
   for(let i=0;i<samples;i++)pcm[i]=.3*Math.sin(2*Math.PI*hz*(offset+i)/rate);
   for(const frame of normalizer.push({time:offset/rate,pcm,sampleRate:rate,samples}))latest=analyser.analyse({left:frame.pcm.subarray(0,576),right:frame.pcm.subarray(576)});
  }
  assert.ok(latest);const peak=latest.spectrum[0].indexOf(Math.max(...latest.spectrum[0]));
  assert.ok(Math.abs(peak/2*44100/512-hz)<180,`${rate}Hz input ${hz}Hz tone maps to ${peak/2*44100/512}`);
  assert.ok(avsAudioSample(latest,'spec',hz/(44100/512*288),.015,1)>.12,`getspec must see ${hz}Hz at ${rate}`);
  assert.equal(Math.max(...latest.spectrum[1]),0,'stereo isolation');
 }
}
// A short high-frequency burst survives a later quiet callback until each renderer consumes it.
const a=new AvsAudioAnalyser(),hold=new AudioHold(),tone=new Float32Array(576);
for(let i=0;i<576;i++)tone[i]=.3*Math.sin(2*Math.PI*12000*i/44100);
const hit=a.analyse({left:tone});hold.push(hit);hold.push(a.analyse({left:new Float32Array(576)}));
assert.ok(Math.max(...hold.consume().spectrum[0])>100);assert.equal(Math.max(...hold.consume().spectrum[0]),0);
const director=new MpcAutoDirector();director.configure(true,2);let switches=0;
for(let i=0;i<1400;i++) {
 const time=i*576/44100,pcm=new Float32Array(1152);
 for(let k=0;k<576;k++){const t=time+k/44100;pcm[k]=pcm[576+k]=.25*Math.sin(2*Math.PI*100*t)+(t%.5<.025?.055*Math.sin(2*Math.PI*9000*t):0);}
 if(director.update(time,true,pcm).switch){switches++;director.rearm();}
}
assert.ok(director.tempo.locked&&Math.abs(director.tempo.bpm-120)<3,`high percussion over steady bass must lock, got ${director.tempo.bpm}`);
assert.ok(switches>0,'full-band musical evidence must advance Auto');
for(const hz of [30,60,100,440,1000,9000]) {
 const d=new MpcAutoDirector();
 for(let i=0;i<800;i++) {const time=i*576/44100,p=new Float32Array(1152);for(let k=0;k<576;k++)p[k]=p[576+k]=.2*Math.sin(2*Math.PI*hz*(time+k/44100));d.update(time,true,p);}
 assert.equal(d.tempo.locked,false,`steady ${hz}Hz tone must not invent a tempo`);
}
for(const rate of [48000,384000]) {
 const normalizer=new PcmNormalizer(), d=new MpcAutoDirector();let cursor=0;
 for(let poll=0;poll<300;poll++) {
  const position=poll*.033, frames=[];
  while(cursor/rate<=position) {const pcm=new Float32Array(1152);for(let k=0;k<576;k++){const t=(cursor+k)/rate;pcm[k]=pcm[576+k]=t%.5<.015?.4*Math.sin(2*Math.PI*8000*t):0;}frames.push(...normalizer.push({time:cursor/rate,pcm,sampleRate:rate,samples:576}));cursor+=576;}
  d.update(position,true,new Float32Array(1152),frames);
 }
 assert.ok(d.tempo.locked&&Math.abs(d.tempo.bpm-120)<3,`normalized ${rate}Hz high-percussion stream must lock`);
}
console.log('Full-band audio: 100Hz–18kHz, 44.1–384kHz, partial packets, stereo/getspec, held treble transient, Auto over steady bass PASS');
