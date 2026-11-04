import Config from "../common/Config";
import Players from "../user/Players";
import Area3 from "../common/Area3";
import CAPlayer from "../user/CAPlayer";
import { Pos3 } from "../common/Pos3";
import { Complex, Data, Structure } from "../common/Structure";
import { Areas } from "../temp/Data";
import StrFactory from "../util/StrFactory";
import NBTService from "./NBTService";
import { Matrix3D, Transform3 } from "../util/SimpleMatrix";
import Tr from "../util/Translator";
import { MsgType, online, tell } from "../util/Msg";
import { describeError, sleep } from "../util/Safe";

/**
 * Copy / paste / save / load / undo / redo.
 *
 * Behavioural fixes in 2.0.0 (all of them were "copy does nothing" or "undo restores a
 * different region" class bugs):
 *
 *  - `save()` and `load()` were `async` but never awaited their own traversal, so
 *    `otherSave()` fired every slice of a multi-slice operation concurrently;
 *  - `NBTService.save` threw because its output directory did not exist, and the
 *    throw happened inside a promise callback, i.e. it vanished into an unhandled
 *    rejection;
 *  - `traversal()` had no `finally`, so any failure left `forbidCmd` stuck on
 *    ("请等待当前操作完成") and the boss bar on screen forever;
 *  - `loadChunk()` teleported the player around to force chunk loading even when the
 *    caller did not want that, and could not be turned off;
 *  - stored player data from older versions can be missing `redoList`/`copy`, which
 *    crashed every entry point that iterated it.
 */
export default class StructureService {
    public static STRUCT_OPN_MOD = {
        FAST: 0,
        STABLE: 1
    }
    public static uid = 0;

    /** Boss bar slot reused for progress, so we never leak bars. */
    private static readonly BAR_UID = 0xCA11;

    // ---------------------------------------------------------------- helpers
    private static langOf(caPlayer: CAPlayer): string {
        const p = online(caPlayer?.xuid);
        return p ? p.langCode : "en_US";
    }

    private static tip(caPlayer: CAPlayer, text: string, type: number = MsgType.RAW): void {
        tell(online(caPlayer?.xuid), text, type);
    }

    /**
     * Older structures.json files predate `redoList`/`copy`; make sure every entry
     * point can iterate them without a null check dance.
     */
    public static normalizeData(data: any): Data {
        const out: any = data && typeof data === "object" ? data : {};
        if (out.copy == null || typeof out.copy !== "object") out.copy = {};
        if (!Array.isArray(out.undoList)) out.undoList = [];
        if (!Array.isArray(out.redoList)) out.redoList = [];
        if (out.saveList == null || typeof out.saveList !== "object") out.saveList = {};
        if (out.pid == null) out.pid = "0001";
        return out as Data;
    }

    // ------------------------------------------------------------ chunk gate
    private static canGetBlock(area: Area3): boolean {
        const a = area.start;
        const b = area.end;
        try {
            return mc.getBlock(a.x, a.y, a.z, a.dimid) != null
                && mc.getBlock(b.x, b.y, b.z, b.dimid) != null;
        } catch {
            return false;
        }
    }

    private static loadChunkMode(): string {
        const raw = String(Config.get(Config.GLOBAL, "loadChunkMode", "teleport") ?? "").toLowerCase();
        return raw === "poll" ? "poll" : "teleport";
    }

