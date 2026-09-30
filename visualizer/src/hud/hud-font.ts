/** Procedural glyph data of the HUD engine (docs/design/HUD-PACK-ENGINE.md 5.1 and 5.2, docs/design/CONTRACT.md 2.3.9).
 *
 * Everything here was drawn for this project by hand on a 5x7 grid (plus a seven-segment table and seven-by-seven icons): no game, emulator, ROM or
 * third-party font data was read, traced or extracted, and no glyph is derived from a kit image. The letterforms are deliberately plain and angular so
 * a scene reads as a stylised instrument, not as a copy of any title's typography. ASCII 0x20..0x7e only; lower case shares the upper-case glyphs.
 *
 * Pure data and pure functions: no imports, no DOM. Glyphs are stored as rows of '#' and '.', decomposed once into a small set of rectangles per glyph
 * (greedy cover, best of the horizontal-first and vertical-first passes) so the painter draws text as batched rectangles: identical on every machine,
 * crisp at any scale after snapping, and about eight path segments per glyph at most.
 * Status: proposed and CPU-checked (tools/check-hud-engine.mjs); nothing here has been seen on a display. */

/** Pixel font metrics in cells: glyph box, advance (glyph plus one blank column) and line pitch. */
export const FONT = Object.freeze({ w: 5, h: 7, advance: 6, line: 9 });
export const ICON_SIZE = 7;

const GLYPHS: Readonly<Record<string, string>> = {
  ' ': '...../...../...../...../...../...../.....',
  '!': '..#../..#../..#../..#../..#../...../..#..',
  '"': '.#.#./.#.#./...../...../...../...../.....',
  '#': '.#.#./#####/.#.#./.#.#./#####/.#.#./.....',
  '$': '..#../.####/#.#../.###./..#.#/####./..#..',
  '%': '##..#/##.#./...#./..#../.#.../.#.##/#..##',
  '&': '.##../#..#./#.#../.#.../#.#.#/#..#./.##.#',
  "'": '..#../..#../.#.../...../...../...../.....',
  '(': '...#./..#../.#.../.#.../.#.../..#../...#.',
  ')': '.#.../..#../...#./...#./...#./..#../.#...',
  '*': '...../.#.#./..#../#####/..#../.#.#./.....',
  '+': '...../..#../..#../#####/..#../..#../.....',
  ',': '...../...../...../...../.##../..#../.#...',
  '-': '...../...../...../#####/...../...../.....',
  '.': '...../...../...../...../...../.##../.##..',
  '/': '....#/....#/...#./..#../.#.../#..../#....',
  '0': '.###./#...#/#..##/#.#.#/##..#/#...#/.###.',
  '1': '..#../.##../#.#../..#../..#../..#../#####',
  '2': '.###./#...#/....#/..##./.#.../#..../#####',
  '3': '####./....#/....#/.###./....#/....#/####.',
  '4': '...#./..##./.#.#./#..#./#####/...#./...#.',
  '5': '#####/#..../####./....#/....#/#...#/.###.',
  '6': '..##./.#.../#..../####./#...#/#...#/.###.',
  '7': '#####/....#/...#./..#../.#.../.#.../.#...',
  '8': '.###./#...#/#...#/.###./#...#/#...#/.###.',
  '9': '.###./#...#/#...#/.####/....#/...#./.##..',
  ':': '...../.##../.##../...../.##../.##../.....',
  ';': '...../.##../.##../...../.##../..#../.#...',
  '<': '...#./..#../.#.../#..../.#.../..#../...#.',
  '=': '...../...../#####/...../#####/...../.....',
  '>': '.#.../..#../...#./....#/...#./..#../.#...',
  '?': '.###./#...#/....#/...#./..#../...../..#..',
  '@': '.###./#...#/#.###/#.#.#/#.###/#..../.###.',
  A: '.###./#...#/#...#/#####/#...#/#...#/#...#',
  B: '####./#...#/#...#/####./#...#/#...#/####.',
  C: '.###./#...#/#..../#..../#..../#...#/.###.',
  D: '###../#..#./#...#/#...#/#...#/#..#./###..',
  E: '#####/#..../#..../####./#..../#..../#####',
  F: '#####/#..../#..../####./#..../#..../#....',
  G: '.###./#...#/#..../#.###/#...#/#...#/.###.',
  H: '#...#/#...#/#...#/#####/#...#/#...#/#...#',
  I: '.###./..#../..#../..#../..#../..#../.###.',
  J: '..###/...#./...#./...#./...#./#..#./.##..',
  K: '#...#/#..#./#.#../##.../#.#../#..#./#...#',
  L: '#..../#..../#..../#..../#..../#..../#####',
  M: '#...#/##.##/#.#.#/#.#.#/#...#/#...#/#...#',
  N: '#...#/##..#/##..#/#.#.#/#..##/#..##/#...#',
  O: '.###./#...#/#...#/#...#/#...#/#...#/.###.',
  P: '####./#...#/#...#/####./#..../#..../#....',
  Q: '.###./#...#/#...#/#...#/#.#.#/#..#./.##.#',
  R: '####./#...#/#...#/####./#.#../#..#./#...#',
  S: '.####/#..../#..../.###./....#/....#/####.',
  T: '#####/..#../..#../..#../..#../..#../..#..',
  U: '#...#/#...#/#...#/#...#/#...#/#...#/.###.',
  V: '#...#/#...#/#...#/#...#/#...#/.#.#./..#..',
  W: '#...#/#...#/#...#/#.#.#/#.#.#/##.##/#...#',
  X: '#...#/#...#/.#.#./..#../.#.#./#...#/#...#',
  Y: '#...#/#...#/.#.#./..#../..#../..#../..#..',
  Z: '#####/....#/...#./..#../.#.../#..../#####',
  '[': '.###./.#.../.#.../.#.../.#.../.#.../.###.',
  '\\': '#..../#..../.#.../..#../...#./....#/....#',
  ']': '.###./...#./...#./...#./...#./...#./.###.',
  '^': '..#../.#.#./#...#/...../...../...../.....',
  _: '...../...../...../...../...../...../#####',
  '`': '.#.../..#../...../...../...../...../.....',
  '{': '..##./..#../..#../.#.../..#../..#../..##.',
  '|': '..#../..#../..#../..#../..#../..#../..#..',
  '}': '.##../..#../..#../...#./..#../..#../.##..',
  '~': '...../...../.#..#/#.##./...../...../.....',
};

