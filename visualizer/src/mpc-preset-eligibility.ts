import type { LocalAvsPreset } from './avs/local-collection.ts';

/** Ratings constrain shuffle only; manual ordered browsing can still find unrated presets. */
export function eligiblePresets(catalog: readonly LocalAvsPreset[], order: readonly number[], shuffle: boolean, minimumRating: number, failed: ReadonlySet<number> = new Set()): number[] {
  return order.filter(index => {
    const preset = catalog[index];
    return preset?.autoEligible && !preset.notWorking && !failed.has(index)
      && (!shuffle || (preset.rating ?? 0) >= minimumRating);
  });
}
