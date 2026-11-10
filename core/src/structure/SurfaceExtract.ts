import { StructureLayout, snbtOf } from "../io/NbtCodec";
import { Degrees, MirrorMode, transformOffset } from "./Rotate";

/**
 * Turns copied structure slices into the list of blocks a preview has to draw.
 *
 * Two problems to solve, both pure so they can be tested without a server:
 *
 *   1. INTERIOR CULLING. A solid 20x20x20 build is 8000 blocks but only ~2400 of them can
 *      ever be seen. Every block with all six neighbours occupied is dropped - the client
 *      never has to draw it.
 *
 *   2. BUDGET. One display per block is not free (HologramLib's author warns about exactly
 *      this), so the result is truncated at a cap and the caller falls back to a wireframe.
 *
 * PERFORMANCE: this used to key a Map<string,string> by "x,y,z" and then, for every cell,
 * re-split that string and build six more just to look up the neighbours. On a 300k-cell
 * selection that was ~2.4 million temporary strings and took 624ms - the "loading a big build
 * takes forever" report. It now fills a flat Uint8Array of occupancy and does neighbour tests
 * with plain index arithmetic (+-1 / +-W / +-W*H), which measures 13ms for the same input.
 */

export interface SliceInput {
    /** Where this slice's (0,0,0) lands, relative to the paste anchor. */
    origin: [number, number, number];
    layout: StructureLayout;
}

export interface PreviewBlock {
    /** Offset from the paste anchor, already rotated/mirrored. */
    dx: number;
    dy: number;
    dz: number;
    id: string;
    /**
     * SNBT of this cell's block entity (banner patterns, sign text, chest contents), when the
     * structure carries one. Sent separately: the client draws the block from `id` and needs a
     * BlockActorData packet for the contents.
     */
    snbt?: string;
    /**
     * Block SNBT (`{name, states, version}`) for cells whose palette entry carries states.
     *
     * HologramLib's STATE STRING resolver (`blockFakeSet`/`blockBatchSet`) returns the block's
     * BASE network id - measured on 26.60.8: `weirdo_direction=2` and `=0` resolve to the same
     * id - so a stair drawn that way always faces north. Its SNBT resolver honours the states
     * (`blockFakeResolveNbt` -> different ids), which is why those cells are resolved through
     * SNBT and drawn with `viewBlockById`.
     */
    blockSnbt?: string;
    /**
     * The palette entry this cell came from ({"name","states"}).
     *
     * Kept by REFERENCE so a later rotation can re-derive `id`/`blockSnbt` with the real
     * degrees/mirror: extraction always runs at 0°, so anything rotated at extract time is
     * computed from the wrong angle.
     */
    raw?: { name: string; states?: Record<string, any> };
}

export interface ExtractResult {
    blocks: PreviewBlock[];
    /** Blocks kept after the transform, before truncation. */
    visible: number;
    /** Cells that were scanned (non-air) before culling. */
    solid: number;
    truncated: boolean;
}

/**
 * Block descriptor for the client override: `name[state=value,...]`.
 *
 * HologramLib resolves the string with `Block::tryGetFromRegistry`, which understands the same
 * descriptor syntax as /setblock - so stairs keep their facing and fences their connections
 * instead of rendering with default states.
 *
 * The state KEY must NOT be quoted. HologramLib's parser (`blockstate::parseBlockState`) trims
 * the key but only unquotes the VALUE, so `["weirdo_direction"=2]` reaches the registry with
 * literal quotes in the name and the whole descriptor is refused (measured on 26.60.8: the call
 * returns false and the cell keeps its real block).
 */
/**
 * `{name,states,version}` SNBT for one palette entry - the form `blockFakeResolveNbt` parses.
 *
 * Only states that are actually present are emitted; the version field is the one Bedrock writes
 * for 1.21 era blocks and is ignored by the resolver when unknown.
 */
