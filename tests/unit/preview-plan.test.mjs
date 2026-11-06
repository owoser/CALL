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

const ROT = require(join(ROOT, 'dist', 'call', 'core', 'src', 'structure', 'Rotate.js'));

function worldCells(blocks, anchorPoint, size, deg, mir, pivot) {
    return blocks.map((b) => {
        const [ox, oz] = ROT.cellOffset(b.dx, b.dz, size[0], size[2], deg, mir, pivot);
        return { x: anchorPoint.x + ox, y: anchorPoint.y + b.dy, z: anchorPoint.z + oz, id: b.id };
    });
}

/** Straightforward reference: project every block, test the cube, sort, crop. */
function naiveWindow(blocks, opts) {
    const { anchor: a, size, degrees, mirror, pivot } = opts;
    const r = Math.max(1, Math.floor(opts.radius));
    const cx = Math.floor(opts.center.x), cy = Math.floor(opts.center.y), cz = Math.floor(opts.center.z);
    let minX = cx - r, maxX = cx + r, minZ = cz - r, maxZ = cz + r;
    const minY = cy - r, maxY = cy + r;
    if (opts.prefetch && opts.prefetch.amount > 0) {
        const { dx, dz, amount } = opts.prefetch;
        if (dx > 0) maxX += amount; else if (dx < 0) minX -= amount;
        if (dz > 0) maxZ += amount; else if (dz < 0) minZ -= amount;
    }
    const hits = [];
    for (const c of worldCells(blocks, a, size, degrees, mirror, pivot)) {
        if (c.x < minX || c.x > maxX || c.y < minY || c.y > maxY || c.z < minZ || c.z > maxZ) continue;
        const dx = c.x - cx, dy = c.y - cy, dz = c.z - cz;
        hits.push({ c, d: dx * dx + dy * dy + dz * dz });
    }
    hits.sort((x, y) => x.d - y.d);
    const budget = Math.max(1, Math.floor(opts.budget));
    return hits.slice(0, budget).map((h) => [h.c.x, h.c.y, h.c.z].join(',')).sort();
}

function asKeys(cells) {
    return cells.map((c) => [c.x, c.y, c.z].join(',')).sort();
}

test('sourceGrid buckets clipboard columns and keeps the total', () => {
    const { sourceGrid, bucketKey } = load();
    const grid = sourceGrid([
        block(0, 0, 0, 'stone'),
        block(15, 0, 15, 'stone'),
        block(16, 0, 0, 'glass'),
    ]);
    assert.equal(grid.total, 3);
    assert.equal(bucketKey(0, 0), bucketKey(15, 15), 'same 16x16 column');
    assert.notEqual(bucketKey(15, 0), bucketKey(16, 0), '16 starts the next column');
    assert.equal(bucketKey(-1, -1), '-1,-1', 'negatives floor correctly');
});

test('windowFromSource keeps only the cube around the player, nearest first', () => {
    const { sourceGrid, windowFromSource } = load();
    const blocks = [];
    for (let dx = 0; dx < 3; dx++) for (let dz = 0; dz < 3; dz++) blocks.push(block(dx, 0, dz, 'a'));
    const grid = sourceGrid(blocks);
    const res = windowFromSource(grid, {
        anchor, size: [3, 1, 3], degrees: 0, mirror: 'none', pivot: 'inplace',
        center: { x: anchor.x, y: anchor.y, z: anchor.z }, radius: 1, budget: 100,
    });
    assert.equal(res.inWindow, 4, 'radius 1 keeps the 2x1x2 corner');
    assert.deepEqual([res.cells[0].x, res.cells[0].z], [anchor.x, anchor.z], 'nearest first');
});

test('the budget crops to the nearest cells and reports the real count', () => {
    const { sourceGrid, windowFromSource } = load();
    const blocks = [];
    for (let dx = 0; dx < 9; dx++) for (let dz = 0; dz < 9; dz++) blocks.push(block(dx, 0, dz, 'a'));
    const grid = sourceGrid(blocks);
    const res = windowFromSource(grid, {
        anchor, size: [9, 1, 9], degrees: 0, mirror: 'none', pivot: 'inplace',
        center: { x: anchor.x + 4, y: anchor.y, z: anchor.z + 4 }, radius: 4, budget: 5,
    });
    assert.equal(res.inWindow, 81);
    assert.equal(res.cells.length, 5);
    assert.deepEqual([res.cells[0].x, res.cells[0].z], [anchor.x + 4, anchor.z + 4], 'centre first');
});

