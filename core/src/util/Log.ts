/**
 * Console logging conventions.
 *
 * The host already prefixes every line with the plugin name ("[CALL] "), so our own messages only
 * carry their MODULE tag - writing "[CALL][preview] ..." produced the duplicated
 * "[CALL] [CALL][preview] ..." seen in the console.
 *
 * Debug output is marked [DBG] and stays silent unless `debugMod` is on.
 */
import Config from "../common/Config";

/** True when `debugMod` is enabled in configs.json. */
export function debugMod(): boolean {
    try {
        return Config.get(Config.GLOBAL, "debugMod", false) === true;
    } catch {
        return false;
    }
}

/** Normal line: "[CALL] [preview] ..." (the host adds the first part). */
export function info(tag: string, message: string): void {
    logger.info("[" + tag + "] " + message);
}

/** Warning line: "[CALL] [preview] ...". */
export function warn(tag: string, message: string): void {
    logger.warn("[" + tag + "] " + message);
}

/** Debug line: only with `debugMod`, and marked so it is obvious in a log dump. */
export function dbg(tag: string, message: string): void {
    if (!debugMod()) return;
    logger.debug("[DBG][" + tag + "] " + message);
}

export default { debugMod, info, warn, dbg };
