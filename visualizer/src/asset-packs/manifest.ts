/** `mpcaaavs-assets` v1: the asset-pack manifest for private local sprite packs (docs/design/ASSET-PACK-MANIFEST.md).
 *
 * A pack is one `pack.json` plus PNG atlases in `show-assets-private/<pack-id>/`. The manifest names rectangles of atlas pixels
 * (regions) with the genre-neutral roles of docs/design/SPRITE-SHOW-KIT.md, animation strips (clips), glyph-grid fonts and
 * palettes. Pixels never live in the manifest.
 *
 * Pure module: no DOM, no clock, no randomness, no I/O. `checkAssetPackManifest` is a strict data-only validator: unknown keys,
 * wrong types, out-of-range numbers, rectangles outside their atlas, unresolved references, bad paths and duplicate ids are all
 * errors. On success the result is a normalized, deeply frozen manifest with every default filled in. */
import { isPackId, packPathProblem } from './paths.ts';

export const ASSET_PACK_FORMAT = 'mpcaaavs-assets';
export const ASSET_PACK_VERSION = 1;
export const ASSET_PACK_MANIFEST_FILE = 'pack.json';

export const ASSET_PACK_LIMITS = Object.freeze({
  manifestBytes: 512 * 1024, atlasBytes: 8 * 1024 * 1024, atlasDimension: 4096, atlases: 16, palettes: 16, paletteColors: 256, cycles: 8,
  regions: 4096, clips: 2048, fonts: 16, frames: 256, glyphs: 256, tags: 8, tagChars: 24, idChars: 64, nameChars: 48, captionChars: 24,
  hold: 600, big: 8, screenSlots: 32, cursors: 32, drops: 16, clipVerbsPerActor: 32, issues: 64, coordinate: 8192, parts: 8,
});

/** The eleven roles of SPRITE-SHOW-KIT.md. A region's `role` is one of these; `clip` marks a bare animation frame cell. */
export const ASSET_ROLES = ['actor', 'clip', 'projectile', 'effect', 'pickup', 'prop', 'background', 'hud', 'text', 'transition', 'screen'] as const;
export const CLIP_VERBS = ['idle', 'walk', 'run', 'dash', 'jump', 'fall', 'crouch', 'attack', 'special', 'super', 'cast', 'throw', 'guard', 'parry', 'hurt',
  'knockdown', 'die', 'spawn', 'enter', 'exit', 'taunt', 'pose', 'transform', 'swim', 'climb', 'hang', 'swing'] as const;
export const MOTION_MODELS = ['straight', 'arc', 'sine', 'boomerang', 'homing', 'bounce', 'spread', 'orbit', 'fall', 'rise', 'swoop', 'hover', 'pendulum'] as const;
export const ACTOR_CLASSES = ['hero', 'enemy', 'boss', 'npc', 'companion'] as const;
export const SIZE_CLASSES = ['tiny', 'small', 'medium', 'large', 'huge'] as const;
export const BLEND_MODES = ['normal', 'add', 'screen'] as const;
export const FACINGS = ['left', 'right'] as const;
export const FILL_DIRECTIONS = ['left-to-right', 'right-to-left', 'bottom-to-top', 'top-to-bottom'] as const;
export const HUD_PARTS = ['bar', 'counter', 'digits', 'box', 'emblem', 'banner', 'cursor'] as const;
export const TRANSITION_DIRECTIONS = ['in', 'out', 'left', 'right', 'up', 'down'] as const;
export const IMAGE_FILTERS = ['nearest', 'linear'] as const;
export const FONT_ROLES = ['hud', 'text'] as const;

export type AssetRole = typeof ASSET_ROLES[number];
export type ClipVerb = typeof CLIP_VERBS[number];
export type MotionModel = typeof MOTION_MODELS[number];
export type ActorClass = typeof ACTOR_CLASSES[number];
export type SizeClass = typeof SIZE_CLASSES[number];
export type BlendMode = typeof BLEND_MODES[number];
export type Facing = typeof FACINGS[number];
export type FillDirection = typeof FILL_DIRECTIONS[number];
export type HudPart = typeof HUD_PARTS[number];
export type TransitionDirection = typeof TRANSITION_DIRECTIONS[number];
export type ImageFilter = typeof IMAGE_FILTERS[number];
export type FontRole = typeof FONT_ROLES[number];

/** Pixels: `[x, y]` inside a region or cell, measured from its top-left corner. */
export type Point = readonly [x: number, y: number];
/** Atlas pixels: `[x, y, width, height]`. */
export type Rect = readonly [x: number, y: number, width: number, height: number];
export interface NineSlice { readonly left: number; readonly top: number; readonly right: number; readonly bottom: number }
/** `indexed` (optional, sprite layer): the PNG stores palette indices in its red channel (alpha = coverage) and regions or clips name the
 * palette that colours it; a different palette recolours the same art. Absent or false: the PNG is plain colour. */
export interface AtlasDef { readonly file: string; readonly width: number; readonly height: number; readonly filter: ImageFilter; readonly indexed?: boolean }
/** `beats` is the period of one full cycle of `from..to` (inclusive palette indices) in beats. */
export interface PaletteCycle { readonly from: number; readonly to: number; readonly beats: number }
export interface PaletteDef { readonly colors: readonly string[]; readonly cycles: readonly PaletteCycle[] }

