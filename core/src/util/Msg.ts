import { describeError } from "./Safe";

/**
 * The single outgoing-message path for CALL.
 *
 * Why this exists: `Player.tell/sendText` is the one API every code path touches, and
 * every misuse of it is player-visible. Known sharp edges on LegacyScriptEngine 0.22:
 *
 *  - an empty or non-string message is rejected (and before 0.22.3 an empty string
 *    actually disconnected the player - issue #394);
 *  - a type outside 0..11 silently falls back, but a `TextObject` (type 9) whose body
 *    is not a rawtext JSON document makes the client drop the packet or the session;
 *  - calling it on a stale `Player` handle (cached before the player logged out)
 *    throws into whatever callback holds the handle.
 *
 * `tell()` normalises all of that in one place.
 */

/** Values accepted by `Player.tell(msg, type)` - see core/src/temp/Enums.ts for the caveat about 3 vs 4. */
export const MsgType = {
    RAW: 0,
    CHAT: 1,
    POPUP: 4,
    TIP: 5,
    JSON: 9,
} as const;

/** BDS rejects absurdly large text packets; keep messages well under the limit. */
const MAX_LEN = 2000;

function toText(value: any): string {
    if (value == null) return "";
    if (typeof value === "string") return value;
    try {
        return String(value);
    } catch {
        return "";
    }
}

function clamp(text: string): string {
    if (text.length <= MAX_LEN) return text;
    return text.slice(0, MAX_LEN - 12) + "…(truncated)";
}

function isRawText(text: string): boolean {
    try {
        const parsed = JSON.parse(text);
        return parsed != null && typeof parsed === "object" && Array.isArray(parsed.rawtext);
    } catch {
        return false;
    }
}

function normaliseType(type: any): number {
    const n = typeof type === "number" ? type : MsgType.RAW;
    if (!Number.isFinite(n) || n < 0 || n > 11) return MsgType.RAW;
    return n | 0;
}

/**
 * Send one message to a player.
 * @returns true when the packet was handed to the engine.
 */
export function tell(player: Player | null | undefined, text: any, type: number = MsgType.RAW): boolean {
    if (!player) return false;

    const body = clamp(toText(text));
    if (body.length === 0) return false;

    let kind = normaliseType(type);
    // TextObject requires a rawtext document; anything else is downgraded rather than
    // risking a malformed packet.
    if (kind === MsgType.JSON && !isRawText(body)) kind = MsgType.RAW;

    try {
        return player.sendText(body, kind) !== false;
    } catch (e) {
        try {
            logger.debug("[CALL][Msg] send failed: " + describeError(e));
        } catch {
            // nothing else we can do
        }
        return false;
    }
}

/**
 * Send text as a TextObject, wrapping it in a rawtext document.
 * Use this instead of passing type 9 with a plain string.
 */
export function tellRaw(player: Player | null | undefined, text: any, type: number = MsgType.JSON): boolean {
    const body = toText(text);
    if (body.length === 0) return false;
    const payload = JSON.stringify({ rawtext: [{ text: body }] });
    return tell(player, payload, type);
}

export function broadcast(text: any, type: number = MsgType.RAW): number {
    let sent = 0;
    try {
        for (const pl of mc.getOnlinePlayers()) {
            if (tell(pl, text, type)) sent++;
        }
    } catch (e) {
        try {
            logger.debug("[CALL][Msg] broadcast failed: " + describeError(e));
        } catch {
            // ignore
        }
    }
    return sent;
}

/** Resolve a live Player handle from an xuid; null when the player is offline. */
export function online(xuid: string): Player | null {
    if (!xuid) return null;
    try {
        return mc.getPlayer(xuid) ?? null;
    } catch {
        return null;
    }
}

/** Tell a player by xuid. Returns false when they are offline. */
export function tellXuid(xuid: string, text: any, type: number = MsgType.RAW): boolean {
    return tell(online(xuid), text, type);
}
