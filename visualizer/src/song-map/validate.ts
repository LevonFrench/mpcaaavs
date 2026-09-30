// Structural validation of a song map before it reaches a worker (AAAVS). Throws a descriptive Error.
import { SONG_MAP_VERSION, type SongMapBinary, type SongMapJSON } from './types.ts';

const ROLES = new Set(['intro', 'groove', 'break', 'build', 'drop', 'breakdown', 'outro']);
const FEATURES = ['rms', 'low', 'mid', 'high', 'vocal', 'drums', 'bass', 'other'] as const;
const ONSETS = ['kick', 'snare', 'hat', 'vocal'] as const;
const finite = (x: unknown): x is number => typeof x === 'number' && Number.isFinite(x);

function times(name: string, a: unknown, duration: number) {
  if (!Array.isArray(a)) throw new Error(`song map: ${name} must be an array`);
  let prev = -Infinity;
  for (const x of a) {
    if (!finite(x) || x < -1 || x > duration + 60) throw new Error(`song map: ${name} has an invalid time`);
    if (x < prev) throw new Error(`song map: ${name} is not sorted`);
    prev = x;
  }
}

export function validateSongMap(j: unknown, bin?: Partial<SongMapBinary> | null): SongMapJSON {
  if (!j || typeof j !== 'object') throw new Error('song map: not an object');
  const m = j as SongMapJSON;
  if (m.version !== SONG_MAP_VERSION) throw new Error(`song map: unsupported version ${String(m.version)}`);
  if (!finite(m.duration) || m.duration <= 0 || m.duration > 6 * 3600) throw new Error('song map: invalid duration');
  if (!finite(m.bpm) || m.bpm < 20 || m.bpm > 400) throw new Error('song map: invalid bpm');
  if (!finite(m.fps) || m.fps <= 0 || m.fps > 1000) throw new Error('song map: invalid fps');
  times('beats', m.beats, m.duration);
  times('downbeats', m.downbeats, m.duration);
  if (m.bar0 !== undefined && !finite(m.bar0)) throw new Error('song map: invalid bar0');
  // Optional meter: an out-of-range value is an error (a reader would silently fall back to 4 for it).
  if (m.beatsPerBar !== undefined && (!Number.isInteger(m.beatsPerBar) || m.beatsPerBar < 2 || m.beatsPerBar > 12)) throw new Error('song map: invalid beatsPerBar');
  if (!Array.isArray(m.sections)) throw new Error('song map: sections must be an array');
  let prevEnd = -Infinity;
  for (const s of m.sections) {
    if (!s || typeof s.name !== 'string' || !ROLES.has(s.role) || !finite(s.start) || !finite(s.end) || !(s.end > s.start) || !finite(s.energy))
      throw new Error('song map: invalid section');
    if (s.start < prevEnd - 1e-6) throw new Error('song map: sections overlap');
    prevEnd = s.end;
  }
  if (!m.features || typeof m.features !== 'object') throw new Error('song map: missing features');
  const frames = Math.ceil(m.duration * m.fps);
  for (const k of FEATURES) {
    const a = m.features[k];
    if (!Array.isArray(a)) throw new Error(`song map: missing feature ${k}`);
    if (a.length > frames + m.fps * 5) throw new Error(`song map: feature ${k} is longer than the song`);
    for (const x of a) if (!finite(x)) throw new Error(`song map: feature ${k} has a non-finite value`);
  }
  if (!m.onsets || typeof m.onsets !== 'object') throw new Error('song map: missing onsets');
  for (const k of ONSETS) {
    const a = m.onsets[k];
    if (!Array.isArray(a)) throw new Error(`song map: missing onsets ${k}`);
    let prev = -Infinity;
    for (const e of a) {
      if (!Array.isArray(e) || e.length !== 2 || !finite(e[0]) || !finite(e[1])) throw new Error(`song map: invalid onset ${k}`);
      if (e[0] < prev) throw new Error(`song map: onsets ${k} not sorted`);
      prev = e[0];
    }
  }
  if (m.bass_midi !== undefined && (!Array.isArray(m.bass_midi) || m.bass_midi.some((x) => !finite(x)))) throw new Error('song map: invalid bass_midi');
  if (m.spectrum) {
    const s = m.spectrum;
    if (![s.frames, s.mel, s.chroma, s.fmin, s.fmax].every(finite) || s.mel < 1 || s.mel > 256 || s.chroma !== 12 || s.frames < 0) throw new Error('song map: invalid spectrum header');
    if (bin?.spec && bin.spec.length !== s.frames * (s.mel + s.chroma)) throw new Error('song map: spectrum size does not match its header');
  }
  if (m.wave) {
    const w = m.wave;
    if (![w.rate, w.channels, w.frames].every(finite) || w.channels !== 2 || w.rate < 1000 || w.rate > 96000) throw new Error('song map: invalid wave header');
    if (bin?.wave && bin.wave.length !== w.frames * 2) throw new Error('song map: wave size does not match its header');
  }
  if (!m.confidence || ![m.confidence.tempo, m.confidence.downbeat, m.confidence.sections].every(finite)) throw new Error('song map: invalid confidence');
  if (!Array.isArray(m.approximations) || m.approximations.some((x) => typeof x !== 'string')) throw new Error('song map: invalid approximations');
  return m;
}
