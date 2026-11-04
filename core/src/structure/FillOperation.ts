import FillService, { FillOutcome } from "./FillService";
import Area3 from "../common/Area3";
import BlockType from "../common/BlockType";
import CAPlayer from "../user/CAPlayer";
import StrFactory from "../util/StrFactory";
import Tr from "../util/Translator";
import AreaOperation from "./AreaOperation";
import { MsgType, online, tell } from "../util/Msg";

/**
 * Renders the result of a fill operation.
 *
 * The message is decided by what ACTUALLY happened: 3.0.1 printed the success text even
 * when every slab had failed, and 3.0.2 printed one identical toast per slab.
 */
function report(caPlayer: CAPlayer, area: Area3, successKey: string, outcome: FillOutcome): void {
    const player = online(caPlayer.xuid);
    if (player == null) return;
    const lang = player.langCode;

    if (outcome.ok) {
        tell(player, StrFactory.cmdSuccess(Tr._(lang, successKey, `${area}`)), MsgType.RAW);
        return;
    }

    if (outcome.invalidBlock) {
        tell(player, StrFactory.cmdErr(Tr._(lang, "dynamic.FillManager.reason.invalidBlock")), MsgType.RAW);
        return;
    }
    if (outcome.notLoaded > 0) {
        tell(player, StrFactory.cmdErr(Tr._(lang, "dynamic.FillManager.reason.notLoaded")), MsgType.RAW);
        return;
    }
    tell(player, StrFactory.cmdWarn(
        Tr._(lang, "dynamic.FillManager.soildFill.warn", String(outcome.failed))
    ), MsgType.RAW);
}

export default class FillOperation {
    public static fill(output: CommandOutput, caPlayer: CAPlayer, res: { block: LLSE_Block; States: string; FillMode: string; }) {
        AreaOperation.hasArea(caPlayer);
        const blockType = new BlockType(res.block.type, res.States);
        const area = Area3.fromArea3D(caPlayer.settings.area);
        const done = (key: string) => (outcome: FillOutcome) => report(caPlayer, area, key, outcome);

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
            (outcome) => report(caPlayer, area, "dynamic.FillOperation.fill.clear", outcome)
        );
    }

    public static replace(output: CommandOutput, caPlayer: CAPlayer, res: { states2: string; block: LLSE_Block; block2: LLSE_Block; states: string; }) {
        AreaOperation.hasArea(caPlayer);
        const blockType1 = new BlockType(res.block.type, res.states);
        const blockType2 = new BlockType(res.block2.type, res.states2);
        const area = Area3.fromArea3D(caPlayer.settings.area);
        FillService.soildFill(caPlayer, caPlayer.settings.area, blockType1, blockType2, "replace",
            (outcome) => report(caPlayer, area, "dynamic.FillOperation.fill.replace", outcome));
    }
}
