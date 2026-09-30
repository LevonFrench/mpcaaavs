// The NERV show: the 16 plates ported from bizarro/evangelion (MIT, see THIRD-PARTY-NERV.txt).
import type { SceneClass } from '../../show/scene.ts';
import type { NervPlateId } from './show-def.ts';
import Boot from './boot.ts';
import Magi from './magi.ts';
import Psycho from './psycho.ts';
import Radar from './radar.ts';
import Harmonics from './harmonics.ts';
import Seele from './seele.ts';
import Battery from './battery.ts';
import ATField from './atfield.ts';
import Alert from './alert.ts';
import Plug from './plug.ts';
import Target from './target.ts';
import City from './city.ts';
import Sync from './sync.ts';
import Berserk from './berserk.ts';
import Impact from './impact.ts';
import End from './end.ts';

export { NERV_PLATE_IDS, NERV_SHOW, type NervPlateId } from './show-def.ts';

export const NERV_SCENE_CLASSES: Record<NervPlateId, SceneClass> = {
  boot: Boot, magi: Magi, psycho: Psycho, radar: Radar, harmonics: Harmonics, seele: Seele, battery: Battery, atfield: ATField,
  alert: Alert, plug: Plug, target: Target, city: City, sync: Sync, berserk: Berserk, impact: Impact, end: End,
};

