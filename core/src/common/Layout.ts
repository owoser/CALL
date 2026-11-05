import * as fs from "fs";
import * as path from "path";

/**
 * One-time migration from the 1.x/3.0 layout to the 3.1 layout.
 *
 * BEFORE (messy)                          AFTER
 *   userdata/config/configs.json      ->   config/configs.json
 *   userdata/config/userlist.json     ->   config/userlist.json
 *   userdata/config/stupid_permission_file.json -> config/permission.json
 *   userdata/data/**                  ->   data/**
 *   userdata/plugins/**               ->   data/shapes/**
 *   userdata/import|export/**         ->   data/import|export/**
 *   userdata/version                  ->   data/version
 *   userdata/temp, userdata/build     ->   dropped (they were never used)
 *   config/{check,help,icons,item_texture,update,url}.json, config/lang/**
 *                                     ->   dropped (read-only assets, now in assets/)
 *
 * The planning half is a pure function so it can be unit tested without a filesystem;
 * the applying half is deliberately conservative: a target that already exists is never
 * overwritten, and a failure leaves the source in place.
 */

export interface LayoutEntry {
    /** Path relative to the plugin root, using forward slashes. */
    path: string;
    isFile: boolean;
}

export interface LayoutMove {
    from: string;
    to: string;
}

export interface LayoutPlan {
    moves: LayoutMove[];
    /** Stale read-only resources that now live in assets/. */
    remove: string[];
    /** Legacy directories to delete once they are empty. */
    dropDirs: string[];
}

/** Files that used to live in config/ but are shipped in assets/ since 3.1. */
const STALE_CONFIG_FILES = [
    "check.json",
    "help.json",
    "icons.json",
    "item_texture.json",
    "update.json",
    "url.json",
    "configs.default.json",
];

const USERDATA_MAP: Array<[RegExp, string]> = [
    [/^userdata\/config\/stupid_permission_file\.json$/, "config/permission.json"],
    [/^userdata\/config\/(.+)$/, "config/$1"],
    [/^userdata\/data\/(.+)$/, "data/$1"],
    [/^userdata\/plugins\/(.+)$/, "data/shapes/$1"],
    [/^userdata\/(import|export)\/(.+)$/, "data/$1/$2"],
    [/^userdata\/version$/, "data/version"],
];

export function planMigration(entries: LayoutEntry[]): LayoutPlan {
    const moves: LayoutMove[] = [];
    const remove: string[] = [];
    const dropDirs = new Set<string>();

    for (const entry of entries) {
        const p = entry.path.replace(/\\/g, "/");

        if (p === "userdata" || p.startsWith("userdata/")) {
            dropDirs.add("userdata");
            // temp/ and build/ were never used; import/export are handled below
            if (/^userdata\/(temp|build)(\/|$)/.test(p)) {
                continue;
            }
            for (const [pattern, target] of USERDATA_MAP) {
                const m = pattern.exec(p);
                if (m == null) continue;
                const to = target.replace(/\$(\d)/g, (_all, n) => String(m[Number(n)] ?? ""));
                if (entry.isFile) moves.push({ from: p, to });
                break;
            }
            continue;
        }

        // read-only resources that moved to assets/
        if (p.startsWith("config/")) {
            const rest = p.slice("config/".length);
            if (rest.startsWith("lang/") || STALE_CONFIG_FILES.includes(rest)) {
                if (entry.isFile) remove.push(p);
            }
        }
    }

    return { moves, remove, dropDirs: [...dropDirs] };
}

function isFile(p: string): boolean {
    try {
        return fs.statSync(p).isFile();
    } catch {
        return false;
    }
}

function moveFile(root: string, move: LayoutMove, log: (msg: string) => void): void {
    const from = path.join(root, move.from);
    const to = path.join(root, move.to);
    if (!isFile(from)) return;

    fs.mkdirSync(path.dirname(to), { recursive: true });

    if (fs.existsSync(to)) {
        // Shape packs are code, not data: when the package already ships a pack with the
        // same name (the built-in one), the bundled copy wins and the legacy duplicate is
        // dropped instead of littering data/shapes with *.old files on every upgrade.
        if (move.to.startsWith("data/shapes/")) {
            try {
                fs.unlinkSync(from);
                return;
            } catch {
                // fall through to the conservative path
            }
        }
        // never overwrite: keep both, the old file gets a suffix for the user to inspect
        const backup = to + ".old";
        if (fs.existsSync(backup)) {
            log("skipped " + move.from + " (both " + move.to + " and " + move.to + ".old exist)");
            return;
        }
        fs.renameSync(from, backup);
        log("kept " + move.to + ", previous file saved as " + move.to + ".old");
        return;
    }

    try {
        fs.renameSync(from, to);
    } catch {
        // different volume
        fs.copyFileSync(from, to);
        if (!isFile(to) || fs.statSync(to).size !== fs.statSync(from).size) {
            throw new Error("copy verification failed for " + move.to);
        }
        fs.unlinkSync(from);
    }
}

function pruneEmptyDirs(dir: string): void {
    if (!fs.existsSync(dir)) return;
    let names: string[] = [];
    try {
        names = fs.readdirSync(dir);
    } catch {
        return;
    }
    for (const name of names) {
        const p = path.join(dir, name);
        try {
            if (fs.statSync(p).isDirectory()) pruneEmptyDirs(p);
        } catch {
            // ignore
        }
    }
    try {
        if (fs.readdirSync(dir).length === 0) fs.rmdirSync(dir);
    } catch {
        // not empty or in use
    }
}

/** Run the migration. Returns a short human-readable summary, or null when nothing to do. */
export function migrateLegacyLayout(root: string, log: (msg: string) => void = () => { }): string | null {
    const entries: LayoutEntry[] = [];

    const walk = (absDir: string, relDir: string): void => {
        if (!fs.existsSync(absDir)) return;
        let names: string[] = [];
        try {
            names = fs.readdirSync(absDir);
        } catch {
            return;
        }
        for (const name of names) {
            const abs = path.join(absDir, name);
            const rel = relDir === "" ? name : relDir + "/" + name;
            let stat: fs.Stats;
            try {
                stat = fs.statSync(abs);
            } catch {
                continue;
            }
            if (stat.isDirectory()) {
                entries.push({ path: rel, isFile: false });
                walk(abs, rel);
            } else {
                entries.push({ path: rel, isFile: true });
            }
        }
    };

    walk(path.join(root, "userdata"), "userdata");
    walk(path.join(root, "config"), "config");

    const plan = planMigration(entries);
    if (plan.moves.length === 0 && plan.remove.length === 0) return null;

    let moved = 0;
    let removed = 0;
    for (const move of plan.moves) {
        try {
            moveFile(root, move, log);
            moved++;
        } catch (e) {
            log("could not move " + move.from + ": " + (e && (e as any).message ? (e as any).message : e));
        }
    }
    for (const rel of plan.remove) {
        try {
            fs.unlinkSync(path.join(root, rel));
            removed++;
        } catch {
            // ignore
        }
    }

    for (const dir of plan.dropDirs) {
        pruneEmptyDirs(path.join(root, dir));
    }

    return "layout migrated: " + moved + " file(s) moved, " + removed + " stale file(s) removed";
}
