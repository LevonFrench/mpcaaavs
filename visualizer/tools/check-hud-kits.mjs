// L1: read-only metadata audit. Corrections are a private overlay outside the kit tree.
import { existsSync, lstatSync, mkdirSync, readFileSync, readdirSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { createHash } from 'node:crypto';
import { decodeImage, sniffImage } from './png-lite.mjs';
const visualizer = fileURLToPath(new URL('../', import.meta.url));
export const hash = bytes => createHash('sha256').update(bytes).digest('hex');
export function isInside(child, parent) { const r=path.relative(path.resolve(parent),path.resolve(child));return r===''||(!r.startsWith(`..${path.sep}`)&&r!=='..'&&!path.isAbsolute(r)); }
export function noLinks(value) {
  const absolute=path.resolve(value), root=path.parse(absolute).root;let current=root;
  for(const part of absolute.slice(root.length).split(path.sep).filter(Boolean)){current=path.join(current,part);if(!existsSync(current))break;if(lstatSync(current).isSymbolicLink())throw Error('Linked paths are refused');}
}
export function imagesIn(directory) {
  if(!existsSync(directory))return [];
  noLinks(directory); return readdirSync(directory,{withFileTypes:true}).sort((a,b)=>a.name.localeCompare(b.name,'en')).flatMap(e=>{const p=path.join(directory,e.name);if(e.isSymbolicLink())return [];return e.isDirectory()?imagesIn(p):e.isFile()&&/\.(?:png|jpe?g|gif|webp)$/i.test(e.name)?[p]:[];});
}
export function readKit(directory) {
  noLinks(directory);const file=path.join(directory,'manifest.json');let manifest={},problem=null;
  try{if(existsSync(file)){if(lstatSync(file).size>2*1024*1024)throw Error('Oversized kit manifest');manifest=JSON.parse(readFileSync(file,'utf8'));if(!manifest||typeof manifest!=='object'||Array.isArray(manifest))throw Error('Invalid kit manifest');}else problem='missing-manifest';}catch{problem='unreadable-manifest';}
  const images=imagesIn(directory), crops=images.filter(p=>path.relative(directory,p).startsWith(`crops${path.sep}`)&&!/viewport|stage|arena/i.test(path.basename(p)));
  const source=images.find(p=>path.relative(directory,p).startsWith(`source${path.sep}`));
  return {directory,key:path.basename(directory),manifest,problem,images,image:source??images.find(p=>/assembly_preview/i.test(p))??images[0],paletteImages:crops.length?crops:source?[source]:images.slice(0,1)};
}
export function auditKit(kit) {
  const m=kit.manifest,p=m.provenance??m.source??{},issues=[],corrected={}; let image=null;
  if(kit.problem)issues.push(kit.problem);
  if(kit.image)try{image=decodeImage(readFileSync(kit.image));corrected.sourceResolution={width:image.width,height:image.height};}catch{issues.push(`image-${sniffImage(readFileSync(kit.image))}-unsupported`);}
  else issues.push('no-image');
  const declared=p.sourceResolution??m.sourceResolution;
  if(image&&declared&&(declared.width!==image.width||declared.height!==image.height))issues.push('declared-image-size-mismatch');
  const native=p.nativeResolution??m.nativeResolution;
  if(image&&image.height>image.width&&/4[:/]3/.test(native?.displayAspectRatio??'')){issues.push('portrait-labelled-landscape');corrected.displayAspectRatio=`${image.width}:${image.height}`;}
  if(!/^[a-f0-9]{64}$/i.test(p.sourceSha256??'')){issues.push('non-hash-source-sha256');if(kit.image)corrected.sourceSha256=hash(readFileSync(kit.image));}
  if(p.releaseYear&&new RegExp(`\\b${p.releaseYear}\\b`).test(m.title??''))issues.push('year-matches-title-number');
  if(!m.typography&&!m.fonts)issues.push('missing-typography');
  const es=Array.isArray(m.elements)?m.elements:[];
  const template=es.length<4||es.every(e=>/dock|viewport|header|panel|cluster|player-status-gauge|radar-or-counter|command-selector|countdown-timer-boss|minimap-subweapon/.test(e.role??''));
  if(template)issues.push('template-decomposition'); corrected.layoutOrigin=template?'template':'kit';
  const wiki=p.wikiPath??m.wikiPath; if(typeof wiki==='string'&&path.isAbsolute(wiki)&&!existsSync(wiki))issues.push('dangling-wiki-reference');
  return {key:kit.key,issues,corrected};
}
export function auditKits(kitsDirectory,outDirectory) {
  const root=path.resolve(kitsDirectory);if(outDirectory&&isInside(outDirectory,root))throw Error('Metadata overlay must be outside kit assets');
  if(!existsSync(root))return {format:'aaavs-hud-kit-audit',version:1,skipped:true,kits:0,counts:{},overlay:[]};
  const rows=readdirSync(root,{withFileTypes:true}).filter(e=>e.isDirectory()&&!e.name.startsWith('_')).sort((a,b)=>a.name.localeCompare(b.name,'en')).map(e=>auditKit(readKit(path.join(root,e.name))));
  const counts={};for(const row of rows)for(const issue of row.issues)counts[issue]=(counts[issue]??0)+1;
  const report={format:'aaavs-hud-kit-audit',version:1,skipped:false,kits:rows.length,counts,overlay:rows};
  if(outDirectory){noLinks(outDirectory);mkdirSync(outDirectory,{recursive:true});writeFileSync(path.join(outDirectory,'kit-metadata-overlay.json'),JSON.stringify(report,null,2)+'\n');}return report;
}
if(process.argv[1]&&path.resolve(process.argv[1])===fileURLToPath(import.meta.url)){
  try{const args=process.argv.slice(2),arg=(key,fallback)=>{const i=args.indexOf(key);return i<0?fallback:args[i+1];};const report=auditKits(arg('--kits',path.join(visualizer,'assets','hud-kits')),arg('--out-dir',path.join(visualizer,'..','.tmp','HGEN','kit-audit')));console.log(JSON.stringify({skipped:report.skipped,kits:report.kits,counts:report.counts}));}catch(e){console.error(e.message);process.exitCode=1;}
}
