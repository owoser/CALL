/**
 * Client-side "ghost" entities for the preview, built on the library's entity domain.
 *
 * Paintings, item frames and armour stands are ENTITIES in Bedrock, so a preview made of fake
 * BLOCKS cannot show them at all. HologramLib exposes a protocol-entity family
 * (entityCreateAdvanced / entitySetPosition / entitySetRotation / entityDestroy) that only exists on
 * the client - no AI, no collision, not saved - which is exactly what a preview needs.
 *
 * Capability gate: the docs list 40 entity exports, but the gate is the export surface we actually
 * call (see AGENTS.md section 0). A missing one disables entity previews and says so once; blocks
 * keep using blockFakeSet.
 */
import ll from "./Holo";

type Fn = ((...args: any[]) => any) | null;

/** The cached native function for an export name (Holo.bind), or null when the library lacks it. */
function bind(name: string): Fn {
    try {
        const fn = ll.bind(name);
        return typeof fn === "function" ? (fn as Fn) : null;
    } catch {
        return null;
    }
}

let warned = false;

export interface GhostEntityIds {
    ids: number[];
}

export const FakeEntities = {
    /** True when the entity family we call is exported. */
    available(): boolean {
        return bind("entityCreateAdvanced") != null &&
            bind("entitySetPosition") != null &&
            bind("entityDestroy") != null;
    },

    /** Why it is unavailable (for /ca tools debug). */
    reason(): string {
        const missing: string[] = [];
        for (const name of ["entityCreateAdvanced", "entitySetPosition", "entitySetRotation", "entityDestroy"]) {
            if (bind(name) == null) missing.push(name);
        }
        return missing.length === 0 ? "" : "缺少导出: " + missing.join(", ");
    },

    /**
     * Create one ghost entity. Returns 0 when the library refused it (id 0 is never valid).
     *
     * `yaw` is in degrees, Bedrock's 0 = south; paintings are specified by the block they hang on,
     * so the caller passes the yaw derived from the block's facing.
     */
    create(identifier: string, x: number, y: number, z: number, dimid: number, yaw: number): number {
        const create = bind("entityCreateAdvanced");
        if (create == null) return 0;
        try {
            const id = Number(create(identifier, x, y, z, dimid, yaw, 0, 1, ""));
            if (Number.isFinite(id) && id > 0) return id;
            return 0;
        } catch (e) {
            if (!warned) {
                warned = true;
                try {
                    logger.warn("[CALL][preview] 实体预览创建失败: " + String((e as any)?.message ?? e));
                } catch { }
            }
            return 0;
        }
    },

    move(id: number, x: number, y: number, z: number, dimid: number): boolean {
        const fn = bind("entitySetPosition");
        if (fn == null || id <= 0) return false;
        try {
            return fn(id, x, y, z, dimid) !== false;
        } catch {
            return false;
        }
    },

    rotate(id: number, yaw: number): boolean {
        const fn = bind("entitySetRotation");
        if (fn == null || id <= 0) return false;
        try {
            return fn(id, yaw, 0) !== false;
        } catch {
            return false;
        }
    },

    destroy(id: number): boolean {
        const fn = bind("entityDestroy");
        if (fn == null || id <= 0) return false;
        try {
            return fn(id) !== false;
        } catch {
            return false;
        }
    },

    destroyMany(ids: number[]): number {
        let n = 0;
        for (const id of ids) if (FakeEntities.destroy(id)) n++;
        return n;
    },
};

export default FakeEntities;
