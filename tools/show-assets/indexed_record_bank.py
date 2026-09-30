"""Decode explicit indexed record banks with embedded native 256-color CLUTs.

All layout values are caller supplied. Source bytes are read-only; existing
outputs are compared and preserved. This is not an automatic palette guesser.
"""
import argparse
import hashlib
import json
import re
import struct
from pathlib import Path
import numpy as np
from PIL import Image
from psx_extract import rgb555


def untile(data, width, height, tile_width=64, tile_height=32, remainder_first=False):
    if width%tile_width or len(data)!=width*height:
        raise ValueError('tile layout must exactly cover indexed image')
    a=np.frombuffer(data,dtype=np.uint8)
    if not height%tile_height:
        return a.reshape(height//tile_height,width//tile_width,tile_height,tile_width).transpose(0,2,1,3).reshape(height,width)
    remaining=height%tile_height
    groups=[tile_height]*(height//tile_height)
    if remainder_first:groups.insert(0,remaining)
    else:groups.append(remaining)
    out=np.empty((height,width),dtype=np.uint8);pos=0;y=0
    for rows in groups:
        for x in range(0,width,tile_width):
            n=rows*tile_width;out[y:y+rows,x:x+tile_width]=a[pos:pos+n].reshape(rows,tile_width);pos+=n
        y+=rows
    return out


def export(data, disc_path, out, width, height, start, stride, pixel_offset, palette_offset, count, layout):
    out=Path(out)
    if width<=0 or height<=0 or width*height>16777216 or count<=0 or count>65536:
        raise ValueError('invalid image dimensions/count')
    if min(start,pixel_offset,palette_offset)<0 or stride<=0:
        raise ValueError('negative record offset or invalid stride')
    if max(pixel_offset+width*height,palette_offset+512)>stride or start+count*stride>len(data):
        raise ValueError('record outside source')
    a,b=pixel_offset,palette_offset
    if a<b+512 and b<a+width*height:raise ValueError('pixel/palette extents overlap')
    out.mkdir(parents=True,exist_ok=True);index=out/'index.json'
    previous=json.loads(index.read_text()) if index.exists() else []
    if any(x.get('method')!='disc:embedded-indexed-records' for x in previous):
        raise ValueError('preserve independent index')
    old={r['png']:r for r in previous};records=[]
    for n in range(count):
        offset=start+n*stride;pix=data[offset+pixel_offset:offset+pixel_offset+width*height]
        if layout in ('block-row','block-row-remfirst'):ids=untile(pix,width,height,remainder_first=layout.endswith('remfirst'))
        elif layout=='column-strip':
            if width%64:raise ValueError('column strip width must divide by 64')
            ids=np.frombuffer(pix,dtype=np.uint8).reshape(width//64,height,64).transpose(1,0,2).reshape(height,width)
        elif layout=='linear':ids=np.frombuffer(pix,dtype=np.uint8).reshape(height,width)
        else:raise ValueError('unknown pixel layout')
        colors=np.array([rgb555(c) for c in struct.unpack_from('<256H',data,offset+palette_offset)],dtype=np.uint8)
        im=Image.fromarray(colors[ids]);name=re.sub(r'[^A-Za-z0-9_.-]','_',disc_path)+f'@{offset:08x}.png';target=out/name
        if target.exists():
            if name not in old:raise ValueError('preserve unclaimed PNG')
            with Image.open(target) as existing:
                if existing.size!=im.size or not np.array_equal(np.array(existing.convert('RGBA')),np.array(im)):
                    raise ValueError('preserve independently changed PNG')
        else:im.save(target)
        records.append({'file':disc_path,'offset':offset,'png':name,'bpp':8,'width':width,'height':height,'record_stride':stride,'pixels_offset':offset+pixel_offset,'palette_offset':offset+palette_offset,'layout':layout,'source_data_sha256':hashlib.sha256(data).hexdigest(),'method':'disc:embedded-indexed-records','visual_acceptance':False})
    old.update({r['png']:r for r in records});index.write_text(json.dumps(list(old.values()),indent=2));return records


if __name__=='__main__':
    p=argparse.ArgumentParser(description=__doc__)
    p.add_argument('--source-data',type=Path,required=True);p.add_argument('--disc-path',required=True);p.add_argument('--out',type=Path,required=True)
    for key in ('width','height','start','stride','pixel-offset','palette-offset','count'):p.add_argument('--'+key,type=lambda x:int(x,0),required=True)
    p.add_argument('--layout',choices=('block-row','block-row-remfirst','column-strip','linear'),required=True);a=p.parse_args()
    print('Embedded indexed records:',len(export(a.source_data.read_bytes(),a.disc_path,a.out,a.width,a.height,a.start,a.stride,a.pixel_offset,a.palette_offset,a.count,a.layout)))
