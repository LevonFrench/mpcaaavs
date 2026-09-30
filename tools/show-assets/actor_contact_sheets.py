"""Labelled, alpha-aware contact sheets for caller-provided clip.json folders."""
import argparse
import json
from pathlib import Path
from PIL import Image,ImageDraw

def sheets(root,out):
    count=0
    for path in sorted(root.rglob('clip.json')):
        clip=json.loads(path.read_text());frames=clip['frames'];dest=out/path.parent.relative_to(root);dest.mkdir(parents=True,exist_ok=True)
        for start in range(0,len(frames),40):
            chunk=frames[start:start+40];cols=5;tw,th=192,192;sheet=Image.new('RGB',(cols*tw,((len(chunk)+cols-1)//cols)*th),'#25252b');draw=ImageDraw.Draw(sheet)
            for k,entry in enumerate(chunk):
                x,y=k%cols*tw,k//cols*th
                for yy in range(0,152,8):
                    for xx in range(0,tw,8):draw.rectangle((x+xx,y+yy,x+xx+7,y+yy+7),fill='#303039' if (xx//8+yy//8)%2 else '#202027')
                with Image.open(path.parent/entry['png']) as src:
                    im=src.convert('RGBA');scale=max(1,min(3,180//im.width,144//im.height))
                    if scale>1:im=im.resize((im.width*scale,im.height*scale),Image.Resampling.NEAREST)
                    im.thumbnail((180,144),Image.Resampling.NEAREST);sheet.paste(im,(x+(tw-im.width)//2,y+4),im)
                source=entry.get('source',{});label=f'{start+k:04d}  duration={entry["duration"]}'
                draw.text((x+5,y+157),label,fill='white');draw.text((x+5,y+173),'source frame '+str(source.get('frame','?')),fill='#aabbee')
            sheet.save(dest/f'sheet-{start//40:03d}.png');count+=1
    return count

if __name__=='__main__':
    p=argparse.ArgumentParser(description=__doc__);p.add_argument('--root',required=True,type=Path);p.add_argument('--out',required=True,type=Path);a=p.parse_args();print('Contact sheets',sheets(a.root,a.out))
