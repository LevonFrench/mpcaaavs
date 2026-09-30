"""Assemble mapped stage sprite parts using source VRAM uploads and palettes.

Only caller-supplied data maps are consumed. Downloaded code is never executed.
Animation addresses must point to original disc bytes; unknown formats fail.
"""
import argparse
import json
import struct
from pathlib import Path
import numpy as np
from PIL import Image
from disc_fs import open_disc
from image_formats import indices, packed16, cut
from sotn_extract import pointer_table, inflate


def extract(reader, mapping, out):
    tree={n:(l,s) for n,l,s in reader.tree()}; receipts=[]
    for stage in mapping['stages']:
        data=reader.read(*tree[stage['file']]);base=stage['base']
        def u32(p):return struct.unpack_from('<I',data,p)[0]
        start=stage['graphics_start'];table=start
        while not base+start<=u32(table)<base+table:
            table+=4
            if table-start>65536:raise ValueError('graphics pointer array not found')
        banks=[];p=table
        while start<=u32(p)-base<table:
            banks.append(u32(p)-base);p+=4
        # PAL_COPY (opcode 5): destination color index, color count, source.
        palettes={};p=stage['palette_copy_offset']
        if u32(p)!=5:raise ValueError('palette program is not PAL_COPY')
        p+=4
        while u32(p)!=0xffffffff:
            dest,count,ptr=struct.unpack_from('<3I',data,p);p+=12
            if dest%16 or count%16:raise ValueError('unaligned palette copy')
            for n in range(count//16):
                off=ptr-base+n*32;pal=packed16(cut(data,off,32),'psx');pal[0,3]=0
                palettes[dest//16+n]=(pal,off)
        for actor in stage['actors']:
            vram=np.zeros((512,4096),dtype=np.uint8);valid=np.zeros_like(vram,dtype=bool);uploads=[]
            bank=banks[actor['graphics_bank']];kind=u32(bank);p=bank+4
            if kind not in (1,4):raise ValueError('only mapped 4bpp graphics supported')
            while u32(p)!=0xffffffff:
                y,x,h,w,ptr=struct.unpack_from('<4HI',data,p);p+=12;off=ptr-base
                raw=inflate(data[off:],w*h//2) if kind==4 else cut(data,off,w*h//2)
                ids=indices(raw,4)[:w*h].reshape(h,w);xx=x*4
                if y+h>512 or xx+w>4096:raise ValueError('upload outside VRAM')
                vram[y:y+h,xx:xx+w]=ids;valid[y:y+h,xx:xx+w]=True
                uploads.append({'offset':off,'vram_words':[x,y],'size_pixels':[w,h]})
            frame_table=u32(stage['sprite_banks']+actor['sprite_bank']*4)-base
            pointers=pointer_table(data,frame_table,base);frames={0:(Image.new('RGBA',(1,1)),0,0,[])};skips=[]
            for index,ptr in enumerate(pointers):
                if not ptr:continue
                try:
                    off=ptr-base;count=struct.unpack_from('<H',data,off)[0]
                    if not 0<count<128:raise ValueError('unsupported part count')
                    parts=[]
                    for n in range(count):
                        f,x,y,w,h,clut,tileset,l,t,r,b=struct.unpack_from('<Hhh8H',data,off+2+n*22)
                        if f&~63:raise ValueError('unsupported part flags')
                        if (r-l,b-t)!=(w,h):raise ValueError('part UV/size mismatch')
                        if f&4:w-=1;r-=1;x+=bool(f&2)
                        if f&8:h-=1;b-=1;y+=bool(f&1)
                        if f&16:w-=1;l+=1;x+=not bool(f&2)
                        if f&32:h-=1;t+=1;y+=not bool(f&1)
                        ts=tileset+actor['texture_base'];quarter=ts&3;page=ts>>2
                        xx=(page%16)*256+l+(128 if quarter&1 else 0);yy=(page//16)*256+t+(128 if quarter&2 else 0)
                        if page>=32 or w<=0 or h<=0 or xx<0 or yy<0 or xx+w>4096 or yy+h>512:raise ValueError('part outside VRAM')
                        if not valid[yy:yy+h,xx:xx+w].all():raise ValueError('part samples unloaded graphics')
                        palid=(actor['palette']&0x7fff) if actor['palette']&0x8000 else actor['palette']+clut
                        pal,po=palettes[palid];rgba=pal[vram[yy:yy+h,xx:xx+w]]
                        if f&2:rgba=rgba[:,::-1]
                        if f&1:rgba=rgba[::-1]
                        parts.append((Image.fromarray(rgba.copy()),x,y,{'flags':f,'clut':palid,'palette_offset':po,'part_offset':off+2+n*22,'texture_page':page}))
                    l=min(x for im,x,y,info in parts);t=min(y for im,x,y,info in parts);r=max(x+im.width for im,x,y,info in parts);b=max(y+im.height for im,x,y,info in parts)
                    canvas=Image.new('RGBA',(r-l,b-t))
                    # Earlier source parts draw over later parts at equal priority.
                    for im,x,y,info in reversed(parts):canvas.alpha_composite(im,(x-l,y-t))
                    frames[index]=(canvas,l,t,[p[3] for p in parts])
                except (ValueError,KeyError,IndexError,struct.error) as e:skips.append({'frame':index,'reason':str(e)})
            actor_out=out/'actors'/actor['name'];actor_out.mkdir(parents=True,exist_ok=True);clips=[]
            frame_out=actor_out/'assembled-frames';frame_out.mkdir(exist_ok=True);frame_rows=[]
            for pose,(image,x,y,parts) in frames.items():
                name=f'frame-{pose:03d}.png';target=frame_out/name
                if not target.exists():image.save(target)
                frame_rows.append({'png':name,'source_frame':pose,'entity_offset':[x,y],'parts':parts})
            (frame_out/'index.json').write_text(json.dumps(frame_rows,indent=2))
            for animation in actor.get('animations',[]):
                seq=[];off=animation['offset'];loop=None;terminal=None
                for n in range(1024):
                    duration,pose=struct.unpack_from('<BB',data,off+n*2)
                    if duration==0:loop=pose;break
                    if duration==255:terminal='source end';break
                    if pose not in frames:raise ValueError('animation references missing frame '+str(pose))
                    seq.append((duration,pose,off+n*2))
                else:raise ValueError('animation exceeded bounded record budget')
                if not seq or (loop is not None and loop>=len(seq)):raise ValueError('invalid animation')
                dest=actor_out/animation['verb']
                if dest.exists():
                    old=json.loads((dest/'clip.json').read_text())
                    if old.get('method')!='disc:stage-parts+animation-table' or old.get('source_animation_offset')!=off:raise FileExistsError('preserve existing clip '+str(dest))
                    clips.append({'verb':animation['verb'],'frames':len(old['frames']),'resumed':True});continue
                dest.mkdir();l=min(frames[s[1]][1] for s in seq);t=min(frames[s[1]][2] for s in seq);r=max(frames[s[1]][1]+frames[s[1]][0].width for s in seq);b=max(frames[s[1]][2]+frames[s[1]][0].height for s in seq);entries=[]
                for n,(duration,pose,record) in enumerate(seq):
                    im,x,y,parts=frames[pose];canvas=Image.new('RGBA',(r-l,b-t));canvas.alpha_composite(im,(x-l,y-t));name=f'{n:04d}.png';canvas.save(dest/name)
                    entries.append({'png':name,'duration':duration,'anchor':[-l,b-t-1],'entity_anchor':[-l,-t],'big':False,'source':{'frame':pose,'record_offset':record,'parts':parts}})
                clip={'role':actor.get('role','enemy'),'verb':animation['verb'],'frames':entries,'loop':loop is not None,'loop_start':loop,'terminal':terminal,'source_file':stage['file'],'source_animation_offset':off,'source_duration_units':'game frames','method':'disc:stage-parts+animation-table','visual_acceptance':False,'uploads':uploads}
                (dest/'clip.json').write_text(json.dumps(clip,indent=2));clips.append({'verb':animation['verb'],'frames':len(entries)})
            receipt={'actor':actor['name'],'source_file':stage['file'],'assembled_frames':len(frames),'source_frames':len(pointers),'clips':clips,'skips':skips,'binding':actor,'uploads':uploads}
            (actor_out/'stage-extraction.json').write_text(json.dumps(receipt,indent=2));receipts.append(receipt)
    return receipts


if __name__=='__main__':
    p=argparse.ArgumentParser(description=__doc__)
    for n in ('source','map','out'):p.add_argument('--'+n,required=True,type=Path)
    a=p.parse_args();r=open_disc(a.source)
    try:
        result=extract(r,json.loads(a.map.read_text()),a.out);(a.out/'stage-actor-extraction.json').write_text(json.dumps(result,indent=2));print('Stage actors',len(result),'clips',sum(len(x['clips']) for x in result),flush=True)
    finally:r.close()
