// The control/projector link.
//
// aaavs runs its show in one window and, when the performer asks for it, its
// OUTPUT in a second one that can be dragged to a projector and fullscreened.
// This file is the only thing the two windows share.
//
// WHY THE RENDERER IS DUPLICATED RATHER THAN THE PICTURE
//
// A `GPUCanvasContext` is bound to the canvas it was configured on, and a
// `GPUDevice` cannot cross a browsing context — neither is structured
// cloneable and neither is transferable. There is no version of "hand the
// projector window the canvas we are already drawing" that the platform
// permits. That leaves exactly two shapes:
//
//   (a) the projector window builds its OWN device and renders the same show
//       from a description of it, or
//   (b) the control window keeps rendering and ships PIXELS across.
//
// (b) sounds cheaper and is not. `canvas.captureStream()` produces a
// `MediaStream`, and a `MediaStream` does not cross a window boundary either
// outside of an experimental Chrome-only transferable `MediaStreamTrack`; the
// portable way to move one is a loopback `RTCPeerConnection`, i.e. a real VP8/
// H.264 encode and decode. That buys a frame or two of latency, 4:2:0 chroma
// subsampling and ringing on exactly the high-contrast hard-edged material an
// AVS preset is made of. Worse, the show is drawn on TWO canvases — the WebGPU
// `#stage` and the 2D `#avs-stage` the compatibility lane presents into — so a
// single `captureStream` would miss half the shipped default and a compositing
// canvas would have to be added just to feed the encoder.
//
// So: (a). The projector window loads `projector-window.ts`, builds its own
// device, and is driven from here. What crosses the wire is a DESCRIPTION —
// the preset, the AVS preset bytes, the live params, and one packed audio
// frame — never a picture. Audio is still analysed exactly once, in the
// control window, because that is where the file and the AudioContext are.
//
// THE PER-FRAME COST
//
// `AudioSnapshot` is not postable as-is: its `spectrogram` alone is
// `SPEC_N * SPECTROGRAM_ROWS` floats — 256 KiB — and `BroadcastChannel` has no
// transfer list, so every send is a structured-clone COPY. But that buffer is a
// ring that gains exactly ONE row per analysis frame (the same fact
// `AudioGpu.uploadSpectrogram` is built on), so the wire carries the newest row
// and the receiver keeps its own ring. Everything else is small. The result is
// one fixed `Float32Array` of `LINK_AUDIO_FLOATS` — 13,536 bytes — reused in
// place every frame, so the sender allocates nothing.

import { SPEC_N, SPECTROGRAM_ROWS, WAVE_N, BAND_NAMES } from './audio.ts';
import { PERCEPTUAL_BAND_COUNT } from './audio-features.ts';
import type { TransitionSpec } from './director.ts';
import type { AvsComponentControl } from './avs/index.ts';
import type { AvsFrameGraphLane } from './avs/gpu-frame-graph.ts';
import type { LayerMixerSnapshot } from './layers.ts';
import type { ShowLayerFields } from './show-state.ts';
import type { AudioSnapshot, BandName, ParamValue, Preset } from './contracts.ts';

/** Same-origin channel name. Both windows open exactly this one. */
export const LINK_CHANNEL_NAME = 'aaavs';

/**
 * Bumped whenever the wire format changes incompatibly.
 *
 * Two windows can hold two different builds — the projector is a long-lived
 * popup and the control window reloads under it during development. A mismatch
 * is dropped rather than misread, because a stale `Float32Array` layout
 * silently produces a plausible wrong picture.
 */
export const LINK_PROTOCOL = 1;

export type LinkRole = 'control' | 'projector';

/** Display-space post parameters. Mirrored so both windows tone-map alike. */
export interface LinkPost {
  readonly bloom: number;
  readonly exposure: number;
  readonly vignette: number;
  readonly grain: number;
}

/** The musical frame the audio snapshot belongs to. Derived once, in control. */
export interface LinkFrameState {
  readonly bpm: number;
  /** Continuous beat position — `timeline.slotAt(t) / SLOTS_PER_BEAT`. */
  readonly beats: number;
  readonly dtBeats: number;
  readonly dtSeconds: number;
  readonly frameIndex: number;
  readonly playing: boolean;
  readonly paused: boolean;
}

// --------------------------------------------------------------- audio frame
//
// One flat `Float32Array`. Named offsets rather than a struct because the
// sender writes it in place and the receiver reads it in place; an object would
// mean an allocation per frame on both sides, sixty times a second.

