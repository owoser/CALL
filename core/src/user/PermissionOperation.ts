import Activity from "../Activity";
import Config, { PermissionsType } from "../common/Config";
import Players from "./Players";
import CAPlayer from "./CAPlayer";
import StrFactory from "../util/StrFactory";
import Tr from "../util/Translator";

import * as fs from "fs";

export default class PermissionOperation {
    /*** private */
    private static check(name: string) {
        if (Config.get(Config.GLOBAL, "permission") != PermissionsType.CUSTOMIZE) {
            throw new Error(Tr._c("console.PermissionOperation.check.error"));
        }
        if (name == null) {
            throw new Error(Tr._c("console.PermissionOperation.check.error1"));
        }
        name = name.trim();
        if (name === "") {
            throw new Error(Tr._c("console.PermissionOperation.check.error2"));
        }
    }

    public static find(name: string) {
        // userlist.json is created empty on first start, so "list" may be missing entirely
        const list = Config.get(Config.PERMISSIONS, "list");
        if (!Array.isArray(list)) return false;
        return list.includes(name);
    }

    /**
     * warning: this is a bad way to check permission, but simple
     */
    public static findByFile(name: string) {
        // The file is optional: it only exists when the admin maintains a whitelist by hand.
        // Missing or malformed content must not throw inside a permission check.
        let list: string[] = [];
        try {
            const content = fs.readFileSync(Config.PERMISSION_FILE_PATH, { encoding: "utf8" });
            const parsed = JSON.parse(content);
            if (Array.isArray(parsed)) list = parsed.map((v) => String(v));
        } catch {
            return false;
        }
        return list.includes(name);
    }

    public static checkTag(player: LLSE_Player) {
        return player.hasTag("call_permission")
    }

    public static list(output: CommandOutput) {
        output.success(Tr._c("console.PermissionOperation.list.success", Config.get(Config.PERMISSIONS, "list")));
    }

    public static add(name: string, output: CommandOutput) {
        PermissionOperation.check(name);
        if (!PermissionOperation.find(name)) {
            let list = Config.get(Config.PERMISSIONS, "list");
            let player = mc.getPlayer(name);
            list.push(name);
            Config.set(Config.PERMISSIONS, "list", list);
            output.success(Tr._c("console.PermissionOperation.add.success", name, player == null ? Tr._c("word.no") : Tr._c("word.ok")));

            if(player != null) {
                Players.setCAPlayer(player.xuid, new CAPlayer(player.xuid));
                player.sendText(StrFactory.cmdSuccess(Tr._(player.langCode, "dynamic.PermissionOperation.add.success")));
            }
        }
        else {
            throw new Error(Tr._c("console.PermissionOperation.add.fail", `${name}`));
        }
    }

    public static ban(name: string, output: CommandOutput) {
        PermissionOperation.check(name);
        if (PermissionOperation.find(name)) {
            let list = Config.get(Config.PERMISSIONS, "list");
            let set = new Set(list);
            let player = mc.getPlayer(name);
            set.delete(name);
            Config.set(Config.PERMISSIONS, "list", Array.from(set));
            output.success(Tr._c("console.PermissionOperation.ban.success", name, player == null ? Tr._c("word.no") : Tr._c("word.ok")));

            if(player != null) {
                Activity.onDestroy(Players.getCAPlayer(player.xuid));
                player.sendText(StrFactory.cmdErr(Tr._(player.langCode, "dynamic.PermissionOperation.ban.success")));
            }
        }
        else {
            throw new Error(Tr._c("console.PermissionOperation.ban.fail", `${name}`));
        }
    }
}