// Track and franchise strings of the NERV show (AAAVS addition, not upstream).
//
// Upstream hard-codes its song ("NEON OVERDRIVE" by mroneilovealot) on the boot and end cards and in a
// few tickers, and names the franchise in the plug and berserk headers. The port reads them from the
// show params instead: the host passes the loaded track's title and artist, and the public defaults for
// the franchise words stay neutral (AGENTS.md, "Legal line"); a private local overlay may pass the
// real words. The reference fixture passes the upstream song's title and artist.
import { F, font } from '../../show/type.ts';

export interface NervShowText {
  /** Track title as shown on the cards (upper case). */
  title: string;
  /** The title card's two stacked lines. */
  titleLines: [string, string];
  /** Japanese line under the title (upstream: the katakana title). */
  titleJp: string;
  artist: string;
  /** Header word before "UNIT-01" (upstream: the franchise name); empty by default. */
  unit: string;
  unitJp: string;
  /** Terminal file name of the audio query (MAGI ticker). */
  file: string;
}

const DEFAULT_TITLE = 'AUDIO SIGNAL';

export function nervText(params: Record<string, unknown> | undefined): NervShowText {
  const p = params ?? {};
  const str = (k: string) => (typeof p[k] === 'string' ? (p[k] as string).trim() : '');
  const title = (str('title') || DEFAULT_TITLE).toUpperCase();
  const words = title.split(/\s+/).filter(Boolean);
  let lines: [string, string];
  if (words.length <= 1) lines = ['', title];
  else {
    // split into two lines of similar length, the second at least as long (NEON / OVERDRIVE)
    let best = 1, bestD = Infinity;
    for (let i = 1; i < words.length; i++) {
      const a = words.slice(0, i).join(' ').length, b = words.slice(i).join(' ').length;
      const d = Math.abs(a - b) + (a > b ? 0.5 : 0);
      if (d < bestD) { bestD = d; best = i; }
    }
    lines = [words.slice(0, best).join(' '), words.slice(best).join(' ')];
  }
  return {
    title,
    titleLines: lines,
    titleJp: str('titleJp') || '音声信号',
    artist: str('artist') || 'UNKNOWN ARTIST',
    unit: str('unit'),
    unitJp: str('unitJp'),
    file: (title.replace(/[^A-Z0-9]+/g, '_').replace(/^_|_$/g, '') || 'AUDIO') + '.WAV',
  };
}

/** "<unit> UNIT-01" with the unit word optional. */
export const unitName = (x: NervShowText, sep = ' ') => (x.unit ? `${x.unit}${sep}UNIT-01` : 'UNIT-01');

/** Condensed-serif size that keeps `text` within maxW at horizontal squeeze sx (upstream sizes are the maximum). */
export function fitCondensedSize(c: CanvasRenderingContext2D, text: string, size: number, sx: number, maxW: number) {
  c.save();
  c.font = font(F.serif(600), size);
  c.letterSpacing = '0px';
  const w = c.measureText(text).width * sx;
  c.restore();
  return w > maxW ? (size * maxW) / w : size;
}
