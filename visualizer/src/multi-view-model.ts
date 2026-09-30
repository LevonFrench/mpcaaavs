/** Shared multiview show contract. No transport, storage, catalog mutation or wall clock. */
import { parseSceneTiming, defaultSceneTiming, type SceneTiming } from './mpc-scene-clock.ts';
import { parseFadeFields, type FadeSpec } from './mpc-transition-timing.ts';
import { TRANSITION_COUNT } from './mpc-contract.ts';

export const MULTI_VIEW_MAX_PANES = 4;
export const MULTI_VIEW_LAYOUTS = ['single', 'columns', 'rows', 'grid', 'hero-left', 'hero-top', 'upper-third', 'lower-third', 'side-rail', 'picture-in-picture', 'cards'] as const;
export type MultiViewLayout = typeof MULTI_VIEW_LAYOUTS[number];
export const MULTI_VIEW_MOTIONS = ['cut', 'dissolve', 'slide-x', 'slide-y', 'wipe-x', 'wipe-y', 'flip-x', 'flip-y', 'morph'] as const;
export type MultiViewMotion = typeof MULTI_VIEW_MOTIONS[number];
export type MultiViewSource = { kind: 'all-presets' } | { kind: 'set'; id: string }
  | { kind: 'all-sets'; traversal: 'sets' | 'mixed'; barsPerSet: number } | { kind: 'presets'; hashes: readonly string[] };
