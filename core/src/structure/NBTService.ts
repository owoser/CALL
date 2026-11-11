import * as fs from "fs";
import * as path from "path";
import Area3 from "../common/Area3";
import Paths from "../common/Paths";
import CAPlayer from "../user/CAPlayer";
import { Pos3 } from "../common/Pos3";
import { Warn } from "../util/Error";
import { describeError } from "../util/Safe";
import { MsgType, online, tell } from "../util/Msg";
import { placeBytesAsync } from "./StructurePlacement";
import StructureStore, { sliceFileName } from "./StructureStore";

/**
 * Structure slices: capture to CALL's own .mcstructure files, restore them into the world.
 *
 * WHY NOT mc.setStructure / /structure load
 * -----------------------------------------
 * Verified with tests/live on LL 26.51.x + LSE 0.22.x:
 *
 *   mc.getStructure()  -> works, NBT is correct.
 *   mc.setStructure()  -> silently no-op with engine-captured NBT, and an ACCESS
 *                         VIOLATION (0xC0000005, StructureTemplate::placeInWorld) with a
 *                         hand-built template. That crash is what dropped every player
 *                         whenever 1.6.1 pasted or generated a shape.
 *   /structure save|load -> works, but the saved structures live only for the current
 *                         session (`disk` mode produced no file anywhere on the server),
 *                         so they cannot back CALL's save/load/list feature.
 *
 * So CALL keeps owning its files (unchanged, 1.x-compatible path) and restores them by
 * writing blocks one at a time, yielding between batches.
 */
export default class NBTService {
    /** CALL's own structure store. */
    public static readonly PATH = Paths.NBT;

    /**
     * Absolute path of one slice.
     *
     * `saveid` stays the historical `<sid>_<x>_<z>` key so every call site keeps working; the
     * folder and the on-disk name come from StructureStore. A structure that fits in one slice
     * is stored as `<sid>.mcstructure`, a split one as `<sid>_<x>_<z>.mcstructure`.
     */
    public static filePath(saveid: string): string {
        const raw = String(saveid ?? "");
        // `<sid>_<x>_<z>` when the caller passes a slice id; a bare `<sid>` otherwise.
        const m = /^(.*)_(\d+)_(\d+)$/.exec(raw);
        const sid = m == null ? raw.split("_")[0] : m[1];
        const dir = StructureStore.dirOf(sid);
        const slices = StructureStore.slicesOf(sid);
        const file = slices == null
            ? raw
            : sliceFileName(sid, m == null ? 0 : Number(m[2]), m == null ? 0 : Number(m[3]), slices[0], slices[1]);
        const folder = dir == null ? NBTService.PATH : path.join(NBTService.PATH, dir);
        return path.join(folder, file + ".mcstructure");
    }

    private static ensureDir(): void {
        fs.mkdirSync(NBTService.PATH, { recursive: true });
    }

    /** Capture a region into a named structure file. */
    public static save(saveid: string, area: Area3, ignoreBlocks = false, ignoreEntities = false): void {
        if (saveid == null || saveid === "") throw new Error("NBTService.save: empty id");

        let comp: NbtCompound | null = null;
        try {
            comp = mc.getStructure(
                new IntPos(area.start.x, area.start.y, area.start.z, area.start.dimid),
                new IntPos(area.end.x, area.end.y, area.end.z, area.end.dimid),
                ignoreBlocks,
                ignoreEntities
            );
        } catch (e) {
            throw new Error("getStructure failed for " + area.toString() + ": " + describeError(e));
        }
        if (comp == null) {
            throw new Error("getStructure returned nothing for " + area.toString() + " (is the area loaded?)");
        }
        NBTService.writeFile(saveid, comp);
    }

    public static saveFromNBT(saveid: string, comp: NbtCompound): boolean {
        try {
            NBTService.writeFile(saveid, comp);
            return true;
        } catch (e) {
            logger.warn("[NBTService] saveFromNBT failed: " + describeError(e));
            return false;
        }
    }

