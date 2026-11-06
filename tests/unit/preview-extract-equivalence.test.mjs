/**
 * The preview's interior culling was rewritten from a Map<string,string> keyed by "x,y,z"
 * (which split that string again for every neighbour test) to a flat Uint8Array. That is a
 * ~25x speedup, but it must produce EXACTLY the same blocks or the ghost silently disagrees
 * with the paste. This file pins the equivalence against a literal copy of the old algorithm.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { join, dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { existsSync } from 'node:fs';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..', '..');
const MOD = join(ROOT, 'dist', 'call', 'core', 'src', 'structure', 'SurfaceExtract.js');

const AIR = new Set(['minecraft:air', 'minecraft:cave_air', 'minecraft:void_air', 'minecraft:structure_void', '']);
const NEIGHBOURS = [[1, 0, 0], [-1, 0, 0], [0, 1, 0], [0, -1, 0], [0, 0, 1], [0, 0, -1]];

/** ZYX, the format's own order (see StructureOrder). */
function cellCoords(i, sz, sy) {
    const z = i % sz;
    const rest = (i - z) / sz;
    const y = rest % sy;
    const x = (rest - y) / sy;
    return { x, y, z };
}

/** The algorithm as it was before the rewrite: string keys everywhere. */
function referenceExtract(slices, maxBlocks) {
    const solid = new Map();
    for (const s of slices) {
        const [sx, sy, sz] = s.layout.size;
        const total = sx * sy * sz;
        for (let i = 0; i < total && i < s.layout.indices.length; i++) {
            const pi = s.layout.indices[i];
            if (!(pi >= 0)) continue;
            const entry = s.layout.palette[pi];
            if (entry == null || AIR.has(entry.name)) continue;
            const { x, y, z } = cellCoords(i, sz, sy);
            solid.set((s.origin[0] + x) + ',' + (s.origin[1] + y) + ',' + (s.origin[2] + z), entry.name);
        }
    }
    const kept = [];
    for (const [k, name] of solid) {
        const [x, y, z] = k.split(',').map(Number);
        let exposed = false;
        for (const [ox, oy, oz] of NEIGHBOURS) {
            if (!solid.has((x + ox) + ',' + (y + oy) + ',' + (z + oz))) { exposed = true; break; }
        }
        if (!exposed) continue;
        kept.push({ dx: x, dy: y, dz: z, id: name });
    }
    kept.sort((a, b) => (b.dy - a.dy) || (a.dx - b.dx) || (a.dz - b.dz));
    const truncated = kept.length > maxBlocks;
    return {
        blocks: truncated ? kept.slice(0, maxBlocks) : kept,
        visible: kept.length,
        solid: solid.size,
        truncated,
    };
}

function lcg(seed) {
    let s = seed >>> 0;
    return () => {
        s = (s * 1664525 + 1013904223) >>> 0;
        return s / 4294967296;
    };
}

function randomSlice(rand, sx, sy, sz, origin) {
    const palette = [
        { name: 'minecraft:stone', states: {}, version: 1 },
        { name: 'minecraft:air', states: {}, version: 1 },
        { name: 'minecraft:glass', states: {}, version: 1 },
        { name: 'minecraft:structure_void', states: {}, version: 1 },
    ];
    const total = sx * sy * sz;
    const indices = new Array(total);
    for (let i = 0; i < total; i++) {
        const r = rand();
        indices[i] = r < 0.45 ? 1 : (r < 0.55 ? -1 : (r < 0.8 ? 0 : (r < 0.9 ? 2 : 3)));
    }
    return { origin, layout: { size: [sx, sy, sz], indices, palette } };
}

function norm(blocks) {
    return blocks.map((b) => [b.dx, b.dy, b.dz, b.id].join('|')).sort();
}

test('bitmap culling matches the string-key algorithm exactly', () => {
    assert.ok(existsSync(MOD), 'build first: npm run build:fast');
    const S = require(MOD);
    const rand = lcg(20261106);

    for (let round = 0; round < 60; round++) {
        const sx = 1 + Math.floor(rand() * 6);
        const sy = 1 + Math.floor(rand() * 5);
        const sz = 1 + Math.floor(rand() * 6);
        const ox = Math.floor(rand() * 9);
        const oy = Math.floor(rand() * 4);
        const oz = Math.floor(rand() * 9);
        const slices = [randomSlice(rand, sx, sy, sz, [ox, oy, oz])];
        // a second slice that overlaps the first, to exercise cross-slice culling
        if (round % 3 === 0) slices.push(randomSlice(rand, 2, 2, 2, [ox + 1, oy + 1, oz + 1]));

        const got = S.extractSurface(slices, 0, 'none', Number.MAX_SAFE_INTEGER);
        const want = referenceExtract(slices, Number.MAX_SAFE_INTEGER);
        assert.deepEqual(norm(got.blocks), norm(want.blocks), 'round ' + round + ' blocks');
        assert.equal(got.visible, want.visible, 'round ' + round + ' visible');
        assert.equal(got.solid, want.solid, 'round ' + round + ' solid');
        assert.equal(got.truncated, false);
    }
});

test('truncation keeps the same top-first blocks as before', () => {
    const S = require(MOD);
    const rand = lcg(7);
    const slices = [randomSlice(rand, 6, 5, 6, [0, 0, 0])];
    for (const cap of [1, 5, 17, 40]) {
        const got = S.extractSurface(slices, 0, 'none', cap);
        const want = referenceExtract(slices, cap);
        assert.deepEqual(norm(got.blocks), norm(want.blocks), 'cap ' + cap);
        assert.equal(got.truncated, want.truncated);
    }
});

test('a hollow shell keeps only its six faces', () => {
    const S = require(MOD);
    const palette = [{ name: 'minecraft:stone', states: {}, version: 1 }, { name: 'minecraft:air', states: {}, version: 1 }];
    const [sx, sy, sz] = [5, 5, 5];
    const indices = new Array(sx * sy * sz).fill(0);
    for (let x = 1; x < sx - 1; x++) {
        for (let y = 1; y < sy - 1; y++) {
            for (let z = 1; z < sz - 1; z++) {
                indices[sx * sy * x + sx * y + z] = 1; // hollow centre
            }
        }
    }
    const res = S.extractSurface([{ origin: [0, 0, 0], layout: { size: [sx, sy, sz], indices, palette } }], 0, 'none', 1000);
    assert.equal(res.solid, sx * sy * sz - 27, 'the hollow centre is not solid');
    assert.equal(res.blocks.length, sx * sy * sz - 27, 'every remaining cell is visible');
});
