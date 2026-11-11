import * as fs from "fs";
import * as path from "path";
import Paths from "../common/Paths";
import Holo from "./Holo";

/**
 * HologramLib capability gate.
 *
 * The rule is the library author's: decide on the EXPORTED API SURFACE, not on a release
 * number. `typeof ll.import("HologramLib", name) === "function"` is the only reliable signal --
 * 442-export (26.60.6 / 26.51.10) and 450-export (26.60.8 / 26.51.11) builds both report
 * ABI 1.37.0, so a version comparison cannot tell them apart.
 *
 * Version strings are still collected, but only for the log line:
 *   holoAbiVersion() / holoLseVersion() / holoEndstoneVersion()  (450+ builds)
 *   holoApiVersion()  -> packed integer 0x012B00                     (older builds)
 *   manifest.json     -> release string + apiVersionSemver            (last resort)
 *
 * The ABI / LSE / endstone versions move independently; only a vtable change in
 * include/hologramlib/*.h forces C++ consumers to rebuild, which never concerns a script caller.
 *
 * Nothing here is fatal: a server without the library keeps every other feature. Missing
 * capabilities are announced once and the affected preview/paste features degrade.
 */

/** Supported ABI line. Documentation value only - never used to enable a feature. */
export const HOLO_ABI = "1.37.0";
/** First release of the 450-export surface (block states + block entities + version exports). */
export const HOLO_MIN_RELEASE_26_51 = "26.51.11";
export const HOLO_MIN_RELEASE_26_60 = "26.60.8";

export interface HoloCaps {
    /** The library answers at all (shapeCreateBox is its oldest stable export). */
    bridge: boolean;
    /** swingCount + swingTotal + swingReset: air left-click detection. */
    swing: boolean;
    /** blockFakeSet / blockFakeClear: per-cell fake blocks that accept state strings. */
    fakeStates: boolean;
    /** blockBatchSet / blockBatchClear: sub-chunk batched fake blocks. */
    batch: boolean;
    /** itemDisplayCreateAdvanced / itemDisplayDestroy + blockFakeClear: the walk-through visuals. */
    nearPass: boolean;
    /** itemDisplaySetMode: block mode, so the walk-through visual looks like a real block. */
    nearBlockMode: boolean;
    /** blockFakeSetBlockEntity: block entity payload (banner patterns, sign text, chests). */
    fakeEntity: boolean;
    /** viewBlockById: override by network id (full states). */
    viewById: boolean;
    /** viewBlockEntity: BlockActorData by serialized NBT bytes. */
    viewEntity: boolean;
    /** blockFakeSetNbt / blockFakeResolveNbt: SNBT-driven fake blocks. */
    snbt: boolean;
    /** holoLseVersion() present: this is the 450-export surface (also proves the shape fix). */
    versionExports: boolean;
}

export interface HoloStatus {
    installed: boolean;
    /** Release string, e.g. "26.60.8" - for humans only. */
    version: string;
    /** ABI/API semver, e.g. "1.37.0". */
    api: string;
    /** LSE export surface version, e.g. "1.0.0" ("unknown" on 442 builds). */
    lse: string;
    /** `count` from lib/exports.json, -1 when unreadable. */
    exports: number;
    caps: HoloCaps;
    /** Everything air-left-click needs (kept for the older call sites). */
    ok: boolean;
    reason: string;
}

const CAP_EXPORTS: Array<[keyof HoloCaps, string[]]> = [
    ["bridge", ["shapeCreateBox"]],
    ["swing", ["swingCount", "swingTotal", "swingReset"]],
    ["fakeStates", ["blockFakeSet", "blockFakeClear"]],
    ["batch", ["blockBatchSet", "blockBatchClear"]],
    ["nearPass", ["itemDisplayCreateAdvanced", "itemDisplayDestroy", "blockFakeClear"]],
    ["nearBlockMode", ["itemDisplaySetMode", "itemDisplaySetScale", "itemDisplaySetVisiblePlayer"]],
    ["fakeEntity", ["blockFakeSetBlockEntity"]],
    ["viewById", ["viewBlockById"]],
    ["viewEntity", ["viewBlockEntity"]],
    ["snbt", ["blockFakeSetNbt", "blockFakeResolveNbt"]],
    ["versionExports", ["holoLseVersion"]],
];

