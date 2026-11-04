/**
 * Validation for values that end up in packets sent to the client.
 *
 * WHY THIS EXISTS - a real incident
 * ---------------------------------
 * CALL 1.x/2.0 passed `11` as the boss-bar colour for fill/clear/replace (see
 * FillService). LegacyScriptEngine's `PlayerClass::setBossBar` does
 *
 *     BossBarColor color = static_cast<BossBarColor>(args[3].asNumber().toInt32());
 *
 * with no range check, and LeviLamina's BossBarColor is `enum class : uchar`
 * with only 0..7. The client received a BossEventPacket with an out-of-range colour
 * and dropped the connection (ClientDisconnection-90) *while the server kept running* -
 * which is exactly the "fill kicks me off the server" symptom. Copy/paste used 1 and 6,
 * so they never tripped it.
 *
 * Anything client-visible goes through this module from now on.
 */

/** Number of values in BDS' BossBarColor enum (Pink..White). */
export const BOSS_BAR_COLORS = 8;

/** Clamp a boss-bar colour to a value the client can decode. */
export function bossBarColor(value: any, fallback = 0): number {
    const n = Math.trunc(Number(value));
    if (!Number.isFinite(n)) return fallback;
    if (n < 0) return 0;
    if (n >= BOSS_BAR_COLORS) return BOSS_BAR_COLORS - 1;
    return n;
}

/** Clamp a boss-bar percentage to 0..100. */
export function bossBarPercent(value: any): number {
    const n = Number(value);
    if (!Number.isFinite(n)) return 0;
    if (n < 0) return 0;
    if (n > 100) return 100;
    return n;
}

/** TextPacket types accepted by `Player.tell` (LSE accepts 0..11). */
export function messageType(value: any, fallback = 0): number {
    const n = Math.trunc(Number(value));
    if (!Number.isFinite(n) || n < 0 || n > 11) return fallback;
    return n;
}

/** Dimension ids BDS can address. */
export function dimensionId(value: any, fallback = 0): 0 | 1 | 2 {
    const n = Math.trunc(Number(value));
    return n === 1 || n === 2 ? (n as 0 | 1 | 2) : (n === 0 ? 0 : (fallback as 0 | 1 | 2));
}

/** Y range of the current world height. */
export const WORLD_MIN_Y = -64;
export const WORLD_MAX_Y = 320;

export function clampY(value: any): number {
    const n = Math.trunc(Number(value));
    if (!Number.isFinite(n)) return 0;
    return Math.max(WORLD_MIN_Y, Math.min(WORLD_MAX_Y, n));
}

/**
 * Normalise a block identifier the way the game does.
 *
 * The command parser accepts a bare name and assumes the `minecraft:` namespace, and CALL
 * itself writes bare names: `/ca clear` builds `new BlockType("air")`, and Lua/JS shape
 * packs commonly use `stone`. 3.0.1 rejected those with "invalid block or region: air"
 * and silently cleared nothing.
 *
 * @returns the canonical `namespace:path`, or null when it cannot be a block name
 */
export function normaliseBlockName(value: any): string | null {
    if (typeof value !== "string") return null;
    let name = value.trim().toLowerCase();
    if (name === "") return null;
    if (!name.includes(":")) name = "minecraft:" + name;
    // namespace and path are dot-separated segments; this rejects "..", leading or
    // trailing dots/slashes, and anything else that could smuggle extra arguments into
    // the command line.
    return /^[a-z0-9_-]+(?:\.[a-z0-9_-]+)*:[a-z0-9_-]+(?:\.[a-z0-9_-]+)*$/.test(name) ? name : null;
}

/** A block name is only safe to interpolate into a command when it resolves. */
export function isBlockName(value: any): boolean {
    return normaliseBlockName(value) != null;
}

/**
 * Block states for command syntax look like `["a"=1,"b"="x"]`.
 * Empty states must be omitted entirely - emitting `[]` plus an empty follow-up
 * argument used to produce commands with stray empty parameters.
 */
export function isBlockStates(value: any): boolean {
    if (typeof value !== "string") return false;
    const s = value.trim();
    // "" and "[]" are the same thing: there are no states, so nothing must be emitted.
    if (s === "" || s === "[]") return false;
    if (!s.startsWith("[") || !s.endsWith("]")) return false;
    return !/[\r\n]/.test(s);
}

/** Volume guard for a single /fill or /clone command (BDS limit). */
export const MAX_FILL_VOLUME = 32768;

/** What we actually aim for per command: 32768 is the hard ceiling, so keep a margin. */
export const SAFE_FILL_VOLUME = 30000;

/**
 * How tall a fill slab may be before it risks hitting MAX_FILL_VOLUME.
 *
 * `/fill` is capped at 32768 blocks per command. A full 64x64 slice with the old fixed
 * height of 8 produced exactly 32768, i.e. zero margin.
 */
/**
 * Should a restore write this cell at all?
 *
 * Restoring a big region is dominated by cells that are already correct - undoing a clear
 * is almost entirely air, which is already air in the world. Writing those is pure waste.
 *
 * Only skipped when the target block carries no states: if it has states, the name matches
 * but the variant may not, so it must be written.
 */
export function shouldWriteTarget(currentType: string, targetName: string, hasStates: boolean): boolean {
    if (hasStates) return true;
    if (targetName == null || targetName === "") return false;
    return String(currentType ?? "") !== String(targetName);
}

export type CmdErrorClass = "not-loaded" | "noop" | "other";

/**
 * Classify a command result.
 *
 * BDS reports UNLOADED CHUNKS as "无法在世界外放置方块" / "Cannot place blocks outside of the
 * world" (verified: the same /fill succeeds once a ticking area covers the region), and it
 * reports a fill that changed nothing as a failure too. Neither is a real error.
 */
export function classifyCmdError(out: string, ok: boolean): CmdErrorClass {
    if (ok) return "other";
    const text = String(out ?? "");
    if (/无法在世界外|outside of the world|超出世界/i.test(text)) return "not-loaded";
    if (/(^|\s)0\s*(个|blocks?\b)/i.test(text)) return "noop";
    return "other";
}

export function slabHeight(xSpan: number, zSpan: number, maxHeight = 8): number {
    const perLayer = Math.max(1, Math.trunc(xSpan) || 1) * Math.max(1, Math.trunc(zSpan) || 1);
    const fit = Math.floor(SAFE_FILL_VOLUME / perLayer);
    return Math.max(1, Math.min(Math.max(1, maxHeight), fit || 1));
}

export function volumeOf(sx: number, sy: number, sz: number): number {
    return Math.max(0, Math.trunc(sx)) * Math.max(0, Math.trunc(sy)) * Math.max(0, Math.trunc(sz));
}
