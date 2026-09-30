"""Bounded gzip-to-ISO expansion into caller-owned scratch."""
import argparse
import gzip
from pathlib import Path

if __name__=='__main__':
    p=argparse.ArgumentParser(description=__doc__)
    p.add_argument('--source',type=Path,required=True);p.add_argument('--out',type=Path,required=True)
    a=p.parse_args();count=0
    with gzip.open(a.source,'rb') as src,a.out.open('xb') as dst:
        while data:=src.read(1024**2):
            count+=len(data)
            if count>20*1024**3:raise ValueError('gzip expansion exceeds scratch budget')
            dst.write(data)
