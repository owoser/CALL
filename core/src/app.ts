import Activity from "./Activity";
import Config from "./common/Config";
import Paths from "./common/Paths";
import BuildStamp from "./common/BuildStamp";
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
import { AddonInstaller } from "./addon/AddonInstaller";
import PreviewOperation from "./structure/PreviewOperation";
import AreaOperation from "./structure/AreaOperation";
import PreviewScene from "./structure/PreviewScene";
import StructureStore from "./structure/StructureStore";
import StructureService from "./structure/StructureService";
import Wireframe from "./holo/Wireframe";
import Holo from "./holo/Holo";
import ItemDisplay from "./holo/ItemDisplay";
import { ToolItems } from "./user/ToolItems";
import SwingWatcher from "./user/SwingWatcher";
import * as HoloCompat from "./holo/HoloCompat";
import { every as safeEvery } from "./util/Safe";

import { MsgType, tell } from "./util/Msg";
import { every, describeError, logFailure, safeCall, stopEverything } from "./util/Safe";
import * as Chunks from "./game/Chunks";

/**
 * A temp namespace for listener handler
 *
 * should use a base class and use extends
 */
namespace ListenerHandler {
    const Join = "onJoin";
    const Left = "onLeft";
    const UseItemOn = "onUseItemOn";
const UseItem = "onUseItem";
    const StartDestroyBlock = "onStartDestroyBlock";

    function onJoinHandler(player: Player) {
        safeCall("onJoin", () => {
            // Block overrides are remembered by player name, so a preview that was cancelled
            // while the player was offline can only be undone now that they are back.
            PreviewScene.retryCleanup();

            if (!Players.hasPermission(player)) return;

            try {
                StructureStore.rememberPlayer(player.xuid, String(player.realName ?? ""));
            } catch {
                // ignore
            }
            Activity.onCreate(player.xuid);
            const caPlayer = Players.getCAPlayer(player.xuid);
            if (caPlayer == null) return;
            // The swing counter survives a relog; take its current value as the baseline so
            // yesterday's clicks do not fire the moment they walk in.
            try {
                SwingWatcher.track(caPlayer);
            } catch {
                // ignore
            }
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
            try {
                SwingWatcher.forget(caPlayer.xuid);
            } catch {
                // ignore
            }
        });
    }

