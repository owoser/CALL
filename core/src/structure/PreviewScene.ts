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
import HoloCompat from "../holo/HoloCompat";
import { FakeBlocks, packCells, PACK_MAX_BYTES } from "../holo/FakeBlocks";
import BatchSender, { TICK_MS } from "./BatchSender";
import { canInheritLedger, shouldWaitForDrain } from "./CleanupGate";
import { dimensionOf } from "../common/Dimension";
import NearBlocks from "../holo/NearBlocks";
import { NearCandidate, selectNearCells } from "./NearWindow";
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
    /** Owner, so the per-cell pump can be scheduled from inside submitSets. */
    xuid: string;
    anchor: Pos3;
    size: [number, number, number];
    degrees: Degrees;
    mirror: MirrorMode;
    pivot: PivotMode;
    playerName: string;
    /** Dimension of the player when the preview started (needed to read the real block). */
    dimid: number;
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
    /** Cells that carry block-entity data (kept for diagnostics). */
    beCells: Set<string>;
    /** Cells currently replaced by a passable sulfur cube, with the cube's display id. */
    nearCubes: Map<string, { id: number; x: number; y: number; z: number }>;
    /** How each drawn cell must be re-sent when its cube goes away (states / block entity). */
    cellPayload: Map<string, { id: string; blockSnbt?: string; snbt?: string }>;
    /** Payload of the cells whose cube is currently active (kept until they are restored). */
    nearPayload: Map<string, { id: string; blockSnbt?: string; snbt?: string }>;
    /** Near-switch (walk-through) bookkeeping. */
    nearWindow: number;
    nearKey: string;
    nearAt: number;
    nearDropped: number;
    nearRegistrations: number;
    nearPos: { x: number; y: number; z: number } | null;
    /** Block-granularity key of the last ENTER scan (see syncNear). */
    nearScanKey: string;
    /** Bumped whenever the desired content changes - part of the near throttle key. */
    contentVersion: number;
    /** Block entity payloads accepted / refused-or-over-budget for this preview. */
    entitiesSent: number;
    entitiesDropped: number;
    /** State-carrying / block-entity cells taken out of the batch and drawn per cell. */
    cellQueued: number;
    /** Entries the library did not see in a payload we packed (argument truncation tripwire). */
    truncated: number;
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
const debugEnabled = () => {
    try {
        return Config.get(Config.GLOBAL, "debugMod", false) === true;
    } catch {
        return false;
    }
};
const batchPerTick = () => Math.floor(num("previewBatchPerTick", 6, 2, 8));
const resendSeconds = () => Math.floor(num("previewResendSeconds", 45, 0, 120));
const queueMax = () => Math.floor(num("previewBatchQueueMax", 24, 0, 128));
/**
 * Draw the cells a batch cannot express: body first (SNBT when the entry has states, the state
 * string otherwise), then the block entity payload. One write per cell.
 *
 * Why not let the batch draw them: the batch only carries a state STRING, which the library
 * resolves by block NAME (base states), and a batch over `previewBatchImmediate` drains over
 * several ticks - so an immediate correction sent right after it gets overwritten. Different
 * cells means that race cannot happen at all.
 */
function drawCells(scene: Scene, ops: PlanOp[]): void {
    for (const op of ops) {
        if (op.op !== "set") continue;
        const id = String((op as any).id ?? "");
        const body = op.blockSnbt != null && op.blockSnbt !== ""
            ? BlockView.setBlockNbt(scene.playerName, op.x, op.y, op.z, op.blockSnbt)
            : BlockView.set(scene.playerName, op.x, op.y, op.z, id);
        if (!body) {
            scene.failed++;
            continue;
        }
        markSet(scene, op.key, op.x, op.y, op.z, id);
        scene.cellPayload.set(op.key, {
            id,
            ...(op.blockSnbt != null && op.blockSnbt !== "" ? { blockSnbt: op.blockSnbt } : {}),
            ...(op.snbt != null && op.snbt !== "" ? { snbt: op.snbt } : {}),
        });
        scene.cellQueued++;
        if (op.snbt != null && op.snbt !== "") {
            // Kept so the near-switch never picks this cell: leaving the radius re-sends the bare
            // block and the block entity (chest contents, sign text) would be wiped on the client.
            scene.beCells.add(op.key);
            if (BlockView.setBlockEntity(scene.playerName, op.x, op.y, op.z, op.snbt)) scene.entitiesSent++;
            else scene.entitiesDropped++;
        }
    }
}

/** Walk-through window radius (0 = feature off). */
const nearRadius = () => Math.floor(num("previewNearRadius", 5, 0, 16));
/** Cells one registration may carry. */
const nearMaxCells = () => Math.floor(num("previewNearCells", 512, 64, 2048));
/** Keep the cube invisible (the block looks unchanged but is passable). */
const nearInvisible = () => String(Config.get(Config.GLOBAL, "previewNearInvisible", true)).toLowerCase() !== "false";
/** Extra vertical offset in BLOCKS (0 = the model is centred in its cell). Fine tuning only. */
const nearYOffset = () => {
    const value = Number(Config.get(Config.GLOBAL, "previewNearYOffset", 0));
    return Number.isFinite(value) && value >= -1 && value <= 1 ? value : 0;
};
/** Size of the walk-through cube; 1 = normal (the library's own default). */
const nearScale = () => {
    const value = Number(Config.get(Config.GLOBAL, "previewNearScale", 1));
    return Number.isFinite(value) && value >= 0.0625 && value <= 10 ? value : 1;
};

