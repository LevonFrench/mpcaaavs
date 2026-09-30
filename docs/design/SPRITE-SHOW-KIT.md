# Sprite show kit

Status: proposed design. Shared by every sprite-based show (fighting, action
platformer, run-and-gun, shooter, survival horror menus). Assets come from
private local asset packs (`show-assets-private/`, never committed); the public
build draws procedural stand-ins with the same timing.

## Principle: perform, never simulate

Sprite shows are music videos made of game material, not simulated play.
Nobody wins or loses, no level is "cleared", there is no GAME OVER. Characters
perform to the music, HUD parts behave like meters, projectiles are notes,
effects are accents, backgrounds are the stage. Game banners (ROUND, K.O.,
STAGE CLEAR, WARNING) are punctuation on musical events, never results.

## One asset vocabulary for every genre

A pack describes its sprites in genre-neutral roles so plates can mix packs
(a platformer boss on a fighting-game stage, fighting-game sparks on a
platformer hero).

| Role | Contents | Key metadata |
| --- | --- | --- |
| `actor` | heroes, enemies, bosses, NPCs, familiars | class (`hero`, `enemy`, `boss`, `npc`, `companion`), size class, clips by verb, anchor (feet), facing |
| `clip` | an animation strip of one actor | verb (below), per-frame duration in source frames, loop flag, `big` frame index(es), per-frame anchor |
| `projectile` | thrown/fired objects | motion model (below), spin/animation clip, spawn offset from actor, impact effect |
| `effect` | hit sparks, deaths, spawns, flashes, trails, particles, super freezes | blend (`normal`, `add`, `screen`), duration, scale class |
| `pickup` | items, currency, power-ups, collectibles | idle clip (bob/glint), collect effect, caption text |
| `prop` | breakables and set dressing: candles, lamps, crates, chandeliers, doors | idle clip, break clip and drop table |
| `background` | parallax layers, animated tiles, full stitched stage panoramas | scroll factor per layer, loop width, animated-tile clips, palette cycles |
| `hud` | bars, counters, digit fonts, boxes, emblems, banners, cursors | nine-slice margins, fill direction, segment pitch, ghost colour |
| `text` | dialogue boxes, fonts, captions, name plates | glyph grid, box nine-slice |
| `transition` | doors, stairs, wipes, crumbles, flips, fades | duration in beats, direction |
| `screen` | whole-screen UIs: select grids, maps, inventories, status and result screens | layout regions and cursor positions |

**Clip verbs:** `idle`, `walk`, `run`, `dash`, `jump`, `fall`, `crouch`,
`attack`, `special`, `super`, `cast`, `throw`, `guard`, `parry`, `hurt`,
`knockdown`, `die`, `spawn`, `enter`, `exit`, `taunt`, `pose`, `transform`,
`swim`, `climb`, `hang`, `swing`.

## Motion models (projectiles and moving actors)

Every motion is a function of time with musical parameters, so things arrive on
beats: `straight` (constant velocity, flight time in beats), `arc` (ballistic:
launch on one beat, land on a later beat), `sine` (wave: period in beats,
amplitude from energy), `boomerang` (out and back, returns on a chosen beat),
`homing` (eases toward a target, arrives on a beat), `bounce` (bounces on each
beat), `spread` (fan of n straight shots), `orbit` (circles an actor, one turn
per bar), `fall` (drops from the top, lands on a beat), `rise` (emerges from
the floor), `swoop` (curved dive in and out), `hover` (idle float with bob on
the beat), `pendulum` (swing: period one bar).

## Choreography grammar

A plate is a set of lanes, each assigned to a musical source. The engine turns
song-map events into verbs, with look-ahead so each clip's `big` frame (the
release, the impact, the flash) lands exactly on its event.

| Musical source | Typical verbs |
| --- | --- |
| beat | idle/walk step, bob, background parallax step, animated-tile step |
| downbeat / bar | pose changes, camera cuts, banners, prop breaks |
| kick | attacks and specials with big frames, projectile launches, hit sparks |
| snare / clap | guard and parry flashes, projectile clashes, enemy deaths, alarms |
| hats | light attacks, footsteps, small pickups, candle flickers, digit ticks |
| bass pitch | vertical choice: jump vs crouch, high vs low projectile |
| melody / chroma change | path shapes (drawn sigils, whip angles, cursor moves) |
| band energy | HUD bars, meter fills, background brightness |
| section role | plate mode (below) |
| drop downbeat | screen-wide moments: supers, screen-clear items, freezes, flips |
| silence | everyone to idle, freeze, or black |

