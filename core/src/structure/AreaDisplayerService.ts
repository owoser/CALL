import * as fs from "fs";
import Constant from "../temp/Constant";
import Area3 from "../common/Area3";
import Paths from "../common/Paths";
import CAPlayer from "../user/CAPlayer";
import { Pos3 } from "../common/Pos3";
import { Warn } from "../util/Error";
import StrFactory from "../util/StrFactory";
import Tr from "../util/Translator";
import Config from "../common/Config";
import { MsgType, tell, online } from "../util/Msg";
import { describeError, safeCall } from "../util/Safe";

/**
 * Draws the player's selection.
 *
 * WHY THIS WAS REWRITTEN
 * ----------------------
 * Up to 1.6.1 the only way CALL showed a selection was to *overwrite world blocks*:
 * it placed a `minecraft:structure_block` somewhere above the build, wrote bounding-box
 * tags into the block entity, and kept the original block NBT in an in-memory Map.
 * That had three consequences:
 *   - a crash, a `ll reload` or an exception mid-restore left the structure block in
 *     the world permanently, and it was never put back;
 *   - the "somewhere above the build" scan could land inside someone else's structure;
 *   - a malformed block-entity tag is exactly the kind of thing a client chokes on,
 *     and it was the leading suspect for players being dropped.
 *
 * The default is now `particle`: a non-destructive box outline. The old behaviour is
 * still available via `areaDisplayMode: "structure_block"`, but it is hardened (validated
 * reads, journaled to disk so a crash can be recovered, restored on unload).
 *
 * Modes (`areaDisplayMode` in userdata/config/configs.json):
 *   particle        - default; particle outline, no world writes ever
 *   text            - only the action-bar size hint, no world writes
 *   structure_block - legacy block swap (journaled + restorable)
 *   off             - no visual at all (the `/ca ar show on` hint still works)
 */

export type AreaDisplayMode = "particle" | "text" | "structure_block" | "off";

interface StructureBlockRecord {
    /** Where the display block was placed. */
    x: number;
    y: number;
    z: number;
    dimid: number;
    /** SNBT of the block we displaced, so it can be restored after a crash. */
    blockNbt: string | null;
    blockEntityNbt: string | null;
}

interface DisplayState {
    mode: AreaDisplayMode;
    /** Non-null sentinel: AreaOperation uses `displayPos != null` as "already shown". */
    anchor: Pos3 | null;
    /** Last rendered area, to avoid redrawing identical boxes. */
    signature: string;
    lastRender: number;
    record: StructureBlockRecord | null;
}

const JOURNAL_PATH = () => Paths.join("userdata", "data", "area_display.json");

/**
 * Crash journal for the legacy block-swap mode.
 * Plain fs on purpose: JsonConfigFile caches values in memory, so a journal written
 * by a process that then died would not be visible to us anyway.
 */
function readJournal(): Record<string, StructureBlockRecord> {
    try {
        const raw = fs.readFileSync(JOURNAL_PATH(), "utf8");
        const parsed = JSON.parse(raw);
        return parsed && typeof parsed === "object" ? parsed : {};
    } catch {
        return {};
    }
}

function writeJournalFile(data: Record<string, StructureBlockRecord>): void {
    try {
        fs.writeFileSync(JOURNAL_PATH(), JSON.stringify(data, null, 2), "utf8");
    } catch (e) {
        logger.warn("[CALL][AreaDisplay] cannot write journal: " + describeError(e));
    }
}

export default class AreaDisplayerService {
    private static states = new Map<string, DisplayState>();
    private static spawner: ParticleSpawner | null = null;
    private static spawnerFailed = false;

    // ---------------------------------------------------------------- config
    public static mode(): AreaDisplayMode {
        // Config may not be readable before the engine is ready; default is the safe one.
        const raw = String(Config.get(Config.GLOBAL, "areaDisplayMode", "particle") ?? "").toLowerCase();
        switch (raw) {
            case "particle":
            case "text":
            case "structure_block":
            case "off":
                return raw as AreaDisplayMode;
            default:
                return "particle";
        }
    }

