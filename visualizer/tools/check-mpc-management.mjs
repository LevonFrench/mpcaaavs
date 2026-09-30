import {build} from 'esbuild';
import assert from 'node:assert/strict';
import {syntheticCatalog, syntheticTaxa, loadBrowser, installFakeDom, FakeTimers} from './fixtures-folders.mjs';
async function load(path){const r=await build({entryPoints:[path],bundle:true,format:'esm',write:false});return import(`data:text/javascript;base64,${Buffer.from(r.outputFiles[0].text).toString('base64')}`);}
const {parseSetups,setupIndices,stepSetup,defaultSettings}=await load('src/mpc-setups.ts');
assert.equal(stepSetup([8,2,7],2,1,false),7);assert.equal(stepSetup([8,2,7],8,-1,false),7);
assert.equal(stepSetup([8,2,7],99,1,false),8);assert.equal(stepSetup([8],8,1,false),null);
assert.equal(stepSetup([8,2,7],8,1,true,()=>0),2);
const catalog=[0,1].map(i=>({sha256:String(i).repeat(64),name:`Preset ${i}`,fileName:`${i}.avs`,autoEligible:true,rating:i+1}));
const saved={id:'test',name:'Set',presets:catalog.map(p=>p.sha256).reverse(),settings:defaultSettings};
assert.deepEqual(setupIndices(parseSetups([saved])[0],catalog),[1,0]);
assert.throws(()=>parseSetups([{...saved,presets:['../escape']}]));
assert.throws(()=>parseSetups([{...saved,presets:[catalog[0].sha256,catalog[0].sha256]}]));
assert.throws(()=>parseSetups([{...saved,settings:{...defaultSettings,bars:3}}]));
assert.throws(()=>setupIndices(saved,[catalog[0]]));
const {minimumRating:unusedRating,...legacySettings}=defaultSettings;
assert.equal(parseSetups([{...saved,settings:legacySettings}])[0].settings.minimumRating,0,'legacy setups include unrated presets');
for(let minimumRating=0;minimumRating<=5;minimumRating++)assert.equal(parseSetups([{...saved,settings:{...defaultSettings,minimumRating}}])[0].settings.minimumRating,minimumRating);
for(const minimumRating of [-1,6,1.5,'3',null,NaN])assert.throws(()=>parseSetups([{...saved,settings:{...defaultSettings,minimumRating}}]),/minimum rating/);
class Element {
 constructor(tag){this.tagName=tag;this.children=[];this.attributes={};this.textContent='';this.value='';}
 append(...children){this.children.push(...children);}prepend(...children){this.children.unshift(...children);}
 replaceChildren(...children){this.children=children;}setAttribute(k,v){this.attributes[k]=v;}focus(){this.focused=true;}
 all(){return [this,...this.children.flatMap(c=>c.all())];}
 querySelector(selector){return this.all().find(e=>selector==='button'?e.tagName==='button':e.tagName==='input'&&e.type==='search');}
}
const root=new Element('section'),requests=[],rates=[],marked=[],minimumRatings=[],activated=[],loaded=[],settings={...defaultSettings};
globalThis.document={querySelector:()=>root,createElement:tag=>new Element(tag)};
globalThis.window={confirm:()=>true};
const {PresetManagement}=await load('src/mpc-management.ts');
const manager=new PresetManagement({catalog:()=>catalog,current:()=>0,settings:()=>settings,load:i=>loaded.push(i),rate:(i,n)=>rates.push([i,n]),markNotWorking:(i,value)=>marked.push([i,value]),setMinimumRating:value=>{minimumRatings.push(value);settings.minimumRating=value;},send:r=>requests.push(r),activate:s=>activated.push(s),panel(){},close(){}});
const click=text=>{const b=root.all().find(e=>e.tagName==='button'&&e.textContent===text);assert.ok(b,`button ${text}`);assert.ok(!b.disabled);b.onclick();};
const change=(label,value)=>{const el=root.all().find(e=>e.attributes['aria-label']===label);assert.ok(el,`control ${label}`);el.value=String(value);el.onchange();};
manager.show(2);assert.equal(requests.at(-1).op,'load-setups');
change('Shuffle minimum rating',3);assert.deepEqual(minimumRatings,[3]);manager.refresh();assert.equal(root.all().find(e=>e.attributes['aria-label']==='Shuffle minimum rating').value,'3');
change('List minimum star rating',2);assert.equal(minimumRatings.length,1,'search filter does not change shuffle settings');change('List minimum star rating',0);
manager.receive('setups-loaded',[]);click('New setup');click('Add to setup');
const other=root.all().find(e=>e.tagName==='button'&&e.textContent.includes('Preset 1'));other.onclick();click('Add to setup');
change('Setup shuffle minimum rating',4);click('Save setup');assert.equal(requests.at(-1).op,'save-setups');assert.deepEqual(requests.at(-1).setups[0].presets,catalog.map(p=>p.sha256));assert.equal(requests.at(-1).setups[0].settings.minimumRating,4);
const persisted=JSON.parse(JSON.stringify(requests.at(-1).setups));manager.receive('setups-saved');
click('Activate setup');assert.deepEqual(activated.at(-1).presets,catalog.map(p=>p.sha256));
click('Use entire library');assert.equal(activated.at(-1),null);
click('Load preset');assert.deepEqual(loaded,[1]);click('5 ★');assert.deepEqual(rates,[[1,5]]);
click('Mark not working');assert.deepEqual(marked,[[1,true]]);assert.equal(catalog[1].notWorking,undefined,'flag waits for native persistence acknowledgment');
catalog[1].notWorking=true;manager.refresh();assert.ok(root.all().some(e=>e.textContent.includes('Preset 1 · not working')));
click('Load preset');assert.deepEqual(loaded,[1,1],'marked presets can be manually retested');
change('Preset status','broken');assert.ok(!root.all().some(e=>e.tagName==='button'&&e.className?.includes('preset-row')&&e.textContent.includes('Preset 0')));
click('Clear not-working mark');assert.deepEqual(marked,[[1,true],[1,false]]);catalog[1].notWorking=false;manager.refresh();assert.ok(root.all().some(e=>e.textContent==='No presets match.'));change('Preset status','all');
manager.receive('library-error','Disk is read-only');assert.ok(root.all().some(e=>e.textContent==='Disk is read-only'));
manager.show(0);assert.ok(root.hidden);manager.show(2);manager.receive('setups-loaded',persisted);
assert.ok(root.all().some(e=>e.tagName==='option'&&e.textContent==='New setup'));
assert.equal(parseSetups(persisted)[0].settings.minimumRating,4,'shuffle threshold survives setup serialization');

// =====================================================================================================================
// Preset Browser view (BRW): the pure keyboard, sort and list models, then the view itself on a fake DOM. CPU only.
// =====================================================================================================================
const BV = await loadBrowser(['mpc-browser-view']);
const {treeKeyAction, listKeyAction, sortChoices, effectiveSort, sortText, computeList, rowText, listName, sizeText, summaryText, settingsSummary, browserCss, STYLE_ID, BrowserView,
  siblingPositions, ROW_WIDE, ROW_NARROW, TREE_ROW, SEARCH_DEBOUNCE_MS, BROWSER_HELP, buildFolderTree, buildRecords, parseQuery, folderMembers, parseLocalAvsCatalog: parseCatalog, parseLocalAvsSources: parseSources,
  FolderStore, builtinDefault, FLAG, sortIndices, SORT_FIELDS, defaultSceneTiming} = BV;
const HX = n => n.toString(16).padStart(64, '0');

// ---------------------------------------------------------------------------------------------------- keyboard models (pure)
{
  const R = (depth, expanded) => ({id: 0, key: `k${depth}${expanded}`, depth, label: 'l', count: 1, expanded, playing: false, chain: ['k']});
  const rows = [R(0, true), R(1, false), R(1, null), R(0, false), R(0, null)];
  const tk = (key, at, mods = {}, list = rows) => treeKeyAction(key, mods, list, at);
  assert.deepEqual(tk('ArrowDown', 0), {type: 'focus', to: 1}); assert.deepEqual(tk('ArrowDown', 4), {type: 'focus', to: 4}, 'clamped at the end');
  assert.deepEqual(tk('ArrowUp', 3), {type: 'focus', to: 2}); assert.deepEqual(tk('ArrowUp', 0), {type: 'focus', to: 0}, 'clamped at the top');
  assert.deepEqual(tk('Home', 3), {type: 'focus', to: 0}); assert.deepEqual(tk('End', 0), {type: 'focus', to: 4});
  assert.deepEqual(tk('PageDown', 0), {type: 'focus', to: 4}); assert.deepEqual(tk('PageUp', 4), {type: 'focus', to: 0});
  assert.deepEqual(tk('ArrowRight', 1), {type: 'expand'}, 'Right opens a closed folder'); assert.deepEqual(tk('ArrowRight', 0), {type: 'focus', to: 1}, 'and then enters an open one');
  assert.deepEqual(tk('ArrowRight', 2), {type: 'none'}, 'a leaf has nothing to open');
  assert.deepEqual(tk('ArrowRight', 0, {}, [R(0, true), R(0, false)]), {type: 'none'}, 'an open folder with no visible child: nothing');
  assert.deepEqual(tk('ArrowLeft', 0), {type: 'collapse'}, 'Left closes an open folder'); assert.deepEqual(tk('ArrowLeft', 1), {type: 'focus', to: 0}, 'and then goes to the parent');
  assert.deepEqual(tk('ArrowLeft', 2), {type: 'focus', to: 0}); assert.deepEqual(tk('ArrowLeft', 3), {type: 'none'}, 'a closed root has no parent'); assert.deepEqual(tk('ArrowLeft', 4), {type: 'none'});
  assert.deepEqual(tk('*', 1), {type: 'siblings'}); assert.deepEqual(tk('Enter', 1), {type: 'open'}); assert.deepEqual(tk('Enter', 1, {ctrl: true}), {type: 'play'}); assert.deepEqual(tk('Enter', 1, {meta: true}), {type: 'play'});
  assert.deepEqual(tk('F2', 1), {type: 'rename'}); assert.deepEqual(tk('Delete', 1), {type: 'delete'});
  assert.deepEqual(tk('ArrowDown', 0, {alt: true}), {type: 'none'}, 'Alt combinations belong to the host'); assert.deepEqual(tk('x', 0), {type: 'none'}); assert.deepEqual(tk('a', 0), {type: 'none'});
  assert.deepEqual(tk('ArrowDown', 0, {}, []), {type: 'none'}, 'no rows'); assert.deepEqual(tk('ArrowDown', NaN), {type: 'focus', to: 1}, 'a bad focus counts as the first row');
  assert.deepEqual(tk('ArrowDown', -5), {type: 'focus', to: 1});
  const lk = (key, focus, mods = {}, count = 100) => listKeyAction(key, mods, count, focus, 10);
  assert.deepEqual(lk('ArrowDown', -1), {type: 'focus', to: 0, extend: false}); assert.deepEqual(lk('ArrowDown', 5), {type: 'focus', to: 6, extend: false}); assert.deepEqual(lk('ArrowDown', 99), {type: 'focus', to: 99, extend: false});
  assert.deepEqual(lk('ArrowUp', 5, {shift: true}), {type: 'focus', to: 4, extend: true}); assert.deepEqual(lk('ArrowUp', 0), {type: 'focus', to: 0, extend: false}); assert.deepEqual(lk('ArrowUp', -1), {type: 'focus', to: 0, extend: false});
  assert.deepEqual(lk('PageDown', 5), {type: 'focus', to: 15, extend: false}); assert.deepEqual(lk('PageUp', 5), {type: 'focus', to: 0, extend: false}); assert.deepEqual(listKeyAction('PageDown', {}, 100, 5, 7), {type: 'focus', to: 12, extend: false});
  assert.deepEqual(lk('Home', 50, {shift: true}), {type: 'focus', to: 0, extend: true}); assert.deepEqual(lk('End', 0), {type: 'focus', to: 99, extend: false});
  assert.deepEqual(lk('Enter', 4), {type: 'load'}); assert.deepEqual(lk('Enter', 4, {shift: true}), {type: 'playFrom'}); assert.deepEqual(lk('Enter', 4, {ctrl: true}), {type: 'playAll'}); assert.deepEqual(lk('Enter', -1, {ctrl: true}), {type: 'playAll'});
  assert.deepEqual(lk('Enter', -1), {type: 'none'}); assert.deepEqual(lk(' ', 3), {type: 'toggle'}); assert.deepEqual(lk(' ', -1), {type: 'none'});
  assert.deepEqual(lk('a', 3, {ctrl: true}), {type: 'selectAll'}); assert.deepEqual(lk('A', 3, {meta: true}), {type: 'selectAll'}); assert.deepEqual(lk('a', 3, {ctrl: true}, 0), {type: 'none'}); assert.deepEqual(lk('a', 3), {type: 'none'});
  for (const n of [1, 2, 3, 4, 5]) assert.deepEqual(lk(String(n), 3), {type: 'rate', value: n});
  for (const key of ['0', '6', '9']) assert.deepEqual(lk(key, 3), {type: 'none'}); assert.deepEqual(lk('3', 3, {shift: true}), {type: 'none'}); assert.deepEqual(lk('3', -1), {type: 'none'}, 'nothing focused to rate');
  assert.deepEqual(lk('m', 3), {type: 'broken'}); assert.deepEqual(lk('M', 3), {type: 'broken'}); assert.deepEqual(lk('m', -1), {type: 'none'}); assert.deepEqual(lk('.', -1), {type: 'reveal'});
  assert.deepEqual(lk('Escape', 3), {type: 'clear'}); assert.deepEqual(lk('ArrowDown', 3, {alt: true}), {type: 'none'}); assert.deepEqual(lk('ArrowDown', 3, {ctrl: true}), {type: 'none'}); assert.deepEqual(lk('ArrowDown', 0, {}, 0), {type: 'none'});
  assert.deepEqual(lk('x', 3), {type: 'none'});
}

