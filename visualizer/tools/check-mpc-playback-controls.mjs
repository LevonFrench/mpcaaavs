import {build} from 'esbuild';
import assert from 'node:assert/strict';
// Setup Builder playback, timing and transition controls (contract S7 seed, extended by the TIM stream for Timing System v2).
// The DOM is a minimal fake: only the calls the controls make, so this also proves they need nothing more (BRW's management check has an equally small one).
async function load(path){const r=await build({entryPoints:[path],bundle:true,format:'esm',write:false});return import(`data:text/javascript;base64,${Buffer.from(r.outputFiles[0].text).toString('base64')}`);}
class Element {
 constructor(tag){this.tagName=tag;this.children=[];this.attributes={};this.textContent='';this.value='';this.className='';}
 append(...children){this.children.push(...children);}prepend(...children){this.children.unshift(...children);}
 replaceChildren(...children){this.children=children;}setAttribute(k,v){this.attributes[k]=v;}
 all(){return [this,...this.children.flatMap(c=>c.all())];}
}
globalThis.document={createElement:tag=>new Element(tag)};
const {renderPlaybackControls}=await load('src/mpc-playback-controls.ts');
const {TRANSITIONS}=await load('src/mpc-transition.ts');
const {defaultSettings,parseSetups,canonicalSettings}=await load('src/mpc-setups.ts');
const {defaultSceneTiming,parseSceneTiming,compileSceneClock}=await load('src/mpc-scene-clock.ts');
const {FADE_TIMING_LABELS}=await load('src/mpc-transition-timing.ts');
const {captureTempo,downbeatHere}=await load('src/mpc-timing-tools.ts');
const {exportCueSheet}=await load('src/mpc-cue-sheet.ts');
const legacyKeys=Object.keys(defaultSettings);
const hash=n=>n.toString(16).padStart(64,'0');
function render(prefix='Setup',{ctx,settings:over={},timing:timingOver={}}={}){
 const host=new Element('div'),settings={...defaultSettings,...over},timing={...defaultSceneTiming,...timingOver},dirty=[];
 renderPlaybackControls(host,settings,timing,redraw=>dirty.push(redraw===true),prefix,ctx);
 const find=label=>{const e=host.all().find(x=>x.attributes['aria-label']===label);assert.ok(e,`control ${label}`);return e;};
 const button=text=>{const e=host.all().find(x=>x.tagName==='button'&&x.textContent===text);assert.ok(e,`button ${text}`);return e;};
 const click=text=>{const b=button(text);assert.ok(!b.disabled,`${text} is enabled`);b.onclick();};
 const choose=(label,value)=>{const e=find(label);e.value=String(value);e.onchange();};
 const type=(label,value)=>{const e=find(label);e.value=String(value);e.oninput();};
 const check=(label,on)=>{const e=find(label);e.checked=on;e.onchange();};
 const status=()=>host.all().find(e=>e.className==='timing-status').textContent;
 const problem=()=>host.all().find(e=>e.className==='timing-problem').textContent;
 const readout=()=>host.all().find(e=>e.className==='timing-readout').textContent;
 const hint=()=>host.all().find(e=>e.className==='timing-hint').textContent;
 return {host,settings,timing,dirty,all:host.all(),find,button,click,choose,type,check,status,problem,readout,hint};
}
const seconds=list=>list.map(e=>e.textContent);

