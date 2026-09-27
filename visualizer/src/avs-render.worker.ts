import { AvsCompatibilityRuntime, createAvsCompatibilityRegistry, parseAvsPreset, type AvsPresetAst } from './avs/index.ts';
import { loadBundledAvsBitmapResolver } from './avs/bundled-bitmaps.ts';
import { createAvsBitmapResolver } from './avs/effects/bitmap-assets.ts';
import { copyAvsPixelsToRgba } from './avs-presentation.ts';
import { PackedAvsGpuFrameGraph, type PackedAvsGpuPass } from './avs/gpu-frame-graph.ts';
import { planTerminalExactGpuPasses, type AvsTerminalGpuPlan } from './avs/gpu-preset-plan.ts';
import { planTerminalEnhancedSuperScope, type AvsTerminalEnhancedSuperScopePlan } from './avs/superscope-gpu-plan.ts';
import { EnhancedSuperScopeGpuTerminalPass } from './avs/effects/superscope-gpu.ts';
import { ExactAvsConvolutionGpuPass } from './avs/effects/convolution-gpu.ts';
import { planTerminalExactGpuConvolutions, type AvsTerminalGpuConvolutionPlan } from './avs/convolution-gpu-plan.ts';
import { planTerminalEnhancedDynamicMovement, type AvsTerminalEnhancedDynamicMovementPlan } from './avs/dynamic-movement-gpu-plan.ts';
import { AvsDynamicMovementGpuMapGenerator, EnhancedDynamicMovementGpuPass } from './avs/effects/dynamic-movement-gpu.ts';
import {
  EnhancedDynamicMovementResidentGpuPass, EnhancedDynamicMovementResidentState,
} from './avs/effects/dynamic-movement-eel-gpu.ts';
import { planTerminalEnhancedMovementEel, type AvsTerminalEnhancedMovementEelPlan } from './avs/movement-eel-gpu-plan.ts';
import { EnhancedMovementEelGpuPass, EnhancedMovementEelGpuState } from './avs/effects/movement-eel-gpu.ts';
import type { AvsFrameGraphLane, AvsFrameGraphTiming } from './avs/gpu-frame-graph.ts';
import type { AvsWorkerFrameMessage, AvsWorkerRequest, AvsWorkerResponse } from './avs-worker-protocol.ts';
import { constructOwned } from './owned-resources.ts';

/**
 * GPU observability fields carried on the 'frame' message. Defined here as an
 * optional extension so older clients simply ignore them.
 */
export interface AvsWorkerFrameGpuTelemetry {
  /** Rolling-average GPU time of the node chain plus terminal pass (timestamp-query only). */
  readonly gpuMs?: number;
  /**
   * Worker frame start to GPU queue completion for the most recently completed
   * frame. Excludes the postMessage hop and the main-thread drawImage.
   */
  readonly gpuLatencyMs?: number;
  /** Most recent device-lost reason or uncaptured GPU error, for the HUD. */
  readonly gpuError?: string;
}

export type AvsWorkerFrameMessageWithTelemetry = AvsWorkerFrameMessage & AvsWorkerFrameGpuTelemetry;

interface WorkerScope {
  onmessage: ((event: MessageEvent<AvsWorkerRequest>) => void) | null;
  postMessage(message: AvsWorkerResponse | AvsWorkerFrameMessageWithTelemetry, transfer?: Transferable[]): void;
}

/** After this many device losses the worker stays on the exact CPU presenter. */
const MAX_GPU_DEVICE_LOSSES = 3;

