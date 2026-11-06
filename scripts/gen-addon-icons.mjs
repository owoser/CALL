#!/usr/bin/env node
/**
 * Generates the CALL tool icons (32x32 RGBA PNG) with no image libraries.
 *
 * Everything is drawn from primitives (disc / rect / line / ring) so the five icons share
 * one palette and one style, and so the art is reproducible from source instead of being a
 * binary blob nobody can edit.
 */
import { deflateSync } from 'node:zlib';
import { mkdirSync, writeFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const OUT = join(ROOT, 'assets', 'addon', 'CALL_Tools_RP', 'textures', 'items');
const S = 32;

const C = {
    none: [0, 0, 0, 0],
    metal: [176, 182, 190, 255],
    metalDark: [110, 116, 124, 255],
    metalLight: [222, 228, 235, 255],
    wood: [122, 78, 44, 255],
    woodLight: [164, 112, 66, 255],
    gold: [246, 200, 76, 255],
    goldDark: [188, 140, 30, 255],
    paper: [236, 240, 246, 255],
    paperLine: [120, 132, 148, 255],
    blue: [88, 160, 240, 255],
    blueDark: [40, 96, 168, 255],
    cyan: [110, 226, 226, 255],
    red: [226, 96, 96, 255],
    green: [110, 210, 120, 255],
    black: [24, 26, 30, 255],
};

function canvas() {
    return new Uint8Array(S * S * 4);
}
function px(buf, x, y, c) {
    if (x < 0 || y < 0 || x >= S || y >= S) return;
    const i = (y * S + x) * 4;
    buf[i] = c[0]; buf[i + 1] = c[1]; buf[i + 2] = c[2]; buf[i + 3] = c[3];
}
function rect(buf, x0, y0, w, h, c) {
    for (let y = y0; y < y0 + h; y++) for (let x = x0; x < x0 + w; x++) px(buf, x, y, c);
}
function frame(buf, x0, y0, w, h, c) {
    rect(buf, x0, y0, w, 1, c);
    rect(buf, x0, y0 + h - 1, w, 1, c);
    rect(buf, x0, y0, 1, h, c);
    rect(buf, x0 + w - 1, y0, 1, h, c);
}
function disc(buf, cx, cy, r, c, hollowR = -1) {
    for (let y = -r; y <= r; y++) {
        for (let x = -r; x <= r; x++) {
            const d = Math.sqrt(x * x + y * y);
            if (d > r + 0.4) continue;
            if (hollowR >= 0 && d < hollowR) continue;
            px(buf, Math.round(cx + x), Math.round(cy + y), c);
        }
    }
}
function line(buf, x0, y0, x1, y1, c, thick = 1) {
    const steps = Math.max(Math.abs(x1 - x0), Math.abs(y1 - y0));
    for (let i = 0; i <= steps; i++) {
        const t = steps === 0 ? 0 : i / steps;
        const x = Math.round(x0 + (x1 - x0) * t);
        const y = Math.round(y0 + (y1 - y0) * t);
        for (let dy = 0; dy < thick; dy++) for (let dx = 0; dx < thick; dx++) px(buf, x + dx, y + dy, c);
    }
}
function dashedFrame(buf, x0, y0, w, h, c, step = 3) {
    for (let x = x0; x < x0 + w; x++) if ((x - x0) % (step + 1) < step) { px(buf, x, y0, c); px(buf, x, y0 + h - 1, c); }
    for (let y = y0; y < y0 + h; y++) if ((y - y0) % (step + 1) < step) { px(buf, x0, y, c); px(buf, x0 + w - 1, y, c); }
}

/** A wooden wand handle running from the lower-left corner to the middle. */
function wand(buf) {
    line(buf, 5, 27, 20, 12, C.wood, 3);
    line(buf, 6, 26, 19, 13, C.woodLight, 1);
}

const icons = {
    'call_gear': (b) => {
        // 8 teeth around a metal ring
        for (let i = 0; i < 8; i++) {
            const a = (Math.PI * 2 * i) / 8;
            const cx = 16 + Math.cos(a) * 11;
            const cy = 16 + Math.sin(a) * 11;
            rect(b, Math.round(cx) - 2, Math.round(cy) - 2, 4, 4, C.metalDark);
        }
        disc(b, 16, 16, 11, C.metalDark);
        disc(b, 16, 16, 9, C.metal);
        disc(b, 16, 16, 5, C.none);
        disc(b, 16, 16, 4, C.metalDark);
        disc(b, 16, 16, 2, C.none);
        // highlight
        for (let i = 0; i < 6; i++) px(b, 11 + i, 8, C.metalLight);
    },
    'call_wand_select': (b) => {
        wand(b);
        // corner brackets around a small selection
        const c = C.gold;
        rect(b, 18, 5, 6, 1, c); rect(b, 18, 5, 1, 6, c);
        rect(b, 27, 5, 1, 6, c); rect(b, 22, 5 - 5 + 10, 6, 1, c);
        rect(b, 18, 10, 1, 1, c); rect(b, 27, 10, 1, 1, c);
        px(b, 23, 8, C.goldDark);
        px(b, 23, 9, C.goldDark);
    },
    'call_wand_copy': (b) => {
        wand(b);
        rect(b, 17, 6, 11, 13, C.paperLine);
        rect(b, 18, 7, 9, 11, C.paper);
        rect(b, 20, 15, 11, 13, C.paperLine);
        rect(b, 21, 16, 9, 11, C.paper);
        for (let i = 0; i < 4; i++) rect(b, 22, 18 + i * 2, 7, 1, C.paperLine);
    },
    'call_wand_paste': (b) => {
        wand(b);
        rect(b, 18, 5, 11, 15, C.blueDark);
        rect(b, 19, 6, 9, 13, C.blue);
        rect(b, 21, 3, 5, 3, C.paperLine);
        // down arrow = "paste here"
        line(b, 23, 9, 23, 17, C.paper, 2);
        line(b, 20, 14, 23, 18, C.paper, 2);
        line(b, 26, 14, 23, 18, C.paper, 2);
    },
    'call_wand_preview': (b) => {
        wand(b);
        dashedFrame(b, 15, 4, 14, 14, C.cyan);
        disc(b, 22, 11, 3, C.paper);
        disc(b, 22, 11, 1, C.black);
        px(b, 18, 7, C.paper);
    },
};

// ------------------------------------------------------------------ PNG writer
function crc32(buf) {
    let c, crc = 0xffffffff;
    for (let n = 0; n < buf.length; n++) {
        c = (crc ^ buf[n]) & 0xff;
        for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
        crc = (crc >>> 8) ^ c;
    }
    return (crc ^ 0xffffffff) >>> 0;
}
function chunk(type, data) {
    const len = Buffer.alloc(4);
    len.writeUInt32BE(data.length, 0);
    const body = Buffer.concat([Buffer.from(type, 'ascii'), data]);
    const crc = Buffer.alloc(4);
    crc.writeUInt32BE(crc32(body), 0);
    return Buffer.concat([len, body, crc]);
}
function encodePng(rgba) {
    const ihdr = Buffer.alloc(13);
    ihdr.writeUInt32BE(S, 0);
    ihdr.writeUInt32BE(S, 4);
    ihdr[8] = 8;   // bit depth
    ihdr[9] = 6;   // RGBA
    const raw = Buffer.alloc(S * (S * 4 + 1));
    for (let y = 0; y < S; y++) {
        raw[y * (S * 4 + 1)] = 0; // filter: none
        rgba.copy(raw, y * (S * 4 + 1) + 1, y * S * 4, (y + 1) * S * 4);
    }
    return Buffer.concat([
        Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
        chunk('IHDR', ihdr),
        chunk('IDAT', deflateSync(raw, { level: 9 })),
        chunk('IEND', Buffer.alloc(0)),
    ]);
}

mkdirSync(OUT, { recursive: true });
for (const [name, draw] of Object.entries(icons)) {
    const buf = canvas();
    draw(buf);
    const png = encodePng(Buffer.from(buf));
    writeFileSync(join(OUT, name + '.png'), png);
    console.log('icon ' + name.padEnd(20) + (png.length / 1024).toFixed(1) + ' KB');
}
console.log('icons written to ' + OUT);