Section roles map to plate modes: intro = title/attract/select; groove = dance,
walk-through, projectile play; break/breakdown = exploration, maps, menus,
poses; build = charge-up, bosses approaching, meters filling, countdowns; drop =
supers, bosses, screen-clear moments; outro = credits and exits.

Retiming rules: loops (idle, walk, run, hover) retime to beat multiples;
one-shot clips (attacks, specials, deaths) keep native frame timing and only
their start moves. Hitstop freezes of 4-12 source frames on accents, scaled by
onset strength.

## HUD as meters

HUD parts read musical signals instead of game state: health bars = band
energy (with the game's ghost-trail drain), magic/super meters = energy trend
across a build, counters (score, hearts, ammo, combo) = counts of onsets,
timers = beats or bars remaining in the section, boss bars = fill on entry and
drain across the section, level/experience = song progress.

## Backgrounds

Stitched panoramas and parallax layers from packs scroll at tempo-locked
speeds: one screen width per bar (or per two bars) by default, stair or door
transitions on phrase boundaries. Animated tiles, palette cycles and background
props step on beats; drops flash or shake the backdrop.

## Crossover

Because every pack uses the same roles and verbs, plates can mix sources: any
`actor` can use any `effect`; a `boss` from one pack can appear behind another
pack's `hud`; a fighting-game `super` freeze can punctuate a platformer plate.
Mixing is opt-in per plate and seeded per run.

## Pack format

Packs follow the asset-pack manifest defined for `cloud/show-asset-packs`
(`docs/CLOUD-HANDOFF.md`, task 3) with the roles above as its region types. The
public build ships no pack; each plate that uses a role also defines its
procedural stand-in.

## Engine: sprite layer and choreographer (implemented)

Status: implemented in `visualizer/src/show/sprite/`, demo show in `visualizer/src/shows/pixel-stage/`, CPU checks in
`visualizer/tools/check-sprite-layer.mjs`, stills with `node tools/render-show-stills.mjs --show pixel-stage` (see `.show-stills/sprite/README.md`).

| Module | What it does |
| --- | --- |
| `layer.ts` | Sprite layer. Uploads a pack's atlases (raw RGBA data or decoded bitmaps), draws instanced quads into a native-resolution target with `texelFetch` (nearest, no filtering or bleeding), facing by flip, per-instance tint, normal, additive and screen blending, palette swap through an index atlas plus a palette texture (one row per palette, rebuilt on the beat for cycles). No drop shadows. |
| `scaling.ts`, `present.ts` | Pixel scaling policy. The plate renders at the game's native size (e.g. 256x224, 320x180, 384x216) and is presented at the largest **integer** scale, centred, with a themed border drawn on the same pixel grid; `sharp` mode fills the frame with a fractional scale and the sharp-bilinear shader. 1080p and 4K differ only by the integer factor. |
| `clip.ts` | Retiming rules: loops last whole beats and read the beat grid (so seeks and tempo changes keep them locked); one-shots keep native tick timing and only their start moves; hitstop 4-12 ticks from onset strength freezes a one-shot at its big frame. |
| `motion.ts` | The 13 motion models as pure functions of the beat (flights arrive on a whole beat; orbit and pendulum have a period of one bar, hover of one beat). |
| `choreo.ts` | The choreographer: song-map events to a script, with look-ahead so every clip's big frame starts on its event; call and response by phrase; projectiles launched on the big frame, landing on a beat; enemies that die on a snare respawn on the next downbeat; banners and screen punches at section starts; the drop moment (punch on the drop downbeat, super one bar later with a screen freeze). With no onsets in the map it performs on the beat grid. |
| `perform.ts` | `Stage`: evaluates a script at any time into sprite draws and post punches (shake and zoom in whole native pixels through `PostOverrides`, flash). Stateless. |
| `hud.ts` | HUD as meters: ghost-drain bars, segmented meters with MAX flash, counters and timers from pack font grids, nine-slice boxes, banners. |
| `test-pack.ts` | The procedural test pack (neutral shapes; indexed figures with palette swaps, trimmed frames, detached blades, effects, backdrops, UI and fonts) built in code through the real manifest validator. |
| `scene.ts` | `makeSpritePlate(spec)`: a `PlateSpec` (native size, border, backdrop, cast and lanes, HUD) becomes an engine `Scene`. |

A show picks the sprite layer by using `makeSpritePlate`; `show-init` has a `show` field (`nerv` by default, `pixel-stage`) and the worker looks
plates up in `src/shows/scenes.ts`. Real packs replace the test pack by passing their `AssetPack` where `sharedTestPack()` is used in `scene.ts`;
plates name regions and verbs, never files.
