import Players from "./user/Players";
import StructureService from "./structure/StructureService";
import CAPlayer from "./user/CAPlayer";
import AreaOperation from "./structure/AreaOperation";
import SettingsOperation from "./user/SettingsOperation";
import AreaDisplayerService from "./structure/AreaDisplayerService";
import { logFailure } from "./util/Safe";

export default class Activity {
    public static onServerCreate() {
        SettingsOperation.onServerCreate();
    }

    public static onCreate(xuid: string) {
        Players.createCAPlayer(xuid);
    }

    public static onStart(caPlayer: CAPlayer) {
        AreaOperation.onStart(caPlayer);//Restore selection display
    }

    public static onStop(caPlayer: CAPlayer) {
        AreaOperation.onStop(caPlayer);//clear selection display
    }

    public static onDestroy(caPlayer: CAPlayer) {
        if (caPlayer == null) return;
        // Every per-player timer and world highlight must go with the player, otherwise
        // it keeps running against a handle that no longer exists.
        try {
            caPlayer.stopTimers();
        } catch {
            // ignore
        }
        try {
            AreaDisplayerService.release(caPlayer);
        } catch (e) {
            logFailure("Activity.onDestroy.display", e);
        }
        caPlayer.saveAll();
        Players.dataMap.delete(caPlayer.xuid);
        if (!caPlayer.settings.saveUndo) {
            StructureService.clearUndoList(caPlayer);
            StructureService.clearRedoList(caPlayer);
        }
        if (!caPlayer.settings.saveCopy) {
            StructureService.clearCopy(caPlayer);
        }
    }
}