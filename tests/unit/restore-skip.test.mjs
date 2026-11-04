/**
 * Offline tests for the restore fast path.
 *
 * Restoring a big snapshot is dominated by cells that are already correct - undoing a
 * clear is almost entirely air that is already air. Skip-tests decide whether the block is
 * written at all, so they must be conservative: a block with states can share a name with
 * the target and still be the wrong variant.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { join, dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { existsSync } from 'node:fs';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..', '..');
const SAFE_ARGS = join(ROOT, 'dist', 'call', 'core', 'src', 'game', 'SafeArgs.js');

let S;
function load() {
    assert.ok(existsSync(SAFE_ARGS), 'build first: npm run build:fast');
    S = require(SAFE_ARGS);
}

test('a cell that already matches is skipped', () => {
    load();
    assert.equal(S.shouldWriteTarget('minecraft:air', 'minecraft:air', false), false);
    assert.equal(S.shouldWriteTarget('minecraft:stone', 'minecraft:stone', false), false);
});

test('a cell that differs is written', () => {
    load();
    assert.equal(S.shouldWriteTarget('minecraft:air', 'minecraft:stone', false), true);
    assert.equal(S.shouldWriteTarget('' , 'minecraft:stone', false), true);
    assert.equal(S.shouldWriteTarget('<unloaded>', 'minecraft:stone', false), true);
});

test('blocks with states are always written', () => {
    load();
    // same name, but the variant may differ (facing, growth, ...) -> must not skip
    assert.equal(S.shouldWriteTarget('minecraft:oak_stairs', 'minecraft:oak_stairs', true), true);
    assert.equal(S.shouldWriteTarget('minecraft:air', 'minecraft:air', true), true);
});

test('an empty target name is never written', () => {
    load();
    assert.equal(S.shouldWriteTarget('minecraft:air', '', false), false);
    assert.equal(S.shouldWriteTarget('minecraft:air', null, false), false);
});
