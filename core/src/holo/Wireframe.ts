import Holo from "./Holo";
import Config from "../common/Config";

/**
 * Selection / preview boxes drawn through HologramLib's DebugShape packets.
 *
 * Shapes live in the client's memory only: nothing is written to the world, nothing is
 * persisted, and the library re-sends them when a player joins. Each logical key keeps at
 * most one box plus one label, and a signature check keeps us from re-sending identical
 * geometry every tick.
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
    signature: string;
}

const entries = new Map<string, Entry>();

function maxRenderDistance(): number {
    const raw = Number(Config.get(Config.GLOBAL, "holoMaxRenderDistance", 256));
    return Number.isFinite(raw) && raw > 0 ? raw : 0;
}

function boxSignature(box: Box, color: Rgba, label: string): string {
    return [box.x1, box.y1, box.z1, box.x2, box.y2, box.z2, color.join(","), label].join("|");
}

/**
 * Remove a shape from the world and every client.
 *
 * `shapeDestroy` can fail (the id is no longer known); if it does the shape keeps being sent
 * to clients, which is exactly the "旧框叠在新框上" report. Hiding it with `shapeRemove` at
 * least clears the screen, and the failure is logged instead of swallowed.
 */
function destroy(entry: Entry, key = ""): void {
    for (const id of [entry.boxId, entry.labelId]) {
        if (!(id > 0)) continue;
        const ok = Holo.call("shapeDestroy", id);
        if (ok === false) {
            Holo.call("shapeRemove", id);
            Holo.call("shapeDestroy", id);
            const exists = Holo.call("shapeExists", id);
            try {
                logger.warn("[CALL][wire] shapeDestroy failed key=" + (key || "?") + " id=" + id + " exists=" + String(exists));
            } catch {
                // logger unavailable (unit tests)
            }
        }
    }
}

export const Wireframe = {
    available(): boolean {
        return Holo.available();
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

        if (prev != null) {
            destroy(prev, key);
            entries.delete(key);
        }

        const boxId = Number(Holo.call("shapeCreateBox", box.x1, box.y1, box.z1, box.x2, box.y2, box.z2));
        if (!(boxId > 0)) return false;

        Holo.call("shapeSetColor", boxId, color[0], color[1], color[2], color[3]);
        const dist = maxRenderDistance();
        if (dist > 0) Holo.call("shapeSetMaxRenderDistance", boxId, dist);
        Holo.call("shapeDraw", boxId);

        let labelId = 0;
        if (label !== "") {
            const y = Math.max(box.y1, box.y2) + 1.2;
            labelId = Number(
                Holo.call(
                    "shapeCreateText",
                    (box.x1 + box.x2) / 2,
                    y,
                    (box.z1 + box.z2) / 2,
                    label
                )
            );
            if (labelId > 0) {
                Holo.call("shapeSetColor", labelId, color[0], color[1], color[2], 1.0);
                if (dist > 0) Holo.call("shapeSetMaxRenderDistance", labelId, dist);
                Holo.call("shapeDraw", labelId);
            }
        }

        entries.set(key, { boxId, labelId, signature });
        return true;
    },

    hide(key: string): void {
        const entry = entries.get(key);
        if (entry == null) return;
        destroy(entry, key);
        entries.delete(key);
    },

    hideAll(): void {
        for (const [key] of entries) Wireframe.hide(key);
        // Optional sledgehammer for stuck boxes (see wireframeResetAll).
        try {
            if (Config.get(Config.GLOBAL, "wireframeResetAll", false) === true) {
                Holo.call("shapeDestroyAll");
            }
        } catch {
            // ignore
        }
    },

    /**
     * "Is anything stacked?" - the tracked keys against what the library actually holds.
     *
     * The library numbers shapes from 1 upwards, so a mismatch means some box was never
     * destroyed; listing our keys makes the culprit obvious instead of guessing from a screen.
     */
    debugReport(): string[] {
        const lines: string[] = [];
        lines.push("本插件登记的形状：" + entries.size + " 个 key");
        for (const [key, entry] of entries) {
            const exists = entry.boxId > 0 ? Holo.call("shapeExists", entry.boxId) : null;
            lines.push("  " + key + "  boxId=" + entry.boxId + " labelId=" + entry.labelId +
                "  库中存在=" + String(exists));
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
};

export default Wireframe;
