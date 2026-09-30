"""Read palette-first native tile-strip archives using documented layout families.

Reference: Missingmew/phoenixtools dumpStriped and its public filemaps. Filemaps
are read as data; their regional offsets and descriptive labels are NOT reused.
Native count/offset/size tables bind palettes to all compressed strips. Export
only when exactly one supplied documented layout matches every expanded strip.
Ambiguous width/height pairs stay unrendered. Indexed alpha stays opaque.
"""
import argparse
import hashlib
import json
import re
import shlex
import struct
import time
from pathlib import Path
import numpy as np
from PIL import Image
from disc_fs import NitroFS
from image_formats import dims, indices, unlz


def layouts(path):
    result = set()
    for line in Path(path).read_text().splitlines():
        if not line.strip().startswith('0x'):
            continue
        try:
            row = shlex.split(line)
            if row[1] == '2':
                x, y = int(row[4]), int(row[5])
                dims(x * 8, y * 8)
                result.add((x, y))
        except (ValueError, IndexError):
            continue
    if not result:
        raise ValueError('reference contains no documented strip layouts')
    return sorted(result)


def export(source, disc_path, reference, out, seconds=1800):
    source, reference, out = Path(source), Path(reference), Path(out)
    before = source.stat()
    start = time.monotonic()
    fs = NitroFS(source)
    try:
        where, size = next((o, s) for n, o, s in fs.tree() if n == disc_path)
        data = fs.read(where, size)
    finally:
        fs.close()
    family = layouts(reference)
    source_hash = hashlib.sha256(data).hexdigest()
    reference_hash = hashlib.sha256(reference.read_bytes()).hexdigest()
    words = np.frombuffer(data[:len(data) // 4 * 4], dtype='<u4')
    if len(words) < 3:
        raise ValueError('source too small for offset table')
    candidates = np.flatnonzero((words[:-2] >= 2) & (words[:-2] <= 4096)
                               & (words[1:-1] == 4 + words[:-2] * 8)
                               & np.isin(words[2:], (32, 512)))
    folder = out / 'raw/nds-strips'
    folder.mkdir(parents=True, exist_ok=True)
    index = folder / 'index.json'
    old = json.loads(index.read_text()) if index.exists() else []
    if any(r.get('method') != 'disc:nds-strips' for r in old):
        raise ValueError('preserve independent strip index')
    owned = {r['png']: r for r in old}
    rows, rejected, ambiguous = [], [], []
    for candidate in candidates:
        if time.monotonic() - start > seconds:
            raise TimeoutError('native strip scan timebox exceeded')
        offset = int(candidate) * 4
        try:
            count = int(words[candidate])
            pairs = [struct.unpack_from('<II', data, offset + 4 + i * 8) for i in range(count)]
            previous = 4 + count * 8
            for relative, length in sorted(pairs):
                if relative < previous or not length or offset + relative + length > len(data):
                    raise ValueError('invalid/overlapping strip extent')
                previous = relative + length
            pal_offset, pal_size = pairs[0]
            bpp = 4 if pal_size == 32 else 8
            raw = []
            for relative, length in pairs[1:]:
                stored = data[offset + relative:offset + relative + length]
                if stored[0] not in (0x10, 0x11, 0x24, 0x28, 0x30):
                    raise ValueError('strip lacks supported compression header')
                raw.append(unlz(stored))
            lengths = {len(r) for r in raw}
            if len(lengths) != 1:
                raise ValueError('variable strip expansion size')
            expanded = lengths.pop()
            matches = [(x, y) for x, y in family if x * y * 64 * bpp // 8 == expanded]
            if len(matches) != 1:
                ambiguous.append({'offset': offset, 'count': count, 'palette_size': pal_size,
                                  'expanded_strip_bytes': expanded, 'matching_layouts': matches})
                continue
            x, y = matches[0]
            w, h = x * 8, y * 8 * (count - 1)
            dims(w, h)
            palette = data[offset + pal_offset:offset + pal_offset + pal_size]
            colors = np.frombuffer(palette, dtype='<u2')
            rgb = np.stack([colors & 31, (colors >> 5) & 31, (colors >> 10) & 31], axis=-1).astype(np.uint8)
            rgb = (rgb << 3) | (rgb >> 2)
            expanded_bytes = b''.join(raw)
            tile_ids = indices(expanded_bytes, bpp).reshape(y * (count - 1), x, 8, 8)
            tile_ids = tile_ids.transpose(0, 2, 1, 3).reshape(h, w)
            image = Image.fromarray(rgb[tile_ids])
            name = re.sub(r'[^A-Za-z0-9_.-]', '_', disc_path) + f'@{offset:08x}.png'
            path = folder / name
            if path.exists():
                if name not in owned:
                    raise ValueError('preserve unclaimed strip image')
                with Image.open(path) as existing:
                    if not np.array_equal(np.array(existing.convert('RGB')), np.array(image)):
                        raise ValueError('preserve changed strip image')
            else:
                image.save(path)
            row = {'file': disc_path, 'offset': offset, 'png': name, 'width': w, 'height': h,
                   'bpp': bpp, 'palette_offset': offset + pal_offset, 'palette_size': pal_size,
                   'palette_sha256': hashlib.sha256(palette).hexdigest(),
                   'expanded_sha256': hashlib.sha256(expanded_bytes).hexdigest(),
                   'source_file_sha256': source_hash, 'reference_sha256': reference_hash,
                   'documented_strip_tiles': [x, y], 'layout_binding': 'sole documented family member matching every native expansion',
                   'strips': [{'offset': offset + r, 'stored_size': s, 'expanded_size': len(b),
                               'stored_sha256': hashlib.sha256(data[offset + r:offset + r + s]).hexdigest()}
                              for (r, s), b in zip(pairs[1:], raw)],
                   'alpha': 'opaque; runtime transparency unbound', 'reference_names_offsets_used': False,
                   'method': 'disc:nds-strips', 'visual_acceptance': False}
            rows.append(row)
            owned[name] = row
        except (ValueError, struct.error, IndexError) as e:
            if str(e).startswith('preserve '):
                raise
            rejected.append({'offset': offset, 'reason': str(e)})
    after = source.stat()
    if (before.st_size, before.st_mtime_ns) != (after.st_size, after.st_mtime_ns):
        raise ValueError('source metadata changed')
    index.write_text(json.dumps(list(owned.values()), indent=2))
    result = {'source': str(source.resolve()), 'disc_path': disc_path, 'source_file_sha256': source_hash,
              'reference': str(reference.resolve()), 'reference_sha256': reference_hash,
              'documented_layout_family': family, 'native_headers': len(candidates), 'decoded': len(rows),
              'ambiguous': ambiguous, 'rejected': rejected, 'seconds': time.monotonic() - start,
              'source_size_mtime_unchanged': True, 'alpha': 'opaque; runtime transparency unbound',
              'reference_offset_name_binding': 'Not reused across regions; native table scan only',
              'visual_acceptance': 'pending sampled review; no runtime/background identity inferred'}
    (out / 'native-strips-scan.json').write_text(json.dumps(result, indent=2))
    return result


if __name__ == '__main__':
    p = argparse.ArgumentParser(description=__doc__)
    for name in ('source', 'reference', 'out'):
        p.add_argument('--' + name, type=Path, required=True)
    p.add_argument('--disc-path', required=True)
    p.add_argument('--seconds', type=int, default=1800)
    args = p.parse_args()
    result = export(args.source, args.disc_path, args.reference, args.out, args.seconds)
    print(json.dumps({k: v for k, v in result.items() if k not in ('ambiguous', 'rejected')}))
