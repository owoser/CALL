import * as fs from "fs";
import Wireframe, { COLOR } from "../holo/Wireframe";
import Constant from "../temp/Constant";
import Area3 from "../common/Area3";
import Paths from "../common/Paths";
import CAPlayer from "../user/CAPlayer";
import { Pos3 } from "../common/Pos3";
import { Warn } from "../util/Error";
import StrFactory from "../util/StrFactory";
import Tr from "../util/Translator";
import Config from "../common/Config";
import PreviewHudLock from "./PreviewHudLock";
import { MsgType, tell, online } from "../util/Msg";
import { describeError, logFailure, safeCall } from "../util/Safe";

/**
 * Draws the player's selection.
 *
 * MODES (`areaDisplayMode`)
 * -------------------------
 *   structure_block (default) - the 1.x approach: place ONE temporary structure block in
 *       a verified-empty spot and give it a bounding box covering the selection. It is
 *       the only visual that has actually been seen to render on this platform
 *       (particles were added in 2.0 and reported as invisible).
 *   particle - particle outline, no world writes.
 *   text     - only the size hint.
 *   off      - nothing.
 *
 * SAFETY RULES for structure_block (this is what 1.x got wrong):
 *   1. never overwrite anything: the slot must be air, and not already used by another
 *      player's highlight;
 *   2. the original block NBT is journaled to `data/area_display.json` BEFORE
 *      the world is touched, so a crash / kill / `ll reload` can still be recovered -
 *      `releaseAll()` runs at startup and on unload;
 *   3. only the six bounding-box fields are written into the block entity, and every
 *      read is validated first (1.x called blockEntity.getNbt() and setNbt()
 *      unconditionally and threw when the chunk had gone).
 */

export type AreaDisplayMode = "wireframe" | "structure_block" | "particle" | "text" | "off";

interface StructureBlockRecord {
    x: number;
    y: number;
    z: number;
    dimid: number;
    blockNbt: string | null;
    blockEntityNbt: string | null;
}

interface DisplayState {
    mode: AreaDisplayMode;
    anchor: Pos3 | null;
    signature: string;
    lastRender: number;
    record: StructureBlockRecord | null;
}

const JOURNAL_PATH = () => Paths.join("data", "area_display.json");

function readJournal(): Record<string, StructureBlockRecord> {
    try {
        const parsed = JSON.parse(fs.readFileSync(JOURNAL_PATH(), "utf8"));
        return parsed && typeof parsed === "object" ? parsed : {};
    } catch {
        return {};
    }
}

function writeJournalFile(data: Record<string, StructureBlockRecord>): void {
    try {
        fs.mkdirSync(Paths.DATA, { recursive: true });
        fs.writeFileSync(JOURNAL_PATH(), JSON.stringify(data, null, 2), "utf8");
    } catch (e) {
        logFailure("AreaDisplay.journal", e);
    }
}

function isReplaceable(type: string): boolean {
    return type === "minecraft:air"
        || type === "minecraft:cave_air"
        || type === "minecraft:void_air";
}

export default class AreaDisplayerService {
    private static states = new Map<string, DisplayState>();
    private static spawner: ParticleSpawner | null = null;
    private static spawnerFailed = false;
    private static announcedMode = false;

