/**
 * Remap DIRECTIONAL block states when a structure is mirrored / rotated.
 *
 * Rotating a paste used to move the cells and leave every palette entry untouched, so a rotated
 * staircase still faced the original way: the shape turned, the stairs did not - the "stairs are
 * scrambled after a rotated paste" report. The same data feeds the preview, so both were wrong.
 *
 * Only states whose meaning is KNOWN are remapped; anything else is left exactly as it is
 * (guessing a state name would corrupt blocks silently). Keys we deliberately do not touch are
 * listed in UNMAPPED so a debug run can show what a rotation left alone.
 *
 * The vector convention below is the one transformLayout()/cellOffset() use:
 *   mirror first (flip x or z), then rotate clockwise around Y as (dx,dz) -> (-dz,dx).
 */
import type { Degrees, MirrorMode } from "./Rotate";

export type StateValue = { type?: number; value?: any } | any;
export type StateMap = Record<string, StateValue>;

/** Keys we know how to rotate. Everything else is passed through untouched. */
export const MAPPED_KEYS = [
    "weirdo_direction",
    "cardinal_direction",
    "facing_direction",
    "torch_facing_direction",
    "pillar_axis",
    "axis",
    "ground_sign_direction",
] as const;

/** Directional-looking keys we deliberately leave alone until their semantics are confirmed. */
export const UNMAPPED = ["rail_direction", "lever_direction", "repeater_direction"] as const;

/**
 * Bedrock namespaces some state keys: a chest reports `minecraft:cardinal_direction` while stairs
 * use bare `weirdo_direction`. Matching the exact string therefore missed every namespaced block -
 * the "chest/trapdoor rotation does nothing" report - so the namespace is stripped for the lookup.
 */
const NAMESPACE = /^[A-Za-z0-9_.]+:(.+)$/;
function bareKey(key: string): string {
    const m = NAMESPACE.exec(key);
    return m == null ? key : m[1];
}

/** Cardinal directions as STRINGS: "minecraft:cardinal_direction" carries "north"/"south"/... */
const CARDINAL_NAMES: Record<string, number> = { south: 0, west: 1, north: 2, east: 3 };
const CARDINAL_NAME_LIST = ["south", "west", "north", "east"];
function cardinalFromName(value: any): number | null {
    if (typeof value !== "string") return null;
    const n = CARDINAL_NAMES[value.toLowerCase()];
    return n == null ? null : n;
}

function raw(value: StateValue): any {
    if (value != null && typeof value === "object" && "value" in (value as any) && "type" in (value as any)) {
        return (value as any).value;
    }
    return value;
}

/** Keep the original NBT type wrapper so the palette stays byte-compatible. */
function rewrap(original: StateValue, next: any): StateValue {
    if (original != null && typeof original === "object" && "type" in (original as any)) {
        return { ...(original as any), value: next };
    }
    return next;
}

const asInt = (value: StateValue): number | null => {
    const v = raw(value);
    if (typeof v === "boolean") return v ? 1 : 0;
    const n = Number(v);
    return Number.isFinite(n) ? n : null;
};

/** weirdo_direction (stairs): 0 = east(+X), 1 = west(-X), 2 = south(+Z), 3 = north(-Z). */
const STAIRS = [
    [1, 0],   // 0 east
    [-1, 0],  // 1 west
    [0, 1],   // 2 south
    [0, -1],  // 3 north
];
/** cardinal_direction: 0 = south(+Z), 1 = west(-X), 2 = north(-Z), 3 = east(+X). */
const CARDINAL = [
    [0, 1],
    [-1, 0],
    [0, -1],
    [1, 0],
];

function indexOfVector(table: number[][], vec: number[]): number {
    for (let i = 0; i < table.length; i++) {
        if (table[i][0] === vec[0] && table[i][1] === vec[1]) return i;
    }
    return -1;
}

/**
 * Transform a horizontal direction index through the same matrix the cells go through.
 * Returns -1 when the table does not describe a horizontal direction (caller keeps the value).
 */
function remapHorizontal(table: number[][], value: StateValue, degrees: Degrees, mirror: MirrorMode): StateValue {
    const current = asInt(value);
    if (current == null || current < 0 || current >= table.length) return value;
    let [dx, dz] = table[current];

    if (mirror === "x" || mirror === "xz") dx = -dx;
    if (mirror === "z" || mirror === "xz") dz = -dz;

    const steps = (degrees / 90) % 4;
    for (let i = 0; i < steps; i++) {
        const nx = -dz;
        const nz = dx;
        dx = nx;
        dz = nz;
    }

    const next = indexOfVector(table, [dx, dz]);
    return next < 0 ? value : rewrap(value, next);
}

/**
 * facing_direction: 0 = down, 1 = up, 2 = north(-Z), 3 = south(+Z), 4 = west(-X), 5 = east(+X).
 * Vertical values never change under a Y rotation; the four horizontals follow the cell matrix.
 */
