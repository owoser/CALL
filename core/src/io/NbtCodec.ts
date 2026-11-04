/**
 * NBT endian conversion for .mcstructure files.
 *
 * WHY THIS EXISTS
 * ---------------
 * LegacyScriptEngine's NbtCompound.toBinaryNBT() produces (and NBT.parseBinaryNBT()
 * consumes) big-endian NBT, the classic "network NBT" layout.
 *
 * Minecraft Bedrock writes and reads .mcstructure files as LITTLE-endian NBT. Verified
 * on LeviLamina 26.51.x: a file produced by toBinaryNBT() and dropped into
 * <bds>/structures/ is rejected by /structure load ("structure not found"), and the
 * files /structure save writes start with 0a 00 00 03 0e 00 (LE) while toBinaryNBT()
 * emits 00 0e for the same name length (BE).
 *
 * So anything CALL hands to the game as a structure file must be transcoded first.
 * Parsing goes through a small tagged tree; only the byte order differs, so the
 * conversion is lossless.
 */

import { cellIndex } from "./StructureOrder";

type NbtTag =
    | { type: 1; value: number }
    | { type: 2; value: number }
    | { type: 3; value: number }
    | { type: 4; value: bigint }
    | { type: 5; value: number }
    | { type: 6; value: number }
    | { type: 7; value: Buffer }
    | { type: 8; value: string }
    | { type: 9; listType: number; items: NbtTag[] }
    | { type: 10; entries: { name: string; tag: NbtTag }[] }
    | { type: 11; value: Int32Array }
    | { type: 12; value: BigInt64Array };

class Reader {
    private pos = 0;
    constructor(private readonly buf: Buffer, private readonly little: boolean) {}

    /** Current read offset (also used to verify a parse consumed the whole buffer). */
    public get position(): number {
        return this.pos;
    }

    need(n: number): void {
        if (this.pos + n > this.buf.length) throw new Error("NBT truncated at " + this.pos);
    }
    u8(): number {
        this.need(1);
        return this.buf.readUInt8(this.pos++);
    }
    i16(): number {
        this.need(2);
        const v = this.little ? this.buf.readInt16LE(this.pos) : this.buf.readInt16BE(this.pos);
        this.pos += 2;
        return v;
    }
    u16(): number {
        this.need(2);
        const v = this.little ? this.buf.readUInt16LE(this.pos) : this.buf.readUInt16BE(this.pos);
        this.pos += 2;
        return v;
    }
    i32(): number {
        this.need(4);
        const v = this.little ? this.buf.readInt32LE(this.pos) : this.buf.readInt32BE(this.pos);
        this.pos += 4;
        return v;
    }
    i64(): bigint {
        this.need(8);
        const v = this.little ? this.buf.readBigInt64LE(this.pos) : this.buf.readBigInt64BE(this.pos);
        this.pos += 8;
        return v;
    }
    f32(): number {
        this.need(4);
        const v = this.little ? this.buf.readFloatLE(this.pos) : this.buf.readFloatBE(this.pos);
        this.pos += 4;
        return v;
    }
    f64(): number {
        this.need(8);
        const v = this.little ? this.buf.readDoubleLE(this.pos) : this.buf.readDoubleBE(this.pos);
        this.pos += 8;
        return v;
    }
    bytes(n: number): Buffer {
        this.need(n);
        const out = this.buf.subarray(this.pos, this.pos + n);
        this.pos += n;
        return out;
    }
    utf(): string {
        const len = this.u16();
        this.need(len);
        const s = this.buf.toString("utf8", this.pos, this.pos + len);
        this.pos += len;
        return s;
    }
}

function readPayload(r: Reader, type: number): NbtTag {
    switch (type) {
        case 1:
            return { type: 1, value: r.u8() };
        case 2:
            return { type: 2, value: r.i16() };
        case 3:
            return { type: 3, value: r.i32() };
        case 4:
            return { type: 4, value: r.i64() };
        case 5:
            return { type: 5, value: r.f32() };
        case 6:
            return { type: 6, value: r.f64() };
        case 7: {
            const n = r.i32();
            if (n < 0) throw new Error("negative byte array length");
            return { type: 7, value: Buffer.from(r.bytes(n)) };
        }
        case 8:
            return { type: 8, value: r.utf() };
        case 9: {
            const listType = r.u8();
            const n = r.i32();
            const items: NbtTag[] = [];
            if (n < 0) throw new Error("negative list length");
            for (let i = 0; i < n; i++) items.push(readPayload(r, listType));
            return { type: 9, listType, items };
        }
        case 10: {
            const entries: { name: string; tag: NbtTag }[] = [];
            for (;;) {
                const t = r.u8();
                if (t === 0) break;
                const name = r.utf();
                entries.push({ name, tag: readPayload(r, t) });
            }
            return { type: 10, entries };
        }
        case 11: {
            const n = r.i32();
            const arr = new Int32Array(n);
            for (let i = 0; i < n; i++) arr[i] = r.i32();
            return { type: 11, value: arr };
        }
        case 12: {
            const n = r.i32();
            const arr = new BigInt64Array(n);
            for (let i = 0; i < n; i++) arr[i] = r.i64();
            return { type: 12, value: arr };
        }
        default:
            throw new Error("unsupported NBT tag type " + type);
    }
}

