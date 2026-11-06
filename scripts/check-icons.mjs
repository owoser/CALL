
import fs from 'node:fs';
import { inflateSync } from 'node:zlib';
import path from 'node:path';

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
  return { w, h, raw };
}

const dir = 'assets/addon/CALL_Tools_RP/textures/items';
for (const f of fs.readdirSync(dir).sort()) {
  const { w, h, raw } = decodePng(fs.readFileSync(path.join(dir, f)));
  const stride = w * 4 + 1;
  let opaque = 0, total = w * h;
  let minX = w, maxX = -1, minY = h, maxY = -1;
  for (let y = 0; y < h; y++) {
    for (let x = 0; x < w; x++) {
      const a = raw[y * stride + 1 + x * 4 + 3];
      if (a > 16) {
        opaque++;
        if (x < minX) minX = x; if (x > maxX) maxX = x;
        if (y < minY) minY = y; if (y > maxY) maxY = y;
      }
    }
  }
  const pct = ((opaque / total) * 100).toFixed(0);
  console.log(f.padEnd(24) + w + 'x' + h + '  opaque ' + String(pct).padStart(3) + '%  bbox ' +
    minX + ',' + minY + ' -> ' + maxX + ',' + maxY);
}