/** Seven-by-seven icons for `pips` and `slots`. */
const ICONS: Readonly<Record<string, string>> = {
  heart: '.##.##./#######/#######/#######/.#####./..###../...#...',
  life: '..###../..###../...#.../.#####./#.###.#/..#.#../.##.##.',
  ring: '..###../.#...#./#.....#/#.....#/#.....#/.#...#./..###..',
  round: '..###../.#####./#######/#######/#######/.#####./..###..',
  block: '.#####./#######/#######/#######/#######/#######/.#####.',
  star: '...#.../...#.../#######/.#####./..###../.##.##./.#...#.',
  medal: '.#...#./.#...#./..#.#../..###../.#####./.#####./..###..',
  dot: '......./......./..###../..###../..###../......./.......',
  box: '#######/#.....#/#.#.#.#/#..#..#/#.#.#.#/#.....#/#######',
  gem: '..###../.#####./#######/.#####./..###../...#.../.......',
  key: '.###.../#...#../#...#../.###.../..#..../..##.../..#....',
  potion: '..###../...#.../...#.../..###../.#####./.#####./..###..',
  shield: '#######/#.....#/#.....#/#.....#/.#...#./..#.#../...#...',
  sword: '......#/.....##/....##./#..##../.###.../..#..../.#.#...',
};

/** Seven-segment masks: bit 0 a (top), 1 b (upper right), 2 c (lower right), 3 d (bottom), 4 e (lower left), 5 f (upper left), 6 g (middle). */
const SEG: Readonly<Record<string, number>> = {
  '0': 63, '1': 6, '2': 91, '3': 79, '4': 102, '5': 109, '6': 125, '7': 7, '8': 127, '9': 111,
  A: 119, B: 124, C: 57, D: 94, E: 121, F: 113, G: 61, H: 118, I: 6, J: 30, L: 56, N: 84, O: 63, P: 115, R: 80, S: 109, T: 120, U: 62, Y: 110, Z: 91,
  '-': 64, _: 8, '=': 72, ' ': 0,
};

function rowsOf(pattern: string, width: number, height: number): string[] {
  const rows = pattern.split('/');
  if (rows.length !== height || rows.some(r => r.length !== width)) throw new Error(`Malformed glyph pattern ${pattern}`);
  return rows;
}

/** Greedy rectangle cover of a bitmap. `vertical` decomposes column-first. Returns [x, y, w, h, ...] in cells. */
function cover(rows: readonly string[], vertical: boolean): number[] {
  const h = rows.length, w = rows[0]!.length;
  const on = (x: number, y: number) => rows[y]![x] === '#';
  const done = Array.from({ length: h }, () => new Array<boolean>(w).fill(false));
  const out: number[] = [];
  const free = (x: number, y: number) => x < w && y < h && on(x, y) && !done[y]![x];
  for (let a = 0; a < (vertical ? w : h); a++) {
    for (let b = 0; b < (vertical ? h : w); b++) {
      const x = vertical ? a : b, y = vertical ? b : a;
      if (!free(x, y)) continue;
      let run = 1, span = 1;
      if (vertical) {
        while (free(x, y + run)) run++;
        while ((() => { for (let k = 0; k < run; k++) if (!free(x + span, y + k)) return false; return true; })()) span++;
        for (let i = 0; i < span; i++) for (let k = 0; k < run; k++) done[y + k]![x + i] = true;
        out.push(x, y, span, run);
      } else {
        while (free(x + run, y)) run++;
        while ((() => { for (let k = 0; k < run; k++) if (!free(x + k, y + span)) return false; return true; })()) span++;
        for (let j = 0; j < span; j++) for (let k = 0; k < run; k++) done[y + j]![x + k] = true;
        out.push(x, y, run, span);
      }
    }
  }
  return out;
}
function bestCover(rows: readonly string[]): Int8Array {
  const a = cover(rows, false), b = cover(rows, true);
  return Int8Array.from(b.length < a.length ? b : a);
}

