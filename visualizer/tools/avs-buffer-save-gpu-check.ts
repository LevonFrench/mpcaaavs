import {
  assessExactGpuBufferSave, buildExactAvsBufferSaveWgsl, planAvsResidentSurfaces,
  resolveExactAvsBufferSaveDirection, type AvsBufferSaveResidentOperation,
  type AvsComponent, type AvsPresetAst,
} from '../src/avs/index.ts';

let assertions=0;const assert=(value:unknown,message:string):asserts value=>{assertions++;if(!value)throw new Error(message);};
const expectedModes=['replace','average','additive','every-other-pixel','destination-minus-source','every-other-line','xor','maximum','minimum','source-minus-destination','multiply','adjustable'];
for(let blend=0;blend<12;blend++){
  const operation=planned(bufferSave('0',0,3,blend,blend===11?77:128));
  const eligibility=assessExactGpuBufferSave(operation);
  assert(eligibility.eligible,`blend ${blend} must be eligible`);
  assert(operation.blendCode===blend&&operation.blendMode===expectedModes[blend],`blend ${blend} surface metadata`);
  const store=buildExactAvsBufferSaveWgsl(operation,true,31);
  assert(store.includes('global_buffer[index]=blend(frame,old,index)'),`blend ${blend} store shader`);
  assert(store.includes('const WIDTH=31u'),`blend ${blend} width specialization`);
}
const load=planned(bufferSave('0',1,5,0,128));
assert(load.possibleDirections.join(',')==='load'&&!load.createsBuffer,'load-only must preserve absent-buffer no-op metadata');
assert(buildExactAvsBufferSaveWgsl(load,false,17).includes('output[index]=blend(saved,frame,index)'), 'load shader direction');
const even=planned(bufferSave('0',2,1,0,128)),odd=planned(bufferSave('0',3,1,0,128));
assert(even.cpuPhaseState&&even.alternatesEachFrame,'even alternating metadata');
assert(odd.cpuPhaseState&&odd.alternatesEachFrame,'odd alternating metadata');
let phase:0|1=0,sequence:string[]=[];for(let i=0;i<4;i++){const step=resolveExactAvsBufferSaveDirection(2,phase);sequence.push(step.direction);phase=step.nextPhase;}
assert(sequence.join(',')==='store,load,store,load','even alternating sequence');
phase=0;sequence=[];for(let i=0;i<4;i++){const step=resolveExactAvsBufferSaveDirection(3,phase);sequence.push(step.direction);phase=step.nextPhase;}
assert(sequence.join(',')==='load,store,load,store','odd alternating sequence');
assert(resolveExactAvsBufferSaveDirection(-1,0).direction==='load','native negative nonzero direction loads');
assert(!assessExactGpuBufferSave({...load,blendCode:12}).eligible,'unknown blend code must fail closed');
assert(!assessExactGpuBufferSave({...even,possibleDirections:['store']}).eligible,'inconsistent direction metadata must fail closed');
assert(!assessExactGpuBufferSave({...even,cpuPhaseState:false}).eligible,'inconsistent phase metadata must fail closed');
assert(!assessExactGpuBufferSave(load,2).eligible,'unsupported initial phase must fail closed');
let threw=false;try{buildExactAvsBufferSaveWgsl(load,true,17);}catch{threw=true;}assert(threw,'unplanned direction shader must fail closed');
console.log(`avs-buffer-save-gpu-check: PASS (${assertions} assertions)`);

function planned(component:AvsComponent):AvsBufferSaveResidentOperation{
  const preset:AvsPresetAst={version:2,header:'test',clearEveryFrame:false,components:[component],byteLength:component.payload.length};
  const operation=planAvsResidentSurfaces(preset).operations.find(value=>value.kind==='buffer-save');
  if(!operation)throw new Error('Buffer Save operation missing');return operation;
}
function bufferSave(path:string,direction:number,buffer:number,blend:number,amount:number):AvsComponent{
  const payload=new Uint8Array(16),view=new DataView(payload.buffer);view.setInt32(0,direction,true);view.setInt32(4,buffer,true);view.setInt32(8,blend,true);view.setInt32(12,amount,true);
  return{effectId:18,apeId:null,payload,fileOffset:0,path,children:[],list:null,listCode:null};
}
