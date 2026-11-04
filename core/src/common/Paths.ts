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
    // 1. This file is compiled to <root>/core/src/common/Paths.js, so three levels up
    //    is always the plugin directory - absolute and independent of the server's
    //    working directory. Preferred because it cannot be fooled.
    const fromModule = path.resolve(__dirname, "..", "..", "..");
    if (looksLikePluginRoot(fromModule)) return fromModule;

    // 2. Ask the script engine. On LSE 0.22 `filePath` may be just the entry file name
    //    ("index.js"), so the result is only trusted when it actually looks like a
    //    plugin root.
    try {
        const getInfo = (ll as any).getCurrentPluginInfo;
        if (typeof getInfo === "function") {
            const info = getInfo.call(ll);
            if (info && info.filePath) {
                const raw = String(info.filePath);
                const candidates = [normalise(raw), path.resolve(process.cwd(), raw)];
                for (const candidate of candidates) {
                    if (candidate && looksLikePluginRoot(candidate)) return candidate;
                }
            }
        }
    } catch {
        // engine not ready yet - fall through
    }

    // 3. historical layout
    return path.resolve(process.cwd(), "plugins", "call");
}

const ROOT = detectPluginRoot();

/** Path of `root` relative to the BDS root, e.g. "plugins/CALL". */
function rootRelative(p: string): string {
    const normalized = p.replace(/\\/g, "/");
    const at = normalized.lastIndexOf("/plugins/");
    if (at >= 0) return normalized.slice(at + 1);
    return normalized.replace(/^\.\//, "");
}

/**
 * The BDS root: the plugin always lives at `<bds>/plugins/<name>`, so we walk up one
 * level per path segment. Verified against the server executable when possible.
 */
function detectServerRoot(root: string): string {
    const parts = rootRelative(root).split("/").filter(Boolean);
    const guess = path.resolve(root, ...parts.map(() => ".."));
    for (const exe of ["bedrock_server_mod.exe", "bedrock_server.exe"]) {
        try {
            if (fs.existsSync(path.join(guess, exe))) return guess;
        } catch {
            // ignore
        }
    }
    return guess;
}

const SERVER_ROOT = detectServerRoot(ROOT);
const SERVER_STRUCTURES_DIR = path.join(SERVER_ROOT, "structures");

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
    SERVER_STRUCTURES_DIR,
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

    /**
     * The BDS root (`plugins/../..`) and its `structures` folder.
     *
     * `/structure load <name> ...` only reads templates from `<BDS root>/structures`,
     * and that command is how CALL actually places blocks on LL3 (see
     * StructurePlacement), so we need the real path.
     */
    public static readonly SERVER_ROOT = SERVER_ROOT;
    public static readonly SERVER_STRUCTURES = SERVER_STRUCTURES_DIR;

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

    /**
     * Convert an absolute path under the plugin root into a path relative to the BDS
     * root - which is what LegacyScriptEngine's own file APIs (`new JsonConfigFile`,
     * `new File`) document as their base directory.
     *
     * Falls back to the input when the plugin is not below a "plugins" directory
     * (unusual installs), and normalises separators to forward slashes.
     */
    public static lse(absPath: string): string {
        const normalized = absPath.replace(/\\/g, "/");
        const marker = "/plugins/";
        const at = normalized.lastIndexOf(marker);
        if (at >= 0) return normalized.slice(at + 1);
        return normalized.replace(/^\.\//, "");
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