    /**
     * Wait until both corners of `area` are readable.
     *
     * BDS has no public "load this chunk" API, so the only reliable way to force a
     * remote chunk in is to move a player next to it - which is why the legacy code
     * teleported. `loadChunkMode: "poll"` disables that: the operation then simply
     * fails with a clear message when the area is not loaded, instead of yanking the
     * player around.
     */
    private static async loadChunk(caPlayer: CAPlayer, area: Area3): Promise<boolean> {
        if (StructureService.canGetBlock(area)) return true;

        const mode = StructureService.loadChunkMode();
        const max = Math.max(1, Number(Config.get(Config.GLOBAL, "maxLoadCheckNum", 10)) || 10);
        const lang = StructureService.langOf(caPlayer);
        const tip = !!caPlayer.settings.loadChuckTip;

        if (tip) {
            StructureService.tip(caPlayer, StrFactory.cmdMsg(
                Tr._(lang, "dynamic.StructureManager.loadChunk.overRange", area.toString())
            ));
        }

        const p = online(caPlayer.xuid);
        for (let attempt = 0; attempt < max; attempt++) {
            if (mode === "teleport" && p != null) {
                // Land on top of the area instead of inside it: teleporting into the
                // middle of a solid region used to suffocate / fall-damage the player.
                try {
                    p.teleport(
                        (area.start.x + area.end.x) / 2 + 0.5,
                        Math.min(area.end.y + 2, 320),
                        (area.start.z + area.end.z) / 2 + 0.5,
                        area.start.dimid
                    );
                } catch {
                    // player might be in a state that rejects teleports (loading screen)
                }
            }
            await sleep(400);
            if (StructureService.canGetBlock(area)) {
                if (tip) {
                    StructureService.tip(caPlayer, StrFactory.cmdTip(
                        Tr._(lang, "dynamic.StructureManager.loadChunk.success", area.toString())
                    ));
                }
                return true;
            }
        }

        if (tip) {
            StructureService.tip(caPlayer, StrFactory.cmdErr(
                Tr._(lang, "dynamic.StructureManager.loadChunk.cancel", area.toString(), String(max))
            ));
        }
        return false;
    }

    // -------------------------------------------------------------- storage
    public static register(xuid: string) {
        const pr = Config.get(Config.STRUCTURES, "private") ?? {};
        const template = StructureService.normalizeData(pr.default ? JSON.parse(JSON.stringify(pr.default)) : {});
        template.pid = ("0000" + Object.keys(pr).length).slice(-4);
        Config.set(Config.STRUCTURES, `private.${xuid}`, template);
        return template;
    }

    public static getData(xuid: string): Data {
        let data = Config.get(Config.STRUCTURES, `private.${xuid}`);
        if (data == null) {
            data = StructureService.register(xuid);
        }
        const normalized = StructureService.normalizeData(data);
        if (normalized !== data) {
            Config.set(Config.STRUCTURES, `private.${xuid}`, normalized);
        }
        return normalized;
    }

    public static setData(xuid: string, data: Data) {
        return Config.set(Config.STRUCTURES, `private.${xuid}`, data);
    }

    public static publicForEach(callback: (id: string, xuid: string) => void) {
        const pu = Config.get(Config.STRUCTURES, "public");
        if (pu == null || typeof pu !== "object") return;
        for (const key of Object.keys(pu)) {
            const structids = pu[key];
            if (!Array.isArray(structids)) continue;
            for (const id of structids) {
                if (id == null) continue;
                callback(id, key);
            }
        }
    }

    // ------------------------------------------------------- position / tp
    public static savePos(caPlayer: CAPlayer) {
        const p = online(caPlayer.xuid);
        if (p == null) return;
        caPlayer.prePos = Pos3.fromPos(p.pos).calibration();
        caPlayer.direction = p.direction;
    }

    public static tp(caPlayer: CAPlayer) {
        const pos = caPlayer.prePos;
        const player = online(caPlayer.xuid);
        if (pos == null || player == null) return;

        try {
            const diArr = Pos3.directionToPosArr(caPlayer.direction ?? player.direction);
            const cmd =
                `/tp "${player.realName}" ${pos.x.toFixed(2)} ${(pos.y - 0.5).toFixed(2)} ${pos.z.toFixed(2)} ` +
                `facing ${(pos.x + diArr[0]).toFixed(2)} ${(pos.y + diArr[1]).toFixed(2)} ${(pos.z + diArr[2]).toFixed(2)}`;
            const res = Play_versionSafeRun(caPlayer, cmd);
            if (res && res.success) {
                caPlayer.refreshAllChunks();
            }
        } catch (e) {
            logger.debug("[CALL][StructureService.tp] " + describeError(e));
        }
    }

