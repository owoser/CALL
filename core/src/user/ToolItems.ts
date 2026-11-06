import Config from "../common/Config";
import CAPlayer from "../user/CAPlayer";
import { MsgType, tell } from "../util/Msg";
import StrFactory from "../util/StrFactory";
import { AddonInstaller } from "../addon/AddonInstaller";

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
                item.setDisplayName(spec.name);
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

    public static list(output: any): void {
        const lines: string[] = [];
        for (const spec of TOOL_SPECS) {
            lines.push("  " + spec.name + " §8(" + spec.id + ")");
            for (const lore of spec.lore) lines.push("    " + lore);
        }
        output.success("内置工具：" + lines.join("\n"));
    }
}

export default ToolItems;
