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

function destroy(entry: Entry): void {
    for (const id of [entry.boxId, entry.labelId]) {
        if (id > 0) Holo.call("shapeDestroy", id);
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
            destroy(prev);
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
        destroy(entry);
        entries.delete(key);
    },

    hideAll(): void {
        for (const [key] of entries) Wireframe.hide(key);
    },

    /** How many boxes are currently tracked (used by the live tests). */
    count(): number {
        return entries.size;
    },
};

export default Wireframe;
