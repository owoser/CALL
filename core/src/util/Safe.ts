/**
 * Failure containment for callback boundaries.
 *
 * LegacyScriptEngine >= 0.17.9 throws API failures straight into the calling script,
 * and an exception that escapes an event listener, command callback or timer is, at
 * best, logged and lost - at worst it takes the whole callback chain (and the player's
 * session) down with it. Every engine-owned callback therefore goes through one of the
 * helpers below: nothing may escape into the engine, and every failure is attributed to
 * a `tag` so the console log is actionable.
 */

const seen = new Map<string, number>();

function shouldLog(tag: string, message: string): boolean {
    // Collapse identical repeated failures (timers can fire fast) to one line per tag
    // per 5s, otherwise a broken timer floods the console and hides everything else.
    const key = tag + "|" + message;
    const now = Date.now();
    const last = seen.get(key) ?? 0;
    if (now - last < 5000) return false;
    seen.set(key, now);
    if (seen.size > 500) seen.clear();
    return true;
}

export function isDebug(): boolean {
    try {
        // Late import avoided on purpose: Config pulls in file APIs.
        const Config = require("../common/Config").default;
        return !!Config.get(Config.GLOBAL, "debugMod", false);
    } catch {
        return false;
    }
}

export function describeError(e: any): string {
    if (e == null) return "unknown error";
    if (typeof e === "string") return e;
    if (typeof e.message === "string") return e.message;
    try {
        return String(e);
    } catch {
        return "unserialisable error";
    }
}

/**
 * Run `fn` and swallow/log anything it throws.
 * @returns `fn`'s value, or `fallback` when it threw.
 */
export function safeCall<T>(tag: string, fn: () => T, fallback?: T): T | undefined {
    try {
        return fn();
    } catch (e) {
        logFailure(tag, e);
        return fallback;
    }
}

/** Start a promise chain that can never produce an unhandled rejection. */
export function runAsync(tag: string, fn: () => Promise<unknown>): void {
    let result: Promise<unknown>;
    try {
        result = fn();
    } catch (e) {
        logFailure(tag, e);
        return;
    }
    Promise.resolve(result).catch((e) => logFailure(tag, e));
}

export function logFailure(tag: string, e: any): void {
    const message = describeError(e);
    if (!shouldLog(tag, message)) return;
    const stack = e && typeof e.stack === "string" ? "\n" + e.stack : "";
    try {
        logger.error("[CALL][" + tag + "] " + message + stack);
    } catch {
        // logger not available yet / engine shutting down
    }
}

export function sleep(ms: number): Promise<void> {
    return new Promise((resolve) => setTimeout(resolve, Math.max(0, ms | 0)));
}

/**
 * Interval bookkeeping.
 *
 * 1.x started intervals with setInterval() and frequently never cleared them, so
 * per-player loops kept running (and kept touching stale Player handles) after the
 * player logged out. Use these instead of the bare globals.
 */
const intervals = new Set<number>();

export function every(tag: string, ms: number, fn: () => void): number {
    const id = setInterval(() => safeCall(tag, fn), ms) as unknown as number;
    intervals.add(id);
    return id;
}

export function everyFor(owner: { timers?: number[] }, tag: string, ms: number, fn: () => void): number {
    const id = every(tag, ms, fn);
    if (!owner.timers) owner.timers = [];
    owner.timers.push(id);
    return id;
}

export function stop(id: number): void {
    if (id == null) return;
    try {
        clearInterval(id);
    } catch {
        // ignore
    }
    intervals.delete(id);
}

export function stopAllOf(owner: { timers?: number[] }): void {
    if (!owner || !owner.timers) return;
    for (const id of owner.timers) stop(id);
    owner.timers = [];
}

export function stopEverything(): void {
    for (const id of [...intervals]) stop(id);
    intervals.clear();
}