const HEADER_FLOATS = 32;
const PERCEPTUAL_BANDS_AT = HEADER_FLOATS;
const PERCEPTUAL_FLUX_AT = PERCEPTUAL_BANDS_AT + PERCEPTUAL_BAND_COUNT;
const WAVEFORM_AT = PERCEPTUAL_FLUX_AT + PERCEPTUAL_BAND_COUNT;
const SPECTRUM_AT = WAVEFORM_AT + WAVE_N * 2;
const BAND_PAN_AT = SPECTRUM_AT + SPEC_N * 2;
const PEAKS_AT = BAND_PAN_AT + SPEC_N;
const SPECTROGRAM_LINE_AT = PEAKS_AT + SPEC_N;

/** Where each field lives in the packed frame. Exported for tests and tooling. */
export const LINK_AUDIO_OFFSETS = Object.freeze({
  time: 0,
  level: 1,
  beat: 2,
  pan: 3,
  width: 4,
  crest: 5,
  centroid: 6,
  flatness: 7,
  /** Five public bands, in `BAND_NAMES` order. */
  bands: 8,
  /** The row `audio.ts` will write NEXT. The newest row is this minus one. */
  spectrogramRow: 13,
  bpm: 14,
  beats: 15,
  dtBeats: 16,
  dtSeconds: 17,
  frameIndex: 18,
  bloom: 19,
  exposure: 20,
  vignette: 21,
  grain: 22,
  /** Bit 0 playing, bit 1 paused. */
  flags: 23,
  // 24..31 reserved, so a new scalar does not move the arrays.
  perceptualBands: PERCEPTUAL_BANDS_AT,
  perceptualFlux: PERCEPTUAL_FLUX_AT,
  waveform: WAVEFORM_AT,
  spectrum: SPECTRUM_AT,
  bandPan: BAND_PAN_AT,
  peaks: PEAKS_AT,
  /** The single newest spectrogram row. The ring itself never crosses. */
  spectrogramLine: SPECTROGRAM_LINE_AT,
} as const);

export const LINK_AUDIO_FLOATS = SPECTROGRAM_LINE_AT + SPEC_N;
/** 13,536 bytes at the shipped WAVE_N/SPEC_N. Copied once per frame per peer. */
export const LINK_AUDIO_BYTES = LINK_AUDIO_FLOATS * 4;

const FLAG_PLAYING = 1;
const FLAG_PAUSED = 2;

/** Allocate the sender's reusable frame. One per control window, ever. */
export function createLinkAudioFrame(): Float32Array {
  return new Float32Array(LINK_AUDIO_FLOATS);
}

/**
 * Fill `out` from this frame's snapshot. Writes in place; allocates nothing.
 *
 * Only the NEWEST spectrogram row is copied. `audio.ts` advances
 * `spectrogramRow` by one per analysis frame and this runs on that same loop,
 * so one row per message reconstructs the ring exactly on the far side.
 */
export function packLinkAudioFrame(
  out: Float32Array,
  audio: AudioSnapshot,
  post: LinkPost,
  state: LinkFrameState,
): void {
  const o = LINK_AUDIO_OFFSETS;
  out[o.time] = audio.time;
  out[o.level] = audio.level;
  out[o.beat] = audio.beat;
  out[o.pan] = audio.pan;
  out[o.width] = audio.width;
  out[o.crest] = audio.crest;
  out[o.centroid] = audio.centroid;
  out[o.flatness] = audio.flatness;
  for (let i = 0; i < BAND_NAMES.length; i++) {
    out[o.bands + i] = audio.bands[BAND_NAMES[i] as BandName] ?? 0;
  }
  out[o.spectrogramRow] = audio.spectrogramRow;
  out[o.bpm] = state.bpm;
  out[o.beats] = state.beats;
  out[o.dtBeats] = state.dtBeats;
  out[o.dtSeconds] = state.dtSeconds;
  out[o.frameIndex] = state.frameIndex;
  out[o.bloom] = post.bloom;
  out[o.exposure] = post.exposure;
  out[o.vignette] = post.vignette;
  out[o.grain] = post.grain;
  out[o.flags] = (state.playing ? FLAG_PLAYING : 0) | (state.paused ? FLAG_PAUSED : 0);

  out.set(audio.perceptualBands, o.perceptualBands);
  out.set(audio.perceptualFlux, o.perceptualFlux);
  out.set(audio.waveform, o.waveform);
  out.set(audio.spectrum, o.spectrum);
  out.set(audio.bandPan, o.bandPan);
  out.set(audio.peaks, o.peaks);

  // `spectrogramRow` is the row that will be written next, so the newest one is
  // the row before it. Getting this off by one produces a spectrogram that is
  // one frame stale everywhere and looks entirely correct.
  const newest = (audio.spectrogramRow + SPECTROGRAM_ROWS - 1) % SPECTROGRAM_ROWS;
  const from = newest * SPEC_N;
  out.set(audio.spectrogram.subarray(from, from + SPEC_N), o.spectrogramLine);
}

