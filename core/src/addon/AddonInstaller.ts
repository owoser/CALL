import * as fs from "fs";
import * as path from "path";
import Paths from "../common/Paths";

/**
 * Installs the bundled addon (behavior pack + resource pack) that defines CALL's tool
 * items, and enables it for the current world.
 *
 * Why this exists: LegacyScriptEngine cannot register new item ids, so the tools have to be
 * real addon items. The packs ship inside the plugin (assets/addon/) and are copied into the
 * server's pack folders on first start; the world's pack lists are then merged - never
 * overwritten, so packs the admin already uses keep working.
 *
 * Enabling a pack only takes effect at world load, so the first run reports "restart
 * required" instead of pretending the items exist.
 */

export const BP_FOLDER = "CALL_Tools_BP";
export const RP_FOLDER = "CALL_Tools_RP";

const BP_UUID = "b7c1f2a4-1d3e-4a55-9a10-6c0f5e7d8a01";
const RP_UUID = "b7c1f2a4-1d3e-4a55-9a10-6c0f5e7d8a03";
const PACK_VERSION = [1, 0, 0];

export interface AddonResult {
    /** The packs are on disk and enabled for the world. */
    ok: boolean;
    /** Something changed, the server must be restarted before the items exist. */
    needsRestart: boolean;
    /** Short human readable summary for the console. */
    message: string;
}

function readJson<T = any>(file: string): T | null {
    try {
        return JSON.parse(fs.readFileSync(file, "utf8"));
    } catch {
        return null;
    }
}

function writeJson(file: string, value: unknown): void {
    fs.mkdirSync(path.dirname(file), { recursive: true });
    fs.writeFileSync(file, JSON.stringify(value, null, 2) + "\n", "utf8");
}

/** Copy a directory recursively, skipping files whose size and mtime already match. */
function copyDir(from: string, to: string): number {
    let copied = 0;
    fs.mkdirSync(to, { recursive: true });
    for (const name of fs.readdirSync(from)) {
        const src = path.join(from, name);
        const dst = path.join(to, name);
        const st = fs.statSync(src);
        if (st.isDirectory()) {
            copied += copyDir(src, dst);
            continue;
        }
        let same = false;
        try {
            const prev = fs.statSync(dst);
            same = prev.size === st.size && Math.abs(prev.mtimeMs - st.mtimeMs) < 2000;
        } catch {
            same = false;
        }
        if (same) continue;
        fs.copyFileSync(src, dst);
        copied++;
    }
    return copied;
}

/** `level-name` from server.properties, falling back to the only world folder. */
export function findWorldDir(serverRoot: string): string | null {
    const worlds = path.join(serverRoot, "worlds");

    let levelName: string | null = null;
    try {
        const props = fs.readFileSync(path.join(serverRoot, "server.properties"), "utf8");
        const m = /^\s*level-name\s*=\s*(.+?)\s*$/m.exec(props);
        if (m) levelName = m[1];
    } catch {
        // server.properties missing - fall through
    }

    if (levelName != null && levelName !== "") {
        const dir = path.join(worlds, levelName);
        if (fs.existsSync(dir)) return dir;
    }
    try {
        const dirs = fs.readdirSync(worlds, { withFileTypes: true }).filter((e) => e.isDirectory());
        if (dirs.length === 1) return path.join(worlds, dirs[0].name);
    } catch {
        // no worlds folder
    }
    return null;
}

/** Append our pack to a world pack list, keeping every entry that is already there. */
function enablePack(worldDir: string, file: string, uuid: string): { changed: boolean; error?: string } {
    const full = path.join(worldDir, file);
    const current = readJson<any[]>(full);
    const list: any[] = Array.isArray(current) ? current : [];

    if (list.some((e) => e && String(e.pack_id).toLowerCase() === uuid)) {
        return { changed: false };
    }

    if (fs.existsSync(full)) {
        try {
            fs.copyFileSync(full, full + ".bak");
        } catch {
            return { changed: false, error: "无法备份 " + file };
        }
    }

    list.push({ pack_id: uuid, version: PACK_VERSION });
    try {
        writeJson(full, list);
        return { changed: true };
    } catch (e) {
        return { changed: false, error: "写入 " + file + " 失败: " + (e && (e as any).message ? (e as any).message : e) };
    }
}

export class AddonInstaller {
    /**
     * Install + enable the tool addon.
     *
     * Safe to call on every start: the copy is skipped when the files are unchanged and the
     * world pack lists are left alone once our uuid is present.
     */
    public static install(): AddonResult {
        const src = path.join(Paths.ASSETS, "addon");
        if (!fs.existsSync(path.join(src, BP_FOLDER))) {
            return { ok: false, needsRestart: false, message: "内置物品包缺失（" + src + "）" };
        }

        const serverRoot = Paths.SERVER_ROOT;
        const exe = ["bedrock_server_mod.exe", "bedrock_server.exe"].some((n) => fs.existsSync(path.join(serverRoot, n)));
        if (!exe) {
            return { ok: false, needsRestart: false, message: "未找到服务器根目录（推断为 " + serverRoot + "）" };
        }

        let copied = 0;
        try {
            copied += copyDir(path.join(src, BP_FOLDER), path.join(serverRoot, "behavior_packs", BP_FOLDER));
            copied += copyDir(path.join(src, RP_FOLDER), path.join(serverRoot, "resource_packs", RP_FOLDER));
        } catch (e) {
            return {
                ok: false,
                needsRestart: false,
                message: "复制物品包失败: " + (e && (e as any).message ? (e as any).message : e),
            };
        }

        const worldDir = findWorldDir(serverRoot);
        if (worldDir == null) {
            return { ok: false, needsRestart: false, message: "未找到世界目录，无法启用内置物品包" };
        }

        const bp = enablePack(worldDir, "world_behavior_packs.json", BP_UUID);
        const rp = enablePack(worldDir, "world_resource_packs.json", RP_UUID);
        const error = bp.error ?? rp.error;
        if (error != null) {
            return { ok: false, needsRestart: false, message: error };
        }

        const changed = copied > 0 || bp.changed || rp.changed;
        if (!changed) {
            return { ok: true, needsRestart: false, message: "内置物品包已是最新" };
        }
        const parts: string[] = [];
        if (copied > 0) parts.push(copied + " 个文件");
        if (bp.changed || rp.changed) parts.push("已写入世界包列表");
        return {
            ok: true,
            needsRestart: true,
            message: "内置工具物品已安装（" + parts.join("，") + "），重启服务器后生效",
        };
    }

    /** True when the addon items are actually available in this process. */
    public static itemsAvailable(): boolean {
        try {
            const item = mc.newItem("call:gear", 1);
            return item != null;
        } catch {
            return false;
        }
    }
}