const scope = globalThis as unknown as WorkerScope;
let runtime: AvsCompatibilityRuntime | null = null;
let generation = 0;
let surface: OffscreenCanvas | null = null;
let context: OffscreenCanvasRenderingContext2D | null = null;
let image: ImageData | null = null;
let imageWords: Uint32Array | null = null;
let gpuGraph: PackedAvsGpuFrameGraph | null = null;
let originalPreset: AvsPresetAst | null = null;
let gpuPlan: AvsTerminalGpuPlan | null = null;
let gpuPasses: readonly PackedAvsGpuPass[] = [];
let convolutionPlan: AvsTerminalGpuConvolutionPlan | null = null;
let enhancedPlan: AvsTerminalEnhancedSuperScopePlan | null = null;
let enhancedPass: EnhancedSuperScopeGpuTerminalPass | null = null;
let dynamicMovementPlan: AvsTerminalEnhancedDynamicMovementPlan | null = null;
let dynamicMovementPass: EnhancedDynamicMovementGpuPass | EnhancedDynamicMovementResidentGpuPass | null = null;
let dynamicMovementGenerator: AvsDynamicMovementGpuMapGenerator | null = null;
let dynamicMovementResidentState: EnhancedDynamicMovementResidentState | null = null;
let movementEelPlan: AvsTerminalEnhancedMovementEelPlan | null = null;
let movementEelPass: EnhancedMovementEelGpuPass | null = null;
let gpuLane: AvsFrameGraphLane = 'exact';
let gpuDeviceLosses = 0;
let gpuDeviceLost = false;
let gpuError: string | undefined;
let gpuLatencyMs: number | undefined;
let frameStarted = 0;
/** Graph frame number -> worker frame start, until that frame's queue completes. */
const pendingFrameStarts = new Map<number, number>();

scope.onmessage = (event) => {
  void handle(event.data).catch((error: unknown) => {
    scope.postMessage({
      type: 'error', generation,
      message: error instanceof Error ? error.message : String(error),
      fatal: true,
    });
  });
};

