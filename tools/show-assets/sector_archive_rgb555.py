"""Export caller-mapped opaque RGB555 bitmap entries from sector archives.

Compressed entries use the bounded LZSS reader; source extent and pixel dimensions
must match exactly. All paths and mappings are supplied as arguments.
"""
import argparse
import hashlib
import json
import re
from pathlib import Path
import numpy as np
from PIL import Image
from sector_archive_images import entries,decompress


def export(data,disc_path,out,header,width,height,padding=0):
    if not 0<width<=4096 or not 0<height<=4096 or width*height>524288:
        raise ValueError('invalid bitmap dimensions')
    if not 0<=padding<=4096:raise ValueError('invalid explicit bitmap padding')
    size=width*height*2
    if header is None:entry={'type':0,'offset':0,'size':len(data),'container':'raw bitmap'}
    else:entry=entries(data)[header]
    payload=data[entry['offset']:entry['offset']+entry['size']]
    if entry['type']==7:payload=decompress(payload,size,padding)
    elif entry['type']==0:
        if len(payload)!=size+padding or any(payload[size:]):raise ValueError('bitmap size or explicit zero padding mismatch')
        payload=payload[:size]
    else:raise ValueError('entry is not a mapped raw/compressed bitmap')
    words=np.frombuffer(payload,dtype='<u2').reshape(height,width)
    channels=np.stack([words&31,(words>>5)&31,(words>>10)&31],axis=-1).astype(np.uint8)
    im=Image.fromarray((channels<<3)|(channels>>2));out=Path(out);out.mkdir(parents=True,exist_ok=True);index=out/'index.json'
    old=json.loads(index.read_text()) if index.exists() else []
    if any(x.get('method')!='disc:sector-rgb555' for x in old):raise ValueError('preserve independent index')
    owned={x['png']:x for x in old};name=re.sub(r'[^A-Za-z0-9_.-]','_',disc_path)+f'@{entry["offset"]:08x}.png';target=out/name
    if target.exists():
        if name not in owned:raise ValueError('preserve unclaimed PNG')
        with Image.open(target) as previous:
            if previous.size!=im.size or not np.array_equal(np.array(previous.convert('RGB')),np.array(im)):raise ValueError('preserve independently changed PNG')
    else:im.save(target)
    row={'file':disc_path,'png':name,'offset':entry['offset'],'header':header,'entry':entry,'width':width,'height':height,'bpp':16,'layout':'linear','alpha':'opaque background','zero_expansion_padding_verified':padding,'source_data_sha256':hashlib.sha256(data).hexdigest(),'method':'disc:sector-rgb555','visual_acceptance':False}
    owned[name]=row;index.write_text(json.dumps(list(owned.values()),indent=2));return row


if __name__=='__main__':
    p=argparse.ArgumentParser(description=__doc__)
    p.add_argument('--source-data',required=True,type=Path);p.add_argument('--disc-path',required=True);p.add_argument('--out',required=True,type=Path)
    mapping=p.add_mutually_exclusive_group(required=True);mapping.add_argument('--header',type=lambda x:int(x,0));mapping.add_argument('--raw',action='store_true')
    for k in ('width','height'):p.add_argument('--'+k,type=lambda x:int(x,0),required=True)
    p.add_argument('--padding',type=int,default=0);a=p.parse_args()
    print('Mapped RGB555 bitmap:',export(a.source_data.read_bytes(),a.disc_path,a.out,a.header,a.width,a.height,a.padding)['png'])
