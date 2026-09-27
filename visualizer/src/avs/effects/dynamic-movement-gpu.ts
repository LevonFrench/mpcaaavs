import { avsAudioSample } from '../audio.ts';
import { compileAvsEel } from '../eel/compiler.ts';
import type { AvsEelProgram } from '../eel/types.ts';
import { AvsEelVm, type AvsEelGlobalState } from '../eel/vm.ts';
import type { AvsFrameGraphCapability, AvsGpuPassContext, PackedAvsGpuPass } from '../gpu-frame-graph.ts';
import type { AvsDynamicMovementConfig } from './dynamic-movement.ts';
import type { AvsAudioFrame } from '../types.ts';

export const AVS_GPU_DYNAMIC_MOVEMENT_CAPABILITY: AvsFrameGraphCapability = {
  id: 'dynamic-movement-cpu-map-gpu-resample', backend: 'webgpu', lane: '120', byteExact: true,
  reason: 'CPU preserves EEL/grid state and uploads an exact packed map; WebGPU performs packed-u32 sampling and alpha blend.',
};

export interface AvsDynamicMovementGpuMap {
  readonly packed: Uint32Array;
  readonly bilinear: boolean;
  readonly blend: boolean;
}

export class AvsDynamicMovementGpuMapGenerator {
  private readonly vm: AvsEelVm;
  private readonly programs: readonly [AvsEelProgram | null, AvsEelProgram | null, AvsEelProgram | null, AvsEelProgram | null];
  private initialized = false;
  private gridX = new Float64Array(0);
  private gridY = new Float64Array(0);
  private gridAlpha = new Float64Array(0);
  private cellX = new Uint16Array(0);
  private fractionX = new Float64Array(0);
  private cellY = new Uint16Array(0);
  private fractionY = new Float64Array(0);
  private packed = new Uint32Array(0);

  constructor(
    readonly config: AvsDynamicMovementConfig,
    global: AvsEelGlobalState,
    seed: number,
  ) {
    if (config.buffer !== 0 || config.noMove) throw new Error('Dynamic Movement GPU map rejects global-buffer and no-move modes');
    this.vm = new AvsEelVm({ global, seed });
    this.programs = [
      compileOrNull(config.point), compileOrNull(config.frame),
      compileOrNull(config.beat), compileOrNull(config.init),
    ];
  }

  generate(audio: AvsAudioFrame, width: number, height: number): AvsDynamicMovementGpuMap {
    if (width <= 0 || height <= 0 || width * height >= 0x00400000) throw new RangeError('Dynamic Movement GPU dimensions unsupported');
    const vm = this.vm;
    vm.setHost({
      getosc: (band, sampleWidth, channel) => avsAudioSample(audio, 'osc', band, sampleWidth, channel),
      getspec: (band, sampleWidth, channel) => avsAudioSample(audio, 'spec', band, sampleWidth, channel),
    });
    vm.set('w', width); vm.set('h', height); vm.set('b', audio.beat ? 1 : 0); vm.set('alpha', 0.5);
    if (!this.initialized) { execute(this.programs[3], vm); this.initialized = true; }
    execute(this.programs[1], vm); if (audio.beat) execute(this.programs[2], vm);
    const columns = clamp(Math.trunc(this.config.gridWidth) + 1, 2, 256);
    const rows = clamp(Math.trunc(this.config.gridHeight) + 1, 2, 256);
    const gridSize = columns * rows;
    if (this.gridX.length !== gridSize) {
      this.gridX = new Float64Array(gridSize); this.gridY = new Float64Array(gridSize);
      this.gridAlpha = new Float64Array(gridSize);
    }
    this.prepareAxes(width, height, columns, rows);
    const radius = Math.sqrt(width * width + height * height) * 0.5;
    for (let gy = 0; gy < rows; gy++) {
      const screenY = gy * height / (rows - 1);
      const normalizedY = (screenY - height * 0.5) * (2 / height);
      for (let gx = 0; gx < columns; gx++) {
        const screenX = gx * width / (columns - 1);
        vm.set('x', (screenX - width * 0.5) * (2 / width)); vm.set('y', normalizedY);
        vm.set('d', Math.hypot(screenX - width * 0.5, screenY - height * 0.5) / radius);
        vm.set('r', Math.atan2(screenY - height * 0.5, screenX - width * 0.5) + Math.PI * 0.5);
        execute(this.programs[0], vm);
        const index = gx + gy * columns;
        if (this.config.rectangular) {
          this.gridX[index] = (vm.get('x') + 1) * width * 0.5;
          this.gridY[index] = (vm.get('y') + 1) * height * 0.5;
        } else {
          const distance = vm.get('d') * radius, angle = vm.get('r') - Math.PI * 0.5;
          this.gridX[index] = width * 0.5 + Math.cos(angle) * distance;
          this.gridY[index] = height * 0.5 + Math.sin(angle) * distance;
        }
        this.gridAlpha[index] = clamp(vm.get('alpha'), 0, 1);
      }
    }
    if (this.packed.length !== width * height * 2) this.packed = new Uint32Array(width * height * 2);
    this.buildPackedMap(width, height, columns);
    return { packed: this.packed, bilinear: this.config.bilinear, blend: this.config.blend };
  }