// Accessible names and visible labels: the historical ones under the Setup prefix, plus the Timing System v2 controls.
{
 const {host,all,find}=render('Setup');
 assert.deepEqual(all.filter(e=>e.tagName==='select').map(e=>e.attributes['aria-label']),['Setup auto phrase','Setup transition','Setup timing','Setup transition lands','Setup seconds / fallback','Setup manual queue','Setup shuffle minimum rating']);
 assert.deepEqual(all.filter(e=>e.tagName==='label'&&e.children.some(c=>c.tagName==='select')).map(e=>e.textContent),['Auto phrase','Transition','Timing','Transition lands','Seconds / fallback','Manual queue','Shuffle minimum rating']);
 assert.deepEqual(all.filter(e=>e.tagName==='label'&&e.children.some(c=>c.type==='checkbox')).map(e=>e.textContent),['Instant','1 beat','2 beats','1 bar','2 bars','Auto switching','Shuffle','Animate outgoing preset','Transitions on manual changes','Transitions on Auto changes','Follow the song clock','Hold the last entry']);
 assert.deepEqual(all.filter(e=>e.tagName==='input'&&e.type==='number').map(e=>e.attributes['aria-label']),['Song BPM','First scene offset (seconds)','Bars per scene','Shuffle seed','Beats per bar']);
 assert.deepEqual(all.filter(e=>e.tagName==='input'&&e.type==='text').map(e=>e.attributes['aria-label']),['Bars pattern']);
 assert.deepEqual(all.filter(e=>e.tagName==='textarea').map(e=>e.attributes['aria-label']),['Tempo changes','Cue sheet']);
 assert.equal(find('Repeatable scene timing').type,'checkbox');
 assert.deepEqual(all.filter(e=>e.tagName==='h2').map(e=>e.textContent),['Repeatable scene timing']);assert.deepEqual(all.filter(e=>e.tagName==='h3').map(e=>e.textContent),['Timing tools']);
 assert.equal(find('Setup transition').children.length,TRANSITIONS.length,'one option per named transition');
 assert.deepEqual(seconds(find('Setup timing').children),['Seconds','Instant','1 beat','2 beats','1 bar','2 bars','Random'],'"4 beats" is now "1 bar"');assert.deepEqual([...FADE_TIMING_LABELS],seconds(find('Setup timing').children));
 assert.deepEqual(find('Setup timing').children.map(o=>o.value),['0','1','2','3','4','5','6']);
 assert.deepEqual(seconds(find('Setup auto phrase').children),['Adaptive: 2–12 bars','2 bars','4 bars','8 bars','12 bars']);
 assert.deepEqual(seconds(find('Setup transition lands').children),['Starts at the scene boundary','Ends on the scene boundary','Peaks on the scene boundary']);
 assert.deepEqual(seconds(find('Setup manual queue').children),['Immediately','On the next beat','On the next bar','On the next phrase']);
 assert.deepEqual(all.filter(e=>e.tagName==='button').map(e=>e.textContent),['Tap tempo','−1 beat','−50 ms','−10 ms','+10 ms','+50 ms','+1 beat','Downbeat here','Restart sequence here','Use detected tempo','Export cue sheet','Import cue sheet']);
 assert.ok(host.children.at(-1).textContent.startsWith('Timed NERV changes use the Transition and Timing controls above'));
 assert.ok(all.some(e=>e.tagName==='p'&&e.textContent.startsWith('The same song position selects the same scene')));assert.ok(all.some(e=>e.tagName==='p'&&e.textContent.startsWith('A positive offset holds the opening scene')));
 // Default state: Seconds, all lengths in the Random set, start anchor, immediate queue.
 assert.equal(find('Setup timing').value,'0');assert.equal(find('Setup seconds / fallback').value,'2000');assert.equal(find('Setup transition lands').value,'0');assert.equal(find('Setup manual queue').value,'0');
}

// Behaviour of the historical controls: edits in place, only the clock toggle asks for a redraw.
{
 const {settings,timing,dirty,find,choose}=render('Setup');
 choose('Setup transition',15);assert.equal(settings.transition,15);
 choose('Setup auto phrase',8);assert.equal(settings.bars,8);
 choose('Setup timing',4);assert.equal(settings.beats,4,'1 bar is the legacy "4 beats" projection');assert.equal('fadeTiming' in settings,false);
 choose('Setup seconds / fallback',500);assert.equal(settings.durationMs,500);
 choose('Setup shuffle minimum rating',3);assert.equal(settings.minimumRating,3);
 assert.deepEqual(dirty,[false,false,false,false,false]);
 assert.equal(find('Setup transition').value,'15','the selected value is reflected');
 for(const [text,key] of [['Auto switching','enabled'],['Shuffle','shuffle'],['Animate outgoing preset','keepOld'],['Transitions on manual changes','manualFade'],['Transitions on Auto changes','autoFade']]){
  const {settings:s,all}=render('Setup');const box=all.find(e=>e.tagName==='label'&&e.textContent===text).children.find(c=>c.type==='checkbox');
  assert.equal(box.checked,defaultSettings[key]);box.checked=!box.checked;box.onchange();assert.equal(s[key],box.checked,`${text} edits ${key}`);
 }
 const toggle=find('Repeatable scene timing'),bpm=find('Song BPM');
 assert.equal(bpm.disabled,true,'timing inputs are disabled while the song clock is off');
 toggle.checked=true;toggle.onchange();assert.equal(timing.enabled,true);assert.equal(dirty.at(-1),true,'the clock toggle requests a redraw');assert.equal(bpm.disabled,false,'and enables the timing inputs without one');
 bpm.value='';bpm.oninput();assert.ok(Number.isNaN(timing.bpm),'a cleared number field becomes NaN so validation rejects it');
 bpm.value='128.5';bpm.oninput();assert.equal(timing.bpm,128.5);assert.equal(dirty.at(-1),false);
 const offset=find('First scene offset (seconds)');offset.value='-3';offset.oninput();assert.equal(timing.offsetSeconds,-3);
 const bars=find('Bars per scene');bars.value='4';bars.oninput();assert.equal(timing.barsPerScene,4);
 const seed=find('Shuffle seed');seed.value='89';seed.oninput();assert.equal(timing.seed,89);
 assert.deepEqual([bpm.min,bpm.max,bpm.step],['20','400','0.01']);assert.deepEqual([seed.min,seed.max,seed.step],['0','4294967295','1']);
 assert.deepEqual(Object.keys(timing),['enabled','bpm','offsetSeconds','barsPerScene','seed'],'a v1 edit leaves exactly the five timing keys');
 assert.equal(JSON.stringify(parseSceneTiming(timing)),JSON.stringify(timing));
}

