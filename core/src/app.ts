import Activity from "./Activity";
import Config from "./common/Config";
import Paths from "./common/Paths";
import Players from "./user/Players";
import AreaDisplayerService from "./structure/AreaDisplayerService";
import EnableOperation from "./user/EnableOperation";
import { ToolOperation } from "./user/ToolOperation";
import { PluginLoader } from "./plugin/PluginLoader";
import { Compare } from "./temp/Common";
import { Pos } from "./temp/Pos";
import { ToolType } from "./temp/Tool";
import StrFactory from "./util/StrFactory";
import Tr from "./util/Translator";
import CACommand from "./CACommand";
import { MsgType, tell } from "./util/Msg";
import { every, describeError, safeCall, stopEverything } from "./util/Safe";

/**
 * A temp namespace for listener handler
 *
 * should use a base class and use extends
 */
namespace ListenerHandler {
    const Join = "onJoin";
    const Left = "onLeft";
    const UseItemOn = "onUseItemOn";
    const StartDestroyBlock = "onStartDestroyBlock";

    function onJoinHandler(player: Player) {
        safeCall("onJoin", () => {
            if (!Players.hasPermission(player)) return;

            Activity.onCreate(player.xuid);
            const caPlayer = Players.getCAPlayer(player.xuid);
            if (caPlayer == null) return;
            Activity.onStart(caPlayer);
        });
    }

    function onLeftHandler(player: Player) {
        safeCall("onLeft", () => {
            if (player == null) return;
            const caPlayer = Players.getCAPlayer(player.xuid);
            // Even when the player never had permission we must drop the cached state.
            if (caPlayer == null) return;

            Activity.onStop(caPlayer);
            Activity.onDestroy(caPlayer);
        });
    }

    function reportToPlayer(player: Player, e: any) {
        const message = describeError(e);
        try {
            if (Config.get(Config.GLOBAL, "debugMod")) {
                logger.error("[CALL][tool] " + message + "\nstack:" + (e && e.stack ? e.stack : ""));
            }
        } catch {
            // ignore
        }
        tell(player, StrFactory.cmdErr(message), MsgType.TIP);
    }

    function onUseItemOnHandler(
        player: Player,
        item: Item,
        block: Block,
        side: number,
        pos: Pos
    ) {
        if (!Players.hasPermission(player)) return;
        const caPlayer = Players.fetchCAPlayer(player.xuid);
        if (caPlayer == null || !EnableOperation.isEnable(caPlayer)) return;

        safeCall("onUseItemOn", () => {
            try {
                ToolOperation.onClick(ToolType.RIGHT, caPlayer, item, block, pos);
            } catch (e) {
                reportToPlayer(player, e);
            }
        });
    }

    function onStartDestroyBlockHandler(player: Player, block: Block) {
        if (!Players.hasPermission(player)) return;
        const caPlayer = Players.fetchCAPlayer(player.xuid);
        if (caPlayer == null || !EnableOperation.isEnable(caPlayer)) return;

        safeCall("onStartDestroyBlock", () => {
            try {
                ToolOperation.onClick(
                    ToolType.LEFT,
                    caPlayer,
                    player.getHand(),
                    block,
                    block.pos
                );
            } catch (e) {
                reportToPlayer(player, e);
            }
        });
    }

    export function init() {
        mc.listen(Join, (player: Player) => onJoinHandler(player));
        mc.listen(Left, (player: Player) => onLeftHandler(player));

        // anti-shake: onUseItemOn fires several times for one click on some clients
        const clickMap = new Map<string, boolean>();
        mc.listen(UseItemOn, (player: Player, item: Item, block: Block, side: number, pos: any) => {
            safeCall("onUseItemOn.gate", () => {
                if (!player) return;
                if (clickMap.get(player.xuid)) return;
                clickMap.set(player.xuid, true);
                setTimeout(() => clickMap.set(player.xuid, false), 200);
                onUseItemOnHandler(player, item, block, side, pos);
            });
        });

        mc.listen(StartDestroyBlock, (player: Player, block: Block) =>
            onStartDestroyBlockHandler(player, block)
        );

        mc.listen(Left, (player: Player) => {
            safeCall("onLeft.cleanup", () => {
                if (player) clickMap.delete(player.xuid);
            });
        });
    }
}

/**
 * A temp namespace for other function
 */
namespace Other {
    export function displayLogo(show: boolean) {
        if (!show) return;
        logger.info("     _____          _      _      ");
        logger.info("    / ____|   /\\   | |    | |     ");
        logger.info("   | |       /  \\  | |    | |     ");
        logger.info("   | |      / /\\ \\ | |    | |     ");
        logger.info("   | |____ / ____ \\| |____| |____ ");
        logger.info("    \\_____/_/    \\_\\______|______|");
        logger.info("       ======= " + Config.PLUGIN_VERSION.toString() + " =======");
        logger.info("");
    }

