import Config from "../common/Config";
import CAPlayer from "../user/CAPlayer";
import { MsgType, tell } from "../util/Msg";
import StrFactory from "../util/StrFactory";
import { AddonInstaller, BP_FOLDER, RP_FOLDER } from "../addon/AddonInstaller";
import Paths from "../common/Paths";
import * as fs from "fs";
import * as path from "path";
import { collectEntries, createStoreZip } from "../io/ZipStore";
import { describeError } from "../util/Safe";
import { mergeToolBindings } from "./Bindings";

/**
 * The bundled tool items.
 *
 * The ids come from the addon shipped in assets/addon (a behavior pack defines the items, a
 * resource pack gives them icons and localised names). They are deliberately NOT vanilla
 * items: reusing e.g. minecraft:clock would collide with every other plugin or datapack that
 * repurposes the same item.
 *
 * Default bindings live in configs.json (default.items) and are matched by item id, so the
 * items work through the exact same click pipeline as the old hotkey items - and a player who
 * rebinds something keeps their own binding.
 */

export const TOOL = {
    gear: "call:gear",
    select: "call:wand_select",
    copy: "call:wand_copy",
    paste: "call:wand_paste",
    preview: "call:wand_preview",
    adjust: "call:wand_adjust",
} as const;

export const TOOL_IDS: string[] = Object.values(TOOL);

export interface ToolSpec {
    id: string;
    name: string;
    lore: string[];
}

export const TOOL_SPECS: ToolSpec[] = [
    {
        id: TOOL.gear,
        name: "§e⚙ 建造助手 · 菜单",
        lore: ["§7右键打开 CALL 主菜单", "§8/ca tools 查看全部工具"],
    },
    {
        id: TOOL.select,
        name: "§b选区魔杖",
        lore: ["§7左键 = A 点", "§7右键 = B 点", "§8拿着它不会破坏方块"],
    },
    {
        id: TOOL.copy,
        name: "§a复制魔杖",
        lore: ["§7右键 = 复制当前选区", "§8配合粘贴魔杖使用"],
    },
    {
        id: TOOL.paste,
        name: "§d粘贴魔杖",
        lore: ["§7右键 = 直接粘贴到点击位置"],
    },
    {
        id: TOOL.preview,
        name: "§6预览魔杖",
        lore: ["§7右键 = 设落点 / 再点一次旋转 90°", "§7潜行右键 = 确认粘贴", "§7左键 = 换落点"],
    },
    {
        id: TOOL.adjust,
        name: "§6调整魔杖",
        lore: [
            "§7右键点方块的某个面 = 朝那一面挪 1 格",
            "§7潜行右键 = 反方向挪 1 格",
            "§7左键 = 切换 原地 / 绕落点 旋转",
        ],
    },
];

export class ToolItems {
    /** Are the addon items present in this server process? */
    public static available(): boolean {
        if (Config.get(Config.GLOBAL, "toolItems", true) === false) return false;
        return AddonInstaller.itemsAvailable();
    }

    public static isTool(type: string): boolean {
        return TOOL_IDS.indexOf(type) !== -1;
    }

    /** Build one tool item (null when the addon is not active). */
    public static create(id: string) {
        try {
            const item = mc.newItem(id, 1);
            if (item == null) return null;
            const spec = TOOL_SPECS.find((s) => s.id === id);
            if (spec != null) {
                // Deliberately NO setDisplayName: the click pipeline keys bindings by the
                // item's custom name ("" for none), and the addon already supplies the
                // localised name through its own language file.
                item.setLore(spec.lore);
            }
            return item;
        } catch {
            return null;
        }
    }

    /**
     * Give the full tool set.
     *
     * Creative only: the items are addon items with no recipe, so a survival player must not
     * be able to obtain them (and could not craft them anyway).
     */
    public static give(output: any, caPlayer: CAPlayer): void {
        const player = caPlayer.$;

        if (!ToolItems.available()) {
            output.error(
                "内置工具物品未生效：请确认 configs.json 里 toolItems = true，并重启服务器一次（插件会自动把物品包装到 behavior_packs / resource_packs）"
            );
            return;
        }
        if (player.isCreative === false) {
            output.error("工具物品只能在创造模式领取（无合成表，生存无法获得）");
            return;
        }

        let given = 0;
        for (const spec of TOOL_SPECS) {
            const item = ToolItems.create(spec.id);
            if (item == null) continue;
            player.giveItem(item);
            given++;
        }
        output.success("已发放 " + given + " 个建造工具，右键试用；绑定见 /ca tools list");
        tell(player, StrFactory.cmdSuccess("§a已获得建造工具（" + given + " 件）"), MsgType.TIP);
    }

