import * as fs from "fs";
import * as path from "path";
import Version from "../util/Version";
import Paths from "./Paths";

export enum PermissionsType {
    ALL = "all",
    OP = "op",
    CUSTOMIZE = "customize",
    FROM_FILE = "file",
    FROM_TAG = "tag"
}

// read-only assets (shipped with the plugin)
const CHECK_PATH = path.join(Paths.ASSETS, "check.json");
const ICONS_PATH = path.join(Paths.ASSETS, "icons.json");
const ITEM_TEXTURE_PATH = path.join(Paths.ASSETS, "item_texture.json");

// user configuration
const GLOBAL_PATH = path.join(Paths.CONFIG, "configs.json");
const PERMISSIONS_PATH = path.join(Paths.CONFIG, "userlist.json");
const PERMISSION_FILE_PATH = path.join(Paths.CONFIG, "permission.json");

// user data
const PLAYERS_SETTINGS_PATH = path.join(Paths.DATA, "settings.json");
const STRUCTURES_PATH = path.join(Paths.DATA, "structures.json");
const DATA_VERSION_PATH = path.join(Paths.DATA, "version");

/**
 * Pristine copy of the shipped defaults, kept in the read-only config folder.
 *
 * Why this exists: LSE's JsonConfigFile creates an EMPTY file when the path is missing,
 * so a user who deletes configs.json ends up with `{}` - every key silently falls back to
 * the code defaults and there is nothing to read or edit. Restore the annotated template
 * instead, before the handles below are opened.
 */
const CONFIG_TEMPLATE_PATH = path.join(Paths.ASSETS, "configs.default.json");

function healGlobalConfig(): void {
    try {
        fs.mkdirSync(Paths.CONFIG, { recursive: true });
        let missing = true;
        try {
            const st = fs.statSync(GLOBAL_PATH);
            missing = !st.isFile() || st.size < 3;
        } catch {
            missing = true;
        }
        if (!missing) return;
        if (!fs.existsSync(CONFIG_TEMPLATE_PATH)) return;
        fs.copyFileSync(CONFIG_TEMPLATE_PATH, GLOBAL_PATH);
        logger.warn("[CALL] " + GLOBAL_PATH + " was missing or empty - restored the default template");
    } catch (e) {
        try {
            logger.warn("[CALL] cannot restore the default config: " + (e && (e as any).message ? (e as any).message : e));
        } catch {
            // logger may not be ready yet
        }
    }
}

healGlobalConfig();

// LegacyScriptEngine's own file APIs take paths relative to the BDS root.
const CHECK_LSE = Paths.lse(CHECK_PATH);
const ITEM_TEXTURE_LSE = Paths.lse(ITEM_TEXTURE_PATH);
const GLOBAL_LSE = Paths.lse(GLOBAL_PATH);
const PERMISSIONS_LSE = Paths.lse(PERMISSIONS_PATH);
const PLAYERS_SETTINGS_LSE = Paths.lse(PLAYERS_SETTINGS_PATH);
const STRUCTURES_LSE = Paths.lse(STRUCTURES_PATH);

/** Read a JSON file with fs - safe to call before the script engine is ready. */
function readJson<T = any>(file: string): T | null {
    try {
        return JSON.parse(fs.readFileSync(file, "utf8")) as T;
    } catch {
        return null;
    }
}

/**
 * The plugin version.
 *
 * manifest.json is the source of truth on LeviLamina 3 (it is what the loader reads),
 * so prefer it and only fall back to package.json.
 */
function detectPluginVersion(): Version {
    for (const file of ["manifest.json", "package.json"]) {
        const json = readJson(path.join(Paths.ROOT, file));
        const raw = json && json.version;
        if (typeof raw === "string" && /^\d+(\.\d+)*$/.test(raw.trim())) {
            return Version.fromString(raw.trim());
        }
    }
    return Version.fromArr([0, 0, 0]);
}

function detectDataVersion(): Version | null {
    try {
        const raw = fs.readFileSync(DATA_VERSION_PATH, "utf8").trim();
        if (raw) return Version.fromString(raw);
    } catch {
        // first run
    }
    return null;
}

function detectServerVersion(): Version {
    try {
        // Returns e.g. "v1.26.51.9"; older shapes have also omitted the leading v.
        const raw = String(mc.getBDSVersion() ?? "").trim();
        const cleaned = raw.replace(/^[vV]/, "");
        if (/^\d+(\.\d+)*$/.test(cleaned)) return Version.fromString(cleaned);
    } catch {
        // called before the engine is ready
    }
    return Version.fromArr([0, 0, 0]);
}

function detectLseVersion(): Version {
    try {
        const raw = String((ll as any).versionString?.() ?? "").trim();
        const cleaned = raw.replace(/^[vV]/, "");
        if (/^\d+(\.\d+)*$/.test(cleaned)) return Version.fromString(cleaned);
    } catch {
        // ignore
    }
    return Version.fromArr([0, 0, 0]);
}

export default class Config {
    /** Kept for backwards compatibility with 1.x call sites. */
    static A = GLOBAL_PATH;

    /** Absolute path of the user-editable global config (printed at startup). */
    public static readonly GLOBAL_FILE = GLOBAL_PATH;

