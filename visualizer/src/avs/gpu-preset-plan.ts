import type { AvsComponent, AvsPresetAst } from './types.ts';
import { decodeAvsMovement } from './effects/movement.ts';
import { decodeAvsBlitterFeedback, decodeAvsRotoBlitter } from './effects/blitter-gpu.ts';
import {
  AVS_CHANNEL_SHIFT_APE_ID, AVS_COLOR_REDUCTION_APE_ID, AVS_MULTIPLIER_APE_ID,
  createAvsChannelShiftState, decodeAvsChannelShift, decodeAvsColorReduction,
  decodeAvsMultiplier, resolveAvsChannelShiftMode, type AvsChannelShiftState,
} from './effects/named-apes.ts';
import type {
  ExactAvsBlurConfig, ExactAvsGpuPassConfig, ExactAvsPointwiseOperation,
} from './gpu-frame-graph.ts';

export interface AvsTerminalGpuPlan {
  readonly cpuPreset: AvsPresetAst;
  /** Physical GPU passes after consecutive pointwise operations are fused. */
  readonly passes: readonly ExactAvsGpuPassConfig[];
  /** Compatibility/diagnostic view of the Blur operations in `passes`. */
  readonly blurPasses: readonly ExactAvsBlurConfig[];
  readonly extractedComponents: number;
  readonly fusedPointwiseOperations: number;
  readonly movementPasses: number;
  readonly rotoBlitterPasses: number;
  readonly blitterFeedbackPasses: number;
  readonly reason: string;
}

export interface AvsGpuChannelShiftResolver {
  readonly state: AvsChannelShiftState;
  readonly randomizeOnBeat: boolean;
  resolve(beat: boolean): Extract<ExactAvsPointwiseOperation, { kind: 'channel-shift' }>;
}

/** Resolve beat-random Channel Shift on CPU into the compact mode consumed by WGSL. */
export function createExactGpuChannelShiftResolver(component: AvsComponent): AvsGpuChannelShiftResolver {
  if (component.list || normalizedApe(component.apeId) !== normalizedApe(AVS_CHANNEL_SHIFT_APE_ID)) {
    throw new TypeError('component is not Channel Shift');
  }
  const config=decodeAvsChannelShift(component.payload),state=createAvsChannelShiftState(config,component.path);
  return{state,randomizeOnBeat:config.randomizeOnBeat,resolve:(beat:boolean)=>({kind:'channel-shift',mode:resolveAvsChannelShiftMode(state,config,beat)})};
}

/**
 * Extract a root-level terminal Blur chain only when each visual frame starts
 * from a cleared root. Otherwise the CPU executor needs the blurred result as
 * next-frame feedback, and offloading without readback would change semantics.
 */
export function planTerminalExactGpuPasses(preset: AvsPresetAst): AvsTerminalGpuPlan {
  if (!preset.clearEveryFrame) {
    return emptyPlan(preset, 'root framebuffer feedback requires the exact CPU graph');
  }
  let split = preset.components.length;
  const reverse: Array<ExactAvsGpuPassConfig> = [];
  while (split > 0) {
    const component = preset.components[split - 1]!;
    const config = terminalExactConfig(component);
    if (!config) break;
    reverse.push(config);
    split--;
  }
  if (reverse.length === 0) {
    return emptyPlan(preset, 'no safe root-level terminal exact-GPU suffix');
  }
  const components = reverse.reverse();
  const passes = fusePointwise(components);
  const blurPasses = passes.flatMap(pass => pass.kind === 'blur' ? [pass.config] : []);
  const fusedPointwiseOperations = passes.reduce(
    (total, pass) => total + (pass.kind === 'pointwise' ? pass.operations.length : 0), 0,
  );
  const movementPasses = passes.filter(pass => pass.kind === 'movement').length;
  const rotoBlitterPasses = passes.filter(pass => pass.kind === 'roto-blitter').length;
  const blitterFeedbackPasses = passes.filter(pass => pass.kind === 'blitter-feedback').length;
  return {
    cpuPreset: { ...preset, components: preset.components.slice(0, split) },
    passes,
    blurPasses,
    extractedComponents: components.length,
    fusedPointwiseOperations,
    movementPasses,
    rotoBlitterPasses,
    blitterFeedbackPasses,
    reason: `${components.length} exact terminal component${components.length === 1 ? '' : 's'} moved to ` +
      `${passes.length} resident WebGPU pass${passes.length === 1 ? '' : 'es'}` +
      (fusedPointwiseOperations > 1 ? ` (${fusedPointwiseOperations} pointwise operations fused)` : '') +
      (movementPasses > 0 ? ` (${movementPasses} static Movement map${movementPasses === 1 ? '' : 's'})` : '') +
      (rotoBlitterPasses > 0 ? ` (${rotoBlitterPasses} static Roto Blitter affine pass${rotoBlitterPasses === 1 ? '' : 'es'})` : '') +
      (blitterFeedbackPasses > 0 ? ` (${blitterFeedbackPasses} static Blitter Feedback affine pass${blitterFeedbackPasses === 1 ? '' : 'es'})` : ''),
  };
}

function emptyPlan(preset: AvsPresetAst, reason: string): AvsTerminalGpuPlan {
  return {
    cpuPreset: preset, passes: [], blurPasses: [], extractedComponents: 0,
    fusedPointwiseOperations: 0, movementPasses: 0, rotoBlitterPasses: 0, blitterFeedbackPasses: 0, reason,
  };
}

