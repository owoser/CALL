import Config from "../common/Config";
import Constant from "../temp/Constant";
import StructureService from "./StructureService";
import StructureStore, { resolveStructureId } from "./StructureStore";
import Area3 from "../common/Area3";
import CAPlayer from "../user/CAPlayer";
import { Pos3 } from "../common/Pos3";
import { Complex, Data, Structure } from "../common/Structure";
import StrFactory from "../util/StrFactory";
import AreaOperation from "./AreaOperation";
import { Pos } from "../temp/Pos";
import Tr from "../util/Translator";
import { MsgType, online, tell } from "../util/Msg";
import { describeError } from "../util/Safe";
import { Degrees, MirrorMode, PivotMode, degreesName, rotatedTargetAreas, rotatedUnion } from "./Rotate";

export default class StructureOperation {
    private static setDimid(complex: any, distDimid: number): void {
        Object.keys(complex).forEach((sid, i) => {
            complex[sid].area.start.dimid = distDimid;
            complex[sid].area.end.dimid = distDimid;
        });
    }

    /**
     * Resolve a structure id the player typed or picked.
     *
     * Three tables, in order: the player's own saves, the published registry, and the folders
     * under data/nbt/public/. The last one is what the menu shows - it used to be missing here,
     * so a freshly copied public structure listed fine and then answered "无法找到结构".
     */
    public static findId(input: string, caPlayer: CAPlayer) {
        const xuid = caPlayer.$.xuid;
        const data = StructureService.getData(xuid);
        const saveList = data.saveList ?? {};

        const registry: string[] = [];
        const registryOwner = new Map<string, string>();
        StructureService.publicForEach((id: string, key: string) => {
            if (id == null) return;
            registry.push(id);
            if (!registryOwner.has(id)) registryOwner.set(id, key);
        });

        const scanned = StructureStore.scanPublic().map((e) => ({ name: e.name, sid: e.sid }));
        const hit = resolveStructureId(input, { own: Object.keys(saveList), registry, scanned });

        if (hit.kind === "own") return { xuid, structid: hit.sid, kind: hit.kind };
        if (hit.kind === "registry") {
            return { xuid: registryOwner.get(hit.sid) ?? xuid, structid: hit.sid, kind: hit.kind };
        }
        if (hit.kind === "scanned") return { xuid, structid: hit.display, kind: hit.kind };

        throw new Error(
            Tr._(caPlayer.$.langCode, "dynamic.StructureOperation.findId.s0") +
            "（自己的结构用 id；公共结构用文件夹名，如 public/领地02号）"
        );
    }
    /** Plain {start,end} corners (no dimid) -> a real Area3 in the target dimension. */
    private static areaOf(
        a: { start: { x: number; y: number; z: number }; end: { x: number; y: number; z: number } },
        dimid: number
    ): Area3 {
        return Area3.fromArea3D(
            new Area3(
                new Pos3(a.start.x, a.start.y, a.start.z, dimid as any),
                new Pos3(a.end.x, a.end.y, a.end.z, dimid as any)
            )
        );
    }

    public static checkTargetStruct(
        area: Area3,
        pos: Pos3,
        caPlayer: CAPlayer
    ) {
        area = Area3.fromArea3D(area);
        let lens = area.getLens();
        if (pos.y < Constant.SPACE.MIN_HIGHT) {
            throw new Error(
                Tr._(
                    caPlayer.$.langCode,
                    "dynamic.StructureOperation.checkTargetStruct.s1"
                ) + Constant.SPACE.MIN_HIGHT
            );
        } else if (pos.y + lens[1] > Constant.SPACE.MAX_HIGHT) {
            throw new Error(
                Tr._(
                    caPlayer.$.langCode,
                    "dynamic.StructureOperation.checkTargetStruct.s2",
                    lens[1],
                    pos.y,
                    pos.y + lens[1],
                    Constant.SPACE.MAX_HIGHT
                )
            );
        }
    }

