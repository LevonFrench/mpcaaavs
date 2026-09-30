import {
  AVS_EXACT_ORDERED_TEXER_GPU_CAPABILITY, AVS_EXACT_ORDERED_TEXER_WGSL,
  buildExactAvsTexer2UnscaledRecord, buildExactAvsTexerRecord,
  exactAvsTexer2ConfigEligibility, planExactAvsTexerGpu,
  renderExactAvsTexerRecordsBinnedCpu, renderExactAvsTexerRecordsCpu,
  type ExactAvsTexerDrawRecord,
} from '../src/avs/texer-ordered-gpu.ts';
import type { AvsBitmap } from '../src/avs/effects/bitmap-assets.ts';
let assertions=0; const assert=(condition:unknown,message:string):asserts condition=>{assertions++;if(!condition)throw new Error(message);};
const bitmap:AvsBitmap={width:5,height:5,pixels:Uint32Array.from({length:25},(_,i)=>((i*41)&255)|(((i*73)&255)<<8)|(((i*109)&255)<<16))};
const width=37,height=29; const plan=planExactAvsTexerGpu(width,height,bitmap,128);
assert(plan.eligible&&plan.tilePlan.tileSize===16,'fixed Texer plan should be eligible');
assert(AVS_EXACT_ORDERED_TEXER_GPU_CAPABILITY.byteExact,'Texer capability must be exact');
assert(!planExactAvsTexerGpu(width,height,{width:1,height:1,pixels:new Uint32Array(1)},2).eligible,'degenerate bitmap must fail closed');
assert(!exactAvsTexer2ConfigEligibility({version:1,image:'',resize:true,wrap:false,colorize:true,init:'',frame:'',beat:'',point:''}).eligible,'resized Texer II must fail closed');
const records:ExactAvsTexerDrawRecord[]=[buildExactAvsTexerRecord(bitmap,4,4,null),buildExactAvsTexerRecord(bitmap,4,4,0x4080c0),buildExactAvsTexerRecord(bitmap,-1,2,0xffffff)];
for(const [x,y,flipX,flipY] of [[-1,-1,false,false],[0,0,true,false],[0.02,-0.03,false,true],[1,1,true,true]] as const){const record=buildExactAvsTexer2UnscaledRecord(bitmap,width,height,x,y,0x90c060,true,flipX,flipY);if(record)records.push(record);}
const source=Uint32Array.from({length:width*height},(_,i)=>Math.imul(i+1,0x010305)&0x00ffffff);
for(let blendMode=0;blendMode<=9;blendMode++)for(const clearInput of [false,true]){const frame={records,blendMode,adjustableAlpha:173,clearInput};assert(equal(renderExactAvsTexerRecordsCpu(source,width,height,bitmap,frame),renderExactAvsTexerRecordsBinnedCpu(source,width,height,bitmap,frame,plan)),`binned Texer replay differs blend=${blendMode} clear=${clearInput}`);}
let seed=0x1234abcd;const random=():number=>{seed^=seed<<13;seed^=seed>>>17;seed^=seed<<5;return seed>>>0;};
for(let trial=0;trial<32;trial++){const randomRecords:ExactAvsTexerDrawRecord[]=[];for(let i=0;i<80;i++){const x=Number(random()%(width+12))-6,y=Number(random()%(height+12))-6;const r=buildExactAvsTexerRecord(bitmap,x,y,random()&1?random()&0x00ffffff:null);randomRecords.push({...r,flipX:Boolean(random()&1),flipY:Boolean(random()&1)});}const frame={records:randomRecords,blendMode:random()%10,adjustableAlpha:random()&255,clearInput:Boolean(random()&1)};assert(equal(renderExactAvsTexerRecordsCpu(source,width,height,bitmap,frame),renderExactAvsTexerRecordsBinnedCpu(source,width,height,bitmap,frame,plan)),`random Texer replay differs trial ${trial}`);}
assert(AVS_EXACT_ORDERED_TEXER_WGSL.includes('@compute @workgroup_size(16,16,1) fn raster_texer'),'ordered raster entry point missing');
assert(AVS_EXACT_ORDERED_TEXER_WGSL.includes('firstTrailingBit(bits)'),'raster must visit low bits first');
assert(AVS_EXACT_ORDERED_TEXER_WGSL.includes('bits&=bits-1u'),'raster must clear canonical bits');
console.log(`AVS ordered Texer GPU check passed (${assertions} assertions)`);
function equal(a:Uint32Array,b:Uint32Array):boolean{return a.length===b.length&&a.every((value,index)=>value===b[index]);}
