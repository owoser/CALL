import Holo from "./Holo";
import BlockType from "../common/BlockType";

/**
 * Batched client-side blocks (`blockBatch*`).
 *
 * HologramLib can hand a whole batch of "show this block at that cell, for this player" changes to
 * the library in ONE call, which merges them per sub-chunk into UpdateSubChunkBlocks packets
 * (<=1024 changes per packet, framed by a global 8-packets-per-tick budget). Sending the preview
 * window cell by cell costs one native call AND one packet per cell - a 12,000 cell window was
 * 12,000 packets; the same window is 12 packets this way.
 *
 * Every export is optional: on a library without them `available()` is false and the caller keeps
 * using the per-cell `viewBlock` path.
 */

export interface FakeCell {
    x: number;
    y: number;
    z: number;
    /** Full block descriptor, e.g. minecraft:stone_stairs["weirdo_direction"=2]. */
    id: string;
}

export interface PackResult {
    /** `x y z state;x y z state` - one entry per call (split when too large). */
    segments: string[];
    /** Cells that could not be encoded (bad coordinates or a `;` inside the state). */
    skipped: number;
}

/** One packed string is kept well below the library limit; a segment is one or more packets. */
export const PACK_MAX_BYTES = 512 * 1024;
/** Cells per `blockBatchClear` call (the library splits the packets itself). */
export const CLEAR_CHUNK = 4096;

function isInt(n: unknown): boolean {
    return typeof n === "number" && Number.isFinite(n) && Math.floor(n) === n;
}

/**
 * Encode cells into the library's packed format.
 *
 * Pure: no library access, which keeps it unit-testable and lets the caller decide what to do with
 * `skipped`. A `;` inside the state would break the format, so those cells are dropped instead of
 * producing a malformed batch (the caller re-sends them through the per-cell path).
 */
export function packCells(cells: FakeCell[], maxBytes = PACK_MAX_BYTES): PackResult {
    const segments: string[] = [];
    let current: string[] = [];
    let bytes = 0;
    let skipped = 0;

    for (const cell of cells) {
        const id = String(cell?.id ?? "");
        if (id === "" || id.indexOf(";") >= 0 || !isInt(cell.x) || !isInt(cell.y) || !isInt(cell.z)) {
            skipped++;
            continue;
        }
        const entry = cell.x + " " + cell.y + " " + cell.z + " " + id;
        const size = entry.length + (current.length > 0 ? 1 : 0);
        if (current.length > 0 && bytes + size > maxBytes) {
            segments.push(current.join(";"));
            current = [];
            bytes = 0;
        }
        current.push(entry);
        bytes += entry.length + (current.length > 1 ? 1 : 0);
    }
    if (current.length > 0) segments.push(current.join(";"));
    return { segments, skipped };
}

/** `x y z;x y z` - the format blockBatchClear expects. */
export function packPositions(cells: Array<[number, number, number]>): string {
    const parts: string[] = [];
    for (const [x, y, z] of cells) {
        if (!isInt(x) || !isInt(y) || !isInt(z)) continue;
        parts.push(x + " " + y + " " + z);
    }
    return parts.join(";");
}

/** `batch=3 queue=1 packets=12 bytes=21400 nearSets=0` -> numbers. */
export function parseStats(raw: string): { batch: number; queue: number; packets: number; bytes: number } | null {
    const text = String(raw ?? "");
    if (text === "") return null;
    const pick = (key: string): number => {
        const m = new RegExp(key + "\\s*=\\s*(\\d+)").exec(text);
        return m == null ? 0 : Number(m[1]);
    };
    return { batch: pick("batch"), queue: pick("queue"), packets: pick("packets"), bytes: pick("bytes") };
}

type AnyFn = (...args: any[]) => any;

let setFn: AnyFn | null | undefined;
let clearFn: AnyFn | null | undefined;
let statsFn: AnyFn | null | undefined;
let progressFn: AnyFn | null | undefined;
let testFn: AnyFn | null | undefined;
let oneFn: AnyFn | null | undefined;

function bind(slot: "set" | "clear" | "stats" | "progress" | "test" | "one", name: string): AnyFn | null {
    const cached = slot === "set" ? setFn : slot === "clear" ? clearFn : slot === "stats" ? statsFn
        : slot === "progress" ? progressFn : slot === "one" ? oneFn : testFn;
    if (cached !== undefined) return cached;
    let fn: AnyFn | null = null;
    try {
        fn = Holo.bind(name) ?? null;
    } catch {
        fn = null;
    }
    if (slot === "set") setFn = fn;
    else if (slot === "clear") clearFn = fn;
    else if (slot === "stats") statsFn = fn;
    else if (slot === "progress") progressFn = fn;
    else if (slot === "one") oneFn = fn;
    else testFn = fn;
    return fn;
}

/** Drop every cached handle (library hot-reload / fresh probe). */
export function resetBindings(): void {
    setFn = undefined;
    clearFn = undefined;
    statsFn = undefined;
    progressFn = undefined;
    testFn = undefined;
    oneFn = undefined;
}

