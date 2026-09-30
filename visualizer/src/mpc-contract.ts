/** Stored-value ranges shared by TypeScript, the Player server and native code.
 * The Player server (tools/standalone-library.mjs) and the C++ sources cannot import this file;
 * tools/check-mpc-contract.mjs and tools/check-aaavs-settings-contract.mjs compare their literals with it.
 * No imports: every module, worker and check may depend on it. See docs/design/CONTRACT.md 2.1. */
export const TRANSITION_COUNT = 33;                 // stored transition index 0..32
export const TRANSITION_CUT = 15, TRANSITION_RANDOM_ALL = 31, TRANSITION_SMART = 32;
export const FADE_TIMING_COUNT = 7;                 // 0 seconds, 1 instant, 2 beat1, 3 beat2, 4 bar1, 5 bar2, 6 random
export const FADE_RANDOM_SET_MIN = 1, FADE_RANDOM_SET_ALL = 31;   // bit0 instant, bit1 beat1, bit2 beat2, bit3 bar1, bit4 bar2
export const FADE_ANCHOR_COUNT = 3;                 // 0 start, 1 end, 2 hit
export const QUEUE_QUANTIZE_COUNT = 4;              // 0 immediate, 1 beat, 2 bar, 3 phrase
export const DURATION_MS_MIN = 250, DURATION_MS_MAX = 8000, DURATION_MS_DEFAULT = 2000;
export const LEGACY_BEATS = [0, 1, 2, 4] as const;
export const FADE_FROM_BEATS: Readonly<Record<number, number>> = { 0: 0, 1: 2, 2: 3, 4: 4 };
export const BEATS_FROM_FADE: readonly number[] = [0, 0, 1, 2, 4, 0, 0];      // indexed by fadeTiming; instant, 2 bars, random project to 0
export const QUALITY_COUNT = 5, AVS_RESOLUTION_COUNT = 3, PIXEL_ART_COUNT = 3, SHOW_FPS_COUNT = 3, TIMING_OVERLAY_COUNT = 2;
export const DISPLAY_STORAGE_KEY = 'aaavs.mpcDisplay.v1';
export const STATE_NAMES = ['folders', 'stats'] as const;
export const STATE_MAX_BYTES = 3670016;             // 3.5 MiB; below the 4 MiB library request cap
export const AUDIO_DURATION_MAX = 86400;
