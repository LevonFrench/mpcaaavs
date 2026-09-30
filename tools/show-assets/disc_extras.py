"""Sequential BSS extras runner with caller-supplied manifest and paths."""
import argparse
import json
import shutil
import subprocess
import sys
import time
from pathlib import Path
from catalog_images import catalogue
from disc_batch import digest,ledger

def main():
    ap=argparse.ArgumentParser(description=__doc__)
    for n in ('manifest','out','scratch','chdman','ffmpeg'):ap.add_argument('--'+n,required=True,type=Path)
    a=ap.parse_args();tools=Path(__file__).resolve().parent
    for job in json.loads(a.manifest.read_text()):
        dest=a.out/'disc'/job['system']/job['slug'];raw=dest/'raw'/'rooms'
        if (dest/'rooms-meta.json').exists():print('RESUME rooms',job['slug'],flush=True);continue
        start=time.monotonic();work=a.scratch/('rooms-'+job['slug'])
        if work.exists():raise ValueError('unclaimed scratch '+str(work))
        work.mkdir();notes=[];sources=[];count=0;status='partial'
        print('START rooms',job['slug'],flush=True)
        try:
            for si,name in enumerate(job['sources'],1):
                source=Path(name);sources.append({'path':str(source.resolve()),'sha256':digest(source)})
                if source.suffix.lower()=='.chd':
                    b=work/f'disc{si}.bin'
                    with (dest/'rooms-run.log').open('a') as log:
                        subprocess.run([str(a.chdman),'extractcd','-i',str(source),'-o',str(work/f'disc{si}.cue'),'-ob',str(b)],stdout=log,stderr=log,check=True,timeout=1800-(time.monotonic()-start))
                    bins=[b]
                elif source.suffix.lower()=='.pbp':
                    subprocess.run([sys.executable,str(tools/'pbp_to_bin.py'),'--pbp',str(source),'--out',str(work/f'disc{si}')],check=True,timeout=1800-(time.monotonic()-start))
                    bins=sorted(work.glob(f'disc{si}*.bin'))
                else:bins=[source]
                for di,b in enumerate(bins,1):
                    target=raw if len(bins)==1 else raw/f'd{di}'
                    subprocess.run([sys.executable,str(tools/'bss_rooms.py'),'--source',str(b),'--out',str(target),'--scratch',str(work),'--ffmpeg',str(a.ffmpeg),'--alignment',str(job['alignment']),'--seconds',str(max(1,int(1800-(time.monotonic()-start))))],check=True,timeout=max(1,1800-(time.monotonic()-start)))
                    receipt=json.loads((target/'rooms.json').read_text());count+=receipt['decoded']
                    c=catalogue(target,dest/('rooms-catalog' if len(bins)==1 else f'rooms-catalog-d{di}'))
                    notes.append(f'disc {di}: {receipt["decoded"]} rooms, {len(receipt["failures"])} failures; samples require visual validation')
                    if b.is_relative_to(work):b.unlink()
        except Exception as e:notes.append(str(e));status='timeout' if isinstance(e,subprocess.TimeoutExpired) else 'failed'
        finally:
            if work.resolve().parent!=a.scratch.resolve():raise ValueError('unsafe cleanup')
            shutil.rmtree(work)
        seconds=round(time.monotonic()-start,2)
        (dest/'rooms-meta.json').write_text(json.dumps({'sources':sources,'rooms_decoded':count,'status':status,'notes':notes,'seconds':seconds},indent=2))
        ledger(a.out/'LEDGER.csv',{'system':job['system'],'slug':job['slug'],'title':job['title'],'source_path':' | '.join(job['sources']),'method':'disc:rooms','status':status,'raw_count':count,'ui_candidate_count':0,'seconds':seconds,'notes':' | '.join(notes)})
        print('FINISH rooms',job['slug'],count,status,flush=True)

if __name__=='__main__':main()