function makeWriter(little: boolean) {
    const parts: Buffer[] = [];
    let len = 0;
    const push = (b: Buffer) => {
        parts.push(b);
        len += b.length;
    };
    return {
        u8(v: number) {
            const b = Buffer.allocUnsafe(1);
            b.writeUInt8(v & 0xff);
            push(b);
        },
        u16(v: number) {
            const b = Buffer.allocUnsafe(2);
            if (little) b.writeUInt16LE(v, 0);
            else b.writeUInt16BE(v, 0);
            push(b);
        },
        i16(v: number) {
            const b = Buffer.allocUnsafe(2);
            if (little) b.writeInt16LE(v, 0);
            else b.writeInt16BE(v, 0);
            push(b);
        },
        i32(v: number) {
            const b = Buffer.allocUnsafe(4);
            if (little) b.writeInt32LE(v, 0);
            else b.writeInt32BE(v, 0);
            push(b);
        },
        i64(v: bigint) {
            const b = Buffer.allocUnsafe(8);
            if (little) b.writeBigInt64LE(v, 0);
            else b.writeBigInt64BE(v, 0);
            push(b);
        },
        f32(v: number) {
            const b = Buffer.allocUnsafe(4);
            if (little) b.writeFloatLE(v, 0);
            else b.writeFloatBE(v, 0);
            push(b);
        },
        f64(v: number) {
            const b = Buffer.allocUnsafe(8);
            if (little) b.writeDoubleLE(v, 0);
            else b.writeDoubleBE(v, 0);
            push(b);
        },
        raw(b: Buffer) {
            push(Buffer.from(b));
        },
        utf(s: string) {
            const body = Buffer.from(s, "utf8");
            const l = Buffer.allocUnsafe(2);
            if (little) l.writeUInt16LE(body.length, 0);
            else l.writeUInt16BE(body.length, 0);
            push(l);
            push(body);
        },
        done(): Buffer {
            return Buffer.concat(parts, len);
        },
    };
}

type Writer = ReturnType<typeof makeWriter>;

function writePayload(w: Writer, tag: NbtTag, type: number): void {
    switch (type) {
        case 1:
            w.u8((tag as any).value);
            break;
        case 2:
            w.i16((tag as any).value);
            break;
        case 3:
            w.i32((tag as any).value);
            break;
        case 4:
            w.i64((tag as any).value);
            break;
        case 5:
            w.f32((tag as any).value);
            break;
        case 6:
            w.f64((tag as any).value);
            break;
        case 7:
            w.i32((tag as any).value.length);
            w.raw((tag as any).value);
            break;
        case 8:
            w.utf((tag as any).value);
            break;
        case 9: {
            const t = tag as { listType: number; items: NbtTag[] };
            w.u8(t.listType);
            w.i32(t.items.length);
            for (const item of t.items) writePayload(w, item, t.listType);
            break;
        }
        case 10: {
            const t = tag as { entries: { name: string; tag: NbtTag }[] };
            for (const e of t.entries) {
                w.u8(e.tag.type);
                w.utf(e.name);
                writePayload(w, e.tag, e.tag.type);
            }
            w.u8(0);
            break;
        }
        case 11: {
            const arr = (tag as any).value as Int32Array;
            w.i32(arr.length);
            for (const v of arr) w.i32(v);
            break;
        }
        case 12: {
            const arr = (tag as any).value as BigInt64Array;
            w.i32(arr.length);
            for (const v of arr) w.i64(v);
            break;
        }
        default:
            throw new Error("unsupported NBT tag type " + type);
    }
}

interface ParsedRoot {
    rootName: string;
    root: NbtTag;
    little: boolean;
}

/**
 * Try to read `buf` as a named root compound in one byte order.
 * @returns the parse when it consumed the buffer EXACTLY, otherwise null.
 */
