import Holo from "./Holo";

/**
 * Boss bars (`bossBar*`), used for the paste-preview countdown.
 *
 * A boss bar is the only HUD element that can show "how much time is left" without fighting
 * the action bar - CALL already writes the selection hint there every second
 * (AreaDisplayerService), and two writers on one channel would flicker.
 *
 * Verified in HologramLib 1.33.0 (LL 26.51) and 1.35.0 (LL 26.60):
 *   bossBarAdd(playerName, title, healthPercent, color, overlay) -> id
 *   bossBarSetTitle(id, title) / bossBarSetHealth(id, percent) / bossBarSetStyle(id, color, overlay)
 *   bossBarRemove(id) / bossBarCount(playerName)
 *
 * Only ever removes its OWN id: bossBarRemoveAll() would wipe bars belonging to other plugins.
 */

let addFn: any;
let titleFn: any;
let healthFn: any;
let styleFn: any;
let removeFn: any;

function bind(): void {
    if (addFn !== undefined) return;
    addFn = Holo.bind("bossBarAdd") ?? null;
    titleFn = Holo.bind("bossBarSetTitle") ?? null;
    healthFn = Holo.bind("bossBarSetHealth") ?? null;
    styleFn = Holo.bind("bossBarSetStyle") ?? null;
    removeFn = Holo.bind("bossBarRemove") ?? null;
}

export const BossBar = {
    available(): boolean {
        if (!Holo.available()) return false;
        bind();
        return addFn != null && titleFn != null && healthFn != null && removeFn != null;
    },

    /**
     * Create a bar for one player; returns the id EXACTLY as the library gave it.
     *
     * Never convert it. A real session returned 0x7000000000000000 = 8070450532247928832;
     * turning that into a JS Number rounds it to 8070450532247929000, and every later call
     * (setTitle / setHealth / setStyle / remove all take the id back) then answers false while
     * getInfo says "not_found". That is precisely why 3.9.0 created a bar, never updated it,
     * and could not remove it.
     */
    add(playerName: string, title: string, percent: number, color: number, overlay: number): any | null {
        if (!BossBar.available()) return null;
        try {
            const id = addFn(playerName, title, percent, color, overlay);
            // Whatever the runtime hands back - number, bigint or a decimal string - it goes
            // back in unchanged. Round-tripping through JS arithmetic is what broke it.
            if (typeof id === "bigint") return id >= BigInt(0) ? id : null;
            if (typeof id === "number") return Number.isFinite(id) && id >= 0 ? id : null;
            if (typeof id === "string" && /^-?\d+$/.test(id.trim()) && !id.trim().startsWith("-")) return id.trim();
            return null;
        } catch {
            addFn = undefined;
            return null;
        }
    },

    setTitle(id: any, title: string): boolean {
        return BossBar.safe(() => titleFn(id, title) === true);
    },

    setHealth(id: any, percent: number): boolean {
        return BossBar.safe(() => healthFn(id, percent) === true);
    },

    setStyle(id: any, color: number, overlay: number): boolean {
        bind();
        if (styleFn == null) return false;
        return BossBar.safe(() => styleFn(id, color, overlay) === true);
    },

    remove(id: any): boolean {
        if (id == null) return false;
        bind();
        if (removeFn == null) return false;
        return BossBar.safe(() => removeFn(id) === true);
    },

    /** One update call: title + fill + colour. True only when all three landed. */
    update(id: any, title: string, percent: number, color: number, overlay: number): boolean {
        const a = BossBar.setTitle(id, title);
        const b = BossBar.setHealth(id, percent);
        const c = BossBar.setStyle(id, color, overlay);
        return a && b && c;
    },

    /** What the library thinks this bar looks like ("not_found" when the id is gone). */
    getInfo(id: any): string | null {
        const fn = Holo.bind("bossBarGetInfo");
        if (fn == null) return null;
        try {
            return String(fn(id) ?? "");
        } catch {
            return null;
        }
    },

    /**
     * Remove every bar this player owns.
     *
     * Only for an explicit user command: it cannot tell our bars from another plugin's. It is
     * the only way to clear bars that were created with an id we can no longer address.
     */
    removeAll(playerName: string): boolean {
        const fn = Holo.bind("bossBarRemoveAll");
        if (fn == null) return false;
        return BossBar.safe(() => {
            fn(playerName);
            return true;
        });
    },

    /** How many bars this player currently has (diagnostics only). */
    count(playerName: string): number | null {
        const fn = Holo.bind("bossBarCount");
        if (fn == null) return null;
        try {
            const n = Number(fn(playerName));
            return Number.isFinite(n) ? n : null;
        } catch {
            return null;
        }
    },

    /** A stale native handle must not break the HUD: drop it and rebind next time. */
    safe(fn: () => boolean): boolean {
        try {
            return fn();
        } catch {
            addFn = undefined;
            titleFn = undefined;
            healthFn = undefined;
            styleFn = undefined;
            removeFn = undefined;
            return false;
        }
    },

    reset(): void {
        addFn = undefined;
        titleFn = undefined;
        healthFn = undefined;
        styleFn = undefined;
        removeFn = undefined;
    },
};

export default BossBar;

/**
 * Candidate ways to hand a bar id back to the library, best first.
 *
 * A live session returned 8070450532247929000 - the double rounding of the real
 * 0x7000000000000000 = 8070450532247928832 - and passing that number straight back is what
 * the library looks up, so it answers false / not_found. The exact integer is still
 * recoverable from the double (it IS representable), so we try, in order:
 *
 *   bigint of the exact integer, that integer as a decimal string, the raw number, its string.
 *
 * The caller keeps whichever one the library actually accepts.
 */
export function idCandidates(raw: any): any[] {
    if (raw == null) return [];
    if (typeof raw === "bigint") return [raw, raw.toString()];
    if (typeof raw === "number") {
        if (Number.isSafeInteger(raw)) return [raw];
        const out: any[] = [];
        try {
            const exact = BigInt(raw);
            out.push(exact, exact.toString());
        } catch {
            // not an integral double - fall through to the raw forms
        }
        out.push(raw, String(raw));
        return out;
    }
    return [raw];
}

export function describeId(raw: any): string {
    if (raw == null) return "-";
    const type = typeof raw;
    if (type === "bigint") {
        const exact = (raw as bigint).toString();
        return exact + "(bigint)";
    }
    if (type === "number") {
        const exact = Number.isSafeInteger(raw) ? String(raw) : (() => {
            try { return BigInt(raw).toString(); } catch { return String(raw); }
        })();
        return exact + "(number" + (Number.isSafeInteger(raw) ? "" : ", 已超出 2^53") + ")";
    }
    return String(raw) + "(" + type + ")";
}
