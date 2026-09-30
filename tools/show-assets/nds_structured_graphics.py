"""Extract documented 1bpp font cells and palette-bound native portrait tiles.

Format reference: AlaryVanEeckhout/Mega_Man_ZX_Editor lib/font.py,
lib/graphic.py, lib/datconv.py and lib/gamedat.py, read as text only.
Fonts are canonical white coverage masks, not guessed native text colours.
Portrait index zero is an unbound background coverage mask; runtime alpha
is not claimed. Every nonzero used index must have a stored source colour.
Paths and portrait tile dimensions are explicit caller arguments.
"""
import argparse
import hashlib
import json
import re
import struct
import time
from pathlib import Path
import numpy as np
from PIL import Image
from disc_fs import NitroFS
from image_formats import dims


def digest(data):
    return hashlib.sha256(data).hexdigest()


def font_cells(data):
    if len(data) < 32:
        raise ValueError('font header truncated')
    width, height, stride, count, size = struct.unpack_from('<HHIII', data)
    padded = (width + 7) // 8 * 8
    if not 1 <= width <= 64 or not 1 <= height <= 128 or not 1 <= count <= 65535:
        raise ValueError('invalid font cell dimensions/count')
    if stride != padded * height // 8 or count * stride != size or 32 + size != len(data):
        raise ValueError('font stride/count/payload extent mismatch')
    for i in range(count):
        offset = 32 + i * stride
        encoded = data[offset:offset + stride]
        bits = np.unpackbits(np.frombuffer(encoded, dtype=np.uint8), bitorder='little').reshape(height, padded)
        rgba = np.full((height, padded, 4), 255, dtype=np.uint8)
        rgba[:, :, 3] = bits * 255
        yield Image.fromarray(rgba), {'offset': offset, 'cell_index': i, 'width': padded, 'height': height,
              'declared_width': width, 'stride': stride, 'bpp': 1, 'source_cell_sha256': digest(encoded),
              'alpha': 'canonical source 1bpp coverage mask; runtime text colour unbound',
              'layout': 'LSB-first row bits; byte-padded width retained'}


def portrait_cells(data, tiles_x, tiles_y):
    if len(data) < 20:
        raise ValueError('portrait table truncated')
    header_size = struct.unpack_from('<I', data)[0]
    if header_size % 20 or not 20 <= header_size <= len(data) or header_size // 20 > 4096:
        raise ValueError('invalid portrait graphic-header table')
    w, h = tiles_x * 8, tiles_y * 8
    dims(w, h)
    for i, base in enumerate(range(0, header_size, 20)):
        gfx_offset, gfx_size = struct.unpack_from('<IH', data, base)
        pal_offset, pal_size, depth, flags = struct.unpack_from('<IHBB', data, base + 12)
        if not gfx_size:
            continue  # Native empty placeholder, not a fabricated image.
        if depth != 16 or gfx_size != w * h or not 2 <= pal_size <= 512 or pal_size % 2:
            raise ValueError('portrait 8bpp size/palette mismatch')
        start, pal_start = base + gfx_offset, base + 12 + pal_offset
        if start < header_size or start + gfx_size > len(data) or pal_start < start + gfx_size or pal_start + pal_size > len(data):
            raise ValueError('portrait graphic/palette outside extent')
        skip = flags & 0xf0
        ids = np.frombuffer(data[start:start + gfx_size], dtype=np.uint8)
        if skip + pal_size // 2 > 256 or any(v != 0 and not skip <= v < skip + pal_size // 2 for v in np.unique(ids)):
            raise ValueError('portrait uses an unbound nonzero palette index')
        encoded_palette = data[pal_start:pal_start + pal_size]
        colors = np.frombuffer(encoded_palette, dtype='<u2')
        rgb = np.stack([colors & 31, (colors >> 5) & 31, (colors >> 10) & 31], axis=-1).astype(np.uint8)
        rgb = (rgb << 3) | (rgb >> 2)
        palette = np.zeros((256, 4), dtype=np.uint8)
        palette[skip:skip + len(colors), :3] = rgb
        palette[skip:skip + len(colors), 3] = 255
        palette[0, 3] = 0
        tile_ids = ids.reshape(tiles_y, tiles_x, 8, 8).transpose(0, 2, 1, 3).reshape(h, w)
        yield Image.fromarray(palette[tile_ids]), {'offset': base, 'cell_index': i, 'width': w, 'height': h,
              'bpp': 8, 'graphic_offset': start, 'graphic_size': gfx_size, 'palette_offset': pal_start,
              'palette_size': pal_size, 'palette_skip': skip, 'graphic_sha256': digest(data[start:start + gfx_size]),
              'palette_sha256': digest(encoded_palette), 'layout': '8x8 tiles; explicit documented portrait dimensions',
              'alpha': 'index zero masked as unbound background; native runtime transparency unverified'}


