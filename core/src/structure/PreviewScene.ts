/**
 * The paste preview, drawn as per-client BLOCK OVERRIDES (HologramLib viewBlock).
 *
 * Three modes, chosen automatically:
 *
 *   full    surface blocks <= previewMaxBlocks  -> draw everything (unchanged behaviour)
 *   window  more than that, but the clipboard is small enough to parse as a whole
 *           -> draw only the cells within previewRadius of the player, nearest first,
 *              and follow the player as they walk
 *   lazy    the clipboard itself is huge (> previewMaxCells) -> only the 64-block slices
 *           that intersect the current window are parsed, LRU cached
 *
 * Why not item displays: they are a fake MOB holding the block, so the ghost inherited the
 * mob's idle animation ("随风飘扬") and every block cost a client entity, which collapsed the
 * frame rate. viewBlock sends one small packet per cell instead.
 *
 * Invariants:
 *   - cells come from cellOffset(), the same mapping the paste writes with;
 *   - only the DIFF against what is applied is sent (four quarter turns = zero packets);
 *   - teardown clears exactly our own cells, never viewClearAll;
 *   - cells of a player who left are retried when they come back.
 */
import Config from "../common/Config";
import { Pos3 } from "../common/Pos3";
import CAPlayer from "../user/CAPlayer";
import NBTService from "./NBTService";
import StructureService from "./StructureService";
import { parseStructureLayout } from "../io/NbtCodec";
import { extractSurface, PreviewBlock, SliceInput } from "./SurfaceExtract";
import { Degrees, MirrorMode, PivotMode } from "./Rotate";
import { clipboardBox } from "./Clipboard";
import Area3 from "../common/Area3";
import { Structure } from "../common/Structure";
import BlockView from "../holo/BlockView";
import { MsgType, online, tell } from "../util/Msg";
import StrFactory from "../util/StrFactory";
import { describeError } from "../util/Safe";
import {
    PlanGrid,
    PlanOp,
    PlannedCell,
    appliedCells,
    diffPlacement,
    planCells,
    planGrid,
    sampleOutline,
    untransformCell,
    windowCells,
} from "./PreviewPlan";

export type SceneMode = "full" | "window" | "lazy";

/** One 64-block slice of the clipboard, WITHOUT its layout (that is parsed on demand). */
interface SliceRef {
    sid: string;
    key: string;
    origin: [number, number, number];
    /** rectangle in clipboard coordinates, for window intersection */
    x0: number;
    z0: number;
    w: number;
    d: number;
}

interface Scene {
    anchor: Pos3;
    size: [number, number, number];
    degrees: Degrees;
    mirror: MirrorMode;
    pivot: PivotMode;
    playerName: string;
    cancelled: boolean;
    mode: SceneMode;

    /** full / window: every surface block of the clipboard. */
    blocks: PreviewBlock[];
    /** full / window: world cells bucketed by 16x16 column. */
    grid: PlanGrid | null;
    /** window: coarse shell drawn outside the budget. */
    outline: PlannedCell[];

    /** lazy: slice index + per-slice grids + LRU order + parse backlog. */
    slices: SliceRef[];
    sliceGrids: Map<string, PlanGrid>;
    sliceOrder: string[];
    pending: SliceRef[];

    applied: Map<string, string>;
    queue: PlanOp[];
    failed: number;
    building: boolean;

    radius: number;
    lastCenter: { x: number; y: number; z: number } | null;
    timer: ReturnType<typeof setInterval> | null;
    loadTimer: ReturnType<typeof setTimeout> | null;
    emptyTipShown: boolean;
    windowCount: number;
    totalSurface: number;
}

const scenes = new Map<string, Scene>();

function num(key: string, fallback: number, min: number, max: number): number {
    const raw = Number(Config.get(Config.GLOBAL, key, fallback));
    if (!Number.isFinite(raw)) return fallback;
    return Math.min(max, Math.max(min, raw));
}

