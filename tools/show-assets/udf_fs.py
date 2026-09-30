"""Read-only ECMA-167 UDF view for ordinary type-1 physical partitions.

No mounts, programs, keys or writes. Locations returned by tree() are negative
opaque file handles, not image offsets; read() resolves allocation descriptors.
ISOOrUDF preserves ISO locations and only falls back for a missing/empty tree.
Reference: Linux fs/udf/ecma_167.h (structures only, never executed).
"""
import binascii
import struct


def u16(data, offset):
    return struct.unpack_from('<H', data, offset)[0]


def u32(data, offset):
    return struct.unpack_from('<I', data, offset)[0]


def tag(data, expected=None, location=None):
    if len(data) < 16:
        raise ValueError('truncated UDF descriptor tag')
    ident, version = u16(data, 0), u16(data, 2)
    length = u16(data, 10)
    if version not in (2, 3) or sum(data[:4] + data[5:16]) & 255 != data[4]:
        raise ValueError('invalid UDF tag checksum/version')
    if expected is not None and ident != expected:
        raise ValueError('unexpected UDF descriptor')
    if location is not None and u32(data, 12) != location:
        raise ValueError('UDF tag location mismatch')
    if length > len(data) - 16 or binascii.crc_hqx(data[16:16 + length], 0) != u16(data, 8):
        raise ValueError('invalid UDF descriptor CRC/length')
    required = {2: 32, 5: 196, 6: 440, 256: 416, 261: 176, 266: 216, 258: 24, 257: 38}.get(ident, 16)
    if 16 + length < required:
        raise ValueError('UDF descriptor fields outside CRC coverage')
    return ident


