import Holo from "./Holo";
import Config from "../common/Config";

/**
 * Selection / preview boxes drawn through HologramLib's DebugShape packets.
 *
 * Shapes live in the client's memory only: nothing is written to the world, nothing is
 * persisted, and the library re-sends them when a player joins.
 *
 * WHY EVERY SHAPE CARRIES A LIFETIME:
 * `shapeDestroy` does not actually remove a shape from the client in this library version -
 * it sends a remove packet that only carries the network id (no type), the client ignores it
 * and the old box stays on screen, so every re-render left a ghost. The proto does carry
 * `mTotalTimeLeft` (`shapeSetDuration`), which the CLIENT honours, so that is what we rely on:
 * every shape expires on its own and the live ones are refreshed on a timer. Destroying still
 * frees the server-side object, we simply never depend on it clearing the screen.
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
    /** How many times the label was updated in place instead of recreated. */
    textReuses: number;
}

const entries = new Map<string, Entry>();

/** How long a shape lives on the client before it disappears by itself. */
function ttlSeconds(): number {
    const raw = Number(Config.get(Config.GLOBAL, "wireframeTtlSeconds", 5));
    return Number.isFinite(raw) && raw >= 1 ? Math.min(120, raw) : 5;
}

function maxRenderDistance(): number {
    const raw = Number(Config.get(Config.GLOBAL, "holoMaxRenderDistance", 256));
    return Number.isFinite(raw) && raw > 0 ? raw : 0;
}

function boxSignature(box: Box, color: Rgba, label: string): string {
    return [box.x1, box.y1, box.z1, box.x2, box.y2, box.z2, color.join(","), label].join("|");
}

function sameBox(a: Box, b: Box): boolean {
    return a.x1 === b.x1 && a.y1 === b.y1 && a.z1 === b.z1 &&
        a.x2 === b.x2 && a.y2 === b.y2 && a.z2 === b.z2;
}

/** Label position above the box. */
function labelPos(box: Box): [number, number, number] {
    return [(box.x1 + box.x2) / 2, Math.max(box.y1, box.y2) + 1.2, (box.z1 + box.z2) / 2];
}

/** Give a shape its lifetime and draw it. Duration must be set BEFORE draw: draw sends the proto. */
function armAndDraw(id: number, color: Rgba, alpha = color[3]): void {
    Holo.call("shapeSetColor", id, color[0], color[1], color[2], alpha);
    const dist = maxRenderDistance();
    if (dist > 0) Holo.call("shapeSetMaxRenderDistance", id, dist);
    Holo.call("shapeSetDuration", id, ttlSeconds());
    Holo.call("shapeDraw", id);
}

/**
 * Make a shape vanish quickly.
 *
 * `shapeDestroy` alone leaves it on the client, so the lifetime is dropped to a fraction of a
 * second first and the client takes it off on its own; destroy then frees the server object.
 */
function fadeOut(id: number): void {
    if (!(id > 0)) return;
    if (Holo.call("shapeSetDuration", id, 0.2) !== false) Holo.call("shapeUpdate", id);
    Holo.call("shapeRemove", id);
    Holo.call("shapeDestroy", id);
}

