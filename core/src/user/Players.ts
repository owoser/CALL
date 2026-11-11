import Activity from "../Activity";
import CAPlayer from "./CAPlayer";
import { Pos3 } from "../common/Pos3";
import PermissionOperation from "./PermissionOperation";
import { PermissionsType } from "../common/Config";
import StrFactory from "../util/StrFactory";
import Config from "../common/Config";
import { MsgType, tell } from "../util/Msg";
import { describeError, logFailure } from "../util/Safe";
import { runNow } from "../game/Cmd";

export interface SimpleCmdResult {
    success: boolean;
    output: string;
}

export default class Players {
    public static dataMap = new Map<string, CAPlayer>();

    public static hasPermission(player: Player): boolean {
        if (player == null) return false;
        try {
            const survivalActive = Config.get(Config.GLOBAL, "suvivalModeActive", false);
            if (!survivalActive && player.gameMode != 1) return false;

            switch (Config.get(Config.GLOBAL, "permission")) {
                case PermissionsType.ALL:
                    return true;
                case PermissionsType.OP:
                    return player.isOP();
                case PermissionsType.CUSTOMIZE:
                    return PermissionOperation.find(player.realName);
                case PermissionsType.FROM_FILE:
                    return PermissionOperation.findByFile(player.realName);
                case PermissionsType.FROM_TAG:
                    return PermissionOperation.checkTag(player);
                default:
                    return false;
            }
        } catch (e) {
            logFailure("Players.hasPermission", e);
            return false;
        }
    }

    public static createCAPlayer(xuid: string) {
        const caPlayer = new CAPlayer(xuid);
        Players.dataMap.set(xuid, caPlayer);
        return caPlayer;
    }

    public static fetchCAPlayer(xuid: string): CAPlayer | null {
        if (!Players.dataMap.has(xuid)) {
            Players.createCAPlayer(xuid);
        }
        return Players.getCAPlayer(xuid) ?? null;
    }

    public static setCAPlayer(xuid: string, data: CAPlayer) {
        Players.dataMap.set(xuid, data);
    }

    public static getCAPlayer(xuid: string): CAPlayer | undefined {
        return Players.dataMap.get(xuid);
    }

    /** Run a command as the player, silently (no failure output). */
    public static silenceCmd(caPlayer: CAPlayer, cmd: string) {
        Players.cmd(caPlayer, cmd, false);
    }

    /**
     * Run a command in the player's context.
     *
     * 2.0 built `/execute at "<realName>" run <cmd>` from a cached Player handle. Now the
     * command goes through `Player.runcmd`, which needs no name at all - a stale handle
     * simply resolves to "offline" instead of feeding freed memory into a command string.
     *
     * @param isTell report failures back to the player
     */
    public static cmd(caPlayer: CAPlayer, cmd: string, isTell: boolean = true): SimpleCmdResult {
        const player = caPlayer?.$ ?? null;
        const text = String(cmd ?? "").trim().replace(/^\//, "");
        if (player == null) {
            return { success: false, output: "player offline" };
        }
        if (text === "") {
            return { success: false, output: "empty command" };
        }

        try {
            const ok = player.runcmd(text);
            if (!ok && isTell) {
                tell(player, StrFactory.cmdErr("command failed: " + text), MsgType.RAW);
            }
            if (Config.get(Config.GLOBAL, "debugMod", false)) {
                logger.debug("[DBG][cmd] " + text + " -> " + ok);
            }
            if (Config.get(Config.GLOBAL, "outputCmd", false)) {
                logger.info("[cmd] " + text);
            }
            return { success: ok !== false, output: "" };
        } catch (e) {
            logFailure("Players.cmd", e);
            if (isTell) tell(player, StrFactory.cmdErr(describeError(e)), MsgType.RAW);
            return { success: false, output: describeError(e) };
        }
    }

    /** Console-level command (no player context). */
    public static consoleCmd(cmd: string): SimpleCmdResult {
        const res = runNow(cmd);
        return { success: res.ok, output: res.out };
    }
}
