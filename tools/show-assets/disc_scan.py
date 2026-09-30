"""Scan filesystem files for strictly validated image containers."""
import argparse
import json
import re
import struct
from pathlib import Path
import numpy as np
from PIL import Image
from disc_fs import open_disc
from psx_extract import parse_tim
from scan_disc_images import indexed

def scan(source,system,out,prefix=''):
    out=Path(out);out.mkdir(parents=True,exist_ok=True)
    reader=open_disc(source,system);rows={};failures=[];palettes={};pix=[]
    try:
        try:
            from image_formats import scan_images
        except ImportError:
            scan_images=None
        nitro_pals={}
        if system=='nds' and scan_images:
            from image_formats import nitro_palette,unlz
            for name,loc,length in reader.tree():
                try:
                    data=reader.physical(loc,length)
                    if data[:1] in (b'\x10',b'\x11',b'\x24',b'\x28'):data=unlz(data)
                    pal=nitro_palette(data)
                    if pal is not None:nitro_pals[name]=pal
                except (ValueError,IndexError,struct.error):pass
        for name,location,length in reader.tree():
            try:
                data=reader.physical(location,length) if system in ('nds','gc','wii') else reader.read(location,length)
            except (ValueError, OSError) as e:
                failures.append({'file':name,'reason':str(e)});continue
            if name.upper().endswith(('.PIX','.RAW')):pix.append((name,data))
            hits=[];off=0
            while True:
                off=data.find(b'\x10\0\0\0',off)
                if off<0:break
                if off%4:off+=1;continue
                try:hit=parse_tim(data,off)
                except (ValueError,IndexError,struct.error):hit=None
                if not hit:off+=4;continue
                im,nxt,info,pals=hit
                if info['bpp'] in (4,8):
                    ids=indexed(data,off,info['bpp'])
                    for k,pal in enumerate(pals):
                        if int(ids.max())>=len(pal):continue
                        variant=Image.fromarray(np.asarray(pal,dtype=np.uint8)[ids])
                        hits.append(('tim',off,'' if k==0 else f'.pal{k}',variant,info))
                    if pals:palettes.setdefault(str(Path(name).parent),[]).append((name,pals[0]))
                else:hits.append(('tim',off,'',im,info))
                off=nxt+(-nxt%4)
            if scan_images:
                matches=[p for n,p in nitro_pals.items() if Path(n).parent==Path(name).parent and Path(n).stem==Path(name).stem]
                if not matches:matches=[p for n,p in nitro_pals.items() if Path(n).parent==Path(name).parent]
                hits.extend(scan_images(name,data,failures,matches[0] if len(matches)==1 else None))
            for fmt,offset,suffix,im,info in hits:
                stem=prefix+re.sub(r'[^A-Za-z0-9_.-]','_',name)+f'@{offset:08x}'+suffix
                folder=out/fmt;folder.mkdir(exist_ok=True);path=folder/(stem+'.png')
                if not path.exists():im.save(path)
                rows.setdefault(fmt,[]).append({'file':name,'offset':offset,'png':path.name,**info})
        # Explicitly unverified raw guesses, isolated from decoded TIM output.
        guesses=[]
        for name,data in pix:
            if data[:4]==b'\x10\0\0\0':continue
            options=[]
            for palname,pal in palettes.get(str(Path(name).parent),[]):
                if not Path(palname).name.upper().startswith(('ITEM','STMAIN')):continue
                for bpp in (4,8):
                    if len(pal)<2**bpp:continue
                    ids=np.frombuffer(data,dtype=np.uint8)
                    if bpp==4:
                        ids=np.stack((ids&15,ids>>4),axis=1).ravel()
                    for width in (40,48,64,128):
                        h=len(ids)//width
                        if h<2 or h>32768:continue
                        rgba=np.asarray(pal,dtype=np.uint8)[ids[:h*width].reshape(h,width)]
                        score=float(np.abs(np.diff(rgba[:,:,:3].astype(np.int16),axis=0)).mean())
                        options.append((score,bpp,width,palname,rgba))
            for rank,(score,bpp,width,palname,rgba) in enumerate(sorted(options,key=lambda r:r[0])[:3],1):
                folder=out/'raw-guesses';folder.mkdir(exist_ok=True)
                filename=prefix+re.sub(r'[^A-Za-z0-9_.-]','_',name)+f'_guess{rank}_{bpp}bpp_w{width}.png'
                Image.fromarray(rgba).save(folder/filename)
                guesses.append({'png':filename,'palette':palname,'bpp':bpp,'width':width,'row_mad':score,'verified':False})
        for fmt,records in rows.items():
            index=out/fmt/'index.json';existing=json.loads(index.read_text()) if index.exists() else []
            merged={r['png']:r for r in existing};merged.update({r['png']:r for r in records})
            index.write_text(json.dumps(list(merged.values()),indent=1))
        (out/(prefix+'scan.json')).write_text(json.dumps({'formats':{f:len(v) for f,v in rows.items()},'failures':failures,'raw_guesses':guesses},indent=2))
        print({f:len(v) for f,v in rows.items()},flush=True)
    finally:reader.close()

if __name__=='__main__':
    p=argparse.ArgumentParser(description=__doc__)
    p.add_argument('--source',required=True,type=Path);p.add_argument('--system',required=True);p.add_argument('--out',required=True,type=Path);p.add_argument('--prefix',default='')
    a=p.parse_args();scan(a.source,a.system,a.out,a.prefix)