// Transition timing: the Timing select stores canonical settings (C-03, C-04): `beats` is the projection, v2 fields only when they differ from their defaults.
{
 const {settings,dirty,choose,find,hint}=render('Setup');
 const expected={0:[0,false],1:[0,true],2:[1,false],3:[2,false],4:[4,false],5:[0,true],6:[0,true]};
 for(const [value,[beats,written]] of Object.entries(expected)){
  choose('Setup timing',value);
  assert.equal(settings.beats,beats,`fadeTiming ${value} projects to beats ${beats}`);assert.equal('fadeTiming' in settings,written,`fadeTiming ${value} written: ${written}`);
  if(written)assert.equal(settings.fadeTiming,Number(value));
  assert.equal(find('Setup timing').value,value);assert.doesNotThrow(()=>parseSetups([{id:'s',name:'S',presets:[],settings,timing:defaultSceneTiming}]));
 }
 choose('Setup timing',0);assert.deepEqual(Object.keys(settings),legacyKeys,'back to Seconds: exactly the ten legacy keys');assert.deepEqual(settings,defaultSettings);
 assert.ok(dirty.every(d=>d===false));
 // The hint follows the choice and the meter.
 choose('Setup timing',0);assert.match(hint(),/fixed length/);choose('Setup timing',1);assert.match(hint(),/hard cut/);
 choose('Setup timing',4);assert.match(hint(),/^1 bar = 4 beats\. With no song clock and no locked tempo a fade uses Seconds \/ fallback\.$/);
 choose('Setup timing',6);assert.match(hint(),/Random draws one of the lengths checked below/);
}
// A legacy setup shows its legacy value; a v2 value wins over `beats`.
{
 assert.equal(render('Setup',{settings:{beats:2}}).find('Setup timing').value,'3');assert.equal(render('Setup',{settings:{beats:4}}).find('Setup timing').value,'4');
 assert.equal(render('Setup',{settings:{beats:2,fadeTiming:5}}).find('Setup timing').value,'5');
}
// Random includes: five lengths, enabled only for Random, the last one cannot be cleared, the default set is never written.
{
 const {settings,find,choose,check,status}=render('Setup');
 const names=['instant','1 beat','2 beats','1 bar','2 bars'],box=i=>find(`Setup random includes ${names[i]}`);
 for(let i=0;i<5;i++){assert.equal(box(i).checked,true);assert.equal(box(i).disabled,true,'Random includes is disabled for a fixed timing');}
 choose('Setup timing',6);for(let i=0;i<5;i++)assert.equal(box(i).disabled,false);
 check('Setup random includes instant',false);assert.equal(settings.fadeRandomSet,30);assert.equal(box(0).checked,false);
 check('Setup random includes 2 bars',false);assert.equal(settings.fadeRandomSet,14);
 check('Setup random includes 1 bar',false);check('Setup random includes 2 beats',false);assert.equal(settings.fadeRandomSet,2);
 check('Setup random includes 1 beat',false);assert.equal(settings.fadeRandomSet,2,'the last member stays');assert.equal(box(1).checked,true);assert.equal(status(),'Random needs at least one length.');
 check('Setup random includes instant',true);check('Setup random includes 1 bar',true);check('Setup random includes 2 beats',true);check('Setup random includes 2 bars',true);
 assert.equal('fadeRandomSet' in settings,false,'the full set is the default and is not stored');assert.equal(settings.fadeTiming,6);
 choose('Setup timing',3);for(let i=0;i<5;i++)assert.equal(box(i).disabled,true);
 // A stored mask is shown.
 const stored=render('Setup',{settings:{fadeTiming:6,fadeRandomSet:22,beats:0}});
 assert.deepEqual([0,1,2,3,4].map(i=>stored.find(`Setup random includes ${names[i]}`).checked),[false,true,true,false,true]);
}
// Anchor and manual queue: shown always, changeable only when the host acts on them; only non-default values are stored.
{
 const off=render('Setup');assert.equal(off.find('Setup transition lands').disabled,true);assert.equal(off.find('Setup manual queue').disabled,true);
 assert.match(off.find('Setup transition lands').title,/needs a newer player/);assert.match(off.find('Setup manual queue').title,/needs a newer player/);
 const on=render('Setup',{ctx:{anchors:true,quantizedQueue:true}});assert.equal(on.find('Setup transition lands').disabled,false);assert.equal(on.find('Setup manual queue').disabled,false);
 on.choose('Setup transition lands',1);assert.equal(on.settings.fadeAnchor,1);on.choose('Setup manual queue',2);assert.equal(on.settings.queueQuantize,2);
 assert.deepEqual(Object.keys(on.settings),[...legacyKeys,'fadeAnchor','queueQuantize']);assert.doesNotThrow(()=>parseSetups([{id:'s',name:'S',presets:[],settings:on.settings}]));
 on.choose('Setup transition lands',2);assert.equal(on.settings.fadeAnchor,2);on.choose('Setup transition lands',0);on.choose('Setup manual queue',0);assert.deepEqual(on.settings,defaultSettings,'defaults are removed again');
 // A stored value stays visible even when the host cannot act on it yet.
 const shown=render('Setup',{settings:{fadeAnchor:1,queueQuantize:3}});assert.equal(shown.find('Setup transition lands').value,'1');assert.equal(shown.find('Setup manual queue').value,'3');
}
// Seconds / fallback keeps its choices and shows a stored value that is not among them (a cue sheet or the Player may hold one).
{
 const {find,settings,choose}=render('Setup',{settings:{durationMs:1500}});
 assert.equal(find('Setup seconds / fallback').value,'1500');assert.ok(find('Setup seconds / fallback').children.some(o=>o.value==='1500'&&o.textContent==='1.5'));
 assert.deepEqual(find('Setup seconds / fallback').children.slice(0,6).map(o=>o.value),['250','500','1000','2000','4000','8000']);
 choose('Setup seconds / fallback',250);assert.equal(settings.durationMs,250);
}