const glyphCache = new Map<string, Int8Array>();
const EMPTY = new Int8Array(0);
const normalise = (ch: string): string => {
  const c = ch.length === 1 ? ch : ch.charAt(0);
  const u = c >= 'a' && c <= 'z' ? c.toUpperCase() : c;
  return Object.hasOwn(GLYPHS, u) ? u : '?';
};
/** The seven pattern rows of a character ('?' for anything outside printable ASCII). */
export function glyphRows(ch: string): readonly string[] { return rowsOf(GLYPHS[normalise(ch)]!, FONT.w, FONT.h); }
/** Rectangles [x, y, w, h, ...] in cells that cover the glyph exactly. A space has none. Cached; do not mutate. */
export function glyphRects(ch: string): Int8Array {
  const key = normalise(ch);
  let hit = glyphCache.get(key);
  if (!hit) { hit = key === ' ' ? EMPTY : bestCover(rowsOf(GLYPHS[key]!, FONT.w, FONT.h)); glyphCache.set(key, hit); }
  return hit;
}
/** Every printable ASCII character that has its own glyph (the table, for tests). */
export const GLYPH_CHARS: readonly string[] = Object.freeze(Object.keys(GLYPHS));
/** Width in cells of `n` characters at the font's advance (the last blank column is not counted). */
export const textCells = (n: number): number => (n > 0 ? n * FONT.advance - 1 : 0);

export const ICON_NAMES: readonly string[] = Object.freeze(Object.keys(ICONS));
const iconCache = new Map<string, Int8Array>();
/** Rectangles [x, y, w, h, ...] in cells (a 7x7 box) for an icon name; a dot for an unknown name. */
export function iconRects(name: string): Int8Array {
  const key = Object.hasOwn(ICONS, name) ? name : 'dot';
  let hit = iconCache.get(key);
  if (!hit) { hit = bestCover(rowsOf(ICONS[key]!, ICON_SIZE, ICON_SIZE)); iconCache.set(key, hit); }
  return hit;
}
export function iconRows(name: string): readonly string[] { return rowsOf(ICONS[Object.hasOwn(ICONS, name) ? name : 'dot']!, ICON_SIZE, ICON_SIZE); }

/** Seven-segment mask of a character (0 for anything without a segment form, so an unknown character shows blank). */
export function segMask(ch: string): number {
  const c = ch.length === 1 ? ch : ch.charAt(0), u = c >= 'a' && c <= 'z' ? c.toUpperCase() : c;
  return Object.hasOwn(SEG, u) ? SEG[u]! : 0;
}
/** Segment rectangles of one digit cell `cw` x `ch` with bar thickness `t`, in segment order a..g, as [x, y, w, h] x 7 written into `out` (length 28).
 * The seven rectangles never overlap and touch edge to edge (top and bottom bars sit between the verticals; the verticals own the corners and the
 * middle row). Integer inputs give integer rectangles. A cell smaller than 3t + 2 tall or 2t + 1 wide is drawn as if it were that size. */
export function segRects(cw: number, ch: number, t: number, out: number[] = new Array<number>(28).fill(0)): number[] {
  const th = Math.max(0, t), w = Math.max(cw, 2 * th + 1), h = Math.max(ch, 3 * th + 2);
  const midY = th + Math.floor((h - 3 * th) / 2), lowY = midY + th;
  const put = (i: number, x: number, y: number, ww: number, hh: number) => { out[i * 4] = x; out[i * 4 + 1] = y; out[i * 4 + 2] = ww; out[i * 4 + 3] = hh; };
  put(0, th, 0, w - 2 * th, th);          // a
  put(1, w - th, 0, th, lowY);            // b
  put(2, w - th, lowY, th, h - lowY);     // c
  put(3, th, h - th, w - 2 * th, th);     // d
  put(4, 0, lowY, th, h - lowY);          // e
  put(5, 0, 0, th, lowY);                 // f
  put(6, th, midY, w - 2 * th, th);       // g
  return out;
}
