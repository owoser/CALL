import Config from "../common/Config";
import { Pos3 } from "../common/Pos3";
import Wireframe, { COLOR } from "../holo/Wireframe";
import PreviewScene from "./PreviewScene";
import ItemDisplay from "../holo/ItemDisplay";
import StructureService from "./StructureService";
import StructureOperation from "./StructureOperation";
import { Box, Degrees, MirrorMode, PivotMode, rotatedUnion } from "./Rotate";
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
    /** Manual nudge on top of pos; the ghost AND the paste use pos + offset. */
    offset: { x: number; y: number; z: number };
    degrees: Degrees;
    mirror: MirrorMode;
    pivot: PivotMode;
    timer: ReturnType<typeof setTimeout> | null;
}

/** Where the paste will actually start: the anchor plus every manual nudge. */
function anchorOf(st: PreviewState): Pos3Type {
    // Pos3.add() mutates, and the state must survive a failed paste - always work on a copy.
    return st.pos.clone().add(st.offset.x, st.offset.y, st.offset.z);
}

function pivotOf(value: any): PivotMode {
    return String(value ?? "").toLowerCase() === "anchor" ? "anchor" : "inplace";
}

/** Config default for the rotation pivot (key: previewPivot). */
function defaultPivot(): PivotMode {
    return pivotOf(Config.get(Config.GLOBAL, "previewPivot", "inplace"));
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
    const pivot = st.pivot === "anchor" ? " §7绕落点" : "";
    const nudge = st.offset.x !== 0 || st.offset.y !== 0 || st.offset.z !== 0
        ? " §7偏移 §f" + st.offset.x + "/" + st.offset.y + "/" + st.offset.z
        : "";
    return "§b预览 §7旋转 §f" + st.degrees + "° §7镜像 §f" + st.mirror + pivot + nudge +
        "§7 · §f" + w + "§7×§f" + h + "§7×§f" + d;
}

export default class PreviewOperation {
    private static render(caPlayer: CAPlayer, st: PreviewState): boolean {
        const data = StructureService.getData(caPlayer.xuid);
        const complex = (data as any)?.copy ?? {};
        if (Object.keys(complex).length === 0) return false;

        const box = rotatedUnion(complex, anchorOf(st), st.degrees, st.mirror, st.pivot);
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
            const result = PreviewScene.build(caPlayer, anchorOf(st), st.degrees, st.mirror, st.pivot);
            return result;
        }
        PreviewScene.rotate(caPlayer, st.degrees, st.mirror, st.pivot);
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
            // a fresh anchor means a fresh nudge: the offset belongs to the old placement
            offset: { x: 0, y: 0, z: 0 },
            degrees: prev?.degrees ?? 0,
            mirror: prev?.mirror ?? "none",
            pivot: prev?.pivot ?? defaultPivot(),
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

    /** Reposition the live scene without re-reading the clipboard. */
    private static reposition(caPlayer: CAPlayer, st: PreviewState): void {
        PreviewOperation.render(caPlayer, st);
        if (PreviewOperation.mode() === "wireframe") {
            PreviewScene.clear(caPlayer.xuid);
        } else if (!PreviewScene.move(caPlayer, anchorOf(st), st.degrees, st.mirror, st.pivot)) {
            PreviewOperation.syncScene(caPlayer, st, true);
        }
        PreviewOperation.arm(caPlayer, st);
    }

    /**
     * Rotation pivot: inplace = the box stays put, anchor = rotate around the clicked cell.
     *
     * Switching it changes where every block lands, so the live scene is rebuilt from the
     * cached block list and the wireframe is redrawn with the same box the paste will cover.
     */
    public static pivot(output: any, caPlayer: CAPlayer, value?: string): void {
        const st = states.get(caPlayer.xuid);
        const requested = value == null || String(value) === "" ? null : pivotOf(value);
        const current = st != null ? st.pivot : defaultPivot();
        const next: PivotMode = requested ?? (current === "inplace" ? "anchor" : "inplace");

        Config.set(Config.GLOBAL, "previewPivot", next);
        if (st != null) {
            st.pivot = next;
            PreviewOperation.reposition(caPlayer, st);
        }
        output.success(next === "anchor"
            ? "旋转基准: §e绕落点§r（你点的那一格是竖轴，旋转后框会转到相邻象限）"
            : "旋转基准: §a原地§r（框不动，图案在框内旋转）");
    }

    /**
     * Relative nudge. Without arguments the offset is cleared.
     *
     * The ghost and the paste read the same anchor, so a nudge moves both - it is not a
     * preview-only offset.
     */
    public static nudge(output: any, caPlayer: CAPlayer, dx?: number, dy?: number, dz?: number): void {
        const st = states.get(caPlayer.xuid);
        if (st == null) {
            output.error("还没有预览：先用预览魔杖右键点一个方块");
            return;
        }

        const args = [dx, dy, dz].map((n) => Number(n));
        if (args.some((n) => !Number.isFinite(n))) {
            st.offset = { x: 0, y: 0, z: 0 };
            PreviewOperation.reposition(caPlayer, st);
            output.success("预览偏移已清零");
            return;
        }

        st.offset = {
            x: st.offset.x + Math.trunc(args[0]),
            y: st.offset.y + Math.trunc(args[1]),
            z: st.offset.z + Math.trunc(args[2]),
        };
        PreviewOperation.reposition(caPlayer, st);
        const target = anchorOf(st);
        output.success("预览偏移 " + st.offset.x + "/" + st.offset.y + "/" + st.offset.z +
            " → 落点 " + target.floor().toString() + "（粘贴会跟着走）");
    }

