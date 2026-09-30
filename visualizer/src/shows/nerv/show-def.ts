// The NERV show definition (pure data, no GL): plate ids, home windows in the reference song's bar
// numbering (bizarro/evangelion app/src/timeline.ts, docs/TREATMENT.md "Song map", MIT) and the
// director's candidate lists per section role. See show/plan.ts.
import type { ShowDef } from '../../show/plan.ts';

/** _eva.ts BAR_OFF: downbeats[k + 2] is reference bar k (bar 0 = 4.82 s). */
const BAR_OFF = 2;

export const NERV_PLATE_IDS = ['boot', 'magi', 'psycho', 'radar', 'harmonics', 'seele', 'battery', 'atfield', 'alert', 'plug', 'target', 'city', 'sync', 'berserk', 'impact', 'end'] as const;
export type NervPlateId = typeof NERV_PLATE_IDS[number];

/** Upstream's timeline: bar windows of the reference song (bar 0 = 4.82 s; boot opens at 0 s, end runs to the song end). */
export const NERV_SHOW: ShowDef = {
  barOff: BAR_OFF,
  plates: {
    boot: { home: [-2, 2] }, magi: { home: [2, 7] }, psycho: { home: [7, 13] }, radar: { home: [13, 18] },
    harmonics: { home: [18, 24] }, seele: { home: [24, 29] }, battery: { home: [29, 35] }, atfield: { home: [35, 45] },
    alert: { home: [45, 54] }, plug: { home: [54, 60] }, target: { home: [60, 65] }, city: { home: [65, 72] },
    sync: { home: [72, 78] }, berserk: { home: [78, 87] }, impact: { home: [87, 96] }, end: { home: [96, 100] },
  },
  roles: {
    intro: ['boot'],
    groove: ['magi', 'psycho', 'radar', 'harmonics'],
    break: ['seele', 'city'],
    build: ['battery', 'sync'],
    drop: ['atfield', 'alert', 'target', 'berserk', 'impact'],
    breakdown: ['city', 'seele', 'plug'],
    outro: ['end'],
  },
  bridge: 'plug',
  intro: 'boot',
  outro: 'end',
};
