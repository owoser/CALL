/**
 * When a teardown may send its restore packets.
 *
 * A cancelled preview can still have batches queued inside HologramLib. Restoring while that queue
 * is draining means the queued batches land AFTER the restore and draw the fake blocks straight
 * back - the "cancel left half a structure on screen" report. So the restore waits, with a hard
 * deadline so a stuck queue can never hang a cancel.
 *
 * Kept pure (and separate) so the decision is unit-testable without a server or a client.
 */

export interface DrainGateInput {
    /** Packets still queued in the library (FakeBlocks.stats().queue). */
    queued: number;
    /** Wall-clock deadline for waiting; null/undefined = no deadline. */
    deadline?: number | null;
    /** Current time (injected for tests). */
    now: number;
}

export interface DrainGateResult {
    /** true = keep waiting, do not restore yet. */
    wait: boolean;
    /** true = the deadline expired while the queue was still busy. */
    expired: boolean;
}

/**
 * Decide whether a teardown task should wait one more tick.
 *
 * - queue empty -> never wait;
 * - queue busy and the deadline has passed -> stop waiting (one warn) and restore anyway;
 * - otherwise -> wait.
 */
export function shouldWaitForDrain(input: DrainGateInput): DrainGateResult {
    const queued = Number(input?.queued ?? 0);
    if (!(queued > 0)) return { wait: false, expired: false };
    const deadline = input?.deadline == null ? null : Number(input.deadline);
    const now = Number(input?.now ?? Date.now());
    if (deadline != null && Number.isFinite(deadline) && now >= deadline) {
        return { wait: false, expired: true };
    }
    return { wait: true, expired: false };
}

/**
 * May a rebuild inherit the previous scene's ledger?
 *
 * Inheriting is what keeps a nudged/rotated preview clean: the cells it already drew stay tracked,
 * so the next diff clears the ones that left the footprint instead of forgetting them. It is only
 * valid for the SAME player in the SAME dimension - otherwise those cells must be restored, because
 * nothing about the new scene can clear them.
 */
export function canInheritLedger(
    previous: { playerName: string; dimid: number } | null | undefined,
    next: { playerName: string; dimid: number }
): boolean {
    if (previous == null) return false;
    const a = String(previous.playerName ?? "");
    const b = String(next?.playerName ?? "");
    if (a === "" || b === "" || a !== b) return false;
    return Number(previous.dimid ?? 0) === Number(next?.dimid ?? 0);
}

export default { shouldWaitForDrain, canInheritLedger };
