import { Areas } from "../temp/Data";
import CAPlayer from "../user/CAPlayer";
import StructureService from "./StructureService";
import Constant from "../temp/Constant";
import Config from "../common/Config";
import Area3 from "../common/Area3";
import { Structure } from "../common/Structure";
import { Pos3 } from "../common/Pos3";
import StrFactory from "../util/StrFactory";
import BlockType from "../common/BlockType";
import Tr from "../util/Translator";
import { logFailure, sleep } from "../util/Safe";
import { fillCommand, runNow } from "../game/Cmd";
import { MsgType, online, tell } from "../util/Msg";

/**
 * Fill / clear / replace / hollow / outline.
 *
 * Rewritten in 3.0 because the 2.0 path was the one that dropped players:
 *  - it passed boss-bar colour `11` (out of range 0..7) for every fill, which made the
 *    CLIENT disconnect while the server stayed up;
 *  - it teleported the player to the region centre, then ran the fills with
 *    `/execute at "<name>"`, then teleported back;
 *  - `BlockType.toString()` emitted trailing empty arguments ("minecraft:stone " plus
 *    an empty mode/replace pair), producing commands the parser rejects.
 *
 * Chunks are now guaranteed loaded by StructureService.traversal (ticking area), the
 * player is never moved, and every /fill goes through Cmd.fillCommand's validation.
 */
export default class FillService {
    private static readonly SLAB_HEIGHT = Constant.FILL.MAX_HIGHT; // keeps 64x64x8 <= 32768

    /**
     * Walk every slice of `areas` and run `cmdCallback` for each horizontal slab.
     */
    public static async ergod(
        caPlayer: CAPlayer,
        areas: Areas,
        index: number,
        total: number,
        cmdCallback: (yBottom: number, yTop: number, area: Area3) => boolean,
        overCallback: (warn: number) => void
    ): Promise<void> {
        const fillWaitTime = Number(Config.get(Config.GLOBAL, "fillWaitTime", 0)) || 0;
        const lang = caPlayer.$?.langCode ?? "en_US";
        let warn = 0;

        await StructureService.traversal(
            caPlayer,
            areas,
            Tr._(lang, "dynamic.FillManager.ergod.fill", `${index + 1}/${total}`),
            async (x: number, z: number) => {
                const area = areas[x][z];
                for (let y = area.start.y; y <= area.end.y; y += FillService.SLAB_HEIGHT) {
                    const yTop = Math.min(y + FillService.SLAB_HEIGHT - 1, area.end.y);
                    let ok = false;
                    try {
                        ok = cmdCallback(y, yTop, area);
                    } catch {
                        ok = false;
                    }
                    if (!ok) warn++;
                    if (fillWaitTime > 0) await sleep(fillWaitTime);
                }
                return true;
            },
            () => overCallback(warn),
            () => { }
        );
    }

    /** Fill the whole region with one block (mode "" = replace everything). */
    public static soildFill(
        caPlayer: CAPlayer,
        targetArea: Area3,
        blockTypeA: BlockType,
        blockTypeB: BlockType,
        mod: string,
        overCallback: () => void
    ): void {
        const structure = new Structure(Area3.fromArea3D(targetArea));
        StructureService.undoSave(caPlayer, [structure], () => {
            FillService.ergod(
                caPlayer,
                structure.getAreas(),
                0,
                1,
                (yBottom, yTop, area) => {
                    const from = new Pos3(area.start.x, yBottom, area.start.z, area.start.dimid);
                    const to = new Pos3(area.end.x, yTop, area.end.z, area.end.dimid);
                    const cmd = fillCommand(
                        from,
                        to,
                        blockTypeA.type,
                        blockTypeA.states,
                        mod,
                        blockTypeB.type,
                        blockTypeB.states
                    );
                    if (cmd == null) {
                        FillService.reportInvalid(caPlayer, blockTypeA);
                        return false;
                    }
                    return FillService.exec(caPlayer, cmd);
                },
                (warn) => {
                    if (warn > 0) {
                        tell(online(caPlayer.xuid), StrFactory.cmdWarn(
                            Tr._(caPlayer.$?.langCode ?? "en_US", "dynamic.FillManager.soildFill.warn", String(warn))
                        ), MsgType.RAW);
                    }
                    overCallback();
                }
            ).catch((e) => {
                logFailure("FillService.soildFill", e);
                overCallback();
            });
        });
    }

