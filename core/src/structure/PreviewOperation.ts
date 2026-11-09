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
import { MsgType, online, tell } from "../util/Msg";
import { describeError } from "../util/Safe";
import StrFactory from "../util/StrFactory";

import Holo from "../holo/Holo";
import BossBar, { describeId, idCandidates } from "../holo/BossBar";
import PreviewHudLock from "./PreviewHudLock";
import { every, stop as stopTimer } from "../util/Safe";
import {
    CountdownMode,
    bossBarProgress,
    bossBarStyle,
    countdownActionBar,
    countdownMode,
    countdownText,
    countdownVisible,
    gestureOf,
    nextBarAction,
    remainingSeconds,
} from "./PreviewHud";
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
    /** Wall-clock deadline for the auto-cancel; drives the countdown. */
    deadline: number;
    /** Boss bar id while the countdown is on screen (null = not shown). */
    barId: number | null;
    /** Last title pushed to the bar, so an unchanged second is not re-sent. */
    lastTitle: string;
    /** The name HologramLib keys per-player state by. */
    playerName: string;
    /** Consecutive failed bar updates; 2 in a row means the id is dead. */
    barFails: number;
    /** HUD actually in use for this preview: the boss bar, or the action-bar fallback. */
    hud: "bar" | "noid" | "actionbar";
    /** Last tick this bar was verified against bossBarGetInfo. */
    barVerifiedAt: number;
    /** How many times the bar had to be rebuilt before giving up on it. */
    barRebuilds: number;
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

/** How often the countdown HUD refreshes. Half a second keeps the bar smooth. */
const HUD_INTERVAL_MS = 500;
/** Compare the live bar against the library's own record this often (0 = never). */
const BAR_VERIFY_MS = 2000;
let hudTimer: number | null = null;

    /**
     * "bar"     = boss bar, updated by id (only when the id survives the round trip)
     * "noid"    = boss bar, RE-CREATED once per second because the id cannot be used again
     * "actionbar" = last resort, needs no library at all
     */
type HudKind = "bar" | "noid" | "actionbar";

function hudPreference(): HudKind {
    const raw = String(Config.get(Config.GLOBAL, "previewCountdownHud", "auto") ?? "").toLowerCase();
    if (raw === "actionbar") return "actionbar";
    if (raw === "bar") return "bar";
    return BossBar.available() ? "bar" : "actionbar";
}

function currentMode(): CountdownMode {
    return countdownMode(Config.get(Config.GLOBAL, "previewCountdown", "always"));
}

function stopHud(): void {
    if (hudTimer != null) {
        stopTimer(hudTimer);
        hudTimer = null;
    }
}

function startHud(): void {
    if (hudTimer != null) return;
    // Safe.every wraps the callback in safeCall: one bad round is logged instead of silently
    // killing the timer, which is exactly how the countdown froze in 3.9.0.
    hudTimer = every("preview.hud", HUD_INTERVAL_MS, hudTick);
}

function dropBar(st: PreviewState, xuid: string): void {
    if (st.barId != null) {
        BossBar.remove(st.barId);
        st.barId = null;
    }
    if (st.hud === "noid" && st.playerName !== "") {
        // the only handle we have for a rebuilt bar is the player name
        BossBar.removeAll(st.playerName);
    }
    st.lastTitle = "";
    st.barFails = 0;
    if (st.hud !== "actionbar") PreviewHudLock.release(xuid);
}

