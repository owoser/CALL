/**
 * Offline benchmark for the two hot paths of the paste preview.
 *
 * Both were measured before optimising: `extractSurface` took 624ms for a 300k-cell selection
 * (string keys, then the same strings were re-split to test neighbours) and a rotation walked
 * all 48k surface blocks to rebuild a world-space index (26ms). Run this after touching
 * SurfaceExtract or PreviewPlan to see whether the numbers held.
 *
 *   node scripts/bench-preview.mjs
 */
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createRequire } from 'node:module';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const require = createRequire(import.meta.url);
const S = require(join(ROOT, 'dist', 'call', 'core', 'src', 'structure', 'SurfaceExtract.js'));
const P = require(join(ROOT, 'dist', 'call', 'core', 'src', 'structure', 'PreviewPlan.js'));

function solidSlice(sx, sy, sz, origin) {
    return {
        origin,
        layout: {
            size: [sx, sy, sz],
            indices: new Array(sx * sy * sz).fill(0),
            palette: [{ name: 'minecraft:stone', states: {}, version: 1 }],
        },
    };
}

function time(label, fn) {
    fn(); // warm up
    const t = process.hrtime.bigint();
    let out;
    for (let i = 0; i < 3; i++) out = fn();
    const ms = Number(process.hrtime.bigint() - t) / 1e6 / 3;
    console.log(label.padEnd(46), ms.toFixed(1).padStart(8) + ' ms');
    return out;
}

console.log('surface extraction');
for (const [sx, sy, sz] of [[64, 40, 64], [64, 64, 73], [64, 64, 120]]) {
    const slices = [solidSlice(sx, sy, sz, [0, 0, 0])];
    time(`  ${sx}x${sy}x${sz} (${sx * sy * sz} cells)`, () => S.extractSurface(slices, 0, 'none', Number.MAX_SAFE_INTEGER));
}

console.log('\nwindow query (rotation only re-runs this)');
for (const n of [20000, 48383, 120000]) {
    const blocks = [];
    for (let i = 0; i < n; i++) {
        blocks.push({ dx: i % 64, dy: Math.floor(i / (64 * 64)) % 64, dz: Math.floor(i / 64) % 64, id: 'minecraft:stone' });
    }
    const grid = P.sourceGrid(blocks);
    const anchor = { x: 0, y: 64, z: 0 };
    const q = {
        anchor, size: [64, 64, 64], degrees: 90, mirror: 'none', pivot: 'inplace',
        center: { x: 20, y: 64, z: 20 }, radius: 48, budget: 12000,
    };
    time(`  ${n} blocks, r=48, budget 12000`, () => P.windowFromSource(grid, q));
}