function tryParseRoot(buf: Buffer, little: boolean): ParsedRoot | null {
    try {
        const reader = new Reader(buf, little);
        const rootType = reader.u8();
        if (rootType !== 10) return null;
        const rootName = reader.utf();
        // A root name is either empty or printable ASCII; anything else means we are
        // reading the wrong byte order.
        if (!/^[\x20-\x7e]*$/.test(rootName)) return null;
        const root = readPayload(reader, 10);
        // The decisive check: a correct byte order consumes the buffer exactly.
        if (reader.position !== buf.length) return null;
        return { rootName, root, little };
    } catch {
        return null;
    }
}

/**
 * Determine the byte order of an NBT document whose root is a named compound.
 *
 * WHY NOT A LENGTH HEURISTIC
 * --------------------------
 * 2.0 guessed with `readUInt16BE(3) <= buf.length - 5`. For a little-endian file that
 * value is the constant 782 (the first child's name length 0x000e read the wrong way),
 * so every file LARGER than 787 bytes was misdetected as big-endian and failed to parse
 * with "structure has no usable size". Small test regions happened to be under that
 * size, which is why the bug survived testing.
 *
 * Both orders are now parsed and the one that consumes the buffer exactly wins;
 * little-endian is preferred when both succeed (that is the .mcstructure format).
 */
export function detectEndian(buf: Buffer): "be" | "le" {
    if (buf.length < 5) throw new Error("NBT too short");
    if (buf[0] !== 10) throw new Error("NBT root is not a compound (0x" + buf[0].toString(16) + ")");

    const little = tryParseRoot(buf, true);
    if (little) return "le";
    const big = tryParseRoot(buf, false);
    if (big) return "be";

    throw new Error(
        "cannot determine NBT byte order: neither reading parses to a complete compound"
    );
}

function toEndian(buf: Buffer, little: boolean): Buffer {
    const from = detectEndian(buf);
    if ((from === "le") === little) return buf;
    const reader = new Reader(buf, from === "le");
    reader.u8(); // root type
    const rootName = reader.utf();
    const root = readPayload(reader, 10);
    const w = makeWriter(little);
    w.u8(10);
    w.utf(rootName);
    writePayload(w, root, 10);
    return w.done();
}

/** Big-endian NBT -> little-endian NBT (the .mcstructure file format). */
export function toLittleEndian(buf: Buffer): Buffer {
    return toEndian(buf, true);
}

/** Little-endian NBT (a real .mcstructure file) -> big-endian NBT. */
export function toBigEndian(buf: Buffer): Buffer {
    return toEndian(buf, false);
}
// ------------------------------------------------- structure layout extraction
/**
 * A structure template reduced to what placement needs.
 *
 * Parsed from the raw NBT bytes rather than through the NbtCompound JS API on purpose:
 * engine captures store `block_indices` as TAG_Int_Array, which LSE's JS NbtCompound
 * cannot index (`getTag(0)` returns undefined), while JS-built shape templates use a
 * List of Ints. The byte-level parser handles both.
 */
export interface StructureLayout {
    size: [number, number, number];
    indices: number[];
    /** States are plain JS values so they can be fed back into new NbtCompound(). */
    palette: { name: string; states: Record<string, any>; version: number }[];
}

function parseRoot(buf: Buffer): Extract<NbtTag, { type: 10 }> {
    const little = detectEndian(buf) === "le";
    const reader = new Reader(buf, little);
    reader.u8(); // root tag type
    reader.utf(); // root name
    const root = readPayload(reader, 10);
    if (root.type !== 10) throw new Error("structure root is not a compound");
    return root;
}

function child(tag: Extract<NbtTag, { type: 10 }>, name: string): NbtTag | undefined {
    return tag.entries.find((e) => e.name === name)?.tag;
}

function numArray(tag: NbtTag | undefined): number[] {
    if (tag == null) return [];
    if (tag.type === 11) return Array.from(tag.value);
    if (tag.type === 7) return Array.from(tag.value);
    if (tag.type === 9) {
        const out: number[] = [];
        for (const item of tag.items) {
            if (item.type === 3 || item.type === 2 || item.type === 1 || item.type === 4) {
                out.push(Number(item.value));
            }
        }
        return out;
    }
    return [];
}

function toJs(tag: NbtTag): any {
    switch (tag.type) {
        case 1:
        case 2:
        case 3:
            return tag.value;
        case 4:
            return Number(tag.value);
        case 5:
        case 6:
            return tag.value;
        case 8:
            return tag.value;
        case 10: {
            const out: Record<string, any> = {};
            for (const e of tag.entries) out[e.name] = toJs(e.tag);
            return out;
        }
        case 9:
            return tag.items.map(toJs);
        default:
            return null;
    }
}

