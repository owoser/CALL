/**
 * The paste preview, drawn as per-client BLOCK OVERRIDES (HologramLib viewBlock).
 *
 * The previous implementation put one item display (a fake mob holding a block) on every
 * surface cell. That is what users described as "假方块随风飘扬": the carrier mob breathes and
 * idles, so the block bobs; and a few thousand of them crush the client's frame rate and hit
 * the library's actor limits, which is why a big preview also loaded only partially.
 *
 * viewBlock() replaces that: the library tells ONE client "at this cell show that block". No
 * entity, no animation, no model pose, correct light, and the cost is a block update packet.
 *
 * Rules this module keeps:
 *   - only SURFACE cells are drawn (SurfaceExtract) and the total is capped (previewMaxBlocks);
 *   - work is spread over ticks (previewBatchSize) so a big build never stalls a tick;
 *   - the scene keeps the set of cells it has applied, so rotate/move send only the DIFF and
 *     four quarter turns end with zero packets;
 *   - teardown clears exactly our own cells - never viewClearAll(), which would also drop the
 *     overrides another plugin registered for the same player;
 *   - cells of an offline player are retried when they come back (the library keeps per-player
 *     overrides by name).
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
import { PlanOp, appliedCells, diffPlacement, planCells } from "./PreviewPlan";

interface Scene {
    anchor: Pos3;
    /** Clipboard extent, needed to normalise the rotation (see Rotate.transformCell). */
    size: [number, number, number];
    /** Base (unrotated) offsets, so rotation never has to re-read the files. */
    blocks: PreviewBlock[];
    degrees: Degrees;
    mirror: MirrorMode;
    pivot: PivotMode;
    cancelled: boolean;
    playerName: string;
    visible: number;
    truncated: boolean;
    building: boolean;
    /** cell key -> block id currently shown to this player by US. */
    applied: Map<string, string>;
    /** pending set/clear operations, drained previewBatchSize per tick. */
    queue: PlanOp[];
    /** cells the client refused (block id unknown to it). */
    failed: number;
}

const scenes = new Map<string, Scene>();
/** Give up before parsing a clipboard that would obviously be too heavy. */
const MAX_CELLS = 400000;

function num(key: string, fallback: number, min: number, max: number): number {
    const raw = Number(Config.get(Config.GLOBAL, key, fallback));
    if (!Number.isFinite(raw)) return fallback;
    return Math.min(max, Math.max(min, raw));
}

/**
 * Residual vertical error of the item-display backend, in BLOCKS.
 *
 * The block-override preview does not need it (the cell IS the block), it is kept for
 * /ca preview probe and /ca preview trim, which still measure the item-display pose.
 */
export function blockYCorrection(): number {
    const raw = Number(Config.get(Config.GLOBAL, "previewBlockYCorrection", 0));
    return Number.isFinite(raw) ? raw : 0;
}

function batchSize(): number {
    return Math.floor(num("previewBatchSize", 1000, 50, 5000));
}

function maxBlocks(): number {
    return Math.floor(num("previewMaxBlocks", 8000, 200, 50000));
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
    reason?: string;
}