    private static stateOf(caPlayer: CAPlayer, create: boolean): DisplayState | null {
        if (!caPlayer || !caPlayer.xuid) return null;
        let st = AreaDisplayerService.states.get(caPlayer.xuid);
        if (st == null && create) {
            st = { mode: AreaDisplayerService.mode(), anchor: null, signature: "", lastRender: 0, record: null };
            AreaDisplayerService.states.set(caPlayer.xuid, st);
        }
        return st ?? null;
    }

    private static signatureOf(area: Area3): string {
        return [area.start.x, area.start.y, area.start.z, area.end.x, area.end.y, area.end.z, area.start.dimid].join(",");
    }

    // -------------------------------------------------------------- particle
    private static getSpawner(): ParticleSpawner | null {
        if (AreaDisplayerService.spawner != null) return AreaDisplayerService.spawner;
        if (AreaDisplayerService.spawnerFailed) return null;
        try {
            const radius = Number(Config.get(Config.GLOBAL, "areaDisplayRadius", 96)) || 96;
            AreaDisplayerService.spawner = mc.newParticleSpawner(radius, true, true);
        } catch (e) {
            AreaDisplayerService.spawnerFailed = true;
            logger.warn("[CALL][AreaDisplay] particle spawner unavailable, falling back to text: " + describeError(e));
        }
        return AreaDisplayerService.spawner;
    }

    private static drawBox(area: Area3): boolean {
        const spawner = AreaDisplayerService.getSpawner();
        if (spawner == null) return false;
        try {
            spawner.drawCuboid(
                new FloatPos(area.start.x, area.start.y, area.start.z, area.start.dimid),
                new FloatPos(area.end.x + 1, area.end.y + 1, area.end.z + 1, area.end.dimid),
                ParticleColor.Green
            );
            return true;
        } catch (e) {
            logger.warn("[CALL][AreaDisplay] drawCuboid failed: " + describeError(e));
            return false;
        }
    }

    // ------------------------------------------------- legacy block swapping
    private static legacyAdd(pos: Pos3, lens: number[], offset: number, caPlayer: CAPlayer, st: DisplayState): void {
        const block = mc.getBlock(pos.x, pos.y, pos.z, pos.dimid);
        if (block == null) {
            throw new Warn(Tr._(caPlayer.$.langCode, "dynamic.AreaDisplayerManager.set.cannotLoad"));
        }

        let blockNbt: NbtCompound | null = null;
        let blockEntityNbt: NbtCompound | null = null;
        try {
            if (block.hasBlockEntity()) {
                const be = block.getBlockEntity();
                if (be != null) blockEntityNbt = be.getNbt();
            }
            blockNbt = block.getNbt();
        } catch (e) {
            throw new Error(Tr._(caPlayer.$.langCode, "dynamic.AreaDisplayerManager.add.error", describeError(e)));
        }

        // Journal *before* touching the world: if the write succeeds and the engine dies
        // afterwards, the next start can still put the original block back.
        const record: StructureBlockRecord = {
            x: pos.x,
            y: pos.y,
            z: pos.z,
            dimid: pos.dimid,
            blockNbt: blockNbt ? blockNbt.toSNBT() : null,
            blockEntityNbt: blockEntityNbt ? blockEntityNbt.toSNBT() : null,
        };
        AreaDisplayerService.writeJournal(caPlayer.xuid, record);

        if (!mc.setBlock(pos.x, pos.y, pos.z, pos.dimid, "minecraft:structure_block", 0)) {
            throw new Error(Tr._(caPlayer.$.langCode, "dynamic.AreaDisplayerManager.add.error", "setBlock rejected"));
        }

        const placed = mc.getBlock(pos.x, pos.y, pos.z, pos.dimid);
        if (placed == null || !placed.hasBlockEntity()) {
            throw new Error(Tr._(caPlayer.$.langCode, "dynamic.AreaDisplayerManager.add.error", "structure_block has no block entity"));
        }
        const blockEntity = placed.getBlockEntity();
        const entityNbt = blockEntity.getNbt();
        entityNbt.setTag("showBoundingBox", new NbtByte(1));
        entityNbt.setTag("xStructureSize", new NbtInt(lens[0]));
        entityNbt.setTag("yStructureSize", new NbtInt(lens[1]));
        entityNbt.setTag("zStructureSize", new NbtInt(lens[2]));
        entityNbt.setTag("yStructureOffset", new NbtInt(offset));
        blockEntity.setNbt(entityNbt);

        st.record = record;
    }