/** Parse a .mcstructure / toBinaryNBT() byte image into a placement layout. */
export function parseStructureLayout(buf: Buffer): StructureLayout {
    const root = parseRoot(buf);

    const sizeTag = child(root, "size");
    const size = numArray(sizeTag);
    if (size.length < 3) throw new Error("structure has no usable size");

    const structureTag = child(root, "structure");
    if (structureTag == null || structureTag.type !== 10) throw new Error("structure has no 'structure' tag");

    const indicesTag = child(structureTag, "block_indices");
    let indices: number[] = [];
    if (indicesTag != null && indicesTag.type === 9 && indicesTag.items.length > 0) {
        // layer 0 = blocks, layer 1 = liquids
        indices = numArray(indicesTag.items[0]);
        if (indices.length === 0) indices = numArray(indicesTag);
    } else {
        indices = numArray(indicesTag);
    }
    if (indices.length === 0) throw new Error("structure has no block indices");

    const palette: StructureLayout["palette"] = [];
    const paletteTag = child(structureTag, "palette");
    const defaultTag = paletteTag && paletteTag.type === 10 ? child(paletteTag, "default") : undefined;
    const blockPalette = defaultTag && defaultTag.type === 10 ? child(defaultTag, "block_palette") : undefined;
    if (blockPalette != null && blockPalette.type === 9) {
        for (const entry of blockPalette.items) {
            if (entry.type !== 10) continue;
            const name = child(entry, "name");
            const states = child(entry, "states");
            const version = child(entry, "version");
            palette.push({
                name: name && name.type === 8 ? name.value : "minecraft:air",
                states: states && states.type === 10 ? (toJs(states) as Record<string, any>) : {},
                version: version && version.type === 3 ? Number(version.value) : 0,
            });
        }
    }

    return { size: [size[0], size[1], size[2]], indices, palette };
}
// --------------------------------------------------- mirror / rotate support
export interface TransformOptions {
    /** 0 / 90 / 180 / 270 degrees, clockwise around the Y axis. */
    rotation?: number;
    /** "none" | "x" | "z" | "xz" */
    mirror?: string;
}

function normaliseRotation(rotation: number | undefined): number {
    const n = Number(rotation ?? 0);
    if (!Number.isFinite(n)) return 0;
    const wrapped = ((Math.round(n / 90) * 90) % 360 + 360) % 360;
    return wrapped;
}

/**
 * Mirror and/or rotate a parsed structure layout.
 *
 * Placement is per block, so the transform has to happen here - passing a rotation to
 * the game is not an option (mc.setStructure crashes, and /structure load only accepts
 * structures the game already knows about).
 *
 * Order of operations matches what a structure block does: mirror first, then rotate.
 */
export function transformLayout(layout: StructureLayout, options: TransformOptions): StructureLayout {
    const rotation = normaliseRotation(options.rotation);
    const mirror = String(options.mirror ?? "none").toLowerCase();
    const mirrorX = mirror === "x" || mirror === "xz";
    const mirrorZ = mirror === "z" || mirror === "xz";

    const [sx, sy, sz] = layout.size;
    const swap = rotation === 90 || rotation === 270;
    const outSize: [number, number, number] = swap ? [sz, sy, sx] : [sx, sy, sz];

    if (rotation === 0 && !mirrorX && !mirrorZ) {
        return layout;
    }

    const outIndices = new Array<number>(outSize[0] * outSize[1] * outSize[2]).fill(-1);
    const outSz = outSize[2];

    for (let x = 0; x < sx; x++) {
        for (let y = 0; y < sy; y++) {
            for (let z = 0; z < sz; z++) {
                // ZYX order: SZ*SY*X + SZ*Y + Z (see StructureOrder)
                const src = cellIndex(x, y, z, sz, sy);
                const value = layout.indices[src];
                if (value == null || value < 0) continue;

                let nx = mirrorX ? sx - 1 - x : x;
                let nz = mirrorZ ? sz - 1 - z : z;

                // rotate clockwise around Y
                let rx = nx;
                let rz = nz;
                switch (rotation) {
                    case 90:
                        rx = sz - 1 - nz;
                        rz = nx;
                        break;
                    case 180:
                        rx = sx - 1 - nx;
                        rz = sz - 1 - nz;
                        break;
                    case 270:
                        rx = nz;
                        rz = sx - 1 - nx;
                        break;
                    default:
                        break;
                }

                if (rx < 0 || rx >= outSize[0] || rz < 0 || rz >= outSize[2]) continue;
                const dst = cellIndex(rx, y, rz, outSz, sy);
                outIndices[dst] = value;
            }
        }
    }

    return { size: outSize, indices: outIndices, palette: layout.palette };
}