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