    // ------------------------------------------------------------ traversal
    /**
     * Walk the slice grid, one slice at a time, with a progress bar.
     *
     * Guarantees: `forbidCmd` is always restored, the boss bar is always removed, and a
     * failing slice callback is treated as a failure instead of an escaping exception.
     */
    public static async traversal(
        caPlayer: CAPlayer,
        areas: Areas,
        title: string,
        color: number,
        successCallback: (x: number, z: number) => Promise<boolean>,
        overCallback: () => void,
        failCallback: (x: number, z: number) => void,
        waitTime: number = Number(Config.get(Config.GLOBAL, "traversalWaitTime", 20)) || 20
    ): Promise<void> {
        const mx = areas.length;
        const mz = mx > 0 ? areas[0].length : 0;
        if (mx === 0 || mz === 0) {
            overCallback();
            return;
        }

        const showBar = () => !!caPlayer.settings.displayProgressBar && online(caPlayer.xuid) != null;
        const total = mx * mz;

        caPlayer.forbidCmd = true; // 禁止执行指令
        try {
            if (showBar()) {
                const p = online(caPlayer.xuid)!;
                p.setBossBar(StructureService.BAR_UID, StrFactory.cmdMsg(title), 0, color);
            }

            for (let x = 0; x < mx; x++) {
                for (let z = 0; z < mz; z++) {
                    const loaded = await StructureService.loadChunk(caPlayer, areas[x][z]);
                    let stepOk = false;
                    if (loaded) {
                        try {
                            stepOk = await successCallback(x, z);
                        } catch (e) {
                            logger.error("[CALL][StructureService] slice " + x + "," + z + " failed: " + describeError(e)
                                + (e && e.stack ? "\n" + e.stack : ""));
                            stepOk = false;
                        }
                    }
                    if (!stepOk) {
                        try {
                            failCallback(x, z);
                        } catch (e) {
                            logger.error("[CALL][StructureService] failCallback threw: " + describeError(e));
                        }
                        return;
                    }
                    if (showBar()) {
                        const p = online(caPlayer.xuid);
                        if (p != null) {
                            p.setBossBar(StructureService.BAR_UID, StrFactory.cmdMsg(title), ((x * mz + z + 1) * 100) / total, color);
                        }
                    }
                    await sleep(waitTime);
                }
            }

            overCallback();
        } finally {
            caPlayer.forbidCmd = false;
            try {
                const p = online(caPlayer.xuid);
                if (p != null) p.removeBossBar(StructureService.BAR_UID);
            } catch {
                // ignore
            }
            StructureService.tp(caPlayer);
        }
    }

    public static getId(): number {
        return StructureService.uid++;
    }

    public static generateSid(): string {
        const timestamp = Date.now().toString(36);
        const randomString = Math.random().toString(36).substring(2, 4);
        return timestamp + randomString;
    }

    // ----------------------------------------------------------------- save
    public static async save(
        caPlayer: CAPlayer,
        structure: Structure,
        index: number,
        total: number,
        overCallback: (structid: string, data: any) => void
    ): Promise<void> {
        const xuid = caPlayer.xuid;
        const data = StructureService.getData(xuid);
        const areas = structure.getAreas();
        const structid = StructureService.generateSid();
        const lang = StructureService.langOf(caPlayer);
        let failed = false;

        await StructureService.traversal(
            caPlayer,
            areas,
            Tr._(lang, "dynamic.StructureManager.save.saving", `${index + 1}/${total}`),
            1,
            (x: number, z: number) => {
                const saveid = structid + "_" + x + "_" + z;
                NBTService.save(saveid, areas[x][z], false, !caPlayer.settings.saveEntity);
                return Promise.resolve(true);
            },
            () => {
                overCallback(structid, data);
            },
            (x: number, z: number) => {
                failed = true;
                // 删除所有已保存的切片
                for (let tz = 0; tz <= z; tz++) {
                    for (let tx = 0; tx <= x; tx++) {
                        NBTService.del(structid + "_" + tx + "_" + tz);
                    }
                }
            },
            20
        );

        if (failed) {
            throw new Error(Tr._(lang, "dynamic.StructureManager.save.failed", structid));
        }
    }

