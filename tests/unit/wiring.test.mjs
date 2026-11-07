/**
 * Wiring guards for the structure store.
 *
 * Three patches in a row silently did nothing because the target files use CRLF and the
 * String.replace anchors were LF-only. The compiler could not see it (the code simply was not
 * there) and the unit tests only covered pure helpers, so the first person to notice was the
 * player: a public structure listed fine and then threw.
 *
 * These assertions read the SOURCE files and fail when a critical integration point is missing.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { join, dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { readFileSync } from 'node:fs';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..', '..');
const read = (rel) => readFileSync(join(ROOT, rel), 'utf8');

const OP = 'core/src/structure/StructureOperation.ts';
const SERVICE = 'core/src/structure/StructureService.ts';
const NBT = 'core/src/structure/NBTService.ts';
const STORE = 'core/src/structure/StructureStore.ts';
const FORM = 'core/src/view/StructureForm.ts';
const CMD = 'core/src/CACommand.ts';

test('findId resolves public folders', () => {
    const src = read(OP);
    assert.ok(src.includes('resolveStructureId('), 'findId must use the resolution table');
    assert.ok(src.includes('scanPublic('), 'findId must consult data/nbt/public');
});

test('load() resolves through getStructureById (not saveList only)', () => {
    const src = read(OP);
    assert.ok(src.includes('StructureService.getStructureById(caPlayer, r.structid)'),
        'load() must use getStructureById, otherwise a public id makes st null');
    assert.ok(!/let structure = new Structure\(st\.area/.test(src),
        'the old saveList-only construction must be gone');
});

test('delete() refuses public folders instead of dereferencing saveList', () => {
    const src = read(OP);
    assert.ok(src.includes('公共结构是只读的'), 'delete() needs the read-only message');
    assert.ok(/const r = StructureOperation\.findId\(res\.id, caPlayer\);/.test(src),
        'delete() must resolve the id through findId');
});

test('the structure service exposes the public/save helpers', () => {
    const src = read(SERVICE);
    for (const marker of ['getStructureById(', 'authorLabel(', 'migrateStore(', 'publicSizeOf(']) {
        assert.ok(src.includes(marker), 'StructureService is missing ' + marker);
    }
});

test('NBT paths go through the store', () => {
    const src = read(NBT);
    assert.ok(src.includes('StructureStore.dirOf('), 'NBTService.filePath must resolve the folder');
    assert.ok(src.includes('StructureStore.writeAtomic('), 'slices must be written atomically');
});

test('the store exposes the layout helpers the rest of the code expects', () => {
    const src = read(STORE);
    for (const marker of ['export function groupSlices', 'export function resolveStructureId', 'renameOwnerFolder(']) {
        assert.ok(src.includes(marker), 'StructureStore is missing ' + marker);
    }
});

test('the structure forms never dereference an offline author', () => {
    const src = read(FORM);
    assert.ok(src.includes('StructureService.authorLabel('), 'forms must use authorLabel');
    assert.ok(!/getCAPlayer\([^)]*\)\.\$/.test(src), 'a raw getCAPlayer(...).$ would throw for offline authors');
});

test('asset names match the JSONC rename', () => {
    const src = read(CMD);
    assert.ok(src.length > 0);
    const cfg = read('core/src/common/Config.ts');
    assert.ok(cfg.includes('configs.jsonc'), 'the config file is configs.jsonc');
    assert.ok(cfg.includes('check.jsonc'), 'the schema file is check.jsonc');
});
