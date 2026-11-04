import Config from "../common/Config";
import Area3 from "../common/Area3";
import { Pos3 } from "../common/Pos3";
import { Structure } from "../common/Structure";
import { PluginLoader } from "./PluginLoader";
import StrFactory from "../util/StrFactory";
import StructureService from "../structure/StructureService";
import CAPlayer from "../user/CAPlayer";
import Tr from "../util/Translator";
import StructureNBT from "../io/StructureNBT";
import { MsgType, online, tell } from "../util/Msg";
import { describeError, safeCall } from "../util/Safe";
import { coveredArea, placeNbtAsync } from "../structure/StructurePlacement";

export interface BlockData {
    x: number;
    y: number;
    z: number;
    block_palette: string;
    block_position_data: string;
}

export type Blocks = Array<BlockData>;

export interface TransledInfo {
    name: string;
    description: string;
}

export class ShapeService {
    public static debugMod = Config.get(Config.GLOBAL, "debugMod");

    public static getIdList() {
        return PluginLoader.idList;
    }

    /**
     * Generate a shape from a third-party shape plugin.
     *
     * Fixed in 2.0.0: the undo snapshot used `pos .. pos + size` (one block too large on
     * the far side) while the placement itself was off by one in the other direction,
     * so `/ca undo` after `/ca shape` restored the wrong region. Placement and snapshot
     * now both come from StructurePlacement.
     */
    public static run(
        caPlayer: CAPlayer,
        pluginId: string,
        index: number,
        pos: Pos3,
        jsonStr: string
    ) {
        const player = online(caPlayer?.xuid);
        const lang = player ? player.langCode : "en_US";

        const plugin = PluginLoader.pluginsMap.get(pluginId);
        if (plugin == null) {
            tell(player, StrFactory.cmdErr(Tr._(lang, "dynamic.ShapeManager.run.noPlugin", pluginId)), MsgType.RAW);
            return;
        }

        let param: any;
        try {
            param = jsonStr ? JSON.parse(jsonStr) : {};
        } catch (e) {
            tell(player, StrFactory.cmdErr(describeError(e)), MsgType.RAW);
            return;
        }

        let nbt: StructureNBT;
        try {
            nbt = plugin.onCmd(player ?? caPlayer.$, index, pos, param);
        } catch (e) {
            tell(player, StrFactory.cmdErr(describeError(e)), MsgType.RAW);
            if (ShapeService.debugMod) {
                logger.error("[CALL][ShapeService] " + pluginId + " failed:\n" + (e && e.stack ? e.stack : describeError(e)));
            }
            return;
        }
        if (nbt == null || nbt.size == null) {
            tell(player, StrFactory.cmdErr(Tr._(lang, "dynamic.ShapeManager.run.fail")), MsgType.RAW);
            return;
        }

        const size: [number, number, number] = [nbt.size[0] || 1, nbt.size[1] || 1, nbt.size[2] || 1];
        const structure = new Structure(coveredArea(pos, size));

        tell(player, StrFactory.cmdTip(Tr._(lang, "dynamic.ShapeManager.run.creating")), MsgType.RAW);

        StructureService.undoSave(caPlayer, [structure], () => {
            // mc.setStructure() crashes the server on this platform, so shapes are
            // written block by block (async, yields between batches).
            placeNbtAsync(nbt, pos)
                .then((written) => {
                    if (written > 0) {
                        tell(player, StrFactory.cmdSuccess(Tr._(lang, "dynamic.ShapeManager.run.success")), MsgType.RAW);
                    } else {
                        tell(player, StrFactory.cmdErr(Tr._(lang, "dynamic.ShapeManager.run.fail")), MsgType.RAW);
                    }
                })
                .catch((e) => {
                    tell(player, StrFactory.cmdErr(describeError(e)), MsgType.RAW);
                });
        });
    }
}
