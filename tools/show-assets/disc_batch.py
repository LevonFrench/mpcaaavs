"""Sequential private disc harvest. Supply JSON manifest, output and scratch paths.

Runs installed chdman and the existing PBP reader only. Append-only ledger;
per-job receipts allow resume. Scratch cleanup is limited to owned directories.
"""
import argparse
import csv
import hashlib
import json
import shutil
import subprocess
import sys
import time
from pathlib import Path
from disc_fs import open_disc, Unsupported
from psx_extract import Disc
from catalog_images import catalogue

COLS='system,slug,title,source_path,method,status,raw_count,ui_candidate_count,seconds,notes'.split(',')

def digest(path):
    h=hashlib.sha256()
    with path.open('rb') as f:
        for data in iter(lambda:f.read(4*1024**2),b''):h.update(data)
    return h.hexdigest()

def ledger(path,row):
    fresh=not path.exists()
    with path.open('a',newline='',encoding='utf-8') as f:
        w=csv.DictWriter(f,fieldnames=COLS)
        if fresh:w.writeheader()
        w.writerow(row);f.flush()

def main():
    ap=argparse.ArgumentParser(description=__doc__)
    for name in ('manifest','out','scratch','chdman'):ap.add_argument('--'+name,required=True,type=Path)
    ap.add_argument('--system');ap.add_argument('--seconds',type=int,default=1800)
    a=ap.parse_args();a.out.mkdir(parents=True,exist_ok=True);a.scratch.mkdir(parents=True,exist_ok=True)
    tools=Path(__file__).resolve().parent
    jobs=json.loads(a.manifest.read_text(encoding='utf-8'))
    for job in jobs:
        if a.system and job['system']!=a.system:continue
        system,slug=job['system'],job['slug']
        if Path(slug).name!=slug or slug in ('.','..'):raise ValueError('unsafe slug')
        dest=a.out/'disc'/system/slug;dest.mkdir(parents=True,exist_ok=True)
        meta=dest/'meta.json'
        if meta.exists() and json.loads(meta.read_text()).get('scan_finished'):
            print('RESUME',system,slug,flush=True);continue
        work=a.scratch/('disc-'+slug)
        if work.exists():raise RuntimeError('unclaimed scratch: '+str(work))
        work.mkdir();start=time.monotonic();deadline=start+a.seconds
        notes=[];sources=[];trees=[];status='partial';counts={'raw_count':0,'ui_candidate_count':0};formats={}
        print('START',system,slug,flush=True)
        def run(cmd):
            remaining=deadline-time.monotonic()
            if remaining<=0:raise subprocess.TimeoutExpired(cmd,a.seconds)
            with (dest/'run.log').open('a',encoding='utf-8') as log:
                result=subprocess.run(list(map(str,cmd)),stdout=log,stderr=log,timeout=remaining)
            if result.returncode:raise ValueError('conversion/scan failed: '+(dest/'run.log').read_text(errors='replace')[-1000:])
        try:
            paths=job.get('sources',[])
            if not paths:raise Unsupported(job.get('reason','source not found'))
            discnum=0
            for source_number,supplied in enumerate(paths,1):
                source=Path(supplied)
                if not source.is_file():raise FileNotFoundError(str(source))
                stat=source.stat()
                if source.suffix.lower() in ('.7z','.zip','.rar'):raise Unsupported('archive')
                sources.append({'path':str(source.resolve()),'sha256':digest(source),'size':stat.st_size,'mtime_ns':stat.st_mtime_ns})
                ext=source.suffix.lower();images=[source]
                if ext=='.chd':
                    if system=='dreamcast':
                        run([a.chdman,'extractcd','-i',source,'-o',work/f'source{source_number}.gdi']);images=[work/f'source{source_number}.gdi']
                    else:
                        run([a.chdman,'extractcd','-i',source,'-o',work/f'source{source_number}.cue','-ob',work/f'source{source_number}.bin']);images=[work/f'source{source_number}.bin']
                elif ext=='.pbp':
                    run([sys.executable,tools/'pbp_to_bin.py','--pbp',source,'--out',work/'disc']);images=sorted(work.glob('disc*.bin'))
                elif ext=='.gz':
                    run([sys.executable,tools/'disc_gunzip.py','--source',source,'--out',work/'disc.iso']);images=[work/'disc.iso']
                if sum(p.stat().st_size for p in a.scratch.rglob('*') if p.is_file())>20*1024**3:raise ValueError('scratch exceeds 20 GiB')
                for image in images:
                    discnum+=1;prefix=f'd{discnum}_' if len(images)>1 or len(paths)>1 else ''
                    reader=open_disc(image,system)
                    try:
                        tree=list(reader.tree())
                        trees.extend(f'{prefix}{name}\t{size}\t{offset}' for name,offset,size in tree)
                    finally:reader.close()
                    (dest/'files.txt').write_text('\n'.join(trees)+'\n',encoding='utf-8')
                    run([sys.executable,tools/'disc_scan.py','--source',image,'--system',system,'--out',dest/'raw','--prefix',prefix])
                    if image.is_relative_to(work) and image.suffix!='.gdi':image.unlink()
                if source.stat().st_size!=stat.st_size or source.stat().st_mtime_ns!=stat.st_mtime_ns:raise ValueError('source changed externally')
            status='partial';notes.append('Filesystem scan complete; game-specific extras and visual acceptance tracked separately.')
        except Unsupported as e:status='skipped';notes.append('skipped: '+str(e))
        except subprocess.TimeoutExpired:status='timeout';notes.append('30-minute game timebox')
        except Exception as e:status='failed';notes.append(str(e))
        finally:
            if work.resolve().parent!=a.scratch.resolve() or not work.name.startswith('disc-'):raise RuntimeError('unsafe cleanup')
            shutil.rmtree(work)
        for raw in sorted((dest/'raw').glob('*')) if (dest/'raw').exists() else []:
            if not raw.is_dir():continue
            if any(raw.glob('*.png')):
                c=catalogue(raw,dest/('catalog-'+raw.name))
                counts['raw_count']+=c['raw_count'];counts['ui_candidate_count']+=c['ui_candidate_count'];formats[raw.name]=c['raw_count']
                for folder,target in (('contact','sheets'),('ui-candidates','ui-candidates')):
                    for p in (dest/('catalog-'+raw.name)/folder).glob('*.png'):
                        to=dest/target/raw.name/p.name;to.parent.mkdir(parents=True,exist_ok=True)
                        if not to.exists():shutil.move(str(p),to)
        seconds=round(time.monotonic()-start,2)
        receipt={**job,'sources':sources,'method':'disc:'+','.join(formats),'status':status,**counts,'formats':formats,'seconds':seconds,'notes':notes,'scan_finished':True}
        meta.write_text(json.dumps(receipt,indent=2),encoding='utf-8')
        ledger(a.out/'LEDGER.csv',{'system':system,'slug':slug,'title':job['title'],'source_path':' | '.join(job.get('sources',[])),'method':receipt['method'],'status':status,**counts,'seconds':seconds,'notes':' | '.join(notes)})
        print('FINISH',system,slug,status,counts,seconds,flush=True)

if __name__=='__main__':main()
