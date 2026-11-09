import Config from "../common/Config";
import Players from "./Players";
import CAPlayer from "./CAPlayer";
import { Pos3 } from "../common/Pos3";
import { ToolType } from "../temp/Tool";
import StrFactory from "../util/StrFactory";
import { describeError } from "../util/Safe";
import * as acorn from "acorn";
import * as escodegen from "escodegen";
import * as estraverse from "estraverse";
import Tr from "../util/Translator";
import BlockType from "../common/BlockType";
import PreviewOperation from "../structure/PreviewOperation";
import { faceFromView } from "../common/ViewFace";
import { matchBinding } from "./Bindings";
import { ToolItems, TOOL } from "./ToolItems";
import { MsgType, tell } from "../util/Msg";

type ToolVariable = {
    readonly pos: Pos3;
    readonly posf: Pos3;
    readonly block: Block;
    readonly itemA: Item;
    readonly itemB: Item;
    readonly itemArr: Array<Item>;
    readonly me: LLSE_Player;
}

export class ToolOperation {
    public static start(output: CommandOutput, caPlayer: CAPlayer, res: { enum_1: any; enum_2: any; item: Item; cmd: string; describe: string; Name: string; }) {
        switch (res.enum_1) {
            case "list":
            case "li":
                ToolOperation.list(output, caPlayer);
                break;
            case "bind":
            case "bi":
                ToolOperation.bind(output, caPlayer, res.item, res.enum_2, res.cmd, res.describe, res.Name);
                break;
            case "unbind":
            case "un":
                ToolOperation.unbind(output, caPlayer, res.item, res.enum_2, res.Name);
                break;
        }
    }

    private static getItems(caPlayer: CAPlayer, type: ToolType) {
        switch (type) {
            case ToolType.RIGHT:
                return caPlayer.settings.items.onUseItemOn
            case ToolType.LEFT:
                return caPlayer.settings.items.onStartDestroyBlock
        }
    }

    /*** private */
    private static checkName(name: string, caPlayer: CAPlayer) {
        if (name !== "") {
            if (!/^[a-zA-Z0-9_\u4e00-\u9fa5]+$/.test(name)) {
                throw new Error(Tr._(caPlayer.$.langCode, "dynamic.ToolOperation.checkName.s0", name));
            }
        }
    }

    /*** private */
    private static getList(caPlayer: CAPlayer, type: ToolType) {
        let items = ToolOperation.getItems(caPlayer, type);
        let arr: any[] = [];
        let nameArr: any[] = [];
        let tempArr: any[] = [];
        Object.keys(items).forEach(type => {
            arr.push(Tr._(caPlayer.$.langCode, "dynamic.ToolOperation.getList.s1", StrFactory.color(Format.Bold + Format.Gold, type)));
            nameArr = [];
            Object.keys(items[type]).forEach((name, i, a) => {
                nameArr.push(Tr._(caPlayer.$.langCode, "dynamic.ToolOperation.getList.s2", StrFactory.color(Format.Bold + Format.Gold, name), StrFactory.color(Format.Bold + Format.Gold, items[type][name].describe)));
                tempArr = [];
                items[type][name].cmds.forEach((cmd: string) => {
                    tempArr.push(StrFactory.color(Format.MinecoinGold, cmd));
                })
                nameArr.push([Tr._(caPlayer.$.langCode, "dynamic.ToolOperation.list.s10"), tempArr]);
            });
            arr.push(nameArr);
        });
        return arr;
    }

    public static getLinearList(caPlayer: CAPlayer, type: ToolType) {
        let items = ToolOperation.getItems(caPlayer, type);
        let arr: any[] = [];
        Object.keys(items).forEach(type => {
            Object.keys(items[type]).forEach((name, i, a) => {
                arr.push([type, name, items[type][name].describe, items[type][name].cmds]);
            });
        });
        return arr;
    }

    public static restoreDefaults(caPlayer: CAPlayer) {
        caPlayer.settings.items = Config.get(Config.PLAYERS_SETTINGS, "default.items");
        caPlayer.$.sendText(StrFactory.cmdSuccess(Tr._(caPlayer.$.langCode, "dynamic.ToolOperation.restoreDefaults.s3")));
    }

