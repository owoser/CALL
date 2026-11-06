import { Pos3 } from "../common/Pos3";
import { clipboardBox } from "./Clipboard";

/**
 * Rotation / mirror maths for the paste preview.
 *
 * A copied clipboard is a set of slices, each with its own area. Rotating the paste means
 * (a) telling the block placer to rotate and (b) using the ROTATED footprint for the
 * destination snapshot and the wireframe - otherwise undo would cover the wrong blocks.
 *
 * THE ANCHOR IS THE MINIMUM CORNER OF THE DESTINATION BOX, and it is always the clicked
 * block. Rotating never flips the box to the negative side of the anchor: the pattern inside
 * the box turns, the box stays put (90/270 swap its width and depth, as a rotation must).
 *
 * transformCell() below is the ONLY mapping allowed to decide where a cell lands: its
 * rotation table is copied verbatim from NbtCodec.transformLayout(), because that is what
 * actually writes the blocks. A second set of maths here (the pre-3.4.1 Transform3 code)
 * shifted every rotated paste by (edge - 1) blocks, which is exactly the bug users reported
 * as "预览和粘贴不一致 / 转动后粘贴偏移".
 */

export type MirrorMode = "none" | "x" | "z" | "xz";
export type Degrees = 0 | 90 | 180 | 270;

export interface Box {
    x1: number;
    y1: number;
    z1: number;
    x2: number;
    y2: number;
    z2: number;
}

/** Rotate an offset around the paste origin (XZ plane only; Y is untouched). */
export function rotateOffset(dx: number, dz: number, degrees: Degrees): [number, number] {
    switch (degrees) {
        case 90:
            return [0 - dz, dx];
        case 180:
            return [0 - dx, 0 - dz];
        case 270:
            return [dz, 0 - dx];
        default:
            return [dx, dz];
    }
}

export function mirrorOffset(dx: number, dz: number, mirror: MirrorMode): [number, number] {
    switch (mirror) {
        case "x":
            return [0 - dx, dz];
        case "z":
            return [dx, 0 - dz];
        case "xz":
            return [0 - dx, 0 - dz];
        default:
            return [dx, dz];
    }
}

export function transformOffset(
    dx: number,
    dz: number,
    degrees: Degrees,
    mirror: MirrorMode
): [number, number] {
    const [mx, mz] = mirrorOffset(dx, dz, mirror);
    return rotateOffset(mx, mz, degrees);
}

/**
 * Size of the destination box. 90/270 swap the horizontal axes; Y is never touched.
 */
export function transformedSize(w: number, d: number, degrees: Degrees): [number, number] {
    return degrees === 90 || degrees === 270 ? [d, w] : [w, d];
}

/**
 * Map a clipboard-relative cell to its destination-relative cell.
 *
 * This is NbtCodec.transformLayout()'s table, applied to the WHOLE clipboard box instead of
 * to one slice. Mirror runs first (x / z / xz flip that axis), then the rotation:
 *
 *   90  -> [d - 1 - nz, nx]
 *   180 -> [w - 1 - nx, d - 1 - nz]
 *   270 -> [nz, w - 1 - nx]
 *
 * The result always lands inside [0..W'-1] x [0..D'-1], i.e. the rotated box grows from the
 * anchor instead of jumping into negative coordinates. Preview, wireframe, undo snapshot and
 * the per-slice paste positions all use this single mapping - keeping them in agreement is
 * the whole point of the function.
 */
export function transformCell(
    dx: number,
    dz: number,
    w: number,
    d: number,
    degrees: Degrees,
    mirror: MirrorMode
): [number, number] {
    const mirrorX = mirror === "x" || mirror === "xz";
    const mirrorZ = mirror === "z" || mirror === "xz";
    const nx = mirrorX ? w - 1 - dx : dx;
    const nz = mirrorZ ? d - 1 - dz : dz;

    switch (degrees) {
        case 90:
            return [d - 1 - nz, nx];
        case 180:
            return [w - 1 - nx, d - 1 - nz];
        case 270:
            return [nz, w - 1 - nx];
        default:
            return [nx, nz];
    }
}