/**
 * The projector's side of the audio frame.
 *
 * Holds ONE `AudioSnapshot` whose typed arrays never change identity, so the
 * receiving render loop passes the same object to `AudioGpu.upload` every frame
 * and the incremental spectrogram upload keeps working unchanged. The
 * spectrogram ring is rebuilt here, one row per accepted message — including
 * messages that arrive between two projector frames, which is why `accept` is
 * driven by the channel and not by the render loop.
 */
export class LinkAudioReceiver {
  private readonly bands: Record<BandName, number> = { sub: 0, low: 0, mid: 0, high: 0, air: 0 };
  private readonly mutable = {
    time: 0,
    level: 0,
    beat: 0,
    bands: this.bands as Readonly<Record<BandName, number>>,
    pan: 0,
    width: 0,
    crest: 1,
    centroid: 0,
    flatness: 0,
    perceptualBands: new Float32Array(PERCEPTUAL_BAND_COUNT),
    perceptualFlux: new Float32Array(PERCEPTUAL_BAND_COUNT),
    waveform: new Float32Array(WAVE_N * 2),
    spectrum: new Float32Array(SPEC_N * 2),
    bandPan: new Float32Array(SPEC_N),
    spectrogram: new Float32Array(SPEC_N * SPECTROGRAM_ROWS),
    spectrogramRow: 0,
    peaks: new Float32Array(SPEC_N),
  };

  /** Musical state that came with the last accepted frame. */
  bpm = 120;
  beats = 0;
  dtBeats = 0;
  dtSeconds = 0;
  frameIndex = 0;
  playing = false;
  paused = false;
  post: LinkPost = { bloom: 0.28, exposure: 1, vignette: 0.7, grain: 0.35 };
  /** Frames accepted. Zero means the control window has never sent one. */
  frames = 0;

  get snapshot(): AudioSnapshot {
    return this.mutable as AudioSnapshot;
  }

  accept(frame: Float32Array): void {
    if (frame.length < LINK_AUDIO_FLOATS) return;
    const o = LINK_AUDIO_OFFSETS;
    const m = this.mutable;
    m.time = frame[o.time] ?? 0;
    m.level = frame[o.level] ?? 0;
    m.beat = frame[o.beat] ?? 0;
    m.pan = frame[o.pan] ?? 0;
    m.width = frame[o.width] ?? 0;
    m.crest = frame[o.crest] ?? 1;
    m.centroid = frame[o.centroid] ?? 0;
    m.flatness = frame[o.flatness] ?? 0;
    for (let i = 0; i < BAND_NAMES.length; i++) {
      this.bands[BAND_NAMES[i] as BandName] = frame[o.bands + i] ?? 0;
    }
    this.bpm = frame[o.bpm] ?? 120;
    this.beats = frame[o.beats] ?? 0;
    this.dtBeats = frame[o.dtBeats] ?? 0;
    this.dtSeconds = frame[o.dtSeconds] ?? 0;
    this.frameIndex = frame[o.frameIndex] ?? 0;
    this.post = {
      bloom: frame[o.bloom] ?? 0,
      exposure: frame[o.exposure] ?? 1,
      vignette: frame[o.vignette] ?? 0,
      grain: frame[o.grain] ?? 0,
    };
    const flags = frame[o.flags] ?? 0;
    this.playing = (flags & FLAG_PLAYING) !== 0;
    this.paused = (flags & FLAG_PAUSED) !== 0;

    m.perceptualBands.set(frame.subarray(o.perceptualBands, o.perceptualBands + PERCEPTUAL_BAND_COUNT));
    m.perceptualFlux.set(frame.subarray(o.perceptualFlux, o.perceptualFlux + PERCEPTUAL_BAND_COUNT));
    m.waveform.set(frame.subarray(o.waveform, o.waveform + WAVE_N * 2));
    m.spectrum.set(frame.subarray(o.spectrum, o.spectrum + SPEC_N * 2));
    m.bandPan.set(frame.subarray(o.bandPan, o.bandPan + SPEC_N));
    m.peaks.set(frame.subarray(o.peaks, o.peaks + SPEC_N));

    const row = frame[o.spectrogramRow] ?? 0;
    const head = ((Math.trunc(row) % SPECTROGRAM_ROWS) + SPECTROGRAM_ROWS) % SPECTROGRAM_ROWS;
    const newest = (head + SPECTROGRAM_ROWS - 1) % SPECTROGRAM_ROWS;
    m.spectrogram.set(
      frame.subarray(o.spectrogramLine, o.spectrogramLine + SPEC_N),
      newest * SPEC_N,
    );
    m.spectrogramRow = head;
    this.frames++;
  }
}

