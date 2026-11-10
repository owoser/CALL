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

/**
 * Bytes per packed string - measured, not guessed.
 *
 * LSE truncates the string it passes to `ll.import` at ~16 KB. Everything past that point never
 * reaches the library, and NOTHING reports an error: `blockBatchSelfTest` shows it as fewer
 * `changes` than we packed (measured 1295 of 5981 at 84 KB, 1192 of 1516 at 21 KB, while a 14-cell
 * preview parsed all 14). That truncation was the real cause of both the "preview has a hole" and
 * the "cancel leaves most of the structure behind" reports.
 *
 * 12 KB keeps every segment a safe margin below the limit; the cost is more, smaller batches.
 */
export const PACK_MAX_BYTES = 12 * 1024;
/** Cells per `blockBatchClear` call - the same ~16 KB string limit applies to its positions. */
export const CLEAR_CHUNK = 1024;

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
/**
 * Can this descriptor travel in the packed format?
 *
 * The packed entry is `x y z state` and entries are joined by `;`, so a `;` inside the state
 * breaks the format. Such a cell must NOT be counted as restored - the caller has to send it
 * through the single-cell path instead (a dropped cell that is counted as restored is a ghost).
 */
export function isPackableId(id: string): boolean {
    const text = String(id ?? "");
    return text !== "" && text.indexOf(";") < 0;
}

