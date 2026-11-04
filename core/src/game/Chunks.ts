import Area3 from "../common/Area3";
import Config from "../common/Config";
import { Pos3 } from "../common/Pos3";
import { dimensionId } from "./SafeArgs";
import { run, runNow } from "./Cmd";
import { describeError, logFailure, sleep } from "../util/Safe";

/**
 * Force-loading chunks without moving the player.
 *
 * 1.x/2.0 handled "the area is not loaded" by teleporting the player to it - every
 * 400ms in `loadChunk`, and every 50ms up to 15 times in `Players.tpAsync`. That moves
 * players around mid-operation, can drop them into solid rock, and is a lot of
 * client-visible churn.
 *
 * BDS has `/tickingarea` for exactly this. We add a named ticking area, wait for the
 * corner blocks to become readable, and always remove it again (including on failure,
 * and on the next startup, in case the process died while one was active).
 */

const PREFIX = "call_";
const DIM_NAMES = ["overworld", "nether", "the_end"];
let counter = 0;

export type ChunkLoaderMode = "tickingarea" | "none";

export function loaderMode(): ChunkLoaderMode {
    const raw = String(Config.get(Config.GLOBAL, "chunkLoader", "tickingarea") ?? "").toLowerCase();
    return raw === "none" ? "none" : "tickingarea";
}

/** True when both corners of the area can be read right now. */
export function isLoaded(area: Area3): boolean {
    const a = area.start;
    const b = area.end;
    try {
        return mc.getBlock(a.x, a.y, a.z, a.dimid) != null
            && mc.getBlock(b.x, b.y, b.z, b.dimid) != null;
    } catch {
        return false;
    }
}

function nextName(): string {
    counter = (counter + 1) % 100000;
    return PREFIX + Date.now().toString(36) + "_" + counter;
}

function maxWaitMs(): number {
    const n = Number(Config.get(Config.GLOBAL, "chunkLoadTimeout", 4000));
    return Number.isFinite(n) && n > 0 ? n : 4000;
}

/**
 * Ensure `area` is readable, using a ticking area when necessary.
 * @returns true when the corners became readable.
 */
export async function ensureLoaded(area: Area3): Promise<boolean> {
    if (isLoaded(area)) return true;
    if (loaderMode() === "none") {
        logFailure("Chunks.ensureLoaded", new Error("area not loaded and chunkLoader = none"));
        return false;
    }

    const a = area.start;
    const b = area.end;
    const name = nextName();
    const dim = DIM_NAMES[dimensionId(a.dimid)] ?? DIM_NAMES[0];

    // Bedrock clamps a ticking area to a limited footprint; clamp generously so the
    // command is accepted for large selections (we only need the corners readable).
    const CLAMP = 512;
    const x1 = Math.max(a.x, a.x - CLAMP);
    const z1 = Math.max(a.z, a.z - CLAMP);
    const x2 = Math.min(b.x, a.x + CLAMP);
    const z2 = Math.min(b.z, a.z + CLAMP);
    const y1 = Math.max(-64, Math.min(a.y, b.y));
    const y2 = Math.min(320, Math.max(a.y, b.y));

    const addCmd = `/execute in ${dim} run tickingarea add ${x1} ${y1} ${z1} ${x2} ${y2} ${z2} ${name}`;
    const add = await run(addCmd);
    if (!add.ok) {
        // Not fatal on its own: the area may become readable anyway (player nearby).
        logFailure("Chunks.ensureLoaded.add", new Error(add.out || "tickingarea add failed"));
    }

    try {
        const deadline = Date.now() + maxWaitMs();
        while (Date.now() < deadline) {
            await sleep(250);
            if (isLoaded(area)) return true;
        }
        return isLoaded(area);
    } finally {
        // Always clean up; a leaked ticking area is a permanent world change.
        safeRemove(name, dim);
    }
}

function safeRemove(name: string, dim: string): void {
    try {
        runNow(`/execute in ${dim} run tickingarea remove ${name}`);
    } catch (e) {
        logFailure("Chunks.ensureLoaded.remove", e);
    }
}

/**
 * Remove `call_` ticking areas left behind by a previous run.
 * Called once at startup; failures are ignored.
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

/** Build a Pos3 from an Area3 corner (small helper for callers). */
export function startOf(area: Area3): Pos3 {
    return Pos3.fromPos3(area.start);
}
