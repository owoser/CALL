/**
 * Preview geometry: surface culling and clipboard slice offsets.
 *
 * Both are pure and both are easy to get subtly wrong (an off-by-one in the neighbour test
 * hides a wall; a wrong slice offset stacks two halves of a build on top of each other).
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { join, dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { existsSync } from 'node:fs';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..', '..');
const SURF = join(ROOT, 'dist', 'call', 'core', 'src', 'structure', 'SurfaceExtract.js');
const CLIP = join(ROOT, 'dist', 'call', 'core', 'src', 'structure', 'Clipboard.js');
const ORDER = join(ROOT, 'dist', 'call', 'core', 'src', 'io', 'StructureOrder.js');

function loadSurf() {
    assert.ok(existsSync(SURF), 'build first: npm run build:fast');
    return require(SURF);
}
function loadClip() {
    assert.ok(existsSync(CLIP), 'build first: npm run build:fast');
    return require(CLIP);
}
function loadOrder() {
    assert.ok(existsSync(ORDER), 'build first: npm run build:fast');
    return require(ORDER);
}

/** Build a solid cube layout of the given size. */
function cube(sx, sy, sz, name = 'minecraft:stone') {
    const indices = new Array(sx * sy * sz).fill(0);
    return { size: [sx, sy, sz], indices, palette: [{ name, states: {}, version: 0 }] };
}

test('a solid cube keeps only its shell', () => {
    const { extractSurface } = loadSurf();
    const res = extractSurface([{ origin: [0, 0, 0], layout: cube(5, 5, 5) }], 0, 'none', 100000);
    assert.equal(res.solid, 125);
    // shell of 5x5x5 = 125 - 27 = 98
    assert.equal(res.visible, 98);
    assert.equal(res.truncated, false);
});

test('a single layer is fully visible (no neighbours above or below)', () => {
    const { extractSurface } = loadSurf();
    const res = extractSurface([{ origin: [0, 0, 0], layout: cube(4, 1, 4) }], 0, 'none', 100000);
    assert.equal(res.solid, 16);
    assert.equal(res.visible, 16);
});

test('neighbouring slices cull their shared faces', () => {
    const { extractSurface } = loadSurf();
    // two 2x2x2 cubes side by side along X form a 4x2x2 cuboid: shell = 32 - 0 interior
    const res = extractSurface(
        [
            { origin: [0, 0, 0], layout: cube(2, 2, 2) },
            { origin: [2, 0, 0], layout: cube(2, 2, 2) },
        ],
        0, 'none', 100000
    );
    assert.equal(res.solid, 16);
    assert.equal(res.visible, 16, 'a 4x2x2 cuboid has no interior blocks');
});

test('air and structure_void are not counted', () => {
    const { extractSurface } = loadSurf();
    const layout = {
        size: [2, 1, 1],
        indices: [0, 1],
        palette: [
            { name: 'minecraft:stone', states: {}, version: 0 },
            { name: 'minecraft:air', states: {}, version: 0 },
        ],
    };
    const res = extractSurface([{ origin: [0, 0, 0], layout }], 0, 'none', 100000);
    assert.equal(res.solid, 1);
    assert.equal(res.visible, 1);
});

/**
 * The preview used to decode block_indices with "X varies fastest" (i = z*sx*sy + y*sx + x)
 * instead of the format's ZYX order (SZ*SY*X + SZ*Y + Z), i.e. it TRANSPOSED x and z. A 3x1x3
 * clipboard of horizontal stripes previewed as vertical stripes while the paste wrote the
 * real ones - the user report "预览和粘贴不一致 / 预览像是按我的朝向转了".
 *
 * Solid cubes cannot catch this (any axis permutation of a cube is the same cube), so every
 * fixture here now carries a unique block per cell.
 */
function labelledLayout(sx, sy, sz) {
    const indices = new Array(sx * sy * sz).fill(-1);
    const palette = [];
    for (let x = 0; x < sx; x++) {
        for (let y = 0; y < sy; y++) {
            for (let z = 0; z < sz; z++) {
                palette.push({ name: 'minecraft:c' + x + '_' + y + '_' + z, states: {}, version: 0 });
                indices[loadOrder().cellIndex(x, y, z, sz, sy)] = palette.length - 1;
            }
        }
    }
    return { size: [sx, sy, sz], indices, palette };
}

test('every block keeps its real coordinate (no x/z transpose)', () => {
    const { extractSurface } = loadSurf();

    for (const [sx, sy, sz] of [[3, 1, 3], [2, 3, 2], [3, 1, 5]]) {
        const layout = labelledLayout(sx, sy, sz);
        const res = extractSurface([{ origin: [0, 0, 0], layout }], 0, 'none', 100000);
        assert.ok(res.blocks.length > 0, 'something to check');
        for (const block of res.blocks) {
            const m = /^minecraft:c(\d+)_(\d+)_(\d+)$/.exec(block.id);
            assert.ok(m != null, 'unexpected id ' + block.id);
            const [, x, y, z] = m.map(Number);
            assert.deepEqual(
                [block.dx, block.dy, block.dz], [x, y, z],
                `${sx}x${sy}x${sz}: ${block.id} landed on ${block.dx},${block.dy},${block.dz}`
            );
        }
    }
});

