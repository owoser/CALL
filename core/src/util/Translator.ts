import * as fs from "fs";
import * as path from "path";
import PropertiesReader from "properties-reader";
import * as sprintf from "sprintf-js";
import Config from "../common/Config";

/**
 * Translation loader.
 *
 * Rewritten in 2.0.0 because the 1.x version was a single point of failure:
 *
 *  - it called `File.getFilesList(Config.LANG_PATH)` at module load. On LSE 0.22 that
 *    call yields undefined for the plugin's own language directory, so
 *    `files.forEach(...)` threw a TypeError and the WHOLE plugin failed to load
 *    (the console only said "加载插件代码失败");
 *  - a missing key made `sprintf(undefined, ...)` throw, and every caller assumed a
 *    string came back;
 *  - a missing `.lang` file made PropertiesReader throw.
 *
 * Keys that are missing now degrade to the key itself: ugly, but never fatal.
 */

const LANG_DIR = Config.LANG_PATH;
const DEFAULT_LANG = "en_US";

const langList = new Set<string>();
const readers = new Map<string, PropertiesReader.Reader | null>();

function scanLangDir(): void {
    try {
        for (const entry of fs.readdirSync(LANG_DIR, { withFileTypes: true })) {
            if (!entry.isFile()) continue;
            if (!entry.name.endsWith(".lang")) continue;
            langList.add(path.parse(entry.name).name);
        }
    } catch (e) {
        try {
            logger.warn("[Translator] cannot list language files in " + LANG_DIR + ": " + (e as Error).message);
        } catch {
            // logger unavailable
        }
    }
}

scanLangDir();

function getReader(lang: string): PropertiesReader.Reader | null {
    if (readers.has(lang)) return readers.get(lang)!;
    let reader: PropertiesReader.Reader | null = null;
    try {
        reader = PropertiesReader(path.join(LANG_DIR, lang + ".lang"));
    } catch (e) {
        try {
            logger.warn("[Translator] cannot open language " + lang + ": " + (e as Error).message);
        } catch {
            // ignore
        }
    }
    readers.set(lang, reader);
    return reader;
}

export default class Tr {
    public static readonly DEFAULTLANG = DEFAULT_LANG;

    /** Translate using the configured console language. */
    public static _c(key: string, ...args: any[]): string {
        const lang = String(Config.get(Config.GLOBAL, "consoleLanguage", DEFAULT_LANG) ?? DEFAULT_LANG);
        return Tr._(lang, key, ...args);
    }

    public static _(lang: string, key: string, ...args: any[]): string {
        let useLang = lang;
        if (!useLang || !langList.has(useLang)) useLang = DEFAULT_LANG;

        const reader = getReader(useLang);
        const raw = reader?.get(key);
        if (raw == null) return key;

        const template = String(raw);
        if (args.length === 0) return template;
        try {
            return sprintf.sprintf(template, ...args);
        } catch {
            return template;
        }
    }

    /** Reload .lang files. */
    public static reload(): void {
        readers.clear();
        langList.clear();
        scanLangDir();
    }
}
