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
