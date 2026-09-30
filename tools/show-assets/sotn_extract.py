"""Extract palette-mapped graphics and actor clips from caller-supplied maps.

Read-only reference: Xeeynamo/sotn-decomp config/assets.us.yaml. Unknown palette
bindings are logged, never replaced with invented colors or animation timing.
No downloaded source is imported or executed.
"""
import argparse
import json
import re
import struct
from pathlib import Path
import numpy as np
import yaml
from PIL import Image
from disc_fs import open_disc
from image_formats import indices,packed16,cut

def pointer_table(data, offset, base, maximum=4096):
    """An asset table ends at its earliest non-null pointed-to record."""
    pointers=[];end=len(data);p=offset
    while p<end and len(pointers)<maximum:
        value=struct.unpack_from('<I',data,p)[0];p+=4
        if value:
            real=value-base
            if not offset<=real<len(data):raise ValueError('asset pointer outside table/data region')
            end=min(end,real)
        pointers.append(value)
    if p!=end:raise ValueError('asset pointer table boundary mismatch')
    return pointers

def actor_clips(reader, mapping, out):
    """Read source pointer tables and animation control records, never C code."""
    tree={n:(l,s) for n,l,s in reader.tree()};cache={};result=[]
    def load(name):
        if name not in cache:
            l,s=tree[name];cache[name]=reader.read(l,s)
        return cache[name]
    for actor in mapping['actors']:
        data=load(actor['frame_file']);base=actor['frame_base'];graphics=load(actor['graphics_file']);gb=actor['graphics_base']
        frameptrs=pointer_table(data,actor['frame_table'],base)
        gp=struct.unpack_from('<I',graphics,actor['graphics_bank']*4)[0]-gb
        gfxptrs=pointer_table(graphics,gp,gb)
        palette_source=load(actor['palette_file']);po=actor['palette_offset'];pal=packed16(cut(palette_source,po,32),'psx');pal[0,3]=0
        frames={0:(Image.new('RGBA',(1,1)),0,0,{'blank_null_frame':True})};skips=[]
        for i,pointer in enumerate(frameptrs):
            if not pointer:continue
            try:
                flags,x,y,_=struct.unpack_from('<HhhH',data,pointer-base)
                if not flags&0x8000:raise ValueError('multi-part frame requires a texture-page mapping')
                index=flags&0x7fff;go=gfxptrs[index]-gb;w,h,px,py=cut(graphics,go,4)
                if not 0<w<=255 or not 0<h<=255:raise ValueError('invalid sprite header')
                ids=indices(cut(graphics,go+4,(w*h+1)//2),4)[:w*h].reshape(h,w)
                frames[i]=(Image.fromarray(pal[ids]),x+px,y+py,{'frame_pointer':pointer,'graphics_offset':go,'graphics_index':index,'part_offset':[x,y],'header_pivot':[px,py]})
            except (ValueError,IndexError,struct.error) as e:skips.append({'frame':i,'reason':str(e)})
        animation_data=load(actor['animation_file']);ab=actor['animation_base']
        table=[struct.unpack_from('<I',animation_data,actor['animation_table']+i*4)[0]-ab for i in range(actor['animation_count'])]
        subtable=[struct.unpack_from('<I',animation_data,actor['subanimation_table']+i*4)[0]-ab for i in range(actor['subanimation_count'])]
        def records(offset,depth=0):
            if depth>4:raise ValueError('recursive animation call')
            rows=[]
            for k in range(4096):
                duration,pose=struct.unpack_from('<hH',animation_data,offset+k*4)
                if duration==-3:
                    called=records(subtable[pose&255],depth+1)
                    if not called or called[-1][0]!=-1:raise ValueError('subanimation lacks end marker')
                    rows.extend(called[:-1])
                else:
                    rows.append((duration,pose,offset+k*4))
                    if duration<=0:return rows
            raise ValueError('animation lacks terminal control record')
        programs={i:records(p) for i,p in enumerate(table)}
        actor_out=out/'actors'/actor['name'];actor_out.mkdir(parents=True,exist_ok=True)
        for anim in range(len(table)):
            seq=[];seen={};state=(anim,0);loop_at=None;terminal=None
            try:
                while len(seq)<4096:
                    if state in seen:loop_at=seen[state];break
                    seen[state]=len(seq);aid,step=state;duration,pose,offset=programs[aid][step]
                    if duration>0:
                        frame=pose&0x1ff
                        if frame not in frames:raise ValueError('animation references unsupported frame '+str(frame))
                        seq.append({'frame':frame,'duration':duration,'properties':pose>>9,'record_offset':offset,'animation_id':aid});state=(aid,step+1)
                    elif duration==0:state=(aid,pose)
                    elif duration==-2:state=(pose&255,pose>>8)
                    elif duration==-1:terminal='source end/hold';break
                    else:raise ValueError('unsupported animation control '+str(duration))
                if not seq:continue
                if len(seq)>=4096:raise ValueError('animation exceeded bounded instruction budget')
                # Preserve each source part's offsets on one stable canvas per clip.
                l=min(frames[s['frame']][1] for s in seq);t=min(frames[s['frame']][2] for s in seq)
                r=max(frames[s['frame']][1]+frames[s['frame']][0].width for s in seq);b=max(frames[s['frame']][2]+frames[s['frame']][0].height for s in seq)
                verb=actor.get('verbs',{}).get(str(anim),f'animation-{anim:03d}');folder=actor_out/verb
                if (folder/'clip.json').exists():
                    old=json.loads((folder/'clip.json').read_text())
                    if old.get('method')!='disc:sprite-header+animation-table' or old.get('source_animation_offset')!=table[anim]:
                        raise ValueError('preserve independent existing clip: '+str(folder))
                    result.append({'actor':actor['name'],'verb':verb,'frames':len(old['frames']),'animation_id':anim,'resumed':True});continue
                folder.mkdir(parents=True,exist_ok=True);entries=[]
                for n,s in enumerate(seq):
                    im,x,y,info=frames[s['frame']];canvas=Image.new('RGBA',(r-l,b-t));canvas.alpha_composite(im,(x-l,y-t));filename=f'{n:04d}.png';canvas.save(folder/filename)
                    entries.append({'png':filename,'duration':s['duration'],'anchor':[-l,b-t-1],'entity_anchor':[-l,-t],'big':False,'source':{**s,**info}})
                receipt={'role':actor.get('role','hero'),'verb':verb,'frames':entries,'loop':loop_at is not None,'loop_start':loop_at,'terminal':terminal,'animation_id':anim,'source_animation_offset':table[anim],'source_duration_units':'game frames','palette_source':actor['palette_file'],'palette_offset':po,'method':'disc:sprite-header+animation-table','anchor_note':'Stable entity alignment; foot baseline is bottom of the clip union.','visual_acceptance':False}
                (folder/'clip.json').write_text(json.dumps(receipt,indent=2));result.append({'actor':actor['name'],'verb':verb,'frames':len(seq),'animation_id':anim})
            except (ValueError,IndexError,KeyError,struct.error) as e:skips.append({'animation':anim,'reason':str(e)})
        (actor_out/'extraction.json').write_text(json.dumps({'source_frame_count':len(frames),'palette_offset':po,'skips':skips,'clips':[r for r in result if r['actor']==actor['name']]},indent=2))
    (out/'actor-extraction.json').write_text(json.dumps({'clips':result,'visual_acceptance':False},indent=2));return result

def inflate(data,expected):
    cut(data,0,8);dictionary=data[:8];pos=16;out=[]
    def nibble():
        nonlocal pos
        if pos//2>=len(data):raise ValueError('truncated compressed image')
        v=data[pos//2];v=(v&15) if pos%2 else v>>4;pos+=1;return v
    while len(out)<expected*2+1:
        op=nibble()
        if op==15:
            if len(out)!=expected*2:raise ValueError('compressed image size mismatch')
            a=np.array(out,dtype=np.uint8);return (a[::2]|a[1::2]<<4).tobytes()
        if op==0:out.extend([0]*((nibble()<<4)+nibble()+0x13))
        elif op==1:out.append(nibble())
        elif op==2:v=nibble();out.extend([v,v])
        elif op==3:out.extend([nibble(),nibble()])
        elif op==4:out.extend([nibble(),nibble(),nibble()])
        elif op==5:v=nibble();out.extend([v]*(nibble()+3))
        elif op==6:out.extend([0]*(nibble()+3))
        else:
            v=dictionary[op-7];kind,amount=v&0xf0,v&15
            if kind==0x10:out.append(amount)
            elif kind==0x20:out.extend([amount,amount])
            elif kind==0x60:out.extend([0]*(amount+3))
            else:raise ValueError('unsupported compression dictionary entry')
    raise ValueError('compressed image exceeds documented size')

def main():
    p=argparse.ArgumentParser(description=__doc__)
    for n in ('source','config','out'):p.add_argument('--'+n,required=True,type=Path)
    p.add_argument('--actor-map',type=Path);p.add_argument('--actors-out',type=Path)
    a=p.parse_args();a.out.mkdir(parents=True,exist_ok=True)
    config=yaml.safe_load(a.config.read_text());reader=open_disc(a.source);tree={n:(l,s) for n,l,s in reader.tree()};rows=[];skips=[]
    try:
        if a.actor_map:
            if not a.actors_out:p.error('--actor-map requires --actors-out')
            clips=actor_clips(reader,json.loads(a.actor_map.read_text()),a.actors_out)
            print('Source-duration actor clips',len(clips),flush=True)
        for file in config['files']:
            name=file['target'].split('/',2)[-1]
            if name not in tree:continue
            l,s=tree[name];data=reader.read(l,s)
            for segment in file.get('segments',[]):
                for asset in segment['assets']:
                    if len(asset)<3:continue
                    off,kind,label,*args=asset
                    if kind not in ('rawgfx','cmpgfx'):continue
                    if len(args)!=4:
                        skips.append({'file':name,'asset':label,'reason':'palette not explicitly bound in supplied map'});continue
                    w,h,bpp,paloff=args
                    if bpp not in (4,8):continue
                    try:
                        pal=packed16(cut(data,paloff,(1<<bpp)*2),'psx');pal[0,3]=0
                        expected=w*h*bpp//8
                        raw=inflate(data[off:],expected) if kind=='cmpgfx' else cut(data,off,expected)
                        ids=indices(raw,bpp).reshape(h,w)
                        folder=a.out/'documented-gfx';folder.mkdir(exist_ok=True)
                        stem=re.sub(r'[^A-Za-z0-9_.-]','_',name+'_'+label)+f'@{off:08x}'
                        output=folder/(stem+'.png')
                        if not output.exists():Image.fromarray(pal[ids]).save(output)
                        rows.append({'file':name,'offset':off,'asset':label,'png':output.name,'width':w,'height':h,'bpp':bpp,'palette_offset':paloff,'kind':kind})
                    except (ValueError,IndexError,struct.error) as e:skips.append({'file':name,'asset':label,'reason':str(e)})
        (a.out/'documented-gfx'/'index.json').write_text(json.dumps(rows,indent=1))
        (a.out/'sotn-extraction.json').write_text(json.dumps({'decoded':len(rows),'skips':skips,'animation_acceptance':False,'notes':['Palette-bound graphics only. Entity part assembly and source-duration clips remain incomplete.']},indent=2))
        print('SOTN palette-bound graphics',len(rows),'skipped',len(skips),flush=True)
    finally:reader.close()

if __name__=='__main__':main()
