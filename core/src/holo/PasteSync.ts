import Config from "../common/Config";
import BlockView from "./BlockView";
import Players from "../user/Players";
import HoloCompat from "./HoloCompat";

/**
 * Refresh clients that are standing near a paste.
 *
 * The server side of a paste is already correct: `StructurePlacement.flushBlockEntities` writes
 * banner patterns, sign text and chest contents through `Block.getBlockEntity().setNbt()`. What
 * the client does NOT get is the BlockActorData packet, so a freshly pasted banner keeps its
 * default (solid) look until the player reloads the chunk - the "pasted banner is black" report.
 *
 * The library exposes the packet (`blockFakeSetNbt` + `blockFakeSetBlockEntity`, 450-export
 * surface). CALL uses it only as a repaint for players already in range:
 *
 *   - the fake block body is an exact copy of the real one, so the two are indistinguishable;
 *   - nothing is written to the world, and a chunk reload simply shows the real block again;
 *   - players further away are skipped - they receive the right data with the chunk itself.
 *
 * `pasteSyncBlockEntities: "off"` disables it; a library without the exports disables it silently.
 */
const HOLE = new Set(["", "minecraft:air", "minecraft:cave_air", "minecraft:void_air"]);

function enabled(): boolean {
    const raw = String(Config.get(Config.GLOBAL, "pasteSyncBlockEntities", "fake") ?? "fake").toLowerCase();
    return raw !== "off" && raw !== "false";
}

function radius(): number {
    const raw = Number(Config.get(Config.GLOBAL, "pasteSyncRadius", 64));
    return isFinite(raw) && raw > 0 ? Math.min(256, raw) : 64;
}

function maxPerBatch(): number {
    const raw = Number(Config.get(Config.GLOBAL, "pasteSyncMax", 256));
    return isFinite(raw) && raw >= 0 ? Math.min(4096, Math.floor(raw)) : 256;
}

/**
 * Online players.
 *
 * LSE spells it `mc.getOnlinePlayers()` (types/lse/GameAPI/Player.d.ts). The first version of this
 * file used `mc.getPlayers()`, which does not exist - the defensive guard turned that into an
 * empty array and every paste silently reported "pushed 0" with no error anywhere.
 */
function onlinePlayers(): any[] {
    // CALL's own registry first: mc.getOnlinePlayers() answered 0 while six players were online,
    // and a paste that repaints nobody is indistinguishable from "nobody was near".
    push.via = "registry";
    try {
        const list: any[] = [];
        for (const [, caPlayer] of Players.dataMap) {
            const live = caPlayer == null ? null : (caPlayer as any).$;
            if (live != null) list.push(live);
        }
        push.seenUnsupported = false;
        if (list.length > 0) return list;
    } catch {
        // fall through to the global API
    }
    push.via = "api";
    try {
        const g: any = typeof mc !== "undefined" ? (mc as any) : null;
        if (g == null) return [];
        if (typeof g.getOnlinePlayers === "function") {
            const list = g.getOnlinePlayers();
            push.seenUnsupported = false;
            return Array.isArray(list) ? list : [];
        }
        push.seenUnsupported = true;
    } catch {
        push.seenUnsupported = true;
    }
    return [];
}

const push = { pushed: 0, skipped: 0, seen: 0, inDim: 0, inRange: 0, failed: 0, seenUnsupported: false, via: "none" };

/**
 * Repaint one cell for every player near it.
 *
 * `blockSnbt` must be the block's own NBT (`block.getNbt().toSNBT()`), `beSnbt` the block
 * entity's. Both are dropped when the library cannot take them; nothing here throws.
 */
export function afterBlockEntity(x: number, y: number, z: number, dimid: number, blockSnbt: string, beSnbt: string): void {
    if (!enabled() || String(beSnbt ?? "") === "") return;
    if (!HoloCompat.status().caps.fakeEntity) return;
    if (push.skipped >= maxPerBatch()) return;

    const list = onlinePlayers();
    push.seen += list.length;
    if (list.length === 0) return;
    const r = radius();
    const r2 = r * r;

    for (const player of list) {
        try {
            if (player == null) continue;
            const pos = player.pos;
            if (pos == null || Number(pos.dimid ?? 0) !== dimid) continue;
            push.inDim++;
            if (HOLE.has(String(player.realName ?? ""))) continue;
            const dx = Number(pos.x) - x;
            const dy = Number(pos.y) - y;
            const dz = Number(pos.z) - z;
            if (dx * dx + dy * dy + dz * dz > r2) continue;
            push.inRange++;

            // Body first: the library ignores BlockActorData for a cell the client does not know.
            if (blockSnbt !== "") BlockView.setBlockNbt(player.realName, x, y, z, blockSnbt);
            BlockView.setBlockEntity(player.realName, x, y, z, beSnbt);
            push.pushed++;
        } catch {
            push.failed++;
        }
    }
}

/**
 * Counters for /ca tools debug.
 *
 * `seen / inDim / inRange` are what makes "pushed 0" explainable: nobody online, nobody in this
 * dimension, nobody inside the radius, or the enumeration API is missing (`unsupported`).
 */
export function stats(): {
    pushed: number; skipped: number; seen: number; inDim: number; inRange: number;
    failed: number; unsupported: boolean; via: string;
} {
    return {
        pushed: push.pushed, skipped: push.skipped, seen: push.seen, inDim: push.inDim,
        inRange: push.inRange, failed: push.failed, unsupported: push.seenUnsupported,
        via: push.via,
    };
}

export default { afterBlockEntity, stats };
