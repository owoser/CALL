import { Pos3 } from "../common/Pos3";

/**
 * Rotation / mirror maths for the paste preview.
 *
 * A copied clipboard is a set of slices, each with its own area. Rotating the paste means
 * (a) telling the block placer to rotate and (b) using the ROTATED footprint for the
 * destination snapshot and the wireframe - otherwise undo would cover the wrong blocks.
 *
 * Angles are clockwise, 0 / 90 / 180 / 270, applied before the mirror.
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

/** Union of every slice's destination area, after rotation and mirror. */
export function rotatedUnion(
    complex: Record<string, any>,
    targetPos: Pos3,
    degrees: Degrees,
    mirror: MirrorMode
): Box | null {
    let box: Box | null = null;

    for (const sid of Object.keys(complex ?? {})) {
        const area = complex[sid]?.area;
        if (area?.start == null || area?.end == null) continue;

        const x0 = Math.min(area.start.x, area.end.x);
        const x1 = Math.max(area.start.x, area.end.x);
        const z0 = Math.min(area.start.z, area.end.z);
        const z1 = Math.max(area.start.z, area.end.z);
        const y0 = Math.min(area.start.y, area.end.y);
        const y1 = Math.max(area.start.y, area.end.y);

        // transform the two opposite corners and keep the min/max
        const corners: Array<[number, number]> = [
            transformOffset(x0, z0, degrees, mirror),
            transformOffset(x1, z1, degrees, mirror),
        ];
        const ax = targetPos.x + Math.min(corners[0][0], corners[1][0]);
        const bx = targetPos.x + Math.max(corners[0][0], corners[1][0]);
        const az = targetPos.z + Math.min(corners[0][1], corners[1][1]);
        const bz = targetPos.z + Math.max(corners[0][1], corners[1][1]);
        const ay = targetPos.y + y0;
        const by = targetPos.y + y1;

        if (box == null) box = { x1: ax, y1: ay, z1: az, x2: bx, y2: by, z2: bz };
        else {
            box.x1 = Math.min(box.x1, ax); box.x2 = Math.max(box.x2, bx);
            box.y1 = Math.min(box.y1, ay); box.y2 = Math.max(box.y2, by);
            box.z1 = Math.min(box.z1, az); box.z2 = Math.max(box.z2, bz);
        }
    }
    return box;
}

/** Same footprint, expressed as Areas for the undo snapshot. */
export function rotatedTargetAreas(
    complex: Record<string, any>,
    targetPos: Pos3,
    degrees: Degrees,
    mirror: MirrorMode
): Array<{ start: { x: number; y: number; z: number }; end: { x: number; y: number; z: number } }> {
    const out: Array<{ start: any; end: any }> = [];
    for (const sid of Object.keys(complex ?? {})) {
        const area = complex[sid]?.area;
        if (area?.start == null || area?.end == null) continue;
        const x0 = Math.min(area.start.x, area.end.x);
        const x1 = Math.max(area.start.x, area.end.x);
        const z0 = Math.min(area.start.z, area.end.z);
        const z1 = Math.max(area.start.z, area.end.z);
        const y0 = Math.min(area.start.y, area.end.y);
        const y1 = Math.max(area.start.y, area.end.y);
        const corners: Array<[number, number]> = [
            transformOffset(x0, z0, degrees, mirror),
            transformOffset(x1, z1, degrees, mirror),
        ];
        out.push({
            start: {
                x: targetPos.x + Math.min(corners[0][0], corners[1][0]),
                y: targetPos.y + y0,
                z: targetPos.z + Math.min(corners[0][1], corners[1][1]),
            },
            end: {
                x: targetPos.x + Math.max(corners[0][0], corners[1][0]),
                y: targetPos.y + y1,
                z: targetPos.z + Math.max(corners[0][1], corners[1][1]),
            },
        });
    }
    return out;
}

export function degreesName(degrees: Degrees): string {
    return degrees + "_degrees";
}
