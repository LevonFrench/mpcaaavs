// Messages of the show render worker (src/show-render.worker.ts), AAAVS.
//
// The worker speaks two dialects:
//  - the show dialect below: load a song map (or none: live fallback), plan the whole show with
//    planShow() and render any song time (the still renderer and a future show player use it);
//  - the NERV preset dialect of src/avs-worker-protocol.ts ('load' with a .nerv preset, 'render' with a
//    NervPlaybackFrame and an AvsAudioFrame), so the MPC host and the shared Player can swap the legacy
//    Canvas2D NERV worker for this engine without changing their clocks (see src/show-host.ts).
import type { SongMapJSON } from '../song-map/types.ts';

export interface ShowParams {
  /** Loaded track, shown on the title and end cards. */
  title?: string;
  artist?: string;
  titleJp?: string;
  /** Optional franchise words (private local overlay only; public defaults stay neutral). */
  unit?: string;
  unitJp?: string;
}

/** Load (or replace) the analysis. `songMap` null: the live fallback (tempo grid + live audio frames). */
export interface ShowInitMessage {
  readonly type: 'show-init';
  readonly generation: number;
  /** URL of the show-assets directory (fonts), absolute or relative to the worker script. */
  readonly assetBase: string;
  readonly songMap: SongMapJSON | null;
  /** SongMapBinary.spec bytes. */
  readonly spec?: ArrayBuffer | null;
  /** SongMapBinary.wave (Float32 interleaved stereo). Absent: synthesized from the analysis (approximate scopes). */
  readonly wave?: ArrayBuffer | null;
  readonly params?: ShowParams;
  /** Live fallback only: media duration and tempo when there is no song map. */
  readonly duration?: number;
  readonly bpm?: number;
  /** Live fallback only: time of any beat (grid phase, default 0) and the PCM rate of the AVS frames (default 44100). */
  readonly firstBeat?: number;
  readonly sampleRate?: number;
  /** Plan the whole show with planShow() (default true when a song map is given). */
  readonly plan?: boolean;
  /** Restrict the plan to these plate ids (faster stills). */
  readonly only?: readonly string[];
  /** Log init progress to the console. */
  readonly verbose?: boolean;
}

export interface ShowRenderMessage {
  readonly type: 'show-render';
  readonly generation: number;
  readonly sequence: number;
  /** Song time in seconds. */
  readonly time: number;
  /** Frame step (default 1/60). */
  readonly dt?: number;
  /** Wait for the GPU before replying (timing runs). */
  readonly sync?: boolean;
}

/**
 * Live fallback only: one AVS audio frame played at media time `time` (the end of its 576-sample window).
 * `waveform` and `spectrum` hold 1152 bytes each: 576 left then 576 right (src/avs/types.ts AvsAudioFrame).
 */
export interface ShowAudioMessage {
  readonly type: 'show-audio';
  readonly generation: number;
  readonly time: number;
  readonly waveform: ArrayBuffer;
  readonly spectrum: ArrayBuffer;
  readonly beat: boolean;
  readonly beatLevel: number;
}

export type ShowWorkerRequest = ShowInitMessage | ShowRenderMessage | ShowAudioMessage;

export interface ShowPlanEntry { readonly id: string; readonly role: string; readonly start: number; readonly end: number; readonly startBar: number; readonly endBar: number }

export interface ShowReadyMessage {
  readonly type: 'show-ready';
  readonly generation: number;
  readonly plan: readonly ShowPlanEntry[];
  readonly duration: number;
  readonly scale: number;
  readonly width: number;
  readonly height: number;
  /** Scene construction errors (a plate that failed renders dark red). */
  readonly errors: readonly string[];
  readonly synthesizedWave: boolean;
  readonly initMs: number;
}

export interface ShowFrameMessage {
  readonly type: 'show-frame';
  readonly generation: number;
  readonly sequence: number;
  readonly bitmap: ImageBitmap;
  readonly width: number;
  readonly height: number;
  readonly renderMs: number;
  /** Plate on screen at this time, or null. */
  readonly plate: string | null;
}

