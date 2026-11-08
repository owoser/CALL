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
/** Slack for clock/tick jitter when matching a swing to its block click. */
const WINDOW_SLACK_MS = 20;
/** Never turn one poll's delta into more than this many clicks. */
const MAX_PER_WINDOW = 3;

type Counter = (name: string) => number | null;

let counterSource: Counter | null = null;
const baseline = new Map<string, number>();
const lastBlockLeft = new Map<string, number>();
const timers = new Map<string, any>();
/** When this player was last polled (bounds the window a swing belongs to). */
const lastPollAt = new Map<string, number>();
let pollMs = 200;

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

    /** The ticker interval, needed to size the "did it hit something?" window. */
    setPollInterval(ms: number): void {
        const n = Number(ms);
        pollMs = Number.isFinite(n) && n > 0 ? n : 200;
    },

    /**
     * Poll one player; calls `onAirLeft` when a swing turns out to have hit nothing.
     *
     * The window is built from the PREVIOUS poll, not the current one: the client sends the
     * swing and the block interaction in the same tick, so by the time the counter is read the
     * block event has usually already arrived. Comparing against "now" (the old code) made
     * every block click look like a click on air, which then overwrote the selection with the
     * player's feet.
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

        const xuid = caPlayer.xuid;
        const polledAt = Date.now();
        const windowFrom = lastPollAt.get(xuid) ?? polledAt - pollMs;
        lastPollAt.set(xuid, polledAt);

        const prev = baseline.get(xuid);
        if (prev == null) {
            // First sighting: never treat history as a click.
            baseline.set(xuid, now);
            return;
        }
        if (now === prev) return;

        baseline.set(xuid, now);   // consume the delta either way
        if (now < prev) return;     // swingReset was called

        // A block/entity click this recently explains the swing outright.
        const blockAt = lastBlockLeft.get(xuid) ?? 0;
        if (blockAt >= windowFrom - WINDOW_SLACK_MS) return;
        if (polledAt - blockAt < pollMs + DEDUPE_MS + WINDOW_SLACK_MS) return;

        const times = Math.min(MAX_PER_WINDOW, Math.max(1, now - prev));
        for (let i = 0; i < times; i++) {
            setTimeout(() => {
                const at = Date.now();
                const last = lastBlockLeft.get(xuid) ?? 0;
                // Re-check at fire time: a block click may have arrived while waiting.
                if (last >= windowFrom - WINDOW_SLACK_MS && at - last <= pollMs + DEDUPE_MS + WINDOW_SLACK_MS) return;
                try {
                    onAirLeft(caPlayer);
                } catch (e) {
                    try {
                        logger.warn("[CALL][swing] " + (e && (e as any).message ? (e as any).message : e));
                    } catch {
                        // ignore
                    }
                }
            }, DEDUPE_MS + i * 30);
        }
    },
    /** Drop per-player state (leave). */
    forget(xuid: string): void {
        baseline.delete(xuid);
        lastBlockLeft.delete(xuid);
        lastPollAt.delete(xuid);
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
        lastPollAt.clear();
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
