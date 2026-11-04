import { Areas } from "../temp/Data";
import CAPlayer from "../user/CAPlayer";
import StructureService from "./StructureService";
import Config from "../common/Config";
import Area3 from "../common/Area3";
import { Structure } from "../common/Structure";
import { Pos3 } from "../common/Pos3";
import StrFactory from "../util/StrFactory";
import BlockType from "../common/BlockType";
import Tr from "../util/Translator";
import { logFailure, sleep } from "../util/Safe";
import { fillCommand, runNow } from "../game/Cmd";
import { classifyCmdError } from "../game/Chunks";
import { slabHeight } from "../game/SafeArgs";
import { MsgType, online, tell } from "../util/Msg";

/**
 * Fill / clear / replace / hollow / outline.
 *
 * Design notes for this file (each one is a bug that used to bite):
 *  - fill runs at CONSOLE level: every coordinate is absolute and CALL already checked the
 *    player's permission, so routing through the player only made it depend on vanilla
 *    command permissions;
 *  - slab height is derived from the slice footprint (see SafeArgs.slabHeight) so a 64x64
 *    slice never lands exactly on the 32768-block ceiling;
 *  - failures are collected and reported ONCE per operation. 3.0.2 sent one identical
 *    toast per slab, e.g. fourteen "cannot place blocks outside of the world" in a row;
 *  - "cannot place blocks outside of the world" is BDS' message for UNLOADED CHUNKS, and
 *    it is surfaced as such (see Chunks.classifyCmdError) instead of being passed through.
 */

/** Result of one /fill command. */
export type FillStep = "ok" | "noop" | "not-loaded" | "invalid" | "failed";

/** Aggregated result of a whole operation. */
export interface FillOutcome {
    ok: boolean;
    slabs: number;
    failed: number;
    notLoaded: number;
    invalidBlock: boolean;
}

function emptyOutcome(): FillOutcome {
    return { ok: true, slabs: 0, failed: 0, notLoaded: 0, invalidBlock: false };
}

function mergeInto(into: FillOutcome, step: FillStep): void {
    into.slabs++;
    if (step === "ok" || step === "noop") return;
    into.failed++;
    into.ok = false;
    if (step === "not-loaded") into.notLoaded++;
    if (step === "invalid") into.invalidBlock = true;
}

export default class FillService {
    /**
     * Walk every slice and run `cmdCallback` for each horizontal slab.
     */
    public static async ergod(
        caPlayer: CAPlayer,
        areas: Areas,
        index: number,
        total: number,
        cmdCallback: (yBottom: number, yTop: number, area: Area3) => FillStep | Promise<FillStep>,
        overCallback: (outcome: FillOutcome) => void
    ): Promise<void> {
        const fillWaitTime = Number(Config.get(Config.GLOBAL, "fillWaitTime", 0)) || 0;
        const lang = caPlayer.$?.langCode ?? "en_US";
        const outcome = emptyOutcome();

        await StructureService.traversal(
            caPlayer,
            areas,
            Tr._(lang, "dynamic.FillManager.ergod.fill", `${index + 1}/${total}`),
            async (x: number, z: number) => {
                const area = areas[x][z];
                const step = slabHeight(area.end.x - area.start.x + 1, area.end.z - area.start.z + 1);
                for (let y = area.start.y; y <= area.end.y; y += step) {
                    const yTop = Math.min(y + step - 1, area.end.y);
                    let result: FillStep;
                    try {
                        result = await cmdCallback(y, yTop, area);
                    } catch (e) {
                        logFailure("FillService.slab", e);
                        result = "failed";
                    }
                    mergeInto(outcome, result);
                    if (result !== "ok" && result !== "noop") {
                        FillService.logOnce("step:" + area + ":" + y + ":" + result,
                            " slab " + area.start.x + "," + y + "," + area.start.z
                            + " -> " + area.end.x + "," + yTop + "," + area.end.z);
                    }
                    if (fillWaitTime > 0) await sleep(fillWaitTime);
                }
                return true;
            },
            () => overCallback(outcome),
            () => overCallback(outcome)
        );
    }

    /** Fill the whole region with one block (mode "" = replace everything). */
    public static soildFill(
        caPlayer: CAPlayer,
        targetArea: Area3,
        blockTypeA: BlockType,
        blockTypeB: BlockType,
        mod: string,
        overCallback: (outcome: FillOutcome) => void
    ): void {
        const structure = new Structure(Area3.fromArea3D(targetArea));
        StructureService.undoSave(caPlayer, [structure], () => {
            FillService.ergod(
                caPlayer,
                structure.getAreas(),
                0,
                1,
                (yBottom, yTop, area) => {
                    const from = new Pos3(area.start.x, yBottom, area.start.z, area.start.dimid);
                    const to = new Pos3(area.end.x, yTop, area.end.z, area.end.dimid);
                    const cmd = fillCommand(
                        from,
                        to,
                        blockTypeA.type,
                        blockTypeA.states,
                        mod,
                        blockTypeB.type,
                        blockTypeB.states
                    );
                    if (cmd == null) {
                        FillService.reportInvalid(caPlayer, blockTypeA);
                        return "invalid";
                    }
                    return FillService.exec(cmd);
                },
                overCallback
            ).catch((e) => {
                logFailure("FillService.soildFill", e);
                overCallback({ ok: false, slabs: 1, failed: 1, notLoaded: 0, invalidBlock: false });
            });
        });
    }

