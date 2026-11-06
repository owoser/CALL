import Config from "../common/Config";
import { Pos3 } from "../common/Pos3";
import Wireframe, { COLOR } from "../holo/Wireframe";
import PreviewScene from "./PreviewScene";
import ItemDisplay from "../holo/ItemDisplay";
import StructureService from "./StructureService";
import StructureOperation from "./StructureOperation";
import { Box, Degrees, MirrorMode, rotatedUnion } from "./Rotate";
import CAPlayer from "../user/CAPlayer";
import { Pos3 as Pos3Type } from "../common/Pos3";
import { MsgType, tell } from "../util/Msg";
import { describeError } from "../util/Safe";
import StrFactory from "../util/StrFactory";

/**
 * The paste preview.
 *
 * A "ghost block" preview is not possible: HologramLib has no client-side block override and
 * LegacyScriptEngine cannot obtain the network block runtime ids a raw UpdateBlockPacket would
 * need. So the preview shows WHAT will happen instead of the blocks themselves:
 *
 *   - the destination box, already rotated, drawn as a wireframe visible to every player;
 *   - a label with the rotation and the footprint;
 *   - the same box is what the undo snapshot covers, so what you confirm is what gets pasted.
 */

interface PreviewState {
    pos: Pos3Type;
    degrees: Degrees;
    mirror: MirrorMode;
    timer: ReturnType<typeof setTimeout> | null;
}

const states = new Map<string, PreviewState>();
/** Display ids of the current /ca preview calib run. */
const calibIds: number[] = [];
/** Display ids of the current /ca preview probe run. */
const probeIds: number[] = [];

function timeoutSeconds(): number {
    const raw = Number(Config.get(Config.GLOBAL, "previewTimeout", 60));
    return Number.isFinite(raw) && raw >= 10 ? raw : 60;
}

function clearTimer(st: PreviewState): void {
    if (st.timer != null) {
        clearTimeout(st.timer);
        st.timer = null;
    }
}

function label(st: PreviewState, box: Box): string {
    const w = Math.abs(box.x2 - box.x1) + 1;
    const h = Math.abs(box.y2 - box.y1) + 1;
    const d = Math.abs(box.z2 - box.z1) + 1;
    return "§b预览 §7旋转 §f" + st.degrees + "° §7镜像 §f" + st.mirror + "§7 · §f" + w + "§7×§f" + h + "§7×§f" + d;
}

export default class PreviewOperation {
    private static render(caPlayer: CAPlayer, st: PreviewState): boolean {
        const data = StructureService.getData(caPlayer.xuid);
        const complex = (data as any)?.copy ?? {};
        if (Object.keys(complex).length === 0) return false;

        const box = rotatedUnion(complex, st.pos, st.degrees, st.mirror);
        if (box == null) return false;

        return Wireframe.show(
            "preview:" + caPlayer.xuid,
            {
                x1: box.x1, y1: box.y1, z1: box.z1,
                x2: box.x2 + 1, y2: box.y2 + 1, z2: box.z2 + 1,
            },
            COLOR.preview,
            label(st, box)
        );
    }

    /** "ghost" = real block preview + wireframe, "wireframe" = outline only. */
    private static mode(): "ghost" | "wireframe" {
        const raw = String(Config.get(Config.GLOBAL, "previewMode", "ghost") ?? "").toLowerCase();
        return raw === "wireframe" ? "wireframe" : "ghost";
    }

    private static syncScene(caPlayer: CAPlayer, st: PreviewState, rebuild: boolean) {
        if (PreviewOperation.mode() === "wireframe") {
            PreviewScene.clear(caPlayer.xuid);
            return null;
        }
        if (rebuild) {
            const result = PreviewScene.build(caPlayer, st.pos, st.degrees, st.mirror);
            return result;
        }
        PreviewScene.rotate(caPlayer, st.degrees, st.mirror);
        return null;
    }

    private static arm(caPlayer: CAPlayer, st: PreviewState): void {
        clearTimer(st);
        st.timer = setTimeout(() => {
            PreviewOperation.cancelFor(caPlayer.xuid);
            const player = caPlayer.$;
            if (player != null) tell(player, StrFactory.cmdErr("预览已超时取消"), MsgType.TIP);
        }, timeoutSeconds() * 1000);
    }

