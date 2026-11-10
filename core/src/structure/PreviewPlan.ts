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
    /** Block entity SNBT for this cell, when the clipboard has one (see SurfaceExtract). */
    snbt?: string;
    /** Block SNBT for cells whose block carries states (resolved through blockFakeResolveNbt). */
    blockSnbt?: string;
}

export type PlanOp =
    | { op: "set"; key: string; x: number; y: number; z: number; id: string; snbt?: string; blockSnbt?: string }
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
        out.set(key, {
            key, x, y, z, id: block.id,
            ...(block.snbt ? { snbt: block.snbt } : {}),
            ...(block.blockSnbt ? { blockSnbt: block.blockSnbt } : {}),
        });
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
        ops.push({
            op: "set", key, x: cell.x, y: cell.y, z: cell.z, id: cell.id,
            ...(cell.snbt ? { snbt: cell.snbt } : {}),
            ...(cell.blockSnbt ? { blockSnbt: cell.blockSnbt } : {}),
        });
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

/** Surface blocks grouped by their CLIPBOARD column, so the index survives a rotation. */

/**
 * Reusable buffers for window queries.
 *
 * The preview re-runs the query on every rotate and while the player walks, so allocating a few
 * typed arrays per call shows up. They grow to the largest window seen and are reused.
 */
const PreviewPlanScratch = {
    dist: new Int32Array(0),
    dx: new Int32Array(0),
    dz: new Int32Array(0),
    dy: new Int32Array(0),
    id: [] as string[],
    counts: new Uint32Array(0),
    orderBuf: new Int32Array(0),

    reserve(n: number): number {
        if (n < this.dist.length) return n;
        const size = Math.max(1024, Math.ceil(n * 1.6));
        const dist = new Int32Array(size);
        dist.set(this.dist);
        this.dist = dist;
        const dx = new Int32Array(size);
        dx.set(this.dx);
        this.dx = dx;
        const dz = new Int32Array(size);
        dz.set(this.dz);
        this.dz = dz;
        const dy = new Int32Array(size);
        dy.set(this.dy);
        this.dy = dy;
        this.id.length = size;
        return n;
    },

    /** Indices of the first entries, sorted by ascending distance (counting sort). */
    order(total: number, range: number): Int32Array {
        if (this.counts.length < range) this.counts = new Uint32Array(range);
        else this.counts.fill(0, 0, range);
        if (this.orderBuf.length < total) this.orderBuf = new Int32Array(Math.ceil(total * 1.3));

        const counts = this.counts;
        const dist = this.dist;
        for (let i = 0; i < total; i++) counts[dist[i]]++;

        let acc = 0;
        for (let i = 0; i < range; i++) {
            const c = counts[i];
            counts[i] = acc;
            acc += c;
        }

        const order = this.orderBuf;
        for (let i = 0; i < total; i++) order[counts[dist[i]]++] = i;
        return order;
    },
};
export interface SourceGrid {
    /** key = (dx >> 4) + "," + (dz >> 4); values keep the clipboard offsets. */
    buckets: Map<string, PreviewBlock[]>;
    total: number;
}

/** Bucket key of a clipboard column. `>> 4` floors negatives correctly (-1 -> -1). */
export function bucketKey(dx: number, dz: number): string {
    return (dx >> 4) + "," + (dz >> 4);
}

/**
 * Index the surface blocks by CLIPBOARD column - deliberately transform-free.
 *
 * The preview used to index by WORLD column, which meant every rotate/move had to walk all
 * surface blocks again (26ms at 48k blocks, 65ms at 120k). The clipboard side of the mapping
 * never changes, so it is built once and rotating only re-runs the (window-sized) query.
 */
export function sourceGrid(blocks: PreviewBlock[]): SourceGrid {
    const buckets = new Map<string, PreviewBlock[]>();
    for (const block of blocks) {
        const key = bucketKey(block.dx, block.dz);
        const list = buckets.get(key);
        if (list == null) buckets.set(key, [block]);
        else list.push(block);
    }
    return { buckets, total: blocks.length };
}