/** "minecraft:oak_stairs[direction=2,...]" -> "minecraft:oak_stairs" (the cube holds the block item). */
function blockItemOf(id: string): string {
    const text = String(id ?? "");
    const at = text.indexOf("[");
    return at > 0 ? text.slice(0, at) : text;
}

/** Dimension the scene lives in (the player must be in it for a near window to make sense). */
function sourceDim(scene: Scene): number {
    return scene.dimid;
}

/** Draw block entities (banner patterns, sign text, chests) on top of the fake blocks. */
const blockEntityOn = () => String(Config.get(Config.GLOBAL, "previewBlockEntity", "true")).toLowerCase() !== "false";
/** How many block entity payloads one preview may push (they are per-cell packets). */
const blockEntityMax = () => Math.floor(num("previewBlockEntityMax", 64, 0, 512));

/**
 * Push the block entity payloads of just-applied cells.
 *
 * The block body must already be on the client - the library ignores a BlockActorData packet for
 * a cell it does not know - so this runs AFTER the set for those cells, and only when the
 * installed library exports `blockFakeSetBlockEntity` (450-export surface: 26.60.8 / 26.51.11).
 * The budget is per preview: banners and signs are rare, a 64 cap keeps a village worth of them
 * visible without turning every pump into a packet storm.
 */
function pushEntities(scene: Scene, ops: PlanOp[]): void {
    if (!blockEntityOn()) return;
    const cap = blockEntityMax();
    if (cap <= 0) return;
    if (!HoloCompat.status().caps.fakeEntity) return;
    for (const op of ops) {
        if (op.op !== "set" || op.snbt == null || op.snbt === "") continue;
        if (scene.entitiesSent >= cap) {
            scene.entitiesDropped++;
            continue;
        }
        if (BlockView.setBlockEntity(scene.playerName, op.x, op.y, op.z, op.snbt)) scene.entitiesSent++;
        else scene.entitiesDropped++;
    }
}

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
interface CleanupTask {
    playerName: string;
    cells: Array<[number, number, number]>;
    dimid: number;
    /**
     * Wait for HologramLib's own batch queue to drain before restoring.
     *
     * A cancelled preview can still have queued batches; restoring first and letting those land
     * afterwards draws the fake blocks straight back - the "cancel left half a structure" report.
     */
    waitForDrain?: boolean;
    /** 0 = first restore, 1 = the follow-up pass that catches an already in-flight packet. */
    passes?: number;
    /** Wall-clock limit for the drain wait (a stuck queue must not block cancelling forever). */
    deadline?: number;
}
const cleanups: CleanupTask[] = [];

/** Counters for /ca tools debug: how the last cancels actually went. */
const teardownStats = { tasks: 0, cells: 0, waited: 0, passes: 0, deadlineHits: 0, failed: 0, carried: 0, skipped: 0, direct: 0 };

/** How long a cancel may wait for the library queue to drain before restoring anyway. */
const DRAIN_WAIT_MS = 3000;
/** Upper bound for one scene's "ever drawn" set (see `enqueue`). */
const EVER_APPLIED_MAX = 200000;
let cleanupTimer: ReturnType<typeof setTimeout> | null = null;

function scheduleCleanup(): void {
    if (cleanupTimer != null) return;
    cleanupTimer = setTimeout(() => {
        cleanupTimer = null;
        PreviewScene.drainCleanup();
    }, 0);
}

function enqueueCleanup(
    playerName: string,
    cells: Array<[number, number, number]>,
    dimid = 0,
    options: { waitForDrain?: boolean } = {}
): void {
    if (cells.length === 0) return;
    const task: CleanupTask = { playerName, cells, dimid, passes: 0 };
    if (options.waitForDrain === true) {
        task.waitForDrain = true;
        task.deadline = Date.now() + DRAIN_WAIT_MS;
    }
    cleanups.push(task);
    teardownStats.tasks++;
    teardownStats.cells += cells.length;
    scheduleCleanup();
}

/** Drop pending cleanup tasks for one player (their scene is being rebuilt right now). */
function discardCleanup(playerName: string): void {
    for (let i = cleanups.length - 1; i >= 0; i--) {
        if (cleanups[i].playerName === playerName) cleanups.splice(i, 1);
    }
}

/**
 * Drop only the cells the inherited ledger already covers.
 *
 * A rebuild inherits the previous scene's ledger, so those cells are still tracked and will be
 * cleared by the next teardown - dropping their pending task is safe and stops it punching holes
 * into the new scene. Tasks holding cells that are NOT inherited keep running, because nothing else
 * remembers them (that omission is what left pieces of a nudged preview on the client).
 */
