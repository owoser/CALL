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
import { FakeBlocks, packCells } from "../holo/FakeBlocks";
import BatchSender from "./BatchSender";
import { GhostLedger, markCleared, markOwed, markSet, resetLedger, takeOwed, teardownCells } from "./GhostLedger";
import { MsgType, online, tell } from "../util/Msg";
import StrFactory from "../util/StrFactory";
import { describeError } from "../util/Safe";
import {
    PlanOp,
    PlannedCell,
    SourceGrid,
    appliedCells,
    diffPlacement,
    planCells,
    sampleOutline,
    sourceGrid,
    untransformCell,
    windowFromSource,
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

interface Scene extends GhostLedger {
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
    /** full / window: surface blocks bucketed by CLIPBOARD column (transform-free). */
    grid: SourceGrid | null;
    /** window: coarse shell drawn outside the budget. */
    outline: PlannedCell[];

    /** lazy: slice index + per-slice grids + LRU order + parse backlog. */
    slices: SliceRef[];
    sliceGrids: Map<string, SourceGrid>;
    sliceOrder: string[];
    pending: SliceRef[];
    /** clipboard-space box the window covered last time (used to keep those slices cached) */
    windowBox: { minX: number; maxX: number; minZ: number; maxZ: number } | null;

    applied: Map<string, string>;
    /**
     * Cells removed from `applied` whose clear we could NOT confirm - retried on later pumps.
     *
     * Without this a failed clear silently became a permanent ghost on the client (fake blocks
     * only disappear when the client reloads the chunk or receives the restore packet).
     */
    stale: Map<string, [number, number, number]>;
    /** Everything this scene ever put on the client - the belt-and-braces set for teardown. */
    everApplied: Map<string, [number, number, number]>;
    /** A client chunk reload wiped our cells: re-send the window WITHOUT forgetting the map. */
    resendRequested: boolean;
    /** Last additive re-send (rate limit). */
    resendAt: number;
    resends: number;
    queue: PlanOp[];
    failed: number;
    building: boolean;

    /** Batched submissions (blockBatchSet / blockBatchClear) and the cells they carried. */
    batches: number;
    batchCells: number;
    /** Chunks that had to fall back to per-cell viewBlock / viewClearBlock. */
    batchFallbacks: number;
    /** Batched sets the library refused (-1) and cells the encoder had to drop. */
    batchRejected: number;
    batchSkipped: number;
    /** Last chunk boundary log (one INFO line per burst, not per tick). */
    batchLogAt: number;
    /** Counters as of the last log line, so the log shows this burst's delta. */
    logBatches: number;
    logCells: number;
    /** Chunk the player stood in at the last refresh, for the client-reload re-send. */
    lastChunk: string | null;
    /** When the window was last re-sent from scratch (heartbeat / chunk change). */
    lastResendAt: number;

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

/** `previewBatchMode`: "auto" uses blockBatch* when the library has it, "off" forces per-cell. */
const batchMode = () => String(Config.get(Config.GLOBAL, "previewBatchMode", "auto") ?? "auto").toLowerCase();
const batchCells = () => Math.floor(num("previewBatchCells", 1024, 128, 4096));
const batchImmediate = () => Math.floor(num("previewBatchImmediate", 256, 0, 1024));
const batchTimeout = () => Math.floor(num("previewBatchTimeoutMs", 5000, 1000, 15000));
const batchPerTick = () => Math.floor(num("previewBatchPerTick", 6, 2, 8));
const resendSeconds = () => Math.floor(num("previewResendSeconds", 45, 0, 120));
const queueMax = () => Math.floor(num("previewBatchQueueMax", 24, 0, 128));

/** Should this send go through the batch API? */
export function batchingAvailable(): boolean {
    try {
        return batchMode() !== "off" && FakeBlocks.available();
    } catch {
        return false;
    }
}
const radiusDefault = () => Math.floor(num("previewRadius", 48, 16, 192));
const updateDistance = () => Math.floor(num("previewUpdateDistance", 8, 2, 32));
const maxCells = () => Math.floor(num("previewMaxCells", 800000, 40000, 4000000));
const sliceCacheSize = () => Math.floor(num("previewSliceCache", 8, 2, 64));
const prefetchAmount = () => Math.floor(num("previewPrefetch", 16, 0, 64));
const outlineEnabled = () => Config.get(Config.GLOBAL, "previewOutline", true) !== false;
const outlineStep = () => Math.floor(num("previewOutlineStep", 8, 2, 32));
/** Milliseconds one pump round may spend calling viewBlock. */
const tickBudgetMs = () => Math.floor(num("previewTickBudgetMs", 8, 2, 20));
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

/** Drop pending cleanup tasks for one player (their scene is being rebuilt right now). */
function discardCleanup(playerName: string): void {
    for (let i = cleanups.length - 1; i >= 0; i--) {
        if (cleanups[i].playerName === playerName) cleanups.splice(i, 1);
    }
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
        const realName = String(caPlayer.$?.realName ?? "");
        // A rebuild must not race the previous scene's teardown: those cleanup tasks restore
        // the real blocks and would punch holes into the cells we are about to draw.
        if (realName !== "") discardCleanup(realName);
        PreviewScene.clear(xuid);

        if (!BlockView.available()) {
            return {
                ok: false, blocks: 0, visible: 0, truncated: false,
                reason: "需要 HologramLib 的 viewBlock 接口（1.30.0 / LL 26.51.4 起）",
            };
        }

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
            windowBox: null,
            applied: new Map(),
            stale: new Map(),
            everApplied: new Map(),
            resendRequested: false,
            resendAt: 0,
            resends: 0,
            batches: 0,
            batchCells: 0,
            batchFallbacks: 0,
            batchRejected: 0,
            batchSkipped: 0,
            batchLogAt: 0,
            logBatches: 0,
            logCells: 0,
            lastChunk: null,
            lastResendAt: 0,
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
        scene.grid = sourceGrid(extracted.blocks);
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

        // Fake blocks live on the CLIENT: a chunk reload (walking away and back, a teleport,
        // a dimension change) restores the real blocks while our map still says "applied".
        // A full re-send is cheap now (one call per 1024 cells), so do it when the player
        // crosses a chunk boundary or the heartbeat comes due.
        PreviewScene.maybeResend(scene, center, player);

        const forward = forwardAxis(player);
        const amount = prefetchAmount();
        const prefetch = amount > 0 ? { dx: forward.dx, dz: forward.dz, amount } : undefined;

        if (scene.mode === "lazy") PreviewScene.ensureSlices(xuid, center);

        const grids: SourceGrid[] = scene.mode === "lazy"
            ? [...scene.sliceGrids.values()]
            : (scene.grid != null ? [scene.grid] : []);
        const res = windowFromSource(grids, {
            anchor: scene.anchor,
            size: scene.size,
            degrees: scene.degrees,
            mirror: scene.mirror,
            pivot: scene.pivot,
            center,
            radius: scene.radius,
            budget: budget(),
            prefetch,
        });
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

    /**
     * Force a full re-send of the window when the client may have dropped our cells.
     *
     * Two triggers: the player entered a different chunk (its chunk data gets re-sent, which
     * resets every client-side block change), and the `previewResendSeconds` heartbeat. Huge
     * windows are skipped so a 200k-cell scene cannot flush itself every few seconds.
     */
    maybeResend(scene: Scene, center: { x: number; y: number; z: number }, player: any): void {
        const chunk = Math.floor(center.x / 16) + "," + Math.floor(center.z / 16) + "," + String(player?.dimid ?? 0);
        const changed = scene.lastChunk != null && scene.lastChunk !== chunk;
        scene.lastChunk = chunk;

        const now = Date.now();
        const seconds = resendSeconds();
        const due = seconds > 0 && now - scene.lastResendAt > seconds * 1000;
        if (!changed && !due) return;

        // A chunk reload wipes fake blocks, so we re-send - ADDITIVELY. `applied` must stay
        // truthful: clearing it (what this did before) forgot every cell that left the window,
        // so those cells were never cleared again and stayed on the client until a relog, while
        // the whole window was re-sent on every chunk crossing (the "1,000,000 cells" log).
        if (scene.applied.size > 30000) return;      // huge windows rely on the client's own reload
        if (now - scene.resendAt < 1500) return;     // at most one additive re-send per 1.5 s
        scene.resendAt = now;
        scene.lastResendAt = now;
        scene.resendRequested = true;
        scene.resends++;
    },
    /**
     * Diff + REPLACE the queue + pump.
     *
     * Replacing (not appending) is what keeps rapid rotations cheap: the queue is only ever a
     * plan to reach the LATEST desired state, computed against what has actually been sent, so
     * ten clicks in a row cost one plan instead of ten.
     */
    enqueue(xuid: string, desired: Map<string, PlannedCell>): void {
        const scene = scenes.get(xuid);
        if (scene == null) return;
        const ops = diffPlacement(scene.applied, desired);

        // Additive re-send: the same cells again (idempotent), leaving `applied` correct.
        if (scene.resendRequested) {
            scene.resendRequested = false;
            for (const [key, cell] of desired) {
                const id = String(cell.id ?? "");
                if (id === "") continue;
                ops.push({ op: "set", key, x: cell.x, y: cell.y, z: cell.z, id });
            }
        }

        // Old clears that never got confirmed go first, so a ghost cannot outlive an update.
        for (const [key, pos] of scene.stale) {
            ops.unshift({ op: "clear", key, x: pos[0], y: pos[1], z: pos[2] });
        }
        scene.stale.clear();

        scene.queue = ops;
        if (ops.length > 0) scene.failed = 0;
        scene.building = ops.length > 0;
        if (ops.length > 0 || scene.stale.size > 0) PreviewScene.pump(xuid);
    },

    /**
     * Send the next chunk of the queue.
     *
     * With the batch API a chunk is ONE call carrying up to `previewBatchCells` cells, which the
     * library merges into sub-chunk packets - 12,000 cells used to be 12,000 native calls and
     * 12,000 packets, now it is 12 calls and 12 packets. The first chunk of a burst is submitted
     * synchronously (instant feedback), the rest are paced by BatchSender so the library's global
     * 8-packets-per-tick budget is shared instead of monopolised.
     */
    pump(xuid: string): void {
        const scene = scenes.get(xuid);
        if (scene == null || scene.cancelled) return;
        if (!batchingAvailable()) {
            PreviewScene.pumpLegacy(xuid);
            return;
        }

        // Owed clears first: a cell whose restore never went out must not be forgotten.
        if (scene.stale.size > 0) {
            const owed: PlanOp[] = takeOwed(scene, batchCells()).map((entry) => ({
                op: "clear" as const,
                key: entry.key,
                x: entry.pos[0],
                y: entry.pos[1],
                z: entry.pos[2],
            }));
            PreviewScene.submitClears(scene, owed);
            BatchSender.configure(batchPerTick());
            BatchSender.request(() => PreviewScene.pump(xuid));
            return;
        }

        if (scene.queue.length === 0) {
            scene.building = false;
            return;
        }

        // Do not pile batches onto a library queue that is already deep: the client would be
        // flooded and individual packets could be dropped, which is how ghosts survive.
        const stats = FakeBlocks.stats();
        const maxQueue = queueMax();
        if (stats != null && maxQueue > 0 && stats.queue > maxQueue) {
            BatchSender.configure(batchPerTick());
            BatchSender.request(() => PreviewScene.pump(xuid));
            return;
        }

        const chunk = scene.queue.splice(0, batchCells());
        const clears: PlanOp[] = [];
        const sets: PlanOp[] = [];
        for (const op of chunk) {
            if (op.op === "set") sets.push(op);
            else clears.push(op);
        }

        // Clears first: they only touch cells the new plan no longer wants.
        if (clears.length > 0) PreviewScene.submitClears(scene, clears);
        if (sets.length > 0) {
            const immediate = scene.queue.length === 0 && sets.length <= batchImmediate();
            PreviewScene.submitSets(scene, sets, immediate);
        }

        if (scene.queue.length > 0) {
            BatchSender.configure(batchPerTick());
            BatchSender.request(() => PreviewScene.pump(xuid));
            return;
        }
        scene.building = false;
        PreviewScene.logBurst(scene);
    },

    /** One batched set; falls back to per-cell viewBlock when the library refuses the payload. */
    submitSets(scene: Scene, ops: PlanOp[], immediate: boolean): void {
        const cells = ops.map((op) => ({ x: op.x, y: op.y, z: op.z, id: String((op as any).id ?? "") }));
        const packed = packCells(cells);
        if (packed.skipped > 0) scene.batchSkipped += packed.skipped;

        let accepted = packed.segments.length > 0;
        for (const segment of packed.segments) {
            if (FakeBlocks.set(scene.playerName, segment, immediate) < 0) {
                accepted = false;
                break;
            }
        }

        if (accepted) {
            for (const op of ops) markSet(scene, op.key, op.x, op.y, op.z, String((op as any).id ?? ""));
            scene.batches++;
            scene.batchCells += ops.length;
            return;
        }

        // Rejected (all states unparsable / player gone) or everything was skipped: fall back
        // per cell so the window still appears, and say which case it was in the counters.
        if (packed.segments.length === 0) scene.batchSkipped += 0;
        else scene.batchRejected++;
        scene.batchFallbacks++;
        for (const op of ops) {
            const id = String((op as any).id ?? "");
            if (BlockView.set(scene.playerName, op.x, op.y, op.z, id)) {
                markSet(scene, op.key, op.x, op.y, op.z, id);
            } else {
                scene.failed++;
            }
        }
    },

    /** One batched clear (restores the real blocks); per-cell fallback on refusal. */
    submitClears(scene: Scene, ops: PlanOp[]): void {
        const positions: Array<[number, number, number]> = ops.map((op) => [op.x, op.y, op.z]);
        if (FakeBlocks.clear(scene.playerName, positions)) {
            for (const op of ops) markCleared(scene, op.key);
            scene.batches++;
            scene.batchCells += ops.length;
            return;
        }
        // Could not confirm: keep them as owed work instead of pretending they are gone.
        scene.batchFallbacks++;
        for (const op of ops) markOwed(scene, op.key, op.x, op.y, op.z);
    },

    /** One INFO line per drained burst (never per tick), for evidence in the log. */
    logBurst(scene: Scene): void {
        const now = Date.now();
        if (scene.batches === 0 || now - scene.batchLogAt < 1000) return;
        scene.batchLogAt = now;
        const batches = scene.batches - scene.logBatches;
        const cells = scene.batchCells - scene.logCells;
        scene.logBatches = scene.batches;
        scene.logCells = scene.batchCells;
        try {
            const stats = FakeBlocks.stats();
            logger.info("[CALL][preview] +" + batches + " 批 / +" + cells + " 格"
                + (stats != null ? "（库队列 " + stats.queue + " 包）" : "")
                + (scene.resends > 0 ? " 重发 " + scene.resends : "")
                + (scene.batchFallbacks > 0 ? " 回退 " + scene.batchFallbacks : "")
                + (scene.batchRejected > 0 ? " 被拒 " + scene.batchRejected : "")
                + (scene.batchSkipped > 0 ? " 跳过 " + scene.batchSkipped : "")
                + (scene.stale.size > 0 ? " 欠清 " + scene.stale.size : ""));
        } catch {
            // logging must never break a preview
        }
    },
    /** The pre-batch path: one native call (and one packet) per cell, time-boxed. */
    pumpLegacy(xuid: string): void {
        const scene = scenes.get(xuid);
        if (scene == null || scene.cancelled) return;

        // Time budget instead of a fixed count: viewBlock is a native call plus one block
        // update per cell, and its cost varies a lot between machines. Sending as many as fit
        // in `previewTickBudgetMs` keeps a round short even on a slow host, and makes a fast
        // host drain the queue in far fewer rounds.
        const per = batchSize();
        const deadline = Date.now() + tickBudgetMs();
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
            if ((done & 31) === 0 && Date.now() >= deadline) break;
        }

        if (scene.queue.length > 0) {
            setTimeout(() => PreviewScene.pumpLegacy(xuid), 0);
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

        scene.windowBox = { minX, maxX, minZ, maxZ };

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
            scene.sliceGrids.set(ref.key, sourceGrid(extracted.blocks));
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
                if (PreviewScene.sliceInUse(scene, key)) continue;
                scene.sliceGrids.delete(key);
                scene.sliceOrder.splice(i, 1);
                removed = true;
                break;
            }
            if (!removed) return;
        }
    },

    /** Keep a cached slice while it can still contribute to the window. */
    sliceInUse(scene: Scene, key: string): boolean {
        const box = scene.windowBox;
        if (box == null) return false;
        const ref = scene.slices.find((s) => s.key === key);
        if (ref == null) return false;
        if (ref.x0 > box.maxX || ref.x0 + ref.w - 1 < box.minX) return false;
        if (ref.z0 > box.maxZ || ref.z0 + ref.d - 1 < box.minZ) return false;
        return true;
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
        // The index is clipboard-side, so a rotation does NOT rebuild it - only the outline
        // (which is drawn in world coordinates) has to be recomputed.
        scene.outline = scene.mode === "window" && outlineEnabled()
            ? sampleOutline(
                scene.blocks, scene.anchor, scene.size, scene.degrees, scene.mirror, scene.pivot,
                outlineStep(), OUTLINE_CAP
            )
            : [];
    },

    /**
     * Can the existing scene simply be moved to a new anchor?
     *
     * Rebuilding tears the old scene down and its cleanup runs asynchronously, which is what
     * used to punch holes into a freshly moved preview. Moving diffs against the applied cells
     * instead - but only when the clipboard behind the scene is still the same one.
     */
    canMove(xuid: string): boolean {
        const scene = scenes.get(xuid);
        if (scene == null) return false;
        const info = PreviewScene.gatherInfo(xuid);
        if (info.error != null) return false;
        const before = scene.slices.map((s) => s.sid).join("|");
        const now = info.slices.map((s) => s.sid).join("|");
        return before === now;
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

        // The union of everything this scene ever drew: `applied` alone is not enough, because a
        // clear that could not be confirmed moved its cell to `stale`, and an older drift could
        // have left cells that only `everApplied` still remembers.
        const cells = teardownCells(scene);
        resetLedger(scene);

        if (cells.length > 0 && batchingAvailable() && FakeBlocks.clear(scene.playerName, cells)) {
            scene.batches++;
            scene.batchCells += cells.length;
            return;
        }
        enqueueCleanup(scene.playerName, cells);
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
        batches: number;
        batchCells: number;
        batchFallbacks: number;
        stale: number;
        resends: number;
        immediate: boolean;
        libQueue: number;
    } {
        const scene = scenes.get(xuid);
        if (scene == null) {
            return {
                active: false, mode: "-", total: 0, windowCount: 0, applied: 0,
                failed: 0, pending: cleanups.length, radius: radiusDefault(), loading: 0,
                backend: PreviewScene.backend(),
                batches: 0, batchCells: 0, batchFallbacks: 0, stale: 0, resends: 0,
                immediate: false, libQueue: 0,
            };
        }
        const stats = FakeBlocks.stats();
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
            batches: scene.batches,
            batchCells: scene.batchCells,
            batchFallbacks: scene.batchFallbacks,
            stale: scene.stale.size,
            resends: scene.resends,
            immediate: batchingAvailable(),
            libQueue: stats != null ? stats.queue : 0,
        };
    },

    /** Which renderer the preview uses (no entity fallback any more). */
    backend(): string {
        if (!BlockView.available()) return "不可用（缺少 HologramLib viewBlock）";
        return batchingAvailable() ? "viewBlock+batch" : "viewBlock";
    },
};

export default PreviewScene;