export const FakeBlocks = {
    /** Both halves are required: sending without clearing would leave ghosts behind. */
    available(): boolean {
        return bind("set", "blockBatchSet") != null && bind("clear", "blockBatchClear") != null;
    },

    pack: packCells,
    packPositions,

    /** One call -> one batchId (-1 when the library rejected the payload). */
    set(playerName: string, packed: string, immediate = false): number {
        const fn = bind("set", "blockBatchSet");
        if (fn == null) return -1;
        try {
            const id = Number(fn(String(playerName), packed, immediate === true));
            return Number.isFinite(id) ? id : -1;
        } catch {
            resetBindings();
            return -1;
        }
    },

    /** Restore the real blocks for these cells. Chunked; true only when every chunk went out. */
    clear(playerName: string, cells: Array<[number, number, number]>): boolean {
        const fn = bind("clear", "blockBatchClear");
        if (fn == null) return false;
        if (cells.length === 0) return true;
        for (let i = 0; i < cells.length; i += CLEAR_CHUNK) {
            const part = cells.slice(i, i + CLEAR_CHUNK);
            const packed = packPositions(part);
            if (packed === "") continue;
            try {
                // The export is documented as Boolean, but a count/1 is just as valid.
                const ok = fn(String(playerName), packed);
                if (ok !== true && !Number(ok)) return false;
            } catch {
                resetBindings();
                return false;
            }
        }
        return true;
    },

    /**
     * Restore cells by re-sending the block the WORLD has at those positions.
     *
     * `blockBatchClear` is the documented way to undo a fake block, but it reports failure
     * (its bodies are validated one by one and it only counts packets that really went out),
     * and a failed clear is a permanent ghost. The set path is the one that demonstrably works,
     * so "clear" is implemented as "set the real block" - exactly what the library would send,
     * with a descriptor we build from the live block.
     *
     * Returns how many cells were restored; cells whose chunk the server does not have are
     * skipped so the caller can keep them owed.
     */
    restore(playerName: string, cells: Array<[number, number, number]>, dimid = 0): number {
        const entries: FakeCell[] = [];
        for (const [x, y, z] of cells) {
            let id = "";
            try {
                const block = mc.getBlock(x, y, z, dimid as 0 | 1 | 2);
                if (block != null) {
                    const bt = BlockType.generateFromBlock(block);
                    const states = String(bt.states ?? "");
                    id = states === "" || states === "[]" ? String(bt.type) : String(bt.type) + states;
                }
            } catch {
                id = "";
            }
            if (id !== "") entries.push({ x, y, z, id });
        }
        if (entries.length === 0) return 0;

        const packed = packCells(entries);
        if (packed.segments.length === 0) return 0;
        for (const segment of packed.segments) {
            if (FakeBlocks.set(playerName, segment, false) < 0) return 0;
        }
        return entries.length;
    },

    /**
     * Single-cell restore (`blockFakeClear`).
     *
     * `blockBatchClear` builds its packets in bulk and reports failure when a body does not pass
     * the library validation or no packet went out, so this older single-cell path is kept as the
     * fallback: without it a refused clear leaves a permanent ghost on the client.
     */
    clearOne(playerName: string, x: number, y: number, z: number): boolean {
        const fn = bind("one", "blockFakeClear");
        if (fn == null) return false;
        try {
            const ok = fn(String(playerName), Number(x), Number(y), Number(z));
            return ok === true || Number(ok) > 0;
        } catch {
            resetBindings();
            return false;
        }
    },

    stats(): { batch: number; queue: number; packets: number; bytes: number } | null {
        const fn = bind("stats", "blockBatchStats");
        if (fn == null) return null;
        try {
            return parseStats(String(fn() ?? ""));
        } catch {
            resetBindings();
            return null;
        }
    },

    /** 0..100, or -1 when the library no longer knows the batch. */
    progress(batchId: number): number {
        const fn = bind("progress", "blockBatchProgress");
        if (fn == null) return -1;
        try {
            const n = Number(fn(Number(batchId)));
            return Number.isFinite(n) ? n : -1;
        } catch {
            resetBindings();
            return -1;
        }
    },

    /** Parse/group/encode without sending - used by diagnostics. */
    selfTest(packed: string): string | null {
        const fn = bind("test", "blockBatchSelfTest");
        if (fn == null) return null;
        try {
            return String(fn(String(packed)) ?? "");
        } catch {
            resetBindings();
            return null;
        }
    },

    /** Tests inject the backing functions. */
    setSource(source: { set?: AnyFn | null; clear?: AnyFn | null; stats?: AnyFn | null; progress?: AnyFn | null; one?: AnyFn | null } | null): void {
        resetBindings();
        if (source == null) return;
        if (source.set !== undefined) setFn = source.set;
        if (source.clear !== undefined) clearFn = source.clear;
        if (source.stats !== undefined) statsFn = source.stats;
        if (source.progress !== undefined) progressFn = source.progress;
        if (source.one !== undefined) oneFn = source.one;
    },
};

export default FakeBlocks;