test('a striped clipboard previews the same stripes the paste writes', () => {
    const { extractSurface } = loadSurf();
    const { cellIndex } = loadOrder();

    // the real clipboard from the report: 3 wide, 1 tall, 3 deep, whole rows of one material
    const sx = 3, sy = 1, sz = 3;
    const rows = [
        ['bamboo_planks', 'bamboo_planks', 'bamboo_planks'],
        ['crimson_planks', 'warped_planks', 'jungle_planks'],
        ['cherry_planks', 'cherry_planks', 'cherry_planks'],
    ];
    const indices = new Array(sx * sy * sz).fill(-1);
    const palette = [];
    const pi = new Map();
    for (let z = 0; z < sz; z++) {
        for (let x = 0; x < sx; x++) {
            const name = 'minecraft:' + rows[z][x];
            if (!pi.has(name)) { pi.set(name, palette.length); palette.push({ name, states: {}, version: 0 }); }
            indices[cellIndex(x, 0, z, sz, sy)] = pi.get(name);
        }
    }

    const res = extractSurface([{ origin: [0, 0, 0], layout: { size: [sx, sy, sz], indices, palette } }], 0, 'none', 100000);
    assert.equal(res.blocks.length, 9, 'a single layer is fully visible');

    // every block must sit where the paste will put it, with the same material
    for (const block of res.blocks) {
        assert.equal(
            block.id, 'minecraft:' + rows[block.dz][block.dx],
            'block at (' + block.dx + ',' + block.dz + ') is ' + block.id
        );
    }
    // and the stripes stay stripes along X (a transposed decode turns them into columns)
    assert.equal(new Set(res.blocks.filter((b) => b.dz === 0).map((b) => b.id)).size, 1, 'top row is one material');
    assert.equal(new Set(res.blocks.filter((b) => b.dz === 2).map((b) => b.id)).size, 1, 'bottom row is one material');
});

test('the budget truncates the list but keeps the top layers', () => {
    const { extractSurface } = loadSurf();
    const res = extractSurface([{ origin: [0, 0, 0], layout: cube(5, 5, 5) }], 0, 'none', 10);
    assert.equal(res.truncated, true);
    assert.equal(res.blocks.length, 10);
    assert.equal(res.visible, 98);
    // sorted by dy descending: the highest layer survives the cut
    const maxDy = Math.max(...res.blocks.map((b) => b.dy));
    assert.equal(maxDy, 4);
});

test('90 degree rotation swaps the footprint', () => {
    const { extractSurface } = loadSurf();
    const layout = cube(4, 1, 2);
    const flat = extractSurface([{ origin: [0, 0, 0], layout }], 0, 'none', 100000);
    const turned = extractSurface([{ origin: [0, 0, 0], layout }], 90, 'none', 100000);
    const range = (blocks, key) => Math.max(...blocks.map((b) => b[key])) - Math.min(...blocks.map((b) => b[key]));
    assert.equal(range(flat.blocks, 'dx'), 3);
    assert.equal(range(flat.blocks, 'dz'), 1);
    assert.equal(range(turned.blocks, 'dx'), 1);
    assert.equal(range(turned.blocks, 'dz'), 3);
});

test('slice offsets come from the chunk index in the file name', () => {
    const { sliceOrigin, SLICE_LENGTH } = loadClip();
    assert.deepEqual(sliceOrigin('abc_0_0'), [0, 0, 0]);
    assert.deepEqual(sliceOrigin('abc_1_0'), [SLICE_LENGTH, 0, 0]);
    assert.deepEqual(sliceOrigin('abc_0_2'), [0, 0, 2 * SLICE_LENGTH]);
    assert.deepEqual(sliceOrigin('no-suffix'), [0, 0, 0]);
});

test('clipboardMin finds the corner shared by every slice', () => {
    const { clipboardMin } = loadClip();
    const complex = {
        a: { area: { start: { x: 10, y: 64, z: -5 }, end: { x: 19, y: 70, z: 0 } } },
        b: { area: { start: { x: 20, y: 64, z: -5 }, end: { x: 29, y: 70, z: 0 } } },
    };
    assert.deepEqual(clipboardMin(complex), { x: 10, y: 64, z: -5 });
    assert.deepEqual(clipboardMin({}), { x: 0, y: 0, z: 0 });
});

test('blocksBox wraps the translated blocks', () => {
    const { blocksBox } = loadClip();
    const box = blocksBox(
        [{ dx: 0, dy: 0, dz: 0 }, { dx: 3, dy: 2, dz: 1 }],
        { x: 100, y: 64, z: 200 }
    );
    assert.deepEqual(box, { x1: 100, y1: 64, z1: 200, x2: 103, y2: 66, z2: 201 });
    assert.equal(blocksBox([], { x: 0, y: 0, z: 0 }), null);
});