  private buildPackedMap(width: number, height: number, columns: number): void {
    const bilinear = this.config.bilinear;
    const maxX = Math.max(0, width - (bilinear ? 2 : 1));
    const maxY = Math.max(0, height - (bilinear ? 2 : 1));
    const spanX = Math.max(1, maxX), spanY = Math.max(1, maxY);
    let index = 0;
    for (let y = 0; y < height; y++) {
      const cellY = this.cellY[y]!, fy = this.fractionY[y]!, inverseY = 1 - fy;
      const row = cellY * columns;
      for (let x = 0; x < width; x++, index++) {
        const fx = this.fractionX[x]!, topLeft = this.cellX[x]! + row;
        const topRight = topLeft + 1, bottomLeft = topLeft + columns, bottomRight = bottomLeft + 1;
        let mappedX = (this.gridX[topLeft]! + (this.gridX[topRight]! - this.gridX[topLeft]!) * fx) * inverseY
          + (this.gridX[bottomLeft]! + (this.gridX[bottomRight]! - this.gridX[bottomLeft]!) * fx) * fy;
        let mappedY = (this.gridY[topLeft]! + (this.gridY[topRight]! - this.gridY[topLeft]!) * fx) * inverseY
          + (this.gridY[bottomLeft]! + (this.gridY[bottomRight]! - this.gridY[bottomLeft]!) * fx) * fy;
        if (this.config.wrap) {
          mappedX = ((mappedX % spanX) + spanX) % spanX; mappedY = ((mappedY % spanY) + spanY) % spanY;
        } else {
          mappedX = clamp(mappedX, 0, maxX); mappedY = clamp(mappedY, 0, maxY);
        }
        const ix = Math.trunc(mappedX), iy = Math.trunc(mappedY);
        const sampleX = bilinear && width >= 2 ? Math.trunc((mappedX - ix) * 256) & 255 : 0;
        const sampleY = bilinear && height >= 2 ? Math.trunc((mappedY - iy) * 256) & 255 : 0;
        const rawAlpha = (this.gridAlpha[topLeft]! + (this.gridAlpha[topRight]! - this.gridAlpha[topLeft]!) * fx) * inverseY
          + (this.gridAlpha[bottomLeft]! + (this.gridAlpha[bottomRight]! - this.gridAlpha[bottomLeft]!) * fx) * fy;
        const alpha = Math.trunc(clamp(rawAlpha, 0, 1) * 255);
        this.packed[index * 2] = ix + iy * width;
        this.packed[index * 2 + 1] = sampleX | (sampleY << 8) | (alpha << 16);
      }
    }
  }

  private prepareAxes(width: number, height: number, columns: number, rows: number): void {
    if (this.cellX.length !== width) {
      this.cellX = new Uint16Array(width); this.fractionX = new Float64Array(width);
      for (let x = 0; x < width; x++) { const c = x * (columns - 1) / width; const cell = Math.min(columns - 2, Math.trunc(c)); this.cellX[x] = cell; this.fractionX[x] = c - cell; }
    }
    if (this.cellY.length !== height) {
      this.cellY = new Uint16Array(height); this.fractionY = new Float64Array(height);
      for (let y = 0; y < height; y++) { const c = y * (rows - 1) / height; const cell = Math.min(rows - 2, Math.trunc(c)); this.cellY[y] = cell; this.fractionY[y] = c - cell; }
    }
  }
}