    public static save(
        output: CommandOutput,
        caPlayer: CAPlayer,
        res: { Name: any }
    ) {
        const player = caPlayer.$;
        let name = res.Name;
        let data = StructureService.getData(player.xuid);
        if (StrFactory.isLegalName(name)) {
            name = `save_${system.getTimeStr()}`;
        }
        AreaOperation.hasArea(caPlayer); //throw
        let maxNum = Config.get(Config.GLOBAL, "maxSaveStructure");
        if (Object.keys(data.saveList).length >= maxNum) {
            throw new Error(
                Tr._(
                    player.langCode,
                    "dynamic.StructureOperation.save.s3",
                    maxNum
                )
            );
        }
        let st = new Structure(caPlayer.settings.area, name);
        StructureService.save(
            caPlayer,
            st,
            0,
            1,
            (structid: string, data: Data) => {
                data.saveList[`${structid}`] = st;
                Config.set(Config.STRUCTURES, `private.${player.xuid}`, data);
                tell(online(player.xuid), StrFactory.cmdSuccess(
                    Tr._(
                        player.langCode,
                        "dynamic.StructureOperation.save.s4",
                        Area3.fromArea3D(data.saveList[structid].area),
                        structid,
                        name
                    )
                ), MsgType.RAW);
            }
        ).catch((e) => {
            tell(online(player.xuid), StrFactory.cmdErr(describeError(e)), MsgType.RAW);
        });
    }

    public static load(
        output: CommandOutput,
        caPlayer: CAPlayer,
        res: {
            id: string;
            IntPos: IntPos;
            Mirror: string;
            Degrees: string;
            IncludeEntities: boolean;
            IncludeBlocks: boolean;
            Waterlogged: boolean;
            Integrity: number;
            Seed: string;
        }
    ) {
        const player = caPlayer.$;
        let r = StructureOperation.findId(res.id, caPlayer);
        let st = Config.get(
            Config.STRUCTURES,
            `private.${r.xuid}.saveList.${r.structid}`
        );
        let structure = new Structure(st.area, st.name, st.isPublic);
        let pos: Pos3;
        if (res.IntPos == null) {
            pos = Pos3.fromPos(player.pos).calibration().floor();
        } else {
            pos = Pos3.fromPos(res.IntPos);
        }
        // /ca load rotates/mirrors inside the placement pipeline, so the undo snapshot has to
        // be the ROTATED destination box; moving the source box onto pos covers the wrong
        // cells as soon as Degrees is not 0.
        const degrees = (parseFloat(String(res.Degrees ?? "0")) || 0) as Degrees;
        const mirror = String(res.Mirror ?? "none").toLowerCase() as MirrorMode;
        const box = rotatedUnion({ st: structure }, pos, degrees, mirror);
        if (box == null) {
            throw new Error("无法计算粘贴目标区域");
        }
        StructureOperation.checkTargetStruct(
            new Area3(
                new Pos3(box.x1, box.y1, box.z1, pos.dimid),
                new Pos3(box.x2, box.y2, box.z2, pos.dimid)
            ),
            pos,
            caPlayer
        );
        let targetArea = new Area3(
            new Pos3(box.x1, box.y1, box.z1, pos.dimid),
            new Pos3(box.x2, box.y2, box.z2, pos.dimid)
        );
        const undoStructs = rotatedTargetAreas({ st: structure }, pos, degrees, mirror).map(
            (a) => new Structure(StructureOperation.areaOf(a, pos.dimid))
        );
        StructureOperation.setDimid({ st: structure }, pos.dimid); // set dimid to structure
        //save dist area
        StructureService.undoSave(caPlayer, undoStructs, () => {
            StructureService.load(
                caPlayer,
                structure,
                r.structid,
                pos,
                0,
                1,
                res.Mirror,
                res.Degrees,
                res.IncludeEntities,
                res.IncludeBlocks,
                res.Waterlogged,
                res.Integrity,
                res.Seed,
                () => {
                    tell(online(player.xuid), StrFactory.cmdSuccess(
                        Tr._(
                            player.langCode,
                            "dynamic.StructureOperation.load.s5",
                            st.name,
                            pos,
                            r.structid,
                            targetArea
                        )
                    ), MsgType.RAW);
                }
            ).catch((e) => {
                tell(online(player.xuid), StrFactory.cmdErr(describeError(e)), MsgType.RAW);
            });
        });
    }