    /** Set (or move) the preview anchor. */
    public static set(output: any, caPlayer: CAPlayer, res: { IntPos?: any }): void {
        const data = StructureService.getData(caPlayer.xuid) as any;
        if (Object.keys(data?.copy ?? {}).length === 0) {
            output.error("剪贴板是空的：先用复制魔杖复制一个选区");
            return;
        }

        const pos = res?.IntPos != null
            ? Pos3.fromPos(res.IntPos)
            : Pos3.fromPos(caPlayer.$.pos).calibration().floor();

        const prev = states.get(caPlayer.xuid);
        const st: PreviewState = {
            pos,
            degrees: prev?.degrees ?? 0,
            mirror: prev?.mirror ?? "none",
            timer: null,
        };
        states.set(caPlayer.xuid, st);

        if (!PreviewOperation.render(caPlayer, st)) {
            states.delete(caPlayer.xuid);
            output.error("无法显示预览：需要 HologramLib（服务端形状发包）");
            return;
        }

        const scene = PreviewOperation.syncScene(caPlayer, st, true);
        PreviewOperation.arm(caPlayer, st);
        if (scene != null && !scene.ok) {
            output.success("预览落点: " + pos.floor().toString() + "（方块预览不可用：" + scene.reason + "，仅显示线框）");
            return;
        }
        if (scene != null && scene.ok) {
            output.success(
                "预览就绪: " + scene.blocks + " 个方块" +
                (scene.truncated ? "（已按上限截断）" : "") +
                "，旋转 " + st.degrees + "°（再右键旋转，潜行右键确认）"
            );
            return;
        }
        output.success("预览落点: " + pos.floor().toString() + "，旋转 " + st.degrees + "°（再右键旋转，潜行右键确认）");
    }

    /**
     * One right-click on a block.
     *
     * Sneaking confirms (that is the "done, paste it" gesture), otherwise the first click sets
     * the anchor and later clicks rotate - so a wand alone can do the whole loop without
     * typing commands, which is the point of having items in the first place.
     */
    public static click(output: any, caPlayer: CAPlayer, res: { IntPos?: any }): void {
        let sneaking = false;
        try {
            sneaking = caPlayer.$.isSneaking === true;
        } catch {
            sneaking = false;
        }
        if (sneaking) {
            PreviewOperation.confirm(output, caPlayer);
            return;
        }
        if (!states.has(caPlayer.xuid)) {
            PreviewOperation.set(output, caPlayer, res);
            return;
        }
        PreviewOperation.rotate(output, caPlayer);
    }

    /** Left click always moves the anchor. */
    public static move(output: any, caPlayer: CAPlayer, res: { IntPos?: any }): void {
        PreviewOperation.set(output, caPlayer, res);
    }

    /** Rotate the preview by 90 degrees. */
    public static rotate(output: any, caPlayer: CAPlayer): void {
        const st = states.get(caPlayer.xuid);
        if (st == null) {
            output.error("还没有预览：先用预览魔杖右键点一个方块");
            return;
        }
        st.degrees = (((st.degrees + 90) % 360) as Degrees);
        PreviewOperation.render(caPlayer, st);
        PreviewOperation.syncScene(caPlayer, st, false);
        PreviewOperation.arm(caPlayer, st);
        output.success("预览旋转: " + st.degrees + "°");
    }

    /** Cycle the mirror mode. */
    public static mirror(output: any, caPlayer: CAPlayer): void {
        const st = states.get(caPlayer.xuid);
        if (st == null) {
            output.error("还没有预览：先用预览魔杖右键点一个方块");
            return;
        }
        const order: MirrorMode[] = ["none", "x", "z", "xz"];
        st.mirror = order[(order.indexOf(st.mirror) + 1) % order.length];
        PreviewOperation.render(caPlayer, st);
        PreviewOperation.syncScene(caPlayer, st, false);
        PreviewOperation.arm(caPlayer, st);
        output.success("预览镜像: " + st.mirror);
    }

