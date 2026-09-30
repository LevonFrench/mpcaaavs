"""Decode explicitly mapped texture/palette entries in sector-aligned archives.

Reference layouts are supplied by the caller through header byte offsets and
pixel depth. Reads only; strict bounds and decompression size checks; no palette
search or silent zero-fill for invalid backreferences.
"""
import argparse
import hashlib
import json
import re
import struct
from pathlib import Path
import numpy as np
from PIL import Image
from indexed_record_bank import untile
from psx_extract import rgb555


def entries(data):
    if len(data)<2048:raise ValueError('archive header truncated')
    rows={};offset=2048;terminated=False
    for pos in range(0,2048,16):
        if data[pos:pos+12]==b'dummy header':terminated=True;break
        typ,size,x,y,w,h=struct.unpack_from('<II4H',data,pos)
        if typ>8:raise ValueError('unknown archive entry type')
        if size:
            if offset+size>len(data):raise ValueError('entry extent outside archive')
            rows[pos]={'type':typ,'size':size,'x':x,'y':y,'w':w,'h':h,'offset':offset}
            offset+=(size+2047)&~2047
    if not terminated or not rows:raise ValueError('archive header has no terminator or entries')
    return rows


def decompress(data,expected,padding=0):
    if not 0<expected<=1024*1024:raise ValueError('invalid expansion size')
    if not 0<=padding<=4096:raise ValueError('invalid explicit padding size')
    limit=expected+padding
    out=decompress_stream(data,limit)
    if len(out)!=limit:raise ValueError('expansion does not match texture extent plus explicit padding')
    if any(out[expected:]):raise ValueError('nonzero explicit texture padding')
    return bytes(out[:expected])


def decompress_stream(data,limit=16777216):
    if not 0<limit<=67108864:raise ValueError('invalid stream expansion cap')
    pos=0;out=bytearray();flags=1
    while pos<len(data):
        if flags==1:
            flags=data[pos]|256;pos+=1
            if pos==len(data):raise ValueError('flag without token')
        byte=data[pos];pos+=1
        if flags&1:out.append(byte)
        else:
            if pos==len(data):raise ValueError('truncated backreference')
            tail=data[pos];pos+=1;distance=((tail&15)<<8)|byte;count=(tail>>4)+2
            if distance==0 or distance>len(out):raise ValueError('invalid backreference')
            if len(out)+count>limit:raise ValueError('expansion exceeds texture extent')
            for _ in range(count):out.append(out[-distance])
        if len(out)>limit:raise ValueError('expansion exceeds texture extent')
        flags>>=1
    return bytes(out)


def export(data,disc_path,out,texture_header,palette_header,bpp,padding=0,palette_index=None,stored_height=None,rect=None):
    table=entries(data);t=table[texture_header];p=table[palette_header]
    if t['type'] not in (1,8) or p['type']!=2 or bpp not in (4,8):raise ValueError('incompatible entry types/depth')
    if not 0<t['w']<=1024 or not 0<t['h']<=512 or t['x']+t['w']>1024 or t['y']+t['h']>512:raise ValueError('texture outside VRAM')
    sh=t['h'] if stored_height is None else stored_height
    if not t['h']<=sh<=512 or sh-t['h']>=32:raise ValueError('explicit stored height outside one tile of declared height')
    expected=t['w']*sh*2;pixels=data[t['offset']:t['offset']+t['size']]
    if t['type']==8:pixels=decompress(pixels,expected,padding)
    else:
        if len(pixels)!=expected+padding:raise ValueError('raw texture size does not match header plus explicit padding')
        if any(pixels[expected:]):raise ValueError('nonzero explicit raw texture padding')
        pixels=pixels[:expected]
    ncolors=1<<bpp
    if p['size']!=p['w']*p['h']*2 or p['size']%(ncolors*2):raise ValueError('CLUT size mismatch')
    ids=untile(pixels,t['w']*2,sh)[:t['h']]
    if bpp==4:
        packed=ids;ids=np.empty((t['h'],t['w']*4),dtype=np.uint8);ids[:,0::2]=packed&15;ids[:,1::2]=packed>>4
    colors=np.array([rgb555(c) for c in struct.unpack_from('<'+str(p['size']//2)+'H',data,p['offset'])],dtype=np.uint8).reshape(-1,ncolors,4)
    out=Path(out);out.mkdir(parents=True,exist_ok=True);index=out/'index.json';old=json.loads(index.read_text()) if index.exists() else []
    if any(x.get('method')!='disc:sector-archive-indexed' for x in old):raise ValueError('preserve independent index')
    owned={x['png']:x for x in old};rows=[]
    for k,palette in enumerate(colors):
        if palette_index is not None and k!=palette_index:continue
        im=Image.fromarray(palette[ids]);source_size=im.size;suffix=''
        if rect is not None:
            x,y,w,h=rect
            if min(x,y)<0 or min(w,h)<=0 or x+w>im.width or y+h>im.height:raise ValueError('mapped rectangle outside decoded texture')
            im=im.crop((x,y,x+w,y+h));suffix='.rect'+'-'.join(map(str,rect))
        name=re.sub(r'[^A-Za-z0-9_.-]','_',disc_path)+f'@{t["offset"]:08x}.clut{p["offset"]:08x}.pal{k}{suffix}.png';target=out/name
        if target.exists():
            if name not in owned:raise ValueError('preserve unclaimed PNG')
            with Image.open(target) as previous:
                if previous.size!=im.size or not np.array_equal(np.array(previous.convert('RGBA')),np.array(im)):raise ValueError('preserve changed PNG')
        else:im.save(target)
        rows.append({'file':disc_path,'png':name,'offset':t['offset'],'texture_header':texture_header,'palette_header':palette_header,'texture_entry':t,'palette_entry':p,'palette_index':k,'width':im.width,'height':im.height,'stored_height':sh,'source_decoded_size':source_size,'mapped_rectangle':rect,'bpp':bpp,'layout':'block-row','zero_expansion_padding_verified':padding,'method':'disc:sector-archive-indexed','source_data_sha256':hashlib.sha256(data).hexdigest(),'visual_acceptance':False})
    if not rows:raise ValueError('requested palette is outside source CLUT')
    owned.update({x['png']:x for x in rows});index.write_text(json.dumps(list(owned.values()),indent=2));return rows


if __name__=='__main__':
    p=argparse.ArgumentParser(description=__doc__);p.add_argument('--source-data',required=True,type=Path);p.add_argument('--disc-path',required=True);p.add_argument('--out',required=True,type=Path)
    for k in ('texture-header','palette-header','bpp'):p.add_argument('--'+k,required=True,type=lambda x:int(x,0))
    p.add_argument('--padding',type=int,default=0)
    p.add_argument('--palette-index',type=int)
    p.add_argument('--stored-height',type=int)
    p.add_argument('--rect',type=int,nargs=4,metavar=('X','Y','W','H'))
    a=p.parse_args();print('Mapped texture palettes:',len(export(a.source_data.read_bytes(),a.disc_path,a.out,a.texture_header,a.palette_header,a.bpp,a.padding,a.palette_index,a.stored_height,a.rect)))
