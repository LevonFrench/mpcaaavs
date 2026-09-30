import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { fsPackSource, loadAssetPackModule } from './asset-pack-fs-source.mjs';
import * as F from './fixtures-asset-pack.mjs';
// CPU-only check of the show asset packs (docs/design/ASSET-PACK-MANIFEST.md, src/asset-packs/): the strict `mpcaaavs-assets` v1 manifest validator,
// path traversal rejection on every adapter, the loader's absent/invalid/loaded outcomes, the procedural stand-in path (no pack, invalid pack, wrong
// role, metadata-only pack) and the repository rules that keep private packs out of git. Every pack here is a tiny synthetic fixture generated in
// tools/fixtures-asset-pack.mjs; nothing is read from or written to show-assets-private/. No browser, GPU or audio: nothing here shows a pixel.
const repo = fileURLToPath(new URL('../..', import.meta.url)), visualizer = fileURLToPath(new URL('..', import.meta.url));
const A = await loadAssetPackModule();
let checks = 0;
const ok = (c, m) => { assert.ok(c, m); checks++; };
const eq = (a, b, m) => { assert.deepStrictEqual(a, b, m); checks++; };
const clone = v => structuredClone(v);
const under = (p, want) => p === want || p.startsWith(`${want}.`) || p.startsWith(`${want}[`);
const fakeDecode = async (_bytes, atlas) => ({ width: atlas.width, height: atlas.height });
const BS = String.fromCharCode(92);

/** Mutates a fresh fixture manifest and asserts a rejection at `where` (path prefix) matching `text`. */
function rejects(mutate, where, text, note) {
  const m = F.fixtureManifest(); mutate(m);
  const r = A.checkAssetPackManifest(clone(m));
  assert.equal(r.manifest, null, `${note}: expected a rejection`);
  assert.ok(r.issues.length > 0, note);
  assert.ok(r.issues.some(i => under(i.path, where) && (!text || text.test(i.message))), `${note}: wanted an issue at ${where}${text ? ` matching ${text}` : ''}, got ${JSON.stringify(r.issues.slice(0, 4))}`);
  checks++;
}
function accepts(mutate, note) {
  const m = F.fixtureManifest(); mutate(m);
  const r = A.checkAssetPackManifest(clone(m));
  assert.ok(r.manifest, `${note}: ${JSON.stringify(r.issues.slice(0, 3))}`); assert.equal(r.issues.length, 0, note); checks++;
  return r.manifest;
}

// ---------------------------------------------------------------------------------------------------------------- fixtures are real
{
  const files = F.fixtureFiles(), sprites = F.decodePng(files['atlas/sprites.png']), ui = F.decodePng(files['atlas/ui.png']);
  eq([sprites.width, sprites.height, ui.width, ui.height], [64, 64, 64, 48], 'fixture atlases decode');
  ok(sprites.rgba[3] === 255 && sprites.rgba.some(v => v !== 0), 'fixture atlas is painted');
  eq(F.fixtureFiles()['atlas/sprites.png'], files['atlas/sprites.png'], 'fixture atlases are deterministic');
  ok(Object.values(files).every(v => v.length < 16384), 'fixtures are tiny');
}

// ---------------------------------------------------------------------------------------------------------------- good manifest
const good = A.parseAssetPackManifest(JSON.stringify(F.fixtureManifest()));
ok(good.manifest && good.issues.length === 0, `fixture manifest is valid: ${JSON.stringify(good.issues)}`);
const gm = good.manifest;
ok(Object.isFrozen(gm) && Object.isFrozen(gm.regions.hero) && Object.isFrozen(gm.regions.hero.rect), 'manifest is deeply frozen');
eq(gm.regions.note.anchor, [4, 4], 'projectile anchor defaults to centre');
eq(gm.regions.hero.anchor, [8, 24], 'actor anchor defaults to bottom-centre');
eq(gm.regions.panel.anchor, [0, 0], 'hud anchor defaults to top-left');
eq(gm.regions.hero.clips, { idle: 'hero-idle', attack: 'hero-attack' }, 'actor clips by verb');
eq(gm.atlases.sprites.filter, 'nearest', 'atlas filter default');
eq(gm.clips['hero-idle'].length, 4, 'strip clip length');
eq(gm.fonts.digits.advance, [6, 6, 6, 6, 6, 6, 6, 6, 6, 6], 'scalar advance expands per glyph');
eq(A.ASSET_ROLES.length, 11, 'eleven roles');
for (const role of A.ASSET_ROLES) ok(Object.values(gm.regions).some(r => r.role === role), `fixture covers role ${role}`);

// Typed lookups
{
  const pack = new A.AssetPack(gm, new Map([['sprites', { width: 64, height: 64 }], ['ui', { width: 64, height: 48 }]]));
  eq([pack.id, pack.name], ['fixture-pack', 'Fixture Pack (synthetic)'], 'pack identity');
  ok(pack.regionOf('hero', 'actor') && !pack.regionOf('hero', 'effect') && !pack.regionOf('nope', 'actor'), 'regionOf is role-typed');
  ok(pack.region('__proto__') === undefined && pack.region('constructor') === undefined && pack.clip('toString') === undefined && pack.font('hasOwnProperty') === undefined, 'lookups ignore prototype names');
  eq(pack.idsByRole('hud'), ['meter', 'panel'], 'idsByRole is sorted');
  eq(pack.idsByRole('actor'), ['hero'], 'one actor');
  eq(pack.actorClip('hero', 'attack')?.id, 'hero-attack', 'actorClip');
  ok(pack.actorClip('hero', 'swim') === undefined && pack.actorClip('gem', 'idle') === undefined, 'actorClip misses');
  const idle = pack.clipFrames('hero-idle');
  eq(idle.map(f => f.rect), [[0, 0, 16, 16], [16, 0, 16, 16], [32, 0, 16, 16], [48, 0, 16, 16]], 'strip cells');
  eq(idle[0].anchor, [8, 16], 'strip anchor is bottom-centre of the cell');
  const attack = pack.clipFrames('hero-attack');
  eq(attack.map(f => [f.rect, f.anchor, f.hold]), [[[0, 40, 16, 16], [8, 15], 3], [[16, 40, 16, 16], [9, 15], 5]], 'frames clip uses its own anchors and holds');
  ok(pack.clipFrames('hero-idle') === idle, 'clipFrames is cached');
  eq(A.glyphRect(gm.fonts.digits, '7'), [12, 8, 6, 8], 'glyph grid cell');
  ok(A.glyphRect(gm.fonts.digits, 'x') === undefined && A.glyphAdvance(gm.fonts.digits, 'x') === undefined && A.glyphAdvance(gm.fonts.digits, '3') === 6, 'glyph misses');
  eq([0, 5, 6, 11, 12, 23, 24, 25, 100, -3].map(t => A.clipFrameIndex([6, 6, 6, 6], true, t)), [0, 0, 1, 1, 2, 3, 0, 0, 0, 0], 'looping clip frame index wraps');
  eq([0, 2, 3, 7, 8, 500, -1].map(t => A.clipFrameIndex([3, 5], false, t)), [0, 0, 1, 1, 1, 1, 0], 'one-shot clip holds its last frame');
  eq([A.clipFrameIndex([], true, 4), A.clipFrameIndex([4], true, Number.NaN), A.clipDuration([3, 5])], [0, 0, 8], 'degenerate clips');
  const palette = gm.palettes.main;
  eq(A.paletteColorsAt(palette, 0), ['#102030', '#405060', '#8090a0', '#d0e0f0'], 'palette cycle at beat 0');
  eq(A.paletteColorsAt(palette, 1), ['#102030', '#8090a0', '#d0e0f0', '#405060'], 'palette cycle rotates through its range');
  eq(A.paletteColorsAt(palette, 2), A.paletteColorsAt(palette, 0), 'palette cycle period');
  eq(A.paletteColorsAt(palette, 1.25), A.paletteColorsAt(palette, 1.25), 'palette cycle is a pure function of the beat');
  eq(A.paletteColorsAt(palette, -1), ['#102030', '#8090a0', '#d0e0f0', '#405060'], 'negative beats wrap');
}