/** One player's HUD update; never allowed to throw into the shared timer. */
function hudFor(xuid: string, st: PreviewState, now: number): void {
    const remaining = st.deadline - now;
    if (remaining <= 0) return; // the cancel timer owns the expiry

    if (!countdownVisible(currentMode(), remaining)) {
        if (st.barId != null) dropBar(st, xuid);
        PreviewHudLock.release(xuid);
        return;
    }

    const player = online(xuid);
    if (player == null) return;

    const title = countdownText(remaining);

    if (st.hud === "actionbar" || !BossBar.available()) {
        st.hud = "actionbar";
        PreviewHudLock.hold(xuid);
        if (title !== st.lastTitle) {
            st.lastTitle = title;
            tell(player, countdownActionBar(remaining), MsgType.TIP);
        }
        return;
    }

    const style = bossBarStyle(remaining);
    const percent = bossBarProgress(remaining, timeoutSeconds() * 1000);

    if (st.hud === "noid") {
        // Rebuild once per second: remove the previous bar by NAME (the only key that works)
        // and create it again with the new title and fill.
        if (title === st.lastTitle) return;
        BossBar.removeAll(st.playerName);
        const fresh = BossBar.add(st.playerName, title, percent, style.color, style.overlay);
        if (fresh == null) {
            st.hud = "actionbar";
            PreviewHudLock.hold(xuid);
            st.lastTitle = "";
            tell(player, StrFactory.cmdWarn("Boss 条重建失败，倒计时改用动作栏"), MsgType.TIP);
            return;
        }
        st.lastTitle = title;
        st.barVerifiedAt = now;
        return;
    }

    if (st.barId == null) {
        const raw = BossBar.add(st.playerName, title, percent, style.color, style.overlay);
        if (raw == null) {
            // The library refused: fall back for this preview instead of hammering it.
            st.hud = "actionbar";
            PreviewHudLock.hold(xuid);
            st.lastTitle = "";
            tell(player, StrFactory.cmdWarn("Boss 条创建失败，倒计时改用动作栏"), MsgType.TIP);
            return;
        }

        // The id is a 64-bit value; the runtime hands it over as a double, so the exact
        // integer has to be reconstructed before it can be used again. Try the candidates and
        // keep the first encoding the library actually accepts.
        let chosen: any = null;
        for (const candidate of idCandidates(raw)) {
            if (BossBar.setTitle(candidate, title)) {
                chosen = candidate;
                break;
            }
        }
        if (chosen == null) {
            const rebuild = Config.get(Config.GLOBAL, "previewBossBarRebuild", true) !== false;
            if (!rebuild) {
                BossBar.removeAll(st.playerName);
                st.hud = "actionbar";
                PreviewHudLock.hold(xuid);
                st.lastTitle = "";
                tell(player, StrFactory.cmdWarn("Boss 条 id 不可回传，倒计时改用动作栏"), MsgType.TIP);
                return;
            }
            // The runtime gave us a rounded 64-bit id, so it cannot be used to address this
            // bar again. Rather than lose the boss bar entirely, fall back to REBUILDING it:
            // the title only changes once per second anyway, so one removeAll + add per second
            // reproduces a countdown without ever touching an id.
            BossBar.removeAll(st.playerName);
            st.hud = "noid";
            st.barId = null;
            st.lastTitle = "";
            st.barFails = 0;
            st.barVerifiedAt = now;
            hudFor(xuid, st, now);
            return;
        }

        st.barId = chosen;
        st.lastTitle = title;
        st.barFails = 0;
        st.barVerifiedAt = now;
        return;
    }

    // Verify occasionally against the library's own record: a bar whose anchor is gone keeps
    // returning true while the client shows a frozen frame, and getInfo is the only signal.
    if (now - st.barVerifiedAt >= BAR_VERIFY_MS) {
        st.barVerifiedAt = now;
        const info = BossBar.getInfo(st.barId);
        if (info != null && (info === "" || /not_found|missing/i.test(info))) {
            dropBar(st, xuid);
            return;
        }
    }

    if (title === st.lastTitle && st.barFails === 0) {
        if (!BossBar.setHealth(st.barId, percent)) st.barFails++;
        return;
    }

    if (BossBar.update(st.barId, title, percent, style.color, style.overlay)) {
        st.lastTitle = title;
        st.barFails = 0;
        return;
    }

    // Two failures in a row mean this id is dead: drop it and rebuild next tick. After a few
    // rebuilds the library clearly cannot keep the bar alive, so fall back for this preview.
    st.barFails++;
    const action = nextBarAction(st.barFails, st.barRebuilds);
    if (action === "rebuild") {
        st.barFails = 0;
        st.barRebuilds++;
        dropBar(st, xuid);
    } else if (action === "giveup") {
        st.barFails = 0;
        dropBar(st, xuid);
        st.hud = "actionbar";
        PreviewHudLock.hold(xuid);
        st.lastTitle = "";
        tell(player, StrFactory.cmdWarn("Boss 条无法更新，倒计时改用动作栏"), MsgType.TIP);
    }
}