// ------------------------------------------------------------------ messages

/**
 * Everything one window can tell the other, as one discriminated union.
 *
 * The split between `preset` and `params` mirrors the split that already exists
 * in `main.ts`: structural change (a different show, a layer added, a slider
 * dragged in the panel) versus a live param write on layers of one type, which
 * is what the keyboard and every bound MIDI CC actually do. Sending the whole
 * preset on a knob turn would work and would allocate a fresh object graph at
 * MIDI rate; sending only the patch is what the control window does to itself.
 */
export type LinkMessage =
  /** A window announcing itself. The peer answers with its full state. */
  | { readonly kind: 'hello' }
  /** A window leaving on purpose, so the peer does not wait out the timeout. */
  | { readonly kind: 'bye' }
  | { readonly kind: 'heartbeat' }
  /** The whole show. `transition` non-null asks the projector to crossfade in. */
  | {
      readonly kind: 'preset';
      readonly preset: Preset;
      readonly transition: TransitionSpec | null;
      readonly at: number;
      readonly bpm: number;
    }
  /** Live param write on every layer of `type`, exactly as `patchParams` does. */
  | {
      readonly kind: 'params';
      readonly type: string;
      readonly patch: Readonly<Record<string, ParamValue>>;
    }
  /**
   * In-place edits of existing layers' live-read ("hot") spec fields, by layer
   * id. What a panel slider or select sends: it must NOT reload the stack,
   * which would reset every trigger and feedback trail once per frame of the
   * drag. Anything structural (a layer added, removed, reordered or rebuilt)
   * still travels as a whole `preset`.
   */
  | { readonly kind: 'layer-fields'; readonly fields: readonly ShowLayerFields[] }
  /**
   * The layer mute/solo state. Not in the preset (it is a mixing-desk gesture,
   * not preset data), so it is mirrored on its own: after every `preset`, on
   * every mute/solo click, and in the state answered to a `hello`.
   */
  | { readonly kind: 'mixer'; readonly mixer: LayerMixerSnapshot }
  /**
   * Render settings the projector must follow but does not persist itself.
   * `gpuLane` is 'exact' unless the performer opted into approximate GPU.
   */
  | { readonly kind: 'render-settings'; readonly gpuLane: AvsFrameGraphLane }
  /** Raw `.avs` bytes. Sent once per preset load, never per frame. */
  | { readonly kind: 'avs-load'; readonly bytes: Uint8Array; readonly fileName: string }
  /** Leave the AVS compatibility lane and go back to the native stack. */
  | { readonly kind: 'avs-clear' }
  /** Per-effect power/mute/solo, mirroring `setAvsControl`. */
  | { readonly kind: 'avs-controls'; readonly controls: readonly AvsComponentControl[] }
  /** The packed frame. `LINK_AUDIO_FLOATS` long; see `packLinkAudioFrame`. */
  | { readonly kind: 'audio'; readonly frame: Float32Array };

interface LinkEnvelope {
  readonly protocol: number;
  readonly from: LinkRole;
  readonly message: LinkMessage;
}

/**
 * The slice of `BroadcastChannel` this file uses, so a test can stand one in.
 *
 * `onmessage` keeps the DOM's `MessageEvent` parameter rather than a narrower
 * `{ data: unknown }`: it is a mutable property, so a narrower parameter type
 * makes the real `BroadcastChannel` unassignable to this interface.
 */
export interface BroadcastChannelLike {
  postMessage(message: unknown): void;
  close(): void;
  onmessage: ((event: MessageEvent) => void) | null;
}

export interface LinkOptions {
  readonly role: LinkRole;
  readonly onMessage: (message: LinkMessage) => void;
  /** Called when the peer appears or goes away. Never called with no change. */
  readonly onPeerChange?: (live: boolean) => void;
  /** Injected in tests. Defaults to a real `BroadcastChannel`. */
  readonly channel?: BroadcastChannelLike;
}

/**
 * How long a silent peer stays "live".
 *
 * Six heartbeat periods rather than two, because a browser throttles timers in
 * a window that is not visible to about one per second. A projector parked on a
 * second display that the OS has decided is occluded is still a projector.
 */