export const Wireframe = {
    available(): boolean {
        return Holo.available();
    },

    /** Lifetime in seconds (exposed for tests and the report). */
    ttl(): number {
        return ttlSeconds();
    },

    /**
     * Draw (or refresh) a box under `key`.
     *
     * Returns false when the library is unavailable so callers can fall back to another
     * display mode instead of silently showing nothing.
     */
    show(key: string, box: Box, color: Rgba, label = ""): boolean {
        if (!Holo.available()) return false;

        const signature = boxSignature(box, color, label);
        const prev = entries.get(key);
        if (prev != null && prev.signature === signature) return true;

        if (prev == null) {
            const entry = Wireframe.create(key, box, color, label, signature);
            return entry != null;
        }

        // The box can only be resized by recreating it (scale is uniform); the label is reused
        // in place so no ghost text can accumulate.
        const textReuses = prev.textReuses + 1;
        let boxId = prev.boxId;
        {
            if (!sameBox(prev.box, box) || !(prev.boxId > 0)) {
                fadeOut(prev.boxId);
                boxId = Number(Holo.call("shapeCreateBox", box.x1, box.y1, box.z1, box.x2, box.y2, box.z2));
                if (!(boxId > 0)) {
                    entries.delete(key);
                    return false;
                }
                armAndDraw(boxId, color);
            } else if (color.join(",") !== prev.color.join(",")) {
                Holo.call("shapeSetColor", boxId, color[0], color[1], color[2], color[3]);
                Holo.call("shapeUpdate", boxId);
            }
        }

        let labelId = prev.labelId;
        if (label !== "") {
            const [lx, ly, lz] = labelPos(box);
            // Reuse the same text shape: the client cannot be trusted to remove a recreated one.
            const textOk = label === prev.label || Holo.call("shapeSetText", labelId, label) !== false;
            const moveOk = Holo.call("shapeSetLocation", labelId, lx, ly, lz) !== false;
            const reused = labelId > 0 && textOk && moveOk;
            if (reused) {
                Holo.call("shapeSetDuration", labelId, ttlSeconds());
                const dist = maxRenderDistance();
                if (dist > 0) Holo.call("shapeSetMaxRenderDistance", labelId, dist);
                Holo.call("shapeUpdate", labelId);
            } else {
                fadeOut(labelId);
                labelId = Number(Holo.call("shapeCreateText", lx, ly, lz, label));
                if (labelId > 0) armAndDraw(labelId, color, 1.0);
            }
        }

        entries.set(key, { boxId, labelId, box, color, label, signature, textReuses });
        return true;
    },

    /** First draw of a key. */
    create(key: string, box: Box, color: Rgba, label: string, signature: string): Entry | null {
        const boxId = Number(Holo.call("shapeCreateBox", box.x1, box.y1, box.z1, box.x2, box.y2, box.z2));
        if (!(boxId > 0)) return null;
        armAndDraw(boxId, color);

        let labelId = 0;
        if (label !== "") {
            const [lx, ly, lz] = labelPos(box);
            labelId = Number(Holo.call("shapeCreateText", lx, ly, lz, label));
            if (labelId > 0) armAndDraw(labelId, color, 1.0);
        }

        const entry: Entry = { boxId, labelId, box, color, label, signature, textReuses: 0 };
        entries.set(key, entry);
        return entry;
    },

    hide(key: string): void {
        const entry = entries.get(key);
        if (entry == null) return;
        fadeOut(entry.boxId);
        fadeOut(entry.labelId);
        entries.delete(key);
    },

    hideAll(): void {
        for (const [key] of entries) Wireframe.hide(key);
        // Optional sledgehammer for stuck shapes (see wireframeResetAll).
        try {
            if (Config.get(Config.GLOBAL, "wireframeResetAll", false) === true) {
                Holo.call("shapeDestroyAll");
            }
        } catch {
            // ignore
        }
    },

    /**
     * Push the lifetime of every live shape forward (called on a timer).
     *
     * Shapes the client lost (or that expired while nobody looked) are recreated.
     */
    refresh(): number {
        if (!Holo.available()) return 0;
        let alive = 0;
        for (const [key, entry] of entries) {
            const boxOk = entry.boxId > 0 && Holo.call("shapeExists", entry.boxId) !== false;
            if (!boxOk) {
                // The library dropped it: rebuild this key from the remembered geometry.
                entries.delete(key);
                Wireframe.create(key, entry.box, entry.color, entry.label, entry.signature);
                continue;
            }
            Holo.call("shapeSetDuration", entry.boxId, ttlSeconds());
            Holo.call("shapeUpdate", entry.boxId);
            if (entry.labelId > 0) {
                Holo.call("shapeSetDuration", entry.labelId, ttlSeconds());
                Holo.call("shapeUpdate", entry.labelId);
            }
            alive++;
        }
        return alive;
    },

    /** "Is anything stacked?" - the tracked keys against what the library actually holds. */
    debugReport(): string[] {
        const lines: string[] = [];
        lines.push("本插件登记的形状：" + entries.size + " 个 key（寿命 " + ttlSeconds() + " 秒）");
        for (const [key, entry] of entries) {
            const exists = entry.boxId > 0 ? Holo.call("shapeExists", entry.boxId) : null;
            lines.push("  " + key + "  boxId=" + entry.boxId + " labelId=" + entry.labelId +
                "  文本复用=" + entry.textReuses + "  库中存在=" + String(exists));
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
        return lines;
    },

    /** How many boxes are currently tracked (used by the live tests). */
    count(): number {
        return entries.size;
    },

    /** Tracked ids for one key (used by the live tests). */
    idsOf(key: string): { boxId: number; labelId: number } | null {
        const e = entries.get(key);
        return e == null ? null : { boxId: e.boxId, labelId: e.labelId };
    },
};

export default Wireframe;
