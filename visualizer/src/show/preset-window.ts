// NERV presets on the show engine (AAAVS): from the host's NERV playback clock (src/avs-worker-protocol.ts
// NervPlaybackFrame) to the live analysis window and timeline entries the show worker renders.
//
// A .nerv preset names one plate. The host plays it for a scene window [sceneStart, sceneEnd) on its own beat grid
// (the saved clock grid, else the legacy tempo counted from the scene start) and may be crossfading from the previous
// plate. There is no song map in this path yet, so the analysis is the live fallback (live.ts) over a window around the
// scene, and each plate's home bars are mapped onto its scene window (bar-map.ts) so its story resolves on the
// scene's last bar, exactly as planShow() does for a whole song.
//
// presetWindow() is pure; the worker rebuilds the engine's analysis and timeline only when the returned key changes
// (a new scene, a new grid, a new previous plate, or playback running past the scene end by another bar).
import type { NervPlaybackFrame } from '../avs-worker-protocol.ts';
import { compileClockGrid } from '../mpc-beat-grid.ts';
import { NERV_SHOW, type NervPlateId } from '../shows/nerv/show-def.ts';
import type { BarMap } from './bar-map.ts';
import { liveSongMap, type LiveClock } from './live.ts';
import { barIndexAt } from './plan.ts';

export interface PresetEntry {
  readonly id: NervPlateId;
  readonly key: string;
  readonly start: number;
  readonly end: number;
  readonly barMap: BarMap;
}

export interface PresetWindow {
  /** Changes whenever the analysis window or the timeline must be rebuilt. */
  readonly key: string;
  readonly live: LiveClock;
  readonly current: PresetEntry;
  /** The plate being crossfaded from, while clock.blend < 1. */
  readonly previous: PresetEntry | null;
  readonly bpm: number;
}

const clampBpm = (b: number) => Math.min(400, Math.max(20, Number.isFinite(b) ? b : 120));
const fix = (x: number) => x.toFixed(4);

function entry(id: NervPlateId, start: number, end: number, downbeats: readonly number[], tag: string): PresetEntry {
  const def = NERV_SHOW.plates[id];
  if (!def) throw new Error(`unknown NERV plate ${id}`);
  const a = Math.round(barIndexAt(downbeats, start));
  const b = Math.max(a + 1, Math.round(barIndexAt(downbeats, end)));
  return {
    id, start, end, key: `${tag}:${id}@${fix(start)}-${fix(end)}`,
    barMap: { barOff: NERV_SHOW.barOff, homeStart: def.home[0], homeEnd: def.home[1], songStart: a, songEnd: b },
  };
}

export function presetWindow(clock: NervPlaybackFrame, plate: NervPlateId): PresetWindow {
  const grid = compileClockGrid(clock.grid ?? null);
  const start = clock.sceneStart ?? clock.time - clock.localTime;
  const bpm = clampBpm(grid ? grid.bpmAt(start) : clock.bpm);
  const bar = 240 / bpm;
  // the beat phase: the saved grid's offset, else the legacy derivation (beats counted from the scene start)
  const firstBeat = grid && clock.grid ? clock.grid.offset : start;
  const home = NERV_SHOW.plates[plate]!.home, homeBars = home[1] - home[0];
  let end = clock.sceneEnd ?? (clock.progress > 1e-6 && clock.localTime > 0 ? start + clock.localTime / clock.progress : start + homeBars * bar);
  if (!(end > start + 0.25)) end = start + homeBars * bar;
  // playing past the scene end (a held scene): extend by whole bars, so the key changes at most once a bar
  if (clock.time >= end) end += (Math.floor((clock.time - end) / bar) + 1) * bar;

  const blending = clock.previousScene !== undefined && clock.blend !== undefined && clock.blend < 1;
  let pStart = start, pEnd = start;
  const prevId = blending ? (clock.previousScene as NervPlateId) : null;
  if (prevId) {
    const ph = NERV_SHOW.plates[prevId]!.home;
    pEnd = clock.previousSceneEnd ?? start;
    pStart = clock.previousSceneStart ?? pEnd - (ph[1] - ph[0]) * bar;
    if (!(pEnd > pStart + 0.25)) pStart = pEnd - (ph[1] - ph[0]) * bar;
  }
  // the previous plate keeps rendering through the fade (its clock may run past its own end)
  const fade = clock.fadeSeconds ?? (clock.transitionBeats ?? 4) * (60 / bpm);
  const pEntryEnd = Math.max(pEnd, start) + fade + bar;

  const origin = Math.max(0, Math.min(start, prevId ? pStart : start) - 2 * bar);
  const duration = Math.max(end, prevId ? pEntryEnd : end) + 4 * bar;
  const live: LiveClock = { duration, bpm, firstBeat, origin, maxSeconds: duration - origin };
  const d = liveSongMap(live).downbeats;
  const current = entry(plate, start, end, d, 'cur');
  const prev = prevId ? entry(prevId, pStart, pEnd, d, 'prev') : null;
  // the previous entry's window is its scene; its timeline entry stays on screen through the fade
  const previous = prev ? { ...prev, end: pEntryEnd } : null;
  const key = [current.key, previous?.key ?? '-', fix(bpm), fix(firstBeat), fix(origin), fix(duration)].join('|');
  return { key, live, current, previous, bpm };
}
