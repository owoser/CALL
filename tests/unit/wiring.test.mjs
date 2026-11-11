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
    assert.ok(op.includes('feetBlock('), 'the air click needs the feet target');
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
    assert.ok(compat.includes('swingCount'), 'HoloCompat must expose the swing capability');
    assert.ok(compat.includes('Holo.bind(n) != null'),
        'capabilities must be probed on the exported API surface, not on a release number');
    assert.ok(compat.includes('holoLseVersion'),
        'the LSE export-surface version is the version signal (ABI 1.37.0 is shared by 442 and 450 builds)');
    assert.ok(!compat.includes('requiredFor('),
        'no release-number thresholds: 26.60.6 and 26.60.8 report the same ABI');

    const swing = read('core/src/user/SwingWatcher.ts');
    assert.ok(swing.includes('DEDUPE_MS = 100'), 'the dedupe window is 100ms by decision');

    const op = read('core/src/user/ToolOperation.ts');
    assert.ok(op.includes('AIR_TOOLS'), 'only the bundled tools react to air');
    assert.ok(op.includes('mc.getBlock(x, feetCell - dy, z'), 'the air target is the block under the feet, read from the world');
    assert.ok(op.includes('faceFromView('), 'the adjust wand uses the view direction on air');
});

test('moving a preview keeps its cells (no rebuild, no stale cleanup)', () => {
    const op = read('core/src/structure/PreviewOperation.ts');
    assert.ok(op.includes('PreviewScene.canMove('),
        'set() must ask whether the existing scene can simply be moved');
    assert.ok(op.includes('PreviewScene.move('),
        'set() must move the scene instead of rebuilding it');

    const scene = read('core/src/structure/PreviewScene.ts');
    // A rebuild INHERITS the previous ledger instead of clearing and starting empty: clearing is
    // what lost the old footprint (a nudged preview left pieces of itself behind).
    assert.ok(scene.includes('function detachScene('),
        'a rebuild must detach the old scene without emitting packets');
    assert.ok(scene.includes('discardCleanupCovered('),
        'only cells the inherited ledger covers may have their cleanup dropped');
    assert.ok(scene.includes('carried?.applied ?? new Map()'),
        'the new scene must start from the inherited ledger');
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

test('the preview sends through the batch API', () => {
    const scene = read('core/src/structure/PreviewScene.ts');
    assert.ok(scene.includes('import { FakeBlocks, packCells'), 'the scene must use the batch adapter');
    assert.ok(scene.includes('import BatchSender'), 'submissions must be paced');
    assert.ok(scene.includes('submitSets(') && scene.includes('submitClears('),
        'set and clear must both have a batched path');
    assert.ok(scene.includes('pumpLegacy('), 'the per-cell path must stay as the fallback');
    assert.ok(scene.includes('FakeBlocks.set(scene.playerName, segment, immediate)'),
        'a chunk must be one library call');
    // Teardown moved into drainCleanup(), which waits for the library queue and repeats the
    // restore once - a queued batch landing after the restore is what left a half structure.
    assert.ok(scene.includes('FakeBlocks.restoreDetailed(task.playerName, task.cells, task.dimid'),
        'teardown must restore the real blocks and know WHICH cells went out');
    assert.ok(scene.includes('PACK_MAX_BYTES') || scene.includes('packed.segments'),
        'the draw path must respect the packed segment budget');
    assert.ok(scene.includes('预览载荷被截断'),
        'a truncated payload must be reported, not silently half-drawn');
    assert.ok(scene.includes('flushCleanup('),
        'a paste must be able to wait for the preview teardown (restore packets carry pre-paste blocks)');
    const op = read('core/src/structure/PreviewOperation.ts');
    assert.ok(/public static async confirm\(/.test(op), 'confirm() must await the teardown before pasting');
    assert.ok(op.includes('flushCleanup('), 'confirm() must use the teardown wait');
    assert.ok(scene.includes('库丢包+') && scene.includes('selfTest:'),
        'the restore must log the library\'s dropped/bad delta and a selfTest of the payload');
    assert.ok(scene.includes('scene.everApplied.set('),
        'the plan itself must register every desired cell (a missed mark becomes a ghost)');
    assert.ok(scene.includes('cancelOwner('), 'a cancel must stop feeding the library queue first');
    assert.ok(scene.includes('waitForDrain'), 'teardown must wait for the library queue to drain');
    assert.ok(scene.includes('passes'), 'teardown must repeat the restore once');
    assert.ok(scene.includes('maybeResend('), 'a client chunk reload must trigger a re-send');

    const cfg = read('assets/configs.default.jsonc');
    for (const key of ['previewBatchMode', 'previewBatchCells', 'previewBatchImmediate', 'previewBatchPerTick', 'previewResendSeconds']) {
        assert.ok(cfg.includes('"' + key + '"'), key + ' must be documented in the template');
    }
});

test('the reset is gone from maybeResend (this is what left ghosts on the client)', () => {
    const scene = read('core/src/structure/PreviewScene.ts');
    const resend = scene.slice(scene.indexOf('maybeResend(scene: Scene'), scene.indexOf('Diff + REPLACE the queue'));
    assert.ok(resend.length > 200, 'maybeResend must be found');
    assert.equal(/applied\.clear\(\)/.test(resend), false,
        'maybeResend must never clear the applied map - that forgets cells that left the window');
    assert.ok(resend.includes('resendRequested = true'), 'it must flag an additive re-send instead');
    assert.ok(resend.includes('applied.size > 30000'), 'huge windows must not re-send wholesale');
});

test('a cross-dimension selection is cleared instead of throwing', () => {
    const area = read('core/src/structure/AreaOperation.ts');
    assert.ok(area.includes('selectionState('), 'the guard must use the pure selection check');
    assert.equal(area.includes('与两点不在同一维度'), false, 'the old throw must be gone');
    assert.ok(area.includes('dropSelection('), 'a stale selection must be dropped');
    const app = read('core/src/app.ts');
    assert.ok(app.includes("mc.listen(\"onChangeDim\""), 'a dimension change must clear the selection');
    assert.ok(app.includes('AreaOperation.dropSelection('));
});

test('undo and redo wait for the preview teardown', () => {
    const cmd = read('core/src/CACommand.ts');
    const undoBlock = cmd.slice(cmd.indexOf('case "undo":'), cmd.indexOf('case "tool":'));
    assert.ok(undoBlock.includes('flushCleanup('), 'undo/redo must wait like the paste does');
    const op = read('core/src/structure/StructureOperation.ts');
    assert.ok(op.includes('warnOtherDimension('), 'a cross-dimension undo must say so');
});

test('the ledger owns applied / stale / everApplied', () => {
    const scene = read('core/src/structure/PreviewScene.ts');
    assert.ok(scene.includes('teardownCells('), 'teardown must clear the union');
    assert.ok(scene.includes('detachScene(xuid)'), 'a cancel must detach before restoring');
    assert.ok(scene.includes('markOwed('), 'an unconfirmed clear must be owed, not dropped');
    assert.ok(scene.includes('takeOwed(scene'), 'owed clears must be retried');
    assert.ok(scene.includes('scene.stale.size > 0'), 'the pump must service owed clears first');
    assert.ok(scene.includes('previewBatchQueueMax'), 'the pump must respect the library queue');

    const ledger = read('core/src/structure/GhostLedger.ts');
    assert.ok(ledger.includes('export function markOwed('));
    assert.ok(ledger.includes('export function teardownCells('));
});

test('clears go through the set path, not the library clear', () => {
    const scene = read('core/src/structure/PreviewScene.ts');
    assert.ok(scene.includes('FakeBlocks.restore('), 'clears must restore the real block');
    assert.equal(scene.includes('FakeBlocks.clear(scene.playerName'), false,
        'blockBatchClear reports failure on this build - it must not be the way we clear');
    const blocks = read('core/src/holo/FakeBlocks.ts');
    assert.ok(blocks.includes('restore(playerName: string'), 'FakeBlocks needs the restore path');
    assert.ok(blocks.includes('BlockType.generateFromBlock'), 'the real block must come from the world');
});

test('clears are queued before sets (先清理再移动)', () => {
    const scene = read('core/src/structure/PreviewScene.ts');
    assert.ok(/const clears: PlanOp\[\] = \[\];/.test(scene), 'enqueue must split clears out');
    assert.ok(scene.includes('scene.queue = clears.concat(sets)'), 'clears must be queued first');
    assert.ok(scene.includes('Owed clears first') || scene.includes('stale.size > 0'),
        'owed clears must be retried before new work');
});

test('the paste wand takes over the click when a preview is open (both buttons, block + air)', () => {
    const op = read('core/src/user/ToolOperation.ts');
    assert.ok(op.includes('tryPreviewPaste('), 'the interception must exist');
    assert.ok(op.includes('TOOL.paste'), 'it must be limited to the paste wand');
    assert.ok(op.includes('PreviewOperation.has('), 'and only when a preview is open');
    assert.ok(op.includes('PreviewOperation.confirm('), 'it must reuse the preview paste flow');

    // onClick covers BOTH buttons (the left side falls back to the right binding today)
    const clickAt = op.indexOf('public static onClick(');
    const click = op.slice(clickAt, clickAt + 4000);   // the correction block sits in between now
    assert.ok(click.includes('tryPreviewPaste('), 'onClick must intercept before bindings');
    // onAirClick covers air clicks on both buttons
    const air = op.slice(op.indexOf('public static onAirClick('), op.indexOf('public static onClick('));
    assert.ok(air.includes('tryPreviewPaste(caPlayer, hand'), 'onAirClick must intercept too');
});

test('the preview wand no longer confirms with sneak+right', () => {
    const op = read('core/src/structure/PreviewOperation.ts');
    const confirmCase = op.slice(op.indexOf('case "confirm":'), op.indexOf('case "confirm":') + 400);
    assert.equal(/confirm\(output, caPlayer\)/.test(confirmCase), false,
        'sneak+right must not paste any more');
    assert.ok(confirmCase.includes('hintPasteWand'), 'it must point at the paste wand instead');
});

test('posf bindings are migrated on the first click, not only when a binding is missing', () => {
    const op = read('core/src/user/ToolOperation.ts');
    assert.ok(op.includes('ensurePosfMigrated('), 'the migration helper must exist');
    const click = op.slice(op.indexOf('public static onClick('), op.indexOf('public static onClick(') + 1500);
    assert.ok(click.includes('ensurePosfMigrated(caPlayer)'),
        'every click must check it - a ${posf} binding resolves fine and keeps selecting the face plane');
    assert.ok(op.includes('migratePosfBindings(caPlayer.settings)'), 'it must rewrite the stored bindings');
});

test('the per-burst preview log is debug-only', () => {
    const scene = read('core/src/structure/PreviewScene.ts');
    const log = scene.slice(scene.indexOf('logBurst(scene: Scene)'), scene.indexOf('logBurst(scene: Scene)') + 900);
    assert.ok(log.includes('debugMod'), 'the burst counter must be gated on debugMod');
    assert.ok(log.indexOf('debugMod') < log.indexOf('logger.info'),
        'the gate has to be checked BEFORE writing the line');
});
