import {compileSceneClock,parseSceneTiming,type SceneTiming} from './mpc-scene-clock.ts';
import {FADE_RANDOM_SET_ALL} from './mpc-contract.ts';
import {canonicalSettings,effectiveFadeTiming,type SetupSettings} from './mpc-setups.ts';
import {TRANSITIONS} from './mpc-transition.ts';
import {FADE_TIMING_LABELS} from './mpc-transition-timing.ts';
import {TapTempo,captureTempo,downbeatHere,nudgeOffset,rebaseTiming,replaceTiming,restartHere,tidyTiming} from './mpc-timing-tools.ts';
import {exportCueSheet,importCueSheet} from './mpc-cue-sheet.ts';
/** What the host can offer the timing tools. Every member is optional; a control that needs an absent one is disabled or says why. */
export interface PlaybackControlsContext {
  /** Media position in seconds. Needed by Downbeat here, Restart sequence here, Use detected tempo and the live readout. */
  position?():number;
  /** True while the song plays. Tap tempo refuses taps while it is false. */
  playing?():boolean;
  /** The live tracker: locked flag, tempo and beat phase. Needed by Use detected tempo. */
  tempo?():{locked:boolean;bpm:number;phase:number};
  /** Monotonic seconds for tap spacing; default `performance.now() / 1000`. Tap tempo measures the spacing of the taps, so any steady clock will do. */
  now?():number;
  /** True when the collection holds a preset with this sha256. A cue-sheet import drops script cues for presets it does not hold (default: all are held). */
  knows?(sha256:string):boolean;
  /** The host acts on the end and peak anchors / on a quantized manual queue. Until it says so the choices are shown but disabled (default false). */
  anchors?:boolean;
  quantizedQueue?:boolean;
}
const RANDOM_LABELS=['Instant','1 beat','2 beats','1 bar','2 bars'] as const;
const ANCHOR_LABELS=['Starts at the scene boundary','Ends on the scene boundary','Peaks on the scene boundary'] as const;
const QUEUE_LABELS=['Immediately','On the next beat','On the next bar','On the next phrase'] as const;
const replaceObject=(target:object,source:object)=>{const t=target as Record<string,unknown>;for(const key of Object.keys(t))delete t[key];Object.assign(t,source);};
const shown=(value:number)=>String(Number(value.toFixed(3)));
const messageOf=(error:unknown)=>error instanceof Error?error.message:String(error);
/** Numbers separated by commas, spaces or semicolons; NaN marks text that is not a whole number so the parser rejects the draft with its own message. */
const parsePattern=(text:string):number[]|null=>{
  const parts=text.trim().split(/[\s,;]+/).filter(Boolean);
  return parts.length?parts.map(p=>/^\d{1,4}$/.test(p)?Number(p):NaN):null;
};
/** One change per line, "seconds BPM"; a line that is not two numbers becomes NaN so the parser rejects it. Sorted by time. */
const parseChanges=(text:string):{at:number;bpm:number}[]|null=>{
  const lines=text.split(/\r?\n/).map(l=>l.trim()).filter(Boolean);
  if(!lines.length)return null;
  const number=(p:string|undefined)=>p!==undefined&&/^[+-]?(\d+\.?\d*|\.\d+)$/.test(p)?Number(p):NaN;
  return lines.map(line=>{const p=line.split(/[\s,;@]+/).filter(Boolean);return p.length===2?{at:number(p[0]),bpm:number(p[1])}:{at:NaN,bpm:NaN};}).sort((a,b)=>a.at-b.at||0);
};
/**
 * Setup Builder playback, timing and transition controls, extracted from `PresetManagement` (contract S7) and extended by Timing System v2.
 * Every control edits `settings` or `timing` in place. `onDirty` runs after each edit; it receives `true` when the edit changes which controls
 * are enabled (the song-clock toggle), so the caller redraws exactly as the original panel did. Every other control refreshes itself.
 * `labelPrefix` names the accessible labels ("Setup shuffle minimum rating"); the `Setup` labels of the historical controls are unchanged.
 * New controls write only non-default fields (contract C-04) and keep the draft valid input for `parseSetups`; text that cannot be parsed is stored
 * as NaN, exactly like a cleared number field, so Save and Activate report the parser's own message.
 */