function discardCleanupCovered(playerName: string, covered: Map<string, [number, number, number]>): void {
    if (covered.size === 0) return;
    for (let i = cleanups.length - 1; i >= 0; i--) {
        const task = cleanups[i];
        if (task.playerName !== playerName) continue;
        const left: Array<[number, number, number]> = [];
        for (const cell of task.cells) {
            if (!covered.has(cell[0] + "," + cell[1] + "," + cell[2])) left.push(cell);
        }
        if (left.length === 0) cleanups.splice(i, 1);
        else task.cells = left;
    }
}

/**
 * Detach a scene WITHOUT sending anything, handing its ledger over.
 *
 * A rebuild must not tear the old scene down (that is what discarded the old cells and produced
 * residue after a nudge); it inherits what the client is already showing and diffs against it.
 */
function detachScene(xuid: string): { ledger: GhostLedger; dimid: number; playerName: string } | null {
    const scene = scenes.get(xuid);
    if (scene == null) return null;
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
    try {
        BatchSender.cancelOwner("preview:" + xuid);
    } catch {
        // best effort
    }
    // Walk-through registration: the library destroys the active sulfur cubes here. Without this a
    // player who cancels while standing inside the preview would keep the cubes on their client.
    if (scene.nearCubes.size > 0) {
        try {
            NearBlocks.clearAll(Array.from(scene.nearCubes.values()).map((c) => c.id));
        } catch { /* cosmetic */ }
        scene.nearCubes.clear();
        scene.nearPayload.clear();
        scene.nearWindow = 0;
    }
    scenes.delete(xuid);
    return {
        ledger: { applied: scene.applied, stale: scene.stale, everApplied: scene.everApplied },
        dimid: scene.dimid,
        playerName: scene.playerName,
    };
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
        // Player objects carry NO dimid (only IntPos/FloatPos do) - see common/Dimension.ts.
        const dimid = dimensionOf(caPlayer);

        // A rebuild INHERITS the previous scene's ledger instead of tearing it down.
        //
        // The old code cleared here and started from an empty ledger, while also discarding the
        // pending teardown so it could not punch holes into the new scene. Cells of the previous
        // footprint that were no longer part of the plan then had nobody left to clear them: after a
        // nudge or a rotate the preview left pieces of itself behind, and the final cancel only knew
        // about the last scene's cells (measured: 1719 cells cleaned out of ~9000 drawn).
        const previous = detachScene(xuid);
        let carried: GhostLedger | null = null;
        if (previous != null) {
            if (canInheritLedger({ playerName: previous.playerName, dimid: previous.dimid },
                { playerName: realName, dimid })) {
                carried = previous.ledger;
                discardCleanupCovered(realName, carried.everApplied);
                teardownStats.carried += carried.applied.size;
            } else {
                // A different dimension or player cannot inherit: those cells can only be restored.
                enqueueCleanup(previous.playerName, [...previous.ledger.everApplied.values()], previous.dimid, { waitForDrain: true });
                discardCleanup(realName);
            }
        }
        /** Hand the inherited cells to the cleanup queue when this build cannot go on. */
        const giveUp = (result: BuildResult): BuildResult => {
            if (carried != null && carried.everApplied.size > 0 && realName !== "") {
                enqueueCleanup(realName, [...carried.everApplied.values()], dimid, { waitForDrain: true });
            }
            return result;
        };

        if (!BlockView.available()) {
            return giveUp({
                ok: false, blocks: 0, visible: 0, truncated: false,
                reason: "需要 HologramLib 的方块覆盖接口（blockFakeSet，或旧版 viewBlock）",
            });
        }

        if (realName === "") {
            return giveUp({ ok: false, blocks: 0, visible: 0, truncated: false, reason: "无法解析玩家名" });
        }

        const info = PreviewScene.gatherInfo(xuid);
        if (info.error != null) {
            return giveUp({ ok: false, blocks: 0, visible: 0, truncated: false, reason: info.error });
        }

        const scene: Scene = {
            xuid,
            anchor,
            size: info.size,
            degrees,
            mirror,
            pivot,
            playerName: realName,
            dimid,
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
            applied: carried?.applied ?? new Map(),
            stale: carried?.stale ?? new Map(),
            everApplied: carried?.everApplied ?? new Map(),
            resendRequested: false,
            resendAt: 0,
            resends: 0,
            batches: 0,
            batchCells: 0,
            batchFallbacks: 0,
            batchRejected: 0,
            batchSkipped: 0,
            entitiesSent: 0,
            entitiesDropped: 0,
            cellQueued: 0,
            truncated: 0,
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
            beCells: new Set<string>(),
            nearCubes: new Map<string, { id: number; x: number; y: number; z: number }>(),
            cellPayload: new Map<string, { id: string; blockSnbt?: string; snbt?: string }>(),
            nearPayload: new Map<string, { id: string; blockSnbt?: string; snbt?: string }>(),
            nearWindow: 0,
            nearKey: "",
            nearAt: 0,
            nearDropped: 0,
            nearRegistrations: 0,
            nearPos: null,
            nearScanKey: "",
            contentVersion: 0,
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

    /**
     * Register the cells around the player as "walk-through".
     *
     * The library replaces the WHOLE set per call and destroys the active cubes while doing it, so
     * this is throttled hard: only when the player moved more than radius/2 (or crossed a block),
     * when the scene changed, or when the feature was just switched on.
     */
    syncNear(scene: Scene): void {
        const radius = nearRadius();
        if (radius <= 0 || !NearBlocks.available()) return;
        if (scene.cancelled) return;

        const player = online(scene.xuid);
        if (player == null) return;
        let px = 0, py = 0, pz = 0, pdim = 0;
        try {
            px = Number(player.pos.x);
            py = Number(player.pos.y);
            pz = Number(player.pos.z);
            pdim = Number(player.pos.dimid);
        } catch {
            return;
        }
        if (!Number.isFinite(px) || !Number.isFinite(py) || !Number.isFinite(pz)) return;
        if (sourceDim(scene) !== pdim) return;

        const leaveR = radius * 1.3;
        const nearSq = radius * radius;
        const leaveSq = leaveR * leaveR;

        // 1) LEAVE: a cube whose cell is now far away is destroyed and the real fake block is
        //    re-sent through the ORIGINAL path, so states and block entities come back intact.
        if (scene.nearCubes.size > 0) {
            for (const [key, cube] of scene.nearCubes) {
                const dx = px - (cube.x + 0.5);
                const dy = py - cube.y;
                const dz = pz - (cube.z + 0.5);
                if (dx * dx + dy * dy + dz * dz <= leaveSq) continue;
                NearBlocks.leave(cube.id);
                scene.nearCubes.delete(key);
                PreviewScene.redrawCell(scene, key, cube.x, cube.y, cube.z);
            }
        }

        // 2) ENTER: nearest cells inside the radius, capped, one cube each.
        //    Only when the player crossed a block boundary or the scene changed: the candidate scan
        //    walks every applied cell, and that can be tens of thousands.
        const scanKey = Math.floor(px) + "," + Math.floor(py) + "," + Math.floor(pz) + "|" + scene.contentVersion;
        if (scene.nearScanKey === scanKey) return;
        scene.nearScanKey = scanKey;
        const room = nearMaxCells() - scene.nearCubes.size;
        if (room <= 0) return;
        const candidates: NearCandidate[] = [];
        for (const [key, id] of scene.applied) {
            if (String(id) === "" || scene.nearCubes.has(key)) continue;
            const pos = scene.everApplied.get(key);
            if (pos == null) continue;
            candidates.push({ key, x: pos[0], y: pos[1], z: pos[2], id: String(id) });
        }
        const picked = selectNearCells(candidates, { x: px, y: py, z: pz }, {
            radius,
            maxCells: room,
            maxBytes: Number.MAX_SAFE_INTEGER,   // the cubes are created one by one, no payload cap
            allowStates: true,                   // our own restore path keeps the states intact
        });
        scene.nearDropped = picked.dropped;
        for (const cell of picked.cells) {
            const info = scene.cellPayload.get(cell.key);
            const blockItem = blockItemOf(String(cell.id));
            const id = NearBlocks.enter(scene.playerName, cell.x, cell.y, cell.z, scene.dimid,
                blockItem, nearInvisible(), nearScale(), nearYOffset());
            if (id > 0) {
                scene.nearCubes.set(cell.key, { id, x: cell.x, y: cell.y, z: cell.z });
                scene.nearRegistrations++;
                if (info != null) scene.nearPayload.set(cell.key, info);
            }
        }
        scene.nearWindow = scene.nearCubes.size;
        scene.nearKey = [scene.anchor.x, scene.anchor.y, scene.anchor.z, scene.degrees, scene.mirror,
            scene.pivot, scene.contentVersion].join("|");
        scene.nearPos = { x: px, y: py, z: pz };
        scene.nearAt = Date.now();
    },

    /**
     * Re-send one cell exactly the way it was drawn before it became a cube.
     *
     * Plain cells go through the per-cell path (which is what the ledger already restored anyway);
     * stateful and block-entity cells carry their payload here, which is the whole reason the library
     * batch route could not be used for them.
     */
    redrawCell(scene: Scene, key: string, x: number, y: number, z: number): void {
        const info = scene.cellPayload.get(key) ?? scene.nearPayload.get(key);
        if (info == null) return;
        try {
            if (info.blockSnbt != null && info.blockSnbt !== "") {
                BlockView.setBlockNbt(scene.playerName, x, y, z, info.blockSnbt);
            } else if (info.id !== "") {
                BlockView.set(scene.playerName, x, y, z, info.id);
            }
            if (info.snbt != null && info.snbt !== "") {
                BlockView.setBlockEntity(scene.playerName, x, y, z, info.snbt);
            }
        } catch {
            // cosmetic
        }
        scene.nearPayload.delete(key);
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
        const chunk = Math.floor(center.x / 16) + "," + Math.floor(center.z / 16) + "," + String(scene.dimid);
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
        scene.contentVersion++;
        // SAFETY NET: every cell this plan wants on screen goes into `everApplied`, whether or not
        // its packet is later confirmed. Teardown restores that union, so a cell that some draw
        // path forgot to mark can never become a permanent ghost - restoring a cell that already
        // shows the real block is a no-op packet.
        for (const [key, cell] of desired) {
            if (String(cell.id ?? "") === "") continue;
            scene.everApplied.set(key, [cell.x, cell.y, cell.z]);
        }
        // Long sessions keep adding footprints (cleared cells stay here on purpose). Bound it: a
        // preview that walked over 200k cells can drop the oldest safely - the ones most likely
        // gone from the client anyway.
        if (scene.everApplied.size > EVER_APPLIED_MAX) {
            const drop = scene.everApplied.size - EVER_APPLIED_MAX;
            let dropped = 0;
            for (const key of scene.everApplied.keys()) {
                scene.everApplied.delete(key);
                if (++dropped >= drop) break;
            }
        }

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

        // ORDER: clears before sets. diffPlacement emits sets first, so a big move used to draw
        // the new window (12 chunks of sets) before restoring the old one ("先清理再移动" - the
        // library author's rule). Restores must reach the client before the cells they touch are
        // re-drawn, otherwise the pending set wins and the old blocks stay on screen.
        const clears: PlanOp[] = [];
        const sets: PlanOp[] = [];
        for (const op of ops) {
            if (op.op === "clear") clears.push(op);
            else sets.push(op);
        }
        scene.queue = clears.concat(sets);
        if (scene.queue.length > 0) scene.failed = 0;
        scene.building = scene.queue.length > 0;
        if (scene.queue.length > 0 || scene.stale.size > 0) PreviewScene.pump(xuid);
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
            BatchSender.request(() => PreviewScene.pump(xuid), "preview:" + xuid);
            return;
        }

        if (scene.queue.length === 0) {
            scene.building = false;
            try { PreviewScene.syncNear(scene); } catch { /* cosmetic */ }
            return;
        }

        // Do not pile batches onto a library queue that is already deep: the client would be
        // flooded and individual packets could be dropped, which is how ghosts survive.
        const stats = FakeBlocks.stats();
        const maxQueue = queueMax();
        if (stats != null && maxQueue > 0 && stats.queue > maxQueue) {
            BatchSender.configure(batchPerTick());
            BatchSender.request(() => PreviewScene.pump(xuid), "preview:" + xuid);
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
            BatchSender.request(() => PreviewScene.pump(xuid), "preview:" + xuid);
            return;
        }
        scene.building = false;
        PreviewScene.logBurst(scene);
        // The queue just finished: this is the cheapest moment to (re)register the walk-through
        // window, and the throttle inside syncNear keeps it from happening every tick.
        try { PreviewScene.syncNear(scene); } catch { /* cosmetic */ }
    },

    /**
     * One batched set; falls back to per-cell drawing when the library refuses the payload.
     *
     * Cells that carry block STATES or a block entity are deliberately kept OUT of the batch:
     *
     *   - the batch can only carry a state string, and the library resolves that string by block
     *     NAME (measured: stairs dir 2 and dir 0 return the same network id), so those cells would
     *     be drawn with base states anyway;
     *   - a queued batch (over `previewBatchImmediate`, default 256) drains over several ticks,
     *     so an immediate `blockFakeSetNbt`/`blockFakeSetBlockEntity` sent right after it gets
     *     OVERWRITTEN by the batch - that is exactly the "states accepted but still default
     *     orientation" and "block entity payload accepted but still black" pair;
     *   - per-cell drawing is not more expensive here: the cell is written once instead of twice.
     */
    submitSets(scene: Scene, ops: PlanOp[], immediate: boolean): void {
        const cellOps = ops.filter((op) => op.op === "set" && (op.blockSnbt != null || op.snbt != null));
        if (cellOps.length > 0) drawCells(scene, cellOps);
        const batchable = cellOps.length === 0 ? ops : ops.filter((op) => cellOps.indexOf(op) < 0);
        if (batchable.length === 0) return;
        const cells = batchable.map((op) => ({ x: op.x, y: op.y, z: op.z, id: String((op as any).id ?? "") }));
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
            for (const op of batchable) {
                const id = String((op as any).id ?? "");
                markSet(scene, op.key, op.x, op.y, op.z, id);
                scene.cellPayload.set(op.key, { id });
            }
            scene.batches++;
            scene.batchCells += batchable.length;
            if (debugEnabled()) {
                // Same tripwire as the restore: if the library sees fewer entries than we packed,
                // the tail of the string was cut by the argument limit and those cells will never
                // appear (the old "preview has a hole" report).
                let expected = 0;
                let parsed = 0;
                for (const segment of packed.segments) {
                    expected += segment.split(";").length;
                    const report = FakeBlocks.selfTest(segment);
                    if (report != null) parsed += Number((/changes=(\d+)/.exec(report) || [])[1] ?? 0);
                }
                if (parsed < expected) {
                    scene.truncated += expected - parsed;
                    logger.warn("[CALL][preview] 预览载荷被截断: 打包 " + expected + " 条，库只解析 " +
                        parsed + " 条（段=" + packed.segments.length + "）");
                }
            }
            return;
        }

        // Rejected (all states unparsable / player gone) or everything was skipped: fall back
        // per cell so the window still appears, and say which case it was in the counters.
        if (packed.segments.length === 0) scene.batchSkipped += 0;
        else scene.batchRejected++;
        scene.batchFallbacks++;
        for (const op of batchable) {
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
        // A clear is "send the block the world has here". The library's own clear paths report
        // failure for reasons we cannot see (they validate each body and only count packets that
        // went out), and a failed clear is a permanent ghost, so the restore goes through the set
        // path - the one that demonstrably reaches the client.
        const positions: Array<[number, number, number]> = ops.map((op) => [op.x, op.y, op.z]);
        const restored = FakeBlocks.restore(scene.playerName, positions, scene.dimid);
        if (restored >= ops.length) {
            for (const op of ops) markCleared(scene, op.key);
            scene.batches++;
            scene.batchCells += ops.length;
            return;
        }

        // Cells whose chunk the server does not have cannot be restored yet: owe them.
        const byKey = new Map<string, PlanOp>();
        for (const op of ops) byKey.set(op.key, op);
        let kept = 0;
        for (const op of ops) {
            const pos = byKey.get(op.key)!;
            let alive = false;
            try {
                alive = mc.getBlock(pos.x, pos.y, pos.z, scene.dimid as 0 | 1 | 2) != null;
            } catch {
                alive = false;
            }
            if (alive && kept < restored) {
                markCleared(scene, op.key);
                kept++;
            } else {
                markOwed(scene, op.key, op.x, op.y, op.z);
            }
        }
        if (kept > 0) {
            scene.batches++;
            scene.batchCells += kept;
        }
        if (kept < ops.length) scene.batchFallbacks++;
    },

    /**
     * Per-burst counter line - `debugMod` only.
     *
     * It was unconditional and a normal preview session prints one per second, which is noise on a
     * production console. The counters are still kept (they drive nothing else) and the line appears
     * as soon as `debugMod` is on, which is when somebody actually wants them.
     */
    logBurst(scene: Scene): void {
        const now = Date.now();
        if (scene.batches === 0 || now - scene.batchLogAt < 1000) return;
        scene.batchLogAt = now;
        try {
            if (Config.get(Config.GLOBAL, "debugMod", false) !== true) {
                scene.logBatches = scene.batches;
                scene.logCells = scene.batchCells;
                return;
            }
        } catch {
            return;
        }
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
        const applied: PlanOp[] = [];
        while (scene.queue.length > 0 && done < per) {
            const op = scene.queue.shift() as PlanOp;
            if (op.op === "set") {
                // State-carrying cells are drawn from SNBT (the only resolver that honours states);
                // the rest keep the state-string path. Both are one write per cell.
                const ok = op.blockSnbt != null && op.blockSnbt !== ""
                    ? BlockView.setBlockNbt(scene.playerName, op.x, op.y, op.z, op.blockSnbt)
                    : BlockView.set(scene.playerName, op.x, op.y, op.z, op.id);
                if (ok) {
                    scene.applied.set(op.key, op.id);
                    applied.push(op);
                } else scene.failed++;
            } else {
                BlockView.clear(scene.playerName, op.x, op.y, op.z);
                scene.applied.delete(op.key);
            }
            done++;
            if ((done & 31) === 0 && Date.now() >= deadline) break;
        }
        pushEntities(scene, applied);

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
        if (scene == null || scene.timer != null) return;
        // EVERY mode needs this ticker, not only window/lazy: the walk-through window has to follow
        // the player, and a "full" preview used to register it once and never again (the reported
        // "only near the drop point does it turn into entities").
        scene.timer = setInterval(() => {
            const live = scenes.get(xuid);
            if (live == null) return;
            if (online(xuid) == null) {
                PreviewScene.clear(xuid);
                return;
            }
            try { PreviewScene.syncNear(live); } catch { /* cosmetic */ }
            if (live.mode !== "full") PreviewScene.refreshWindow(xuid, false);
        }, WINDOW_TICK_MS);
    },

    /** Drop the scene and clear every cell it applied (batched, never viewClearAll). */
    clear(xuid: string): void {
        // detachScene stops the timers and the queued pump jobs before anything is restored - a
        // job that runs after the restore would draw the fake blocks right back. It also returns
        // the ledger, which now carries every cell the scene ever drew (inherited across rebuilds
        // included), so a cancel cleans the WHOLE preview instead of just the last footprint.
        const detached = detachScene(xuid);
        if (detached == null) return;
        const ledger = detached.ledger;
        const cells = teardownCells(ledger);
        if (debugEnabled()) {
            logger.info("[CALL][preview] 取消: applied=" + ledger.applied.size + " stale=" + ledger.stale.size +
                " ever=" + ledger.everApplied.size + " 清理=" + cells.length + " 队列=" +
                (BatchSender.pendingOf("preview:" + xuid)) + " 库队列=" + (FakeBlocks.stats()?.queue ?? -1));
        }
        resetLedger(ledger as any);

        // Restore through the deferred path: it waits for the library's own queue to drain and
        // repeats the restore once, so a packet already in flight cannot survive.
        enqueueCleanup(detached.playerName, cells, detached.dimid, { waitForDrain: true });
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

            // Do not restore while the library still has batches queued: those would land after
            // our restore and put the fake blocks back on screen.
            if (task.waitForDrain === true) {
                const stats = FakeBlocks.stats();
                const gate = shouldWaitForDrain({
                    queued: stats == null ? 0 : Number(stats.queue ?? 0),
                    deadline: task.deadline ?? null,
                    now: Date.now(),
                });
                if (gate.wait) {
                    teardownStats.waited++;
                    scheduleCleanup();
                    return;
                }
                if (gate.expired) teardownStats.deadlineHits++;
            }

            // Fake blocks are restored with the SAME mechanism that drew them (a client-side
            // block update), not with viewClearBlock - that only reverts viewBlock overrides.
            if (batchingAvailable()) {
                // Exact positions, not a count: cells whose block cannot be read are skipped, and
                // the old slice(count) then dropped the WRONG cells while reporting success - a
                // residue that looked like a clean teardown.
                const before = debugEnabled() ? FakeBlocks.stats() : null;
                const result = FakeBlocks.restoreDetailed(task.playerName, task.cells, task.dimid,
                    { probe: debugEnabled() });
                if (debugEnabled() && before != null) {
                    const after = FakeBlocks.stats();
                    const dDropped = after == null ? -1 : after.dropped - before.dropped;
                    const dBad = after == null ? -1 : after.bad - before.bad;
                    if ((result.truncated ?? 0) > 0) {
                        logger.warn("[CALL][preview] 还原载荷被截断: " + result.truncated +
                            " 条没进库（检查 PACK_MAX_BYTES 是否仍低于参数上限）");
                    }
                    logger.info("[CALL][preview] 还原: 请求=" + task.cells.length +
                        " 可读=" + result.restored.length + " 不可读=" + result.skipped.length +
                        " 段=" + ((result.probe ?? []).length || "?") +
                        " 库丢包+" + dDropped + " 库坏项+" + dBad +
                        ((result.probe ?? []).length > 0 ? " selfTest: " + result.probe!.join(" | ") : ""));
                }
                if (result.restored.length + result.skipped.length < task.cells.length) {
                    const done = new Set(result.restored.concat(result.skipped as any).map((c: any) => c[0] + "," + c[1] + "," + c[2]));
                    task.cells = task.cells.filter((c) => !done.has(c[0] + "," + c[1] + "," + c[2]));
                    teardownStats.failed += task.cells.length;
                    work--;
                    continue;
                }
                if (result.direct.length > 0) {
                    // The packed format cannot carry these (a ';' inside the descriptor): send the
                    // real block one cell at a time, otherwise they keep the fake block forever.
                    let sent = 0;
                    for (const cell of result.direct) {
                        if (BlockView.set(task.playerName, cell.x, cell.y, cell.z, cell.id)) sent++;
                    }
                    teardownStats.direct += sent;
                    if (sent < result.direct.length) teardownStats.failed += result.direct.length - sent;
                }
                if (result.skipped.length > 0) {
                    // The chunk is gone / the block cannot be read: nothing left to restore there.
                    teardownStats.skipped += result.skipped.length;
                    if (result.restored.length === 0 && task.cells.length > 0) {
                        // NOTHING could be read: almost always the wrong DIMENSION (a Player has no
                        // dimid; only positions do) or an unloaded chunk. Say it out loud.
                        const sample = result.skipped.slice(0, 3).map((c) => c.join(",")).join(" / ");
                        logger.error("[CALL][preview] 还原一格都没读到: 维度=" + task.dimid +
                            " 请求=" + task.cells.length + " 未加载=" + (result.unloaded ?? 0) +
                            " 解析失败=" + (result.failed ?? 0) + " 样例=" + sample);
                    }
                }
                // A full restore still can be followed by a packet that was already in flight:
                // one extra pass on a later tick closes that window (idempotent - it re-sends the
                // real blocks).
                if (task.waitForDrain === true && (task.passes ?? 0) === 0) {
                    task.passes = 1;
                    teardownStats.passes++;
                    cleanups.shift();
                    cleanups.push(task);
                    if (cleanupTimer != null) {
                        clearTimeout(cleanupTimer);
                        cleanupTimer = null;
                    }
                    cleanupTimer = setTimeout(() => {
                        cleanupTimer = null;
                        PreviewScene.drainCleanup();
                    }, TICK_MS * 2);
                    return;
                }
                cleanups.shift();
                continue;
            }
            while (task.cells.length > 0 && work > 0) {
                const [x, y, z] = task.cells.pop() as [number, number, number];
                BlockView.clear(task.playerName, x, y, z);
                work--;
            }
            if (task.cells.length === 0) cleanups.shift();
        }
        if (cleanups.length > 0) scheduleCleanup();
    },

    /** Teardown bookkeeping for /ca tools debug (how many cancels had to wait / repeat). */
    teardownReport(): string {
        return "取消清理: 待处理 " + cleanups.length + " 条 · 累计 " + teardownStats.tasks + " 次/" +
            teardownStats.cells + " 格 · 等队列 " + teardownStats.waited + " 次 · 二次还原 " +
            teardownStats.passes + " 次 · 超时放行 " + teardownStats.deadlineHits + " · 失败 " +
            teardownStats.failed + " 格 · 单格补发 " + teardownStats.direct + " 格 · 不可读 " +
            teardownStats.skipped + " 格 · 继承 " + teardownStats.carried + " 格" +
            (BatchSender.pending() > 0 ? " · 发送队列 " + BatchSender.pending() : "");
    },

    /** Dimension/mode of the live scene (tests: the scene must use the player's real dimension). */
    activeScene(xuid: string): { dimid: number; mode: SceneMode; applied: number } | null {
        const scene = scenes.get(xuid);
        if (scene == null) return null;
        return { dimid: scene.dimid, mode: scene.mode, applied: scene.applied.size };
    },

    /** Pending teardown tasks (tests: a cancel must end with zero). */
    pendingTeardowns(): number {
        return cleanups.length;
    },

    /**
     * Resolve once the preview's cleanup has actually reached the client.
     *
     * A paste that starts while the teardown packets are still in flight is a race the client
     * loses: the restore carries the block the WORLD had when it was read (pre-paste), so it lands
     * on top of freshly pasted cells and the structure looks half-missing until a relog reloads the
     * chunk. Both the deferred tasks AND the library queue have to be empty for the window to be
     * closed, which is why this waits on both.
     */
    flushCleanup(timeoutMs = 5000): Promise<{ ok: boolean; waitedMs: number; tasks: number; queue: number }> {
        const startedAt = Date.now();
        const deadline = startedAt + Math.max(0, timeoutMs);
        return new Promise((resolve) => {
            const step = () => {
                const stats = FakeBlocks.stats();
                const queue = stats == null ? 0 : Number(stats.queue ?? 0);
                const tasks = cleanups.length;
                if ((tasks === 0 && queue === 0) || Date.now() >= deadline) {
                    resolve({ ok: tasks === 0 && queue === 0, waitedMs: Date.now() - startedAt, tasks, queue });
                    return;
                }
                setTimeout(step, TICK_MS);
            };
            step();
        });
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

    /**
     * One real `blockSnbt` from the live scene (null when the preview has none).
     *
     * This is the probe for "our SNBT formatter vs the library's resolver": if
     * `blockFakeResolveNbt(sample)` equals the bare-name id, the states in OUR string are not being
     * accepted (a type problem), and no amount of ordering fixes will help.
     */
    /**
     * Block entity census for the live scene, preferring a BANNER sample.
     *
     * The previous version returned the first payload whatever it was - in practice a chest - and
     * the debug line then judged that chest by banner rules, printing a meaningless "missing
     * colour". A banner sample plus explicit counts is what makes the answer readable.
     */
    sampleBlockEntity(xuid: string): { snbt: string; be: number; banners: number; patterned: number; isBanner: boolean } | null {
        const scene = scenes.get(xuid);
        if (scene == null) return null;
        let be = 0, banners = 0, patterned = 0;
        let firstAny: string | null = null;
        let firstBanner: string | null = null;
        for (const block of scene.blocks) {
            const snbt = block.snbt;
            if (snbt == null || snbt === "") continue;
            be++;
            if (firstAny == null) firstAny = snbt;
            if (/"(id|identifier)"\s*:\s*"[^"]*banner"/i.test(snbt)) {
                banners++;
                if (/"(Patterns|patterns)"/.test(snbt)) patterned++;
                if (firstBanner == null) firstBanner = snbt;
            }
        }
        const pick = firstBanner ?? firstAny;
        if (pick == null) return null;
        return { snbt: pick, be, banners, patterned, isBanner: firstBanner != null };
    },

    sampleStateSnbt(xuid: string): string | null {
        const scene = scenes.get(xuid);
        if (scene == null) return null;
        for (const block of scene.blocks) {
            if (block.blockSnbt != null && block.blockSnbt !== "") return block.blockSnbt;
        }
        return null;
    },

    /** Counters that make a "hole" or a leftover explainable: what the preview dropped and why. */
    diagnostics(xuid: string): string {
        const scene = scenes.get(xuid);
        if (scene == null) return "预览: 无活动场景";
        return "预览计数: mode=" + scene.mode +
            " 批量=" + scene.batches + "/" + scene.batchCells + "格 回退=" + scene.batchFallbacks +
            " 拒绝=" + scene.batchRejected + " 编码跳过=" + scene.batchSkipped +
            " 逐格=" + scene.cellQueued + " 截断=" + scene.truncated +
            " 实体=" + scene.entitiesSent + " 丢弃=" + scene.entitiesDropped +
            " 失败=" + scene.failed;
    },

    /** Which renderer the preview uses (no entity fallback any more). */
    backend(): string {
        const kind = BlockView.backend();
        if (kind === "none") return "不可用（缺少 HologramLib 方块覆盖接口）";
        const batched = batchingAvailable();
        if (kind === "blockFake") return batched ? "blockFake+batch" : "blockFake";
        return batched ? "viewBlock+batch（方块状态会丢失）" : "viewBlock（方块状态会丢失）";
    },
};

export default PreviewScene;