// Scene timing v2: beats per bar, bars pattern, tempo changes. New controls write only non-default fields and keep the parser's own messages.
{
 const {timing,find,type,check,problem,hint,choose,dirty}=render('Setup',{timing:{enabled:true}});
 type('Beats per bar','3');assert.equal(timing.beatsPerBar,3);assert.equal(timing.version,2);assert.equal(problem(),'');
 choose('Setup timing',4);assert.match(hint(),/^1 bar = 3 beats\./,'the hint states the meter');
 type('Beats per bar','4');assert.equal('beatsPerBar' in timing,false,'the default meter is not stored');assert.equal('version' in timing,false);assert.deepEqual(Object.keys(timing),['enabled','bpm','offsetSeconds','barsPerScene','seed']);
 type('Beats per bar','');assert.ok(Number.isNaN(timing.beatsPerBar));assert.match(problem(),/beatsPerBar must be a whole number from 1 to 16/);
 for(const bad of ['0','17','2.5'])type('Beats per bar',bad),assert.match(problem(),/beatsPerBar/,bad);
 type('Beats per bar','7');assert.equal(problem(),'');assert.equal(timing.beatsPerBar,7);type('Beats per bar','4');
 // Pattern.
 type('Bars pattern','4, 4, 8, 16');assert.deepEqual(timing.barsPattern,[4,4,8,16]);assert.equal(timing.barsPerScene,4,'barsPerScene follows the first entry');assert.equal(timing.version,2);assert.equal(problem(),'');
 assert.equal(find('Bars per scene').disabled,true,'a pattern owns the scene lengths');assert.equal(find('Bars per scene').value,'4');
 check('Hold last pattern entry',true);assert.equal(timing.patternHold,true);check('Hold last pattern entry',false);assert.equal('patternHold' in timing,false,'hold false is the default');
 type('Bars pattern','2;3 1');assert.deepEqual(timing.barsPattern,[2,3,1]);assert.equal(timing.barsPerScene,2);
 for(const bad of ['4,x','4,0','4,129','1.5','-4','x'])type('Bars pattern',bad),assert.ok(timing.barsPattern.some(n=>!Number.isInteger(n)||n<1||n>128),bad),assert.match(problem(),/barsPattern must list 1 to 64 whole numbers from 1 to 128/,bad);
 type('Bars pattern','6,,');assert.equal('barsPattern' in timing,false,'one entry is just bars per scene');assert.equal(timing.barsPerScene,6);assert.equal(problem(),'','trailing separators are tolerated');type('Bars pattern','6, 8,');assert.deepEqual(timing.barsPattern,[6,8]);
 type('Bars pattern','4,4,'+'4,'.repeat(70));assert.match(problem(),/barsPattern/,'more than 64 entries');
 type('Bars pattern','');assert.equal('barsPattern' in timing,false);assert.equal('patternHold' in timing,false);assert.equal(find('Bars per scene').disabled,false);assert.equal(problem(),'');assert.equal(timing.barsPerScene,4,'the projection stays');
 type('Bars pattern','6');assert.equal('barsPattern' in timing,false,'a one-entry pattern equal to barsPerScene is the default');
 type('Bars pattern','5');assert.equal('barsPattern' in timing,false);assert.equal(timing.barsPerScene,5,'one entry is bars per scene');type('Bars pattern','');
 assert.deepEqual(Object.keys(timing),['enabled','bpm','offsetSeconds','barsPerScene','seed']);assert.ok(dirty.every(d=>d===false));
 // Tempo changes.
 type('Tempo changes','60 90\n20,140\n');assert.deepEqual(timing.tempoMap,[{at:20,bpm:140},{at:60,bpm:90}],'sorted by time');assert.equal(timing.version,2);assert.equal(problem(),'');
 for(const bad of ['20','20 140 1','abc 140','20 x','20 19','20 401','0 100'])type('Tempo changes',bad),assert.match(problem(),/tempoMap/,bad);
 type('Tempo changes','20 140\n20 150');assert.match(problem(),/tempoMap/,'equal times');
 type('Tempo changes','  30 @ 100  ');assert.deepEqual(timing.tempoMap,[{at:30,bpm:100}]);assert.equal(problem(),'','the @ separator and spaces are fine');
 type('Tempo changes','');assert.equal('tempoMap' in timing,false);assert.equal('version' in timing,false);assert.deepEqual(Object.keys(timing),['enabled','bpm','offsetSeconds','barsPerScene','seed']);
}
// A person types one character at a time and every keystroke refreshes the panel: a field must keep what was typed while it still means the stored value.
// (A lone "8" in Bars pattern equals Bars per scene and is stored as no pattern, so the first digit of "8, 16" once vanished.) A number input reports ''
// while its text is not yet a number; `keepDot` models a browser that reports "12." as typed.
{
 const numberValue=(text,keepDot)=>/^-?\d+(\.\d+)?$/.test(text)||(keepDot&&/^-?\d+\.$/.test(text))?text:'';
 const typing=(r,label,text,keepDot)=>{
  const el=r.find(label),isNumber=el.type==='number';el.value='';let shown='';
  for(const ch of text){shown+=ch;el.value=isNumber?numberValue(shown,keepDot):shown;el.oninput();shown=isNumber?(el.value!==numberValue(shown,keepDot)?el.value:shown):el.value;}
  return shown;
 };
 const cases=[['Bars pattern','4, 4, 8, 16'],['Bars pattern','8, 16'],['Bars pattern','8'],['Bars pattern','2, 4, 1'],['Bars pattern','16;8 4'],['Tempo changes','134.2 140'],['Tempo changes','60 90\n120 140\n200.5 100'],
  ['Song BPM','128.5'],['First scene offset (seconds)','-0.25'],['First scene offset (seconds)','12.5'],['Beats per bar','7'],['Bars per scene','16'],['Shuffle seed','12345']];
 for(const keepDot of [false,true])for(const [label,text] of cases){
  for(const barsPerScene of [8,4]){
   const r=render('Setup',{timing:{enabled:true,barsPerScene}});
   assert.equal(typing(r,label,text,keepDot).replace(/\s+/g,''),text.replace(/\s+/g,''),`typing ${JSON.stringify(text)} into ${label} (bars per scene ${barsPerScene}) leaves it as typed`);
  }
 }
 // The typed pattern is also what was stored, and deleting back to one entry keeps the text while the pattern goes away.
 const r=render('Setup',{timing:{enabled:true,barsPerScene:8}});typing(r,'Bars pattern','8, 16',false);
 assert.deepEqual(r.timing.barsPattern,[8,16]);assert.equal(r.find('Bars pattern').value,'8, 16');
 r.find('Bars pattern').value='8,';r.find('Bars pattern').oninput();assert.equal('barsPattern' in r.timing,false);assert.equal(r.find('Bars pattern').value,'8,','one entry equal to Bars per scene: the typed text stays');
 assert.equal(r.find('Bars per scene').disabled,false,'and Bars per scene is editable again');
 // A timing changed from outside (a cue-sheet import) still replaces the text the controls show.
 r.timing.barsPattern=[3,5];r.timing.version=2;r.find('Song BPM').oninput();assert.equal(r.find('Bars pattern').value,'3, 5');
}