def export(source, out, fonts, portraits, tiles_x, tiles_y, seconds=1800):
    source, out = Path(source), Path(out)
    before = source.stat()
    reader = NitroFS(source)
    start_time = time.monotonic()
    result = {'source': str(source.resolve()), 'files': [], 'formats': {}, 'failures': [],
              'reference': 'https://github.com/AlaryVanEeckhout/Mega_Man_ZX_Editor/tree/main/lib',
              'visual_acceptance': 'pending', 'runtime_colour_alpha_binding': 'font colour and portrait index zero unbound'}
    owned = {}
    try:
        tree = {name: (offset, size) for name, offset, size in reader.tree()}
        for name, fmt, decoder in [(n, 'nds-font-mask', font_cells) for n in fonts] + [
                (n, 'nds-portrait-mask', lambda d: portrait_cells(d, tiles_x, tiles_y)) for n in portraits]:
            if time.monotonic() - start_time > seconds:
                raise TimeoutError('structured image timebox exceeded')
            location, size = tree[name]
            data = reader.read(location, size)
            file_hash = digest(data)
            folder = out / 'raw' / fmt
            folder.mkdir(parents=True, exist_ok=True)
            if fmt not in owned:
                index = folder / 'index.json'
                old = json.loads(index.read_text()) if index.exists() else []
                if any(row.get('method') != 'disc:nds-structured' for row in old):
                    raise ValueError('preserve independent structured index')
                owned[fmt] = {row['png']: row for row in old}
            count = 0
            # Validate the entire requested file before writing any of its cells.
            decoded = list(decoder(data))
            for image, info in decoded:
                png = re.sub(r'[^A-Za-z0-9_.-]', '_', name) + f"@{info['offset']:08x}.cell{info['cell_index']:05d}.png"
                path = folder / png
                if path.exists():
                    if png not in owned[fmt]:
                        raise ValueError('preserve unclaimed structured PNG')
                    with Image.open(path) as existing:
                        if not np.array_equal(np.array(existing.convert('RGBA')), np.array(image)):
                            raise ValueError('preserve changed structured PNG')
                else:
                    image.save(path)
                owned[fmt][png] = {'file': name, 'png': png, 'source_file_sha256': file_hash,
                                   'method': 'disc:nds-structured', 'visual_acceptance': False, **info}
                count += 1
            result['files'].append({'file': name, 'size': size, 'sha256': file_hash, 'format': fmt, 'decoded': count})
            result['formats'][fmt] = result['formats'].get(fmt, 0) + count
            (folder / 'index.json').write_text(json.dumps(list(owned[fmt].values()), indent=2))
    finally:
        reader.close()
    after = source.stat()
    if (before.st_size, before.st_mtime_ns) != (after.st_size, after.st_mtime_ns):
        raise ValueError('source metadata changed')
    result['source_size_mtime_unchanged'] = True
    result['seconds'] = time.monotonic() - start_time
    (out / 'native-structured-scan.json').write_text(json.dumps(result, indent=2))
    return result


if __name__ == '__main__':
    parser = argparse.ArgumentParser(description=__doc__)
    for name in ('source', 'out'):
        parser.add_argument('--' + name, type=Path, required=True)
    parser.add_argument('--font', action='append', default=[])
    parser.add_argument('--portrait', action='append', default=[])
    parser.add_argument('--tiles-x', type=int, default=0)
    parser.add_argument('--tiles-y', type=int, default=0)
    parser.add_argument('--seconds', type=int, default=1800)
    args = parser.parse_args()
    print(json.dumps(export(args.source, args.out, args.font, args.portrait, args.tiles_x, args.tiles_y, args.seconds)))
