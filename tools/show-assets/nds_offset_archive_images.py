"""Export an explicitly mapped offset/size archive of self-paletted tile frames.

Public reference: Missingmew/phoenixtools pacEntry, extract-archive.c and
palette-prefix tile conventions. Tile dimensions/depth must be supplied from
verified format evidence. No row-coherence search, palette guessing or timing
inference. Native frame order is retained; source ROM is always read-only.
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
from image_formats import cut,dims,indices,unlz


def export(source,disc_path,out,archive_offset,tiles_x,tiles_y,bpp,seconds=1800):
    if bpp not in (4,8):raise ValueError('unsupported tile depth')
    w,h=tiles_x*8,tiles_y*8;dims(w,h);ncolors=1<<bpp;expected=ncolors*2+w*h*bpp//8
    source=Path(source);before=source.stat();fs=NitroFS(source);start=time.monotonic();rows=[]
    try:
        table={n:(o,l) for n,o,l in fs.tree()}
        where,length=table[disc_path];data=fs.read(where,length);sourcehash=hashlib.sha256(data).hexdigest()
    finally:fs.close()
    cut(data,archive_offset,4);n=struct.unpack_from('<I',data,archive_offset)[0]
    if not 1<=n<=65535:raise ValueError('invalid offset archive count')
    cut(data,archive_offset+4,n*8);minimum=4+n*8;previous=minimum
    folder=Path(out)/'raw/nds-offset-frames';folder.mkdir(parents=True,exist_ok=True);index=folder/'index.json';old=json.loads(index.read_text()) if index.exists() else []
    if any(r.get('method')!='disc:nds-offset-frames' for r in old):raise ValueError('preserve independent frame index')
    owned={r['png']:r for r in old}
    for i in range(n):
        if time.monotonic()-start>seconds:raise TimeoutError('offset archive timebox exceeded')
        rel,size=struct.unpack_from('<II',data,archive_offset+4+i*8)
        if rel<previous or not size:raise ValueError('invalid/overlapping archive entry')
        previous=rel+size;stored=cut(data,archive_offset+rel,size)
        if stored[:1] not in (b'\x10',b'\x11',b'\x24',b'\x28',b'\x30'):raise ValueError('entry has no supported compression header')
        raw=unlz(stored)
        if len(raw)!=expected:raise ValueError('mapped palette/tile extent does not match expansion')
        colors=np.frombuffer(raw[:ncolors*2],dtype='<u2');rgb=np.stack([colors&31,(colors>>5)&31,(colors>>10)&31],axis=-1).astype(np.uint8);rgb=(rgb<<3)|(rgb>>2)
        ids=indices(raw[ncolors*2:],bpp).reshape(tiles_y,tiles_x,8,8).transpose(0,2,1,3).reshape(h,w);im=Image.fromarray(rgb[ids])
        name=re.sub(r'[^A-Za-z0-9_.-]','_',disc_path)+f'@{archive_offset+rel:08x}.frame{i:05d}.png';path=folder/name
        if path.exists():
            if name not in owned:raise ValueError('preserve unclaimed frame')
            with Image.open(path) as oldimage:
                if not np.array_equal(np.array(oldimage.convert('RGB')),np.array(im)):raise ValueError('preserve changed frame')
        else:im.save(path)
        row={'file':disc_path,'archive_offset':archive_offset,'archive_index':i,'offset':archive_offset+rel,'png':name,'width':w,'height':h,'bpp':bpp,'layout':'8x8 tiles','palette_prefix_size':ncolors*2,'compression_header':stored[0],'stored_size':size,'expanded_size':len(raw),'stored_sha256':hashlib.sha256(stored).hexdigest(),'expanded_sha256':hashlib.sha256(raw).hexdigest(),'source_file_sha256':sourcehash,'alpha':'opaque; runtime transparency unbound','timing':'unknown; no durations inferred','method':'disc:nds-offset-frames','visual_acceptance':False};rows.append(row);owned[name]=row
    after=source.stat()
    if (before.st_size,before.st_mtime_ns)!=(after.st_size,after.st_mtime_ns):raise ValueError('source metadata changed')
    index.write_text(json.dumps(list(owned.values()),indent=2));result={'source':str(source.resolve()),'source_size_mtime_unchanged':True,'disc_path':disc_path,'archive_offset':archive_offset,'decoded_frames':len(rows),'mapping':{'tiles_x':tiles_x,'tiles_y':tiles_y,'bpp':bpp},'seconds':time.monotonic()-start,'timing':'unknown; source order retained, no durations inferred'}
    (Path(out)/'native-offset-frames-scan.json').write_text(json.dumps(result,indent=2));return result


if __name__=='__main__':
    p=argparse.ArgumentParser(description=__doc__)
    for key in ('source','out'):p.add_argument('--'+key,type=Path,required=True)
    p.add_argument('--disc-path',required=True)
    for key in ('archive-offset','tiles-x','tiles-y','bpp'):p.add_argument('--'+key,type=lambda v:int(v,0),required=True)
    p.add_argument('--seconds',type=int,default=1800);a=p.parse_args();print(json.dumps(export(a.source,a.disc_path,a.out,a.archive_offset,a.tiles_x,a.tiles_y,a.bpp,a.seconds)))
