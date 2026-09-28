import type {LocalAvsPreset} from './avs/local-collection.ts';
import {parseSetups, type PresetSetup, type SetupSettings} from './mpc-setups.ts';
import {TRANSITIONS} from './mpc-transition.ts';
interface Actions { catalog():readonly LocalAvsPreset[]; current():number; settings():SetupSettings; load(index:number):void; rate(index:number,value:number):void; send(value:unknown):void; activate(setup:PresetSetup|null):void; panel(mode:number):void; close():void }
/** Lazy management view: opening it does not create a renderer or audio context. */
export class PresetManagement {
  private root:HTMLElement|null=null;
  private mode=0;private search='';private minimum=0;private sort='name';private page=0;
  private selected=-1;private sets:PresetSetup[]=[];private loaded=false;private pending:PresetSetup[]|null=null;
  private draft:PresetSetup|null=null;private dirty=false;private feedback='';
  constructor(private a:Actions){}
  get open(){return this.mode!==0;}
  show(mode:number){
    if(!this.root)this.root=document.querySelector('#management');
    if(!this.root)return;
    this.mode=mode;this.root.hidden=!mode;this.a.panel(mode);
    if(mode){this.selected=this.a.current();if(!this.loaded)this.a.send({op:'load-setups'});this.draw();this.root.querySelector<HTMLElement>('button')?.focus();}
  }
  refresh(){if(this.open)this.draw();}
  receive(type:string,payload:unknown,operation?:string){
    try{
      if(type==='setups-loaded'){this.sets=parseSetups(payload);this.loaded=true;}
      if(type==='setups-saved'&&this.pending){this.sets=this.pending;this.pending=null;this.dirty=JSON.stringify(this.draft)!==JSON.stringify(this.sets.find(s=>s.id===this.draft?.id));this.feedback='Setup saved to disk.';}
      if(type==='library-error'){if(operation!=='rate')this.pending=null;this.feedback=String(payload);}
    }catch(error){this.feedback=String(error);}
    this.refresh();
  }
  private element<K extends keyof HTMLElementTagNameMap>(tag:K,text='',className='') {const e=document.createElement(tag);e.textContent=text;e.className=className;return e;}
  private button(text:string,action:()=>void,disabled=false){const b=this.element('button',text);b.type='button';b.disabled=disabled;b.onclick=action;return b;}
  private tell(text:string){this.feedback=text;this.draw();}
  private newDraft(){this.draft={id:crypto.randomUUID(),name:'New setup',presets:[],settings:{...this.a.settings()}};this.dirty=true;this.draw();}
  private abandon(){return !this.dirty||window.confirm('Discard unsaved setup changes?');}
  private draw(){
    if(!this.root||!this.mode)return;
    const root=this.root;root.replaceChildren();
    const header=this.element('header');header.append(this.element('h1',this.mode===1?'Preset Manager':'Setup Builder'));
    header.append(this.button(this.mode===1?'Setup Builder · Ctrl+F7':'Preset Manager · Ctrl+F6',()=>this.show(this.mode===1?2:1)),this.button('Close · Esc',()=>{this.show(0);this.a.close();}));root.append(header);
    const controls=this.element('div','','library-tools');
    const input=this.element('input');input.type='search';input.placeholder='Search presets';input.value=this.search;input.setAttribute('aria-label','Search presets');
    input.oninput=()=>{this.search=input.value;this.page=0;this.draw();const next=root.querySelector<HTMLInputElement>('input[type=search]');next?.focus();};controls.append(input);
    const filter=this.element('select');filter.setAttribute('aria-label','Minimum star rating');
    for(let n=0;n<=5;n++){const o=this.element('option',n?`${n}+ stars`:'All ratings');o.value=String(n);filter.append(o);}filter.value=String(this.minimum);filter.onchange=()=>{this.minimum=Number(filter.value);this.page=0;this.draw();};controls.append(filter);
    const sort=this.element('select');sort.setAttribute('aria-label','Sort presets');for(const [v,label]of [['name','Name'],['rating','Highest rating']]){const o=this.element('option',label);o.value=v!;sort.append(o);}sort.value=this.sort;sort.onchange=()=>{this.sort=sort.value;this.page=0;this.draw();};controls.append(sort);root.append(controls);
    const body=this.element('div','','library-columns');const list=this.element('section','','library-list');list.setAttribute('aria-label','Presets');
    const catalog=this.a.catalog(),matches=catalog.map((p,i)=>({p,i})).filter(({p})=>(p.rating??0)>=this.minimum&&p.name.toLowerCase().includes(this.search.toLowerCase())).sort((a,b)=>this.sort==='rating'?((b.p.rating??0)-(a.p.rating??0)||a.p.name.localeCompare(b.p.name)):a.p.name.localeCompare(b.p.name));
    this.page=Math.min(this.page,Math.max(0,Math.ceil(matches.length/60)-1));
    for(const {p,i}of matches.slice(this.page*60,(this.page+1)*60)){
      const row=this.button(`${p.rating?'★'.repeat(p.rating):'—'}  ${p.name}${i===this.a.current()?' · playing':''}`,()=>{this.selected=i;this.draw();});row.className=i===this.selected?'preset-row selected':'preset-row';row.setAttribute('aria-pressed',String(i===this.selected));list.append(row);
    }
    if(!matches.length)list.append(this.element('p','No presets match.'));
    const paging=this.element('div','','library-tools');paging.append(this.button('Previous',()=>{this.page--;this.draw();},this.page===0),this.element('span',`${matches.length} presets · page ${this.page+1}/${Math.max(1,Math.ceil(matches.length/60))}`),this.button('Next',()=>{this.page++;this.draw();},(this.page+1)*60>=matches.length));list.append(paging);body.append(list);
    const detail=this.element('section','','library-detail');
    const selected=catalog[this.selected];
    if(selected){detail.append(this.element('h2',selected.name),this.element('p',selected.fileName??''));
      const stars=this.element('div','','library-tools');for(let n=1;n<=5;n++){const b=this.button(`${n} ★`,()=>this.a.rate(this.selected,n));b.setAttribute('aria-label',`Rate ${n} stars`);b.setAttribute('aria-pressed',String(selected.rating===n));stars.append(b);}detail.append(stars,this.button('Load preset',()=>this.a.load(this.selected),!selected.autoEligible));
      if(!selected.autoEligible)detail.append(this.element('p',selected.unavailableReason??'This preset cannot be parsed.'));
      if(this.mode===2)detail.append(this.button('Add to setup',()=>{if(!this.draft)this.newDraft();if(this.draft!.presets.length>=500){this.tell('A setup can hold up to 500 presets.');return;}if(!this.draft!.presets.includes(selected.sha256)){this.draft!.presets.push(selected.sha256);this.dirty=true;}this.draw();}));
    }
    if(this.mode===2)this.builder(detail,catalog);body.append(detail);root.append(body);
    const foot=this.element('footer');const feedback=this.element('p',this.feedback);feedback.setAttribute('role','status');foot.append(feedback,this.element('p','Current preset rating: F6 lower · F7 raise. Ratings rename the file and update Date modified.'));
    const help=this.element('details');help.append(this.element('summary','Keyboard shortcuts'),this.element('p','Ctrl+F6 Preset Manager · Ctrl+F7 Setup Builder · F6 / F7 rating · Escape close · Space play/pause · Alt+Enter fullscreen. MPC-HC views use Ctrl+0–9. Options → Player → Keys lists and customizes every player command. Text fields keep their normal typing keys.'));foot.append(help);root.append(foot);
  }
  private builder(detail:HTMLElement,catalog:readonly LocalAvsPreset[]){
    detail.append(this.element('h2','Saved setups'));
    const pick=this.element('select');pick.setAttribute('aria-label','Saved setups');pick.append(this.element('option','Choose a setup…'));
    for(const s of this.sets){const o=this.element('option',s.name);o.value=s.id;pick.append(o);}pick.value=this.draft?.id??'';pick.onchange=()=>{const s=this.sets.find(s=>s.id===pick.value);if(s&&this.abandon()){this.draft=structuredClone(s);this.dirty=false;}this.draw();};detail.append(pick,this.button('New setup',()=>{if(this.abandon())this.newDraft();},!this.loaded));
    if(!this.loaded)detail.append(this.element('p','Loading saved setups…'));
    if(!this.draft)return;const draft=this.draft;
    const name=this.element('input');name.value=draft.name;name.maxLength=120;name.setAttribute('aria-label','Setup name');name.oninput=()=>{draft.name=name.value;this.dirty=true;};detail.append(name);
    const ordered=this.element('ol');draft.presets.forEach((hash,i)=>{const row=this.element('li');row.append(this.element('span',catalog.find(p=>p.sha256===hash)?.name??'Missing preset'),this.button('↑',()=>{[draft.presets[i-1],draft.presets[i]]=[draft.presets[i]!,draft.presets[i-1]!];this.dirty=true;this.draw();},i===0),this.button('↓',()=>{[draft.presets[i+1],draft.presets[i]]=[draft.presets[i]!,draft.presets[i+1]!];this.dirty=true;this.draw();},i===draft.presets.length-1),this.button('Remove',()=>{draft.presets.splice(i,1);this.dirty=true;this.draw();}));ordered.append(row);});detail.append(ordered);
    if(!draft.presets.length)detail.append(this.element('p','Select presets on the left, then Add to setup.'));
    const select=(label:string,key:'bars'|'transition'|'beats'|'durationMs',values:readonly (readonly [number,string])[])=>{const wrapper=this.element('label',label);const el=this.element('select');for(const [v,t]of values){const o=this.element('option',t);o.value=String(v);el.append(o);}el.value=String(draft.settings[key]);el.onchange=()=>{draft.settings[key]=Number(el.value);this.dirty=true;};wrapper.append(el);detail.append(wrapper);};
    select('Auto phrase','bars',[[0,'Adaptive: 2–12 bars'],[2,'2 bars'],[4,'4 bars'],[8,'8 bars'],[12,'12 bars']]);select('Transition','transition',TRANSITIONS.map((t,i)=>[i,t] as const));select('Duration','beats',[[0,'Seconds'],[1,'1 beat'],[2,'2 beats'],[4,'4 beats']]);select('Seconds / fallback','durationMs',[[250,'0.25'],[500,'0.5'],[1000,'1'],[2000,'2'],[4000,'4'],[8000,'8']]);
    for(const [key,text]of [['enabled','Auto switching'],['shuffle','Shuffle'],['keepOld','Animate outgoing preset'],['manualFade','Transitions on manual changes'],['autoFade','Transitions on Auto changes']] as const){const label=this.element('label',text),box=this.element('input');box.type='checkbox';box.checked=draft.settings[key];box.onchange=()=>{draft.settings[key]=box.checked;this.dirty=true;};label.prepend(box);detail.append(label);}
    detail.append(this.button('Save setup',()=>{try{if(!draft.presets.length)throw Error('Add at least one preset.');const next=this.sets.filter(s=>s.id!==draft.id);next.push(structuredClone(draft));this.pending=parseSetups(next);this.a.send({op:'save-setups',setups:this.pending});this.feedback='Saving…';this.draw();}catch(e){this.tell(String(e));}},!!this.pending||!this.loaded),this.button('Activate setup',()=>{try{if(!draft.presets.length)throw Error('Add at least one preset.');this.a.activate(parseSetups([draft])[0]!);this.tell(`Active setup: ${draft.name}`);}catch(e){this.tell(String(e));}}),this.button('Use entire library',()=>{this.a.activate(null);this.tell('Using the entire preset library.');}),this.button('Delete saved setup',()=>{if(window.confirm(`Delete saved setup “${draft.name}”? Preset files are kept.`)){this.pending=this.sets.filter(s=>s.id!==draft.id);this.a.send({op:'save-setups',setups:this.pending});this.feedback='Deleting saved setup…';this.draw();}},!!this.pending||!this.sets.some(s=>s.id===draft.id)));
  }
}
