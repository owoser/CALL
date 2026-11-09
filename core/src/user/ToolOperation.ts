import Config from "../common/Config";
import Players from "./Players";
import CAPlayer from "./CAPlayer";
import { Pos3 } from "../common/Pos3";
import { ToolType } from "../temp/Tool";
import StrFactory from "../util/StrFactory";
import * as acorn from "acorn";
import * as escodegen from "escodegen";
import * as estraverse from "estraverse";
import Tr from "../util/Translator";
import BlockType from "../common/BlockType";
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

        const data: ToolVariable = {
            pos: Pos3.fromPos(block.pos).floor(),
            posf: Pos3.fromPos(posFloat),
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

        // 1) the exact floor block, when the engine can answer
        let block: any = null;
        try {
            block = player.getBlockStandingOn();
        } catch {
            block = null;
        }

        // 2) one below the feet cell (standing on a block, or hovering just above one)
        if (block == null) {
            try {
                block = mc.getBlock(x, y - 1, z, dimid as 0 | 1 | 2);
            } catch {
                block = null;
            }
        }

        // 3) whatever the player is looking at (useful while flying over nothing)
        if (block == null) {
            try {
                block = player.getBlockFromViewVector(false, false, 64, false);
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

        ToolOperation.onClick(wanted, caPlayer, hand, block as any, block.pos as any);
    }
    public static onClick(type: ToolType, caPlayer: CAPlayer, item: Item, block: Block, posFloat: FloatPos) {
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