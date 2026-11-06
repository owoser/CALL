import Config from "../common/Config";
import { Pos3 } from "../common/Pos3";
import CAPlayer from "../user/CAPlayer";
import NBTService from "./NBTService";
import StructureService from "./StructureService";
import { parseStructureLayout } from "../io/NbtCodec";
import { extractSurface, PreviewBlock, SliceInput } from "./SurfaceExtract";
import { Degrees, MirrorMode, transformOffset } from "./Rotate";
import { applyYCorrection, clipboardMin } from "./Clipboard";
import Area3 from "../common/Area3";
import { Structure } from "../common/Structure";
import ItemDisplay from "../holo/ItemDisplay";
import { MsgType, online, tell } from "../util/Msg";
import StrFactory from "../util/StrFactory";
import { describeError } from "../util/Safe";

/**
 * The fake-block preview scene: one item display per visible block.
 *
 * Design constraints that shaped this:
 *   - one display per block is expensive, so only SURFACE blocks are drawn (SurfaceExtract)
 *     and the total is capped (previewMaxBlocks);
 *   - creation is spread over several ticks (previewBatchSize) so a big paste never freezes
 *     the server for a second;
 *   - rotating moves the existing displays instead of rebuilding them;
 *   - only the previewing player sees them (itemDisplaySetVisiblePlayer);
 *   - teardown destroys our ids one by one and NEVER calls itemDisplayDestroyAll(), which
 *     would also wipe displays belonging to other plugins.
 */

interface Scene {
    anchor: Pos3;
    /** Base (unrotated) offsets, so rotation never has to re-read the files. */
    blocks: PreviewBlock[];
    ids: number[];
    degrees: Degrees;
    mirror: MirrorMode;
    cancelled: boolean;
    playerName: string;
    visible: number;
    truncated: boolean;
    building: boolean;
}

const scenes = new Map<string, Scene>();
/** Give up before parsing a clipboard that would obviously be too heavy. */
const MAX_CELLS = 400000;

function num(key: string, fallback: number, min: number, max: number): number {
    const raw = Number(Config.get(Config.GLOBAL, key, fallback));
    if (!Number.isFinite(raw)) return fallback;
    return Math.min(max, Math.max(min, raw));
}

function blockScale(): string {
    const raw = Config.get(Config.GLOBAL, "previewBlockScale", "0.5");
    return raw == null || raw === "" ? "0.5" : String(raw);
}

/**
 * offY in MODEL units (16 units = 1 block), NOT in blocks.
 * The documented block-mode pose is "-4"; see HologramLib's item-display docs.
 */
function blockOffsetY(): string {
    const raw = Config.get(Config.GLOBAL, "previewBlockOffsetY", "0");
    return raw == null || String(raw) === "" ? "0" : String(raw);
}

/**
 * Residual vertical error, in BLOCKS (not model units).
 *
 * Measured with /ca preview probe instead of guessed: whatever cell the probe block lands in
 * becomes -N here, which is a unit we fully understand.
 */
export function blockYCorrection(): number {
    const raw = Number(Config.get(Config.GLOBAL, "previewBlockYCorrection", 0));
    return Number.isFinite(raw) ? raw : 0;
}

function viewDistance(): number {
    return num("previewViewDistance", 64, 16, 256);
}

function batchSize(): number {
    return Math.floor(num("previewBatchSize", 200, 50, 1000));
}

function maxBlocks(): number {
    return Math.floor(num("previewMaxBlocks", 2000, 200, 20000));
}

/** World position of a block centre under the current transform. */
function worldPos(anchor: Pos3, block: PreviewBlock, degrees: Degrees, mirror: MirrorMode): [number, number, number] {
    const [dx, dz] = transformOffset(block.dx, block.dz, degrees, mirror);
    return [
        anchor.x + dx + 0.5,
        // bottom centre: y is the block's own level, offY/measured correction lift the model
        applyYCorrection(anchor.y + block.dy, blockYCorrection()),
        anchor.z + dz + 0.5,
    ];
}

function tip(xuid: string, text: string, error = false): void {
    const player = online(xuid);
    if (player == null) return;
    tell(player, error ? StrFactory.cmdErr(text) : StrFactory.cmdMsg(text), MsgType.TIP);
}

export interface BuildResult {
    ok: boolean;
    blocks: number;
    visible: number;
    truncated: boolean;
    reason?: string;
}

