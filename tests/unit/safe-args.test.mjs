/**
 * Offline tests for argument validation / clamping (core/src/game/SafeArgs.ts).
 *
 * The module is deliberately free of engine dependencies so these run in plain Node.
 *
 * Regression covered here: 3.0.1 rejected the bare block name "air" that
 * `/ca clear` builds, so clearing a region silently did nothing
 * ("CALL-invalid block or region: air").
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

test('bare block names get the minecraft: namespace', () => {
    load();
    assert.equal(S.normaliseBlockName('air'), 'minecraft:air');
    assert.equal(S.normaliseBlockName('stone'), 'minecraft:stone');
    assert.equal(S.normaliseBlockName('  AIR  '), 'minecraft:air');
    assert.equal(S.normaliseBlockName('Minecraft:Oak_Stairs'), 'minecraft:oak_stairs');
    assert.equal(S.normaliseBlockName('custompack:my_block'), 'custompack:my_block');
    assert.equal(S.isBlockName('air'), true, 'a bare name must be accepted (this broke 3.0.1)');
});

test('nonsense block names are rejected', () => {
    load();
    for (const bad of ['', '   ', null, undefined, 42, 'has space', '../evil', 'a:b:c', 'minecraft:']) {
        assert.equal(S.normaliseBlockName(bad), null, 'should reject ' + JSON.stringify(bad));
        assert.equal(S.isBlockName(bad), false);
    }
});

test('block states are only accepted when they look like command syntax', () => {
    load();
    assert.equal(S.isBlockStates('["a"=1]'), true);
    assert.equal(S.isBlockStates('["facing_direction"=2]'), true);
    assert.equal(S.isBlockStates(''), false);
    assert.equal(S.isBlockStates('[]'), false, 'empty states must be omitted, not emitted');
    assert.equal(S.isBlockStates('no brackets'), false);
    assert.equal(S.isBlockStates('[\na\n]'), false, 'newlines would break the command');
});

test('client-visible values are clamped', () => {
    load();
    // BossBarColor has exactly 8 values; 11 (what fill used to pass) must never escape.
    assert.equal(S.bossBarColor(11), 7);
    assert.equal(S.bossBarColor(1), 1);
    assert.equal(S.bossBarColor(-3), 0);
    assert.equal(S.bossBarColor('x', 2), 2);

    assert.equal(S.bossBarPercent(140), 100);
    assert.equal(S.bossBarPercent(-1), 0);
    assert.equal(S.bossBarPercent('x'), 0);

    assert.equal(S.messageType(99), 0);
    assert.equal(S.messageType(5), 5);

    assert.equal(S.dimensionId(9), 0);
    assert.equal(S.dimensionId(1), 1);

    assert.equal(S.clampY(999), 320);
    assert.equal(S.clampY(-999), -64);
});

test('volume helper multiplies component-wise', () => {
    load();
    assert.equal(S.volumeOf(2, 3, 4), 24);
    assert.equal(S.volumeOf(-1, 3, 4), 0);
    assert.equal(S.MAX_FILL_VOLUME, 32768);
});