async function handle(message: AvsWorkerRequest): Promise<void> {
  if (message.type === 'clear') {
    generation = message.generation;
    runtime = null;
    originalPreset = null;
    gpuPlan = null;
    // The device, context and surface outlive presets: the next load resizes
    // them in place instead of paying for a new adapter and device.
    releaseExactGpuPasses();
    convolutionPlan = null;
    enhancedPlan = null;
    enhancedPass?.destroy();
    enhancedPass = null;
    dynamicMovementPass?.destroy(); dynamicMovementPass = null; dynamicMovementPlan = null; dynamicMovementGenerator = null; dynamicMovementResidentState = null;
    movementEelPass?.destroy(); movementEelPass = null; movementEelPlan = null;
    return;
  }
  if (message.type === 'load') {
    generation = message.generation;
    const resolver = await loadBundledAvsBitmapResolver();
    if (generation !== message.generation) return;
    const local = message.bitmaps?.length ? createAvsBitmapResolver(new Map(message.bitmaps.map(asset => [asset.name, new Uint8Array(asset.bytes)]))) : null;
    const registry = createAvsCompatibilityRegistry({}, { bitmapResolver: local ? name => local(name) ?? resolver(name) : resolver });
    originalPreset = parseAvsPreset(message.preset);
    gpuLane = message.gpuLane;
    await ensureSurface(message.width, message.height, gpuLane);
    dynamicMovementPlan = gpuGraph && gpuLane === '120' ? planTerminalEnhancedDynamicMovement(originalPreset) : null;
    dynamicMovementGenerator = null;
    dynamicMovementResidentState = null;
    const dynamicInput = dynamicMovementPlan?.component ? dynamicMovementPlan.cpuPreset : originalPreset;
    enhancedPlan = gpuGraph && gpuLane === '120' ? planTerminalEnhancedSuperScope(dynamicInput) : null;
    const exactInput = enhancedPlan?.component ? enhancedPlan.cpuPreset : dynamicInput;
    movementEelPlan = gpuGraph && gpuLane === '120' ? planTerminalEnhancedMovementEel(exactInput) : null;
    const exactGpuInput = movementEelPlan?.component ? movementEelPlan.cpuPreset : exactInput;
    gpuPlan = gpuGraph ? planTerminalExactGpuPasses(exactGpuInput) : {
      cpuPreset: originalPreset, passes: [], blurPasses: [], extractedComponents: 0,
      fusedPointwiseOperations: 0, movementPasses: 0, rotoBlitterPasses: 0, blitterFeedbackPasses: 0, reason: 'WebGPU unavailable; exact CPU fallback',
    };
    convolutionPlan = gpuGraph ? planTerminalExactGpuConvolutions(gpuPlan.cpuPreset) : null;
    runtime = new AvsCompatibilityRuntime(convolutionPlan?.cpuPreset ?? gpuPlan.cpuPreset, message.width, message.height, registry);
    compileGpuPasses();
    const warmup = runtime.render(undefined, true);
    movementEelPass?.prepare();
    if (generation !== message.generation) return;
    scope.postMessage({ type: 'ready', generation, unsupported: warmup.stats.unsupported, preset: originalPreset });
    return;
  }
  if (message.type === 'controls') {
    if (message.generation !== generation || !runtime) return;
    // Terminal GPU extraction changes component ordering when any extracted
    // leaf is bypassed. Rebuild the exact full CPU graph under live controls.
    if (message.controls.length > 0 && ((gpuPlan?.extractedComponents ?? 0) > 0 || (convolutionPlan?.extractedComponents ?? 0) > 0 || enhancedPlan?.component || dynamicMovementPlan?.component || movementEelPlan?.component) && originalPreset) {
      const controls = message.controls;
      releaseExactGpuPasses();
      enhancedPass?.destroy();
      enhancedPass = null;
      enhancedPlan = null;
      dynamicMovementPass?.destroy(); dynamicMovementPass = null; dynamicMovementPlan = null; dynamicMovementGenerator = null; dynamicMovementResidentState = null;
      movementEelPass?.destroy(); movementEelPass = null; movementEelPlan = null;
      convolutionPlan = null;
      runtime = new AvsCompatibilityRuntime(originalPreset, runtime.framebuffer.width, runtime.framebuffer.height, runtime.registry);
      runtime.setControls(controls);
      gpuPlan = {
        cpuPreset: originalPreset, passes: [], blurPasses: [], extractedComponents: 0,
        fusedPointwiseOperations: 0, movementPasses: 0, rotoBlitterPasses: 0, blitterFeedbackPasses: 0, reason: 'component controls require exact CPU graph',
      };
      gpuPasses = [];
    } else {
      runtime.setControls(message.controls);
    }
    scope.postMessage({ type: 'controls-applied', generation, revision: message.revision });
    return;
  }
  if (message.generation !== generation || !runtime) {
    // Always return ownership of the audio buffer so the client's small buffer
    // pool cannot be stranded by a superseded preset.
    const blank = new OffscreenCanvas(1, 1).transferToImageBitmap();
    scope.postMessage({
      type: 'frame', generation: message.generation, sequence: message.sequence,
      pcm: message.pcm, bitmap: blank, width: 1, height: 1,
      unsupported: 0, renderMs: 0,
    }, [message.pcm, blank]);
    return;
  }

  const started = performance.now();
  frameStarted = started;
  runtime.resize(message.width, message.height);
  await ensureSurface(message.width, message.height, gpuLane);
  const expectedGpuPasses = expectedExactGpuPasses() + (movementEelPlan?.component ? 1 : 0) + (enhancedPlan?.component ? 1 : 0) + (dynamicMovementPlan?.component ? 1 : 0);
  if (gpuGraph && gpuPlan && gpuPasses.length !== expectedGpuPasses) {
    compileGpuPasses();
  } else if (!gpuGraph && ((gpuPlan?.extractedComponents ?? 0) > 0 || (convolutionPlan?.extractedComponents ?? 0) > 0 || enhancedPlan?.component || dynamicMovementPlan?.component || movementEelPlan?.component) && originalPreset) {
    // Resizing already resets compatibility state, so rebuilding the runtime
    // here preserves exact semantics without a GPU readback dependency.
    enhancedPass?.destroy();
    enhancedPass = null;
    enhancedPlan = null;
    dynamicMovementPass?.destroy(); dynamicMovementPass = null; dynamicMovementPlan = null; dynamicMovementGenerator = null; dynamicMovementResidentState = null;
    movementEelPass?.destroy(); movementEelPass = null; movementEelPlan = null;
    convolutionPlan = null;
    runtime = new AvsCompatibilityRuntime(originalPreset, message.width, message.height, runtime.registry);
    gpuPlan = {
      cpuPreset: originalPreset, passes: [], blurPasses: [], extractedComponents: 0,
      fusedPointwiseOperations: 0, movementPasses: 0, rotoBlitterPasses: 0, blitterFeedbackPasses: 0, reason: 'WebGPU unavailable; exact CPU fallback',
    };
    gpuPasses = [];
  }
  const pcm = new Float32Array(message.pcm);
  const effectStarted = performance.now();
  const audio = runtime.pcmAudio.analyse({ left: pcm.subarray(0, 576), right: pcm.subarray(576) });
  let frame = runtime.render(audio);
  if (movementEelPass) {
    try { movementEelPass.update(audio); }
    catch (error) { disableEnhancedMovementEel(error instanceof Error ? error.message : String(error)); frame = runtime.render(audio); }
  }
  if (enhancedPass) {
    try {
      enhancedPass.updateFrame(audio, message.width, message.height);
    } catch (error) {
      // Fail closed: replay this same analysed frame through the full classic
      // graph. The enhanced pass never leaves a partial CPU framebuffer.
      disableEnhancedSuperScope(error instanceof Error ? error.message : String(error));
      frame = runtime.render(audio);
    }
  }
  if (dynamicMovementPass) {
    try { dynamicMovementPass.update(audio); }
    catch (error) { disableEnhancedDynamicMovement(error instanceof Error ? error.message : String(error)); frame = runtime.render(audio); }
  }
  const effectMs = performance.now() - effectStarted;
  let presenter: 'webgpu-exact' | 'webgpu-enhanced' | 'cpu-image-data';
  let uploadMs = 0;
  let encodeSubmitMs = 0;
  if (gpuGraph) {
    const timing = gpuGraph.uploadExecuteAndPresent(frame.framebuffer.pixels, gpuPasses);
    uploadMs = timing.uploadMs;
    encodeSubmitMs = timing.encodeSubmitMs;
    presenter = enhancedPass || dynamicMovementPass || movementEelPass ? 'webgpu-enhanced' : 'webgpu-exact';
  } else {
    copyAvsPixelsToRgba(frame.framebuffer.pixels, image!.data, imageWords!);
    context!.putImageData(image!, 0, 0);
    presenter = 'cpu-image-data';
  }
  const bitmap = surface!.transferToImageBitmap();
  const renderMs = performance.now() - started;
  scope.postMessage({
    type: 'frame', generation, sequence: message.sequence, pcm: message.pcm,
    bitmap, width: frame.framebuffer.width, height: frame.framebuffer.height,
    unsupported: frame.stats.unsupported, renderMs,
    effectMs, presenter, uploadMs, encodeSubmitMs,
    gpuEffectPasses: reportedGpuEffectPasses(),
    gpuEffectComponents: (gpuPlan?.extractedComponents ?? 0) + (convolutionPlan?.extractedComponents ?? 0) + (movementEelPass ? 1 : 0) + (enhancedPass ? 1 : 0) + (dynamicMovementPass ? 1 : 0),
    gpuFusedPointwiseOperations: gpuPlan?.fusedPointwiseOperations ?? 0,
    gpuEffectPlan: combinedGpuPlanReason(),
    gpuEnhancedSuperScope: enhancedPass !== null,
    gpuEnhancedDynamicMovement: dynamicMovementPass !== null,
    gpuEnhancedDynamicMovementResidentMap: dynamicMovementPass instanceof EnhancedDynamicMovementResidentGpuPass,
    gpuEnhancedMovementEel: movementEelPass !== null,
    gpuMs: gpuGraph?.gpuMs, gpuLatencyMs: gpuGraph ? gpuLatencyMs : undefined, gpuError,
  }, [message.pcm, bitmap]);
}

