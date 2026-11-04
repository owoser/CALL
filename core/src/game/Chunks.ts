import Area3 from "../common/Area3";
import Config from "../common/Config";
import { dimensionId } from "./SafeArgs";
import { run, runNow } from "./Cmd";
import { logFailure, sleep } from "../util/Safe";

/**
 * Force-loading chunks for an operation.
 *
 * VERIFIED BEHAVIOUR (LeviLamina 26.51.x, no player nearby):
 *
 *   fill 0 120 0 63 127 63 minecraft:stone
 *     -> ERR "无法在世界外放置方块" / "Cannot place blocks outside of the world"
 *   tickingarea add 0 120 0 63 127 63 callprobe
 *   fill 0 120 0 63 127 63 minecraft:stone
 *     -> 32656 个方块已填充
 *
 * That misleading "outside of the world" message is what BDS returns for UNLOADED chunks,
 * not for a size problem. It is why large selections failed while small ones (chunks the
 * player was standing in anyway) worked.
 *
 * 3.0's helper removed its ticking area in a `finally` block, i.e. BEFORE the caller ran
 * /fill, so it never helped. Hence the lease API below: the ticking area must live for
 * the whole operation.
 *
 * BDS allows only 10 ticking areas at once (the console prints "n/10"), so leases are
 * reference counted per region, and only one is normally held at a time.
 */

const PREFIX = "call_";
const DIM_NAMES = ["overworld", "nether", "the_end"];
const CHUNK = 16;

export { classifyCmdError, CmdErrorClass } from "./SafeArgs";
import { classifyCmdError } from "./SafeArgs";

interface Entry {
    name: string;
    dim: string;
    refs: number;
}

const active = new Map<string, Entry>();
let counter = 0;

export interface ChunkLease {
    readonly name: string | null;
    /** Idempotent. Releases this reference; the ticking area goes away with the last one. */
    release(): void;
}

const NOOP_LEASE: ChunkLease = { name: null, release() { } };

function loaderEnabled(): boolean {
    const raw = String(Config.get(Config.GLOBAL, "chunkLoader", "tickingarea") ?? "").toLowerCase();
    return raw !== "none";
}

/** Never wait less than this: generating a 6x6 chunk region at distance takes seconds. */
const MIN_TIMEOUT_MS = 15000;

function timeoutMs(): number {
    const n = Number(Config.get(Config.GLOBAL, "chunkLoadTimeout", MIN_TIMEOUT_MS));
    return Number.isFinite(n) && n > 0 ? Math.max(n, MIN_TIMEOUT_MS) : MIN_TIMEOUT_MS;
}

function dimName(dimid: any): string {
    return DIM_NAMES[dimensionId(dimid)] ?? DIM_NAMES[0];
}

/**
 * True when EVERY chunk column covered by `area` reads back.
 *
 * Sampling per chunk matters: an earlier 5x5 grid skipped whole chunk columns of a
 * 96-wide region (columns 0,1,3,4,5 - missing 2), reported "loaded", and then /fill
 * refused with "cannot place blocks outside of the world".
 *
 * CAVEAT: mc.getBlock() can load a chunk on demand, so a true result here does NOT prove
 * that /fill will accept the region. That is why acquire() always creates a ticking area
 * instead of trusting this check.
 */
export function isLoaded(area: Area3): boolean {
    const a = area.start;
    const b = area.end;
    const dim = a.dimid;
    const x1 = Math.min(a.x, b.x);
    const x2 = Math.max(a.x, b.x);
    const z1 = Math.min(a.z, b.z);
    const z2 = Math.max(a.z, b.z);
    const ys = a.y === b.y ? [a.y] : [Math.min(a.y, b.y), Math.max(a.y, b.y)];

    for (let cx = Math.floor(x1 / CHUNK); cx <= Math.floor(x2 / CHUNK); cx++) {
        for (let cz = Math.floor(z1 / CHUNK); cz <= Math.floor(z2 / CHUNK); cz++) {
            const x = cx * CHUNK + 8;
            const z = cz * CHUNK + 8;
            for (const y of ys) {
                try {
                    if (mc.getBlock(x, y, z, dim) == null) return false;
                } catch {
                    return false;
                }
            }
        }
    }
    return true;
}

/** Wait until `area` reads back, up to `chunkLoadTimeout`. */
export async function waitLoaded(area: Area3, limitMs = timeoutMs()): Promise<boolean> {
    if (isLoaded(area)) return true;
    const deadline = Date.now() + Math.max(limitMs, MIN_TIMEOUT_MS);
    while (Date.now() < deadline) {
        await sleep(300);
        if (isLoaded(area)) return true;
    }
    return isLoaded(area);
}

