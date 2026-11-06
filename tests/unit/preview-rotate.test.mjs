/**
 * Rotation / mirror maths for the paste preview.
 *
 * These are pure functions, and getting them wrong would silently paste into the wrong
 * footprint - so every combination is pinned down here, including the 90/270 size swap.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { join, dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { existsSync } from 'node:fs';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..', '..');
const MOD = join(ROOT, 'dist', 'call', 'core', 'src', 'structure', 'Rotate.js');

function load() {
    assert.ok(existsSync(MOD), 'build first: npm run build:fast');
    return require(MOD);
}

const pos = (x, y, z) => ({ x, y, z, dimid: 0 });

test('rotateOffset turns clockwise and returns to identity', () => {
    const { rotateOffset } = load();
    assert.deepEqual(rotateOffset(1, 0, 0), [1, 0]);
    assert.deepEqual(rotateOffset(1, 0, 90), [0, 1]);
    assert.deepEqual(rotateOffset(1, 0, 180), [-1, 0]);
    assert.deepEqual(rotateOffset(1, 0, 270), [0, -1]);
    // four quarter turns = identity
    let [x, z] = [3, 5];
    for (let i = 0; i < 4; i++) [x, z] = rotateOffset(x, z, 90);
    assert.deepEqual([x, z], [3, 5]);
});

test('mirrorOffset flips the requested axes only', () => {
    const { mirrorOffset } = load();
    assert.deepEqual(mirrorOffset(2, 3, 'none'), [2, 3]);
    assert.deepEqual(mirrorOffset(2, 3, 'x'), [-2, 3]);
    assert.deepEqual(mirrorOffset(2, 3, 'z'), [2, -3]);
    assert.deepEqual(mirrorOffset(2, 3, 'xz'), [-2, -3]);
});

test('rotatedUnion swaps the footprint at 90/270 and keeps Y', () => {
    const { rotatedUnion } = load();
    // a 4x1x2 slice starting at the paste anchor
    const complex = { sid: { area: { start: pos(0, 0, 0), end: pos(3, 0, 1) } } };

    const flat = rotatedUnion(complex, pos(100, 64, 100), 0, 'none');
    assert.deepEqual(
        { x1: flat.x1, y1: flat.y1, z1: flat.z1, x2: flat.x2, y2: flat.y2, z2: flat.z2 },
        { x1: 100, y1: 64, z1: 100, x2: 103, y2: 64, z2: 101 }
    );

    const turned = rotatedUnion(complex, pos(100, 64, 100), 90, 'none');
    assert.equal(Math.abs(turned.x2 - turned.x1), 1, 'x extent becomes the old z extent');
    assert.equal(Math.abs(turned.z2 - turned.z1), 3, 'z extent becomes the old x extent');
    // the rotated box grows FROM the anchor: it never jumps to the negative side
    assert.deepEqual(
        [turned.x1, turned.z1, turned.x2, turned.z2],
        [100, 100, 101, 103]
    );
    assert.equal(turned.y1, 64);
    assert.equal(turned.y2, 64);
});

test('rotatedUnion unions every slice and applies the mirror', () => {
    const { rotatedUnion } = load();
    const complex = {
        a: { area: { start: pos(0, 0, 0), end: pos(1, 1, 1) } },
        b: { area: { start: pos(4, 0, 0), end: pos(5, 2, 1) } },
    };
    const box = rotatedUnion(complex, pos(10, 70, 10), 0, 'none');
    assert.deepEqual([box.x1, box.x2, box.y1, box.y2, box.z1, box.z2], [10, 15, 70, 72, 10, 11]);

    // Mirroring rearranges the pattern INSIDE the box; the box itself still starts at the
    // anchor. (It used to be computed from the slices' absolute coordinates, which put it at
    // 5..10 - the bug that made the wireframe and the real paste disagree.)
    const mirrored = rotatedUnion(complex, pos(10, 70, 10), 0, 'x');
    assert.deepEqual([mirrored.x1, mirrored.x2], [10, 15]);
});

test('rotatedTargetAreas returns one area per slice, rotated', () => {
    const { rotatedTargetAreas } = load();
    const complex = { a: { area: { start: pos(0, 0, 0), end: pos(3, 0, 1) } } };
    const areas = rotatedTargetAreas(complex, pos(0, 64, 0), 90, 'none');
    assert.equal(areas.length, 1);
    assert.equal(areas[0].start.y, 64);
    assert.equal(Math.abs(areas[0].end.x - areas[0].start.x), 1);
    assert.equal(Math.abs(areas[0].end.z - areas[0].start.z), 3);
});

test('degreesName matches the /structure rotation vocabulary', () => {
    const { degreesName } = load();
    assert.equal(degreesName(0), '0_degrees');
    assert.equal(degreesName(90), '90_degrees');
    assert.equal(degreesName(270), '270_degrees');
});