export const AVS_ENHANCED_DYNAMIC_MOVEMENT_WGSL = /* wgsl */ `
struct Params { width: u32, pixels: u32, bilinear: u32, blend: u32 };
@group(0) @binding(0) var<storage, read> source: array<u32>;
@group(0) @binding(1) var<storage, read_write> destination: array<u32>;
@group(0) @binding(2) var<storage, read> map: array<u32>;
@group(0) @binding(3) var<uniform> params: Params;
fn avs_table(a:u32,b:u32)->u32 { var r=(a*b)/255u; let c=(a==147u&&(b==85u||b==170u))||(a==155u&&(b==51u||b==102u||b==153u||b==204u))||(a==171u&&(b==85u||b==170u))||(a==187u&&(b==75u||b==150u||b==165u))||(a==195u&&b==153u); if(c){r-=1u;} return r; }
fn blend(a:u32,b:u32,alpha:u32)->u32 { let inv=255u-alpha; let lo=avs_table(a&255u,alpha)+avs_table(b&255u,inv); let mi=avs_table((a>>8u)&255u,alpha)+avs_table((b>>8u)&255u,inv); let hi=avs_table((a>>16u)&255u,alpha)+avs_table((b>>16u)&255u,inv); return lo|(mi<<8u)|(hi<<16u); }
fn sample4(offset:u32,fx:u32,fy:u32)->u32 { let ix=255u-fx; let iy=255u-fy; let w=array<u32,4>(avs_table(ix,iy),avs_table(fx,iy),avs_table(ix,fy),avs_table(fx,fy)); let p=array<u32,4>(source[offset],source[offset+1u],source[offset+params.width],source[offset+params.width+1u]); var lo=0u;var mi=0u;var hi=0u;for(var i=0u;i<4u;i++){lo+=avs_table(p[i]&255u,w[i]);mi+=avs_table((p[i]>>8u)&255u,w[i]);hi+=avs_table((p[i]>>16u)&255u,w[i]);}return (lo&255u)|((mi&255u)<<8u)|((hi&255u)<<16u); }
@compute @workgroup_size(256) fn dynamic_movement_main(@builtin(global_invocation_id) id:vec3u){let i=id.x;if(i>=params.pixels){return;}let offset=map[i*2u];let extra=map[i*2u+1u];var sampled=source[offset];if(params.bilinear!=0u){sampled=sample4(offset,extra&255u,(extra>>8u)&255u);}destination[i]=select(sampled,blend(sampled,source[i],(extra>>16u)&255u),params.blend!=0u);}
`;

export class EnhancedDynamicMovementGpuPass implements PackedAvsGpuPass {
  readonly capability = AVS_GPU_DYNAMIC_MOVEMENT_CAPABILITY;
  private readonly pipeline: GPUComputePipeline; private readonly map: GPUBuffer; private readonly params: GPUBuffer;
  private readonly groups = new WeakMap<GPUBuffer, WeakMap<GPUBuffer, GPUBindGroup>>();
  constructor(private readonly device: GPUDevice, readonly generator: AvsDynamicMovementGpuMapGenerator, private readonly width: number, private readonly height: number) {
    this.pipeline = device.createComputePipeline({ layout:'auto', compute:{ module:device.createShaderModule({code:AVS_ENHANCED_DYNAMIC_MOVEMENT_WGSL}), entryPoint:'dynamic_movement_main' } });
    this.map = device.createBuffer({ size: width * height * 8, usage: GPUBufferUsage.STORAGE | GPUBufferUsage.COPY_DST });
    this.params = device.createBuffer({ size:16, usage:GPUBufferUsage.UNIFORM | GPUBufferUsage.COPY_DST });
  }
  update(audio: AvsAudioFrame): void { const map=this.generator.generate(audio,this.width,this.height); this.device.queue.writeBuffer(this.map,0,map.packed.buffer as ArrayBuffer,map.packed.byteOffset,map.packed.byteLength); this.device.queue.writeBuffer(this.params,0,new Uint32Array([this.width,this.width*this.height,map.bilinear?1:0,map.blend?1:0])); }
  encode(context:AvsGpuPassContext):void { let targets=this.groups.get(context.source);if(!targets){targets=new WeakMap();this.groups.set(context.source,targets);}let group=targets.get(context.target);if(!group){group=context.device.createBindGroup({layout:this.pipeline.getBindGroupLayout(0),entries:[{binding:0,resource:{buffer:context.source}},{binding:1,resource:{buffer:context.target}},{binding:2,resource:{buffer:this.map}},{binding:3,resource:{buffer:this.params}}]});targets.set(context.target,group);}const pass=context.encoder.beginComputePass();pass.setPipeline(this.pipeline);pass.setBindGroup(0,group);pass.dispatchWorkgroups(Math.ceil(context.width*context.height/256));pass.end(); }
  destroy():void { this.map.destroy();this.params.destroy(); }
}

function compileOrNull(source:string):AvsEelProgram|null { if(!source.trim())return null;try{return compileAvsEel(source);}catch{return null;} }
function execute(program:AvsEelProgram|null,vm:AvsEelVm):number { return program?vm.execute(program):0; }
function clamp(value:number,min:number,max:number):number{return value<min?min:value>max?max:value;}