    /** Paste for real, using the previewed position and transform. */
    public static confirm(output: any, caPlayer: CAPlayer): void {
        const st = states.get(caPlayer.xuid);
        if (st == null) {
            output.error("还没有预览：先用预览魔杖右键点一个方块");
            return;
        }
        const pos = st.pos;
        const mirror = st.mirror;
        const degrees = st.degrees;
        PreviewOperation.cancelFor(caPlayer.xuid);

        try {
            StructureOperation.pasteTransformed(output, caPlayer, pos, mirror, degrees);
        } catch (e) {
            output.error("粘贴失败: " + describeError(e));
        }
    }

    /**
     * Calibration helper.
     *
     * The right "one block" scale for an item display is not documented consistently
     * (0.5 in the library notes, 1.0 in the author's screenshot), and the model origin has to
     * match too. This lays out three candidate scales inside a 1x1x1 wireframe each, so one
     * screenshot decides it.
     */
    /**
     * `/ca preview calib` shows the sweep; `/ca preview calib 8` stores the picked value so the
     * admin can finish the calibration without waiting for anyone.
     */
    public static calib(output: any, caPlayer: CAPlayer, pick?: string): void {
        const chosen = pick != null && pick !== "" ? String(pick).trim() : "";
        if (chosen !== "") {
            if (!/^\d+(\.\d+)?$/.test(chosen)) {
                output.error("用法: /ca preview calib [scale 数字]（不带参数=摆出候选，带参数=保存该缩放）");
                return;
            }
            Config.set(Config.GLOBAL, "previewBlockScale", chosen);
            PreviewOperation.clearCalib();
            const st = states.get(caPlayer.xuid);
            if (st != null) PreviewScene.build(caPlayer, st.pos, st.degrees, st.mirror);
            output.success("已保存 previewBlockScale = " + chosen + "（预览已按新值重建）");
            return;
        }

        PreviewOperation.clearCalib();

        if (!ItemDisplay.available()) {
            output.error("校准需要 HologramLib");
            return;
        }

        const p = Pos3.fromPos(caPlayer.$.pos).floor();
        // Position is measured separately (see probe); this sweep answers "how big is one
        // block", which perspective makes hard to judge: three candidates, each in its own
        // 1x1x1 wireframe, with the measured correction applied so they share the same height.
        const candidates = ["0.75", "1", "1.25"];
        const offsetY = String(Config.get(Config.GLOBAL, "previewBlockOffsetY", "0"));
        const correction = Number(Config.get(Config.GLOBAL, "previewBlockYCorrection", 0)) || 0;
        let placed = 0;

        for (let i = 0; i < candidates.length; i++) {
            const cx = p.x + 2 + i * 2;
            const cy = p.y;
            const cz = p.z;
            const scale = candidates[i];

            // 1x1x1 wireframe = the reference cell the block has to fill exactly
            Wireframe.show(
                "calib:" + i,
                { x1: cx, y1: cy, z1: cz, x2: cx + 1, y2: cy + 1, z2: cz + 1 },
                COLOR.preview,
                "§fscale " + scale
            );

            const id = ItemDisplay.create({
                // documented pose: bottom centre + offY in model units + rotX/rotZ 180
                x: cx + 0.5,
                y: cy + correction,
                z: cz + 0.5,
                dim: p.dimid,
                blockId: "minecraft:stone",
                scale,
                offsetY,
                viewDistance: 64,
                onlyPlayer: String(caPlayer.$.realName ?? ""),
            });
            if (id > 0) {
                calibIds.push(id);
                placed++;
            }
        }

        output.success(
            "已摆出 " + placed + " 组校准石块（scale " + candidates.join(" / ") +
            "，已带上位置修正 " + correction + "）：哪个刚好填满线框，就 /ca preview calib <那个 scale>（/ca preview cancel 清理）"
        );
        // clean up on its own so a forgotten calibration never litters the world
        setTimeout(() => PreviewOperation.clearCalib(), 120000);
    }

