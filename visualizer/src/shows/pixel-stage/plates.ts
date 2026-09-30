// The six Pixel Stage plates: PlateSpec data (cast, lanes, backdrop, HUD layout) for the sprite scene in src/show/sprite/scene.ts. Everything the
// plates draw comes from the procedural test pack; the musical story of each plate is carried by the choreographer and the HUD meters.
import type { SceneClass } from '../../show/scene.ts';
import type { PerformerSpec, StagePlan } from '../../show/sprite/choreo.ts';
import { makeSpritePlate, type HudContext, type PlateSpec } from '../../show/sprite/scene.ts';
import type { BorderTheme } from '../../show/sprite/present.ts';
import { pushFrame, type SpriteDraw } from '../../show/sprite/perform.ts';
import { motionAt } from '../../show/sprite/motion.ts';
import { clipFrameIndex } from '../../asset-packs/pack.ts';
import { PIXEL_STAGE_NAMES, type PixelStagePlateId } from './show-def.ts';
import { textWidth } from '../../show/sprite/hud.ts';
import { band, banner, barsLeft, box, chargeMeter, clamp01, counterText, countOnsets, COOL, DIM, eq, energyBar, GOOD, header, HOT, INK, lamps, lin, portrait, ROSE, solid, text, ticker, segmentedMeter } from './kit.ts';

const BANNERS = { intro: 'INTRO', groove: 'GROOVE', break: 'BREAK', build: 'BUILD', drop: 'DROP', breakdown: 'BREAKDOWN', outro: 'OUTRO' } as const;
const theme = (base: string, accent: string, frame: string, pattern: BorderTheme['pattern']): BorderTheme => ({ base: lin(base), accent: lin(accent), frame: lin(frame, 1.6), pattern });
const lerp = (a: number, b: number, t: number) => a + (b - a) * t;
const ease = (t: number) => t * t * (3 - 2 * t);

const banners = (h: HudContext, cx: number, cy: number, scale: number): SpriteDraw[] => h.stage.banners.flatMap((b) => banner(h.pack, b.text, cx, cy, b.age, b.left, { font: 'caps', scale, tint: lin('#fff6d0', 1.3) }));

const floorLayers = (floorTop: number, palette: string) => [
  { region: 'sky', y: 0, fillTo: floorTop + 4, palette },
  { region: 'hills', y: floorTop - 72, palette },
  { region: 'skyline', y: floorTop - 96, palette },
  { region: 'floor', y: floorTop, fillTo: 400, palette },
];
/** Hero facing right, rival facing left, mirrored lanes: the call goes to whoever has the phrase. */
const fighter = (id: string, actor: string, x: number, y: number, facing: 'left' | 'right', side: 'A' | 'B', foe: string, extra: Partial<PerformerSpec> = {}): PerformerSpec => ({
  id, actor, x, y, facing, side, base: 'idle', ...extra,
  lanes: [
    { source: 'kick', verbs: ['attack', 'special'], turn: 'call', target: foe, fx: 'spark', reach: 26, minStrength: 0.25, maxPerBar: 3 },
    { source: 'downbeat', verbs: ['cast'], every: 2, offset: side === 'A' ? 1 : 0, turn: 'call', target: foe, launch: { region: side === 'A' ? 'note' : 'orb', model: side === 'A' ? 'arc' : 'homing', beats: 2 }, fx: 'spark', reaction: 'guard', hitstop: false },
    { source: 'snare', verbs: ['guard', 'parry'], turn: 'response', reaction: 'none', maxPerBar: 2 },
    { source: 'hat', verbs: ['swing'], turn: 'call', minStrength: 0.15, maxPerBar: 2, fx: 'spark', reach: 22, target: foe, reaction: 'none' },
  ],
});

