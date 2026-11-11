/**
 * Walk-through cubes, managed by CALL itself.
 *
 * The library's \`blockBatchSetNear\` looks like a one-call solution, but it re-sends the whole window
 * through the BATCH path, and a state string cannot carry block states: measured,
 * \`blockFakeResolve("minecraft:oak_stairs[weirdo_direction=2]")\` returns the SAME network id as
 * direction 0, while \`blockFakeResolveNbt\` honours it. That is why a registered staircase came back
 * with the default facing, and why block-entity cells lost their contents (the batch re-send only
 * carries a block).
 *
 * So the transition is done per cell with the primitives we already trust:
 *   enter: \`blockFakeClear\` the cell + \`sulfurCreate\` an invisible cube holding the block item
 *   leave: \`sulfurDestroy\` the cube + re-send the cell through the ORIGINAL path (SNBT / block entity)
 *
 * The cube renders the item it holds, so an invisible cube looks exactly like the block - and it has
 * no client-side collision, which is the whole point.
 */
import HoloCompat from "./HoloCompat";
import holo from "./Holo";

const stats = { cubes: 0, creates: 0, destroys: 0, failures: 0 };

export const NearBlocks = {
    available(): boolean {
        return HoloCompat.status().caps.nearPass === true;
    },

    reason(): string {
        return NearBlocks.available() ? "" : "库缺少 sulfurCreate/sulfurDestroy";
    },

    /**
     * Turn one cell into a passable cube. Returns the display id, or 0 on failure.
     *
     * \`blockItem\` is the block's id ("minecraft:oak_stairs"); the cube shows its block model.
     */
    enter(playerName: string, x: number, y: number, z: number, dimid: number, blockItem: string, invisible: boolean): number {
        if (!NearBlocks.available()) return 0;
        try {
            holo.call("blockFakeClear", playerName, x, y, z);
            const id = Number(holo.call("sulfurCreate",
                x + 0.5, y, z + 0.5, dimid, blockItem, 1, 0, "", "", invisible));
            if (Number.isFinite(id) && id >= 0) {
                stats.creates++;
                stats.cubes++;
                return id;
            }
            stats.failures++;
            return 0;
        } catch {
            stats.failures++;
            return 0;
        }
    },

    /** Remove one cube (the caller re-sends the real fake block afterwards). */
    leave(id: number): boolean {
        if (!NearBlocks.available() || id < 0) return false;
        try {
            const ok = holo.call("sulfurDestroy", id) !== false;
            if (ok) {
                stats.destroys++;
                stats.cubes = Math.max(0, stats.cubes - 1);
            } else {
                stats.failures++;
            }
            return ok;
        } catch {
            stats.failures++;
            return false;
        }
    },

    /** Destroy every cube we still track (teardown / dimension change). */
    clearAll(ids: number[]): number {
        let n = 0;
        for (const id of ids) if (NearBlocks.leave(id)) n++;
        return n;
    },

    stats(): { cubes: number; creates: number; destroys: number; failures: number } {
        return { ...stats };
    },
};

export default NearBlocks;
