"""Create private synthetic UDF fixtures and exercise read-only fallback/bounds."""
import argparse
import binascii
import json
import struct
from pathlib import Path
from disc_fs import Reader, open_disc
from udf_fs import ISOOrUDF, UDFView


def put(data, offset, fmt, *values):
    struct.pack_into('<' + fmt, data, offset, *values)


def descriptor(ident, location, data):
    put(data, 0, 'HHBBHHHI', ident, 2, 0, 0, 1,
        binascii.crc_hqx(data[16:], 0), len(data) - 16, location)
    data[4] = sum(data[:4] + data[5:16]) & 255
    return data


def long(length, block, part=0):
    return struct.pack('<IIH6x', length, block, part)


def entry(block, typ, mode, size, allocation, extended=False):
    header = 216 if extended else 176
    data = bytearray(header + len(allocation))
    put(data, 20, 'H', 4)
    data[27] = typ
    put(data, 34, 'H', mode)
    put(data, 56, 'Q', size)
    put(data, header - 8, 'II', 0, len(allocation))
    data[header:] = allocation
    return descriptor(266 if extended else 261, block, data)


def main():
    ap = argparse.ArgumentParser(description=__doc__)
    ap.add_argument('--out', required=True, type=Path)
    args = ap.parse_args()
    args.out.mkdir(parents=True, exist_ok=True)
    image = bytearray(400 * 2048)

    def store(lba, data):
        image[lba * 2048:lba * 2048 + len(data)] = data

    anchor = bytearray(512)
    put(anchor, 16, 'II', 3 * 2048, 32)
    store(256, descriptor(2, 256, anchor))
    partition = bytearray(512)
    put(partition, 22, 'H', 0)
    put(partition, 188, 'II', 300, 80)
    store(32, descriptor(5, 32, partition))
    volume = bytearray(446)
    put(volume, 212, 'I', 2048)
    volume[248:264] = long(2048, 0)
    put(volume, 264, 'II', 6, 1)
    volume[440:446] = b'\x01\x06\x01\x00\x00\x00'
    store(33, descriptor(6, 33, volume))
    store(34, descriptor(8, 34, bytearray(512)))
    fs = bytearray(512)
    fs[400:416] = long(2048, 1)
    store(300, descriptor(256, 0, fs))
    expected = {
        'fragmented.bin': b'A' * 2100 + bytes(9) + b'B' * 27,
        'continuation.bin': b'C' * 99 + b'D' * 71,
        '日本-inline.bin': b'native inline fixture',
        'extended.bin': b'E' * 51,
    }
    records = bytearray()
    for block, name in enumerate(expected, 2):
        encoded = b'\x10' + name.encode('utf-16-be')
        fid = bytearray((38 + len(encoded) + 3) & ~3)
        put(fid, 16, 'H', 1)
        fid[19] = len(encoded)
        fid[20:36] = long(2048, block)
        fid[38:38 + len(encoded)] = encoded
        records.extend(descriptor(257, 1, fid))
    store(301, entry(1, 4, 3, len(records), records))
    short = struct.pack('<6I', 2100, 20, (2 << 30) | 9, 0, 27, 22)
    store(302, entry(2, 5, 0, len(expected['fragmented.bin']), short))
    store(320, b'A' * 2100)
    store(322, b'B' * 27)
    allocation = long(99, 23) + long((3 << 30) | 40, 6)
    store(303, entry(3, 5, 1, 170, allocation))
    continuation = bytearray(40)
    put(continuation, 20, 'I', 16)
    continuation[24:] = long(71, 24)
    store(306, descriptor(258, 6, continuation))
    store(323, b'C' * 99)
    store(324, b'D' * 71)
    store(304, entry(4, 5, 3, len(expected['日本-inline.bin']), expected['日本-inline.bin']))
    store(305, entry(5, 5, 0, 51, struct.pack('<II', 51, 25), extended=True))
    store(325, b'E' * 51)
    path = args.out / 'synthetic.iso'
    path.write_bytes(image)
    checks = []
    for empty_iso in (False, True):
        if empty_iso:
            source = Reader(path)
            source.tree = lambda: iter(())
            reader = ISOOrUDF(source)
        else:
            reader = open_disc(path, 'ps2')
        try:
            actual = dict(reader.files())
            assert actual == expected
            assert reader.filesystem == 'udf'
            for name, handle, size in reader.tree():
                for offset in range(0, size, 7):
                    n = min(13, size - offset)
                    assert reader.udf.read(handle, n, offset) == expected[name][offset:offset + n]
            checks.append('empty ISO fallback' if empty_iso else 'missing ISO fallback')
        finally:
            reader.close()
    # CRC, partition boundaries, unsafe names, and continuation loops fail.
    bad = bytearray(image)
    bad[256 * 2048 + 20] ^= 1
    badpath = args.out / 'corrupt.iso'
    badpath.write_bytes(bad)
    source = Reader(badpath)
    try:
        try:
            UDFView(source)
        except ValueError:
            checks.append('corrupt anchor rejected')
        else:
            raise AssertionError('accepted corrupt anchor')
    finally:
        source.close()
    for invalid in (b'\x08../x', b'\x08..', b'\x08bad\\path', b'\x08bad\0name'):
        try:
            UDFView.filename(invalid)
        except ValueError:
            pass
        else:
            raise AssertionError('accepted unsafe name')
    checks.append('unsafe names rejected')
    source = Reader(path)
    try:
        view = UDFView(source)
        for block, length in ((80, 1), (79, 2049), (-1, 1)):
            try:
                view.absolute(0, block, length)
            except ValueError:
                pass
            else:
                raise AssertionError('accepted partition overrun')
        checks.append('partition bounds rejected')
        # Continuation points back to itself with a fresh, valid checksum.
        cyclic = bytearray(image)
        continuation[24:] = long((3 << 30) | 40, 6)
        data = descriptor(258, 6, continuation)
        cyclic[306 * 2048:306 * 2048 + len(data)] = data
        cyclepath = args.out / 'cyclic.iso'
        cyclepath.write_bytes(cyclic)
        cycle_reader = Reader(cyclepath)
        try:
            try:
                list(UDFView(cycle_reader).tree())
            except ValueError as e:
                assert 'cyclic' in str(e)
            else:
                raise AssertionError('accepted cyclic allocation')
        finally:
            cycle_reader.close()
        checks.append('cyclic allocation rejected')
    finally:
        source.close()
    result = {'passed': checks, 'files': len(expected), 'bytes': sum(map(len, expected.values())),
              'modes': ['short multipart', 'declared hole', 'long AD continuation', 'inline', 'extended file entry', 'CS0 UTF16'],
              'scope': 'Synthetic format verification, not new game image coverage.'}
    (args.out / 'structural-check.json').write_text(json.dumps(result, indent=2))
    print(json.dumps(result))


if __name__ == '__main__':
    main()