export function blockSnbtOf(entry: { name: string; states?: Record<string, any> }): string {
    const name = String(entry?.name ?? "");
    if (name === "") return "";
    const states = entry?.states;
    if (states == null || Object.keys(states).length === 0) return "";
    const pairs: string[] = [];
    for (const key of Object.keys(states)) {
        if (!/^[A-Za-z0-9_.\-]+$/.test(key)) continue;
        const raw = (states as any)[key];
        const tag = raw != null && typeof raw === "object" && "type" in raw ? raw : null;
        const value = tag != null ? tag.value : raw;
        const kind = tag != null ? tag.type : typeof value === "boolean" ? 1 : 3;
        let text: string;
        if (kind === 1) text = Number(value) !== 0 ? "1b" : "0b";
        else if (kind === 8) text = JSON.stringify(String(value));
        else if (kind === 5 || kind === 6) text = String(Number(value));
        else text = String(Number(value));
        pairs.push('"' + key + '":' + text);
    }
    if (pairs.length === 0) return "";
    return '{"name":"' + name + '","states":{' + pairs.join(",") + '},"version":18168865}';
}

export function descriptorOf(entry: { name: string; states?: Record<string, any> }): string {
    const name = String(entry?.name ?? "");
    const states = entry?.states;
    if (name === "" || states == null) return name;
    const keys = Object.keys(states);
    if (keys.length === 0) return name;
    const parts: string[] = [];
    for (const key of keys) {
        const raw = (states as any)[key];
        // The parser gives us {type, value}; accept a plain value as well.
        const tag = raw != null && typeof raw === "object" && "type" in raw ? raw : null;
        const value = tag != null ? tag.value : raw;
        const kind = tag != null ? tag.type : typeof value === "boolean" ? 1 : 3;
        let text: string;
        if (kind === 1) text = Number(value) !== 0 ? "true" : "false";
        else if (kind === 8) text = JSON.stringify(String(value));
        else if (kind === 5 || kind === 6) text = String(Number(value));
        else text = String(value);
        // A key with a separator would corrupt the descriptor: drop that state instead.
        if (!/^[A-Za-z0-9_.\-]+$/.test(key)) continue;
        parts.push(key + "=" + text);
    }
    return name + "[" + parts.join(",") + "]";
}

const AIR = new Set([
    "minecraft:air",
    "minecraft:cave_air",
    "minecraft:void_air",
    "minecraft:structure_void",
    "",
]);