    // ----------------------------------------------------------------- load
    public static async load(
        caPlayer: CAPlayer,
        preStructure: Structure,
        structid: string,
        posInt: Pos3,
        index: number,
        total: number,
        mirror = "none",
        degrees = "0_degrees",
        includeEntities = false,
        includeBlocks = true,
        waterlogged = false,
        integrity = 100,
        seed = "",
        overCallback: () => void
    ): Promise<void> {
        const area = Area3.fromArea3D(preStructure.area).relative();
        const areas = new Structure(area).getAreas();
        const degreeNum = parseFloat(degrees) || 0;
        const lang = StructureService.langOf(caPlayer);

        const trans = Transform3.getBasicRota(degreeNum).mul(Transform3.getMirror(mirror));
        const sta2 = area.start.transform2D(trans as Matrix3D);
        const end2 = area.end.transform2D(trans as Matrix3D);
        const lens2 = [end2.x - sta2.x, end2.z - sta2.z];

        for (let iz = 0; iz < preStructure.zSize; iz++) {
            for (let ix = 0; ix < preStructure.xSize; ix++) {
                const a = areas[ix][iz].transform2D(trans as Matrix3D);
                a.start.add(posInt.x, posInt.y, posInt.z);
                a.end.add(posInt.x, posInt.y, posInt.z);
                areas[ix][iz] = a;
            }
        }

        const tx = lens2[0] < 0 ? -lens2[0] : 0;
        const tz = lens2[1] < 0 ? -lens2[1] : 0;

        await StructureService.traversal(
            caPlayer,
            areas,
            Tr._(lang, "dynamic.StructureManager.load.loading", `${index + 1}/${total}`),
            6,
            (x: number, z: number) => {
                const saveid = structid + "_" + x + "_" + z;
                const start = areas[x][z].start;
                const target = new Pos3(start.x + tx, start.y, start.z + tz, start.dimid);
                return Promise.resolve(NBTService.load(caPlayer, saveid, target, mirror, degreeNum));
            },
            () => {
                overCallback();
            },
            () => {
                // handled by traversal (failCallback); nothing extra to clean up here
            },
            Number(Config.get(Config.GLOBAL, "traversalWaitTime", 20)) || 20
        );
    }

    public static delete(caPlayer: CAPlayer, sid: string, st: Structure) {
        if (st == null) return;
        for (let z = 0; z < st.zSize; z++) {
            for (let x = 0; x < st.xSize; x++) {
                NBTService.del(sid + "_" + x + "_" + z);
            }
        }
        if (!st.isPublic) return;

        const pu = Config.get(Config.STRUCTURES, "public");
        if (pu == null || typeof pu !== "object") return;
        const xuid = caPlayer?.xuid;
        const list = pu[xuid];
        if (!Array.isArray(list)) return;
        pu[xuid] = list.filter((id: any) => id != null && id !== sid);
        if (pu[xuid].length === 0) delete pu[xuid];
        Config.set(Config.STRUCTURES, "public", pu);
    }

    public static getAllNBT(st: Structure, sid: string): NbtCompound[][] {
        const arr: NbtCompound[][] = [];
        for (let x = 0; x < st.xSize; x++) {
            const row: NbtCompound[] = [];
            for (let z = 0; z < st.zSize; z++) {
                row.push(NBTService.read(sid + "_" + x + "_" + z));
            }
            arr.push(row);
        }
        return arr;
    }

    public static getPrivate(): any {
        return Config.get(Config.STRUCTURES, "private");
    }

    public static getPrivateArr(caPlayer: CAPlayer): any[] {
        const arr: any[] = [];
        const saveList = Config.get(Config.STRUCTURES, `private.${caPlayer.xuid}.saveList`);
        if (saveList == null || typeof saveList !== "object") return arr;
        Object.keys(saveList).forEach((structid) => {
            const st = saveList[structid];
            if (st == null) return;
            arr.push({ id: structid, name: st.name, author: caPlayer.xuid, isPublic: !!st.isPublic });
        });
        return arr;
    }

