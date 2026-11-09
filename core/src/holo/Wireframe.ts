import Holo from "./Holo";
import Config from "../common/Config";
import * as HoloCompat from "./HoloCompat";

/**
 * Selection / preview boxes drawn through HologramLib's DebugShape packets.
 *
 * Shapes live in the client's memory only: nothing is written to the world, nothing is
 * persisted, and the library re-sends them when a player joins.
 *
 * Two rules keep ghosts away:
 *   1. never recreate what can be moved - a box whose SIZE did not change is moved with
 *      shapeSetLocation, and a label is always rewritten in place (shapeSetText + setLocation).
 *   2. no lifetime by default. A previous build set shapeSetDuration on every shape, assuming
 *      the library's remove packet was ignored; clients kept those "timed" entities instead, so
 *      our own workaround broke the plain destroy path that had been working. Opt-in now
 *      (`wireframeTtlSeconds` > 0).
 */

export interface Box {
    x1: number;
    y1: number;
    z1: number;
    x2: number;
    y2: number;
    z2: number;
}

export type Rgba = [number, number, number, number];

export const COLOR = {
    incomplete: [1.0, 0.85, 0.2, 1.0] as Rgba,
    complete: [0.35, 0.95, 0.45, 1.0] as Rgba,
    preview: [0.35, 0.75, 1.0, 1.0] as Rgba,
    warning: [1.0, 0.35, 0.35, 1.0] as Rgba,
};

interface Entry {
    boxId: number;
    labelId: number;
    box: Box;
    color: Rgba;
    label: string;
    signature: string;
    textReuses: number;
    boxMoves: number;
}

const entries = new Map<string, Entry>();

/** How far below the world a shape is parked before being destroyed. */
const PARK_DISTANCE = 512;

/** 0 = off (default). Only useful if a library build ignores remove packets. */
function ttlSeconds(): number {
    const raw = Number(Config.get(Config.GLOBAL, "wireframeTtlSeconds", 0));
    if (!Number.isFinite(raw) || raw <= 0) return 0;
    return Math.min(120, Math.max(1, raw));
}

/**
 * Should a shape be moved out of sight before it is destroyed?
 *
 * Only needed on libraries older than the shape-fix release: there `shapeDestroy` sends a
 * packet that clients read as an update, so the shape stays. With a fixed library the plain
 * destroy works and parking is skipped. The option forces it either way.
 */
function parkBeforeDestroy(): boolean {
    if (Config.get(Config.GLOBAL, "wireframeParkBeforeDestroy", false) === true) return true;
    return !HoloCompat.removeReliable();
}

function maxRenderDistance(): number {
    const raw = Number(Config.get(Config.GLOBAL, "holoMaxRenderDistance", 256));
    return Number.isFinite(raw) && raw > 0 ? raw : 0;
}

function boxSignature(box: Box, color: Rgba, label: string): string {
    return [box.x1, box.y1, box.z1, box.x2, box.y2, box.z2, color.join(","), label].join("|");
}

function sizeOf(box: Box): [number, number, number] {
    return [Math.abs(box.x2 - box.x1), Math.abs(box.y2 - box.y1), Math.abs(box.z2 - box.z1)];
}

function sameSize(a: Box, b: Box): boolean {
    const [ax, ay, az] = sizeOf(a);
    const [bx, by, bz] = sizeOf(b);
    return ax === bx && ay === by && az === bz;
}

function sameBox(a: Box, b: Box): boolean {
    return a.x1 === b.x1 && a.y1 === b.y1 && a.z1 === b.z1 &&
        a.x2 === b.x2 && a.y2 === b.y2 && a.z2 === b.z2;
}

function centerOf(box: Box): [number, number, number] {
    return [(box.x1 + box.x2) / 2, (box.y1 + box.y2) / 2, (box.z1 + box.z2) / 2];
}

function labelPos(box: Box): [number, number, number] {
    return [(box.x1 + box.x2) / 2, Math.max(box.y1, box.y2) + 1.2, (box.z1 + box.z2) / 2];
}

