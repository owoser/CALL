/**
 * The preview rotates the CELLS in planCells(); the block STATES have to follow it there.
 *
 * Extraction always runs at 0 degrees, so anything remapped at extract time uses the wrong angle
 * (that was the "0 degrees is right, 90 degrees is wrong" bug).
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { join, dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { existsSync } from 'node:fs';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..', '..');
const PLAN = join(ROOT, 'dist', 'call', 'core', 'src', 'structure', 'PreviewPlan.js');

function load() {
    assert.ok(existsSync(PLAN), 'build first: npm run build:fast');
    return require(PLAN);
}

const STAIRS = { type: 3, value: 0 }; // east
const block = (dx, dz, dir) => ({
    dx, dy: 0, dz,
    id: 'minecraft:stone_stairs[weirdo_direction=' + dir + ',upside_down_bit=false]',
    blockSnbt: '{"name":"minecraft:stone_stairs","states":{"weirdo_direction":' + dir + ',"upside_down_bit":0b},"version":18168865}',
    raw: { name: 'minecraft:stone_stairs', states: { weirdo_direction: { type: 3, value: dir }, upside_down_bit: { type: 1, value: 0 } } },
});

const dirOf = (s) => Number((/weirdo_direction=(\d)/.exec(s.id) || [])[1]);

test('planCells turns the state with the cells', () => {
    const { planCells } = load();
    const blocks = [block(0, 0, 0)];
    const at = (degrees, mirror = 'none') => {
        const cells = planCells({ x: 0, y: 0, z: 0 }, [2, 1, 2], degrees, mirror, 'inplace', blocks);
        return [...cells.values()][0];
    };
    assert.equal(dirOf(at(0)), 0, '0 degrees must keep the source facing');
    assert.equal(dirOf(at(90)), 2);
    assert.equal(dirOf(at(180)), 1);
    assert.equal(dirOf(at(270)), 3);
    assert.equal(dirOf(at(0, 'x')), 1, 'mirror X flips east/west');
});

test('the rotated cell keeps a block SNBT that matches the turned states', () => {
    const { planCells } = load();
    const cells = planCells({ x: 0, y: 0, z: 0 }, [2, 1, 2], 90, 'none', 'inplace', [block(0, 0, 0)]);
    const cell = [...cells.values()][0];
    assert.equal(dirOf({ id: cell.id }), 2);
    assert.match(cell.blockSnbt, /"weirdo_direction":2\b/, 'SNBT must carry the turned state: ' + cell.blockSnbt);
});

test('cells without states are left exactly as extracted', () => {
    const { planCells } = load();
    const plain = { dx: 0, dy: 0, dz: 0, id: 'minecraft:gold_block' };
    const cell = [...planCells({ x: 0, y: 0, z: 0 }, [2, 1, 2], 90, 'none', 'inplace', [plain]).values()][0];
    assert.equal(cell.id, 'minecraft:gold_block');
    assert.equal(cell.blockSnbt, undefined);
});