    public static cmdsTranslator(caPlayer: CAPlayer, itemArr: Item[], iA: number, iB: number, cmds: string[], block: Block, posFloat: FloatPos) {
        // customize variable
        try {
            //@ts-ignore
            block["states"] = BlockType.generateFromBlock(block).states;
        } catch {
            // A click on air has no real block behind it; commands that never touch $states
            // (call menu, call copy, ...) must still run.
            //@ts-ignore
            block["states"] = {};
        }

        // `${posf}` is the raw click point, which lies on the FACE plane: clicking the +Z face of
        // the block at z=-43 gives z=-42, so a binding that used `${posf.z}` selected the
        // neighbouring block (the reported "one block off"). Such bindings are migrated to
        // `${pos.…}` by ToolItems.migratePosfBindings(); `${hit}`/`${hitf}` are the same raw point
        // under names that cannot be confused with the clicked block.
        const data: any = {
            pos: Pos3.fromPos(block.pos).floor(),
            posf: Pos3.fromPos(posFloat),
            hit: Pos3.fromPos(posFloat).floor(),
            hitf: Pos3.fromPos(posFloat),
            block,
            itemA: itemArr[iA],
            itemB: itemArr[iB],
            itemArr: itemArr,
            me: caPlayer.$
        }

        const arr: string[] = [];
        cmds.forEach((cmd, i) => {
            const strs = cmd.match(/\$\{.+?\}/g);
            if (strs != null) {
                for (let i = 0; i < strs.length; i++) {
                    // 解析表达式
                    const ast: any = acorn.parse(strs[i].slice(2, -1), { ecmaVersion: 2021 });
                    // 遍历语法树的函数
                    estraverse.replace(ast, {
                        enter(node, parent) {
                            if (node.type === "Identifier" && !(parent.type === "MemberExpression" && parent.property == node)) {
                                node.name = 'data.' + node.name;
                            }
                        }
                    })
                    // 表达式生成指令
                    cmd = cmd.replace(new RegExp(/\$\{.+?\}/), eval('`${' + escodegen.generate(ast).slice(0, -1) + '}`'));//`1 + block.pos.x * 2`
                }
            }

            if (!(cmd === '' || cmd === '/')) {
                arr.push(cmd);
            }
        });
        return arr;
    }

    /** Warn about a tool that has no binding, once per player and item. */
    private static warnedUnbound = new Set<string>();

    private static warnUnbound(caPlayer: CAPlayer, type: string): void {
        const key = caPlayer.xuid + "|" + type;
        if (ToolOperation.warnedUnbound.has(key)) return;
        ToolOperation.warnedUnbound.add(key);
        const player = caPlayer.$;
        if (player == null) return;
        tell(
            player,
            StrFactory.cmdErr("这个工具还没有绑定（" + type + "）：/ca tools give 重新领取，或重进一次服务器"),
            MsgType.RAW
        );
    }

    /** Which tools react to a click that did not land on a block. */
    private static readonly AIR_TOOLS = new Set<string>([
        TOOL.gear,
        TOOL.select,
        TOOL.copy,
        TOOL.paste,
        TOOL.preview,
        TOOL.adjust,
    ]);

    /**
     * The block the player is standing ON (the one under their feet).
     *
     * `player.pos` is one block above the feet level (Pos3.calibration() subtracts that 1), so
     * `floor(pos.y) - 1` is the cell the body occupies and one more down is the floor block the
     * operator wants a click on air to target. `getBlockStandingOn()` answers that directly and
     * is preferred; while flying there is no floor, so fall back to the cell below, then to what
     * the player looks at, then to a stand-in (bindings that never touch $pos/$block still work).
     */
    private static feetBlock(player: any): any {
        // The cell the player's body occupies (feet level), used for every fallback below.
        let x = 0, y = 64, z = 0, dimid = 0;
        try {
            const p = player.pos;
            x = Math.floor(Number(p.x));
            z = Math.floor(Number(p.z));
            y = Math.floor(Number(p.y)) - 1;
            dimid = Number(p.dimid ?? 0);
        } catch {
            // keep the defaults
        }

        // 1) the block the player stands on - "clicking air means the block under my feet",
        //    which is the rule the operator expects (the crosshair is deliberately NOT used:
        //    clicking into the sky would otherwise target whatever happens to be in view).
        let block: any = null;
        try {
            block = player.getBlockStandingOn();
        } catch {
            block = null;
        }

        // 2) the cell below the feet
        if (block == null) {
            try {
                block = mc.getBlock(x, y - 1, z, dimid as 0 | 1 | 2);
            } catch {
                block = null;
            }
        }

        // 3) the cell the body occupies, as the last readable block
        if (block == null) {
            try {
                block = mc.getBlock(x, y, z, dimid as 0 | 1 | 2);
            } catch {
                block = null;
            }
        }
        // 4) a stand-in at the feet cell
        if (block == null) {
            block = { pos: { x, y, z, dimid }, type: "minecraft:air", states: {} };
        }
        return block;
    }
    /**
     * A click that did not land on a block (LSE has no event for one; see SwingWatcher).
     *
     * The target is the block at the player's feet, and the binding that runs is the one for
     * that side - falling back to the other side for tools that only bind one of them (the
     * gear, the copy and the paste wand are right-click only).
     */
    public static onAirClick(side: "left" | "right", caPlayer: CAPlayer, item?: Item) {
        const player = caPlayer?.$;
        if (player == null) return;

        let hand: any = item;
        if (hand == null) {
            try {
                hand = player.getHand();
            } catch {
                hand = null;
            }
        }
        const tool = String(hand?.type ?? "");
        if (!ToolOperation.AIR_TOOLS.has(tool)) return;
        if (ToolOperation.tryPreviewPaste(caPlayer, hand, "air:" + side)) return;

        const block = ToolOperation.feetBlock(player);

        if (tool === TOOL.adjust) {
            // A click on air has no face; the wand moves along the view instead.
            let pitch = 0;
            let facing = 0;
            try {
                const dir: any = player.direction;
                pitch = Number(dir?.pitch) || 0;
                facing = Number(typeof dir?.toFacing === "function" ? dir.toFacing() : 0) || 0;
            } catch {
                pitch = 0;
                facing = 0;
            }
            caPlayer.lastClickSide = faceFromView(pitch, facing);
        }

        let wanted = side === "left" ? ToolType.LEFT : ToolType.RIGHT;
        try {
            const bound = ToolOperation.getItems(caPlayer, wanted) as any;
            if (bound == null || bound[tool] == null) {
                wanted = wanted === ToolType.LEFT ? ToolType.RIGHT : ToolType.LEFT;
            }
        } catch {
            // keep the requested side
        }

        ToolOperation.onClick(wanted, caPlayer, hand, block as any, block.pos as any, "air");
    }
    /** Last tool action per player: one click must never run a tool twice. */
    private static lastAction = new Map<string, number>();
    /** Last BLOCK click per player: the air path must not redo a click that hit a block. */
    private static lastBlockAt = new Map<string, number>();