export interface ShowErrorMessage { readonly type: 'show-error'; readonly generation: number; readonly message: string }

export type ShowWorkerResponse = ShowReadyMessage | ShowFrameMessage | ShowErrorMessage;

const finite = (x: unknown): x is number => typeof x === 'number' && Number.isFinite(x);
const PARAM_KEYS = new Set(['title', 'artist', 'titleJp', 'unit', 'unitJp']);

/** Validate a show request (the worker rejects anything else). Returns the message typed. */
export function validateShowRequest(m: unknown): ShowWorkerRequest {
  if (!m || typeof m !== 'object') throw new Error('Invalid show message');
  const x = m as Record<string, unknown>;
  if (!Number.isInteger(x.generation) || (x.generation as number) < 0) throw new Error('Invalid show generation');
  if (x.type === 'show-init') {
    if (typeof x.assetBase !== 'string' || x.assetBase.length > 2048) throw new Error('Invalid show asset base');
    if (x.songMap !== null && (typeof x.songMap !== 'object' || x.songMap === undefined)) throw new Error('Invalid show song map');
    for (const k of ['spec', 'wave'] as const) if (x[k] != null && !(x[k] instanceof ArrayBuffer)) throw new Error(`Invalid show ${k}`);
    if (x.wave instanceof ArrayBuffer && x.wave.byteLength % 8 !== 0) throw new Error('Invalid show wave');
    if (x.params !== undefined) {
      if (!x.params || typeof x.params !== 'object') throw new Error('Invalid show params');
      for (const [k, v] of Object.entries(x.params)) if (!PARAM_KEYS.has(k) || (typeof v !== 'string' || v.length > 200)) throw new Error('Invalid show params');
    }
    if (x.songMap === null && (!finite(x.duration) || (x.duration as number) <= 0 || (x.duration as number) > 6 * 3600 || !finite(x.bpm) || (x.bpm as number) < 20 || (x.bpm as number) > 400)) throw new Error('Invalid live show clock');
    if (x.firstBeat !== undefined && (!finite(x.firstBeat) || Math.abs(x.firstBeat as number) > 6 * 3600)) throw new Error('Invalid live show clock');
    if (x.sampleRate !== undefined && (!finite(x.sampleRate) || (x.sampleRate as number) < 8000 || (x.sampleRate as number) > 384000)) throw new Error('Invalid live show clock');
    if (x.plan !== undefined && typeof x.plan !== 'boolean') throw new Error('Invalid show plan flag');
    if (x.only !== undefined && (!Array.isArray(x.only) || x.only.some((s) => typeof s !== 'string'))) throw new Error('Invalid show plate filter');
    return m as ShowInitMessage;
  }
  if (x.type === 'show-render') {
    if (!Number.isInteger(x.sequence) || !finite(x.time) || (x.time as number) < 0 || (x.time as number) > 6 * 3600) throw new Error('Invalid show clock');
    if (x.dt !== undefined && (!finite(x.dt) || (x.dt as number) <= 0 || (x.dt as number) > 1)) throw new Error('Invalid show clock');
    if (x.sync !== undefined && typeof x.sync !== 'boolean') throw new Error('Invalid show sync flag');
    return m as ShowRenderMessage;
  }
  if (x.type === 'show-audio') {
    if (!finite(x.time) || (x.time as number) < 0 || (x.time as number) > 6 * 3600) throw new Error('Invalid show audio clock');
    for (const k of ['waveform', 'spectrum'] as const) if (!(x[k] instanceof ArrayBuffer) || x[k].byteLength !== 1152) throw new Error(`Invalid show audio ${k}`);
    if (typeof x.beat !== 'boolean' || !finite(x.beatLevel) || (x.beatLevel as number) < 0) throw new Error('Invalid show audio beat');
    return m as ShowAudioMessage;
  }
  throw new Error('Invalid show message type');
}
