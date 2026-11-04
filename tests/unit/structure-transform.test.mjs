/**
 * Offline tests for structure mirror / rotation.
 *
 * These matter because placement is per block: the game never sees a rotation parameter,
 * so if transformLayout() is wrong the operation silently writes the wrong shape (and
 * `/ca move` clears the source first, which would destroy the build).
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

const PALETTE = [
    { name: 'minecraft:air', states: {}, version: 0 },
    { name: 'minecraft:stone', states: {}, version: 0 },
    { name: 'minecraft:gold_block', states: {}, version: 0 },
];

/** 3 x 1 x 1 strip: stone at x=0, air at x=1, gold at x=2. */
function strip() {
    return { size: [3, 1, 1], indices: [1, 0, 2], palette: PALETTE };
}

/** Decode a layout into { "x,y,z": paletteIndex } for readable assertions. */
function cells(layout) {
    const [sx, sy, sz] = layout.size;
    const out = {};
    for (let x = 0; x < sx; x++) {
        for (let y = 0; y < sy; y++) {
            for (let z = 0; z < sz; z++) {
                const v = layout.indices[(x * sz + z) * sy + y];
                if (v != null && v >= 0) out[x + ',' + y + ',' + z] = v;
            }
        }
    }
    return out;
}

let codec;
function load() {
    assert.ok(existsSync(CODEC), 'build first: npm run build:fast');
    codec = require(CODEC);
}

test('identity transform returns the same layout', () => {
    load();
    const out = codec.transformLayout(strip(), { rotation: 0, mirror: 'none' });
    assert.deepEqual(out.size, [3, 1, 1]);
    assert.deepEqual(cells(out), { '0,0,0': 1, '1,0,0': 0, '2,0,0': 2 });
});

test('180 degrees keeps the footprint and reverses the axis', () => {
    load();
    const out = codec.transformLayout(strip(), { rotation: 180, mirror: 'none' });
    assert.deepEqual(out.size, [3, 1, 1]);
    const c = cells(out);
    assert.equal(c['0,0,0'], 2, 'gold should now be at x=0');
    assert.equal(c['2,0,0'], 1, 'stone should now be at x=2');
});

test('90 / 270 degrees swap the horizontal axes', () => {
    load();
    const r90 = codec.transformLayout(strip(), { rotation: 90, mirror: 'none' });
    assert.deepEqual(r90.size, [1, 1, 3], 'x/z must swap');
    const c90 = cells(r90);
    assert.equal(c90['0,0,0'], 1, 'stone at the near end');
    assert.equal(c90['0,0,2'], 2, 'gold at the far end');

    const r270 = codec.transformLayout(strip(), { rotation: 270, mirror: 'none' });
    assert.deepEqual(r270.size, [1, 1, 3]);
    const c270 = cells(r270);
    assert.equal(c270['0,0,0'], 2, 'gold at the near end (opposite of 90)');
    assert.equal(c270['0,0,2'], 1, 'stone at the far end');
});

test('90 twice equals 180 on a square footprint', () => {
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

test('mirror xz is a point reflection on a 2d plane', () => {
    load();
    const src = { size: [2, 1, 2], indices: [1, 1, 1, 0], palette: PALETTE };
    const out = codec.transformLayout(src, { rotation: 0, mirror: 'xz' });
    const c = cells(out);
    // the only air cell (x=1,z=1) must end up at the opposite corner (x=0,z=0)
    assert.equal(c['0,0,0'], 0);
    assert.equal(c['1,0,0'], 1);
});

test('mirror then rotate keeps every block (no data loss)', () => {
    load();
    const src = {
        size: [2, 2, 2],
        indices: [1, 0, 0, 0, 0, 0, 0, 2],
        palette: PALETTE,
    };
    const total = (l) => l.indices.filter((v) => v != null && v >= 0).length;
    const out = codec.transformLayout(src, { rotation: 90, mirror: 'x' });
    assert.equal(total(out), total(src), 'block count must be preserved');
    assert.deepEqual(out.size, [2, 2, 2]);
});