async function ensureSurface(width: number, height: number, lane: AvsFrameGraphLane): Promise<void> {
  if (!gpuDeviceLost && surface?.width === width && surface.height === height && (!gpuGraph || gpuGraph.lane === lane)) return;
  releaseExactGpuPasses();
  enhancedPass?.destroy();
  enhancedPass = null;
  dynamicMovementPass?.destroy(); dynamicMovementPass = null;
  movementEelPass?.destroy(); movementEelPass = null;
  if (gpuGraph && !gpuDeviceLost) {
    // Keep the adapter, device and context; only the size-baked resources are
    // rebuilt. The caller recompiles passes because gpuPasses is now empty.
    try {
      gpuGraph.resize(width, height, lane);
      return;
    } catch {
      // Fall through to a full rebuild, e.g. a size over the adapter limit.
    }
  }
  gpuGraph?.destroy();
  gpuGraph = null;
  gpuDeviceLost = false;
  pendingFrameStarts.clear();
  gpuLatencyMs = undefined;
  surface = new OffscreenCanvas(width, height);
  context = null;
  image = null;
  imageWords = null;
  if (gpuDeviceLosses < MAX_GPU_DEVICE_LOSSES) {
    try {
      gpuGraph = await PackedAvsGpuFrameGraph.create({
        canvas: surface, width, height, lane, timestamps: true,
        onTiming: recordGpuTiming,
        onDeviceLost: (reason) => {
          gpuDeviceLosses++;
          gpuDeviceLost = true;
          gpuError = `WebGPU device lost (${gpuDeviceLosses}/${MAX_GPU_DEVICE_LOSSES}): ${reason}`;
        },
        onUncapturedError: (errorMessage) => { gpuError = `WebGPU error: ${errorMessage}`; },
      });
    } catch {
      // A context that failed after configure cannot be switched to 2D. Discard
      // it so the exact CPU presentation lane remains available.
      gpuGraph = null;
      surface = new OffscreenCanvas(width, height);
    }
  }
  if (!gpuGraph) {
    context = surface.getContext('2d', { alpha: false });
    if (!context) throw new Error('Neither WebGPU nor OffscreenCanvas 2D presentation is available');
    image = new ImageData(width, height);
    imageWords = new Uint32Array(image.data.buffer, image.data.byteOffset, width * height);
  }
}