/**
 * One HUD tick: keep every live preview's countdown in sync.
 *
 * The boss bar is used when HologramLib provides one and it demonstrably works; the action bar
 * is the fallback and takes a lock so the selection hint yields that beat instead of flickering
 * against it. The ticker stops itself as soon as no preview is live.
 */
function hudTick(): void {
    if (states.size === 0) {
        stopHud();
        return;
    }
    const now = Date.now();
    for (const [xuid, st] of states) {
        try {
            hudFor(xuid, st, now);
        } catch (e) {
            try {
                logger.warn("[CALL][preview hud] " + (e && (e as any).message ? (e as any).message : e));
            } catch {
                // ignore
            }
        }
    }
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
        st.deadline = Date.now() + timeoutSeconds() * 1000;
        // a fresh arm always refreshes the visible countdown
        st.lastTitle = "";
        st.timer = setTimeout(() => {
            PreviewOperation.cancelFor(caPlayer.xuid);
            const player = caPlayer.$;
            if (player != null) tell(player, StrFactory.cmdErr("预览已超时取消"), MsgType.TIP);
        }, timeoutSeconds() * 1000);
        startHud();
        hudTick();
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
            deadline: 0,
            barId: null,
            lastTitle: "",
            playerName: String(caPlayer.$?.realName ?? ""),
            barFails: 0,
            hud: hudPreference(),
            barVerifiedAt: 0,
            barRebuilds: 0,
        };
        states.set(caPlayer.xuid, st);

        if (!PreviewOperation.render(caPlayer, st)) {
            states.delete(caPlayer.xuid);
            output.error("无法显示预览：需要 HologramLib（服务端形状发包）");
            return;
        }

        // Moving an existing preview keeps its cells: rebuilding would tear the old scene down,
        // and that cleanup runs asynchronously and erased the cells the new scene had just
        // drawn (the "left click leaves holes" report).
        const canMove = PreviewScene.canMove(caPlayer.xuid);
        const scene = canMove
            ? (PreviewScene.move(caPlayer, pos, st.degrees, st.mirror, st.pivot) ? null : PreviewOperation.syncScene(caPlayer, st, true))
            : PreviewOperation.syncScene(caPlayer, st, true);
        PreviewOperation.arm(caPlayer, st);
        if (scene != null && !scene.ok) {
            output.success("预览落点: " + pos.floor().toString() + "（方块预览不可用：" + scene.reason + "，仅显示线框）");
            return;
        }
        if (scene != null && scene.ok) {
            const mode = scene.mode ?? "full";
            const how = mode === "full"
                ? scene.blocks + " 个方块"
                : mode === "window"
                    ? "大建筑：窗口加载（表面 " + scene.blocks + " 个，走进范围逐个出现）"
                    : "超大建筑：按切片懒解析（走到哪解析到哪）";
            output.success(
                "预览就绪: " + how +
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
        const gesture = gestureOf("right", PreviewOperation.sneaking(caPlayer), states.has(caPlayer.xuid));
        switch (gesture) {
            case "confirm":
                PreviewOperation.confirm(output, caPlayer);
                return;
            case "rotate":
                PreviewOperation.rotate(output, caPlayer);
                return;
            default:
                PreviewOperation.set(output, caPlayer, res);
                return;
        }
    }

    /**
     * Left click: move the anchor - or CANCEL when sneaking.
     *
     * Mobile has no separate left button: tapping a block is the same onStartDestroyBlock
     * event, so "sneak + tap" cancels there too. The wand never breaks the block (the tool
     * items are blocked in onDestroyBlock/onPlaceBlock).
     */
    public static move(output: any, caPlayer: CAPlayer, res: { IntPos?: any }): void {
        const gesture = gestureOf("left", PreviewOperation.sneaking(caPlayer), states.has(caPlayer.xuid));
        if (gesture === "cancel") {
            PreviewOperation.cancelFor(caPlayer.xuid);
            output.success("已取消预览");
            return;
        }
        PreviewOperation.set(output, caPlayer, res);
    }

    /** True when the player is crouching (some clients throw on the property). */
    private static sneaking(caPlayer: CAPlayer): boolean {
        try {
            return caPlayer.$.isSneaking === true;
        } catch {
            return false;
        }
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

    /**
     * `/ca preview bar` - what does the library actually say?
     *
     * The 3.9.0 countdown froze at the value it was created with, which means either our calls
     * failed or the library stopped updating a bar whose anchor went away. This prints the raw
     * answers so the next report contains facts instead of a screenshot.
     */
    public static barReport(output: any, caPlayer: CAPlayer): void {
        const st = states.get(caPlayer.xuid);
        const name = String(caPlayer.$?.realName ?? "");
        const lines: string[] = [
            "Boss 条可用: " + (BossBar.available() ? "是" : "否"),
            "本玩家条数: " + (BossBar.count(name) ?? "?"),
            "本预览: " + (st == null ? "无预览"
                : (st.hud === "bar" ? "Boss 条(按 id 更新)"
                    : st.hud === "noid" ? "Boss 条(每秒重建，id 不可回传)"
                        : "动作栏") +
                "，id=" + describeId(st.barId) +
                "，失败=" + st.barFails + "，重建=" + st.barRebuilds),
        ];
        if (st?.barId != null) {
            lines.push("库内记录: " + (typeof st.barId === "number" ? (BossBar.getInfo(st.barId) ?? "?") : "(id 不是数字，库不接受查询)"));
        }
        const probe = Holo.bind("bossBarProbe");
        if (probe != null) {
            try {
                lines.push("probe: " + String(probe()));
            } catch (e) {
                lines.push("probe 抛错: " + describeError(e));
            }
        }
        output.success(lines.join("\n"));
    }

    /** `/ca preview bar clear` - remove this player's bar without touching anything else. */
    public static barClear(output: any, caPlayer: CAPlayer): void {
        const name = String(caPlayer.$?.realName ?? "");
        const st = states.get(caPlayer.xuid);
        const lines: string[] = [];
        if (st?.barId != null) {
            const removed = BossBar.remove(st.barId);
            lines.push("delete id=" + String(st.barId) + " -> " + removed);
            st.barId = null;
            st.lastTitle = "";
        } else {
            lines.push("当前预览没有 CALL 管理的条");
        }
        const left = BossBar.count(name);
        if (left != null && left > 0) {
            // Bars made with an unaddressable id can only be cleared wholesale. This is an
            // explicit user command, so it is allowed to do that - and it says so.
            const ok = BossBar.removeAll(name);
            lines.push("仍有 " + left + " 条无法按 id 删除，已整玩家清空 -> " + ok);
        }
        lines.push("剩余条数: " + (BossBar.count(name) ?? "?") + "（只清 CALL 自己的；removeAll 会连别的插件的一起清）");
        output.success(lines.join("\n"));
    }

    /**
     * `/ca preview bar test` - a 6 second self-test the player can watch.
     *
     * Creates one bar, rewrites its title and fill once per second, and reports every return
     * value in chat: that separates "our calls fail" from "the client ignores the updates".
     */
    public static barTest(output: any, caPlayer: CAPlayer): void {
        if (!BossBar.available()) {
            output.error("HologramLib 的 bossBar 接口不可用");
            return;
        }
        const name = String(caPlayer.$?.realName ?? "");
        const player = caPlayer.$;
        const lines: string[] = [];
        const push = (text: string) => {
            lines.push(text);
            try {
                tell(player, "§8[bar] " + text, MsgType.TIP);
            } catch {
                // ignore
            }
        };
        const raw = BossBar.add(name, "§e自检 6", 1, 1, 0);
        push("add -> " + describeId(raw));
        if (raw == null) {
            output.success(lines.join("\n"));
            return;
        }

        // Which encoding does the library accept for this id?
        let id: any = raw;
        for (const candidate of idCandidates(raw)) {
            const ok = BossBar.setTitle(candidate, "§e自检 6");
            // getInfo only accepts a number; asking it with anything else makes the library
            // log "参数类型不匹配" into the console, which is pure noise.
            const info = typeof candidate === "number" ? BossBar.getInfo(candidate) : null;
            push("  " + describeId(candidate) + " -> setTitle=" + ok +
                (typeof candidate === "number" ? " info=" + (info ?? "?") : ""));
            if (ok && id === raw) id = candidate;
        }
        let i = 0;
        const timer = every("preview.barTest", 1000, () => {
            i++;
            const title = "§e自检 " + Math.max(0, 6 - i);
            const ok = BossBar.update(id, title, Math.max(0, (6 - i) / 6), 1 + (i % 2), 0);
            const info = BossBar.getInfo(id);
            push("第" + i + "秒 update=" + ok + " info=" + (info ?? "?"));
            if (i >= 6) {
                stopTimer(timer);
                const removed = BossBar.remove(id);
                push("remove -> " + removed + "，剩余 " + (BossBar.count(name) ?? "?"));
                // Whatever the id did, prove the rebuild strategy: remove by name, add again.
                BossBar.removeAll(name);
                const again = BossBar.add(name, "§e重建测试", 0.5, 3, 0);
                push("rebuild: removeAll + add -> " + describeId(again) + "，条数 " + (BossBar.count(name) ?? "?"));
                BossBar.removeAll(name);
                push("清理后条数 " + (BossBar.count(name) ?? "?"));
                output.success(lines.join("\n"));
            }
        });
    }
    /** Force a window recompute (`/ca preview refresh`) - also the way to recover after a hitch. */
    public static recompute(output: any, caPlayer: CAPlayer): void {
        if (!states.has(caPlayer.xuid)) {
            output.error("当前没有预览");
            return;
        }
        PreviewScene.refreshWindow(caPlayer.xuid, true);
        const scene = PreviewScene.info(caPlayer.xuid);
        output.success("已重算预览窗口：模式 " + scene.mode + " · 窗口 " + scene.windowCount +
            " · 已覆盖 " + scene.applied + " 格 · 半径 " + scene.radius);
    }

    /** Runtime window radius override (`/ca preview radius <16-192>`). */
    public static radius(output: any, caPlayer: CAPlayer, value?: number): void {
        if (!states.has(caPlayer.xuid)) {
            output.error("当前没有预览");
            return;
        }
        const wanted = Number(value);
        if (!Number.isFinite(wanted)) {
            output.error("用法: /ca preview radius <16-192>");
            return;
        }
        const applied = PreviewScene.setRadius(caPlayer.xuid, wanted);
        if (applied == null) {
            output.error("当前没有预览");
            return;
        }
        output.success("预览窗口半径: " + applied + " 格（已重算）");
    }

    public static info(output: any, caPlayer: CAPlayer): void {
        const scene = PreviewScene.info(caPlayer.xuid);
        const st = states.get(caPlayer.xuid);
        const st2 = states.get(caPlayer.xuid);
        const left = st2 != null ? remainingSeconds((st2?.deadline ?? 0) - Date.now()) : 0;
        const bar = BossBar.available() ? "Boss 条" : "动作栏";
        const modeText = scene.mode === "full" ? "全量"
            : scene.mode === "window" ? "窗口"
            : scene.mode === "lazy" ? "懒解析" : "-";
        output.success(
            "模式 " + PreviewOperation.mode() + "/" + modeText +
            " · 基准 " + (st != null ? st.pivot : defaultPivot()) +
            " · 偏移 " + (st != null ? st.offset.x + "/" + st.offset.y + "/" + st.offset.z : "0/0/0") +
            " · 渲染 " + scene.backend +
            " · 已覆盖 " + scene.applied + " 格" +
            (scene.mode === "lazy"
                ? " · 切片 " + scene.total + "（待解析 " + scene.loading + "）"
                : " · 总表面 " + scene.total + " · 窗口 " + scene.windowCount) +
            (scene.pending > 0 ? "（待发 " + scene.pending + "）" : "") +
            (scene.failed > 0 ? "（" + scene.failed + " 格客户端不认识）" : "") +
            " · 上限 " + Config.get(Config.GLOBAL, "previewMaxBlocks", 12000) +
            " · 半径 " + scene.radius +
            (st2 != null ? " · 剩余 " + left + "s（倒计时 " + bar + "）" : "") +
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
            dropBar(st, xuid);
            states.delete(xuid);
            PreviewHudLock.release(xuid);
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
        stopHud();
        PreviewHudLock.clear();
    }
}