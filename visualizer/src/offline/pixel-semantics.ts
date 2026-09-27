/**
 * The offline lane's AVS frame semantics, versioned and recorded in the
 * manifest as determinism.pixel_semantics. Dependency-free so the manifest
 * writer can import it without pulling the AVS runtime into the page bundle;
 * src/offline/avs-cue.ts implements it.
 *
 * Version history:
 *   1  cue start = construct only; Custom BPM arbitrary mode read the wall
 *      clock (nondeterministic for those presets). PCM decimation used
 *      `start + trunc(i * available / 576)`.
 *   2  cue start = construct + one preinit frame with silent audio, exactly
 *      like the live worker's load; Custom BPM reads the output frame's
 *      timestamp. PCM decimation adopted the live fillAvsPcm convention,
 *      which is index-identical for every nonempty interval, and offline
 *      intervals are never empty, so that part changed no byte.
 * Version 2 changes offline pixels (and so PNG and RGB24 hashes) for presets
 * whose preinit frame draws into the feedback buffer or advances effect state
 * (6 of the 124 bundled presets on a 12-frame synthetic scan, e.g. UnConeD -
 * Mister Santa, Duo - Brainstorm), and for Custom BPM arbitrary-interval
 * presets, whose v1 output depended on wall-clock render speed. It makes a frozen-PCM offline
 * render of one cue bit-identical to the live CPU path fed the same PCM and
 * the same seeded registry (tools/offline-live-parity-check.ts).
 */
export const OFFLINE_PIXEL_SEMANTICS_VERSION = 2;

export interface OfflinePixelSemantics {
  readonly version: number;
  readonly pcm_window: string;
  readonly cue_start: string;
  readonly randomness: string;
  readonly custom_bpm_clock: string;
}

export const OFFLINE_PIXEL_SEMANTICS: OfflinePixelSemantics = Object.freeze({
  version: OFFLINE_PIXEL_SEMANTICS_VERSION,
  pcm_window: 'avs-576 trunc(i*frames/576) over the output frame interval (live fillAvsPcm convention)',
  cue_start: 'preinit frame with silent audio, as the live worker load',
  randomness: 'xorshift32 per cue seed; reseeded at every cue by design',
  custom_bpm_clock: 'output frame timestamp in ms (frame*1000*fps_den/fps_num)',
});
