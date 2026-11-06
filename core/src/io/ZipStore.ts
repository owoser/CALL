import * as fs from "fs";
import * as path from "path";
import * as zlib from "zlib";

/**
 * Minimal STORE-only ZIP writer.
 *
 * Needed to hand out the addon as a .mcaddon/.mcpack that a player can double-click, without
 * pulling a zip library into the plugin (the build-time helper in scripts/ is ESM and not
 * shipped). Store-only is fine: the packs are a few hundred KB of already-compressed PNGs.
 */

const CRC_TABLE = (() => {
    const table = new Int32Array(256);
    for (let i = 0; i < 256; i++) {
        let c = i;
        for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
        table[i] = c;
    }
    return table;
})();

function crc32(buf: Buffer): number {
    let crc = -1;
    for (let i = 0; i < buf.length; i++) crc = (crc >>> 8) ^ CRC_TABLE[(crc ^ buf[i]) & 0xff];
    return (crc ^ -1) >>> 0;
}

export interface ZipEntry {
    /** Path inside the archive, forward slashes. */
    name: string;
    data: Buffer;
}

export function createStoreZip(entries: ZipEntry[]): Buffer {
    const chunks: Buffer[] = [];
    const central: Buffer[] = [];
    let offset = 0;

    for (const entry of entries) {
        const nameBuf = Buffer.from(entry.name, "utf8");
        const crc = crc32(entry.data);
        const size = entry.data.length;

        const local = Buffer.alloc(30);
        local.writeUInt32LE(0x04034b50, 0);
        local.writeUInt16LE(20, 4);      // version needed
        local.writeUInt16LE(0, 6);       // flags
        local.writeUInt16LE(0, 8);       // method: store
        local.writeUInt16LE(0, 10);      // time
        local.writeUInt16LE(0x21, 12);   // date (1980-01-01)
        local.writeUInt32LE(crc, 14);
        local.writeUInt32LE(size, 18);
        local.writeUInt32LE(size, 22);
        local.writeUInt16LE(nameBuf.length, 26);
        local.writeUInt16LE(0, 28);

        chunks.push(local, nameBuf, entry.data);

        const dir = Buffer.alloc(46);
        dir.writeUInt32LE(0x02014b50, 0);
        dir.writeUInt16LE(20, 4);
        dir.writeUInt16LE(20, 6);
        dir.writeUInt16LE(0, 8);
        dir.writeUInt16LE(0, 10);
        dir.writeUInt16LE(0, 12);
        dir.writeUInt16LE(0x21, 14);
        dir.writeUInt32LE(crc, 16);
        dir.writeUInt32LE(size, 20);
        dir.writeUInt32LE(size, 24);
        dir.writeUInt16LE(nameBuf.length, 28);
        dir.writeUInt16LE(0, 30);        // extra
        dir.writeUInt16LE(0, 32);        // comment
        dir.writeUInt16LE(0, 34);        // disk
        dir.writeUInt16LE(0, 36);        // internal attrs
        dir.writeUInt32LE(0, 38);        // external attrs
        dir.writeUInt32LE(offset, 42);
        central.push(dir, nameBuf);

        offset += local.length + nameBuf.length + size;
    }

    const centralBuf = Buffer.concat(central);
    const end = Buffer.alloc(22);
    end.writeUInt32LE(0x06054b50, 0);
    end.writeUInt16LE(0, 4);
    end.writeUInt16LE(0, 6);
    end.writeUInt16LE(entries.length, 8);
    end.writeUInt16LE(entries.length, 10);
    end.writeUInt32LE(centralBuf.length, 12);
    end.writeUInt32LE(offset, 16);
    end.writeUInt16LE(0, 20);

    return Buffer.concat([...chunks, centralBuf, end]);
}

/** Collect every file under `dir` as archive entries prefixed with `prefix`. */
export function collectEntries(dir: string, prefix: string): ZipEntry[] {
    const out: ZipEntry[] = [];
    const walk = (abs: string, rel: string): void => {
        for (const name of fs.readdirSync(abs)) {
            const childAbs = path.join(abs, name);
            const childRel = rel === "" ? name : rel + "/" + name;
            const stat = fs.statSync(childAbs);
            if (stat.isDirectory()) walk(childAbs, childRel);
            else out.push({ name: prefix + "/" + childRel, data: fs.readFileSync(childAbs) });
        }
    };
    if (fs.existsSync(dir)) walk(dir, "");
    return out;
}
