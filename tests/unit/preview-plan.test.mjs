/**
 * Planning for the block-override preview.
 *
 * The ghost is drawn with viewBlock(): cell -> block id, sent per player. Two invariants matter
 * and are pinned here: the cells come from the same mapping the paste uses, and a rebuild sends
 * only the DIFFERENCE (otherwise rotating four times would re-send the whole build four times,
 * and a rotation back to 0 degrees would still cost a full clear + redraw).
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { join, dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { existsSync } from 'node:fs';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..', '..');
const MOD = join(ROOT, 'dist', 'call', 'core', 'src', 'structure', 'PreviewPlan.js');

function load() {
    assert.ok(existsSync(MOD), 'build first: npm run build:fast');
    return require(MOD);
}

const block = (dx, dy, dz, id) => ({ dx, dy, dz, id });
const anchor = { x: 100, y: 64, z: -200 };
const size = [3, 1, 3];

test('cells are anchor + offset, as integers, at 0 degrees', () => {
    const { planCells } = load();
    const cells = planCells(anchor, size, 0, 'none', 'inplace', [
        block(0, 0, 0, 'minecraft:stone'),
        block(2, 0, 2, 'minecraft:glass'),
    ]);
    assert.equal(cells.size, 2);
    assert.deepEqual(cells.get('100,64,-200'), { key: '100,64,-200', x: 100, y: 64, z: -200, id: 'minecraft:stone' });
    assert.deepEqual(cells.get('102,64,-198').id, 'minecraft:glass');
});

test('a rotation moves the cells and keeps them inside the box', () => {
    const { planCells } = load();
    const flat = planCells(anchor, size, 0, 'none', 'inplace', [block(2, 0, 0, 'minecraft:stone')]);
    const turned = planCells(anchor, size, 90, 'none', 'inplace', [block(2, 0, 0, 'minecraft:stone')]);
    assert.deepEqual([...flat.keys()], ['102,64,-200']);
    // 90 degrees maps (2,0) to (d-1-0, 2) = (2,2): the pattern turns inside the box
    assert.deepEqual([...turned.keys()], ['102,64,-198']);
});

test('an unchanged scene produces no work at all', () => {
    const { planCells, diffPlacement } = load();
    const applied = new Map();
    const cells = planCells(anchor, size, 0, 'none', 'inplace', [block(0, 0, 0, 'minecraft:stone')]);
    for (const [key, cell] of cells) applied.set(key, cell.id);

    assert.deepEqual(diffPlacement(applied, cells), []);
});

test('a changed block id is an overwrite, a dropped cell is a clear', () => {
    const { planCells, diffPlacement } = load();
    const before = planCells(anchor, size, 0, 'none', 'inplace', [
        block(0, 0, 0, 'minecraft:stone'),
        block(1, 0, 1, 'minecraft:dirt'),
    ]);
    const applied = new Map();
    for (const [key, cell] of before) applied.set(key, cell.id);

    const after = planCells(anchor, size, 0, 'none', 'inplace', [
        block(0, 0, 0, 'minecraft:glass'),
    ]);
    const ops = diffPlacement(applied, after);
    const sets = ops.filter((o) => o.op === 'set');
    const clears = ops.filter((o) => o.op === 'clear');
    assert.equal(sets.length, 1, 'only the changed block is re-sent');
    assert.equal(sets[0].id, 'minecraft:glass');
    assert.equal(clears.length, 1, 'the block that left the box is cleared');
    assert.deepEqual([clears[0].x, clears[0].y, clears[0].z], [101, 64, -199]);
});

test('four quarter turns return to zero work', () => {
    const { planCells, diffPlacement } = load();
    const blocks = [
        block(0, 0, 0, 'minecraft:stone'),
        block(2, 0, 0, 'minecraft:glass'),
        block(0, 0, 2, 'minecraft:dirt'),
        block(2, 0, 2, 'minecraft:sand'),
    ];
    const applied = new Map();
    for (const [key, cell] of planCells(anchor, size, 0, 'none', 'inplace', blocks)) applied.set(key, cell.id);

    // apply each turn like the scene does: send the diff, then remember it
    for (const deg of [90, 180, 270, 0]) {
        const desired = planCells(anchor, size, deg, 'none', 'inplace', blocks);
        for (const op of diffPlacement(applied, desired)) {
            if (op.op === 'set') applied.set(op.key, op.id);
            else applied.delete(op.key);
        }
    }

    const wanted = planCells(anchor, size, 0, 'none', 'inplace', blocks);
    assert.equal(applied.size, wanted.size, 'no leftovers');
    assert.deepEqual(diffPlacement(applied, wanted), [], 'back at 0 degrees nothing is left to send');
});

test('appliedCells turns tracked keys back into coordinates for cleanup', () => {
    const { appliedCells } = load();
    const cells = appliedCells(new Map([['100,64,-200', 'minecraft:stone'], ['102,64,-198', 'minecraft:glass']]));
    assert.deepEqual(cells.sort(), [[100, 64, -200], [102, 64, -198]]);
});

// ------------------------------------------------------------- streaming window

test('planGrid buckets cells by 16x16 column and keeps the total', () => {
    const { planGrid, bucketKey } = load();
    const blocks = [
        block(0, 0, 0, 'minecraft:stone'),
        block(15, 0, 15, 'minecraft:stone'),
        block(16, 0, 0, 'minecraft:glass'),
    ];
    const grid = planGrid(anchor, [17, 1, 17], 0, 'none', 'inplace', blocks);
    assert.equal(grid.total, 3);
    assert.equal(bucketKey(0, 0), bucketKey(15, 15), 'same 16x16 column');
    assert.notEqual(bucketKey(15, 0), bucketKey(16, 0), '16 crosses into the next column');
    assert.equal(bucketKey(-1, -1), '-1,-1', 'negatives floor correctly');
    // anchor is (100,64,-200): the three cells land on 100/-200, 115/-185 and 116/-200
    let total = 0;
    for (const list of grid.buckets.values()) total += list.length;
    assert.equal(total, 3, 'no cell lost when bucketing');
    assert.equal(grid.buckets.get(bucketKey(100, -200)).length, 1);
    assert.equal(grid.buckets.get(bucketKey(116, -200)).length, 1);
});

test('windowCells keeps only the cube around the player, nearest first', () => {
    const { planGrid, windowCells } = load();
    // a 3x1x3 plane at the anchor; the window centre is the corner cell
    const blocks = [
        block(0, 0, 0, 'a'), block(1, 0, 0, 'a'), block(2, 0, 0, 'a'),
        block(0, 0, 1, 'a'), block(1, 0, 1, 'a'), block(2, 0, 1, 'a'),
        block(0, 0, 2, 'a'), block(1, 0, 2, 'a'), block(2, 0, 2, 'a'),
    ];
    const grid = planGrid(anchor, [3, 1, 3], 0, 'none', 'inplace', blocks);
    const res = windowCells(grid, {
        center: { x: anchor.x, y: anchor.y, z: anchor.z },
        radius: 1,
        budget: 100,
    });
    // radius 1 (Chebyshev) around (0,0,0) keeps 2x1x2 = 4 cells
    assert.equal(res.inWindow, 4);
    assert.equal(res.cells.length, 4);
    assert.deepEqual([res.cells[0].x, res.cells[0].z], [anchor.x, anchor.z], 'nearest first');
    for (const cell of res.cells) {
        assert.ok(Math.abs(cell.x - anchor.x) <= 1 && Math.abs(cell.z - anchor.z) <= 1);
    }
});

test('the budget crops the window to the nearest cells and reports the real count', () => {
    const { planGrid, windowCells } = load();
    const blocks = [];
    for (let dx = 0; dx < 9; dx++) for (let dz = 0; dz < 9; dz++) blocks.push(block(dx, 0, dz, 'a'));
    const grid = planGrid(anchor, [9, 1, 9], 0, 'none', 'inplace', blocks);

    const res = windowCells(grid, { center: { x: anchor.x + 4, y: anchor.y, z: anchor.z + 4 }, radius: 4, budget: 5 });
    assert.equal(res.inWindow, 81, 'everything is inside the radius');
    assert.equal(res.cells.length, 5, 'but only the budget is drawn');
    assert.deepEqual([res.cells[0].x, res.cells[0].z], [anchor.x + 4, anchor.z + 4], 'centre first');
});

test('prefetch extends the window on the facing side only', () => {
    const { planGrid, windowCells } = load();
    const blocks = [];
    for (let dx = 0; dx < 10; dx++) blocks.push(block(dx, 0, 0, 'a'));
    const grid = planGrid(anchor, [10, 1, 1], 0, 'none', 'inplace', blocks);
    const base = windowCells(grid, { center: { x: anchor.x, y: anchor.y, z: anchor.z }, radius: 1, budget: 100 });
    const ahead = windowCells(grid, {
        center: { x: anchor.x, y: anchor.y, z: anchor.z },
        radius: 1,
        budget: 100,
        prefetch: { dx: 1, dz: 0, amount: 4 },
    });
    assert.equal(base.inWindow, 2);
    assert.equal(ahead.inWindow, 6, '+4 cells ahead on +X');
});

test('untransformCell is the exact inverse of cellOffset (all angles and mirrors)', () => {
    const { untransformCell } = load();
    const R = require(join(ROOT, 'dist', 'call', 'core', 'src', 'structure', 'Rotate.js'));
    const w = 5, d = 3;
    for (const deg of [0, 90, 180, 270]) {
        for (const mirror of ['none', 'x', 'z', 'xz']) {
            for (const pivot of ['inplace', 'anchor']) {
                for (let dx = 0; dx < w; dx++) {
                    for (let dz = 0; dz < d; dz++) {
                        const [wx, wz] = R.cellOffset(dx, dz, w, d, deg, mirror, pivot);
                        const [bx, bz] = untransformCell(wx, wz, w, d, deg, mirror, pivot);
                        assert.deepEqual([bx, bz], [dx, dz],
                            `deg ${deg} mirror ${mirror} pivot ${pivot} cell ${dx},${dz}`);
                    }
                }
            }
        }
    }
});

test('sampleOutline thins the surface and respects its cap', () => {
    const { sampleOutline } = load();
    const blocks = [];
    for (let i = 0; i < 100; i++) blocks.push(block(i % 10, 0, Math.floor(i / 10), 'a'));
    const step4 = sampleOutline(blocks, anchor, [10, 1, 10], 0, 'none', 'inplace', 4, 1500);
    assert.equal(step4.length, 25, 'every 4th block of 100');
    const capped = sampleOutline(blocks, anchor, [10, 1, 10], 0, 'none', 'inplace', 1, 7);
    assert.equal(capped.length, 7);
    assert.equal(sampleOutline(blocks, anchor, [10, 1, 10], 0, 'none', 'inplace', 1, 0).length, 0);
});
