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

export interface ClipboardBox {
    /** Minimum corner over every slice: the clipboard's own origin. */
    min: { x: number; y: number; z: number };
    /** Extent in blocks. */
    size: { x: number; y: number; z: number };
}

/**
 * Minimum corner + extent of a clipboard.
 *
 * The extent matters as much as the origin: every transform has to be expressed relative to
 * it (a rotation maps 0..w-1 onto 0..w-1), and using the absolute world coordinates instead
 * is what put the paste wireframe thousands of blocks away from the paste.
 */
export function clipboardBox(complex: Record<string, any>): ClipboardBox | null {
    let minX = Infinity, minY = Infinity, minZ = Infinity;
    let maxX = -Infinity, maxY = -Infinity, maxZ = -Infinity;

    for (const sid of Object.keys(complex ?? {})) {
        const area = complex[sid]?.area;
        if (area?.start == null) continue;
        const ex = area.end?.x ?? area.start.x;
        const ey = area.end?.y ?? area.start.y;
        const ez = area.end?.z ?? area.start.z;
        minX = Math.min(minX, area.start.x, ex);
        minY = Math.min(minY, area.start.y, ey);
        minZ = Math.min(minZ, area.start.z, ez);
        maxX = Math.max(maxX, area.start.x, ex);
        maxY = Math.max(maxY, area.start.y, ey);
        maxZ = Math.max(maxZ, area.start.z, ez);
    }
    if (!Number.isFinite(minX) || !Number.isFinite(maxX)) return null;

    return {
        min: { x: minX, y: minY, z: minZ },
        size: { x: maxX - minX + 1, y: maxY - minY + 1, z: maxZ - minZ + 1 },
    };
}

/** Minimum corner over every slice area (the clipboard's own origin). */
export function clipboardMin(complex: Record<string, any>): { x: number; y: number; z: number } {
    const box = clipboardBox(complex);
    return box == null ? { x: 0, y: 0, z: 0 } : box.min;
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
/**
 * Turn "the probe block landed N cells too high" into a spawn-position correction.
 *
 * This lives here (not in PreviewScene) because that module pulls in LSE globals and cannot be
 * loaded offline, while this is exactly the piece worth pinning down with a unit test.
 */
export function correctionFromLandedCell(landed: number): number {
    return -Number(landed);
}

export function applyYCorrection(baseY: number, correction: number): number {
    return baseY + (Number.isFinite(correction) ? correction : 0);
}
