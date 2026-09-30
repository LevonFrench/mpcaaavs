"""Read documented CPAC BKEY/BDAT tables and self-paletted image entries.

Reference structures: Missingmew/phoenixtools extract-apollo-cpac.c and
convert-apollo-image.c (reference text only). PKEY/PDAT palette associations
and headerless graphics are retained as unsupported, never guessed. Paths,
file selection and wall-clock limit are arguments; ROM access is read-only.
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
from image_formats import cut, dims, indices, unlz
from nds_texture_headers import decode as linear_texture


def members(data,notes):
    cut(data,0,8);first=struct.unpack_from('<I',data)[0]
    if not 8<=first<=4096 or first%8:raise ValueError('invalid CPAC root table')
    cut(data,0,first);previous=first
    for arc_index in range(first//8):
        off,size=struct.unpack_from('<II',data,arc_index*8)
        if off<previous or size<24:raise ValueError('overlapping/short CPAC subarchive')
        arc=cut(data,off,size);previous=off+size;hs,count=struct.unpack_from('<II',arc)
        if count!=2 or hs!=24:raise ValueError('unsupported CPAC section header')
        key,keys,body,begin=struct.unpack_from('<4sI4sI',arc,8)
        if keys!=hs or not hs<=begin<=size:raise ValueError('invalid CPAC section offsets')
        if key==b'YEKP' and body==b'TADP':
            notes.append({'subarchive':arc_index,'offset':off,'reason':'PKEY/PDAT palette associations unbound'});continue
        if key!=b'YEKB' or body!=b'TADB' or (begin-hs)%8:raise ValueError('unsupported CPAC table signature')
        n=(begin-hs)//8
        for i in range(n):
            rel,flags=struct.unpack_from('<II',arc,hs+i*8);length=flags&0x7fffffff
            if not length:continue
            raw=cut(arc,begin+rel,length)
            try:
                decoded=unlz(raw) if flags>>31 else raw
                if flags>>31 and raw[:1] not in (b'\x10',b'\x11',b'\x24',b'\x28',b'\x30'):raise ValueError('unsupported CPAC compression header')
            except (ValueError,IndexError,struct.error) as e:
                notes.append({'subarchive':arc_index,'entry':i,'reason':str(e)});continue
            yield decoded,{'subarchive':arc_index,'entry':i,'offset':off+begin+rel,'compressed':bool(flags>>31),'compressed_size':length,'expanded_size':len(decoded),'stored_sha256':hashlib.sha256(raw).hexdigest(),'expanded_sha256':hashlib.sha256(decoded).hexdigest()}


def tiled_texture(data):
    cut(data,0,4);head=struct.unpack_from('<I',data)[0];w=head&65535;h=(head>>16)&32767;bpp=4 if head>>31 else 8
    dims(w,h)
    if w%8 or h%8:raise ValueError('tiled image dimensions not multiples of eight')
    n=1<<bpp;size=w*h*bpp//8
    if len(data)!=4+n*2+size:raise ValueError('tiled size header does not match member extent')
    words=np.frombuffer(cut(data,4,n*2),dtype='<u2');rgb=np.stack([words&31,(words>>5)&31,(words>>10)&31],axis=-1).astype(np.uint8);rgb=(rgb<<3)|(rgb>>2)
    pal=np.column_stack([rgb,np.full(n,255,dtype=np.uint8)]);ids=indices(cut(data,4+n*2,size),bpp)
    ids=ids.reshape(h//8,w//8,8,8).transpose(0,2,1,3).reshape(h,w)
    return Image.fromarray(pal[ids]),{'width':w,'height':h,'bpp':bpp,'layout':'8x8 tiles','header_size':4,'palette_offset':4,'palette_size':n*2,'alpha':'opaque; runtime index-zero transparency unbound','encoding':'tiled-size-header'}


def export(source,out,files,seconds=1800):
    out=Path(out);folder=out/'raw/nds-cpac';folder.mkdir(parents=True,exist_ok=True);index=folder/'index.json'
    old=json.loads(index.read_text()) if index.exists() else []
    if any(r.get('method')!='disc:nds-cpac-image' for r in old):raise ValueError('preserve independent CPAC index')
    owned={r['png']:r for r in old};rows=[];notes=[];source=Path(source);before=source.stat();start=time.monotonic();fs=NitroFS(source);seen=[];nonimages=0
    try:
        for name,where,size in fs.tree():
            if name not in files:continue
            seen.append(name);data=fs.read(where,size);sourcehash=hashlib.sha256(data).hexdigest()
            for payload,info in members(data,notes):
                if time.monotonic()-start>seconds:raise TimeoutError('CPAC timebox exceeded')
                try:im,texture=tiled_texture(payload)
                except (ValueError,IndexError,struct.error):
                    try:
                        im,texture=linear_texture(payload,0)
                        if texture['source_extent']!=len(payload):raise ValueError('linear texture does not fill member')
                        texture['encoding']='linear-texture-header'
                    except (ValueError,IndexError,struct.error):nonimages+=1;continue
                stem=re.sub(r'[^A-Za-z0-9_.-]','_',name)+f'@{info["offset"]:08x}.arc{info["subarchive"]}.entry{info["entry"]}.png';target=folder/stem
                if target.exists():
                    if stem not in owned:raise ValueError('preserve unclaimed CPAC image')
                    with Image.open(target) as previous:
                        if not np.array_equal(np.array(previous.convert('RGBA')),np.array(im)):raise ValueError('preserve changed CPAC image')
                else:im.save(target)
                row={**texture,**info,'png':stem,'file':name,'filesystem_offset':where,'source_file_sha256':sourcehash,'method':'disc:nds-cpac-image','visual_acceptance':False};owned[stem]=row;rows.append(row)
    except TimeoutError as e:notes.append({'reason':str(e)})
    finally:fs.close()
    after=source.stat()
    if (before.st_size,before.st_mtime_ns)!=(after.st_size,after.st_mtime_ns):raise ValueError('source metadata changed')
    if set(seen)!=set(files):raise ValueError('requested CPAC file missing from NitroFS')
    index.write_text(json.dumps(list(owned.values()),indent=2));result={'source':str(source.resolve()),'files':seen,'source_size_mtime_unchanged':True,'decoded_images':len(rows),'unrecognized_members':nonimages,'notes':notes,'seconds':time.monotonic()-start}
    (out/'native-cpac-scan.json').write_text(json.dumps(result,indent=2));return result


if __name__=='__main__':
    p=argparse.ArgumentParser(description=__doc__)
    for key in ('source','out'):p.add_argument('--'+key,type=Path,required=True)
    p.add_argument('--file',action='append',required=True);p.add_argument('--seconds',type=int,default=1800)
    a=p.parse_args();print(json.dumps(export(a.source,a.out,a.file,a.seconds)))
