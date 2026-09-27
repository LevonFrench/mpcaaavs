import { AvsAudioAccumulator, AvsAudioAnalyser, type AvsStereoPcm } from './audio.ts';
import { createAvsCompatibilityRegistry } from './effects/registry.ts';
import {
  AvsExecutor,
  type AvsComponentControl,
  type AvsEffectRegistry,
  type AvsExecutionStats,
  type AvsResolvedComponentControl,
} from './executor.ts';
import { AvsFramebuffer } from './framebuffer.ts';
import { parseAvsPreset } from './preset.ts';
import { AVS_AUDIO_SAMPLES, type AvsAudioFrame, type AvsPresetAst } from './types.ts';

export interface AvsRuntimeFrame {
  readonly framebuffer: AvsFramebuffer;
  readonly stats: AvsExecutionStats;
}

/**
 * High-level imported-preset runtime. It deliberately terminates in packed
 * RGB; an AAAVS renderer can upload the RGBA view after every legacy effect has
 * finished, keeping native HDR enhancements outside the compatibility lane.
 */
export class AvsCompatibilityRuntime {
  readonly preset: AvsPresetAst;
  readonly registry: AvsEffectRegistry;
  readonly executor: AvsExecutor;
  readonly hostAudio = new AvsAudioAccumulator();
  readonly pcmAudio = new AvsAudioAnalyser();
  private surface: AvsFramebuffer;

  constructor(
    preset: AvsPresetAst | ArrayBuffer | Uint8Array,
    width: number,
    height: number,
    registry = createAvsCompatibilityRegistry(),
  ) {
    this.preset = 'components' in preset ? preset : parseAvsPreset(preset);
    this.registry = registry;
    this.executor = new AvsExecutor(this.preset, registry);
    this.surface = new AvsFramebuffer(width, height);
  }

  get framebuffer(): AvsFramebuffer { return this.surface; }
  get controls(): readonly AvsResolvedComponentControl[] { return this.executor.controls; }

  setControls(controls: readonly AvsComponentControl[]): void {
    this.executor.setControls(controls);
  }

  setComponentControl(path: string, control: Omit<AvsComponentControl, 'path'>): void {
    this.executor.setComponentControl(path, control);
  }

  resize(width: number, height: number): void {
    if (this.surface.width === width && this.surface.height === height) return;
    this.surface = new AvsFramebuffer(width, height);
    // AVS releases list/global surfaces when dimensions change. Movement and
    // effect-local caches validate dimensions independently on the next frame.
    this.executor.reset();
  }

  pushHostAudio(
    waveform: readonly [Uint8Array, Uint8Array],
    spectrum: readonly [Uint8Array, Uint8Array],
  ): void { this.hostAudio.push(waveform, spectrum); }

  renderHostFrame(preinit = false): AvsRuntimeFrame {
    return this.render(this.hostAudio.consume(), preinit);
  }

  renderPcm(pcm: AvsStereoPcm, preinit = false): AvsRuntimeFrame {
    return this.render(this.pcmAudio.analyse(pcm), preinit);
  }

  render(audio: AvsAudioFrame = emptyAudio(), preinit = false): AvsRuntimeFrame {
    const stats = this.executor.render(this.surface, audio, preinit);
    return { framebuffer: this.surface, stats };
  }

  /** Browser-ready RGBA8 copy. Packed AVS RGB is B,G,R in byte order on LE. */
  rgbaBytes(alpha = 255): Uint8ClampedArray {
    const rgba = new Uint8ClampedArray(this.surface.pixels.length * 4);
    for (let i = 0; i < this.surface.pixels.length; i++) {
      const pixel = this.surface.pixels[i]!;
      rgba[i * 4] = (pixel >>> 16) & 255;
      rgba[i * 4 + 1] = (pixel >>> 8) & 255;
      rgba[i * 4 + 2] = pixel & 255;
      rgba[i * 4 + 3] = alpha;
    }
    return rgba;
  }

  reset(): void {
    this.executor.reset();
    this.hostAudio.reset();
    this.pcmAudio.reset();
    this.surface.clear();
  }
}

function emptyAudio(): AvsAudioFrame {
  return {
    waveform: [new Uint8Array(AVS_AUDIO_SAMPLES), new Uint8Array(AVS_AUDIO_SAMPLES)],
    spectrum: [new Uint8Array(AVS_AUDIO_SAMPLES), new Uint8Array(AVS_AUDIO_SAMPLES)],
    beat: false, beatLevel: 0,
  };
}
