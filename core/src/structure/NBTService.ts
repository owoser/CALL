import * as fs from "fs";
import * as path from "path";
import Area3 from "../common/Area3";
import Paths from "../common/Paths";
import CAPlayer from "../user/CAPlayer";
import { Pos3 } from "../common/Pos3";
import { FileMode } from "../temp/Common";
import { Warn } from "../util/Error";
import { describeError } from "../util/Safe";
import { placeStructure } from "./StructurePlacement";

/**
 * Reads and writes `.mcstructure` files (`userdata/data/nbt/<id>_<x>_<z>.mcstructure`).
 *
 * Fixed in 2.0.0:
 *  - the output directory was never created, so every write threw
 *    ("cannot open file for write") and copy/save/undo were dead;
 *  - `save()` used the *asynchronous* `File.write(...)` but reported success
 *    immediately, so `paste` could read a half-written (or missing) file;
 *  - `load()` compensated for the setStructure +1 offset and then teleported the
 *    player as a side effect, which is both surprising and wrong.
 */
export default class NBTService {
    public static readonly PATH = Paths.NBT;

    private static filePath(saveid: string): string {
        return path.join(NBTService.PATH, saveid + ".mcstructure");
    }

    private static ensureDir(): void {
        fs.mkdirSync(NBTService.PATH, { recursive: true });
    }

    private static write(saveid: string, comp: NbtCompound): void {
        if (comp == null) throw new Error("NBTService.write: empty nbt for " + saveid);
        NBTService.ensureDir();
        const file = new File(NBTService.filePath(saveid), FileMode.WriteMode, true);
        let ok = false;
        try {
            ok = file.writeSync(comp.toBinaryNBT());
        } finally {
            try {
                file.close();
            } catch {
                // ignore
            }
        }
        if (!ok) throw new Error("NBTService.write: failed to write " + saveid);
    }

    /** Capture a region into a structure file. Throws when the engine cannot read it. */
    public static save(saveid: string, area: Area3, ignoreBlocks = false, ignoreEntities = false): void {
        const start = new IntPos(area.start.x, area.start.y, area.start.z, area.start.dimid);
        const end = new IntPos(area.end.x, area.end.y, area.end.z, area.end.dimid);

        let comp: NbtCompound | null = null;
        try {
            comp = mc.getStructure(start, end, ignoreBlocks, ignoreEntities);
        } catch (e) {
            throw new Error("getStructure failed for " + area.toString() + ": " + describeError(e));
        }
        if (comp == null) {
            throw new Error("getStructure returned nothing for " + area.toString() + " (is the area loaded?)");
        }
        NBTService.write(saveid, comp);
    }

    public static saveFromNBT(saveid: string, comp: NbtCompound): boolean {
        try {
            NBTService.write(saveid, comp);
            return true;
        } catch {
            return false;
        }
    }

    public static exists(saveid: string): boolean {
        try {
            return fs.statSync(NBTService.filePath(saveid)).isFile();
        } catch {
            return false;
        }
    }

    public static read(saveid: string): NbtCompound {
        const file = NBTService.filePath(saveid);
        let exists = false;
        try {
            exists = fs.statSync(file).isFile();
        } catch {
            exists = false;
        }
        if (!exists) {
            throw new Warn("dynamic.StructureManager.load.missingFile");
        }

        let raw: string | ByteBuffer | undefined;
        const handle = new File(file, FileMode.ReadMode, true);
        try {
            raw = handle.readAllSync();
        } finally {
            try {
                handle.close();
            } catch {
                // ignore
            }
        }
        if (raw == null) throw new Error("cannot read " + saveid);

        const parsed = NBT.parseBinaryNBT(raw as ArrayBuffer);
        if (parsed == null) throw new Error("cannot parse " + saveid);
        return parsed;
    }

    /**
     * Place a stored structure so its corner sits exactly on `pos`.
     * No teleporting, no off-by-one.
     */
    public static load(
        caPlayer: CAPlayer,
        saveid: string,
        pos: Pos3,
        mirror: string | number = "none",
        rotation: number = 0
    ): boolean {
        const nbtObj = NBTService.read(saveid);
        return placeStructure(nbtObj, pos, mirror, rotation);
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