    /**
     * Position measurement.
     *
     * Guessing parameters wasted three rounds, so this measures instead: five stacked 1x1x1
     * wireframes act as a ruler, and ONE grass_block (top/bottom is obvious) is placed at the
     * bottom cell with the most neutral pose possible. Whatever cell it lands in is the error,
     * in blocks - a unit we control exactly.
     *
     * `/ca preview probe 3` stores "-3 blocks" and rebuilds the live preview.
     */
    public static probe(output: any, caPlayer: CAPlayer, pick?: string): void {
        const chosen = pick != null && pick !== "" ? String(pick).trim() : "";
        if (chosen !== "") {
            if (!/^-?\d+(\.\d+)?$/.test(chosen)) {
                output.error("用法: /ca preview probe [格数]（不带参数=测量；带参数=保存修正，可填小数如 0.5）");
                return;
            }
            // landed N cells too high -> shift everything down by N
            Config.set(Config.GLOBAL, "previewBlockYCorrection", String(-Number(chosen)));
            PreviewOperation.clearProbe();
            const st = states.get(caPlayer.xuid);
            if (st != null) PreviewScene.build(caPlayer, st.pos, st.degrees, st.mirror);
            output.success("已保存 previewBlockYCorrection = " + (-Number(chosen)) + " 格（预览已重建）");
            return;
        }

        PreviewOperation.clearProbe();
        if (!ItemDisplay.available()) {
            output.error("测量需要 HologramLib");
            return;
        }

        const p = Pos3.fromPos(caPlayer.$.pos).floor();

        // Two cells side by side at the same height:
        //   left  = the position the preview actually spawns at (correction applied)
        //   right = raw anchor (correction NOT applied), for A/B
        // Whatever the block does, the pair makes the answer obvious in one screenshot.
        Wireframe.show(
            "probe:0",
            { x1: p.x, y1: p.y, z1: p.z, x2: p.x + 1, y2: p.y + 1, z2: p.z + 1 },
            COLOR.complete,
            "§a预览的位置"
        );
        Wireframe.show(
            "probe:1",
            { x1: p.x + 3, y1: p.y, z1: p.z, x2: p.x + 4, y2: p.y + 1, z2: p.z + 1 },
            COLOR.incomplete,
            "§e原始锚点（未修正）"
        );

        // Apply the SAME correction the real preview uses, otherwise this probe always shows
        // the raw (uncorrected) position and looks permanently half a block off.
        const correction = PreviewScene.correction();
        const scale = String(Config.get(Config.GLOBAL, "previewBlockScale", "1"));
        const onlyPlayer = String(caPlayer.$.realName ?? "");

        // left cell: exactly what /ca preview does
        const corrected = ItemDisplay.create({
            x: p.x + 0.5,
            y: p.y + correction,
            z: p.z + 0.5,
            dim: p.dimid,
            blockId: "minecraft:grass_block",
            scale, offsetY: "0", rotY: 0, viewDistance: 64, onlyPlayer,
        });
        if (corrected > 0) probeIds.push(corrected);

        // right cell: the raw anchor, so the difference is visible without moving the camera
        const raw = ItemDisplay.create({
            x: p.x + 3.5,
            y: p.y,
            z: p.z + 0.5,
            dim: p.dimid,
            blockId: "minecraft:stone",
            scale, offsetY: "0", rotY: 0, viewDistance: 64, onlyPlayer,
        });
        if (raw > 0) probeIds.push(raw);

        output.success(
            "左边绿框 = 预览实际位置（已修正 " + correction + " 格，里面是草方块）；" +
            "右边黄框 = 原始锚点（未修正，里面是石头）。" +
            "草方块若正好填满绿框就说明校准完成；否则告诉我它比绿框高/低多少"
        );
        setTimeout(() => PreviewOperation.clearProbe(), 180000);
    }

    /** Destroy probe displays + wireframes. */
    public static clearProbe(): void {
        if (probeIds.length > 0) {
            ItemDisplay.destroyAll(probeIds.splice(0, probeIds.length));
        }
        for (let i = 0; i < 4; i++) Wireframe.hide("probe:" + i);
    }