    public static delete(
        output: CommandOutput,
        caPlayer: CAPlayer,
        res: { id: any }
    ) {
        const player = caPlayer.$;
        let data = StructureService.getData(player.xuid);
        let saveList = data.saveList;
        let sid = res.id;
        let st = saveList[sid];
        if (st == null) {
            throw new Error(
                Tr._(player.langCode, "dynamic.StructureOperation.delete.s6")
            );
        }
        // StructureService.delete() removes the file slices AND the public entry.
        StructureService.delete(caPlayer, sid, st);
        let tempSt = saveList[sid];
        //删除 savelist
        delete saveList[sid];
        Config.set(
            Config.STRUCTURES,
            `private.${player.xuid}.saveList`,
            saveList
        );
        output.success(
            StrFactory.cmdSuccess(
                Tr._(
                    player.langCode,
                    "dynamic.StructureOperation.delete.s7",
                    sid,
                    tempSt.name
                )
            )
        );
    }

    public static list(output: CommandOutput, caPlayer: CAPlayer) {
        const player = caPlayer.$;
        let prArr = StructureService.getPrivateArr(caPlayer);
        let puArr = StructureService.getPublicArr();
        let arr: Array<any> = [
            Format.White +
                Format.Bold +
                Tr._(player.langCode, "dynamic.StructureOperation.list.s8"),
            new Array(),
            Format.White +
                Format.Bold +
                Tr._(player.langCode, "dynamic.StructureOperation.list.s9"),
            new Array(),
        ];
        puArr.forEach((v: any) => {
            arr[1].push(
                Format.Bold + Format.MinecoinGold + v.id + Format.Clear,
                [
                    Format.Gray +
                        Tr._(
                            player.langCode,
                            "dynamic.StructureOperation.list.s10",
                            v.name
                        ),
                    Format.Gray +
                        Tr._(
                            player.langCode,
                            "dynamic.StructureOperation.list.s11",
                            data.xuid2name(v.author)
                        ),
                ]
            );
        });
        prArr.forEach((v: any) => {
            arr[3].push(
                Format.Bold + Format.MinecoinGold + v.id + Format.Clear,
                [
                    Format.Gray +
                        Tr._(
                            player.langCode,
                            "dynamic.StructureOperation.list.s10",
                            v.name
                        ),
                ]
            );
        });
        player.sendText(
            StrFactory.cmdMsg(
                Tr._(player.langCode, "dynamic.StructureOperation.list.s13")
            ) + StrFactory.catalog(arr)
        );
    }

    public static public(
        output: CommandOutput,
        caPlayer: CAPlayer,
        res: { id: string }
    ) {
        const player = caPlayer.$;
        let r = StructureOperation.findId(res.id, caPlayer);
        if (r.kind === "scanned") {
            throw new Error("公共结构是只读的：请在 data/nbt/public 目录里改名或删除");
        }
        if (r.xuid != player.xuid) {
            throw new Error(
                Tr._(player.langCode, "dynamic.StructureOperation.public.s14")
            );
        }
        let st: Structure = Config.get(
            Config.STRUCTURES,
            `private.${r.xuid}.saveList.${r.structid}`
        );
        if (!st.isPublic) {
            let arr = Config.get(Config.STRUCTURES, `public.${r.xuid}`);
            if (arr == null) {
                arr = [];
            }
            arr.push(r.structid);
            Config.set(Config.STRUCTURES, `public.${r.xuid}`, arr);
            Config.set(
                Config.STRUCTURES,
                `private.${r.xuid}.saveList.${r.structid}.isPublic`,
                true
            );
        }
        output.success(
            StrFactory.cmdSuccess(
                Tr._(
                    player.langCode,
                    "dynamic.StructureOperation.public.s15",
                    st.name,
                    r.structid
                )
            )
        );
    }