// ------------------------------------------------------------------------------------------------ duel (groove)
const DUEL_FLOOR = 172;
const duel: PlateSpec = {
  id: 'duel', native: [256, 224], border: theme('#1a0a2a', '#7a1f6a', '#ffb43a', 'stripes'), bg: [0.01, 0.01, 0.02],
  backdrop: { layers: floorLayers(DUEL_FLOOR, 'dusk'), barsPerScreen: 4 },
  plan: { phraseBars: 2, banners: BANNERS, performers: [fighter('hero', 'hero', 74, 190, 'right', 'A', 'rival'), fighter('rival', 'rival', 182, 190, 'left', 'B', 'hero', { beatOffset: 1 })] },
  dressing: (h) => lamps(h, DUEL_FLOOR + 10, 88, 'dusk', 4),
  hud: (h) => {
    const w = h.nativeW, H = h.nativeH, kicks = countOnsets(h.au.onsets, 'kick', h.start, h.t), snares = countOnsets(h.au.onsets, 'snare', h.start, h.t);
    return [
      ...header(h),
      ...energyBar(h, 6, 18, 96, 'HERO', (t) => Math.max(0.12, Math.min(1, (h.au.env('low', t) + h.au.env('bass', t)) * 0.8)), COOL),
      ...energyBar(h, w - 102, 18, 96, 'RIVAL', (t) => Math.max(0.12, Math.min(1, (h.au.env('mid', t) + h.au.env('high', t)) * 0.9)), ROSE, true),
      ...box(h.pack, 'panel', w / 2 - 15, 20, 30, 20, 960),
      ...text(h.pack, 'caps', 'BAR', w / 2, 23, { align: 'center', tint: DIM, z: 970 }),
      ...text(h.pack, 'digits', counterText(barsLeft(h), 2), w / 2, 31, { align: 'center', tint: HOT, z: 970 }),
      ...text(h.pack, 'digits', counterText(kicks, 5), 8, 40, { tint: INK, z: 960 }), ...text(h.pack, 'digits', counterText(snares, 5), w - 8, 40, { align: 'right', tint: INK, z: 960 }),
      ...chargeMeter(h, 40, H - 24, 26, clamp01(1.06 * h.section.p + 0.05 * band(h, 'rms')), 7),
      ...text(h.pack, 'caps', 'SUPER', 8, H - 23, { tint: HOT, z: 960 }),
      ...eq(h, 70, 52, 28, 22, 3, 1),
      ...ticker(h, H - 12), ...banners(h, w / 2, 76, 2),
    ];
  },
};

// ------------------------------------------------------------------------------------------------ march (groove, walk-through)
const MARCH_FLOOR = 150;
const minion = (id: string, actor: string, x: number, r: number): PerformerSpec => ({
  id, actor, x, y: 172, facing: 'left', base: 'walk', beatOffset: r * 0.5,
  lanes: [{ source: 'snare', verbs: ['die'], pick: [3, r], fx: 'burst', maxPerBar: 2 }],
});
const march: PlateSpec = {
  id: 'march', native: [384, 216], border: theme('#04141a', '#0a4a4a', '#6fe3ff', 'grid'), bg: [0.01, 0.015, 0.02],
  backdrop: { layers: floorLayers(MARCH_FLOOR, 'dawn'), barsPerScreen: 1 },
  plan: {
    phraseBars: 2, banners: BANNERS, performers: [
      { id: 'hero', actor: 'hero', x: 120, y: 172, facing: 'right', base: 'run', baseByRole: { groove: 'run', break: 'walk', intro: 'walk', outro: 'walk' }, lanes: [
        { source: 'kick', verbs: ['throw'], pick: [2, 0], target: 'm1', launch: { region: 'bolt', model: 'straight', beats: 1 }, fx: 'spark', reaction: 'hurt', minStrength: 0.25 },
        { source: 'kick', verbs: ['throw'], pick: [2, 1], target: 'm2', launch: { region: 'star', model: 'sine', beats: 2, amp: 7 }, fx: 'spark', reaction: 'hurt', minStrength: 0.25 },
        { source: 'hat', verbs: ['swing'], pick: [4, 0], minStrength: 0.2, maxPerBar: 1, fx: 'spark', reach: 22, target: 'm1', reaction: 'none' },
      ] },
      { id: 'ally', actor: 'ally', x: 70, y: 172, facing: 'right', base: 'run', beatOffset: 0.5, baseByRole: { break: 'walk', intro: 'walk', outro: 'walk' }, lanes: [
        { source: 'downbeat', verbs: ['throw'], target: 'm3', launch: { region: 'note', model: 'arc', beats: 2 }, fx: 'spark', reaction: 'hurt' },
      ] },
      minion('m1', 'minion', 250, 0), minion('m2', 'minion-b', 296, 1), minion('m3', 'minion-c', 342, 2),
    ],
  },
  dressing: (h) => lamps(h, MARCH_FLOOR + 12, 96, 'dawn', 1),
  hud: (h) => {
    const w = h.nativeW, H = h.nativeH;
    return [
      ...header(h, INK, COOL),
      ...energyBar(h, 6, 18, 120, 'ENERGY', (t) => band(h, 'rms', t), GOOD),
      ...text(h.pack, 'caps', 'DIST', w - 96, 19, { tint: DIM, z: 960 }), ...text(h.pack, 'digits', counterText(Math.floor(h.bar) * 12, 5), w - 6, 19, { align: 'right', tint: HOT, z: 960 }),
      ...text(h.pack, 'caps', 'NEXT', w - 96, 29, { tint: DIM, z: 960 }), ...text(h.pack, 'caps', `${counterText(barsLeft(h), 2)} BARS`, w - 6, 29, { align: 'right', tint: INK, z: 960 }),
      ...chargeMeter(h, 8, H - 34, 28, clamp01(0.1 + 0.9 * h.section.p), 7, lin('#2affd0', 1.2), lin('#ffd02a', 1.4)),
      ...eq(h, 150, 22, 24, 22, 3, 1, COOL, GOOD),
      ...ticker(h, H - 12), ...banners(h, w / 2, 64, 2),
    ];
  },
};

