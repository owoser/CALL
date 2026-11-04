import Config from "../common/Config";
import Area3 from "../common/Area3";
import { Pos3, Vec3Tuple } from "../common/Pos3";
import { shouldWriteTarget } from "../game/SafeArgs";

/**
 * Structure placement helpers.
 *
 * WHAT THE PLATFORM ACTUALLY DOES (verified with tests/live on LL 26.51.x / LSE 0.22.x)
 * -----------------------------------------------------------------------------------
 *   mc.getStructure(pos1, pos2)   works, NBT is correct.
 *   mc.setStructure(nbt, pos)     with engine-captured NBT: silently does nothing.
 *                                 with a hand-built template: ACCESS VIOLATION inside
 *                                 StructureTemplate::placeInWorld (0xC0000005, null
 *                                 deref) -> the server process dies and every player is
 *                                 dropped. This is the crash 1.6.1 users hit whenever
 *                                 they pasted or generated a shape.
 *   /structure save|load|delete    works.
 *
 * Two placement mechanisms are therefore used, and neither touches mc.setStructure:
 *
 *   1. Structures that already live in the game's structure store are placed with
 *      /structure load - see NBTService (copy / paste / undo / save / load).
 *   2. Structures that only exist as NBT in memory (generated shapes, imported files)
 *      are written block by block with Block.setNbt() - see placeByBlocks().
 *
 * The old +1 offset hack is gone: /structure load places the template's minimum corner
 * exactly on the given position, and placeByBlocks() does the same.
 */

// ---------------------------------------------------------------- mirrors / rotation
/** Mirror name from the command layer -> integer used by the engine API. */
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

/** Mirror name -> token accepted by /structure load. */
export function mirrorToToken(mirror: string | number | null | undefined): string {
    switch (mirrorToIndex(mirror)) {
        case 1:
            return "x";
        case 2:
            return "z";
        case 3:
            return "xz";
        default:
            return "none";
    }
}

/** Rotation in degrees -> integer steps (0..4). */
export function rotationToIndex(degrees: string | number | null | undefined): number {
    const n = typeof degrees === "number" ? degrees : parseFloat(String(degrees ?? "0"));
    if (!Number.isFinite(n)) return 0;
    const steps = Math.round((((n % 360) + 360) % 360) / 90);
    return steps > 4 ? 0 : steps;
}

/** Rotation in degrees -> token accepted by /structure load. */
export function rotationToToken(degrees: string | number | null | undefined): string {
    return rotationToIndex(degrees) * 90 + "_degrees";
}

// --------------------------------------------------------------------- geometry
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
        new Pos3(Math.floor(pos.x), Math.floor(pos.y), Math.floor(pos.z), pos.dimid),
        new Pos3(Math.floor(pos.x) + sx - 1, Math.floor(pos.y) + sy - 1, Math.floor(pos.z) + sz - 1, pos.dimid)
    );
}

import { StructureLayout, parseStructureLayout, transformLayout, TransformOptions } from "../io/NbtCodec";

// --------------------------------------------------- per-block placement (bytes)
/**
 * Linear index of a cell inside block_indices.
 *
 * THIS IS THE FORMAT SPEC, NOT A GUESS. From the Bedrock .mcstructure documentation
 * (tryashtar's "Bedrock mcstructure file format", wiki.bedrock.dev/nbt/mcstructure):
 *
 *   "Entries proceed in ZYX order from the lowest corner to the highest one."
 *   index -> coords:  (i / SZ / SY, i / SZ % SY, i % SZ)
 *   coords -> index:  SZ*SY*X + SZ*Y + Z
 *
 * i.e. Z varies fastest, then Y, then X.
 *
 * 3.0.0 used "Y varies fastest" --- i.e. `(x * sz + z) * sy + y` --- which transposed
 * every pasted structure: a wall standing in the XY plane came out lying flat in the XZ
 * plane. It slipped through testing because the only copy/paste test used a 4x2x4 region
 * (so sx === sz, hiding the swap) with markers on index 0 and index N-1, which map to
 * themselves under any axis permutation.
 */
export { cellIndex, cellCoords } from "../io/StructureOrder";
import { cellCoords } from "../io/StructureOrder";

function blockNbtOf(entry: { name: string; states: Record<string, any>; version: number }): NbtCompound {
    const states = entry.states && typeof entry.states === "object" ? entry.states : {};
    return new NbtCompound({
        name: new NbtString(entry.name || "minecraft:air"),
        states: new NbtCompound(states),
        version: new NbtInt(entry.version || 0),
    });
}

function maxBlocks(restore = false): number {
    const key = restore ? "maxRestoreBlocks" : "maxPlaceBlocks";
    const fallback = restore ? 2000000 : 40000;
    const n = Number(Config.get(Config.GLOBAL, key, fallback));
    return Number.isFinite(n) && n > 0 ? n : fallback;
}