function fusePointwise(components: readonly ExactAvsGpuPassConfig[]): ExactAvsGpuPassConfig[] {
  const result: ExactAvsGpuPassConfig[] = [];
  let pending: ExactAvsPointwiseOperation[] = [];
  const flush = (): void => {
    if (pending.length === 0) return;
    result.push({ kind: 'pointwise', operations: pending });
    pending = [];
  };
  for (const component of components) {
    if (component.kind === 'pointwise') pending.push(...component.operations);
    else { flush(); result.push(component); }
  }
  flush();
  return result;
}

function terminalExactConfig(component: AvsComponent): ExactAvsGpuPassConfig | null {
  const blur = terminalBlurConfig(component);
  if (blur) return { kind: 'blur', config: blur };
  const pointwise = terminalPointwiseConfig(component);
  if (pointwise) return { kind: 'pointwise', operations: [pointwise] };
  if (!component.list && !component.apeId && component.effectId === 15) {
    const config = decodeAvsMovement(component.payload);
    if (config.sourceMapped === 0 && config.effect >= 2 && config.effect <= 17) {
      return { kind: 'movement', config };
    }
  }
  if (!component.list && !component.apeId && component.effectId === 9) {
    const config = decodeAvsRotoBlitter(component.payload);
    if (!config.beatReverse && !config.beatScale) return { kind: 'roto-blitter', config };
  }
  if (!component.list && !component.apeId && component.effectId === 4) {
    const config = decodeAvsBlitterFeedback(component.payload);
    if (!config.changeOnBeat && config.scale !== 32) return { kind: 'blitter-feedback', config };
  }
  return null;
}

function terminalBlurConfig(component: AvsComponent): ExactAvsBlurConfig | null {
  if (component.list || component.apeId || component.effectId !== 6) return null;
  const view = new DataView(component.payload.buffer, component.payload.byteOffset, component.payload.byteLength);
  const mode = component.payload.byteLength >= 4 ? view.getInt32(0, true) : 1;
  if (mode !== 1 && mode !== 2 && mode !== 3) return null;
  const roundUp = component.payload.byteLength >= 8 && view.getInt32(4, true) !== 0;
  return { mode, roundUp };
}

function terminalPointwiseConfig(component: AvsComponent): ExactAvsPointwiseOperation | null {
  if (component.list) return null;
  if (component.apeId) {
    const ape=normalizedApe(component.apeId);
    if(ape===normalizedApe(AVS_CHANNEL_SHIFT_APE_ID)){
      const config=decodeAvsChannelShift(component.payload);
      // Beat-random state needs a per-frame CPU-resolved mode/uniform seam.
      // The immutable terminal pipeline fails closed until that seam is live.
      return config.randomizeOnBeat?null:{kind:'channel-shift',mode:config.mode};
    }
    if(ape===normalizedApe(AVS_COLOR_REDUCTION_APE_ID)){
      const levels=Math.max(0,Math.min(8,Math.trunc(decodeAvsColorReduction(component.payload).levels)));
      const mask=levels===0?0:(0xff<<(8-levels))&0xff;
      return{kind:'color-reduction',mask:mask|(mask<<8)|(mask<<16)};
    }
    if(ape===normalizedApe(AVS_MULTIPLIER_APE_ID))return{kind:'multiplier',mode:decodeAvsMultiplier(component.payload).mode};
    return null;
  }
  switch (component.effectId) {
    case 3: {
      const fade = int(component, 0, 16);
      if (fade < 1 || fade > 255) return null;
      return { kind: 'fade', fade, target: int(component, 4, 0) & 0x00ffffff };
    }
    case 12: {
      const mode = int(component, 0, 1);
      if (mode === 0) return null;
      const distance = int(component, 12, 10) * 2;
      const squared = distance * distance;
      if (!Number.isSafeInteger(squared)) return null;
      return {
        kind: 'color-clip', mode: mode === 1 || mode === 2 ? mode : 3,
        source: int(component, 4, 0x202020) & 0x00ffffff,
        replacement: int(component, 8, int(component, 4, 0x202020)) & 0x00ffffff,
        distanceSquared: Math.min(195_075, squared),
      };
    }
    case 22: {
      if (int(component, 0, 1) === 0) return null;
      const redMultiplier = brightnessMultiplier(int(component, 12, 0));
      const greenMultiplier = brightnessMultiplier(int(component, 16, 0));
      const blueMultiplier = brightnessMultiplier(int(component, 20, 0));
      const maximum = Math.floor(0xffffffff / 255);
      if (![redMultiplier, greenMultiplier, blueMultiplier].every(
        value => Number.isInteger(value) && value >= 0 && value <= maximum,
      )) return null;
      const distance = int(component, 36, 16);
      if (distance === -0x80000000) return null;
      return {
        kind: 'brightness', additive: int(component, 4, 0) !== 0,
        average: int(component, 8, 1) !== 0,
        redMultiplier, greenMultiplier, blueMultiplier,
        reference: int(component, 28, 0) & 0x00ffffff,
        exclude: int(component, 32, 0) !== 0,
        distance,
      };
    }
    case 37:
      return int(component, 0, 1) !== 0 ? { kind: 'invert' } : null;
    case 44: {
      const direction = int(component, 0, 0);
      return direction === 0 || direction === 1 ? { kind: 'fast-brightness', direction } : null;
    }
    default:
      return null;
  }
}

function normalizedApe(value:string|null):string{return(value??'').trim().toLowerCase();}

function brightnessMultiplier(setting: number): number {
  return Math.trunc((1 + (setting < 0 ? 1 : 16) * (setting / 4096)) * 65_536);
}

function int(component: AvsComponent, offset: number, fallback: number): number {
  if (offset + 4 > component.payload.byteLength) return fallback;
  return new DataView(
    component.payload.buffer, component.payload.byteOffset, component.payload.byteLength,
  ).getInt32(offset, true);
}
