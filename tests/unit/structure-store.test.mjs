/**
 * Directory layout of the structure store.
 *
 * Pins the two things that are easy to get wrong and painful in production: a display name that
 * Windows cannot turn into a folder, and the file name of a single-slice structure (the id on
 * its own, not `<id>_0_0`).
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { join, dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { existsSync } from 'node:fs';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..', '..');
const MOD = join(ROOT, 'dist', 'call', 'core', 'src', 'structure', 'StructureStore.js');

function load() {
    assert.ok(existsSync(MOD), 'build first: npm run build:fast');
    return require(MOD);
}

test('illegal file-name characters become underscores', () => {
    const S = load();
    assert.equal(S.sanitizeFolder('a/b\\c:d*e?f"g<h>i|j', 'x'), 'a_b_c_d_e_f_g_h_i_j');
    assert.equal(S.sanitizeFolder('  领地01号  ', 'x'), '领地01号');
    assert.equal(S.sanitizeFolder('', 'mw4w5g20ay'), 'mw4w5g20ay', 'falls back to the id');
    assert.equal(S.sanitizeFolder('...', 'id'), 'id', 'dots-only is unusable on Windows');
    assert.equal(S.sanitizeFolder('CON', 'id'), 'id', 'reserved device name');
});

test('a very long name is capped but still usable', () => {
    const S = load();
    const long = 'x'.repeat(200);
    const out = S.sanitizeFolder(long, 'id');
    assert.ok(out.length <= S.MAX_FOLDER, 'capped to ' + S.MAX_FOLDER + ', got ' + out.length);
    assert.equal(out, 'x'.repeat(S.MAX_FOLDER));
});

test('folder layout matches the documented tree', () => {
    const S = load();
    assert.equal(S.folderPath('save', 'Allen13in', '领地01号', 'mw4w5g20ay'), 'Allen13in/领地01号');
    assert.equal(S.folderPath('save', 'Allen13in', '', 'mw4w5g20ay'), 'Allen13in/mw4w5g20ay');
    assert.equal(S.folderPath('copy', 'Allen13in', 'ignored', 'mw4w5g20ay'), 'Allen13in/copy/mw4w5g20ay');
    assert.equal(S.folderPath('undo', 'Allen13in', '', 'mw4w5g20ay'), 'Allen13in/undo/mw4w5g20ay');
    assert.equal(S.folderPath('redo', 'Allen13in', '', 'mw4w5g20ay'), 'Allen13in/redo/mw4w5g20ay');
    assert.equal(S.folderPath('public', '', '领地02号', 'mw4w5g20ay'), 'public/领地02号');
});

test('a player name that is illegal on disk is neutralised in the folder', () => {
    const S = load();
    assert.equal(S.folderPath('save', 'a:b', 'n', 'sid'), 'a_b/n');
});

test('single-slice structures use the bare id as file name', () => {
    const S = load();
    assert.equal(S.sliceFileName('mw4w5g20ay', 0, 0, 1, 1), 'mw4w5g20ay');
    assert.equal(S.sliceFileName('mw4w5g20ay', 0, 0, 2, 2), 'mw4w5g20ay_0_0');
    assert.equal(S.sliceFileName('mw4w5g20ay', 1, 0, 2, 1), 'mw4w5g20ay_1_0');
});

test('the index maps an id to its folder', () => {
    const S = load();
    const store = S.default;
    store.clearIndex();
    assert.equal(store.dirOf('abc'), null, 'unknown ids fall back to the flat layout');
    store.register('abc', 'Allen13in/领地', 1, 1);
    assert.equal(store.dirOf('abc'), 'Allen13in/领地');
    assert.deepEqual(store.slicesOf('abc'), [1, 1]);
    store.forget('abc');
    assert.equal(store.dirOf('abc'), null);
});
