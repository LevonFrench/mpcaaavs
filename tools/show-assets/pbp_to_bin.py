"""Unpack a PlayStation-on-PSP EBOOT (.PBP) into raw MODE2/2352 disc images.

Owner-supplied games only; output goes to a scratch directory and feeds
psx_extract.py. Multi-disc EBOOTs produce one .bin per disc.

    python tools/show-assets/pbp_to_bin.py --pbp game.PBP --out <scratch>/game
"""
from __future__ import annotations

import argparse
import struct
import zlib
from pathlib import Path

BLOCK = 0x9300  # 16 raw sectors of 2352 bytes


def iso_offsets(f, psar: int) -> list[int]:
    f.seek(psar)
    magic = f.read(16)
    if magic.startswith(b'PSISOIMG0000'):
        return [psar]
    if magic.startswith(b'PSTITLEIMG000000'):
        f.seek(psar + 0x200)
        offsets = [o for o in struct.unpack('<5I', f.read(20)) if o]
        return [psar + o for o in offsets]
    raise SystemExit(f'Unsupported PSAR header {magic[:16]!r}')


def unpack_disc(f, iso: int, out: Path) -> int:
    f.seek(iso + 0x4000)
    table = f.read(0x100000 - 0x4000)
    written = 0
    with out.open('wb') as dst:
        for k in range(0, len(table), 32):
            offset, length = struct.unpack_from('<IH', table, k)
            if length == 0:
                break
            f.seek(iso + 0x100000 + offset)
            data = f.read(length)
            if length == BLOCK:
                block = data
            else:
                block = zlib.decompress(data, -15)
            dst.write(block)
            written += len(block)
    return written


def main() -> None:
    ap = argparse.ArgumentParser(description=__doc__.split('\n\n')[0])
    ap.add_argument('--pbp', type=Path, required=True)
    ap.add_argument('--out', type=Path, required=True, help='Output path stem; .bin (or -discN.bin) is appended')
    args = ap.parse_args()
    with args.pbp.open('rb') as f:
        head = f.read(40)
        if head[:4] != b'\x00PBP':
            raise SystemExit('Not a PBP file')
        psar = struct.unpack_from('<I', head, 36)[0]
        discs = iso_offsets(f, psar)
        args.out.parent.mkdir(parents=True, exist_ok=True)
        for i, iso in enumerate(discs):
            path = args.out.with_name(args.out.name + (f'-disc{i + 1}' if len(discs) > 1 else '') + '.bin')
            size = unpack_disc(f, iso, path)
            print(f'{path} {size} bytes')


if __name__ == '__main__':
    main()
