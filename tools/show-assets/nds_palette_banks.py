"""Decode source-paletted native 20-byte tile-bank records, read-only.

Reference fields: AlaryVanEeckhout/Mega_Man_ZX_Editor lib/common.py and
lib/graphic.py (source text only). Root offset/flag tables and optional LZ10
sections are validated. Palette-less banks remain unrendered. Output columns
are an explicit atlas presentation choice, never claimed as a native screen.
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
from image_formats import dims, indices, unlz


def sections(data):
    if len(data) < 20:
        raise ValueError('no complete native bank header')
    n = struct.unpack_from('<I', data)[0]
    if 1 <= n <= 4096 and 8 + n * 4 <= len(data) and struct.unpack_from('<I', data, 4 + n * 4)[0] == len(data):
        words = list(struct.unpack_from('<' + str(n) + 'I', data, 4))
        offsets = [word & 0xffffff for word in words] + [len(data)]
        for i, word in enumerate(words):
            a, b = offsets[i:i + 2]
            if a < 8 + n * 4 or a > b or b > len(data) or word >> 24 not in (0, 128):
                raise ValueError('invalid native section offset/flag')
            if a == b:
                continue
            chunk = data[a:b]
            if word >> 24 == 128:
                if chunk[0] != 0x10:
                    raise ValueError('compressed native section lacks LZ10 header')
                chunk = unlz(chunk)
            yield i, a, word >> 24 == 128, chunk
    else:
        yield 0, 0, False, data


def banks(data):
    if len(data) < 20:
        raise ValueError('no graphic section')
    header = struct.unpack_from('<I', data)[0]
    if header % 20 or not 20 <= header <= len(data) or header // 20 > 4096:
        raise ValueError('section has no documented 20-byte graphic table')
    for i, base in enumerate(range(0, header, 20)):
        go, size = struct.unpack_from('<IH', data, base)
        po, ps, depth, flags = struct.unpack_from('<IHBB', data, base + 12)
        if not size:
            yield i, None, 'native empty bank'
            continue
        if depth not in (8, 16) or not ps:
            yield i, None, 'unbound palette or unsupported depth'
            continue
        begin, palette_at = base + go, base + 12 + po
        if begin < header or begin + size > len(data) or not 2 <= ps <= 512 or ps % 2 or palette_at < begin + size or palette_at + ps > len(data):
            raise ValueError('native graphic/palette extent invalid')
        stored = data[begin:begin + size]
        # Bytes 6/7 describe OAM indexing/offset, not a compression flag.
        # The reference detects an LZ10 stream from the graphic payload.
        # A raw tile bank can also begin with the pixel byte 0x10, so retain
        # exact raw tiles if the attempted stream fails strict decompression.
        compressed = False
        raw = stored
        if stored[0] == 0x10:
            try:
                raw = unlz(stored)
                compressed = True
            except ValueError:
                pass
        bpp = depth // 2
        skip = flags & 0xf0
        ids = indices(raw, bpp)
        if not len(raw) or len(ids) % 64:
            raise ValueError('native bank has incomplete tiles')
        if skip + ps // 2 > 1 << bpp or any(v != 0 and not skip <= v < skip + ps // 2 for v in np.unique(ids)):
            yield i, None, 'nonzero index lacks source palette entry'
            continue
        encoded_palette = data[palette_at:palette_at + ps]
        colors = np.frombuffer(encoded_palette, dtype='<u2')
        rgb = np.stack([colors & 31, (colors >> 5) & 31, (colors >> 10) & 31], axis=-1).astype(np.uint8)
        rgb = (rgb << 3) | (rgb >> 2)
        palette = np.zeros((1 << bpp, 4), dtype=np.uint8)
        palette[skip:skip + len(colors), :3] = rgb
        palette[skip:skip + len(colors), 3] = 255
        yield i, (ids, palette, {'record_offset': base, 'graphic_offset': begin, 'stored_size': size,
                 'expanded_size': len(raw), 'compressed_graphic': compressed, 'bpp': bpp,
                 'compression_detection': 'strict payload LZ10; otherwise complete palette-bound raw tiles',
                 'oam_indexing': data[base + 6], 'oam_tile_offset': data[base + 7],
                 'palette_offset': palette_at, 'palette_size': ps, 'palette_skip': skip,
                 'stored_sha256': hashlib.sha256(stored).hexdigest(), 'expanded_sha256': hashlib.sha256(raw).hexdigest(),
                 'palette_sha256': hashlib.sha256(encoded_palette).hexdigest(),
                 'alpha': 'source colours opaque; unbound index zero masked when palette skip nonzero; runtime alpha unverified'}), None


def export(source, out, columns, names=None, seconds=1800):
    if not 1 <= columns <= 128:
        raise ValueError('invalid atlas column count')
    source, out = Path(source), Path(out)
    before = source.stat()
    start_time = time.monotonic()
    folder = out / 'raw/nds-palette-bank'
    folder.mkdir(parents=True, exist_ok=True)
    index = folder / 'index.json'
    old = json.loads(index.read_text()) if index.exists() else []
    if any(r.get('method') != 'disc:nds-palette-bank' for r in old):
        raise ValueError('preserve independent palette-bank index')
    owned = {r['png']: r for r in old}
    result = {'source': str(source.resolve()), 'decoded': 0, 'files_scanned': 0,
              'sections_recognized': 0, 'unsupported': [], 'failures': [], 'atlas_columns': columns,
              'native_screen_geometry': 'unbound; atlas presentation only', 'visual_acceptance': 'pending',
              'decoder_revision': 'payload-lz10-v2',
              'reference': 'https://github.com/AlaryVanEeckhout/Mega_Man_ZX_Editor/tree/main/lib'}
    reader = NitroFS(source)
    try:
        for name, location, length in reader.tree():
            if names is not None and name not in names:
                continue
            if names is None and not name.lower().endswith('.bin'):
                continue
            if time.monotonic() - start_time > seconds:
                raise TimeoutError('native bank scan timebox exceeded')
            data = reader.read(location, length)
            result['files_scanned'] += 1
            file_hash = hashlib.sha256(data).hexdigest()
            try:
                for section, section_offset, section_compressed, chunk in sections(data):
                    try:
                        records = list(banks(chunk))
                    except ValueError as e:
                        result['unsupported'].append({'file': name, 'section': section, 'reason': str(e)})
                        continue
                    result['sections_recognized'] += 1
                    for record, decoded, reason in records:
                        if decoded is None:
                            result['unsupported'].append({'file': name, 'section': section, 'record': record, 'reason': reason})
                            continue
                        ids, palette, info = decoded
                        tiles = len(ids) // 64
                        rows = (tiles + columns - 1) // columns
                        dims(columns * 8, rows * 8)
                        rgba_tiles = np.zeros((rows * columns, 8, 8, 4), dtype=np.uint8)
                        rgba_tiles[:tiles] = palette[ids.reshape(tiles, 8, 8)]
                        rgba = rgba_tiles.reshape(rows, columns, 8, 8, 4).transpose(0, 2, 1, 3, 4).reshape(rows * 8, columns * 8, 4)
                        image = Image.fromarray(rgba)
                        png = re.sub(r'[^A-Za-z0-9_.-]', '_', name) + f'@{section_offset:08x}.section{section:04d}.bank{record:04d}.png'
                        path = folder / png
                        if path.exists():
                            if png not in owned:
                                raise ValueError('preserve unclaimed palette-bank PNG')
                            with Image.open(path) as existing:
                                if not np.array_equal(np.array(existing.convert('RGBA')), rgba):
                                    raise ValueError('preserve changed palette-bank PNG')
                        else:
                            image.save(path)
                        owned[png] = {'file': name, 'png': png, 'section': section, 'section_offset': section_offset,
                                      'section_compressed': section_compressed, 'section_sha256': hashlib.sha256(chunk).hexdigest(),
                                      'source_file_sha256': file_hash, 'tiles': tiles, 'atlas_columns': columns,
                                      'presentation_padding_tiles': rows * columns - tiles,
                                      'native_screen_geometry': 'not stored here; canonical source-order tile atlas',
                                      'method': 'disc:nds-palette-bank', 'visual_acceptance': False, **info}
                        result['decoded'] += 1
            except (ValueError, struct.error) as e:
                if str(e).startswith('preserve '):
                    raise
                result['failures'].append({'file': name, 'reason': str(e)})
    finally:
        reader.close()
    after = source.stat()
    if (before.st_size, before.st_mtime_ns) != (after.st_size, after.st_mtime_ns):
        raise ValueError('source metadata changed')
    result['source_size_mtime_unchanged'] = True
    result['seconds'] = time.monotonic() - start_time
    index.write_text(json.dumps(list(owned.values()), indent=2))
    (out / 'native-palette-bank-scan.json').write_text(json.dumps(result, indent=2))
    return result


if __name__ == '__main__':
    p = argparse.ArgumentParser(description=__doc__)
    for name in ('source', 'out'):
        p.add_argument('--' + name, type=Path, required=True)
    p.add_argument('--file', action='append')
    p.add_argument('--columns', type=int, default=16)
    p.add_argument('--seconds', type=int, default=1800)
    args = p.parse_args()
    r = export(args.source, args.out, args.columns, args.file, args.seconds)
    print(json.dumps({k: v for k, v in r.items() if k not in ('unsupported', 'failures')}))
