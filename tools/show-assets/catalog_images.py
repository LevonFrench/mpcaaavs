"""Catalogue private images; paths are supplied by the caller.

python catalog_images.py --raw <directory> --out <directory> [--snapshots]
Raw files are retained byte-for-byte. Noise/duplicates are omitted from the
catalogue rather than deleted. Snapshot candidates require a small change
against BOTH neighbouring kept frames. Candidate selection is heuristic.
"""
from pathlib import Path
import argparse
import json
import shutil
import re
from collections import defaultdict
import numpy as np
from PIL import Image, ImageDraw

WORDS = re.compile(r'ITEM|STMAIN|STMOJI|RADAR|MAP|FILE|FONT|RES|SELE|TITLE|CONTINUE|DIE|ICON|STATUS|MENU|HUD|GAUGE|LIFE', re.I)

def catalogue(raw, out, snapshots=False):
    raw, out = Path(raw), Path(out)
    contact, ui = out/'contact', out/'ui-candidates'
    contact.mkdir(parents=True, exist_ok=True)
    ui.mkdir(parents=True, exist_ok=True)
    index = json.loads((raw/'index.json').read_text()) if (raw/'index.json').exists() else []
    info = {r['png']: r for r in index}
    files = sorted(raw.glob('*.png'))
    kept, excluded, candidates = [], [], []
    previous = None
    for f in files:
        with Image.open(f) as src:
            arr = np.array(src.convert('RGBA'))
        unique = len(np.unique(np.ascontiguousarray(arr).view(np.uint32)))
        bpp = info.get(f.name.split('.pal')[0]+'.png', info.get(f.name, {})).get('bpp')
        if unique <= 1 or (bpp in (4, 8) and unique/arr.shape[0]/arr.shape[1] > .6):
            excluded.append({'file':f.name, 'reason':'flat/noise'})
            continue
        if snapshots and previous is not None and previous.shape == arr.shape and np.abs(arr.astype(np.int16)-previous.astype(np.int16)).mean() < 1:
            excluded.append({'file':f.name,'reason':'consecutive-duplicate'})
            continue
        kept.append(f)
        previous = arr
        alpha = (arr[:,:,3] == 0).mean()
        if .1 <= alpha <= .9 or max(arr.shape[:2]) <= 128 or WORDS.search(f.name):
            shutil.copy2(f, ui/f.name)
            candidates.append({'file':f.name,'reason':'alpha/size/name'})
    if snapshots:
        def pixels(f):
            with Image.open(f) as im:
                return np.array(im.convert('RGB')).astype(np.int16)
        if len(kept) >= 3:
            before, current = pixels(kept[0]), pixels(kept[1])
            for i in range(1, len(kept)-1):
                after = pixels(kept[i+1])
                if before.shape == current.shape == after.shape:
                    mask1 = np.max(np.abs(current-before),axis=2)>8
                    mask2 = np.max(np.abs(current-after),axis=2)>8
                    mask = mask1 | mask2
                    if 0 < mask.mean() < .12 and mask1.mean() < .12 and mask2.mean() < .12:
                        f = kept[i]
                        shutil.copy2(f, ui/f.name)
                        yy,xx = np.where(mask)
                        box = (max(0,int(xx.min())-4),max(0,int(yy.min())-4),min(current.shape[1],int(xx.max())+5),min(current.shape[0],int(yy.max())+5))
                        with Image.open(f) as im:
                            im.crop(box).save(ui/(f.stem+'_change.png'))
                        candidates.append({'file':f.name,'reason':'both-neighbour-change','box':box,'changed_fraction':float(mask.mean())})
                before,current = current,after
    groups = defaultdict(list)
    for f in kept:
        groups['frames' if snapshots else f.name.split('@')[0].split('_guess')[0]].append(f)
    count = 0
    per = 30 if snapshots else 40
    for group, images in groups.items():
        for start in range(0,len(images),per):
            chunk = images[start:start+per]
            w,h,cols = 256,208,5
            sheet=Image.new('RGB',(w*cols,h*((len(chunk)+cols-1)//cols)), '#24242b')
            draw=ImageDraw.Draw(sheet)
            for j,f in enumerate(chunk):
                with Image.open(f) as src:
                    src=src.convert('RGBA')
                    size=src.size
                    src.thumbnail((w-12,h-48),Image.Resampling.NEAREST)
                    x,y=(j%cols)*w,(j//cols)*h
                    sheet.paste(src,(x+(w-src.width)//2,y+4),src)
                label=f.name.replace('.png','')
                draw.text((x+4,y+h-42),label[:35],fill='white')
                draw.text((x+4,y+h-28),label[35:70],fill='white')
                draw.text((x+4,y+h-14),f'{size[0]}x{size[1]}',fill='#aabbee')
            safe=re.sub(r'[^A-Za-z0-9_.-]','_',group)[:100]
            sheet.save(contact/f'{safe}_{start//per+1:03d}.png')
            count+=1
    result={'raw_count':len(files),'kept_count':len(kept),'ui_candidate_count':len(list(ui.glob('*.png'))),'contact_count':count,'excluded':excluded,'candidates':candidates}
    (out/'catalog.json').write_text(json.dumps(result,indent=2))
    return result

if __name__ == '__main__':
    p=argparse.ArgumentParser(description=__doc__)
    p.add_argument('--raw',required=True,type=Path)
    p.add_argument('--out',required=True,type=Path)
    p.add_argument('--snapshots',action='store_true')
    a=p.parse_args()
    r=catalogue(a.raw,a.out,a.snapshots)
    print(json.dumps({k:v for k,v in r.items() if k not in ('excluded','candidates')}))