export interface RegionCommon {
  readonly atlas: string;
  readonly rect: Rect;
  /** Anchor inside the region. Defaults: bottom-centre for actor, prop, pickup; centre for projectile, effect; top-left otherwise. */
  readonly anchor: Point;
  readonly palette?: string;
  readonly tags: readonly string[];
  /** Only on hud, text and screen regions. */
  readonly nineSlice?: NineSlice;
}
export interface ActorRegion extends RegionCommon {
  readonly role: 'actor'; readonly class: ActorClass; readonly size: SizeClass; readonly facing: Facing;
  /** verb to clip id; each clip's own `verb` must match. */
  readonly clips: Readonly<Partial<Record<ClipVerb, string>>>;
}
export interface ClipCellRegion extends RegionCommon { readonly role: 'clip' }
export interface ProjectileRegion extends RegionCommon {
  readonly role: 'projectile'; readonly motion: MotionModel; readonly spawn: Point; readonly clip?: string; readonly impact?: string;
}
export interface EffectRegion extends RegionCommon {
  readonly role: 'effect'; readonly blend: BlendMode; readonly duration: number; readonly scale: SizeClass; readonly clip?: string;
}
export interface PickupRegion extends RegionCommon { readonly role: 'pickup'; readonly idle?: string; readonly collect?: string; readonly caption?: string }
export interface PropRegion extends RegionCommon { readonly role: 'prop'; readonly idle?: string; readonly break?: string; readonly drops: readonly string[] }
export interface BackgroundRegion extends RegionCommon {
  readonly role: 'background'; readonly scroll: number; readonly layer: number; readonly loopWidth?: number; readonly tiles?: string;
}
export interface HudRegion extends RegionCommon {
  readonly role: 'hud'; readonly part: HudPart; readonly fill?: FillDirection; readonly segmentPitch?: number; readonly ghost?: string;
}
export interface TextRegion extends RegionCommon { readonly role: 'text' }
export interface TransitionRegion extends RegionCommon {
  readonly role: 'transition'; readonly beats: number; readonly direction: TransitionDirection; readonly clip?: string;
}
export interface ScreenRegion extends RegionCommon {
  /** `slots` are named rectangles inside the region; `cursors` are cursor positions inside the region. */
  readonly role: 'screen'; readonly slots: Readonly<Record<string, Rect>>; readonly cursors: readonly Point[];
}
export type Region = ActorRegion | ClipCellRegion | ProjectileRegion | EffectRegion | PickupRegion | PropRegion | BackgroundRegion | HudRegion
  | TextRegion | TransitionRegion | ScreenRegion;

/** A detached part of a clip (a weapon, a cape, a held prop) drawn beside the body frame with its own atlas rectangle per frame.
 * `rects[i]` is null when the part is absent in frame i; `offsets[i]` is the part rectangle's top-left relative to the body frame's
 * anchor (the feet), in unflipped pixels. Both have one entry per frame. */
export interface ClipPart {
  readonly atlas: string;
  readonly rects: readonly (Rect | null)[];
  readonly offsets: readonly (readonly [number, number])[];
  readonly layer: 'front' | 'back';
  readonly palette?: string;
}

/** One animation strip: `frames` (region ids) or `strip` (equal cells of one atlas rectangle, resolved to `cells`). */
export interface ClipDef {
  readonly verb: ClipVerb;
  readonly loop: boolean;
  /** Source frames each frame is shown, one entry per frame. */
  readonly hold: readonly number[];
  /** Frame indices where the release, impact or flash lands. */
  readonly big: readonly number[];
  readonly frames: readonly string[] | null;
  readonly strip: { readonly atlas: string; readonly rect: Rect; readonly count: number; readonly axis: 'x' | 'y' } | null;
  /** Per-frame anchors inside each frame; null uses each frame region's anchor (or bottom-centre for a strip). */
  readonly anchors: readonly Point[] | null;
  readonly palette?: string;
  readonly length: number;
  /** Optional (sprite layer): per-frame offset of the frame's atlas rectangle inside the untrimmed source frame. When present, `anchors` are
   * measured in the untrimmed frame (they may lie outside the trimmed rectangle), so the anchor inside the rectangle is `anchor - trim`. */
  readonly trims?: readonly Point[];
  /** Optional (sprite layer): detached parts by name. */
  readonly parts?: Readonly<Record<string, ClipPart>>;
}
export interface FontDef {
  readonly role: FontRole;
  readonly atlas: string;
  readonly rect: Rect;
  readonly cell: readonly [width: number, height: number];
  readonly columns: number;
  readonly chars: string;
  /** Horizontal advance per glyph, in `chars` order. */
  readonly advance: readonly number[];
  readonly lineHeight: number;
  readonly baseline: number;
  readonly palette?: string;
}

export interface AssetPackManifest {
  readonly format: typeof ASSET_PACK_FORMAT;
  readonly version: typeof ASSET_PACK_VERSION;
  readonly id: string;
  readonly name: string;
  readonly atlases: Readonly<Record<string, AtlasDef>>;
  readonly palettes: Readonly<Record<string, PaletteDef>>;
  readonly regions: Readonly<Record<string, Region>>;
  readonly clips: Readonly<Record<string, ClipDef>>;
  readonly fonts: Readonly<Record<string, FontDef>>;
}

export interface ManifestIssue { readonly level: 'error'; readonly path: string; readonly message: string }
export interface ManifestCheck { readonly manifest: AssetPackManifest | null; readonly issues: readonly ManifestIssue[] }

