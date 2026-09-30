// Message protocol between the scan client (main thread) and the song-map worker.
// Every message carries the job id; a worker and a client both drop messages of any other job, so a track
// change can never be corrupted by a late message from the previous track.
import type { SongMapJSON } from './types.ts';

export type SongMapRequest =
  | { type: 'begin'; job: number; sampleRate: number; totalSamples: number | null; maxWaveSeconds?: number }
  /** Starts a contiguous PCM run at `feedStart`; items in [coreStart, coreEnd) are stored. */
  | { type: 'region'; job: number; feedStart: number; coreStart: number; coreEnd: number }
  | { type: 'pcm'; job: number; left: Float32Array; right: Float32Array }
  /** Finishes the current region; `publish` also replies with a snapshot. */
  | { type: 'end-region'; job: number; atTrackEnd: boolean; publish: boolean }
  | { type: 'snapshot'; job: number }
  | { type: 'cancel'; job: number };

export interface SongMapSnapshotMessage {
  type: 'snapshot'; job: number;
  map: SongMapJSON; spec: Uint8Array; wave: Float32Array;
  coverage: [number, number][]; complete: boolean;
  /** Bytes held by the worker's analyzer after this snapshot (for budgets). */
  heapBytes: number;
}

export type SongMapResponse =
  /** One per `pcm` message: the backpressure signal. */
  | { type: 'ack'; job: number; samples: number }
  | { type: 'region-done'; job: number }
  | SongMapSnapshotMessage
  | { type: 'error'; job: number; message: string };

export interface WorkerLike {
  postMessage(message: SongMapRequest, transfer?: Transferable[]): void;
  onmessage: ((event: { data: SongMapResponse }) => void) | null;
  terminate(): void;
}