// Sibling positions of a flat tree: counted among the rows that share a parent, at every depth.
{
  assert.deepEqual(siblingPositions([]), {pos: [], size: []});
  const d = [0, 1, 2, 2, 1, 0, 1].map(depth => ({depth}));
  assert.deepEqual(siblingPositions(d), {pos: [1, 1, 1, 2, 2, 2, 1], size: [2, 2, 2, 2, 2, 2, 1]});
  assert.deepEqual(siblingPositions([0, 0, 0].map(depth => ({depth}))), {pos: [1, 2, 3], size: [3, 3, 3]});
  assert.deepEqual(siblingPositions([0, 1, 1, 0, 1].map(depth => ({depth}))), {pos: [1, 1, 2, 2, 1], size: [2, 2, 2, 2, 1]}, 'a second root starts its own children at 1');
  assert.deepEqual(siblingPositions([1, 2, 2].map(depth => ({depth}))), {pos: [1, 1, 2], size: [1, 2, 2]}, 'a slice starting deeper is still consistent');
  assert.doesNotThrow(() => siblingPositions([{depth: NaN}, {depth: -3}, {depth: 1.9}]));
}

// ---------------------------------------------------------------------------------------------------- sort and list models (pure)
{
  assert.deepEqual(sortChoices({hasText: false, taxa: false, stats: false, manual: false}), ['name', 'rating', 'path', 'package', 'size', 'random']);
  assert.deepEqual(sortChoices({hasText: true, taxa: false, stats: false, manual: false}), ['relevance', 'name', 'rating', 'path', 'package', 'size', 'random']);
  assert.deepEqual(sortChoices({hasText: false, taxa: true, stats: true, manual: true}), ['name', 'rating', 'path', 'package', 'size', 'recent', 'plays', 'random', 'manual', 'style', 'energy', 'busyness', 'author', 'fidelity']);
  assert.deepEqual(new Set(sortChoices({hasText: true, taxa: true, stats: true, manual: true})), new Set(SORT_FIELDS), 'everything is offered when all data exists');
  const all = sortChoices({hasText: true, taxa: false, stats: false, manual: false});
  const fallback = [{key: 'path', dir: 'asc'}, {key: 'name', dir: 'asc'}];
  const es = (extra = {}) => effectiveSort({choice: null, hasText: false, saved: null, fallback, available: all, ...extra});
  assert.deepEqual(es(), fallback, 'the folder default'); assert.deepEqual(es({hasText: true}), [{key: 'relevance', dir: 'desc'}, {key: 'name', dir: 'asc'}], 'relevance while a term exists');
  assert.deepEqual(es({saved: [{key: 'rating', dir: 'desc'}]}), [{key: 'rating', dir: 'desc'}], 'the folder\u2019s saved play order');
  assert.deepEqual(es({saved: [{key: 'rating', dir: 'desc'}], hasText: true})[0].key, 'relevance', 'a search beats the saved order');
  assert.deepEqual(es({choice: [{key: 'size', dir: 'desc'}], hasText: true, saved: [{key: 'rating', dir: 'desc'}]}), [{key: 'size', dir: 'desc'}], 'an explicit choice beats everything');
  assert.deepEqual(es({choice: [{key: 'style', dir: 'asc'}, {key: 'name', dir: 'asc'}]}), [{key: 'name', dir: 'asc'}], 'keys with no data are dropped');
  assert.deepEqual(es({choice: [{key: 'style', dir: 'asc'}]}), [{key: 'name', dir: 'asc'}], 'and the result is never empty');
  assert.deepEqual(es({choice: [], saved: [], fallback: []}), [{key: 'name', dir: 'asc'}]); assert.equal(es({choice: [1, 2, 3, 4].map(() => ({key: 'name', dir: 'asc'}))}).length, 3, 'at most three keys');
  assert.equal(sortText([{key: 'name', dir: 'asc'}]), 'name'); assert.equal(sortText([{key: 'rating', dir: 'desc'}, {key: 'name', dir: 'asc'}]), 'highest rating, then name');
  assert.equal(sortText([{key: 'name', dir: 'desc'}]), 'name, descending'); assert.equal(sortText([{key: 'rating', dir: 'asc'}]), 'highest rating, ascending');
  // Row text: the manager's historical format, plus plain-text states.
  assert.equal(rowText('Preset 1', 2, {notWorking: true, playing: true}), '\u2605\u2605  Preset 1 \u00b7 not working \u00b7 playing'); assert.equal(rowText('Preset 1', 0, {}), '\u2014  Preset 1');
  assert.equal(rowText('P', 5, {unavailable: true, failed: true}), '\u2605\u2605\u2605\u2605\u2605  P \u00b7 unavailable \u00b7 failed'); assert.equal(rowText('P', 1, {playing: true}), '\u2605  P \u00b7 playing');
  assert.equal(listName('NERV / 01 - Boot', 'NERV'), '01 - Boot'); assert.equal(listName('NERV / ', 'NERV'), 'NERV / '); assert.equal(listName('Other / 01', 'NERV'), 'Other / 01'); assert.equal(listName('X', ''), 'X');
  assert.equal(listName('NERV/x', 'NERV'), 'NERV/x');
  assert.equal(listName('Twin Title / Duel Rails 042', 'Twin Title'), 'Duel Rails 042', 'a HUD folder named by a shared title hides the repeated prefix');
  assert.equal(sizeText(25), '25 B'); assert.equal(sizeText(1023), '1023 B'); assert.equal(sizeText(1024), '1 KB'); assert.equal(sizeText(12 * 1024 + 300), '12 KB'); assert.equal(sizeText(1048576), '1.0 MB'); assert.equal(sizeText(364 * 1024 * 1024), '364.0 MB');
  const spec = [{key: 'name', dir: 'asc'}];
  assert.equal(summaryText({count: 312, total: 312, label: 'tuggummi', scopeAll: false, sort: spec}), '312 presets in tuggummi, sorted by name');
  assert.equal(summaryText({count: 1, total: 1, label: 'x', scopeAll: false, sort: spec}), '1 preset in x, sorted by name'); assert.equal(summaryText({count: 0, total: 0, label: 'x', scopeAll: false, sort: spec}), '0 presets in x, sorted by name');
  assert.equal(summaryText({count: 12, total: 4000, label: 'AVS', scopeAll: false, sort: spec}), '12 of 4,000 presets in AVS, sorted by name'); assert.equal(summaryText({count: 1, total: 9, label: 'x', scopeAll: true, sort: spec}), '1 of 9 presets everywhere, sorted by name');
  assert.equal(settingsSummary({...defaultSettings, enabled: true, shuffle: true, bars: 8}), 'Auto on, shuffle on, 8-bar phrases');
  assert.equal(settingsSummary({...defaultSettings, enabled: false}, {...defaultSceneTiming, enabled: true, barsPerScene: 4}), 'Auto off, shuffle off, adaptive phrases, song clock on (4 bars per scene)');
  // The stylesheet: injected by the view because the page policy blocks external CSS; every rule is scoped and both breakpoints exist.
  assert.ok(!/@import|url\(|expression\(|javascript:/i.test(browserCss), 'no external resource'); assert.ok(browserCss.includes('@media(max-width:480px)') && browserCss.includes('@media(max-width:899px)'));
  const selectors = browserCss.replace(/@media[^{]*\{/g, '').split('}').map(r => r.split('{')[0].trim()).filter(Boolean);
  assert.ok(selectors.length > 40 && selectors.every(s => s.split(',').every(part => part.trim().startsWith('#management'))), 'every rule is scoped under #management');
  assert.ok(browserCss.includes(`--ab-row:${ROW_WIDE}px`) && browserCss.includes(`--ab-row:${ROW_NARROW}px`) && browserCss.includes(`--ab-tree-row:${TREE_ROW}px`), 'CSS row heights match the windowing constants');
  assert.ok(browserCss.includes(':focus-visible') && browserCss.includes('#36b4dc'), 'a visible focus ring in the existing accent colour');
  assert.ok(BROWSER_HELP.includes('Ctrl+Enter') && BROWSER_HELP.includes('F2') && !/[\u0000-\u001f]/.test(BROWSER_HELP));
}
{
  const fx = syntheticCatalog(4000, 1);
  const catalog = parseCatalog(fx.catalogJson, fx.validationJson, 'https://aaavs.invalid/mpc.html');
  const tree = buildFolderTree(catalog, {sources: parseSources(fx.sourcesJson)}), rs = buildRecords(catalog, tree);
  const q = text => parseQuery(text);
  const base = {scopeAll: false, query: q(''), minimum: 0, status: 'all', sort: [{key: 'name', dir: 'asc'}], seed: 1};
  const group = [...tree.byKey.keys()].find(k => k === 'avs/src/c:visbot-legacy');
  assert.ok(group, 'a folder with more than 100 presets'); const folder = tree.byKey.get(group), members = [...folderMembers(tree, folder, rs)];
  // Scope: inside the folder by default, everywhere on request.
  const inside = computeList(tree, rs, {...base, folder});
  assert.deepEqual([...inside.ids].sort((a, b) => a - b), members); assert.equal(inside.scope, members.length);
  const everywhere = computeList(tree, rs, {...base, folder, scopeAll: true}); assert.equal(everywhere.ids.length, 4416); assert.equal(everywhere.scope, 4416);
  assert.equal(computeList(tree, rs, {...base, folder: -1}).ids.length, 4416, 'no folder means the whole library');
  // Search inside the scope equals filtering the members by the same query; everywhere it finds more.
  const query = q('acid');
  const found = computeList(tree, rs, {...base, folder, query}), foundAll = computeList(tree, rs, {...base, folder, query, scopeAll: true});
  assert.ok(found.ids.length > 0 && foundAll.ids.length > found.ids.length);
  assert.ok([...found.ids].every(i => rs.nameKey[i].includes('acid') || rs.pathKey[i].includes('acid')) && [...found.ids].every(i => members.includes(i)));
  // Filters: minimum rating and status combine with the search.
  const rated = computeList(tree, rs, {...base, folder, minimum: 3});
  assert.deepEqual([...rated.ids].sort((a, b) => a - b), members.filter(i => rs.rating[i] >= 3)); assert.ok(rated.ids.length > 0 && rated.ids.length < members.length);
  const broken = computeList(tree, rs, {...base, scopeAll: true, folder, status: 'broken'}), working = computeList(tree, rs, {...base, scopeAll: true, folder, status: 'working'});
  assert.ok(broken.ids.length > 0); assert.equal(broken.ids.length + working.ids.length, 4416);
  assert.ok([...broken.ids].every(i => rs.flags[i] & FLAG.notWorking) && [...working.ids].every(i => !(rs.flags[i] & FLAG.notWorking)));
  // Sorting: by rating then name is total; relevance uses the score; random depends on the seed only.
  const byRating = computeList(tree, rs, {...base, folder, sort: [{key: 'rating', dir: 'desc'}, {key: 'name', dir: 'asc'}]}).ids;
  for (let k = 1; k < byRating.length; k++) { const a = byRating[k - 1], b = byRating[k]; assert.ok(rs.rating[a] > rs.rating[b] || rs.rating[a] === rs.rating[b] && rs.nameRank[a] <= rs.nameRank[b]); }
  const rel = computeList(tree, rs, {...base, folder, scopeAll: true, query, sort: [{key: 'relevance', dir: 'desc'}, {key: 'name', dir: 'asc'}]});
  assert.ok(rel.ids.length === foundAll.ids.length); const scores = [...rel.ids].map(i => 0); assert.equal(scores.length, rel.ids.length);
  const r1 = computeList(tree, rs, {...base, folder, sort: [{key: 'random', dir: 'asc'}], seed: 11}).ids.join(), r2 = computeList(tree, rs, {...base, folder, sort: [{key: 'random', dir: 'asc'}], seed: 11}).ids.join();
  const r3 = computeList(tree, rs, {...base, folder, sort: [{key: 'random', dir: 'asc'}], seed: 12}).ids.join(); assert.equal(r1, r2); assert.notEqual(r1, r3);
  assert.equal(computeList(tree, rs, {...base, folder, query: q('rating:>>')}).notes[0], 'ignored: rating:>>'); assert.equal(computeList(tree, rs, {...base, folder: 99999}).ids.length, 0, 'an unknown folder lists nothing');
  assert.equal(computeList(tree, rs, {...base, folder, now: 5}).ids.length, members.length);
}

// ---------------------------------------------------------------------------------------------------- the view on a fake DOM
let dom = installFakeDom();
const fxv = syntheticCatalog(4000, 1);
const vCatalog0 = parseCatalog(fxv.catalogJson, fxv.validationJson, 'https://aaavs.invalid/mpc.html');
const vSources = parseSources(fxv.sourcesJson);
const vTaxa = new Map(syntheticTaxa(fxv.catalogJson));
const vTitles = new Map(Object.entries(fxv.titlesJson.titles));
const live = {enabled: true, bars: 8, shuffle: false, minimumRating: 0, transition: 1, beats: 2, durationMs: 1000, keepOld: true, manualFade: true, autoFade: true};
let idSeed = 0;
function mount(o = {}) {
  const env = {catalog: o.catalog ?? vCatalog0, current: o.current ?? -1, source: o.source ?? {kind: 'library'}, failed: new Set(), settings: {...live, ...(o.settings ?? {})}, tempo: o.tempo ?? null};
  const sent = [], timers = new FakeTimers(), store = new FolderStore(request => sent.push(request), timers);
  store.load();
  if (!o.late) store.receive(...(o.storeMessage ?? ['state-loaded', {name: 'folders', data: o.state ?? null}]));
  const calls = [];
  const options = {
    catalog: () => env.catalog, current: () => env.current, store,
    load: i => calls.push(['load', i]), rate: (i, n) => calls.push(['rate', i, n]), markNotWorking: (i, v) => calls.push(['mark', i, v]),
    settings: () => env.settings, timing: () => null, tempo: () => env.tempo,
    onFocus: (i, reason) => calls.push(['focus', i, reason]), onOpen: key => calls.push(['open', key]),
    source: () => env.source, failed: () => env.failed, timers, now: () => 1000 + (idSeed += 7), newId: () => `id${++idSeed}`, data: o.data ?? {sources: vSources},
    ...(o.noPlay ? {} : {playFolder: plan => { calls.push(['play', plan]); return o.playResult ?? {ok: true, eligible: plan.order.length}; }}),
    ...(o.noStop ? {} : {stopFolder: () => calls.push(['stop'])}),
    ...(o.controls ? {controls: (host, settings, timing, onDirty) => { calls.push(['controls', settings, timing]); const b = document.createElement('button'); b.textContent = 'Fake controls'; b.onclick = () => { settings.shuffle = !settings.shuffle; onDirty(false); }; host.append(b); }} : {}),
    ...(o.saveAsSetup ? {saveAsSetup: (name, hashes, omitted) => { calls.push(['setup', name, hashes.length, omitted]); return `Saved setup ${name}`; }} : {}),
    ...(o.confirm === undefined ? {} : {confirm: text => { calls.push(['confirm', text]); return o.confirm; }}),
    ...(o.styles ? {styles: o.styles} : {}),
  };
  const view = new BrowserView(options);
  const q = pred => view.root.query(pred), all = pred => view.root.queryAll(pred);
  const h = {
    env, sent, timers, store, calls, view, options, q, all,
    label: name => q(e => e.attributes['aria-label'] === name),
    button: text => q(e => e.tagName === 'button' && e.textContent === text),
    buttons: text => all(e => e.tagName === 'button' && e.textContent === text),
    options_: () => all(e => e.attributes.role === 'option'),
    nodes: () => all(e => e.attributes.role === 'treeitem'),
    nodeLabels: () => h.nodes().map(e => e.children[1].textContent),
    node: label => h.nodes().find(e => e.children[1].textContent === label),
    status: () => q(e => e.className === 'ab-status').textContent,
    notice: () => q(e => e.className === 'ab-notice'),
    playing: () => q(e => e.className === 'ab-playing'),
    search: () => q(e => e.tagName === 'input' && e.type === 'search'),
    list: () => q(e => e.attributes.role === 'listbox'), tree: () => q(e => e.attributes.role === 'tree'),
    folderPane: () => q(e => e.className === 'ab-folder'), location: () => q(e => e.className === 'ab-location'), selection: () => q(e => e.className === 'ab-selection'),
    plays: () => calls.filter(c => c[0] === 'play').map(c => c[1]),
    saves: () => sent.filter(r => r.op === 'save-state'),
    type: text => { const s = h.search(); s.value = text; dom.fire(s, 'input'); },
    settle: () => timers.fire(),
    click: e => { assert.ok(e, 'element'); assert.ok(!e.disabled, `enabled: ${e.textContent}`); e.onclick(); },
    change: (label, value) => { const e = h.label(label); assert.ok(e, `control ${label}`); e.value = String(value); dom.fire(e, 'change'); },
    open: label => { h.node(label).onclick(); },
    rowsText: () => h.options_().map(e => e.textContent),
  };
  return h;
}

// ---- skeleton: style, roles, labels
{
  const h = mount();
  assert.equal(dom.head.queryAll(e => e.id === STYLE_ID).length, 1, 'the view injects its own stylesheet once'); assert.equal(dom.head.query(e => e.id === STYLE_ID).textContent, browserCss);
  mount(); assert.equal(dom.head.queryAll(e => e.id === STYLE_ID).length, 1, 'a second view does not add another');
  assert.equal(h.view.root.className, 'aaavs-browser'); assert.equal(h.view.root.attributes['data-narrow'], '0'); assert.equal(h.view.root.attributes['data-pane'], 'tree');
  const s = h.search(); assert.equal(s.attributes['aria-label'], 'Search presets'); assert.equal(s.type, 'search');
  for (const l of ['Search scope', 'Sort presets', 'Then sort by', 'List minimum star rating', 'Preset status', 'Sort direction', 'Include subfolders', 'Folders', 'Presets']) assert.ok(h.label(l), `aria-label ${l}`);
  assert.equal(h.tree().attributes.role, 'tree'); assert.equal(h.list().attributes.role, 'listbox'); assert.equal(h.list().attributes['aria-multiselectable'], 'true');
  assert.equal(h.tree().tabIndex, 0); assert.equal(h.list().tabIndex, 0); assert.equal(h.q(e => e.className === 'ab-status').attributes.role, 'status'); assert.equal(h.notice().attributes.role, 'status');
  assert.deepEqual(h.label('Preset status').children.map(o => o.textContent), ['All statuses', 'Not marked broken', 'Marked not working'], 'the manager\u2019s labels');
  assert.deepEqual(h.label('List minimum star rating').children.map(o => o.textContent), ['Show all ratings', 'Show 1+ stars', 'Show 2+ stars', 'Show 3+ stars', 'Show 4+ stars', 'Show 5+ stars']);
  assert.deepEqual(h.label('Search scope').children.map(o => o.textContent), ['In this folder', 'Everywhere']);
  // Nothing in the DOM shows a private path.
  assert.ok(!h.view.root.all().some(e => /_staging|C:\\|Users/.test(e.textContent + JSON.stringify(e.attributes))));
  assert.equal(h.status(), '4,000 presets in AVS, sorted by path, then name'); assert.equal(h.button('Play folder').disabled, false); assert.equal(h.button('Stop folder').hidden, true);
  assert.equal(h.q(e => e.className === 'ab-empty').hidden, true); assert.equal(h.q(e => e.className === 'ab-empty').textContent, 'No presets match.');
  assert.equal(h.playing().hidden, true, 'nothing playing: no header line');
  assert.ok(h.calls.every(c => c[0] !== 'focus' || c[1] === -1), 'construction does not announce a focused preset');
  h.view.dispose();
}

// ---- tree: rows, roles and keyboard
{
  const h = mount();
  assert.deepEqual(h.nodeLabels(), ['AVS', 'By source', 'By rating', 'NERV', 'HUD packs', 'Smart folders', 'My folders']);
  const avsRow = h.node('AVS'), by = h.node('By source');
  assert.equal(avsRow.attributes['aria-level'], '1'); assert.equal(avsRow.attributes['aria-expanded'], 'true'); assert.equal(avsRow.attributes['aria-selected'], 'true'); assert.equal(by.attributes['aria-level'], '2'); assert.equal(by.attributes['aria-expanded'], 'false');
  assert.equal(h.node('NERV').attributes['aria-expanded'], undefined, 'a leaf has no expanded state'); assert.equal(h.node('NERV').attributes['aria-selected'], 'false');
  assert.equal(avsRow.children[2].textContent, '4,000'); assert.equal(h.node('NERV').children[2].textContent, '16'); assert.equal(by.style.paddingLeft, '22px');
  assert.equal(h.tree().attributes['aria-activedescendant'], avsRow.id, 'the tree names its active row'); assert.equal(avsRow.attributes['aria-posinset'], '1'); assert.equal(avsRow.attributes['aria-setsize'], '5', 'five roots'); assert.equal(by.attributes['aria-posinset'], '1'); assert.equal(by.attributes['aria-setsize'], '2', 'By source and By rating are siblings'); assert.equal(h.node('By rating').attributes['aria-posinset'], '2'); assert.equal(h.node('My folders').attributes['aria-posinset'], '5');
  assert.equal(h.node('AVS').className.includes('active'), true);
  // Keys: Down, Right expands, Right again enters, Left leaves, Enter opens.
  let ev = dom.key(h.tree(), 'ArrowDown'); assert.equal(ev.defaultPrevented && ev.stopped, true);
  assert.equal(h.tree().attributes['aria-activedescendant'], h.node('By source').id); assert.equal(h.node('By source').className.includes('active'), true);
  dom.key(h.tree(), 'ArrowRight'); assert.equal(h.node('By source').attributes['aria-expanded'], 'true'); assert.ok(h.nodeLabels().includes('Visbot archive'));
  dom.key(h.tree(), 'ArrowRight'); assert.equal(h.tree().attributes['aria-activedescendant'], h.node('Visbot archive').id, 'Right on an open folder enters it');
  dom.key(h.tree(), 'ArrowLeft'); assert.equal(h.tree().attributes['aria-activedescendant'], h.node('By source').id, 'Left on a leaf-most row goes to its parent'); dom.key(h.tree(), 'ArrowLeft');
  assert.equal(h.node('By source').attributes['aria-expanded'], 'false'); assert.ok(!h.nodeLabels().includes('Visbot archive'), 'Left closes an open folder');
  dom.key(h.tree(), 'End'); assert.equal(h.tree().attributes['aria-activedescendant'], h.node('My folders').id); dom.key(h.tree(), 'Home'); assert.equal(h.tree().attributes['aria-activedescendant'], h.node('AVS').id);
  const before = h.calls.length;
  dom.key(h.tree(), 'ArrowDown'); dom.key(h.tree(), 'ArrowDown'); dom.key(h.tree(), 'ArrowDown'); dom.key(h.tree(), 'Enter');
  assert.equal(h.view.folderKey, 'nerv', 'Enter opens the active folder'); assert.ok(h.calls.slice(before).some(c => c[0] === 'open' && c[1] === 'nerv'));
  assert.equal(h.status(), '16 presets in NERV, sorted by path, then name'); assert.equal(h.view.root.attributes['data-pane'], 'list'); assert.equal(h.node('NERV').attributes['aria-selected'], 'true'); assert.equal(h.node('AVS').attributes['aria-selected'], 'false');
  // The NERV prefix is hidden inside the NERV folder; the path is a separate child; the row text keeps the historical format.
  const first = h.options_()[0]; assert.match(first.textContent, /^\u2014  \d\d - \w+.*NERV/, first.textContent); assert.ok(!first.textContent.includes('NERV / '));
  assert.equal(first.children[0].className, 'ab-path'); assert.equal(first.children[0].textContent, 'NERV'); assert.equal(first.children.at(-1).className, 'ab-size');
  // Clicking a row opens it; clicking the twisty toggles without opening.
  h.node('HUD packs').onclick(); assert.equal(h.view.folderKey, 'hud'); assert.equal(h.node('HUD packs').attributes['aria-expanded'], 'true', 'a click opens the folder and expands it');
  dom.fire(h.node('HUD packs').children[0], 'click', {}); assert.equal(h.node('HUD packs').attributes['aria-expanded'], 'false', 'the twisty only toggles'); assert.equal(h.view.folderKey, 'hud');
  dom.fire(h.node('HUD packs').children[0], 'click', {}); assert.equal(h.node('HUD packs').attributes['aria-expanded'], 'true');
  assert.deepEqual(h.nodes().filter(e => e.attributes['aria-level'] === '2' && h.nodeLabels().indexOf(e.children[1].textContent) > h.nodeLabels().indexOf('HUD packs')).slice(0, 3).map(e => e.children[1].textContent), ['Showcase', 'Arcade \u00b7 Fighting', 'Arcade \u00b7 Action'], 'the 16 pack labels in order');
  // `*` expands all siblings.
  dom.key(h.tree(), 'Home'); dom.key(h.tree(), 'ArrowDown'); dom.key(h.tree(), '*');
  assert.equal(h.node('By source').attributes['aria-expanded'], 'true', '* opens the siblings of the active row'); assert.equal(h.node('By rating').attributes['aria-expanded'], 'true', 'every sibling that can open, opens');
  // Alt combinations and unknown keys are not consumed.
  ev = dom.key(h.tree(), 'ArrowDown', {altKey: true}); assert.equal(ev.defaultPrevented, false); ev = dom.key(h.tree(), 'q'); assert.equal(ev.stopped, false);
  h.view.dispose();
}

// ---- the windowed list
{
  const h = mount();
  const n = h.view.resultIndices.length; assert.equal(n, 4000);
  assert.equal(h.options_().length, 60, 'nothing measurable: the first 60 rows');
  const list = h.list(); const first = h.options_()[0];
  assert.equal(first.attributes.role, 'option'); assert.equal(first.attributes['aria-posinset'], '1'); assert.equal(first.attributes['aria-setsize'], '4000'); assert.equal(first.tagName, 'button'); assert.equal(first.tabIndex, -1);
  assert.ok(first.className.includes('preset-row'), 'rows keep the manager\u2019s class'); assert.match(first.id, /^ab-opt-\d+$/);
  const spacer = list.children.find(c => c.className === 'ab-spacer'); assert.equal(spacer.style.height, `${4000 * ROW_WIDE}px`);
  // A measured viewport renders about two dozen rows and follows the scroll position.
  list.clientHeight = 360; list.scrollTop = 3600; dom.fire(list, 'scroll');
  const rows = h.options_(); assert.equal(rows.length, 22); assert.equal(rows[0].attributes['aria-posinset'], '95'); assert.equal(spacer.children[0].style.top, `${94 * ROW_WIDE}px`);
  list.scrollTop = 0; dom.fire(list, 'scroll'); assert.equal(h.options_().length, 16); assert.equal(h.options_()[0].attributes['aria-posinset'], '1');
  list.scrollTop = 4000 * ROW_WIDE; dom.fire(list, 'scroll'); assert.equal(h.options_().at(-1).attributes['aria-posinset'], '4000', 'the last row is reachable');
  // Keyboard reveals the focused row: End scrolls to the bottom and names the active row.
  list.scrollTop = 0; dom.fire(list, 'scroll'); dom.key(list, 'End');
  assert.equal(list.scrollTop, 4000 * ROW_WIDE - 360); const active = list.attributes['aria-activedescendant']; assert.ok(h.options_().some(e => e.id === active), 'the active row is in the DOM'); assert.equal(h.options_().at(-1).attributes['aria-posinset'], '4000');
  dom.key(list, 'Home'); assert.equal(list.scrollTop, 0);
  for (let k = 0; k < 12; k++) dom.key(list, 'ArrowDown'); assert.equal(list.scrollTop, 12 * ROW_WIDE + ROW_WIDE - 360 > 0 ? 12 * ROW_WIDE + ROW_WIDE - 360 : 0);
  // Wheel scrolling preserves the active descendant even when its row leaves the visible window.
  const focused = list.attributes['aria-activedescendant']; list.scrollTop = 72000; dom.fire(list, 'scroll');
  assert.equal(list.attributes['aria-activedescendant'], focused); assert.equal(h.options_().filter(e => e.id === focused).length, 1, 'offscreen active row remains mounted once');
  assert.ok(h.options_().length <= 23, 'one pinned row keeps the window bounded'); assert.equal(list.scrollTop, 72000, 'pinning does not undo wheel scrolling');
  h.tree().clientHeight = TREE_ROW; h.tree().scrollTop = 900; const treeActive = h.tree().attributes['aria-activedescendant']; dom.fire(h.tree(), 'scroll');
  assert.equal(h.nodes().filter(e => e.id === treeActive).length, 1, 'the offscreen tree active descendant remains mounted once');
  assert.equal(h.tree().scrollTop, 900); assert.equal(new Set(h.options_().map(e => e.id)).size, h.options_().length, 'no duplicate option ids');
  dom.key(list, 'End'); assert.equal(h.options_().filter(e => e.id === list.attributes['aria-activedescendant']).length, 1, 'keyboard return unpins without duplicate ids');
  // Unmeasured: a focus far down is still in the DOM.
  const u = mount(); dom.key(u.list(), 'End'); assert.equal(u.options_().length, 60); assert.equal(u.options_().at(-1).attributes['aria-posinset'], '4000'); assert.ok(u.options_().some(e => e.id === u.list().attributes['aria-activedescendant']));
  // With no viewport there is no scrolling to do; a small list shows every row.
  const small = mount({catalog: vCatalog0.filter(p => p.kind === 'nerv')}); assert.equal(small.options_().length, 16); assert.equal(small.status().startsWith('16 presets in NERV'), true);
  h.view.dispose(); u.view.dispose(); small.view.dispose();
}

// ---- the animation-frame path coalesces scroll renders
{
  dom = installFakeDom({raf: true}); const d2 = dom;
  const h = mount(); h.list().clientHeight = 360;
  const before = h.options_()[0].attributes['aria-posinset'];
  h.list().scrollTop = 720; dom.fire(h.list(), 'scroll'); dom.fire(h.list(), 'scroll'); dom.fire(h.tree(), 'scroll');
  assert.equal(d2.frames.length, 1, 'three scroll events, one frame'); assert.equal(h.options_()[0].attributes['aria-posinset'], before, 'nothing is rendered before the frame');
  assert.equal(d2.flushFrames(), 1); assert.equal(h.options_()[0].attributes['aria-posinset'], String(20 - 6 + 1));
  h.view.dispose();
  dom = installFakeDom();
}

// ---- search: debounce, identity, relevance, scope, Escape, `/`, Down, notes
{
  const h = mount(); const s = h.search();
  h.type('acid'); assert.deepEqual(h.timers.delays, [SEARCH_DEBOUNCE_MS], 'debounced at 80 ms'); assert.equal(h.view.resultIndices.length, 4000, 'nothing changes until the timer fires');
  h.type('acid b'); assert.equal(h.timers.pending.size, 1, 'each key restarts the one timer');
  h.settle();
  const n = h.view.resultIndices.length; assert.ok(n > 0 && n < 4000); assert.ok(h.status().startsWith(`${n.toLocaleString('en-US')} of 4,000 presets in AVS, sorted by relevance, then name`), h.status());
  assert.equal(h.q(e => e.tagName === 'input' && e.type === 'search'), s, 'the search box is never rebuilt'); assert.equal(h.label('Sort presets').value, 'relevance');
  // Relevance orders name-prefix hits before substring hits.
  // Clauses and notes.
  h.type('rating:>>'); h.settle(); assert.ok(h.status().includes('ignored: rating:>>'), h.status()); assert.equal(h.view.resultIndices.length, 4000, 'a malformed clause never blanks the list');
  h.type('is:broken'); h.settle(); assert.ok(h.view.resultIndices.length > 0 && h.view.resultIndices.length < 200); assert.ok(h.status().includes('presets in AVS') || h.status().includes('preset in AVS'));
  h.type('zzzznothing'); h.settle(); assert.equal(h.view.resultIndices.length, 0); assert.equal(h.q(e => e.className === 'ab-empty').hidden, false); assert.equal(h.options_().length, 0); assert.equal(h.list().attributes['aria-activedescendant'], undefined);
  assert.ok(h.status().startsWith('0 of 4,000 presets in AVS'));
  // Scope: a folder, then everywhere.
  h.type(''); h.settle(); h.open('NERV'); h.type('boot'); h.settle(); assert.equal(h.view.resultIndices.length, 1, 'inside NERV only');
  h.change('Search scope', 'all'); assert.equal(h.view.resultIndices.length, 1); h.type('a'); h.settle(); assert.ok(h.view.resultIndices.length > 1000, 'everywhere is the whole library'); assert.ok(h.status().includes('everywhere'));
  h.change('Search scope', 'folder'); assert.ok(h.status().includes('in NERV'));
  // Escape: clears the text first (and is consumed); then moves to the list (consumed); then is left for the host.
  h.type('boot'); h.settle(); let ev = dom.key(s, 'Escape'); assert.equal(s.value, ''); assert.equal(ev.stopped && ev.defaultPrevented, true, 'Escape in the box is consumed');
  assert.equal(h.view.queryText, ''); assert.equal(h.view.resultIndices.length, 16);
  ev = dom.key(s, 'Escape'); assert.equal(ev.stopped, true); assert.equal(document.activeElement, h.list(), 'then focus returns to the list');
  ev = dom.key(h.list(), 'Escape'); assert.equal(ev.stopped, false, 'nothing left to clear: the host closes the panel');
  // Typing never reaches a playback shortcut.
  ev = dom.key(s, 'x'); assert.equal(ev.stopped, true); ev = dom.key(s, ' '); assert.equal(ev.stopped, true);
  // `/` and Ctrl+F focus the box from anywhere in the browser, but `/` is text when typing in a field.
  document.activeElement = null;
  ev = dom.key(h.view.root, '/', {target: {tagName: 'div'}}); assert.equal(document.activeElement, s); assert.equal(ev.defaultPrevented, true); assert.equal(s.selected, true);
  document.activeElement = null; ev = dom.key(h.view.root, '/', {target: {tagName: 'input'}}); assert.equal(document.activeElement, null); assert.equal(ev.defaultPrevented, false);
  ev = dom.key(h.view.root, '/', {target: {tagName: 'select'}}); assert.equal(document.activeElement, null);
  ev = dom.key(h.view.root, 'f', {ctrlKey: true, target: {tagName: 'input'}}); assert.equal(document.activeElement, s, 'Ctrl+F works even from a field'); assert.equal(ev.defaultPrevented, true);
  document.activeElement = null; dom.key(h.view.root, 'F', {metaKey: true, target: {tagName: 'div'}}); assert.equal(document.activeElement, s);
  document.activeElement = null; ev = dom.key(h.view.root, '/', {altKey: true, target: {tagName: 'div'}}); assert.equal(document.activeElement, null, 'Alt+/ is not ours');
  // Down from the box moves to the first result and the list.
  h.type('a'); const cb = h.calls.length; ev = dom.key(s, 'ArrowDown'); assert.equal(document.activeElement, h.list());
  assert.equal(h.view.focusedIndex(), h.view.resultIndices[0]); assert.ok(h.calls.slice(cb).some(c => c[0] === 'focus' && c[1] === h.view.resultIndices[0] && c[2] === 'focus'), 'the first result is focused and announced (search applied first)');
  assert.equal(h.view.queryText, 'a'); h.view.setQuery('nerv'); assert.equal(h.view.queryText, 'nerv'); assert.equal(s.value, 'nerv'); h.view.dispose();
}

// ---- sort and filter controls
{
  const h = mount({data: {sources: vSources}}); h.open('NERV'); h.open('AVS');
  assert.deepEqual(h.label('Sort presets').children.map(o => o.value), ['name', 'rating', 'path', 'package', 'size', 'random'], 'no relevance without a term, no style keys without data');
  h.change('Sort presets', 'rating'); assert.deepEqual([...h.view.sortSpec], [{key: 'rating', dir: 'desc'}, {key: 'name', dir: 'asc'}], 'the natural direction for the key; the previous second key stays'); assert.equal(h.label('Sort direction').textContent, '\u2193 Descending');
  const ids = h.view.resultIndices; for (let k = 1; k < 200; k++) assert.ok(vCatalog0[ids[k - 1]].rating >= vCatalog0[ids[k]].rating);
  assert.ok(h.status().endsWith('sorted by highest rating, then name')); assert.equal(h.label('Sort direction').attributes['aria-pressed'], 'true');
  h.click(h.label('Sort direction')); assert.deepEqual([...h.view.sortSpec][0], {key: 'rating', dir: 'asc'}); assert.equal(h.label('Sort direction').textContent, '\u2191 Ascending'); assert.ok(h.status().endsWith('sorted by highest rating, ascending, then name'));
  h.change('Then sort by', 'size'); assert.deepEqual([...h.view.sortSpec], [{key: 'rating', dir: 'asc'}, {key: 'size', dir: 'asc'}]);
  assert.ok(![...h.label('Then sort by').children].some(o => o.value === 'rating'), 'the second choice never repeats the first');
  h.change('Then sort by', ''); assert.equal(h.view.sortSpec.length, 1);
  h.change('Sort presets', 'name'); assert.deepEqual([...h.view.sortSpec], [{key: 'name', dir: 'asc'}]);
  // Random: seeded, with a Reshuffle button that changes the order.
  h.change('Sort presets', 'random'); const shown = () => h.view.resultIndices.slice(0, 20).join(); const one = shown();
  const reshuffle = h.q(e => e.tagName === 'button' && e.textContent.startsWith('Reshuffle')); assert.equal(reshuffle.hidden, false); h.click(reshuffle); assert.notEqual(shown(), one, 'a new seed, a new order');
  h.change('Sort presets', 'name'); assert.equal(h.q(e => e.tagName === 'button' && e.textContent.startsWith('Reshuffle')).hidden, true);
  // Filters.
  h.change('List minimum star rating', 3); assert.ok(h.view.resultIndices.length > 0 && h.view.resultIndices.length < 4000); assert.ok([...h.view.resultIndices].every(i => vCatalog0[i].rating >= 3));
  h.change('Preset status', 'broken'); assert.ok([...h.view.resultIndices].every(i => vCatalog0[i].notWorking && vCatalog0[i].rating >= 3)); h.change('List minimum star rating', 0);
  assert.equal(h.view.resultIndices.length, vCatalog0.filter(p => p.notWorking && p.kind === 'avs').length); h.change('Preset status', 'working');
  assert.equal(h.view.resultIndices.length, vCatalog0.filter(p => !p.notWorking && p.kind === 'avs').length); h.change('Preset status', 'all');
  assert.equal(h.view.resultIndices.length, 4000); assert.equal(h.label('Preset status').value, 'all');
  // A saved play order becomes the default list order when the folder opens.
  h.open('NERV'); h.view.dispose();
  const s = mount({state: {version: 1, playback: {nerv: {recursive: true, sort: [{key: 'size', dir: 'desc'}]}}}}); s.open('NERV');
  assert.deepEqual([...s.view.sortSpec], [{key: 'size', dir: 'desc'}], 'the folder\u2019s saved play order defaults the list'); s.view.dispose();
  // With taxonomy data the style keys appear; manual order only inside a manual folder.
  const t = mount({data: {sources: vSources, taxa: vTaxa}}); assert.ok(t.label('Sort presets').children.some(o => o.value === 'style') && t.label('Sort presets').children.some(o => o.value === 'author'));
  assert.ok(!t.label('Sort presets').children.some(o => o.value === 'manual')); assert.ok(t.nodeLabels().includes('By style') || t.node('By source')); t.view.dispose();
  const stats = mount({data: {sources: vSources, stats: {version: 1, plays: new Map([[vCatalog0[3].sha256, [4, Date.now() - 1000]]])}}});
  assert.ok(stats.label('Sort presets').children.some(o => o.value === 'recent') && stats.label('Sort presets').children.some(o => o.value === 'plays')); stats.view.dispose();
}

// ---- selection, keyboard on the list, and the host callbacks
{
  const h = mount(); h.open('NERV'); const ids = h.view.resultIndices; const list = h.list();
  const focusCalls = () => h.calls.filter(c => c[0] === 'focus').map(c => c.slice(1));
  h.calls.length = 0;
  dom.key(list, 'ArrowDown'); assert.equal(h.view.focusedIndex(), ids[0]); assert.deepEqual(focusCalls().at(-1), [ids[0], 'focus']); assert.deepEqual(h.view.selectedIndices(), [ids[0]]);
  dom.key(list, 'ArrowDown'); dom.key(list, 'ArrowDown'); assert.equal(h.view.focusedIndex(), ids[2]); assert.deepEqual(h.view.selectedIndices(), [ids[2]], 'selection follows focus');
  dom.key(list, 'ArrowDown', {shiftKey: true}); dom.key(list, 'ArrowDown', {shiftKey: true}); assert.deepEqual(h.view.selectedIndices(), [ids[2], ids[3], ids[4]].sort((a, b) => ids.indexOf(a) - ids.indexOf(b)), 'Shift+arrows extend from the anchor');
  dom.key(list, 'ArrowUp', {shiftKey: true}); assert.deepEqual(h.view.selectedIndices(), [ids[2], ids[3]]);
  dom.key(list, 'ArrowDown'); assert.deepEqual(h.view.selectedIndices(), [ids[4]], 'a plain arrow collapses the selection');
  dom.key(list, ' '); assert.equal(h.view.selectedCount, 0, 'Space toggles the focused row off'); assert.deepEqual(h.view.selectedIndices(), [ids[4]], 'the focused row is still what an action applies to'); dom.key(list, ' '); assert.equal(h.view.selectedCount, 1); assert.deepEqual(h.view.selectedIndices(), [ids[4]]);
  dom.key(list, 'a', {ctrlKey: true}); assert.equal(h.view.selectedIndices().length, 16, 'Ctrl+A selects every row shown'); assert.equal(h.all(e => e.attributes.role === 'option' && e.attributes['aria-selected'] === 'true').length, 16);
  let ev = dom.key(list, 'Escape'); assert.equal(ev.stopped, true, 'Escape with several selected clears them first'); assert.deepEqual(h.view.selectedIndices(), [ids[4]]);
  ev = dom.key(list, 'Escape'); assert.equal(ev.stopped, false);
  // Digits, M, Enter.
  h.calls.length = 0;
  dom.key(list, '4'); dom.key(list, 'm'); dom.key(list, 'Enter'); dom.key(list, '9'); assert.deepEqual(h.calls, [['rate', ids[4], 4], ['mark', ids[4], true], ['load', ids[4]]]);
  dom.key(list, 'M'); assert.deepEqual(h.calls.at(-1), ['mark', ids[4], true], 'M toggles from the catalog\u2019s current state');
  // Clicks: plain, Shift range, Ctrl toggle, double-click loads.
  h.options_()[1].onclick(); assert.equal(h.view.focusedIndex(), ids[1]); assert.deepEqual(h.view.selectedIndices(), [ids[1]]);
  h.options_()[5].onclick({shiftKey: true}); assert.deepEqual(h.view.selectedIndices(), Array.from(ids.slice(1, 6)));
  h.options_()[8].onclick({ctrlKey: true}); assert.equal(h.view.selectedIndices().length, 6); h.options_()[8].onclick({metaKey: true}); assert.equal(h.view.selectedIndices().length, 5, 'Ctrl or Meta toggles');
  h.calls.length = 0; h.options_()[2].ondblclick(); assert.deepEqual(h.calls, [['load', ids[2]]]);
  h.options_()[2].onclick(); assert.equal(h.view.selectedIndices().length, 1);
  // The playing row is marked in text.
  h.env.current = ids[3]; h.view.refresh(); assert.ok(h.options_()[3].textContent.includes(' \u00b7 playing')); assert.ok(h.options_()[3].className.includes('playing')); assert.ok(!h.options_()[2].textContent.includes('playing'));
  // No listeners are lost on refresh: the same handlers keep working.
  dom.key(list, 'ArrowDown'); assert.ok(h.view.focusedIndex() >= 0); h.view.dispose();
}

// ---- keyboard focus survives redraws (the pressed control is replaced by the redraw it causes)
{
  const h = mount(); h.open('NERV'); const list = h.list(), detail = h.q(e => e.className === 'ab-detail');
  assert.equal(detail.tabIndex, -1, 'the detail column can take programmatic focus');
  // A row never takes focus from the list: mouse down is cancelled and the list keeps the keyboard.
  document.activeElement = null;
  const ev = dom.fire(h.options_()[2], 'mousedown'); assert.equal(ev.defaultPrevented, true); assert.equal(document.activeElement, list, 'the list holds the focus');
  h.options_()[2].onclick(); assert.equal(document.activeElement, list, 'and keeps it after the click redraw');
  dom.key(list, 'ArrowDown'); assert.equal(h.view.focusedIndex(), h.view.resultIndices[3], 'the keyboard still works after a click');
  // A pressed detail button that comes back after the redraw gets the focus back on its replacement.
  const save = h.button('Save current settings'); save.focus(); assert.equal(document.activeElement, save);
  h.click(save); const again = h.button('Save current settings');
  assert.notEqual(again, save, 'the redraw replaced the button'); assert.equal(document.activeElement, again, 'the focus moved to its replacement');
  // A pressed button that is gone after the redraw hands the focus to the detail column instead of dropping it.
  const edit = h.button('Edit options'); edit.focus(); h.click(edit);
  assert.equal(h.button('Edit options'), undefined, 'the draft replaced it'); assert.equal(document.activeElement, detail, 'the focus is not lost');
  // Focus elsewhere is never taken: a redraw while the search box is focused leaves it alone.
  const box = h.search(); box.focus(); h.view.reload(); assert.equal(document.activeElement, box, 'a redraw does not steal the focus');
  h.view.dispose();
}

// ---- Play folder, results, Stop, last folder
{
  const h = mount(); const playable = vCatalog0.filter(p => p.kind === 'avs' && p.autoEligible).length;
  h.click(h.button('Play folder'));
  const plan = h.plays()[0]; assert.equal(plan.key, 'avs'); assert.equal(plan.label, 'AVS'); assert.equal(plan.order.length, playable, 'thousands of presets, no 500 cap'); assert.ok(plan.order.length > 500);
  assert.equal(plan.options, 'live'); assert.equal(plan.settings, null); assert.equal(plan.timing, null, 'an AVS folder keeps the song clock off');
  assert.ok(h.status().includes(`Playing ${playable.toLocaleString('en-US')} presets from AVS.`) && h.status().includes('Live settings kept.'), h.status());
  assert.deepEqual(h.store.state.last, {key: 'avs', recursive: true}); h.settle(); assert.deepEqual(h.saves().at(-1).data.last, {key: 'avs', recursive: true}, 'the last folder is saved for Ctrl+F8');
  // Auto off: the message says how to move on.
  const off = mount({settings: {enabled: false}}); off.click(off.button('Play folder')); assert.ok(off.status().includes('Auto is off: use Next/Previous.')); off.view.dispose();
  // Subfolders off plays only the direct members.
  const probeTree = buildFolderTree(vCatalog0, {sources: vSources}), withBoth = probeTree.nodes.find(n => n.kind === 'package' && n.direct.length > 0 && n.children.length > 0);
  assert.ok(withBoth, 'a folder with both presets and subfolders'); h.view.openFolder(withBoth.key); const keyOfFolder = h.view.folderKey; assert.equal(keyOfFolder, withBoth.key);
  h.calls.length = 0; h.click(h.button('Play folder')); const recursive = h.plays().at(-1); assert.equal(recursive.key, keyOfFolder);
  h.label('Include subfolders').checked = false; dom.fire(h.label('Include subfolders'), 'change'); h.click(h.button('Play folder')); const direct = h.plays().at(-1); assert.ok(direct.order.length < recursive.order.length); assert.deepEqual(h.store.state.last, {key: keyOfFolder, recursive: false});
  assert.equal(h.view.folderKey, keyOfFolder);
  // Results: with a search or filter active the button plays exactly the list, in list order; Play folder still plays the folder.
  h.open('AVS'); h.type('acid'); h.settle(); const results = h.view.resultIndices; assert.ok(results.length > 0);
  const rb = h.q(e => e.tagName === 'button' && e.textContent.startsWith('Play ') && e.textContent.endsWith(results.length === 1 ? ' result' : ' results')); assert.ok(rb && !rb.hidden, 'Play N results appears'); assert.equal(rb.textContent, `Play ${results.length} results`);
  h.click(rb); const byResults = h.plays().at(-1); assert.deepEqual(byResults.order, [...results].filter(i => vCatalog0[i].autoEligible), 'exactly the displayed list, in displayed order'); assert.equal(byResults.label, 'AVS (results)');
  h.click(h.button('Play folder')); assert.equal(h.plays().at(-1).order.length, playable, 'Play folder plays the folder, not the results');
  dom.key(h.list(), 'Enter', {ctrlKey: true}); assert.equal(h.plays().at(-1).label, 'AVS (results)', 'Ctrl+Enter plays what is shown');
  h.type(''); h.settle(); assert.equal(h.q(e => e.tagName === 'button' && e.textContent.startsWith('Play ') && /results?$/.test(e.textContent)).hidden, true);
  dom.key(h.list(), 'Enter', {ctrlKey: true}); assert.equal(h.plays().at(-1).label, 'AVS');
  // Shift+Enter starts from the focused preset.
  dom.key(h.list(), 'ArrowDown'); dom.key(h.list(), 'ArrowDown'); const focused = h.view.focusedIndex(); dom.key(h.list(), 'Enter', {shiftKey: true}); assert.equal(h.plays().at(-1).startAt, focused);
  // The tree: Ctrl+Enter opens and plays; Enter only opens.
  h.calls.length = 0; dom.key(h.tree(), 'Home'); dom.key(h.tree(), 'ArrowDown'); dom.key(h.tree(), 'Enter'); assert.equal(h.plays().length, 0); dom.key(h.tree(), 'Enter', {ctrlKey: true}); assert.equal(h.plays().length, 1);
  // Playing header and Stop folder come from the host's source.
  assert.equal(h.playing().hidden, true); h.env.source = {kind: 'folder', key: 'avs', label: 'AVS', total: 3965}; h.env.settings = {...live, shuffle: true}; h.view.refresh();
  assert.equal(h.playing().textContent, 'Playing: Folder "AVS" \u00b7 3,965 presets \u00b7 shuffle on'); assert.equal(h.playing().hidden, false); assert.equal(h.button('Stop folder').hidden, false);
  assert.ok(h.node('AVS').all().some(e => e.textContent === 'playing'), 'the playing folder is marked in the tree, in text');
  h.calls.length = 0; h.click(h.button('Stop folder')); assert.deepEqual(h.calls, [['stop']]); assert.ok(h.status().includes('Stopped folder play.'));
  h.env.source = {kind: 'setup', label: 'My setup'}; h.view.refresh(); assert.equal(h.playing().textContent, 'Playing: Setup "My setup" \u00b7 shuffle on'); assert.equal(h.button('Stop folder').hidden, true, 'Stop is for folders');
  // Refusals and missing host support.
  const refuse = mount({playResult: {ok: false, reason: 'The host said no.'}}); refuse.click(refuse.button('Play folder')); assert.ok(refuse.status().includes('The host said no.')); assert.equal(refuse.store.state.last, null, 'a refused play is not remembered'); refuse.view.dispose();
  const bare = mount({noPlay: true, noStop: true}); assert.equal(bare.button('Play folder').disabled, true); assert.ok(bare.q(e => e.className === 'ab-reason').textContent.includes('not available in this host'));
  assert.equal(bare.view.playFolder(), null); assert.ok(bare.status().includes('not available in this host')); assert.equal(bare.view.playLast(), false); bare.env.source = {kind: 'folder', key: 'avs', label: 'A', total: 1}; bare.view.refresh(); assert.equal(bare.button('Stop folder').hidden, true); bare.view.dispose();
  const empty = mount({catalog: vCatalog0.filter(p => p.kind === 'avs' && !p.autoEligible)}); empty.click(empty.button('Play folder')); assert.ok(empty.status().includes('No playable presets'), empty.status()); assert.equal(empty.plays().length, 0); empty.view.dispose();
  // Ctrl+F8: replay the last folder; false when there is none, so the manager can open the browser.
  const last = mount(); assert.equal(last.view.playLast(), false, 'no folder played yet'); last.open('NERV'); last.click(last.button('Play folder'));
  last.calls.length = 0; last.open('AVS'); assert.equal(last.view.playLast(), true); assert.equal(last.plays().at(-1).key, 'nerv'); assert.equal(last.view.folderKey, 'nerv', 'the browser shows the folder that plays');
  const gone = mount({state: {version: 1, last: {key: 'avs/src/vanished', recursive: true}}}); assert.equal(gone.view.playLast(), false, 'a folder that no longer exists'); gone.view.dispose();
  const stale = mount({state: {version: 1, last: {key: 'nerv', recursive: false}}}); assert.equal(stale.view.playLast(), true); assert.equal(stale.plays()[0].order.length, 16); stale.view.dispose();
  h.view.dispose(); last.view.dispose();
}

// ---- built-in defaults and folder options
{
  const h = mount({tempo: 133.5, styles: 33}); h.open('HUD packs');
  const pane = () => h.folderPane().all().filter(e => e.tagName === 'p').map(e => e.textContent);
  assert.ok(pane().some(t => t.startsWith('Built-in default for HUD packs:')), pane().join('|'));
  h.node('Neo Geo').onclick(); assert.equal(h.view.folderKey, 'hud/Neo Geo');
  assert.ok(pane().some(t => t.startsWith('Built-in default for Neo Geo: ')));
  h.click(h.button('Play folder')); let plan = h.plays().at(-1);
  assert.equal(plan.options, 'builtin'); assert.deepEqual(plan.settings, builtinDefault('Neo Geo', 33).settings); assert.equal(plan.timing.enabled, true); assert.equal(plan.timing.bpm, 133.5, 'the trusted tempo reaches the clock'); assert.equal(plan.order.length, 150);
  assert.ok(h.status().includes('Built-in defaults applied:'));
  // "Use folder options" off keeps the live settings.
  const use = h.label('Use folder options'); assert.equal(use.checked, true); use.checked = false; dom.fire(use, 'change'); h.click(h.button('Play folder')); plan = h.plays().at(-1); assert.equal(plan.options, 'live'); assert.equal(plan.settings, null);
  use.checked = true; dom.fire(use, 'change');
  // Save the live settings as this folder's options; the next play uses them and the choice is stored.
  h.click(h.button('Save current settings')); assert.ok(h.store.state.playback['hud/Neo Geo']); assert.deepEqual(h.store.state.playback['hud/Neo Geo'].settings, live); h.settle();
  assert.ok(h.saves().at(-1).data.playback['hud/Neo Geo']); assert.ok(h.status().includes('Saved the current settings'));
  assert.ok(pane().some(t => t.startsWith('Saved options: Auto on, shuffle off, 8-bar phrases')), pane().join('|'));
  h.click(h.button('Play folder')); plan = h.plays().at(-1); assert.equal(plan.options, 'saved'); assert.deepEqual(plan.settings, live); assert.equal(plan.timing.enabled, false);
  h.click(h.button('Clear saved options')); assert.equal(h.store.state.playback['hud/Neo Geo'], undefined); assert.ok(pane().some(t => t.startsWith('Built-in default for Neo Geo')));
  assert.equal(h.button('Clear saved options').disabled, true);
  h.view.dispose();
  // Editing with the playback controls: a draft, saved on request, cancelled on request.
  const structural = mount({controls: true, tempo: 133.5, styles: 33, state: {version: 1, playback: {'hud/Rhythm': {recursive: true, sort: [{key: 'size', dir: 'desc'}]}}}});
  structural.open('HUD packs'); structural.node('Rhythm').onclick(); structural.click(structural.button('Play folder'));
  const structuralPlan = structural.plays().at(-1); assert.equal(structuralPlan.options, 'builtin');
  structural.click(structural.button('Edit options')); const structuralDraft = structural.calls.find(c => c[0] === 'controls');
  assert.deepEqual(structuralDraft[1], structuralPlan.settings, 'sort-only saved options edit the effective built-in settings');
  assert.equal(structuralDraft[2].enabled, true); assert.equal(structuralDraft[2].bpm, structuralPlan.timing.bpm); assert.equal(structuralDraft[2].barsPerScene, structuralPlan.timing.barsPerScene);
  assert.equal(structural.label('Draft include subfolders').checked, true); assert.equal(structural.label('Folder play order').value, 'size', 'structural saved choices remain intact'); structural.view.dispose();
  const e = mount({controls: true}); e.open('HUD packs'); e.node('Rhythm').onclick();
  e.click(e.button('Edit options')); const c = e.calls.find(x => x[0] === 'controls'); assert.ok(c, 'the controls render into the pane'); assert.equal(c[1].queueQuantize, 1, 'the draft starts from the built-in default'); assert.equal(c[2].enabled, true);
  assert.ok(e.button('Fake controls')); e.click(e.button('Fake controls')); assert.equal(c[1].shuffle, false, 'the draft is edited in place');
  assert.ok(e.label('Folder play order') && e.label('Draft include subfolders')); e.change('Folder play order', 'name'); e.label('Draft include subfolders').checked = false; dom.fire(e.label('Draft include subfolders'), 'change');
  e.click(e.button('Cancel')); assert.equal(e.store.state.playback['hud/Rhythm'], undefined, 'cancel saves nothing'); assert.equal(e.button('Fake controls'), undefined);
  e.click(e.button('Edit options')); e.change('Folder play order', 'size'); e.label('Draft include subfolders').checked = false; dom.fire(e.label('Draft include subfolders'), 'change'); e.click(e.button('Save options'));
  const savedRhythm = e.store.state.playback['hud/Rhythm']; assert.deepEqual(savedRhythm.sort, [{key: 'size', dir: 'desc'}, {key: 'name', dir: 'asc'}].map(x => x.key === 'size' ? {key: 'size', dir: 'asc'} : x)); assert.equal(savedRhythm.recursive, false);
  assert.equal(savedRhythm.settings.queueQuantize, 1); assert.equal(savedRhythm.timing.enabled, true); e.settle(); assert.ok(e.saves().at(-1).data.playback['hud/Rhythm']);
  assert.equal(e.view.folderKey, 'hud/Rhythm'); assert.equal(e.label('Include subfolders').checked, false, 'the saved recursion choice shows in the toolbar'); e.view.dispose();
  const nc = mount(); nc.open('HUD packs'); nc.node('Rhythm').onclick(); nc.click(nc.button('Edit options'));
  assert.ok(nc.folderPane().all().some(x => x.textContent === 'Playback controls are not available here.'), 'without the controls the pane says so'); nc.view.dispose();
  // An unreadable playback entry from a newer build is never applied and the pane says so.
  const opaque = mount({state: {version: 1, playback: {nerv: {settings: {transition: 99}}}}}); opaque.open('NERV');
  assert.ok(opaque.folderPane().all().some(x => x.textContent === 'Options from a newer version are kept unchanged and are not applied.'));
  opaque.click(opaque.button('Play folder')); assert.equal(opaque.plays().at(-1).options, 'builtin'); assert.equal(opaque.button('Clear saved options').disabled, false);
  opaque.view.dispose();
  // Save folder as setup bridges to the setup list (500 at most).
  const sv = mount({saveAsSetup: true}); sv.click(sv.button('Save folder as setup')); const setupCall = sv.calls.find(x => x[0] === 'setup');
  assert.deepEqual(setupCall, ['setup', 'AVS', 500, vCatalog0.filter(p => p.kind === 'avs' && p.autoEligible).length - 500]); assert.ok(sv.status().includes('Saved setup AVS'));
  assert.equal(mount().button('Save folder as setup'), undefined, 'no bridge, no button'); sv.view.dispose();
}

// ---- user folders: create, add, remove, order, rename, delete, search folders
{
  const h = mount({confirm: true}); h.open('My folders');
  assert.deepEqual(h.folderPane().all().filter(e => e.tagName === 'button').map(e => e.textContent).slice(-2), ['New folder', 'New search folder']); assert.equal(h.button('New search folder').disabled, true, 'a search folder needs a search');
  h.click(h.button('New folder')); const folder = h.store.state.folders[0]; assert.equal(folder.name, 'New folder'); assert.equal(folder.kind, 'manual');
  assert.equal(h.view.folderKey, `user:${folder.id}`, 'the new folder opens'); assert.ok(h.nodeLabels().includes('New folder')); assert.equal(h.node('New folder').attributes['aria-selected'], 'true');
  const nameInput = h.label('Folder name'); assert.equal(nameInput.value, 'New folder'); nameInput.value = 'Late night'; h.click(h.button('Rename folder')); assert.equal(h.store.state.folders[0].name, 'Late night'); assert.ok(h.nodeLabels().includes('Late night'));
  h.label('Folder name').value = '   '; h.click(h.button('Rename folder')); assert.equal(h.store.state.folders[0].name, 'Late night', 'a blank name changes nothing');
  h.settle(); assert.ok(h.saves().at(-1).data.folders.some(f => f.name === 'Late night'), 'edits are saved');
  // A save acknowledgement changes nothing the pane shows, so it never replaces a field the owner is typing in; a real change does redraw.
  const typing = h.label('Folder name'); typing.value = 'half typed'; typing.focus();
  h.store.receive('state-saved', {name: 'folders'});
  assert.equal(h.label('Folder name'), typing, 'the same field'); assert.equal(typing.value, 'half typed'); assert.equal(document.activeElement, typing);
  h.store.mutate(s => { s.folders[0].name = 'Renamed elsewhere'; });
  assert.notEqual(h.label('Folder name'), typing, 'a change to the folder redraws the pane'); assert.equal(h.label('Folder name').value, 'Renamed elsewhere');
  h.store.mutate(s => { s.folders[0].name = 'Late night'; }); assert.equal(h.label('Folder name').value, 'Late night');
  // Add presets from a list to the folder.
  h.open('NERV'); const nerv = h.view.resultIndices; dom.key(h.list(), 'ArrowDown'); dom.key(h.list(), 'ArrowDown', {shiftKey: true}); dom.key(h.list(), 'ArrowDown', {shiftKey: true});
  assert.equal(h.view.selectedIndices().length, 3); assert.ok(h.selection().children.some(e => e.textContent === '3 presets selected'));
  const pick = h.label('Add to folder'); assert.deepEqual(pick.children.map(o => o.textContent), ['Add to folder\u2026', 'Late night', 'New folder\u2026']);
  h.change('Add to folder', folder.id); assert.deepEqual(h.store.state.folders[0].presets, [nerv[0], nerv[1], nerv[2]].map(i => vCatalog0[i].sha256)); assert.ok(h.status().includes('Added 3 to Late night.'), h.status()); assert.equal(h.label('Add to folder').value, '');
  h.change('Add to folder', folder.id); assert.ok(h.status().includes('Added 0 to Late night; 3 skipped'), h.status());
  // Open it: members in the owner's order, Remove and Move controls.
  h.open('My folders'); h.node('Late night').onclick(); assert.equal(h.view.resultIndices.length, 3); assert.equal(h.node('Late night').children[2].textContent, '3');
  assert.deepEqual([...h.view.sortSpec], [{key: 'manual', dir: 'asc'}]); assert.deepEqual([...h.view.resultIndices], [nerv[0], nerv[1], nerv[2]]);
  dom.key(h.list(), 'ArrowDown'); assert.ok(h.button('Move up') && h.button('Move down')); h.click(h.button('Move down')); assert.deepEqual([...h.view.resultIndices].slice(0, 2), [nerv[1], nerv[0]], 'Move down reorders the manual folder');
  h.click(h.button('Move up')); assert.deepEqual([...h.view.resultIndices].slice(0, 2), [nerv[0], nerv[1]]);
  assert.ok(h.label('Sort presets').children.some(o => o.value === 'manual')); h.change('Sort presets', 'name'); assert.equal(h.button('Move up'), undefined, 'moving needs the manual order');
  dom.key(h.list(), 'ArrowDown'); h.click(h.button('Remove from folder')); assert.equal(h.store.state.folders[0].presets.length, 2); assert.ok(h.status().includes('Removed 1 from the folder.'));
  // Play folder plays it in its own order once the manual sort is back.
  h.change('Sort presets', 'manual'); h.click(h.button('Play folder')); assert.deepEqual(h.plays().at(-1).order, [...h.view.resultIndices]);
  // "New folder…" in the Add menu creates and opens a folder and adds to it.
  h.open('NERV'); dom.key(h.list(), 'ArrowDown'); h.change('Add to folder', '\u0000new'); assert.equal(h.store.state.folders.length, 2); assert.equal(h.store.state.folders[1].presets.length, 1); assert.equal(h.view.folderKey, `user:${h.store.state.folders[1].id}`);
  assert.ok(h.status().includes('Added 1 to New folder.'));
  // A subfolder, and the depth limit.
  h.click(h.button('New subfolder')); const child = h.store.state.folders[2]; assert.equal(child.parent, h.store.state.folders[1].id); assert.equal(h.view.folderKey, `user:${child.id}`);
  h.click(h.button('New subfolder')); h.click(h.button('New subfolder')); assert.equal(h.store.state.folders.length, 5); assert.equal(h.button('New subfolder').disabled, true, 'four levels is the limit');
  assert.ok(h.folderPane().all().some(e => e.textContent === 'Folders can be nested 4 levels deep.'));
  // Delete asks first, removes the subtree, and moves the selection to the parent.
  h.calls.length = 0; h.click(h.button('Delete folder')); assert.ok(h.calls.some(c => c[0] === 'confirm' && /Delete folder/.test(c[1]))); assert.equal(h.store.state.folders.length, 4);
  const doomed = h.store.state.folders[1]; h.view.openFolder(`user:${doomed.id}`); h.click(h.button('Delete folder')); assert.equal(h.store.state.folders.length, 1, 'the subtree goes with it'); assert.equal(h.view.folderKey, 'user');
  const declined = mount({confirm: false, state: {version: 1, folders: [{id: 'k', name: 'Keep', parent: null, kind: 'manual', presets: [], created: 1}]}}); declined.open('My folders'); declined.node('Keep').onclick(); declined.click(declined.button('Delete folder'));
  assert.equal(declined.store.state.folders.length, 1, 'declining keeps the folder'); declined.view.dispose();
  // Keyboard: F2 focuses the name box; Delete on a user row asks and deletes.
  h.node('Late night').onclick(); document.activeElement = null; dom.key(h.tree(), 'F2'); assert.equal(document.activeElement, h.label('Folder name'), 'F2 renames');
  h.calls.length = 0; dom.key(h.tree(), 'Delete'); assert.ok(h.calls.some(c => c[0] === 'confirm')); assert.equal(h.store.state.folders.length, 0);
  dom.key(h.tree(), 'Home'); dom.key(h.tree(), 'F2'); dom.key(h.tree(), 'Delete'); assert.equal(h.store.state.folders.length, 0, 'F2 and Delete only act on user folders');
  h.view.dispose();
  // Search folders: saved from the current search and scope; editable; live.
  const s = mount({state: {version: 1, folders: []}}); s.open('AVS'); s.type('acid'); s.settle(); s.open('My folders'); assert.equal(s.button('New search folder').disabled, false, 'still true after opening My folders with a query');
  s.type('acid'); s.settle(); s.click(s.button('New search folder')); const sf = s.store.state.folders[0]; assert.equal(sf.kind, 'smart'); assert.equal(sf.query, 'acid'); assert.equal(sf.scope, 'user');
  s.view.openFolder(`user:${sf.id}`); assert.ok(s.folderPane().all().some(e => e.textContent.startsWith('The saved search runs in')), 'the scope is stated');
  assert.equal(s.label('Saved search').value, 'acid'); s.label('Saved search').value = 'rating:>=4'; s.click(s.button('Save search')); assert.equal(s.store.state.folders[0].query, 'rating:>=4');
  assert.equal(s.view.resultIndices.length, 0, 'the scope is the (empty) My folders section'); s.view.dispose();
  const s2 = mount({state: {version: 1, folders: [{id: 'q', name: 'Fours', parent: null, kind: 'smart', query: 'rating:>=4', scope: null, created: 1}]}}); s2.open('My folders'); s2.node('Fours').onclick();
  assert.equal(s2.view.resultIndices.length, vCatalog0.filter(p => (p.rating ?? 0) >= 4).length); assert.ok(s2.folderPane().all().some(e => e.textContent === 'Updates as ratings, marks and searches change.'));
  assert.equal(s2.button('Remove from folder'), undefined, 'a search folder has no manual members'); s2.view.dispose();
  // Stale plan: editing the playing folder says so.
  const st = mount({state: {version: 1, folders: [{id: 'p', name: 'Playing', parent: null, kind: 'manual', presets: [vCatalog0[0].sha256], created: 1}]}});
  st.open('My folders'); st.node('Playing').onclick(); st.click(st.button('Play folder')); st.env.source = {kind: 'folder', key: 'user:p', label: 'Playing', total: 1}; st.view.refresh();
  assert.ok(!st.playing().textContent.includes('Folder changed'), 'unchanged since the plan'); st.open('AVS'); dom.key(st.list(), 'ArrowDown'); st.change('Add to folder', 'p');
  assert.ok(st.playing().textContent.endsWith('Folder changed. Play again to apply.'), st.playing().textContent); st.view.openFolder('user:p'); st.click(st.button('Play folder')); assert.ok(!st.playing().textContent.includes('Folder changed'), 'playing again clears it'); st.view.dispose();
  // Folder from setup.
  const fs = mount({state: {version: 1}}); const made = fs.view.createFolderFromSetup('From setup', vCatalog0.slice(0, 600).map(p => p.sha256)); assert.deepEqual([made.added, made.skipped], [600, 0], 'a setup of any size becomes an unbounded folder');
  assert.equal(fs.store.state.folders[0].presets.length, 600); assert.ok(fs.status().includes('Created folder "From setup" with 600 presets')); fs.view.dispose();
}

// ---- the store: loading, unavailable, read-only, persistence of the panel state
{
  const late = mount({late: true}); assert.equal(late.store.status, 'loading');
  late.open('NERV'); dom.key(late.list(), 'ArrowDown');
  late.view.openFolder('user'); late.click(late.button('New folder')); assert.ok(late.status().includes('Saved folders are still loading.'), late.status()); assert.equal(late.store.state.folders.length, 0);
  late.view.dispose();
  // The panel state comes back once the file loads (only if the reader has not started using the panel).
  const fresh = mount({late: true});
  const saved = {version: 1, ui: {expanded: ['avs', 'avs/src', 'nerv'], selected: 'nerv', sort: [{key: 'rating', dir: 'desc'}], scopeAll: true}};
  fresh.store.receive('state-loaded', {name: 'folders', data: saved});
  assert.equal(fresh.view.folderKey, 'nerv'); assert.equal(fresh.label('Search scope').value, 'all'); assert.deepEqual([...fresh.view.sortSpec][0], {key: 'rating', dir: 'desc'}); assert.equal(fresh.node('By source').attributes['aria-expanded'], 'true', 'the saved expansion is restored');
  assert.equal(fresh.node('NERV').attributes['aria-selected'], 'true'); assert.equal(fresh.view.resultIndices.length, 4416, 'scope Everywhere restored'); fresh.view.dispose();
  const busy = mount({late: true}); busy.open('HUD packs'); busy.store.receive('state-loaded', {name: 'folders', data: saved}); assert.equal(busy.view.folderKey, 'hud', 'a reader who already chose a folder keeps it'); busy.view.dispose();
  // Persistence: opening folders, expanding, sorting and the scope reach the store's UI state and are saved after the quiet period.
  const p = mount(); p.open('NERV'); p.change('Sort presets', 'size'); p.change('Search scope', 'all'); p.node('HUD packs').children[0].onclick();
  assert.equal(p.store.state.ui.selected, 'nerv'); assert.deepEqual(p.store.state.ui.sort, [{key: 'size', dir: 'asc'}, {key: 'name', dir: 'asc'}]); assert.equal(p.store.state.ui.scopeAll, true); assert.ok(p.store.state.ui.expanded.includes('hud'));
  assert.deepEqual(p.timers.delays, [3000], 'UI-only changes wait three quiet seconds'); p.settle(); assert.equal(p.saves().length, 1); assert.equal(p.saves()[0].data.ui.selected, 'nerv'); p.view.dispose();
  // An older host: session only, with a notice; the view keeps working.
  const old = mount({late: true}); old.store.receive('library-error', 'Unknown library request', 'load-state'); assert.equal(old.notice().hidden, false); assert.equal(old.notice().textContent, 'Folder persistence unavailable (session only).');
  old.open('My folders'); old.click(old.button('New folder')); assert.equal(old.store.state.folders.length, 1, 'folders still work for the session'); assert.deepEqual(old.sent, [{op: 'load-state', name: 'folders'}]); old.view.dispose();
  // A newer or unreadable file is read-only: the notice offers Reset (confirmed), and nothing is written meanwhile.
  const ro = mount({state: {version: 2}, confirm: false}); assert.equal(ro.store.status, 'readonly'); assert.match(ro.notice().textContent, /newer version; editing is disabled to protect them/);
  ro.open('My folders'); ro.click(ro.button('New folder')); assert.equal(ro.store.state.folders.length, 0); assert.equal(ro.saves().length, 0);
  ro.click(ro.button('Reset folders')); assert.equal(ro.store.status, 'readonly', 'declined'); assert.ok(ro.calls.some(c => c[0] === 'confirm' && /empty set/.test(c[1])));
  const ro2 = mount({state: {version: 2}, confirm: true}); ro2.click(ro2.button('Reset folders')); assert.equal(ro2.store.status, 'ready'); assert.equal(ro2.notice().hidden, true); assert.equal(ro2.saves().length, 1);
  ro.view.dispose(); ro2.view.dispose();
  // A failed save shows the error with Retry.
  const bad = mount(); bad.open('My folders'); bad.click(bad.button('New folder')); bad.settle(); bad.store.receive('library-error', 'Disk is read-only', 'save-state');
  assert.match(bad.notice().textContent, /Folders could not be saved \(Disk is read-only\)\. Changes stay in this session\./); const retryCount = bad.saves().length; bad.click(bad.button('Retry save')); assert.equal(bad.saves().length, retryCount + 1); bad.view.dispose();
}

// ---- location, preset detail hooks, refresh and data changes
{
  const h = mount({data: {sources: vSources, titles: vTitles}});
  const multi = vCatalog0.findIndex(p => p.kind === 'avs' && (p.origins?.length ?? 0) > 1); assert.ok(multi >= 0); const single = vCatalog0.findIndex(p => p.kind === 'avs' && p.origins?.length === 1 && !p.folder);
  const where = h.view.describeLocation(multi); assert.ok(where.path.length >= 3 && where.path[0] === 'AVS'); assert.ok(where.others.length >= 1 && where.others[0].key.startsWith('avs/src/')); assert.deepEqual(h.view.describeLocation(single).others, []);
  assert.deepEqual(h.view.describeLocation(99999), {path: [], others: []});
  h.view.setQuery(vCatalog0[multi].name.toLowerCase()); h.view.setQuery(vCatalog0[multi].name); const at = h.view.resultIndices.indexOf(multi); assert.ok(at >= 0);
  h.options_().find(e => e.id === `ab-opt-${multi}`).onclick();
  assert.equal(h.view.focusedIndex(), multi); assert.ok(h.location().children[0].textContent.startsWith('Location: AVS > By source > '), h.location().children[0].textContent);
  assert.ok(h.location().children.some(e => /^Also in \d+ other folders?$/.test(e.textContent))); const link = h.location().all().find(e => e.tagName === 'button'); assert.ok(link, 'other folders are links');
  const target = where.others[0].key; h.click(h.location().all().filter(e => e.tagName === 'button')[0]); assert.equal(h.view.folderKey, target, 'a link opens that folder'); assert.ok(h.view.resultIndices.includes(multi));
  // HUD rows say what the scene is, honestly.
  h.view.setQuery(''); h.view.openFolder('hud/Showcase'); dom.key(h.list(), 'ArrowDown');
  const hud = vCatalog0[h.view.focusedIndex()]; assert.equal(hud.kind, 'hud'); assert.ok(h.location().children.some(e => e.textContent === `HUD scene \u00b7 ${hud.hud.tier === 'auto' ? 'auto \u00b7 unreviewed' : hud.hud.tier}`), h.location().all().map(e => e.textContent).join('|'));
  h.view.openFolder('nerv'); dom.key(h.list(), 'ArrowDown'); assert.ok(h.location().children.some(e => e.textContent === 'NERV scene'));
  // The local title overlay reaches HUD rows only.
  h.view.openFolder('hud'); assert.ok(h.options_().every(e => /Fixture Title \d+/.test(e.textContent)), h.options_()[0].textContent); h.view.setQuery('fixture title'); assert.ok(h.view.resultIndices.length > 0);
  h.view.setQuery('Score Strip'); assert.ok(h.view.resultIndices.length > 0, 'the neutral name stays searchable'); assert.ok(h.options_()[0].textContent.includes('Fixture Title'), h.options_()[0].textContent); h.view.setQuery('');
  h.view.setData({titles: null}); h.view.openFolder('hud'); h.view.setQuery('Score Strip'); assert.ok(!h.options_()[0].textContent.includes('Fixture Title'), 'no overlay: the neutral public name'); h.view.setQuery('');
  h.view.openFolder('avs'); assert.ok(h.options_().every(e => !e.textContent.includes('Fixture Title')), 'AVS rows never take an overlay title'); h.view.dispose();
}
{
  // refresh(): a rating change patches one row without rebuilding anything.
  const catalog = [...vCatalog0]; const h = mount({catalog}); h.open('NERV'); dom.key(h.list(), 'ArrowDown'); const focused = h.view.focusedIndex(); const search = h.search(); const listNode = h.list();
  h.calls.length = 0;
  h.env.catalog = catalog.map((p, i) => i === focused ? {...p, rating: 4} : p); h.view.refresh();
  assert.ok(h.options_()[0].textContent.startsWith('\u2605\u2605\u2605\u2605  '), 'the row shows the new rating'); assert.equal(h.search(), search); assert.equal(h.list(), listNode, 'the skeleton is kept');
  assert.deepEqual(h.calls.filter(c => c[0] === 'focus'), [['focus', focused, 'refresh']], 'the manager is told the focused preset changed'); assert.equal(h.view.focusedIndex(), focused);
  // A mark and a session failure show as text; an unrelated refresh keeps focus and selection.
  h.env.catalog = h.env.catalog.map((p, i) => i === focused ? {...p, notWorking: true} : p); h.view.refresh(); assert.ok(h.options_()[0].textContent.includes(' \u00b7 not working'));
  h.env.failed = new Set([focused]); h.view.refresh(); assert.ok(h.options_()[0].textContent.includes(' \u00b7 failed'));
  h.env.failed = new Set(); h.view.refresh(); assert.ok(!h.options_()[0].textContent.includes(' \u00b7 failed')); h.calls.length = 0; h.view.refresh(); assert.deepEqual(h.calls, [], 'a refresh with no change announces nothing');
  // The rating filter follows a rating change: the row leaves a 5-star list.
  h.change('List minimum star rating', 4); assert.equal(h.view.resultIndices.includes(focused), true); h.env.catalog = h.env.catalog.map((p, i) => i === focused ? {...p, rating: 1} : p); h.view.refresh();
  assert.equal(h.view.resultIndices.includes(focused), false, 'lowering a rating removes it from a filtered list'); assert.ok(h.calls.some(c => c[0] === 'focus' && c[1] === -1), 'and the manager is told nothing is focused');
  // A catalog of another length rebuilds; another hash at the same index rebuilds; both keep the panel usable.
  const shorter = catalog.slice(0, 100); h.env.catalog = shorter; h.view.refresh(); assert.equal(h.node('AVS').children[2].textContent, '100', 'the tree follows a new catalog');
  h.env.catalog = shorter.map((p, i) => i === 3 ? {...p, sha256: HX(777)} : p); h.view.refresh(); assert.equal(h.view.resultIndices.length >= 0, true);
  // setData rebuilds with the new optional data; the taxonomy adds its branches.
  const before = h.nodeLabels().includes('By style'); h.view.setData({taxa: vTaxa}); h.view.reload(); assert.equal(before, false); h.open('AVS');
  assert.ok(h.q(e => e.tagName === 'option' && e.value === 'style'), 'style keys appear with taxonomy data'); h.view.dispose();
  // After dispose nothing touches the DOM.
  const listeners = () => (dom.listeners.resize ?? []).length, n0 = listeners(); const d = mount(); assert.equal(listeners(), n0 + 1, 'a view listens for resizes'); d.view.dispose(); assert.equal(listeners(), n0, 'and stops on dispose');
  const before2 = d.options_().length; d.env.catalog = []; assert.doesNotThrow(() => d.view.refresh()); assert.equal(d.options_().length, before2, 'a disposed view no longer touches its DOM');
}

// ---- narrow layout (the embedded artwork window) and the drill-down
{
  dom.narrow = true; const h = mount();
  assert.equal(h.view.root.attributes['data-narrow'], '1'); assert.equal(h.view.root.attributes['data-pane'], 'tree'); const spacer = h.list().children.find(c => c.className === 'ab-spacer'); assert.equal(spacer.style.height, `${4000 * ROW_NARROW}px`, 'rows are 52 px tall when narrow');
  h.list().clientHeight = 520; h.list().scrollTop = 0; dom.fire(h.list(), 'scroll'); assert.equal(h.options_().length, Math.ceil(520 / ROW_NARROW) + 6);
  h.open('NERV'); assert.equal(h.view.root.attributes['data-pane'], 'list', 'choosing a folder shows its list'); const back = h.button('\u2039 Folders'); h.click(back); assert.equal(h.view.root.attributes['data-pane'], 'tree'); assert.equal(document.activeElement, h.tree());
  h.node('NERV').onclick(); assert.equal(document.activeElement, h.list(), 'pointer opening moves focus out of the hidden narrow tree'); h.click(back);
  document.activeElement = null; dom.key(h.tree(), 'Enter'); assert.equal(h.view.root.attributes['data-pane'], 'list'); assert.equal(document.activeElement, h.list(), 'Enter moves focus to the list when narrow');
  const filters = h.button('Filters'); assert.equal(h.view.root.attributes['data-filters'], 'closed'); h.click(filters); assert.equal(h.view.root.attributes['data-filters'], 'open'); assert.equal(filters.attributes['aria-expanded'], 'true'); h.click(filters); assert.equal(h.view.root.attributes['data-filters'], 'closed');
  const details = h.button('Details'); h.click(details); assert.equal(h.view.root.attributes['data-details'], 'open'); assert.equal(details.attributes['aria-expanded'], 'true'); h.click(details); assert.equal(h.view.root.attributes['data-details'], 'closed');
  const rename = mount({state: {version: 1, folders: [{id: 'rename', name: 'Rename me', parent: null, kind: 'manual', presets: [], created: 1}]}});
  rename.open('My folders'); rename.node('Rename me').onclick(); rename.view.focusTree(); dom.key(rename.tree(), 'F2');
  assert.equal(rename.view.root.attributes['data-details'], 'open', 'F2 opens the narrow detail sheet before focusing its field');
  assert.equal(rename.button('Details').attributes['aria-expanded'], 'true'); assert.equal(document.activeElement, rename.label('Folder name')); rename.view.dispose();
  // A resize back to wide re-measures.
  dom.narrow = false; dom.resize(); assert.equal(h.view.root.attributes['data-narrow'], '0'); assert.equal(spacer.style.height, `${16 * ROW_WIDE}px`, 'the NERV list is re-laid out at the wide row height');
  // No matchMedia: the window width decides (or wide).
  dom = installFakeDom({matchMedia: false}); const nm = mount(); assert.equal(nm.view.root.attributes['data-narrow'], '0'); nm.view.dispose();
  globalThis.innerWidth = 400; const nw = mount(); assert.equal(nw.view.root.attributes['data-narrow'], '1'); nw.view.dispose(); delete globalThis.innerWidth;
  dom = installFakeDom(); h.view.dispose();
}

// ---- integration surface for the manager: the item slot and the callbacks
{
  const h = mount(); assert.ok(h.view.itemSlot && h.view.root.all().includes(h.view.itemSlot), 'the item slot is part of the tree');
  const marker = document.createElement('p'); marker.textContent = 'manager content'; h.view.itemSlot.append(marker); h.open('NERV'); dom.key(h.list(), 'ArrowDown');
  assert.ok(h.view.itemSlot.children.includes(marker), 'the view never clears what the manager put in the slot'); assert.ok(h.q(e => e.className === 'ab-detail').children.includes(h.view.itemSlot));
  // Every host callback is optional: a bare minimum host still works.
  const store = new FolderStore(() => {}, new FakeTimers()); store.load(); store.receive('state-loaded', {name: 'folders', data: null});
  const bare = new BrowserView({catalog: () => vCatalog0.slice(0, 50), current: () => -1, store, load() {}, rate() {}, markNotWorking() {}, settings: () => live});
  assert.doesNotThrow(() => { bare.focusSearch(); bare.focusTree(); bare.focusList(); bare.refresh(); bare.reload(); bare.stop(); bare.revealCurrent(); bare.playFolder(); bare.playLast(); }); bare.dispose();
  // revealCurrent opens the folder holding the playing preset and focuses it.
  const r = mount({current: 5000 > vCatalog0.length ? 0 : vCatalog0.findIndex(p => p.kind === 'avs' && p.origins?.length === 1 && !p.folder)}); r.open('NERV'); r.type('zzz'); r.settle();
  assert.equal(r.view.resultIndices.length, 0); assert.equal(r.view.revealCurrent(), true); assert.equal(r.view.focusedIndex(), r.env.current); assert.equal(r.view.queryText, '', 'the search was cleared to show it'); assert.notEqual(r.view.folderKey, 'nerv');
  assert.ok(r.options_().some(e => e.id === `ab-opt-${r.env.current}`)); dom.key(r.list(), '.'); assert.equal(r.view.focusedIndex(), r.env.current);
  const none = mount({current: -1}); assert.equal(none.view.revealCurrent(), false); const nerv = mount({current: vCatalog0.findIndex(p => p.kind === 'nerv')}); assert.equal(nerv.view.revealCurrent(), true); assert.equal(nerv.view.folderKey, 'nerv');
  r.view.dispose(); none.view.dispose(); nerv.view.dispose(); h.view.dispose();
  // The store's own listener is preserved.
  const seen = []; const s2 = new FolderStore(() => {}, new FakeTimers()); s2.onChange = () => seen.push('previous'); s2.load();
  const v2 = new BrowserView({catalog: () => vCatalog0.slice(0, 20), current: () => -1, store: s2, load() {}, rate() {}, markNotWorking() {}, settings: () => live}); s2.receive('state-loaded', {name: 'folders', data: null}); assert.ok(seen.includes('previous'), 'the previous onChange still runs'); v2.dispose();
}
// ---- the view on the manager's original minimal fake DOM (no getAttribute, style, head, measuring or matchMedia)
{
  class Mini {
    constructor(tag) { this.tagName = tag; this.children = []; this.attributes = {}; this.textContent = ''; this.value = ''; }
    append(...children) { this.children.push(...children); } prepend(...children) { this.children.unshift(...children); }
    replaceChildren(...children) { this.children = children; } setAttribute(k, v) { this.attributes[k] = v; } focus() { this.focused = true; }
    all() { return [this, ...this.children.flatMap(c => c.all())]; }
  }
  const savedDocument = globalThis.document, savedMedia = globalThis.matchMedia;
  globalThis.document = {createElement: tag => new Mini(tag)}; delete globalThis.matchMedia;
  try {
    const box = new Mini('section');
    const sent = [], store = new FolderStore(r => sent.push(r), new FakeTimers()); store.load(); store.receive('state-loaded', {name: 'folders', data: null});
    const played = [];
    const mini = new BrowserView({catalog: () => vCatalog0.slice(0, 300), current: () => 3, store, load() {}, rate() {}, markNotWorking() {}, settings: () => live,
      playFolder: plan => { played.push(plan.order.length); return {ok: true, eligible: plan.order.length}; }, stopFolder() {}, source: () => ({kind: 'library'})});
    box.append(mini.root);
    const kinds = box.all().filter(e => e.attributes.role === 'option').length;
    assert.equal(kinds, 60, 'unmeasured: the first 60 rows');
    assert.ok(box.all().some(e => e.attributes.role === 'treeitem'), 'the tree renders');
    box.all().find(e => e.tagName === 'button' && e.textContent === 'Play folder').onclick();
    assert.equal(played.length, 1, 'Play folder works on the minimal DOM');
    mini.setQuery('wave'); mini.refresh(); mini.reload(); mini.revealCurrent(); mini.playLast(); mini.stop();
    assert.ok(box.all().find(e => e.className === 'ab-status').textContent.length > 0);
    mini.dispose();
  } finally { globalThis.document = savedDocument; if (savedMedia) globalThis.matchMedia = savedMedia; }
}
dom.uninstall();

console.log('Management CPU DOM: independent search/shuffle filters, mark/clear and retest actions, setup threshold save/reload, rating/load actions, errors, close PASS; legacy settings and validation bounds PASS');
console.log('Preset Browser view PASS: keyboard models, sort and list models, injected scoped stylesheet, tree roles and keys, windowed list (measured, unmeasured, narrow, animation-frame), search (debounce, relevance, scope, Escape, /, notes), sort and filter controls, selection, Play folder (no 500 cap, results, subfolders, Stop, Ctrl+F8), built-in and saved folder options, user folders, store states, refresh patching, keyboard focus kept across redraws, narrow drill-down, the original minimal fake DOM');
