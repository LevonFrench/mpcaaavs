import { build } from 'esbuild';
import assert from 'node:assert/strict';
const bundle = await build({entryPoints:['src/mpc-auto-director.ts'],bundle:true,format:'esm',write:false});
const { MpcAutoDirector } = await import(`data:text/javascript;base64,${Buffer.from(bundle.outputFiles[0].text).toString('base64')}`);
const silence = new Float32Array(1152);

// Use the director's actual tracker policy, checking every poll, not only final BPM.
for (const bpm of [90,120,160]) {
  const d = new MpcAutoDirector(), period = 60 / bpm;
  const events = [];
  for(let beat=0;beat<112;beat++) {
    if(beat>=32 && beat<44) continue; // Three-bar breakdown.
    if(beat>48 && beat%9===3) continue; // Missing attacks.
    events.push(beat*period + Math.sin(beat*7)*.003);
    if(beat>=60 && beat<68) events.push((beat+.5)*period); // One fill.
  }
  let index=0, min=Infinity, max=0;
  for(let t=0;t<110*period;t+=.02) {
    while(index<events.length && events[index]<=t) d.tempo.addOnset(events[index++]);
    d.tempo.update(t);
    if(t>12*period) {
      assert.ok(d.tempo.locked,`${bpm}: lost lock at ${t}`);
      min=Math.min(min,d.tempo.bpm);max=Math.max(max,d.tempo.bpm);
      assert.ok(Math.abs(d.tempo.bpm-bpm)<3,`${bpm}: unstable reading ${d.tempo.bpm} at ${t}`);
    }
  }
  console.log(`${bpm} BPM: breakdown, missed beats and fill remain locked (${min.toFixed(2)}–${max.toFixed(2)})`);
}

const gap = new MpcAutoDirector();gap.configure(true,8);
for(let i=0;i<24;i++){gap.tempo.addOnset(i*.5);gap.tempo.update(i*.5);}
gap.update(11.5,true,silence,[]);gap.grid(3,true);
const before = gap.tempo.bpm;
gap.update(11.533,true,silence,[],true);
assert.ok(gap.tempo.locked && gap.tempo.bpm===before,'a dropped PCM batch must retain the song tempo');
// True seek still invalidates the old song clock.
gap.update(0,true,silence,[]);
assert.equal(gap.tempo.bpm,0);assert.equal(gap.tempo.locked,false);

// End-to-end stereo PCM: dense eighth-note percussion at fast tempo must not
// be censored by a 220 ms refractory period into irregular quarter-note gaps.
for(const bpm of [120,160]) {
  const d=new MpcAutoDirector(), period=60/bpm;
  let checked=0;
  for(let n=0;n<Math.ceil(28*44100/576);n++) {
    const time=n*576/44100, pcm=new Float32Array(1152);
    for(let i=0;i<576;i++) {
      const t=time+i/44100, beat=t/period, subdivision=beat*2;
      const hit=subdivision-Math.floor(subdivision);
      const percussion=hit<.08 ? .15*Math.exp(-hit*35)*Math.sin(2*Math.PI*7000*t) : 0;
      pcm[i]=pcm[576+i]=.12*Math.sin(2*Math.PI*100*t)+percussion;
    }
    d.update(time,true,pcm,[{time,pcm}]);
    if(time>12){assert.ok(d.tempo.locked && Math.abs(d.tempo.bpm-bpm)<4,`PCM ${bpm}: ${d.tempo.bpm} locked=${d.tempo.locked} at ${time}`);checked++;}
  }
  assert.ok(checked>100);
}
console.log('MPC clock: drop continuity, seek reset, dense PCM percussion PASS');

// Real detector path: repeated packet losses, a tempo change, then silence.
const changing = new MpcAutoDirector();
for(let n=0;n<Math.ceil(75*44100/576);n++) {
  const time=n*576/44100,pcm=new Float32Array(1152),bpm=time<25?109:92;
  for(let i=0;i<576;i++) {
    const t=time+i/44100,relative=t<25?t:t-25,age=relative%(60/bpm);
    pcm[i]=pcm[576+i]=time<55 && age<.04 ? .5*Math.exp(-age*35)*Math.sin(2*Math.PI*1000*t) : 0;
  }
  const drop=n%127===0;
  changing.update(time,true,pcm,drop?[]:[{time,pcm}],drop);
  if(time>12 && time<24)assert.ok(changing.tempo.locked && Math.abs(changing.tempo.bpm-109)<2,'packet loss preserves measured tempo');
  if(time>44 && time<54)assert.ok(changing.tempo.locked && Math.abs(changing.tempo.bpm-92)<2,`tempo change must reacquire, got ${changing.tempo.bpm}`);
  if(time>74)assert.equal(changing.tempo.locked,false,'silence must eventually retire the predicted grid');
}
console.log('MPC measured clock: repeated packet loss, 109 to 92 BPM change, eventual silence unlock PASS');
