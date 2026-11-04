/**
 * Linear index <-> block coordinate conversion for Bedrock structure files.
 *
 * THIS IS THE FORMAT SPEC, NOT A CONVENTION.
 * From the .mcstructure documentation (tryashtar's "Bedrock mcstructure file format",
 * wiki.bedrock.dev/nbt/mcstructure):
 *
 *   "Entries proceed in ZYX order from the lowest corner to the highest one."
 *   index -> coords:  (i / SZ / SY, i / SZ % SY, i % SZ)
 *   coords -> index:  SZ*SY*X + SZ*Y + Z
 *
 * i.e. Z varies fastest, then Y, then X.
 *
 * 3.0.0 used "Y varies fastest" --- `(x*sz + z)*sy + y` --- which transposed every pasted
 * structure: a wall standing in the XY plane came out lying flat in the XZ plane, and a
 * flat selection became a tall box. It survived testing because the only copy/paste test
 * used a 4x2x4 region (sx === sz hides the swap) with markers on the first and last index
 * (both invariant under any axis permutation).
 *
 * This module is deliberately free of any engine dependency so it can be unit tested
 * offline.
 */

/** @param sz size along Z @param sy size along Y */
export function cellIndex(x: number, y: number, z: number, sz: number, sy: number): number {
    return sz * sy * x + sz * y + z;
}

/** Inverse of cellIndex(). */
export function cellCoords(i: number, sz: number, sy: number): { x: number; y: number; z: number } {
    const plane = sz * sy;
    const x = Math.floor(i / plane);
    const rest = i - x * plane;
    const y = Math.floor(rest / sz);
    const z = rest - y * sz;
    return { x, y, z };
}

/** Total number of cells for a size triple. */
export function cellCount(size: [number, number, number]): number {
    return Math.max(0, size[0] | 0) * Math.max(0, size[1] | 0) * Math.max(0, size[2] | 0);
}