let cached: HoloStatus | null = null;
let cachedExports = -1;
let warned = false;

function libraryRoots(): string[] {
    return [
        path.join(Paths.SERVER_ROOT, "mods", "HologramLib"),
        path.join(Paths.SERVER_ROOT, "plugins", "HologramLib"),
    ];
}

/** The installed library's manifest, if any. */
function readManifest(): { version: string; api: string } | null {
    for (const root of libraryRoots()) {
        try {
            const file = path.join(root, "manifest.json");
            if (!fs.existsSync(file)) continue;
            const raw = JSON.parse(fs.readFileSync(file, "utf8"));
            return {
                version: String(raw?.version ?? "unknown"),
                api: String(raw?.extraInfo?.apiVersionSemver ?? "unknown"),
            };
        } catch {
            // try the next location
        }
    }
    return null;
}

/**
 * How many LSE exports does the installed build ship?
 *
 * `lib/exports.json` is the authoritative list (same file the library loads), so this answers
 * "which surface do I have" without guessing from a release number. -1 when unreadable.
 */
function readExportCount(): number {
    if (cachedExports >= 0) return cachedExports;
    for (const root of libraryRoots()) {
        try {
            const file = path.join(root, "lib", "exports.json");
            if (!fs.existsSync(file)) continue;
            const raw = JSON.parse(fs.readFileSync(file, "utf8"));
            const n = Number(raw?.count);
            if (isFinite(n) && n > 0) {
                cachedExports = n;
                return n;
            }
        } catch {
            // try the next location
        }
    }
    return -1;
}

function semverText(value: any): string {
    const text = value == null ? "" : String(value).trim();
    return /^\d+\.\d+/.test(text) ? text : "";
}

/** `holoLseVersion()` / `holoAbiVersion()` when the build has them. */
function liveVersion(name: string): string {
    return semverText(Holo.call(name));
}

/** `holoApiVersion()` returns the packed integer 0x012B00 -> "1.37.0". */
function packedApi(): string {
    const raw = Holo.call("holoApiVersion");
    const n = Number(raw);
    if (!isFinite(n) || n <= 0) return "";
    const major = (n >> 16) & 0xff;
    const minor = (n >> 8) & 0xff;
    const patch = n & 0xff;
    return major + "." + minor + "." + patch;
}

function capsOf(): HoloCaps {
    const caps = {} as HoloCaps;
    for (const [key, names] of CAP_EXPORTS) {
        caps[key] = names.every((n) => Holo.bind(n) != null);
    }
    return caps;
}

export function status(force = false): HoloStatus {
    if (cached != null && !force) return cached;

    const manifest = readManifest();
    const caps = capsOf();
    const installed = caps.bridge || manifest != null;
    const exports = readExportCount();

    const version = manifest?.version ?? "unknown";
    const api = liveVersion("holoAbiVersion") || packedApi() || semverText(manifest?.api) || "unknown";
    const lse = liveVersion("holoLseVersion") || "unknown";

    const missing: string[] = [];
    if (!caps.swing) missing.push("左键空气点击");
    if (!caps.fakeStates) missing.push("方块状态预览");
    if (!caps.fakeEntity) missing.push("方块实体预览/粘贴同步");

    let reason = "";
    if (!installed) {
        reason = "未检测到 HologramLib（线框、预览、左键空气点击不可用；其余功能正常）";
    } else if (missing.length > 0) {
        reason = "HologramLib 导出面偏旧（" + (exports > 0 ? exports + " 条" : "未知条数") +
            "，需要 450 条）：已禁用 " + missing.join("、") +
            "；请升级到 " + HOLO_MIN_RELEASE_26_60 + "（26.60 线）/ " + HOLO_MIN_RELEASE_26_51 + "（26.51 线）";
    }

    cached = {
        installed,
        version,
        api,
        lse,
        exports,
        caps,
        ok: caps.swing,
        reason,
    };
    return cached;
}

/**
 * Can `shapeDestroy` actually remove a shape from clients?
 *
 * Before the shape-fix release the remove packet still carried `shape_type` (defaulted to Box),
 * so clients treated it as an update and kept the shape. CALL works around that by parking
 * shapes far below the world first. The 450-export surface is newer than the fix, so the
 * version exports are the proof we use - not a release number.
 */
