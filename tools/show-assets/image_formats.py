"""Conservative image decoders from public format descriptions.

References: PuyoTools PVR wiki, arc_unpacker GIM layout, NitroSystem formats,
Dolphin texture layouts. Unsupported layouts raise; no substitute palettes.
Images remain provisional until a caller visually validates a game sample.
"""
import struct
import io
from pathlib import Path
import numpy as np
from PIL import Image
from psx_extract import rgb555

LIMIT=64*1024**2

def cut(data,start,size):
    if start<0 or size<0 or start+size>len(data):raise ValueError('truncated image extent')
    return data[start:start+size]

def dims(w,h):
    if not 1<=w<=4096 or not 1<=h<=4096 or w*h>4*1024**2:raise ValueError('invalid image dimensions')

def expand(v,bits):return (v*255//((1<<bits)-1)).astype(np.uint8)

def packed16(data,kind,endian='<'):
    v=np.frombuffer(data,dtype=endian+'u2').astype(np.uint32)
    if kind=='psx':return np.array([rgb555(int(c)) for c in v],dtype=np.uint8)
    if kind in ('rgb565','bgr565'):
        r,g,b=expand((v>>11)&31,5),expand((v>>5)&63,6),expand(v&31,5)
        if kind=='bgr565':r,b=b,r
        a=np.full(len(v),255,dtype=np.uint8)
    elif kind=='argb1555':r,g,b,a=expand((v>>10)&31,5),expand((v>>5)&31,5),expand(v&31,5),expand(v>>15,1)
    elif kind=='rgba5551':r,g,b,a=expand(v&31,5),expand((v>>5)&31,5),expand((v>>10)&31,5),expand(v>>15,1)
    elif kind=='argb4444':r,g,b,a=expand((v>>8)&15,4),expand((v>>4)&15,4),expand(v&15,4),expand(v>>12,4)
    elif kind=='rgba4444':r,g,b,a=expand(v&15,4),expand((v>>4)&15,4),expand((v>>8)&15,4),expand(v>>12,4)
    elif kind=='rgb5a3':
        opaque=(v&0x8000)!=0
        r=np.where(opaque,expand((v>>10)&31,5),expand((v>>8)&15,4))
        g=np.where(opaque,expand((v>>5)&31,5),expand((v>>4)&15,4))
        b=np.where(opaque,expand(v&31,5),expand(v&15,4))
        a=np.where(opaque,255,expand((v>>12)&7,3)).astype(np.uint8)
    else:raise ValueError('unsupported 16-bit pixels')
    return np.stack((r,g,b,a),axis=1)

def indices(data,bpp):
    a=np.frombuffer(data,dtype=np.uint8)
    return np.stack((a&15,a>>4),axis=1).ravel() if bpp==4 else a

def tim2(buf,off):
    version,alignment,count=struct.unpack_from('<BBH',buf,off+4)
    if version not in (3,4) or alignment not in (0,1) or not 1<=count<=1024:raise ValueError('invalid TIM2 header')
    p=off+(128 if alignment else 16);result=[]
    for i in range(count):
        total,clutsize,imgsize,hs,ncolors,fmt,mips,cluttype,imgtype,w,h=struct.unpack_from('<IIIHHBBBBHH',buf,p)
        dims(w,h)
        if total<hs+imgsize+clutsize or hs<48 or not 1<=mips<=16 or imgtype not in (1,2,3,4,5):raise ValueError('invalid TIM2 picture')
        cut(buf,p,total);data=cut(buf,p+hs,imgsize);pal=cut(buf,p+hs+imgsize,clutsize)
        bpp={1:16,2:24,3:32,4:4,5:8}[imgtype]
        base=cut(data,0,(w*h*bpp+7)//8)
        if bpp==16:rgba=packed16(base,'rgba5551')
        elif bpp in (24,32):
            rgba=np.frombuffer(base,dtype=np.uint8).reshape(-1,bpp//8)
            if bpp==24:rgba=np.column_stack((rgba,np.full(len(rgba),255,dtype=np.uint8)))
            else:rgba=rgba.copy();rgba[:,3]=np.minimum(rgba[:,3].astype(np.uint16)*2,255)
        else:
            pt=cluttype&7
            if pt==1:colors=packed16(pal,'rgba5551')
            elif pt in (2,3):
                colors=np.frombuffer(pal,dtype=np.uint8).reshape(-1,pt+1)
                if pt==2:colors=np.column_stack((colors,np.full(len(colors),255,dtype=np.uint8)))
                else:colors=colors.copy();colors[:,3]=np.minimum(colors[:,3].astype(np.uint16)*2,255)
            else:raise ValueError('unsupported TIM2 CLUT')
            if len(colors)<ncolors:raise ValueError('short TIM2 CLUT')
            if bpp==8 and not cluttype&128:
                if len(colors)%32:raise ValueError('incomplete swizzled CLUT')
                order=np.arange(len(colors)).reshape(-1,32).copy();order[:,8:16],order[:,16:24]=order[:,16:24].copy(),order[:,8:16].copy();colors=colors[order.ravel()]
            ids=indices(base,bpp)[:w*h]
            if int(ids.max())>=len(colors):raise ValueError('TIM2 palette index out of range')
            rgba=colors[ids]
        result.append((f'.pic{i}',Image.fromarray(rgba.reshape(h,w,4)),{'bpp':bpp,'width':w,'height':h,'mipmaps_ignored':max(0,mips-1)}));p+=total
    return result

def morton(x,y):
    result=np.zeros(np.broadcast(x,y).shape,dtype=np.int64)
    for bit in range(12):result|=((y>>bit)&1)<<(bit*2);result|=((x>>bit)&1)<<(bit*2+1)
    return result

def pvr(buf,off):
    length=struct.unpack_from('<I',buf,off+4)[0];data=cut(buf,off+16,length-8)
    pixel,layout=buf[off+8:off+10];w,h=struct.unpack_from('<HH',buf,off+12);dims(w,h)
    if pixel not in (0,1,2):raise ValueError('unsupported PVR pixels or missing external palette')
    kind=('argb1555','rgb565','argb4444')[pixel]
    if layout in (1,2,0xd,0x12):
        if w&(w-1) or h&(h-1):raise ValueError('non-power-of-two twiddled PVR')
        colors=packed16(data[-w*h*2:],kind)
        if len(colors)!=w*h:raise ValueError('short PVR image')
        y,x=np.indices((h,w));small=min(w,h)
        ids=morton(x%small,y%small)+(x//small+y//small)*small*small
        rgba=colors[ids]
    elif layout in (3,4,0x10,0x11):
        if w!=h or w<8 or w&(w-1):raise ValueError('invalid VQ dimensions')
        entries=1024
        if layout==0x10:entries=64 if w<=16 else 128 if w==32 else 512 if w==64 else 1024
        if layout==0x11:entries=64 if w<=16 else 256 if w==32 else 1024
        colors=packed16(cut(data,0,entries*2),kind).reshape(-1,4,4)
        ids=np.frombuffer(data[-w*h//4:],dtype=np.uint8);y,x=np.indices((h//2,w//2));blocks=ids[morton(x,y)]
        if int(blocks.max())>=len(colors):raise ValueError('VQ codebook index out of range')
        rgba=np.empty((h,w,4),dtype=np.uint8)
        for xx in range(2):
            for yy in range(2):rgba[yy::2,xx::2]=colors[blocks,xx*2+yy]
    elif layout in (9,0xb):rgba=packed16(cut(data,0,w*h*2),kind).reshape(h,w,4)
    else:raise ValueError('unsupported PVR layout '+str(layout))
    return [('',Image.fromarray(rgba),{'width':w,'height':h,'bpp':16,'layout':layout,'pixel_format':pixel})]

def gim(buf,off):
    end=off+16+struct.unpack_from('<I',buf,off+20)[0];cut(buf,off,end-off)
    p=off+0x30;chunks={}
    while p+16<=end:
        typ,unknown,size,nxt,body=struct.unpack_from('<HHIII',buf,p)
        if size<16 or p+size>end:raise ValueError('invalid GIM chunk')
        chunks[typ]=(p,size);p+=size
    if 4 not in chunks:raise ValueError('GIM bitmap missing')
    p,size=chunks[4];fmt,swizzle,w,h=struct.unpack_from('<HHHH',buf,p+0x14);dims(w,h)
    if fmt not in range(6) or swizzle not in (0,1):raise ValueError('unsupported GIM pixels')
    bpp=(16,16,16,32,4,8)[fmt];pw=(w+15)&~15;ph=(h+7)&~7
    stride=pw*bpp//8;start=p+16+struct.unpack_from('<I',buf,p+0x2c)[0]
    if start<p+16 or start+stride*ph>p+size:raise ValueError('GIM pixels outside block')
    data=np.frombuffer(cut(buf,start,stride*ph),dtype=np.uint8)
    if swizzle:
        y,x=np.indices((ph,stride));ids=((y//8)*(stride//16)+x//16)*128+(y%8)*16+x%16;data=data[ids].ravel()
    if fmt<3:rgba=packed16(data.tobytes(),('bgr565','rgba5551','rgba4444')[fmt])
    elif fmt==3:rgba=data.reshape(-1,4)
    else:
        if 5 not in chunks:raise ValueError('GIM palette missing')
        pp,ps=chunks[5];pf=struct.unpack_from('<H',buf,pp+0x14)[0];n=struct.unpack_from('<H',buf,pp+0x18)[0]
        if pf not in range(4):raise ValueError('unsupported GIM palette')
        pal=cut(buf,pp+0x50,n*(4 if pf==3 else 2))
        if pp+0x50+len(pal)>pp+ps:raise ValueError('GIM palette outside block')
        colors=np.frombuffer(pal,dtype=np.uint8).reshape(-1,4) if pf==3 else packed16(pal,('bgr565','rgba5551','rgba4444')[pf])
        ids=indices(data.tobytes(),bpp)
        if int(ids.max())>=len(colors):raise ValueError('GIM palette index out of range')
        rgba=colors[ids]
    return [('',Image.fromarray(rgba.reshape(ph,pw,4)[:h,:w]),{'width':w,'height':h,'bpp':bpp,'swizzle':swizzle})]

def gc_texture(data,offset,w,h,fmt,palette=None):
    dims(w,h)
    layout={0:(8,8,32),1:(8,4,32),2:(8,4,32),3:(4,4,32),4:(4,4,32),5:(4,4,32),6:(4,4,64),8:(8,8,32),9:(8,4,32),14:(8,8,32)}
    if fmt not in layout:raise ValueError('unsupported tiled texture '+str(fmt))
    bw,bh,bs=layout[fmt];tw,th=(w+bw-1)//bw,(h+bh-1)//bh
    raw=cut(data,offset,tw*th*bs);v=np.frombuffer(raw,dtype=np.uint8)
    if fmt==0:
        gray=np.stack((v>>4,v&15),axis=1).ravel()*17
        pixels=np.stack((gray,gray,gray,np.full(len(gray),255,dtype=np.uint8)),axis=1)
    elif fmt==1:pixels=np.stack((v,v,v,np.full(len(v),255,dtype=np.uint8)),axis=1)
    elif fmt==2:
        gray=(v&15)*17;pixels=np.stack((gray,gray,gray,(v>>4)*17),axis=1)
    elif fmt==3:
        a,gray=v[::2],v[1::2];pixels=np.stack((gray,gray,gray,a),axis=1)
    elif fmt in (4,5):pixels=packed16(raw,'rgb565' if fmt==4 else 'rgb5a3','>')
    elif fmt==6:
        blocks=v.reshape(-1,64)
        pixels=np.stack((blocks[:,1:32:2],blocks[:,32:64:2],blocks[:,33:64:2],blocks[:,0:32:2]),axis=2)
    elif fmt in (8,9):
        if palette is None:raise ValueError('TPL palette missing')
        ids=np.stack((v>>4,v&15),axis=1).ravel() if fmt==8 else v
        if int(ids.max())>=len(palette):raise ValueError('TPL palette index out of range')
        pixels=palette[ids]
    else:
        # Each 8x8 tile contains four row-major 4x4 CMPR subblocks.
        blocks=v.reshape(-1,8)
        colors=packed16(blocks[:,:4].copy().tobytes(),'rgb565','>').astype(np.int16).reshape(-1,2,4)
        c0=blocks[:,0].astype(np.uint16)*256+blocks[:,1];c1=blocks[:,2].astype(np.uint16)*256+blocks[:,3]
        opaque=c0>c1
        c2=np.where(opaque[:,None],(2*colors[:,0]+colors[:,1])//3,(colors[:,0]+colors[:,1])//2)
        c3=np.where(opaque[:,None],(colors[:,0]+2*colors[:,1])//3,0)
        colors=np.stack((colors[:,0],colors[:,1],c2,c3),axis=1).astype(np.uint8)
        ids=(blocks[:,4:,None]>>np.array([6,4,2,0],dtype=np.uint8))&3
        sub=colors[np.arange(len(blocks))[:,None,None],ids]
        pixels=sub.reshape(-1,2,2,4,4,4).transpose(0,1,3,2,4,5).reshape(-1,8,8,4)
    rgba=pixels.reshape(th,tw,bh,bw,4).transpose(0,2,1,3,4).reshape(th*bh,tw*bw,4)
    return Image.fromarray(rgba[:h,:w])

def tpl(buf,off):
    count,table=struct.unpack_from('>II',buf,off+4)
    if not 1<=count<=4096:raise ValueError('invalid TPL texture count')
    cut(buf,off+table,count*8);result=[]
    for i in range(count):
        ih,ph=struct.unpack_from('>II',buf,off+table+i*8);h,w,fmt,pixels=struct.unpack_from('>HHII',buf,off+ih);palette=None
        if ph:
            n=struct.unpack_from('>H',buf,off+ph)[0];pf,po=struct.unpack_from('>II',buf,off+ph+4);raw=cut(buf,off+po,n*2)
            if pf==0:
                v=np.frombuffer(raw,dtype=np.uint8);a,gray=v[::2],v[1::2];palette=np.stack((gray,gray,gray,a),axis=1)
            elif pf in (1,2):palette=packed16(raw,'rgb565' if pf==1 else 'rgb5a3','>')
            else:raise ValueError('unsupported TPL palette')
        im=gc_texture(buf,off+pixels,w,h,fmt,palette);result.append((f'.tex{i}',im,{'width':w,'height':h,'texture_format':fmt}))
    return result

def bti(buf):
    fmt=buf[0];w,h=struct.unpack_from('>HH',buf,2);pal=None
    if buf[8]:
        pf=buf[9];n=struct.unpack_from('>H',buf,10)[0];po=struct.unpack_from('>I',buf,12)[0];raw=cut(buf,po,n*2)
        if pf in (1,2):pal=packed16(raw,'rgb565' if pf==1 else 'rgb5a3','>')
        elif pf==0:
            v=np.frombuffer(raw,dtype=np.uint8);gray=v[1::2];pal=np.stack((gray,gray,gray,v[::2]),axis=1)
        else:raise ValueError('unsupported BTI palette')
    offset=struct.unpack_from('>I',buf,28)[0]
    return gc_texture(buf,offset,w,h,fmt,pal),{'width':w,'height':h,'texture_format':fmt}

def raster(buf,off,fmt):
    if fmt=='png':
        p=off+8
        while True:
            n=struct.unpack_from('>I',buf,p)[0];kind=cut(buf,p+4,4);cut(buf,p,n+12);p+=n+12
            if p-off>LIMIT:raise ValueError('PNG exceeds size limit')
            if kind==b'IEND':break
        encoded=buf[off:p]
    elif fmt=='bmp':
        size=struct.unpack_from('<I',buf,off+2)[0]
        if not 26<=size<=LIMIT:raise ValueError('invalid BMP size')
        header=struct.unpack_from('<I',buf,off+14)[0]
        if header not in (12,40,52,56,64,108,124):raise ValueError('invalid BMP DIB header')
        if header==12:w,h,planes,bpp=struct.unpack_from('<4H',buf,off+18)
        else:w,h,planes,bpp=struct.unpack_from('<iiHH',buf,off+18)
        if planes!=1 or bpp not in (1,4,8,16,24,32):raise ValueError('invalid BMP pixels')
        dims(abs(w),abs(h));encoded=cut(buf,off,size)
    else:
        end=buf.find(b'\xff\xd9',off+2)
        if end<0 or end-off>LIMIT:raise ValueError('JPEG terminator missing')
        encoded=buf[off:end+2]
    with Image.open(io.BytesIO(encoded)) as im:
        dims(*im.size);im.load();return im.convert('RGBA'),{'width':im.width,'height':im.height}

def unlz(data):
    if data[:1] in (b'\x24',b'\x28'):return unhuffman(data)
    if data[:1]==b'\x30':return unrle(data)
    if not data or data[0] not in (0x10,0x11):return data
    total=int.from_bytes(data[1:4],'little');p=4
    if not total and data[0]==0x11:total=int.from_bytes(data[4:8],'little');p=8
    if not 0<total<=LIMIT:raise ValueError('invalid Nintendo LZ expansion size')
    out=bytearray()
    while len(out)<total:
        flags=cut(data,p,1)[0];p+=1
        for bit in range(7,-1,-1):
            if len(out)>=total:break
            if not flags&(1<<bit):out.extend(cut(data,p,1));p+=1;continue
            a,b=cut(data,p,2);p+=2
            if data[0]==0x10:n=(a>>4)+3;back=((a&15)<<8|b)+1
            elif a>>4==0:
                c=cut(data,p,1)[0];p+=1;n=((a&15)<<4|(b>>4))+0x11;back=((b&15)<<8|c)+1
            elif a>>4==1:
                c,d=cut(data,p,2);p+=2;n=((a&15)<<12|b<<4|c>>4)+0x111;back=((c&15)<<8|d)+1
            else:n=(a>>4)+1;back=((a&15)<<8|b)+1
            if back>len(out):raise ValueError('invalid Nintendo LZ backreference')
            for _ in range(min(n,total-len(out))):out.append(out[-back])
    return bytes(out)

def unrle(data):
    """Nintendo BIOS RL stream: high-bit repeat, otherwise literal runs."""
    cut(data,0,4)
    if data[0]!=0x30:raise ValueError('invalid Nintendo RL header')
    total=int.from_bytes(data[1:4],'little')
    if not 0<total<=LIMIT:raise ValueError('invalid Nintendo RL expansion size')
    out=bytearray();p=4
    while len(out)<total:
        flag=cut(data,p,1)[0];p+=1
        count=(flag&127)+(3 if flag&128 else 1)
        if len(out)+count>total:raise ValueError('Nintendo RL run exceeds declared extent')
        if flag&128:
            value=cut(data,p,1);p+=1;out.extend(value*count)
        else:out.extend(cut(data,p,count));p+=count
    return bytes(out)

def unhuffman(data):
    """Nintendo BIOS Huffman stream, 4/8-bit symbols; bounded tree traversal."""
    cut(data,0,6);bits=data[0]&15
    if data[0] not in (0x24,0x28):raise ValueError('unsupported Nintendo Huffman header')
    total=int.from_bytes(data[1:4],'little')
    if not 0<total<=LIMIT:raise ValueError('invalid Huffman expansion size')
    end=4+(data[4]+1)*2
    cut(data,4,end-4);p=end;root=5;node=root;out=bytearray();word=0;remaining=0;low=None;depth=0
    while len(out)<total:
        if not remaining:word=struct.unpack('<I',cut(data,p,4))[0];p+=4;remaining=32
        bit=(word>>31)&1;word=(word<<1)&0xffffffff;remaining-=1
        entry=data[node];child=(node&~1)+(entry&63)*2+2+bit
        if not root<=child<end:raise ValueError('Huffman child outside tree')
        if entry&(0x80>>bit):
            symbol=data[child]
            if bits==8:out.append(symbol)
            else:
                if symbol>15:raise ValueError('Huffman nibble outside range')
                if low is None:low=symbol
                else:out.append(low|(symbol<<4));low=None
            node=root;depth=0
        else:
            node=child;depth+=1
            if depth>256:raise ValueError('Huffman tree exceeds depth bound')
    return bytes(out)

def nitro_block(data,magic,block):
    off=data.find(magic)
    if off<0:return None
    cut(data,off,16)
    bom,ver,total,hs,count=struct.unpack_from('<HHIHH',data,off+4)
    if bom!=0xfeff or hs!=16 or total<16 or not 1<=count<=32:raise ValueError('invalid Nitro header')
    cut(data,off,total);p=off+hs
    for _ in range(count):
        if p+8>off+total:raise ValueError('truncated Nitro block header')
        size=struct.unpack_from('<I',data,p+4)[0]
        if size<8 or p+size>off+total:raise ValueError('invalid Nitro block')
        if data[p:p+4]==block:return cut(data,p+8,size-8)
        p+=size

def nitro_palette(data):
    block=nitro_block(data,b'RLCN',b'TTLP')
    if block is None:return None
    cut(block,0,16)
    size,off=struct.unpack_from('<II',block,8)
    if off<16 or off>len(block):raise ValueError('invalid Nitro palette offset')
    available=len(block)-off
    # Some native NCLR writers store 0x200 minus the actual byte count.
    if size!=available and size<=512 and 512-size==available:size=available
    if not size or size%2:raise ValueError('invalid Nitro palette size')
    colors=packed16(cut(block,off,size),'psx')
    # DS OBJ transparency belongs to index zero, not every black color word.
    colors[:,3]=255
    return colors

def nitro_graphics(data,pal,columns=16):
    block=nitro_block(data,b'RGCN',b'RAHC')
    if block is None:return []
    h,w,fmt=struct.unpack_from('<HHI',block);mapping,layout,size,off=struct.unpack_from('<IIII',block,8)
    if fmt not in (3,4) or layout not in (0,1):raise ValueError('unsupported Nitro graphics layout')
    bpp=4 if fmt==3 else 8;raw=cut(block,off,size);ids=indices(raw,bpp)
    if pal is None:raise ValueError('no unambiguous sibling NCLR palette')
    if w==0xffff or h==0xffff:w=columns;h=(len(ids)//64+w-1)//w
    dims(w*8,h*8)
    if len(ids)<w*h*64:raise ValueError('Nitro tile count/dimensions disagree')
    ids=ids[:w*h*64].reshape(h,w,8,8).transpose(0,2,1,3).reshape(h*8,w*8) if layout==0 else ids[:w*h*64].reshape(h*8,w*8)
    result=[];n=16 if bpp==4 else 256
    for i in range(len(pal)//n):
        colors=pal[i*n:(i+1)*n].copy();colors[0,3]=0
        if int(ids.max())>=len(colors):raise ValueError('Nitro palette too short')
        result.append((f'.pal{i}',Image.fromarray(colors[ids]),{'width':w*8,'height':h*8,'bpp':bpp,'palette':i,'assembled_cells':False}))
    return result

def narc_files(data):
    if data[:4]!=b'NARC':return []
    bom,ver,total,hs,count=struct.unpack_from('<HHIHH',data,4)
    if hs!=16 or count>16 or total>len(data):raise ValueError('invalid NARC header')
    chunks={};p=hs
    for _ in range(count):
        size=struct.unpack_from('<I',data,p+4)[0]
        if size<8 or p+size>total:raise ValueError('invalid NARC chunk')
        chunks[data[p:p+4]]=cut(data,p+8,size-8);p+=size
    fat=chunks[b'BTAF'];blob=chunks[b'GMIF'];n=struct.unpack_from('<H',fat)[0]
    if n*8+4>len(fat):raise ValueError('short NARC allocation table')
    return [(str(i),unlz(cut(blob,a,b-a))) for i in range(n) for a,b in [struct.unpack_from('<II',fat,4+i*8)]]

def scan_images(name,data,failures,palette=None):
    result=[]
    if data[:1] in (b'\x10',b'\x11',b'\x24',b'\x28',b'\x30') and data[:4]!=b'\x10\0\0\0':
        try:data=unlz(data)
        except (ValueError,IndexError):pass
    if data[:4]==b'NARC':
        try:
            members=narc_files(data);pals=[]
            for _,member in members:
                pal=nitro_palette(member)
                if pal is not None:pals.append(pal)
            bymagic={magic:[m for _,m in members if m[:4]==magic] for magic in (b'RGCN',b'RLCN',b'RECN',b'RNAN')}
            if all(len(bymagic[m])==1 for m in (b'RGCN',b'RLCN',b'RECN')):
                try:
                    from nitro_cells import assemble
                    cells,bank=assemble(bymagic[b'RGCN'][0],bymagic[b'RLCN'][0],bymagic[b'RECN'][0],bymagic[b'RNAN'][0] if len(bymagic[b'RNAN'])==1 else None)
                    for i,(im,info) in enumerate(cells):result.append(('nitro-cells',0,f'.cell{i}',im,{**info,'animation_bank':bank}))
                except (ValueError,IndexError,struct.error) as e:failures.append({'file':name,'format':'nitro-cells','reason':str(e)})
            for n,member in members:
                for fmt,off,suffix,im,info in scan_images(name+'#'+n,member,failures,pals[0] if len(pals)==1 else None):
                    result.append((fmt,0,'.member'+n+suffix,im,{**info,'archive_member':n,'member_offset':off}))
        except (ValueError,IndexError,struct.error,KeyError) as e:failures.append({'file':name,'format':'narc','reason':str(e)})
        return result
    if Path(name).suffix.lower()=='.bti':
        try:
            im,info=bti(data);result.append(('bti',0,'',im,info))
        except (ValueError,IndexError,struct.error) as e:failures.append({'file':name,'format':'bti','reason':str(e)})
    for magic,fmt in ((b'\x89PNG\r\n\x1a\n','png'),(b'BM','bmp'),(b'\xff\xd8\xff','jpeg')):
        p=0
        while True:
            p=data.find(magic,p)
            if p<0:break
            off=p;p+=len(magic)
            if off%4:continue
            try:
                im,info=raster(data,off,fmt);result.append((fmt,off,'',im,info))
            except (ValueError,OSError,IndexError,struct.error):pass
    for magic,fmt,decoder in ((b'TIM2','tim2',tim2),(b'PVRT','pvr',pvr),(b'MIG.00.1PSP\0','gim',gim),(b'\x00\x20\xaf\x30','tpl',tpl)):
        p=0
        while True:
            p=data.find(magic,p)
            if p<0:break
            off=p;p+=4
            if off%4:continue
            try:
                for suffix,im,info in decoder(data,off):result.append((fmt,off,suffix,im,info))
            except (ValueError,IndexError,struct.error) as e:failures.append({'file':name,'format':fmt,'offset':off,'reason':str(e)})
    if b'RGCN' in data:
        try:
            for suffix,im,info in nitro_graphics(data,palette):result.append(('nitro',0,suffix,im,info))
        except (ValueError,IndexError,struct.error) as e:failures.append({'file':name,'format':'nitro','reason':str(e)})
    return result