/**
 * Frees the buffers of graph-compiled exact passes before they are dropped.
 * The external enhanced passes are destroyed through their own references.
 */
function releaseExactGpuPasses(): void {
  for (const pass of gpuPasses) {
    if (pass !== enhancedPass && pass !== dynamicMovementPass && pass !== movementEelPass) pass.destroy?.();
  }
  gpuPasses = [];
}

/** Synchronous call after submit records the start; the async one closes it. */
function recordGpuTiming(timing: AvsFrameGraphTiming): void {
  if (timing.gpuCompleteMs === undefined) {
    pendingFrameStarts.set(timing.frame, frameStarted);
    // Completions arrive in order; anything this old was dropped by a lost device.
    if (pendingFrameStarts.size > 8) pendingFrameStarts.delete(pendingFrameStarts.keys().next().value!);
    return;
  }
  const started = pendingFrameStarts.get(timing.frame);
  if (started === undefined) return;
  pendingFrameStarts.delete(timing.frame);
  gpuLatencyMs = performance.now() - started;
}

function compileGpuPasses(): void {
  // The device now outlives recompiles, so free the replaced exact passes
  // explicitly. Must run before the external passes below are nulled.
  releaseExactGpuPasses();
  enhancedPass?.destroy();
  enhancedPass = null;
  dynamicMovementPass?.destroy(); dynamicMovementPass = null;
  movementEelPass?.destroy(); movementEelPass = null;
  if (!gpuGraph || !gpuPlan || !runtime) { gpuPasses = []; return; }
  let passes: PackedAvsGpuPass[];
  try {
    passes = compileConvolutionAndExactPasses();
    // Publish ownership before optional passes can fail and trigger fallback.
    gpuPasses = passes;
  } catch (error) {
    disableGpuConvolution(error instanceof Error ? error.message : String(error));
    return;
  }
  const movementPlan = movementEelPlan;
  if (movementPlan?.component && movementPlan.config && movementPlan.program) {
    try {
      const compiled = gpuGraph.compileExternalPass(device => new EnhancedMovementEelGpuPass(
        device, new EnhancedMovementEelGpuState(movementPlan.config!, movementPlan.program!, runtime!.registry.eelGlobal),
        runtime!.framebuffer.width, runtime!.framebuffer.height,
      ));
      if (!(compiled instanceof EnhancedMovementEelGpuPass)) { compiled.destroy?.(); throw new TypeError('Custom Movement EEL pass factory returned an unexpected pass'); }
      movementEelPass = compiled; passes.push(compiled);
    } catch (error) {
      disableEnhancedMovementEel(error instanceof Error ? error.message : String(error));
      return;
    }
  }
  const plan = enhancedPlan;
  if (plan?.component && plan.config && plan.program) {
    try {
      const compiled = gpuGraph.compileExternalPass(device => new EnhancedSuperScopeGpuTerminalPass(
        device, plan.config!, plan.program!, runtime!.registry.eelGlobal, hashPath(plan.component!.path),
      ));
      if (!(compiled instanceof EnhancedSuperScopeGpuTerminalPass)) {
        compiled.destroy?.();
        throw new TypeError('Enhanced SuperScope pass factory returned an unexpected pass');
      }
      enhancedPass = compiled;
      passes.push(compiled);
    } catch (error) {
      disableEnhancedSuperScope(error instanceof Error ? error.message : String(error));
      return;
    }
  }
  const dynamicPlan = dynamicMovementPlan;
  if (dynamicPlan?.component && dynamicPlan.config) {
    try {
      const compiled = dynamicPlan.residentProgram
        ? gpuGraph.compileExternalPass(device => {
          const state = dynamicMovementResidentState ?? new EnhancedDynamicMovementResidentState(
            dynamicPlan.config!, dynamicPlan.residentProgram!, runtime!.registry.eelGlobal, hashPath(dynamicPlan.component!.path),
          );
          dynamicMovementResidentState = state;
          return new EnhancedDynamicMovementResidentGpuPass(device, state, runtime!.framebuffer.width, runtime!.framebuffer.height);
        })
        : gpuGraph.compileExternalPass(device => {
          const generator = dynamicMovementGenerator ?? new AvsDynamicMovementGpuMapGenerator(
            dynamicPlan.config!, runtime!.registry.eelGlobal, hashPath(dynamicPlan.component!.path),
          );
          dynamicMovementGenerator = generator;
          return new EnhancedDynamicMovementGpuPass(device, generator, runtime!.framebuffer.width, runtime!.framebuffer.height);
        });
      if (!(compiled instanceof EnhancedDynamicMovementGpuPass) && !(compiled instanceof EnhancedDynamicMovementResidentGpuPass)) {
        compiled.destroy?.();
        throw new TypeError('Dynamic Movement pass factory returned an unexpected pass');
      }
      dynamicMovementPass = compiled; passes.push(compiled);
    } catch (error) {
      disableEnhancedDynamicMovement(error instanceof Error ? error.message : String(error));
      return;
    }
  }
  gpuPasses = passes;
}

