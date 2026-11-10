import Holo from "./Holo";

/**
 * Per-client block overrides - the paste preview's renderer.
 *
 * Two library families can do this, and they are NOT equivalent:
 *
 *   blockFakeSet / blockFakeClear   (HologramLib 1.36.0+)  accepts a STATE string
 *       'minecraft:oak_stairs[waterlogged=true,upside_down_bit=false,weirdo_direction=2]'
 *       and renders the real block with those states. This is what a building preview needs:
 *       stairs keep their facing, fences their connections, waterlogged blocks their water.
 *
 *   viewBlock / viewClearBlock      (older, name only)
 *       resolves the id through the block registry and drops any [states] - it still returns
 *       true, so a state-heavy preview silently renders default orientations. Kept only as a
 *       fallback for libraries older than 1.36.0; the startup log says which one is in use.
 *
 * Either way no entity is created, so nothing breathes, bobs or spins (item displays are a fake
 * MOB holding the block, which is why the old ghost swayed like it was in the wind), and the
 * server world, the save file and every other player are untouched.
 */
type Fn = (...args: any[]) => any;

let fakeSet: Fn | null | undefined;
let fakeClear: Fn | null | undefined;
let viewSet: Fn | null | undefined;
let viewClear: Fn | null | undefined;
let mode: "blockFake" | "viewBlock" | "none" | null = null;
let warnedStates = false;

/** `minecraft:stone_stairs["a"=1]` -> `minecraft:stone_stairs`. */
function bareName(id: string): string {
    const i = id.indexOf("[");
    return i < 0 ? id : id.slice(0, i);
}

function detect(): "blockFake" | "viewBlock" | "none" {
    if (mode != null) return mode;
    fakeSet = Holo.bind("blockFakeSet");
    fakeClear = Holo.bind("blockFakeClear");
    viewSet = Holo.bind("viewBlock");
    viewClear = Holo.bind("viewClearBlock");
    if (fakeSet != null && fakeClear != null) mode = "blockFake";
    else if (viewSet != null && viewClear != null) mode = "viewBlock";
    else mode = "none";
    return mode;
}

function log(message: string, warn: boolean): void {
    try {
        if (warn) logger.warn("[CALL][view] " + message);
        else logger.info("[CALL][view] " + message);
    } catch {
        // logger unavailable (unit tests)
    }
}

export const BlockView = {
    /** Which API the preview actually uses: `blockFake` (states intact) or `viewBlock` (name only). */
    backend(): "blockFake" | "viewBlock" | "none" {
        return detect();
    },

    /** True when block states survive the round trip (i.e. the preview can be trusted visually). */
    statesExact(): boolean {
        return detect() === "blockFake";
    },

    available(): boolean {
        if (!Holo.available()) return false;
        return detect() !== "none";
    },

    /**
     * Apply a per-client block override.
     *
     * `blockId` carries states (`name["k"=v,...]`) and is passed through verbatim to
     * `blockFakeSet`, which parses it. There is deliberately NO "strip the states and retry"
     * path: a state string the library refuses now reports `false` (the caller keeps the cell
     * for the next pump) instead of pretending success with a default-orientation block.
     */
    set(playerName: string, x: number, y: number, z: number, blockId: string): boolean {
        if (!Holo.available()) return false;
        const kind = detect();
        const id = String(blockId ?? "");
        if (id === "") return false;

        if (kind === "blockFake") {
            try {
                return fakeSet!(playerName, x, y, z, id) === true;
            } catch {
                mode = null;
                fakeSet = undefined;
                return false;
            }
        }
        if (kind === "viewBlock") {
            if (!warnedStates && id.indexOf("[") >= 0) {
                warnedStates = true;
                log("当前 HologramLib 只提供 viewBlock（按方块名查基态），预览里的楼梯朝向等状态会丢失；升级到 26.60.8 / 26.51.11 可恢复", true);
            }
            try {
                return viewSet!(playerName, x, y, z, bareName(id)) === true;
            } catch {
                mode = null;
                viewSet = undefined;
                return false;
            }
        }
        return false;
    },

    /**
     * Resolve a block SNBT (`{name,states,version}`) to its network id.
     *
     * This is the ONLY resolver that honours block states: HologramLib's state-STRING resolver
     * returns the base id (measured on 26.60.8 — `weirdo_direction=2` and `=0` give the same
     * number), because it looks the block up by name. -1 when unavailable or unparsable.
     */
    resolveId(blockSnbt: string): number {
        const text = String(blockSnbt ?? "");
        if (text === "") return -1;
        const fn = Holo.bind("blockFakeResolveNbt");
        if (fn == null) return -1;
        try {
            const n = fn(text);
            return typeof n === "number" && isFinite(n) && n >= 0 ? n : -1;
        } catch {
            return -1;
        }
    },

    /** Override one cell by NETWORK ID (`viewBlockById`, 450-export builds): states included. */
    setById(playerName: string, x: number, y: number, z: number, networkId: number): boolean {
        if (!Holo.available() || !(networkId >= 0)) return false;
        const fn = Holo.bind("viewBlockById");
        if (fn == null) return false;
        try {
            return fn(playerName, x, y, z, networkId) === true;
        } catch {
            return false;
        }
    },

    /**
     * Draw one cell from a block's own NBT (`blockFakeSetNbt`, 450-export builds).
     *
     * Unlike `set`, this takes `block.getNbt().toSNBT()` - name, states and version - so the
     * client ends up with exactly the block the server holds. Used before a block entity payload,
     * because the library only attaches BlockActorData to a body it has just drawn.
     */
    setBlockNbt(playerName: string, x: number, y: number, z: number, snbt: string): boolean {
        if (!Holo.available() || String(snbt ?? "") === "") return false;
        const fn = Holo.bind("blockFakeSetNbt");
        if (fn == null) return false;
        try {
            return fn(playerName, x, y, z, snbt) === true;
        } catch {
            return false;
        }
    },

    /**
     * Push one block entity payload to a client (`blockFakeSetBlockEntity`, 450-export builds).
     *
     * The block BODY must already be on the client - the library's own docs are explicit: a
     * BlockActorData packet for a cell the client does not know is ignored. Call this after the
     * set for that cell succeeded.
     */
    setBlockEntity(playerName: string, x: number, y: number, z: number, snbt: string): boolean {
        if (!Holo.available() || String(snbt ?? "") === "") return false;
        const fn = Holo.bind("blockFakeSetBlockEntity");
        if (fn == null) return false;
        try {
            return fn(playerName, x, y, z, snbt) === true;
        } catch {
            return false;
        }
    },

    /** true = the override was removed; false = there was nothing to remove (or offline). */
    clear(playerName: string, x: number, y: number, z: number): boolean {
        if (!Holo.available()) return false;
        const kind = detect();
        if (kind === "blockFake") {
            try {
                return fakeClear!(playerName, x, y, z) === true;
            } catch {
                mode = null;
                fakeClear = undefined;
                return false;
            }
        }
        if (kind === "viewBlock") {
            try {
                return viewClear!(playerName, x, y, z) === true;
            } catch {
                mode = null;
                viewClear = undefined;
                return false;
            }
        }
        return false;
    },

    /** Forget the bound functions (after the library is reinstalled and reloaded). */
    reset(): void {
        mode = null;
        fakeSet = fakeClear = viewSet = viewClear = undefined;
        warnedStates = false;
    },
};

export default BlockView;
