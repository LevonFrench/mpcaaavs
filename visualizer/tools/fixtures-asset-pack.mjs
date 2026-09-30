// Synthetic asset-pack fixtures for the asset-pack checks (docs/design/ASSET-PACK-MANIFEST.md). Everything is generated here from
// arithmetic: the atlases are flat colour blocks with a hash-derived checker, every name is neutral, and nothing resembles game art.
// Nothing in this file is written to the repository; callers build the pack in memory or in a scratch directory.
import { deflateSync, inflateSync } from 'node:zlib';

const crcTable = new Uint32Array(256).map((_, n) => { let c = n; for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1; return c >>> 0; });
export function crc32(bytes) { let c = 0xffffffff; for (const b of bytes) c = crcTable[(c ^ b) & 255] ^ (c >>> 8); return (c ^ 0xffffffff) >>> 0; }
const chunk = (type, data) => {
  const out = Buffer.alloc(12 + data.length);
  out.writeUInt32BE(data.length, 0); out.write(type, 4, 'latin1'); Buffer.from(data).copy(out, 8);
  out.writeUInt32BE(crc32(out.subarray(4, 8 + data.length)), 8 + data.length);
  return out;
};
/** RGBA pixels (width*height*4 bytes) to an 8-bit RGBA, non-interlaced PNG. */
export function encodePng(width, height, rgba) {
  const header = Buffer.alloc(13);
  header.writeUInt32BE(width, 0); header.writeUInt32BE(height, 4); header[8] = 8; header[9] = 6;
  const raw = Buffer.alloc((width * 4 + 1) * height);
  for (let y = 0; y < height; y++) { raw[y * (width * 4 + 1)] = 0; Buffer.from(rgba.buffer, rgba.byteOffset + y * width * 4, width * 4).copy(raw, y * (width * 4 + 1) + 1); }
  return new Uint8Array(Buffer.concat([Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]), chunk('IHDR', header), chunk('IDAT', deflateSync(raw, { level: 9 })), chunk('IEND', Buffer.alloc(0))]));
}
/** Inverse of encodePng for the PNGs this file writes (8-bit RGBA, filter 0); used to prove the fixtures are real PNGs. */
export function decodePng(bytes) {
  const buf = Buffer.from(bytes);
  assertSignature(buf);
  let offset = 8, width = 0, height = 0; const idat = [];
  while (offset < buf.length) {
    const length = buf.readUInt32BE(offset), type = buf.toString('latin1', offset + 4, offset + 8), data = buf.subarray(offset + 8, offset + 8 + length);
    if (buf.readUInt32BE(offset + 8 + length) !== crc32(buf.subarray(offset + 4, offset + 8 + length))) throw new Error(`bad CRC in ${type}`);
    if (type === 'IHDR') { width = data.readUInt32BE(0); height = data.readUInt32BE(4); }
    if (type === 'IDAT') idat.push(data);
    offset += 12 + length;
  }
  const raw = inflateSync(Buffer.concat(idat)), rgba = new Uint8Array(width * height * 4);
  for (let y = 0; y < height; y++) { if (raw[y * (width * 4 + 1)] !== 0) throw new Error('unexpected filter'); rgba.set(raw.subarray(y * (width * 4 + 1) + 1, (y + 1) * (width * 4 + 1)), y * width * 4); }
  return { width, height, rgba };
}
function assertSignature(buf) { if (buf.readUInt32BE(0) !== 0x89504e47 || buf.readUInt32BE(4) !== 0x0d0a1a0a) throw new Error('not a PNG'); }

const hash = (n) => { let h = (n ^ 0x9e3779b9) >>> 0; h = Math.imul(h ^ (h >>> 16), 0x85ebca6b); h = Math.imul(h ^ (h >>> 13), 0xc2b2ae35); return (h ^ (h >>> 16)) >>> 0; };
/** A width x height atlas: each `[x, y, w, h]` block is a flat hash-derived colour with a 1px lighter border and a checker dot. */
export function paintAtlas(width, height, blocks) {
  const rgba = new Uint8Array(width * height * 4);
  blocks.forEach(([bx, by, bw, bh], index) => {
    const h = hash(index + 1), base = [64 + (h & 127), 64 + ((h >>> 8) & 127), 64 + ((h >>> 16) & 127)];
    for (let y = by; y < by + bh; y++) for (let x = bx; x < bx + bw; x++) {
      const edge = x === bx || y === by || x === bx + bw - 1 || y === by + bh - 1, dot = ((x - bx) + (y - by)) % 4 === 0;
      const k = edge ? 1.4 : dot ? 0.8 : 1, p = (y * width + x) * 4;
      rgba[p] = Math.min(255, base[0] * k); rgba[p + 1] = Math.min(255, base[1] * k); rgba[p + 2] = Math.min(255, base[2] * k); rgba[p + 3] = 255;
    }
  });
  return encodePng(width, height, rgba);
}