    /** Hollow / outline: fill the six faces, then clear the inside for "hollow". */
    public static fillOutside(
        caPlayer: CAPlayer,
        tArea: Area3,
        blockTypeA: BlockType,
        isHollow: boolean,
        overCallback: (outcome: FillOutcome) => void
    ): void {
        const a = Area3.fromArea3D(tArea);
        const s = a.start;
        const e = a.end;

        const faces: Area3[] = [
            new Area3(new Pos3(s.x, s.y, s.z, s.dimid), new Pos3(s.x, e.y, e.z, s.dimid)), // -X
            new Area3(new Pos3(s.x, s.y, s.z, s.dimid), new Pos3(e.x, s.y, e.z, s.dimid)), // -Y
            new Area3(new Pos3(s.x, s.y, s.z, s.dimid), new Pos3(e.x, e.y, s.z, s.dimid)), // -Z
            new Area3(new Pos3(e.x, s.y, s.z, s.dimid), new Pos3(e.x, e.y, e.z, s.dimid)), // +X
            new Area3(new Pos3(s.x, e.y, s.z, s.dimid), new Pos3(e.x, e.y, e.z, s.dimid)), // +Y
            new Area3(new Pos3(s.x, s.y, e.z, s.dimid), new Pos3(e.x, e.y, e.z, s.dimid)), // +Z
        ];

        const structs = faces.map((f) => new Structure(f));
        const lens = a.getLens();
        let interior: Area3 | null = null;
        if (isHollow && lens[0] > 2 && lens[1] > 2 && lens[2] > 2) {
            interior = Area3.fromArea3D(tArea);
            interior.start.add(1, 1, 1);
            interior.end.add(-1, -1, -1);
            structs.push(new Structure(interior));
        }

        StructureService.undoSave(caPlayer, structs, () => {
            FillService.runPasses(caPlayer, structs, interior, blockTypeA, overCallback).catch((e) => {
                logFailure("FillService.fillOutside", e);
                overCallback({ ok: false, slabs: 1, failed: 1, notLoaded: 0, invalidBlock: false });
            });
        });
    }

    private static async runPasses(
        caPlayer: CAPlayer,
        structs: Structure[],
        interior: Area3 | null,
        blockTypeA: BlockType,
        overCallback: (outcome: FillOutcome) => void
    ): Promise<void> {
        const outcome = emptyOutcome();
        for (let i = 0; i < structs.length; i++) {
            const isInterior = interior != null && i === structs.length - 1;
            const bt = isInterior ? new BlockType("minecraft:air", "") : blockTypeA;
            await FillService.ergod(
                caPlayer,
                structs[i].getAreas(),
                i,
                structs.length,
                (yBottom, yTop, area) => {
                    const from = new Pos3(area.start.x, yBottom, area.start.z, area.start.dimid);
                    const to = new Pos3(area.end.x, yTop, area.end.z, area.end.dimid);
                    const cmd = fillCommand(from, to, bt.type, bt.states);
                    if (cmd == null) return "invalid";
                    return FillService.exec(cmd);
                },
                (pass) => {
                    outcome.slabs += pass.slabs;
                    outcome.failed += pass.failed;
                    outcome.notLoaded += pass.notLoaded;
                    outcome.invalidBlock = outcome.invalidBlock || pass.invalidBlock;
                    outcome.ok = outcome.ok && pass.ok;
                }
            );
        }
        overCallback(outcome);
    }

    /**
     * Execute one fill command (console level) and classify the result.
     *
     * "not loaded" is retried: the ticking area taken by Chunks.acquire is registered
     * asynchronously, and there is no reliable way to observe that from the script API
     * (mc.getBlock force-loads on demand, so any readiness probe is instantly true). A few
     * short retries turn an intermittent failure into a reliable one.
     */
    private static async exec(cmd: string): Promise<FillStep> {
        const attempts = 4;
        for (let i = 0; i < attempts; i++) {
            const res = runNow(cmd);
            if (res.ok) return "ok";
            const kind = classifyCmdError(res.out, res.ok);
            if (kind === "noop") return "noop";
            if (kind === "not-loaded") {
                if (i < attempts - 1) {
                    await sleep(800);
                    continue;
                }
                FillService.logOnce(cmd, "region still not loaded after " + attempts + " attempts");
                return "not-loaded";
            }
            FillService.logOnce(cmd, res.out);
            return "failed";
        }
        return "failed";
    }

    private static logged = new Set<string>();

    private static logOnce(cmd: string, out: string): void {
        if (FillService.logged.has(cmd)) return;
        FillService.logged.add(cmd);
        if (FillService.logged.size > 200) FillService.logged.clear();
        logFailure("FillService.fill", new Error(cmd + " -> " + (out || "rejected")));
    }

    private static reportInvalid(caPlayer: CAPlayer, blockType: BlockType): void {
        const lang = caPlayer.$?.langCode ?? "en_US";
        FillService.logOnce("invalid:" + blockType?.type, blockType?.type ?? "");
        tell(online(caPlayer.xuid), StrFactory.cmdErr(
            Tr._(lang, "dynamic.FillManager.reason.invalidBlock") + " " + (blockType?.toString() || "(empty)")
        ), MsgType.RAW);
    }
}
