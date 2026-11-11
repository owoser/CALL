import Config from "./common/Config";
import Players from "./user/Players";
import AreaOperation from "./structure/AreaOperation";
import BasicTranslOperation from "./structure/BasicTranslOperation";
import BlockEditerOperation from "./structure/BlockEditerOperation";
import ChunkOperation from "./structure/ChunkOperation";
import EnableOperation from "./user/EnableOperation";
import ExportOperation from "./io/ExportOperation";
import PreviewOperation from "./structure/PreviewOperation";
import PreviewScene from "./structure/PreviewScene";
import { ToolItems } from "./user/ToolItems";
import FillOperation from "./structure/FillOperation";
import HelpOperation from "./user/HelpOperation";
import ImportOperation from "./io/ImportOperation";
import MenuOperation from "./view/MenuOperation";
import PermissionOperation from "./user/PermissionOperation";
import SettingsOperation from "./user/SettingsOperation";
import ShapeOperation from "./plugin/ShapeOperation";
import StructureOperation from "./structure/StructureOperation";
import TextureOperation from "./structure/TextureOperation";
import { ToolOperation } from "./user/ToolOperation";
import { Warn } from "./util/Error";
import { logFailure } from "./util/Safe";
import StrFactory from "./util/StrFactory";
import Tr from "./util/Translator";

/**
 * this a temp class for register command
 * standard command should consist of single command object and callback
 */

/**
 * If you are a beginner in LL plugin development, please do not imitate the structure of this class
 * Please use sub modules to register and callback a sub command separately
 * rather than writing them together
 * 
 * This project is doing this because of laziness
 */
