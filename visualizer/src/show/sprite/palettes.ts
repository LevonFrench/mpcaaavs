// Indexed-colour palette table for the sprite layer. An indexed atlas stores palette indices in its red channel; the GPU looks the
// colour up in a palette texture (one row per palette, 256 columns). This module builds that table on the CPU (it is the texture's pixel
// data) and is the reference the checks compare the shader's behaviour with: `lookup(id, index)` is what a pixel of index `index` becomes
// under palette `id`. Palette cycles rotate index ranges once per `beats` beats as a pure function of the beat (paletteColorsAt).
import type { PaletteDef } from '../../asset-packs/manifest.ts';
import { paletteColorsAt } from '../../asset-packs/pack.ts';

export const PALETTE_WIDTH = 256;

/** `#rrggbb` or `#rrggbbaa` to 8-bit components. */
export function parseColor(color: string): [number, number, number, number] {
  const n = (i: number) => parseInt(color.slice(i, i + 2), 16);
  return [n(1), n(3), n(5), color.length >= 9 ? n(7) : 255];
}

export class PaletteTable {
  /** Palette id to its row, rows in sorted id order. */
  readonly rows = new Map<string, number>();
  readonly ids: readonly string[];
  /** RGBA8, PALETTE_WIDTH x rows.size, row 0 first. */
  readonly data: Uint8Array;
  private readonly defs: readonly PaletteDef[];
  private key: string | null = null;
  private readonly animated: boolean;

  constructor(palettes: Readonly<Record<string, PaletteDef>>) {
    this.ids = Object.keys(palettes).sort();
    this.ids.forEach((id, row) => this.rows.set(id, row));
    this.defs = this.ids.map((id) => palettes[id]!);
    this.animated = this.defs.some((d) => d.cycles.length > 0);
    this.data = new Uint8Array(PALETTE_WIDTH * Math.max(1, this.ids.length) * 4);
    this.update(0);
  }

  /** Row of a palette id, or -1. */
  rowOf(id: string | undefined): number { return id === undefined ? -1 : this.rows.get(id) ?? -1; }

  /** Recompute the cycling rows for `beat`. Returns true when any pixel of the table changed (the texture needs an upload). */
  update(beat: number): boolean {
    const key = this.animated ? this.defs.map((d) => d.cycles.map((c) => Math.floor(((((beat / c.beats) % 1) + 1) % 1) * (c.to - c.from + 1))).join(',')).join('|') : '-';
    if (key === this.key) return false;
    this.key = key;
    this.defs.forEach((def, row) => {
      const colors = this.animated ? paletteColorsAt(def, beat) : def.colors;
      const base = row * PALETTE_WIDTH * 4;
      this.data.fill(0, base, base + PALETTE_WIDTH * 4);
      for (let i = 0; i < colors.length && i < PALETTE_WIDTH; i++) this.data.set(parseColor(colors[i]!), base + i * 4);
    });
    return true;
  }

  /** The RGBA8 colour index `index` has under palette `id` at the last `update`. Unknown palette or index gives transparent black. */
  lookup(id: string, index: number): [number, number, number, number] {
    const row = this.rowOf(id);
    if (row < 0 || !Number.isInteger(index) || index < 0 || index >= PALETTE_WIDTH) return [0, 0, 0, 0];
    const p = (row * PALETTE_WIDTH + index) * 4;
    return [this.data[p]!, this.data[p + 1]!, this.data[p + 2]!, this.data[p + 3]!];
  }
}
