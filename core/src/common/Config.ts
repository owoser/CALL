import * as fs from "fs";
import * as path from "path";
import Version from "../util/Version";
import Paths from "./Paths";
import { mergeDefaults } from "../user/Bindings";

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

/** Strip // and /* *\/ comments so a commented template can be parsed with JSON.parse. */
function stripJsonComments(text: string): string {
    let out = "";
    let inString = false;
    let inLine = false;
    let inBlock = false;
    for (let i = 0; i < text.length; i++) {
        const c = text[i];
        const next = text[i + 1];
        if (inLine) {
            if (c === "\n") { inLine = false; out += c; }
            continue;
        }
        if (inBlock) {
            if (c === "*" && next === "/") { inBlock = false; i++; }
            continue;
        }
        if (inString) {
            out += c;
            if (c === "\\") { out += text[i + 1] ?? ""; i++; }
            else if (c === '"') inString = false;
            continue;
        }
        if (c === '"') { inString = true; out += c; continue; }
        if (c === "/" && next === "/") { inLine = true; i++; continue; }
        if (c === "/" && next === "*") { inBlock = true; i++; continue; }
        out += c;
    }
    return out;
}

/** Parsed copy of the shipped template (cached: it is read-only). */
let templateCache: any = null;
function templateConfig(): any {
    if (templateCache != null) return templateCache;
    try {
        const raw = fs.readFileSync(CONFIG_TEMPLATE_PATH, "utf8");
        templateCache = JSON.parse(stripJsonComments(raw));
    } catch {
        templateCache = null;
    }
    return templateCache;
}

/**
 * Fill in configuration keys that this version added.
 *
 * checkConfig() throws on any key declared in check.json but absent from configs.json, which
 * used to disable the whole plugin after an upgrade that introduced a setting. Copy the
 * missing top-level keys from the shipped template instead and say so in the console.
 */
let addedKeys: string[] = [];
function healMissingKeys(): void {
    try {
        const template = templateConfig();
        if (template == null) return;
        // The user's file may still carry the template's comments (it is seeded by copying it),
        // so it needs the same stripping. Rewriting drops those comments - the annotated
        // template stays available in assets/configs.default.json.
        const current = JSON.parse(stripJsonComments(fs.readFileSync(GLOBAL_PATH, "utf8")));

        const missing = Object.keys(template).filter((k) => current[k] === undefined);
        if (missing.length === 0) return;

        for (const key of missing) current[key] = template[key];
        fs.writeFileSync(GLOBAL_PATH, JSON.stringify(current, null, 4) + "\n", "utf8");
        addedKeys = missing;
        try {
            logger.warn("[CALL] configs.json 补全 " + missing.length + " 个新配置项: " + missing.join(", "));
        } catch {
            // logger may not be ready
        }
    } catch (e) {
        try {
            logger.warn("[CALL] cannot fill in new config keys: " + (e && (e as any).message ? (e as any).message : e));
        } catch {
            // ignore
        }
    }
}

healMissingKeys();

/**
 * Lift the 3.5 preview budget to what the block-override renderer can handle.
 *
 * The old numbers were tuned for one fake ENTITY per cell (2000 blocks, 200 per tick): a
 * 2000-block cap is exactly why a large building previewed only partially, and 200 per tick
 * made it crawl. A block override costs one small packet, so both are raised - but only when
 * the value is still the untouched old default, and the console says what happened.
 */
function migratePreviewDefaults(): void {
    try {
        const current = JSON.parse(stripJsonComments(fs.readFileSync(GLOBAL_PATH, "utf8")));
        const changes: string[] = [];
        // 2000 was the item-display default, 8000 the first block-override default; both are
        // too small once the premier becomes a streaming window budget.
        const budget = Number(current.previewMaxBlocks);
        if (budget === 2000 || budget === 8000) {
            current.previewMaxBlocks = 12000;
            changes.push("previewMaxBlocks " + budget + " → 12000");
        }
        if (Number(current.previewBatchSize) === 200) {
            current.previewBatchSize = 1000;
            changes.push("previewBatchSize 200 → 1000");
        }
        // 3.9.0 shipped "auto" (only the last 20s); the countdown is meant to be visible for the
        // whole preview.
        if (String(current.previewCountdown ?? "") === "auto") {
            current.previewCountdown = "always";
            changes.push("previewCountdown auto → always");
        }
        if (changes.length === 0) return;
        fs.writeFileSync(GLOBAL_PATH, JSON.stringify(current, null, 4) + "\n", "utf8");
        try {
            logger.warn("[CALL] 预览上限/批量按新渲染方式上调: " + changes.join(", "));
        } catch {
            // logger may not be ready
        }
    } catch (e) {
        try {
            logger.warn("[CALL] cannot migrate preview defaults: " + (e && (e as any).message ? (e as any).message : e));
        } catch {
            // ignore
        }
    }
}

migratePreviewDefaults();

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

    /** The shipped template value for a (dotted) config key, or undefined. */
    public static templateValue(key: string): any {
        let cur: any = templateConfig();
        for (const part of String(key).split(".")) {
            if (cur == null || typeof cur !== "object") return undefined;
            cur = cur[part];
        }
        return cur;
    }

    /**
     * Bindings for the bundled tool items: the shipped template with the server's own
     * `default.items` layered on top (the server's customisation wins, the template fills
     * whatever it does not know about).
     *
     * Reading only the live config is what left a newly shipped tool without any binding on
     * every upgraded server: `default.items` was written years of releases ago and never grew
     * the new entry, so the migration had nothing to copy.
     */
    public static toolBindingDefaults(): Record<string, any> {
        const tpl = (templateConfig()?.default?.items) ?? {};
        let live: any = null;
        try {
            live = Config.get(Config.GLOBAL, "default.items");
        } catch {
            live = null;
        }
        return mergeDefaults(tpl, live ?? {});
    }

    // ---- versions ---------------------------------------------------------
    /** Oldest BDS this build supports. */
    public static readonly MINVERSION = Version.fromArr([1, 26, 0]);
    /** Oldest LegacyScriptEngine this build supports. */
    /**
     * Oldest LSE this build is exercised on. 0.22.3 is verified on LeviLamina 26.51.8 - the
     * Node.js engine is not sensitive to these patch releases, so gating on 0.22.4 only
     * produced a scary warning on servers that work fine.
     */
    public static readonly LSE_MINVERSION = Version.fromArr([0, 22, 0]);
    /** Config keys that were added automatically on this start (empty when nothing changed). */
    public static readonly ADDED_KEYS = addedKeys;

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