export function packCells(cells: FakeCell[], maxBytes = PACK_MAX_BYTES): PackResult {
    const segments: string[] = [];
    let current: string[] = [];
    let bytes = 0;
    let skipped = 0;

    for (const cell of cells) {
        const id = String(cell?.id ?? "");
        if (!isPackableId(id) || !isInt(cell.x) || !isInt(cell.y) || !isInt(cell.z)) {
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
/**
 * Parse `blockBatchStats()`: `batch=N queue=N packets=N bytes=N dropped=N bad=N nearSets=N`.
 *
 * `dropped` and `bad` are the library TELLING us it threw work away: a packet whose player could
 * not be resolved (`flushOne`), or a sub-chunk body that came out empty (encoding). They are the
 * only authoritative signal that "we sent it" is not "the client got it", so they are parsed here
 * instead of being ignored.
 */
/**
 * `["key"=v,...]` -> `[key=v,...]`.
 *
 * The ENGINE reports states in /setblock style (quoted keys). HologramLib's state parser only
 * unquotes VALUES, so a quoted key is looked up with the quotes in it and the entry is rejected -
 * measured earlier with the preview descriptors, same parser. Every `x y z state` string we hand
 * to the library must therefore have bare keys.
 */
export function unquoteStateKeys(states: string): string {
    return String(states ?? "").replace(/"([A-Za-z0-9_:.\-]+)"\s*=/g, "$1=");
}

export function parseStats(raw: string): {
    batch: number; queue: number; packets: number; bytes: number;
    dropped: number; bad: number; nearSets: number;
} | null {
    const text = String(raw ?? "");
    if (text === "") return null;
    const pick = (key: string): number => {
        const m = new RegExp(key + "\\s*=\\s*(\\d+)").exec(text);
        return m == null ? 0 : Number(m[1]);
    };
    return {
        batch: pick("batch"), queue: pick("queue"), packets: pick("packets"), bytes: pick("bytes"),
        dropped: pick("dropped"), bad: pick("bad"), nearSets: pick("nearSets"),
    };
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
        return FakeBlocks.restoreDetailed(playerName, cells, dimid).restored.length;
    },

    /**
     * Restore and report WHICH cells were restored.
     *
     * Returning only a count was wrong: cells whose block could not be read are skipped, so the
     * caller's `slice(count)` removed the wrong positions and left the skipped ones behind while
     * claiming they were done - a residue source that looks like "cleanup reported 0 failures".
     */
    restoreDetailed(
        playerName: string,
        cells: Array<[number, number, number]>,
        dimid = 0,
        options: { probe?: boolean } = {}
    ): {
        restored: Array<[number, number, number]>;
        skipped: Array<[number, number, number]>;
        /**
         * Cells with a usable descriptor that the PACKED format cannot carry (a `;` inside the
         * state). They must be sent one by one, otherwise they keep the fake block forever.
         */
        direct: FakeCell[];
        /** `blockBatchSelfTest` output per segment (only with `probe`), for diagnostics. */
        probe?: string[];
        /** Entries the library did NOT see in a segment we packed (the 16 KB truncation tripwire). */
        truncated?: number;
        /** Cells whose chunk the server does not have loaded in THAT dimension. */
        unloaded?: number;
        /** Cells whose block could not be turned into a descriptor (exception). */
        failed?: number;
    } {
        const entries: FakeCell[] = [];
        const skipped: Array<[number, number, number]> = [];
        const direct: FakeCell[] = [];
        let unloaded = 0;
        let failed = 0;
        for (const [x, y, z] of cells) {
            let id = "";
            try {
                const block = mc.getBlock(x, y, z, dimid as 0 | 1 | 2);
                if (block != null) {
                    const bt = BlockType.generateFromBlock(block);
                    // The engine hands states back in /setblock style with QUOTED KEYS, and the
                    // library's state parser only unquotes VALUES - "key"=v is then looked up with
                    // the quotes in it and rejected. Unquote the keys, keep the values as they are.
                    const states = unquoteStateKeys(String(bt.states ?? ""));
                    id = states === "" || states === "[]" ? String(bt.type) : String(bt.type) + states;
                }
            } catch {
                id = "";
                failed++;
            }
            if (isPackableId(id)) entries.push({ x, y, z, id });
            else if (id !== "") direct.push({ x, y, z, id });
            else {
                skipped.push([x, y, z]);
                if (id === "") unloaded++;
            }
        }
        if (entries.length === 0) return { restored: [], skipped, direct };

        const packed = packCells(entries);
        if (packed.segments.length === 0) {
            return { restored: [], skipped: [...skipped, ...entries.map((e) => [e.x, e.y, e.z] as [number, number, number])], direct };
        }
        if (packed.skipped > 0) {
            // packCells dropped some entries: they must NOT be reported as restored.
            const kept = new Set<string>();
            for (const segment of packed.segments) {
                for (const item of segment.split(";")) {
                    const parts = item.trim().split(/\s+/);
                    if (parts.length >= 4) kept.add(parts[0] + "," + parts[1] + "," + parts[2]);
                }
            }
            for (const entry of [...entries]) {
                const key = entry.x + "," + entry.y + "," + entry.z;
                if (kept.has(key)) continue;
                entries.splice(entries.indexOf(entry), 1);
                if (isPackableId(entry.id)) skipped.push([entry.x, entry.y, entry.z]);
                else direct.push(entry);
            }
        }
        const probe: string[] = [];
        let truncated = 0;
        if (options.probe === true) {
            for (const segment of packed.segments) {
                const report = FakeBlocks.selfTest(segment);
                if (report == null) continue;
                probe.push(report);
                // TRIPWIRE for the ~16 KB argument truncation: if the library parses fewer entries
                // than we packed, the tail of the string never arrived. Without this the symptom is
                // just "some cells were not restored", which is indistinguishable from a client bug.
                const expected = segment.split(";").length;
                const parsed = Number((/changes=(\d+)/.exec(report) || [])[1] ?? expected);
                if (parsed < expected) truncated += expected - parsed;
            }
        }
        for (const segment of packed.segments) {
            if (FakeBlocks.set(playerName, segment, false) < 0) {
                return { restored: [], skipped: [...skipped, ...entries.map((e) => [e.x, e.y, e.z] as [number, number, number])], direct };
            }
        }
        const restored = entries.map((e) => [e.x, e.y, e.z] as [number, number, number]);
        return probe.length > 0
            ? { restored, skipped, direct, probe, truncated, unloaded, failed }
            : { restored, skipped, direct, unloaded, failed };
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

    stats(): {
        batch: number; queue: number; packets: number; bytes: number;
        dropped: number; bad: number; nearSets: number;
    } | null {
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
