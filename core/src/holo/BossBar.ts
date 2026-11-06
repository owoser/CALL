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

    /** Create a bar for one player; returns the id or null when the API is missing. */
    add(playerName: string, title: string, percent: number, color: number, overlay: number): number | null {
        if (!BossBar.available()) return null;
        try {
            const id = Number(addFn(playerName, title, percent, color, overlay));
            return Number.isFinite(id) && id > 0 ? id : null;
        } catch {
            addFn = undefined;
            return null;
        }
    },

    setTitle(id: number, title: string): boolean {
        return BossBar.safe(() => titleFn(id, title) === true);
    },

    setHealth(id: number, percent: number): boolean {
        return BossBar.safe(() => healthFn(id, percent) === true);
    },

    setStyle(id: number, color: number, overlay: number): boolean {
        bind();
        if (styleFn == null) return false;
        return BossBar.safe(() => styleFn(id, color, overlay) === true);
    },

    remove(id: number | null | undefined): boolean {
        if (id == null) return false;
        bind();
        if (removeFn == null) return false;
        return BossBar.safe(() => removeFn(id) === true);
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