// Accepted variants: defaults and alternatives
accepts(m => { delete m.regions.hero.size; delete m.regions.hero.facing; delete m.atlases.sprites.filter; delete m.palettes; delete m.regions.hero.palette; delete m.clips['hero-idle'].palette; }, 'defaults');
accepts(m => { m.clips['hero-idle'].hold = 6; }, 'scalar hold');
accepts(m => { delete m.clips; m.regions.hero.clips = {}; m.regions.note.impact = 'spark'; }, 'no clips');
accepts(m => { m.fonts.digits.advance = [6, 6, 5, 6, 6, 6, 6, 6, 6, 4]; }, 'per-glyph advance');
accepts(m => { delete m.regions; delete m.clips; delete m.fonts; delete m.palettes; }, 'atlases only');
eq(A.checkAssetPackManifest(F.fixtureManifest()).manifest.clips['hero-idle'].hold, [6, 6, 6, 6], 'check accepts parsed objects directly');

// ---------------------------------------------------------------------------------------------------------------- bad manifests
for (const value of [null, 5, 'x', [], true]) { const r = A.checkAssetPackManifest(value); ok(r.manifest === null && r.issues.length === 1, `root ${JSON.stringify(value)} rejected`); }
rejects(m => { m.extra = 1; }, 'extra', /unknown key/, 'unknown root key');
rejects(m => { m.format = 'other'; }, 'format', /mpcaaavs-assets/, 'wrong format');
rejects(m => { m.version = 2; }, 'version', /unsupported/, 'unsupported version');
rejects(m => { m.version = '1'; }, 'version', undefined, 'string version');
rejects(m => { delete m.version; }, 'version', undefined, 'missing version');
rejects(m => { m.id = '../x'; }, 'id', undefined, 'traversal id');
rejects(m => { m.id = 'Upper'; }, 'id', undefined, 'uppercase id');
rejects(m => { m.id = 'con'; }, 'id', undefined, 'device name id');
rejects(m => { m.id = 5; }, 'id', undefined, 'numeric id');
rejects(m => { m.name = ''; }, 'name', undefined, 'empty name');
rejects(m => { m.name = 'Bad <name>'; }, 'name', undefined, 'markup in name');
rejects(m => { m.name = 'x'.repeat(60); }, 'name', undefined, 'long name');
rejects(m => { m.atlases = {}; }, 'atlases', /at least one/, 'no atlases');
rejects(m => { m.atlases = []; }, 'atlases', undefined, 'atlases as array');
rejects(m => { delete m.atlases; }, 'atlases', undefined, 'missing atlases');
rejects(m => { m.atlases.extra = { file: 'a.png', width: 4, height: 4, zzz: 1 }; }, 'atlases.extra.zzz', /unknown key/, 'unknown atlas key');
rejects(m => { m.atlases.sprites.width = 0; }, 'atlases.sprites.width', undefined, 'zero atlas width');
rejects(m => { m.atlases.sprites.width = 4097; }, 'atlases.sprites.width', undefined, 'oversize atlas width');
rejects(m => { m.atlases.sprites.width = 64.5; }, 'atlases.sprites.width', /integer/, 'fractional atlas width');
rejects(m => { m.atlases.sprites.height = '64'; }, 'atlases.sprites.height', /integer/, 'string atlas height');
rejects(m => { m.atlases.sprites.height = null; }, 'atlases.sprites.height', undefined, 'null atlas height');
rejects(m => { m.atlases.sprites.filter = 'cubic'; }, 'atlases.sprites.filter', /one of/, 'unknown filter');
rejects(m => { m.atlases.ui.file = 'atlas/sprites.png'; }, 'atlases.ui.file', /another atlas/, 'shared atlas file');
rejects(m => { m.atlases.ui.file = 'ATLAS/Sprites.PNG'; }, 'atlases.ui.file', /another atlas/, 'shared atlas file, case-insensitive');
rejects(m => { m.atlases.ui.file = 'atlas/ui.jpg'; }, 'atlases.ui.file', /\.png/, 'non-png atlas');
rejects(m => { m.atlases.ui.file = '../ui.png'; }, 'atlases.ui.file', undefined, 'traversal atlas file');
rejects(m => { m.atlases['Bad Id'] = { file: 'b.png', width: 4, height: 4 }; }, 'atlases', /id/, 'bad atlas id');
rejects(m => { for (let i = 0; i < 17; i++) m.atlases[`a${i}`] = { file: `a${i}.png`, width: 4, height: 4 }; }, 'atlases', /at most 16/, 'too many atlases');
rejects(m => { m.regions.hero.role = 'wizard'; }, 'regions.hero.role', /one of/, 'unknown role');
rejects(m => { delete m.regions.hero.role; }, 'regions.hero.role', undefined, 'missing role');
rejects(m => { m.regions.hero.zzz = 1; }, 'regions.hero.zzz', /unknown key/, 'unknown region key');
rejects(m => { m.regions.note.class = 'hero'; }, 'regions.note.class', /unknown key/, 'role-specific key on the wrong role');
rejects(m => { m.regions.hero.atlas = 'nope'; }, 'regions.hero.atlas', /unknown atlas/, 'unknown region atlas');
rejects(m => { delete m.regions.hero.atlas; }, 'regions.hero.atlas', undefined, 'missing region atlas');
rejects(m => { m.regions.hero.atlas = '__proto__'; }, 'regions.hero.atlas', /unknown atlas/, 'prototype name as atlas');
rejects(m => { m.regions.hero.rect = [60, 0, 16, 16]; }, 'regions.hero.rect', /outside/, 'region past the right edge');
rejects(m => { m.regions.hero.rect = [0, 50, 16, 16]; }, 'regions.hero.rect', /outside/, 'region past the bottom edge');
rejects(m => { m.regions.hero.rect = [-1, 0, 16, 16]; }, 'regions.hero.rect[0]', undefined, 'negative region x');
rejects(m => { m.regions.hero.rect = [0, 0, 0, 16]; }, 'regions.hero.rect[2]', undefined, 'empty region');
rejects(m => { m.regions.hero.rect = [0, 0, 1.5, 16]; }, 'regions.hero.rect[2]', /integer/, 'fractional region');
rejects(m => { m.regions.hero.rect = [0, 0, 16]; }, 'regions.hero.rect', /\[x, y, width, height\]/, 'short rect');
rejects(m => { m.regions.hero.rect = [0, 0, Number.NaN, 16]; }, 'regions.hero.rect', undefined, 'NaN rect');
rejects(m => { m.regions.hero.rect = 'x'; }, 'regions.hero.rect', undefined, 'string rect');
rejects(m => { delete m.regions.hero.rect; }, 'regions.hero.rect', undefined, 'missing rect');
rejects(m => { m.regions.hero.anchor = [17, 0]; }, 'regions.hero.anchor[0]', undefined, 'anchor outside region');
rejects(m => { m.regions.hero.anchor = [0]; }, 'regions.hero.anchor', undefined, 'short anchor');
rejects(m => { m.regions.hero.palette = 'nope'; }, 'regions.hero.palette', /unknown palette/, 'unknown region palette');
rejects(m => { m.regions.hero.tags = ['ok', 'ok']; }, 'regions.hero.tags', /duplicate/, 'duplicate tag');
rejects(m => { m.regions.hero.tags = ['Bad Tag']; }, 'regions.hero.tags', undefined, 'bad tag');
rejects(m => { m.regions.hero.tags = 'x'; }, 'regions.hero.tags', undefined, 'tags not a list');
rejects(m => { m.regions.hero.class = 'wizard'; }, 'regions.hero.class', /one of/, 'unknown actor class');
rejects(m => { delete m.regions.hero.class; }, 'regions.hero.class', undefined, 'missing actor class');
rejects(m => { m.regions.hero.size = 'gigantic'; }, 'regions.hero.size', undefined, 'unknown size class');
rejects(m => { m.regions.hero.facing = 'up'; }, 'regions.hero.facing', undefined, 'unknown facing');
rejects(m => { m.regions.hero.clips.dance = 'hero-idle'; }, 'regions.hero.clips.dance', /unknown clip verb/, 'unknown verb');
rejects(m => { m.regions.hero.clips.idle = 'nope'; }, 'regions.hero.clips.idle', /unknown clip/, 'actor refers to unknown clip');
rejects(m => { m.regions.hero.clips.idle = 'hero-attack'; }, 'regions.hero.clips.idle', /has verb attack/, 'clip verb mismatch');
rejects(m => { m.regions.hero.clips.idle = 5; }, 'regions.hero.clips.idle', /clip id/, 'clip id not a string');
rejects(m => { m.regions.hero.nineSlice = { left: 1, top: 1, right: 1, bottom: 1 }; }, 'regions.hero.nineSlice', /only valid on/, 'nine-slice on an actor');
rejects(m => { m.regions.panel.nineSlice = { left: 12, top: 6, right: 12, bottom: 6 }; }, 'regions.panel.nineSlice', /centre column/, 'nine-slice margins cover the width');
rejects(m => { m.regions.panel.nineSlice = { left: 6, top: 8, right: 6, bottom: 8 }; }, 'regions.panel.nineSlice', /centre row/, 'nine-slice margins cover the height');
rejects(m => { m.regions.panel.nineSlice = { left: 25, top: 1, right: 0, bottom: 0 }; }, 'regions.panel.nineSlice.left', undefined, 'nine-slice margin past the region');
rejects(m => { m.regions.panel.nineSlice = { left: -1, top: 1, right: 1, bottom: 1 }; }, 'regions.panel.nineSlice.left', undefined, 'negative margin');
rejects(m => { m.regions.panel.nineSlice = { left: 1, top: 1, right: 1 }; }, 'regions.panel.nineSlice.bottom', undefined, 'missing margin');
rejects(m => { m.regions.panel.nineSlice = { left: 1, top: 1, right: 1, bottom: 1, extra: 1 }; }, 'regions.panel.nineSlice.extra', /unknown key/, 'unknown margin key');
rejects(m => { m.regions.note.motion = 'teleport'; }, 'regions.note.motion', /one of/, 'unknown motion model');
rejects(m => { delete m.regions.note.motion; }, 'regions.note.motion', undefined, 'missing motion model');
rejects(m => { m.regions.note.impact = 'hero'; }, 'regions.note.impact', /role effect/, 'impact must be an effect');
rejects(m => { m.regions.note.impact = 'missing'; }, 'regions.note.impact', /unknown region/, 'impact refers to a missing region');
rejects(m => { m.regions.note.clip = 'missing'; }, 'regions.note.clip', /unknown clip/, 'projectile clip missing');
rejects(m => { m.regions.note.spawn = [-1, 0]; }, 'regions.note.spawn[0]', undefined, 'negative spawn offset');
rejects(m => { m.regions.spark.blend = 'multiply'; }, 'regions.spark.blend', /one of/, 'unknown blend');
rejects(m => { m.regions.spark.duration = 0; }, 'regions.spark.duration', undefined, 'zero effect duration');
rejects(m => { m.regions.spark.duration = 601; }, 'regions.spark.duration', undefined, 'huge effect duration');
rejects(m => { m.regions.gem.collect = 'hero'; }, 'regions.gem.collect', /role effect/, 'collect must be an effect');
rejects(m => { m.regions.gem.caption = 'x'.repeat(30); }, 'regions.gem.caption', undefined, 'long caption');
rejects(m => { m.regions.gem.caption = 'GAME OVER <b>'; }, 'regions.gem.caption', undefined, 'markup caption');
rejects(m => { m.regions.crate.drops = ['hero']; }, 'regions.crate.drops[0]', /role pickup/, 'drop must be a pickup');
rejects(m => { m.regions.crate.drops = Array(17).fill('gem'); }, 'regions.crate.drops', /at most 16/, 'too many drops');
rejects(m => { m.regions.crate.break = 'missing'; }, 'regions.crate.break', /unknown clip/, 'break clip missing');
rejects(m => { m.regions.stage.scroll = 5; }, 'regions.stage.scroll', undefined, 'scroll factor range');
rejects(m => { m.regions.stage.scroll = Infinity; }, 'regions.stage.scroll', /finite/, 'infinite scroll');
rejects(m => { m.regions.stage.layer = 16; }, 'regions.stage.layer', undefined, 'layer range');
rejects(m => { m.regions.stage.loopWidth = 0; }, 'regions.stage.loopWidth', undefined, 'loop width range');
rejects(m => { m.regions.meter.part = 'gauge'; }, 'regions.meter.part', /one of/, 'unknown hud part');
rejects(m => { m.regions.meter.fill = 'inside-out'; }, 'regions.meter.fill', /one of/, 'unknown fill direction');
rejects(m => { m.regions.meter.segmentPitch = 0; }, 'regions.meter.segmentPitch', undefined, 'segment pitch range');
rejects(m => { m.regions.meter.ghost = 'red'; }, 'regions.meter.ghost', /#rrggbb/, 'ghost colour format');
rejects(m => { m.regions.wipe.direction = 'sideways'; }, 'regions.wipe.direction', /one of/, 'unknown transition direction');
rejects(m => { m.regions.wipe.beats = 0; }, 'regions.wipe.beats', undefined, 'zero transition beats');
rejects(m => { m.regions.menu.slots.list = [0, 0, 40, 40]; }, 'regions.menu.slots.list', /outside/, 'slot outside its screen');
rejects(m => { m.regions.menu.slots['Bad Slot'] = [0, 0, 1, 1]; }, 'regions.menu.slots', /ids/, 'bad slot name');
rejects(m => { m.regions.menu.cursors = [[40, 0]]; }, 'regions.menu.cursors[0][0]', undefined, 'cursor outside its screen');
rejects(m => { m.regions.menu.cursors = Array(33).fill([0, 0]); }, 'regions.menu.cursors', /at most 32/, 'too many cursors');
rejects(m => { m.regions['Bad Id'] = m.regions.gem; }, 'regions', /id/, 'bad region id');
rejects(m => { m.regions = []; }, 'regions', undefined, 'regions as an array');
rejects(m => { m.palettes.main.colors = []; }, 'palettes.main.colors', undefined, 'empty palette');
rejects(m => { m.palettes.main.colors[1] = 'blue'; }, 'palettes.main.colors[1]', /#rrggbb/, 'named colour');
rejects(m => { m.palettes.main.colors[1] = '#12345'; }, 'palettes.main.colors[1]', undefined, 'short colour');
rejects(m => { m.palettes.main.colors = Array(257).fill('#000000'); }, 'palettes.main.colors', undefined, 'too many colours');
rejects(m => { m.palettes.main.cycles[0].to = 9; }, 'palettes.main.cycles[0].to', undefined, 'cycle past the palette');
rejects(m => { m.palettes.main.cycles[0].to = 1; }, 'palettes.main.cycles[0].to', /greater than from/, 'empty cycle range');
rejects(m => { m.palettes.main.cycles[0].beats = 0; }, 'palettes.main.cycles[0].beats', undefined, 'zero cycle beats');
rejects(m => { m.palettes.main.cycles = Array(9).fill({ from: 0, to: 1, beats: 1 }); }, 'palettes.main.cycles', /at most 8/, 'too many cycles');
rejects(m => { m.palettes.main.zzz = 1; }, 'palettes.main.zzz', /unknown key/, 'unknown palette key');
rejects(m => { m.clips['hero-idle'].verb = 'levitate'; }, 'clips.hero-idle.verb', /one of/, 'unknown clip verb');
rejects(m => { delete m.clips['hero-idle'].verb; }, 'clips.hero-idle.verb', undefined, 'missing clip verb');
rejects(m => { m.clips['hero-idle'].zzz = 1; }, 'clips.hero-idle.zzz', /unknown key/, 'unknown clip key');
rejects(m => { m.clips['hero-idle'].loop = 'yes'; }, 'clips.hero-idle.loop', /true or false/, 'loop not a boolean');
rejects(m => { m.clips['hero-attack'].frames = ['missing']; m.clips['hero-attack'].hold = [3]; m.clips['hero-attack'].anchors = [[0, 0]]; }, 'clips.hero-attack.frames[0]', /unknown region/, 'clip frame names a missing region');
rejects(m => { m.clips['hero-attack'].frames = []; }, 'clips.hero-attack.frames', undefined, 'empty frame list');
rejects(m => { m.clips['hero-attack'].frames = Array(257).fill('hero-atk-0'); }, 'clips.hero-attack.frames', undefined, 'too many frames');
rejects(m => { m.clips['hero-attack'].frames = [5, 'hero-atk-1']; }, 'clips.hero-attack.frames[0]', /region id/, 'frame id not a string');
rejects(m => { m.clips['hero-idle'].frames = ['hero-atk-0']; }, 'clips.hero-idle', /exactly one of frames or strip/, 'both frames and strip');
rejects(m => { delete m.clips['hero-idle'].strip; }, 'clips.hero-idle', /exactly one of frames or strip/, 'neither frames nor strip');
rejects(m => { m.clips['hero-idle'].strip.count = 5; }, 'clips.hero-idle.strip.count', /divide/, 'strip width not divisible');
rejects(m => { m.clips['hero-idle'].strip.count = 0; }, 'clips.hero-idle.strip.count', undefined, 'zero strip count');
rejects(m => { m.clips['hero-idle'].strip.rect = [32, 0, 64, 16]; }, 'clips.hero-idle.strip.rect', /outside/, 'strip outside its atlas');
rejects(m => { m.clips['hero-idle'].strip.atlas = 'nope'; }, 'clips.hero-idle.strip.atlas', /unknown atlas/, 'strip atlas missing');
rejects(m => { m.clips['hero-idle'].strip.axis = 'z'; }, 'clips.hero-idle.strip.axis', /one of/, 'strip axis');
rejects(m => { m.clips['hero-idle'].strip.zzz = 1; }, 'clips.hero-idle.strip.zzz', /unknown key/, 'unknown strip key');
rejects(m => { m.clips['hero-idle'].hold = [6, 6]; }, 'clips.hero-idle.hold', /one entry per frame/, 'hold length mismatch');
rejects(m => { m.clips['hero-idle'].hold = [6, 6, 0, 6]; }, 'clips.hero-idle.hold[2]', undefined, 'zero hold');
rejects(m => { m.clips['hero-idle'].hold = [6, 6, 601, 6]; }, 'clips.hero-idle.hold[2]', undefined, 'huge hold');
rejects(m => { m.clips['hero-idle'].hold = 'x'; }, 'clips.hero-idle.hold', undefined, 'hold not a number');
rejects(m => { m.clips['hero-idle'].big = [4]; }, 'clips.hero-idle.big[0]', undefined, 'big frame past the clip');
rejects(m => { m.clips['hero-idle'].big = [1, 1]; }, 'clips.hero-idle.big[1]', /duplicate/, 'duplicate big frame');
rejects(m => { m.clips['hero-idle'].anchors = [[0, 0]]; }, 'clips.hero-idle.anchors', /one point per frame/, 'anchor count mismatch');
rejects(m => { m.clips['hero-idle'].anchors = [[0, 0], [0, 0], [0, 0], [16, 99]]; }, 'clips.hero-idle.anchors[3]', undefined, 'clip anchor outside its cell');
rejects(m => { m.clips['hero-idle'].palette = 'nope'; }, 'clips.hero-idle.palette', /unknown palette/, 'clip palette missing');
rejects(m => { m.clips['Bad Id'] = m.clips['hero-idle']; }, 'clips', /id/, 'bad clip id');
rejects(m => { m.fonts.digits.cell = [6]; }, 'fonts.digits.cell', undefined, 'short cell');
rejects(m => { m.fonts.digits.cell = [0, 8]; }, 'fonts.digits.cell[0]', undefined, 'zero cell');
rejects(m => { m.fonts.digits.columns = 1; }, 'fonts.digits.rect', /too small/, 'glyph grid does not fit its rect');
rejects(m => { m.fonts.digits.columns = 0; }, 'fonts.digits.columns', undefined, 'zero columns');
rejects(m => { m.fonts.digits.chars = '0123456788'; }, 'fonts.digits.chars', /repeat/, 'repeated glyph');
rejects(m => { m.fonts.digits.chars = '012345678\u0000'; }, 'fonts.digits.chars', /control/, 'control glyph');
rejects(m => { m.fonts.digits.chars = ''; }, 'fonts.digits.chars', undefined, 'no glyphs');
rejects(m => { m.fonts.digits.chars = 5; }, 'fonts.digits.chars', /string/, 'chars not a string');
rejects(m => { m.fonts.digits.advance = [6, 6]; }, 'fonts.digits.advance', /one entry per glyph/, 'advance length mismatch');
rejects(m => { m.fonts.digits.advance = -1; }, 'fonts.digits.advance', undefined, 'negative advance');
rejects(m => { m.fonts.digits.advance = 'x'; }, 'fonts.digits.advance', undefined, 'advance not numeric');
rejects(m => { m.fonts.digits.role = 'banner'; }, 'fonts.digits.role', /one of/, 'unknown font role');
rejects(m => { m.fonts.digits.baseline = 9; }, 'fonts.digits.baseline', undefined, 'baseline below the cell');
rejects(m => { m.fonts.digits.atlas = 'nope'; }, 'fonts.digits.atlas', /unknown atlas/, 'font atlas missing');
rejects(m => { m.fonts.digits.rect = [0, 0, 80, 16]; }, 'fonts.digits.rect', /outside/, 'font rect outside its atlas');
rejects(m => { m.fonts.digits.zzz = 1; }, 'fonts.digits.zzz', /unknown key/, 'unknown font key');
rejects(m => { m.fonts.digits.palette = 'nope'; }, 'fonts.digits.palette', /unknown palette/, 'font palette missing');
// Keys that JSON.parse can create as own properties must never reach a prototype. `__proto__` is not a legal id; `constructor` and friends
// are legal ids but only ever exist as own data, and lookups of names a pack does not define stay undefined.
{
  const inject = (name) => JSON.stringify(F.fixtureManifest()).replace('"regions":{', `"regions":{${JSON.stringify(name)}:{"role":"clip","atlas":"sprites","rect":[0,0,1,1]},`);
  const r = A.parseAssetPackManifest(inject('__proto__'));
  ok(r.manifest === null && r.issues.some(i => i.path.startsWith('regions.')), 'region id __proto__ rejected');
  for (const name of ['constructor', 'prototype']) {
    const own = A.parseAssetPackManifest(inject(name));
    ok(own.manifest && Object.hasOwn(own.manifest.regions, name), `region id ${name} is plain own data`);
    const pack = new A.AssetPack(own.manifest, new Map());
    ok(pack.region(name).role === 'clip' && pack.clip(name) === undefined && pack.font(name) === undefined && pack.palette(name) === undefined, `${name} resolves only where it is defined`);
  }
}
ok(({}).polluted === undefined && Object.prototype.hasOwnProperty.call(Object.prototype, '__proto__'), 'Object.prototype untouched');
{
  const raw = `{"format":"mpcaaavs-assets","version":1,"id":"p","name":"P","atlases":{"__proto__":{"file":"a.png","width":4,"height":4}}}`;
  ok(A.parseAssetPackManifest(raw).manifest === null, '__proto__ atlas rejected');
}

// parseAssetPackManifest: bytes and text
ok(A.parseAssetPackManifest('{').manifest === null && /JSON/.test(A.parseAssetPackManifest('{').issues[0].message), 'invalid JSON');
ok(A.parseAssetPackManifest(new Uint8Array([0xff, 0xfe, 0x7b])).manifest === null && /UTF-8/.test(A.parseAssetPackManifest(new Uint8Array([0xff, 0xfe, 0x7b])).issues[0].message), 'invalid UTF-8');
ok(A.parseAssetPackManifest(new Uint8Array(A.ASSET_PACK_LIMITS.manifestBytes + 1)).manifest === null, 'oversize manifest bytes');
ok(A.parseAssetPackManifest(new TextEncoder().encode(JSON.stringify(F.fixtureManifest()))).manifest !== null, 'manifest bytes parse');
ok(A.parseAssetPackManifest(new Uint8Array([0xef, 0xbb, 0xbf, ...new TextEncoder().encode(JSON.stringify(F.fixtureManifest()))])).manifest !== null, 'UTF-8 BOM tolerated');
{
  const r = A.checkAssetPackManifest({ ...F.fixtureManifest(), ...Object.fromEntries(Array.from({ length: 200 }, (_, i) => [`k${i}`, 1])) });
  ok(r.manifest === null && r.issues.length <= A.ASSET_PACK_LIMITS.issues, 'issue list is bounded');
}
eq(A.checkAssetPackManifest(F.fixtureManifest()), A.checkAssetPackManifest(F.fixtureManifest()), 'validation is deterministic');

// ---------------------------------------------------------------------------------------------------------------- path traversal
const BAD_PATHS = [
  '..', '../x.png', 'a/../x.png', 'a/..', './x.png', 'a/./x.png', '/x.png', '/etc/passwd', '//host/share/x.png', BS + 'x.png', `a${BS}x.png`, `..${BS}x.png`,
  'C:/x.png', 'C:x.png', `C:${BS}x.png`, 'c:', 'file:///x.png', 'http://host/x.png', 'https://host/x.png', 'data:image/png;base64,AAAA', 'javascript:alert(1)', 'blob:x',
  '%2e%2e/x.png', '..%2fx.png', '%2e%2e%2fx.png', 'a%2fb.png', 'a%00.png', 'x.png%20', 'a\u0000b.png', 'a\nb.png', 'a\tb.png', 'a\u007fb.png', 'a\u0085b.png', 'a\u2028b.png',
  '', ' ', ' x.png', 'x.png ', 'a b.png', 'a//b.png', 'a/', '/', '.hidden.png', 'a/.hidden.png', '.png', 'x.', 'x.png.', 'a./b.png', '~1.png', 'PROGRA~1/x.png', 'a?b.png', 'a#b.png',
  'a*.png', 'a|b.png', 'a<b.png', 'a"b.png', 'con', 'CON.png', 'aux.png', 'nul.png', 'NUL', 'com1.png', 'LPT9.txt', 'a/PRN.png', 'conin$', '\u2024\u2024/x.png', '\uff0e\uff0e/x.png', '\uff0fx.png',
  '\u202etxt.png', 'caf\u00e9.png', '\ud83d\ude00.png', 'a/b/c/d/e/f/g.png', 'x'.repeat(129), `${'x'.repeat(65)}.png`, 'a:b.png', 'a::$DATA',
];
for (const bad of BAD_PATHS) {
  ok(typeof A.packPathProblem(bad) === 'string', `packPathProblem rejects ${JSON.stringify(bad)}`);
  ok(!A.isPackPath(bad), `isPackPath rejects ${JSON.stringify(bad)}`);
  assert.throws(() => A.assetPackUrl('fixture-pack', bad, 'https://aaavs.invalid/mpc.html'), /Invalid asset pack path/, `assetPackUrl ${JSON.stringify(bad)}`); checks++;
}
for (const bad of [null, undefined, 5, {}, [], ['a.png'], true]) ok(A.packPathProblem(bad) === 'must be a string', `non-string path ${JSON.stringify(bad)}`);
for (const good of ['pack.json', 'atlas/sprites.png', 'a-b_c.d.png', 'a/b/c/d/e/f.png', 'A.PNG', '0.png', '_x.png', 'x'.repeat(60) + '.png']) ok(A.packPathProblem(good) === null && A.isPackPath(good), `good path ${good}`);
ok(A.packPathProblem('x.jpg', ['.png']) !== null && A.packPathProblem('.png', ['.png']) !== null && A.packPathProblem('x.PNG', ['.png']) === null, 'extension allowlist');
for (const bad of ['', '..', '../x', 'a/b', 'A', 'a b', 'a.b', '-x', 'con', 'NUL', 'x'.repeat(49), 'a%2f', BS + 'x', 'C:', null, 5]) ok(!A.isPackId(bad), `bad pack id ${JSON.stringify(bad)}`);
for (const good of ['fixture-pack', 'a', '0', 'pack-1', 'x'.repeat(48)]) ok(A.isPackId(good), `good pack id ${good}`);
for (const bad of ['..', 'a/b', 'A', '']) assert.throws(() => A.assetPackUrl(bad, 'pack.json', 'https://aaavs.invalid/mpc.html'), /pack id/, `assetPackUrl id ${bad}`), checks++;
eq(A.assetPackUrl('fixture-pack', 'atlas/sprites.png', 'https://aaavs.invalid/mpc.html'), 'https://aaavs.invalid/show-assets-private/fixture-pack/atlas/sprites.png', 'MPC host URL');
eq(A.assetPackUrl('fixture-pack', 'pack.json', 'http://127.0.0.1:8080/standalone.html?x=1#y'), 'http://127.0.0.1:8080/show-assets-private/fixture-pack/pack.json', 'Player URL ignores the page query and fragment');
eq(A.assetPackUrl('fixture-pack', 'pack.json', 'http://127.0.0.1:8080/app/'), 'http://127.0.0.1:8080/app/show-assets-private/fixture-pack/pack.json', 'URL is relative to the page directory');

// fetch adapter: never requests an invalid path, maps 404 to "not installed"
{
  const asked = [];
  const source = A.fetchPackSource('fixture-pack', 'https://aaavs.invalid/mpc.html', async (url, limit) => { asked.push([String(url), limit]); return new Uint8Array([1]); });
  for (const bad of BAD_PATHS.slice(0, 40)) await assert.rejects(source.read(bad, 10), /Invalid asset pack path/, `fetch source ${JSON.stringify(bad)}`), checks++;
  eq(asked, [], 'no request was made for any rejected path');
  eq([...await source.read('pack.json', 99)], [1], 'fetch source reads a good path');
  eq(asked, [['https://aaavs.invalid/show-assets-private/fixture-pack/pack.json', 99]], 'fetch source requests the pack URL with the byte limit');
  const missing = A.fetchPackSource('fixture-pack', 'https://aaavs.invalid/mpc.html', async () => { throw new Error('Local asset unavailable (HTTP 404)'); });
  await assert.rejects(missing.read('pack.json', 9), A.AssetPackMissingError, '404 is AssetPackMissingError'); checks++;
  const broken = A.fetchPackSource('fixture-pack', 'https://aaavs.invalid/mpc.html', async () => { throw new Error('Local asset unavailable (HTTP 500)'); });
  await assert.rejects(broken.read('pack.json', 9), e => !(e instanceof A.AssetPackMissingError), '500 is not "missing"'); checks++;
  assert.throws(() => A.fetchPackSource('../x', 'https://aaavs.invalid/mpc.html'), /pack id/); checks++;
  const memory = A.memoryPackSource('fixture-pack', { 'pack.json': 'x' });
  await assert.rejects(memory.read('../pack.json', 9), /Invalid asset pack path/); await assert.rejects(memory.read('nope.png', 9), A.AssetPackMissingError); await assert.rejects(memory.read('pack.json', 0), /budget/);
  eq([...await memory.read('pack.json', 9)], [120], 'memory source reads text'); checks += 3;
  const prototypeRead = A.memoryPackSource('fixture-pack', {});
  await assert.rejects(prototypeRead.read('constructor', 9), A.AssetPackMissingError, 'memory source ignores prototype names'); checks++;
}

// Node file adapter: same rules, plus symlinks and escapes
const scratch = mkdtempSync(path.join(tmpdir(), 'asset-pack-check-'));
try {
  const packDir = path.join(scratch, 'fixture-pack');
  mkdirSync(path.join(packDir, 'atlas'), { recursive: true });
  for (const [name, value] of Object.entries(F.fixtureFiles())) writeFileSync(path.join(packDir, name), value);
  writeFileSync(path.join(scratch, 'secret.txt'), 'outside the pack');
  symlinkSync(path.join(scratch, 'secret.txt'), path.join(packDir, 'link.txt'));
  symlinkSync(scratch, path.join(packDir, 'linkdir'));
  const fs = fsPackSource(A, packDir);
  eq(fs.packId, 'fixture-pack', 'fs source pack id');
  ok((await fs.read('pack.json', 1 << 20)).byteLength > 100, 'fs source reads the manifest');
  await assert.rejects(fs.read('nope.png', 9), A.AssetPackMissingError, 'fs source: missing file'); checks++;
  await assert.rejects(fs.read('atlas', 9), /regular file/, 'fs source: directory'); checks++;
  await assert.rejects(fs.read('link.txt', 99), /regular file/, 'fs source: symlinked file'); checks++;
  await assert.rejects(fs.read('linkdir/secret.txt', 99), /escaped|regular/, 'fs source: file through a symlinked directory'); checks++;
  await assert.rejects(fs.read('pack.json', 10), /budget/, 'fs source: byte limit'); checks++;
  for (const bad of BAD_PATHS.slice(0, 50)) await assert.rejects(fs.read(bad, 99), /Invalid asset pack path/, `fs source ${JSON.stringify(bad)}`), checks++;
  assert.throws(() => fsPackSource(A, path.join(scratch, 'Not A Pack')), /pack id/); checks++;

  // ------------------------------------------------------------------------------------------------------------ loader
  const loaded = await A.loadAssetPack(fs, { decode: fakeDecode });
  ok(loaded.status === 'loaded' && loaded.pack && loaded.issues.length === 0, `fixture pack loads from disk: ${JSON.stringify(loaded.issues)}`);
  ok(loaded.pack.hasImage('sprites') && loaded.pack.hasImage('ui') && !loaded.pack.hasImage('nope'), 'atlas images attached');
  const meta = await A.loadAssetPack(fs, { decode: null });
  ok(meta.status === 'loaded' && !meta.pack.hasImage('sprites') && meta.pack.region('hero'), 'metadata-only load (no decoder) still validates headers');
  ok((await A.loadAssetPackOrNull(fs, { decode: null })) !== null, 'loadAssetPackOrNull returns the pack');
  const emptyDir = path.join(scratch, 'absent-pack'); mkdirSync(emptyDir);
  const absent = await A.loadAssetPack(fsPackSource(A, emptyDir), { decode: fakeDecode });
  ok(absent.status === 'absent' && absent.pack === null && /not installed/.test(absent.issues[0].message), 'directory without a manifest is absent');
  ok(readdirSync(emptyDir).length === 0, 'loading never writes to the pack directory');
} finally { rmSync(scratch, { recursive: true, force: true }); }

const load = async (files, id = 'fixture-pack', options = { decode: fakeDecode }) => A.loadAssetPack(A.memoryPackSource(id, files), options);
const withManifest = (mutate) => { const m = F.fixtureManifest(); mutate(m); return { ...F.fixtureFiles(), 'pack.json': JSON.stringify(m) }; };
{
  const a = await load({}); ok(a.status === 'absent' && a.pack === null && a.issues.length === 1, 'missing pack is absent');
  eq(await A.loadAssetPackOrNull(A.memoryPackSource('fixture-pack', {}), { decode: fakeDecode }), null, 'missing pack gives null');
  const unreadable = await A.loadAssetPack({ packId: 'fixture-pack', read: async () => { throw new Error('disk on fire'); } });
  ok(unreadable.status === 'absent' && /unreadable/.test(unreadable.issues[0].message), 'unreadable manifest is absent, not a throw');
  const html = await A.loadAssetPack(A.fetchPackSource('fixture-pack', 'https://aaavs.invalid/mpc.html', async () => { throw new Error('Local asset unavailable (HTTP 404)'); }), { decode: fakeDecode });
  ok(html.status === 'absent', 'hosts that 404 the pack folder give absent');
  const badJson = await load({ 'pack.json': '{nope' }); ok(badJson.status === 'invalid' && /JSON/.test(badJson.issues[0].message), 'malformed JSON is invalid');
  const badManifest = await load(withManifest(m => { m.regions.hero.rect = [60, 60, 16, 16]; })); ok(badManifest.status === 'invalid' && badManifest.pack === null, 'invalid manifest is invalid');
  const wrongId = await load(F.fixtureFiles(), 'other-pack'); ok(wrongId.status === 'invalid' && wrongId.issues[0].path === 'id', 'manifest id must match its directory');
  const files = F.fixtureFiles();
  const noAtlas = await load({ 'pack.json': files['pack.json'], 'atlas/sprites.png': files['atlas/sprites.png'] });
  ok(noAtlas.status === 'invalid' && noAtlas.issues.some(i => i.path === 'atlases.ui.file' && /missing/.test(i.message)), 'missing atlas file');
  const notPng = await load({ ...files, 'atlas/ui.png': new TextEncoder().encode('GIF89a'.repeat(10)) });
  ok(notPng.status === 'invalid' && notPng.issues.some(i => i.path === 'atlases.ui.file'), 'atlas that is not a PNG');
  const wrongSize = await load({ ...files, 'atlas/ui.png': F.paintAtlas(32, 32, []) });
  ok(wrongSize.status === 'invalid' && wrongSize.issues.some(i => /declares 64x48/.test(i.message)), 'atlas size must match the manifest');
  const corruptCrc = Uint8Array.from(files['atlas/ui.png']); corruptCrc[20] ^= 1;
  const crcBad = await load({ ...files, 'atlas/ui.png': corruptCrc }); ok(crcBad.status === 'invalid' && /checksum/.test(crcBad.issues[0].message), 'PNG header checksum');
  const truncated = await load({ ...files, 'atlas/ui.png': files['atlas/ui.png'].subarray(0, 20) }); ok(truncated.status === 'invalid', 'truncated PNG');
  const undecodable = await load(files, 'fixture-pack', { decode: async () => { throw new Error('bad'); } }); ok(undecodable.status === 'invalid' && /decoded/.test(undecodable.issues[0].message), 'decoder failure is invalid, not a throw');
  const lying = await load(files, 'fixture-pack', { decode: async () => ({ width: 1, height: 1 }) }); ok(lying.status === 'invalid', 'decoded size must match');
  const huge = await load({ ...files, 'atlas/ui.png': new Uint8Array(A.ASSET_PACK_LIMITS.atlasBytes + 1) }); ok(huge.status === 'invalid', 'oversize atlas');
  const bigManifest = await load({ ...files, 'pack.json': new Uint8Array(A.ASSET_PACK_LIMITS.manifestBytes + 1) }); ok(bigManifest.status === 'absent' || bigManifest.status === 'invalid', 'oversize manifest never loads');
  const traversal = await load(withManifest(m => { m.atlases.ui.file = '../../../etc/passwd.png'; })); ok(traversal.status === 'invalid' && traversal.issues.some(i => i.path === 'atlases.ui.file'), 'traversal in a manifest atlas path is invalid');
  eq((await load(files)).status, 'loaded', 'good pack loads from memory');
}

// ---------------------------------------------------------------------------------------------------------------- stand-ins
class Recorder {
  constructor() { this.ops = []; this.globalAlpha = 1; this.globalCompositeOperation = 'source-over'; this.imageSmoothingEnabled = true; this.fillStyle = '#000'; this.strokeStyle = '#000'; this.lineWidth = 1; }
  record(name, args) { this.ops.push([name, ...args, this.globalAlpha, this.globalCompositeOperation, this.fillStyle, this.strokeStyle]); }
}
for (const name of ['save', 'restore', 'translate', 'scale', 'rotate', 'beginPath', 'moveTo', 'lineTo', 'closePath', 'arc', 'fillRect', 'strokeRect', 'fill', 'stroke', 'drawImage']) {
  Recorder.prototype[name] = function (...args) {
    if (name === 'save') (this.stack ??= []).push([this.globalAlpha, this.globalCompositeOperation, this.imageSmoothingEnabled]);
    if (name === 'restore') { const s = this.stack.pop(); [this.globalAlpha, this.globalCompositeOperation, this.imageSmoothingEnabled] = s; }
    for (const a of args) assert.ok(typeof a === 'number' ? Number.isFinite(a) : true, `${name} got a non-finite argument`);
    this.record(name, args);
  };
}
const clockTraps = () => {
  const saved = { random: Math.random, now: Date.now, perf: performance.now };
  const trap = (n) => () => { throw new Error(`${n} used while drawing`); };
  Math.random = trap('Math.random'); Date.now = trap('Date.now'); performance.now = trap('performance.now');
  return () => { Math.random = saved.random; Date.now = saved.now; performance.now = saved.perf; };
};
const draw = (pack, beat) => { const ctx = new Recorder(), restore = clockTraps(); try { const used = A.drawExamplePlate(ctx, pack, beat); return { ctx, used }; } finally { restore(); } };
const EXAMPLE_KEYS = ['stage', 'hero', 'note', 'spark', 'gem', 'meter'];
{
  const absent = draw(null, 3.25);
  eq(Object.keys(absent.used), EXAMPLE_KEYS, 'example plate draws every slot');
  ok(Object.values(absent.used).every(v => v === 'stand-in'), 'no pack: every slot is a stand-in');
  ok(absent.ctx.ops.length > 40 && absent.ctx.ops.every(op => op[0] !== 'drawImage'), 'no pack: only procedural shapes, no image draws');
  ok(absent.ctx.ops.filter(op => op[0] === 'save').length === absent.ctx.ops.filter(op => op[0] === 'restore').length, 'save and restore balance');
  ok(absent.ctx.globalAlpha === 1 && absent.ctx.globalCompositeOperation === 'source-over', 'context state restored');
  eq(draw(null, 3.25).ctx.ops, absent.ctx.ops, 'stand-in drawing is deterministic');
  ok(JSON.stringify(draw(null, 4).ctx.ops) !== JSON.stringify(draw(null, 5.5).ctx.ops), 'stand-ins animate with the beat');
  for (const beat of [0, 0.5, 1, 7.99, 8, 100, 12345.678]) draw(null, beat);
  for (const beat of [-1, 1e6]) draw(null, beat);
  checks += 9;

  const pack = await A.loadAssetPackOrNull(A.memoryPackSource('fixture-pack', F.fixtureFiles()), { decode: fakeDecode });
  const real = draw(pack, 3.25);
  eq(real.used, { stage: 'pack', hero: 'pack', note: 'pack', spark: 'pack', gem: 'pack', meter: 'pack' }, 'pack present: every slot uses its region');
  const images = real.ctx.ops.filter(op => op[0] === 'drawImage');
  ok(images.length >= 6, 'pack present: atlas regions are drawn');
  ok(real.ctx.ops.every(op => op[0] !== 'drawImage' || (Number.isFinite(op[2]) && op[4] > 0 && op[5] > 0)), 'image draws have sane sizes');
  eq(draw(pack, 3.25).ctx.ops, real.ctx.ops, 'pack drawing is deterministic');
  const sourceRects = [];
  for (const t of [0, 6, 12, 18, 24]) { const c = new Recorder(); A.drawSprite(c, pack, A.EXAMPLE_SLOTS.hero, 0, 0, { time: t }); sourceRects.push(c.ops.find(op => op[0] === 'drawImage').slice(2, 6)); }
  eq(sourceRects.map(r => r[0]), [0, 16, 32, 48, 0], 'the idle clip advances through its strip and loops');

  const metaPack = await A.loadAssetPackOrNull(A.memoryPackSource('fixture-pack', F.fixtureFiles()), { decode: null });
  ok(Object.values(draw(metaPack, 1).used).every(v => v === 'stand-in'), 'metadata-only pack falls back to stand-ins');
  eq(draw(metaPack, 1).ctx.ops, draw(null, 1).ctx.ops, 'metadata-only fallback is identical to the no-pack fallback');
  const invalid = await A.loadAssetPackOrNull(A.memoryPackSource('fixture-pack', { 'pack.json': '{' }), { decode: fakeDecode });
  eq(draw(invalid, 1).ctx.ops, draw(null, 1).ctx.ops, 'invalid pack falls back like an absent pack');
  const partialManifest = F.fixtureManifest(); delete partialManifest.regions.gem; delete partialManifest.regions.note.impact; delete partialManifest.regions.crate.drops;
  const partial = await A.loadAssetPackOrNull(A.memoryPackSource('fixture-pack', F.fixtureFiles(partialManifest)), { decode: fakeDecode });
  const p = draw(partial, 2); eq([p.used.gem, p.used.hero, p.used.note], ['stand-in', 'pack', 'pack'], 'a region the pack lacks falls back per slot');
  const wrongRole = A.drawSprite(new Recorder(), pack, { region: 'hero', role: 'effect', size: [16, 16] }, 0, 0);
  eq(wrongRole, 'stand-in', 'a region of another role is not used');
  eq([A.spriteSource(pack, { region: 'hero', role: 'actor', size: [1, 1] }), A.spriteSource(null, { region: 'hero', role: 'actor', size: [1, 1] }), A.spriteSource(pack, { region: 'zzz', role: 'actor', size: [1, 1] })], ['pack', 'stand-in', 'stand-in'], 'spriteSource reports the path');

  // Every role has a stand-in; hostile options never throw or emit non-finite numbers.
  for (const role of A.ASSET_ROLES) for (const options of [{}, { scale: 0 }, { scale: Number.NaN, time: Number.NaN, alpha: Number.NaN }, { width: 0, height: -5, fill: 7 }, { time: -50, flip: true, scale: 3, fill: -1 }, { width: 1e6, height: 1e6 }]) {
    const c = new Recorder(); const restore = clockTraps();
    try { eq(A.drawSprite(c, null, { region: 'x', role, size: [20, 30] }, 5, 7, options), 'stand-in', `${role} stand-in`); } finally { restore(); }
    ok(c.ops.length > 0, `${role} stand-in draws something`);
  }
  // Tone handling: a bad tone is ignored, a good one is used; neither depends on anything but the slot.
  const toned = new Recorder(); A.drawSprite(toned, null, { region: 'x', role: 'prop', size: [10, 10], tone: '#ff0000' }, 0, 0);
  ok(toned.ops.some(op => op.some(x => typeof x === 'string' && x.startsWith('rgba(255,0,0,'))), 'stand-in uses the slot tone');
  eq(A.hashString('abc'), A.hashString('abc'), 'hashString is stable'); ok(A.hashString('abc') !== A.hashString('abd'), 'hashString discriminates');

  // Nine-slice and meters with a real pack
  const nine = new Recorder(); A.drawSprite(nine, pack, { region: 'panel', role: 'hud', size: [24, 16] }, 10, 10, { width: 60, height: 30 });
  eq(nine.ops.filter(op => op[0] === 'drawImage').length, 9, 'nine-slice draws nine pieces');
  const dests = nine.ops.filter(op => op[0] === 'drawImage').map(op => [op[6], op[7], op[8], op[9]].map(v => v + 0));
  eq([dests[0], dests[8]], [[0, 0, 6, 6], [54, 24, 6, 6]], 'nine-slice corners keep their size');
  const bar = new Recorder(); A.drawSprite(bar, pack, { region: 'meter', role: 'hud', size: [32, 8] }, 0, 0, { fill: 0.5 });
  eq(bar.ops.find(op => op[0] === 'drawImage').slice(2, 10).map(v => v + 0), [8, 56, 16, 8, 0, 0, 16, 8], 'a half-full bar draws half of its region');
  const text = new Recorder(); const width = A.drawGlyphs(text, pack, 'digits', '12x', 0, 0, 12);
  eq([text.ops.filter(op => op[0] === 'drawImage').length, width], [2, 18], 'glyph text draws known glyphs and leaves a blank cell for unknown ones');
  const standText = new Recorder(); const standWidth = A.drawGlyphs(standText, null, 'digits', '12 x', 0, 0, 10);
  ok(standWidth > 0 && standText.ops.every(op => op[0] !== 'drawImage') && standText.ops.length > 4, 'procedural text without a pack');
  eq(A.drawGlyphs(new Recorder(), pack, 'missing-font', 'ab', 0, 0, 10), A.drawGlyphs(new Recorder(), null, 'digits', 'ab', 0, 0, 10), 'unknown font falls back to the procedural font');
}

// ---------------------------------------------------------------------------------------------------------------- source rules
{
  const dir = path.join(visualizer, 'src/asset-packs');
  for (const file of readdirSync(dir).filter(f => f.endsWith('.ts'))) {
    const code = readFileSync(path.join(dir, file), 'utf8').replace(/\/\*[\s\S]*?\*\//g, '').replace(/\/\/.*$/gm, '');
    ok(!/Math\.random|Date\.now|performance\.now|new Date\(|crypto\.getRandomValues|setTimeout|setInterval|requestAnimationFrame/.test(code), `${file}: no clock or randomness`);
  }
  for (const file of ['manifest.ts', 'paths.ts', 'png.ts', 'pack.ts', 'draw.ts']) {
    const code = readFileSync(path.join(dir, file), 'utf8');
    ok(!/\bfetch\(|node:|\bdocument\b|\bwindow\b/.test(code.replace(/\/\*[\s\S]*?\*\//g, '').replace(/\/\/.*$/gm, '')), `${file}: pure module`);
  }
}

// ---------------------------------------------------------------------------------------------------------------- repository rules
{
  const git = (...args) => execFileSync('git', args, { cwd: repo, encoding: 'utf8' });
  const ignored = (p) => { try { execFileSync('git', ['check-ignore', '-q', '--no-index', p], { cwd: repo }); return true; } catch { return false; } };
  for (const p of ['show-assets-private/x/pack.json', 'show-assets-private/x/atlas/a.png', 'visualizer/show-assets-private/x/pack.json', 'visualizer/show-assets-private/x/atlas/a.png']) ok(ignored(p), `${p} is git-ignored`);
  eq(git('ls-files', '--', 'show-assets-private', 'visualizer/show-assets-private').trim(), '', 'no tracked file under show-assets-private/');
  eq(git('ls-files', '--', '*show-assets-private*').trim(), '', 'no tracked file anywhere has show-assets-private in its path');
  const tracked = git('ls-files', '-z').split('\0').filter(Boolean);
  ok(!tracked.some(f => /(^|\/)(pack\.json|atlas)(\/|$)/i.test(f) && /asset-pack|show-assets/i.test(f) && !/^(visualizer\/(src|tools)\/|docs\/)/.test(f)), 'no pack manifests or atlases are tracked outside src, tools and docs');
  const doc = readFileSync(path.join(repo, 'docs/design/ASSET-PACK-MANIFEST.md'), 'utf8');
  for (const word of [...A.ASSET_ROLES, ...A.CLIP_VERBS, ...A.MOTION_MODELS, 'mpcaaavs-assets', 'show-assets-private', 'nine-slice', 'stand-in']) ok(doc.includes(word), `manifest doc covers ${word}`);
}
console.log(`Asset pack check PASS: ${checks} checks (manifest validation, path rejection, loader outcomes, procedural fallback, repository rules).`);
