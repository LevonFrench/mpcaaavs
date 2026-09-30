"""Decode documented PS1 BSS stills with an installed FFmpeg MDEC decoder.

Wrap original bitstream bytes in disposable STR sectors; no game is played.
Public reference: FFmpeg libavformat/psxstr.c and libavcodec/mdec.c.
"""
import argparse
import json
import re
import struct
import subprocess
import time
from pathlib import Path
from disc_fs import open_disc

def sectors(frame):
    size=len(frame);count=(size+2015)//2016;out=bytearray()
    for i in range(count):
        sector=bytearray(2352);sector[:12]=b'\0'+b'\xff'*10+b'\0';sector[15]=2
        sector[18]=2;sector[22]=2
        struct.pack_into('<IHHIIHH',sector,24,0x80010160,i,count,0,size,320,240)
        chunk=frame[i*2016:(i+1)*2016];sector[56:56+len(chunk)]=chunk;out.extend(sector)
    return out

def main():
    ap=argparse.ArgumentParser(description=__doc__)
    for n in ('source','out','scratch','ffmpeg'):ap.add_argument('--'+n,required=True,type=Path)
    ap.add_argument('--alignment',type=int,choices=(32768,65536),default=65536)
    ap.add_argument('--seconds',type=int,default=1800);a=ap.parse_args()
    a.out.mkdir(parents=True,exist_ok=True);a.scratch.mkdir(parents=True,exist_ok=True)
    previous=a.out/'index.json'
    reader=open_disc(a.source);rows=json.loads(previous.read_text()) if previous.exists() else [];errors=[];start=time.monotonic()
    try:
        for name,lba,size in reader.tree():
            if not name.upper().endswith('.BSS'):continue
            data=reader.read(lba,size)
            for off in range(0,len(data),a.alignment):
                if time.monotonic()-start>a.seconds:raise TimeoutError('room decoding timebox')
                frame=data[off:off+a.alignment]
                if len(frame)<8:continue
                words,magic,qscale,version=struct.unpack_from('<4H',frame)
                if magic!=0x3800 or version not in (1,2,3) or not 1<=qscale<=63:
                    errors.append({'file':name,'offset':off,'reason':'unsupported BSS bitstream header'});continue
                stem=re.sub(r'[^A-Za-z0-9_.-]','_',name)+f'@{off:08x}'
                output=a.out/(stem+'.png')
                if output.exists():continue
                wrapped=a.scratch/'frame.str'
                wrapped.write_bytes(sectors(frame))
                p=subprocess.run([str(a.ffmpeg),'-nostdin','-v','error','-f','psxstr','-i',str(wrapped),'-frames:v','1',str(output)],capture_output=True,text=True,timeout=min(30,max(1,a.seconds-(time.monotonic()-start))))
                wrapped.unlink()
                if p.returncode or not output.exists():
                    errors.append({'file':name,'offset':off,'reason':p.stderr[-700:]})
                    if output.exists():output.rename(output.with_suffix('.invalid.png'))
                else:rows.append({'file':name,'offset':off,'png':output.name,'width':320,'height':240,'version':version})
        (a.out/'index.json').write_text(json.dumps(rows,indent=1))
        (a.out/'rooms.json').write_text(json.dumps({'decoded':len(rows),'failures':errors,'seconds':time.monotonic()-start,'visually_validated':False},indent=2))
        print('ROOMS',len(rows),'FAILURES',len(errors),flush=True)
    finally:
        reader.close()
        temp=a.scratch/'frame.str'
        if temp.exists():temp.unlink()

if __name__=='__main__':main()
