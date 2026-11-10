/**
 * What the current selection area is worth.
 *
 * A selection is stored as two corners; when the player changes dimension the two corners end up in
 * different dimensions. That used to THROW ("two points are not in the same dimension"), which broke
 * not only selecting but also cancelling the selection (both go through `hasSetArea`). A stale
 * selection is not an error - it is simply no selection any more, so it is reported as `mixed` and
 * the caller clears it.
 */

export interface SelectionCorners {
    start?: { dimid?: any } | null;
    end?: { dimid?: any } | null;
}

export type SelectionState = "none" | "valid" | "mixed";

export function selectionState(area: SelectionCorners | null | undefined): SelectionState {
    const start = area?.start;
    const end = area?.end;
    const a = start?.dimid;
    const b = end?.dimid;
    const hasA = a != null && Number(a) >= 0;
    const hasB = b != null && Number(b) >= 0;
    if (!hasA || !hasB) return "none";
    return Number(a) === Number(b) ? "valid" : "mixed";
}

export default { selectionState };