export function removeReliable(): boolean {
    const s = status();
    return s.installed && s.caps.versionExports;
}

/** `swingCount(name)` or null when unavailable. Never throws. */
export function swingCount(name: string): number | null {
    if (!status().ok) return null;
    const n = Holo.call("swingCount", String(name ?? ""));
    return typeof n === "number" && isFinite(n) ? n : null;
}

/** True when left-click detection can run. */
export function swingAvailable(): boolean {
    return status().ok;
}

/** The capability word used in logs: one character per feature. */
function mark(on: boolean): string {
    return on ? "✓" : "✗";
}

/** One concise line for the startup log and `/ca tools status`. */
export function describe(): string {
    const s = status();
    if (!s.installed) return "HologramLib: 未安装（线框/预览/左键不可用）";
    const surface = s.exports > 0 ? s.exports + " exports" : "unknown exports";
    const head = "HologramLib " + s.version + " (ABI " + s.api +
        (s.lse === "unknown" ? "" : " / LSE " + s.lse) + " · " + surface + ")";
    const c = s.caps;
    const tail = "状态" + mark(c.fakeStates) + " 批量" + mark(c.batch) +
        " 方块实体" + mark(c.fakeEntity) + " 粘贴同步" + mark(c.fakeEntity) +
        " swing" + mark(c.swing);
    return head + " — " + tail + (s.reason === "" ? "" : "；" + s.reason);
}

/**
 * Diagnostic lines for `/ca tools debug`: proves the pieces this build claims to have.
 *
 * Everything is read-only - it resolves a state string, resolves an SNBT payload and asks the
 * batch encoder to parse a two-cell payload. Nothing is sent to a client.
 */
export function probe(): string[] {
    const s = status(true);
    const lines: string[] = [describe()];
    lines.push("导出面: " + (s.exports > 0 ? s.exports + " 条" : "读不到 lib/exports.json") +
        "，ABI=" + s.api + "，LSE=" + s.lse);

    if (!s.installed) return lines;

    lines.push("holoAbiVersion=" + (liveVersion("holoAbiVersion") || "(无此导出)") +
        " holoLseVersion=" + (liveVersion("holoLseVersion") || "(无此导出)") +
        " holoApiVersion=" + (packedApi() || "(不可用)"));

    const stateStr = 'minecraft:stone_stairs["weirdo_direction"=2,"upside_down_bit"=false]';
    if (s.caps.fakeStates) {
        const id = Holo.call("blockFakeResolve", stateStr);
        lines.push("blockFakeResolve(楼梯带状态) = " + (typeof id === "number" ? id : "n/a") +
            (typeof id === "number" && id >= 0 ? " (状态串被接受)" : " (状态串被拒绝!)"));
    }
    if (s.caps.snbt) {
        const snbt = '{"name":"minecraft:stone_stairs","states":{"weirdo_direction":2},"version":18168865}';
        const id = Holo.call("blockFakeResolveNbt", snbt);
        lines.push("blockFakeResolveNbt(楼梯 SNBT) = " + (typeof id === "number" ? id : "n/a"));
    }
    if (s.caps.batch) {
        const packed = "0 0 0 " + stateStr + ";1 0 0 minecraft:oak_stairs[waterlogged=true]";
        const report = Holo.call("blockBatchSelfTest", packed);
        lines.push("blockBatchSelfTest = " + (report == null ? "n/a" : String(report).slice(0, 200)));
    }
    return lines;
}

/** Report a missing/old library exactly once per start (info when it is fine). */
export function warnOnce(): void {
    if (warned) return;
    warned = true;
    const s = status();
    try {
        if (s.reason === "") logger.info("[CALL] " + describe());
        else logger.warn("[CALL] " + describe());
    } catch {
        // logger missing (unit tests)
    }
}

/** Forget the probe (tests / after the admin installs the library). */
export function reset(): void {
    cached = null;
    cachedExports = -1;
    warned = false;
    Holo.reload();
}

export default {
    HOLO_ABI,
    HOLO_MIN_RELEASE_26_51,
    HOLO_MIN_RELEASE_26_60,
    status,
    swingCount,
    swingAvailable,
    removeReliable,
    describe,
    probe,
    warnOnce,
    reset,
};