    /**
     * The area-selection HUD tick.
     *
     * 1.x ran one 300ms interval that walked every cached CAPlayer - including players
     * who had logged out, whose cached Player handle then threw. It now runs at the
     * configurable `areaTextTipInterval` (default 1s) and only looks at online players.
     */
    export function setClock() {
        const interval = Math.max(
            250,
            Number(Config.get(Config.GLOBAL, "areaTextTipInterval", 1000)) || 1000
        );
        every("clock.areaTextTip", interval, () => {
            for (const [, caPlayer] of Players.dataMap) {
                if (!caPlayer || !caPlayer.settings || !caPlayer.settings.areaTextShow) continue;
                AreaDisplayerService.areaTextTip(caPlayer);
            }
        });
    }

    export function checkConfig() {
        const check = Config.get(Config.CHECK, "configs");
        if (check == null) {
            throw new Error(
                Tr._c("console.Config.check.notFind", Paths.toPosix(Paths.join("config", "check.json")))
            );
        }
        Object.keys(check).forEach((k) => {
            const spec = check[k];
            const data = Config.get(Config.GLOBAL, k);
            if (data == null)
                throw new Error(Tr._c("console.Config.check.notFind", k));
            if (spec.type != "enum" && typeof data != spec.type)
                throw new Error(Tr._c("console.Config.check.type", k, spec.type));
            switch (spec.type) {
                case "number":
                    if (data < spec.min)
                        throw new Error(Tr._c("console.Config.check.less", k, String(spec.min)));
                    if (data > spec.max)
                        throw new Error(Tr._c("console.Config.check.greater", k, String(spec.max)));
                    break;
                case "enum": {
                    let has = false;
                    (spec.values ?? []).forEach((v: any) => {
                        if (v == data) has = true;
                    });
                    if (!has)
                        throw new Error(Tr._c("console.Config.check.enum", k, String(spec.values)));
                    break;
                }
            }
        });
    }

    /**
     * Compatibility gate. Never fatal: CALL still tries to run on an unexpected
     * version, it just says so loudly in the console.
     */
    export function checkVersion() {
        // ll.requireVersion() is a stub in modern LSE (it always returns true), so the
        // real check has to read the versions out of the script engine itself.
        const lse = Config.LSE_VERSION;
        if (lse.compare(Config.LSE_MINVERSION) == Compare.LESSER) {
            logger.warn(
                "[CALL] LegacyScriptEngine " + lse.toString() +
                " is older than the supported minimum " + Config.LSE_MINVERSION.toString() +
                " - some APIs may behave differently."
            );
        }
        const server = Config.SERVER_VERSION;
        if (server.compare(Config.MINVERSION) == Compare.LESSER) {
            logger.warn(
                "[CALL] BDS " + server.toString() +
                " is older than the supported minimum " + Config.MINVERSION.toString() + "."
            );
        }
    }
}

function init(): boolean {
    try {
        Paths.ensureDirs();

        Other.checkVersion();

        Other.checkConfig(); //check config
        if (!Config.get(Config.GLOBAL, "enable")) {
            logger.warn("[CALL] disabled by config (enable = false)");
            return false;
        }
        //set default settings
        Config.set(
            Config.PLAYERS_SETTINGS,
            "default",
            Config.get(Config.GLOBAL, "default")
        );

        Activity.onServerCreate();

        ListenerHandler.init(); //init listener
        CACommand.register(); //register command
        logger.info("[CALL] " + Config.PLUGIN_VERSION.toString() + " ready (root: " + Paths.toPosix(Paths.ROOT) + ")");
    } catch (e) {
        logger.error("[CALL] init failed: " + describeError(e) + "\nstack:" + (e && e.stack ? e.stack : ""));
        return false;
    }
    return true;
}

function loadPlugins() {
    safeCall("PluginLoader", () => {
        const loader = new PluginLoader();
        loader.loadPlugins();
    });
}

export default function main() {
    if (!Config.get(Config.GLOBAL, "enable")) return;
    if (!init()) return;

    Other.setClock();
    Other.displayLogo(Config.get(Config.GLOBAL, "displayLogo"));
    loadPlugins();

    // Make sure hot-unload (ll reload CALL) does not leave timers behind.
    try {
        (ll as any).onUnload(() => {
            safeCall("onUnload", () => {
                stopEverything();
                AreaDisplayerService.releaseAll();
                Players.dataMap.clear();
            });
        });
    } catch (e) {
        logger.warn("[CALL] ll.onUnload unavailable: " + describeError(e));
    }
}
