import * as fs from "fs";
import * as path from "path";
import Area3 from "../common/Area3";
import Paths from "../common/Paths";
import CAPlayer from "../user/CAPlayer";
import { Pos3 } from "../common/Pos3";
import { Warn } from "../util/Error";
import { describeError } from "../util/Safe";
import { placeBytesAsync } from "./StructurePlacement";

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

    public static filePath(saveid: string): string {
        return path.join(NBTService.PATH, saveid + ".mcstructure");
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
            logger.warn("[CALL][NBTService] saveFromNBT failed: " + describeError(e));
            return false;
        }
    }

    public static writeFile(saveid: string, comp: NbtCompound): void {
        if (comp == null) throw new Error("writeFile: empty nbt");
        NBTService.ensureDir();
        const bytes = Buffer.from(new Uint8Array(comp.toBinaryNBT() as ArrayBuffer));
        fs.writeFileSync(NBTService.filePath(saveid), bytes);
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
        try {
            return fs.readFileSync(NBTService.filePath(saveid));
        } catch {
            throw new Warn("dynamic.StructureManager.load.missingFile");
        }
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
        const batch = Number(Config_getNum("placeBatchBlocks", 600));
        return placeBytesAsync(bytes, pos, batch > 0 ? batch : 600, {
            rotation: typeof rotation === "number" ? rotation : parseFloat(String(rotation)) || 0,
            mirror: String(mirror ?? "none"),
        });
    }

    public static del(saveid: string): boolean {
        try {
            fs.unlinkSync(NBTService.filePath(saveid));
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