    private static writeJournal(xuid: string, record: StructureBlockRecord): void {
        const data = readJournal();
        data[xuid] = record;
        writeJournalFile(data);
    }

    private static clearJournal(xuid: string): void {
        const data = readJournal();
        if (data[xuid] == null) return;
        delete data[xuid];
        writeJournalFile(data);
    }

    private static restoreRecord(record: StructureBlockRecord, xuid: string): void {
        try {
            const block = mc.getBlock(record.x, record.y, record.z, record.dimid as 0 | 1 | 2);
            if (block == null) {
                logger.warn("[CALL][AreaDisplay] cannot restore selection block at " +
                    record.x + "," + record.y + "," + record.z + " (chunk not loaded)");
                return;
            }
            if (record.blockNbt) {
                const nbt = NBT.parseSNBT(record.blockNbt);
                if (nbt != null) block.setNbt(nbt);
            }
            if (record.blockEntityNbt) {
                const be = block.getBlockEntity();
                const nbt = NBT.parseSNBT(record.blockEntityNbt);
                if (be != null && nbt != null) be.setNbt(nbt);
            }
        } catch (e) {
            logger.warn("[CALL][AreaDisplay] restore failed: " + describeError(e));
        } finally {
            AreaDisplayerService.clearJournal(xuid);
        }
    }

    /** Find a column position that is free, not a container, and not already used. */
    private static findLegacySlot(area: Area3): { pos: Pos3; offset: number } {
        const lens = area.getLens();
        for (const candidate of AreaDisplayerService.legacyCandidates(area)) {
            const block = mc.getBlock(candidate.x, candidate.y, candidate.z, candidate.dimid);
            if (block == null) continue;
            let isContainer = false;
            try {
                isContainer = block.hasContainer();
            } catch {
                isContainer = false;
            }
            if (isContainer) continue;
            if (AreaDisplayerService.isSlotTaken(candidate)) continue;
            return { pos: candidate, offset: AreaDisplayerService.offsetFor(candidate, area, lens) };
        }
        throw new Error("dynamic.AreaDisplayerManager.set.cannotDisplay");
    }

    private static *legacyCandidates(area: Area3): Generator<Pos3> {
        const anchor = area.start;
        for (let y = area.end.y + 1; y < Constant.SPACE.MAX_HIGHT; y++) {
            yield new Pos3(anchor.x, y, anchor.z, anchor.dimid);
        }
        for (let y = area.start.y - 1; y > Constant.SPACE.MIN_HIGHT; y--) {
            yield new Pos3(anchor.x, y, anchor.z, anchor.dimid);
        }
    }

    private static offsetFor(pos: Pos3, area: Area3, lens: number[]): number {
        if (pos.y > area.end.y) return -lens[1] - pos.y + area.end.y + 1;
        return area.start.y - pos.y;
    }

    private static isSlotTaken(pos: Pos3): boolean {
        for (const st of AreaDisplayerService.states.values()) {
            if (st.record == null) continue;
            if (st.record.x === pos.x && st.record.y === pos.y && st.record.z === pos.z && st.record.dimid === pos.dimid) {
                return true;
            }
        }
        return false;
    }

    // ------------------------------------------------------------- public API
    /**
     * Show `area` for a player.
     * @returns a non-null anchor (AreaOperation treats "null" as "not displayed").
     */
    public static set(area: Area3, caPlayer: CAPlayer): Pos3 | null {
        if (!caPlayer) return null;
        const st = AreaDisplayerService.stateOf(caPlayer, true);
        if (st == null) return null;

        const normalised = Area3.fromArea3D(area);
        const mode = AreaDisplayerService.mode();
        st.mode = mode;
        st.signature = AreaDisplayerService.signatureOf(normalised);

        switch (mode) {
            case "off":
                st.anchor = normalised.start;
                return st.anchor;

            case "text":
                st.anchor = normalised.start;
                return st.anchor;

            case "particle": {
                AreaDisplayerService.drawBox(normalised);
                st.lastRender = Date.now();
                st.anchor = normalised.start;
                return st.anchor;
            }

            case "structure_block": {
                if (st.record != null) return st.anchor;
                const slot = AreaDisplayerService.findLegacySlot(normalised);
                AreaDisplayerService.legacyAdd(slot.pos, normalised.getLens(), slot.offset, caPlayer, st);
                st.anchor = slot.pos;
                return st.anchor;
            }
        }
    }

