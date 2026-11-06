/**
 * Pure planning helpers for the block preview.
 *
 * The preview draws with viewBlock(): the library tells ONE client "at this cell show that
 * block" - no entity, no model pose, no vertical fudge. Everything the ghost needs is therefore
 * a set of integer cells plus their block id, and the only interesting operation is the DIFF
 * against what is already applied (rotating four times must end with zero packets, and a
 * rebuild must not clear cells it is about to draw again).
 *
 * Kept free of engine globals so the diff can be unit tested.
 */
import { Degrees, MirrorMode, PivotMode, cellOffset } from "./Rotate";
import type { PreviewBlock } from "./SurfaceExtract";

export interface PlannedCell {
    key: string;
    x: number;
    y: number;
    z: number;
    id: string;
}

export type PlanOp =
    | { op: "set"; key: string; x: number; y: number; z: number; id: string }
    | { op: "clear"; key: string; x: number; y: number; z: number };

export function cellKey(x: number, y: number, z: number): string {
    return x + "," + y + "," + z;
}

/**
 * Where every surface block lands, as integer cells.
 *
 * The offset comes from cellOffset(), the same mapping the paste writes with, so the ghost and
 * the result cannot disagree. Two blocks can never share a cell (a structure has one block per
 * cell), but the map makes that harmless anyway.
 */
export function planCells(
    anchor: { x: number; y: number; z: number },
    size: [number, number, number],
    degrees: Degrees,
    mirror: MirrorMode,
    pivot: PivotMode,
    blocks: PreviewBlock[]
): Map<string, PlannedCell> {
    const out = new Map<string, PlannedCell>();
    for (const block of blocks) {
        const [dx, dz] = cellOffset(block.dx, block.dz, size[0], size[2], degrees, mirror, pivot);
        const x = Math.floor(anchor.x + dx);
        const y = Math.floor(anchor.y + block.dy);
        const z = Math.floor(anchor.z + dz);
        const key = cellKey(x, y, z);
        out.set(key, { key, x, y, z, id: block.id });
    }
    return out;
}

/**
 * What has to be sent to go from `applied` (cell -> block id) to `desired`.
 *
 * - a cell whose id differs is simply overwritten (viewBlock replaces it);
 * - a cell that is no longer part of the box is cleared;
 * - cells that already match produce nothing, which is what makes rotating back to 0 degrees
 *   free instead of a full re-send.
 */
export function diffPlacement(
    applied: Map<string, string>,
    desired: Map<string, PlannedCell>
): PlanOp[] {
    const ops: PlanOp[] = [];
    for (const [key, cell] of desired) {
        if (applied.get(key) === cell.id) continue;
        ops.push({ op: "set", key, x: cell.x, y: cell.y, z: cell.z, id: cell.id });
    }
    for (const key of applied.keys()) {
        if (desired.has(key)) continue;
        const parts = key.split(",");
        ops.push({ op: "clear", key, x: Number(parts[0]), y: Number(parts[1]), z: Number(parts[2]) });
    }
    return ops;
}

/** Cells that are applied but no longer wanted (used when a scene is dropped). */
export function appliedCells(applied: Map<string, string>): Array<[number, number, number]> {
    const out: Array<[number, number, number]> = [];
    for (const key of applied.keys()) {
        const parts = key.split(",");
        out.push([Number(parts[0]), Number(parts[1]), Number(parts[2])]);
    }
    return out;
}
