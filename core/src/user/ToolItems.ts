import Config from "../common/Config";
import AreaDisplayerService from "../structure/AreaDisplayerService";
import SwingWatcher from "./SwingWatcher";
import { FakeBlocks } from "../holo/FakeBlocks";
import * as HoloCompat from "../holo/HoloCompat";
import PreviewScene from "../structure/PreviewScene";
import PasteSync from "../holo/PasteSync";
import BuildStamp from "../common/BuildStamp";
import Holo from "../holo/Holo";
import Wireframe from "../holo/Wireframe";
import CAPlayer from "../user/CAPlayer";
import { MsgType, tell } from "../util/Msg";
import StrFactory from "../util/StrFactory";
import { AddonInstaller, BP_FOLDER, PACK_VERSION, RP_FOLDER } from "../addon/AddonInstaller";
import Paths from "../common/Paths";
import * as fs from "fs";
import * as path from "path";
import { collectEntries, createStoreZip } from "../io/ZipStore";
import { describeError } from "../util/Safe";
import { mergeToolBindings } from "./Bindings";
import { migratePosfBindings } from "./BindingMigration";

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
        lore: [
            "§7有预览时：点击 = 粘贴到预览位置（左右键都可以）",
            "§7没有预览时：粘贴到点击位置",
            "§8飞行中也能用，不需要潜行",
        ],
    },
    {
        id: TOOL.preview,
        name: "§6预览魔杖",
        lore: [
            "§7右键 = 设落点 / 再点一次旋转 90°",
            "§7确认粘贴请用【粘贴魔杖】点一下（左右键都行）",
            "§7左键 = 换落点",
            "§7潜行左键 = 取消预览",
            "§8移动端：潜行 + 点击方块 = 取消",
        ],
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
    /**
     * What to check when the items do not exist.
     *
     * The engine silently drops an item definition whose `format_version` is newer than it can
     * handle (BDS 1.26.51 rejects 1.26.60 documents with `out of handled range`), and the pack
     * then loads fine while every item stays missing - which looked like "restart the server".
     */
    public static readonly MISSING_HINT = "内置工具物品未被引擎接受。常见原因：物品 JSON 的 format_version 高于本引擎可处理的版本（内容日志会报 out of handled range），或世界没有启用 CALL Tools 行为包。把 server.properties 的 content-log-console-output-enabled 设为 true 可看到具体原因；/ca tools status 可查看状态。";

    /** One-shot post-start re-check (packs can load after the plugin enable pass). */
    private static startProbeDone = false;

    /** Are the addon items present in this server process? */
    public static available(): boolean {
        if (Config.get(Config.GLOBAL, "toolItems", true) === false) return false;
        return AddonInstaller.itemsAvailable();
    }

    /** Multi-line state for /ca tools status and the startup report. */
    public static diagnose(): string {
        const enabled = Config.get(Config.GLOBAL, "toolItems", true) !== false;
        const addon = AddonInstaller.lastResult;
        const available = ToolItems.available();
        const lines = [
            "toolItems = " + enabled,
            "物品包 = " + (addon == null ? "本次启动未执行安装" : (addon.ok ? addon.message : "失败: " + addon.message)),
            "引擎已注册物品 = " + (available ? "是" : "否"),
            "物品包版本 = " + PACK_VERSION.join("."),
            "texturepack-required = " + (ToolItems.resourcePackRequired() === true ? "true" : (ToolItems.resourcePackRequired() === false ? "false" : "未设置")),
        ];
        if (!available) lines.push(" → " + ToolItems.MISSING_HINT);
        return lines.join("\n");
    }

    /**
     * Report the item state once the world has started.
     *
     * The plugin enable pass runs before (or between) world/pack loading, and the ordering
     * differs between LeviLamina builds - so probing only at enable time produced a false
     * "not ready, restart" warning on 26.51. A definition the engine rejected is permanent,
     * so by the time this fires both answers are final.
     */
    public static checkAfterStart(): void {
        if (ToolItems.startProbeDone) return;
        const report = () => {
            if (ToolItems.startProbeDone) return;
            ToolItems.startProbeDone = true;
            try {
                if (AddonInstaller.itemsAvailable()) logger.info("[CALL] tool items ready");
                else logger.warn("[CALL] " + ToolItems.MISSING_HINT);
            } catch {
                // logger may already be gone during shutdown
            }
        };
        try {
            mc.listen("onServerStarted", () => report());
        } catch {
            // older LSE without that event: the timer below still reports
        }
        setTimeout(report, 5000);
    }

    /**
     * Rewrite `${posf.x}` -> `${pos.x}` in every stored binding (see BindingMigration).
     */
    public static migratePosfBindings(settings: any): number {
        return migratePosfBindings(settings);
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
        const skipped: string[] = [];
        for (const spec of TOOL_SPECS) {
            const item = ToolItems.create(spec.id);
            if (item == null) {
                skipped.push(spec.id);
                continue;
            }
            player.giveItem(item);
            given++;
        }
        output.success("已发放 " + given + " 个建造工具，右键试用；绑定见 /ca tools list");
        if (skipped.length > 0) {
            // A tool that cannot be created is invisible, not broken: say so instead of
            // reporting a smaller number and letting the player wonder.
            output.error(
                "有 " + skipped.length + " 个工具没能生成（" + skipped.join(", ") + "）：物品包可能还没生效。" +
                "确认 configs.json 的 toolItems = true，然后重启服务器（写入世界包列表后还需再重启一次）"
            );
        }
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
        const posfFixed = ToolItems.migratePosfBindings(settings) > 0;
        // The SHIPPED template is the source of truth for our own items: `default.items` in
        // configs.json is written once and never grows, so a tool released later would have
        // no binding to copy no matter how often the player reconnects.
        const merged = mergeToolBindings(settings, { items: Config.toolBindingDefaults() }, TOOL_IDS);
        return merged || posfFixed;
    }

    /**
     * Write any missing bundled-tool binding into configs.json's `default.items`.
     *
     * Purely config hygiene: the click path already heals the player's own settings, but an
     * admin who opens configs.json should see the tools that actually ship. Only missing ids
     * are added - a customised binding is never touched.
     */
    public static healDefaultBindings(): string[] {
        try {
            const defaults = Config.toolBindingDefaults();
            const live = Config.get(Config.GLOBAL, "default.items") ?? {};

            // Old configs bound their wands with `${posf.x}` (the FACE plane of the clicked
            // block), which is why every wand selected the neighbouring block. Rewrite those
            // bindings once; the player copies in `players.*` are migrated on their next click.
            const fixed = migratePosfBindings({ items: live });
            if (fixed > 0) {
                Config.set(Config.GLOBAL, "default.items", live);
                try {
                    logger.warn("[CALL] 已把 " + fixed + " 条使用 ${posf} 的绑定改写为 ${pos}（点击的方块坐标）");
                } catch {
                    // logger may not be ready
                }
            }

            const missing: string[] = [];
            for (const kind of ["onUseItemOn", "onStartDestroyBlock"]) {
                for (const id of TOOL_IDS) {
                    if (defaults?.[kind]?.[id] == null) continue;
                    if (live?.[kind]?.[id] == null) missing.push(id + " (" + kind + ")");
                }
            }
            if (missing.length === 0) return [];

            Config.set(Config.GLOBAL, "default.items", defaults);
            try {
                logger.warn("[CALL] configs.json 补全内置工具绑定: " + missing.join(", "));
            } catch {
                // logger may not be ready
            }
            return missing;
        } catch (e) {
            try {
                logger.warn("[CALL] cannot fill in tool bindings: " + describeError(e));
            } catch {
                // ignore
            }
            return [];
        }
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
        try {
            for (const line of Wireframe.debugReport()) lines.push(line);
        } catch {
            // the report must never break the command
        }
        try {
            lines.push(BuildStamp.describe());
        } catch {
            // diagnostics only
        }
        try {
            for (const line of HoloCompat.probe()) lines.push(line);
        } catch {
            // version probe must never break the report
        }
        try {
            const sync = PasteSync.stats();
            lines.push("粘贴后客户端同步: 推送 " + sync.pushed + " 失败 " + sync.failed +
                " · 在线 " + sync.seen + " 同维度 " + sync.inDim + " 半径内 " + sync.inRange +
                (sync.unsupported ? " · API 不支持 getOnlinePlayers" : ""));
        } catch {
            // diagnostics only
        }
        try {
            lines.push(PreviewScene.diagnostics(caPlayer.xuid));
        } catch {
            // diagnostics only
        }
        try {
            lines.push(PreviewScene.teardownReport());
        } catch {
            // diagnostics only
        }
        try {
            // Block entity payload: the banner/sign case. Whether it carries Patterns/Base decides
            // if the black banner is a data problem or a rendering problem.
            const be = PreviewScene.sampleBlockEntity(caPlayer.xuid);
            if (be != null) {
                const head = "方块实体 " + be.be + " 格 / 旗帜 " + be.banners + " 面 / 带图案 " + be.patterned + " 面";
                if (!be.isBanner) {
                    lines.push("预览实体: " + head + "（结构里没有旗帜，样例是其它方块实体）");
                } else {
                    lines.push("预览实体: " + head + " · 样例 " + be.snbt.slice(0, 160) +
                        (be.patterned > 0 ? " (含 Patterns ✓)" : " (缺 Patterns ✗)"));
                }
            }
        } catch {
            // diagnostics only
        }
        try {
            // Does the library actually READ the states out of the SNBT we generate?
            const sample = PreviewScene.sampleStateSnbt(caPlayer.xuid);
            if (sample != null) {
                const resolveNbt = Holo.bind("blockFakeResolveNbt");
                const resolveStr = Holo.bind("blockFakeResolve");
                const name = (/"name"\s*:\s*"([^"]+)"/.exec(sample) || [])[1] ?? "";
                const withStates = resolveNbt != null ? Number(resolveNbt(sample)) : -1;
                const bare = resolveStr != null && name !== "" ? Number(resolveStr(name)) : -1;
                lines.push("预览样例 SNBT: " + sample.slice(0, 120) +
                    " -> resolveNbt=" + withStates + " 裸名=" + bare +
                    (withStates > 0 && withStates !== bare ? " (状态被接受 ✓)" : " (状态未被接受 ✗)"));
            }
        } catch {
            // diagnostics only
        }
        try {
            for (const line of AreaDisplayerService.describe(caPlayer.xuid)) lines.push(line);
            const area = caPlayer.settings?.area;
            if (area?.start != null && area.start.dimid != null) {
                lines.push("选区: " + area.start.x + "," + area.start.y + "," + area.start.z
                    + " -> " + area.end.x + "," + area.end.y + "," + area.end.z);
            }
        } catch {
            // diagnostics only
        }
        try {
            const ok = FakeBlocks.available();
            const probe = ok ? FakeBlocks.selfTest("0 0 0 minecraft:stone") : null;
            // The library's own counters: 'dropped' means IT threw a packet away (player not
            // resolvable, or an empty sub-chunk body) and 'bad' counts undecodable entries. They are
            // the only authoritative "sent is not received" signal it gives us.
            const st = ok ? FakeBlocks.stats() : null;
            lines.push("假方块批量: " + (ok ? "可用" : "不可用（库版本过旧）")
                + (st != null ? " · 库: 队列=" + st.queue + " 已发=" + st.packets + " 丢包=" + st.dropped + " 坏项=" + st.bad : "")
                + (probe != null ? " · selfTest: " + probe.slice(0, 60) : ""));
        } catch {
            // diagnostics only
        }
        try {
            const s = SwingWatcher.statsOf();
            lines.push("左键空气: 已触发 " + s.dispatched
                + " / 吞掉(右键或放置) " + s.swallowedHandled
                + " / 吞掉(切换物品) " + s.swallowedHand);
        } catch {
            // counters are diagnostic only
        }
        // Informational only: the pack is delivered whether or not the flag is set.
        const required = ToolItems.resourcePackRequired();
        lines.push("texturepack-required: " + (required === true ? "true" : required === false ? "false（不影响资源包下发）" : "未设置（不影响资源包下发）"));
        output.success(lines.join("\n"));
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