// ------------------------------------------------------------------------------------------------ charge (build)
const CHARGE_FLOOR = 120;
const charge: PlateSpec = {
  id: 'charge', native: [320, 180], border: theme('#0a0620', '#2a1a6a', '#ff6fd0', 'dots'), bg: [0.005, 0.005, 0.012],
  backdrop: { layers: floorLayers(CHARGE_FLOOR, 'neon'), barsPerScreen: 4 },
  plan: {
    phraseBars: 2, banners: BANNERS, performers: [
      { id: 'hero', actor: 'hero', x: 76, y: 140, facing: 'right', base: 'idle', lanes: [
        { source: 'kick', verbs: ['cast'], target: 'boss', launch: { region: 'orb', model: 'homing', beats: 2 }, fx: 'spark', reaction: 'guard', minStrength: 0.3, maxPerBar: 2, hitstop: false },
        { source: 'hat', verbs: ['throw'], pick: [3, 0], minStrength: 0.2, maxPerBar: 1, target: 'boss', launch: { region: 'star', model: 'boomerang', beats: 2, amp: 10 }, hitstop: false },
      ] },
      { id: 'ally', actor: 'ally', x: 36, y: 142, facing: 'right', base: 'idle', beatOffset: 0.5, lanes: [{ source: 'downbeat', verbs: ['taunt', 'pose'], hitstop: false }] },
      { id: 'boss', actor: 'boss', x: 270, y: 150, facing: 'left', base: 'idle', hover: 3, path: (u) => [lerp(318, 226, ease(u)), 144], lanes: [
        { source: 'snare', verbs: ['guard'], maxPerBar: 1, reaction: 'none' },
        { source: 'kick', verbs: ['cast'], pick: [3, 1], minStrength: 0.4, maxPerBar: 1, target: 'hero', launch: { region: 'orb', model: 'rise', beats: 1, origin: 'floor', amp: 22 }, fx: 'spark', reaction: 'none', hitstop: false },
      ] },
    ],
  },
  hud: (h) => {
    const w = h.nativeW, H = h.nativeH, left = barsLeft(h), lv = clamp01(1.06 * h.section.p + 0.05 * band(h, 'rms'));
    return [
      ...header(h, INK, ROSE),
      ...energyBar(h, 6, 18, 88, 'HERO', (t) => band(h, 'low', t), COOL),
      ...energyBar(h, w - 94, 18, 88, 'BOSS', (t) => clamp01(lerp(1, 0.18, (t - h.start) / (h.end - h.start)) * (0.92 + 0.08 * h.au.hit('kick', t, 0.12))), ROSE, true),
      ...box(h.pack, 'panel', w / 2 - 26, 22, 52, 40, 960),
      ...text(h.pack, 'caps', 'DROP IN', w / 2, 26, { align: 'center', tint: DIM, z: 970 }),
      ...text(h.pack, 'digits', counterText(left, 1), w / 2, 37, { align: 'center', scale: 3, tint: left <= 1 ? lin('#ff5a3a', 1.6) : HOT, z: 970 }),
      ...chargeMeter(h, 10, H - 26, 42, lv, 8),
      ...text(h.pack, 'caps', 'CHARGE', 10, H - 36, { tint: HOT, z: 960 }), ...text(h.pack, 'caps', `${counterText(Math.round(lv * 100), 3)}%`, w - 10, H - 36, { align: 'right', tint: INK, z: 960 }),
      ...eq(h, 8, 54, 26, 26, 3, 1, ROSE, COOL), ...ticker(h, H - 12), ...banners(h, w / 2, 84, 2),
    ];
  },
};

