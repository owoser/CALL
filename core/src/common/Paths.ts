import * as fs from "fs";
import * as path from "path";

/**
 * Locates this plugin's own directory and exposes every path CALL writes to.
 *
 * WHY THIS EXISTS
 * ---------------
 * Up to 1.6.1 every path in the plugin was the hardcoded string `./plugins/call`.
 * That breaks as soon as the plugin is installed under a different directory name,
 * when the server is started with a different working directory, or when a tool
 * queries paths before the engine is fully up.
 *
 * Resolution order:
 *   1. ll.getCurrentPluginInfo().filePath  - what the loader actually loaded
 *   2. this module's own location          - core/src/common -> plugin root
 *   3. <cwd>/plugins/call                  - historical layout, last resort
 */

function isFile(p: string): boolean {
    try {
        return fs.statSync(p).isFile();
    } catch {
        return false;
    }
}

function isDir(p: string): boolean {
    try {
        return fs.statSync(p).isDirectory();
    } catch {
        return false;
    }
}

function normalise(raw: string): string {
    const trimmed = raw.replace(/[\\/]+$/, "");
    // ll.getCurrentPluginInfo().filePath may point at the entry file instead of
    // the plugin directory, depending on how the plugin was installed.
    if (isDir(trimmed)) return trimmed;
    return path.dirname(trimmed);
}

function looksLikePluginRoot(dir: string): boolean {
    return isFile(path.join(dir, "manifest.json")) || isFile(path.join(dir, "package.json"));
}

function detectPluginRoot(): string {
    // 1. authoritative: ask the script engine
    try {
        const getInfo = (ll as any).getCurrentPluginInfo;
        if (typeof getInfo === "function") {
            const info = getInfo.call(ll);
            if (info && info.filePath) {
                const root = normalise(String(info.filePath));
                if (root) return root;
            }
        }
    } catch {
        // engine not ready yet - fall through
    }

    // 2. this file lives at <root>/core/src/common/Paths.js
    const fromModule = path.resolve(__dirname, "..", "..", "..");
    if (looksLikePluginRoot(fromModule)) return fromModule;

    // 3. historical layout
    const fromCwd = path.resolve(process.cwd(), "plugins", "call");
    return fromCwd;
}

const ROOT = detectPluginRoot();

const CONFIG_DIR = path.join(ROOT, "config");
const USERDATA_DIR = path.join(ROOT, "userdata");
const DATA_DIR = path.join(USERDATA_DIR, "data");
const USER_CONFIG_DIR = path.join(USERDATA_DIR, "config");

/** Directories that must exist before the plugin can read or write anything. */
const REQUIRED_DIRS = [
    CONFIG_DIR,
    USERDATA_DIR,
    USER_CONFIG_DIR,
    DATA_DIR,
    path.join(DATA_DIR, "nbt"),
    path.join(USERDATA_DIR, "plugins"),
    path.join(USERDATA_DIR, "temp"),
    path.join(USERDATA_DIR, "build"),
    path.join(USERDATA_DIR, "import"),
    path.join(USERDATA_DIR, "export"),
];

let dirsEnsured = false;

export default class Paths {
    public static readonly ROOT = ROOT;
    public static readonly CONFIG = CONFIG_DIR;
    public static readonly LANG = path.join(CONFIG_DIR, "lang");
    public static readonly BIN = path.join(ROOT, "bin");
    public static readonly USERDATA = USERDATA_DIR;
    public static readonly USER_CONFIG = USER_CONFIG_DIR;
    public static readonly DATA = DATA_DIR;
    public static readonly NBT = path.join(DATA_DIR, "nbt");
    public static readonly PLUGINS = path.join(USERDATA_DIR, "plugins");
    public static readonly TEMP = path.join(USERDATA_DIR, "temp");
    public static readonly BUILD = path.join(USERDATA_DIR, "build");
    public static readonly IMPORT = path.join(USERDATA_DIR, "import");
    public static readonly EXPORT = path.join(USERDATA_DIR, "export");

    public static join(...parts: string[]): string {
        return path.join(ROOT, ...parts);
    }

    /**
     * LegacyScriptEngine file APIs are happiest with forward slashes; Windows
     * accepts either, but JSON files embed these strings and mixing separators
     * makes them hard to diff.
     */
    public static toPosix(p: string): string {
        return p.replace(/\\/g, "/");
    }

    /** Idempotent. Safe to call from several modules during startup. */
    public static ensureDirs(): boolean {
        if (dirsEnsured) return true;
        let ok = true;
        for (const dir of REQUIRED_DIRS) {
            try {
                fs.mkdirSync(dir, { recursive: true });
            } catch (e) {
                ok = false;
                try {
                    logger.error("[CALL][Paths] cannot create directory: " + dir + " (" + (e as Error).message + ")");
                } catch {
                    // logger itself may not exist yet
                }
            }
        }
        dirsEnsured = ok;
        return ok;
    }
}

// Must happen before any JsonConfigFile/File is constructed.
Paths.ensureDirs();
