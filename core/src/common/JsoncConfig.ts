import * as fs from "fs";
import * as path from "path";
import { parseJsonc, patchJsonc, renderFromTemplate, serializeValue } from "./JsoncDoc";

/**
 * A config file that keeps its comments.
 *
 * LSE's JsonConfigFile rewrites the whole document with JSON.stringify, which deletes every
 * comment in the shipped template - so after one upgrade a server admin has a file full of
 * keys with no explanation. This handle keeps the raw text, patches single values in place and
 * only rewrites the file when a value actually changes.
 */
export class JsoncConfigFile {
    private text: string;
    private data: any;
    private dirty = false;

    constructor(public readonly file: string, templateFile?: string) {
        let raw = "";
        try {
            raw = fs.readFileSync(file, "utf8");
        } catch {
            raw = "";
        }
        if (raw.trim() === "" && templateFile != null) {
            try {
                raw = fs.readFileSync(templateFile, "utf8");
            } catch {
                raw = "{}\n";
            }
        }
        if (raw.trim() === "") raw = "{}\n";
        this.text = raw;
        this.data = JsoncConfigFile.parseSafe(raw);
    }

    static parseSafe(text: string): any {
        try {
            const value = parseJsonc(text);
            return value != null && typeof value === "object" ? value : {};
        } catch {
            return {};
        }
    }

    /** LSE-compatible accessor. */
    get(key: string): any {
        return this.data?.[key];
    }

    /** LSE-compatible mutator: patches the raw text so comments survive. */
    set(key: string, value: any): void {
        this.data[key] = value;
        const patched = patchJsonc(this.text, [key], value);
        this.text = patched ?? this.rebuild();
        this.dirty = true;
        this.flush();
    }

    delete(key: string): boolean {
        if (!(key in (this.data ?? {}))) return false;
        delete this.data[key];
        this.text = this.rebuild();
        this.dirty = true;
        this.flush();
        return true;
    }

    /** Deep value for dotted paths, mirroring Config.get(). */
    deep(pathStr: string, def?: any): any {
        let cur: any = this.data;
        for (const part of String(pathStr).split(".")) {
            if (cur == null || typeof cur !== "object") return def === undefined ? null : def;
            cur = cur[part];
        }
        return cur === undefined ? (def === undefined ? null : def) : cur;
    }

    /** Write the merged document back; used by migrations that replace many values at once. */
    replaceText(nextText: string): void {
        this.text = nextText;
        this.data = JsoncConfigFile.parseSafe(nextText);
        this.dirty = true;
        this.flush();
    }

    rawText(): string {
        return this.text;
    }

    reload(): void {
        try {
            this.text = fs.readFileSync(this.file, "utf8");
        } catch {
            // keep the current text
        }
        this.data = JsoncConfigFile.parseSafe(this.text);
    }

    close(): void {
        if (this.dirty) this.flush();
    }

    /** Rewrite the whole document from the current object (comments are rebuilt by the caller). */
    private rebuild(): string {
        return serializeValue(this.data) + "\n";
    }

    private flush(): void {
        try {
            const dir = path.dirname(this.file);
            fs.mkdirSync(dir, { recursive: true });
            const tmp = this.file + ".tmp";
            fs.writeFileSync(tmp, this.text, "utf8");
            fs.renameSync(tmp, this.file);
            this.dirty = false;
        } catch {
            // a read-only config folder must not take the plugin down
        }
    }
}

/**
 * Bring an annotated template and a user file into agreement.
 *
 * Returns the text that should be written to the user file, or null when nothing needs to
 * change (same version). The user's values win; the template supplies comments, ordering and
 * the keys that did not exist before.
 */
export function migrateToTemplate(
    templateText: string,
    userText: string
): { text: string | null; from: number; to: number; added: string[]; dropped: string[] } {
    const template = JsoncConfigFile.parseSafe(templateText);
    const user = JsoncConfigFile.parseSafe(userText);
    const toVersion = Number(template.version);
    const fromVersion = Number(user.version);

    const templateKeys = Object.keys(template).filter((k) => k !== "version");
    const userKeys = Object.keys(user).filter((k) => k !== "version");
    const added = templateKeys.filter((k) => !userKeys.includes(k));
    const dropped = userKeys.filter((k) => !templateKeys.includes(k));

    const same = Number.isFinite(toVersion) && Number.isFinite(fromVersion) && fromVersion === toVersion;
    const missing = added.length > 0;
    if (same && !missing) {
        return { text: null, from: fromVersion, to: toVersion, added, dropped };
    }

    const merged: any = {};
    for (const key of templateKeys) {
        merged[key] = key in user ? user[key] : template[key];
    }
    merged.version = Number.isFinite(toVersion) ? toVersion : 1;
    const text = renderFromTemplate(templateText, merged);
    return { text, from: fromVersion, to: toVersion, added, dropped };
}

export default JsoncConfigFile;
