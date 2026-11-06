import Holo from "./Holo";

/**
 * Fake-block preview through HologramLib's item display domain.
 *
 * The library spawns these on the CLIENT only - no server entity, nothing written to the
 * world, re-sent automatically when a player reconnects, gone when the server restarts. That
 * is exactly what a paste preview needs: show the blocks without touching anything.
 *
 * One display = one block. Everything here is defensive: when the library is missing every
 * call returns a negative id / false and the caller falls back to the wireframe.
 */

export interface DisplaySpec {
    /** World position of the block CENTRE. */
    x: number;
    y: number;
    z: number;
    dim: number;
    /** Block/item id, e.g. "minecraft:stone". */
    blockId: string;
    /** Model scale, see previewBlockScale (calibrated to match one block). */
    scale: string;
    /** Y rotation in degrees. */
    rotY?: number;
    /** Visibility radius; <= 0 = unlimited. */
    viewDistance?: number;
    /** Only this player (realName) sees it. */
    onlyPlayer?: string;
    /** 2 = render as a 3D block (what we want), 1 = flat item, 0 = auto. */
    mode?: number;
}

const BLOCK_MODE = 2;

export const ItemDisplay = {
    available(): boolean {
        return Holo.available();
    },

    /** Create one display; returns its id or a negative number. */
    create(spec: DisplaySpec): number {
        const id = Number(
            Holo.call(
                "itemDisplayCreateFull",
                spec.x, spec.y, spec.z,
                spec.dim,
                spec.blockId,
                0,                 // aux
                "0", "0", "0",     // model offset
                "0", String(spec.rotY ?? 0), "0",
                spec.scale,
                "",                // snbt
                false              // glint
            )
        );
        if (!(id > 0)) return -1;

        // Force the 3D block renderer: the same item id can otherwise come out as a flat
        // sprite, which would look like a paper cut-out in the world.
        Holo.call("itemDisplaySetMode", id, spec.mode ?? BLOCK_MODE);
        // Never clickable / never a hitbox: a preview must not swallow player clicks.
        Holo.call("itemDisplaySetHitbox", id, 0, 0);
        if (spec.viewDistance != null) {
            Holo.call("itemDisplaySetViewDistance", id, spec.viewDistance);
        }
        if (spec.onlyPlayer != null && spec.onlyPlayer !== "") {
            Holo.call("itemDisplaySetVisiblePlayer", id, spec.onlyPlayer);
        }
        return id;
    },

    /** Move an existing display (used when the preview is rotated instead of rebuilt). */
    move(id: number, x: number, y: number, z: number, rotY: number): void {
        Holo.call("itemDisplaySetPosition", id, x, y, z);
        Holo.call("itemDisplaySetRotation", id, "0", String(rotY), "0");
    },

    destroy(id: number): void {
        if (id > 0) Holo.call("itemDisplayDestroy", id);
    },

    /**
     * Destroy a batch.
     *
     * Deliberately never uses itemDisplayDestroyAll: HologramLib is shared, and that call
     * would wipe displays created by other plugins or other CALL features.
     */
    destroyAll(ids: number[]): void {
        for (const id of ids) ItemDisplay.destroy(id);
    },

    exists(id: number): boolean {
        return Holo.call("itemDisplayExists", id) === true;
    },

    setVisiblePlayer(id: number, playerName: string): void {
        Holo.call("itemDisplaySetVisiblePlayer", id, playerName);
    },
};

export default ItemDisplay;
