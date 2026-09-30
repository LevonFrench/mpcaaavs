import assert from 'node:assert/strict';
import { AVS_COLOR_MAP_APE_ID, assessExactGpuColorMap, buildExactAvsColorMapWgsl, planTerminalExactGpuColorMaps, type AvsColorMapConfig, type AvsComponent, type AvsPresetAst } from '../src/avs/index.ts';
let assertions=0;const config=(key=0,blendMode=0,cycle=0):AvsColorMapConfig=>({key,blendMode,mapCycleMode:cycle,adjustBlend:173,dontSkipFastBeats:false,cycleSpeed:8,maps:Array.from({length:8},(_,index)=>({index,enabled:index===0,id:index,filename:'',points:[{position:0,color:0x102030,id:0},{position:255,color:0xf0e0d0,id:1}]}))});
assert.equal(assessExactGpuColorMap(config()).eligible,true);assertions++;
assert.match(assessExactGpuColorMap(config(0,0,1)).reason,/stateful/);assertions++;
assert.equal(assessExactGpuColorMap(config(-1)).eligible,false);assertions++;
assert.equal(assessExactGpuColorMap(config(0,10)).eligible,false);assertions++;
for(let key=0;key<6;key++)for(let blend=0;blend<10;blend++){const wgsl=buildExactAvsColorMapWgsl(config(key,blend));assert.match(wgsl,/color_table\[key\]/);assertions++;assert.match(wgsl,/&0x00ffffffu/);assertions++;}
const component=encode(config()),preset:AvsPresetAst={version:2,header:'Nullsoft AVS Preset 0.2\u001a',clearEveryFrame:true,components:[component],byteLength:component.payload.length};
assert.equal(planTerminalExactGpuColorMaps(preset).extractedComponents,1);assertions++;
assert.equal(planTerminalExactGpuColorMaps({...preset,clearEveryFrame:false}).extractedComponents,0);assertions++;
assert.equal(planTerminalExactGpuColorMaps({...preset,components:[encode(config(0,0,2))]}).extractedComponents,0);assertions++;
console.log(`avs-color-map-gpu-check: PASS (${assertions} assertions)`);
function encode(value:AvsColorMapConfig):AvsComponent{const payload=new Uint8Array(496+value.maps.reduce((sum,map)=>sum+map.points.length*12,0)),view=new DataView(payload.buffer);view.setInt32(0,value.key,true);view.setInt32(4,value.blendMode,true);view.setInt32(8,value.mapCycleMode,true);payload[12]=value.adjustBlend;payload[15]=value.cycleSpeed;let tail=496;value.maps.forEach((map,index)=>{const header=16+index*60;view.setInt32(header,map.enabled?1:0,true);view.setInt32(header+4,map.points.length,true);map.points.forEach(point=>{view.setUint32(tail,point.position,true);view.setUint32(tail+4,point.color,true);view.setUint32(tail+8,point.id,true);tail+=12;});});return{effectId:16384,apeId:AVS_COLOR_MAP_APE_ID,payload,fileOffset:0,path:'0',children:[],list:null,listCode:null};}