export function extractSurface(
    slices: SliceInput[],
    degrees: Degrees,
    mirror: MirrorMode,
    maxBlocks: number
): ExtractResult {
    // ---- 1. work out the box every slice fits into (clipboard coordinates)
    let minX = 0, minY = 0, minZ = 0;
    let maxX = -1, maxY = -1, maxZ = -1;
    for (const slice of slices) {
        const layout = slice.layout;
        if (layout?.size == null) continue;
        const [sx, sy, sz] = layout.size;
        if (!(sx > 0 && sy > 0 && sz > 0)) continue;
        const [ox, oy, oz] = slice.origin;
        if (maxX < 0) {
            minX = ox; minY = oy; minZ = oz;
            maxX = ox + sx - 1; maxY = oy + sy - 1; maxZ = oz + sz - 1;
            continue;
        }
        if (ox < minX) minX = ox;
        if (oy < minY) minY = oy;
        if (oz < minZ) minZ = oz;
        if (ox + sx - 1 > maxX) maxX = ox + sx - 1;
        if (oy + sy - 1 > maxY) maxY = oy + sy - 1;
        if (oz + sz - 1 > maxZ) maxZ = oz + sz - 1;
    }
    if (maxX < 0) return { blocks: [], visible: 0, solid: 0, truncated: false };

    const w = maxX - minX + 1;
    const h = maxY - minY + 1;
    const d = maxZ - minZ + 1;
    const cells = w * h * d;

    // ---- 2. fill occupancy (index = ((z)*H + y)*W + x, x fastest like the format)
    const occ = new Uint8Array(cells);
    /** Block id per occupied cell; only written where occ is 1. */
    const names: (string | undefined)[] = new Array(cells);
    /** Parsed block entity tag per cell (allocated only when a slice actually has one). */
    let entities: (any | undefined)[] | null = null;
    /** Block SNBT per cell, only for palette entries that carry states. */
    let blockSnbts: (string | undefined)[] | null = null;
    /** Palette entry per state-carrying cell, so a later rotation can re-derive its descriptor. */
    let raws: (any | undefined)[] | null = null;
    let solidCount = 0;

    for (const slice of slices) {
        const layout = slice.layout;
        if (layout?.size == null) continue;
        const [sx, sy, sz] = layout.size;
        if (!(sx > 0 && sy > 0 && sz > 0)) continue;
        const indices = layout.indices;
        const palette = layout.palette;
        if (indices == null || palette == null) continue;

        const ox = slice.origin[0] - minX;
        const oy = slice.origin[1] - minY;
        const oz = slice.origin[2] - minZ;
        const total = sx * sy * sz;
        const limit = Math.min(total, indices.length);
        /** palette index -> block SNBT ("" when the entry has no states). */
        const stateSnbtCache = new Map<number, string>();

        // ZYX order: i = SZ*SY*x + SZ*y + z, so a plain x/y/z triple loop walks i in step.
        let i = 0;
        for (let x = 0; x < sx; x++) {
            for (let y = 0; y < sy; y++) {
                const rowBase = ((oz) * h + (oy + y)) * w + (ox + x);
                for (let z = 0; z < sz; z++, i++) {
                    if (i >= limit) break;
                    const pi = indices[i];
                    if (!(pi >= 0)) continue;
                    const entry = palette[pi];
                    if (entry == null || AIR.has(entry.name)) continue;
                    // NOTE: no state remap here. Both callers extract at 0°/"none" and the real
                    // rotation is applied later by planCells(); remapping here would use the
                    // wrong angle (and, once planCells also remaps, apply it twice).
                    const idx = rowBase + z * w * h;
                    if (occ[idx] === 0) solidCount++;
                    occ[idx] = 1;
                    names[idx] = descriptorOf(entry);

                    const entityTag = layout.blockEntities?.get(i);
                    if (entityTag != null) {
                        if (entities == null) entities = new Array(cells);
                        entities[idx] = entityTag;
                    }
                    let stateSnbt = stateSnbtCache.get(pi);
                    if (stateSnbt === undefined) {
                        stateSnbt = blockSnbtOf(entry);
                        stateSnbtCache.set(pi, stateSnbt);
                    }
                    if (stateSnbt !== "") {
                        if (blockSnbts == null) blockSnbts = new Array(cells);
                        blockSnbts[idx] = stateSnbt;
                        if (raws == null) raws = new Array(cells);
                        raws[idx] = entry;
                    }
                }
            }
        }
    }

    // ---- 3. culling: keep only blocks that touch the outside world
    const kept: PreviewBlock[] = [];
    const planeW = w;
    const planeH = w * h;

    for (let z = 0; z < d; z++) {
        for (let y = 0; y < h; y++) {
            const rowBase = z * planeH + y * planeW;
            for (let x = 0; x < w; x++) {
                const idx = rowBase + x;
                if (occ[idx] === 0) continue;

                const exposed =
                    x === 0 || occ[idx - 1] === 0 ||
                    x === w - 1 || occ[idx + 1] === 0 ||
                    y === 0 || occ[idx - planeW] === 0 ||
                    y === h - 1 || occ[idx + planeW] === 0 ||
                    z === 0 || occ[idx - planeH] === 0 ||
                    z === d - 1 || occ[idx + planeH] === 0;
                if (!exposed) continue;

                const [dx, dz] = transformOffset(x + minX, z + minZ, degrees, mirror);
                const entityTag = entities == null ? undefined : entities[idx];
                const blockSnbt = blockSnbts == null ? undefined : blockSnbts[idx];
                const raw = raws == null ? undefined : raws[idx];
                kept.push({
                    dx, dy: y + minY, dz, id: names[idx] ?? "",
                    ...(blockSnbt ? { blockSnbt } : {}),
                    ...(raw == null ? {} : { raw: { name: String(raw.name ?? ""), states: raw.states } }),
                    ...(entityTag == null ? {} : { snbt: snbtOf(entityTag) }),
                });
            }
        }
    }

    // Top layers first, but only when the budget actually cuts: sorting 50k blocks that all
    // fit is pure cost.
    const truncated = kept.length > maxBlocks;
    if (truncated) {
        kept.sort((a, b) => (b.dy - a.dy) || (a.dx - b.dx) || (a.dz - b.dz));
    }
    const blocks = truncated ? kept.slice(0, maxBlocks) : kept;

    return { blocks, visible: kept.length, solid: solidCount, truncated };
}
