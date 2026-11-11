/**
 * Pick the cells around the player that may turn into passable sulfur cubes.
 *
 * The library keeps ONE near set per player and REPLACES it on every call (it destroys the active
 * cubes first), so the caller has to hand it the complete window each time - and the window has to
 * stay small: the packed payload travels through an LSE string argument (~16 KB) and the library
 * scans every registered cell every 4 ticks.
 *
 * Cells that carry block-entity data are NEVER selected: when the player leaves the radius the
 * library re-sends the plain block only, which would silently wipe a chest's contents or a sign's
 * text on the client.
 */

export interface NearCandidate {
    /** Cell key (x,y,z). */
    key: string;
    x: number;
    y: number;
    z: number;
    /** Block id / state string, exactly what the batch call expects. */
    id: string;
}

export interface NearWindowOptions {
    /** Convert cells within this many blocks. 0 disables the feature. */
    radius: number;
    /** Hard cap on how many cells may be registered at once. */
    maxCells: number;
    /** Byte budget for the packed payload (the library splits packets, the ARGUMENT does not). */
    maxBytes: number;
    /** Cell keys that must stay solid (block entities, SNBT payloads). */
    exclude?: Set<string>;
    /**
     * Allow cells whose descriptor carries STATES (stairs, slabs, ...).
     *
     * Default false: the near layer re-sends those cells through the batch path, and a batch
     * descriptor that differs at all from what the per-cell path drew shows up as a scrambled
     * orientation (the reported "stairs face the wrong way while walking through"). Plain blocks
     * only, until that path is made byte-identical.
     */
    allowStates?: boolean;
}

export interface NearWindowResult {
    cells: NearCandidate[];
    /** Candidates that were inside the radius but did not fit the caps. */
    dropped: number;
    /** Bytes the packed payload of `cells` will take (approximate, same rule as packCells). */
    bytes: number;
}

/** Rough packed size of one cell: "x y z state" plus the separator. */
function entrySize(cell: NearCandidate, first: boolean): number {
    return String(cell.x).length + String(cell.y).length + String(cell.z).length + cell.id.length + 3 + (first ? 0 : 1);
}

/** Distance from the player's feet to the cell centre, squared. */
function distanceSq(cell: NearCandidate, px: number, py: number, pz: number): number {
    const dx = px - (cell.x + 0.5);
    const dy = py - cell.y;
    const dz = pz - (cell.z + 0.5);
    return dx * dx + dy * dy + dz * dz;
}

/**
 * The cells to register, nearest first, capped by count and by payload bytes.
 *
 * A small margin is added to the radius so the library's own hysteresis (it releases at
 * radius * 1.3) still has a registered cell to work with right at the boundary.
 */
export function selectNearCells(
    cells: Iterable<NearCandidate>,
    player: { x: number; y: number; z: number },
    options: NearWindowOptions
): NearWindowResult {
    const radius = Number(options.radius);
    if (!Number.isFinite(radius) || radius <= 0) return { cells: [], dropped: 0, bytes: 0 };

    const limit = Math.max(1, Math.floor(Number(options.maxCells) || 1));
    const maxBytes = Math.max(256, Math.floor(Number(options.maxBytes) || 256));
    const reach = radius + 1;
    const reachSq = reach * reach;
    const exclude = options.exclude ?? new Set<string>();
    const allowStates = options.allowStates === true;

    const inside: Array<{ cell: NearCandidate; d2: number }> = [];
    for (const cell of cells) {
        if (cell == null || cell.id === "" || cell.id.indexOf(";") >= 0) continue;
        if (exclude.has(cell.key)) continue;
        if (!allowStates && cell.id.indexOf("[") >= 0) continue;
        const d2 = distanceSq(cell, player.x, player.y, player.z);
        if (!Number.isFinite(d2) || d2 > reachSq) continue;
        inside.push({ cell, d2 });
    }
    inside.sort((a, b) => a.d2 - b.d2);

    const picked: NearCandidate[] = [];
    let bytes = 0;
    for (const item of inside) {
        if (picked.length >= limit) break;
        const size = entrySize(item.cell, picked.length === 0);
        if (bytes + size > maxBytes) break;   // nearest first, so the rest are simply farther
        picked.push(item.cell);
        bytes += size;
    }
    return { cells: picked, dropped: inside.length - picked.length, bytes };
}

export default { selectNearCells };
