/** Device-local display preferences shared by the MPC-HC and Player hosts: the three resolution choices (render quality, AVS resolution,
 * pixel-art scaling) and the two overlay choices (FPS text, timing overlay). They are never part of a setup and never travel through
 * the library `configure` op (docs/design/CONTRACT.md C-14).
 *
 * Wire: integers in the native `settings` message and the page-to-native `display:` string (CONTRACT 2.2.3, 2.2.4). Storage: one JSON
 * object of names under `aaavs.mpcDisplay.v1` in the Player's localStorage (CONTRACT 2.2.6). Parsing accepts either form, per key, and a
 * missing or invalid key keeps the current value, so an old native or page that never sends a key changes nothing.
 * Pure apart from loadPrefs/savePrefs, which wrap every storage access in try/catch and work without any storage. */
import { DISPLAY_STORAGE_KEY } from './mpc-contract.ts';
import type { AvsResolutionMode } from './avs-presentation.ts';
import type { DisplaySettings, PixelArtScaling, QualityTier } from './render-resolution.ts';

export type ShowFps = 0 | 1 | 2;
export type TimingOverlay = 0 | 1;
export interface DisplayPrefs extends DisplaySettings { readonly showFps: ShowFps; readonly timingOverlay: TimingOverlay }

/** Names in wire order: the index is the wire integer. Their lengths equal the counts in mpc-contract.ts (pinned by check-render-sizer.mjs). */
export const QUALITY_NAMES: readonly QualityTier[] = Object.freeze(['auto', 'performance', 'balanced', 'high', 'native'] as const);
export const AVS_RESOLUTION_NAMES: readonly AvsResolutionMode[] = Object.freeze(['classic', 'crisp', 'high'] as const);
export const PIXEL_ART_NAMES: readonly PixelArtScaling[] = Object.freeze(['auto', 'integer', 'smooth'] as const);
export const SHOW_FPS_NAMES: readonly ['off', 'fps', 'detail'] = Object.freeze(['off', 'fps', 'detail'] as const);
export const TIMING_OVERLAY_NAMES: readonly ['hover', 'always'] = Object.freeze(['hover', 'always'] as const);

/** One control per key, for the Preset Manager row and the Player selects. `values[i]` is the storage name of wire integer `i`. */
export interface DisplayField { readonly key: keyof DisplayPrefs; readonly label: string; readonly values: readonly string[]; readonly labels: readonly string[] }
const FIELD_LIST: DisplayField[] = [
  { key: 'quality', label: 'Render quality', values: QUALITY_NAMES, labels: ['Auto', 'Performance', 'Balanced', 'High', 'Native'] },
  { key: 'avsResolution', label: 'AVS resolution', values: AVS_RESOLUTION_NAMES, labels: ['Classic', 'Crisp', 'High (experimental)'] },
  { key: 'pixelArt', label: 'Pixel-art scaling', values: PIXEL_ART_NAMES, labels: ['Auto', 'Integer', 'Smooth'] },
  { key: 'showFps', label: 'Show FPS', values: SHOW_FPS_NAMES, labels: ['Off', 'FPS', 'Detail'] },
  { key: 'timingOverlay', label: 'Timing overlay', values: TIMING_OVERLAY_NAMES, labels: ['Hover', 'Always visible'] },
];
export const DISPLAY_FIELDS: readonly DisplayField[] = Object.freeze(FIELD_LIST.map(field => Object.freeze(field)));

// Every key of DisplayPrefs is an index into the names above, so all five share one codec.
const KEYS: readonly (keyof DisplayPrefs)[] = ['quality', 'avsResolution', 'pixelArt', 'showFps', 'timingOverlay'];
const NAMES: Readonly<Record<keyof DisplayPrefs, readonly string[]>> = {
  quality: QUALITY_NAMES, avsResolution: AVS_RESOLUTION_NAMES, pixelArt: PIXEL_ART_NAMES, showFps: SHOW_FPS_NAMES, timingOverlay: TIMING_OVERLAY_NAMES,
};