class UDFView:
    def __init__(self, reader):
        self.reader = reader
        self.entries = {}
        self.handles = {}
        self.partitions = {}
        total = getattr(reader, 'total', (reader.size - reader.base) // reader.sector * 2048)
        sectors = total // 2048
        anchor = None
        for lba in dict.fromkeys((256, sectors - 1, sectors - 257)):
            if lba < 0:
                continue
            try:
                candidate = reader.read(lba, 2048)
                tag(candidate, 2, lba)
                anchor = candidate
                break
            except (ValueError, OSError):
                continue
        if anchor is None:
            raise ValueError('no valid UDF anchor')
        volume = None
        self.maps = []
        length, start = u32(anchor, 16), u32(anchor, 20)
        if not 0 < length <= 1024 ** 2 or length % 2048:
            raise ValueError('invalid UDF descriptor sequence extent')
        terminated = False
        for lba in range(start, start + length // 2048):
            block = reader.read(lba, 2048)
            ident = tag(block, location=lba)
            if ident == 5:
                number = u16(block, 22)
                extent = (u32(block, 188), u32(block, 192))
                if not extent[1] or sum(extent) > sectors:
                    raise ValueError('UDF partition outside image')
                self.partitions[number] = extent
            elif ident == 6:
                if volume is None or u32(block, 16) > u32(volume, 16):
                    volume = block
            elif ident == 8:
                terminated = True
                break
            elif ident == 3:
                raise ValueError('UDF descriptor sequence continuations unsupported')
        if not terminated or volume is None or u32(volume, 212) != 2048:
            raise ValueError('unsupported UDF logical volume/block size')
        map_length, map_count = u32(volume, 264), u32(volume, 268)
        if map_length > len(volume) - 440 or 440 + map_length > 16 + u16(volume, 10) or not 0 < map_count <= 128:
            raise ValueError('invalid UDF partition map bounds')
        pos = 440
        for _ in range(map_count):
            if pos + 6 > 440 + map_length or volume[pos:pos + 2] != b'\x01\x06':
                raise ValueError('UDF type-2/VAT/sparing/metadata partition unsupported')
            number = u16(volume, pos + 4)
            if number not in self.partitions:
                raise ValueError('unbound UDF partition reference')
            self.maps.append(number)
            pos += 6
        if pos != 440 + map_length:
            raise ValueError('invalid UDF partition map length')
        fs_length, fs_block, fs_ref, fs_kind = self.long_ad(volume, 248)
        if fs_kind or fs_length < 512:
            raise ValueError('invalid UDF file set address')
        fs = self.block(fs_ref, fs_block)
        tag(fs, 256, fs_block)
        self.root = self.long_ad(fs, 400)

    @staticmethod
    def long_ad(data, pos):
        length = u32(data, pos)
        return length & 0x3fffffff, u32(data, pos + 4), u16(data, pos + 8), length >> 30

    def absolute(self, ref, block, length):
        if not 0 <= ref < len(self.maps):
            raise ValueError('invalid UDF partition reference')
        start, count = self.partitions[self.maps[ref]]
        if block < 0 or length < 0 or block * 2048 + length > count * 2048:
            raise ValueError('UDF extent outside partition')
        return start + block

    def block(self, ref, block):
        return self.reader.read(self.absolute(ref, block, 2048), 2048)

    def entry(self, address):
        length, block, ref, kind = address
        key = (ref, block)
        if key in self.entries:
            return self.entries[key]
        if kind or not 176 <= length <= 1024 ** 2:
            raise ValueError('invalid UDF file entry address')
        data = self.reader.read(self.absolute(ref, block, length), length)
        ident = tag(data, location=block)
        if ident not in (261, 266):
            raise ValueError('UDF indirect/terminal ICB unsupported')
        if u16(data, 20) != 4:
            raise ValueError('unsupported UDF ICB strategy')
        file_type, mode = data[27], u16(data, 34) & 7
        size = struct.unpack_from('<Q', data, 56)[0]
        header = 176 if ident == 261 else 216
        ea, ad_size = u32(data, header - 8), u32(data, header - 4)
        end = header + ea + ad_size
        if end > len(data) or end > 16 + u16(data, 10):
            raise ValueError('UDF allocation descriptors outside CRC-covered entry')
        allocation = data[header + ea:end]
        if mode == 3:
            if len(allocation) < size:
                raise ValueError('truncated UDF inline file')
            entry = {'type': file_type, 'size': size, 'inline': allocation[:size]}
        elif mode in (0, 1):
            # PS2 mastering tools sometimes use a full uint32 short-AD length
            # for a single large file. Accept only the self-consistent case:
            # the stored word equals informationLength, exceeds the 30-bit
            # field, and the full recorded extent fits the physical partition.
            # This cannot match a conforming hole's informationLength.
            if mode == 0 and len(allocation) == 8 and size > 0x3fffffff and u32(allocation, 0) == size:
                lba = self.absolute(ref, u32(allocation, 4), size)
                extents = [(0, lba, size)]
                self.entries.setdefault('_compat', []).append({'partition': ref, 'icb': block, 'size': size, 'dialect': 'ps2-full-uint32-short-ad'})
            else:
                extents = self.allocations(allocation, mode, ref, set())
            if sum(e[2] for e in extents) < size:
                raise ValueError('incomplete UDF allocation extent coverage')
            entry = {'type': file_type, 'size': size, 'extents': extents}
        else:
            raise ValueError('UDF extended allocation descriptors unsupported')
        self.entries[key] = entry
        handle = -(self.absolute(ref, block, length) + 1)
        self.handles[handle] = entry
        entry['handle'] = handle
        return entry

    def allocations(self, data, mode, ref, seen):
        stride = 8 if mode == 0 else 16
        if len(data) % stride:
            raise ValueError('misaligned UDF allocation descriptors')
        extents = []
        for pos in range(0, len(data), stride):
            word, block = u32(data, pos), u32(data, pos + 4)
            length, kind = word & 0x3fffffff, word >> 30
            part = ref if mode == 0 else u16(data, pos + 8)
            if not length:
                continue
            if kind == 3:
                key = (part, block)
                if key in seen or len(seen) >= 64 or not 24 <= length <= 1024 ** 2:
                    raise ValueError('invalid/cyclic UDF allocation continuation')
                seen.add(key)
                continuation = self.reader.read(self.absolute(part, block, length), length)
                tag(continuation, 258, block)
                n = u32(continuation, 20)
                if n > length - 24 or n + 24 > 16 + u16(continuation, 10):
                    raise ValueError('truncated UDF continuation descriptors')
                extents.extend(self.allocations(continuation[24:24 + n], mode, part, seen))
            else:
                # Only declared unrecorded/unallocated extents become zeroes.
                lba = self.absolute(part, block, length) if kind != 2 else None
                extents.append((kind, lba, length))
        return extents

    def read(self, handle, length, offset=0):
        entry = self.handles[handle]
        if min(offset, length) < 0 or offset + length > entry['size']:
            raise ValueError('UDF read outside file')
        if 'inline' in entry:
            return entry['inline'][offset:offset + length]
        result = bytearray()
        for kind, lba, size in entry['extents']:
            if offset >= size:
                offset -= size
                continue
            take = min(length - len(result), size - offset)
            if kind == 0:
                sector, within = divmod(offset, 2048)
                result.extend(self.reader.read(lba + sector, within + take)[within:])
            else:
                result.extend(bytes(take))
            offset = 0
            if len(result) == length:
                break
        if len(result) != length:
            raise ValueError('truncated UDF file read')
        return bytes(result)

    @staticmethod
    def filename(data):
        if not data or data[0] not in (8, 16):
            raise ValueError('unsupported UDF CS0 name compression')
        name = data[1:].decode('latin1' if data[0] == 8 else 'utf-16-be')
        if not name or name in ('.', '..') or any(c in name for c in '/\\\0'):
            raise ValueError('unsafe UDF filename')
        return name

    def tree(self):
        stack = [('', self.root, 0)]
        seen = set()
        count = 0
        while stack:
            prefix, address, depth = stack.pop()
            directory = self.entry(address)
            if directory['handle'] in seen:
                raise ValueError('cyclic/aliased UDF directory')
            seen.add(directory['handle'])
            if directory['type'] != 4 or depth > 128 or directory['size'] > 32 * 1024 ** 2:
                raise ValueError('invalid/oversized UDF directory')
            data = self.read(directory['handle'], directory['size'])
            pos = 0
            while pos < len(data):
                if data[pos:pos + 2] == b'\0\0':
                    if any(data[pos:]):
                        raise ValueError('nonzero bytes after UDF directory padding')
                    break
                if pos + 38 > len(data):
                    raise ValueError('truncated UDF directory identifier')
                name_length, flags, impl = data[pos + 19], data[pos + 18], u16(data, pos + 36)
                size = (38 + impl + name_length + 3) & ~3
                record = data[pos:pos + size]
                if len(record) != size:
                    raise ValueError('truncated UDF directory name')
                tag(record, 257)
                if 16 + u16(record, 10) < 38 + impl + name_length:
                    raise ValueError('UDF name outside descriptor CRC')
                address = self.long_ad(record, 20)
                pos += size
                if flags & (4 | 8):
                    continue
                name = prefix + self.filename(record[38 + impl:38 + impl + name_length])
                entry = self.entry(address)
                count += 1
                if count > 1000000:
                    raise ValueError('UDF file count exceeds bound')
                if flags & 2:
                    stack.append((name + '/', address, depth + 1))
                elif entry['type'] == 5:
                    yield name, entry['handle'], entry['size']
                else:
                    raise ValueError('UDF special/symlink file unsupported')


class ISOOrUDF:
    def __init__(self, reader):
        self.reader = reader
        self.udf = None
        self.filesystem = None

    def __getattr__(self, name):
        return getattr(self.reader, name)

    def tree(self):
        # ValueError from a malformed ISO remains an error, not hidden fallback.
        from disc_fs import Unsupported
        try:
            rows = list(self.reader.tree())
        except Unsupported:
            rows = []
        if rows:
            self.filesystem = 'iso9660'
            yield from rows
            return
        self.udf = UDFView(self.reader)
        self.filesystem = 'udf'
        yield from self.udf.tree()

    def read(self, location, length):
        if location < 0:
            if self.udf is None:
                raise ValueError('UDF handle requires a preceding tree walk')
            return self.udf.read(location, length)
        return self.reader.read(location, length)

    def files(self):
        for name, location, size in self.tree():
            yield name, self.read(location, size)
