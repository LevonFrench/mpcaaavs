import { BEATS_FROM_FADE, FADE_FROM_BEATS, TRANSITION_CUT } from './mpc-contract.ts';
import type { SetupSettings } from './mpc-setups.ts';
/**
 * Built-in playback defaults for the HUD pack folders and the NERV scene folder (docs/design/CONTRACT.md, owner directive B).
 * Static public data keyed by pack label: no titles, no counts, nothing derived from any private file. "Play folder" uses a row
 * when the user has no saved playback bundle for that folder, so any HUD folder plays immediately with settings that suit its
 * character. The values are authored defaults chosen from the era and feel of each pack; they have not been auditioned.
 *
 * A row names a preferred transition and a classic fallback. The preferred style may be one of the newer styles (16..32), which
 * a build only has when its transition list is long enough; `builtinDefault(label, styles)` picks the fallback otherwise, so a
 * default never selects a style that has no name or drawing code yet.
 */

/** The 16 pack labels, in browser order. U+00B7 (middle dot) is the only non-ASCII character. */
export const HUD_PACK_LABELS = [
  'Showcase', 'Arcade · Fighting', 'Arcade · Action', 'Neo Geo', 'Vector & Early Arcade', '8/16-bit Consoles', '32/64-bit Consoles',
  '128-bit Consoles', 'Handheld & LCD', 'Home Computers', 'PC Classic', 'Flight, Space & Racing', 'Modern', 'Rhythm', 'Cinema & TV', 'Anime & Mecha',
] as const;
export type HudPackLabel = (typeof HUD_PACK_LABELS)[number];
/** Label of the sibling NERV root, which also ships a default (the same values as the NERV scene-set template). */
export const NERV_FOLDER_LABEL = 'NERV';
/** Label of the HUD root; also the default for a selection made only of HUD scenes. */
export const HUD_ROOT_LABEL = 'HUD packs';

/** Number of named transition styles a build ships today; the newer styles 16..32 arrive with the transition stream. */
export const CLASSIC_STYLES = 16;

// Fade timing indices of the contract: 0 seconds, 1 instant, 2 one beat, 3 two beats, 4 one bar, 5 two bars, 6 random.
type Fade = 0 | 1 | 2 | 3 | 4 | 5 | 6;
interface Row {
  readonly character: string;
  readonly sceneBars: number;          // bars per scene when the song clock is on
  readonly bars: 0 | 2 | 4 | 8 | 12;  // live Auto phrase when the clock is off
  readonly fade: Fade;
  readonly randomSet?: number;         // bit mask of the random fade choices (default all)
  readonly transition: number;         // preferred style
  readonly fallback: number;           // classic style used when the preferred one is not available yet
  readonly durationMs: number;         // seconds mode and no-tempo fallback
  readonly shuffle: boolean;
  readonly queue?: 0 | 1 | 2 | 3;      // manual queue quantization
}

const ROWS: Readonly<Record<HudPackLabel, Row>> = {
  'Showcase': { character: 'Hand-tuned scenes shown in order with unhurried one-bar crossfades.', sceneBars: 8, bars: 8, fade: 4, transition: 1, fallback: 1, durationMs: 2000, shuffle: false },
  'Arcade · Fighting': { character: 'Pixel-era and punchy: one-beat stepped wipes on a four-bar cycle.', sceneBars: 4, bars: 4, fade: 2, transition: 16, fallback: 6, durationMs: 500, shuffle: true },
  'Arcade · Action': { character: 'Pixel-era and quick: one-beat tile flips on a four-bar cycle.', sceneBars: 4, bars: 4, fade: 2, transition: 26, fallback: 14, durationMs: 500, shuffle: true },
  'Neo Geo': { character: 'Bright 16-bit arcade: one-beat block cuts, short scenes.', sceneBars: 4, bars: 4, fade: 2, transition: 6, fallback: 6, durationMs: 500, shuffle: true },
  'Vector & Early Arcade': { character: 'Phosphor look: one-beat CRT switch-off on a two-bar cycle.', sceneBars: 2, bars: 2, fade: 2, transition: 22, fallback: TRANSITION_CUT, durationMs: 500, shuffle: true },
  '8/16-bit Consoles': { character: 'Stepped and hard: one-beat block cuts on a four-bar cycle.', sceneBars: 4, bars: 4, fade: 2, transition: 6, fallback: 6, durationMs: 500, shuffle: true },
  '32/64-bit Consoles': { character: 'Early 3D era: two-beat dot dissolves on an eight-bar cycle.', sceneBars: 8, bars: 8, fade: 3, transition: 14, fallback: 14, durationMs: 1000, shuffle: true },
  '128-bit Consoles': { character: 'Smooth and glossy: one-bar crossfades on an eight-bar cycle.', sceneBars: 8, bars: 8, fade: 4, transition: 1, fallback: 1, durationMs: 2000, shuffle: true },
  'Handheld & LCD': { character: 'Low-fidelity screens: instant cuts on a four-bar cycle.', sceneBars: 4, bars: 4, fade: 1, transition: TRANSITION_CUT, fallback: TRANSITION_CUT, durationMs: 250, shuffle: true },
  'Home Computers': { character: 'Blocky and quick: one-beat block cuts on a four-bar cycle.', sceneBars: 4, bars: 4, fade: 2, transition: 6, fallback: 6, durationMs: 500, shuffle: true },
  'PC Classic': { character: 'Dithered and stepped: one-beat dot dissolves on a four-bar cycle.', sceneBars: 4, bars: 4, fade: 2, transition: 14, fallback: 14, durationMs: 500, shuffle: true },
  'Flight, Space & Racing': { character: 'Instrument panels: two-beat radar sweeps on an eight-bar cycle.', sceneBars: 8, bars: 8, fade: 3, transition: 20, fallback: 1, durationMs: 1000, shuffle: true },
  'Modern': { character: 'Clean and varied: random two-beat to two-bar fades with any style, eight-bar cycle.', sceneBars: 8, bars: 8, fade: 6, randomSet: 28, transition: 31, fallback: 0, durationMs: 1000, shuffle: true },
  'Rhythm': { character: 'Tight and beat-locked: one-beat wipes on a two-bar cycle, manual changes wait for the next beat.', sceneBars: 2, bars: 2, fade: 2, transition: 16, fallback: 10, durationMs: 250, shuffle: true, queue: 1 },
  'Cinema & TV': { character: 'Cinematic: two-bar crossfades on a sixteen-bar cycle.', sceneBars: 16, bars: 12, fade: 5, transition: 1, fallback: 1, durationMs: 4000, shuffle: true },
  'Anime & Mecha': { character: 'Dramatic: one-bar iris and crossfade on an eight-bar cycle.', sceneBars: 8, bars: 8, fade: 4, transition: 19, fallback: 1, durationMs: 2000, shuffle: true },
};
/** All HUD packs together (the HUD root, or a search that returns only HUD scenes): unhurried, shuffled crossfades. */
const HUD_ALL_ROW: Row = { character: 'Every HUD scene: shuffled one-bar crossfades on an eight-bar cycle.', sceneBars: 8, bars: 8, fade: 4, transition: 1, fallback: 1, durationMs: 2000, shuffle: true };
/** The NERV scene folder: the same values as the NERV scene-set template offered in the Setup Builder. */
const NERV_ROW: Row = { character: 'The NERV scene set: eight-bar scenes with two-beat crossfades, in order.', sceneBars: 8, bars: 8, fade: 3, transition: 1, fallback: 1, durationMs: 1000, shuffle: false };

