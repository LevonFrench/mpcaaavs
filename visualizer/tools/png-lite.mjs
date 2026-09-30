// Local reference decoding only. No image bytes or reconstructed pixels are ever exported by the generator.
import { inflateSync } from 'node:zlib';
export const IMAGE_LIMITS = Object.freeze({ bytes: 32 * 1024 * 1024, pixels: 16 * 1024 * 1024 });
function bounds(w, h) { if (!Number.isInteger(w) || !Number.isInteger(h) || w < 1 || h < 1 || w * h > IMAGE_LIMITS.pixels) throw Error('Image dimensions exceed local decoder limits'); }
export function sniffImage(bytes) {
  const b = Buffer.from(bytes); if (b.length > IMAGE_LIMITS.bytes) throw Error('Image byte limit');
  if (b.subarray(0, 8).equals(Buffer.from([137,80,78,71,13,10,26,10]))) return 'png';
  if (/^GIF8[79]a$/.test(b.subarray(0,6).toString('ascii'))) return 'gif';
  if (b[0] === 255 && b[1] === 216) return 'jpeg';
  if (b.subarray(0,4).toString() === 'RIFF' && b.subarray(8,12).toString() === 'WEBP') return 'webp';
  return 'unknown';
}
const paeth = (a,b,c) => { const p = a+b-c, x = Math.abs(p-a), y = Math.abs(p-b), z = Math.abs(p-c); return x <= y && x <= z ? a : y <= z ? b : c; };
function png(b) {
  let w,h,depth,type,interlace,palette,alpha; const chunks = []; let p = 8;
  while (p + 12 <= b.length) {
    const n = b.readUInt32BE(p), tag = b.subarray(p+4,p+8).toString(); if (n > b.length-p-12) throw Error('Truncated PNG');
    const data = b.subarray(p+8,p+8+n); p += n+12;
    if (tag === 'IHDR') { if (n !== 13) throw Error('Invalid PNG header'); w=data.readUInt32BE(0); h=data.readUInt32BE(4); depth=data[8]; type=data[9]; interlace=data[12]; if (data[10] || data[11]) throw Error('Unsupported PNG compression'); }
    else if (tag === 'PLTE') palette=data; else if (tag === 'tRNS') alpha=data; else if (tag === 'IDAT') chunks.push(data); else if (tag === 'IEND') break;
  }
  bounds(w,h); const channels=({0:1,2:3,3:1,4:2,6:4})[type];
  if (!channels || ![1,2,4,8,16].includes(depth) || (type !== 0 && type !== 3 && depth < 8) || (type === 3 && depth === 16) || interlace > 1) throw Error('Unsupported PNG format');
  const passes = interlace ? [[0,0,8,8],[4,0,8,8],[0,4,4,8],[2,0,4,4],[0,2,2,4],[1,0,2,2],[0,1,1,2]] : [[0,0,1,1]];
  const expected = passes.reduce((s,[x,y,dx,dy]) => s + (w>x && h>y ? (Math.ceil((w-x)/dx)*channels*depth+7>>3)+1 : 0)*Math.max(0,Math.ceil((h-y)/dy)),0);
  const raw=inflateSync(Buffer.concat(chunks),{maxOutputLength: expected}); if(raw.length!==expected) throw Error('Invalid PNG raster size');
  const rgba=new Uint8Array(w*h*4); let offset=0;
  for (const [sx,sy,dx,dy] of passes) {
    const pw=Math.max(0,Math.ceil((w-sx)/dx)), ph=Math.max(0,Math.ceil((h-sy)/dy)); if(!pw||!ph)continue;
    const rowBytes=Math.ceil(pw*channels*depth/8), stride=Math.max(1,Math.ceil(channels*depth/8)); let prev=new Uint8Array(rowBytes);
    for(let y=0;y<ph;y++) {
      const filter=raw[offset++], row=Uint8Array.from(raw.subarray(offset,offset+rowBytes)); offset+=rowBytes;
      if(filter>4)throw Error('Invalid PNG filter');
      for(let i=0;i<rowBytes;i++){const a=i>=stride?row[i-stride]:0,c=i>=stride?prev[i-stride]:0;row[i]=(row[i]+(filter===1?a:filter===2?prev[i]:filter===3?Math.floor((a+prev[i])/2):filter===4?paeth(a,prev[i],c):0))&255;}
      const sample=i=>depth===16?row[i*2]:depth===8?row[i]:(row[Math.floor(i*depth/8)]>>(8-depth-(i*depth%8)))&((1<<depth)-1);
      for(let x=0;x<pw;x++) {
        const i=x*channels, out=((sy+y*dy)*w+sx+x*dx)*4; let r,g,bl,a=255;
        if(type===3){const idx=sample(i);if(!palette||idx*3+2>=palette.length)throw Error('Invalid PNG palette');[r,g,bl]=palette.subarray(idx*3,idx*3+3);a=alpha?.[idx]??255;}
        else if(type===0||type===4){r=g=bl=Math.round(sample(i)*255/(depth<8?(1<<depth)-1:255)); if(type===4)a=sample(i+1);}
        else {[r,g,bl]=[sample(i),sample(i+1),sample(i+2)]; if(type===6)a=sample(i+3);}
        rgba.set([r,g,bl,a],out);
      } prev=row;
    }
  } return {width:w,height:h,sampleWidth:w,sampleHeight:h,rgba,format:'png',quality:'full'};
}
function gif(b) {
  const w=b.readUInt16LE(6),h=b.readUInt16LE(8); bounds(w,h); let p=13, palette;
  if(b[10]&128){const n=3*(2<<(b[10]&7));palette=b.subarray(p,p+n);p+=n;}
  let transparent=-1; const blocks=()=>{const chunks=[];while(p<b.length){const n=b[p++];if(!n)break;if(p+n>b.length)throw Error('Truncated GIF');chunks.push(b.subarray(p,p+n));p+=n;}return Buffer.concat(chunks);};
  while(p<b.length){const marker=b[p++];if(marker===0x21){const label=b[p++];const data=blocks();if(label===0xf9&&data.length>=4&&data[0]&1)transparent=data[3];continue;}if(marker===0x3b)break;if(marker!==0x2c)throw Error('Invalid GIF block');
    const x=b.readUInt16LE(p),y=b.readUInt16LE(p+2),iw=b.readUInt16LE(p+4),ih=b.readUInt16LE(p+6), flags=b[p+8];p+=9;if(!iw||!ih||x+iw>w||y+ih>h)throw Error('Invalid GIF rectangle');
    if(flags&128){const n=3*(2<<(flags&7));palette=b.subarray(p,p+n);p+=n;}if(!palette)throw Error('Missing GIF palette');
    const min=b[p++];if(min<2||min>8)throw Error('Invalid GIF code size');const data=blocks(),clear=1<<min,end=clear+1;let bits=0,size=min+1,next=end+1,dict=[],prev=null;
    const reset=()=>{dict=Array.from({length:clear},(_,i)=>[i]);size=min+1;next=end+1;prev=null;};reset();const indices=[];
    const code=()=>{if(bits+size>data.length*8)throw Error('Truncated GIF codes');let n=0;for(let i=0;i<size;i++)n|=((data[(bits+i)>>3]>>((bits+i)&7))&1)<<i;bits+=size;return n;};
    while(indices.length<iw*ih){const c=code();if(c===clear){reset();continue;}if(c===end)break;const value=dict[c]??(c===next&&prev?[...prev,prev[0]]:null);if(!value)throw Error('Invalid GIF dictionary');indices.push(...value);if(prev&&next<4096){dict[next++]=[...prev,value[0]];if(next===(1<<size)&&size<12)size++;}prev=value;}
    if(indices.length!==iw*ih)throw Error('Incomplete GIF raster');const rows=flags&64?[...Array.from({length:Math.ceil(ih/8)},(_,i)=>i*8),...Array.from({length:Math.ceil((ih-4)/8)},(_,i)=>4+i*8),...Array.from({length:Math.ceil((ih-2)/4)},(_,i)=>2+i*4),...Array.from({length:Math.ceil((ih-1)/2)},(_,i)=>1+i*2)]:Array.from({length:ih},(_,i)=>i);
    const rgba=new Uint8Array(w*h*4);for(let ry=0;ry<ih;ry++)for(let rx=0;rx<iw;rx++){const idx=indices[ry*iw+rx],q=idx*3;if(q+2>=palette.length)throw Error('Invalid GIF palette index');rgba.set([...palette.subarray(q,q+3),idx===transparent?0:255],((y+rows[ry])*w+x+rx)*4);}
    return {width:w,height:h,sampleWidth:w,sampleHeight:h,rgba,format:'gif',quality:'first-frame'};
  }throw Error('GIF has no image');
}
// JPEG-lite reads baseline Huffman coefficients and reconstructs each block's DC colour.
// This is an explicitly coarse 1/8 thumbnail for palette/layout analysis, not an export decoder.
function jpeg(b) {
  let p=2,frame,scan,entropyStart,interval=0;const quant=new Map(),huffs=new Map();
  while(p<b.length){if(b[p++]!==255)throw Error('Invalid JPEG marker');while(b[p]===255)p++;const marker=b[p++];if(marker===217)break;if(marker===216||(marker>=208&&marker<=215))continue;const n=b.readUInt16BE(p);if(n<2||p+n>b.length)throw Error('Truncated JPEG');const d=b.subarray(p+2,p+n);p+=n;
    if(marker===0xdb){let q=0;while(q<d.length){const spec=d[q++],wide=spec>>4,id=spec&15;quant.set(id,wide?d.readUInt16BE(q):d[q]);q+=64*(wide?2:1);}}
    else if(marker===0xc4){let q=0;while(q<d.length){const id=d[q++],counts=[...d.subarray(q,q+16)];q+=16;let c=0;const table=new Map();for(let len=1;len<=16;len++){for(let k=0;k<counts[len-1];k++)table.set(`${len}:${c++}`,d[q++]);c<<=1;}huffs.set(id,table);}}
    else if(marker===0xc0){const h=d.readUInt16BE(1),w=d.readUInt16BE(3);bounds(w,h);if(d[0]!==8)throw Error('Unsupported JPEG depth');const components=[];for(let i=0;i<d[5];i++){const a=6+i*3;components.push({id:d[a],h:d[a+1]>>4,v:d[a+1]&15,q:d[a+2],dc:0});}frame={w,h,components};}
    else if([0xc1,0xc2,0xc3,0xc9,0xca,0xcb].includes(marker))throw Error('JPEG-lite supports baseline JPEG only');
    else if(marker===0xdd)interval=d.readUInt16BE(0);
    else if(marker===0xda){scan=[];for(let i=0;i<d[0];i++)scan.push({id:d[1+i*2],dc:d[2+i*2]>>4,ac:d[2+i*2]&15});if(d.at(-3)!==0||d.at(-2)!==63||d.at(-1)!==0)throw Error('Unsupported JPEG scan');entropyStart=p;break;}
  }
  if(!frame||!scan||scan.length!==frame.components.length||![1,3].includes(scan.length))throw Error('Unsupported JPEG components');
  const {w,h,components}=frame,maxH=Math.max(...components.map(c=>c.h)),maxV=Math.max(...components.map(c=>c.v));if(maxH>4||maxV>4||components.some(c=>!c.h||!c.v||!quant.has(c.q)))throw Error('Invalid JPEG sampling');
  let pos=entropyStart,byte=0,remaining=0;
  const bit=()=>{if(!remaining){byte=b[pos++];if(byte===255){const n=b[pos++];if(n!==0)throw Error('Unexpected JPEG entropy marker');}if(pos>b.length)throw Error('Truncated JPEG entropy');remaining=8;}return (byte>>--remaining)&1;};
  const bits=n=>{let value=0;while(n--)value=value*2+bit();return value;};
  const symbol=id=>{const t=huffs.get(id);if(!t)throw Error('Missing JPEG Huffman table');let v=0;for(let len=1;len<=16;len++){v=v*2+bit();const s=t.get(`${len}:${v}`);if(s!==undefined)return s;}throw Error('Invalid JPEG Huffman code');};
  const signed=n=>{const v=bits(n);return n&&v<(1<<(n-1))?v-((1<<n)-1):v;};
  const sw=Math.ceil(w/8),sh=Math.ceil(h/8),rgba=new Uint8Array(sw*sh*4),mx=Math.ceil(w/(8*maxH)),my=Math.ceil(h/(8*maxV));let mcu=0;
  for(let y=0;y<my;y++)for(let x=0;x<mx;x++){
    if(interval&&mcu&&mcu%interval===0){remaining=0;if(b[pos++]!==255||b[pos]<208||b[pos]>215)throw Error('Missing JPEG restart');pos++;for(const c of components)c.dc=0;}
    const blocks=[];for(const spec of scan){const c=components.find(c=>c.id===spec.id);if(!c)throw Error('Invalid JPEG component');const out=[];for(let by=0;by<c.v;by++)for(let bx=0;bx<c.h;bx++){const n=symbol(spec.dc);if(n>11)throw Error('Invalid JPEG DC');c.dc+=signed(n);out.push(Math.max(0,Math.min(255,c.dc*quant.get(c.q)/8+128)));for(let k=1;k<64;){const ac=symbol(16+spec.ac),run=ac>>4,size=ac&15;if(!size){if(!run)break;if(run!==15)throw Error('Invalid JPEG AC');k+=16;}else{k+=run+1;if(size>10||k>64)throw Error('Invalid JPEG coefficient');bits(size);}}}blocks.push({c,out});}
    for(let by=0;by<maxV;by++)for(let bx=0;bx<maxH;bx++){const xx=x*maxH+bx,yy=y*maxV+by;if(xx>=sw||yy>=sh)continue;const vals=blocks.map(({c,out})=>out[Math.floor(by*c.v/maxV)*c.h+Math.floor(bx*c.h/maxH)]);let [r,g,bl]=[vals[0],vals[0],vals[0]];if(vals.length===3){const cb=vals[1]-128,cr=vals[2]-128;r+=1.402*cr;g-=.344136*cb+.714136*cr;bl+=1.772*cb;}rgba.set([r,g,bl].map(v=>Math.max(0,Math.min(255,Math.round(v)))).concat(255),(yy*sw+xx)*4);}mcu++;
  }return {width:w,height:h,sampleWidth:sw,sampleHeight:sh,rgba,format:'jpeg',quality:'dc-thumbnail'};
}
export function decodeImage(bytes) { const b=Buffer.from(bytes),format=sniffImage(b);if(format==='png')return png(b);if(format==='gif')return gif(b);if(format==='jpeg')return jpeg(b);throw Error(`Unsupported local image format: ${format}`); }
