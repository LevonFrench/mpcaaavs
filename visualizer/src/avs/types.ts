/** Classic Advanced Visualization Studio (AVS) compatibility contracts. */

export const AVS_PRESET_HEADER_V1 = 'Nullsoft AVS Preset 0.1\u001a';
export const AVS_PRESET_HEADER_V2 = 'Nullsoft AVS Preset 0.2\u001a';
export const AVS_AUDIO_SAMPLES = 576;
export const AVS_FFT_SIZE = 512;
export const AVS_FFT_BINS = AVS_FFT_SIZE / 2;

export type AvsPresetVersion = 1 | 2;

export interface AvsEffectListSettings {
  /** The compact legacy mode word exactly as stored in the preset. */
  readonly mode: number;
  readonly enabled: boolean;
  readonly clearEveryFrame: boolean;
  readonly inputBlendMode: number;
  readonly outputBlendMode: number;
  readonly inputBlendValue: number;
  readonly outputBlendValue: number;
  readonly inputBuffer: number;
  readonly outputBuffer: number;
  readonly inputInvert: boolean;
  readonly outputInvert: boolean;
  readonly beatRender: boolean;
  readonly beatRenderFrames: number;
  /** Bytes occupied by the list header before its optional code record/children. */
  readonly byteLength: number;
}

export interface AvsEffectListCode {
  readonly enabled: boolean;
  readonly init: string;
  readonly frame: string;
  /** The complete extension payload is retained for lossless future decoding. */
  readonly raw: Uint8Array;
}

export interface AvsComponent {
  /** Signed renderer id. Effect List is -2; APE renderers generally use a large positive id. */
  readonly effectId: number;
  /** Fixed 32-byte APE renderer identifier, without trailing NULs. */
  readonly apeId: string | null;
  readonly payload: Uint8Array;
  readonly fileOffset: number;
  readonly path: string;
  readonly children: readonly AvsComponent[];
  readonly list: AvsEffectListSettings | null;
  readonly listCode: AvsEffectListCode | null;
}

export interface AvsPresetAst {
  readonly version: AvsPresetVersion;
  readonly header: string;
  readonly clearEveryFrame: boolean;
  readonly components: readonly AvsComponent[];
  readonly byteLength: number;
}

/** Exact byte-domain data passed to an AVS renderer: [left, right][576]. */
export interface AvsAudioFrame {
  readonly waveform: readonly [Uint8Array, Uint8Array];
  readonly spectrum: readonly [Uint8Array, Uint8Array];
  readonly beat: boolean;
  /** Max sum of absolute signed waveform bytes, before thresholding. */
  readonly beatLevel: number;
}
