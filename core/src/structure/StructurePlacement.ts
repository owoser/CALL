import Config from "../common/Config";
import Area3 from "../common/Area3";
import { Pos3, Vec3Tuple } from "../common/Pos3";

/**
 * The one place that puts a structure back into the world.
 *
 * WHY THIS EXISTS
 * ---------------
 * On LeviLamina 3 / LSE 0.22, `mc.setStructure(nbt, pos, mirror, rotation)` does *not*
 * place the template with its corner at `pos`: the engine calls
 *
 *     placeInWorld(..., pos.getBlockPos() + BlockPos(0, 1, 0), mirror, rotation)
 *
 * (src/legacy/api/StructureAPI.cpp upstream), i.e. everything lands one block too high.
 * CALL used to paper over this in a single call site (`pos.y - 1` in NBTService.load)
 * and not at all in the shape generator, which is why generated shapes and pasted
 * regions did not line up with the selection and why undo restored the wrong box.
 *
 * Centralising the offset here keeps placement, undo bookkeeping and the shape
 * generator consistent, and lets the offset be corrected from config if a future
 * engine build changes it again.
 */

function placeOffset(): number {
    const raw = Config.get(Config.GLOBAL, "structurePlaceOffset", 1);
    const n = Number(raw);
    return Number.isFinite(n) ? n : 0;
}

/** Mirror name used by the command layer -> the integer mc.setStructure expects. */
export function mirrorToIndex(mirror: string | number | null | undefined): 0 | 1 | 2 | 3 {
    if (typeof mirror === "number") {
        return (mirror >= 0 && mirror <= 3 ? mirror : 0) as 0 | 1 | 2 | 3;
    }
    switch (String(mirror ?? "").toLowerCase()) {
        case "x":
        case "1":
            return 1;
        case "z":
        case "2":
            return 2;
        case "xz":
        case "3":
            return 3;
        default:
            return 0;
    }
}

/** Rotation in degrees (0/90/180/270) -> the integer mc.setStructure expects (0..4). */
export function rotationToIndex(degrees: string | number | null | undefined): number {
    const n = typeof degrees === "number" ? degrees : parseFloat(String(degrees ?? "0"));
    if (!Number.isFinite(n)) return 0;
    const steps = Math.round(((n % 360) + 360) % 360 / 90);
    return steps > 4 ? 0 : steps;
}

/**
 * Place `nbt` so that its minimum corner lands exactly on `pos`.
 * @returns whether the engine accepted the placement.
 */
export function placeStructure(
    nbt: NbtCompound,
    pos: Pos3,
    mirror: string | number = 0,
    rotation: string | number = 0
): boolean {
    if (nbt == null) throw new Error("placeStructure: nbt is null");

    const offset = placeOffset();
    const placedY = pos.y - offset;
    let intPos: IntPos;
    try {
        intPos = new IntPos(pos.x, placedY, pos.z, pos.dimid);
    } catch {
        intPos = mc.newIntPos(pos.x, placedY, pos.z, pos.dimid);
    }

    const result = mc.setStructure(
        nbt,
        intPos,
        mirrorToIndex(mirror) as 0 | 1 | 2 | 3,
        rotationToIndex(rotation) as 0 | 1 | 2 | 3
    );
    return result !== false;
}

/**
 * The world region a placement of `size` blocks at `pos` actually covers.
 * Used for undo snapshots - getting this wrong is what made `/ca undo` restore the
 * wrong box after a paste or a generated shape.
 */
export function coveredArea(pos: Pos3, size: Vec3Tuple): Area3 {
    const sx = Math.max(1, Math.round(size[0] || 1));
    const sy = Math.max(1, Math.round(size[1] || 1));
    const sz = Math.max(1, Math.round(size[2] || 1));
    return new Area3(
        new Pos3(pos.x, pos.y, pos.z, pos.dimid),
        new Pos3(pos.x + sx - 1, pos.y + sy - 1, pos.z + sz - 1, pos.dimid)
    );
}
