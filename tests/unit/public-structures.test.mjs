/**
 * Grouping the files of a hand-managed public structure folder.
 *
 * Pins the case that produced "公开结构列表报错": a folder can hold a single file or the slices
 * of a bigger build, and a half-copied structure must be reported as incomplete instead of
 * loading one quarter of a building.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { join, dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { existsSync } from 'node:fs';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..', '..');
const MOD = join(ROOT, 'dist', 'call', 'core', 'src', 'structure', 'StructureStore.js');

function load() {
    assert.ok(existsSync(MOD), 'build first: npm run build:fast');
    return require(MOD);
}

test('a single-file structure is one complete group', () => {
    const S = load();
    const groups = S.groupSlices(['mw4w5g20ay.mcstructure']);
    assert.equal(groups.length, 1);
    assert.deepEqual([groups[0].sid, groups[0].xSize, groups[0].zSize], ['mw4w5g20ay', 1, 1]);
    assert.equal(groups[0].complete, true);
});

test('a 2x2 structure is complete only when all four slices are there', () => {
    const S = load();
    const full = S.groupSlices(['m1_0_0.mcstructure', 'm1_1_0.mcstructure', 'm1_0_1.mcstructure', 'm1_1_1.mcstructure']);
    assert.equal(full.length, 1);
    assert.deepEqual([full[0].xSize, full[0].zSize], [2, 2]);
    assert.equal(full[0].present, 4);
    assert.equal(full[0].complete, true);

    const missing = S.groupSlices(['m1_0_0.mcstructure', 'm1_1_1.mcstructure']);
    assert.equal(missing[0].complete, false, 'two of four is not complete');
    assert.equal(missing[0].present, 2);
});

test('several structures in one folder are separate groups', () => {
    const S = load();
    const groups = S.groupSlices(['a.mcstructure', 'b.mcstructure', 'b_1_0.mcstructure']);
    assert.equal(groups.length, 2);
    const b = groups.find((g) => g.sid === 'b');
    assert.deepEqual([b.xSize, b.zSize, b.complete], [2, 1, true]);
});

test('non-mcstructure files are ignored', () => {
    const S = load();
    const groups = S.groupSlices(['README.txt', 'x.mcstructure']);
    assert.equal(groups.length, 1);
    assert.equal(groups[0].sid, 'x');
});

test('file names with dots and dashes keep their id', () => {
    const S = load();
    const groups = S.groupSlices(['my-structure.v2.mcstructure']);
    assert.equal(groups[0].sid, 'my-structure.v2');
});

test('a public folder name maps to its internal slice id', () => {
    const S = load();
    const store = S.default;
    store.clearIndex();
    store.alias('领地02号', 'mw4w5g20ay');
    assert.equal(store.sliceSidOf('领地02号'), 'mw4w5g20ay');
    assert.equal(store.sliceSidOf('unknown-id'), 'unknown-id', 'unknown ids pass through');
    assert.equal(store.sliceSidOf(''), '');
});
