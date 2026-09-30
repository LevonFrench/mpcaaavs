// Shared song-map contract. A superset of bizarro/evangelion's AudioJSON (MIT) so ported show plates read it unchanged.
export const SONG_MAP_VERSION = 1;
export type SectionRole = 'intro' | 'groove' | 'break' | 'build' | 'drop' | 'breakdown' | 'outro';
export interface SongMapSection { name: string; role: SectionRole; start: number; end: number; energy: number }
export type SongMapFeature = 'rms' | 'low' | 'mid' | 'high' | 'vocal' | 'drums' | 'bass' | 'other';
export type SongMapOnsetKind = 'kick' | 'snare' | 'hat' | 'vocal';
export interface SongMapJSON {
  version: number;
  duration: number;
  bpm: number;
  /** Frame rate of features, bass_midi and spectrum frames. */
  fps: number;
  beats: number[];
  downbeats: number[];
  /** Beats between two downbeats (the meter: 3 for a waltz). Optional and additive: absent means 4, and every reader must work without it.
   *  Only integers from 2 to 12 are honoured (src/song-map/meter.ts `beatsPerBarOf`). `confidence.downbeat` covers the bar phase, not the meter. */
  beatsPerBar?: number;
  bar0?: number;
  sections: SongMapSection[];
  features: Record<SongMapFeature, number[]>;
  /** [time seconds, strength 0..1] */
  onsets: Record<SongMapOnsetKind, [number, number][]>;
  bass_midi?: number[];
  /** Frame-major uint8 in SongMapBinary.spec: `mel` per-band-normalized mel bands then 12 chroma bins per frame. */
  spectrum?: { frames: number; mel: number; chroma: number; fmin: number; fmax: number };
  /** Interleaved peak-normalized stereo in SongMapBinary.wave. */
  wave?: { rate: number; channels: number; frames: number };
  confidence: { tempo: number; downbeat: number; sections: number };
  /** Features estimated without stem separation, e.g. 'vocal', 'drums'. */
  approximations: string[];
}
export interface SongMapBinary { spec: Uint8Array; wave: Float32Array }
