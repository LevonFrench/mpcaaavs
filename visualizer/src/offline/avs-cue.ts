import {
  AvsCompatibilityRuntime,
  createAvsCompatibilityRegistry,
  registerAvsBeatParticleEffects,
  type AvsBitmapResolver,
  type AvsEffectRegistry,
  type AvsRuntimeFrame,
} from '../avs/index.ts';
import { fillAvsPcmPlanar } from '../avs/frame-utils.ts';

/**
 * The offline lane's AVS frame semantics (version and history in
 * ./pixel-semantics.ts), factored out of the render worker so the
 * live-vs-offline parity check drives exactly the code the export runs.
 */
export { OFFLINE_PIXEL_SEMANTICS, OFFLINE_PIXEL_SEMANTICS_VERSION } from './pixel-semantics.ts';

/** Mutable frame clock read by Custom BPM's GetTickCount; the driver advances it per output frame. */
export interface OfflineAvsClock {
  nowMs: number;
}

export interface OfflineAvsRegistryOptions {
  readonly bitmapResolver?: AvsBitmapResolver;
  readonly clock: OfflineAvsClock;
}

export function xorshift32(value: number): number {
  let x = value || 0x6d2b79f5;
  x ^= x << 13; x ^= x >>> 17; x ^= x << 5;
  return x >>> 0;
}

/**
 * A registry whose only entropy is `seed`. Offline creates one per cue, so
 * AVS randomness restarts at every cue by design (owner decision 2026-09-26):
 * a cue's runtime renders the same whatever precedes it. (Crossfade frames
 * and opt-in flash limiting still depend on earlier frames, so the worker
 * renders a job serially from frame 0.)
 */
export function createOfflineAvsRegistry(seed: number, options: OfflineAvsRegistryOptions): AvsEffectRegistry {
  let randomState = seed || 0x6d2b79f5;
  const registry = createAvsCompatibilityRegistry({
    randomInt(maximum) {
      randomState = xorshift32(randomState);
      return maximum > 0 ? randomState % maximum : 0;
    },
  }, options.bitmapResolver ? { bitmapResolver: options.bitmapResolver } : {});
  // Only Custom BPM reads the clock; Moving Particle and Starfield keep their
  // default (path-hashed, deterministic) random streams when re-registered.
  const clock = options.clock;
  registerAvsBeatParticleEffects(registry, { now: () => clock.nowMs });
  return registry;
}

/** Output frame timestamp in milliseconds, the offline stand-in for GetTickCount. */
export function offlineFrameTimeMs(frame: number, fpsNum: number, fpsDen: number): number {
  return frame * 1000 * fpsDen / fpsNum;
}

/**
 * Start a cue the way the live worker loads a preset: construct, then one
 * preinit frame with silent audio (never shown). The runtime's framebuffer is
 * exactly `width` x `height`: offline always runs the executor at the output
 * raster, so a larger profile means more AVS pixels, never an upscale.
 */
export function startOfflineAvsCue(
  preset: Uint8Array | ArrayBuffer,
  width: number,
  height: number,
  registry: AvsEffectRegistry,
): AvsCompatibilityRuntime {
  const runtime = new AvsCompatibilityRuntime(
    preset instanceof Uint8Array ? preset : new Uint8Array(preset), width, height, registry,
  );
  runtime.render(undefined, true);
  return runtime;
}

/** Scratch 576-point channels for `renderOfflineAvsFrame`. */
export interface OfflineAvsPcmScratch {
  readonly left: Float32Array;
  readonly right: Float32Array;
}

/** Decimate one output frame interval and render it, as the live worker does per frame. */
export function renderOfflineAvsFrame(
  runtime: AvsCompatibilityRuntime,
  scratch: OfflineAvsPcmScratch,
): AvsRuntimeFrame {
  return runtime.renderPcm({ left: scratch.left, right: scratch.right });
}

/** Fill `scratch` with the AVS window for `[sampleStart, sampleEnd)`. */
export function fillOfflineAvsPcm(
  left: Float32Array,
  right: Float32Array,
  sampleStart: number,
  sampleEnd: number,
  scratch: OfflineAvsPcmScratch,
): void {
  fillAvsPcmPlanar(left, right, sampleStart, sampleEnd, scratch.left, scratch.right);
}
