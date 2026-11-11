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

const stats = { cubes: 0, creates: 0, destroys: 0, failures: 0, blockMode: 0, fallback: 0 };

/**
 * Blocks in block mode are drawn at roughly half a block by the client, so 1.0 (the library's C++
 * default) still looks small; the caller passes previewNearScale to compensate.
 */
export const NearBlocks = {
    available(): boolean {
        return HoloCompat.status().caps.nearPass === true;
    },

    reason(): string {
        const caps = HoloCompat.status().caps;
        if (!caps.nearPass) return "库缺少 itemDisplayCreateAdvanced/itemDisplayDestroy";
        if (!caps.nearBlockMode) return "库缺少 itemDisplaySetMode（无法用方块模式）";
        return "";
    },

    /** Block mode needs setMode + setScale; without them the item display renders as a flat item. */
    blockModeAvailable(): boolean {
        const caps = HoloCompat.status().caps;
        return caps.nearPass === true && caps.nearBlockMode === true;
    },

    /**
     * Turn one cell into a passable visual block.
     *
     * Item display in BLOCK mode is the only primitive that renders a full block AND takes a scale
     * that actually applies: a sulfur cube's held item stays item-sized no matter what
     * (\`sulfurSetScale\` returns true, the visible block does not change - measured).
     */
    enter(playerName: string, x: number, y: number, z: number, dimid: number, blockItem: string, invisible: boolean, scale = 1, yOffset = 8): number {
        if (!NearBlocks.available()) return 0;
        try {
            holo.call("blockFakeClear", playerName, x, y, z);
            const wanted = Number.isFinite(Number(scale)) && Number(scale) > 0 ? Number(scale) : 1;
            // Offsets are MODEL units (1/16 block). The display's pivot is the MODEL CENTRE, so a
            // block placed at (x, y) renders half a block low; +8 = +0.5 block puts it back into the
            // cell. (The library's own default is offsetY "-4" for a floating item, which is what made
            // the walk-through block sit visibly below the real block.)
            const lift = Number.isFinite(Number(yOffset)) ? Number(yOffset) : 8;
            const id = Number(holo.call("itemDisplayCreateAdvanced",
                x + 0.5, y, z + 0.5, dimid, blockItem, 0,
                "0", String(lift), "0", "0", "0", "0", String(wanted)));
            if (!Number.isFinite(id) || id < 0) {
                stats.failures++;
                return 0;
            }
            if (NearBlocks.blockModeAvailable()) {
                try { holo.call("itemDisplaySetMode", id, 2); stats.blockMode++; } catch { /* keep auto */ }
                try { holo.call("itemDisplaySetScale", id, String(wanted)); } catch { /* default */ }
            }
            try { holo.call("itemDisplaySetVisiblePlayer", id, playerName); } catch { /* everyone */ }
            stats.creates++;
            stats.cubes++;
            return id;
        } catch {
            stats.failures++;
            return 0;
        }
    },

    /** Remove one walk-through visual (the caller re-sends the real fake block afterwards). */
    leave(id: number): boolean {
        if (!NearBlocks.available() || id < 0) return false;
        try {
            const ok = holo.call("itemDisplayDestroy", id) !== false;
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

    /** Destroy every visual we still track (teardown / dimension change). */
    clearAll(ids: number[]): number {
        let n = 0;
        for (const id of ids) if (NearBlocks.leave(id)) n++;
        return n;
    },

    stats(): { cubes: number; creates: number; destroys: number; failures: number; blockMode: number } {
        return { ...stats };
    },
};

export default NearBlocks;