export default class CACommand {
    public static register(): void {
        let cmd = mc.newCommand(
            "call",
            Tr._c("console.app.command.introduction"),
            PermType.Any,
            0x80,
            "ca"
        );
        //public param
        cmd.mandatory("player", ParamType.Player, "", "player_man");
        cmd.mandatory("id", ParamType.String, "id", "id_man");
        cmd.mandatory("states", ParamType.String, "", "states_man");
        cmd.mandatory("index", ParamType.Int, "", "index_man");
        cmd.mandatory("block", ParamType.Block, "", "block_man");
        cmd.mandatory("key", ParamType.String, "", "key_man");
        cmd.mandatory("item", ParamType.Item, "", "item_man");
        cmd.mandatory("intPos", ParamType.Vec3, "", "intPos_man");
        cmd.mandatory("nbt", ParamType.JsonValue, "", "nbt_man");
        cmd.mandatory("xuid", ParamType.String, "", "xuid_man");
        cmd.optional("States", ParamType.String, "", "states_opt");
        cmd.optional("IntPos", ParamType.Vec3, "", "intPos_opt");
        cmd.optional("AxisPos", ParamType.Vec3, "", "axisPos_opt");
        cmd.optional("Name", ParamType.String, "", "name_opt");
        // Numbers (including negatives like -0.25) must be a real numeric parameter: a String
        // parameter makes the vanilla parser treat a leading "-" as an option flag.
        cmd.optional("delta", ParamType.Float, "", "delta_opt");
        cmd.optional("BlockEntity", ParamType.JsonValue, "", "blockEntity_man");

        //menu
        cmd.setEnum("menu", ["menu", "me"]);
        cmd.optional("action", ParamType.Enum, "menu", "menu_opt", 1);
        cmd.optional("option", ParamType.String, "", "option_opt");
        cmd.overload(["menu_opt", "option_opt"]);

        //on-off
        cmd.setEnum("on|off", ["on", "off", "of"]);
        cmd.mandatory("action", ParamType.Enum, "on|off", "on-off_man", 1);
        cmd.overload(["on-off_man"]);

        //refresh
        cmd.setEnum("refresh", ["refresh", "rf"]);
        cmd.mandatory("action", ParamType.Enum, "refresh", "refresh_man", 1);
        cmd.overload(["refresh_man"]);

        //preview (3.2.0)
        // The sub-commands are split by ARGUMENT SHAPE, not by topic. Putting the optional
        // numeric parameter in the same enum as the position-taking ones made the vanilla
        // parser eat the "-3" of "click -3 24 363" as the number and then choke on "24".
        cmd.setEnum("preview", ["preview", "pv"]);
        cmd.setEnum("pv_pos", ["set", "se", "click", "ck", "move", "mv"]);
        cmd.setEnum("pv_plain", [
            "rotate", "rt", "mirror", "mi", "confirm", "ok", "cancel", "cc", "info", "in",
            "nudgeface", "nf", "refresh", "rf", "bar", "br", "bartest", "bt", "barclear", "bc"
        ]);
        cmd.setEnum("pv_num", ["calib", "ca", "probe", "pb", "trim", "tm", "radius", "rd"]);
        cmd.setEnum("pv_mode", ["mode", "mo"]);
        cmd.setEnum("pv_mode_val", ["ghost", "wireframe"]);
        cmd.setEnum("pv_pivot", ["pivot", "pvt"]);
        cmd.setEnum("pv_pivot_val", ["inplace", "anchor"]);
        cmd.setEnum("pv_nudge", ["nudge", "ng"]);
        cmd.mandatory("action", ParamType.Enum, "preview", "preview_man", 1);
        cmd.mandatory("enum_1", ParamType.Enum, "pv_pos", "pv_pos_man", 1);
        cmd.mandatory("enum_1", ParamType.Enum, "pv_plain", "pv_plain_man", 1);
        cmd.mandatory("enum_1", ParamType.Enum, "pv_num", "pv_num_man", 1);
        cmd.mandatory("enum_1", ParamType.Enum, "pv_mode", "pv_mode_man", 1);
        cmd.mandatory("enum_2", ParamType.Enum, "pv_mode_val", "pv_mode_val_man", 1);
        cmd.mandatory("enum_1", ParamType.Enum, "pv_pivot", "pv_pivot_man", 1);
        cmd.optional("enum_2", ParamType.Enum, "pv_pivot_val", "pv_pivot_val_opt", 1);
        cmd.mandatory("enum_1", ParamType.Enum, "pv_nudge", "pv_nudge_man", 1);
        // A relative nudge takes three real numbers: like the other numeric preview arguments
        // they must be Float, or the vanilla parser eats a leading "-" as an option flag.
        cmd.mandatory("dx", ParamType.Float, "", "pv_dx_man");
        cmd.mandatory("dy", ParamType.Float, "", "pv_dy_man");
        cmd.mandatory("dz", ParamType.Float, "", "pv_dz_man");
        cmd.overload(["preview_man", "pv_pos_man"]);
        cmd.overload(["preview_man", "pv_pos_man", "IntPos"]);
        cmd.overload(["preview_man", "pv_plain_man"]);
        cmd.overload(["preview_man", "pv_num_man"]);
        cmd.overload(["preview_man", "pv_num_man", "delta_opt"]);
        cmd.overload(["preview_man", "pv_mode_man", "pv_mode_val_man"]);
        cmd.overload(["preview_man", "pv_mode_man"]);
        cmd.overload(["preview_man", "pv_pivot_man"]);
        cmd.overload(["preview_man", "pv_pivot_man", "pv_pivot_val_opt"]);
        cmd.overload(["preview_man", "pv_nudge_man"]);
        cmd.overload(["preview_man", "pv_nudge_man", "pv_dx_man", "pv_dy_man", "pv_dz_man"]);

        //tools (3.2.0)
        cmd.setEnum("tools", ["tools", "tl"]);
        cmd.setEnum("tools_act", ["give", "gi", "list", "li", "status", "st", "pack", "pk", "debug", "db"]);
        cmd.mandatory("action", ParamType.Enum, "tools", "tools_man", 1);
        cmd.optional("enum_1", ParamType.Enum, "tools_act", "tools_act_opt");
        cmd.overload(["tools_man"]);
        cmd.overload(["tools_man", "tools_act_opt"]);

        //area
        cmd.setEnum("area", ["area", "ar"]);
        cmd.setEnum("se", ["set", "se"]);
        cmd.setEnum("cancel", ["cancel", "cc"])
        cmd.setEnum("start|end|a|b", ["start", "st", "end", "en", "a", "b"]);
        cmd.setEnum("show", ["show", "sh"]);
        cmd.setEnum("view", ["view", "vi"]);
        cmd.mandatory("action", ParamType.Enum, "area", "area_man", 1);
        cmd.mandatory(
            "enum_1",
            ParamType.Enum,
            "start|end|a|b",
            "start-end_man",
            1
        );
        cmd.mandatory("enum_1", ParamType.Enum, "se", "se_man", 1);
        cmd.mandatory("enum_1", ParamType.Enum, "cancel", "cancel_man", 1);
        cmd.mandatory("enum_1", ParamType.Enum, "show", "show_man", 1);
        cmd.mandatory("enum_2", ParamType.Enum, "view", "view_man", 1);
        cmd.optional("enum_2", ParamType.Enum, "on|off", "on-off_opt", 1);
        cmd.overload(["area_man", "start-end_man", "intPos_opt"]);
        cmd.overload(["area_man", "start-end_man", "view_man"]);
        cmd.overload(["area_man", "se_man", "intPos_opt"]);
        cmd.overload(["area_man", "cancel_man"]);
        cmd.overload(["area_man", "show_man", "on-off_opt"]);

        //fill
        cmd.setEnum("fill_enum", ["fill", "fi"]);
        cmd.setEnum("fillMode", [
            "hollow",
            "outline",
            "null",
            "ho",
            "ou",
            "nu",
        ]);
        cmd.mandatory("action", ParamType.Enum, "fill_enum", "fill_man", 1);
        cmd.optional("FillMode", ParamType.Enum, "fillMode", "fillMode_opt", 1);
        cmd.overload(["fill_man", "block_man", "states_opt", "fillMode_opt"]);

        //clear
        cmd.setEnum("clear", ["clear", "cl"]);
        cmd.mandatory("action", ParamType.Enum, "clear", "clear_man", 1);
        cmd.overload(["clear_man"]);

        //replace
        cmd.setEnum("replace", ["replace", "re"]);
        cmd.mandatory("action", ParamType.Enum, "replace", "replace_man", 1);
        cmd.mandatory("block2", ParamType.Block, "", "block2_man");
        cmd.optional("states2", ParamType.String, "", "states2_opt");
        cmd.overload([
            "replace_man",
            "block_man",
            "states_man",
            "block2_man",
            "states2_opt",
        ]);

        //save
        cmd.setEnum("save", ["save", "sa"]);
        cmd.mandatory("action", ParamType.Enum, "save", "save_man", 1);
        cmd.overload(["save_man", "name_opt"]);

        //list
        cmd.setEnum("list", ["list", "li"]);
        cmd.mandatory("action", ParamType.Enum, "list", "list_man", 1);
        cmd.overload(["list_man"]);

        //load
        cmd.setEnum("load", ["load", "lo"]);
        cmd.setEnum("mirror", ["none", "x", "z", "xz"]);
        cmd.setEnum("degrees", [
            "0_degrees",
            "90_degrees",
            "180_degrees",
            "270_degrees",
        ]);
        cmd.mandatory("action", ParamType.Enum, "load", "load_man", 1);
        cmd.optional("Mirror", ParamType.Enum, "mirror", "mirror_opt");
        cmd.optional("Degrees", ParamType.Enum, "degrees", "degrees_opt");
        cmd.optional(
            "IncludeEntities",
            ParamType.Bool,
            "",
            "includeEntities_opt"
        );
        cmd.optional("IncludeBlocks", ParamType.Bool, "", "includeBlocks_opt");
        cmd.optional("Waterlogged", ParamType.Bool, "", "waterlogged_opt");
        cmd.optional("Integrity", ParamType.Float, "", "integrity_opt");
        cmd.optional("Seed", ParamType.String, "", "seed_opt");
        cmd.overload([
            "load_man",
            "id_man",
            "intPos_opt",
            "degrees_opt",
            "mirror_opt",
        ]);

        //delete
        cmd.setEnum("delete", ["delete", "de"]);
        cmd.mandatory("action", ParamType.Enum, "delete", "delete_man", 1);
        cmd.overload(["delete_man", "id_man"]);
        // bare `/ca delete` reaches the handler so it can print the usage instead of the
        // vanilla "unexpected argument" message.
        cmd.overload(["delete_man"]);

        //range
        cmd.setEnum("range", ["public", "pu", "private", "pr"]);
        cmd.mandatory("action", ParamType.Enum, "range", "range_man", 1);
        cmd.overload(["range_man", "id_man"]);
        cmd.overload(["range_man"]);
        // diagnostics: why cannot this public structure load?
        cmd.setEnum("pubcheck", ["publiccheck", "pchk", "publicreload", "prel"]);
        cmd.mandatory("action", ParamType.Enum, "pubcheck", "pubcheck_man", 1);
        cmd.overload(["pubcheck_man"]);
        cmd.setEnum("pubdebug", ["publicdebug", "pdb"]);
        cmd.mandatory("action", ParamType.Enum, "pubdebug", "pubdebug_man", 1);
        cmd.overload(["pubdebug_man", "id_man"]);
        cmd.overload(["range_man", "id_man"]);

        //copy
        cmd.setEnum("copy", ["copy", "co"]);
        cmd.mandatory("action", ParamType.Enum, "copy", "copy_man", 1);
        cmd.overload(["copy_man"]);

        //paste
        cmd.setEnum("paste", ["paste", "pa"]);
        cmd.mandatory("action", ParamType.Enum, "paste", "paste_man", 1);
        cmd.overload(["paste_man", "intPos_opt"]);

        //move
        cmd.setEnum("move", ["move", "mo"]);
        cmd.mandatory("action", ParamType.Enum, "move", "move_man", 1);
        cmd.overload(["move_man", "intPos_opt"]);

        //mirror
        cmd.setEnum("mirror_act", ["mirror", "mi"]);
        cmd.setEnum("mirror_notNull", ["x", "z", "xz"]);
        cmd.mandatory("action", ParamType.Enum, "mirror_act", "mirror_act");
        cmd.mandatory(
            "mirror",
            ParamType.Enum,
            "mirror_notNull",
            "mirror_notNull_man"
        );
        cmd.overload(["mirror_act", "mirror_notNull_man", "axisPos_opt"]);

        //rote
        cmd.setEnum("rote", ["rote", "ro"]);
        cmd.setEnum("degrees_notNull", [
            "90_degrees",
            "180_degrees",
            "270_degrees",
        ]);
        cmd.mandatory("action", ParamType.Enum, "rote", "rote_man");
        cmd.mandatory(
            "degrees",
            ParamType.Enum,
            "degrees_notNull",
            "degrees_notNull_man"
        );
        cmd.overload(["rote_man", "degrees_notNull_man", "axisPos_opt"]);

        //stack
        cmd.setEnum("stack", ["stack", "st"]);
        cmd.mandatory("action", ParamType.Enum, "stack", "stack_man");
        cmd.mandatory("xMultiple", ParamType.Int, "", "xMultiple_man");
        cmd.mandatory("yMultiple", ParamType.Int, "", "yMultiple_man");
        cmd.mandatory("zMultiple", ParamType.Int, "", "zMultiple_man");
        cmd.overload([
            "stack_man",
            "xMultiple_man",
            "yMultiple_man",
            "zMultiple_man",
        ]);

        //block
        cmd.setEnum("block", ["block", "bl"]);
        cmd.mandatory("action", ParamType.Enum, "block", "block_enum_man");
        cmd.mandatory("enum_1", ParamType.Enum, "menu", "menu_man");
        cmd.overload([
            "block_enum_man",
            "intPos_man",
            "nbt_man",
            "blockEntity_man",
        ]);
        cmd.overload(["block_enum_man", "intPos_man", "menu_man"]);

        //texture
        cmd.setEnum("texture", ["texture", "te"]);
        cmd.setEnum("ab", ["a", "b"]);
        cmd.mandatory("action", ParamType.Enum, "texture", "texture_man");
        cmd.mandatory("enum_1", ParamType.Enum, "ab", "ab_man");
        cmd.overload(["texture_man", "ab_man", "intPos_man"]);

        //shape
        cmd.setEnum("shape", ["shape", "sh"]);
        cmd.mandatory("action", ParamType.Enum, "shape", "shape_man");
        cmd.mandatory("package", ParamType.String, "", "package_man");
        cmd.mandatory("enum_1", ParamType.Enum, "list", "enum1_list_man");
        cmd.mandatory("enum_1", ParamType.Enum, "load", "enum1_load_man");
        cmd.optional("Json", ParamType.JsonValue, "", "json_opt");
        cmd.overload([
            "shape_man",
            "enum1_load_man",
            "package_man",
            "index_man",
            "json_opt",
            "intPos_opt",
        ]);
        cmd.overload(["shape_man", "enum1_list_man"]);

        //undo
        cmd.setEnum("undo", ["undo", "ud"]);
        cmd.mandatory("action", ParamType.Enum, "undo", "undo_man", 1);
        cmd.overload(["undo_man"]);

        //redo
        cmd.setEnum("redo", ["redo", "rd"]);
        cmd.mandatory("action", ParamType.Enum, "redo", "redo_man", 1);
        cmd.overload(["redo_man"]);

        //tool
        cmd.setEnum("tool", ["tool", "to"]);
        cmd.setEnum("bind", ["bind", "bi"]);
        cmd.setEnum("unbind", ["unbind", "un"]);
        cmd.setEnum("type", ["right", "left"]);
        cmd.mandatory("action", ParamType.Enum, "tool", "tool_man");
        cmd.mandatory("enum_1", ParamType.Enum, "bind", "bind_man");
        cmd.mandatory("enum_1", ParamType.Enum, "unbind", "unbind_man");
        cmd.mandatory("enum_2", ParamType.Enum, "type", "type_man");
        cmd.mandatory("cmd", ParamType.String, "", "cmd_man");
        cmd.mandatory("describe", ParamType.String, "", "describe_man");
        cmd.overload(["tool_man", "enum1_list_man"]);
        cmd.overload([
            "tool_man",
            "bind_man",
            "item_man",
            "type_man",
            "cmd_man",
            "describe_man",
            "name_opt",
        ]);
        cmd.overload([
            "tool_man",
            "unbind_man",
            "item_man",
            "type_man",
            "name_opt",
        ]);

        //setting
        cmd.setEnum("setting", ["setting"]);
        cmd.setEnum("set", ["set", "se"]);
        cmd.setEnum("get", ["get", "ge"]);
        cmd.mandatory("action", ParamType.Enum, "setting", "setting_man");
        cmd.mandatory("enum_1", ParamType.Enum, "set", "set_man");
        cmd.mandatory("enum_1", ParamType.Enum, "get", "get_man");
        cmd.mandatory("json", ParamType.JsonValue, "", "json_man");
        cmd.overload(["setting_man", "get_man", "key_man"]);
        cmd.overload(["setting_man", "set_man", "json_man"]);

        //help
        cmd.setEnum("help", ["help", "he", "?"]);
        cmd.mandatory("action", ParamType.Enum, "help", "help_man");
        cmd.overload(["help_man"]);

        //add-ban
        cmd.setEnum("add|ban", ["ban", "add"]);
        cmd.mandatory(
            "playerName",
            ParamType.String,
            "playerName",
            "playerName_man"
        );
        cmd.mandatory("action", ParamType.Enum, "add|ban", "add-ban_man", 1);
        cmd.overload(["add-ban_man", "playerName_man"]);

        //reload
        cmd.setEnum("reload", ["reload", "r"]);
        cmd.mandatory("action", ParamType.Enum, "reload", "reload_man");
        cmd.overload(["reload_man"]);

        //update
        cmd.setEnum("update", ["update", "u"]);
        cmd.mandatory("action", ParamType.Enum, "update", "update_man");
        cmd.overload(["update_man"]);

        //import
        cmd.setEnum("import", ["import", "im"]);
        cmd.mandatory("action", ParamType.Enum, "import", "import_man");
        cmd.mandatory("file", ParamType.String, "", "file_man");
        cmd.optional("includeEntity", ParamType.Bool, "", "includeEntity_opt");
        cmd.overload([
            "import_man",
            "file_man",
            "playerName_man",
            "includeEntity_opt",
            "name_opt",
        ]);

        //export
        cmd.setEnum("export", ["export", "ex"]);
        cmd.setEnum("fileType", ["mcstructure"]);
        cmd.mandatory("action", ParamType.Enum, "export", "export_man");
        cmd.mandatory("type", ParamType.Enum, "fileType", "fileType_man");
        cmd.overload([
            "export_man",
            "fileType_man",
            "id_man",
            "includeEntity_opt",
            "name_opt",
        ]);

        // cmd.setEnum("brush", ["brush", "br"]);
        // cmd.setEnum("texture", ["texture", "te"]);
        // cmd.mandatory("action", ParamType.Enum, "brush");

        cmd.setCallback(
            (
                cmd: Command,
                ori: CommandOrigin,
                output: CommandOutput,
                res: any
            ) => {
                try {
                    CACommand.normalisePositions(res);
                    CACommand.command_callback(cmd, ori, output, res);
                } catch (e) {
                    const text = e.message;
                    if (e instanceof Warn)
                        output.error(StrFactory.cmdWarn(text));
                    else output.error(StrFactory.cmdErr(text));

                    if (Config.get(Config.GLOBAL, "debugMod")) {
                        logger.error(
                            "msg:",
                            e.message,
                            "\ntr:",
                            text + "\nstack:" + e.stack
                        );
                    }
                }
            }
        );
        // setup() returns whether the command actually went live. 1.x ignored it,
        // so a rejected registration looked exactly like a working plugin.
        let installed = false;
        try {
            installed = cmd.setup() !== false;
        } catch (e) {
            logger.error("[command] register failed: " + (e && (e as Error).message ? (e as Error).message : String(e)));
        }
        if (installed) {
            logger.info("[command] /call registered (alias: /ca)");
        } else {
            logger.error(
                "[command] /call could NOT be registered. " +
                "Another plugin may already own the name, or the server was not fully started."
            );
        }
    }