// ------------------------------------------------------------------------------------------------ finale (drop)
const FINALE_FLOOR = 150;
const finale: PlateSpec = {
  id: 'finale', native: [384, 216], border: theme('#1a0404', '#6a1008', '#ffd23f', 'stripes'), bg: [0.012, 0.004, 0.004],
  backdrop: { layers: floorLayers(FINALE_FLOOR, 'neon'), barsPerScreen: 2 },
  plan: {
    phraseBars: 2, banners: BANNERS, performers: [
      { id: 'hero', actor: 'hero', x: 96, y: 172, facing: 'right', base: 'idle', lanes: [
        { source: 'drop', verbs: ['super'], screenwide: true },
        { source: 'kick', verbs: ['attack', 'special'], pick: [2, 0], target: 'boss', fx: 'spark', reach: 30, reaction: 'none', minStrength: 0.3, maxPerBar: 2 },
        { source: 'hat', verbs: ['throw'], pick: [3, 0], minStrength: 0.15, maxPerBar: 1, target: 'boss', launch: { region: 'bolt', model: 'swoop', beats: 2, origin: 'sky' }, fx: 'spark', reaction: 'none', hitstop: false },
      ] },
      { id: 'rival', actor: 'rival', x: 52, y: 176, facing: 'right', base: 'idle', beatOffset: 0.5, lanes: [
        { source: 'kick', verbs: ['cast'], pick: [2, 1], target: 'boss', launch: { region: 'star', model: 'spread', beats: 2, count: 5 }, fx: 'spark', reaction: 'none', minStrength: 0.3, maxPerBar: 2, hitstop: false },
      ] },
      { id: 'ally', actor: 'ally', x: 150, y: 178, facing: 'right', base: 'idle', lanes: [
        { source: 'downbeat', verbs: ['cast'], every: 2, launch: { region: 'orb', model: 'orbit', beats: 8, amp: 18 }, hitstop: false },
        { source: 'snare', verbs: ['parry'], pick: [2, 0], reaction: 'none', maxPerBar: 1 },
        { source: 'hat', verbs: ['throw'], pick: [4, 1], minStrength: 0.15, maxPerBar: 1, target: 'boss', launch: { region: 'star', model: 'fall', beats: 2, origin: 'sky' }, fx: 'puff', reaction: 'none', hitstop: false },
      ] },
      { id: 'boss', actor: 'boss', x: 300, y: 172, facing: 'left', base: 'idle', hover: 4, lanes: [
        { source: 'snare', verbs: ['guard', 'hurt'], maxPerBar: 2, reaction: 'none' },
        { source: 'downbeat', verbs: ['special', 'taunt'], every: 2, offset: 1, hitstop: false },
      ] },
    ],
  },
  dressing: (h) => lamps(h, FINALE_FLOOR + 12, 120, 'neon', 2),
  hud: (h) => {
    const w = h.nativeW, H = h.nativeH, combo = countOnsets(h.au.onsets, 'kick', h.start, h.t);
    return [
      ...header(h, INK, lin('#ff5a3a', 1.5)),
      ...energyBar(h, 6, 18, 160, 'BOSS', (t) => clamp01(lerp(1, 0.2, (t - h.start) / (h.end - h.start)) * (0.9 + 0.1 * h.au.hit('kick', t, 0.12))), ROSE, false),
      ...text(h.pack, 'caps', 'COMBO', w - 6, 19, { align: 'right', tint: DIM, z: 960 }), ...text(h.pack, 'digits', counterText(combo, 4), w - 6, 29, { align: 'right', scale: 2, tint: HOT, z: 960 }),
      ...energyBar(h, 6, 44, 96, 'HERO', (t) => band(h, 'low', t), COOL),
      ...segmentedMeter(h.pack, 10, H - 28, 36, 8, clamp01(1.06 * h.section.p + 0.1 * band(h, 'rms')), h.beat, { low: lin('#ff5a1a', 1.2), high: lin('#fff3a0', 1.6), segW: 6, gap: 1, frame: 'panel', label: { font: 'caps', tint: HOT } }),
      ...text(h.pack, 'caps', 'SUPER', 10, H - 39, { tint: HOT, z: 960 }),
      ...eq(h, 184, 24, 28, 22, 3, 1, lin('#ffd23f', 1.3), ROSE), ...ticker(h, H - 12), ...banners(h, w / 2, 80, 3),
    ];
  },
};

