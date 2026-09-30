// Meter (beats per bar) helpers shared by the song map, the clock and the show engine's live fallback. Pure: no imports.
//
// A song map's grid is a list of beats and a list of downbeats; the meter is only the count of beats between two downbeats. It is optional
// in the contract (`SongMapJSON.beatsPerBar`): absent means 4, and every reader must keep working without it. Only whole numbers from 2 to 12 are
// honoured (the native clock grid allows 1..16; a 1-beat "bar" has no backbeat and a bar beyond 12 beats is not a meter a show can phrase on).

export const DEFAULT_BEATS_PER_BAR = 4;
export const MIN_BEATS_PER_BAR = 2;
export const MAX_BEATS_PER_BAR = 12;

/** The meter a value names: an integer in 2..12, else 4 (absent, fractional, out of range, NaN). */
export function beatsPerBarOf(value: unknown): number {
  return typeof value === 'number' && Number.isInteger(value) && value >= MIN_BEATS_PER_BAR && value <= MAX_BEATS_PER_BAR ? value : DEFAULT_BEATS_PER_BAR;
}

/**
 * Beat indices inside a bar (0 = the downbeat) that carry the backbeat: the snare of a groove. Used for the predicted snares of the live
 * fallback and as the snare evidence of the downbeat search. The pulse is the beat of the grid, so a compound meter is named by how it is
 * counted: 6/8 felt in two has a bar of 2 beats (one backbeat, beat 2), 6/8 counted in six has 6 beats (backbeat on the fourth).
 *
 *   2 (2/4, 6/8 in two)  beat 2                   [1]
 *   3 (3/4 waltz)        beats 2 and 3            [1, 2]  (the "pah-pah" after the "oom")
 *   4 (4/4)              beats 2 and 4            [1, 3]
 *   5 (5/4 as 3+2)       beats 2 and 4            [1, 3]
 *   6 (6/8 in six)       beat 4                   [3]
 *   7 (7/8 as 2+2+3)     beats 3 and 5            [2, 4]  (the starts of the second and third groups)
 *   9 (9/8 as 3+3+3)     beats 4 and 7            [3, 6]
 *   8, 10, 11, 12        beats n/4 and 3n/4, rounded  (8: 3 and 7, 12: 4 and 10)
 *
 * The kick is on every beat in every meter (the downbeat strongest); the backbeat table above is the only meter-specific part.
 */
export function backbeats(beatsPerBar: number): readonly number[] {
  const n = beatsPerBarOf(beatsPerBar);
  switch (n) {
    case 2: return [1];
    case 3: return [1, 2];
    case 4: return [1, 3];
    case 5: return [1, 3];
    case 6: return [3];
    case 7: return [2, 4];
    case 9: return [3, 6];
    default: return [Math.round(n / 4), Math.round((3 * n) / 4)];
  }
}
