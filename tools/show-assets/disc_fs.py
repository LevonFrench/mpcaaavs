"""Read-only disc filesystem adapters. All paths/tool locations are arguments.

Container conversions belong in caller-owned scratch. No emulator is launched.
Unsupported/encrypted formats fail explicitly rather than scanning ciphertext.
"""
from pathlib import Path
import struct
import zlib
import shlex
import mmap


class Unsupported(ValueError):
    pass


class Reader:
    def __init__(self, path, sector=2048, user=0, base=0, lba_bias=0):
        self.path = Path(path)
        self.f = self.path.open('rb')
        self.size = self.path.stat().st_size
        self.sector, self.user, self.base, self.lba_bias = sector, user, base, lba_bias

    def close(self):
        self.f.close()

    def physical(self, offset, length):
        if offset < 0 or length < 0 or offset + length > self.size:
            raise ValueError('extent outside container')
        self.f.seek(offset)
        data = self.f.read(length)
        if len(data) != length:
            raise ValueError('truncated container')
        return data

    def read(self, lba, length):
        lba -= self.lba_bias
        if self.sector == 2048:
            return self.physical(self.base + lba * 2048, length)
        out = bytearray()
        while len(out) < length:
            out.extend(self.physical(self.base + lba * self.sector + self.user, min(2048, length-len(out))))
            lba += 1
        return bytes(out)

    def tree(self):
        pvd = self.read(16+self.lba_bias, 2048)
        if pvd[:7] != b'\x01CD001\x01':
            raise Unsupported('ISO9660 PVD unavailable')
        root = pvd[156:190]
        stack = [('', struct.unpack_from('<I',root,2)[0],struct.unpack_from('<I',root,10)[0])]
        seen=set()
        while stack:
            prefix,lba,size=stack.pop()
            if lba in seen: continue
            seen.add(lba)
            if size > 32*1024**2: raise ValueError('oversized ISO directory')
            data=self.read(lba,size); pos=0
            while pos<len(data):
                n=data[pos]
                if not n:
                    pos=(pos//2048+1)*2048; continue
                rec=data[pos:pos+n];pos+=n
                if n<34 or len(rec)!=n or 33+rec[32]>n:
                    raise ValueError('invalid ISO directory record')
                name=rec[33:33+rec[32]]
                if name in (b'\0',b'\1'):continue
                name=name.decode('ascii','replace').split(';')[0]
                l,s=struct.unpack_from('<I',rec,2)[0],struct.unpack_from('<I',rec,10)[0]
                if rec[25]&2:stack.append((prefix+name+'/',l,s))
                else:yield prefix+name,l,s

    def files(self):
        for name,lba,size in self.tree():
            yield name,self.read(lba,size)


class CISO(Reader):
    def __init__(self,path):
        super().__init__(path)
        h=self.physical(0,24)
        magic,hs,total,block,version,align=struct.unpack_from('<4sIQIBB',h)
        if magic!=b'CISO' or block<2048 or block>1024*1024 or block%2048 or hs not in (0,24) or align>16 or version>1:
            raise Unsupported('unsupported CISO header')
        self.total,self.block,self.align=total,block,align
        count=(total+block-1)//block
        self.index=struct.unpack('<'+str(count+1)+'I',self.physical(hs or 24,(count+1)*4))

    def read(self,lba,length):
        if lba<0 or lba*2048+length>self.total:raise ValueError('CISO extent outside image')
        out=bytearray();offset=lba*2048
        while len(out)<length:
            idx,within=divmod(offset,self.block)
            a,b=self.index[idx:idx+2]; off=(a&0x7fffffff)<<self.align
            expected=min(self.block,self.total-idx*self.block)
            if a&0x80000000:data=self.physical(off,expected)
            else:
                encoded=self.physical(off,((b&0x7fffffff)<<self.align)-off)
                d=zlib.decompressobj(-15);data=d.decompress(encoded,self.block+1)
                if not d.eof or len(data) not in (expected,self.block):raise ValueError('invalid CISO block')
            take=min(length-len(out),expected-within)
            out.extend(data[within:within+take]);offset+=take
        return bytes(out[:length])


class NitroFS(Reader):
    def read(self,offset,length):
        return self.physical(offset,length)

    def tree(self):
        h=self.physical(0,0x50)
        fo,fs,ao,asz=struct.unpack_from('<4I',h,0x40)
        fnt=self.physical(fo,fs);fat=self.physical(ao,asz)
        if len(fnt)<8 or asz%8:raise ValueError('invalid NitroFS tables')
        count=struct.unpack_from('<H',fnt,6)[0]
        if not 1<=count<=4096 or count*8>len(fnt):raise ValueError('invalid NitroFS directory count')
        stack=[('',0)];seen=set()
        while stack:
            prefix,i=stack.pop()
            if i in seen:continue
            seen.add(i)
            if i>=count:raise ValueError('invalid NitroFS directory id')
            off,idx,_=struct.unpack_from('<IHH',fnt,i*8)
            while off<len(fnt):
                n=fnt[off];off+=1
                if not n:break
                size=n&127;name=fnt[off:off+size].decode('ascii','replace');off+=size
                if n&128:
                    child=struct.unpack_from('<H',fnt,off)[0]&0xfff;off+=2
                    stack.append((prefix+name+'/',child))
                else:
                    a,b=struct.unpack_from('<II',fat,idx*8);idx+=1
                    if b<a or b>self.size:raise ValueError('invalid NitroFS file extent')
                    yield prefix+name,a,b-a

    def files(self):
        for name,offset,size in self.tree():yield name,self.physical(offset,size)


class GameCube(Reader):
    def read(self,offset,length):
        return self.physical(offset,length)

    def tree(self):
        h=self.physical(0,0x440)
        if h[0x18:0x1c]==b'\x5d\x1c\x9e\xa3':
            raise Unsupported('Wii encrypted partitions: no keys searched or used')
        if h[0x1c:0x20]!=b'\xc2\x33\x9f\x3d':raise Unsupported('not an unencrypted GameCube image')
        off,size=struct.unpack_from('>II',h,0x424)
        fst=self.physical(off,size);count=struct.unpack_from('>I',fst,8)[0]
        if count*12>len(fst):raise ValueError('invalid FST size')
        parents=[('',count)]
        for i in range(1,count):
            while i>=parents[-1][1]:parents.pop()
            a,b,c=struct.unpack_from('>III',fst,i*12)
            start=count*12+(a&0xffffff);end=fst.find(b'\0',start)
            if end<0:raise ValueError('unterminated FST name')
            name=parents[-1][0]+fst[start:end].decode('ascii','replace')
            if a>>24:parents.append((name+'/',c))
            else:yield name,b,c

    def files(self):
        for name,offset,size in self.tree():yield name,self.physical(offset,size)


class GCZ(GameCube):
    def __init__(self,path):
        super().__init__(path)
        magic,subtype,compressed,total,block,count=struct.unpack('<IIQQII',Reader.physical(self,0,32))
        if magic!=0xb10bc001 or not 0<block<=16*1024**2 or count!=(total+block-1)//block:raise ValueError('invalid GCZ header')
        self.total,self.block,self.compressed=total,block,compressed
        self.index=struct.unpack('<'+str(count)+'Q',Reader.physical(self,32,count*8))
        self.hashes=struct.unpack('<'+str(count)+'I',Reader.physical(self,32+count*8,count*4))
        self.payload=32+count*12;self.cache={}

    def physical(self,offset,length):
        if offset<0 or offset+length>self.total:raise ValueError('GCZ extent outside image')
        result=bytearray();mask=(1<<63)-1
        while len(result)<length:
            i,within=divmod(offset,self.block)
            if i not in self.cache:
                a=self.index[i];b=(self.index[i+1]&mask) if i+1<len(self.index) else self.compressed
                raw=Reader.physical(self,self.payload+(a&mask),b-(a&mask))
                if zlib.adler32(raw)&0xffffffff!=self.hashes[i]:raise ValueError('GCZ block hash mismatch')
                if a>>63:data=raw
                else:
                    d=zlib.decompressobj();data=d.decompress(raw,self.block+1)
                    if not d.eof:raise ValueError('truncated GCZ block')
                if len(data)!=self.block:raise ValueError('GCZ expansion size mismatch')
                self.cache.clear();self.cache[i]=data
            n=min(length-len(result),self.block-within)
            result.extend(self.cache[i][within:within+n]);offset+=n
        return bytes(result)


class WAD(Reader):
    """Inspect installable WAD content extents without reading tickets or keys."""
    def content_metadata(self):
        h=self.physical(0,32)
        hs,kind,version,cert,reserved,ticket,tmd,content,footer=struct.unpack('>I2sH6I',h)
        if hs!=32 or kind not in (b'Is',b'ib') or version or reserved:
            raise Unsupported('unsupported WAD header')
        align=lambda n:(n+63)&~63
        tmd_at=align(hs)+align(cert)+align(ticket)
        content_at=tmd_at+align(tmd)
        if content_at+content+footer>self.size:raise ValueError('WAD sections outside container')
        # Skip certificate/ticket bytes entirely; only public table fields read.
        sig=struct.unpack('>I',self.physical(tmd_at,4))[0]
        body={0x10000:0x240,0x10001:0x140,0x10002:0x80}.get(sig)
        if body is None:raise Unsupported('unknown WAD metadata layout')
        count=struct.unpack('>H',self.physical(tmd_at+body+0x9e,2))[0]
        table_at=body+0xa4
        if not 0<count<=4096 or table_at+count*36>tmd:raise ValueError('invalid WAD content table')
        rows=[];offset=content_at
        for i in range(count):
            cid,index,typ,size=struct.unpack('>IHHQ',self.physical(tmd_at+table_at+i*36,16))
            encrypted_size=(size+15)&~15
            if offset+encrypted_size>content_at+content:raise ValueError('WAD content extent outside section')
            rows.append({'content_id':f'{cid:08x}','index':index,'type':typ,'size':size,'container_offset':offset,'stored_size':encrypted_size,'readable':False,'reason':'encrypted content; no keys searched or used'})
            offset+=align(encrypted_size)
        return {'container':'wad','content_count':count,'content_section_offset':content_at,'content_section_size':content,'contents':rows,'status':'skipped','reason':'Content files parsed, but encrypted payloads require keys. Ticket and certificate bytes were not read.'}

    def tree(self):
        metadata=self.content_metadata()
        raise Unsupported(f'WAD: {metadata["content_count"]} encrypted contents parsed; no keys searched or used')


def open_disc(path, system=''):
    from udf_fs import ISOOrUDF, UDFView
    path=Path(path);ext=path.suffix.lower()
    if ext in ('.7z','.rar','.zip'):raise Unsupported('archive')
    if ext=='.nds':return NitroFS(path)
    if ext=='.cso':return ISOOrUDF(CISO(path))
    if ext=='.gcz':return GCZ(path)
    if ext=='.wad':return WAD(path)
    if ext in ('.rvz','.wbfs'):raise Unsupported(ext[1:]+' encrypted/compressed container reader unavailable; no keys searched')
    if ext=='.gdi':
        for line in path.read_text().splitlines()[1:]:
            cols=shlex.split(line)
            if len(cols)==6 and int(cols[1])>=45000 and cols[2]=='4':
                return Reader(path.parent/cols[4],int(cols[3]),16 if cols[3]=='2352' else 0,int(cols[5]),int(cols[1]))
        raise Unsupported('no high-density GDI data track')
    if ext=='.mds':path=path.with_suffix('.mdf')
    if system in ('gc','wii'):return GameCube(path)
    r=Reader(path)
    for sector,user in ((2048,0),(2352,24),(2352,16),(2336,8)):
        try:
            if r.physical(16*sector+user,7)==b'\x01CD001\x01':
                r.sector,r.user=sector,user;return ISOOrUDF(r) if sector==2048 else r
        except ValueError:pass
    if ext=='.cdi':
        with mmap.mmap(r.f.fileno(),0,access=mmap.ACCESS_READ) as mm:
            pos=0
            while True:
                pos=mm.find(b'\x01CD001\x01',pos)
                if pos<0:break
                pvd=pos;pos+=7
                if pvd+2048>r.size:continue
                root=struct.unpack_from('<I',mm,pvd+158)[0]
                for sector,user in ((2048,0),(2352,16),(2352,24),(2336,8)):
                    base=pvd-16*sector-user
                    if base<0:continue
                    if not mm[base+user:base+user+16].startswith(b'SEGA SEGAKATANA'):continue
                    for rel in range(17,65):
                        loc=base+rel*sector+user
                        rec=mm[loc:loc+34]
                        if len(rec)==34 and rec[0]>=34 and rec[25]&2 and rec[32:34]==b'\x01\x00' and struct.unpack_from('<I',rec,2)[0]==root:
                            r.sector,r.user,r.base,r.lba_bias=sector,user,base,root-rel;return r
    udf_error = ''
    if ext in ('.iso','.mdf','.mds'):
        r.sector,r.user=2048,0
        try:
            UDFView(r)
            return ISOOrUDF(r)
        except (ValueError,OSError) as e:udf_error = '; UDF: '+str(e)
    r.close()
    raise Unsupported('no ISO9660 PVD at sector 16; CDI track discovery unavailable'+udf_error)