// A draft the controls leave behind is always what parseSetups accepts, or a message says why not.
{
 const {settings,timing,type,choose}=render('Setup',{timing:{enabled:true}});
 type('Beats per bar','5');type('Bars pattern','2,4');type('Tempo changes','40 100\n90 130');choose('Setup timing',6);
 const saved=parseSetups(JSON.parse(JSON.stringify([{id:'x',name:'X',presets:[],settings,timing}])))[0];
 assert.deepEqual(saved.timing,timing);assert.deepEqual(saved.settings,settings);assert.deepEqual(saved.timing,{enabled:true,bpm:120,offsetSeconds:0,barsPerScene:2,seed:1,version:2,beatsPerBar:5,barsPattern:[2,4],tempoMap:[{at:40,bpm:100},{at:90,bpm:130}]});
}

// Timing tools.
{
 // Tap tempo: spacing of the taps, from an injected clock; refused while paused; the estimate needs four taps.
 let t=100;const playing={value:true};
 const r=render('Setup',{ctx:{now:()=>t,playing:()=>playing.value},timing:{enabled:true}});
 r.click('Tap tempo');assert.equal(r.status(),'Keep tapping: 1 of 4 taps.');t+=.5;r.click('Tap tempo');t+=.5;r.click('Tap tempo');assert.equal(r.status(),'Keep tapping: 3 of 4 taps.');assert.equal(r.timing.bpm,120);
 t+=.5;r.click('Tap tempo');assert.equal(r.timing.bpm,120);assert.equal(r.status(),'120 BPM from 4 taps.');assert.equal(r.find('Song BPM').value,'120');
 for(let i=0;i<3;i++){t+=60/93;r.click('Tap tempo');}assert.ok(Math.abs(r.timing.bpm-93)<20);t+=60/93;
 playing.value=false;const before=r.timing.bpm;r.click('Tap tempo');assert.equal(r.status(),'Tap along while the song plays.');assert.equal(r.timing.bpm,before);
 playing.value=true;
 const fresh=render('Setup',{ctx:{now:()=>t,playing:()=>true},timing:{enabled:true}});for(let i=0;i<8;i++){fresh.click('Tap tempo');t+=60/140.5;}assert.equal(fresh.timing.bpm,140.5);assert.deepEqual(Object.keys(fresh.timing),['enabled','bpm','offsetSeconds','barsPerScene','seed']);
 // Tools need the song clock; the position tools need a position.
 const off=render('Setup');for(const b of off.all.filter(e=>e.tagName==='button'&&['Tap tempo','+10 ms','Downbeat here','Use detected tempo'].includes(e.textContent)))assert.equal(b.disabled,true,`${b.textContent} waits for the song clock`);
 const noPosition=render('Setup',{timing:{enabled:true}});
 for(const name of ['Downbeat here','Restart sequence here','Use detected tempo']){assert.equal(noPosition.button(name).disabled,true,`${name} needs a position`);assert.match(noPosition.button(name).title,/loaded song/);}
 for(const name of ['Tap tempo','+10 ms','−1 beat'])assert.equal(noPosition.button(name).disabled,false);
}
{
 // Nudge: exact steps, one beat follows the tempo, the offset is clamped.
 const r=render('Setup',{timing:{enabled:true,bpm:120,offsetSeconds:.42}});
 r.click('+50 ms');assert.equal(r.timing.offsetSeconds,.47);assert.equal(r.status(),'First scene offset 0.47 s.');r.click('−10 ms');assert.equal(r.timing.offsetSeconds,.46);r.click('+10 ms');r.click('−50 ms');assert.equal(r.timing.offsetSeconds,.42);
 r.click('+1 beat');assert.equal(r.timing.offsetSeconds,.92);r.click('−1 beat');r.click('−1 beat');assert.equal(r.timing.offsetSeconds,-.08);assert.equal(r.find('First scene offset (seconds)').value,'-0.08','the field follows');
 const limit=render('Setup',{timing:{enabled:true,offsetSeconds:3599.99}});limit.click('+50 ms');assert.equal(limit.timing.offsetSeconds,3600);
 const bad=render('Setup',{timing:{enabled:true,bpm:NaN}});bad.click('+1 beat');assert.equal(bad.status(),'Set a valid song BPM first.');
 assert.deepEqual(Object.keys(r.timing),['enabled','bpm','offsetSeconds','barsPerScene','seed']);
 // With a tempo change behind the new offset the tempo timeline is kept: the change is folded into the base tempo.
 const mapped=render('Setup',{timing:{enabled:true,bpm:120,offsetSeconds:10,tempoMap:[{at:10.4,bpm:60},{at:50,bpm:90}],version:2}});
 mapped.click('+1 beat');assert.equal(mapped.timing.offsetSeconds,10.5);assert.equal(mapped.timing.bpm,60,'the tempo in force at the new offset');assert.deepEqual(mapped.timing.tempoMap,[{at:50,bpm:90}]);
}
{
 // Downbeat here, Restart sequence here, and the readout, from an injected position.
 let position=5.3;
 const r=render('Setup',{ctx:{position:()=>position,playing:()=>true},timing:{enabled:true,bpm:120,offsetSeconds:0}});
 r.click('Downbeat here');assert.equal(r.timing.offsetSeconds,1.3);assert.equal(r.status(),'Offset moved to 1.3 s: a bar line falls at 5.3 s.');assert.equal(r.find('First scene offset (seconds)').value,'1.3');
 r.click('Downbeat here');assert.equal(r.timing.offsetSeconds,1.3);assert.equal(r.status(),'5.3 s is already on a bar line.');
 assert.equal(r.readout(),'bar 3.1 · scene 1 · 8 bars');
 position=1;r.click('Restart sequence here');assert.equal(r.timing.offsetSeconds,1);assert.equal(r.status(),'The first scene now starts at 1 s.');
 assert.equal(r.readout(),'bar 1.1 · scene 1 · 8 bars');
 position=.25;assert.equal(r.readout(),'bar 1.1 · scene 1 · 8 bars','the text changes on the next refresh, not before');
 r.click('+10 ms');assert.equal(r.readout(),'count-in 0.8 s · scene 1 · 8 bars','offset 1.01 s, position 0.25 s');
 position=9.5;r.click('+10 ms');assert.equal(r.readout(),'bar 5.1 · scene 1 · 8 bars','offset 1.02 s: 16.96 beats in');
 position=1e9;r.click('+10 ms');assert.match(r.readout(),/^bar \d+\.\d · scene \d+ · 8 bars$/);
 position=NaN;r.click('+10 ms');assert.equal(r.readout(),'');
 // Pattern lengths and meter show in the readout.
 position=40;const p=render('Setup',{ctx:{position:()=>position},timing:{enabled:true,bpm:120,offsetSeconds:0,barsPattern:[2,4],barsPerScene:2,beatsPerBar:3,version:2}});
 const clock=compileSceneClock({...p.timing}),f=clock.at(40,[0],false),bb=clock.barBeat(40);
 assert.equal(p.readout(),`bar ${bb.bar}.${bb.beat} · scene ${f.ordinal+1} · ${(f.endBeat-f.startBeat)/3} bars`);
 // Invalid timing and a stopped clock leave the readout empty.
 const inv=render('Setup',{ctx:{position:()=>5},timing:{enabled:true,bpm:NaN}});assert.equal(inv.readout(),'');assert.match(inv.problem(),/Scene timing requires/);
 assert.equal(render('Setup',{ctx:{position:()=>5}}).readout(),'');
}
{
 // Downbeat here with a tempo change: the offset moves, the tempo timeline is kept, and the position sits on a bar line of the new grid.
 const timing={...defaultSceneTiming,enabled:true,bpm:100,offsetSeconds:0,tempoMap:[{at:1.1,bpm:200},{at:30,bpm:120}],version:2};
 const r=render('Setup',{ctx:{position:()=>17.77},timing});
 const target=downbeatHere(parseSceneTiming(timing),17.77);r.click('Downbeat here');
 assert.equal(r.timing.offsetSeconds,target);assert.doesNotThrow(()=>parseSceneTiming(r.timing));
 const grid=compileSceneClock(r.timing).grid,beats=grid.beatAt(17.77);assert.ok(Math.abs(beats-Math.round(beats/4)*4)<1e-4,`on a bar line (${beats})`);
}
{
 // Use detected tempo: needs a lock and a position; copies the tempo and a beat of the detected grid; one shot.
 let tempo={locked:false,bpm:0,phase:0};const position=95.3;
 const r=render('Setup',{ctx:{position:()=>position,tempo:()=>tempo},timing:{enabled:true,bpm:100,offsetSeconds:0}});
 r.click('Use detected tempo');assert.match(r.status(),/No tempo lock yet/);assert.equal(r.timing.bpm,100);
 tempo={locked:true,bpm:128.004,phase:.25};r.click('Use detected tempo');
 const expected=captureTempo(tempo,position,4,0);assert.equal(r.timing.bpm,128);assert.equal(r.timing.offsetSeconds,expected.offsetSeconds);assert.ok(Math.abs(r.timing.offsetSeconds)<=.25);
 assert.match(r.status(),/^Copied 128 BPM and moved the offset to /);assert.equal(r.find('Song BPM').value,'128');
 tempo={locked:true,bpm:90,phase:.5};r.click('Use detected tempo');assert.equal(r.timing.bpm,90,'each click is a fresh copy; nothing follows the detector');
 assert.deepEqual(Object.keys(r.timing),['enabled','bpm','offsetSeconds','barsPerScene','seed']);
 const noTempoSource=render('Setup',{ctx:{position:()=>5},timing:{enabled:true}});noTempoSource.click('Use detected tempo');assert.match(noTempoSource.status(),/No tempo lock yet/);
}

