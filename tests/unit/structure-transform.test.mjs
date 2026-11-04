/**
 * Offline tests for structure layout order, mirror and rotation.
 *
 * These matter because placement is per block: the game never sees a rotation parameter,
 * so a wrong index order or a wrong transform silently writes the wrong shape (and
 * `/ca move` clears the source first, which is data loss).
 *
 * The index order is NOT a convention we can pick: the Bedrock .mcstructure format stores
 * block_indices in ZYX order (`SZ*SY*X + SZ*Y + Z`), i.e. Z varies fastest. 3.0.0 used
 * "Y fastest" and transposed every pasted structure.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { join, dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { existsSync } from 'node:fs';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..', '..');
const CODEC = join(ROOT, 'dist', 'call', 'core', 'src', 'io', 'NbtCodec.js');
// StructureOrder and NbtCodec are dependency free on purpose, so they load outside the
// game. StructurePlacement pulls in Config (which needs the engine globals).
const ORDER = join(ROOT, 'dist', 'call', 'core', 'src', 'io', 'StructureOrder.js');

const PALETTE = [
    { name: 'minecraft:air', states: {}, version: 0 },
    { name: 'minecraft:stone', states: {}, version: 0 },
    { name: 'minecraft:gold_block', states: {}, version: 0 },
];

let codec;
let placement;

function load() {
    assert.ok(existsSync(CODEC), 'build first: npm run build:fast');
    codec = require(CODEC);
    placement = require(ORDER);
}

/** Spec order: SZ*SY*X + SZ*Y + Z. */
function idx(x, y, z, sz, sy) {
    return sz * sy * x + sz * y + z;
}

/** True when a palette entry is air (those cells are "empty" for a shape). */
function isAir(layout, index) {
    const entry = layout.palette[index];
    return entry == null || entry.name === 'minecraft:air';
}

/**
 * Decode a layout into { "x,y,z": paletteIndex } using the spec order.
 * Air cells are skipped by default so assertions read like the visible shape.
 */
function cells(layout, includeAir = false) {
    const [sx, sy, sz] = layout.size;
    const out = {};
    for (let x = 0; x < sx; x++) {
        for (let y = 0; y < sy; y++) {
            for (let z = 0; z < sz; z++) {
                const v = layout.indices[idx(x, y, z, sz, sy)];
                if (v == null || v < 0) continue;
                if (!includeAir && isAir(layout, v)) continue;
                out[x + ',' + y + ',' + z] = v;
            }
        }
    }
    return out;
}

// --------------------------------------------------------------------- order

test('cellIndex follows the documented ZYX order (Z fastest)', () => {
    load();
    // 2 x 2 x 2: the first four indices must walk Z then Y, keeping X at 0
    assert.equal(placement.cellIndex(0, 0, 0, 2, 2), 0);
    assert.equal(placement.cellIndex(0, 0, 1, 2, 2), 1, 'Z must vary fastest');
    assert.equal(placement.cellIndex(0, 1, 0, 2, 2), 2, 'then Y');
    assert.equal(placement.cellIndex(0, 1, 1, 2, 2), 3);
    assert.equal(placement.cellIndex(1, 0, 0, 2, 2), 4, 'then X');
});

test('cellCoords is the exact inverse of cellIndex', () => {
    load();
    for (const [sx, sy, sz] of [[3, 2, 1], [1, 2, 3], [4, 5, 6], [1, 1, 1]]) {
        for (let x = 0; x < sx; x++) {
            for (let y = 0; y < sy; y++) {
                for (let z = 0; z < sz; z++) {
                    const i = placement.cellIndex(x, y, z, sz, sy);
                    const back = placement.cellCoords(i, sz, sy);
                    assert.deepEqual(back, { x, y, z }, `roundtrip ${sx}x${sy}x${sz} at ${x},${y},${z} -> ${i}`);
                }
            }
        }
    }
});

test('a Y-fastest index order would be caught by the layout helper', () => {
    load();
    // sz and sy must both be > 1 for the two orders to disagree at all (3.0.0's mistake
    // was invisible whenever the region was square or one cell deep).
    const spec = idx(1, 1, 0, 2, 2);          // SZ*SY*X + SZ*Y + Z = 6
    const yFastest = (1 * 2 + 0) * 2 + 1;     // (x*sz + z)*sy + y  = 5
    assert.equal(spec, 6);
    assert.notEqual(spec, yFastest, 'the two orders must differ for this case');
    assert.equal(placement.cellIndex(1, 1, 0, 2, 2), spec, 'cellIndex must use ZYX');
});

// ---------------------------------------------------------------- transforms

/** 3 x 1 x 1 strip: stone at x=0, air at x=1, gold at x=2. */
function strip() {
    const size = [3, 1, 1];
    const indices = new Array(3).fill(0);
    indices[idx(0, 0, 0, 1, 1)] = 1;
    indices[idx(2, 0, 0, 1, 1)] = 2;
    return { size, indices, palette: PALETTE };
}

