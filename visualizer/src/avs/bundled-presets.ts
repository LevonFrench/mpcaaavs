import { BUNDLED_AVS_PRESET_CATALOG } from './bundled-presets.generated.ts';

export interface BundledAvsPreset {
  readonly id: string;
  readonly name: string;
  readonly fileName: string;
  readonly collection: string;
  readonly url: string;
}

/** The complete installed Community Picks and Winamp 5 Picks collections. */
export const BUNDLED_AVS_PRESETS: readonly BundledAvsPreset[] = BUNDLED_AVS_PRESET_CATALOG;

export async function fetchBundledAvsPreset(preset: BundledAvsPreset): Promise<Uint8Array> {
  const response = await fetch(new URL(preset.url, import.meta.url));
  if (!response.ok) throw new Error(`Could not load ${preset.fileName}: HTTP ${response.status}`);
  return new Uint8Array(await response.arrayBuffer());
}
