import Config from "../common/Config";
import { Pos3 } from "../common/Pos3";
import { normaliseBlockName, normaliseBlockStates, splitBlockToken, clampY, dimensionId, MAX_FILL_VOLUME, volumeOf } from "./SafeArgs";
import { describeError, logFailure, sleep } from "../util/Safe";

/**
 * The single command execution layer.
 *
 * WHY IT EXISTS
 * -------------
 * 1.x/2.0 built every command as
 *
 *     /execute at "<player real name>" run <command>
 *
 * which (a) reads the player's name from a possibly stale Player handle, (b) re-enters
 * the command dispatcher synchronously from inside a command callback, and (c) hides
 * the command's failure output from everyone.
 *
 * Rules enforced here:
 *   - commands that are about a player run through `Player.runcmd` (no name in the
 *     string at all),
 *   - commands that are about coordinates need no entity at all,
 *   - everything defers to the next tick, so we never re-enter the dispatcher,
 *   - every argument is validated before it can reach the parser,
 *   - failures are returned, not swallowed.
 */

export interface CmdResult {
    ok: boolean;
    out: string;
    /** The exact string that was sent (or would have been). */
    cmd: string;
}

const DIM_NAMES = ["overworld", "nether", "the_end"];

function report(cmd: string): void {
    try {
        if (Config.get(Config.GLOBAL, "outputCmd", false)) logger.info("[CALL][cmd] " + cmd);
    } catch {
        // config not ready
    }
}