/** 1 x 1 x 3 strip along Z: stone at z=0, gold at z=2. */
function stripZ() {
    const size = [1, 1, 3];
    const indices = new Array(3).fill(0);
    indices[idx(0, 0, 0, 3, 1)] = 1;
    indices[idx(0, 0, 2, 3, 1)] = 2;
    return { size, indices, palette: PALETTE };
}

test('identity transform returns the same layout', () => {
    load();
    const out = codec.transformLayout(strip(), { rotation: 0, mirror: 'none' });
    assert.deepEqual(out.size, [3, 1, 1]);
    assert.deepEqual(cells(out), { '0,0,0': 1, '2,0,0': 2 });
    assert.deepEqual(cells(out, true), { '0,0,0': 1, '1,0,0': 0, '2,0,0': 2 }, 'air must be preserved in the layout');
});

test('180 degrees keeps the footprint and reverses the axis', () => {
    load();
    const out = codec.transformLayout(strip(), { rotation: 180, mirror: 'none' });
    assert.deepEqual(out.size, [3, 1, 1]);
    const c = cells(out);
    assert.equal(c['0,0,0'], 2, 'gold should now be at x=0');
    assert.equal(c['2,0,0'], 1, 'stone should now be at x=2');
});

test('90 / 270 degrees swap the horizontal axes and mirror each other', () => {
    load();
    const r90 = codec.transformLayout(strip(), { rotation: 90, mirror: 'none' });
    assert.deepEqual(r90.size, [1, 1, 3], 'x/z must swap');

    const r270 = codec.transformLayout(strip(), { rotation: 270, mirror: 'none' });
    assert.deepEqual(r270.size, [1, 1, 3]);

    // invariant: both stay a 2-cell line along Z with the same two materials ...
    const c90 = cells(r90);
    const c270 = cells(r270);
    for (const c of [c90, c270]) {
        assert.equal(Object.keys(c).length, 2, 'block count preserved');
        assert.equal(Object.keys(c).every((k) => k.startsWith('0,0,')), true, 'line must run along Z');
        assert.deepEqual(Object.values(c).sort(), [1, 2], 'both materials preserved');
    }
    // ... and 90 is the reverse of 270
    assert.equal(c90['0,0,0'], c270['0,0,2']);
    assert.equal(c90['0,0,2'], c270['0,0,0']);
});

test('rotating a Z strip by 90 gives an X strip', () => {
    load();
    const out = codec.transformLayout(stripZ(), { rotation: 90, mirror: 'none' });
    assert.deepEqual(out.size, [3, 1, 1]);
    const c = cells(out);
    assert.equal(Object.keys(c).length, 2, 'block count preserved');
    assert.equal(Object.keys(c).every((k) => k.endsWith(',0,0')), true, 'all cells now lie along X');
    assert.deepEqual(Object.values(c).sort(), [1, 2], 'both materials preserved');
});

test('90 twice equals 180', () => {
    load();
    const src = { size: [2, 1, 2], indices: [1, 2, 0, 0], palette: PALETTE };
    const twice = codec.transformLayout(codec.transformLayout(src, { rotation: 90 }), { rotation: 90 });
    const once = codec.transformLayout(src, { rotation: 180 });
    assert.deepEqual(twice.size, once.size);
    assert.deepEqual(twice.indices, once.indices);
});

test('mirror x flips the x axis only', () => {
    load();
    const out = codec.transformLayout(strip(), { rotation: 0, mirror: 'x' });
    assert.deepEqual(out.size, [3, 1, 1]);
    const c = cells(out);
    assert.equal(c['0,0,0'], 2, 'gold moved to x=0');
    assert.equal(c['2,0,0'], 1, 'stone moved to x=2');
});

test('mirror z flips the z axis only', () => {
    load();
    const out = codec.transformLayout(stripZ(), { rotation: 0, mirror: 'z' });
    const c = cells(out);
    assert.equal(c['0,0,0'], 2);
    assert.equal(c['0,0,2'], 1);
});

test('mirror xz is a point reflection', () => {
    load();
    // 2x1x2 of stone with a single gold cell at (1,0,1)
    const indices = new Array(4).fill(1);
    indices[idx(1, 0, 1, 2, 1)] = 2;
    const src = { size: [2, 1, 2], indices, palette: PALETTE };

    const out = codec.transformLayout(src, { rotation: 0, mirror: 'xz' });
    const c = cells(out);
    assert.equal(c['0,0,0'], 2, 'the marker must land on the opposite corner');
    assert.equal(c['1,0,1'], 1, 'and the old corner must be plain stone');
    assert.equal(Object.keys(c).length, 4, 'no cells lost');
});

test('mirror then rotate keeps every block (no data loss)', () => {
    load();
    const src = { size: [2, 2, 2], indices: [1, 0, 0, 0, 0, 0, 0, 2], palette: PALETTE };
    const total = (l) => l.indices.filter((v) => v != null && v >= 0).length;
    const out = codec.transformLayout(src, { rotation: 90, mirror: 'x' });
    assert.equal(total(out), total(src), 'block count must be preserved');
    assert.deepEqual(out.size, [2, 2, 2]);
});