// ------------------------------------------------------------------------------------------------ gallery (break, outro)
const GALLERY_FLOOR = 140;
const poser = (id: string, actor: string, x: number, facing: 'left' | 'right', off: number): PerformerSpec => ({
  id, actor, x, y: 168, facing, base: 'idle', beatOffset: off * 0.5, lanes: [{ source: 'downbeat', verbs: ['pose', 'taunt'], every: 2, offset: off, hitstop: false }],
});
const gallery: PlateSpec = {
  id: 'gallery', native: [320, 200], border: theme('#0a1424', '#1f3a5a', '#8ab0ff', 'diamonds'), bg: [0.01, 0.012, 0.02],
  backdrop: { layers: floorLayers(GALLERY_FLOOR, 'dawn'), barsPerScreen: 8 },
  plan: { phraseBars: 2, banners: BANNERS, performers: [poser('hero', 'hero', 100, 'right', 0), poser('rival', 'rival', 222, 'left', 1), poser('ally', 'ally', 161, 'right', 0)] },
  dressing: (h) => {
    const out = lamps(h, GALLERY_FLOOR + 10, 104, 'dawn', 8);
    const gem = h.pack.clip('gem-glint'), frames = h.pack.clipFrames('gem-glint'), glint = h.pack.clip('glint'), gframes = h.pack.clipFrames('glint');
    const clock = { beat: h.beat, bar: h.au.songBarAt(h.t) };
    if (gem && frames) {
      // gems bounce on every beat of the bar (model `bounce`: ground contact on the beat) with a screen-blended glint on the contact
      const b0 = Math.floor(h.beat / 4) * 4;
      for (let i = 0; i < 5; i++) {
        const x = 30 + i * 62, y = GALLERY_FLOOR + 44, m = motionAt({ model: 'bounce', from: [x, y], to: [x, y], beat0: b0, beat1: b0 + 4, amp: 12 - i }, clock);
        pushFrame(out, frames[clipFrameIndex(gem.hold, true, h.t * 60 + i * 6)]!, m.x, m.y, false, 1, 'glow-cool', 70, 'normal');
        const since = (h.beat - Math.floor(h.beat)) * (60 / h.au.bpm) * 60;
        if (glint && gframes && since < 12) pushFrame(out, gframes[clipFrameIndex(glint.hold, false, since)]!, x, y - 4, false, 1, 'glow-cool', 71, 'screen');
      }
    }
    // hanging lanterns: model `pendulum`, one swing per bar, extreme on the downbeat
    if (gem && frames) for (const x of [150, 232]) {
      const m = motionAt({ model: 'pendulum', from: [x, 17], to: [x, 17], beat0: 0, beat1: 1, amp: 28, fan: 0.55 }, clock);
      for (let k = 1; k < 14; k++) out.push(solid(x + (m.x - x) * (k / 14), 17 + (m.y - 17) * (k / 14), 1, 1, DIM, 55));
      pushFrame(out, frames[clipFrameIndex(gem.hold, true, h.t * 60)]!, m.x, m.y + 5, false, 1, 'glow-warm', 56, 'normal');
    }
    return out;
  },
  hud: (h) => {
    const w = h.nativeW, H = h.nativeH, sel = Math.floor(h.beat) % 3, hats = countOnsets(h.au.onsets, 'hat', h.start, h.t);
    const out: SpriteDraw[] = [...header(h, INK, lin('#8ab0ff', 1.4))];
    // a select screen: the pack's screen region as the panel, portraits in its slots, a cursor hopping on the beat
    out.push(...box(h.pack, 'select', 6, 20, 100, 52, 940));
    [['hero', false], ['rival', true], ['ally', false]].forEach(([a, flip], i) => {
      const x = 14 + i * 30;
      if (i === sel) out.push(solid(x - 2, 26, 28, 42, [0.12, 0.2, 0.45], 941));
      out.push(...portrait(h, a as string, x + 13, 64, flip as boolean, 'idle', 950, i * 0.5));
    });
    const cur = h.pack.regionOf('cursor', 'hud');
    if (cur) out.push({ atlas: cur.atlas, rect: cur.rect, x: 16 + sel * 30, y: 20 - (Math.floor(h.beat * 2) % 2), z: 980, tint: HOT });
    out.push(...text(h.pack, 'caps', 'GEMS', w - 96, 19, { tint: DIM, z: 960 }), ...text(h.pack, 'digits', counterText(hats, 4), w - 6, 19, { align: 'right', tint: HOT, z: 960 }));
    out.push(...text(h.pack, 'caps', 'NEXT', w - 96, 29, { tint: DIM, z: 960 }), ...text(h.pack, 'caps', `${counterText(barsLeft(h), 2)} BARS`, w - 6, 29, { align: 'right', tint: INK, z: 960 }));
    out.push(...energyBar(h, w - 120, 62, 114, 'LEVEL', () => clamp01(h.p), GOOD));
    out.push(...eq(h, 8, 82, 40, 22, 3, 1, COOL, ROSE), ...ticker(h, H - 12), ...banners(h, w / 2, 92, 2));
    return out;
  },
};