    public static getPublicArr(): any[] {
        const arr: any[] = [];
        StructureService.publicForEach((id: string, key: string) => {
            const st: Structure = Config.get(Config.STRUCTURES, `private.${key}.saveList.${id}`);
            if (st == null) return;
            arr.push({ id: id, name: st.name, author: key, isPublic: !!st.isPublic });
        });
        return arr;
    }

    public static getTargetStruct(st: Structure, pos: Pos3) {
        const area = Area3.fromArea3D(st.area).relative();
        area.start.add(pos.x, pos.y, pos.z);
        area.end.add(pos.x, pos.y, pos.z);
        return new Structure(area);
    }

    public static getTargetStructs(complex: Complex, targetPos: Pos3): Array<Structure> {
        const res: Array<Structure> = [];
        Object.keys(complex).forEach((sid) => {
            const area = Area3.fromArea3D(complex[sid].area).relative();
            area.start.add(targetPos.x, targetPos.y, targetPos.z);
            area.end.add(targetPos.x, targetPos.y, targetPos.z);
            res.push(new Structure(area));
        });
        return res;
    }

    // ------------------------------------------------------- internal writes
    private static async otherSave(
        caPlayer: CAPlayer,
        structArr: Array<Structure>,
        overCallback: (complex: Complex) => void
    ): Promise<Complex> {
        const complex: Complex = {};
        for (let i = 0; i < structArr.length; i++) {
            const st = structArr[i];
            st.name = "system_save";
            // save() now really waits for its traversal, so slices stay sequential
            await StructureService.save(caPlayer, st, i, structArr.length, (structid: string) => {
                complex[structid] = st;
            });
        }
        overCallback(complex);
        return complex;
    }

    private static async pop(caPlayer: CAPlayer, overCallback: () => void, mod: string): Promise<void> {
        const key = `private.${caPlayer.xuid}.${mod}List`;
        const list = Config.get(Config.STRUCTURES, key);
        if (!Array.isArray(list) || list.length === 0) {
            overCallback();
            return;
        }
        const complex = list.pop();
        const keys = Object.keys(complex ?? {});

        for (let i = 0; i < keys.length; i++) {
            const sid = keys[i];
            const st = complex[sid];
            await StructureService.load(
                caPlayer, st, sid, st.area.start, i, keys.length,
                "none", "0_degrees", false, true, false, 100, "",
                () => {
                    // loaded: the snapshot is consumed once all slices are back
                }
            );
            StructureService.delete(caPlayer, sid, st);
        }

        Config.set(Config.STRUCTURES, key, list);
        overCallback();
    }

    public static clearCopy(caPlayer: CAPlayer) {
        const complex = Config.get(Config.STRUCTURES, `private.${caPlayer.xuid}.copy`);
        if (complex != null && typeof complex === "object") {
            Object.keys(complex).forEach((sid) => {
                StructureService.delete(caPlayer, sid, complex[sid]);
            });
        }
        Config.set(Config.STRUCTURES, `private.${caPlayer.xuid}.copy`, {});
    }

    public static clearUndoList(caPlayer: CAPlayer) {
        StructureService.clearList(caPlayer, "undoList");
    }

    public static clearRedoList(caPlayer: CAPlayer) {
        StructureService.clearList(caPlayer, "redoList");
    }

    private static clearList(caPlayer: CAPlayer, name: "undoList" | "redoList") {
        const key = `private.${caPlayer.xuid}.${name}`;
        const list = Config.get(Config.STRUCTURES, key);
        if (Array.isArray(list)) {
            list.forEach((complex: Complex) => {
                Object.keys(complex ?? {}).forEach((sid) => {
                    StructureService.delete(caPlayer, sid, complex[sid]);
                });
            });
        }
        Config.set(Config.STRUCTURES, key, []);
    }

