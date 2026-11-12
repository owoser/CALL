import Config from "../common/Config";
import Constant from "../temp/Constant";
import Enums from "../temp/Enums";
import AreaDisplayerService from "./AreaDisplayerService";
import Area3 from "../common/Area3";
import { selectionState } from "../common/Selection";
import CAPlayer from "../user/CAPlayer";
import { Pos3 } from "../common/Pos3";
import StrFactory from "../util/StrFactory";
import Players from "../user/Players";
import Tr from "../util/Translator";

export default class AreaOperation {
    /**
     * The block the player stands ON - "select what is under my feet".
     *
     * `player.pos.y` is one block ABOVE the feet cell (the same convention `ToolOperation` uses),
     * so the floor block is `floor(pos.y) - 2`, not `- 1`: `/ca area b` with no coordinates used to
     * land on the cell the player occupies instead of the block beneath it.
     * `getBlockStandingOn()` is preferred because it answers the question directly (and copes with
     * slabs/stairs); the arithmetic is the fallback for when there is no block to stand on.
     */
    private static feetPos(player: any): Pos3 {
        let x = 0, y = 64, z = 0, dimid = 0;
        let feetCell = 64;
        try {
            const p = player.pos;
            x = Math.floor(Number(p.x));
            feetCell = Math.floor(Number(p.y));
            y = feetCell - 2;
            z = Math.floor(Number(p.z));
            dimid = Number(p.dimid ?? 0);
        } catch {
            return new Pos3(x, y, z, dimid as 0 | 1 | 2);
        }

        // Walk down from the cell just below the player and take the first non-air block.
        // Two reasons: `player.pos.y` is the feet cell (so the block under the feet is -1 for a
        // normal stand and -2 when the position already sits on the block), and `getBlockStandingOn`
        // on this build answers the FEET cell (measured: it returned the player's own y), so the
        // world is the only reliable source.
        for (let dy = 1; dy <= 3; dy++) {
            const cy = feetCell - dy;
            try {
                const block = mc.getBlock(x, cy, z, dimid as 0 | 1 | 2);
                const name = String(block?.type ?? "");
                if (block == null) continue;
                if (name === "minecraft:air" || name === "minecraft:cave_air" || name === "minecraft:void_air") continue;
                return new Pos3(x, cy, z, dimid as 0 | 1 | 2);
            } catch {
                // keep walking down
            }
        }

        // Flying over nothing: the cell two below is the best answer we have.
        return new Pos3(x, y, z, dimid as 0 | 1 | 2);
    }
    public static start(output: CommandOutput, caPlayer: CAPlayer, res: any) {
        const player = caPlayer.$;
        // DEBUG (`debugMod`): what the command parser handed us, and what ends up stored. A point
        // that "moves by one" can then be split into parser vs. storage instead of argued about.
        const dbg = (stage: string) => {
            try {
                if (Config.get(Config.GLOBAL, "debugMod", false) !== true) return;
                const rp: any = res?.IntPos ?? {};
                const a: any = caPlayer.settings?.area ?? {};
                logger.info("[DBG][area] " + stage
                    + " enum_1=" + String(res?.enum_1)
                    + " IntPos=" + rp.x + "," + rp.y + "," + rp.z
                    + " stored=" + (a.start?.x ?? "-") + "," + (a.start?.y ?? "-") + "," + (a.start?.z ?? "-")
                    + " -> " + (a.end?.x ?? "-") + "," + (a.end?.y ?? "-") + "," + (a.end?.z ?? "-"));
            } catch {
                // diagnostics only
            }
        };
        let pos: IntPos = res.IntPos;
        let enum_1 = res.enum_1;
        let enum_2 = res.enum_2;
        switch (enum_1) {
            case "start":
            case "st":
            case "a":
                if (pos != null) {
                    AreaOperation.setPosA(caPlayer, Pos3.fromPos(pos));
                }
                else if (enum_2 == "view" || enum_2 == "vi") {
                    let max = Config.get(Config.GLOBAL, "viewMaxDistance");
                    let block = player.getBlockFromViewVector(false, false, max, false);
                    if (block != null) {
                        AreaOperation.setPosA(caPlayer, Pos3.fromPos(block.pos));
                    }
                    else {
                        throw new Error(Tr._(player.langCode, "dynamic.AreaOperation.start.viewError", `${max}`));
                    }
                }
                else {
                    AreaOperation.setPosA(caPlayer, AreaOperation.feetPos(player));
                }
                break;
            case "end":
            case "en":
            case "b":
                if (pos != null) {
                    AreaOperation.setPosB(caPlayer, Pos3.fromPos(pos));
                }
                else if (enum_2 == "view" || enum_2 == "vi") {
                    let max = Config.get(Config.GLOBAL, "viewMaxDistance");
                    let block = player.getBlockFromViewVector(false, false, max, false);
                    if (block != null) {
                        AreaOperation.setPosB(caPlayer, Pos3.fromPos(block.pos));
                    }
                    else {
                        throw new Error(Tr._(player.langCode, "dynamic.AreaOperation.start.viewError", `${max}`));
                    }
                }
                else {
                    AreaOperation.setPosB(caPlayer, AreaOperation.feetPos(player));
                }
                break;
            case "cancel":
            case "cc":
                AreaOperation.clearArea(caPlayer);
                output.success(StrFactory.cmdMsg(Tr._(player.langCode, "dynamic.AreaOperation.start.clear")));
                break;
            case "show":
            case "sh":
                if (enum_2 == null || enum_2 == "on") {
                    caPlayer.settings.displayArea = true;
                    output.success(StrFactory.cmdSuccess(Tr._(player.langCode, "dynamic.AreaOperation.start.showOn")));
                }
                else if (enum_2 == "off" || enum_2 == "of") {
                    caPlayer.settings.displayArea = false;
                    AreaOperation.hideArea(caPlayer);
                    output.success(StrFactory.cmdSuccess(Tr._(player.langCode, "dynamic.AreaOperation.start.showOff")));
                }
                break;
            case "set":
            case "se":
                let pos3d = (pos == null ? AreaOperation.feetPos(player) : Pos3.fromPos(pos));
                if (caPlayer.isSetPosA) {
                    Players.silenceCmd(caPlayer, `call area cancel`);
                    Players.silenceCmd(caPlayer, `call area a ${pos3d.formatStr()}`);
                    caPlayer.isSetPosA = false;
                }
                else {
                    Players.silenceCmd(caPlayer, `call area b ${pos3d.formatStr()}`);
                    caPlayer.isSetPosA = true;
                }
                break;
        }
        dbg("after");
    };