// ------------------------------------------------------------------------------------------------ select (intro, breakdown)
const SELECT_FLOOR = 122;
const SELECTS: [string, string, 'left' | 'right'][] = [['hero', 'HERO', 'right'], ['rival', 'RIVAL', 'right'], ['ally', 'ALLY', 'right'], ['minion-c', 'BLOB', 'right']];
const select: PlateSpec = {
  id: 'select', native: [320, 180], border: theme('#0a0620', '#3a1a6a', '#ffd23f', 'diamonds'), bg: [0.005, 0.004, 0.012],
  backdrop: { layers: floorLayers(SELECT_FLOOR, 'neon'), barsPerScreen: 8 },
  plan: { phraseBars: 2, banners: BANNERS, performers: SELECTS.map(([actor], i): PerformerSpec => ({ id: `p${i}`, actor, x: 58 + i * 68, y: 150, facing: 'right', base: 'idle', beatOffset: i * 0.25, lanes: [{ source: 'downbeat', verbs: ['pose'], every: 4, offset: i, hitstop: false }] })) },
  hud: (h) => {
    const w = h.nativeW, H = h.nativeH, sel = ((Math.floor(h.bar) % 4) + 4) % 4, title = typeof h.params.title === 'string' && h.params.title ? String(h.params.title).toUpperCase().slice(0, 18) : 'PIXEL STAGE';
    const out: SpriteDraw[] = [...header(h, INK, HOT)];
    const ts = textWidth(h.pack, 'caps', title, 3) <= 280 ? 3 : textWidth(h.pack, 'caps', title, 2) <= 280 ? 2 : 1, tw = textWidth(h.pack, 'caps', title, ts) + 20;
    out.push(...box(h.pack, 'panel', w / 2 - tw / 2, 24, tw, 8 * ts + 26, 940), ...text(h.pack, 'caps', title, w / 2, 30, { align: 'center', scale: ts, tint: lin('#ffe680', 1.5), z: 960 }));
    out.push(...text(h.pack, 'caps', Math.floor(h.beat * 2) % 2 === 0 ? 'STANDBY' : '       ', w / 2, 30 + 8 * ts + 6, { align: 'center', tint: DIM, z: 960 }));
    SELECTS.forEach(([, name], i) => {
      const x = 58 + i * 68, on = i === sel;
      out.push(...box(h.pack, 'panel', x - 28, 92, 56, 62, on ? 61 : 60, on ? lin('#9ab0ff', 1.0) : undefined, on ? 1 : 0.8));
      out.push(...text(h.pack, 'caps', name, x, 157, { align: 'center', tint: on ? HOT : DIM, z: 960 }));
      if (on) { const cur = h.pack.regionOf('cursor', 'hud'); if (cur) out.push({ atlas: cur.atlas, rect: cur.rect, x: x - 4, y: 82 - (Math.floor(h.beat * 2) % 2), z: 980, tint: HOT, scale: 1 }); }
    });
    out.push(...eq(h, 8, 77, 52, 12, 3, 2, lin('#8a2aff', 1.3), lin('#2affd0', 1.3)), ...ticker(h, H - 12), ...banners(h, w / 2, 110, 2));
    return out;
  },
};

const SPECS: Record<PixelStagePlateId, PlateSpec> = { select, duel, march, charge, finale, gallery };
export const PIXEL_STAGE_SPECS = SPECS;
export const PIXEL_STAGE_SCENE_CLASSES: Record<PixelStagePlateId, SceneClass> = Object.fromEntries(
  (Object.keys(SPECS) as PixelStagePlateId[]).map((id) => [id, makeSpritePlate(SPECS[id], PIXEL_STAGE_NAMES[id])]),
) as Record<PixelStagePlateId, SceneClass>;