function draw(id: number, color: Rgba, alpha: number): void {
    Holo.call("shapeSetColor", id, color[0], color[1], color[2], alpha);
    const dist = maxRenderDistance();
    if (dist > 0) Holo.call("shapeSetMaxRenderDistance", id, dist);
    const ttl = ttlSeconds();
    if (ttl > 0) Holo.call("shapeSetDuration", id, ttl);
    Holo.call("shapeDraw", id);
}

function resend(id: number): void {
    const ttl = ttlSeconds();
    if (ttl > 0) Holo.call("shapeSetDuration", id, ttl);
    Holo.call("shapeUpdate", id);
}

/**
 * Get a shape off the screen and out of the library.
 *
 * `shapeDestroy` erases the shape server-side but clients ignore the remove packet in this
 * library build (verified: server reports 0 shapes while the box is still drawn). Updates ARE
 * honoured, so the shape is first moved far below the world and re-sent - the client follows -
 * and only then destroyed. The leftover is invisible and dies with the next relog.
 */
function drop(id: number): void {
    if (!(id > 0)) return;
    if (parkBeforeDestroy()) {
        try {
            const loc: any = Holo.call("shapeGetLocation", id);
            if (Array.isArray(loc) && loc.length >= 3) {
                Holo.call("shapeSetLocation", id, Number(loc[0]), Number(loc[1]) - PARK_DISTANCE, Number(loc[2]));
                Holo.call("shapeUpdate", id);
            }
        } catch {
            // parking is best effort; destroy below still frees the server object
        }
    }
    Holo.call("shapeDestroy", id);
}

