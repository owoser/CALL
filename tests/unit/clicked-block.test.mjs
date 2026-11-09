/**
 * Deriving the clicked block from the hit point + face.
 *
 * The event's block is supposed to be the clicked one, but a click on a face reports a point on
 * that face's plane. When the engine hands back the neighbouring cell, every wand lands one block
 * off - which is exactly the repeated report. Geometry is the tie-breaker: step a fraction into the
 * block from the plane and floor.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';

/** Same rule as ToolOperation.clickedBlock(), kept here so it can be checked without a server. */
function clickedBlock(posFloat, side, fallback = { x: 0, y: 0, z: 0 }) {
    const eps = 1e-3;
    let x = posFloat.x, y = posFloat.y, z = posFloat.z;
    switch (Number(side)) {
        case 0: y += eps; break;
        case 1: y -= eps; break;
        case 2: z += eps; break;
        case 3: z -= eps; break;
        case 4: x += eps; break;
        case 5: x -= eps; break;
        default: return fallback;
    }
    return { x: Math.floor(x), y: Math.floor(y), z: Math.floor(z) };
}

test('the up face points at the block below the plane', () => {
    // clicked the block 1377,179,-45 on its top face
    assert.deepEqual(clickedBlock({ x: 1377.35, y: 180, z: -44.51 }, 1), { x: 1377, y: 179, z: -45 });
});

test('the down face points at the block above the plane', () => {
    assert.deepEqual(clickedBlock({ x: 10.5, y: 64, z: 10.5 }, 0), { x: 10, y: 64, z: 10 });
});

test('north and west faces keep the block (min-side planes)', () => {
    assert.deepEqual(clickedBlock({ x: 10.5, y: 64.5, z: -45 }, 2), { x: 10, y: 64, z: -45 });
    assert.deepEqual(clickedBlock({ x: 10, y: 64.5, z: -44.5 }, 4), { x: 10, y: 64, z: -45 });
});

test('south and east faces step back across the plane', () => {
    assert.deepEqual(clickedBlock({ x: 10.5, y: 64.5, z: -44 }, 3), { x: 10, y: 64, z: -45 });
    assert.deepEqual(clickedBlock({ x: 11, y: 64.5, z: -44.5 }, 5), { x: 10, y: 64, z: -45 });
});

test('an unknown face keeps whatever the event said', () => {
    const fallback = { x: 1, y: 2, z: 3 };
    assert.equal(clickedBlock({ x: 5.5, y: 5.5, z: 5.5 }, -1, fallback), fallback);
});