export interface MultiViewPane {
  readonly source: MultiViewSource | null;
  readonly auto: boolean;
  readonly shuffle: boolean;
  readonly bars: number;
  readonly phaseBars: number;
  readonly transition: number | MultiViewMotion;
  readonly fit: 'contain' | 'cover' | 'stretch';
}
export interface MultiViewBorder { readonly style: 'none' | 'solid' | 'pulse' | 'chase'; readonly width: number; readonly color: string }
export interface MultiViewPlan {
  readonly version: 1;
  readonly count: number;
  readonly layout: MultiViewLayout;
  readonly source: MultiViewSource;
  readonly panes: readonly MultiViewPane[];
  readonly timing: SceneTiming;
  readonly fade: FadeSpec;
  readonly layoutMotion: MultiViewMotion;
  readonly layoutBeats: number;
  readonly gutter: number;
  readonly border: MultiViewBorder;
  readonly minimumRating: number;
  readonly avoidDuplicates: boolean;
}
const rec = (v: unknown): Record<string, unknown> => v && typeof v === 'object' && !Array.isArray(v) ? v as Record<string, unknown> : {};
const num = (v: unknown, lo: number, hi: number, fallback: number) => typeof v === 'number' && Number.isFinite(v) ? Math.min(hi, Math.max(lo, v)) : fallback;
const integer = (v: unknown, lo: number, hi: number, fallback: number) => Math.round(num(v, lo, hi, fallback));
const one = <T extends string>(v: unknown, allowed: readonly T[], fallback: T): T => allowed.includes(v as T) ? v as T : fallback;
const HASH = /^[a-f0-9]{64}$/;
export function parseMultiViewSource(value: unknown): MultiViewSource {
  const v = rec(value);
  if (v.kind === 'set' && typeof v.id === 'string' && v.id.length > 0 && v.id.length <= 128) return { kind: 'set', id: v.id };
  if (v.kind === 'all-sets') return { kind: 'all-sets', traversal: v.traversal === 'mixed' ? 'mixed' : 'sets', barsPerSet: integer(v.barsPerSet, 1, 128, 32) };
  if (v.kind === 'presets' && Array.isArray(v.hashes)) return { kind: 'presets', hashes: [...new Set(v.hashes.slice(0, 100000).filter((h): h is string => typeof h === 'string' && HASH.test(h)))] };
  return { kind: 'all-presets' };
}
/** Device-local plan parser; unknown fields are dropped. No paths or raw preset data are retained. */
export function parseMultiViewPlan(value: unknown): MultiViewPlan {
  const v = rec(value), border = rec(v.border);
  let timing: SceneTiming;
  try { timing = parseSceneTiming(v.timing ?? { ...defaultSceneTiming, enabled: true }); }
  catch { timing = { ...defaultSceneTiming, enabled: true }; }
  // Lane clocks own their cues and scene lengths. Named intervals and the musical grid survive.
  timing = { ...timing, enabled: true }; delete timing.script; delete timing.barsPattern; delete timing.patternHold;
  const panes = Array.from({ length: MULTI_VIEW_MAX_PANES }, (_, i): MultiViewPane => {
    const p = rec(Array.isArray(v.panes) ? v.panes[i] : undefined);
    const transition = typeof p.transition === 'number' && Number.isInteger(p.transition) && p.transition >= 0 && p.transition < TRANSITION_COUNT
      ? p.transition : one(p.transition, MULTI_VIEW_MOTIONS, i % 2 ? 'slide-y' : 'slide-x');
    return { source: p.source == null ? null : parseMultiViewSource(p.source), auto: p.auto !== false, shuffle: p.shuffle === true,
      bars: integer(p.bars, 1, 128, 8), phaseBars: num(p.phaseBars, 0, 128, i * 2), transition,
      fit: one(p.fit, ['contain', 'cover', 'stretch'], 'contain') };
  });
  const f = rec(v.fade);
  return { version: 1, count: integer(v.count, 1, 4, 2), layout: one(v.layout, MULTI_VIEW_LAYOUTS, 'columns'), source: parseMultiViewSource(v.source), panes, timing,
    fade: parseFadeFields({ fadeTiming: f.timing ?? 3, fadeRandomSet: f.randomSet, fadeAnchor: 0, durationMs: f.fixedMs }),
    layoutMotion: one(v.layoutMotion, MULTI_VIEW_MOTIONS, 'morph'), layoutBeats: num(v.layoutBeats, 0, 16, 2), gutter: num(v.gutter, 0, 64, 4),
    border: { style: one(border.style, ['none', 'solid', 'pulse', 'chase'], 'solid'), width: num(border.width, 0, 12, 2), color: typeof border.color === 'string' && /^#[a-f0-9]{6}$/i.test(border.color) ? border.color : '#55cddd' },
    minimumRating: integer(v.minimumRating, 0, 5, 0), avoidDuplicates: v.avoidDuplicates === true };
}
export const defaultMultiViewPlan = (): MultiViewPlan => parseMultiViewPlan(undefined);
export interface MultiViewRect { readonly x: number; readonly y: number; readonly width: number; readonly height: number }
const r = (x: number, y: number, width: number, height: number): MultiViewRect => ({ x, y, width, height });
/** Normalized rectangles in paint order: pane zero is the background in overlay layouts. */
export function multiViewRects(layout: MultiViewLayout, paneCount: number): readonly MultiViewRect[] {
  const n = integer(paneCount, 1, 4, 2), strips = (horizontal: boolean, count: number, x = 0, y = 0, w = 1, h = 1) =>
    Array.from({ length: count }, (_, i) => horizontal ? r(x + i * w / count, y, w / count, h) : r(x, y + i * h / count, w, h / count));
  if (n === 1) return [r(0, 0, 1, 1)];
  if (layout === 'rows') return strips(false, n);
  if (layout === 'grid') return n === 2 ? strips(true, n) : n === 3 ? [r(0, 0, .5, 1), r(.5, 0, .5, .5), r(.5, .5, .5, .5)] : [r(0, 0, .5, .5), r(.5, 0, .5, .5), r(0, .5, .5, .5), r(.5, .5, .5, .5)];
  if (layout === 'hero-left') return [r(0, 0, 2 / 3, 1), ...strips(false, n - 1, 2 / 3, 0, 1 / 3, 1)];
  if (layout === 'hero-top') return [r(0, 0, 1, 2 / 3), ...strips(true, n - 1, 0, 2 / 3, 1, 1 / 3)];
  if (layout === 'upper-third') return [r(0, 1 / 3, 1, 2 / 3), ...strips(true, n - 1, 0, 0, 1, 1 / 3)];
  if (layout === 'lower-third') return [r(0, 0, 1, 2 / 3), ...strips(true, n - 1, 0, 2 / 3, 1, 1 / 3)];
  if (layout === 'side-rail') return [r(0, 0, .75, 1), ...strips(false, n - 1, .75, 0, .25, 1)];
  if (layout === 'picture-in-picture') return [r(0, 0, 1, 1), ...Array.from({ length: n - 1 }, (_, i) => r(.66, .04 + i * .32, .3, .28))];
  if (layout === 'cards') return strips(true, n, .03, .1, .94, .8);
  // `single` with n > 1 falls back to columns rather than quietly hiding live workers.
  return strips(true, n);
}
export function multiViewPixelRects(layout: MultiViewLayout, count: number, width: number, height: number, gutter = 0): readonly MultiViewRect[] {
  const w = integer(width, 1, 4096, 1), h = integer(height, 1, 4096, 1), gap = num(gutter, 0, 64, 0);
  return multiViewRects(layout, count).map(box => {
    const x = Math.round(box.x * w), y = Math.round(box.y * h), right = Math.round((box.x + box.width) * w), bottom = Math.round((box.y + box.height) * h);
    const gx = Math.min(gap / 2, Math.max(0, (right - x - 1) / 2)), gy = Math.min(gap / 2, Math.max(0, (bottom - y - 1) / 2));
    return r(x + gx, y + gy, Math.max(0, right - x - 2 * gx), Math.max(0, bottom - y - 2 * gy));
  });
}
/** Topmost pane wins for picture-in-picture; gaps and non-finite input select nothing. */
export function multiViewHitTest(rects: readonly MultiViewRect[], x: number, y: number): number | null {
  if (!Number.isFinite(x) || !Number.isFinite(y)) return null;
  for (let i = rects.length - 1; i >= 0; i--) { const b = rects[i]!; if (x >= b.x && y >= b.y && x < b.x + b.width && y < b.y + b.height) return i; }
  return null;
}