    /**
     * Export the bundled addon as a .mcaddon the player can import on their own client.
     *
     * Needed because a dedicated server may have `texturepack-required=false`: clients then
     * join without the resource pack and custom items show up with a blank icon (the name is
     * server-side NBT, so it still reads correctly - which makes it look like a CALL bug).
     */
    public static exportAddon(output: any): void {
        try {
            const base = path.join(Paths.ASSETS, "addon");
            const entries = [
                ...collectEntries(path.join(base, BP_FOLDER), BP_FOLDER),
                ...collectEntries(path.join(base, RP_FOLDER), RP_FOLDER),
            ];
            if (entries.length === 0) {
                output.error("找不到内置物品包目录: " + base);
                return;
            }
            fs.mkdirSync(Paths.EXPORT, { recursive: true });
            const target = path.join(Paths.EXPORT, "CALL_Tools.mcaddon");
            fs.writeFileSync(target, createStoreZip(entries));
            output.success(
                "已导出 " + Paths.toPosix(target) + "（" + entries.length + " 个文件）。" +
                "把玩家客户端导入这个 .mcaddon 即可看到工具图标；或者把服务器 server.properties 的 texturepack-required 设为 true"
            );
        } catch (e) {
            output.error("导出失败: " + describeError(e));
        }
    }

    /** Whether the server forces clients to use the world resource pack. */
    public static resourcePackRequired(): boolean | null {
        try {
            const props = fs.readFileSync(path.join(Paths.SERVER_ROOT, "server.properties"), "utf8");
            const m = /^\s*texturepack-required\s*=\s*(\S+)/m.exec(props);
            if (m == null) return null;
            return /^true$/i.test(m[1]);
        } catch {
            return null;
        }
    }

    /**
     * Add the bundled tools' default bindings to a player's settings.
     *
     * Only the ids we ship are touched, and only when the entry is missing, so a player who
     * rebound (or removed) something keeps their choice.
     */
    public static migrateBindings(settings: any): boolean {
        return mergeToolBindings(settings, Config.get(Config.GLOBAL, "default"), TOOL_IDS);
    }

    /** What the click pipeline will actually see for the held item. */
    public static debug(output: any, caPlayer: CAPlayer): void {
        const player = caPlayer.$;
        if (player == null) {
            output.error("需要在线玩家");
            return;
        }
        let type = "?";
        let name = "";
        try {
            const hand = player.getHand();
            type = hand == null ? "(空手)" : String(hand.type);
            //@ts-ignore
            name = hand.getNbt().getTag("tag").getTag("display").getTag("Name").toString().split("\n")[0];
        } catch {
            name = "";
        }

        const lines: string[] = [];
        lines.push("手持物品: " + type);
        lines.push("自定义显示名: " + (name === "" ? "\"\"（空，走类型绑定）" : name));
        for (const [kind, label] of [["onUseItemOn", "右键"], ["onStartDestroyBlock", "左键"]]) {
            const byType = caPlayer.settings?.items?.[kind]?.[type];
            if (byType == null) {
                lines.push(label + "绑定: 无 → 点击不会有反应（/ca tools 重领物品或检查 default.items）");
            } else {
                const key = byType[name] != null ? name : (byType[""] != null ? "" : null);
                lines.push(
                    label + "绑定: " + (key == null
                        ? "有类型条目但没有匹配的命名/空名键"
                        : "命中 [" + (key === "" ? "空名" : key) + "] → " + (byType[key]?.cmds ?? []).join(" ; "))
                );
            }
        }
        lines.push("物品包: " + (ToolItems.available() ? "ready" : "未生效"));
        const required = ToolItems.resourcePackRequired();
        lines.push("texturepack-required: " + (required === true ? "true" : required === false ? "false（客户端可能没有图标）" : "未设置"));
        output.success(lines.join("\n"));
    }

    public static list(output: any): void {
        const required = ToolItems.resourcePackRequired();
        const lines: string[] = [];
        if (required !== true) {
            lines.push(
                "  §e⚠ server.properties 的 texturepack-required = " + (required === false ? "false" : "未设置") +
                "：客户端可能拿不到资源包，工具图标会是空白。改成 true，或用 /ca tools pack 导出给玩家手动安装。"
            );
        }
        for (const spec of TOOL_SPECS) {
            lines.push("  " + spec.name + " §8(" + spec.id + ")");
            for (const lore of spec.lore) lines.push("    " + lore);
        }
        output.success("内置工具：" + lines.join("\n"));
    }
}

export default ToolItems;