    /** Remove whatever was drawn for this player. */
    public static remove(caPlayer: CAPlayer): void {
        if (!caPlayer) return;
        const st = AreaDisplayerService.states.get(caPlayer.xuid);
        if (st == null) return;

        if (st.record != null) {
            AreaDisplayerService.restoreRecord(st.record, caPlayer.xuid);
            st.record = null;
        }
        st.anchor = null;
        st.signature = "";
        if (caPlayer) {
            caPlayer.displayPos = null;
        }
    }

    /** Forget a player entirely (logout / unload). */
    public static release(caPlayer: CAPlayer): void {
        if (!caPlayer) return;
        safeCall("AreaDisplay.release", () => AreaDisplayerService.remove(caPlayer));
        AreaDisplayerService.states.delete(caPlayer.xuid);
    }

    /** Restore every journaled selection block. Called on plugin unload. */
    public static releaseAll(): void {
        // 1. in-memory state
        for (const [xuid, st] of AreaDisplayerService.states) {
            if (st.record != null) safeCall("AreaDisplay.releaseAll", () => AreaDisplayerService.restoreRecord(st.record!, xuid));
            st.record = null;
            st.anchor = null;
        }
        AreaDisplayerService.states.clear();

        // 2. anything left over from a previous run (crash / kill)
        try {
            const all = readJournal();
            for (const xuid of Object.keys(all)) {
                const rec = all[xuid];
                if (rec && typeof rec.x === "number") {
                    safeCall("AreaDisplay.recover", () => AreaDisplayerService.restoreRecord(rec, xuid));
                }
            }
        } catch (e) {
            logger.warn("[CALL][AreaDisplay] journal recovery failed: " + describeError(e));
        }
    }

    /**
     * Periodic HUD update: keeps the particle box alive and refreshes the size hint.
     * Only ever touches online players.
     */
    public static areaTextTip(caPlayer: CAPlayer): void {
        if (!caPlayer || !caPlayer.settings) return;
        const player = online(caPlayer.xuid);
        if (player == null) return;

        const area = caPlayer.settings.area;
        if (area == null || area.start == null || area.end == null) return;
        if (area.start.dimid == null || area.end.dimid == null) return;
        if (!caPlayer.hasSetArea) return;
        if (!caPlayer.settings.areaTextShow || !caPlayer.settings.enable) return;

        const st = AreaDisplayerService.states.get(caPlayer.xuid);
        const mode = st ? st.mode : AreaDisplayerService.mode();

        safeCall("AreaDisplay.tip", () => {
            const a = Area3.fromArea3D(area);
            const lens = a.getLens();

            // Keep the particle outline alive: particles decay, so redraw on the tick.
            if (mode === "particle") {
                const now = Date.now();
                if (st == null || now - st.lastRender >= 900) {
                    AreaDisplayerService.drawBox(a);
                    if (st) st.lastRender = now;
                }
            }

            if (!caPlayer.settings.areaTextShow) return;

            const signature = lens.join("x");
            if (st != null && st.signature === "tip:" + signature) return;
            if (st != null) st.signature = "tip:" + signature;

            const lang = player.langCode;
            const min = a.start;
            const max = a.end;
            const text =
                Tr._(lang, "dynamic.AreaDisplayerManager.areaTextTip.str0", min + "->" + max) + "\n" +
                Tr._(lang, "dynamic.AreaDisplayerManager.areaTextTip.str1",
                    String(lens[0]), String(lens[1]), String(lens[2]));
            tell(player, text, MsgType.TIP);
        });
    }

    /** Kept for callers that used the old helper name. */
    public static show(caPlayer: CAPlayer): boolean {
        if (!caPlayer || !caPlayer.settings || !caPlayer.settings.area) return false;
        return AreaDisplayerService.set(Area3.fromArea3D(caPlayer.settings.area), caPlayer) != null;
    }
}