    /**
     * Paste the preview when the PASTE WAND is used, on either button and either target.
     *
     * The paste wand answers BOTH buttons today (the left side falls back to the right binding),
     * so all four combinations must land here - a click on a block and a click on air, left and
     * right - otherwise one of them would fall through to `call paste <feet>` and paste one block
     * off. Without a preview this returns false and the normal binding runs unchanged.
     */
    private static tryPreviewPaste(caPlayer: CAPlayer, item: any, source: string): boolean {
        if (caPlayer == null) return false;
        if (String(item?.type ?? "") !== TOOL.paste) return false;
        let has = false;
        try {
            has = PreviewOperation.has(caPlayer.xuid);
        } catch {
            has = false;
        }
        if (!has) return false;

        // A block click and an air click can both fire for one physical click: run the paste once.
        const now = Date.now();
        const last = ToolOperation.lastAction.get(caPlayer.xuid) ?? 0;
        if (now - last < 250) return true;
        ToolOperation.lastAction.set(caPlayer.xuid, now);
        ToolOperation.logPath(caPlayer, "preview-paste", item, source);

        const player = caPlayer.$;
        const output = {
            success(message: string) {
                if (player != null) tell(player, StrFactory.cmdSuccess(message), MsgType.TIP);
            },
            error(message: string) {
                if (player != null) tell(player, StrFactory.cmdErr(message), MsgType.TIP);
            },
        };
        try {
            PreviewOperation.confirm(output as any, caPlayer);
        } catch (e) {
            output.error("粘贴失败: " + describeError(e));
        }
        return true;
    }

    /** DEBUG (`debugMod`): which path produced this click, and with which coordinates. */
    private static logClick(caPlayer: CAPlayer, item: any, source: string, block: any, posFloat: any): void {
        try {
            if (Config.get(Config.GLOBAL, "debugMod", false) !== true) return;
            const bp = block?.pos ?? {};
            const fp = posFloat ?? {};
            logger.info("[CALL][tool] path=" + source + " item=" + String(item?.type ?? "?")
                + " block=" + String(bp.x) + "," + String(bp.y) + "," + String(bp.z)
                + " type=" + String(block?.type ?? "?")
                + " posf=" + String(fp.x) + "," + String(fp.y) + "," + String(fp.z)
                + (caPlayer.lastClickSide != null ? " side=" + String(caPlayer.lastClickSide) : ""));
        } catch {
            // diagnostics only
        }
    }

    /** DEBUG (`debugMod`): which path produced this tool action, and where. */
    private static logPath(caPlayer: CAPlayer, path: string, item: any, source: string): void {
        try {
            if (Config.get(Config.GLOBAL, "debugMod", false) !== true) return;
            logger.info("[CALL][tool] path=" + path + " item=" + String(item?.type ?? "?")
                + " source=" + source + " player=" + String(caPlayer.$.realName ?? "?"));
        } catch {
            // diagnostics only
        }
    }