    /** Bedrock block face -> nudge direction. 0=down 1=up 2=north(-Z) 3=south(+Z) 4=west(-X) 5=east(+X). */
    private static readonly FACE_DELTA: Record<number, [number, number, number]> = {
        0: [0, -1, 0],
        1: [0, 1, 0],
        2: [0, 0, -1],
        3: [0, 0, 1],
        4: [-1, 0, 0],
        5: [1, 0, 0],
    };

    /**
     * Adjust wand: move one block along the normal of the face that was clicked.
     *
     * The click pipeline turns an item click into a bound command and loses the face, so
     * app.ts stores it on the player right before dispatching (see caPlayer.lastClickSide).
     */
    public static nudgeFace(output: any, caPlayer: CAPlayer): void {
        const delta = PreviewOperation.FACE_DELTA[Number(caPlayer.lastClickSide)];
        if (delta == null) {
            output.error("没拿到点击的面：换调整魔杖右键点方块的某个面");
            return;
        }
        let sign = 1;
        try {
            if (caPlayer.$.isSneaking === true) sign = -1;
        } catch {
            sign = 1;
        }
        PreviewOperation.nudge(output, caPlayer, delta[0] * sign, delta[1] * sign, delta[2] * sign);
    }

    /** Paste for real, using the previewed position and transform. */
    public static confirm(output: any, caPlayer: CAPlayer): void {
        const st = states.get(caPlayer.xuid);
        if (st == null) {
            output.error("还没有预览：先用预览魔杖右键点一个方块");
            return;
        }
        const pos = anchorOf(st);
        const mirror = st.mirror;
        const degrees = st.degrees;
        const pivot = st.pivot;
        PreviewOperation.cancelFor(caPlayer.xuid);

        try {
            StructureOperation.pasteTransformed(output, caPlayer, pos, mirror, degrees, pivot);
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
    public static calib(output: any, caPlayer: CAPlayer, pick?: number): void {
        const numeric = Number(pick);
        const chosen = pick != null && Number.isFinite(numeric) && numeric > 0 ? numeric : null;
        if (chosen !== null) {
            Config.set(Config.GLOBAL, "previewBlockScale", String(chosen));
            PreviewOperation.clearCalib();
            const st = states.get(caPlayer.xuid);
            if (st != null) PreviewScene.build(caPlayer, anchorOf(st), st.degrees, st.mirror, st.pivot);
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
    public static probe(output: any, caPlayer: CAPlayer, pick?: number): void {
        const numeric = Number(pick);
        const chosen = pick != null && Number.isFinite(numeric) ? numeric : null;
        if (chosen !== null) {
            // landed N cells too high -> shift everything down by N
            Config.set(Config.GLOBAL, "previewBlockYCorrection", -chosen);
            PreviewOperation.clearProbe();
            const st = states.get(caPlayer.xuid);
            if (st != null) PreviewScene.build(caPlayer, anchorOf(st), st.degrees, st.mirror, st.pivot);
            output.success("已保存 previewBlockYCorrection = " + (-chosen) + " 格（预览已重建）");
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
            else PreviewScene.build(caPlayer, anchorOf(st), st.degrees, st.mirror, st.pivot);
        }
        output.success("预览模式: " + value + "（已写入 configs.json）");
    }

    /**
     * Nudge the vertical correction by a relative amount, e.g. `/ca preview trim -0.25`.
     *
     * Once the probe is within a fraction of a block, guessing absolute values is wasteful -
     * this lets the tester dial it in while looking at the result.
     */
    public static trim(output: any, caPlayer: CAPlayer, delta?: number): void {
        const raw = Number(delta);
        if (delta == null || !Number.isFinite(raw)) {
            output.error("用法: /ca preview trim <±格数>，例如 /ca preview trim -0.25");
            return;
        }
        const current = PreviewScene.correction();
        const next = Math.round((current + raw) * 1000) / 1000;
        Config.set(Config.GLOBAL, "previewBlockYCorrection", next);

        PreviewOperation.clearProbe();
        const st = states.get(caPlayer.xuid);
        if (st != null) {
            PreviewScene.build(caPlayer, anchorOf(st), st.degrees, st.mirror, st.pivot);
            output.success("竖直修正: " + current + " → " + next + " 格（预览已重建）");
            return;
        }
        // No live preview: re-place the probe so the new value is visible immediately instead
        // of leaving the player adjusting a number they cannot see.
        PreviewOperation.probe(output, caPlayer);
        output.success("竖直修正: " + current + " → " + next + " 格（没有活动预览，已重新摆出探针）");
    }

    public static info(output: any, caPlayer: CAPlayer): void {
        const scene = PreviewScene.info(caPlayer.xuid);
        const st = states.get(caPlayer.xuid);
        output.success(
            "模式 " + PreviewOperation.mode() +
            " · 基准 " + (st != null ? st.pivot : defaultPivot()) +
            " · 偏移 " + (st != null ? st.offset.x + "/" + st.offset.y + "/" + st.offset.z : "0/0/0") +
            " · 渲染 " + scene.backend +
            " · 已覆盖 " + scene.applied + "/" + scene.blocks + " 格" +
            (scene.building ? "（生成中，待发 " + scene.pending + "）" : "") +
            (scene.failed > 0 ? "（" + scene.failed + " 格客户端不认识）" : "") +
            " · 上限 " + Config.get(Config.GLOBAL, "previewMaxBlocks", 8000) +
            (scene.truncated ? " · 已截断" : "") +
            (st != null ? " · 落点 " + anchorOf(st).floor().toString() + " 旋转 " + st.degrees + "°" : " · 当前无预览")
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