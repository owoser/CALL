/**
 * Coordinate parsing: LSE returns the block CENTRE (x + 0.5).
 *
 * `ParamType.BlockPos` truncated that toward zero, so `-44` became `-43` and `-0.5` became `0`:
 * every negative coordinate was one block off - which is exactly "all wands are one block off",
 * and it only showed up in worlds with negative coordinates. The arguments are `Vec3` now and the
 * result is floored, which maps the centre back to its cell for both signs.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { join, dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..', '..');
const read = (rel) => readFileSync(join(ROOT, rel), 'utf8');

/** Same rule as CACommand.normalisePositions(). */
function toBlock(centre) {
    return { x: Math.floor(centre.x), y: Math.floor(centre.y), z: Math.floor(centre.z) };
}

test('the measured parser output maps back to the clicked cells', () => {
    // measured on the server: BlockPos 1376,179,-44 -> 1376,179,-43 ; Vec3 -> 1376.5,179,-43.5
    assert.deepEqual(toBlock({ x: 1376.5, y: 179, z: -43.5 }), { x: 1376, y: 179, z: -44 });
    assert.deepEqual(toBlock({ x: 10.5, y: 64, z: 44.5 }), { x: 10, y: 64, z: 44 });
    assert.deepEqual(toBlock({ x: 10.5, y: 64, z: -0.5 }), { x: 10, y: 64, z: -1 });
    assert.deepEqual(toBlock({ x: 10.5, y: 64, z: 0.5 }), { x: 10, y: 64, z: 0 });
    assert.deepEqual(toBlock({ x: 10.5, y: 64, z: -99.5 }), { x: 10, y: 64, z: -100 });
});

test('the old BlockPos truncation is what shifted negative coordinates', () => {
    const truncate = (v) => Math.trunc(v);
    assert.equal(truncate(-43.5), -43, 'that is the bug: -44 came back as -43');
    assert.equal(Math.floor(-43.5), -44, 'flooring keeps it');
});

test('the command layer uses Vec3 and floors the result', () => {
    const src = read('core/src/CACommand.ts');
    assert.equal(/ParamType\.BlockPos/.test(src), false, 'no BlockPos arguments may remain');
    assert.ok(/ParamType\.Vec3/.test(src), 'positions must be parsed as Vec3');
    assert.ok(src.includes('normalisePositions(res)'), 'the parsed values must be floored');
});