    public static onClick(
        type: ToolType,
        caPlayer: CAPlayer,
        item: Item,
        block: Block,
        posFloat: FloatPos,
        source: "block" | "air" = "block"
    ) {
        const now = Date.now();
        if (source === "air") {
            // One physical click can arrive twice (block event + swing/use event). The block
            // event carries the block the player actually clicked, so when it just happened the
            // air path must stay out of the way - otherwise the tool acts on the feet block and
            // every wand looks "one block off".
            const blockAt = ToolOperation.lastBlockAt.get(caPlayer.xuid) ?? 0;
            if (now - blockAt < 300) return;
        } else {
            ToolOperation.lastBlockAt.set(caPlayer.xuid, now);
        }

        ToolOperation.logClick(caPlayer, item, source, block, posFloat);
        if (ToolOperation.tryPreviewPaste(caPlayer, item, source === "air" ? "air" : "block")) return;
        let items = ToolOperation.getItems(caPlayer, type);
        let name = "";
        try {
            //@ts-ignore
            name = item.getNbt().getTag("tag").getTag("display").getTag("Name")
                .toString()
                .split("\n")[0]
                .trim();
        }
        catch (e) { }
        // Bindings are keyed by the item's custom display name, and "no custom name" is the
        // empty string. Tools shipped with the plugin have no display name, but a renamed tool
        // (or a player who named it themselves) must still find its type binding - otherwise a
        // click silently does nothing.
        let binding = matchBinding<any>(items[item.type], name);

        if (binding == null && ToolItems.isTool(String(item.type))) {
            // A tool that shipped AFTER this settings snapshot (or after this server's
            // configs.json was written) has no entry at all. Merge the shipped bindings right
            // here so the wand works on the next click instead of being a dead item until the
            // player reconnects - and never silently: the report was "点击了无反应，也没有报错".
            if (ToolItems.migrateBindings(caPlayer.settings)) caPlayer.persistSettings();
            items = ToolOperation.getItems(caPlayer, type);
            binding = matchBinding<any>(items[item.type], name);
        }

        if (binding == null) {
            if (ToolItems.isTool(String(item.type))) ToolOperation.warnUnbound(caPlayer, String(item.type));
            return;
        }

        const itemArr = caPlayer.$.getInventory().getAllItems();
        ToolOperation.cmdsTranslator(caPlayer, itemArr, caPlayer.settings.barReplace, caPlayer.settings.barReplaced, binding.cmds, block, posFloat).forEach((cmd) => {
            Players.silenceCmd(caPlayer, cmd);
        });
    }

    public static bind(output: CommandOutput, caPlayer: CAPlayer, item: Item, type: ToolType, cmd: string, describe: string, name: string) {
        if (name == null) {
            name = "";
        }
        else {
            ToolOperation.checkName(name, caPlayer);
        }
        if (item.isBlock) {
            throw new Error(Tr._(caPlayer.$.langCode, "dynamic.ToolOperation.bind.s4"));
        }
        let items = ToolOperation.getItems(caPlayer, type);
        let cmds = cmd.split(";");
        items[item.type] = (items[item.type] == null ? {} : items[item.type]);
        items[item.type][name] = { cmds: cmds, describe: describe };
        if (name !== "") {
            item.setDisplayName(name + "\n" + describe);
        }
        let pos = Pos3.fromPos(caPlayer.$.pos).calibration().add(0, 1, 0);
        mc.spawnItem(item, pos.x, pos.y, pos.z, pos.dimid);
        output.success(StrFactory.cmdSuccess(Tr._(caPlayer.$.langCode, "dynamic.ToolOperation.bind.s5", cmd, item.type, name === "" ? Tr._(caPlayer.$.langCode, "word.noName") : name, describe)));
    }

    public static unbind(output: CommandOutput, caPlayer: CAPlayer, item: Item, type: ToolType, name: string) {
        let items = ToolOperation.getItems(caPlayer, type);
        name = (name == null ? "" : name);
        if (items[item.type] == null || items[item.type][name] == null) {
            throw new Error(Tr._(caPlayer.$.langCode, "dynamic.ToolOperation.unbind.s6", item.type, name === "" ? Tr._(caPlayer.$.langCode, "word.noName") : name));
        }
        delete items[item.type][name];
        if (Object.keys(items[item.type]).length == 0) {
            delete items[item.type];
        }
        output.success(StrFactory.cmdSuccess(Tr._(caPlayer.$.langCode, "dynamic.ToolOperation.unbind.s7", item.type, name === "" ? Tr._(caPlayer.$.langCode, "word.noName") : name)));
    }

    public static list(output: CommandOutput, caPlayer: CAPlayer) {
        output.success(Tr._(caPlayer.$.langCode, "dynamic.ToolOperation.list.s8") + StrFactory.catalog(ToolOperation.getList(caPlayer, ToolType.RIGHT)));
        output.success(Tr._(caPlayer.$.langCode, "dynamic.ToolOperation.list.s9") + StrFactory.catalog(ToolOperation.getList(caPlayer, ToolType.LEFT)));
    }
}