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

export function volumeOf(sx: number, sy: number, sz: number): number {
    return Math.max(0, Math.trunc(sx)) * Math.max(0, Math.trunc(sy)) * Math.max(0, Math.trunc(sz));
}
