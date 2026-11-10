/**
 * The dimension a player is in - taken from the PLACE that carries it.
 *
 * LSE exposes `dimid` on `IntPos` / `FloatPos` only; a `Player` object has no such field
 * (types/lse/GameAPI/Basic/IntPos.d.ts, FloatPos.d.ts). Reading `player.$.dimid` therefore yields
 * `undefined`, and every `?? 0` made the whole plugin believe it was in the Overworld: correct
 * where the bug was written, catastrophic in the Nether/End, where a restore then asks the
 * Overworld chunks for Nether coordinates, gets `null` back and silently restores nothing
 * (measured: 可读=0 / 不可读=1471).
 *
 * `-1` means "invalid or unavailable" in LSE, so it is treated as unknown, not as a dimension.
 */

/** True when the value is a usable dimension id (LSE uses -1 for "unavailable"). */
export function isValidDimension(value: any): value is number {
    const n = Number(value);
    return Number.isFinite(n) && n >= 0;
}

/**
 * Best-effort dimension of a player (or of anything carrying a position).
 *
 * Order: the player's own position (the only object that has `dimid`), then the current selection
 * area (which is recorded in the same dimension the player was in), then 0.
 */
export function dimensionOf(target: any): number {
    if (target == null) return 0;

    // A CAPlayer wrapper, a raw Player, or a position object.
    const player = target.$ ?? target.player ?? target;
    const pos = player?.pos ?? target.pos;
    const fromPos = pos?.dimid;
    if (isValidDimension(fromPos)) return Number(fromPos);

    const area = target.settings?.area ?? player?.settings?.area;
    const fromArea = area?.start?.dimid ?? area?.end?.dimid;
    if (isValidDimension(fromArea)) return Number(fromArea);

    return 0;
}

export default { dimensionOf, isValidDimension };