    /** Destroy calibration displays + wireframes. */
    public static clearCalib(): void {
        if (calibIds.length > 0) {
            ItemDisplay.destroyAll(calibIds.splice(0, calibIds.length));
        }
        for (let i = 0; i < 6; i++) Wireframe.hide("calib:" + i);
    }

    public static modeCommand(output: any, caPlayer: CAPlayer, arg: string | undefined): void {
        const value = String(arg ?? "").toLowerCase();
        if (value !== "ghost" && value !== "wireframe") {
            output.error("用法: /ca preview mode ghost|wireframe（当前 " + PreviewOperation.mode() + "）");
            return;
        }
        Config.set(Config.GLOBAL, "previewMode", value);
        const st = states.get(caPlayer.xuid);
        if (st != null) {
            if (value === "wireframe") PreviewScene.clear(caPlayer.xuid);
            else PreviewScene.build(caPlayer, st.pos, st.degrees, st.mirror);
        }
        output.success("预览模式: " + value + "（已写入 configs.json）");
    }

    /**
     * Nudge the vertical correction by a relative amount, e.g. `/ca preview trim -0.25`.
     *
     * Once the probe is within a fraction of a block, guessing absolute values is wasteful -
     * this lets the tester dial it in while looking at the result.
     */
    public static trim(output: any, caPlayer: CAPlayer, delta?: string): void {
        const raw = String(delta ?? "").trim();
        if (!/^[+-]?\d+(\.\d+)?$/.test(raw)) {
            output.error("用法: /ca preview trim <±格数>，例如 /ca preview trim -0.25");
            return;
        }
        const current = PreviewScene.correction();
        const next = Math.round((current + Number(raw)) * 1000) / 1000;
        Config.set(Config.GLOBAL, "previewBlockYCorrection", String(next));

        PreviewOperation.clearProbe();
        const st = states.get(caPlayer.xuid);
        if (st != null) PreviewScene.build(caPlayer, st.pos, st.degrees, st.mirror);
        output.success(
            "竖直修正: " + current + " → " + next + " 格（预览已重建；再 /ca preview probe 看是否齐平）"
        );
    }

    public static info(output: any, caPlayer: CAPlayer): void {
        const scene = PreviewScene.info(caPlayer.xuid);
        const st = states.get(caPlayer.xuid);
        output.success(
            "模式 " + PreviewOperation.mode() +
            " · 已生成 " + scene.blocks + " 个方块" + (scene.building ? "（生成中）" : "") +
            " · 上限 " + Config.get(Config.GLOBAL, "previewMaxBlocks", 2000) +
            " · 缩放 " + Config.get(Config.GLOBAL, "previewBlockScale", "1") +
            " · 竖直修正 " + PreviewScene.correction() + " 格" +
            (scene.truncated ? " · 已截断" : "") +
            (st != null ? " · 落点 " + st.pos.floor().toString() + " 旋转 " + st.degrees + "°" : " · 当前无预览")
        );
    }

    public static cancel(output: any, caPlayer: CAPlayer): void {
        PreviewOperation.clearCalib();
        if (!states.has(caPlayer.xuid)) {
            output.error("当前没有预览");
            return;
        }
        PreviewOperation.cancelFor(caPlayer.xuid);
        output.success("已取消预览");
    }

    /** Drop the state and the wireframe (also used on logout / unload). */
    public static cancelFor(xuid: string): void {
        const st = states.get(xuid);
        if (st != null) {
            clearTimer(st);
            states.delete(xuid);
        }
        try {
            Wireframe.hide("preview:" + xuid);
        } catch {
            // ignore
        }
        try {
            PreviewScene.clear(xuid);
        } catch {
            // ignore
        }
    }

    public static has(xuid: string): boolean {
        return states.has(xuid);
    }

    /** The wireframe is client-side only, so a reconnect must rebuild it. */
    public static refresh(xuid: string, caPlayer: CAPlayer): void {
        const st = states.get(xuid);
        if (st == null) return;
        PreviewOperation.render(caPlayer, st);
    }

    public static cancelAll(): void {
        for (const xuid of [...states.keys()]) PreviewOperation.cancelFor(xuid);
    }
}