    /**
     * Turn parsed coordinates into integer block positions.
     *
     * LSE hands a position argument back as the block CENTRE (`x + 0.5`); `BlockPos` truncates
     * that toward zero, so `-44` came back as `-43` and `-0.5` as `0` - every negative coordinate
     * was one block off ("all wands are one block off"). The arguments are declared as `Vec3` now
     * and floored here, which maps the centre back to its cell for both signs.
     */
    public static normalisePositions(res: any): void {
        if (res == null || typeof res !== "object") return;
        for (const key of ["intPos", "IntPos", "AxisPos"]) {
            const value = res[key];
            if (value == null || typeof value !== "object") continue;
            const x = Number(value.x);
            const y = Number(value.y);
            const z = Number(value.z);
            if (!Number.isFinite(x) || !Number.isFinite(y) || !Number.isFinite(z)) continue;
            res[key] = { x: Math.floor(x), y: Math.floor(y), z: Math.floor(z), dimid: value.dimid };
        }
    }

    private static command_callback(
        cmd: Command,
        ori: CommandOrigin,
        output: CommandOutput,
        res: any
    ) {
        switch (ori.type) {
            case OriginType.Player:
                CACommand.command_playerCallback(ori, output, res);
                return;
            case OriginType.DedicatedServer:
                try {
                    CACommand.command_consoleCallback(output, res);
                } catch (error) {
                    logFailure("command.console", error);
                }
                return;
            case OriginType.Virtual:
                //use command: execute
                if (ori.player == undefined) break;
                CACommand.command_playerCallback(ori, output, res);
                break;
            default:
                logger.error(
                    Tr._c(
                        "console.app.command.unknowType",
                        ori.type
                    )
                );
                break;
        }
    }

