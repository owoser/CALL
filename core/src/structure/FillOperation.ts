import Config from "../common/Config";
import FillService from "./FillService";
import Area3 from "../common/Area3";
import BlockType from "../common/BlockType";
import CAPlayer from "../user/CAPlayer";
import StrFactory from "../util/StrFactory";
import Tr from "../util/Translator";
import AreaOperation from "./AreaOperation";
import { MsgType, online, tell } from "../util/Msg";

export default class FillOperation {
    public static fill(output: CommandOutput, caPlayer: CAPlayer, res: { block: LLSE_Block; States: string; FillMode: string; }) {
        //检查参数
        AreaOperation.hasArea(caPlayer);
        const blockType = new BlockType(res.block.type, res.States);
        const area = Area3.fromArea3D(caPlayer.settings.area);

        const done = (key: string) => (ok: boolean, warn: number) => {
            const player = online(caPlayer.xuid);
            if (player == null) return;
            if (ok) {
                tell(player, StrFactory.cmdSuccess(Tr._(player.langCode, key, `${area}`)), MsgType.RAW);
            } else {
                tell(player, StrFactory.cmdErr(
                    Tr._(player.langCode, "dynamic.FillManager.soildFill.warn", String(warn))
                ), MsgType.RAW);
            }
        };

        switch (res.FillMode) {
            case undefined:
            case "null":
            case "nu":
                FillService.soildFill(caPlayer, caPlayer.settings.area, blockType, new BlockType("", ""), "", done("dynamic.FillOperation.fill.fill"));
                break;
            case "hollow":
            case "ho":
                FillService.fillOutside(caPlayer, caPlayer.settings.area, blockType, true, done("dynamic.FillOperation.fill.hollow"));
                break;
            case "outline":
            case "ou":
                FillService.fillOutside(caPlayer, caPlayer.settings.area, blockType, false, done("dynamic.FillOperation.fill.outline"));
                break;
            default:
                throw new Error("unknown fill mode: " + res.FillMode);
        }
    }

    public static clear(output: CommandOutput, caPlayer: CAPlayer) {
        AreaOperation.hasArea(caPlayer);
        const area = Area3.fromArea3D(caPlayer.settings.area);
        FillService.soildFill(
            caPlayer,
            caPlayer.settings.area,
            new BlockType("minecraft:air", ""),
            new BlockType("", ""),
            "",
            (ok, warn) => {
                const player = online(caPlayer.xuid);
                if (player == null) return;
                if (ok) {
                    tell(player, StrFactory.cmdSuccess(
                        Tr._(player.langCode, "dynamic.FillOperation.fill.clear", `${area}`)
                    ), MsgType.RAW);
                } else {
                    tell(player, StrFactory.cmdErr(
                        Tr._(player.langCode, "dynamic.FillManager.soildFill.warn", String(warn))
                    ), MsgType.RAW);
                }
            }
        );
    }

    public static replace(output: CommandOutput, caPlayer: CAPlayer, res: { states2: string; block: LLSE_Block; block2: LLSE_Block; states: string; }) {
        AreaOperation.hasArea(caPlayer);
        const blockType1 = new BlockType(res.block.type, res.states);
        const blockType2 = new BlockType(res.block2.type, res.states2);
        const area = Area3.fromArea3D(caPlayer.settings.area);
        FillService.soildFill(caPlayer, caPlayer.settings.area, blockType1, blockType2, "replace", (ok, warn) => {
            const player = online(caPlayer.xuid);
            if (player == null) return;
            if (ok) {
                tell(player, StrFactory.cmdSuccess(
                    Tr._(player.langCode, "dynamic.FillOperation.fill.replace", `${area}`)
                ), MsgType.RAW);
            } else {
                tell(player, StrFactory.cmdErr(
                    Tr._(player.langCode, "dynamic.FillManager.soildFill.warn", String(warn))
                ), MsgType.RAW);
            }
        });
    }
}
