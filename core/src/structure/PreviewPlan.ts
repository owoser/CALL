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
import { Degrees, MirrorMode, PivotMode, cellOffset, pivotShift } from "./Rotate";
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

// ------------------------------------------------------------------- streaming

/** Cells grouped by their 16x16 XZ column, so a window query never scans everything. */
export interface PlanGrid {
    buckets: Map<string, PlannedCell[]>;
    total: number;
}

/** Bucket key of a world column. `>> 4` floors negatives correctly (-1 -> -1). */
export function bucketKey(x: number, z: number): string {
    return (x >> 4) + "," + (z >> 4);
}

export function planGrid(
    anchor: { x: number; y: number; z: number },
    size: [number, number, number],
    degrees: Degrees,
    mirror: MirrorMode,
    pivot: PivotMode,
    blocks: PreviewBlock[]
): PlanGrid {
    const buckets = new Map<string, PlannedCell[]>();
    let total = 0;
    for (const cell of planCells(anchor, size, degrees, mirror, pivot, blocks).values()) {
        const key = bucketKey(cell.x, cell.z);
        const list = buckets.get(key);
        if (list == null) buckets.set(key, [cell]);
        else list.push(cell);
        total++;
    }
    return { buckets, total };
}

export interface WindowOptions {
    center: { x: number; y: number; z: number };
    /** Chebyshev radius in blocks (the window is a cube). */
    radius: number;
    /** Draw at most this many cells, nearest first. */
    budget: number;
    /** Optional extra slab on one horizontal side (look-direction prefetch). */
    prefetch?: { dx: number; dz: number; amount: number };
}

/**
 * Cells inside the player's window, nearest first, cropped to the budget.
 *
 * Only the 16x16 buckets that overlap the cube are visited, so the cost tracks the window
 * (a few hundred buckets at most) instead of the size of the building.
 */
export function windowCells(
    grids: PlanGrid | PlanGrid[],
    opts: WindowOptions
): { cells: PlannedCell[]; inWindow: number } {
    const list = Array.isArray(grids) ? grids : [grids];
    const r = Math.max(1, Math.floor(opts.radius));
    const cx = Math.floor(opts.center.x);
    const cy = Math.floor(opts.center.y);
    const cz = Math.floor(opts.center.z);

    let minX = cx - r, maxX = cx + r;
    const minY = cy - r, maxY = cy + r;
    let minZ = cz - r, maxZ = cz + r;
    if (opts.prefetch != null && opts.prefetch.amount > 0) {
        const { dx, dz, amount } = opts.prefetch;
        if (dx > 0) maxX += amount;
        else if (dx < 0) minX -= amount;
        if (dz > 0) maxZ += amount;
        else if (dz < 0) minZ -= amount;
    }

    const hits: Array<{ cell: PlannedCell; d: number }> = [];
    const bx0 = minX >> 4, bx1 = maxX >> 4;
    const bz0 = minZ >> 4, bz1 = maxZ >> 4;
    for (const grid of list) {
        for (let bx = bx0; bx <= bx1; bx++) {
            for (let bz = bz0; bz <= bz1; bz++) {
                const bucket = grid.buckets.get(bx + "," + bz);
                if (bucket == null) continue;
                for (const cell of bucket) {
                    if (cell.x < minX || cell.x > maxX) continue;
                    if (cell.z < minZ || cell.z > maxZ) continue;
                    if (cell.y < minY || cell.y > maxY) continue;
                    const dx = cell.x - cx, dy = cell.y - cy, dz = cell.z - cz;
                    hits.push({ cell, d: dx * dx + dy * dy + dz * dz });
                }
            }
        }
    }

    hits.sort((a, b) => a.d - b.d);
    const budget = Math.max(1, Math.floor(opts.budget));
    const cells = hits.length > budget ? hits.slice(0, budget).map((h) => h.cell) : hits.map((h) => h.cell);
    return { cells, inWindow: hits.length };
}

/**
 * Inverse of `cellOffset` for the horizontal axes: world offset -> clipboard offset.
 *
 * Needed to translate the player's window back into clipboard coordinates, so lazy mode can
 * work out which 64-slices it has to parse.
 */
export function untransformCell(
    wx: number,
    wz: number,
    w: number,
    d: number,
    degrees: Degrees,
    mirror: MirrorMode,
    pivot: PivotMode
): [number, number] {
    const [sx, sz] = pivotShift(w, d, degrees, mirror, pivot);
    const rx = wx - sx;
    const rz = wz - sz;

    let nx = rx;
    let nz = rz;
    if (degrees === 90) {
        nz = d - 1 - rx;
        nx = rz;
    } else if (degrees === 180) {
        nx = w - 1 - rx;
        nz = d - 1 - rz;
    } else if (degrees === 270) {
        nz = rx;
        nx = w - 1 - rz;
    }

    const mirrorX = mirror === "x" || mirror === "xz";
    const mirrorZ = mirror === "z" || mirror === "xz";
    const dx = mirrorX ? w - 1 - nx : nx;
    const dz = mirrorZ ? d - 1 - nz : nz;
    return [dx, dz];
}

/**
 * Coarse shell: every `step`-th surface block, capped.
 *
 * Drawn outside the window budget so the whole building still reads as a shape when you stand
 * back. Cells inside the window are also in the detail set, and the diff drops the duplicate.
 */
export function sampleOutline(
    blocks: PreviewBlock[],
    anchor: { x: number; y: number; z: number },
    size: [number, number, number],
    degrees: Degrees,
    mirror: MirrorMode,
    pivot: PivotMode,
    step: number,
    cap: number
): PlannedCell[] {
    const stride = Math.max(1, Math.floor(step));
    const limit = Math.max(0, Math.floor(cap));
    if (limit === 0) return [];

    const out: PlannedCell[] = [];
    for (let i = 0; i < blocks.length && out.length < limit; i += stride) {
        const block = blocks[i];
        const [dx, dz] = cellOffset(block.dx, block.dz, size[0], size[2], degrees, mirror, pivot);
        const x = Math.floor(anchor.x + dx);
        const y = Math.floor(anchor.y + block.dy);
        const z = Math.floor(anchor.z + dz);
        out.push({ key: cellKey(x, y, z), x, y, z, id: block.id });
    }
    return out;
}