export interface WindowQuery {
    anchor: { x: number; y: number; z: number };
    size: [number, number, number];
    degrees: Degrees;
    mirror: MirrorMode;
    pivot: PivotMode;
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
 * The window cube is mapped back to clipboard space (`untransformCell`), so only the source
 * buckets that can contribute are visited. Cell coordinates - and their string keys - are
 * built for the cells that are actually drawn, not for the whole building.
 */
export function windowFromSource(
    grids: SourceGrid | SourceGrid[],
    q: WindowQuery
): { cells: PlannedCell[]; inWindow: number } {
    const list = Array.isArray(grids) ? grids : [grids];
    const r = Math.max(1, Math.floor(q.radius));
    const cx = Math.floor(q.center.x);
    const cy = Math.floor(q.center.y);
    const cz = Math.floor(q.center.z);
    const w = q.size[0];
    const d = q.size[2];

    // ---- world box of the window, with the look-direction slab if requested
    let minX = cx - r, maxX = cx + r;
    const minY = cy - r, maxY = cy + r;
    let minZ = cz - r, maxZ = cz + r;
    if (q.prefetch != null && q.prefetch.amount > 0) {
        const { dx, dz, amount } = q.prefetch;
        if (dx > 0) maxX += amount;
        else if (dx < 0) minX -= amount;
        if (dz > 0) maxZ += amount;
        else if (dz < 0) minZ -= amount;
    }

    // ---- same box in clipboard space (rotation is rigid, so the corners bound it)
    let srcMinX = Infinity, srcMaxX = -Infinity, srcMinZ = Infinity, srcMaxZ = -Infinity;
    const ax = q.anchor.x;
    const az = q.anchor.z;
    for (const [wx, wz] of [[minX, minZ], [maxX, minZ], [minX, maxZ], [maxX, maxZ]]) {
        const [sx, sz] = untransformCell(wx - ax, wz - az, w, d, q.degrees, q.mirror, q.pivot);
        if (sx < srcMinX) srcMinX = sx;
        if (sx > srcMaxX) srcMaxX = sx;
        if (sz < srcMinZ) srcMinZ = sz;
        if (sz > srcMaxZ) srcMaxZ = sz;
    }

    // ---- collect candidates, then order them by distance with a COUNTING SORT.
    // Comparison-sorting 48k objects cost 16ms on its own - more than everything else in this
    // function. Distances are small non-negative integers (the window bounds them), so a
    // counting sort is O(candidates) and allocates nothing per call after warm-up.
    const reach = r + (q.prefetch != null && q.prefetch.amount > 0 ? Math.floor(q.prefetch.amount) : 0);
    const maxDist = 3 * reach * reach + 1;
    const bx0 = srcMinX >> 4, bx1 = srcMaxX >> 4;
    const bz0 = srcMinZ >> 4, bz1 = srcMaxZ >> 4;

    let total = 0;
    for (const grid of list) {
        for (let bx = bx0; bx <= bx1; bx++) {
            for (let bz = bz0; bz <= bz1; bz++) {
                const bucket = grid.buckets.get(bx + "," + bz);
                if (bucket == null) continue;
                for (const block of bucket) {
                    if (block.dx < srcMinX || block.dx > srcMaxX) continue;
                    if (block.dz < srcMinZ || block.dz > srcMaxZ) continue;
                    const [ox, oz] = cellOffset(block.dx, block.dz, w, d, q.degrees, q.mirror, q.pivot);
                    const x = ax + ox;
                    const y = q.anchor.y + block.dy;
                    const z = az + oz;
                    if (x < minX || x > maxX) continue;
                    if (y < minY || y > maxY) continue;
                    if (z < minZ || z > maxZ) continue;
                    const ddx = x - cx, ddy = y - cy, ddz = z - cz;
                    const dist = ddx * ddx + ddy * ddy + ddz * ddz;
                    if (dist >= maxDist) continue;
                    const slot = PreviewPlanScratch.reserve(total);
                    PreviewPlanScratch.dist[slot] = dist;
                    PreviewPlanScratch.dx[slot] = block.dx;
                    PreviewPlanScratch.dz[slot] = block.dz;
                    PreviewPlanScratch.dy[slot] = block.dy;
                    PreviewPlanScratch.id[slot] = block.id;
                    total++;
                }
            }
        }
    }

    const budget = Math.max(1, Math.floor(q.budget));
    const take = Math.min(total, budget);
    const cells: PlannedCell[] = new Array(take);
    if (total > 0) {
        const order = PreviewPlanScratch.order(total, maxDist);
        for (let i = 0; i < take; i++) {
            const slot = order[i];
            const [ox, oz] = cellOffset(
                PreviewPlanScratch.dx[slot], PreviewPlanScratch.dz[slot], w, d, q.degrees, q.mirror, q.pivot
            );
            const x = ax + ox;
            const y = q.anchor.y + PreviewPlanScratch.dy[slot];
            const z = az + oz;
            cells[i] = { key: cellKey(x, y, z), x, y, z, id: PreviewPlanScratch.id[slot] };
        }
    }
    return { cells, inWindow: total };
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