function remapFacing(value: StateValue, degrees: Degrees, mirror: MirrorMode): StateValue {
    const current = asInt(value);
    if (current == null || current < 2 || current > 5) return value;
    const table = [
        [0, -1], // 2 north
        [0, 1],  // 3 south
        [-1, 0], // 4 west
        [1, 0],  // 5 east
    ];
    const mapped = remapHorizontal(table, current - 2, degrees, mirror);
    const next = asInt(mapped);
    return next == null || next < 0 ? value : rewrap(value, next + 2);
}

function remapTorch(value: StateValue, degrees: Degrees, mirror: MirrorMode): StateValue {
    const text = String(raw(value) ?? "");
    const table: Record<string, number[]> = { north: [0, -1], south: [0, 1], west: [-1, 0], east: [1, 0] };
    if (table[text] == null) return value; // top / bottom / anything else
    const names = ["north", "south", "west", "east"];
    const order = names.map((n) => table[n]);
    const mapped = remapHorizontal(order, indexOfVector(order, table[text]), degrees, mirror);
    const next = asInt(mapped);
    return next == null || next < 0 ? value : rewrap(value, names[next]);
}

/**
 * ground_sign_direction: 0..15 in 22.5° steps with 0 = south, 4 = east, 8 = north, 12 = west.
 * (Confirmed against the value table used by Bedrock; a 4-step shift is one 90° turn.)
 */
function remapSign(value: StateValue, degrees: Degrees, mirror: MirrorMode): StateValue {
    const current = asInt(value);
    if (current == null || current < 0 || current > 15) return value;
    let d = current;
    if (mirror === "x" || mirror === "xz") d = (16 - d) % 16;
    if (mirror === "z" || mirror === "xz") d = (8 - d + 16) % 16;
    // MEASURED against the engine: /structure load ... 90_degrees turns
    // ground_sign_direction 0 into 4, i.e. +4 per quarter turn (a hanging sign's text uses this
    // state too, which is why a rotated sign showed its text on the back face).
    const steps = (degrees / 90) % 4;
    d = (d + 4 * steps) % 16;
    return rewrap(value, d);
}

function remapAxis(value: StateValue, degrees: Degrees): StateValue {
    const text = String(raw(value) ?? "").toLowerCase();
    if (text !== "x" && text !== "z") return value; // "y" and anything else stay
    if (degrees !== 90 && degrees !== 270) return value;
    return rewrap(value, text === "x" ? "z" : "x");
}

/**
 * Return a NEW states object with every known directional key rotated/mirrored.
 * A structure with no such states gets the original object back (no allocation on the hot path).
 */
export function remapStates(states: StateMap | null | undefined, degrees: Degrees, mirror: MirrorMode): StateMap {
    if (states == null) return states as any;
    const keys = Object.keys(states);
    if (keys.length === 0) return states;
    if (degrees === 0 && mirror === "none") return states;

    let out: StateMap | null = null;
    for (const key of keys) {
        const original = states[key];
        const bare = bareKey(key);
        let next: StateValue = original;
        switch (bare) {
            case "weirdo_direction": next = remapHorizontal(STAIRS, original, degrees, mirror); break;
            case "cardinal_direction": {
                const named = cardinalFromName(raw(original));
                if (named == null) next = remapHorizontal(CARDINAL, original, degrees, mirror);
                else {
                    const idx = asInt(remapHorizontal(CARDINAL, named, degrees, mirror));
                    next = idx == null || idx < 0 ? original : rewrap(original, CARDINAL_NAME_LIST[idx]);
                }
                break;
            }
            // Doors and trapdoors use `direction`, whose index order is NOT the cardinal one:
            // the player report (correct at 0 degrees, wrong at every rotation) plus the engine
            // evidence for cardinal_direction ("north" -> "east" at 90) rules the cardinal table out.
            // It matches the stairs family instead (0=east, 1=west, 2=south, 3=north).
            case "direction": next = remapHorizontal(STAIRS, original, degrees, mirror); break;
            case "facing_direction": next = remapFacing(original, degrees, mirror); break;
            case "torch_facing_direction": next = remapTorch(original, degrees, mirror); break;
            case "pillar_axis":
            case "axis": next = remapAxis(original, degrees); break;
            case "ground_sign_direction": next = remapSign(original, degrees, mirror); break;
            default: next = original; break;
        }
        if (next !== original) {
            if (out == null) out = { ...states };
            out[key] = next;
        }
    }
    return out ?? states;
}

/** Which mapped keys were present (for the debug line), e.g. ["weirdo_direction"]. */
export function mappedKeysOf(states: StateMap | null | undefined): string[] {
    if (states == null) return [];
    return (MAPPED_KEYS as readonly string[]).filter((k) => states[k] != null);
}