// Cue sheets through the text box.
{
 const r=render('Setup',{timing:{enabled:true,bpm:128,offsetSeconds:.42,barsPerScene:4,seed:7,version:2,beatsPerBar:3,barsPattern:[4,4,8],script:[{ordinal:1,preset:hash(1)},{ordinal:3,preset:hash(2)}]},settings:{fadeTiming:6,fadeRandomSet:22,beats:0,durationMs:1500}});
 const area=r.find('Cue sheet');
 r.click('Export cue sheet');assert.match(r.status(),/^Cue sheet ready/);
 const doc=JSON.parse(area.value);assert.equal(doc.format,'aaavs-cue-sheet');assert.deepEqual(doc.fade,{fadeTiming:6,fadeRandomSet:22,fadeAnchor:0,durationMs:1500});assert.deepEqual(doc.timing.barsPattern,[4,4,8]);
 // Importing it into a different draft reproduces the clock and the fade; the controls follow.
 const other=render('Setup',{timing:{enabled:false},settings:{beats:1}});
 other.find('Cue sheet').value=area.value;other.click('Import cue sheet');
 assert.deepEqual(other.timing,parseSceneTiming(doc.timing));assert.equal(other.settings.fadeTiming,6);assert.equal(other.settings.fadeRandomSet,22);assert.equal(other.settings.durationMs,1500);assert.equal(other.settings.beats,0);
 assert.equal(other.find('Setup timing').value,'6');assert.equal(other.find('Bars pattern').value,'4, 4, 8');assert.equal(other.find('Song BPM').value,'128');assert.equal(other.find('Beats per bar').value,'3');assert.equal(other.find('Song BPM').disabled,false);assert.equal(other.find('Repeatable scene timing').checked,true);
 assert.match(other.status(),/^Imported\./);assert.equal(other.dirty.at(-1),true,'importing a sheet that turns the clock on asks for a redraw');
 assert.deepEqual(Object.keys(other.settings),[...legacyKeys,'fadeTiming','fadeRandomSet']);assert.doesNotThrow(()=>parseSetups([{id:'s',name:'S',presets:[],settings:other.settings,timing:other.timing}]));
 // Unknown presets are dropped and counted; the host says which it holds.
 const known=render('Setup',{ctx:{knows:h=>h===hash(2)},timing:{enabled:true}});known.find('Cue sheet').value=area.value;known.click('Import cue sheet');
 assert.deepEqual(known.timing.script,[{ordinal:3,preset:hash(2)}]);assert.match(known.status(),/1 cue dropped: preset not in this collection\./);
 // A refused sheet says why and changes nothing.
 const guard=render('Setup',{timing:{enabled:true,bpm:99}});const snapshot=JSON.stringify([guard.timing,guard.settings]);
 for(const [text,pattern] of [['nonsense',/not valid JSON/],['{"format":"x","version":1}',/not an AAAVS cue sheet/],['{"format":"aaavs-cue-sheet","version":5,"timing":{}}',/version 5/],['',/not valid JSON/]]){
  guard.find('Cue sheet').value=text;guard.click('Import cue sheet');assert.match(guard.status(),pattern,text);assert.equal(JSON.stringify([guard.timing,guard.settings]),snapshot);
 }
 // Export refuses an invalid draft with the parser's message.
 const broken=render('Setup',{timing:{enabled:true,bpm:NaN}});broken.click('Export cue sheet');assert.match(broken.status(),/Scene timing requires/);assert.equal(broken.find('Cue sheet').value,'');
 // Folder prefix: labels only.
 const folder=render('Folder',{timing:{enabled:true}});folder.find('Folder cue sheet').value=area.value;folder.click('Import cue sheet');assert.equal(folder.timing.beatsPerBar,3);
}