export const Wireframe = {
    available(): boolean {
        return Holo.available();
    },

    /** Configured lifetime in seconds (0 = destroy path, the default). */
    ttl(): number {
        return ttlSeconds();
    },

    show(key: string, box: Box, color: Rgba, label = ""): boolean {
        if (!Holo.available()) return false;

        const signature = boxSignature(box, color, label);
        const prev = entries.get(key);
        if (prev != null && prev.signature === signature) return true;

        if (prev == null) {
            const boxId = Number(Holo.call("shapeCreateBox", box.x1, box.y1, box.z1, box.x2, box.y2, box.z2));
            if (!(boxId > 0)) return false;
            draw(boxId, color, color[3]);
            const labelId = Wireframe.drawLabel(0, box, color, label, null);
            entries.set(key, { boxId, labelId, box, color, label, signature, textReuses: 0, boxMoves: 0 });
            return true;
        }

        let boxId = prev.boxId;
        let boxMoves = prev.boxMoves;
        if (!(boxId > 0)) {
            boxId = Number(Holo.call("shapeCreateBox", box.x1, box.y1, box.z1, box.x2, box.y2, box.z2));
            if (!(boxId > 0)) {
                entries.delete(key);
                return false;
            }
            draw(boxId, color, color[3]);
        } else if (sameBox(prev.box, box)) {
            if (color.join(",") !== prev.color.join(",")) {
                Holo.call("shapeSetColor", boxId, color[0], color[1], color[2], color[3]);
                resend(boxId);
            }
        } else if (sameSize(prev.box, box)) {
            const [cx, cy, cz] = centerOf(box);
            if (Holo.call("shapeSetLocation", boxId, cx, cy, cz) !== false) {
                boxMoves++;
                resend(boxId);
            } else {
                drop(boxId);
                boxId = Number(Holo.call("shapeCreateBox", box.x1, box.y1, box.z1, box.x2, box.y2, box.z2));
                if (!(boxId > 0)) {
                    entries.delete(key);
                    return false;
                }
                draw(boxId, color, color[3]);
            }
        } else {
            drop(boxId);
            boxId = Number(Holo.call("shapeCreateBox", box.x1, box.y1, box.z1, box.x2, box.y2, box.z2));
            if (!(boxId > 0)) {
                entries.delete(key);
                return false;
            }
            draw(boxId, color, color[3]);
        }

        const labelId = Wireframe.drawLabel(prev.labelId, box, color, label, prev);
        const textReuses = labelId > 0 && labelId === prev.labelId ? prev.textReuses + 1 : prev.textReuses;
        entries.set(key, { boxId, labelId, box, color, label, signature, textReuses, boxMoves });
        return true;
    },

    /** Text shapes are never recreated while the key lives: clients keep removed text entities. */
    drawLabel(existingId: number, box: Box, color: Rgba, label: string, prev: Entry | null): number {
        if (label === "") {
            if (existingId > 0) drop(existingId);
            return 0;
        }
        const [lx, ly, lz] = labelPos(box);
        if (existingId > 0) {
            const textOk = prev != null && prev.label === label ? true : Holo.call("shapeSetText", existingId, label) !== false;
            const moveOk = Holo.call("shapeSetLocation", existingId, lx, ly, lz) !== false;
            if (textOk && moveOk) {
                if (prev != null && color.join(",") !== prev.color.join(",")) {
                    Holo.call("shapeSetColor", existingId, color[0], color[1], color[2], 1.0);
                }
                resend(existingId);
                return existingId;
            }
            drop(existingId);
        }
        const id = Number(Holo.call("shapeCreateText", lx, ly, lz, label));
        if (id > 0) draw(id, color, 1.0);
        return id > 0 ? id : 0;
    },

    hide(key: string): void {
        const entry = entries.get(key);
        if (entry == null) return;
        drop(entry.boxId);
        drop(entry.labelId);
        entries.delete(key);
    },

    hideAll(): void {
        for (const [key] of entries) Wireframe.hide(key);
        try {
            if (Config.get(Config.GLOBAL, "wireframeResetAll", false) === true) {
                Holo.call("shapeDestroyAll");
            }
        } catch {
            // ignore
        }
    },

    /** Only meaningful when a lifetime is configured; a no-op otherwise. */
    refresh(): number {
        if (ttlSeconds() <= 0) return 0;
        if (!Holo.available()) return 0;
        let alive = 0;
        for (const [key, entry] of entries) {
            const ok = entry.boxId > 0 && Holo.call("shapeExists", entry.boxId) !== false;
            if (!ok) {
                entries.delete(key);
                Wireframe.show(key, entry.box, entry.color, entry.label);
                continue;
            }
            resend(entry.boxId);
            if (entry.labelId > 0) resend(entry.labelId);
            alive++;
        }
        return alive;
    },

    debugReport(): string[] {
        const lines: string[] = [];
        const ttl = ttlSeconds();
        lines.push("本插件登记的形状：" + entries.size + " 个 key（寿命 " + (ttl > 0 ? ttl + " 秒" : "关闭，走 destroy") + "）");
        for (const [key, entry] of entries) {
            const exists = entry.boxId > 0 ? Holo.call("shapeExists", entry.boxId) : null;
            lines.push("  " + key + "  boxId=" + entry.boxId + " labelId=" + entry.labelId +
                "  原地移动=" + entry.boxMoves + "  文本复用=" + entry.textReuses + "  库中存在=" + String(exists));
        }
        let all: any = null;
        try {
            all = Holo.call("shapeGetAllShapeIds");
        } catch {
            all = null;
        }
        if (Array.isArray(all)) {
            lines.push("库内形状总数：" + all.length + (all.length > entries.size * 2 ? "（比登记的多，可能有残留）" : ""));
        } else {
            lines.push("库内形状总数：拿不到（库不支持或未安装）");
        }
        lines.push("提示：客户端残留无法由服务端清除，重登一次即可清空");
        return lines;
    },

    count(): number {
        return entries.size;
    },

    idsOf(key: string): { boxId: number; labelId: number } | null {
        const e = entries.get(key);
        return e == null ? null : { boxId: e.boxId, labelId: e.labelId };
    },

    statsOf(key: string): { boxMoves: number; textReuses: number } | null {
        const e = entries.get(key);
        return e == null ? null : { boxMoves: e.boxMoves, textReuses: e.textReuses };
    },
};

export default Wireframe;
