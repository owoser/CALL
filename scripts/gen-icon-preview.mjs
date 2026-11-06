import { writeFileSync, mkdirSync, readFileSync } from 'node:fs';
import { deflateSync, inflateSync } from 'node:zlib';
import { join } from 'node:path';
const ROOT = process.cwd();
const SRC = join(ROOT, 'assets', 'addon', 'CALL_Tools_RP', 'textures', 'items');
const SCALE = 6, PAD = 4, S = 32;
function decodePng(buf) {
  let p = 8, w = 0, h = 0; const idat = [];
  while (p < buf.length) {
    const len = buf.readUInt32BE(p);
    const type = buf.toString('ascii', p + 4, p + 8);
    const data = buf.subarray(p + 8, p + 8 + len);
    if (type === 'IHDR') { w = data.readUInt32BE(0); h = data.readUInt32BE(4); }
    if (type === 'IDAT') idat.push(data);
    p += 12 + len;
  }
  const raw = inflateSync(Buffer.concat(idat));
  const out = Buffer.alloc(w * h * 4);
  const stride = w * 4 + 1;
  for (let y = 0; y < h; y++) raw.copy(out, y * w * 4, y * stride + 1, y * stride + 1 + w * 4);
  return out;
}
function crc32(buf){let c,crc=0xffffffff;for(let n=0;n<buf.length;n++){c=(crc^buf[n])&0xff;for(let k=0;k<8;k++)c=c&1?0xedb88320^(c>>>1):c>>>1;crc=(crc>>>8)^c;}return (crc^0xffffffff)>>>0;}
function chunk(type,data){const len=Buffer.alloc(4);len.writeUInt32BE(data.length,0);const body=Buffer.concat([Buffer.from(type,'ascii'),data]);const crc=Buffer.alloc(4);crc.writeUInt32BE(crc32(body),0);return Buffer.concat([len,body,crc]);}
function encode(w,h,rgba){const ihdr=Buffer.alloc(13);ihdr.writeUInt32BE(w,0);ihdr.writeUInt32BE(h,4);ihdr[8]=8;ihdr[9]=6;const raw=Buffer.alloc(w*(h*4+1));for(let y=0;y<h;y++){raw[y*(w*4+1)]=0;rgba.copy(raw,y*(w*4+1)+1,y*w*4,(y+1)*w*4);}return Buffer.concat([Buffer.from([0x89,0x50,0x4e,0x47,0x0d,0x0a,0x1a,0x0a]),chunk('IHDR',ihdr),chunk('IDAT',deflateSync(raw,{level:9})),chunk('IEND',Buffer.alloc(0))]);}
const names = ['call_gear','call_wand_select','call_wand_copy','call_wand_paste','call_wand_preview'];
const cell = S * SCALE + PAD * 2;
const W = cell * names.length, H = cell;
const sheet = Buffer.alloc(W * H * 4);
for (let i = 0; i < W * H; i++) { sheet[i*4]=40; sheet[i*4+1]=44; sheet[i*4+2]=52; sheet[i*4+3]=255; }
names.forEach((n, k) => {
  const d = decodePng(readFileSync(join(SRC, n + '.png')));
  for (let y = 0; y < S * SCALE; y++) for (let x = 0; x < S * SCALE; x++) {
    const sx = Math.floor(x / SCALE), sy = Math.floor(y / SCALE);
    const si = (sy * S + sx) * 4;
    const a = d[si + 3] / 255;
    if (a === 0) continue;
    const dx = k * cell + PAD + x, dy = PAD + y, di = (dy * W + dx) * 4;
    sheet[di] = Math.round(d[si]*a + sheet[di]*(1-a));
    sheet[di+1] = Math.round(d[si+1]*a + sheet[di+1]*(1-a));
    sheet[di+2] = Math.round(d[si+2]*a + sheet[di+2]*(1-a));
    sheet[di+3] = 255;
  }
});
mkdirSync(join(ROOT,'dist'), { recursive: true });
writeFileSync(join(ROOT,'dist','icons-preview.png'), encode(W, H, sheet));
console.log('preview: dist/icons-preview.png ' + W + 'x' + H);