export const LINK_PEER_TIMEOUT_MS = 3000;
const HEARTBEAT_MS = 500;

/**
 * A typed `BroadcastChannel` with a liveness clock.
 *
 * Liveness is the whole reason this is a class rather than three loose
 * functions. `BroadcastChannel.postMessage` is fire-and-forget: with nobody
 * listening it succeeds, silently, having still paid for the structured clone.
 * The control window must therefore KNOW whether a projector exists, both to
 * skip 13 KiB of copying sixty times a second when it does not and to un-dim
 * its own canvas when the projector is closed. A window that dies without
 * saying `bye` — crashed tab, killed process, reloaded page — is caught by the
 * timeout instead.
 *
 * Timestamps are taken locally on receipt. `performance.now()` is relative to
 * each window's own time origin, so a value from the peer would be meaningless.
 */
export class Link {
  private readonly channel: BroadcastChannelLike | null;
  private readonly role: LinkRole;
  private readonly onMessage: (message: LinkMessage) => void;
  private readonly onPeerChange: ((live: boolean) => void) | undefined;
  private readonly beat: ReturnType<typeof setInterval> | null;
  private lastPeerMs = -Infinity;
  private reported = false;
  private disposed = false;

  constructor(options: LinkOptions) {
    this.role = options.role;
    this.onMessage = options.onMessage;
    this.onPeerChange = options.onPeerChange;
    this.channel = options.channel
      ?? (typeof BroadcastChannel === 'undefined' ? null : new BroadcastChannel(LINK_CHANNEL_NAME));
    if (this.channel) {
      this.channel.onmessage = (event) => this.receive(event.data);
      this.beat = setInterval(() => this.tick(), HEARTBEAT_MS);
    } else {
      this.beat = null;
    }
  }

  /** False when `BroadcastChannel` is missing. The caller degrades, not throws. */
  get available(): boolean { return this.channel !== null; }

  /** Has the peer been heard from inside the timeout? */
  get peerLive(): boolean {
    return performance.now() - this.lastPeerMs < LINK_PEER_TIMEOUT_MS;
  }

  post(message: LinkMessage): void {
    if (this.disposed || !this.channel) return;
    const envelope: LinkEnvelope = { protocol: LINK_PROTOCOL, from: this.role, message };
    try { this.channel.postMessage(envelope); }
    catch (error) { console.warn('[aaavs] link send failed:', error); }
  }

  /** Announce this window. The peer answers with its full state. */
  announce(): void {
    this.post({ kind: 'hello' });
  }

  dispose(): void {
    if (this.disposed) return;
    this.post({ kind: 'bye' });
    this.disposed = true;
    if (this.beat !== null) clearInterval(this.beat);
    if (this.channel) {
      this.channel.onmessage = null;
      this.channel.close();
    }
  }

  /**
   * Beat unconditionally, even with nobody listening.
   *
   * Beating only WHILE a peer is live is the obvious optimisation and it is a
   * trap: the two sides' liveness can lapse independently (a throttled timer in
   * a hidden window is enough), and once one side goes quiet the other stops
   * beating too, so neither can ever hear the other again. The link then stays
   * dead until a page reload. An unconditional beat is a few dozen bytes twice
   * a second and it makes recovery automatic and symmetric.
   */
  private tick(): void {
    this.post({ kind: 'heartbeat' });
    const live = this.peerLive;
    if (this.reported !== live) {
      this.reported = live;
      this.onPeerChange?.(live);
    }
  }

  private receive(data: unknown): void {
    if (this.disposed) return;
    const envelope = data as Partial<LinkEnvelope> | null;
    if (!envelope || typeof envelope !== 'object') return;
    if (envelope.protocol !== LINK_PROTOCOL) return;
    // A BroadcastChannel does not echo to its own sender, but a SECOND control
    // window would be a same-role peer whose state messages must not be obeyed.
    if (envelope.from === this.role || !envelope.message) return;

    this.lastPeerMs = performance.now();
    if (!this.reported) {
      this.reported = true;
      this.onPeerChange?.(true);
    }

    const message = envelope.message;
    if (message.kind === 'bye') {
      this.lastPeerMs = -Infinity;
      if (this.reported) {
        this.reported = false;
        this.onPeerChange?.(false);
      }
      return;
    }
    if (message.kind === 'heartbeat') return;
    try { this.onMessage(message); }
    catch (error) { console.warn('[aaavs] link message failed:', error); }
  }
}