export interface PlaceOptions extends TransformOptions {
    /**
     * Restore path (undo / redo / paste / load): use `maxRestoreBlocks` instead of the much
     * smaller `maxPlaceBlocks` that guards shape generation.
     */
    restore?: boolean;
    /** Called after every batch so a long restore can show progress. */
    onProgress?: (done: number, total: number, written: number) => void;
    /**
     * Write palette entries that are air.
     *
     * MUST be true for paste / load / undo (the result has to match the snapshot cell for
     * cell) and false for generated shapes (a shape pack uses air for "do not generate",
     * so writing it would carve holes in the terrain).
     *
     * Index -1 is different from air: the spec says it means "no block here, leave
     * whatever is in the world", so those cells are always skipped.
     */
    writeAir?: boolean;
}

/**
 * Write a parsed structure into the world with its minimum corner at `pos`,
 * yielding to the scheduler every `batch` blocks.
 * @returns how many blocks were written
 */
export async function placeLayoutAsync(
    layout: StructureLayout,
    pos: Pos3,
    batch = 600,
    options: PlaceOptions = {}
): Promise<number> {
    const [sx, sy, sz] = layout.size;
    const total = sx * sy * sz;
    const limit = maxBlocks(options.restore === true);
    if (total > limit) {
        throw new Error(
            "structure too large to place block by block (" + total + " > " + limit + ", key "
            + (options.restore === true ? "maxRestoreBlocks" : "maxPlaceBlocks") + ")"
        );
    }

    const cache = new Map<number, NbtCompound | null>();
    const baseX = Math.floor(pos.x);
    const baseY = Math.floor(pos.y);
    const baseZ = Math.floor(pos.z);
    const writeAir = options.writeAir === true;
    let written = 0;
    let skipped = 0;
    let sinceYield = 0;

    for (let i = 0; i < total && i < layout.indices.length; i++) {
        const paletteIndex = layout.indices[i];
        // -1 = "no block", leave the world alone.
        if (paletteIndex == null || paletteIndex < 0) continue;

        let blockNbt = cache.get(paletteIndex);
        if (blockNbt === undefined) {
            const entry = layout.palette[paletteIndex];
            blockNbt = entry ? blockNbtOf(entry) : null;
            cache.set(paletteIndex, blockNbt);
        }
        if (blockNbt == null) continue;

        const name = String(blockNbt.getData("name") ?? "");
        const isAir = name === "" || name === "minecraft:air" || name === "minecraft:void_air" || name === "minecraft:cave_air";
        if (name === "minecraft:structure_void") continue;
        if (isAir && !writeAir) continue;

        const { x, y, z } = cellCoords(i, sz, sy);
        const targetX = baseX + x;
        const targetY = baseY + y;
        const targetZ = baseZ + z;

        try {
            const block = mc.getBlock(targetX, targetY, targetZ, pos.dimid);
            if (block == null) {
                // unloaded chunk: nothing to compare against, nothing we can write
            } else {
                const entry = layout.palette[paletteIndex];
                const hasStates = entry?.states != null && Object.keys(entry.states).length > 0;
                if (!shouldWriteTarget(block.type, name, hasStates)) {
                    skipped++;
                } else {
                    try {
                        block.setNbt(blockNbt);
                        written++;
                    } catch {
                        // the game rejected this block (e.g. an invalid state)
                    }
                }
            }
        } catch {
            // access failed; skip
        }

        if (++sinceYield >= batch) {
            sinceYield = 0;
            if (options.onProgress != null) {
                try {
                    options.onProgress(i + 1, total, written);
                } catch {
                    // ignore
                }
            }
            await new Promise((r) => setTimeout(r, 0));
        }
    }
    return written;
}

/**
 * Place NBT bytes (a .mcstructure image) at `pos`.
 * @param options mirror / rotation plus air handling
 */
export async function placeBytesAsync(
    bytes: Buffer,
    pos: Pos3,
    batch = 600,
    options: PlaceOptions = {}
): Promise<number> {
    let layout = parseStructureLayout(bytes);
    if (options.mirror != null || options.rotation != null) {
        layout = transformLayout(layout, { mirror: options.mirror, rotation: options.rotation });
    }
    return placeLayoutAsync(layout, pos, batch, options);
}

/** Place an in-memory NbtCompound (shape templates) at `pos`. */
export async function placeNbtAsync(
    nbt: NbtCompound,
    pos: Pos3,
    batch = 600,
    options: PlaceOptions = {}
): Promise<number> {
    return placeBytesAsync(Buffer.from(new Uint8Array(nbt.toBinaryNBT() as ArrayBuffer)), pos, batch, options);
}
