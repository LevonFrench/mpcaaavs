"""Assemble explicit NCGR/NCLR/NCER sets and retain NANR source frame timing.

Format structures: NitroSystem g2d_Anim_data.h / g2d_Cell_data.h;
OBJ attributes: GBATEK. Reference source is read as text, never executed.
Supports static tiled 4/8bpp OBJ data, source palette slots, flips and 1D/2D
mapping. Affine/mosaic/window OBJ, VRAM transfers and nonidentity animation
SRT are rejected rather than approximated. Runtime palette/effect overrides
are outside this exporter. Unknown pairings must be supplied explicitly.
"""
import argparse
import hashlib
import json
import struct
from pathlib import Path

import numpy as np
from PIL import Image
from image_formats import cut, dims, indices, nitro_block, nitro_palette, unlz


def palette_slots(data,bpp):
    colors=nitro_palette(data)
    if colors is None:raise ValueError('missing NCLR PLTT')
    size=16 if bpp==4 else 256
    if len(colors)%size:raise ValueError('partial Nitro palette bank')
    block=nitro_block(data,b'RLCN',b'PMCP')
    if block is None:slots=list(range(len(colors)//size))
    else:
        cut(block,0,8);count,pad,off=struct.unpack_from('<HHI',block)
        if off<8 or count!=len(colors)//size:raise ValueError('PCMP count disagrees with source colors')
        slots=list(struct.unpack('<'+'H'*count,cut(block,off,count*2)))
        if len(set(slots))!=len(slots) or any(s>=16 for s in slots):raise ValueError('invalid PCMP palette slots')
    return {s:colors[i*size:(i+1)*size].copy() for i,s in enumerate(slots)}


def cell_records(data):
    block=nitro_block(data,b'RECN',b'KBEC')
    if block is None:raise ValueError('missing NCER CEBK')
    cut(block,0,24)
    count,flags,off,mapping,transfer,strings,extra=struct.unpack_from('<HHIIIII',block)
    if flags not in (0,1) or not 1<=count<=4096 or off<24:raise ValueError('invalid NCER cell table')
    # NCER uses the enum 0,1,2,3,4; NCGR stores hardware register values.
    if mapping not in range(5):raise ValueError('unsupported NCER mapping enum')
    if transfer:raise ValueError('NCER VRAM transfer bank unsupported')
    stride=16 if flags else 8;cut(block,off,count*stride);base=off+count*stride
    cells=[]
    sizes=(((8,8),(16,16),(32,32),(64,64)),((16,8),(32,8),(32,16),(64,32)),((8,16),(8,32),(16,32),(32,64)))
    for i in range(count):
        n,attrs,rel=struct.unpack_from('<HHI',block,off+i*stride)
        if n>128 or rel%2:raise ValueError('invalid NCER OAM table')
        cut(block,base+rel,n*6);objs=[]
        bounds=list(struct.unpack_from('<hhhh',block,off+i*stride+8)) if flags else None
        for j in range(n):
            a0,a1,a2=struct.unpack_from('<HHH',block,base+rel+j*6)
            if not (a0&0x100) and a0&0x200:continue
            if a0&0x100:raise ValueError('affine NCER OBJ requires runtime matrix')
            if a0&0x1000 or (a0>>10)&3:raise ValueError('mosaic or blended/window/bitmap NCER OBJ requires runtime state')
            shape=a0>>14
            if shape==3:raise ValueError('invalid NCER OBJ shape')
            w,h=sizes[shape][a1>>14];x=a1&511;y=a0&255
            if x>=256:x-=512
            if y>=128:y-=256
            objs.append({'oam':j,'x':x,'y':y,'width':w,'height':h,'bpp':8 if a0&8192 else 4,'tile':a2&1023,'priority':(a2>>10)&3,'palette':a2>>12,'flip_h':bool(a1&4096),'flip_v':bool(a1&8192),'attributes':[a0,a1,a2]})
        cells.append({'cell':i,'cell_attributes':attrs,'declared_bounds':bounds,'objects':objs,'mapping':mapping})
    return cells


def animations(data,cell_count):
    if data is None:return None
    block=nitro_block(data,b'RNAN',b'KNBA')
    if block is None:raise ValueError('missing NANR ABNK')
    cut(block,0,24);count,total,seqoff,frameoff,dataoff,strings,extra=struct.unpack_from('<HHIIIII',block)
    if not 1<=count<=4096 or not 1<=total<=65535 or min(seqoff,frameoff,dataoff)<24:raise ValueError('invalid NANR tables')
    cut(block,seqoff,count*16);cut(block,frameoff,total*8);seqs=[]
    for i in range(count):
        n,loop,typ,mode,rel=struct.unpack_from('<HHIII',block,seqoff+i*16)
        elem=typ&255
        if typ>>16!=1 or typ&0xff00 or elem not in (0,1,2):raise ValueError('unsupported NANR animation type')
        if not n or loop>=n or mode not in (1,2,3,4) or rel%8 or rel+n*8>total*8:raise ValueError('invalid NANR sequence')
        frames=[]
        for j in range(n):
            at=frameoff+rel+j*8;content,duration,pad=struct.unpack_from('<IHH',block,at)
            value=cut(block,dataoff+content,(2,16,8)[elem]);cell=struct.unpack_from('<H',value)[0]
            if cell>=cell_count:raise ValueError('NANR references absent cell')
            x=y=0;srt=None
            if elem==2:x,y=struct.unpack_from('<hh',value,4)
            elif elem==1:
                cell,rotation,sx,sy,x,y=struct.unpack('<HHii hh',value)
                srt={'rotation':rotation,'scale_x_fx32':sx,'scale_y_fx32':sy}
            frames.append({'source_frame':j,'cell':cell,'duration_ticks':duration,'translation':[x,y],'srt':srt,'table_offset':at,'content_offset':dataoff+content})
        if not any(f['duration_ticks'] for f in frames):raise ValueError('NANR has no timed frames')
        seqs.append({'sequence':i,'element_type':elem,'play_mode':mode,'loop_start_frame':loop,'frames':frames,'source_duration_ticks':sum(f['duration_ticks'] for f in frames),'loop':mode in (2,4),'ping_pong':mode in (3,4),'source_order':True})
    return {'sequences':seqs,'total_frame_records':total,'tick_unit':'video frames; native refresh rate not inferred','runtime_overrides_applied':False}


def assemble(graphics,palette,cell_data,animation=None):
    block=nitro_block(graphics,b'RGCN',b'RAHC')
    if block is None:raise ValueError('missing NCGR CHAR')
    cut(block,0,24);ht,wt,fmt,mapping,layout,size,off=struct.unpack_from('<HHIIIII',block)
    if fmt not in (3,4) or layout!=0 or off<24:raise ValueError('cell renderer requires static tiled NCGR')
    bpp=4 if fmt==3 else 8;raw=cut(block,off,size);tilebytes=8*bpp
    if not raw or len(raw)%tilebytes:raise ValueError('partial NCGR tile')
    tiles=indices(raw,bpp).reshape(-1,8,8);pals=palette_slots(palette,bpp);records=cell_records(cell_data)
    expected=(0x10,0x100010,0x200010,0x300010,0)
    if any(expected[r['mapping']]!=mapping for r in records):raise ValueError('NCER/NCGR mapping mismatch')
    objs=[o for r in records for o in r['objects']]
    if not objs:raise ValueError('NCER contains no visible OBJ')
    left=min(o['x'] for o in objs);top=min(o['y'] for o in objs)
    right=max(o['x']+o['width'] for o in objs);bottom=max(o['y']+o['height'] for o in objs)
    dims(right-left,bottom-top);result=[]
    for record in records:
        canvas=Image.new('RGBA',(right-left,bottom-top))
        for o in sorted(record['objects'],key=lambda o:(o['priority'],o['oam']),reverse=True):
            if o['bpp']!=bpp:raise ValueError('NCER/NCGR color depth mismatch')
            slot=o['palette'] if bpp==4 else 0
            if slot not in pals:raise ValueError('NCER references unbound NCLR palette slot')
            pal=pals[slot].copy();pal[0,3]=0;ids=np.empty((o['height'],o['width']),dtype=np.uint8)
            for ty in range(o['height']//8):
                for tx in range(o['width']//8):
                    byte=o['tile']*32
                    if record['mapping']==4:byte+=(ty*32+tx*(bpp//4))*32
                    else:byte*=1<<record['mapping'];byte+=(ty*(o['width']//8)+tx)*tilebytes
                    if byte%tilebytes or byte+tilebytes>len(raw):raise ValueError('NCER tile address outside NCGR')
                    ids[ty*8:ty*8+8,tx*8:tx*8+8]=tiles[byte//tilebytes]
            if o['flip_h']:ids=ids[:,::-1]
            if o['flip_v']:ids=ids[::-1,:]
            im=Image.fromarray(pal[ids]);canvas.alpha_composite(im,(o['x']-left,o['y']-top))
        result.append((canvas,{**record,'bpp':bpp,'canvas_origin':[left,top],'pivot':[-left,-top],'width':right-left,'height':bottom-top,'assembled_cells':True,'source_palette_slots':sorted(pals)}))
    return result,animations(animation,len(records))


def export(graphics,palette,cells,animation,out):
    paths={'graphics':graphics,'palette':palette,'cells':cells}
    if animation is not None:paths['animation']=animation
    buffers={key:unlz(Path(path).read_bytes()) for key,path in paths.items()}
    frames,bank=assemble(buffers['graphics'],buffers['palette'],buffers['cells'],buffers.get('animation'))
    out.mkdir(parents=True,exist_ok=True);rows=[]
    for i,(im,info) in enumerate(frames):
        path=out/f'cell{i:04d}.png'
        if path.exists():
            with Image.open(path) as old:
                if not np.array_equal(np.array(old.convert('RGBA')),np.array(im)):raise ValueError('preserved cell image differs')
        else:im.save(path)
        rows.append({**info,'png':path.name})
    rendered=[]
    for seq in bank['sequences'] if bank else []:
        if any(f['srt'] and (f['srt']['rotation']!=0 or f['srt']['scale_x_fx32']!=4096 or f['srt']['scale_y_fx32']!=4096) for f in seq['frames']):
            rendered.append({'sequence':seq['sequence'],'status':'unsupported SRT transform','frames_rendered':0});continue
        w,h=frames[0][0].size
        xs=[f['translation'][0] for f in seq['frames']];ys=[f['translation'][1] for f in seq['frames']]
        left,top=min(xs),min(ys);cw,ch=w+max(xs)-left,h+max(ys)-top;dims(cw,ch)
        folder=out/f'sequence{seq["sequence"]:04d}';folder.mkdir(exist_ok=True);entries=[]
        for f in seq['frames']:
            im=Image.new('RGBA',(cw,ch));im.alpha_composite(frames[f['cell']][0],(f['translation'][0]-left,f['translation'][1]-top))
            path=folder/f'frame{f["source_frame"]:04d}.png'
            if path.exists():
                with Image.open(path) as old:
                    if not np.array_equal(np.array(old.convert('RGBA')),np.array(im)):raise ValueError('preserved animation frame differs')
            else:im.save(path)
            entries.append({**f,'png':path.name})
        pivot=rows[0]['pivot'];clip={**seq,'frames':entries,'canvas_size':[cw,ch],'pivot':[pivot[0]-left,pivot[1]-top],'timing_is_native':True,'export_order':'source frame table; play_mode retained, no synthesized repeats'}
        (folder/'clip.json').write_text(json.dumps(clip,indent=2));rendered.append({'sequence':seq['sequence'],'status':'source frames rendered','frames_rendered':len(entries)})
    receipt={'method':'disc:nitro-cells','sources':{k:{'path':str(Path(v).resolve()),'sha256':hashlib.sha256(Path(v).read_bytes()).hexdigest()} for k,v in paths.items()},'cells':rows,'animation_bank':bank,'animation_exports':rendered,'visual_validation':'pending','runtime_overrides_applied':False}
    (out/'index.json').write_text(json.dumps(rows,indent=2))
    (out/'meta.json').write_text(json.dumps(receipt,indent=2));return receipt


if __name__=='__main__':
    ap=argparse.ArgumentParser(description=__doc__)
    for key in ('graphics','palette','cells','out'):ap.add_argument('--'+key,type=Path,required=True)
    ap.add_argument('--animation',type=Path)
    a=ap.parse_args();r=export(a.graphics,a.palette,a.cells,a.animation,a.out)
    print(json.dumps({'cells':len(r['cells']),'animation_exports':r['animation_exports']}))
