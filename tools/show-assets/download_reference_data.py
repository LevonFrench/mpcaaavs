"""Download explicitly selected reference DATA, serially, with source records.

No remote code is executed. Allowed kinds: image, movie, documentation, source.
Each call writes a SOURCES.csv row and sha256. A private policy-state JSON
coordinates all requests: >=1.25 s between requests, and any HTTP error stops
that host for the session. No login, cookies, retries or bot-wall bypass.
Usage: --url URL --out FILE --kind image --page-url PAGE --what DESCRIPTION
       --sources CSV --state JSON [--credit TEXT] [--max-mb 32]
"""
import argparse, csv, datetime, hashlib, io, json, os, time
from pathlib import Path
from urllib.request import Request, urlopen
from urllib.parse import urlsplit, urlunsplit, quote
from urllib.error import HTTPError, URLError
import zipfile
from PIL import Image

COLUMNS=['url','page_url','date','what','kind','file','sha256','bytes','content_type','credit','status','notes']
BAD_SUFFIXES={'.exe','.dll','.msi','.bat','.cmd','.ps1','.py','.js','.lua','.sh','.com','.scr','.vbs'}

def write_row(path,row):
    path.parent.mkdir(parents=True,exist_ok=True)
    exists=path.exists()
    with path.open('a',newline='',encoding='utf-8') as f:
        w=csv.DictWriter(f,fieldnames=COLUMNS)
        if not exists:w.writeheader()
        w.writerow({k:row.get(k,'') for k in COLUMNS})

def fetch(url,out,kind,sources,state,page_url='',what='',credit='',max_mb=32):
    out,sources,state=Path(out).resolve(),Path(sources).resolve(),Path(state).resolve()
    parts=urlsplit(url)
    url=urlunsplit((parts.scheme,parts.netloc,quote(parts.path,safe='/%:@'),quote(parts.query,safe='/%?:@&=+'),parts.fragment))
    host=urlsplit(url).hostname
    if urlsplit(url).scheme!='https':raise ValueError('HTTPS data URLs required')
    if out.exists():raise FileExistsError('Preserve existing file: '+str(out))
    policy=json.loads(state.read_text()) if state.exists() else {'last_request':0,'stopped_hosts':{}}
    if host in policy.get('stopped_hosts',{}):raise RuntimeError('Host stopped after earlier error: '+host)
    time.sleep(max(0,1.25-(time.time()-policy.get('last_request',0))))
    row={'url':url,'page_url':page_url,'date':datetime.datetime.now(datetime.timezone.utc).isoformat(),'what':what,'kind':kind,'file':str(out),'credit':credit,'status':'failed'}
    state.parent.mkdir(parents=True,exist_ok=True)
    try:
        req=Request(url,headers={'User-Agent':'PrivateReferenceResearch/1.0','Accept':'image/*' if kind=='image' else '*/*'})
        with urlopen(req,timeout=40) as response:
            mime=response.headers.get_content_type()
            length=response.headers.get('Content-Length')
            if length and int(length)>max_mb*1024**2:raise ValueError('File-size cap exceeded')
            data=response.read(max_mb*1024**2+1)
            if len(data)>max_mb*1024**2:raise ValueError('File-size cap exceeded')
            row['content_type']=mime;row['bytes']=len(data)
            row['resolved_url']=response.url
        if not data:raise ValueError('Empty data response')
        lower=data[:16000].lower()
        if any(x in lower for x in (b'just a moment',b'verify you are human',b'cf-chl-',b'captcha challenge',b'performing security verification')):raise ValueError('Bot protection encountered; stop host')
        if kind=='image':
            if not mime.startswith('image/'):raise ValueError('Expected image content type, got '+mime)
            with Image.open(io.BytesIO(data)) as im:
                if im.format not in ('PNG','GIF','JPEG','WEBP','BMP'):raise ValueError('Unsupported raster data')
                im.verify()
        elif kind=='movie':
            if data[:2]==b'MZ' or data[:4]==b'\x7fELF':raise ValueError('Program signature rejected')
            if mime in ('text/html','application/xhtml+xml'):raise ValueError('HTML instead of input movie')
            if zipfile.is_zipfile(io.BytesIO(data)):
                with zipfile.ZipFile(io.BytesIO(data)) as z:
                    if any(Path(n).suffix.lower() in BAD_SUFFIXES for n in z.namelist()):raise ValueError('Program member in movie archive rejected')
        elif kind not in ('documentation','source'):raise ValueError('Unknown data kind')
        if out.suffix.lower() in BAD_SUFFIXES and kind!='source':raise ValueError('Program extension rejected')
        out.parent.mkdir(parents=True,exist_ok=True)
        with out.open('xb') as f:f.write(data)
        row['sha256']=hashlib.sha256(data).hexdigest();row['status']='downloaded'
    except Exception as e:
        row['notes']=str(e)
        policy.setdefault('stopped_hosts',{})[host]=str(e)
        raise
    finally:
        policy['last_request']=time.time()
        state.write_text(json.dumps(policy,indent=2))
        write_row(sources,row)
    return row

if __name__=='__main__':
    p=argparse.ArgumentParser(description=__doc__)
    for n in ('url','out','kind','sources','state'):p.add_argument('--'+n,required=True)
    for n in ('page-url','what','credit'):p.add_argument('--'+n,default='')
    p.add_argument('--max-mb',type=int,default=32)
    a=p.parse_args();print(json.dumps(fetch(a.url,a.out,a.kind,a.sources,a.state,a.page_url,a.what,a.credit,a.max_mb)))
