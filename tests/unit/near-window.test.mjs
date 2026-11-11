/**
 * Which cells around the player may turn into passable sulfur cubes.
 *
 * The library replaces the whole set per call and scans it every 4 ticks, and the payload travels
 * through a ~16 KB string argument - so the selection has to be small, nearest-first, and must never
 * include a block-entity cell (leaving the radius re-sends the bare block).
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { join, dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { existsSync } from 'node:fs';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..', '..');
const MOD = join(ROOT, 'dist', 'call', 'core', 'src', 'structure', 'NearWindow.js');

const load = () => {
    assert.ok(existsSync(MOD), 'build first: npm run build:fast');
    return require(MOD);
};

const cell = (x, y, z, id = 'minecraft:stone') => ({ key: x + ',' + y + ',' + z, x, y, z, id });
const opts = (extra = {}) => ({ radius: 5, maxCells: 512, maxBytes: 12 * 1024, ...extra });

test('only cells inside the radius are selected', () => {
    const { selectNearCells } = load();
    const at = { x: 0.5, y: 64, z: 0.5 };
    const near = [cell(0, 64, 0), cell(3, 64, 0)];
    const far = [cell(20, 64, 0), cell(0, 80, 0)];
    const out = selectNearCells([...near, ...far], at, opts());
    assert.equal(out.cells.length, 2);
    assert.equal(out.dropped, 0);
});

test('radius 0 disables the feature', () => {
    const { selectNearCells } = load();
    const out = selectNearCells([cell(0, 64, 0)], { x: 0.5, y: 64, z: 0.5 }, opts({ radius: 0 }));
    assert.deepEqual(out.cells, []);
});

test('nearest cells win when the cap is small', () => {
    const { selectNearCells } = load();
    const cells = [cell(4, 64, 0), cell(0, 64, 0), cell(2, 64, 0)];
    const out = selectNearCells(cells, { x: 0.5, y: 64, z: 0.5 }, opts({ maxCells: 1 }));
    assert.equal(out.cells.length, 1);
    assert.equal(out.cells[0].x, 0, 'the closest cell is kept');
    assert.equal(out.dropped, 2);
});

test('block-entity cells are never selected', () => {
    const { selectNearCells } = load();
    const be = cell(1, 64, 1);
    const out = selectNearCells([cell(0, 64, 0), be], { x: 0.5, y: 64, z: 0.5 },
        opts({ exclude: new Set([be.key]) }));
    assert.equal(out.cells.length, 1);
    assert.ok(out.cells.every((c) => c.key !== be.key));
});

test('the byte budget truncates instead of overflowing the argument', () => {
    const { selectNearCells } = load();
    const long = 'minecraft:oak_stairs[weirdo_direction=2,upside_down_bit=false]';
    const cells = [];
    for (let i = 0; i < 200; i++) cells.push(cell(i % 5, 64, Math.floor(i / 5), long));
    const out = selectNearCells(cells, { x: 0.5, y: 64, z: 0.5 }, opts({ maxBytes: 400 }));
    assert.ok(out.cells.length > 0, 'something fits');
    assert.ok(out.bytes <= 400, 'budget respected: ' + out.bytes);
    assert.ok(out.dropped > 0, 'the rest is reported, not silently lost');
});

test('cells with an unusable descriptor are skipped', () => {
    const { selectNearCells } = load();
    const out = selectNearCells([cell(0, 64, 0, ''), cell(1, 64, 0, 'a;b')],
        { x: 0.5, y: 64, z: 0.5 }, opts());
    assert.deepEqual(out.cells, []);
});