export interface BuiltinFolderDefault {
  readonly label: string;
  /** Neutral one-line description of the pack's character, shown in the folder detail pane. */
  readonly character: string;
  /** Bars per scene when the song clock is on. */
  readonly barsPerScene: number;
  /** A full playback bundle accepted by `parseSettings`. */
  readonly settings: SetupSettings;
}

/** The v2 fade fields are written only when they differ from their defaults (contract C-04), so a bundle stays valid for older parsers. */
function bundle(row: Row, styles: number): SetupSettings {
  const beats = BEATS_FROM_FADE[row.fade] ?? 0;
  const s: SetupSettings = {
    enabled: true, bars: row.bars, shuffle: row.shuffle, minimumRating: 0,
    transition: row.transition < styles ? row.transition : row.fallback,
    beats, durationMs: row.durationMs, keepOld: true, manualFade: true, autoFade: true,
  };
  if (row.fade !== FADE_FROM_BEATS[beats]) s.fadeTiming = row.fade;
  if (row.randomSet !== undefined && row.randomSet !== 31) s.fadeRandomSet = row.randomSet;
  if (row.queue) s.queueQuantize = row.queue;
  return Object.freeze(s);
}

const slug = (text: string): string => text.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '');
const compact = (text: string): string => text.toLowerCase().replace(/[^a-z0-9]/g, '');
const bySlug = new Map<string, HudPackLabel>(), byCompact = new Map<string, HudPackLabel>();
for (const label of HUD_PACK_LABELS) { bySlug.set(slug(label), label); byCompact.set(compact(label), label); }

/** Maps a pack label, or the slug form an installer might write (`arcade-fighting`, `neogeo`), to the canonical label, else `null`. */
export function canonicalPackLabel(text: string): HudPackLabel | null {
  if (typeof text !== 'string' || !text) return null;
  return bySlug.get(slug(text)) ?? byCompact.get(compact(text)) ?? null;
}

/** Position of a label in the browser order; unknown labels sort after the 16 known ones. */
export function packOrder(label: string): number {
  const canonical = canonicalPackLabel(label);
  return canonical ? HUD_PACK_LABELS.indexOf(canonical) : HUD_PACK_LABELS.length;
}

/**
 * The built-in default for a HUD pack label or the NERV folder label, or `null` for anything else. `styles` is the number of
 * named transition styles the build ships (`TRANSITIONS.length`); a preferred newer style falls back to a classic one below it.
 */
export function builtinDefault(label: string, styles: number = CLASSIC_STYLES): BuiltinFolderDefault | null {
  const canonical = canonicalPackLabel(label);
  const row = canonical ? ROWS[canonical] : label === NERV_FOLDER_LABEL ? NERV_ROW : label === HUD_ROOT_LABEL ? HUD_ALL_ROW : null;
  if (!row) return null;
  const available = Number.isInteger(styles) && styles >= 1 ? styles : CLASSIC_STYLES;
  return Object.freeze({ label: canonical ?? label, character: row.character, barsPerScene: row.sceneBars, settings: bundle(row, available) });
}

/** Every label that has a built-in default, in browser order (the 16 packs, the HUD root, then NERV). */
export function builtinLabels(): readonly string[] { return [...HUD_PACK_LABELS, HUD_ROOT_LABEL, NERV_FOLDER_LABEL]; }