    // ---- versions ---------------------------------------------------------
    /** Oldest BDS this build supports. */
    public static readonly MINVERSION = Version.fromArr([1, 26, 0]);
    /** Oldest LegacyScriptEngine this build supports. */
    public static readonly LSE_MINVERSION = Version.fromArr([0, 22, 4]);
    public static readonly PLUGIN_VERSION = detectPluginVersion();
    public static readonly DATA_VERSION = detectDataVersion();

    private static _serverVersion: Version | null = null;
    private static _lseVersion: Version | null = null;

    public static get SERVER_VERSION(): Version {
        if (Config._serverVersion == null) Config._serverVersion = detectServerVersion();
        return Config._serverVersion;
    }

    public static get LSE_VERSION(): Version {
        if (Config._lseVersion == null) Config._lseVersion = detectLseVersion();
        return Config._lseVersion;
    }

    // ---- paths ------------------------------------------------------------
    public static readonly ROOT_PATH = Paths.ROOT;
    public static readonly CONFIG_PATH = Paths.CONFIG;
    public static readonly LANG_PATH = Paths.LANG;
    public static readonly BIN_PATH = Paths.BIN;
    public static readonly ASSETS_PATH = Paths.ASSETS;
    /** Kept for backwards compatibility: data/ replaced userdata/. */
    public static readonly DATAPATH = Paths.DATA;
    public static readonly DATA_PATH = Paths.DATA;
    public static readonly SHAPES_PATH = Paths.SHAPES;
    public static readonly IMPORT_PATH = Paths.IMPORT;
    public static readonly EXPORT_PATH = Paths.EXPORT;
    public static readonly TEMPLATES_PATH = path.join(Paths.ROOT, "templates");
    /** Whitelist file used by permission "customize" (was stupid_permission_file.json). */
    public static readonly PERMISSION_FILE_PATH = PERMISSION_FILE_PATH;

    // ---- config handles ---------------------------------------------------
    public static GLOBAL = new JsonConfigFile(GLOBAL_LSE);
    public static PERMISSIONS = new JsonConfigFile(PERMISSIONS_LSE);
    public static PLAYERS_SETTINGS = new JsonConfigFile(PLAYERS_SETTINGS_LSE);
    public static STRUCTURES = new JsonConfigFile(STRUCTURES_LSE);
    public static CHECK = new JsonConfigFile(CHECK_LSE);
    public static ITEM_TEXTURES = new JsonConfigFile(ITEM_TEXTURE_LSE);

    public static readonly ITEM_ICONS: Set<string> = new Set<string>(readJson<string[]>(ICONS_PATH) ?? []);

    /**
     * Read a dotted key out of a JsonConfigFile.
     *
     * Fixed in 2.0.0: the 1.x implementation assigned `res = p` after the
     * try/catch, so a missing intermediate path returned the *parent object*
     * instead of null and `if (value == null)` guards never fired.
     */
    public static get(config: JsonConfigFile, str: string, def?: any): any {
        const keys = str.split(".");
        let current: any;
        try {
            current = config.get(keys[0]);
            for (let i = 1; i < keys.length; i++) {
                if (current == null) break;
                current = current[keys[i]];
            }
        } catch {
            current = undefined;
        }
        if (current == null) return def === undefined ? null : def;
        return current;
    }

    public static set(config: JsonConfigFile, str: string, data: any): boolean {
        const keys = str.split(".");
        if (keys.length === 1) {
            config.set(keys[0], data);
            return true;
        }
        // A missing top-level key is normal on a fresh install (e.g. structures.json starts
        // as "{}"), and refusing here silently dropped every undo/redo snapshot.
        let root = config.get(keys[0]);
        if (root == null || typeof root !== "object") root = {};
        let cursor: any = root;
        try {
            for (let i = 1; i < keys.length - 1; i++) {
                if (cursor[keys[i]] == null || typeof cursor[keys[i]] !== "object") {
                    cursor[keys[i]] = {};
                }
                cursor = cursor[keys[i]];
            }
            cursor[keys[keys.length - 1]] = data;
            config.set(keys[0], root);
        } catch {
            return false;
        }
        return true;
    }

    public static del(config: JsonConfigFile, str: string): boolean {
        const keys = str.split(".");
        if (keys.length === 1) {
            return config.delete(keys[0]);
        }
        const parentPath = keys.slice(0, -1).join(".");
        const parent = Config.get(config, parentPath);
        if (parent == null || typeof parent !== "object") return false;
        delete parent[keys[keys.length - 1]];
        return Config.set(config, parentPath, parent);
    }

    public static closeAll() {
        [
            Config.GLOBAL,
            Config.PERMISSIONS,
            Config.PLAYERS_SETTINGS,
            Config.STRUCTURES,
            Config.CHECK,
            Config.ITEM_TEXTURES,
        ].forEach((c) => {
            try {
                c.close();
            } catch {
                // already closed
            }
        });
    }

    public static openAll() {
        Config.GLOBAL = new JsonConfigFile(GLOBAL_LSE);
        Config.PERMISSIONS = new JsonConfigFile(PERMISSIONS_LSE);
        Config.PLAYERS_SETTINGS = new JsonConfigFile(PLAYERS_SETTINGS_LSE);
        Config.STRUCTURES = new JsonConfigFile(STRUCTURES_LSE);
        Config.CHECK = new JsonConfigFile(CHECK_LSE);
        Config.ITEM_TEXTURES = new JsonConfigFile(ITEM_TEXTURE_LSE);
    }
}