    // ------------------------------------------------------------------ config
    public static mode(): AreaDisplayMode {
        const raw = String(Config.get(Config.GLOBAL, "areaDisplayMode", "wireframe") ?? "").toLowerCase();
        switch (raw) {
            case "wireframe":
            case "particle":
            case "text":
            case "structure_block":
            case "off":
                return raw as AreaDisplayMode;
            default:
                return "structure_block";
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

    // ------------------------------------------------- structure block display
    /**
     * Find a column position above (then below) the selection whose block is air and
     * that no other player's highlight is using.
     */
    private static findSlot(area: Area3): Pos3 | null {
        const x = area.start.x;
        const z = area.start.z;
        const dim = area.start.dimid;

        const taken = (pos: Pos3) => {
            for (const st of AreaDisplayerService.states.values()) {
                const r = st.record;
                if (r && r.x === pos.x && r.y === pos.y && r.z === pos.z && r.dimid === pos.dimid) return true;
            }
            return false;
        };

        const candidates: Pos3[] = [];
        for (let y = area.end.y + 1; y <= Math.min(area.end.y + 24, Constant.SPACE.MAX_HIGHT); y++) {
            candidates.push(new Pos3(x, y, z, dim));
        }
        for (let y = area.start.y - 1; y >= Math.max(area.start.y - 24, Constant.SPACE.MIN_HIGHT); y--) {
            candidates.push(new Pos3(x, y, z, dim));
        }

        for (const pos of candidates) {
            const block = mc.getBlock(pos.x, pos.y, pos.z, pos.dimid);
            if (block == null) continue;              // chunk not readable
            if (!isReplaceable(block.type)) continue; // never overwrite anything
            if (taken(pos)) continue;
            return pos;
        }
        return null;
    }

    private static placeHighlight(pos: Pos3, area: Area3, caPlayer: CAPlayer, st: DisplayState): void {
        const block = mc.getBlock(pos.x, pos.y, pos.z, pos.dimid);
        if (block == null) {
            throw new Warn("dynamic.AreaDisplayerManager.set.cannotLoad");
        }

        // Capture what we are about to replace, and journal it BEFORE touching the world.
        let blockNbt: NbtCompound | null = null;
        let entityNbt: NbtCompound | null = null;
        try {
            if (block.hasBlockEntity()) {
                const be = block.getBlockEntity();
                if (be != null) entityNbt = be.getNbt();
            }
            blockNbt = block.getNbt();
        } catch (e) {
            throw new Error(Tr._(caPlayer.$?.langCode ?? "en_US", "dynamic.AreaDisplayerManager.add.error", describeError(e)));
        }

        const record: StructureBlockRecord = {
            x: pos.x,
            y: pos.y,
            z: pos.z,
            dimid: pos.dimid,
            blockNbt: blockNbt ? blockNbt.toSNBT() : null,
            blockEntityNbt: entityNbt ? entityNbt.toSNBT() : null,
        };
        const journal = readJournal();
        journal[caPlayer.xuid] = record;
        writeJournalFile(journal);
        st.record = record;

        if (!mc.setBlock(pos.x, pos.y, pos.z, pos.dimid, "minecraft:structure_block", 0)) {
            AreaDisplayerService.restore(st, caPlayer.xuid);
            throw new Error(Tr._(caPlayer.$?.langCode ?? "en_US", "dynamic.AreaDisplayerManager.add.error", "setBlock rejected"));
        }

        const placed = mc.getBlock(pos.x, pos.y, pos.z, pos.dimid);
        if (placed == null || !placed.hasBlockEntity()) {
            AreaDisplayerService.restore(st, caPlayer.xuid);
            throw new Error(Tr._(caPlayer.$?.langCode ?? "en_US", "dynamic.AreaDisplayerManager.add.error", "no block entity"));
        }

        const be = placed.getBlockEntity();
        const nbt = be.getNbt();
        const lens = area.getLens();

        // Only the bounding-box fields. Everything else stays at the block's defaults.
        nbt.setTag("showBoundingBox", new NbtByte(1));
        nbt.setTag("xStructureSize", new NbtInt(lens[0]));
        nbt.setTag("yStructureSize", new NbtInt(lens[1]));
        nbt.setTag("zStructureSize", new NbtInt(lens[2]));
        nbt.setTag("yStructureOffset", new NbtInt(pos.y > area.end.y ? -lens[1] + (area.end.y - pos.y) + 1 : area.start.y - pos.y));
        be.setNbt(nbt);
    }

    private static restore(st: DisplayState, xuid: string): void {
        const record = st?.record;
        if (record == null) return;
        try {
            const block = mc.getBlock(record.x, record.y, record.z, record.dimid as 0 | 1 | 2);
            if (block == null) {
                logger.warn("[CALL][AreaDisplay] cannot restore highlight at "
                    + record.x + "," + record.y + "," + record.z + " (chunk not loaded) - will retry on next start");
                return; // keep journal entry so a later start can fix it
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
            logFailure("AreaDisplay.restore", e);
            return;
        } finally {
            st.record = null;
        }

        const journal = readJournal();
        if (journal[xuid] != null) {
            delete journal[xuid];
            writeJournalFile(journal);
        }
    }

    // ---------------------------------------------------------------- particle
    private static getSpawner(): ParticleSpawner | null {
        if (AreaDisplayerService.spawner != null) return AreaDisplayerService.spawner;
        if (AreaDisplayerService.spawnerFailed) return null;
        try {
            const radius = Number(Config.get(Config.GLOBAL, "areaDisplayRadius", 96)) || 96;
            AreaDisplayerService.spawner = mc.newParticleSpawner(radius, true, true);
        } catch (e) {
            AreaDisplayerService.spawnerFailed = true;
            logFailure("AreaDisplay.spawner", e);
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
            logFailure("AreaDisplay.drawBox", e);
            return false;
        }
    }

    /** "12×5×8 = 480" for the floating label above the box. */
    /**
     * "2×1×2 (4) @1376,179,-45" for the floating label.
     *
     * The corner coordinates are in the label on purpose: a box that *looks* shifted can then be
     * checked against the numbers that drew it from the screenshot alone, instead of a round trip
     * of "looks off by one" / "which number is wrong?".
     */
    private static sizeLabel(area: Area3): string {
        const lens = area.getLens();
        const total = lens[0] * lens[1] * lens[2];
        return "§f" + lens[0] + "§7×§f" + lens[1] + "§7×§f" + lens[2] + "§7(" + total + ")"
            + " §8@§7" + area.start.x + "," + area.start.y + "," + area.start.z;
    }

    /** Yellow while the selection is still a single point, green once it has volume. */
    private static colorOf(area: Area3) {
        return area.start.equals(area.end) ? COLOR.incomplete : COLOR.complete;
    }

    // -------------------------------------------------------------- public API
    public static set(area: Area3, caPlayer: CAPlayer): Pos3 | null {
        if (!caPlayer) return null;
        const st = AreaDisplayerService.stateOf(caPlayer, true);
        if (st == null) return null;

        const normalized = Area3.fromArea3D(area);
        const mode = AreaDisplayerService.mode();
        st.mode = mode;
        st.signature = AreaDisplayerService.signatureOf(normalized);

        if (!AreaDisplayerService.announcedMode) {
            AreaDisplayerService.announcedMode = true;
            logger.info("[CALL][AreaDisplay] mode = " + mode);
        }

        switch (mode) {
            case "off":
            case "text":
                st.anchor = normalized.start;
                return st.anchor;

            case "wireframe": {
                // Server-side box outline: nothing is written to the world, every client sees
                // it, and the library re-sends it when someone joins.
                const start = normalized.start;
                const end = normalized.end;
                const size = AreaDisplayerService.sizeLabel(normalized);
                const color = AreaDisplayerService.colorOf(normalized);
                const shown = Wireframe.show(
                    "area:" + caPlayer.xuid,
                    {
                        x1: start.x, y1: start.y, z1: start.z,
                        x2: end.x + 1, y2: end.y + 1, z2: end.z + 1,
                    },
                    color,
                    size
                );
                if (!shown) {
                    // HologramLib missing: never leave the player without feedback.
                    AreaDisplayerService.drawBox(normalized);
                }
                st.lastRender = Date.now();
                st.anchor = st.anchor ?? start;
                return st.anchor;
            }

            case "particle": {
                AreaDisplayerService.drawBox(normalized);
                st.lastRender = Date.now();
                st.anchor = normalized.start;
                return st.anchor;
            }

            case "structure_block": {
                if (st.record != null) return st.anchor; // already shown
                const slot = AreaDisplayerService.findSlot(normalized);
                if (slot == null) {
                    // No safe spot: fall back to the size hint only, never damage the world.
                    st.anchor = normalized.start;
                    return st.anchor;
                }
                AreaDisplayerService.placeHighlight(slot, normalized, caPlayer, st);
                st.anchor = slot;
                return st.anchor;
            }
        }
    }

    /** One-line state for `/ca tools debug`: what is drawn, and from which numbers. */
    public static describe(xuid: string): string[] {
        const st = AreaDisplayerService.states.get(xuid);
        const mode = AreaDisplayerService.mode();
        if (st == null) return ["选区显示: " + mode + " · 未登记"];
        const out = [
            "选区显示: " + mode
                + " · 锚点 " + (st.anchor != null ? st.anchor.x + "," + st.anchor.y + "," + st.anchor.z : "-")
                + (st.record != null ? " · 占位方块 " + st.record.x + "," + st.record.y + "," + st.record.z : ""),
        ];
        try {
            const stats = Wireframe.statsOf("area:" + xuid);
            if (stats != null) {
                out.push("选区线框: box moves " + stats.boxMoves + " / text reuses " + stats.textReuses);
            }
        } catch {
            // wireframe not in use
        }
        return out;
    }

    public static remove(caPlayer: CAPlayer): void {
        if (!caPlayer) return;
        const st = AreaDisplayerService.states.get(caPlayer.xuid);
        if (st == null) return;
        safeCall("AreaDisplay.remove", () => AreaDisplayerService.restore(st, caPlayer.xuid));
        safeCall("AreaDisplay.hideWireframe", () => Wireframe.hide("area:" + caPlayer.xuid));
        st.anchor = null;
        st.signature = "";
        caPlayer.displayPos = null;
    }

    /** Forget a player entirely (logout / unload). */
    public static release(caPlayer: CAPlayer): void {
        if (!caPlayer) return;
        AreaDisplayerService.remove(caPlayer);
        AreaDisplayerService.states.delete(caPlayer.xuid);
    }

    /**
     * Restore every highlight: in-memory first, then anything a previous run left in the
     * journal (crash, kill, hot reload).
     */
    public static releaseAll(): void {
        for (const [xuid, st] of AreaDisplayerService.states) {
            if (st.record != null) safeCall("AreaDisplay.releaseAll", () => AreaDisplayerService.restore(st, xuid));
            st.record = null;
            st.anchor = null;
        }
        AreaDisplayerService.states.clear();

        try {
            const journal = readJournal();
            for (const xuid of Object.keys(journal)) {
                const record = journal[xuid];
                if (record == null || typeof record.x !== "number") continue;
                const fake: DisplayState = { mode: "structure_block", anchor: null, signature: "", lastRender: 0, record };
                safeCall("AreaDisplay.recover", () => AreaDisplayerService.restore(fake, xuid));
            }
        } catch (e) {
            logFailure("AreaDisplay.releaseAll", e);
        }
    }

    /** Periodic HUD update: size hint, and keep a particle outline alive. */
    public static areaTextTip(caPlayer: CAPlayer): void {
        // A live preview owns the action bar (countdown); yield this beat instead of flickering.
        if (PreviewHudLock.held(caPlayer.xuid)) return;
        if (!caPlayer || !caPlayer.settings) return;
        const player = online(caPlayer.xuid);
        if (player == null) return;

        const area = caPlayer.settings.area;
        if (area == null || area.start == null || area.end == null) return;
        if (area.start.dimid == null || area.end.dimid == null) return;
        if (!caPlayer.hasSetArea || !caPlayer.settings.enable) return;

        const st = AreaDisplayerService.states.get(caPlayer.xuid);
        const mode = st ? st.mode : AreaDisplayerService.mode();

        safeCall("AreaDisplay.tip", () => {
            const a = Area3.fromArea3D(area);

            if (mode === "particle") {
                const now = Date.now();
                if (st == null || now - st.lastRender >= 900) {
                    AreaDisplayerService.drawBox(a);
                    if (st) st.lastRender = now;
                }
            }

            if (!caPlayer.settings.areaTextShow) return;
            const lens = a.getLens();
            const signature = "tip:" + lens.join("x");
            if (st != null && st.signature === signature) return;
            if (st != null) st.signature = signature;

            const lang = player.langCode;
            const text =
                Tr._(lang, "dynamic.AreaDisplayerManager.areaTextTip.str0", a.start + "->" + a.end) + "\n" +
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