    /** 普通操作调用入口 */
    public static undoSave(
        caPlayer: CAPlayer,
        structArr: Array<Structure>,
        overCallback: (complex: Complex) => void
    ) {
        StructureService.undoPush(caPlayer, structArr, (complex: Complex) => {
            StructureService.clearRedoList(caPlayer); // 清空 redoList
            overCallback(complex);
        });
    }

    /** undo 调用入口 */
    public static undoPush(
        caPlayer: CAPlayer,
        structArr: Array<Structure>,
        overCallback: (complex: Complex) => void
    ) {
        StructureService.otherSave(caPlayer, structArr, (complex: Complex) => {
            const data = StructureService.getData(caPlayer.xuid);
            data.undoList.push(complex);
            const max = Number(Config.get(Config.GLOBAL, "maxUndoStep", 10)) || 10;
            while (data.undoList.length > max) {
                const dropped = data.undoList.shift();
                Object.keys(dropped ?? {}).forEach((sid) => {
                    StructureService.delete(caPlayer, sid, dropped[sid]);
                });
            }
            Config.set(Config.STRUCTURES, `private.${caPlayer.xuid}`, data);
            overCallback(complex);
        }).catch((e) => {
            logger.error("[CALL][StructureService.undoPush] snapshot failed: " + describeError(e));
        });
    }

    public static redoPush(caPlayer: CAPlayer, structArr: Array<Structure>, overCallback: () => void) {
        StructureService.otherSave(caPlayer, structArr, (complex: Complex) => {
            const data = StructureService.getData(caPlayer.xuid);
            data.redoList.push(complex);
            Config.set(Config.STRUCTURES, `private.${caPlayer.xuid}`, data);
            overCallback();
        }).catch((e) => {
            logger.error("[CALL][StructureService.redoPush] snapshot failed: " + describeError(e));
        });
    }

    public static undoPop(caPlayer: CAPlayer, overCallback: () => void) {
        StructureService.pop(caPlayer, overCallback, "undo").catch((e) =>
            logger.error("[CALL][StructureService.undoPop] " + describeError(e))
        );
    }

    public static redoPop(caPlayer: CAPlayer, overCallback: () => void) {
        StructureService.pop(caPlayer, overCallback, "redo").catch((e) =>
            logger.error("[CALL][StructureService.redoPop] " + describeError(e))
        );
    }

    public static copy(
        caPlayer: CAPlayer,
        structArr: Array<Structure>,
        delLast: any,
        lastComplex: Complex,
        overCallback: (complex: Complex) => void
    ) {
        if (delLast && lastComplex && typeof lastComplex === "object") {
            Object.keys(lastComplex).forEach((sid) => {
                StructureService.delete(caPlayer, sid, lastComplex[sid]);
            });
        }
        StructureService.otherSave(caPlayer, structArr, overCallback).catch((e) =>
            logger.error("[CALL][StructureService.copy] " + describeError(e))
        );
    }

    public static async paste(caPlayer: CAPlayer, pos: Pos3, data: any, overCallback: () => void): Promise<void> {
        const complex = data?.copy ?? {};
        const keys = Object.keys(complex);
        if (keys.length === 0) throw new Error("nothing to paste");

        for (let i = 0; i < keys.length; i++) {
            const sid = keys[i];
            await StructureService.load(
                caPlayer, complex[sid], sid, pos, i, keys.length,
                "none", "0_degrees", false, true, false, 100, "",
                () => { /* per-slice */ }
            );
        }
        overCallback();
    }
}

/**
 * Run a command as the player, with the pre-2.0 `Players.cmd` semantics, but without
 * importing Players here (that would be a cycle: Players -> Activity -> ... -> here).
 */
function Play_versionSafeRun(caPlayer: CAPlayer, cmd: string): { success: boolean; output: string } | null {
    const player = online(caPlayer.xuid);
    if (player == null) return null;
    try {
        const full = `/execute at "${player.realName}" run ${cmd}`;
        return mc.runcmdEx(full) as { success: boolean; output: string };
    } catch (e) {
        logger.debug("[CALL][StructureService] runcmd failed: " + describeError(e));
        return null;
    }
}