/** Escape a value for use inside a quoted command argument. */
function quoted(value: string): string {
    return '"' + String(value).replace(/"/g, '\\"') + '"';
}

/** Run a console-level command on the next tick. */
export async function run(cmd: string): Promise<CmdResult> {
    const text = String(cmd ?? "").trim();
    if (text === "") return { ok: false, out: "empty command", cmd: text };

    report(text);
    await sleep(0); // leave the current callback / tick
    try {
        const res = mc.runcmdEx(text) as { success?: boolean; output?: string } | boolean;
        if (typeof res === "boolean") return { ok: res, out: "", cmd: text };
        return { ok: res?.success !== false, out: String(res?.output ?? ""), cmd: text };
    } catch (e) {
        logFailure("cmd.run", e);
        return { ok: false, out: describeError(e), cmd: text };
    }
}

/** Run a command immediately (only for code that is NOT inside an engine callback). */
export function runNow(cmd: string): CmdResult {
    const text = String(cmd ?? "").trim();
    if (text === "") return { ok: false, out: "empty command", cmd: text };
    report(text);
    try {
        const res = mc.runcmdEx(text) as { success?: boolean; output?: string } | boolean;
        if (typeof res === "boolean") return { ok: res, out: "", cmd: text };
        return { ok: res?.success !== false, out: String(res?.output ?? ""), cmd: text };
    } catch (e) {
        logFailure("cmd.runNow", e);
        return { ok: false, out: describeError(e), cmd: text };
    }
}

/**
 * Run a command in the context of a player.
 * Uses `Player.runcmd` - the command string never contains the player's name, so a
 * stale handle cannot corrupt it (it simply fails to resolve and returns false).
 */
export async function runAs(player: Player | null | undefined, cmd: string): Promise<CmdResult> {
    const text = String(cmd ?? "").trim();
    if (text === "") return { ok: false, out: "empty command", cmd: text };
    if (!player) return { ok: false, out: "player offline", cmd: text };

    report(text);
    await sleep(0);
    try {
        const ok = player.runcmd(text);
        return { ok: ok !== false, out: "", cmd: text };
    } catch (e) {
        logFailure("cmd.runAs", e);
        return { ok: false, out: describeError(e), cmd: text };
    }
}

/** Run a command anchored at a dimension/position (no entity involved). */
export async function runAt(pos: Pos3, cmd: string): Promise<CmdResult> {
    const dim = DIM_NAMES[dimensionId(pos?.dimid)] ?? DIM_NAMES[0];
    const x = Math.floor(Number(pos?.x) || 0);
    const y = clampY(pos?.y);
    const z = Math.floor(Number(pos?.z) || 0);
    return run(`/execute in ${dim} positioned ${x} ${y} ${z} run ${String(cmd ?? "").trim()}`);
}

// ------------------------------------------------------------------ builders

/** Validate and render a block argument for a command. */
export function blockArg(type: string, states: string): string | null {
    const token = splitBlockToken(type);
    const name = normaliseBlockName(token.name);
    if (name == null) return null;

    const explicit = states != null && String(states).trim() !== "" && String(states).trim() !== "[]";
    const raw = explicit ? states : token.states;
    if (raw == null || String(raw).trim() === "") return name;

    const normalised = normaliseBlockStates(raw);
    // States were supplied but cannot be understood: reject instead of silently placing a
    // different variant than the player asked for.
    if (normalised == null) return null;
    return name + " " + normalised;
}

/**
 * Build a /fill command, rejecting volumes BDS cannot handle.
 * @param mode "", "hollow", "outline", "destroy", "keep"
 */
export function fillCommand(a: Pos3, b: Pos3, type: string, states: string, mode = "", replaceType = "", replaceStates = ""): string | null {
    const block = blockArg(type, states);
    if (block == null) return null;

    const sx = Math.abs(b.x - a.x) + 1;
    const sy = Math.abs(b.y - a.y) + 1;
    const sz = Math.abs(b.z - a.z) + 1;
    if (volumeOf(sx, sy, sz) > MAX_FILL_VOLUME) return null;
    if (clampY(a.y) !== a.y || clampY(b.y) !== b.y) return null;

    let out = `/fill ${a.x} ${a.y} ${a.z} ${b.x} ${b.y} ${b.z} ${block}`;
    if (mode) out += " " + mode;
    // An empty replaceType is the "no second block" sentinel used by fill/clear, not a
    // filter - appending it would produce "... minecraft:stone minecraft:air", which the
    // parser rejects (the replace block only exists after a mode).
    if (replaceType != null && String(replaceType).trim() !== "") {
        const replace = blockArg(replaceType, replaceStates);
        if (replace == null) return null;
        out += " " + replace;
    }
    return out;
}

/** Build a /clone command. */
export function cloneCommand(from1: Pos3, from2: Pos3, to: Pos3, mode: "replace" | "masked" = "replace", cloneMode: "normal" | "move" | "force" = "normal"): string | null {
    const sx = Math.abs(from2.x - from1.x) + 1;
    const sy = Math.abs(from2.y - from1.y) + 1;
    const sz = Math.abs(from2.z - from1.z) + 1;
    if (volumeOf(sx, sy, sz) > MAX_FILL_VOLUME) return null;
    return `/clone ${from1.x} ${from1.y} ${from1.z} ${from2.x} ${from2.y} ${from2.z} ${to.x} ${to.y} ${to.z} ${mode} ${cloneMode}`;
}

/** Build a /structure command with a validated name. */
export function structureCommand(action: "save" | "load" | "delete", name: string, args: string[] = []): string | null {
    if (!/^[A-Za-z0-9_.:-]+$/.test(String(name ?? ""))) return null;
    const extra = args.filter((a) => a != null && String(a).trim() !== "").join(" ");
    return `/structure ${action} ${name}` + (extra ? " " + extra : "");
}

/** Build a /tp command for a player. */
export function teleportCommand(playerName: string, pos: Pos3, facing?: [number, number, number]): string | null {
    if (!playerName) return null;
    let out = `/tp ${quoted(playerName)} ${Number(pos.x).toFixed(2)} ${Number(pos.y).toFixed(2)} ${Number(pos.z).toFixed(2)}`;
    if (facing) out += ` facing ${facing[0]} ${facing[1]} ${facing[2]}`;
    return out;
}

/** Validate a structure name the way the game expects it. */
export function isStructureName(name: string): boolean {
    return /^[A-Za-z0-9_.:-]+$/.test(String(name ?? ""));
}
