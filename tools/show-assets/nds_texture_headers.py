"""Strict reader for documented 20-byte linear indexed texture headers.

Reference: Missingmew/phoenixtools controlHeader and DS texture formats in
GBATEK. Headerless tiles, archive layouts and runtime index-zero transparency
are not inferred. Indexed outputs preserve an opaque source palette; A3I5 and
A5I3 preserve their encoded alpha. All locations and paths are arguments.
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


def decode(data,off,palette_index=0):
    cut(data,off,20);fmt,x,y,flags=struct.unpack_from('<4B',data,off)
    if fmt not in (1,2,3,4,6) or x>5 or y>5 or flags:raise ValueError('unsupported texture header')
    hs,size,paloff,palsize=struct.unpack_from('<4I',data,off+4);w,h=8<<x,8<<y;dims(w,h)
    bpp={1:8,2:2,3:4,4:8,6:8}[fmt];colors={1:32,2:4,3:16,4:256,6:8}[fmt]
    if hs!=20 or size!=w*h*bpp//8 or paloff!=hs+size:raise ValueError('texture header extents disagree')
    if not palsize or palsize>512 or palsize%(colors*2) or not 0<=palette_index<palsize//(colors*2):raise ValueError('texture palette extent/index invalid')
    cut(data,off,paloff+palsize)
    words=np.frombuffer(cut(data,off+paloff+palette_index*colors*2,colors*2),dtype='<u2')
    rgb=np.stack([words&31,(words>>5)&31,(words>>10)&31],axis=-1).astype(np.uint8);rgb=(rgb<<3)|(rgb>>2)
    pal=np.column_stack([rgb,np.full(colors,255,dtype=np.uint8)])
    raw=np.frombuffer(cut(data,off+hs,size),dtype=np.uint8)
    if fmt==2:ids=np.stack([(raw>>i)&3 for i in (0,2,4,6)],axis=1).ravel()
    elif fmt==3:ids=indices(raw,4)
    elif fmt==1:ids=raw&31
    elif fmt==6:ids=raw&7
    else:ids=raw
    pixels=pal[ids].reshape(h,w,4)
    if fmt in (1,6):
        a=raw>>(5 if fmt==1 else 3)
        if fmt==1:a=(a<<2)|(a>>1)
        pixels[:,:,3]=((a<<3)|(a>>2)).reshape(h,w)
    info={'offset':off,'width':w,'height':h,'bpp':bpp,'texture_format':fmt,'header_size':hs,'image_size':size,'palette_offset':off+paloff,'palette_size':palsize,'palette_index':palette_index,'source_palette_banks':palsize//(colors*2),'layout':'linear','alpha':'encoded texel alpha' if fmt in (1,6) else 'opaque; runtime index-zero transparency unbound','method':'disc:nds-texture-header','source_extent':paloff+palsize}
    return Image.fromarray(pixels),info


def scan(data):
    # Fast candidate pass over only aligned header words; strict decoder verifies.
    array=np.frombuffer(data[:len(data)//4*4],dtype=np.uint8).reshape(-1,4)
    possible=np.flatnonzero(np.isin(array[:,0],[1,2,3,4,6])&(array[:,1]<=5)&(array[:,2]<=5)&(array[:,3]==0))
    for word in possible:
        off=int(word)*4
        try:yield decode(data,off)
        except (ValueError,struct.error,IndexError):continue


def export(source,out,seconds=1800,files=None):
    out=Path(out);folder=out/'raw'/'nds-texture';folder.mkdir(parents=True,exist_ok=True);index=folder/'index.json'
    old=json.loads(index.read_text()) if index.exists() else []
    if any(r.get('method')!='disc:nds-texture-header' for r in old):raise ValueError('preserve independent texture index')
    owned={r['png']:r for r in old};rows=[];failures=[];start=time.monotonic();source=Path(source);before=source.stat();fs=NitroFS(source)
    try:
        for name,offset,size in fs.tree():
            if time.monotonic()-start>seconds:failures.append({'reason':'timebox exceeded'});break
            if files is not None and name not in files:continue
            data=fs.read(offset,size);hashvalue=hashlib.sha256(data).hexdigest();compressed=False
            if data[:1] in (b'\x10',b'\x11',b'\x24',b'\x28',b'\x30'):
                try:expanded=unlz(data);compressed=expanded!=data;data=expanded
                except (ValueError,IndexError,struct.error) as e:failures.append({'file':name,'reason':str(e)})
            for im,info in scan(data):
                stem=re.sub(r'[^A-Za-z0-9_.-]','_',name)+f'@{info["offset"]:08x}.pal0.png';target=folder/stem
                if target.exists():
                    if stem not in owned:raise ValueError('preserve unclaimed texture image')
                    with Image.open(target) as prior:
                        if not np.array_equal(np.array(prior.convert('RGBA')),np.array(im)):raise ValueError('preserve changed texture image')
                else:im.save(target)
                row={**info,'png':stem,'file':name,'filesystem_offset':offset,'source_file_sha256':hashvalue,'inside_expanded_file':compressed,'visual_acceptance':False};rows.append(row);owned[stem]=row
    finally:fs.close()
    after=source.stat()
    if (before.st_size,before.st_mtime_ns)!=(after.st_size,after.st_mtime_ns):raise ValueError('source metadata changed')
    index.write_text(json.dumps(list(owned.values()),indent=2))
    result={'source':str(source.resolve()),'source_size_mtime_unchanged':True,'decoded_headers':len(rows),'method':'disc:nds-texture-header','seconds':time.monotonic()-start,'failures':failures,'notes':['Opaque indexed pixels preserved; runtime index-zero transparency is not inferred. Alternate palette banks remain unbound. Headerless and proprietary packed textures remain unextracted.']}
    (out/'native-texture-scan.json').write_text(json.dumps(result,indent=2));return result


if __name__=='__main__':
    p=argparse.ArgumentParser(description=__doc__)
    for key in ('source','out'):p.add_argument('--'+key,type=Path,required=True)
    p.add_argument('--seconds',type=int,default=1800);p.add_argument('--file',action='append')
    a=p.parse_args();print(json.dumps(export(a.source,a.out,a.seconds,a.file)))
