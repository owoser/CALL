import * as fs from "fs";
import * as path from "path";
import Paths from "../common/Paths";

/**
 * Thin, defensive bridge to HologramLib (a native LeviLamina mod that can send DebugShape
 * packets to clients).
 *
 * Everything here is optional: when the library is missing, the wrong version, or lrca is
 * not loaded, `available()` is false and every call becomes a no-op. That matters because
 * CALL must keep working on servers that do not run HologramLib at all.
 *
 * Binding notes (from the library's own docs):
 *   - functions are exposed as ll.import("HologramLib", "<original name>");
 *   - bind once and keep the function - never call ll.import inside a tick;
 *   - shapeDraw() broadcasts to every online client and the library re-sends on join;
 *   - no shapeSetDuration() = permanent.
 */

type AnyFn = (...args: any[]) => any;

const cache = new Map<string, AnyFn | null>();
let probed = false;
let reason = "";

function wrapperPath(): string | null {
    const roots = [
        path.join(Paths.SERVER_ROOT, "plugins", "HologramLib"),
        path.join(Paths.SERVER_ROOT, "mods", "HologramLib"),
    ];
    for (const root of roots) {
        const file = path.join(root, "lib", "HologramLib.js");
        try {
            if (fs.existsSync(file)) return file;
        } catch {
            // ignore
        }
    }
    return null;
}

/** Resolve one library function, cached. Returns null when it is unavailable. */
function resolve(name: string): AnyFn | null {
    if (cache.has(name)) return cache.get(name) as AnyFn | null;

    let fn: AnyFn | null = null;

    // 1. direct lrca import - the documented path, no filesystem guessing
    try {
        const g: any = typeof ll !== "undefined" ? (ll as any) : null;
        if (g != null && typeof g.import === "function") {
            const f = g.import("HologramLib", name);
            if (typeof f === "function") fn = f as AnyFn;
        }
    } catch {
        // lrca missing
    }

    // 2. the shipped wrapper (also gives us HL.has() for a version check)
    if (fn == null) {
        try {
            const file = wrapperPath();
            if (file != null) {
                const HL: any = require(file);
                if (HL != null && typeof HL[name] === "function") fn = HL[name] as AnyFn;
            }
        } catch {
            // wrapper not loadable
        }
    }

    cache.set(name, fn);
    return fn;
}

export const Holo = {
    /** Probe once and cache the verdict. */
    available(): boolean {
        if (!probed) {
            probed = true;
            const has = resolve("shapeCreateBox");
            if (has == null) {
                reason = "未找到 HologramLib（需要安装该前置并提供 lrca）";
                return false;
            }
            reason = "";
            return true;
        }
        return resolve("shapeCreateBox") != null;
    },

    reason(): string {
        return reason;
    },

    /**
     * The cached native function for a name, or null.
     *
     * Hot paths (thousands of viewBlock calls per batch) bind once and call the reference
     * directly: `call()` would look the name up and spread an argument array every time.
     */
    bind(name: string): any {
        return resolve(name);
    },

    /** Call a library function; returns undefined when unavailable or when it throws. */
    call(name: string, ...args: any[]): any {
        const fn = resolve(name);
        if (fn == null) return undefined;
        try {
            return fn(...args);
        } catch (e) {
            try {
                logger.warn("[CALL][Holo] " + name + " failed: " + (e && (e as any).message ? (e as any).message : e));
            } catch {
                // logger unavailable
            }
            return undefined;
        }
    },

    /** Reset the cache - used by /ca debug holo after the admin installs the library. */
    reload(): void {
        cache.clear();
        probed = false;
        reason = "";
    },

    /** Library version string when it reports one. */
    version(): string {
        try {
            const file = wrapperPath();
            if (file == null) return "unknown";
            const HL: any = require(file);
            return String(HL?.apiVersion ?? "unknown");
        } catch {
            return "unknown";
        }
    },
};

export default Holo;
