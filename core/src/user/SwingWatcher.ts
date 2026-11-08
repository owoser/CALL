import Holo from "../holo/Holo";
import { swingCount, swingAvailable } from "../holo/HoloCompat";
import CAPlayer from "./CAPlayer";

/**
 * Detect a LEFT CLICK, including a left click on air.
 *
 * Why this exists: LSE's player events only report left clicks that land on a block or an
 * entity (onStartDestroyBlock / onAttackBlock / onAttackEntity). The client sends no packet
 * for a swing at nothing, so a wand could not react to "left click air" at all.
 *
 * HologramLib counts every AnimatePacket(Swing) - air, block or entity - and exposes the
 * counter (swingCount). The protocol does not say what was hit, so the plugin decides:
 * a block/entity click always arrives as its own event right around the swing, so a swing that
 * is NOT followed by one within DEDUPE_MS is treated as a click on air.
 *
 * The counter is per player real name, case sensitive, and survives a relog (until
 * swingReset), so each player's first poll becomes the baseline - otherwise yesterday's
 * clicks would fire the moment they join.
 */

/** How long to wait for a block/entity click before calling it a click on air. */
export const DEDUPE_MS = 100;

type Counter = (name: string) => number | null;

let counterSource: Counter | null = null;
const baseline = new Map<string, number>();
const lastBlockLeft = new Map<string, number>();
const timers = new Map<string, any>();

function count(realName: string): number | null {
    if (counterSource != null) {
        try {
            return counterSource(realName);
        } catch {
            return null;
        }
    }
    return swingCount(realName);
}

export const SwingWatcher = {
    DEDUPE_MS,

    /** Tests inject a fake counter so the live suite needs no real client. */
    setCounterSource(fn: Counter | null): void {
        counterSource = fn;
        baseline.clear();
    },

    /** Is left-click detection possible right now? */
    available(): boolean {
        return counterSource != null || swingAvailable();
    },

    /** Remember where this player's counter starts (call on join). */
    track(caPlayer: CAPlayer): void {
        if (caPlayer == null) return;
        let name = "";
        try {
            name = String(caPlayer.$.realName ?? "");
        } catch {
            return;
        }
        if (name === "") return;
        const n = count(name);
        if (n == null) return;
        baseline.set(caPlayer.xuid, n);
    },

    /** A left click that hit a block or an entity: not an air click. */
    noteBlockLeft(caPlayer: CAPlayer | null | undefined): void {
        if (caPlayer == null) return;
        lastBlockLeft.set(caPlayer.xuid, Date.now());
    },

    /**
     * Poll one player; calls `onAirLeft` when a swing turns out to have hit nothing.
     *
     * Safe to call every `toolSwingPollMs`: the counter is only read, and the decision is
     * deferred by DEDUPE_MS so a block click can cancel it.
     */
    poll(caPlayer: CAPlayer, onAirLeft: (caPlayer: CAPlayer) => void): void {
        if (caPlayer == null) return;
        if (!SwingWatcher.available()) return;
        let name = "";
        try {
            name = String(caPlayer.$.realName ?? "");
        } catch {
            return;
        }
        if (name === "") return;

        const now = count(name);
        if (now == null) return;

        const prev = baseline.get(caPlayer.xuid);
        if (prev == null) {
            // First sighting: never treat history as a click.
            baseline.set(caPlayer.xuid, now);
            return;
        }
        if (now === prev) return;

        baseline.set(caPlayer.xuid, now);   // consume the delta either way
        if (now < prev) return;             // swingReset was called

        const xuid = caPlayer.xuid;
        const since = Date.now();
        if (timers.has(xuid)) return;       // one decision in flight is enough
        const timer = setTimeout(() => {
            timers.delete(xuid);
            const blockAt = lastBlockLeft.get(xuid) ?? 0;
            if (blockAt >= since - 5) return;   // it did hit something
            try {
                onAirLeft(caPlayer);
            } catch (e) {
                try {
                    logger.warn("[CALL][swing] " + (e && (e as any).message ? (e as any).message : e));
                } catch {
                    // ignore
                }
            }
        }, DEDUPE_MS);
        timers.set(xuid, timer);
    },

    /** Drop per-player state (leave). */
    forget(xuid: string): void {
        baseline.delete(xuid);
        lastBlockLeft.delete(xuid);
        const t = timers.get(xuid);
        if (t != null) {
            try {
                clearTimeout(t);
            } catch {
                // ignore
            }
            timers.delete(xuid);
        }
    },

    /** Test helper. */
    reset(): void {
        baseline.clear();
        lastBlockLeft.clear();
        for (const t of timers.values()) {
            try {
                clearTimeout(t);
            } catch {
                // ignore
            }
        }
        timers.clear();
    },
};

export default SwingWatcher;