    private static command_playerCallback(
        ori: CommandOrigin,
        output: CommandOutput,
        res: any
    ) {
        const player = ori.player;
        if (!Players.hasPermission(player)) {
            throw new Error(
                Tr._(
                    ori.player.langCode,
                    "dynamic.app.command_playerCallback.notHasPermission"
                )
            );
        }
        const caPlayer = Players.fetchCAPlayer(ori.player.xuid);
        if (caPlayer.forbidCmd) {
            // A long operation is running. This is an EXPECTED condition, not a bug: throwing it
            // printed a stack trace for every impatient click (the tool path runs commands through
            // `Player.runcmd`, so the throw surfaced in the console). Tell the player and stop.
            output.error(Tr._(player.langCode, "dynamic.app.command_playerCallback.wait"));
            return;
        }

        switch (res.action) {
            case "on":
                EnableOperation.on(output, caPlayer);
                return;
            case "off":
            case "of":
                EnableOperation.off(output, caPlayer);
                return;
        }

        if (!caPlayer.settings.enable) {
            throw new Error(
                Tr._(
                    player.langCode,
                    "dynamic.app.command_playerCallback.close"
                )
            );
        }

        switch (res.action) {
            case undefined:
            case "me":
            case "menu":
                MenuOperation.start(output, caPlayer, res);
                return
            case "preview":
            case "pv":
                switch (res.enum_1) {
                    case "set":
                    case "se":
                        PreviewOperation.set(output, caPlayer, res);
                        return;
                    case "click":
                    case "ck":
                        PreviewOperation.click(output, caPlayer, res);
                        return;
                    case "move":
                    case "mv":
                        PreviewOperation.move(output, caPlayer, res);
                        return;
                    case "rotate":
                    case "rt":
                        PreviewOperation.rotate(output, caPlayer);
                        return;
                    case "mirror":
                    case "mi":
                        PreviewOperation.mirror(output, caPlayer);
                        return;
                    case "confirm":
                    case "ok":
                        void PreviewOperation.confirm(output, caPlayer);
                        return;
                    case "cancel":
                    case "cc":
                        PreviewOperation.cancel(output, caPlayer);
                        return;
                    case "mode":
                    case "mo":
                        PreviewOperation.modeCommand(output, caPlayer, res.enum_2);
                        return;
                    case "calib":
                    case "ca":
                        PreviewOperation.calib(output, caPlayer, res.delta);
                        return;
                    case "probe":
                    case "pb":
                        PreviewOperation.probe(output, caPlayer, res.delta);
                        return;
                    case "trim":
                    case "tm":
                        PreviewOperation.trim(output, caPlayer, res.delta);
                        return;
                    case "info":
                    case "in":
                        PreviewOperation.info(output, caPlayer);
                        return;
                    case "pivot":
                    case "pvt":
                        PreviewOperation.pivot(output, caPlayer, res.enum_2);
                        return;
                    case "nudge":
                    case "ng":
                        PreviewOperation.nudge(output, caPlayer, res.dx, res.dy, res.dz);
                        return;
                    case "nudgeface":
                    case "nf":
                        PreviewOperation.nudgeFace(output, caPlayer);
                        return;
                    case "refresh":
                    case "rf":
                        PreviewOperation.recompute(output, caPlayer);
                        return;
                    case "radius":
                    case "rd":
                        PreviewOperation.radius(output, caPlayer, res.delta);
                        return;
                    case "bar":
                    case "br":
                        PreviewOperation.barReport(output, caPlayer);
                        return;
                    case "bartest":
                    case "bt":
                        PreviewOperation.barTest(output, caPlayer);
                        return;
                    case "barclear":
                    case "bc":
                        PreviewOperation.barClear(output, caPlayer);
                        return;
                }
                output.error("用法: /ca preview set|click|move|rotate|mirror|confirm|cancel|mode|calib|info");
                return;
            case "tools":
            case "tl":
                switch (res.enum_1) {
                    case "list":
                    case "li":
                        ToolItems.list(output);
                        return;
                    case "status":
                    case "st":
                        output.success(ToolItems.diagnose());
                        return;
                    case "pack":
                    case "pk":
                        ToolItems.exportAddon(output);
                        return;
                    case "debug":
                    case "db":
                        ToolItems.debug(output, caPlayer);
                        return;
                    case "give":
                    case "gi":
                    case undefined:
                        ToolItems.give(output, caPlayer);
                        return;
                }
                return;
            case "area":
            case "ar":
                AreaOperation.start(output, caPlayer, res);
                return;
            case "refresh":
            case "rf":
                ChunkOperation.start(output, caPlayer);
                return;
            case "fill":
            case "fi":
                FillOperation.fill(output, caPlayer, res);
                return;
            case "clear":
            case "cl":
                FillOperation.clear(output, caPlayer);
                return;
            case "replace":
            case "re":
                FillOperation.replace(output, caPlayer, res);
                return;
            case "move":
            case "mo":
                BasicTranslOperation.move(output, caPlayer, res);
                return;
            case "stack":
            case "st":
                BasicTranslOperation.stack(output, caPlayer, res);
                return;
            case "mirror":
            case "mi":
                BasicTranslOperation.mirror(output, caPlayer, res);
                return;
            case "rote":
            case "ro":
                BasicTranslOperation.rote(output, caPlayer, res);
                return;
            case "shape":
            case "sh":
                ShapeOperation.start(output, caPlayer, res);
                return;
            case "texture":
            case "te":
                TextureOperation.start(output, caPlayer, res);
                return;
            case "block":
            case "bl":
                BlockEditerOperation.start(output, caPlayer, res);
                return;
            case "copy":
            case "co":
                StructureOperation.copy(output, caPlayer);
                return;
            case "paste":
            case "pa": {
                // Same race as the wand path: teardown packets carry the pre-paste blocks, so a
                // paste that starts while they are queued ends up half overwritten on the client.
                PreviewOperation.cancelFor(caPlayer.xuid);
                void PreviewScene.flushCleanup(4000).then(() => {
                    try {
                        StructureOperation.paste(output, caPlayer, res);
                    } catch (e) {
                        output.error("粘贴失败: " + String((e as any)?.message ?? e));
                    }
                });
                return;
            }
            case "save":
            case "sa":
                StructureOperation.save(output, caPlayer, res);
                return;
            case "list":
            case "li":
                StructureOperation.list(output, caPlayer);
                return;
            case "load":
            case "lo":
                StructureOperation.load(output, caPlayer, res);
                return;
            case "delete":
            case "de":
                StructureOperation.delete(output, caPlayer, res);
                return;
            case "public":
            case "pu":
                StructureOperation.public(output, caPlayer, res);
                return;
            case "private":
            case "pr":
                StructureOperation.private(output, caPlayer, res);
                return;
            case "publiccheck":
            case "pchk":
                StructureOperation.publicCheck(output, caPlayer);
                return;
            case "publicreload":
            case "prel":
                StructureOperation.publicReload(output, caPlayer);
                return;
            case "publicdebug":
            case "pdb":
                StructureOperation.publicDebug(output, caPlayer, res);
                return;
            case "undo":
            case "ud": {
                // Same rule as paste: the preview's teardown must be finished before the world is
                // rewritten, otherwise the restore packets describe blocks the undo is replacing.
                PreviewOperation.cancelFor(caPlayer.xuid);
                void PreviewScene.flushCleanup(4000).then(() => {
                    try {
                        StructureOperation.undo(output, caPlayer);
                    } catch (e) {
                        output.error("撤销失败: " + String((e as any)?.message ?? e));
                    }
                });
                return;
            }
            case "redo":
            case "rd": {
                PreviewOperation.cancelFor(caPlayer.xuid);
                void PreviewScene.flushCleanup(4000).then(() => {
                    try {
                        StructureOperation.redo(output, caPlayer);
                    } catch (e) {
                        output.error("重做失败: " + String((e as any)?.message ?? e));
                    }
                });
                return;
            }
            case "tool":
            case "to":
                ToolOperation.start(output, caPlayer, res);
                return;
            case "setting":
                SettingsOperation.start(output, caPlayer, res);
                return;
            case "help":
            case "he":
            case "?":
                HelpOperation.start(output, caPlayer);
                return;
            case "ban":
            case "add":
            case "reload":
            case "r":
            case "update":
            case "u":
            case "import":
            case "im":
            case "export":
            case "ex":
                throw new Error(
                    Tr._(
                        player.langCode,
                        "dynamic.app.command_playerCallback.consoleCmd"
                    )
                );
        }

        // [To Adapt Bug]
        if(Object.keys(res).includes("FillMode")) {
            FillOperation.fill(output, caPlayer, res);
        }
    }