/** auto quality, classic AVS, auto pixel-art scaling, FPS on, timing overlay on hover. */
export const DEFAULT_PREFS: DisplayPrefs = Object.freeze({ quality: 'auto', avsResolution: 'classic', pixelArt: 'auto', showFps: 1, timingOverlay: 0 });

/** Index of a wire integer or a storage name (lower case, surrounding spaces ignored) within `names`; -1 for anything else. */
function decode(names: readonly string[], value: unknown): number {
  if (typeof value === 'number') return Number.isInteger(value) && value >= 0 && value < names.length ? value : -1;
  return typeof value === 'string' ? names.indexOf(value.trim().toLowerCase()) : -1;
}

function apply(current: DisplayPrefs, source: Record<string, unknown>): DisplayPrefs {
  const next: Record<string, unknown> = { ...current };
  let changed = false;
  for (const key of KEYS) {
    // Own properties only: a polluted Object.prototype must not inject a preference.
    if (!Object.hasOwn(source, key)) continue;
    const index = decode(NAMES[key], source[key]);
    if (index < 0) continue;
    const value = key === 'showFps' || key === 'timingOverlay' ? index : NAMES[key][index];
    if (next[key] !== value) { next[key] = value; changed = true; }
  }
  return changed ? Object.freeze(next as unknown as DisplayPrefs) : current;
}

/**
 * Tolerant parse of the wire object, the storage object or a JSON string of either. Integers (wire) and names (storage) are both
 * accepted per key; a missing or invalid key keeps `current`. Returns `current` itself when nothing changes.
 */
export function parseDisplayPrefs(value: unknown, current: DisplayPrefs = DEFAULT_PREFS): DisplayPrefs {
  let source = value;
  if (typeof source === 'string') { try { source = JSON.parse(source); } catch { return current; } }
  return source && typeof source === 'object' && !Array.isArray(source) ? apply(current, source as Record<string, unknown>) : current;
}

/** `current` with the valid keys of `patch` applied (the Preset Manager row and the Player selects). Returns `current` when nothing changes. */
export function mergePrefs(current: DisplayPrefs, patch: Partial<DisplayPrefs>): DisplayPrefs {
  return patch && typeof patch === 'object' ? apply(current, patch as Record<string, unknown>) : current;
}

/** Integers in contract order, for the native `display:` string and the `settings` message. */
export function prefsToWire(p: DisplayPrefs): { quality: number; avsResolution: number; pixelArt: number; showFps: number; timingOverlay: number } {
  return {
    quality: QUALITY_NAMES.indexOf(p.quality), avsResolution: AVS_RESOLUTION_NAMES.indexOf(p.avsResolution), pixelArt: PIXEL_ART_NAMES.indexOf(p.pixelArt),
    showFps: p.showFps, timingOverlay: p.timingOverlay,
  };
}

/** Names, for the Player's localStorage object. */
export function prefsToStorage(p: DisplayPrefs): Record<string, string> {
  return {
    quality: p.quality, avsResolution: p.avsResolution, pixelArt: p.pixelArt,
    showFps: SHOW_FPS_NAMES[p.showFps], timingOverlay: TIMING_OVERLAY_NAMES[p.timingOverlay],
  };
}

/** Stored preferences, or the defaults when storage is absent, blocked, empty or corrupt. */
export function loadPrefs(): DisplayPrefs {
  try {
    const raw = localStorage.getItem(DISPLAY_STORAGE_KEY);
    return raw ? parseDisplayPrefs(JSON.parse(raw)) : DEFAULT_PREFS;
  } catch { return DEFAULT_PREFS; }
}

/** Best effort: a private window, blocked site data or a full quota simply leaves the preferences session-only. */
export function savePrefs(p: DisplayPrefs): void {
  try { localStorage.setItem(DISPLAY_STORAGE_KEY, JSON.stringify(prefsToStorage(p))); } catch { /* session-only */ }
}
