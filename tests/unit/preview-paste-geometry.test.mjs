/**
 * Preview geometry vs paste geometry.
 *
 * The preview, the wireframe, the undo snapshot and the block placement MUST be driven by one
 * mapping. 3.4.0 had three: the preview rotated around the anchor, the paste normalised the
 * rotated box to its minimum corner AND then shifted it again by (edge - 1), and the
 * wireframe/undo box was computed from the clipboard's absolute world coordinates (hundreds of
 * blocks away, with Y counted twice). The user-visible symptom was [最终粘贴和预览不一致] and
 * [转动后粘贴会偏移位置].
 *
 * These tests pin the invariant: after mirror + rotation, preview cells, pasted cells and the
 * undo box are the same cells, and they always start at the paste position.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { join, dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { existsSync } from 'node:fs';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..', '..');
const REL = 'dist/call/core/src';

function load() {
    const files = {
        rotate: join(ROOT, REL, 'structure', 'Rotate.js'),
        clipboard: join(ROOT, REL, 'structure', 'Clipboard.js'),
        codec: join(ROOT, REL, 'io', 'NbtCodec.js'),
        structure: join(ROOT, REL, 'common', 'Structure.js'),
        area: join(ROOT, REL, 'common', 'Area3.js'),
        pos: join(ROOT, REL, 'common', 'Pos3.js'),
    };
    for (const f of Object.values(files)) assert.ok(existsSync(f), 'build first: npm run build:fast');
    return {
        ...require(files.rotate),
        ...require(files.clipboard),
        transformLayout: require(files.codec).transformLayout,
        Structure: require(files.structure).Structure,
        Area3: require(files.area).default,
        Pos3: require(files.pos).Pos3,
    };
}

const api = load();
const DEGREES = [0, 90, 180, 270];
const MIRRORS = ['none', 'x', 'z', 'xz'];
const PIVOTS = ['inplace', 'anchor'];

/** A clipboard copied from (srcX, srcY, srcZ), W x H x D blocks. */
function clipboard(W, H, D, srcX = 0, srcY = 64, srcZ = 0) {
    return {
        sid: {
            area: {
                start: { x: srcX, y: srcY, z: srcZ },
                end: { x: srcX + W - 1, y: srcY + H - 1, z: srcZ + D - 1 },
            },
        },
    };
}

const pos = (x, y, z) => ({ x, y, z, dimid: 0 });

/** Destination of every source cell, straight from the preview mapping. */
function previewCells(W, D, deg, mirror, pivot = 'inplace') {
    const out = new Map();
    for (let x = 0; x < W; x++) {
        for (let z = 0; z < D; z++) {
            out.set(x + ',' + z, api.cellOffset(x, z, W, D, deg, mirror, pivot).join(','));
        }
    }
    return out;
}

/**
 * Destination of every source cell as the PASTE computes it:
 * relative slice areas -> sliceDestMin for the slice corner -> transformLayout per slice.
 * Mirrors StructureService.load() + placeBytesAsync() without touching the engine.
 */
function pasteCells(W, H, D, deg, mirror, pivot = 'inplace') {
    const box = api.clipboardBox(clipboard(W, H, D));
    assert.ok(box != null, 'clipboard box');

    // load(): subtract the clipboard minimum, then split into 64-block slices
    const area = new api.Area3(new api.Pos3(0, 0, 0, 0), new api.Pos3(W - 1, H - 1, D - 1, 0));
    const st = new api.Structure(area, 't');
    const areas = st.getAreas();
    const out = new Map();

    for (let ix = 0; ix < st.xSize; ix++) {
        for (let iz = 0; iz < st.zSize; iz++) {
            const slice = areas[ix][iz];
            const sw = slice.end.x - slice.start.x + 1;
            const sd = slice.end.z - slice.start.z + 1;
            const [dx, dz] = api.sliceDestMin(
                slice.start.x, slice.start.z, sw, sd,
                box.size.x, box.size.z, deg, mirror, pivot
            );

            // one palette entry per cell so every block can be followed individually
            const indices = new Array(sw * sd).fill(-1);
            const palette = [];
            for (let x = 0; x < sw; x++) {
                for (let z = 0; z < sd; z++) {
                    palette.push({ name: 'b' + (slice.start.x + x) + '_' + (slice.start.z + z), states: {}, version: 0 });
                    indices[sd * x + z] = palette.length - 1;
                }
            }

            const layout = api.transformLayout(
                { size: [sw, 1, sd], indices, palette },
                { rotation: deg, mirror }
            );
            const ow = layout.size[0];
            const od = layout.size[2];
            for (let x = 0; x < ow; x++) {
                for (let z = 0; z < od; z++) {
                    const v = layout.indices[od * x + z];
                    if (v == null || v < 0) continue;
                    const name = palette[v].name.slice(1).split('_').map(Number);
                    out.set(name[0] + ',' + name[1], [dx + x, dz + z].join(','));
                }
            }
        }
    }
    return out;
}

const SIZES = [
    [3, 1, 3],
    [4, 2, 1],
    [1, 3, 4],
    [4, 1, 2],
    [65, 2, 3],
    [3, 1, 65],
    [130, 1, 5],
];

