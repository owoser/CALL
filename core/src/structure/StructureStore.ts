import * as fs from "fs";
import * as path from "path";
import Paths from "../common/Paths";

/**
 * Where a structure lives on disk.
 *
 * The old store was one flat folder: every slice of every structure of every player in
 * `data/nbt/<id>_x_z.mcstructure`, with ownership only recorded in data/structures.json. That
 * is impossible to browse, impossible to hand-edit and impossible to isolate per player.
 *
 * Layout (all relative to data/nbt):
 *
 *   <player>/<name-or-id>/<id>[_x_z].mcstructure     a saved structure
 *   <player>/copy/<id>/<id>[_x_z].mcstructure        the clipboard
 *   <player>/undo/<id>/…  <player>/redo/<id>/…       snapshots
 *   public/<name-or-id>/<id>[_x_z].mcstructure       hand-managed, hot reloaded
 *
 * The id -> folder map is rebuilt at startup from data/structures.json plus a scan of public/,
 * so nothing in the metadata files has to change shape for old servers.
 */

export type StoreKind = "save" | "copy" | "undo" | "redo" | "public";

/** Characters Windows refuses in a file name, plus control characters. */
const ILLEGAL = /[\\/:*?"<>|\u0000-\u001f]/g;
/** Reserved device names: `CON`, `NUL`, `COM1`… are unusable as folders. */
const RESERVED = /^(con|prn|aux|nul|com[1-9]|lpt[1-9])$/i;
export const MAX_FOLDER = 48;

export function sanitizeFolder(raw: any, fallback: string): string {
    let name = String(raw ?? "").replace(ILLEGAL, "_").trim();
    // Windows silently strips trailing dots and spaces; do it explicitly so the folder we
    // register is the folder that actually exists.
    name = name.replace(/[. ]+$/g, "");
    if (name === "" || RESERVED.test(name)) name = String(fallback || "structure");
    name = name.replace(ILLEGAL, "_").replace(/[. ]+$/g, "");
    if (name.length > MAX_FOLDER) name = name.slice(0, MAX_FOLDER).replace(/[. ]+$/g, "");
    return name === "" ? "structure" : name;
}

/** Slice file name: the bare id for a single slice, `<id>_<x>_<z>` when it is split. */
export function sliceFileName(sid: string, x: number, z: number, xSize: number, zSize: number): string {
    return xSize * zSize <= 1 ? sid : sid + "_" + x + "_" + z;
}

export function folderPath(kind: StoreKind, playerName: string, displayName: string, sid: string): string {
    const owner = sanitizeFolder(playerName, "player");
    if (kind === "public") return path.posix.join("public", sanitizeFolder(displayName, sid));
    if (kind === "copy") return path.posix.join(owner, "copy", sid);
    if (kind === "undo") return path.posix.join(owner, "undo", sid);
    if (kind === "redo") return path.posix.join(owner, "redo", sid);
    return path.posix.join(owner, sanitizeFolder(displayName, sid));
}

const INDEX = new Map<string, string>();
/** sid -> [xSize, zSize]; lets a single-slice structure use `<sid>.mcstructure`. */
const SLICES = new Map<string, [number, number]>();
/** xuid -> last known player name, so folders can be named after the player. */
const NAMES = new Map<string, string>();
/** public display id (folder) -> internal slice id */
const ALIAS = new Map<string, string>();

export interface PublicEntry {
    /** What the menu shows and what the player types (unique per folder). */
    id: string;
    sid: string;
    folder: string;
    name: string;
    files: string[];
    size: [number, number, number] | null;
    /** Slices that make up the structure (1x1 for anything that fits in one file). */
    xSize: number;
    zSize: number;
    /** Files present vs slices expected - a hand-copied structure is often incomplete. */
    present: number;
    complete: boolean;
    mtime: number;
}

export interface SliceGroup {
    sid: string;
    files: string[];
    xSize: number;
    zSize: number;
    present: number;
    complete: boolean;
}

/**
 * Group the `.mcstructure` files of one folder into structures.
 *
 * A structure that fits in one slice is a single `<id>.mcstructure`; a bigger one is split
 * into `<id>_<x>_<z>.mcstructure`. Hand-copied public structures routinely arrive with only
 * some of the slices, so the caller needs to know whether the set is complete instead of
 * silently loading half a building.
 */
export function groupSlices(fileNames: string[]): SliceGroup[] {
    const bySid = new Map<string, { files: string[]; maxX: number; maxZ: number }>();
    for (const file of fileNames) {
        if (!/\.mcstructure$/i.test(file)) continue;
        const m = /^(.*?)(?:_(\d+)_(\d+))?\.mcstructure$/i.exec(file);
        if (m == null) continue;
        const sid = m[1];
        const x = m[2] == null ? 0 : Number(m[2]);
        const z = m[3] == null ? 0 : Number(m[3]);
        const entry = bySid.get(sid) ?? { files: [], maxX: 0, maxZ: 0 };
        entry.files.push(file);
        if (x > entry.maxX) entry.maxX = x;
        if (z > entry.maxZ) entry.maxZ = z;
        bySid.set(sid, entry);
    }
    const out: SliceGroup[] = [];
    for (const [sid, entry] of bySid) {
        const xSize = entry.maxX + 1;
        const zSize = entry.maxZ + 1;
        const present = entry.files.length;
        out.push({ sid, files: entry.files.sort(), xSize, zSize, present, complete: present >= xSize * zSize });
    }
    return out;
}

let publicCache: PublicEntry[] = [];
/** Files left in the root of public/ (ignored until they get a folder). */
let looseFiles: string[] = [];

export const StructureStore = {
    root(): string {
        return Paths.NBT;
    },

    publicRoot(): string {
        return path.join(Paths.NBT, "public");
    },

    ensureRoots(): void {
        try {
            fs.mkdirSync(Paths.NBT, { recursive: true });
            fs.mkdirSync(StructureStore.publicRoot(), { recursive: true });
            const readme = path.join(StructureStore.publicRoot(), "README.txt");
            const text = [
                "公开结构：一个结构 = 一个文件夹，文件夹名就是菜单里显示的名字。",
                "",
                "    public/领地02号/<id>.mcstructure            ← 正确：放进文件夹",
                "    public/领地02号/<id>_1_0.mcstructure        ← 大结构的多张切片要一起放进来",
                "",
                "- 直接把 .mcstructure 丢在 public/ 根目录是**不生效**的，菜单不会列出它；",
                "  请先在 public/ 下建一个文件夹，再把文件放进去。",
                "- 增删改文件后打开菜单即可刷新，不需要重启服务器。",
                "",
                "Publish a structure by putting it in a FOLDER: the folder name is the display",
                "name. Files left loose in public/ are ignored - create a folder for them first.",
            ].join("\r\n");
            let current = "";
            try {
                current = fs.readFileSync(readme, "utf8");
            } catch {
                current = "";
            }
            if (current !== text) fs.writeFileSync(readme, text, "utf8");
        } catch {
            // the root may be read only
        }
    },

    /** Remember which folder a structure id lives in. */
    register(sid: string, rel: string, xSize?: number, zSize?: number): void {
        if (!sid) return;
        INDEX.set(sid, rel.replace(/\\/g, "/"));
        if (xSize != null && zSize != null) SLICES.set(sid, [xSize, zSize]);
    },

    /** Map a user-facing id (a public folder name) to the internal slice id. */
    alias(display: string, sid: string): void {
        if (!display || !sid) return;
        ALIAS.set(display, sid);
    },

    /** Internal slice id for whatever the player typed / picked from the menu. */
    sliceSidOf(key: string): string {
        return ALIAS.get(String(key ?? "")) ?? String(key ?? "");
    },

    slicesOf(sid: string): [number, number] | null {
        return SLICES.get(sid) ?? null;
    },

    /**
     * Remember the display name of a player (persisted in data/players.jsonc).
     *
     * Existing data is usually keyed by xuid (migration happens before anyone logs in), so the
     * first time we learn the name the folder is renamed to the readable one and the index is
     * rewritten. Nothing else changes: the ids stay the same.
     */
    rememberPlayer(xuid: string, name: string): void {
        if (!xuid || !name) return;
        NAMES.set(xuid, name);
        StructureStore.renameOwnerFolder(xuid, sanitizeFolder(name, xuid));
        try {
            const file = path.join(Paths.DATA, "players.jsonc");
            let map: any = {};
            try {
                map = JSON.parse(fs.readFileSync(file, "utf8").replace(/^\s*\/\/.*$/gm, "")) ?? {};
            } catch {
                map = {};
            }
            if (map[xuid] === name) return;
            map[xuid] = name;
            fs.mkdirSync(Paths.DATA, { recursive: true });
            fs.writeFileSync(file, JSON.stringify(map, null, 4) + "\n", "utf8");
        } catch {
            // a read-only data folder must not break a login
        }
    },

    /** data/nbt/<xuid> -> data/nbt/<player name> once the name is known. */
    renameOwnerFolder(xuid: string, folder: string): void {
        if (folder === xuid) return;
        const root = Paths.NBT;
        const from = path.join(root, xuid);
        let to = path.join(root, folder);
        try {
            if (!fs.existsSync(from) || fs.statSync(from).isDirectory() === false) return;
            if (fs.existsSync(to)) to = path.join(root, StructureStore.uniqueFolder(root, folder));
            if (path.dirname(to) !== root) return;
            fs.renameSync(from, to);
        } catch {
            return;
        }
        const target = path.relative(root, to).replace(/\\/g, "/");
        for (const [sid, rel] of [...INDEX.entries()]) {
            if (rel === xuid) INDEX.set(sid, target);
            else if (rel.startsWith(xuid + "/")) INDEX.set(sid, target + rel.slice(xuid.length));
        }
    },

    playerNameOf(xuid: string): string | null {
        const cached = NAMES.get(xuid);
        if (cached != null) return cached;
        try {
            const file = path.join(Paths.DATA, "players.jsonc");
            const map = JSON.parse(fs.readFileSync(file, "utf8")) ?? {};
            const name = map[xuid];
            if (typeof name === "string" && name !== "") {
                NAMES.set(xuid, name);
                return name;
            }
        } catch {
            // first run
        }
        return null;
    },

    forget(sid: string): void {
        INDEX.delete(sid);
    },

    /** Folder of a structure id, or null when it was never registered (legacy flat file). */
    dirOf(sid: string): string | null {
        const dir = INDEX.get(sid);
        return dir == null ? null : dir;
    },

    /** Absolute folder for a structure id, creating nothing. */
    absDir(sid: string): string {
        const rel = StructureStore.dirOf(sid);
        return rel == null ? Paths.NBT : path.join(Paths.NBT, rel);
    },

    /** Pick a folder name that does not collide with an existing one. */
    uniqueFolder(parentAbs: string, base: string): string {
        let candidate = base;
        let n = 2;
        while (true) {
            try {
                if (!fs.existsSync(path.join(parentAbs, candidate))) return candidate;
            } catch {
                return candidate;
            }
            candidate = base + "-" + n;
            n++;
            if (n > 99) return base + "-" + Date.now().toString(36);
        }
    },

    /** Create (if needed) and return the folder for a new structure. */
    prepare(kind: StoreKind, playerName: string, displayName: string, sid: string, xSize = 1, zSize = 1): string {
        const rel = folderPath(kind, playerName, displayName, sid);
        const abs = path.join(Paths.NBT, rel);
        try {
            fs.mkdirSync(abs, { recursive: true });
        } catch {
            // fall back to the flat root rather than losing the structure
            return "";
        }
        StructureStore.register(sid, rel, xSize, zSize);
        return rel;
    },

    /** Atomic write: a half-written slice must never be visible to a reader. */
    writeAtomic(file: string, bytes: Buffer): void {
        fs.mkdirSync(path.dirname(file), { recursive: true });
        const tmp = file + ".tmp";
        fs.writeFileSync(tmp, bytes);
        fs.renameSync(tmp, file);
    },

    /** Remove a structure's files and its folder if it became empty. */
    remove(sid: string, saveids: string[], filePathOf: (saveid: string) => string): void {
        let dir: string | null = null;
        for (const saveid of saveids) {
            const file = filePathOf(saveid);
            try {
                dir = path.dirname(file);
                fs.unlinkSync(file);
            } catch {
                // already gone
            }
        }
        if (dir != null) {
            try {
                const left = fs.readdirSync(dir);
                if (left.length === 0) fs.rmdirSync(dir);
            } catch {
                // keep the folder
            }
        }
        StructureStore.forget(sid);
    },

    /**
     * Rescan `public/`.
     *
     * Cheap enough to run every time the menu opens: directories are stat-ed first and only
     * ones whose mtime moved are read again.
     */
    scanPublic(force = false): PublicEntry[] {
        StructureStore.ensureRoots();
        const root = StructureStore.publicRoot();
        const out: PublicEntry[] = [];
        let dirs: fs.Dirent[] = [];
        try {
            dirs = fs.readdirSync(root, { withFileTypes: true });
        } catch {
            return publicCache;
        }

        const previous = new Map(publicCache.map((e) => [e.folder + "/" + e.sid, e]));
        looseFiles = [];
        for (const dirent of dirs) {
            const full = path.join(root, dirent.name);
            let files: string[] = [];
            let mtime = 0;
            if (dirent.isDirectory()) {
                try {
                    mtime = fs.statSync(full).mtimeMs;
                    files = fs.readdirSync(full).filter((f) => f.toLowerCase().endsWith(".mcstructure"));
                } catch {
                    continue;
                }
            } else if (dirent.name.toLowerCase().endsWith(".mcstructure")) {
                // A file dropped straight into public/ is NOT a published structure: the
                // folder is the structure (and its name). Remember it so the menu can say so
                // instead of failing later at load time.
                looseFiles.push(dirent.name);
                continue;
            } else {
                continue;
            }
            if (files.length === 0) continue;

            const groups = groupSlices(files).sort((a, b) => b.files.length - a.files.length);
            let primarySeen = false;
            for (const group of groups) {
                const key = dirent.name + "/" + group.sid;
                const cached = previous.get(key);
                // A folder may accidentally hold slices of TWO structures. Only the biggest
                // one owns the folder name; the others get a stable suffix so the menu id,
                // the alias and the slice files can never point at different structures.
                const id = primarySeen ? dirent.name + "~" + group.sid : (dirent.isDirectory() ? dirent.name : group.sid);
                primarySeen = true;
                if (!force && cached != null && cached.mtime === mtime && cached.id === id
                    && cached.present === group.present && cached.xSize === group.xSize && cached.zSize === group.zSize) {
                    out.push(cached);
                    continue;
                }
                out.push({
                    id,
                    sid: group.sid,
                    folder: dirent.name,
                    name: dirent.isDirectory() ? dirent.name : group.sid,
                    files: group.files,
                    size: null,
                    xSize: group.xSize,
                    zSize: group.zSize,
                    present: group.present,
                    complete: group.complete,
                    mtime,
                });
            }
        }
        publicCache = out;
        for (const entry of out) {
            StructureStore.register(entry.sid, path.posix.join("public", entry.folder), entry.xSize, entry.zSize);
            StructureStore.alias(entry.id, entry.sid);
        }
        return out;
    },
    /** .mcstructure files sitting in the root of public/ - they are ignored until moved into a folder. */
    loosePublicFiles(): string[] {
        StructureStore.scanPublic();
        return looseFiles.slice();
    },

    /** Is this file name one of the ignored loose files? */
    isLoosePublic(name: string): boolean {
        return looseFiles.includes(name);
    },

    cachedPublic(): PublicEntry[] {
        return publicCache;
    },

    /** Test/relogin helper. */
    clearIndex(): void {
        INDEX.clear();
        SLICES.clear();
        ALIAS.clear();
        publicCache = [];
    },

    indexSize(): number {
        return INDEX.size;
    },
};

export default StructureStore;

/** Which table an id was found in. */
export type StructureIdKind = "own" | "registry" | "scanned" | "missing";

export interface StructureIdSources {
    own: string[];
    registry: string[];
    scanned: Array<{ name: string; sid: string }>;
}

/**
 * Resolve whatever the player typed or picked from the menu.
 *
 * Saved structures answer to their internal id, public folders answer to their FOLDER name
 * (which is what the list shows), and a loose file in public/ answers to its file base name.
 * Kept pure so the resolution table can be unit tested - the menu and /ca load must agree on
 * what a given string means.
 */
export function resolveStructureId(
    input: string,
    sources: StructureIdSources
): { kind: StructureIdKind; sid: string; display: string } {
    const raw = String(input ?? "").trim();
    if (raw === "") return { kind: "missing", sid: "", display: "" };

    if (sources.own.includes(raw)) return { kind: "own", sid: raw, display: raw };
    if (sources.registry.includes(raw)) return { kind: "registry", sid: raw, display: raw };

    const byId = sources.scanned.find((e) => (e as any).id === raw);
    if (byId != null) return { kind: "scanned", sid: byId.sid, display: (byId as any).id ?? byId.name };
    const byName = sources.scanned.find((e) => e.name === raw);
    if (byName != null) return { kind: "scanned", sid: byName.sid, display: byName.name };
    const bySid = sources.scanned.find((e) => e.sid === raw);
    if (bySid != null) return { kind: "scanned", sid: bySid.sid, display: (bySid as any).id ?? bySid.name };

    return { kind: "missing", sid: "", display: "" };
}
