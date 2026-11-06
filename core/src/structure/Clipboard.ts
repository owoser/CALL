import Constant from "../temp/Constant";

/**
 * Clipboard geometry helpers.
 *
 * A copy larger than MAX_LENGTH in X or Z is stored as several slices named
 * `<structid>_<ix>_<iz>`. The chunk index is part of the file name, which is how the capture
 * laid them out (Structure.getAreas()), so the offsets can be derived from the name alone.
 *
 * Why this matters: StructureService.load() used to call Area3.relative() on every slice,
 * which zeroes the slice origin - so a multi-slice paste stacked every slice on the same
 * spot. The preview needs the real offsets to agree with what paste actually does.
 */

export const SLICE_LENGTH = Constant.STRUCTURE.MAX_LENGTH;

const SLICE_RE = /_(\d+)_(\d+)$/;

/** Chunk offset of a slice id, in blocks. */
export function sliceOrigin(sid: string): [number, number, number] {
    const m = SLICE_RE.exec(String(sid));
    if (m == null) return [0, 0, 0];
    return [Number(m[1]) * SLICE_LENGTH, 0, Number(m[2]) * SLICE_LENGTH];
}

export interface SimpleBox {
    x1: number;
    y1: number;
    z1: number;
    x2: number;
    y2: number;
    z2: number;
}

/** Minimum corner over every slice area (the clipboard's own origin). */
export function clipboardMin(complex: Record<string, any>): { x: number; y: number; z: number } {
    let x = Infinity, y = Infinity, z = Infinity;
    for (const sid of Object.keys(complex ?? {})) {
        const area = complex[sid]?.area;
        if (area?.start == null) continue;
        x = Math.min(x, area.start.x, area.end?.x ?? area.start.x);
        y = Math.min(y, area.start.y, area.end?.y ?? area.start.y);
        z = Math.min(z, area.start.z, area.end?.z ?? area.start.z);
    }
    if (!Number.isFinite(x)) return { x: 0, y: 0, z: 0 };
    return { x, y, z };
}

/** Union box of the destination, given the anchor and the (already known) size per slice. */
export function blocksBox(blocks: Array<{ dx: number; dy: number; dz: number }>, anchor: { x: number; y: number; z: number }): SimpleBox | null {
    if (blocks.length === 0) return null;
    let x1 = Infinity, y1 = Infinity, z1 = Infinity, x2 = -Infinity, y2 = -Infinity, z2 = -Infinity;
    for (const b of blocks) {
        x1 = Math.min(x1, b.dx); x2 = Math.max(x2, b.dx);
        y1 = Math.min(y1, b.dy); y2 = Math.max(y2, b.dy);
        z1 = Math.min(z1, b.dz); z2 = Math.max(z2, b.dz);
    }
    return {
        x1: anchor.x + x1, y1: anchor.y + y1, z1: anchor.z + z1,
        x2: anchor.x + x2, y2: anchor.y + y2, z2: anchor.z + z2,
    };
}