    function reportToPlayer(player: Player, e: any) {
        const message = describeError(e);
        try {
            if (Config.get(Config.GLOBAL, "debugMod")) {
                logger.error("[tool] " + message + "\nstack:" + (e && e.stack ? e.stack : ""));
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
                SwingWatcher.noteHandled(caPlayer);
                // The bound commands only get coordinates, so the clicked face has to ride on
                // the player (the adjust wand nudges along it).
                caPlayer.lastClickSide = Number(side);
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
                SwingWatcher.noteBlockLeft(caPlayer);
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

    /**
     * Poll the swing counters while anyone holds a tool.
     *
     * Only players with a CALL tool in hand are polled, the interval is configurable and the
     * call is a native counter read - no packets, no per-tick work on an idle server.
     */
    function startSwingTicker() {
        try {
            HoloCompat.warnOnce();
        } catch {
            // ignore
        }
        const rawMs = Number(Config.get(Config.GLOBAL, "toolSwingPollMs", 200)) || 200;
        const ms = Math.max(100, Math.min(1000, rawMs));
        // The watcher needs the interval to know how far back a block click can still belong
        // to the swing it is about to judge.
        SwingWatcher.setPollInterval(ms);

        safeEvery("toolSwingPoll", ms, () => {
            if (Config.get(Config.GLOBAL, "toolAirClick", true) === false) return;
            if (!SwingWatcher.available()) return;
            let players: Player[] = [];
            try {
                players = mc.getOnlinePlayers();
            } catch {
                return;
            }
            for (const player of players) {
                try {
                    const caPlayer = Players.getCAPlayer(player.xuid);
                    if (caPlayer == null || !EnableOperation.isEnable(caPlayer)) continue;
                    const hand = player.getHand();
                    if (hand == null || !ToolItems.isTool(String(hand.type))) continue;
                    SwingWatcher.poll(caPlayer, (cp) => {
                        ToolOperation.onAirClick("left", cp);
                    });
                } catch {
                    // one bad player must not stop the loop
                }
            }
        });
    }

    /**
     * Keep the live wireframes alive.
     *
     * Every shape carries a client-side lifetime (wireframeTtlSeconds) because the library's
     * remove packet is ignored by clients; re-arming them periodically is what keeps the
     * selection and the preview on screen while everything else expires by itself.
     */
    function startWireTicker() {
        const ttl = Number(Config.get(Config.GLOBAL, "wireframeTtlSeconds", 0)) || 0;
        // 0 = the destroy path is used (works); a lifetime only exists when the operator opts in.
        if (ttl <= 0) return;
        const ms = Math.max(1000, Math.floor(Math.min(120, ttl) * 500));
        safeEvery("wireRefresh", ms, () => {
            try {
                Wireframe.refresh();
            } catch {
                // keep the ticker alive
            }
        });
    }

    export function init() {
        StructureService.migrateStore();
        mc.listen(Join, (player: Player) => onJoinHandler(player));
        mc.listen(Left, (player: Player) => onLeftHandler(player));

        // A selection spans two clicks, so a dimension change in between leaves one corner in each
        // world. That is a stale selection, not an error: clear it, drop the wireframe and close any
        // preview that belongs to the dimension the player is leaving (its fake blocks live there).
        try {
            mc.listen("onChangeDim", (player: Player, dimId: number) => {
                safeCall("onChangeDim", () => {
                    if (player == null) return;
                    const caPlayer = Players.getCAPlayer(player.xuid);
                    if (caPlayer == null) return;
                    const hadSelection = caPlayer.hasSetArea === true ||
                        caPlayer.settings?.area?.start?.dimid != null;
                    AreaOperation.dropSelection(caPlayer);
                    if (hadSelection) {
                        tell(player, StrFactory.cmdWarn("已切换维度，选区已清除"), MsgType.TIP);
                    }
                    try {
                        PreviewOperation.cancelFor(caPlayer.xuid);
                    } catch {
                        // the preview teardown is best-effort here
                    }
                    logger.info("[dim] " + String(player.realName ?? player.xuid) + " -> " + String(dimId));
                });
            });
        } catch {
            // an older LSE without onChangeDim: the tolerant hasSetArea() still covers the stale case
        }

        // anti-shake: onUseItemOn fires several times for one click on some clients
        const clickMap = new Map<string, boolean>();
        // When a click lands on a block BOTH events fire; this remembers the block click so
        // the air handler can ignore it.
        const lastBlockClick = new Map<string, number>();
        mc.listen(UseItemOn, (player: Player, item: Item, block: Block, side: number, pos: any) => {
            safeCall("onUseItemOn.gate", () => {
                if (!player) return;
                lastBlockClick.set(player.xuid, Date.now());
                if (clickMap.get(player.xuid)) return;
                clickMap.set(player.xuid, true);
                setTimeout(() => clickMap.set(player.xuid, false), 200);
                onUseItemOnHandler(player, item, block, side, pos);
            });
        });

        // Right-clicking AIR: onUseItemOn never fires there, so the menu / copy wand used to
        // need a block under the crosshair. onUseItem does fire, so route it through the same
        // click pipeline when no block click just happened.
        mc.listen(UseItem, (player: Player, item: Item) => {
            safeCall("onUseItem", () => {
                if (player == null || item == null) return;
                if (!Players.hasPermission(player)) return;
                if (!ToolItems.isTool(String(item.type))) return;
                const caPlayer = Players.fetchCAPlayer(player.xuid);
                if (caPlayer == null || !EnableOperation.isEnable(caPlayer)) return;
                SwingWatcher.noteHandled(caPlayer);
                const last = lastBlockClick.get(player.xuid) ?? 0;
                if (Date.now() - last < 250) return;   // already handled as a block click
                if (clickMap.get(player.xuid)) return;
                clickMap.set(player.xuid, true);
                setTimeout(() => clickMap.set(player.xuid, false), 200);
                ToolOperation.onAirClick("right", caPlayer, item);
            });
        });

        mc.listen(StartDestroyBlock, (player: Player, block: Block) =>
            onStartDestroyBlockHandler(player, block)
        );

        // Left-click detection (see SwingWatcher): HologramLib counts client swings, we turn a
        // swing that was not followed by a block/entity click into "clicked air".
        // Dropping (Q) and picking up also swing the arm, and the swing was read as "left click on
        // air", which fired whatever tool the player was holding. Both are ordinary inventory
        // actions: claim the swing so the ticker does not dispatch it.
        for (const eventName of ["onDropItem", "onTakeItem"]) {
            try {
                mc.listen(eventName as any, (player: Player) => {
                    safeCall(eventName, () => {
                        if (player == null) return;
                        const caPlayer = Players.getCAPlayer(player.xuid);
                        if (caPlayer != null) SwingWatcher.noteHandled(caPlayer);
                    });
                });
            } catch {
                // older LSE without the event: the ticker just sees the extra swing
            }
        }

        mc.listen("onAttackBlock", (player: Player) => {
            safeCall("onAttackBlock.note", () => {
                const caPlayer = player == null ? null : Players.getCAPlayer(player.xuid);
                if (caPlayer != null) SwingWatcher.noteBlockLeft(caPlayer);
            });
        });
        mc.listen("onAttackEntity", (player: Player) => {
            safeCall("onAttackEntity.note", () => {
                const caPlayer = player == null ? null : Players.getCAPlayer(player.xuid);
                if (caPlayer != null) SwingWatcher.noteBlockLeft(caPlayer);
            });
        });

        mc.listen(Left, (player: Player) => {
            safeCall("onLeft.cleanup", () => {
                if (player) {
                    clickMap.delete(player.xuid);
                    PreviewOperation.cancelFor(player.xuid);
                    Wireframe.hide("area:" + player.xuid);
                }
            });
        });

        // Safety net for the tool items: legacy onStartDestroyBlock cannot be cancelled, so
        // the block break is stopped here. can_destroy_in_creative=false on the item already
        // covers creative; this covers everything else and also stops block placement.
        mc.listen("onDestroyBlock", (player: Player) => {
            try {
                const hand = player.getHand();
                if (hand != null && ToolItems.isTool(String(hand.type))) return false;
            } catch {
                // ignore
            }
            return true;
        });
        startSwingTicker();
        startWireTicker();

        mc.listen("onPlaceBlock", (player: Player) => {
            try {
                const hand = player.getHand();
                if (hand != null && ToolItems.isTool(String(hand.type))) return false;
            } catch {
                // ignore
            }
            return true;
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
                Tr._c("console.Config.check.notFind", Paths.toPosix(Paths.join("assets", "check.json")))
            );
        }
        const repairs: string[] = [];
        const put = (key: string, value: any, why: string) => {
            try {
                Config.set(Config.GLOBAL, key, value);
            } catch {
                // file may be read only; the in-memory value still gets used
            }
            repairs.push(key + " (" + why + " → " + JSON.stringify(value) + ")");
        };

        Object.keys(check).forEach((k) => {
            const spec = check[k];
            const tpl = Config.templateValue(k);
            const raw = Config.get(Config.GLOBAL, k);

            if (raw == null) {
                if (tpl === undefined) throw new Error(Tr._c("console.Config.check.notFind", k));
                put(k, tpl, "缺失");
                return;
            }

            // Numbers: a numeric string is accepted (older builds wrote 0.414 as a string).
            // Out of range is CLAMPED with a warning instead of disabling the plugin - a
            // typo in one number must not turn into "CALL will not load".
            if (spec.type === "number") {
                const asNumber = typeof raw === "number"
                    ? raw
                    : (typeof raw === "string" && raw.trim() !== "" && Number.isFinite(Number(raw)) ? Number(raw) : null);
                if (asNumber == null) {
                    if (typeof tpl === "number") {
                        put(k, tpl, "不是数字");
                        return;
                    }
                    throw new Error(Tr._c("console.Config.check.type", k, spec.type));
                }
                let value = asNumber;
                if (typeof spec.min === "number" && value < spec.min) value = spec.min;
                if (typeof spec.max === "number" && value > spec.max) value = spec.max;
                if (typeof raw !== "number" || value !== raw) put(k, value, "越界/类型");
                return;
            }

            if (spec.type === "enum") {
                const values: any[] = Array.isArray(spec.values) ? spec.values : [];
                if (!values.includes(raw)) {
                    const fallback = values.includes(tpl) ? tpl : values[0];
                    put(k, fallback, "非法枚举");
                }
                return;
            }

            if (typeof raw !== spec.type) {
                if (typeof tpl === spec.type) {
                    put(k, tpl, "类型错误");
                    return;
                }
                throw new Error(Tr._c("console.Config.check.type", k, spec.type));
            }
        });

        if (repairs.length > 0) {
            const shown = repairs.slice(0, 8).join("; ") + (repairs.length > 8 ? " …" : "");
            logger.warn("configs.json 按校验规则修正 " + repairs.length + " 项: " + shown);
        }
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
            logger.warn("disabled by config (enable = false)");
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
        logger.info("" + Config.PLUGIN_VERSION.toString() + " ready (root: " + Paths.toPosix(Paths.ROOT) + ")");
        // Which build is this? A screenshot without the commit is unattributable, and we already
        // lost a round to "is this the new build or the old one?".
        logger.info("" + BuildStamp.describe());
        // Print the locations: the upstream docs point at a config path that never existed, and
        // since 3.1 the layout is assets/ (read-only) + config/ + data/.
        logger.info("config: " + Paths.toPosix(Config.GLOBAL_FILE));
        logger.info("data  : " + Paths.toPosix(Paths.DATA));
        if (Paths.LAYOUT_NOTICE != null) logger.warn("" + Paths.LAYOUT_NOTICE);

        // Tool items are addon items, so they only exist after the packs are enabled and the
        // server has been restarted once. Report the real state instead of assuming success.
        // Tell the admin up front whether the wireframe is available: it needs a native mod and
        // is easy to misconfigure, and a silent fallback would look like a CALL bug.
        if (String(Config.get(Config.GLOBAL, "areaDisplayMode", "wireframe")).toLowerCase() === "wireframe") {
            if (Holo.available()) {
                // Functional self-test: resolving the function is not the same as a packet the
                // client accepts. Create + drop one throwaway shape far below the world.
                const probe = Number(Holo.call("shapeCreateBox", 0, -64, 0, 1, -63, 1));
                if (probe > 0) {
                    Holo.call("shapeDestroy", probe);
                    // Same idea for the fake-block path used by the paste preview.
                    const displayProbe = ItemDisplay.create({
                        x: 0.5, y: -63.5, z: 0.5, dim: 0,
                        blockId: "minecraft:stone",
                        scale: String(Config.get(Config.GLOBAL, "previewBlockScale", "0.5")),
                        viewDistance: 16,
                    });
                    if (displayProbe > 0) {
                        ItemDisplay.destroy(displayProbe);
                        logger.info("HologramLib " + Holo.version() + " - wireframe + fake blocks ready");
                    } else {
                        logger.warn("HologramLib " + Holo.version() + " 线框可用，但 itemDisplay 创建失败（探针/校准不可用）");
                    }
                    // The preview itself now uses per-client block overrides.
                    const backend = PreviewScene.backend();
                    if (backend.indexOf("不可用") < 0) {
                        logger.info("预览渲染: " + backend + "（逐客户端方块覆盖，无实体）");
                    } else {
                        logger.warn("预览渲染: " + backend + " —— 方块预览将不可用，只显示线框");
                    }
                } else {
                    logger.warn("HologramLib " + Holo.version() + " 已加载，但画框失败（版本不兼容？）");
                }
            } else {
                logger.warn("wireframe unavailable: " + Holo.reason() + " (fallback: particle outline)");
            }
        }

        if (Config.get(Config.GLOBAL, "toolItems", true) !== false) {
            const addon = AddonInstaller.install();
            if (addon.ok) {
                if (addon.needsRestart) logger.warn("" + addon.message);
                else if (AddonInstaller.itemsAvailable()) {
                    logger.info("tool items ready");
                    // No texturepack-required nag: the pack is delivered without it (the old
                    // warning assumed addon failures were caused by that flag and was wrong).
                } else {
                    // Not "restart the server": the packs may simply load later (ordering
                    // differs between LL builds), and a rejected definition never recovers.
                    // Check again once the world is up instead of guessing here.
                    ToolItems.checkAfterStart();
                }
            } else {
                logger.warn("内置工具物品不可用: " + addon.message);
            }

            // Keep configs.json honest: a tool released after this config was written has no
            // entry in default.items, and reading only that file is what left new wands unbound.
            // The click path also heals the player's own snapshot, so this is for the admin's
            // copy of the file rather than for the click itself.
            ToolItems.healDefaultBindings();
        }
    } catch (e) {
        logger.error("init failed: " + describeError(e) + "\nstack:" + (e && e.stack ? e.stack : ""));
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

    // A previously killed process may have left ticking areas behind, and BDS only allows
    // 10 of them - clean up before anything else can need a slot.
    Chunks.sweepStaleAreas().catch((e) => logFailure("app.sweepStaleAreas", e));

    loadPlugins();

    // Make sure hot-unload (ll reload CALL) does not leave timers behind.
    try {
        (ll as any).onUnload(() => {
            safeCall("onUnload", () => {
                safeCall("onUnload.wireframe", () => {
                    PreviewOperation.cancelAll();
                    PreviewScene.clearAll();
                    Wireframe.hideAll();
                });
                stopEverything();
                AreaDisplayerService.releaseAll();
                // Never leave a call_* ticking area behind: BDS allows only 10 in total.
                Chunks.releaseAll();
                Players.dataMap.clear();
            });
        });
    } catch (e) {
        logger.warn("ll.onUnload unavailable: " + describeError(e));
    }
}