export function renderPlaybackControls(host:HTMLElement,settings:SetupSettings,timing:SceneTiming,onDirty:(redraw?:boolean)=>void,labelPrefix:'Setup'|'Folder',ctx:PlaybackControlsContext={}):void {
  const element=<K extends keyof HTMLElementTagNameMap>(tag:K,text='',className='')=>{const e=document.createElement(tag);e.textContent=text;e.className=className;return e;};
  const named=(text:string)=>labelPrefix==='Setup'?text:`${labelPrefix} ${text.toLowerCase()}`;
  const syncs:(()=>void)[]=[];
  const refresh=()=>{for(const sync of syncs)sync();};
  const problem=element('p','','timing-problem');problem.setAttribute('role','status');
  const status=element('p','','timing-status');status.setAttribute('role','status');
  const showProblem=()=>{try{parseSceneTiming(timing);problem.textContent='';}catch(error){problem.textContent=messageOf(error);}};
  /** After any edit of the timing draft: canonical form, message, refresh of dependent controls, notify. */
  const edited=()=>{tidyTiming(timing);showProblem();refresh();onDirty();};
  /** After an edit of the fade fields: stored canonically (default-valued fields omitted, `beats` the projection of the timing). */
  const write=(patch:Partial<SetupSettings>)=>{replaceObject(settings,canonicalSettings({...settings,...patch}));refresh();onDirty();};
  const say=(text:string)=>{status.textContent=text;};
  const ensureOption=(el:HTMLSelectElement,value:number,label:string)=>{if(!Array.from(el.children).some(o=>(o as HTMLOptionElement).value===String(value))){const o=element('option',label);o.value=String(value);el.append(o);}};
  /** A select bound to a value: `current` reads it, `apply` stores a choice, `extra` adjusts the control (a custom option, a disabled state) before each refresh. */
  const choose=(label:string,values:readonly (readonly [number,string])[],current:()=>number,apply:(value:number)=>void,extra?:(el:HTMLSelectElement)=>void)=>{
    const wrapper=element('label',label),el=element('select');el.setAttribute('aria-label',`${labelPrefix} ${label.toLowerCase()}`);
    for(const [v,t] of values){const o=element('option',t);o.value=String(v);el.append(o);}
    el.onchange=()=>apply(Number(el.value));
    const sync=()=>{extra?.(el);el.value=String(current());};
    syncs.push(sync);sync();wrapper.append(el);host.append(wrapper);return el;
  };
  const select=(label:string,key:'bars'|'transition'|'durationMs'|'minimumRating',values:readonly (readonly [number,string])[])=>{
    const el=choose(label,values,()=>settings[key],v=>{settings[key]=v;onDirty();},e=>{if(key==='durationMs')ensureOption(e,settings.durationMs,String(settings.durationMs/1000));});
    return el;
  };
  select('Auto phrase','bars',[[0,'Adaptive: 2–12 bars'],[2,'2 bars'],[4,'4 bars'],[8,'8 bars'],[12,'12 bars']]);select('Transition','transition',TRANSITIONS.map((t,i)=>[i,t] as const));
  choose('Timing',FADE_TIMING_LABELS.map((t,i)=>[i,t] as const),()=>effectiveFadeTiming(settings),v=>write({fadeTiming:v}));
  const hint=element('p','','timing-hint');host.append(hint);
  const barLength=()=>timing.beatsPerBar??4;
  syncs.push(()=>{
    const t=effectiveFadeTiming(settings);
    hint.textContent=t===0?'A fixed length: see Seconds / fallback.':t===1?'A hard cut with no blend, like the Cut style, so the outgoing preset is not drawn.'
      :`1 bar = ${barLength()} beats. With no song clock and no locked tempo a fade uses Seconds / fallback.${t===6?' Random draws one of the lengths checked below at each change, in a seeded order that repeats.':''}`;
  });
  const random=element('fieldset'),legend=element('legend','Random includes');random.append(legend);
  RANDOM_LABELS.forEach((text,i)=>{
    const label=element('label',text),box=element('input');box.type='checkbox';box.setAttribute('aria-label',`${labelPrefix} random includes ${text.toLowerCase()}`);
    box.onchange=()=>{
      const mask=settings.fadeRandomSet??FADE_RANDOM_SET_ALL,next=box.checked?mask|(1<<i):mask&~(1<<i);
      if(!next){box.checked=true;say('Random needs at least one length.');return;}
      write({fadeRandomSet:next});
    };
    syncs.push(()=>{box.checked=!!(((settings.fadeRandomSet??FADE_RANDOM_SET_ALL)>>i)&1);box.disabled=effectiveFadeTiming(settings)!==6;});
    label.prepend(box);random.append(label);
  });
  host.append(random);
  choose('Transition lands',ANCHOR_LABELS.map((t,i)=>[i,t] as const),()=>settings.fadeAnchor??0,v=>write({fadeAnchor:v}),el=>{el.disabled=!ctx.anchors;el.title=ctx.anchors?'':'Ending or peaking on the boundary needs a newer player; every fade starts at the boundary until then.';});
  select('Seconds / fallback','durationMs',[[250,'0.25'],[500,'0.5'],[1000,'1'],[2000,'2'],[4000,'4'],[8000,'8']]);
  choose('Manual queue',QUEUE_LABELS.map((t,i)=>[i,t] as const),()=>settings.queueQuantize??0,v=>write({queueQuantize:v}),el=>{el.disabled=!ctx.quantizedQueue;el.title=ctx.quantizedQueue?'':'A quantized manual queue needs a newer player; manual changes are immediate until then.';});
  select('Shuffle minimum rating','minimumRating',[[0,'All ratings, including unrated'],[1,'1+ stars'],[2,'2+ stars'],[3,'3+ stars'],[4,'4+ stars'],[5,'5 stars']]);
  for(const [key,text]of [['enabled','Auto switching'],['shuffle','Shuffle'],['keepOld','Animate outgoing preset'],['manualFade','Transitions on manual changes'],['autoFade','Transitions on Auto changes']] as const){const label=element('label',text),box=element('input');box.type='checkbox';box.checked=settings[key];box.onchange=()=>{settings[key]=box.checked;onDirty();};syncs.push(()=>{box.checked=settings[key];});label.prepend(box);host.append(label);}
  host.append(element('h2','Repeatable scene timing'));
  const label=element('label','Follow the song clock'),toggle=element('input');toggle.type='checkbox';toggle.checked=timing.enabled;toggle.setAttribute('aria-label',named('Repeatable scene timing'));
  toggle.onchange=()=>{timing.enabled=toggle.checked;showProblem();refresh();onDirty(true);};syncs.push(()=>{toggle.checked=timing.enabled;});label.prepend(toggle);host.append(label);
  host.append(element('p','The same song position selects the same scene, including after a seek or repeat. Uses the tempo, bar length and scene lengths set below; live audio still drives the instruments. Auto switching must be on. This clock replaces adaptive phrase timing while enabled.'));
  const number=(text:string,key:'bpm'|'offsetSeconds'|'barsPerScene'|'seed'|'beatsPerBar',min:number,max:number,step:string,disabled?:()=>boolean)=>{
    const wrapper=element('label',text),input=element('input');input.type='number';input.min=String(min);input.max=String(max);input.step=step;input.setAttribute('aria-label',named(text));
    input.oninput=()=>{const value=input.value.trim()?Number(input.value):NaN;if(key==='beatsPerBar'){if(Number.isNaN(value)||value!==4)timing[key]=value;else delete timing[key];}else timing[key]=value;edited();};
    // A field keeps the text being typed while it still means the stored value ("12." reads as 12), so a refresh never fights the typist.
    const sync=()=>{const stored=timing[key]??4,same=input.value.trim()===''?Number.isNaN(stored):Number(input.value)===stored;if(!same)input.value=String(stored);input.disabled=!timing.enabled||!!disabled?.();};
    syncs.push(sync);input.value=String(timing[key]??4);input.disabled=!timing.enabled||!!disabled?.();wrapper.append(input);host.append(wrapper);return input;
  };
  number('Song BPM','bpm',20,400,'0.01');number('First scene offset (seconds)','offsetSeconds',-3600,3600,'0.01');number('Bars per scene','barsPerScene',1,128,'1',()=>timing.barsPattern!==undefined);number('Shuffle seed','seed',0,4294967295,'1');
  number('Beats per bar','beatsPerBar',1,16,'1');
  // Scene lengths: a cyclic pattern of bars per scene, optionally holding its last entry. `barsPerScene` follows the first entry so an older build still loads the setup.
  {
    const wrapper=element('label','Bars pattern'),input=element('input');input.type='text';input.placeholder='4, 4, 8, 16';input.setAttribute('aria-label',named('Bars pattern'));
    const hold=element('input'),holdLabel=element('label','Hold the last entry');hold.type='checkbox';hold.setAttribute('aria-label',named('Hold last pattern entry'));holdLabel.prepend(hold);
    input.oninput=()=>{
      const pattern=parsePattern(input.value);
      if(pattern===null){delete timing.barsPattern;delete timing.patternHold;}
      else{timing.barsPattern=pattern;if(Number.isInteger(pattern[0])&&pattern[0]!>=1&&pattern[0]!<=128)timing.barsPerScene=pattern[0]!;}
      edited();
    };
    hold.onchange=()=>{if(hold.checked)timing.patternHold=true;else delete timing.patternHold;edited();};
    // A field keeps the text being typed while it still means the stored pattern. One entry equal to "Bars per scene" is stored as no pattern at all
    // (the default), so the first digit of "8, 16" must not be erased just because a lone "8" is the default.
    const sameText=()=>{const typed=parsePattern(input.value);return (typed?.join(',')??'')===(timing.barsPattern?.join(',')??'')||(timing.barsPattern===undefined&&typed?.length===1&&typed[0]===timing.barsPerScene);};
    syncs.push(()=>{if(!sameText())input.value=timing.barsPattern?timing.barsPattern.join(', '):'';input.disabled=!timing.enabled;hold.checked=!!timing.patternHold;hold.disabled=!timing.enabled||timing.barsPattern===undefined;});
    input.value=timing.barsPattern?timing.barsPattern.join(', '):'';input.disabled=!timing.enabled;hold.checked=!!timing.patternHold;hold.disabled=!timing.enabled||timing.barsPattern===undefined;
    wrapper.append(input);host.append(wrapper,holdLabel);
  }
  // Tempo changes: absolute times, in order after the offset.
  {
    const wrapper=element('label','Tempo changes (seconds and BPM, one per line)'),area=element('textarea');area.rows=3;area.placeholder='134.2 140';area.setAttribute('aria-label',named('Tempo changes'));
    const text=()=>timing.tempoMap?.map(c=>`${c.at} ${c.bpm}`).join('\n')??'';
    area.oninput=()=>{const changes=parseChanges(area.value);if(changes===null)delete timing.tempoMap;else timing.tempoMap=changes;edited();};
    syncs.push(()=>{if(JSON.stringify(parseChanges(area.value))!==JSON.stringify(timing.tempoMap??null))area.value=text();area.disabled=!timing.enabled;});
    area.value=text();area.disabled=!timing.enabled;wrapper.append(area);host.append(wrapper);
  }
  host.append(problem);
  const readout=element('p','','timing-readout');host.append(readout);
  const readoutText=()=>{
    if(!timing.enabled)return '';
    let clock;try{clock=compileSceneClock({...parseSceneTiming(timing),enabled:true});}catch{return '';}
    const at=ctx.position?.();if(typeof at!=='number'||!Number.isFinite(at))return '';
    const frame=clock.at(at,[0],false);if(!frame)return '';
    const bars=Math.round((frame.endBeat-frame.startBeat)/frame.beatsPerBar*100)/100,where=clock.barBeat(at);
    return frame.countIn>0?`count-in ${frame.countIn.toFixed(1)} s · scene 1 · ${bars} bars`:`bar ${where.bar}.${where.beat} · scene ${frame.ordinal+1} · ${bars} bars`;
  };
  const updateReadout=()=>{readout.textContent=readoutText();};
  syncs.push(updateReadout);
  host.append(element('p','A positive offset holds the opening scene until that time. A negative offset starts partway through the sequence. Shuffle repeats the same seeded order on every replay.'));
  // Timing tools: one-shot edits of the draft. None of them follows the live detector afterwards.
  host.append(element('h3','Timing tools'));
  const tools=element('div','','timing-tools');
  const button=(text:string,onclick:()=>void,label=text,needs?:'position')=>{const b=element('button',text);b.type='button';b.setAttribute('aria-label',label);b.onclick=onclick;syncs.push(()=>{b.disabled=!timing.enabled||(needs==='position'&&!ctx.position);});b.disabled=!timing.enabled||(needs==='position'&&!ctx.position);if(needs==='position'&&!ctx.position)b.title='Needs a loaded song and its position.';tools.append(b);return b;};
  const applyOffset=(offset:number)=>{replaceTiming(timing,rebaseTiming(timing,offset));edited();};
  const position=()=>{const p=ctx.position?.();return typeof p==='number'&&Number.isFinite(p)?p:null;};
  const clockNow=()=>ctx.now?ctx.now():typeof performance!=='undefined'&&typeof performance.now==='function'?performance.now()/1000:null;
  const tapper=new TapTempo();
  button('Tap tempo',()=>{
    if(ctx.playing&&ctx.playing()===false){say('Tap along while the song plays.');return;}
    const at=clockNow();if(at===null){say('Tap tempo needs a clock.');return;}
    const bpm=tapper.tap(at);
    if(bpm===null){say(tapper.count<4?`Keep tapping: ${tapper.count} of 4 taps.`:'Keep tapping steadily.');return;}
    timing.bpm=bpm;edited();say(`${bpm} BPM from ${tapper.count} taps.`);
  },'Tap tempo');
  const beat=()=>timing.bpm>0&&Number.isFinite(timing.bpm)?60/timing.bpm:null;
  for(const [text,label,delta] of [['−1 beat','Move the first scene one beat earlier',()=>{const b=beat();return b===null?null:-b;}],['−50 ms','Move the first scene 50 milliseconds earlier',()=>-.05],['−10 ms','Move the first scene 10 milliseconds earlier',()=>-.01],
    ['+10 ms','Move the first scene 10 milliseconds later',()=>.01],['+50 ms','Move the first scene 50 milliseconds later',()=>.05],['+1 beat','Move the first scene one beat later',()=>beat()]] as const){
    button(text,()=>{const d=delta();if(d===null){say('Set a valid song BPM first.');return;}applyOffset(nudgeOffset(timing.offsetSeconds,d));say(`First scene offset ${shown(timing.offsetSeconds)} s.`);},label);
  }
  button('Downbeat here',()=>{
    const at=position();if(at===null){say('No song position yet. Start playback first.');return;}
    const before=timing.offsetSeconds,next=downbeatHere(timing,at);
    if(next===before){say(`${shown(at)} s is already on a bar line.`);return;}
    applyOffset(next);say(`Offset moved to ${shown(timing.offsetSeconds)} s: a bar line falls at ${shown(at)} s.`);
  },'Downbeat here','position');
  button('Restart sequence here',()=>{
    const at=position();if(at===null){say('No song position yet. Start playback first.');return;}
    applyOffset(restartHere(at));say(`The first scene now starts at ${shown(timing.offsetSeconds)} s.`);
  },'Restart sequence here','position');
  button('Use detected tempo',()=>{
    const at=position(),tempo=ctx.tempo?.(),found=at!==null&&tempo?captureTempo(tempo,at,timing.beatsPerBar??4,Number.isFinite(timing.offsetSeconds)?timing.offsetSeconds:0):null;
    if(!found){say('No tempo lock yet. Play until the overlay shows a BPM, then try again.');return;}
    replaceTiming(timing,rebaseTiming({...timing,bpm:found.bpm},found.offsetSeconds));edited();
    say(`Copied ${found.bpm} BPM and moved the offset to ${shown(found.offsetSeconds)} s, a beat of the detected grid. Bar 1 falls on that beat: use Downbeat here or a one-beat nudge to place it.`);
  },'Use detected tempo','position');
  host.append(tools,status);
  // Cue sheets travel as text through the clipboard: no file dialog, presets by hash only.
  {
    const wrapper=element('label','Cue sheet'),area=element('textarea');area.rows=4;area.placeholder='Export fills this box; paste a cue sheet here and choose Import.';area.setAttribute('aria-label',named('Cue sheet'));wrapper.append(area);
    const row=element('div','','timing-tools');
    const exportButton=element('button','Export cue sheet'),importButton=element('button','Import cue sheet');exportButton.type=importButton.type='button';
    exportButton.onclick=()=>{
      try{
        const text=exportCueSheet({timing,fade:{fadeTiming:effectiveFadeTiming(settings),fadeRandomSet:settings.fadeRandomSet??FADE_RANDOM_SET_ALL,fadeAnchor:settings.fadeAnchor??0,durationMs:settings.durationMs}});
        area.value=text;say('Cue sheet ready: copy the text from the box.');
        try{const clipboard=(globalThis as {navigator?:{clipboard?:{writeText?(text:string):Promise<void>}}}).navigator?.clipboard;void clipboard?.writeText?.(text)?.catch?.(()=>{});}catch{/* the box is the fallback */}
      }catch(error){say(messageOf(error));}
    };
    importButton.onclick=()=>{
      try{
        const result=importCueSheet(area.value,h=>ctx.knows?(ctx.knows(h)?0:undefined):0),wasEnabled=timing.enabled;
        replaceTiming(timing,result.timing);
        if(result.fade)write({fadeTiming:result.fade.fadeTiming,fadeRandomSet:result.fade.fadeRandomSet,fadeAnchor:result.fade.fadeAnchor,durationMs:result.fade.durationMs});
        showProblem();refresh();onDirty(wasEnabled!==timing.enabled);
        say(`Imported${result.name?` "${result.name}"`:''}.${result.dropped?` ${result.dropped} cue${result.dropped===1?'':'s'} dropped: preset not in this collection.`:''}${result.note?` Note: ${result.note}`:''}`);
      }catch(error){say(messageOf(error));}
    };
    row.append(exportButton,importButton);host.append(wrapper,row);
  }
  host.append(element('p','Timed NERV changes use the Transition and Timing controls above, including seeded Random styles and Random timing; Random · all styles and Smart random include the newer effects. With the song clock and Auto on, Next, Previous or Load preset queues a NERV scene from this setup for the next scene boundary. The latest choice wins; the sequence continues from there. Turn Auto off for immediate changes. Loading a preset outside this setup holds the scene clock.'));
  showProblem();refresh();
  // The readout follows playback while the panel is on screen. A redraw removes the element, which ends the timer; fake documents have no isConnected, so no timer starts there.
  if(typeof setInterval==='function'&&typeof (readout as {isConnected?:unknown}).isConnected==='boolean'){
    const timer=setInterval(()=>{if(!readout.isConnected){clearInterval(timer);return;}updateReadout();},250);
  }
}
