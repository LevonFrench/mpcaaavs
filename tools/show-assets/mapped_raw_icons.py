"""Export caller-mapped raw indexed records using a source TIM palette.

Record size, pixel dimensions and palette index are explicit arguments. Strict
zero padding can be required. This avoids automatic palette/layout guesses.
"""
import argparse
import json
import re
from pathlib import Path
import numpy as np
from PIL import Image
from disc_fs import open_disc
from psx_extract import parse_tim


def extract(source, pixels_file, palette_file, palette_index, width, height, stride, out, zero_padding=False, bpp=8, palette_offset=0):
    reader=open_disc(source)
    try:
        tree={n:(l,s) for n,l,s in reader.tree()}
        pixels=reader.read(*tree[pixels_file]);paldata=reader.read(*tree[palette_file])
        return export_records(pixels,paldata,pixels_file,palette_file,palette_index,width,height,stride,out,zero_padding,bpp,palette_offset)
    finally:reader.close()


def export_records(pixels, paldata, pixels_file, palette_file, palette_index, width, height, stride, out, zero_padding=False, bpp=8, palette_offset=0):
        if not 0<=palette_offset<=len(paldata)-20:raise ValueError('palette TIM offset outside source')
        hit=parse_tim(paldata,palette_offset)
        if not hit:raise ValueError('palette source is not a TIM')
        palettes=hit[3]
        if not 0<=palette_index<len(palettes):raise ValueError('palette index outside source CLUT')
        colors=np.array(palettes[palette_index],dtype=np.uint8)
        if bpp not in (4,8) or len(colors)!=1<<bpp:raise ValueError('indexed record depth must match source CLUT')
        payload=(width*height*bpp+7)//8
        if not 0<width<=4096 or not 0<height<=4096 or (bpp==4 and width%2) or stride<payload or len(pixels)%stride:
            raise ValueError('raw record layout does not divide source exactly')
        records=[];out.mkdir(parents=True,exist_ok=True);index=out/'index.json'
        existing=json.loads(index.read_text()) if index.exists() else []
        if any(x.get('method')!='disc:mapped-raw-indexed' for x in existing):raise ValueError('preserve independent existing index')
        previous={x['png']:x for x in existing}
        for offset in range(0,len(pixels),stride):
            if zero_padding and any(pixels[offset+payload:offset+stride]):raise ValueError('nonzero mapped record padding')
            packed=np.frombuffer(pixels[offset:offset+payload],dtype=np.uint8)
            if bpp==4:
                ids=np.empty(packed.size*2,dtype=np.uint8);ids[0::2]=packed&15;ids[1::2]=packed>>4
            else:ids=packed
            ids=ids.reshape(height,width)
            name=re.sub(r'[^A-Za-z0-9_.-]','_',pixels_file)+f'@{offset:08x}.pal{palette_index}.png'
            image=Image.fromarray(colors[ids]);target=out/name
            if target.exists():
                if name not in previous:raise ValueError('preserve unclaimed existing image')
                with Image.open(target) as old:
                    if old.size!=image.size or not np.array_equal(np.array(old.convert('RGBA')),np.array(image)):raise ValueError('preserve independently changed image')
            else:image.save(target)
            records.append({'file':pixels_file,'offset':offset,'png':name,'width':width,'height':height,'bpp':bpp,'record_stride':stride,'palette_file':palette_file,'palette_index':palette_index,'palette_offset':palette_offset,'zero_padding_verified':zero_padding,'method':'disc:mapped-raw-indexed','visual_acceptance':False})
        previous.update({x['png']:x for x in records});index.write_text(json.dumps(list(previous.values()),indent=2));return records


if __name__=='__main__':
    p=argparse.ArgumentParser(description=__doc__)
    p.add_argument('--source',required=True,type=Path);p.add_argument('--pixels-file',required=True);p.add_argument('--palette-file',required=True);p.add_argument('--palette-index',type=int,required=True)
    for n in ('width','height','stride'):p.add_argument('--'+n,type=int,required=True)
    p.add_argument('--bpp',type=int,choices=(4,8),default=8);p.add_argument('--palette-offset',type=lambda x:int(x,0),default=0)
    p.add_argument('--out',required=True,type=Path);p.add_argument('--zero-padding',action='store_true');a=p.parse_args()
    print('Mapped indexed records',len(extract(a.source,a.pixels_file,a.palette_file,a.palette_index,a.width,a.height,a.stride,a.out,a.zero_padding,a.bpp,a.palette_offset)))