test('prefetch extends the window on the facing side only', () => {
    const { sourceGrid, windowFromSource } = load();
    const blocks = [];
    for (let dx = 0; dx < 10; dx++) blocks.push(block(dx, 0, 0, 'a'));
    const grid = sourceGrid(blocks);
    const opts = {
        anchor, size: [10, 1, 1], degrees: 0, mirror: 'none', pivot: 'inplace',
        center: { x: anchor.x, y: anchor.y, z: anchor.z }, radius: 1, budget: 100,
    };
    assert.equal(windowFromSource(grid, opts).inWindow, 2);
    assert.equal(windowFromSource(grid, { ...opts, prefetch: { dx: 1, dz: 0, amount: 4 } }).inWindow, 6);
});

test('the source query equals a naive projection for every angle/mirror/pivot', () => {
    const { sourceGrid, windowFromSource } = load();
    const size = [7, 3, 5];
    const blocks = [];
    for (let dx = 0; dx < size[0]; dx++) {
        for (let dz = 0; dz < size[2]; dz++) {
            if ((dx + dz) % 2 === 0) continue;
            blocks.push(block(dx, dx % size[1], dz, dx % 2 ? 'minecraft:stone' : 'minecraft:glass'));
        }
    }
    const grid = sourceGrid(blocks);

    for (const degrees of [0, 90, 180, 270]) {
        for (const mirror of ['none', 'x', 'z', 'xz']) {
            for (const pivot of ['inplace', 'anchor']) {
                for (const center of [{ x: anchor.x, y: anchor.y, z: anchor.z }, { x: anchor.x + 2, y: anchor.y + 1, z: anchor.z + 1 }]) {
                    const opts = { anchor, size, degrees, mirror, pivot, center, radius: 2, budget: 12 };
                    const got = asKeys(windowFromSource(grid, opts).cells);
                    const want = naiveWindow(blocks, opts);
                    assert.deepEqual(got, want, `deg ${degrees} mirror ${mirror} pivot ${pivot} center ${center.x},${center.z}`);
                }
            }
        }
    }
});

test('rotating only re-queries: the same grid serves every angle', () => {
    const { sourceGrid, windowFromSource } = load();
    const size = [5, 1, 5];
    const blocks = [];
    // an L, so a rotation really changes which cells are occupied
    for (let dx = 0; dx < 3; dx++) for (let dz = 0; dz < 2; dz++) blocks.push(block(dx, 0, dz, 'a'));
    for (let dz = 2; dz < 4; dz++) blocks.push(block(0, 0, dz, 'a'));
    const grid = sourceGrid(blocks);
    const base = { anchor, size, mirror: 'none', pivot: 'inplace', center: { x: anchor.x, y: anchor.y, z: anchor.z }, radius: 9, budget: 100 };
    const seen = [0, 90, 180, 270].map((degrees) => asKeys(windowFromSource(grid, { ...base, degrees }).cells));
    for (const keys of seen) assert.equal(keys.length, blocks.length, 'every block stays inside the radius');
    assert.deepEqual(seen[0], naiveWindow(blocks, {
        anchor, size, degrees: 0, mirror: 'none', pivot: 'inplace', center: base.center, radius: 9, budget: 100,
    }));
    assert.notDeepEqual(seen[0], seen[1], 'but the cells themselves move');
    assert.equal(grid.total, blocks.length, 'one grid serves every angle');
});

test('untransformCell is the exact inverse of cellOffset (all angles and mirrors)', () => {
    const { untransformCell } = load();
    const w = 5, d = 3;
    for (const deg of [0, 90, 180, 270]) {
        for (const mirror of ['none', 'x', 'z', 'xz']) {
            for (const pivot of ['inplace', 'anchor']) {
                for (let dx = 0; dx < w; dx++) {
                    for (let dz = 0; dz < d; dz++) {
                        const [wx, wz] = ROT.cellOffset(dx, dz, w, d, deg, mirror, pivot);
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
    assert.equal(sampleOutline(blocks, anchor, [10, 1, 10], 0, 'none', 'inplace', 4, 1500).length, 25);
    assert.equal(sampleOutline(blocks, anchor, [10, 1, 10], 0, 'none', 'inplace', 1, 7).length, 7);
    assert.equal(sampleOutline(blocks, anchor, [10, 1, 10], 0, 'none', 'inplace', 1, 0).length, 0);
});