export const FIXTURE_PACK_ID = 'fixture-pack';
/** A small complete manifest that uses every role, clip form, font grid, palette cycle, nine-slice and screen slot. */
export function fixtureManifest() {
  return {
    format: 'mpcaaavs-assets', version: 1, id: FIXTURE_PACK_ID, name: 'Fixture Pack (synthetic)',
    atlases: {
      sprites: { file: 'atlas/sprites.png', width: 64, height: 64, filter: 'nearest' },
      ui: { file: 'atlas/ui.png', width: 64, height: 48, filter: 'linear' },
    },
    palettes: { main: { colors: ['#102030', '#405060', '#8090a0', '#d0e0f0'], cycles: [{ from: 1, to: 3, beats: 2 }] } },
    regions: {
      hero: { role: 'actor', atlas: 'sprites', rect: [0, 16, 16, 24], class: 'hero', size: 'medium', facing: 'right', palette: 'main', tags: ['neutral'], clips: { idle: 'hero-idle', attack: 'hero-attack' } },
      'hero-atk-0': { role: 'clip', atlas: 'sprites', rect: [0, 40, 16, 16], anchor: [8, 15] },
      'hero-atk-1': { role: 'clip', atlas: 'sprites', rect: [16, 40, 16, 16], anchor: [8, 15] },
      note: { role: 'projectile', atlas: 'sprites', rect: [32, 16, 8, 8], motion: 'arc', spawn: [12, 10], impact: 'spark' },
      spark: { role: 'effect', atlas: 'sprites', rect: [40, 16, 16, 16], blend: 'add', duration: 12, scale: 'small' },
      gem: { role: 'pickup', atlas: 'sprites', rect: [0, 56, 8, 8], collect: 'spark', caption: 'Gem' },
      crate: { role: 'prop', atlas: 'sprites', rect: [56, 40, 8, 16], drops: ['gem'] },
      stage: { role: 'background', atlas: 'sprites', rect: [40, 56, 24, 8], scroll: 0.5, layer: 0, loopWidth: 24 },
      panel: { role: 'hud', atlas: 'sprites', rect: [32, 40, 24, 16], part: 'box', nineSlice: { left: 6, top: 6, right: 6, bottom: 6 } },
      meter: { role: 'hud', atlas: 'sprites', rect: [8, 56, 32, 8], part: 'bar', fill: 'left-to-right', segmentPitch: 4, ghost: '#203040' },
      dialog: { role: 'text', atlas: 'ui', rect: [32, 32, 32, 16], nineSlice: { left: 4, top: 4, right: 4, bottom: 4 } },
      wipe: { role: 'transition', atlas: 'ui', rect: [0, 32, 32, 16], beats: 2, direction: 'left' },
      menu: { role: 'screen', atlas: 'ui', rect: [32, 0, 32, 32], slots: { list: [2, 2, 20, 20], title: [2, 24, 28, 6] }, cursors: [[4, 4], [4, 14]] },
    },
    clips: {
      'hero-idle': { verb: 'idle', loop: true, hold: [6, 6, 6, 6], big: [2], strip: { atlas: 'sprites', rect: [0, 0, 64, 16], count: 4, axis: 'x' } },
      'hero-attack': { verb: 'attack', loop: false, hold: [3, 5], big: [1], frames: ['hero-atk-0', 'hero-atk-1'], anchors: [[8, 15], [9, 15]] },
    },
    fonts: { digits: { role: 'hud', atlas: 'ui', rect: [0, 0, 30, 16], cell: [6, 8], columns: 5, chars: '0123456789', advance: 6, lineHeight: 8, baseline: 7 } },
  };
}
/** The fixture pack as `{ path: bytes | text }`, the shape of `memoryPackSource`. */
export function fixtureFiles(manifest = fixtureManifest()) {
  const blocks = (def) => Object.values(manifest.regions).filter(r => r.atlas === def).map(r => r.rect);
  return {
    'pack.json': JSON.stringify(manifest, null, 2),
    'atlas/sprites.png': paintAtlas(64, 64, [...blocks('sprites'), [0, 0, 64, 16]]),
    'atlas/ui.png': paintAtlas(64, 48, blocks('ui')),
  };
}