    /**
     * Hollow / outline: fill the six faces, then clear the inside for "hollow".
     */
    public static fillOutside(
        caPlayer: CAPlayer,
        tArea: Area3,
        blockTypeA: BlockType,
        isHollow: boolean,
        overCallback: Function
    ): void {
        const a = Area3.fromArea3D(tArea);
        const s = a.start;
        const e = a.end;

        const faces: Area3[] = [
            new Area3(new Pos3(s.x, s.y, s.z, s.dimid), new Pos3(s.x, e.y, e.z, s.dimid)), // -X
            new Area3(new Pos3(s.x, s.y, s.z, s.dimid), new Pos3(e.x, s.y, e.z, s.dimid)), // -Y
            new Area3(new Pos3(s.x, s.y, s.z, s.dimid), new Pos3(e.x, e.y, s.z, s.dimid)), // -Z
            new Area3(new Pos3(e.x, s.y, s.z, s.dimid), new Pos3(e.x, e.y, e.z, s.dimid)), // +X
            new Area3(new Pos3(s.x, e.y, s.z, s.dimid), new Pos3(e.x, e.y, e.z, s.dimid)), // +Y
            new Area3(new Pos3(s.x, s.y, e.z, s.dimid), new Pos3(e.x, e.y, e.z, s.dimid)), // +Z
        ];

        const structs = faces.map((f) => new Structure(f));
        const lens = a.getLens();
        let interior: Area3 | null = null;
        if (isHollow && lens[0] > 2 && lens[1] > 2 && lens[2] > 2) {
            interior = Area3.fromArea3D(tArea);
            interior.start.add(1, 1, 1);
            interior.end.add(-1, -1, -1);
            structs.push(new Structure(interior));
        }

        StructureService.undoSave(caPlayer, structs, () => {
            FillService.runFaces(caPlayer, structs, interior, blockTypeA, overCallback).catch((e) => {
                logFailure("FillService.fillOutside", e);
                overCallback();
            });
        });
    }

    private static async runFaces(
        caPlayer: CAPlayer,
        structs: Structure[],
        interior: Area3 | null,
        blockTypeA: BlockType,
        overCallback: Function
    ): Promise<void> {
        {
            let warn = 0;
            for (let i = 0; i < structs.length; i++) {
                const isInterior = interior != null && i === structs.length - 1;
                const bt = isInterior ? new BlockType("minecraft:air", "") : blockTypeA;
                await FillService.ergod(
                    caPlayer,
                    structs[i].getAreas(),
                    i,
                    structs.length,
                    (yBottom, yTop, area) => {
                        const from = new Pos3(area.start.x, yBottom, area.start.z, area.start.dimid);
                        const to = new Pos3(area.end.x, yTop, area.end.z, area.end.dimid);
                        const cmd = fillCommand(from, to, bt.type, bt.states);
                        if (cmd == null) return false;
                        return FillService.exec(caPlayer, cmd);
                    },
                    (w) => {
                        warn += w;
                    }
                );
            }
            if (warn > 0) {
                tell(online(caPlayer.xuid), StrFactory.cmdWarn(
                    Tr._(caPlayer.$?.langCode ?? "en_US", "dynamic.FillManager.soildFill.warn", String(warn))
                ), MsgType.RAW);
            }
            overCallback();
        }
    }

    /**
     * Execute one fill command.
     *
     * Runs at CONSOLE level on purpose: every coordinate CALL emits is absolute, so no
     * player origin is needed, and running as the player made the operation depend on
     * the player's vanilla command permission (which failed outright for simulated
     * players and silently for anyone below the fill permission level). CALL's own
     * `Players.hasPermission` gate is what decides whether a player may fill.
     */
    private static exec(caPlayer: CAPlayer, cmd: string): boolean {
        const res = runNow(cmd);
        if (res.ok) return true;
        // BDS reports "0 blocks filled" as a FAILED command. Filling air with air is a
        // perfectly normal outcome (e.g. /ca clear over an empty region), so it must not
        // be counted as an error.
        if (FillService.isNoopResult(res.out)) return true;
        FillService.warnOnce(caPlayer, cmd, res.out);
        return false;
    }

    /** True when the engine merely reported "nothing changed". */
    private static isNoopResult(out: string): boolean {
        const text = String(out ?? "");
        if (text === "") return false;
        return /(^|\s)0\s*(个|blocks?\b)/i.test(text);
    }

    private static warned = new Set<string>();

    private static warnOnce(caPlayer: CAPlayer, cmd: string, out: string): void {
        const key = caPlayer.xuid + "|" + cmd;
        if (FillService.warned.has(key)) return;
        FillService.warned.add(key);
        if (FillService.warned.size > 200) FillService.warned.clear();
        logFailure("FillService.fill", new Error(cmd + " -> " + (out || "rejected")));
        tell(online(caPlayer.xuid), StrFactory.cmdErr("fill failed: " + (out || "command rejected")), MsgType.RAW);
    }

    private static reportInvalid(caPlayer: CAPlayer, blockType: BlockType): void {
        const lang = caPlayer.$?.langCode ?? "en_US";
        tell(online(caPlayer.xuid), StrFactory.cmdErr(
            "invalid block or region: " + (blockType?.toString() || "(empty)")
        ), MsgType.RAW);
    }
}