test('preview and paste land every block on the same cell (sizes x angles x mirrors x pivots)', () => {
    for (const [W, H, D] of SIZES) {
        for (const deg of DEGREES) {
            for (const mirror of MIRRORS) {
                for (const pivot of PIVOTS) {
                    const preview = previewCells(W, D, deg, mirror, pivot);
                    const paste = pasteCells(W, H, D, deg, mirror, pivot);
                    const label = W + 'x' + H + 'x' + D + ' rot ' + deg + ' mirror ' + mirror + ' pivot ' + pivot;
                    assert.equal(paste.size, W * D, 'block count ' + label);
                    for (const [src, dst] of preview) {
                        assert.equal(paste.get(src), dst,
                            label + ': ' + src + ' preview ' + dst + ' paste ' + paste.get(src));
                        const [x, z] = dst.split(',').map(Number);
                        if (pivot === 'inplace') {
                            const tw = deg === 90 || deg === 270 ? D : W;
                            const td = deg === 90 || deg === 270 ? W : D;
                            assert.ok(x >= 0 && x < tw && z >= 0 && z < td, dst + ' outside ' + tw + 'x' + td);
                        }
                    }
                }
            }
        }
    }
});

test('four quarter turns return a cell to where it started', () => {
    // walk one corner cell through four 90 deg turns, swapping the box each time
    for (const [W, D] of [[3, 5], [4, 1], [65, 3]]) {
        for (const [sx, sz] of [[0, 0], [W - 1, D - 1], [W - 1, 0]]) {
            let [w, d] = [W, D];
            let [x, z] = [sx, sz];
            for (let i = 0; i < 4; i++) {
                [x, z] = api.transformCell(x, z, w, d, 90, 'none');
                [w, d] = [d, w];
            }
            assert.deepEqual([x, z], [sx, sz], 'cell ' + sx + ',' + sz + ' of ' + W + 'x' + D);
        }
    }
});

test('pivot anchor swings the box around the clicked cell, pivot inplace keeps it in place', () => {
    const complex = clipboard(4, 2, 6, 1200, 22, 3500);
    const anchor = pos(-3, 22, 363);

    for (const deg of DEGREES) {
        for (const mirror of MIRRORS) {
            const inplace = api.rotatedUnion(complex, anchor, deg, mirror, 'inplace');
            const swung = api.rotatedUnion(complex, anchor, deg, mirror, 'anchor');
            const [sx, sz] = api.pivotShift(4, 6, deg, mirror, 'anchor');
            assert.deepEqual([swung.x1, swung.z1], [anchor.x + sx, anchor.z + sz], 'rot ' + deg + ' mirror ' + mirror);
            // same size, different corner
            assert.equal(swung.x2 - swung.x1, inplace.x2 - inplace.x1);
            assert.equal(swung.z2 - swung.z1, inplace.z2 - inplace.z1);
            // 0 deg / no mirror is the identity: nothing may move
            if (deg === 0 && mirror === 'none') assert.deepEqual([sx, sz], [0, 0]);
        }
    }
});

test('the wireframe/undo box is anchored at the paste position, not at the source', () => {
    // copied 1200 blocks east and 3500 south of the paste spot - the old code produced
    // x 1197..1199 / y 44 / z 3863..3865 for this exact case
    const complex = clipboard(4, 2, 6, 1200, 22, 3500);
    const anchor = pos(-3, 22, 363);

    for (const deg of DEGREES) {
        for (const mirror of MIRRORS) {
            const tw = deg === 90 || deg === 270 ? 6 : 4;
            const td = deg === 90 || deg === 270 ? 4 : 6;
            const box = api.rotatedUnion(complex, anchor, deg, mirror);
            assert.deepEqual(
                [box.x1, box.y1, box.z1, box.x2, box.y2, box.z2],
                [-3, 22, 363, -3 + tw - 1, 22 + 2 - 1, 363 + td - 1],
                'rot ' + deg + ' mirror ' + mirror
            );
        }
    }
});

test('the undo snapshot covers exactly the box the paste writes', () => {
    const complex = clipboard(4, 2, 6, 1200, 22, 3500);
    const anchor = pos(-3, 22, 363);

    for (const pivot of PIVOTS) for (const deg of DEGREES) {
        for (const mirror of MIRRORS) {
            const box = api.rotatedUnion(complex, anchor, deg, mirror, pivot);
            const areas = api.rotatedTargetAreas(complex, anchor, deg, mirror, pivot);
            assert.equal(areas.length, 1, 'one area per clipboard entry');
            const tw = deg === 90 || deg === 270 ? 6 : 4;
            const td = deg === 90 || deg === 270 ? 4 : 6;
            assert.deepEqual(
                [areas[0].start.x, areas[0].start.z, areas[0].end.x, areas[0].end.z],
                [box.x1, box.z1, box.x1 + tw - 1, box.z1 + td - 1],
                'rot ' + deg + ' mirror ' + mirror
            );
            assert.deepEqual([areas[0].start.y, areas[0].end.y], [box.y1, box.y2]);
        }
    }
});

test('multi-slice destinations tile the rotated box without holes or overlaps', () => {
    const W = 130, H = 1, D = 5;
    const complex = clipboard(W, H, D, 12, 40, -7);
    const anchor = pos(100, 64, 200);

    for (const deg of DEGREES) {
        const areas = api.rotatedTargetAreas(complex, anchor, deg, 'none');
        const tw = deg === 90 || deg === 270 ? D : W;
        const td = deg === 90 || deg === 270 ? W : D;
        const seen = new Set();
        let cells = 0;
        for (const a of areas) {
            for (let x = a.start.x; x <= a.end.x; x++) {
                for (let z = a.start.z; z <= a.end.z; z++) {
                    const key = x + ',' + z;
                    assert.ok(!seen.has(key), 'overlap at ' + key + ' (rot ' + deg + ')');
                    seen.add(key);
                    cells++;
                }
            }
        }
        assert.equal(cells, W * D, 'covered cells (rot ' + deg + ')');
        assert.equal(seen.size, tw * td, 'box size (rot ' + deg + ')');
    }
});