/**
 * Destination minimum corner of one 64-block slice, relative to the anchor.
 *
 * A slice is rotated on its OWN (placeBytesAsync calls transformLayout per slice), so the
 * corner it has to be placed at is the minimum of its two transformed opposite corners.
 * Taking transformCell(slice start) alone is wrong for anything but 0 deg: mirroring or a
 * quarter turn maps the slice's minimum corner to its maximum one, which is how a 100-block
 * selection used to come out with its slices shuffled.
 */
export function sliceDestMin(
    x0: number,
    z0: number,
    sw: number,
    sd: number,
    w: number,
    d: number,
    degrees: Degrees,
    mirror: MirrorMode
): [number, number] {
    const a = transformCell(x0, z0, w, d, degrees, mirror);
    const b = transformCell(x0 + sw - 1, z0 + sd - 1, w, d, degrees, mirror);
    return [Math.min(a[0], b[0]), Math.min(a[1], b[1])];
}

/**
 * The destination box: the rotated clipboard's footprint, growing from the anchor.
 *
 * The old version transformed the slices' ABSOLUTE world coordinates and added the anchor on
 * top, so a clipboard copied 1200 blocks away produced a wireframe (and an undo snapshot)
 * thousands of blocks off, with Y counted twice. Everything here is relative to the
 * clipboard's own minimum corner, which is what PreviewScene.gather() already does.
 */
export function rotatedUnion(
    complex: Record<string, any>,
    targetPos: Pos3,
    degrees: Degrees,
    mirror: MirrorMode
): Box | null {
    const clipboard = clipboardBox(complex);
    if (clipboard == null) return null;

    const [w, d] = transformedSize(clipboard.size.x, clipboard.size.z, degrees);
    return {
        x1: targetPos.x,
        y1: targetPos.y,
        z1: targetPos.z,
        x2: targetPos.x + w - 1,
        y2: targetPos.y + clipboard.size.y - 1,
        z2: targetPos.z + d - 1,
    };
}

/**
 * Same footprint, expressed as one Area per slice for the undo snapshot.
 *
 * The snapshot has to cover exactly the cells the paste writes, or /ca undo restores a
 * different region than the one that was changed.
 */
export function rotatedTargetAreas(
    complex: Record<string, any>,
    targetPos: Pos3,
    degrees: Degrees,
    mirror: MirrorMode
): Array<{ start: { x: number; y: number; z: number }; end: { x: number; y: number; z: number } }> {
    const out: Array<{ start: any; end: any }> = [];
    const clipboard = clipboardBox(complex);
    if (clipboard == null) return out;

    for (const sid of Object.keys(complex ?? {})) {
        const area = complex[sid]?.area;
        if (area?.start == null || area?.end == null) continue;

        const x0 = Math.min(area.start.x, area.end.x) - clipboard.min.x;
        const x1 = Math.max(area.start.x, area.end.x) - clipboard.min.x;
        const z0 = Math.min(area.start.z, area.end.z) - clipboard.min.z;
        const z1 = Math.max(area.start.z, area.end.z) - clipboard.min.z;
        const y0 = Math.min(area.start.y, area.end.y) - clipboard.min.y;
        const y1 = Math.max(area.start.y, area.end.y) - clipboard.min.y;

        const sw = x1 - x0 + 1;
        const sd = z1 - z0 + 1;
        const [dx, dz] = sliceDestMin(
            x0, z0, sw, sd,
            clipboard.size.x, clipboard.size.z,
            degrees, mirror
        );
        const [ow, od] = transformedSize(sw, sd, degrees);

        out.push({
            start: {
                x: targetPos.x + dx,
                y: targetPos.y + y0,
                z: targetPos.z + dz,
            },
            end: {
                x: targetPos.x + dx + ow - 1,
                y: targetPos.y + y1,
                z: targetPos.z + dz + od - 1,
            },
        });
    }
    return out;
}

export function degreesName(degrees: Degrees): string {
    return degrees + "_degrees";
}