const budget = () => Math.floor(num("previewMaxBlocks", 12000, 200, 200000));
const batchSize = () => Math.floor(num("previewBatchSize", 1000, 50, 5000));
const radiusDefault = () => Math.floor(num("previewRadius", 48, 16, 192));
const updateDistance = () => Math.floor(num("previewUpdateDistance", 8, 2, 32));
const maxCells = () => Math.floor(num("previewMaxCells", 800000, 40000, 4000000));
const sliceCacheSize = () => Math.floor(num("previewSliceCache", 8, 2, 64));
const prefetchAmount = () => Math.floor(num("previewPrefetch", 16, 0, 64));
const outlineEnabled = () => Config.get(Config.GLOBAL, "previewOutline", true) !== false;
const outlineStep = () => Math.floor(num("previewOutlineStep", 8, 2, 32));
const OUTLINE_CAP = 1500;
/** How often the window is checked against the player's position. */
const WINDOW_TICK_MS = 800;

/**
 * Residual vertical error of the item-display debug path, in BLOCKS.
 *
 * The block-override preview does not need it (the cell IS the block); it is kept for
 * /ca preview probe and /ca preview trim.
 */
export function blockYCorrection(): number {
    const raw = Number(Config.get(Config.GLOBAL, "previewBlockYCorrection", 0));
    return Number.isFinite(raw) ? raw : 0;
}

function tip(xuid: string, text: string, error = false): void {
    const player = online(xuid);
    if (player == null) return;
    tell(player, error ? StrFactory.cmdErr(text) : StrFactory.cmdMsg(text), MsgType.TIP);
}

// ---------------------------------------------------------------- deferred cleanup
interface CleanupTask { playerName: string; cells: Array<[number, number, number]>; }
const cleanups: CleanupTask[] = [];
let cleanupTimer: ReturnType<typeof setTimeout> | null = null;

function scheduleCleanup(): void {
    if (cleanupTimer != null) return;
    cleanupTimer = setTimeout(() => {
        cleanupTimer = null;
        PreviewScene.drainCleanup();
    }, 0);
}

function enqueueCleanup(playerName: string, cells: Array<[number, number, number]>): void {
    if (cells.length === 0) return;
    cleanups.push({ playerName, cells });
    scheduleCleanup();
}

function playerOnline(name: string): boolean {
    try {
        return mc.getPlayer(name) != null;
    } catch {
        return false;
    }
}

export interface BuildResult {
    ok: boolean;
    blocks: number;
    visible: number;
    truncated: boolean;
    mode?: SceneMode;
    reason?: string;
}
function forwardAxis(player: any): { dx: number; dz: number } {
    let yaw = 0;
    try {
        yaw = Number(player?.direction?.yaw ?? 0);
    } catch {
        yaw = 0;
    }
    const rad = (yaw * Math.PI) / 180;
    // Bedrock: yaw 0 looks towards +Z, 90 towards -X.
    const vx = -Math.sin(rad);
    const vz = Math.cos(rad);
    if (Math.abs(vx) >= Math.abs(vz)) return { dx: vx >= 0 ? 1 : -1, dz: 0 };
    return { dx: 0, dz: vz >= 0 ? 1 : -1 };
}

