import Holo from "./Holo";

/**
 * Per-client block overrides (`viewBlock` / `viewClearBlock`).
 *
 * This is HologramLib's "make this cell look like that block, for this player only" API. It is
 * the right primitive for a paste preview:
 *
 *   - no entity is created, so nothing breathes, bobs or spins (item displays are a fake MOB
 *     holding the block, which is why the old ghost swayed like it was in the wind);
 *   - the client renders a REAL block: correct model, correct orientation, correct light;
 *   - the server world, the save file and every other player are untouched.
 *
 * Verified exported by HologramLib 1.33.0 (LL 26.51) and 1.35.0 (LL 26.60).
 */
let setFn: any;
let clearFn: any;

function setter(): any {
    if (setFn === undefined) setFn = Holo.bind("viewBlock") ?? null;
    return setFn;
}

function clearer(): any {
    if (clearFn === undefined) clearFn = Holo.bind("viewClearBlock") ?? null;
    return clearFn;
}

export const BlockView = {
    /**
     * Is the API present? `viewDescribe` answers with a string, so an undefined result means the
     * symbol does not exist (Holo.call returns undefined when the import is unavailable).
     */
    available(): boolean {
        if (!Holo.available()) return false;
        return Holo.call("viewDescribe", "") !== undefined;
    },

    /** true = applied, false = the client does not know that block id. */
    set(playerName: string, x: number, y: number, z: number, blockId: string): boolean {
        const fn = setter();
        if (fn == null) return false;
        try {
            return fn(playerName, x, y, z, blockId) === true;
        } catch {
            // A stale handle after the library was reloaded: drop it and rebind next time.
            setFn = undefined;
            return false;
        }
    },

    /** true = the override was removed; false = there was nothing to remove (or offline). */
    clear(playerName: string, x: number, y: number, z: number): boolean {
        const fn = clearer();
        if (fn == null) return false;
        try {
            return fn(playerName, x, y, z) === true;
        } catch {
            clearFn = undefined;
            return false;
        }
    },

    /** Forget the bound functions (after `/ca debug holo` reloads the library). */
    reset(): void {
        setFn = undefined;
        clearFn = undefined;
    },
};

export default BlockView;
