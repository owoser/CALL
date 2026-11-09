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

test('public/ is read-only for the plugin', () => {
    const nbt = read(NBT);
    assert.ok(nbt.includes('refused to delete a public structure file'),
        'NBTService.del must refuse files under data/nbt/public/');
    const svc = read(SERVICE);
    assert.ok(svc.includes('overCallback(failed)'), 'load must hand the failed count to its caller');
});

test('the load failure path is reported, not swallowed', () => {
    const src = read(OP);
    assert.ok(src.includes('(failed: number) => {'), 'the load callback must receive the failed count');
    assert.ok(src.includes('加载失败'), 'a failed load must say so');
    assert.ok(src.includes('publicCheck(') && src.includes('publicReload('), 'the diagnostics commands must exist');
});

test('structure ids are quoted before they reach a command', () => {
    const src = read(FORM);
    assert.ok(src.includes('function quoteArg'), 'the form needs a quoting helper');
    assert.ok(src.includes('call load ${quoteArg(stData.id)}'), 'load must quote the id');
    assert.ok(src.includes('call delete ${quoteArg(data.id)}'), 'delete must quote the id');
    assert.ok(!/call load \$\{stData\.id\}/.test(src), 'an unquoted load id splits on spaces');
});

test('air clicks reach the tools', () => {
    const app = read('core/src/app.ts');
    assert.ok(app.includes('"onUseItem"'), 'the plugin must listen to onUseItem for air clicks');
    assert.ok(app.includes('onAirClick('), 'the air click must be routed to the tools');
    const op = read('core/src/user/ToolOperation.ts');
    assert.ok(op.includes('public static onAirClick('), 'ToolOperation needs onAirClick');
    assert.ok(op.includes('getBlockFromViewVector'), 'the air click needs a target: what the player looks at');
});

test('public structures must live in a folder', () => {
    const store = read(STORE);
    assert.ok(store.includes('loosePublicFiles'), 'loose files must be tracked, not published');
    assert.ok(store.includes('不生效'), 'the README must say loose files are ignored');
    const svc = read(SERVICE);
    assert.ok(svc.includes('没有放进文件夹'), 'the player must be told why it is not listed');
});

test('left click on air goes through the library gate', () => {
    const app = read('core/src/app.ts');
    assert.ok(app.includes('startSwingTicker'), 'the swing ticker must be started');
    assert.ok(app.includes('SwingWatcher.poll('), 'the ticker must poll the swing counter');
    assert.ok(app.includes('HoloCompat.warnOnce()'), 'the library version must be reported once');
    assert.ok(app.includes('SwingWatcher.noteBlockLeft'), 'block clicks must cancel the air click');

    const compat = read('core/src/holo/HoloCompat.ts');
    assert.ok(compat.includes('HOLO_MIN_API') && compat.includes('swingCount'),
        'HoloCompat must gate swingCount on the documented minimum');
    assert.ok(compat.includes('HOLO_MIN_26_51') && compat.includes('HOLO_MIN_26_60'),
        'both release lines need their own minimum (26.51.8 is withdrawn)');

    const swing = read('core/src/user/SwingWatcher.ts');
    assert.ok(swing.includes('DEDUPE_MS = 100'), 'the dedupe window is 100ms by decision');

    const op = read('core/src/user/ToolOperation.ts');
    assert.ok(op.includes('AIR_TOOLS'), 'only the bundled tools react to air');
    assert.ok(op.includes('Math.floor(Number(p.y)) - 1'), 'the air target is the block at the feet');
    assert.ok(op.includes('faceFromView('), 'the adjust wand uses the view direction on air');
});

test('moving a preview keeps its cells (no rebuild, no stale cleanup)', () => {
    const op = read('core/src/structure/PreviewOperation.ts');
    assert.ok(op.includes('PreviewScene.canMove('),
        'set() must ask whether the existing scene can simply be moved');
    assert.ok(op.includes('PreviewScene.move('),
        'set() must move the scene instead of rebuilding it');

    const scene = read('core/src/structure/PreviewScene.ts');
    assert.ok(scene.includes('function discardCleanup('),
        'a rebuild must drop that player stale cleanup tasks');
    assert.ok(/if \(realName !== ""\) discardCleanup\(realName\);/.test(scene),
        'build() must discard stale cleanup before clearing');
    assert.ok(scene.includes('canMove(xuid: string): boolean'), 'PreviewScene needs canMove()');
});

test('block entities ride along with the paste', () => {
    const codec = read('core/src/io/NbtCodec.ts');
    assert.ok(codec.includes('block_position_data'), 'the codec must read block_position_data');
    assert.ok(codec.includes('export function toLseTag('), 'block entity tags must be convertible');
    assert.ok(/blockEntities\?: Map<number, NbtTag>/.test(codec), 'the layout must carry them');

    const placement = read('core/src/structure/StructurePlacement.ts');
    assert.ok(placement.includes('layout.blockEntities?.get(i)'), 'placement must look them up per cell');
    assert.ok(placement.includes('getBlockEntity()'), 'they must be written through Block.getBlockEntity()');
    assert.ok(placement.includes('String(target.type ?? "") !== name'),
        'setNbt must be verified, not trusted');

    // rotation has to move the payload with its block
    assert.ok(/blockEntities\.set\(cellIndex\(rx, y, rz/.test(codec),
        'transformLayout must remap block entity indices');
});