export const PreviewScene = {
    /** Read the clipboard and turn it into surface blocks (no displays yet). */
    gather(xuid: string): { slices: SliceInput[]; error?: string; tooBig?: boolean } {
        const data = StructureService.getData(xuid) as any;
        const complex = data?.copy ?? {};
        const sids = Object.keys(complex);
        if (sids.length === 0) return { slices: [], error: "剪贴板是空的" };

        const min = clipboardMin(complex);
        const slices: SliceInput[] = [];
        let cells = 0;

        // Mirror StructureService.load() exactly: a clipboard entry is keyed by STRUCTID and
        // holds one whole area; the actual files are <structid>_<ix>_<iz>, split by
        // Structure.getAreas() into MAX_LENGTH (64) chunks. Reading <structid>.mcstructure
        // simply does not exist - that was the load.missingFile warning.
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
        return { slices };
    },

    /**
     * Build (or rebuild) the preview for a player.
     *
     * Returns immediately after the first batch: the rest is created over the following
     * ticks, and a progress tip tells the player how far along it is.
     */
    build(caPlayer: CAPlayer, anchor: Pos3, degrees: Degrees, mirror: MirrorMode): BuildResult {
        const xuid = caPlayer.xuid;
        PreviewScene.clear(xuid);

        if (!ItemDisplay.available()) {
            return { ok: false, blocks: 0, visible: 0, truncated: false, reason: "HologramLib 不可用" };
        }

        const gathered = PreviewScene.gather(xuid);
        if (gathered.slices.length === 0) {
            return {
                ok: false, blocks: 0, visible: 0, truncated: false,
                reason: gathered.tooBig ? "区域太大，无法生成方块预览（可调 previewBatchSize/previewMaxBlocks）" : (gathered.error ?? "无法读取剪贴板"),
            };
        }

        // Base (unrotated) extraction: rotation is applied when positioning, so rotating a
        // live scene never has to re-read the slice files.
        const extracted = extractSurface(gathered.slices, 0, "none", maxBlocks());
        if (extracted.blocks.length === 0) {
            return { ok: false, blocks: 0, visible: 0, truncated: false, reason: "选区里没有可显示的方块" };
        }

        const scene: Scene = {
            anchor,
            blocks: extracted.blocks,
            ids: [],
            degrees,
            mirror,
            cancelled: false,
            playerName: String(caPlayer.$.realName ?? ""),
            visible: extracted.visible,
            truncated: extracted.truncated,
            building: true,
        };
        scenes.set(xuid, scene);
        PreviewScene.pump(xuid);

        return { ok: true, blocks: extracted.blocks.length, visible: extracted.visible, truncated: extracted.truncated };
    },

    /** Create the next batch, then yield to the server for a tick. */
    pump(xuid: string): void {
        const scene = scenes.get(xuid);
        if (scene == null || scene.cancelled) return;

        const perTick = batchSize();
        const dim = scene.anchor.dimid;
        const scale = blockScale();
        const dist = viewDistance();
        const end = Math.min(scene.blocks.length, scene.ids.length + perTick);

        for (let i = scene.ids.length; i < end; i++) {
            const block = scene.blocks[i];
            const [x, y, z] = worldPos(scene.anchor, block, scene.degrees, scene.mirror);
            const id = ItemDisplay.create({
                x, y, z, dim,
                blockId: block.id,
                scale,
                offsetY: blockOffsetY(),
                rotY: scene.degrees,
                viewDistance: dist,
                onlyPlayer: scene.playerName,
            });
            scene.ids.push(id > 0 ? id : 0);
        }

        if (scene.ids.length < scene.blocks.length) {
            const done = scene.ids.length;
            const total = scene.blocks.length;
            if (done % (perTick * 5) === 0 || done === total) {
                tip(xuid, "生成预览 " + done + "/" + total);
            }
            setTimeout(() => PreviewScene.pump(xuid), 0);
            return;
        }

        scene.building = false;
        tip(
            xuid,
            "预览就绪：" + scene.blocks.length + " 个方块" +
            (scene.truncated ? "（已按上限截断，实际可见 " + scene.visible + " 个）" : "")
        );
    },

    /** Rotate / mirror the live scene by moving the existing displays. */
    rotate(caPlayer: CAPlayer, degrees: Degrees, mirror: MirrorMode): boolean {
        const scene = scenes.get(caPlayer.xuid);
        if (scene == null) return false;
        scene.degrees = degrees;
        scene.mirror = mirror;

        for (let i = 0; i < scene.ids.length; i++) {
            const id = scene.ids[i];
            if (!(id > 0)) continue;
            const [x, y, z] = worldPos(scene.anchor, scene.blocks[i], degrees, mirror);
            ItemDisplay.move(id, x, y, z, degrees);
        }
        return true;
    },

    /** Move the whole scene to a new anchor. */
    move(caPlayer: CAPlayer, anchor: Pos3, degrees: Degrees, mirror: MirrorMode): boolean {
        const scene = scenes.get(caPlayer.xuid);
        if (scene == null) return false;
        scene.anchor = anchor;
        scene.degrees = degrees;
        scene.mirror = mirror;

        for (let i = 0; i < scene.ids.length; i++) {
            const id = scene.ids[i];
            if (!(id > 0)) continue;
            const [x, y, z] = worldPos(scene.anchor, scene.blocks[i], degrees, mirror);
            ItemDisplay.move(id, x, y, z, degrees);
        }
        return true;
    },

    /** Destroy every display of one player's scene. */
    clear(xuid: string): void {
        const scene = scenes.get(xuid);
        if (scene == null) return;
        scene.cancelled = true;
        scenes.delete(xuid);
        try {
            ItemDisplay.destroyAll(scene.ids.filter((id) => id > 0));
        } catch (e) {
            logger.warn("[CALL][Preview] 清理失败: " + describeError(e));
        }
    },

    clearAll(): void {
        for (const xuid of [...scenes.keys()]) PreviewScene.clear(xuid);
    },

    info(xuid: string): { active: boolean; blocks: number; building: boolean; truncated: boolean } {
        const scene = scenes.get(xuid);
        if (scene == null) return { active: false, blocks: 0, building: false, truncated: false };
        return { active: true, blocks: scene.blocks.length, building: scene.building, truncated: scene.truncated };
    },
};

export default PreviewScene;
