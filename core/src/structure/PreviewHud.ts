/**
 * Pure helpers for the preview HUD (countdown text/style) and the click gestures.
 *
 * Kept free of engine globals so the wording, the colour thresholds and the gesture table can
 * be unit tested without a server. `PreviewOperation` owns the actual timers and native calls.
 */

/**
 * What a click with a tool item should do.
 *
 *   right            -> set the anchor, or rotate the live preview
 *   right + sneaking -> confirm the paste
 *   left             -> set / move the anchor
 *   left  + sneaking -> CANCEL the preview (mobile: sneak + tap the block)
 */
export type PreviewGesture = "set" | "rotate" | "confirm" | "move" | "cancel";

export function gestureOf(button: "left" | "right", sneaking: boolean, hasPreview: boolean): PreviewGesture {
    if (button === "left") {
        if (!sneaking) return hasPreview ? "move" : "set";
        return "cancel";
    }
    if (sneaking) return "confirm";
    return hasPreview ? "rotate" : "set";
}

export type CountdownMode = "auto" | "always" | "off";

/** Sanitise the `previewCountdown` config value. */
export function countdownMode(raw: any): CountdownMode {
    const text = String(raw ?? "").trim().toLowerCase();
    if (text === "off" || text === "none" || text === "0" || text === "false") return "off";
    if (text === "always" || text === "on" || text === "1" || text === "true") return "always";
    return "auto";
}

/** Whole seconds left, never negative, never NaN. */
export function remainingSeconds(remainingMs: number): number {
    const ms = Number(remainingMs);
    if (!Number.isFinite(ms) || ms <= 0) return 0;
    return Math.ceil(ms / 1000);
}

/** `auto` only shows the bar for the last stretch; `always` shows it all the time. */
export const AUTO_VISIBLE_MS = 20000;

export function countdownVisible(mode: CountdownMode, remainingMs: number): boolean {
    if (mode === "off") return false;
    if (remainingMs <= 0) return false;
    if (mode === "always") return true;
    return remainingMs <= AUTO_VISIBLE_MS;
}

/** 0..1 for the bar fill; 0 when the deadline has passed. */
export function bossBarProgress(remainingMs: number, totalMs: number): number {
    const total = Number(totalMs);
    if (!Number.isFinite(total) || total <= 0) return 0;
    const left = Math.max(0, Number(remainingMs) || 0);
    return Math.min(1, Math.max(0, left / total));
}

/** Boss bar colour ids: 1 = blue, 2 = red. Overlay 0 = solid. */
export function bossBarStyle(remainingMs: number): { color: number; overlay: number } {
    return { color: remainingMs <= 10000 ? 2 : 1, overlay: 0 };
}

/**
 * The countdown title.
 *
 * Kept to one short line: it sits above the hotbar and must not cover the screen. Colour and
 * wording escalate near the end so a glance is enough.
 */
export function countdownText(remainingMs: number): string {
    const left = remainingSeconds(remainingMs);
    if (left <= 0) return "§c预览已结束";
    const head = left <= 5
        ? "§c§l预览即将取消 §f" + left + "§cs"
        : left <= 10
            ? "§c预览剩余 §f" + left + "§cs"
            : "§e预览剩余 §f" + left + "§7s";
    return head + "  §8| §7右键=旋转 §8| §7潜行右键=粘贴 §8| §7潜行左键=取消";
}

/** Plain-text variant for the action bar fallback (no boss bar available). */
export function countdownActionBar(remainingMs: number): string {
    const left = remainingSeconds(remainingMs);
    if (left <= 0) return "§c预览已结束";
    return (left <= 10 ? "§c" : "§e") + "预览剩余 " + left + "s §8· §7潜行左键=取消";
}

/** What to do with a boss bar that is not taking updates. */
export type BarAction = "keep" | "rebuild" | "giveup";

export const MAX_BAR_REBUILDS = 3;

/**
 * Decide the bar's fate from its failure history.
 *
 * One failed update can be a transient hiccup (the library may be mid-rebuild); two in a row
 * means the id is dead, and rebuilding it is cheap. After a few rebuilds the library clearly
 * cannot keep this bar alive, so the caller falls back to the action bar instead of fighting
 * it forever.
 */
export function nextBarAction(fails: number, rebuilds: number, maxRebuilds: number = MAX_BAR_REBUILDS): BarAction {
    const f = Number(fails) || 0;
    const r = Number(rebuilds) || 0;
    if (f < 2) return "keep";
    return r < maxRebuilds ? "rebuild" : "giveup";
}
