"""Extract PlayStation TIM images from an owner-supplied MODE2/2352 disc image.

Reads the ISO9660 tree from the raw .bin, scans every data file for embedded TIM
images (uncompressed only) and writes them as PNG plus an index.json. Output is
private reference material for local show asset packs: it must stay under a
git-ignored directory (show-assets-private/) and never be committed or shipped.

    python tools/show-assets/psx_extract.py --bin disc.bin --out show-assets-private/<game>/tim
    python tools/show-assets/psx_extract.py --bin disc.bin --list
"""
from __future__ import annotations

import argparse
import json
import struct
from pathlib import Path

from PIL import Image

SECTOR = 2352
USER_OFFSET = 24  # 12 sync + 4 header + 8 subheader (mode 2 form 1)
USER_SIZE = 2048


class Disc:
    def __init__(self, path: Path):
        self.f = path.open('rb')
        self.sectors = path.stat().st_size // SECTOR

    def read(self, lba: int, size: int) -> bytes:
        out = bytearray()
        while len(out) < size and lba < self.sectors:
            self.f.seek(lba * SECTOR + USER_OFFSET)
            out += self.f.read(USER_SIZE)
            lba += 1
        return bytes(out[:size])

    def walk(self):
        """Yield (path, lba, size) for every file in the ISO9660 tree."""
        pvd = self.read(16, USER_SIZE)
        if pvd[1:6] != b'CD001':
            raise SystemExit('Not an ISO9660 MODE2/2352 image (no CD001 at sector 16)')
        root = pvd[156:156 + 34]
        stack = [('', struct.unpack_from('<I', root, 2)[0], struct.unpack_from('<I', root, 10)[0])]
        seen = set()
        while stack:
            prefix, lba, size = stack.pop()
            if lba in seen:
                continue
            seen.add(lba)
            data = self.read(lba, size)
            pos = 0
            while pos < len(data):
                length = data[pos]
                if length == 0:  # records never straddle a sector: skip to the next one
                    pos = (pos // USER_SIZE + 1) * USER_SIZE
                    continue
                rec = data[pos:pos + length]
                pos += length
                name_len = rec[32]
                name = rec[33:33 + name_len]
                if name in (b'\x00', b'\x01'):
                    continue
                name_s = name.decode('ascii', 'replace').split(';')[0]
                ext_lba = struct.unpack_from('<I', rec, 2)[0]
                ext_size = struct.unpack_from('<I', rec, 10)[0]
                if rec[25] & 2:
                    stack.append((f'{prefix}{name_s}/', ext_lba, ext_size))
                else:
                    yield f'{prefix}{name_s}', ext_lba, ext_size


def rgb555(c: int) -> tuple[int, int, int, int]:
    r, g, b = c & 31, (c >> 5) & 31, (c >> 10) & 31
    alpha = 0 if c == 0 else 255  # 0x0000 is the PlayStation's transparent colour
    return (r << 3 | r >> 2, g << 3 | g >> 2, b << 3 | b >> 2, alpha)


def parse_tim(buf: bytes, off: int):
    """Return (image, next offset, info) for a valid TIM at off, else None."""
    if off + 20 > len(buf) or struct.unpack_from('<I', buf, off)[0] != 0x10:
        return None
    flags = struct.unpack_from('<I', buf, off + 4)[0]
    if flags not in (0, 1, 2, 3, 8, 9):
        return None
    bpp = flags & 3
    p = off + 8
    palettes = []
    if flags & 8:
        if p + 12 > len(buf):
            return None
        clen, _, _, cw, ch = struct.unpack_from('<IHHHH', buf, p)
        if cw == 0 or ch == 0 or clen != 12 + cw * ch * 2 or p + clen > len(buf):
            return None
        if bpp == 0 and cw < 16 or bpp == 1 and cw < 256 and cw != 16:
            pass  # small CLUTs occur; accept
        raw = struct.unpack_from(f'<{cw * ch}H', buf, p + 12)
        palettes = [[rgb555(c) for c in raw[r * cw:(r + 1) * cw]] for r in range(ch)]
        p += clen
    elif bpp in (0, 1):
        return None
    if p + 12 > len(buf):
        return None
    ilen, x, y, w16, h = struct.unpack_from('<IHHHH', buf, p)
    if w16 == 0 or h == 0 or w16 > 1024 or h > 512 or ilen != 12 + w16 * 2 * h or p + ilen > len(buf):
        return None
    data = buf[p + 12:p + ilen]
    width = {0: w16 * 4, 1: w16 * 2, 2: w16, 3: w16 * 2 // 3}[bpp]
    img = Image.new('RGBA', (width, h))
    px = img.load()
    if bpp == 0:
        pal = palettes[0]
        for i, byte in enumerate(data):
            yy, xx = divmod(i * 2, width)
            for k, idx in enumerate((byte & 15, byte >> 4)):
                if xx + k < width:
                    px[xx + k, yy] = pal[idx] if idx < len(pal) else (255, 0, 255, 255)
    elif bpp == 1:
        pal = palettes[0]
        for i, idx in enumerate(data):
            yy, xx = divmod(i, width)
            px[xx, yy] = pal[idx] if idx < len(pal) else (255, 0, 255, 255)
    elif bpp == 2:
        for i, c in enumerate(struct.unpack(f'<{len(data) // 2}H', data)):
            yy, xx = divmod(i, width)
            px[xx, yy] = rgb555(c)
    else:
        img = Image.frombytes('RGB', (width, h), data[:width * h * 3]).convert('RGBA')
    info = {'bpp': [4, 8, 16, 24][bpp], 'width': width, 'height': h, 'vram': [x, y], 'palettes': len(palettes)}
    return img, p + ilen, info, palettes


def main() -> None:
    ap = argparse.ArgumentParser(description=__doc__.split('\n\n')[0])
    ap.add_argument('--bin', type=Path, required=True)
    ap.add_argument('--out', type=Path)
    ap.add_argument('--list', action='store_true', help='List the ISO9660 files and exit')
    ap.add_argument('--min-size', type=int, default=8, help='Skip images smaller than this on either side')
    args = ap.parse_args()
    disc = Disc(args.bin)
    files = sorted(disc.walk())
    if args.list or not args.out:
        for path, lba, size in files:
            print(f'{size:>10}  {lba:>7}  {path}')
        return
    args.out.mkdir(parents=True, exist_ok=True)
    index = []
    for path, lba, size in files:
        if size > 64 * 1024 * 1024:
            continue
        buf = disc.read(lba, size)
        off = 0
        while off < len(buf) - 20:
            hit = parse_tim(buf, off)
            if not hit:
                off += 4
                continue
            img, nxt, info, palettes = hit
            if info['width'] >= args.min_size and info['height'] >= args.min_size:
                stem = f"{path.replace('/', '_')}@{off:08x}"
                img.save(args.out / f'{stem}.png')
                # Alternate CLUT rows are often colour variants (e.g. item states): keep them too.
                for k in range(1, min(len(palettes), 16)):
                    if info['bpp'] in (4, 8):
                        # Re-render with palette k by mapping row-0 colours onto row k.
                        pal_img = img.copy()
                        base = palettes[0]
                        mapping = {tuple(c): tuple(palettes[k][i]) for i, c in enumerate(base) if i < len(palettes[k])}
                        pal_img.putdata([mapping.get(tuple(p), tuple(p)) for p in img.getdata()])
                        pal_img.save(args.out / f'{stem}.pal{k}.png')
                index.append({'file': path, 'offset': off, 'png': f'{stem}.png', **info})
            off = nxt + (-nxt % 4)
    (args.out / 'index.json').write_text(json.dumps(index, indent=1))
    print(f'{len(index)} TIM images from {len(files)} files -> {args.out}')


if __name__ == '__main__':
    main()
