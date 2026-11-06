/**
 * Clipboard chunking - the piece that made the preview fail with load.missingFile.
 *
 * A clipboard entry is keyed by structid, but the files on disk are <structid>_<ix>_<iz>,
 * produced by Structure.getAreas() in MAX_LENGTH (64) chunks. The preview has to use the SAME
 * split as StructureService.load(), otherwise it reads a file that never existed and the
 * geometry would not match the paste either.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { join, dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { existsSync } from 'node:fs';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..', '..');
const STRUCTURE = join(ROOT, 'dist', 'call', 'core', 'src', 'common', 'Structure.js');
const AREA = join(ROOT, 'dist', 'call', 'core', 'src', 'common', 'Area3.js');
const POS = join(ROOT, 'dist', 'call', 'core', 'src', 'common', 'Pos3.js');

function load() {
    for (const f of [STRUCTURE, AREA, POS]) assert.ok(existsSync(f), 'build first: npm run build:fast');
    return {
        Structure: require(STRUCTURE).Structure,
        Area3: require(AREA).default,
        Pos3: require(POS).Pos3,
    };
}

const { Structure, Area3, Pos3 } = load();
const area = (x0, y0, z0, x1, y1, z1) => new Area3(new Pos3(x0, y0, z0, 0), new Pos3(x1, y1, z1, 0));

test('a small area is a single chunk', () => {
    const st = new Structure(area(0, 64, 0, 9, 70, 9), 't');
    const chunks = st.getAreas();
    assert.equal(st.xSize, 1);
    assert.equal(st.zSize, 1);
    assert.equal(chunks.length, 1);
    assert.equal(chunks[0].length, 1);
    assert.deepEqual([chunks[0][0].start.x, chunks[0][0].start.z], [0, 0]);
});

test('a 100x100 area splits into 2x2 chunks at 0/64', () => {
    const st = new Structure(area(0, 64, 0, 99, 70, 99), 't');
    const chunks = st.getAreas();
    assert.equal(st.xSize, 2);
    assert.equal(st.zSize, 2);
    // Structure indexes as chunks[ix][iz]
    assert.deepEqual([chunks[0][0].start.x, chunks[0][0].start.z], [0, 0]);
    assert.deepEqual([chunks[0][1].start.x, chunks[0][1].start.z], [0, 64]);
    assert.deepEqual([chunks[1][0].start.x, chunks[1][0].start.z], [64, 0]);
    assert.deepEqual([chunks[1][1].start.x, chunks[1][1].start.z], [64, 64]);
    // the far chunks are clipped to the selection
    assert.deepEqual([chunks[1][1].end.x, chunks[1][1].end.z], [99, 99]);
    assert.deepEqual([chunks[0][0].end.x, chunks[0][0].end.z], [63, 63]);
});

test('chunk offsets are relative once the clipboard origin is subtracted', () => {
    // the clipboard was copied from x=1000: subtracting the minimum makes it 0-based again
    const st = new Structure(area(1000, 64, 2000, 1099, 70, 2099), 't');
    const chunks = st.getAreas();
    const origin = { x: 1000, y: 64, z: 2000 };
    const rel = chunks.map((row) => row.map((c) => [c.start.x - origin.x, c.start.y - origin.y, c.start.z - origin.z]));
    assert.deepEqual(rel[0][0], [0, 0, 0]);
    assert.deepEqual(rel[1][1], [64, 0, 64]);
});

test('slice ids follow <structid>_<ix>_<iz>', () => {
    const st = new Structure(area(0, 64, 0, 99, 70, 99), 't');
    const chunks = st.getAreas();
    const ids = [];
    for (let ix = 0; ix < chunks.length; ix++) {
        for (let iz = 0; iz < chunks[ix].length; iz++) ids.push('mw4om1fsiq_' + ix + '_' + iz);
    }
    assert.deepEqual(ids, ['mw4om1fsiq_0_0', 'mw4om1fsiq_0_1', 'mw4om1fsiq_1_0', 'mw4om1fsiq_1_1']);
});
