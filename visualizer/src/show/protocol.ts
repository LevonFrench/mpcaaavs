// Messages of the show render worker (src/show-render.worker.ts), AAAVS.
//
// The worker speaks two dialects:
//  - the show dialect below: load a song map (or none: live fallback), plan the whole show with
//    planShow() and render any song time (the still renderer and a future show player use it);
//  - the NERV preset dialect of src/avs-worker-protocol.ts ('load' with a .nerv preset, 'render' with a
//    NervPlaybackFrame and an AvsAudioFrame), so the MPC host and the shared Player can swap the legacy
//    Canvas2D NERV worker for this engine without changing their clocks (see src/show-host.ts).
import type { SongMapJSON } from '../song-map/types.ts';
import { ASSET_PACK_LIMITS } from '../asset-packs/manifest.ts';
import { ASSET_PACK_TOTAL_BYTES } from '../asset-packs/loader.ts';
import { isPackId } from '../asset-packs/paths.ts';

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

/**
 * The private asset pack plates may draw (docs/design/ASSET-PACK-MANIFEST.md), sent by the host to a worker at any time (the worker
 * stores it in src/show/pack-registry.ts). `generation` is only the host's pack revision (any integer >= 0), not a show generation:
 * a pack message is never dropped for belonging to an old show. `packId: null` clears the pack. Otherwise `manifest` is `pack.json`
 * exactly as read and `atlases` maps each atlas id of the manifest to its PNG bytes; both are transferable copies. The worker validates
 * everything again with the asset-pack loader, so a bad pack leaves plates on their procedural stand-ins.
 */
export interface ShowPackMessage {
  readonly type: 'show-pack';
  readonly generation: number;
  readonly packId: string | null;
  readonly manifest?: ArrayBuffer;
  readonly atlases?: Readonly<Record<string, ArrayBuffer>>;
}

export type ShowWorkerRequest = ShowInitMessage | ShowRenderMessage | ShowAudioMessage | ShowPackMessage;

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
  if (x.type === 'show-pack') return validateShowPack(x);
  throw new Error('Invalid show message type');
}

const ATLAS_ID = /^[a-z0-9][a-z0-9_-]{0,63}$/;
/** Shape and size checks of a `show-pack` message (content is validated by the asset-pack loader in the worker). */
function validateShowPack(x: Record<string, unknown>): ShowPackMessage {
  if (x.packId === null) {
    if (x.manifest !== undefined || x.atlases !== undefined) throw new Error('Invalid show pack: a cleared pack carries no data');
    return x as unknown as ShowPackMessage;
  }
  if (!isPackId(x.packId)) throw new Error('Invalid show pack id');
  if (!(x.manifest instanceof ArrayBuffer) || x.manifest.byteLength < 1 || x.manifest.byteLength > ASSET_PACK_LIMITS.manifestBytes) throw new Error('Invalid show pack manifest');
  const atlases = x.atlases;
  if (!atlases || typeof atlases !== 'object' || Array.isArray(atlases)) throw new Error('Invalid show pack atlases');
  const proto = Object.getPrototypeOf(atlases);
  if (proto !== Object.prototype && proto !== null) throw new Error('Invalid show pack atlases');
  const entries = Object.entries(atlases);
  if (entries.length > ASSET_PACK_LIMITS.atlases) throw new Error('Invalid show pack atlases: too many');
  let total = 0;
  for (const [id, bytes] of entries) {
    if (!ATLAS_ID.test(id) || !(bytes instanceof ArrayBuffer) || bytes.byteLength < 1 || bytes.byteLength > ASSET_PACK_LIMITS.atlasBytes) throw new Error('Invalid show pack atlas');
    total += bytes.byteLength;
  }
  if (total > ASSET_PACK_TOTAL_BYTES) throw new Error('Invalid show pack atlases: over the pack budget');
  return x as unknown as ShowPackMessage;
}
