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

const URL_PATH = path.join(Paths.CONFIG, "url.json");
const CHECK_PATH = path.join(Paths.CONFIG, "check.json");
const ICONS_PATH = path.join(Paths.CONFIG, "icons.json");
const ITEM_TEXTURE_PATH = path.join(Paths.CONFIG, "item_texture.json");
const UPDATE_PATH = path.join(Paths.CONFIG, "update.json");
const GLOBAL_PATH = path.join(Paths.USER_CONFIG, "configs.json");
const PERMISSIONS_PATH = path.join(Paths.USER_CONFIG, "userlist.json");
const PLAYERS_SETTINGS_PATH = path.join(Paths.DATA, "settings.json");
const STRUCTURES_PATH = path.join(Paths.DATA, "structures.json");
const DATA_VERSION_PATH = path.join(Paths.USERDATA, "version");

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
    public static readonly DATAPATH = Paths.USERDATA;
    public static readonly DATA_PATH = Paths.DATA;
    public static readonly BUILD_PATH = Paths.BUILD;
    public static readonly PLUGINS_PATH = Paths.PLUGINS;
    public static readonly TEMP_PATH = Paths.TEMP;
    public static readonly IMPORT_PATH = Paths.IMPORT;
    public static readonly EXPORT_PATH = Paths.EXPORT;
    public static readonly UPDATE_PATH = UPDATE_PATH;
    public static readonly TEMPLATES_PATH = path.join(Paths.ROOT, "templates");
    public static readonly STUPID_PERMISSION_FILE_PATH = path.join(Paths.USER_CONFIG, "stupid_permission_file.json");

    // ---- config handles ---------------------------------------------------
    public static URL = new JsonConfigFile(URL_PATH);
    public static GLOBAL = new JsonConfigFile(GLOBAL_PATH);
    public static PERMISSIONS = new JsonConfigFile(PERMISSIONS_PATH);
    public static PLAYERS_SETTINGS = new JsonConfigFile(PLAYERS_SETTINGS_PATH);
    public static STRUCTURES = new JsonConfigFile(STRUCTURES_PATH);
    public static CHECK = new JsonConfigFile(CHECK_PATH);
    public static ITEM_TEXTURES = new JsonConfigFile(ITEM_TEXTURE_PATH);

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
        const root = config.get(keys[0]);
        if (root == null || typeof root !== "object") return false;
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
            Config.URL,
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
        Config.URL = new JsonConfigFile(URL_PATH);
        Config.GLOBAL = new JsonConfigFile(GLOBAL_PATH);
        Config.PERMISSIONS = new JsonConfigFile(PERMISSIONS_PATH);
        Config.PLAYERS_SETTINGS = new JsonConfigFile(PLAYERS_SETTINGS_PATH);
        Config.STRUCTURES = new JsonConfigFile(STRUCTURES_PATH);
        Config.CHECK = new JsonConfigFile(CHECK_PATH);
        Config.ITEM_TEXTURES = new JsonConfigFile(ITEM_TEXTURE_PATH);
    }
}
