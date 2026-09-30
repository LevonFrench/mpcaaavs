"""Fast uncompressed TIM scan and raw indexed-pixel guesses for a local disc.

Uses the existing decoder, but locates aligned TIM signatures with bytes.find.
Alternate palettes are rendered from pixel indices (duplicate CLUT colours do
not collapse). Guesses are ranked by adjacent-row MAD and are NOT verified.
python scan_disc_images.py --bin <disc> --out <raw-directory> --prefix <disc-id>
"""
import argparse
import json
import struct
from pathlib import Path
import numpy as np
from PIL import Image
from psx_extract import Disc, parse_tim

def indexed(buf,off,bpp):
    p=off+8
    length,_,_,cw,ch=struct.unpack_from('<IHHHH',buf,p)
    p+=length
    ilen,_,_,w,h=struct.unpack_from('<IHHHH',buf,p)
    data=np.frombuffer(buf[p+12:p+ilen],dtype=np.uint8)
    if bpp==4:
        ids=np.empty(len(data)*2,dtype=np.uint8)
        ids[::2]=data&15; ids[1::2]=data>>4
        return ids.reshape(h,w*4)
    return data.reshape(h,w*2)

def scan(path,out,prefix=''):
    out=Path(out);out.mkdir(parents=True,exist_ok=True)
    disc=Disc(Path(path));files=sorted(disc.walk())
    rows=[]; palettes={}; pix=[]
    try:
        for name,lba,size in files:
            if name.upper().endswith('ITEMI.PIX'):
                pix.append((name,disc.read(lba,size)))
            if size>64*1024**2: continue
            buf=disc.read(lba,size);off=0
            while True:
                off=buf.find(b'\x10\x00\x00\x00',off)
                if off<0: break
                if off%4: off+=1;continue
                try: hit=parse_tim(buf,off)
                except (ValueError,IndexError,struct.error): hit=None
                if not hit: off+=4;continue
                im,nxt,info,pals=hit
                if info['width']>=8 and info['height']>=8:
                    stem=prefix+name.replace('/','_')+f'@{off:08x}'
                    if not (out/(stem+'.png')).exists():
                        im.save(out/(stem+'.png'))
                    ids=indexed(buf,off,info['bpp']) if info['bpp'] in (4,8) else None
                    for k,pal in enumerate(pals[1:16],1):
                        colors=np.zeros((256,4),dtype=np.uint8);colors[:min(256,len(pal))]=pal[:256]
                        if not (out/(stem+f'.pal{k}.png')).exists():
                            Image.fromarray(colors[ids]).save(out/(stem+f'.pal{k}.png'))
                    rows.append({'file':name,'offset':off,'png':stem+'.png',**info})
                    if Path(name).name.upper().startswith(('ITEM','STMAIN')) and pals:
                        palettes.setdefault(str(Path(name).parent),[]).append((name,pals[0]))
                off=nxt+(-nxt%4)
        guesses=[]
        for name,data in pix:
            options=[]
            for palname,pal in palettes.get(str(Path(name).parent),[]):
                for bpp in (4,8):
                    if len(pal)<(16 if bpp==4 else 256):continue
                    arr=np.frombuffer(data,dtype=np.uint8)
                    if bpp==4:
                        ids=np.empty(len(arr)*2,dtype=np.uint8);ids[::2]=arr&15;ids[1::2]=arr>>4
                    else:ids=arr
                    for width in (40,48,64,128):
                        height=len(ids)//width
                        if height<2:continue
                        colors=np.asarray(pal,dtype=np.uint8)
                        rgba=colors[ids[:height*width].reshape(height,width)]
                        score=float(np.abs(np.diff(rgba[:,:,:3].astype(np.int16),axis=0)).mean())
                        options.append((score,bpp,width,height,palname,rgba))
            for rank,(score,bpp,width,height,palname,rgba) in enumerate(sorted(options,key=lambda v:v[0])[:3],1):
                filename=prefix+name.replace('/','_')+f'_guess{rank}_{bpp}bpp_w{width}.png'
                Image.fromarray(rgba).save(out/filename)
                guesses.append({'png':filename,'palette':palname,'bpp':bpp,'width':width,'height':height,'row_mad':score,'verified':False})
        existing=json.loads((out/'index.json').read_text()) if (out/'index.json').exists() else []
        merged={r['png']:r for r in existing}
        merged.update({r['png']:r for r in rows})
        (out/'index.json').write_text(json.dumps(list(merged.values()),indent=1))
        result={'disc':str(path),'files':len(files),'tim_count':len(rows),'pixel_guesses':guesses,'largest_files':sorted([{'file':n,'bytes':s} for n,l,s in files],key=lambda v:-v['bytes'])[:10]}
        (out/(prefix+'scan.json')).write_text(json.dumps(result,indent=2))
        print(json.dumps({k:v for k,v in result.items() if k not in ('largest_files','pixel_guesses')}),flush=True)
        return result
    finally:disc.f.close()

if __name__=='__main__':
    p=argparse.ArgumentParser(description=__doc__);p.add_argument('--bin',required=True,type=Path);p.add_argument('--out',required=True,type=Path);p.add_argument('--prefix',default='')
    a=p.parse_args();scan(a.bin,a.out,a.prefix)
