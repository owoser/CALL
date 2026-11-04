/**
 * Offline tests for fill sizing and command-result classification.
 *
 * Both are pure functions on purpose: they encode the two lessons of the 3.0.3 bug report.
 *   - a 64x64 slab with height 8 is exactly 32768 blocks, i.e. ON the /fill ceiling;
 *   - BDS reports unloaded chunks as "cannot place blocks outside of the world", which
 *     must not be shown to the player as if it were a size problem.
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

test('slab height never approaches the 32768 /fill ceiling', () => {
    load();
    // the exact case that failed: a full 64x64 slice
    assert.equal(S.slabHeight(64, 64), 7);
    assert.ok(64 * 64 * S.slabHeight(64, 64) <= S.SAFE_FILL_VOLUME);
    assert.ok(64 * 64 * S.slabHeight(64, 64) < S.MAX_FILL_VOLUME);

    // small slices still get the full 8 high slab
    assert.equal(S.slabHeight(16, 16), 8);
    assert.equal(S.slabHeight(13, 61), 8);
    assert.equal(S.slabHeight(1, 113), 8);

    // degenerate / huge inputs never produce 0 or an overflow
    assert.equal(S.slabHeight(0, 0), 8);
    assert.equal(S.slabHeight(200, 200), 1);
    assert.equal(S.slabHeight(-5, 3), 8);
});

test('every slab size stays inside the command limit', () => {
    load();
    for (const [x, z] of [[64, 64], [64, 32], [32, 32], [7, 1], [64, 1], [128, 128], [1, 1]]) {
        const h = S.slabHeight(x, z);
        const volume = x * z * h;
        assert.ok(h >= 1, 'height must be at least 1 for ' + x + 'x' + z);
        assert.ok(volume <= S.MAX_FILL_VOLUME, x + 'x' + h + 'x' + z + ' = ' + volume + ' exceeds the limit');
    }
});

test('BDS messages are classified correctly', () => {
    load();
    const C = S;

    assert.equal(C.classifyCmdError('无法在世界外放置方块', false), 'not-loaded');
    assert.equal(C.classifyCmdError('Cannot place blocks outside of the world', false), 'not-loaded');
    assert.equal(C.classifyCmdError('0 个方块已填充', false), 'noop');
    assert.equal(C.classifyCmdError('Filled 0 blocks', false), 'noop');
    assert.equal(C.classifyCmdError('32656 个方块已填充', true), 'other');
    assert.equal(C.classifyCmdError('语法错误', false), 'other');
    assert.equal(C.classifyCmdError('', false), 'other');
});