    public static private(
        output: CommandOutput,
        caPlayer: CAPlayer,
        res: { id: string }
    ) {
        const player = caPlayer.$;
        let r = StructureOperation.findId(res.id, caPlayer);
        if (r.kind === "scanned") {
            throw new Error("公共结构是只读的：请在 data/nbt/public 目录里改名或删除");
        }
        if (r.xuid != player.xuid) {
            throw new Error(
                Tr._(player.langCode, "dynamic.StructureOperation.public.s14")
            );
        }
        let st = Config.get(
            Config.STRUCTURES,
            `private.${r.xuid}.saveList.${r.structid}`
        ); // get structure
        if (st.isPublic) {
            let arr: string[] = Config.get(
                Config.STRUCTURES,
                `public.${r.xuid}`
            );
            arr.splice(arr.indexOf(r.structid), 1);
            arr = arr.filter((e) => e != null);
            if (arr.length == 0) {
                Config.del(Config.STRUCTURES, `public.${r.xuid}`);
            } else {
                Config.set(Config.STRUCTURES, `public.${r.xuid}`, arr);
            }
            Config.set(
                Config.STRUCTURES,
                `private.${r.xuid}.saveList.${r.structid}.isPublic`,
                false
            );
        }
        output.success(
            StrFactory.cmdSuccess(
                Tr._(
                    player.langCode,
                    "dynamic.StructureOperation.private.s17",
                    st.name,
                    r.structid
                )
            )
        );
    }

    public static undo(output: CommandOutput, caPlayer: CAPlayer) {
        const player = caPlayer.$;
        let undoList = StructureService.getData(player.xuid).undoList;
        if (undoList.length <= 0) {
            throw new Error(
                Tr._(player.langCode, "dynamic.StructureOperation.undo.s18")
            );
        }
        let complex = undoList.pop();
        let structArr: Array<Structure> = [];
        Object.keys(complex).forEach((sid) => {
            let area = Area3.fromArea3D(complex[sid].area);
            structArr.push(new Structure(area, "system_save"));
        });
        StructureService.redoPush(caPlayer, structArr, () => {
            StructureService.undoPop(caPlayer, () => {
                player.sendText(
                    StrFactory.cmdSuccess(
                        Tr._(
                            player.langCode,
                            "dynamic.StructureOperation.undo.s23"
                        )
                    )
                );
            });
        });
    }

    public static redo(output: CommandOutput, caPlayer: CAPlayer) {
        const player = caPlayer.$;
        let redoList = StructureService.getData(player.xuid).redoList;
        if (redoList.length <= 0) {
            throw new Error(
                Tr._(player.langCode, "dynamic.StructureOperation.redo.s19")
            );
        }
        let complex = redoList.pop();
        let structArr: Array<Structure> = [];
        Object.keys(complex).forEach((sid) => {
            let area = Area3.fromArea3D(complex[sid].area);
            structArr.push(new Structure(area, "system_save"));
        });
        StructureService.undoPush(caPlayer, structArr, () => {
            StructureService.redoPop(caPlayer, () => {
                player.sendText(
                    StrFactory.cmdSuccess(
                        Tr._(
                            player.langCode,
                            "dynamic.StructureOperation.redo.s24"
                        )
                    )
                );
            });
        });
    }

    public static copy(output: CommandOutput, caPlayer: CAPlayer) {
        const player = caPlayer.$;
        AreaOperation.hasArea(caPlayer); //throw
        const data = StructureService.getData(player.xuid);
        const lastComplex = data.copy;

        //delete last record
        let dellast = false;
        if (Object.keys(lastComplex).length > 0) {
            dellast = true;
        }

        const area = Area3.fromArea3D(caPlayer.settings.area);
        const structure = new Structure(area);
        
        //copy
        StructureService.copy(
            caPlayer,
            [structure],
            dellast,
            lastComplex,
            (complex: Complex) => {
                //save record
                Config.set(
                    Config.STRUCTURES,
                    `private.${player.xuid}.copy`,
                    complex
                );
                player.sendText(
                    StrFactory.cmdSuccess(
                        Tr._(
                            player.langCode,
                            "dynamic.StructureOperation.copy.s20",
                            area
                        )
                    )
                );
            }
        );
    }