// ------------------------------------------------------------------------------------------------------------ validator plumbing
const ID = /^[a-z0-9][a-z0-9_-]{0,63}$/;
const NAME = /^[A-Za-z0-9][A-Za-z0-9 .,'&()+-]{0,47}$/;
const CAPTION = /^[A-Za-z0-9 .,'!?&()+-]{1,24}$/;
const COLOR = /^#[0-9a-fA-F]{6}(?:[0-9a-fA-F]{2})?$/;
const TAG = /^[a-z0-9][a-z0-9-]{0,23}$/;
const isRecord = (value: unknown): value is Record<string, unknown> => !!value && typeof value === 'object' && !Array.isArray(value);
const shown = (key: string): string => JSON.stringify(key.length > 32 ? `${key.slice(0, 32)}...` : key);
const inEnum = <V extends readonly string[]>(values: V, value: unknown): value is V[number] => typeof value === 'string' && (values as readonly string[]).includes(value);

class Checker {
  readonly issues: ManifestIssue[] = [];
  error(path: string, message: string): void {
    if (this.issues.length < ASSET_PACK_LIMITS.issues) this.issues.push({ level: 'error', path, message });
  }
  /** Reports every key of `value` not in `allowed`. */
  keys(value: Record<string, unknown>, path: string, allowed: readonly string[]): void {
    for (const key of Object.keys(value)) if (!allowed.includes(key)) this.error(path ? `${path}.${key.length > 32 ? key.slice(0, 32) : key}` : key, `unknown key ${shown(key)}`);
  }
  int(value: unknown, path: string, min: number, max: number): number | null {
    if (typeof value !== 'number' || !Number.isInteger(value)) { this.error(path, 'must be an integer'); return null; }
    if (value < min || value > max) { this.error(path, `must be between ${min} and ${max}`); return null; }
    return value;
  }
  num(value: unknown, path: string, min: number, max: number): number | null {
    if (typeof value !== 'number' || !Number.isFinite(value)) { this.error(path, 'must be a finite number'); return null; }
    if (value < min || value > max) { this.error(path, `must be between ${min} and ${max}`); return null; }
    return value;
  }
  bool(value: unknown, path: string): boolean | null {
    if (typeof value !== 'boolean') { this.error(path, 'must be true or false'); return null; }
    return value;
  }
  oneOf<V extends readonly string[]>(value: unknown, path: string, values: V): V[number] | null {
    if (!inEnum(values, value)) { this.error(path, `must be one of ${values.join(', ')}`); return null; }
    return value;
  }
  record(value: unknown, path: string): Record<string, unknown> | null {
    if (!isRecord(value)) { this.error(path || '(root)', 'must be an object'); return null; }
    return value;
  }
  id(key: string, path: string): boolean {
    if (!ID.test(key)) { this.error(path, `id ${shown(key)} must be 1-64 characters of a-z, 0-9, hyphen, underscore, starting with a letter or digit`); return false; }
    return true;
  }
  point(value: unknown, path: string, width: number, height: number): Point | null {
    if (!Array.isArray(value) || value.length !== 2) { this.error(path, 'must be [x, y]'); return null; }
    const x = this.int(value[0], `${path}[0]`, 0, width), y = this.int(value[1], `${path}[1]`, 0, height);
    return x === null || y === null ? null : Object.freeze([x, y]) as Point;
  }
  /** A rectangle of at least 1x1 whose extent must lie within `width` x `height`. */
  rect(value: unknown, path: string, width: number, height: number): Rect | null {
    if (!Array.isArray(value) || value.length !== 4) { this.error(path, 'must be [x, y, width, height]'); return null; }
    const [vx, vy, vw, vh] = value as unknown[];
    const x = this.int(vx, `${path}[0]`, 0, ASSET_PACK_LIMITS.atlasDimension), y = this.int(vy, `${path}[1]`, 0, ASSET_PACK_LIMITS.atlasDimension);
    const w = this.int(vw, `${path}[2]`, 1, ASSET_PACK_LIMITS.atlasDimension), h = this.int(vh, `${path}[3]`, 1, ASSET_PACK_LIMITS.atlasDimension);
    if (x === null || y === null || w === null || h === null) return null;
    if (x + w > width || y + h > height) { this.error(path, `extends outside its ${width}x${height} area`); return null; }
    return Object.freeze([x, y, w, h]) as Rect;
  }
  color(value: unknown, path: string): string | null {
    if (typeof value !== 'string' || !COLOR.test(value)) { this.error(path, 'must be #rrggbb or #rrggbbaa'); return null; }
    return value.toLowerCase();
  }
}

const freeze = <T>(value: T): T => {
  if (value && typeof value === 'object' && !Object.isFrozen(value)) { Object.freeze(value); for (const child of Object.values(value)) freeze(child); }
  return value;
};

/** Region fields that every role accepts, then the ones each role adds. */
const COMMON_KEYS = ['role', 'atlas', 'rect', 'anchor', 'palette', 'tags', 'nineSlice'] as const;
const ROLE_KEYS: Readonly<Record<AssetRole, readonly string[]>> = {
  actor: ['class', 'size', 'facing', 'clips'], clip: [], projectile: ['motion', 'spawn', 'clip', 'impact'], effect: ['blend', 'duration', 'scale', 'clip'],
  pickup: ['idle', 'collect', 'caption'], prop: ['idle', 'break', 'drops'], background: ['scroll', 'layer', 'loopWidth', 'tiles'],
  hud: ['part', 'fill', 'segmentPitch', 'ghost'], text: [], transition: ['beats', 'direction', 'clip'], screen: ['slots', 'cursors'],
};
const NINE_SLICE_ROLES: readonly AssetRole[] = ['hud', 'text', 'screen'];
const defaultAnchor = (role: AssetRole, w: number, h: number): Point => {
  if (role === 'actor' || role === 'prop' || role === 'pickup') return [w >> 1, h];
  if (role === 'projectile' || role === 'effect') return [w >> 1, h >> 1];
  return [0, 0];
};

interface PendingRef { readonly path: string; readonly kind: 'clip' | 'effect' | 'pickup'; readonly id: string }

/** Validates a parsed JSON value. Never throws; `manifest` is null exactly when `issues` is not empty. */
export function checkAssetPackManifest(input: unknown): ManifestCheck {
  const c = new Checker();
  const root = c.record(input, '');
  if (!root) return { manifest: null, issues: c.issues };
  c.keys(root, '', ['format', 'version', 'id', 'name', 'atlases', 'palettes', 'regions', 'clips', 'fonts']);
  if (root.format !== ASSET_PACK_FORMAT) c.error('format', `must be ${JSON.stringify(ASSET_PACK_FORMAT)}`);
  if (root.version !== ASSET_PACK_VERSION) c.error('version', `unsupported version; this build reads version ${ASSET_PACK_VERSION}`);
  if (!isPackId(root.id)) c.error('id', 'must be 1-48 characters of a-z, 0-9 and hyphen, starting with a letter or digit');
  if (typeof root.name !== 'string' || !NAME.test(root.name)) c.error('name', `must be a neutral display name of 1-${ASSET_PACK_LIMITS.nameChars} letters, digits, spaces and . , ' & ( ) + -`);

  // ---- atlases
  const atlases: Record<string, AtlasDef> = {};
  const files = new Set<string>();
  const atlasSource = c.record(root.atlases, 'atlases');
  if (atlasSource) {
    const names = Object.keys(atlasSource);
    if (names.length === 0) c.error('atlases', 'must define at least one atlas');
    if (names.length > ASSET_PACK_LIMITS.atlases) c.error('atlases', `at most ${ASSET_PACK_LIMITS.atlases} atlases`);
    for (const name of names.slice(0, ASSET_PACK_LIMITS.atlases)) {
      const path = `atlases.${name.slice(0, 32)}`;
      if (!c.id(name, path)) continue;
      const item = c.record(atlasSource[name], path);
      if (!item) continue;
      c.keys(item, path, ['file', 'width', 'height', 'filter', 'indexed']);
      const problem = packPathProblem(item.file, ['.png']);
      if (problem) c.error(`${path}.file`, problem);
      else if (files.has((item.file as string).toLowerCase())) c.error(`${path}.file`, 'is used by another atlas');
      else files.add((item.file as string).toLowerCase());
      const width = c.int(item.width, `${path}.width`, 1, ASSET_PACK_LIMITS.atlasDimension), height = c.int(item.height, `${path}.height`, 1, ASSET_PACK_LIMITS.atlasDimension);
      const filter = item.filter === undefined ? 'nearest' : c.oneOf(item.filter, `${path}.filter`, IMAGE_FILTERS);
      const indexed = item.indexed === undefined ? false : c.bool(item.indexed, `${path}.indexed`);
      if (!problem && width !== null && height !== null && filter !== null && indexed !== null) atlases[name] = { file: item.file as string, width, height, filter, ...(indexed ? { indexed: true } : {}) };
    }
  }

  // ---- palettes
  const palettes: Record<string, PaletteDef> = {};
  if (root.palettes !== undefined) {
    const source = c.record(root.palettes, 'palettes');
    if (source) {
      const names = Object.keys(source);
      if (names.length > ASSET_PACK_LIMITS.palettes) c.error('palettes', `at most ${ASSET_PACK_LIMITS.palettes} palettes`);
      for (const name of names.slice(0, ASSET_PACK_LIMITS.palettes)) {
        const path = `palettes.${name.slice(0, 32)}`;
        if (!c.id(name, path)) continue;
        const item = c.record(source[name], path);
        if (!item) continue;
        c.keys(item, path, ['colors', 'cycles']);
        const colors: string[] = [];
        if (!Array.isArray(item.colors) || item.colors.length < 1 || item.colors.length > ASSET_PACK_LIMITS.paletteColors) c.error(`${path}.colors`, `must be a list of 1-${ASSET_PACK_LIMITS.paletteColors} colours`);
        else item.colors.forEach((color, index) => { const value = c.color(color, `${path}.colors[${index}]`); if (value !== null) colors.push(value); });
        const cycles: PaletteCycle[] = [];
        if (item.cycles !== undefined) {
          if (!Array.isArray(item.cycles) || item.cycles.length > ASSET_PACK_LIMITS.cycles) c.error(`${path}.cycles`, `must be a list of at most ${ASSET_PACK_LIMITS.cycles} cycles`);
          else item.cycles.forEach((cycle, index) => {
            const where = `${path}.cycles[${index}]`, entry = c.record(cycle, where);
            if (!entry) return;
            c.keys(entry, where, ['from', 'to', 'beats']);
            const last = Math.max(0, colors.length - 1);
            const from = c.int(entry.from, `${where}.from`, 0, last), to = c.int(entry.to, `${where}.to`, 0, last), beats = c.num(entry.beats, `${where}.beats`, 0.25, 64);
            if (from !== null && to !== null && to <= from) c.error(`${where}.to`, 'must be greater than from');
            else if (from !== null && to !== null && beats !== null) cycles.push({ from, to, beats });
          });
        }
        if (colors.length === (Array.isArray(item.colors) ? item.colors.length : -1)) palettes[name] = { colors, cycles };
      }
    }
  }

  // ---- regions
  const regions: Record<string, Region> = {};
  const pending: PendingRef[] = [];
  const regionSource = root.regions === undefined ? {} : c.record(root.regions, 'regions');
  const ids = new Set<string>();
  if (regionSource) {
    const names = Object.keys(regionSource);
    if (names.length > ASSET_PACK_LIMITS.regions) c.error('regions', `at most ${ASSET_PACK_LIMITS.regions} regions`);
    for (const name of names.slice(0, ASSET_PACK_LIMITS.regions)) {
      const path = `regions.${name.slice(0, 32)}`;
      ids.add(name);
      if (!c.id(name, path)) continue;
      const item = c.record(regionSource[name], path);
      if (!item) continue;
      const role = c.oneOf(item.role, `${path}.role`, ASSET_ROLES);
      if (role === null) continue;
      c.keys(item, path, [...COMMON_KEYS, ...ROLE_KEYS[role]]);
      const region = checkRegion(c, item, role, path, atlases, palettes, pending);
      if (region) regions[name] = region;
    }
  }

  // ---- clips
  const clips: Record<string, ClipDef> = {};
  if (root.clips !== undefined) {
    const source = c.record(root.clips, 'clips');
    if (source) {
      const names = Object.keys(source);
      if (names.length > ASSET_PACK_LIMITS.clips) c.error('clips', `at most ${ASSET_PACK_LIMITS.clips} clips`);
      for (const name of names.slice(0, ASSET_PACK_LIMITS.clips)) {
        const path = `clips.${name.slice(0, 32)}`;
        if (!c.id(name, path)) continue;
        const clip = checkClip(c, source[name], path, atlases, palettes, ids, regions);
        if (clip) clips[name] = clip;
      }
    }
  }
  const clipIds = new Set(root.clips !== undefined && isRecord(root.clips) ? Object.keys(root.clips) : []);

  // ---- fonts
  const fonts: Record<string, FontDef> = {};
  if (root.fonts !== undefined) {
    const source = c.record(root.fonts, 'fonts');
    if (source) {
      const names = Object.keys(source);
      if (names.length > ASSET_PACK_LIMITS.fonts) c.error('fonts', `at most ${ASSET_PACK_LIMITS.fonts} fonts`);
      for (const name of names.slice(0, ASSET_PACK_LIMITS.fonts)) {
        const path = `fonts.${name.slice(0, 32)}`;
        if (!c.id(name, path)) continue;
        const font = checkFont(c, source[name], path, atlases, palettes);
        if (font) fonts[name] = font;
      }
    }
  }

  // ---- references from regions to clips and other regions, resolved once every table exists
  for (const ref of pending) {
    if (ref.kind === 'clip') { if (!clipIds.has(ref.id)) c.error(ref.path, `refers to unknown clip ${shown(ref.id)}`); }
    else if (!ids.has(ref.id)) c.error(ref.path, `refers to unknown region ${shown(ref.id)}`);
    else if (regions[ref.id] && regions[ref.id]!.role !== ref.kind) c.error(ref.path, `region ${shown(ref.id)} must have role ${ref.kind}`);
  }
  for (const [name, region] of Object.entries(regions)) {
    if (region.role !== 'actor') continue;
    for (const [verb, clipId] of Object.entries(region.clips)) {
      const clip = clips[clipId!];
      if (clip && clip.verb !== verb) c.error(`regions.${name}.clips.${verb}`, `clip ${shown(clipId!)} has verb ${clip.verb}, not ${verb}`);
    }
  }

  if (c.issues.length > 0) return { manifest: null, issues: c.issues };
  const manifest: AssetPackManifest = freeze({
    format: ASSET_PACK_FORMAT, version: ASSET_PACK_VERSION, id: root.id as string, name: root.name as string, atlases, palettes, regions, clips, fonts,
  });
  return { manifest, issues: [] };
}

function checkRegion(c: Checker, item: Record<string, unknown>, role: AssetRole, path: string, atlases: Record<string, AtlasDef>, palettes: Record<string, PaletteDef>, pending: PendingRef[]): Region | null {
  const before = c.issues.length;
  const atlasId = typeof item.atlas === 'string' ? item.atlas : '';
  const atlas = Object.hasOwn(atlases, atlasId) ? atlases[atlasId]! : null;
  if (!atlas) c.error(`${path}.atlas`, typeof item.atlas === 'string' ? `refers to unknown atlas ${shown(item.atlas)}` : 'must name an atlas');
  const rect = atlas ? c.rect(item.rect, `${path}.rect`, atlas.width, atlas.height) : null;
  if (!atlas && item.rect === undefined) c.error(`${path}.rect`, 'is required');
  const anchor = rect === null ? null : item.anchor === undefined ? defaultAnchor(role, rect[2], rect[3]) : c.point(item.anchor, `${path}.anchor`, rect[2], rect[3]);
  let palette: string | undefined;
  if (item.palette !== undefined) {
    if (typeof item.palette === 'string' && Object.hasOwn(palettes, item.palette)) palette = item.palette;
    else c.error(`${path}.palette`, 'refers to an unknown palette');
  }
  const tags = tagList(c, item.tags, `${path}.tags`);
  let nineSlice: NineSlice | undefined;
  if (item.nineSlice !== undefined) {
    if (!NINE_SLICE_ROLES.includes(role)) c.error(`${path}.nineSlice`, `is only valid on ${NINE_SLICE_ROLES.join(', ')} regions`);
    else if (rect) {
      const where = `${path}.nineSlice`, slice = c.record(item.nineSlice, where);
      if (slice) {
        c.keys(slice, where, ['left', 'top', 'right', 'bottom']);
        const left = c.int(slice.left, `${where}.left`, 0, rect[2]), right = c.int(slice.right, `${where}.right`, 0, rect[2]);
        const top = c.int(slice.top, `${where}.top`, 0, rect[3]), bottom = c.int(slice.bottom, `${where}.bottom`, 0, rect[3]);
        if (left !== null && right !== null && left + right >= rect[2]) c.error(where, 'left + right margins must leave a centre column');
        else if (top !== null && bottom !== null && top + bottom >= rect[3]) c.error(where, 'top + bottom margins must leave a centre row');
        else if (left !== null && right !== null && top !== null && bottom !== null) nineSlice = { left, top, right, bottom };
      }
    }
  }
  const clipRef = (key: string): string | undefined => {
    if (item[key] === undefined) return undefined;
    if (typeof item[key] !== 'string' || !ID.test(item[key] as string)) { c.error(`${path}.${key}`, 'must be a clip id'); return undefined; }
    pending.push({ path: `${path}.${key}`, kind: 'clip', id: item[key] as string });
    return item[key] as string;
  };
  const regionRef = (key: string, kind: 'effect' | 'pickup', value: unknown = item[key], where = `${path}.${key}`): string | undefined => {
    if (value === undefined) return undefined;
    if (typeof value !== 'string' || !ID.test(value)) { c.error(where, `must be the id of a ${kind} region`); return undefined; }
    pending.push({ path: where, kind, id: value });
    return value;
  };
  const optional = <T>(key: string, read: (value: unknown, where: string) => T | null): T | undefined => {
    if (item[key] === undefined) return undefined;
    return read(item[key], `${path}.${key}`) ?? undefined;
  };
  let extra: Record<string, unknown> = {};
  switch (role) {
    case 'actor': {
      const clips: Partial<Record<ClipVerb, string>> = {};
      if (item.clips !== undefined) {
        const where = `${path}.clips`, table = c.record(item.clips, where);
        if (table) {
          const verbs = Object.keys(table);
          if (verbs.length > ASSET_PACK_LIMITS.clipVerbsPerActor) c.error(where, `at most ${ASSET_PACK_LIMITS.clipVerbsPerActor} verbs`);
          for (const verb of verbs.slice(0, ASSET_PACK_LIMITS.clipVerbsPerActor)) {
            if (!inEnum(CLIP_VERBS, verb)) { c.error(`${where}.${verb.slice(0, 32)}`, `unknown clip verb ${shown(verb)}`); continue; }
            const id = table[verb];
            if (typeof id !== 'string' || !ID.test(id)) { c.error(`${where}.${verb}`, 'must be a clip id'); continue; }
            pending.push({ path: `${where}.${verb}`, kind: 'clip', id });
            clips[verb] = id;
          }
        }
      }
      extra = {
        class: c.oneOf(item.class, `${path}.class`, ACTOR_CLASSES),
        size: item.size === undefined ? 'medium' : c.oneOf(item.size, `${path}.size`, SIZE_CLASSES),
        facing: item.facing === undefined ? 'right' : c.oneOf(item.facing, `${path}.facing`, FACINGS), clips,
      };
      break;
    }
    case 'clip': break;
    case 'projectile':
      extra = {
        motion: c.oneOf(item.motion, `${path}.motion`, MOTION_MODELS),
        spawn: rect === null ? null : item.spawn === undefined ? [0, 0] : c.point(item.spawn, `${path}.spawn`, ASSET_PACK_LIMITS.coordinate, ASSET_PACK_LIMITS.coordinate),
        clip: clipRef('clip'), impact: regionRef('impact', 'effect'),
      };
      break;
    case 'effect':
      extra = {
        blend: item.blend === undefined ? 'normal' : c.oneOf(item.blend, `${path}.blend`, BLEND_MODES),
        duration: item.duration === undefined ? 12 : c.int(item.duration, `${path}.duration`, 1, ASSET_PACK_LIMITS.hold),
        scale: item.scale === undefined ? 'medium' : c.oneOf(item.scale, `${path}.scale`, SIZE_CLASSES), clip: clipRef('clip'),
      };
      break;
    case 'pickup':
      extra = {
        idle: clipRef('idle'), collect: regionRef('collect', 'effect'),
        caption: optional('caption', (value, where) => { if (typeof value !== 'string' || !CAPTION.test(value)) { c.error(where, `must be 1-${ASSET_PACK_LIMITS.captionChars} plain characters`); return null; } return value; }),
      };
      break;
    case 'prop': {
      const drops: string[] = [];
      if (item.drops !== undefined) {
        if (!Array.isArray(item.drops) || item.drops.length > ASSET_PACK_LIMITS.drops) c.error(`${path}.drops`, `must be a list of at most ${ASSET_PACK_LIMITS.drops} pickup region ids`);
        else item.drops.forEach((value, index) => { const id = regionRef('drops', 'pickup', value, `${path}.drops[${index}]`); if (id !== undefined) drops.push(id); });
      }
      extra = { idle: clipRef('idle'), break: clipRef('break'), drops };
      break;
    }
    case 'background':
      extra = {
        scroll: item.scroll === undefined ? 1 : c.num(item.scroll, `${path}.scroll`, 0, 4),
        layer: item.layer === undefined ? 0 : c.int(item.layer, `${path}.layer`, 0, 15),
        loopWidth: optional('loopWidth', (value, where) => c.int(value, where, 1, ASSET_PACK_LIMITS.coordinate)), tiles: clipRef('tiles'),
      };
      break;
    case 'hud':
      extra = {
        part: item.part === undefined ? 'box' : c.oneOf(item.part, `${path}.part`, HUD_PARTS),
        fill: optional('fill', (value, where) => c.oneOf(value, where, FILL_DIRECTIONS)),
        segmentPitch: optional('segmentPitch', (value, where) => c.int(value, where, 1, 256)),
        ghost: optional('ghost', (value, where) => c.color(value, where)),
      };
      break;
    case 'text': break;
    case 'transition':
      extra = {
        beats: item.beats === undefined ? 1 : c.num(item.beats, `${path}.beats`, 0.25, 64),
        direction: item.direction === undefined ? 'in' : c.oneOf(item.direction, `${path}.direction`, TRANSITION_DIRECTIONS), clip: clipRef('clip'),
      };
      break;
    case 'screen': {
      const slots: Record<string, Rect> = {};
      const cursors: Point[] = [];
      if (rect) {
        if (item.slots !== undefined) {
          const where = `${path}.slots`, table = c.record(item.slots, where);
          if (table) {
            const names = Object.keys(table);
            if (names.length > ASSET_PACK_LIMITS.screenSlots) c.error(where, `at most ${ASSET_PACK_LIMITS.screenSlots} slots`);
            for (const slot of names.slice(0, ASSET_PACK_LIMITS.screenSlots)) {
              if (!ID.test(slot)) { c.error(`${where}.${slot.slice(0, 32)}`, 'slot names must be ids'); continue; }
              const value = c.rect(table[slot], `${where}.${slot}`, rect[2], rect[3]);
              if (value) slots[slot] = value;
            }
          }
        }
        if (item.cursors !== undefined) {
          if (!Array.isArray(item.cursors) || item.cursors.length > ASSET_PACK_LIMITS.cursors) c.error(`${path}.cursors`, `must be a list of at most ${ASSET_PACK_LIMITS.cursors} points`);
          else item.cursors.forEach((value, index) => { const point = c.point(value, `${path}.cursors[${index}]`, rect[2], rect[3]); if (point) cursors.push(point); });
        }
      }
      extra = { slots, cursors };
      break;
    }
  }
  if (c.issues.length > before || rect === null || anchor === null || !atlas) return null;
  const common: Record<string, unknown> = { role, atlas: atlasId, rect, anchor, tags };
  if (palette !== undefined) common.palette = palette;
  if (nineSlice !== undefined) common.nineSlice = nineSlice;
  for (const [key, value] of Object.entries(extra)) if (value !== undefined) common[key] = value;
  return common as unknown as Region;
}

function tagList(c: Checker, value: unknown, path: string): readonly string[] {
  if (value === undefined) return [];
  if (!Array.isArray(value) || value.length > ASSET_PACK_LIMITS.tags) { c.error(path, `must be a list of at most ${ASSET_PACK_LIMITS.tags} tags`); return []; }
  const tags: string[] = [];
  value.forEach((tag, index) => {
    if (typeof tag !== 'string' || !TAG.test(tag)) c.error(`${path}[${index}]`, `must be a tag of 1-${ASSET_PACK_LIMITS.tagChars} characters of a-z, 0-9, hyphen`);
    else if (tags.includes(tag)) c.error(`${path}[${index}]`, 'duplicate tag');
    else tags.push(tag);
  });
  return tags;
}

function checkClip(c: Checker, value: unknown, path: string, atlases: Record<string, AtlasDef>, palettes: Record<string, PaletteDef>, regionIds: ReadonlySet<string>, regions: Record<string, Region>): ClipDef | null {
  const before = c.issues.length;
  const item = c.record(value, path);
  if (!item) return null;
  c.keys(item, path, ['verb', 'loop', 'hold', 'big', 'frames', 'strip', 'anchors', 'palette', 'trims', 'parts']);
  const verb = c.oneOf(item.verb, `${path}.verb`, CLIP_VERBS);
  const loop = item.loop === undefined ? false : c.bool(item.loop, `${path}.loop`);
  if ((item.frames === undefined) === (item.strip === undefined)) c.error(path, 'needs exactly one of frames or strip');
  let length = 0;
  let frames: string[] | null = null;
  let strip: ClipDef['strip'] = null;
  /** Width and height of each frame, for anchor checks. */
  const cells: Array<readonly [number, number]> = [];
  if (item.frames !== undefined) {
    if (!Array.isArray(item.frames) || item.frames.length < 1 || item.frames.length > ASSET_PACK_LIMITS.frames) c.error(`${path}.frames`, `must be a list of 1-${ASSET_PACK_LIMITS.frames} region ids`);
    else {
      frames = [];
      item.frames.forEach((frame, index) => {
        const where = `${path}.frames[${index}]`;
        if (typeof frame !== 'string' || !ID.test(frame)) { c.error(where, 'must be a region id'); return; }
        if (!regionIds.has(frame)) { c.error(where, `refers to unknown region ${shown(frame)}`); return; }
        frames!.push(frame);
        const region = regions[frame];
        cells.push(region ? [region.rect[2], region.rect[3]] : [ASSET_PACK_LIMITS.coordinate, ASSET_PACK_LIMITS.coordinate]);
      });
      length = item.frames.length;
    }
  }
  if (item.strip !== undefined) {
    const where = `${path}.strip`, source = c.record(item.strip, where);
    if (source) {
      c.keys(source, where, ['atlas', 'rect', 'count', 'axis']);
      const atlasId = typeof source.atlas === 'string' ? source.atlas : '';
      const atlas = Object.hasOwn(atlases, atlasId) ? atlases[atlasId]! : null;
      if (!atlas) c.error(`${where}.atlas`, 'refers to an unknown atlas');
      const rect = atlas ? c.rect(source.rect, `${where}.rect`, atlas.width, atlas.height) : null;
      const count = c.int(source.count, `${where}.count`, 1, ASSET_PACK_LIMITS.frames);
      const axis = source.axis === undefined ? 'x' : c.oneOf(source.axis, `${where}.axis`, ['x', 'y'] as const);
      if (rect && count !== null && axis !== null) {
        const span = axis === 'x' ? rect[2] : rect[3];
        if (span % count !== 0) c.error(`${where}.count`, `must divide the strip ${axis === 'x' ? 'width' : 'height'} ${span} evenly`);
        else {
          strip = { atlas: atlasId, rect, count, axis };
          length = count;
          for (let i = 0; i < count; i++) cells.push(axis === 'x' ? [span / count, rect[3]] : [rect[2], span / count]);
        }
      }
    }
  }
  let hold: number[] = [];
  const holdFrom = (v: unknown, where: string) => c.int(v, where, 1, ASSET_PACK_LIMITS.hold);
  if (item.hold === undefined) hold = new Array(length).fill(4);
  else if (Array.isArray(item.hold)) {
    if (item.hold.length !== length) c.error(`${path}.hold`, `must have one entry per frame (${length})`);
    else item.hold.forEach((entry, index) => { const h = holdFrom(entry, `${path}.hold[${index}]`); if (h !== null) hold.push(h); });
  } else { const h = holdFrom(item.hold, `${path}.hold`); if (h !== null) hold = new Array(length).fill(h); }
  const big: number[] = [];
  if (item.big !== undefined) {
    if (!Array.isArray(item.big) || item.big.length > ASSET_PACK_LIMITS.big) c.error(`${path}.big`, `must be a list of at most ${ASSET_PACK_LIMITS.big} frame indices`);
    else item.big.forEach((entry, index) => {
      const where = `${path}.big[${index}]`, n = c.int(entry, where, 0, Math.max(0, length - 1));
      if (n === null) return;
      if (big.includes(n)) c.error(where, 'duplicate frame index');
      else big.push(n);
    });
  }
  let trims: Point[] | undefined;
  if (item.trims !== undefined) {
    if (!Array.isArray(item.trims) || item.trims.length !== length) c.error(`${path}.trims`, `must have one [x, y] offset per frame (${length})`);
    else {
      trims = [];
      item.trims.forEach((entry, index) => {
        const point = c.point(entry, `${path}.trims[${index}]`, ASSET_PACK_LIMITS.coordinate, ASSET_PACK_LIMITS.coordinate);
        if (point) trims!.push(point);
      });
    }
  }
  let anchors: Point[] | null = null;
  if (item.anchors !== undefined) {
    if (!Array.isArray(item.anchors) || item.anchors.length !== length) c.error(`${path}.anchors`, `must have one point per frame (${length})`);
    else {
      anchors = [];
      item.anchors.forEach((entry, index) => {
        // with trims the anchor is measured in the untrimmed frame, so it may lie outside the trimmed cell
        const cell = trims !== undefined || item.trims !== undefined ? [ASSET_PACK_LIMITS.coordinate, ASSET_PACK_LIMITS.coordinate] as const : cells[index] ?? [ASSET_PACK_LIMITS.coordinate, ASSET_PACK_LIMITS.coordinate];
        const point = c.point(entry, `${path}.anchors[${index}]`, cell[0], cell[1]);
        if (point) anchors!.push(point);
      });
    }
  }
  let palette: string | undefined;
  if (item.palette !== undefined) {
    if (typeof item.palette === 'string' && Object.hasOwn(palettes, item.palette)) palette = item.palette;
    else c.error(`${path}.palette`, 'refers to an unknown palette');
  }
  let parts: Record<string, ClipPart> | undefined;
  if (item.parts !== undefined) {
    const where = `${path}.parts`, table = c.record(item.parts, where);
    if (table) {
      const names = Object.keys(table);
      if (names.length > ASSET_PACK_LIMITS.parts) c.error(where, `at most ${ASSET_PACK_LIMITS.parts} parts`);
      parts = {};
      for (const name of names.slice(0, ASSET_PACK_LIMITS.parts)) {
        const part = checkPart(c, table[name], `${where}.${name.slice(0, 32)}`, length, atlases, palettes);
        if (!c.id(name, `${where}.${name.slice(0, 32)}`)) continue;
        if (part) parts[name] = part;
      }
    }
  }
  if (c.issues.length > before || verb === null || loop === null || length === 0) return null;
  return { verb, loop, hold, big: big.sort((a, b) => a - b), frames, strip, anchors, ...(palette === undefined ? {} : { palette }), length, ...(trims === undefined ? {} : { trims }), ...(parts === undefined ? {} : { parts }) };
}

function checkPart(c: Checker, value: unknown, path: string, length: number, atlases: Record<string, AtlasDef>, palettes: Record<string, PaletteDef>): ClipPart | null {
  const before = c.issues.length;
  const item = c.record(value, path);
  if (!item) return null;
  c.keys(item, path, ['atlas', 'rects', 'offsets', 'layer', 'palette']);
  const atlasId = typeof item.atlas === 'string' ? item.atlas : '';
  const atlas = Object.hasOwn(atlases, atlasId) ? atlases[atlasId]! : null;
  if (!atlas) c.error(`${path}.atlas`, 'refers to an unknown atlas');
  const rects: Array<Rect | null> = [];
  if (!Array.isArray(item.rects) || item.rects.length !== length) c.error(`${path}.rects`, `must have one rectangle (or null) per frame (${length})`);
  else item.rects.forEach((entry, index) => {
    if (entry === null) { rects.push(null); return; }
    const rect = atlas ? c.rect(entry, `${path}.rects[${index}]`, atlas.width, atlas.height) : null;
    if (rect) rects.push(rect);
  });
  const offsets: Array<readonly [number, number]> = [];
  if (!Array.isArray(item.offsets) || item.offsets.length !== length) c.error(`${path}.offsets`, `must have one [x, y] offset per frame (${length})`);
  else item.offsets.forEach((entry, index) => {
    const where = `${path}.offsets[${index}]`;
    if (!Array.isArray(entry) || entry.length !== 2) { c.error(where, 'must be [x, y]'); return; }
    const x = c.int(entry[0], `${where}[0]`, -ASSET_PACK_LIMITS.coordinate, ASSET_PACK_LIMITS.coordinate), y = c.int(entry[1], `${where}[1]`, -ASSET_PACK_LIMITS.coordinate, ASSET_PACK_LIMITS.coordinate);
    if (x !== null && y !== null) offsets.push([x, y] as const);
  });
  const layer = item.layer === undefined ? 'front' : c.oneOf(item.layer, `${path}.layer`, ['front', 'back'] as const);
  let palette: string | undefined;
  if (item.palette !== undefined) {
    if (typeof item.palette === 'string' && Object.hasOwn(palettes, item.palette)) palette = item.palette;
    else c.error(`${path}.palette`, 'refers to an unknown palette');
  }
  if (c.issues.length > before || !atlas || layer === null) return null;
  return { atlas: atlasId, rects, offsets, layer, ...(palette === undefined ? {} : { palette }) };
}

function checkFont(c: Checker, value: unknown, path: string, atlases: Record<string, AtlasDef>, palettes: Record<string, PaletteDef>): FontDef | null {
  const before = c.issues.length;
  const item = c.record(value, path);
  if (!item) return null;
  c.keys(item, path, ['role', 'atlas', 'rect', 'cell', 'columns', 'chars', 'advance', 'lineHeight', 'baseline', 'palette']);
  const role = item.role === undefined ? 'text' : c.oneOf(item.role, `${path}.role`, FONT_ROLES);
  const atlasId = typeof item.atlas === 'string' ? item.atlas : '';
  const atlas = Object.hasOwn(atlases, atlasId) ? atlases[atlasId]! : null;
  if (!atlas) c.error(`${path}.atlas`, 'refers to an unknown atlas');
  const rect = atlas ? c.rect(item.rect, `${path}.rect`, atlas.width, atlas.height) : null;
  let cell: [number, number] | null = null;
  if (!Array.isArray(item.cell) || item.cell.length !== 2) c.error(`${path}.cell`, 'must be [width, height]');
  else {
    const w = c.int(item.cell[0], `${path}.cell[0]`, 1, 512), h = c.int(item.cell[1], `${path}.cell[1]`, 1, 512);
    if (w !== null && h !== null) cell = [w, h];
  }
  const columns = c.int(item.columns, `${path}.columns`, 1, ASSET_PACK_LIMITS.glyphs);
  let chars = '';
  let glyphs = 0;
  if (typeof item.chars !== 'string') c.error(`${path}.chars`, 'must be a string of the glyphs in grid order');
  else {
    const list = Array.from(item.chars);
    glyphs = list.length;
    if (list.length < 1 || list.length > ASSET_PACK_LIMITS.glyphs) c.error(`${path}.chars`, `must hold 1-${ASSET_PACK_LIMITS.glyphs} glyphs`);
    else if (list.some(ch => { const code = ch.codePointAt(0)!; return code < 0x20 || (code >= 0x7f && code <= 0x9f) || code === 0x2028 || code === 0x2029 || (code >= 0xd800 && code <= 0xdfff); })) c.error(`${path}.chars`, 'must not contain control or surrogate characters');
    else if (new Set(list).size !== list.length) c.error(`${path}.chars`, 'must not repeat a glyph');
    else chars = item.chars;
  }
  if (rect && cell && columns !== null && glyphs > 0) {
    const rows = Math.ceil(glyphs / columns);
    if (columns * cell[0] > rect[2] || rows * cell[1] > rect[3]) c.error(`${path}.rect`, `is too small for ${columns} columns x ${rows} rows of ${cell[0]}x${cell[1]} cells`);
  }
  let advance: number[] = [];
  if (item.advance === undefined) advance = new Array(glyphs).fill(cell ? cell[0] : 1);
  else if (typeof item.advance === 'number') { const a = c.int(item.advance, `${path}.advance`, 0, 512); if (a !== null) advance = new Array(glyphs).fill(a); }
  else if (Array.isArray(item.advance)) {
    if (item.advance.length !== glyphs) c.error(`${path}.advance`, `must have one entry per glyph (${glyphs})`);
    else item.advance.forEach((entry, index) => { const a = c.int(entry, `${path}.advance[${index}]`, 0, 512); if (a !== null) advance.push(a); });
  } else c.error(`${path}.advance`, 'must be an integer or a list of integers');
  const lineHeight = item.lineHeight === undefined ? (cell ? cell[1] : 1) : c.int(item.lineHeight, `${path}.lineHeight`, 1, 1024);
  const baseline = item.baseline === undefined ? (cell ? cell[1] : 0) : c.int(item.baseline, `${path}.baseline`, 0, cell ? cell[1] : 512);
  let palette: string | undefined;
  if (item.palette !== undefined) {
    if (typeof item.palette === 'string' && Object.hasOwn(palettes, item.palette)) palette = item.palette;
    else c.error(`${path}.palette`, 'refers to an unknown palette');
  }
  if (c.issues.length > before || role === null || !rect || !cell || columns === null || lineHeight === null || baseline === null || chars === '') return null;
  return { role, atlas: atlasId, rect, cell, columns, chars, advance, lineHeight, baseline, ...(palette === undefined ? {} : { palette }) };
}

/** Bytes or text to a checked manifest. Malformed UTF-8, malformed JSON and oversize input are issues, not exceptions. */
export function parseAssetPackManifest(input: string | Uint8Array): ManifestCheck {
  let text: string;
  try {
    if (typeof input === 'string') text = input;
    else {
      if (input.byteLength > ASSET_PACK_LIMITS.manifestBytes) return { manifest: null, issues: [{ level: 'error', path: '(root)', message: `manifest exceeds ${ASSET_PACK_LIMITS.manifestBytes} bytes` }] };
      text = new TextDecoder('utf-8', { fatal: true }).decode(input);
    }
  } catch { return { manifest: null, issues: [{ level: 'error', path: '(root)', message: 'manifest is not valid UTF-8' }] }; }
  if (text.length > ASSET_PACK_LIMITS.manifestBytes) return { manifest: null, issues: [{ level: 'error', path: '(root)', message: `manifest exceeds ${ASSET_PACK_LIMITS.manifestBytes} characters` }] };
  let value: unknown;
  try { value = JSON.parse(text); } catch { return { manifest: null, issues: [{ level: 'error', path: '(root)', message: 'manifest is not valid JSON' }] }; }
  return checkAssetPackManifest(value);
}
