#!/usr/bin/env node
/**
 * Minimal, dependency-free ZIP writer.
 *
 * Gulp was replaced by plain Node so the build does not depend on a toolchain that
 * no longer installs on modern Node. There is no stdlib zip writer, so this module
 * implements the small subset of the format we need (deflate or stored entries,
 * no zip64, no encryption, UTF-8 names).
 *
 * Output is byte-for-byte reproducible: entry order is sorted and the DOS
 * timestamp is fixed.
 */
import { createWriteStream } from 'node:fs';
import { readFile, stat } from 'node:fs/promises';
import { deflateRawSync } from 'node:zlib';

/** DOS timestamp for 1980-01-01 00:00:00 — keeps archives reproducible. */
const DOS_TIME = 0;
const DOS_DATE = (0 << 9) | (1 << 5) | 1;

const CRC_TABLE = (() => {
  const table = new Int32Array(256);
  for (let i = 0; i < 256; i++) {
    let c = i;
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    table[i] = c;
  }
  return table;
})();

function crc32(buf) {
  let c = -1;
  for (let i = 0; i < buf.length; i++) c = CRC_TABLE[(c ^ buf[i]) & 0xff] ^ (c >>> 8);
  return (c ^ -1) >>> 0;
}

function u16(n) {
  const b = Buffer.allocUnsafe(2);
  b.writeUInt16LE(n >>> 0, 0);
  return b;
}

function u32(n) {
  const b = Buffer.allocUnsafe(4);
  b.writeUInt32LE(n >>> 0, 0);
  return b;
}

/**
 * @param {string} zipPath
 * @param {Array<{name: string, data: Buffer} | {name: string, sourcePath: string}>} entries
 *   `name` is the path inside the archive and must use forward slashes.
 */
export async function createZip(zipPath, entries) {
  const sorted = [...entries].sort((a, b) => (a.name < b.name ? -1 : a.name > b.name ? 1 : 0));

  const chunks = [];      // local file records
  const central = [];     // central directory records
  let offset = 0;

  for (const entry of sorted) {
    const name = entry.name.replace(/\\/g, '/');
    if (name.endsWith('/')) continue; // directory entries are implied
    const nameBuf = Buffer.from(name, 'utf8');

    let raw;
    if (entry.data) {
      raw = entry.data;
    } else {
      const info = await stat(entry.sourcePath);
      if (!info.isFile()) continue;
      raw = await readFile(entry.sourcePath);
    }

    const crc = crc32(raw);
    let method = 8;
    let payload = deflateRawSync(raw, { level: 9 });
    if (payload.length >= raw.length) {
      method = 0;
      payload = raw;
    }

    const local = Buffer.concat([
      u32(0x04034b50),
      u16(20),            // version needed
      u16(0x0800),        // general purpose flags: UTF-8 names
      u16(method),
      u16(DOS_TIME),
      u16(DOS_DATE),
      u32(crc),
      u32(payload.length),
      u32(raw.length),
      u16(nameBuf.length),
      u16(0),             // extra field length
      nameBuf,
    ]);
    chunks.push(local, payload);

    central.push(
      Buffer.concat([
        u32(0x02014b50),
        u16(20),          // version made by
        u16(20),          // version needed
        u16(0x0800),
        u16(method),
        u16(DOS_TIME),
        u16(DOS_DATE),
        u32(crc),
        u32(payload.length),
        u32(raw.length),
        u16(nameBuf.length),
        u16(0),           // extra
        u16(0),           // comment
        u16(0),           // disk number
        u16(0),           // internal attrs
        u32(0),           // external attrs
        u32(offset),
        nameBuf,
      ])
    );

    offset += local.length + payload.length;
  }

  const centralBuf = Buffer.concat(central);
  const eocd = Buffer.concat([
    u32(0x06054b50),
    u16(0),
    u16(0),
    u16(sorted.length),
    u16(sorted.length),
    u32(centralBuf.length),
    u32(offset),
    u16(0),
  ]);

  await new Promise((resolve, reject) => {
    const out = createWriteStream(zipPath);
    out.on('error', reject);
    out.on('close', resolve);
    for (const c of chunks) out.write(c);
    out.write(centralBuf);
    out.end(eocd);
  });

  return { files: sorted.length, bytes: offset + centralBuf.length + eocd.length };
}

/** Recursively list regular files under `dir`, returning archive-relative names. */
export async function walk(dir, prefix = '') {
  const { readdir } = await import('node:fs/promises');
  const { join } = await import('node:path');
  const out = [];
  for (const ent of await readdir(dir, { withFileTypes: true })) {
    const name = prefix ? prefix + '/' + ent.name : ent.name;
    const full = join(dir, ent.name);
    if (ent.isDirectory()) out.push(...(await walk(full, name)));
    else if (ent.isFile()) out.push({ name, sourcePath: full });
  }
  return out;
}