    public static paste(
        output: CommandOutput,
        caPlayer: CAPlayer,
        res: { IntPos: Pos }
    ) {
        const player = caPlayer.$;
        // data's type is any, not Complex. it not has functions
        let data = StructureService.getData(player.xuid) as Data;
        let keys = Object.keys(data.copy);
        if (keys.length == 0) {
            output.error(
                Tr._(player.langCode, "dynamic.StructureOperation.paste.s21")
            );
            return;
        }
        let pos: Pos3;
        if (res.IntPos != null) {
            pos = Pos3.fromPos(res.IntPos);
        } else {
            pos = Pos3.fromPos(player.pos).calibration().floor();
        }

        keys.forEach((sid) => {
            StructureOperation.checkTargetStruct(
                data.copy[sid].area,
                pos,
                caPlayer
            );
        });
        StructureOperation.setDimid(data.copy, pos.dimid); // set dimid to data.copy
        StructureService.undoSave(
            caPlayer,
            StructureService.getTargetStructs(data.copy, pos),
            () => {
                StructureService.paste(caPlayer, pos, data, () => {
                    tell(online(player.xuid), StrFactory.cmdSuccess(
                        Tr._(
                            player.langCode,
                            "dynamic.StructureOperation.paste.s22",
                            pos.floor()
                        )
                    ), MsgType.RAW);
                }).catch((e) => {
                    tell(online(player.xuid), StrFactory.cmdErr(describeError(e)), MsgType.RAW);
                });
            }
        );
    }

    /**
     * Paste the clipboard with an explicit rotation / mirror.
     *
     * Same pipeline as {@link paste}, but the destination snapshot must cover the ROTATED
     * footprint, otherwise undo would restore the wrong blocks.
     */
    public static pasteTransformed(
        output: CommandOutput,
        caPlayer: CAPlayer,
        pos: Pos3,
        mirror: MirrorMode,
        degrees: Degrees,
        pivot: PivotMode = "inplace"
    ) {
        const player = caPlayer.$;
        const data = StructureService.getData(player.xuid) as Data;
        const keys = Object.keys(data.copy);
        if (keys.length === 0) {
            output.error(Tr._(player.langCode, "dynamic.StructureOperation.paste.s21"));
            return;
        }

        // The snapshot must cover exactly the cells the paste writes. rotatedTargetAreas()
        // derives them from the clipboard-relative transform - the same one
        // StructureService.load() places the slices with - so undo and preview agree.
        const areas = rotatedTargetAreas(data.copy, pos, degrees, mirror, pivot);
        const targets = areas.map((a) => new Structure(StructureOperation.areaOf(a, pos.dimid)));

        // Bounds check on the DESTINATION box: the old loop fed the source's absolute
        // coordinates through checkTargetStruct, which says nothing about the paste.
        for (const target of targets) {
            StructureOperation.checkTargetStruct(target.area, pos, caPlayer);
        }

        StructureOperation.setDimid(data.copy, pos.dimid);
        StructureService.undoSave(
            caPlayer,
            targets,
            () => {
                StructureService.paste(caPlayer, pos, data, () => {
                    tell(
                        online(player.xuid),
                        StrFactory.cmdSuccess(
                            Tr._(player.langCode, "dynamic.StructureOperation.paste.s22", pos.floor())
                        ),
                        MsgType.RAW
                    );
                }, mirror, degreesName(degrees), pivot).catch((e) => {
                    tell(online(player.xuid), StrFactory.cmdErr(describeError(e)), MsgType.RAW);
                });
            }
        );
    }

    public static getUndoSize(xuid: string) {
        return StructureService.getData(xuid).undoList.length;
    }

    public static getRedoSize(xuid: string) {
        return StructureService.getData(xuid).redoList.length;
    }

    public static getSaveList(mod: number, caPlayer: CAPlayer): any[] {
        if (mod == 0) {
            return StructureService.getPrivateArr(caPlayer);
        } else {
            return StructureService.getPublicArr();
        }
    }

    public static canPaste(xuid: string) {
        return Object.keys(StructureService.getData(xuid).copy).length > 0;
    }
}
