/**
 * Batch fake blocks (blockBatch*): the packed format and the stats parser.
 *
 * The preview used to send one viewBlock call (and one packet) per cell. With the batch API a
 * single call carries up to 1024 cells, which the library merges per sub-chunk - so the encoding
 * is the part that must not be wrong.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { join, dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { existsSync } from 'node:fs';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..', '..');
const MOD = join(ROOT, 'dist', 'call', 'core', 'src', 'holo', 'FakeBlocks.js');

function load() {
    assert.ok(existsSync(MOD), 'build first: npm run build:fast');
    return require(MOD);
}

test('cells pack into the documented format', () => {
    const { packCells } = load();
    const res = packCells([
        { x: 100, y: 64, z: 100, id: 'minecraft:stone' },
        { x: 101, y: 64, z: 100, id: 'minecraft:stone_stairs[weirdo_direction=2]' },
    ]);
    assert.equal(res.skipped, 0);
    assert.equal(res.segments.length, 1);
    assert.equal(res.segments[0],
        '100 64 100 minecraft:stone;101 64 100 minecraft:stone_stairs[weirdo_direction=2]');
});

test('a state containing a semicolon is dropped, not corrupting the batch', () => {
    const { packCells } = load();
    const res = packCells([
        { x: 0, y: 0, z: 0, id: 'minecraft:stone' },
        { x: 1, y: 0, z: 0, id: 'minecraft:oak_stairs[weirdo_direction=1;]' },
    ]);
    assert.equal(res.skipped, 1);
    assert.equal(res.segments[0], '0 0 0 minecraft:stone');
});

test('bad coordinates are skipped', () => {
    const { packCells } = load();
    const res = packCells([
        { x: 1.5, y: 0, z: 0, id: 'minecraft:stone' },
        { x: 0, y: Number.NaN, z: 0, id: 'minecraft:stone' },
        { x: 0, y: 0, z: 0, id: '' },
    ]);
    assert.equal(res.skipped, 3);
    assert.deepEqual(res.segments, []);
});

test('a huge batch is split into size-capped segments', () => {
    const { packCells } = load();
    const cells = [];
    for (let i = 0; i < 400; i++) {
        cells.push({ x: i, y: 64, z: 0, id: 'minecraft:polished_deepslate_stairs[upside_down_bit=false]' });
    }
    const res = packCells(cells, 4096);
    assert.ok(res.segments.length > 1, 'expected several segments');
    for (const segment of res.segments) {
        assert.ok(segment.length <= 4096 + 120, 'segment too long: ' + segment.length);
    }
    const total = res.segments.reduce((n, s) => n + s.split(';').length, 0);
    assert.equal(total, 400, 'no cell may be lost while splitting');
});

test('positions pack for blockBatchClear', () => {
    const { packPositions } = load();
    assert.equal(packPositions([[1, 2, 3], [-4, 5, -6]]), '1 2 3;-4 5 -6');
});

test('stats parse into numbers', () => {
    const { parseStats } = load();
    assert.deepEqual(parseStats('batch=3 queue=1 packets=12 bytes=21400 nearSets=0'),
        { batch: 3, queue: 1, packets: 12, bytes: 21400, dropped: 0, bad: 0, nearSets: 0 });
    assert.equal(parseStats(''), null);
});

test('a descriptor the packed format cannot carry is reported, not silently dropped', () => {
    const { isPackableId, packCells } = load();
    assert.equal(isPackableId('minecraft:stone'), true);
    assert.equal(isPackableId(''), false);
    // ';' joins entries, so it can never appear inside a descriptor
    assert.equal(isPackableId('minecraft:sign[text="a;b"]'), false);

    const packed = packCells([
        { x: 0, y: 0, z: 0, id: 'minecraft:stone' },
        { x: 1, y: 0, z: 0, id: 'minecraft:sign[text="a;b"]' },
    ]);
    assert.equal(packed.segments.length, 1);
    assert.equal(packed.skipped, 1, 'the unpackable cell must be counted, so restore can retry it');
    assert.equal(packed.segments[0], '0 0 0 minecraft:stone');
});

test('no packed segment exceeds the measured string limit', () => {
    const { packCells, PACK_MAX_BYTES } = load();
    // 16 KB is where LSE truncates the argument; anything above it is silently lost.
    assert.ok(PACK_MAX_BYTES <= 16 * 1024, 'the segment budget must stay under the ~16 KB FFI limit');
    const cells = [];
    for (let i = 0; i < 5000; i++) {
        cells.push({ x: i % 100, y: 64, z: Math.floor(i / 100), id: 'minecraft:oak_stairs[weirdo_direction=2,upside_down_bit=false]' });
    }
    const packed = packCells(cells);
    assert.equal(packed.skipped, 0);
    assert.ok(packed.segments.length > 1, 'a big payload must be split, not sent as one truncated string');
    for (const segment of packed.segments) {
        assert.ok(segment.length <= PACK_MAX_BYTES, 'segment of ' + segment.length + ' bytes exceeds the budget');
    }
    const total = packed.segments.reduce((n, s) => n + s.split(';').length, 0);
    assert.equal(total, 5000, 'every cell must survive the split: ' + total);
});

test('without the library the adapter reports itself unavailable', () => {
    const { FakeBlocks } = load();
    FakeBlocks.setSource({ set: null, clear: null });
    assert.equal(FakeBlocks.available(), false);
    assert.equal(FakeBlocks.set('Steve', '0 0 0 minecraft:stone', false), -1);
    assert.equal(FakeBlocks.clear('Steve', [[0, 0, 0]]), false);
});

test('a working library is used and its ids are returned', () => {
    const { FakeBlocks } = load();
    const calls = [];
    FakeBlocks.setSource({
        set: (name, packed, immediate) => { calls.push([name, packed, immediate]); return 7; },
        clear: () => true,
        stats: () => 'batch=1 queue=0 packets=2 bytes=300',
    });
    assert.equal(FakeBlocks.available(), true);
    assert.equal(FakeBlocks.set('Steve', '0 0 0 minecraft:stone', true), 7);
    assert.deepEqual(calls[0], ['Steve', '0 0 0 minecraft:stone', true]);
    assert.deepEqual(FakeBlocks.stats(),
        { batch: 1, queue: 0, packets: 2, bytes: 300, dropped: 0, bad: 0, nearSets: 0 });
    FakeBlocks.setSource(null);
});