    /**private*/
    private static hasSetArea(caPlayer: CAPlayer) {
        const state = selectionState(caPlayer.settings.area as any);
        if (state === "valid") {
            caPlayer.hasSetArea = true;
            return true;
        }
        if (state === "mixed") {
            // The corners ended up in different dimensions (the player changed dimension between the
            // two clicks). That is a STALE selection, not an error: throwing here used to break both
            // selecting and cancelling (both call this). Drop it so the next click starts clean.
            AreaOperation.dropSelection(caPlayer);
            return false;
        }
        return false;
    }

    /**
     * Remove the selection WITHOUT going through hasSetArea (it can be the thing being repaired).
     *
     * Also clears the wireframe and the "waiting for corner B" flag, so the next click is a fresh A.
     */
    public static dropSelection(caPlayer: CAPlayer): void {
        caPlayer.hasSetArea = false;
        caPlayer.isSetPosA = false;
        try {
            if (caPlayer.displayPos != null) {
                AreaDisplayerService.remove(caPlayer);
                caPlayer.displayPos = null;
            }
        } catch {
            // the displayer is cosmetic
        }
        caPlayer.settings.area = {
            start: { x: null, y: null, z: null, dimid: null },
            end: { x: null, y: null, z: null, dimid: null },
        } as any;
    }

    /***private */
    private static checkPos(pos: Pos3, caPlayer: CAPlayer) {
        if (pos.y < Constant.SPACE.MIN_HIGHT || pos.y > Constant.SPACE.MAX_HIGHT) {
            throw new Error(Tr._(caPlayer.$.langCode, "dynamic.AreaOperation.checkPos.y", `${Constant.SPACE.MIN_HIGHT}`, `${Constant.SPACE.MAX_HIGHT}`))
        }
    }

