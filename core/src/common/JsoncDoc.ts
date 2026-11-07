/**
 * Minimal JSONC support: parse a file that has `//` and `/* *\/` comments, and rewrite
 * individual values WITHOUT destroying those comments.
 *
 * Why not just JSON.stringify: the shipped template is fully commented (range, suggested
 * value, explanation in Chinese and English). Every migration used to rewrite it with
 * JSON.stringify, so a server that upgraded once lost all of that documentation and the
 * user had no idea what a key does any more.
 *
 * The approach is deliberately small: a tokenizer that knows about strings, comments and
 * punctuation, a path locator that finds `"key": <value>` for a dotted path, and a value
 * serializer. Everything that is not replaced is left byte-for-byte alone.
 */

export type JsoncTokenType = "punct" | "string" | "literal" | "comment" | "ws";

export interface JsoncToken {
    type: JsoncTokenType;
    start: number;
    end: number;
    text: string;
}

/** Strip comments and trailing commas so `JSON.parse` accepts the text. */
export function stripJsonc(text: string): string {
    return tokenize(text)
        .filter((t) => t.type !== "comment")
        .map((t) => t.text)
        .join("")
        .replace(/,(\s*[}\]])/g, "$1");
}

export function parseJsonc<T = any>(text: string): T {
    return JSON.parse(stripJsonc(text)) as T;
}

export function tokenize(text: string): JsoncToken[] {
    const out: JsoncToken[] = [];
    let i = 0;
    const push = (type: JsoncTokenType, start: number, end: number) => {
        out.push({ type, start, end, text: text.slice(start, end) });
    };
    while (i < text.length) {
        const c = text[i];
        if (c === " " || c === "\t" || c === "\r" || c === "\n") {
            const start = i;
            while (i < text.length && /[ \t\r\n]/.test(text[i])) i++;
            push("ws", start, i);
            continue;
        }
        if (c === "/" && text[i + 1] === "/") {
            const start = i;
            while (i < text.length && text[i] !== "\n") i++;
            push("comment", start, i);
            continue;
        }
        if (c === "/" && text[i + 1] === "*") {
            const start = i;
            i += 2;
            while (i < text.length && !(text[i] === "*" && text[i + 1] === "/")) i++;
            i = Math.min(text.length, i + 2);
            push("comment", start, i);
            continue;
        }
        if (c === "\"") {
            const start = i;
            i++;
            while (i < text.length) {
                if (text[i] === "\\") { i += 2; continue; }
                if (text[i] === "\"") { i++; break; }
                i++;
            }
            push("string", start, i);
            continue;
        }
        if (/[\-0-9tfn]/.test(c)) {
            const start = i;
            while (i < text.length && /[-+0-9.eEa-z]/i.test(text[i])) i++;
            push("literal", start, i);
            continue;
        }
        push("punct", i, i + 1);
        i++;
    }
    return out;
}

/** Index of the first significant token at or after `from`. */
function nextSignificant(tokens: JsoncToken[], from: number): number {
    let i = from;
    while (i < tokens.length && (tokens[i].type === "ws" || tokens[i].type === "comment")) i++;
    return i;
}

function skipValue(tokens: JsoncToken[], start: number): number {
    const t = tokens[start];
    if (t == null) return start;
    if (t.type !== "punct") return start + 1;
    if (t.text !== "{" && t.text !== "[") return start + 1;
    const open = t.text;
    const close = open === "{" ? "}" : "]";
    let depth = 0;
    for (let i = start; i < tokens.length; i++) {
        if (tokens[i].type !== "punct") continue;
        if (tokens[i].text === open) depth++;
        else if (tokens[i].text === close) {
            depth--;
            if (depth === 0) return i + 1;
        }
    }
    return tokens.length;
}

/**
 * Find the value token span for a dotted path inside an object literal.
 * Returns [startToken, endToken) or null.
 */
export function findValue(tokens: JsoncToken[], path: string[]): [number, number] | null {
    let i = nextSignificant(tokens, 0);
    if (tokens[i]?.text !== "{") return null;
    for (let depth = 0; depth < path.length; depth++) {
        const want = path[depth];
        i++; // past '{'
        let found: [number, number] | null = null;
        while (i < tokens.length) {
            const keyIdx = nextSignificant(tokens, i);
            if (tokens[keyIdx]?.text === "}") break;
            if (tokens[keyIdx]?.type !== "string") break;
            const key = JSON.parse(tokens[keyIdx].text);
            const colon = nextSignificant(tokens, keyIdx + 1);
            if (tokens[colon]?.text !== ":") break;
            const valStart = nextSignificant(tokens, colon + 1);
            const valEnd = skipValue(tokens, valStart);
            if (key === want) { found = [valStart, valEnd]; break; }
            i = valEnd;
            const comma = nextSignificant(tokens, valEnd);
            if (tokens[comma]?.text === ",") i = comma + 1;
            else break;
        }
        if (found == null) return null;
        i = found[0];
        if (depth === path.length - 1) return found;
        if (tokens[i]?.text !== "{") return null;
    }
    return null;
}

/** Serialize a value the way the template writes it: 4-space indent, JSON-safe. */
export function serializeValue(value: any, indent = 4): string {
    return JSON.stringify(value, null, indent) ?? "null";
}

/** Replace one value in the text, keeping every comment and every other byte. */
export function patchJsonc(text: string, path: string[], value: any): string | null {
    const tokens = tokenize(text);
    const span = findValue(tokens, path);
    if (span == null) return null;
    const start = tokens[span[0]].start;
    const end = tokens[span[1] - 1].end;
    return text.slice(0, start) + serializeValue(value) + text.slice(end);
}

/**
 * Merge a user object into template text.
 *
 * Every key the template documents is patched with the user's value when the user has one;
 * template defaults stay in place otherwise. Keys the template no longer has are dropped
 * (and reported by the caller). Keys the user added that the template does not know cannot be
 * placed without inventing a location, so they are appended as a `_legacy` block.
 */
export function renderFromTemplate(templateText: string, user: any): string {
    let text = templateText;
    const apply = (obj: any, prefix: string[]) => {
        if (obj == null || typeof obj !== "object" || Array.isArray(obj)) return;
        for (const key of Object.keys(obj)) {
            const value = obj[key];
            const next = [...prefix, key];
            const patched = patchJsonc(text, next, value);
            if (patched != null) text = patched;
            else if (value != null && typeof value === "object" && !Array.isArray(value)) apply(value, next);
        }
    };
    apply(user, []);
    return text;
}
