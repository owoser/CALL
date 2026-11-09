/**
 * The ledger that keeps the ghost in sync with what the client actually shows.
 *
 * Fake blocks are client-side: a cell only disappears when the restore packet is sent, and a
 * chunk reload wipes everything. Two rules follow, and both are easy to get wrong:
 *
 *   1. `applied` must never be cleared wholesale - it is the only memory of which cells are on
 *      the client, and losing it means cells that leave the window are never cleared again
 *      (they stay until the player relogs).
 *   2. a clear that could not be confirmed is not done: it moves to `stale` and is retried.
 *
 * Kept pure and separate from the scene so the rules can be tested without a server.
 */

export type CellPos = [number, number, number];

export interface GhostLedger {
    /** key -> block id, the cells the client is showing. */
    applied: Map<string, string>;
    /** key -> position, clears we owe the client. */
    stale: Map<string, CellPos>;
    /** key -> position, everything this preview ever drew (teardown safety net). */
    everApplied: Map<string, CellPos>;
}

export function emptyLedger(): GhostLedger {
    return { applied: new Map(), stale: new Map(), everApplied: new Map() };
}

/** Remember a cell as shown (batched set or per-cell fallback). */
export function markSet(ledger: GhostLedger, key: string, x: number, y: number, z: number, id: string): void {
    ledger.applied.set(key, id);
    ledger.everApplied.set(key, [x, y, z]);
}

/** A confirmed clear: the client no longer shows this cell. */
export function markCleared(ledger: GhostLedger, key: string): void {
    ledger.applied.delete(key);
    ledger.everApplied.delete(key);
}

/**
 * A clear we could not confirm: stop claiming it is applied, but keep it as owed work.
 *
 * `everApplied` keeps it too, so a teardown still restores it even if the retry also fails.
 */
export function markOwed(ledger: GhostLedger, key: string, x: number, y: number, z: number): void {
    ledger.applied.delete(key);
    ledger.stale.set(key, [x, y, z]);
}

/** Take up to `limit` owed clears, removing them from `stale` (the caller re-owes them on failure). */
export function takeOwed(ledger: GhostLedger, limit: number): Array<{ key: string; pos: CellPos }> {
    const out: Array<{ key: string; pos: CellPos }> = [];
    if (!(limit > 0)) return out;
    for (const [key, pos] of ledger.stale) {
        out.push({ key, pos });
        if (out.length >= limit) break;
    }
    for (const entry of out) ledger.stale.delete(entry.key);
    return out;
}

/**
 * Everything a teardown has to restore.
 *
 * The union of applied + stale + everApplied: a superset is harmless (restoring a cell that is
 * already the real block is a no-op packet) while a missing cell is a permanent ghost.
 */
export function teardownCells(ledger: GhostLedger): CellPos[] {
    const union = new Map<string, CellPos>();
    for (const [key, pos] of ledger.everApplied) union.set(key, pos);
    for (const [key, pos] of ledger.stale) union.set(key, pos);
    for (const [key] of ledger.applied) {
        if (!union.has(key)) {
            const parts = key.split(",");
            union.set(key, [Number(parts[0]), Number(parts[1]), Number(parts[2])]);
        }
    }
    return [...union.values()];
}

/** Drop the ledger (after the teardown clear was sent or handed to the cleanup queue). */
export function resetLedger(ledger: GhostLedger): void {
    ledger.applied.clear();
    ledger.stale.clear();
    ledger.everApplied.clear();
}