// The Folder prefix renames the accessible labels without changing the visible text.
{
 const {all,find}=render('Folder');
 assert.deepEqual(all.filter(e=>e.tagName==='select').map(e=>e.attributes['aria-label']),['Folder auto phrase','Folder transition','Folder timing','Folder transition lands','Folder seconds / fallback','Folder manual queue','Folder shuffle minimum rating']);
 assert.deepEqual(all.filter(e=>e.tagName==='label'&&e.children.some(c=>c.tagName==='select')).map(e=>e.textContent),['Auto phrase','Transition','Timing','Transition lands','Seconds / fallback','Manual queue','Shuffle minimum rating']);
 assert.ok(all.some(e=>e.attributes['aria-label']==='Folder repeatable scene timing'));assert.ok(all.some(e=>e.attributes['aria-label']==='Folder song bpm'));
 for(const label of ['Folder beats per bar','Folder bars pattern','Folder hold last pattern entry','Folder tempo changes','Folder cue sheet','Folder random includes instant','Folder random includes 2 bars'])assert.ok(find(label),label);
}

// Everything the controls touch exists in a small DOM, and the interval that keeps the readout live starts only where nodes report isConnected.
{
 const timers=[];globalThis.setInterval=(fn,ms)=>{timers.push({fn,ms});return timers.length;};globalThis.clearInterval=id=>{timers[id-1].cleared=true;};
 try{
  render('Setup',{ctx:{position:()=>1},timing:{enabled:true}});assert.equal(timers.length,0,'no timer without isConnected');
  const connected=[];const originalCreate=document.createElement;
  document.createElement=tag=>{const e=originalCreate(tag);e.isConnected=true;connected.push(e);return e;};
  let pos=5.3;const host=new Element('div'),timing={...defaultSceneTiming,enabled:true};
  renderPlaybackControls(host,{...defaultSettings},timing,()=>{},'Setup',{position:()=>pos});
  document.createElement=originalCreate;
  assert.equal(timers.length,1);assert.equal(timers[0].ms,250);const readout=host.all().find(e=>e.className==='timing-readout');
  assert.equal(readout.textContent,'bar 3.3 · scene 1 · 8 bars');pos=9;timers[0].fn();assert.equal(readout.textContent,'bar 5.3 · scene 1 · 8 bars','the readout follows playback (9 s at 120 BPM is beat 18)');
  readout.isConnected=false;timers[0].fn();assert.equal(timers[0].cleared,true,'a redraw removes the element and ends the timer');
 }finally{delete globalThis.setInterval;delete globalThis.clearInterval;}
}
console.log('Playback controls CPU DOM: verbatim Setup labels (Duration became Timing), in-place edits, redraw only for the clock toggle, canonical fade settings, Random includes, gated anchor and queue, beats per bar, bars pattern, tempo changes, tap tempo, nudge, Downbeat here, Restart here, detected tempo, cue-sheet export/import, live readout, Folder prefix PASS');
