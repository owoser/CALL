import Holo from "./Holo";

/**
 * Fake-block preview through HologramLib's item display domain.
 *
 * Pose rules come straight from the library docs (item-display page):
 *
 *   - block mode pose is offY="-4", rotX="180", rotZ="180" (model units / degrees);
 *   - the position is the block's BOTTOM centre, i.e. y is an integer and x/z are +0.5
 *     (the doc's own example is seamless(100.5, 66, -200.5, ...));
 *   - block mode also applies a SECOND transform, controlled by itemDisplaySetExtend
 *     (defaults scale=1, rx=-90, ry=0) - left untouched on purpose;
 *   - creation goes through itemDisplayCreateSeamless so mode/viewDistance/visiblePlayer are
 *     set in the same packet. Creating first and calling SetMode afterwards respawns the
 *     display and can discard the pose we just set.
 *
 * One display = one block, client side only: no server entity, nothing written to the world,
 * re-sent automatically on reconnect, gone on restart.
 */

export interface DisplaySpec {
    /** Block BOTTOM centre: x/z at +0.5, y at the block's own level. */
    x: number;
    y: number;
    z: number;
    dim: number;
    blockId: string;
    /** Model scale, see previewBlockScale. */
    scale: string;
    /** Y rotation in degrees. */
    rotY?: number;
    /** offY in MODEL units (16 units = 1 block); the documented block pose is "-4". */
    offsetY?: string;
    /** Visibility radius; <= 0 = unlimited. */
    viewDistance?: number;
    /** Only this player (realName) sees it. */
    onlyPlayer?: string;
    /** 2 = 3D block (what we want), 1 = flat item, -1 = library default. */
    mode?: number;
    /**
     * Send the block-mode second transform explicitly. Default true (extend scale 1, rx 0,
     * ry 0); pass false to keep the library defaults (scale 1, rx -90) for A/B testing.
     */
    extend?: boolean;
}

const BLOCK_MODE = 2;
/** Documented block pose. */
const BLOCK_OFF_Y = "-4";
const BLOCK_ROT_X = "180";
const BLOCK_ROT_Z = "180";

export const ItemDisplay = {
    available(): boolean {
        return Holo.available();
    },

    /** Create one display; returns its id or a negative number. */
    create(spec: DisplaySpec): number {
        const id = Number(
            Holo.call(
                "itemDisplayCreateSeamless",
                spec.x, spec.y, spec.z,
                spec.dim,
                spec.blockId,
                0,                                  // aux
                "0", spec.offsetY ?? BLOCK_OFF_Y, "0",   // model unit offset
                BLOCK_ROT_X, String(spec.rotY ?? 0), BLOCK_ROT_Z,
                spec.scale,
                spec.mode ?? BLOCK_MODE,
                spec.viewDistance != null && spec.viewDistance > 0 ? spec.viewDistance : -1,
                spec.onlyPlayer ?? ""
            )
        );
        if (!(id > 0)) return -1;

        // Block mode applies a SECOND transform on top of the main one, and its default rx is
        // -90 degrees. Left alone, every block is rotated a quarter turn about the model
        // origin and ends up several blocks away from its anchor - which is exactly what the
        // preview did before. Pin it to "no extra transform".
        if (spec.extend == null || spec.extend === true) {
            Holo.call("itemDisplaySetExtend", id, "1", "0", "0");
        }

        // A preview must never swallow player clicks; the default is already "no hitbox",
        // but be explicit so a future library default cannot change that under us.
        Holo.call("itemDisplaySetHitbox", id, 0, 0);
        return id;
    },

    /** Move an existing display (used when the preview is rotated instead of rebuilt). */
    move(id: number, x: number, y: number, z: number, rotY: number): void {
        Holo.call("itemDisplaySetPosition", id, x, y, z);
        Holo.call("itemDisplaySetRotation", id, BLOCK_ROT_X, String(rotY), BLOCK_ROT_Z);
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
};

export default ItemDisplay;