export const PreviewScene = {
    /** Read the clipboard and turn it into surface blocks (nothing is sent yet). */
    gather(xuid: string): {
        slices: SliceInput[];
        size?: [number, number, number];
        error?: string;
        tooBig?: boolean;
    } {
        const data = StructureService.getData(xuid) as any;
        const complex = data?.copy ?? {};
        const sids = Object.keys(complex);
        if (sids.length === 0) return { slices: [], error: "剪贴板是空的" };

        const box = clipboardBox(complex);
        if (box == null) return { slices: [], error: "剪贴板是空的" };
        const min = box.min;
        const size: [number, number, number] = [box.size.x, box.size.y, box.size.z];
        const slices: SliceInput[] = [];
        let cells = 0;

        // Mirror StructureService.load() exactly: a clipboard entry is keyed by STRUCTID and
        // holds one whole area; the files are <structid>_<ix>_<iz>, split by
        // Structure.getAreas() into MAX_LENGTH (64) chunks.
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
                    const sid = structid + "_" + ix + "_" + iz;
                    let layout;
                    try {
                        layout = parseStructureLayout(NBTService.readBytes(sid));
                    } catch (e) {
                        logger.warn("[CALL][Preview] 读取切片失败 " + sid + ": " + describeError(e));
                        continue;
                    }
                    cells += layout.size[0] * layout.size[1] * layout.size[2];
                    if (cells > MAX_CELLS) return { slices: [], tooBig: true };

                    const chunk = row[iz];
                    slices.push({ origin: [chunk.start.x, chunk.start.y, chunk.start.z], layout });
                }
            }
        }

        if (slices.length === 0) return { slices: [], error: "切片文件读取失败" };
        return { slices, size };
    },
    /**
     * Build (or rebuild) the preview for a player.
     *
     * Returns after the first batch; the rest is sent over the following ticks with a progress
     * tip, so a big build never stalls a tick.
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

        const gathered = PreviewScene.gather(xuid);
        if (gathered.slices.length === 0) {
            return {
                ok: false, blocks: 0, visible: 0, truncated: false,
                reason: gathered.tooBig ? "区域太大，无法生成方块预览（可调 previewMaxBlocks）" : (gathered.error ?? "无法读取剪贴板"),
            };
        }

        // Base (unrotated) extraction: the transform is applied when planning cells, so
        // rotating a live scene never re-reads the slice files.
        const extracted = extractSurface(gathered.slices, 0, "none", maxBlocks());
        if (extracted.blocks.length === 0) {
            return { ok: false, blocks: 0, visible: 0, truncated: false, reason: "选区里没有可显示的方块" };
        }

        const scene: Scene = {
            anchor,
            size: gathered.size ?? [1, 1, 1],
            blocks: extracted.blocks,
            degrees,
            mirror,
            pivot,
            cancelled: false,
            playerName: realName,
            visible: extracted.visible,
            truncated: extracted.truncated,
            building: true,
            applied: new Map(),
            queue: [],
            failed: 0,
        };
        scenes.set(xuid, scene);
        PreviewScene.plan(xuid);
        PreviewScene.pump(xuid);

        return { ok: true, blocks: extracted.blocks.length, visible: extracted.visible, truncated: extracted.truncated };
    },

    /** Recompute the wanted cells and queue only the difference against what is applied. */
    plan(xuid: string): void {
        const scene = scenes.get(xuid);
        if (scene == null) return;
        const desired = planCells(scene.anchor, scene.size, scene.degrees, scene.mirror, scene.pivot, scene.blocks);
        const ops = diffPlacement(scene.applied, desired);
        if (ops.length > 0) scene.queue.push(...ops);
        scene.failed = 0;
        scene.building = scene.queue.length > 0;
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
            if (done >= per * 5) tip(xuid, "生成预览 " + scene.applied.size + "/" + scene.blocks.length);
            setTimeout(() => PreviewScene.pump(xuid), 0);
            return;
        }

        scene.building = false;
        const parts = [scene.applied.size + " 个方块"];
        if (scene.truncated) parts.push("已按上限截断（可见 " + scene.visible + " 个）");
        if (scene.failed > 0) parts.push(scene.failed + " 个显示不了（客户端不认识该方块）");
        tip(xuid, "预览就绪：" + parts.join("，"));
    },

    /** Rotate / mirror / switch pivot in place: only the difference is re-sent. */
    rotate(caPlayer: CAPlayer, degrees: Degrees, mirror: MirrorMode, pivot: PivotMode): boolean {
        const scene = scenes.get(caPlayer.xuid);
        if (scene == null) return false;
        scene.degrees = degrees;
        scene.mirror = mirror;
        scene.pivot = pivot;
        PreviewScene.plan(caPlayer.xuid);
        PreviewScene.pump(caPlayer.xuid);
        return true;
    },

    /** Move the whole scene to a new anchor (same diff logic). */
    move(caPlayer: CAPlayer, anchor: Pos3, degrees: Degrees, mirror: MirrorMode, pivot: PivotMode): boolean {
        const scene = scenes.get(caPlayer.xuid);
        if (scene == null) return false;
        scene.anchor = anchor;
        scene.degrees = degrees;
        scene.mirror = mirror;
        scene.pivot = pivot;
        PreviewScene.plan(caPlayer.xuid);
        PreviewScene.pump(caPlayer.xuid);
        return true;
    },

    /** Drop the scene and clear every cell it applied (batched, never viewClearAll). */
    clear(xuid: string): void {
        const scene = scenes.get(xuid);
        if (scene == null) return;
        scene.cancelled = true;
        scene.queue = [];
        scenes.delete(xuid);
        enqueueCleanup(scene.playerName, appliedCells(scene.applied));
        scene.applied.clear();
    },

    /**
     * Undo the overrides in batches.
     *
     * A task is kept while its player is offline: the library remembers overrides by player
     * name, so clearing them before they reconnect is not possible - retryCleanup() runs on
     * join and picks the task up again.
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
        blocks: number;
        building: boolean;
        truncated: boolean;
        applied: number;
        failed: number;
        pending: number;
        backend: string;
    } {
        const scene = scenes.get(xuid);
        if (scene == null) {
            return { active: false, blocks: 0, building: false, truncated: false, applied: 0, failed: 0, pending: cleanups.length, backend: PreviewScene.backend() };
        }
        return {
            active: true,
            blocks: scene.blocks.length,
            building: scene.building,
            truncated: scene.truncated,
            applied: scene.applied.size,
            failed: scene.failed,
            pending: scene.queue.length,
            backend: PreviewScene.backend(),
        };
    },

    /** Which renderer the preview uses (there is no entity fallback any more). */
    backend(): string {
        return BlockView.available() ? "viewBlock" : "不可用（缺少 HologramLib viewBlock）";
    },
};

export default PreviewScene;
