import * as fs from "fs";
import * as path from "path";
import Paths from "./Paths";

/**
 * Which build is running?
 *
 * `scripts/build.mjs` writes `build-stamp.json` next to `manifest.json` (version, build time,
 * short git SHA). Printing it at startup and in `/ca tools debug` ends the guessing that happens
 * when a screenshot could come from either the old or the new deploy.
 */
export interface BuildStamp {
    version: string;
    builtAt: string;
    gitSha: string;
}

let cached: BuildStamp | null | undefined;

export function stamp(): BuildStamp | null {
    if (cached !== undefined) return cached;
    try {
        const file = path.join(Paths.ROOT, "build-stamp.json");
        if (!fs.existsSync(file)) {
            cached = null;
            return cached;
        }
        const raw = JSON.parse(fs.readFileSync(file, "utf8"));
        cached = {
            version: String(raw?.version ?? "?"),
            builtAt: String(raw?.builtAt ?? "?"),
            gitSha: String(raw?.gitSha ?? "?"),
        };
    } catch {
        cached = null;
    }
    return cached;
}

/** One line for the startup log / the debug dump. */
export function describe(): string {
    const s = stamp();
    if (s == null) return "build: 无构建戳（不是 npm run build 产物）";
    return "build " + s.version + " (" + s.gitSha + ") " + s.builtAt;
}

export default { stamp, describe };
