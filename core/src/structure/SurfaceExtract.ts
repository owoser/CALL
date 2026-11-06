import { StructureLayout } from "../io/NbtCodec";
import { Degrees, MirrorMode, transformOffset } from "./Rotate";

/**
 * Turns copied structure slices into the list of blocks a preview has to draw.
 *
 * Two problems to solve, both pure so they can be tested without a server:
 *
 *   1. INTERIOR CULLING. A solid 20x20x20 build is 8000 blocks but only ~2400 of them can
 *      ever be seen. Every block with all six neighbours occupied is dropped - the client
 *      never has to draw it.
 *
 *   2. BUDGET. One display per block is not free (HologramLib's author warns about exactly
 *      this), so the result is truncated at a cap and the caller falls back to a wireframe.
 */

export interface SliceInput {
    /** Where this slice's (0,0,0) lands, relative to the paste anchor. */
    origin: [number, number, number];
    layout: StructureLayout;
}

export interface PreviewBlock {
    /** Offset from the paste anchor, already rotated/mirrored. */
    dx: number;
    dy: number;
    dz: number;
    id: string;
}

export interface ExtractResult {
    blocks: PreviewBlock[];
    /** Blocks kept after the transform, before truncation. */
    visible: number;
    /** Cells that were scanned (non-air) before culling. */
    solid: number;
    truncated: boolean;
}

const AIR = new Set([
    "minecraft:air",
    "minecraft:cave_air",
    "minecraft:void_air",
    "minecraft:structure_void",
    "",
]);

function key(x: number, y: number, z: number): string {
    return x + "," + y + "," + z;
}

/** ZYX order, same convention as the rest of the codebase (see StructureOrder). */
export function extractSurface(
    slices: SliceInput[],
    degrees: Degrees,
    mirror: MirrorMode,
    maxBlocks: number
): ExtractResult {
    const solid = new Map<string, string>();

    for (const slice of slices) {
        const layout = slice.layout;
        if (layout == null || layout.size == null) continue;
        const [sx, sy, sz] = layout.size;
        if (!(sx > 0 && sy > 0 && sz > 0)) continue;

        const total = sx * sy * sz;
        for (let i = 0; i < total && i < layout.indices.length; i++) {
            const pi = layout.indices[i];
            if (!(pi >= 0)) continue; // -1 = empty cell
            const entry = layout.palette[pi];
            if (entry == null) continue;
            if (AIR.has(entry.name)) continue;

            const z = Math.floor(i / (sx * sy));
            const rest = i - z * sx * sy;
            const y = Math.floor(rest / sx);
            const x = rest - y * sx;

            solid.set(
                key(slice.origin[0] + x, slice.origin[1] + y, slice.origin[2] + z),
                entry.name
            );
        }
    }

    // ---- culling: keep only blocks that touch the outside world
    const kept: PreviewBlock[] = [];
    const neighbours: Array<[number, number, number]> = [
        [1, 0, 0], [-1, 0, 0],
        [0, 1, 0], [0, -1, 0],
        [0, 0, 1], [0, 0, -1],
    ];

    for (const [k, name] of solid) {
        const parts = k.split(",");
        const sx = Number(parts[0]);
        const sy = Number(parts[1]);
        const sz = Number(parts[2]);

        let exposed = false;
        for (const [ox, oy, oz] of neighbours) {
            if (!solid.has(key(sx + ox, sy + oy, sz + oz))) {
                exposed = true;
                break;
            }
        }
        if (!exposed) continue;

        const [dx, dz] = transformOffset(sx, sz, degrees, mirror);
        kept.push({ dx, dy: sy, dz, id: name });
    }

    // Deterministic order, top layers first: if the budget forces a cut, the player still
    // sees the part of the build that is actually visible from above.
    kept.sort((a, b) => (b.dy - a.dy) || (a.dx - b.dx) || (a.dz - b.dz));

    const truncated = kept.length > maxBlocks;
    const blocks = truncated ? kept.slice(0, maxBlocks) : kept;

    return { blocks, visible: kept.length, solid: solid.size, truncated };
}
