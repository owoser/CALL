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
import { describeError, logFailure, sleep } from "../util/Safe";
import { acquire, isLoaded, waitLoaded } from "../game/Chunks";


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
    /**
     * Wait until both corners of `area` are readable.
     *
     * The player is NEVER moved for this any more. `Chunks.acquire` takes a ticking-area
     * LEASE that must outlive the whole slice (both the undo capture and the /fill), so the
     * lease is taken by traversal() around the slice callback - see below.
     */
    private static async loadChunk(caPlayer: CAPlayer, area: Area3): Promise<boolean> {
        if (isLoaded(area)) return true;

        const lang = StructureService.langOf(caPlayer);
        if (caPlayer.settings.loadChuckTip) {
            StructureService.tip(caPlayer, StrFactory.cmdMsg(
                Tr._(lang, "dynamic.StructureManager.loadChunk.overRange", area.toString())
            ));
        }
        return waitLoaded(area);
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

    // ------------------------------------------------------------ traversal
    /**
     * Walk the slice grid, one slice at a time, with a progress bar.
     *
     * Guarantees: `forbidCmd` is always restored and a failing slice callback is treated
     * as a failure instead of an escaping exception.
     *
     * PROGRESS IS TEXT, NOT A BOSS BAR.
     * 2.0 called `Player.setBossBar(uid, title, percent, colour)` with colour 11 for
     * every fill; LSE casts that straight into BDS' `BossBarColor` (0..7) and the client
     * dropped the connection while the server kept running. Each call also emits a fake
     * `AddActorPacket` of type "player". Text is boring and cannot kick anyone - see
     * core/src/game/SafeArgs.ts.
     */
    public static async traversal(
        caPlayer: CAPlayer,
        areas: Areas,
        title: string,
        successCallback: (x: number, z: number) => Promise<boolean>,
        /** Receives the number of slices that failed (0 = complete success). */
        overCallback: (failed: number) => void,
        failCallback: (x: number, z: number) => void,
        waitTime: number = Number(Config.get(Config.GLOBAL, "traversalWaitTime", 20)) || 20
    ): Promise<void> {
        const mx = areas.length;
        const mz = mx > 0 ? areas[0].length : 0;
        let failedSlices = 0;
        if (mx === 0 || mz === 0) {
            overCallback(0);
            return;
        }

        const showProgress = () => !!caPlayer.settings.displayProgressBar;
        const total = mx * mz;
        let lastProgressAt = 0;
        const reportProgress = (percent: number, force = false) => {
            if (!showProgress() && !force) return;
            const now = Date.now();
            if (!force && now - lastProgressAt < 500) return;
            lastProgressAt = now;
            StructureService.tip(caPlayer, StrFactory.cmdMsg(title + " " + Math.round(percent) + "%"), MsgType.TIP);
        };

        caPlayer.forbidCmd = true; // 禁止执行指令
        try {
            reportProgress(0, true);

            for (let x = 0; x < mx; x++) {
                for (let z = 0; z < mz; z++) {
                    const slice = areas[x][z];
                    // The lease must live until AFTER the slice work: /fill and
                    // mc.getStructure both fail on unloaded chunks, and BDS reports that
                    // as "cannot place blocks outside of the world".
                    const lease = await acquire(slice, "slice " + x + "," + z);
                    let stepOk = false;
                    try {
                        const loaded = await StructureService.loadChunk(caPlayer, slice);
                        if (loaded) {
                            try {
                                stepOk = await successCallback(x, z);
                            } catch (e) {
                                logFailure("StructureService.slice " + x + "," + z, e);
                                stepOk = false;
                            }
                        }
                    } finally {
                        lease.release();
                    }
                    if (!stepOk) {
                        failedSlices++;
                        // DO NOT abort the whole operation here. A 96x96 selection is 4
                        // slices; giving up on the first bad one left every later slice
                        // untouched while the player was told nothing at all (the early
                        // `return` also skipped overCallback). Keep going and report.
                        try {
                            failCallback(x, z);
                        } catch (e) {
                            logFailure("StructureService.failCallback", e);
                        }
                        continue;
                    }
                    reportProgress(((x * mz + z + 1) * 100) / total);
                    await sleep(waitTime);
                }
            }

            overCallback(failedSlices);
        } finally {
            caPlayer.forbidCmd = false;
            // NOTE: no position restore. 3.0 removed every teleport from the operation
            // paths (chunks are force-loaded with /tickingarea instead), so the player is
            // exactly where they were. 2.0 restored a LATCHED prePos owned by whichever
            // operation had last called savePos(), which teleported people to unrelated
            // places - e.g. every /ca shape load moved the player to the previous paste's
            // origin.
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
            async (x: number, z: number) => {
                const saveid = structid + "_" + x + "_" + z;
                // mc.getStructure returns null when the chunk is not ready yet, exactly like
                // /fill. Retry before declaring the slice lost.
                let lastError: any = null;
                for (let attempt = 0; attempt < 3; attempt++) {
                    try {
                        NBTService.save(saveid, areas[x][z], false, !caPlayer.settings.saveEntity);
                        return true;
                    } catch (e) {
                        lastError = e;
                        if (attempt < 2) await sleep(700);
                    }
                }
                logFailure("StructureService.save " + x + "," + z, lastError);
                return false;
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
    ): Promise<number> {
        let failedSlices = 0;
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
            (x: number, z: number) => {
                const saveid = structid + "_" + x + "_" + z;
                const start = areas[x][z].start;
                const target = new Pos3(start.x + tx, start.y, start.z + tz, start.dimid);
                // placement is asynchronous (block by block, yielding between batches)
                return NBTService.loadAsync(caPlayer, saveid, target, mirror, degreeNum).then(() => true);
            },
            (failed: number) => {
                failedSlices = failed;
                overCallback();
            },
            () => {
                // handled by traversal (failCallback); nothing extra to clean up here
            },
            Number(Config.get(Config.GLOBAL, "traversalWaitTime", 20)) || 20
        );

        return failedSlices;
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

    /**
     * Apply the next undo/redo entry.
     *
     * The snapshot is only consumed when EVERY slice restored. It previously popped the
     * entry first and deleted each slice file unconditionally after `load()` returned -
     * and `load()` swallows slice failures - so a failed undo destroyed the very data the
     * player needed to retry with.
     */
    private static async pop(caPlayer: CAPlayer, overCallback: () => void, mod: string): Promise<void> {
        const key = `private.${caPlayer.xuid}.${mod}List`;
        const list = Config.get(Config.STRUCTURES, key);
        if (!Array.isArray(list) || list.length === 0) {
            overCallback();
            return;
        }
        // peek, do not remove
        const complex = list[list.length - 1];
        const keys = Object.keys(complex ?? {});
        if (keys.length === 0) {
            list.pop();
            Config.set(Config.STRUCTURES, key, list);
            overCallback();
            return;
        }

        caPlayer.forbidCmd = true;
        let failed = 0;
        try {
            for (let i = 0; i < keys.length; i++) {
                const sid = keys[i];
                const st = complex[sid];
                failed += await StructureService.load(
                    caPlayer, st, sid, st.area.start, i, keys.length,
                    "none", "0_degrees", false, true, false, 100, "",
                    () => { /* completion is read from the return value */ }
                );
            }

            const player = online(caPlayer.xuid);
            const lang = caPlayer.$?.langCode ?? "en_US";

            if (failed > 0) {
                // keep the entry AND the slice files so the player can retry
                if (player != null) {
                    tell(player, StrFactory.cmdWarn(
                        Tr._(lang, "dynamic.StructureManager.undo.incomplete", String(failed))
                    ), MsgType.RAW);
                }
                return;
            }

            list.pop();
            for (const sid of keys) StructureService.delete(caPlayer, sid, complex[sid]);
            Config.set(Config.STRUCTURES, key, list);
        } finally {
            caPlayer.forbidCmd = false;
            overCallback();
        }
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

    /**
     * 普通操作调用入口
     *
     * `failCallback` is not optional in spirit: without it a failed snapshot used to be
     * swallowed (only logged) and `overCallback` was never called, so the operation the
     * caller wanted to run simply never started and the player was told nothing at all.
     */
    public static undoSave(
        caPlayer: CAPlayer,
        structArr: Array<Structure>,
        overCallback: (complex: Complex) => void,
        failCallback?: (error: any) => void
    ) {
        StructureService.undoPush(caPlayer, structArr, (complex: Complex) => {
            StructureService.clearRedoList(caPlayer); // 清空 redoList
            overCallback(complex);
        }, failCallback);
    }

    /** undo 调用入口 */
    public static undoPush(
        caPlayer: CAPlayer,
        structArr: Array<Structure>,
        overCallback: (complex: Complex) => void,
        failCallback?: (error: any) => void
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
            logFailure("StructureService.undoPush", e);
            if (failCallback != null) {
                try {
                    failCallback(e);
                } catch (e2) {
                    logFailure("StructureService.undoPush.fail", e2);
                }
            }
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

    public static async paste(
        caPlayer: CAPlayer,
        pos: Pos3,
        data: any,
        overCallback: () => void,
        mirror: "none" | "x" | "z" | "xz" = "none",
        degrees: string = "0_degrees"
    ): Promise<void> {
        const complex = data?.copy ?? {};
        const keys = Object.keys(complex);
        if (keys.length === 0) throw new Error("nothing to paste");

        for (let i = 0; i < keys.length; i++) {
            const sid = keys[i];
            await StructureService.load(
                caPlayer, complex[sid], sid, pos, i, keys.length,
                mirror, degrees, false, true, false, 100, "",
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