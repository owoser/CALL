/**
 * Remove the item entities an operation itself created.
 *
 * Replacing a container block makes the engine think the container was destroyed and it spills the
 * contents. Emptying the container first does NOT help: the write that empties it is itself the
 * trigger (measured - clearing succeeded and the items still appeared). So the items are collected
 * afterwards instead, and ONLY the ones that did not exist before the operation: a player's own
 * dropped items inside the box are never touched.
 */
import Area3 from "../common/Area3";

/** How far beyond the operation box a spilled item may land. */
const MARGIN = 4;

const stats = { swept: 0 };
export function sweepStats(): { swept: number } {
    return { ...stats };
}

/** Items currently inside `area` (by the runtime entity id, which is unique while it lives). */
export function snapshotItemIds(area: Area3): Set<string> {
    const ids = new Set<string>();
    for (const entity of entitiesIn(area)) {
        try {
            if (String(entity?.type ?? "") !== "minecraft:item") continue;
            const key = keyOf(entity);
            if (key !== "") ids.add(key);
        } catch {
            // ignore one bad entity
        }
    }
    return ids;
}

/**
 * Identity of one item: the BLOCK it sits in.
 *
 * `Entity.id` turned out to be unusable for dropped items on this build (every one of them came
 * back with id 0, so an id keyed set collapsed), while the position is always there. Two items in
 * the same block are treated as one, which is the conservative direction: an item that existed
 * before the operation is never removed.
 */
function keyOf(entity: any): string {
    const p = entity?.pos;
    if (p == null) return "";
    const x = Math.floor(Number(p.x));
    const y = Math.floor(Number(p.y));
    const z = Math.floor(Number(p.z));
    if (!Number.isFinite(x) || !Number.isFinite(y) || !Number.isFinite(z)) return "";
    return x + "," + y + "," + z;
}

/** Remove item entities inside `area` that are not in `before`; returns how many were removed. */
export function removeNewItems(area: Area3, before: Set<string>): number {
    let removed = 0;
    for (const entity of entitiesIn(area)) {
        try {
            if (String(entity?.type ?? "") !== "minecraft:item") continue;
            const key = keyOf(entity);
            if (key === "" || before.has(key)) continue;
            if (entity.remove() !== false) removed++;
        } catch {
            // a single item we cannot remove must not abort the sweep
        }
    }
    if (removed > 0) stats.swept += removed;
    return removed;
}

/** Every entity whose BLOCK position falls inside `area` (same dimension). */
function entitiesIn(area: Area3): any[] {
    const a = area.start;
    const b = area.end;
    const minX = Math.min(a.x, b.x), maxX = Math.max(a.x, b.x);
    const minY = Math.min(a.y, b.y), maxY = Math.max(a.y, b.y);
    const minZ = Math.min(a.z, b.z), maxZ = Math.max(a.z, b.z);
    // The typings only declare getAllEntities(), but the running LSE exposes getEntities(centre,
    // radius) - measured. Prefer the one that works; the box filter below culls either way.
    let list: any[] = [];
    try {
        const anyMc = mc as any;
        const cx = (minX + maxX) / 2 + 0.5;
        const cy = (minY + maxY) / 2 + 0.5;
        const cz = (minZ + maxZ) / 2 + 0.5;
        const radius = Math.max(6, Math.hypot(maxX - minX + 1, maxY - minY + 1, maxZ - minZ + 1) / 2 + 3);
        if (typeof anyMc.getEntities === "function") {
            list = (anyMc.getEntities(new FloatPos(cx, cy, cz, a.dimid), radius) as any[]) ?? [];
        } else if (typeof anyMc.getAllEntities === "function") {
            list = (anyMc.getAllEntities() as any[]) ?? [];
        }
    } catch {
        return [];
    }
    const out: any[] = [];
    for (const entity of list) {
        try {
            const p = entity?.pos;
            if (p == null) continue;
            if (p.dimid != null && Number(p.dimid) !== Number(a.dimid)) continue;
            const x = Math.floor(Number(p.x));
            const y = Math.floor(Number(p.y));
            const z = Math.floor(Number(p.z));
            // Items are ejected with velocity, so they land a few blocks away: the box is grown to
            // catch them (measured - a tight box missed every one of them).
            if (x < minX - MARGIN || x > maxX + MARGIN) continue;
            if (y < minY - MARGIN || y > maxY + MARGIN + 1) continue;
            if (z < minZ - MARGIN || z > maxZ + MARGIN) continue;
            out.push(entity);
        } catch {
            // ignore
        }
    }
    return out;
}


export default { snapshotItemIds, removeNewItems, sweepStats };