function regionKey(area: Area3): string {
    const a = area.start;
    const b = area.end;
    return [
        dimensionId(a.dimid),
        Math.floor(Math.min(a.x, b.x) / 16),
        Math.floor(Math.min(a.z, b.z) / 16),
        Math.floor(Math.max(a.x, b.x) / 16),
        Math.floor(Math.max(a.z, b.z) / 16),
    ].join(":");
}

function nextName(): string {
    counter = (counter + 1) % 100000;
    return PREFIX + Date.now().toString(36) + "_" + counter;
}

/**
 * Ensure `area` is loaded and keep it loaded until the returned lease is released.
 * Call this BEFORE running the commands, and release it in a `finally`.
 */
export async function acquire(area: Area3, label = ""): Promise<ChunkLease> {
    if (!loaderEnabled()) {
        logFailure("Chunks.acquire", new Error("chunkLoader = none, region may not be loaded " + label));
        return NOOP_LEASE;
    }
    // Deliberately NOT short-circuited on isLoaded(): mc.getBlock() reads a chunk back even
    // when /fill will still refuse the region (verified on this server). Only a ticking
    // area makes the command layer accept it, so one is always taken and released after.

    const key = regionKey(area);
    const existing = active.get(key);
    if (existing) {
        existing.refs++;
        await waitLoaded(area);
        return {
            name: existing.name,
            release() {
                releaseKey(key);
            },
        };
    }

    const a = area.start;
    const b = area.end;
    const dim = dimName(a.dimid);
    const name = nextName();
    const x1 = Math.min(a.x, b.x);
    const x2 = Math.max(a.x, b.x);
    const z1 = Math.min(a.z, b.z);
    const z2 = Math.max(a.z, b.z);
    const y1 = Math.max(-64, Math.min(a.y, b.y));
    const y2 = Math.min(320, Math.max(a.y, b.y));

    const entry: Entry = { name, dim, refs: 1 };
    active.set(key, entry);

    // runNow, not run: the caller is about to issue commands for this region, so the
    // ticking area has to exist before we return (a deferred add would land after them).
    const add = runNow(`/execute in ${dim} run tickingarea add ${x1} ${y1} ${z1} ${x2} ${y2} ${z2} ${name}`);
    if (!add.ok) {
        // Not necessarily fatal: the chunks may already be loaded by a nearby player, and
        // the poll below decides. Log ONCE per operation instead of per slab.
        logFailure("Chunks.acquire.add", new Error(label + " " + (add.out || "tickingarea add rejected")));
    }

    // BDS registers the area asynchronously. waitLoaded() alone cannot prove readiness
    // (mc.getBlock force-loads a chunk on demand, so it is instantly true - measured), so
    // give the registration a moment proportional to the region size. Callers additionally
    // retry a "not loaded" command result, which is what makes this robust.
    const chunkX = Math.floor(x2 / CHUNK) - Math.floor(x1 / CHUNK) + 1;
    const chunkZ = Math.floor(z2 / CHUNK) - Math.floor(z1 / CHUNK) + 1;
    await waitLoaded(area);
    await sleep(Math.min(1500, 200 + chunkX * chunkZ * 60));

    return {
        name,
        release() {
            releaseKey(key);
        },
    };
}

function releaseKey(key: string): void {
    const entry = active.get(key);
    if (entry == null) return;
    entry.refs--;
    if (entry.refs > 0) return;
    active.delete(key);
    try {
        runNow(`/execute in ${entry.dim} run tickingarea remove ${entry.name}`);
    } catch (e) {
        logFailure("Chunks.release", e);
    }
}

/** Release every lease this process still holds (plugin unload). */
export function releaseAll(): void {
    for (const key of [...active.keys()]) {
        const entry = active.get(key)!;
        active.delete(key);
        try {
            runNow(`/execute in ${entry.dim} run tickingarea remove ${entry.name}`);
        } catch {
            // ignore
        }
    }
}

/**
 * Remove `call_` ticking areas left behind by a previous run.
 * Called once at startup.
 */
export async function sweepStaleAreas(): Promise<number> {
    let removed = 0;
    try {
        const res = await run("/tickingarea list all-dimensions");
        if (!res.ok) return 0;
        const names = new Set<string>();
        const re = /call_[A-Za-z0-9_]+/g;
        let m: RegExpExecArray | null;
        while ((m = re.exec(res.out ?? "")) != null) names.add(m[0]);
        for (const name of names) {
            runNow("/tickingarea remove " + name);
            removed++;
        }
        if (removed > 0) logger.warn("[CALL] removed " + removed + " stale ticking area(s) from a previous run");
    } catch (e) {
        logFailure("Chunks.sweepStaleAreas", e);
    }
    return removed;
}