    /*** private */
    private static setPos(caPlayer: CAPlayer, num: number) {
        const player = caPlayer.$;
        if (AreaOperation.hasSetArea(caPlayer)) {
            let area = Area3.fromArea3D(caPlayer.settings.area);
            //检查area
            // let lens = area.getLens();
            // if (lens[0] > Constant.AREA.MAX_LENGTH || lens[2] > Constant.AREA.MAX_LENGTH) {
            //     throw new Error(Tr._(player.langCode, "dynamic.AreaOperation.setPos.max", `${Constant.AREA.MAX_LENGTH} ${Constant.AREA.MAX_HIGHT} ${Constant.AREA.MAX_LENGTH}`));
            // }
            player.sendText(StrFactory.cmdTip(Tr._(player.langCode, "dynamic.AreaOperation.setPos.setArea", `${caPlayer.settings.area.start}->${caPlayer.settings.area.end}`, area.getLensStr())), Enums.msg.RAW);
            AreaOperation.hideArea(caPlayer);
            AreaOperation.showArea(caPlayer);
        }
        else {
            if (num == 1) {
                player.sendText(StrFactory.cmdTip(Tr._(player.langCode, "dynamic.AreaOperation.setPos.a", `${caPlayer.settings.area.start}`)), Enums.msg.RAW);
            }
            else {
                player.sendText(StrFactory.cmdTip(Tr._(player.langCode, "dynamic.AreaOperation.setPos.b",`${caPlayer.settings.area.end}`)), Enums.msg.RAW);
            }

        }
    }

    public static setPosA(caPlayer: CAPlayer, pos: Pos3) {
        AreaOperation.checkPos(pos, caPlayer);
        caPlayer.settings.area.start = Pos3.fromPos3(pos).floor();
        AreaOperation.setPos(caPlayer, 1);
    }

    public static setPosB(caPlayer: CAPlayer, pos: Pos3) {
        AreaOperation.checkPos(pos, caPlayer);
        caPlayer.settings.area.end = Pos3.fromPos3(pos).floor();
        AreaOperation.setPos(caPlayer, 2);
    }

    public static clearArea(caPlayer: CAPlayer) {
        AreaOperation.hideArea(caPlayer);
        caPlayer.hasSetArea = false;
        caPlayer.settings.area = {
            start: {
                x: null,
                y: null,
                z: null,
                dimid: null
            },
            end: {
                x: null,
                y: null,
                z: null,
                dimid: null
            }
        }
    }

    /**throw Error */
    public static hasArea(caPlayer: CAPlayer) {
        if (caPlayer.hasSetArea == null || !caPlayer.hasSetArea) {
            throw new Error(Tr._(caPlayer.$.langCode, "dynamic.AreaOperation.hasArea.error"));
        }
    }

    public static showArea(caPlayer: CAPlayer) {
        if (!caPlayer.settings.displayArea || caPlayer.displayPos != null) {
            return false;
        }
        if (AreaOperation.hasSetArea(caPlayer)) {
            //结构方块显示
            caPlayer.displayPos = AreaDisplayerService.set(caPlayer.settings.area, caPlayer);
            return true;
        }
        else {
            throw new Error(Tr._(caPlayer.$.langCode, "dynamic.AreaOperation.showArea.noArea"));
        }
    }

    public static hideArea(caPlayer: CAPlayer) {
        if (AreaOperation.hasSetArea(caPlayer)) {
            if (caPlayer.displayPos != null) {
                AreaDisplayerService.remove(caPlayer);
                caPlayer.displayPos = null;
            }
        }
    }

    public static onStart(caPlayer: CAPlayer) {
        try {
            AreaOperation.showArea(caPlayer);
        }
        catch (e) { };
    }

    public static onStop(caPlayer: CAPlayer) {
        try {
            AreaOperation.hideArea(caPlayer);
        }
        catch (e) { };
    };
}