function disableEnhancedMovementEel(reason: string): void {
  releaseExactGpuPasses();
  movementEelPass?.destroy(); movementEelPass = null; movementEelPlan = null;
  enhancedPass?.destroy(); enhancedPass = null; enhancedPlan = null;
  dynamicMovementPass?.destroy(); dynamicMovementPass = null; dynamicMovementPlan = null; dynamicMovementGenerator = null; dynamicMovementResidentState = null;
  convolutionPlan = null;
  if (!originalPreset || !runtime) { gpuPasses = []; return; }
  runtime = new AvsCompatibilityRuntime(originalPreset, runtime.framebuffer.width, runtime.framebuffer.height, runtime.registry);
  gpuPlan = { cpuPreset: originalPreset, passes: [], blurPasses: [], extractedComponents: 0,
    fusedPointwiseOperations: 0, movementPasses: 0, rotoBlitterPasses: 0, blitterFeedbackPasses: 0,
    reason: `enhanced custom Movement EEL failed closed: ${reason}` };
  gpuPasses = [];
}

function disableEnhancedDynamicMovement(reason: string): void {
  releaseExactGpuPasses();
  dynamicMovementPass?.destroy(); dynamicMovementPass = null; dynamicMovementPlan = null; dynamicMovementGenerator = null; dynamicMovementResidentState = null;
  movementEelPass?.destroy(); movementEelPass = null; movementEelPlan = null;
  enhancedPass?.destroy(); enhancedPass = null; enhancedPlan = null; convolutionPlan = null;
  if (!originalPreset || !runtime) { gpuPasses = []; return; }
  runtime = new AvsCompatibilityRuntime(originalPreset, runtime.framebuffer.width, runtime.framebuffer.height, runtime.registry);
  gpuPlan = { cpuPreset: originalPreset, passes: [], blurPasses: [], extractedComponents: 0,
    fusedPointwiseOperations: 0, movementPasses: 0, rotoBlitterPasses: 0, blitterFeedbackPasses: 0,
    reason: `enhanced Dynamic Movement failed closed: ${reason}` };
  gpuPasses = [];
}

function disableEnhancedSuperScope(reason: string): void {
  releaseExactGpuPasses();
  enhancedPass?.destroy();
  enhancedPass = null;
  enhancedPlan = null;
  dynamicMovementPass?.destroy(); dynamicMovementPass = null; dynamicMovementPlan = null; dynamicMovementGenerator = null; dynamicMovementResidentState = null;
  movementEelPass?.destroy(); movementEelPass = null; movementEelPlan = null;
  if (!originalPreset || !runtime) { gpuPasses = []; return; }
  const width = runtime.framebuffer.width;
  const height = runtime.framebuffer.height;
  gpuPlan = gpuGraph ? planTerminalExactGpuPasses(originalPreset) : {
    cpuPreset: originalPreset, passes: [], blurPasses: [], extractedComponents: 0,
    fusedPointwiseOperations: 0, movementPasses: 0, rotoBlitterPasses: 0, blitterFeedbackPasses: 0, reason: 'WebGPU unavailable; exact CPU fallback',
  };
  convolutionPlan = gpuGraph ? planTerminalExactGpuConvolutions(gpuPlan.cpuPreset) : null;
  runtime = new AvsCompatibilityRuntime(convolutionPlan?.cpuPreset ?? gpuPlan.cpuPreset, width, height, runtime.registry);
  gpuPasses = gpuGraph ? compileConvolutionAndExactPasses() : [];
  enhancedPlan = {
    cpuPreset: originalPreset, component: null, config: null, program: null,
    reason: `enhanced SuperScope failed closed: ${reason}`,
  };
}

