import * as fs from "fs";
import * as path from "path";
import Paths from "../common/Paths";
import { atLeast } from "../common/Semver";
import Holo from "./Holo";

/**
 * Version gate for HologramLib.
 *
 * CALL uses `swingCount()` (left-click detection, see SwingWatcher) which only exists from
 * 26.51.9 / 26.60.5 (API 1.37.0). 26.51.8 shipped a different, withdrawn `swing*` surface, so
 * a plain ">= 26.51.0" check would accept a library that then silently never reports a swing.
 *
 * Nothing here is fatal: a server without the library keeps every other feature, and the only
 * loss is air-left-click, which is announced once.
 */

export const HOLO_MIN_API = "1.37.0";
export const HOLO_MIN_26_51 = "26.51.9";
export const HOLO_MIN_26_60 = "26.60.5";

export interface HoloStatus {
    installed: boolean;
    version: string;
    api: string;
    /** can we actually call swingCount? */
    swing: boolean;
    /** everything required for air-left-click */
    ok: boolean;
    reason: string;
}

let cached: HoloStatus | null = null;
let warned = false;

/** The manifest of the installed library, if any. */
function readManifest(): { version: string; api: string } | null {
    const roots = [
        path.join(Paths.SERVER_ROOT, "plugins", "HologramLib"),
        path.join(Paths.SERVER_ROOT, "mods", "HologramLib"),
    ];
    for (const root of roots) {
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
 * The API semver the library reports.
 *
 * `holoApiVersion()` returns the PACKED integer (0x012B00 = 76544), which cannot be compared
 * against "1.37.0" - the manifest's `extraInfo.apiVersionSemver` is the human readable one and
 * is what the gate uses. The runtime call is only trusted when it actually looks like a semver.
 */
function readApi(manifestApi: string): string {
    const live = Holo.call("holoApiVersion");
    const text = live == null ? "" : String(live).trim();
    if (/^\d+\.\d+/.test(text)) return text;
    const fromManifest = String(manifestApi ?? "").trim();
    if (/^\d+\.\d+/.test(fromManifest)) return fromManifest;
    return "unknown";
}

/** Which minimum applies: the 26.60 line needs 26.60.5, everything else 26.51.9. */
function requiredFor(version: string): string {
    return /^26\.(60|61)/.test(version) ? HOLO_MIN_26_60 : HOLO_MIN_26_51;
}

export function status(force = false): HoloStatus {
    if (cached != null && !force) return cached;

    const manifest = readManifest();
    const swing = Holo.bind("swingCount") != null;
    const installed = manifest != null || swing;
    const version = manifest?.version ?? "unknown";
    const api = readApi(manifest?.api ?? "unknown");

    let ok = false;
    let reason = "";
    if (!installed) {
        reason = "未检测到 HologramLib（左键空气点击不可用，其余功能正常）";
    } else if (!swing) {
        reason = "HologramLib 版本过低：当前 " + version + "，需要 ≥" + requiredFor(version) +
            "（或 API ≥" + HOLO_MIN_API + "）—— 缺少 swingCount，左键空气点击已禁用";
    } else if (!atLeast(api, HOLO_MIN_API)) {
        reason = "HologramLib API 版本过低：当前 " + api + "，需要 ≥" + HOLO_MIN_API +
            "（版本 " + version + "）—— 左键空气点击已禁用";
    } else if (!atLeast(version, requiredFor(version))) {
        reason = "HologramLib 版本过低：当前 " + version + "，需要 ≥" + requiredFor(version) +
            " —— 左键空气点击已禁用";
    } else {
        ok = true;
    }

    cached = { installed, version, api, swing, ok, reason };
    return cached;
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

/** One concise line for the startup log and /ca tools status. */
export function describe(): string {
    const s = status();
    if (!s.installed) return "HologramLib: 未安装";
    return "HologramLib: " + s.version + " (API " + s.api + ")" + (s.ok ? " — 左键空气点击可用" : " — " + s.reason);
}

/** Report a missing/old library exactly once per start (info when it is fine). */
export function warnOnce(): void {
    if (warned) return;
    warned = true;
    const s = status();
    try {
        if (s.ok) logger.info("[CALL] " + describe());
        else if (s.installed) logger.warn("[CALL] " + describe());
        else logger.warn("[CALL] " + describe());
    } catch {
        // logger missing (unit tests)
    }
}

/** Forget the probe (tests / after the admin installs the library). */
export function reset(): void {
    cached = null;
    warned = false;
    Holo.reload();
}

export default { HOLO_MIN_API, HOLO_MIN_26_51, HOLO_MIN_26_60, status, swingCount, swingAvailable, describe, warnOnce, reset };