    public static writeFile(saveid: string, comp: NbtCompound): void {
        if (comp == null) throw new Error("writeFile: empty nbt");
        NBTService.ensureDir();
        const bytes = Buffer.from(new Uint8Array(comp.toBinaryNBT() as ArrayBuffer));
        StructureStore.writeAtomic(NBTService.filePath(saveid), bytes);
    }

    public static exists(saveid: string): boolean {
        try {
            return fs.statSync(NBTService.filePath(saveid)).isFile();
        } catch {
            return false;
        }
    }

    /** Raw bytes of a stored structure. */
    public static readBytes(saveid: string): Buffer {
        const file = NBTService.filePath(saveid);
        try {
            return fs.readFileSync(file);
        } catch {
            // The path matters: a public structure is resolved from a folder name, and the
            // one thing an operator needs to see is where we looked.
            throw new Warn("dynamic.StructureManager.load.missingFile");
        }
    }

    /** Absolute path a saveid resolves to (diagnostics only). */
    public static pathOf(saveid: string): string {
        return NBTService.filePath(saveid);
    }

    /** Read a stored structure back as NBT (also used by export). */
    public static read(saveid: string): NbtCompound {
        const raw = NBTService.readBytes(saveid);
        const copy = new Uint8Array(raw.length);
        copy.set(raw);
        const parsed = NBT.parseBinaryNBT(copy.buffer as ArrayBuffer);
        if (parsed == null) throw new Error("cannot parse structure " + saveid);
        return parsed;
    }

    /**
     * Async variant used by the traversal engine.
     * NOTE: mirror/rotation are accepted for API compatibility; per-block placement
     * writes the captured orientation as-is.
     */
    public static async loadAsync(
        caPlayer: CAPlayer,
        saveid: string,
        pos: Pos3,
        mirror: string | number = "none",
        rotation: number = 0
    ): Promise<number> {
        if (!NBTService.exists(saveid)) throw new Warn("dynamic.StructureManager.load.missingFile");
        const bytes = NBTService.readBytes(saveid);
        const batch = Number(Config_getNum("placeBatchBlocks", 2000));
        return placeBytesAsync(bytes, pos, batch > 0 ? batch : 2000, {
            rotation: typeof rotation === "number" ? rotation : parseFloat(String(rotation)) || 0,
            mirror: String(mirror ?? "none"),
            // paste / load / undo must reproduce the snapshot cell for cell
            writeAir: true,
            // a restore may legitimately be far larger than a generated shape
            restore: true,
            onProgress: (done, total, written) => NBTService.reportProgress(caPlayer, done, total, written),
        });
    }

    private static lastTip = 0;

    /** Throttled progress text for a long restore. */
    private static reportProgress(caPlayer: CAPlayer, done: number, total: number, written: number): void {
        const now = Date.now();
        if (now - NBTService.lastTip < 1000) return;
        NBTService.lastTip = now;
        const player = online(caPlayer.xuid);
        if (player == null || total <= 0) return;
        const pct = Math.floor((done * 100) / total);
        tell(player, "CALL: " + pct + "% (" + written + "/" + total + ")", MsgType.TIP);
    }

    public static del(saveid: string): boolean {
        const file = NBTService.filePath(saveid);
        // data/nbt/public/ belongs to the operator: CALL may read it, never delete it.
        if (file.replace(/\\/g, "/").includes("/public/")) {
            logger.warn("[store] refused to delete a public structure file: " + file);
            return false;
        }
        try {
            fs.unlinkSync(file);
            return true;
        } catch {
            return false;
        }
    }
}

/** Small helper so this module stays independent of Config's static init order. */
function Config_getNum(key: string, fallback: number): number {
    try {
        const Config = require("../common/Config").default;
        const v = Number(Config.get(Config.GLOBAL, key, fallback));
        return Number.isFinite(v) ? v : fallback;
    } catch {
        return fallback;
    }
}