function disableGpuConvolution(reason: string): void {
  releaseExactGpuPasses();
  convolutionPlan = null;
  enhancedPass?.destroy(); enhancedPass = null; enhancedPlan = null;
  dynamicMovementPass?.destroy(); dynamicMovementPass = null; dynamicMovementPlan = null; dynamicMovementGenerator = null; dynamicMovementResidentState = null;
  movementEelPass?.destroy(); movementEelPass = null; movementEelPlan = null;
  if (!originalPreset || !runtime) { gpuPasses = []; return; }
  runtime = new AvsCompatibilityRuntime(originalPreset, runtime.framebuffer.width, runtime.framebuffer.height, runtime.registry);
  gpuPlan = { cpuPreset: originalPreset, passes: [], blurPasses: [], extractedComponents: 0,
    fusedPointwiseOperations: 0, movementPasses: 0, rotoBlitterPasses: 0, blitterFeedbackPasses: 0,
    reason: `GPU convolution failed closed: ${reason}` };
  gpuPasses = [];
}

function combinedGpuPlanReason(): string {
  const fused = fusedConvolutionPointwiseOperations();
  const reasons = [convolutionPlan?.configs.length ? convolutionPlan.reason : '', fused ? `${fused} pointwise operation${fused === 1 ? '' : 's'} fused into final convolution write` : '', gpuPlan?.reason ?? '', movementEelPass ? movementEelPlan?.reason ?? '' : '', enhancedPass ? enhancedPlan?.reason ?? '' : '', dynamicMovementPass ? dynamicMovementPlan?.reason ?? '' : ''].filter(Boolean);
  return reasons.join('; ') || enhancedPlan?.reason || convolutionPlan?.reason || 'exact CPU fallback';
}

function fusedConvolutionPointwiseOperations(): number {
  if (!(convolutionPlan?.configs.length) || gpuPlan?.passes[0]?.kind !== 'pointwise') return 0;
  return gpuPlan.passes[0].operations.length;
}

function expectedExactGpuPasses(): number {
  return (convolutionPlan?.configs.length ?? 0) + (gpuPlan?.passes.length ?? 0) - (fusedConvolutionPointwiseOperations() ? 1 : 0);
}

/** Logical frame-graph nodes plus internal compute passes hidden by external nodes. */
function reportedGpuEffectPasses(): number {
  return gpuPasses.length
    + (movementEelPass ? Math.max(0, movementEelPass.lastEncodedPasses - 1) : 0)
    + (dynamicMovementPass instanceof EnhancedDynamicMovementResidentGpuPass ? 1 : 0);
}

function compileConvolutionAndExactPasses(): PackedAvsGpuPass[] {
  if (!gpuGraph || !gpuPlan || !runtime) return [];
  const configs = convolutionPlan?.configs ?? [];
  const first = gpuPlan.passes[0];
  const fused = configs.length && first?.kind === 'pointwise' ? first.operations : [];
  const factories: (() => PackedAvsGpuPass)[] = configs.map((config, index) => () => gpuGraph!.compileExternalPass(device => new ExactAvsConvolutionGpuPass(
    device, config, runtime!.framebuffer.width, runtime!.framebuffer.height, false,
    index + 1 === configs.length ? fused : [],
  )));
  const remaining = fused.length ? gpuPlan.passes.slice(1) : gpuPlan.passes;
  factories.push(...remaining.map(config => () => gpuGraph!.compileExactPass(config)));
  return constructOwned(factories);
}

function hashPath(path: string): number {
  let hash = 0x811c9dc5;
  for (let index = 0; index < path.length; index++) hash = Math.imul(hash ^ path.charCodeAt(index), 0x01000193);
  return hash >>> 0;
}