    private static command_consoleCallback(output: CommandOutput, res: any) {

        switch (res.action) {
            case "ban":
                PermissionOperation.ban(res.playerName, output);
                return;
            case "add":
                PermissionOperation.add(res.playerName, output);
                return;
            case "list":
            case "li":
                PermissionOperation.list(output);
                return;
            case "shape":
            case "sh":
                ShapeOperation.consoleStart(output);
                return;
            case "import":
            case "im":
                ImportOperation.start(res, output);
                return;
            case "export":
            case "ex":
                ExportOperation.start(res);
                return;
            case "reload":
            case "r": {
                // Re-reading the files is the whole point: LSE caches the values, so an edited
                // configs.json stays invisible until reload() runs (the old code threw instead).
                const result = Config.reloadAll();
                const near = Config.get(Config.GLOBAL, "previewNearRadius", 5);
                const scale = Config.get(Config.GLOBAL, "previewNearScale", 1);
                if (result.ok) {
                    output.success("配置已重新加载（靠近可穿: 半径=" + near + " 缩放=" + scale + "）");
                } else {
                    output.error("部分配置重载失败: " + result.failed.join(", "));
                }
                return;
            }
            default:
                throw new Error(
                    Tr._c("console.app.command_consoleCallback.cmdError")
                );
        }
    }
}
