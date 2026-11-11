/**
 * "Walk through the preview": register a set of fake blocks that turn into passable sulfur cubes
 * while the player is close (HologramLib \`blockBatchSetNear\`).
 *
 * The library replaces the WHOLE set on every call (it destroys the active cubes and drops the old
 * registration first), so this module always sends one complete window and never tries to patch it.
 * It also owns the cleanup: without a clear, a player who cancels a preview while standing inside it
 * would keep the cubes around.
 */
import HoloCompat from "./HoloCompat";
import holo from "./Holo";
import { packCells, PACK_MAX_BYTES } from "./FakeBlocks";

export interface NearCell {
    x: number;
    y: number;
    z: number;
    id: string;
}

const stats = {
    registrations: 0,
    lastCells: 0,
    lastBatchId: -1,
    failures: 0,
    warnings: 0,
};

let warnedMissing = false;

export const NearBlocks = {
    /** True when the library exports the near-switching pair. */
    available(): boolean {
        return HoloCompat.status().caps.nearPass === true;
    },

    reason(): string {
        return NearBlocks.available() ? "" : "库缺少 blockBatchSetNear";
    },

    /**
     * Replace the player's near set with \`cells\`.
     *
     * Returns the batch id, or -1 when the feature is unavailable / the payload had nothing usable.
     * \`cells\` must already be capped by NearWindow.selectNearCells: this only splits by bytes.
     */
    register(playerName: string, cells: NearCell[], radius: number, invisible: boolean): number {
        if (!NearBlocks.available() || cells.length === 0 || radius <= 0) return -1;
        const packed = packCells(cells.map((c) => ({ x: c.x, y: c.y, z: c.z, id: c.id })), PACK_MAX_BYTES);
        if (packed.segments.length === 0) return -1;
        // A near set is ONE registration: concatenating the segments keeps it a single call (and the
        // library re-parses the same way). If it does not fit, the caller must cap harder.
        const payload = packed.segments.join(";");
        let batchId = -1;
        try {
            batchId = Number(holo.call("blockBatchSetNear", playerName, payload, radius, invisible, false));
        } catch {
            batchId = -1;
        }
        if (!Number.isFinite(batchId) || batchId < 0) {
            stats.failures++;
            if (!warnedMissing) {
                warnedMissing = true;
                try { logger.warn("[CALL][preview] blockBatchSetNear 拒绝注册（玩家不在线或状态解析失败）"); } catch { }
            }
            return -1;
        }
        stats.registrations++;
        stats.lastCells = cells.length;
        stats.lastBatchId = batchId;
        return batchId;
    },

    /** Drop the registration and destroy every active cube of that player. */
    clear(playerName: string): boolean {
        if (!NearBlocks.available()) return false;
        try {
            // An empty position list still makes the library destroy the cubes and drop the set.
            const ok = holo.call("blockBatchClear", playerName, "");
            return ok !== false;
        } catch {
            return false;
        }
    },

    stats(): { registrations: number; lastCells: number; lastBatchId: number; failures: number } {
        return { ...stats };
    },

    /** Library-side counters (nearSets / active cubes) for the debug output. */
    libraryStats(): { near: string; raw: string } {
        try {
            const raw = String(holo.call("blockBatchStats") ?? "");
            const m = /nearSets=(\d+)/.exec(raw);
            return { near: m == null ? "?" : m[1], raw };
        } catch {
            return { near: "?", raw: "" };
        }
    },
};

export default NearBlocks;
