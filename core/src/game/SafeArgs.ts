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
    return normaliseBlockStates(value) != null;
}

/** Remove one layer of wrapping double quotes (the parser may hand them back). */
function stripQuotes(s: string): string {
    let t = s.trim();
    if (t.length >= 2 && t.startsWith('"') && t.endsWith('"')) {
        t = t.slice(1, -1).replace(/\\"/g, '"');
    }
    return t;
}

/** Split on commas that are not inside quotes. */
function splitTopLevel(s: string): string[] {
    const out: string[] = [];
    let cur = "";
    let inQuotes = false;
    for (let i = 0; i < s.length; i++) {
        const ch = s[i];
        if (ch === '"' && s[i - 1] !== "\\") inQuotes = !inQuotes;
        if (ch === "," && !inQuotes) {
            out.push(cur);
            cur = "";
            continue;
        }
        cur += ch;
    }
    out.push(cur);
    return out;
}

/**
 * Split `key=value` (command syntax) or `"key":"value"` (json-ish).
 *
 * The separator must be found OUTSIDE quotes, because a state key can itself contain a
 * colon ("minecraft:vertical_half"). "=" wins when present, so an unquoted namespaced key
 * is not split at its own colon.
 */
function splitKeyValue(seg: string): { key: string; value: string } | null {
    let inQuotes = false;
    let eq = -1;
    let colon = -1;
    for (let i = 0; i < seg.length; i++) {
        const ch = seg[i];
        if (ch === '"' && seg[i - 1] !== "\\") {
            inQuotes = !inQuotes;
            continue;
        }
        if (inQuotes) continue;
        if (ch === "=" && eq < 0) eq = i;
        else if (ch === ":" && colon < 0) colon = i;
    }
    const at = eq >= 0 ? eq : colon;
    if (at <= 0) return null;
    const key = stripQuotes(seg.slice(0, at));
    if (key === "") return null;
    return { key, value: seg.slice(at + 1) };
}

function formatStateValue(raw: string): string | null {
    const s = stripQuotes(raw);
    if (s === "") return null;
    if (/^-?\d+(\.\d+)?$/.test(s)) return s;
    if (s === "true" || s === "false") return s;
    if (/^[A-Za-z0-9_.:-]+$/.test(s)) return '"' + s + '"';
    return null;
}

/**
 * Normalise a block-states argument to the exact syntax the command parser wants:
 * `["key"=value,"key2"="value2"]`.
 *
 * Accepted inputs (users type all of these, and 3.0.7 rejected every form except the
 * first, which is why `/ca fill minecraft:smooth_stone_slab [...]` reported
 * "invalid:minecraft:smooth_stone_slab"):
 *
 *   ["minecraft:vertical_half"="bottom"]      canonical
 *   [minecraft:vertical_half=bottom]          unquoted
 *   minecraft:vertical_half=bottom            no brackets
 *   {"minecraft:vertical_half":"bottom"}      json-ish
 *   a=1,b=true                                multiple, no spaces around commas
 *
 * @returns the canonical string, or null when there are no states / they are unusable
 */
export function normaliseBlockStates(value: any): string | null {
    if (value == null) return null;
    let s = String(value).replace(/[\r\n]/g, " ").trim();
    if (s === "") return null;
    s = stripQuotes(s);
    if (s === "" || s === "[]") return null;

    // tolerate json object form and unbalanced brackets
    if (s.startsWith("{") && s.endsWith("}")) s = s.slice(1, -1);
    if (s.startsWith("[")) s = s.slice(1);
    if (s.endsWith("]")) s = s.slice(0, -1);
    s = s.trim();
    if (s === "") return null;

    const parts: string[] = [];
    for (const chunk of splitTopLevel(s)) {
        const seg = chunk.trim();
        if (seg === "") continue;
        const split = splitKeyValue(seg);
        if (split == null) return null;
        const key = split.key.toLowerCase();
        // state keys may carry a namespace: "minecraft:vertical_half"
        if (!/^[a-z0-9_]+(:[a-z0-9_]+)?$/.test(key)) return null;
        const val = formatStateValue(split.value);
        if (val == null) return null;
        parts.push('"' + key + '"=' + val);
    }
    if (parts.length === 0) return null;
    return "[" + parts.join(",") + "]";
}

/**
 * Split `name[state=value,...]` into its parts.
 *
 * This form exists because the `States` command argument is a single String token: any
 * spaces inside `["a"=1]` split it, and the plugin then received a truncated value. Written
 * without spaces inside the block token it always survives parsing.
 */
export function splitBlockToken(value: any): { name: string; states: string } {
    const s = String(value ?? "").trim();
    const open = s.indexOf("[");
    if (open < 0) return { name: s, states: "" };
    const close = s.lastIndexOf("]");
    const name = s.slice(0, open).trim();
    const inner = close > open ? s.slice(open + 1, close) : s.slice(open + 1);
    return { name, states: "[" + inner + "]" };
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
/**
 * Does this output SAY the command succeeded?
 *
 * BDS 1.26.51 reports `success: false` for a /fill that completed, while printing the success
 * message - and on a server whose console has no language pack that message is the raw key
 * ("commands.fill.success"). Trusting the flag alone marked every slab of a fill as failed,
 * so a perfectly good fill ended up reported as an error (and /ca clear logged the same).
 */
export function isSuccessOutput(out: string): boolean {
    const text = String(out ?? "");
    if (text === "") return false;
    // raw translation key: commands.fill.success / commands.clone.success ...
    if (/commands\.[a-z0-9_.]*\.success\b/i.test(text)) return true;
    // localised success text (en / zh)
    if (/successfully|已填充|已复制|已放置|已清除/i.test(text)) return true;
    return false;
}

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
