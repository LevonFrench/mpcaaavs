// Bar re-indexing for ported plates.
//
// Upstream plates are hand-timed to one song: they read bars by number (barTime(au, 35) is the drop,
// songBar(au, t) - 72 is how far into build 2 we are). To play a plate in any window of any song
// without rewriting it, each plate gets a view of the analysis whose bar grid is re-indexed: the plate's
// HOME window (its bars in upstream's timeline, e.g. atfield 35..45) maps onto the SONG window it was
// given (downbeat indices A0..A1 of this song).
//
//  - Same length: a pure shift (identity for the reference fixture).
//  - Longer window: home bars are held for more than one song bar, spread evenly (floor(j * nH / nA)),
//    so the first and last bars stay first and last and floor(songBar) never goes backwards.
//  - Shorter window: the first ceil(nA/2) and the last bars keep their numbers; the middle home bars are
//    skipped (their times collapse onto the join), so the story's final bars still land on the boundary.
//  - Outside the window both grids extend linearly (plates look a few bars back or ahead).
//
// Bar phase is always the song's own phase: downbeats stay downbeats.
import type { AudioData } from './audio.ts';

export interface BarMap {
  /** Index offset: downbeats[k + barOff] is home bar k (NERV: 2, bar 0 at 4.82 s in the reference song). */
  barOff: number;
  /** Home window [homeStart, homeEnd) in upstream bar numbers. */
  homeStart: number;
  homeEnd: number;
  /** Song window [songStart, songEnd) in this song's downbeat indices. */
  songStart: number;
  songEnd: number;
}

const counts = (m: BarMap) => ({ nh: Math.max(1, m.homeEnd - m.homeStart), na: Math.max(1, m.songEnd - m.songStart) });

/** True when the map is a pure identity (same length, same numbering). */
export function isIdentity(m: BarMap): boolean {
  return m.songStart === m.homeStart + m.barOff && m.songEnd - m.songStart === m.homeEnd - m.homeStart;
}

/** Continuous song bar offset j (from the window start) → continuous home bar offset. */
export function songToHome(m: BarMap, j: number): number {
  const { nh, na } = counts(m);
  if (j < 0) return j;
  if (j >= na) return nh + (j - na);
  if (na === nh) return j;
  const ji = Math.floor(j), fr = j - ji;
  if (na > nh) return Math.floor((ji * nh) / na) + fr;
  const head = Math.ceil(na / 2);
  return (ji < head ? ji : nh - (na - ji)) + fr;
}

/** Integer home bar offset h → the song bar offset where it starts. */
export function homeToSong(m: BarMap, h: number): number {
  const { nh, na } = counts(m);
  if (h <= 0) return h;
  if (h >= nh) return na + (h - nh);
  if (na === nh) return h;
  if (na > nh) return Math.ceil((h * na) / nh - 1e-9);
  const head = Math.ceil(na / 2), tail = na - head;
  if (h < head) return h;
  if (h >= nh - tail) return na - (nh - h);
  return head;
}

/** Time of home bar k (upstream numbering) in this song. */
export function mapBarToTime(au: AudioData, m: BarMap, k: number): number {
  return au.songBarTime(m.songStart + homeToSong(m, k - m.homeStart));
}

/** Continuous home bar (upstream numbering, without barOff) at song time t. */
export function mapTimeToBar(au: AudioData, m: BarMap, t: number): number {
  return m.homeStart + songToHome(m, au.songBarAt(t) - m.songStart);
}