export const PreviewScene = {
    /**
     * Clipboard box + slice list, WITHOUT reading a single file.
     *
     * The slice grid is pure arithmetic on the selection (`Structure.getAreas()`), which is what
     * makes lazy mode possible: a 200x100x200 clipboard is millions of cells but the slice list
     * is a few dozen rectangles.
     */
    gatherInfo(xuid: string): { size: [number, number, number]; slices: SliceRef[]; cells: number; error?: string } {
        const data = StructureService.getData(xuid) as any;
        const complex = data?.copy ?? {};
        const sids = Object.keys(complex);
        const empty: [number, number, number] = [1, 1, 1];
        if (sids.length === 0) return { size: empty, slices: [], cells: 0, error: "剪贴板是空的" };

        const box = clipboardBox(complex);
        if (box == null) return { size: empty, slices: [], cells: 0, error: "剪贴板是空的" };
        const min = box.min;
        const size: [number, number, number] = [box.size.x, box.size.y, box.size.z];
        const slices: SliceRef[] = [];

        for (const structid of sids) {
            const entry = complex[structid];
            const area = Area3.fromArea3D(entry?.area);
            if (area == null) continue;
            area.start.x -= min.x;
            area.start.y -= min.y;
            area.start.z -= min.z;
            area.end.x -= min.x;
            area.end.y -= min.y;
            area.end.z -= min.z;

            const chunks = new Structure(area).getAreas();
            for (let ix = 0; ix < chunks.length; ix++) {
                const row = chunks[ix];
                for (let iz = 0; iz < row.length; iz++) {
                    const chunk = row[iz];
                    slices.push({
                        sid: structid + "_" + ix + "_" + iz,
                        key: structid + ":" + ix + "_" + iz,
                        origin: [chunk.start.x, chunk.start.y, chunk.start.z],
                        x0: chunk.start.x,
                        z0: chunk.start.z,
                        w: chunk.end.x - chunk.start.x + 1,
                        d: chunk.end.z - chunk.start.z + 1,
                    });
                }
            }
        }

        return { size, slices, cells: size[0] * size[1] * size[2] };
    },

    /** Parse every slice (full / window modes). */
    readAll(refs: SliceRef[]): SliceInput[] {
        const out: SliceInput[] = [];
        for (const ref of refs) {
            try {
                const layout = parseStructureLayout(NBTService.readBytes(ref.sid));
                out.push({ origin: ref.origin, layout });
            } catch (e) {
                logger.warn("[CALL][Preview] 读取切片失败 " + ref.sid + ": " + describeError(e));
            }
        }
        return out;
    },

    /**
     * Build (or rebuild) the preview for a player.
     *
     * Chooses the mode, then fills the send queue in batches: nothing blocks a tick for long.
     */
    build(
        caPlayer: CAPlayer,
        anchor: Pos3,
        degrees: Degrees,
        mirror: MirrorMode,
        pivot: PivotMode = "inplace"
    ): BuildResult {
        const xuid = caPlayer.xuid;
        PreviewScene.clear(xuid);

        if (!BlockView.available()) {
            return {
                ok: false, blocks: 0, visible: 0, truncated: false,
                reason: "需要 HologramLib 的 viewBlock 接口（1.30.0 / LL 26.51.4 起）",
            };
        }

        const realName = String(caPlayer.$?.realName ?? "");
        if (realName === "") {
            return { ok: false, blocks: 0, visible: 0, truncated: false, reason: "无法解析玩家名" };
        }

        const info = PreviewScene.gatherInfo(xuid);
        if (info.error != null) {
            return { ok: false, blocks: 0, visible: 0, truncated: false, reason: info.error };
        }

        const scene: Scene = {
            anchor,
            size: info.size,
            degrees,
            mirror,
            pivot,
            playerName: realName,
            cancelled: false,
            mode: "full",
            blocks: [],
            grid: null,
            outline: [],
            slices: info.slices,
            sliceGrids: new Map(),
            sliceOrder: [],
            pending: [],
            applied: new Map(),
            queue: [],
            failed: 0,
            building: true,
            radius: radiusDefault(),
            lastCenter: null,
            timer: null,
            loadTimer: null,
            emptyTipShown: false,
            windowCount: 0,
            totalSurface: 0,
        };

        if (info.cells > maxCells()) {
            // Lazy: parse nothing up front, let the window pull the slices it needs.
            scene.mode = "lazy";
            scenes.set(xuid, scene);
            PreviewScene.startTimer(xuid);
            PreviewScene.refreshWindow(xuid, true);
            return { ok: true, blocks: 0, visible: 0, truncated: false, mode: "lazy" };
        }

        const parsed = PreviewScene.readAll(info.slices);
        if (parsed.length === 0) {
            return { ok: false, blocks: 0, visible: 0, truncated: false, reason: "切片文件读取失败" };
        }

        const extracted = extractSurface(parsed, 0, "none", Number.MAX_SAFE_INTEGER);
        if (extracted.blocks.length === 0) {
            return { ok: false, blocks: 0, visible: 0, truncated: false, reason: "选区里没有可显示的方块" };
        }

        scene.blocks = extracted.blocks;
        scene.totalSurface = extracted.blocks.length;
        scene.mode = extracted.blocks.length <= budget() ? "full" : "window";
        scene.grid = planGrid(anchor, info.size, degrees, mirror, pivot, extracted.blocks);
        if (scene.mode === "window" && outlineEnabled()) {
            scene.outline = sampleOutline(
                extracted.blocks, anchor, info.size, degrees, mirror, pivot, outlineStep(), OUTLINE_CAP
            );
        }

        scenes.set(xuid, scene);
        PreviewScene.startTimer(xuid);
        PreviewScene.refreshWindow(xuid, true);
        return { ok: true, blocks: extracted.blocks.length, visible: extracted.visible, truncated: false, mode: scene.mode };
    },

    /** Recompute what should be shown, queue only the difference, start pumping. */
    refreshWindow(xuid: string, force: boolean): void {
        const scene = scenes.get(xuid);
        if (scene == null || scene.cancelled) return;

        if (scene.mode === "full") {
            const desired = planCells(scene.anchor, scene.size, scene.degrees, scene.mirror, scene.pivot, scene.blocks);
            PreviewScene.enqueue(xuid, desired);
            return;
        }

        const player = online(xuid);
        if (player == null) return;

        let center: { x: number; y: number; z: number };
        try {
            center = {
                x: Math.floor(player.pos.x),
                y: Math.floor(player.pos.y),
                z: Math.floor(player.pos.z),
            };
        } catch {
            return;
        }

        if (!force && scene.lastCenter != null) {
            const moved = Math.max(
                Math.abs(center.x - scene.lastCenter.x),
                Math.abs(center.y - scene.lastCenter.y),
                Math.abs(center.z - scene.lastCenter.z)
            );
            if (moved < updateDistance()) return;
        }
        scene.lastCenter = center;

        const forward = forwardAxis(player);
        const amount = prefetchAmount();
        const prefetch = amount > 0 ? { dx: forward.dx, dz: forward.dz, amount } : undefined;

        if (scene.mode === "lazy") PreviewScene.ensureSlices(xuid, center);

        const grids: PlanGrid[] = scene.mode === "lazy"
            ? [...scene.sliceGrids.values()]
            : (scene.grid != null ? [scene.grid] : []);
        const res = windowCells(grids, { center, radius: scene.radius, budget: budget(), prefetch });
        scene.windowCount = res.inWindow;

        const desired = new Map<string, PlannedCell>();
        for (const cell of scene.outline) desired.set(cell.key, cell);
        for (const cell of res.cells) desired.set(cell.key, cell);
        PreviewScene.enqueue(xuid, desired);

        if (res.inWindow === 0 && !scene.emptyTipShown) {
            scene.emptyTipShown = true;
            tip(xuid, "当前窗口内没有方块（离建筑太远）");
        } else if (res.inWindow > 0) {
            scene.emptyTipShown = false;
        }
    },

    /** Diff + push + pump. */
    enqueue(xuid: string, desired: Map<string, PlannedCell>): void {
        const scene = scenes.get(xuid);
        if (scene == null) return;
        const ops = diffPlacement(scene.applied, desired);
        if (ops.length > 0) scene.queue.push(...ops);
        scene.building = scene.queue.length > 0;
        PreviewScene.pump(xuid);
    },

    /** Send the next batch, then yield to the server for a tick. */
    pump(xuid: string): void {
        const scene = scenes.get(xuid);
        if (scene == null || scene.cancelled) return;

        const per = batchSize();
        let done = 0;
        while (scene.queue.length > 0 && done < per) {
            const op = scene.queue.shift() as PlanOp;
            if (op.op === "set") {
                if (BlockView.set(scene.playerName, op.x, op.y, op.z, op.id)) scene.applied.set(op.key, op.id);
                else scene.failed++;
            } else {
                BlockView.clear(scene.playerName, op.x, op.y, op.z);
                scene.applied.delete(op.key);
            }
            done++;
        }

        if (scene.queue.length > 0) {
            setTimeout(() => PreviewScene.pump(xuid), 0);
            return;
        }
        scene.building = false;
    },

    /** Queue the slices the window needs (lazy mode). */
    ensureSlices(xuid: string, center: { x: number; y: number; z: number }): void {
        const scene = scenes.get(xuid);
        if (scene == null || scene.mode !== "lazy") return;

        const reach = scene.radius + prefetchAmount() + 2;
        let minX = Infinity, maxX = -Infinity, minZ = Infinity, maxZ = -Infinity;
        for (const [wx, wz] of [[-reach, -reach], [reach, -reach], [-reach, reach], [reach, reach]]) {
            const [dx, dz] = untransformCell(wx, wz, scene.size[0], scene.size[2], scene.degrees, scene.mirror, scene.pivot);
            if (dx < minX) minX = dx;
            if (dx > maxX) maxX = dx;
            if (dz < minZ) minZ = dz;
            if (dz > maxZ) maxZ = dz;
        }

        for (const ref of scene.slices) {
            if (scene.sliceGrids.has(ref.key)) continue;
            if (ref.x0 > maxX || ref.x0 + ref.w - 1 < minX) continue;
            if (ref.z0 > maxZ || ref.z0 + ref.d - 1 < minZ) continue;
            if (scene.pending.some((p) => p.key === ref.key)) continue;
            scene.pending.push(ref);
        }
        PreviewScene.scheduleSliceLoad(xuid);
    },

    /** Parse ONE pending slice per turn, so a huge clipboard never stalls a tick. */
    scheduleSliceLoad(xuid: string): void {
        const scene = scenes.get(xuid);
        if (scene == null || scene.loadTimer != null || scene.pending.length === 0) return;
        scene.loadTimer = setTimeout(() => {
            const live = scenes.get(xuid);
            if (live == null || live.cancelled) return;
            live.loadTimer = null;
            const ref = live.pending.shift();
            if (ref == null) return;
            PreviewScene.loadSlice(xuid, ref);
        }, 0);
    },

    loadSlice(xuid: string, ref: SliceRef): void {
        const scene = scenes.get(xuid);
        if (scene == null || scene.cancelled || scene.sliceGrids.has(ref.key)) return;

        let layout;
        try {
            layout = parseStructureLayout(NBTService.readBytes(ref.sid));
        } catch (e) {
            logger.warn("[CALL][Preview] 懒解析切片失败 " + ref.sid + ": " + describeError(e));
            return;
        }

        const extracted = extractSurface([{ origin: ref.origin, layout }], 0, "none", Number.MAX_SAFE_INTEGER);
        if (extracted.blocks.length > 0) {
            scene.sliceGrids.set(ref.key, planGrid(
                scene.anchor, scene.size, scene.degrees, scene.mirror, scene.pivot, extracted.blocks
            ));
            scene.sliceOrder.push(ref.key);
            PreviewScene.evictSlices(scene);
        }

        PreviewScene.refreshWindow(xuid, true);
        PreviewScene.scheduleSliceLoad(xuid);
    },

    /** LRU eviction that never drops a slice still on screen. */
    evictSlices(scene: Scene): void {
        const max = sliceCacheSize();
        while (scene.sliceOrder.length > max) {
            let removed = false;
            for (let i = 0; i < scene.sliceOrder.length; i++) {
                const key = scene.sliceOrder[i];
                const grid = scene.sliceGrids.get(key);
                if (grid == null) {
                    scene.sliceOrder.splice(i, 1);
                    removed = true;
                    break;
                }
                if (PreviewScene.gridInUse(scene, grid)) continue;
                scene.sliceGrids.delete(key);
                scene.sliceOrder.splice(i, 1);
                removed = true;
                break;
            }
            if (!removed) return;
        }
    },

    gridInUse(scene: Scene, grid: PlanGrid): boolean {
        for (const list of grid.buckets.values()) {
            for (const cell of list) {
                if (scene.applied.has(cell.key)) return true;
            }
        }
        return false;
    },

    /** Rebuild the spatial index after the transform changed. */
    rebuildIndex(scene: Scene, anchor: Pos3): void {
        scene.anchor = anchor;
        if (scene.mode === "lazy") {
            scene.sliceGrids.clear();
            scene.sliceOrder = [];
            scene.pending = [];
            return;
        }
        scene.grid = planGrid(scene.anchor, scene.size, scene.degrees, scene.mirror, scene.pivot, scene.blocks);
        scene.outline = scene.mode === "window" && outlineEnabled()
            ? sampleOutline(
                scene.blocks, scene.anchor, scene.size, scene.degrees, scene.mirror, scene.pivot,
                outlineStep(), OUTLINE_CAP
            )
            : [];
    },

    /** Rotate / mirror / switch pivot in place. */
    rotate(caPlayer: CAPlayer, degrees: Degrees, mirror: MirrorMode, pivot: PivotMode): boolean {
        const scene = scenes.get(caPlayer.xuid);
        if (scene == null) return false;
        scene.degrees = degrees;
        scene.mirror = mirror;
        scene.pivot = pivot;
        PreviewScene.rebuildIndex(scene, scene.anchor);
        PreviewScene.refreshWindow(caPlayer.xuid, true);
        return true;
    },

    /** Move the whole scene to a new anchor. */
    move(caPlayer: CAPlayer, anchor: Pos3, degrees: Degrees, mirror: MirrorMode, pivot: PivotMode): boolean {
        const scene = scenes.get(caPlayer.xuid);
        if (scene == null) return false;
        scene.degrees = degrees;
        scene.mirror = mirror;
        scene.pivot = pivot;
        PreviewScene.rebuildIndex(scene, anchor);
        PreviewScene.refreshWindow(caPlayer.xuid, true);
        return true;
    },

    /** Window radius override for this preview (`/ca preview radius <n>`). */
    setRadius(xuid: string, radius: number): number | null {
        const scene = scenes.get(xuid);
        if (scene == null) return null;
        scene.radius = Math.min(192, Math.max(16, Math.floor(radius)));
        PreviewScene.refreshWindow(xuid, true);
        return scene.radius;
    },

    startTimer(xuid: string): void {
        const scene = scenes.get(xuid);
        if (scene == null || scene.timer != null || scene.mode === "full") return;
        scene.timer = setInterval(() => {
            const live = scenes.get(xuid);
            if (live == null) return;
            if (online(xuid) == null) {
                PreviewScene.clear(xuid);
                return;
            }
            PreviewScene.refreshWindow(xuid, false);
        }, WINDOW_TICK_MS);
    },

    /** Drop the scene and clear every cell it applied (batched, never viewClearAll). */
    clear(xuid: string): void {
        const scene = scenes.get(xuid);
        if (scene == null) return;
        scene.cancelled = true;
        scene.queue = [];
        if (scene.timer != null) {
            clearInterval(scene.timer);
            scene.timer = null;
        }
        if (scene.loadTimer != null) {
            clearTimeout(scene.loadTimer);
            scene.loadTimer = null;
        }
        scenes.delete(xuid);
        enqueueCleanup(scene.playerName, appliedCells(scene.applied));
        scene.applied.clear();
    },

    /**
     * Undo the overrides in batches.
     *
     * A task is kept while its player is offline: the library remembers overrides by player
     * name, so they can only be cleared once the player is back - retryCleanup() runs on join.
     */
    drainCleanup(): void {
        let work = batchSize();
        while (cleanups.length > 0 && work > 0) {
            const task = cleanups[0];
            if (!playerOnline(task.playerName)) return;
            while (task.cells.length > 0 && work > 0) {
                const [x, y, z] = task.cells.pop() as [number, number, number];
                BlockView.clear(task.playerName, x, y, z);
                work--;
            }
            if (task.cells.length === 0) cleanups.shift();
        }
        if (cleanups.length > 0) scheduleCleanup();
    },

    /** Hook for player join: retries overrides that could not be cleared while offline. */
    retryCleanup(): void {
        if (cleanups.length > 0) scheduleCleanup();
    },

    clearAll(): void {
        for (const xuid of [...scenes.keys()]) PreviewScene.clear(xuid);
    },

    /** Kept for /ca preview probe and /ca preview trim (item-display calibration). */
    correction(): number {
        return blockYCorrection();
    },

    /** What /ca preview info reports. */
    info(xuid: string): {
        active: boolean;
        mode: SceneMode | "-";
        total: number;
        windowCount: number;
        applied: number;
        failed: number;
        pending: number;
        radius: number;
        loading: number;
        backend: string;
    } {
        const scene = scenes.get(xuid);
        if (scene == null) {
            return {
                active: false, mode: "-", total: 0, windowCount: 0, applied: 0,
                failed: 0, pending: cleanups.length, radius: radiusDefault(), loading: 0,
                backend: PreviewScene.backend(),
            };
        }
        return {
            active: true,
            mode: scene.mode,
            total: scene.mode === "lazy" ? scene.slices.length : scene.totalSurface,
            windowCount: scene.windowCount,
            applied: scene.applied.size,
            failed: scene.failed,
            pending: scene.queue.length,
            radius: scene.radius,
            loading: scene.pending.length,
            backend: PreviewScene.backend(),
        };
    },

    /** Which renderer the preview uses (no entity fallback any more). */
    backend(): string {
        return BlockView.available() ? "viewBlock" : "不可用（缺少 HologramLib viewBlock）";
    },
};

export default PreviewScene;