/**
 * BatchSender: the per-tick pacing that keeps CALL inside the library's global packet budget.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { join, dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { existsSync } from 'node:fs';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..', '..');
const MOD = join(ROOT, 'dist', 'call', 'core', 'src', 'structure', 'BatchSender.js');

function load() {
    assert.ok(existsSync(MOD), 'build first: npm run build:fast');
    return require(MOD).default;
}

test('a tick runs at most previewBatchPerTick jobs', () => {
    const S = load();
    S.reset();
    S.configure(3);
    let ran = 0;
    for (let i = 0; i < 10; i++) S.request(() => ran++);
    S.drainNow();
    assert.equal(ran, 3, 'only the tick budget may run');
    assert.equal(S.pending(), 7);
    S.reset();
});

test('the remaining jobs run on the following ticks', () => {
    const S = load();
    S.reset();
    S.configure(4);
    let ran = 0;
    for (let i = 0; i < 9; i++) S.request(() => ran++);
    S.drainNow();
    S.drainNow();
    S.drainNow();
    assert.equal(ran, 9);
    assert.equal(S.pending(), 0);
    S.reset();
});

test('a throwing job does not stop the queue', () => {
    const S = load();
    S.reset();
    S.configure(8);
    let ran = 0;
    S.request(() => { throw new Error('boom'); });
    S.request(() => ran++);
    S.drainNow();
    assert.equal(ran, 1);
    S.reset();
});

test('perTick is clamped to the library headroom', () => {
    const S = load();
    S.configure(99);
    assert.equal(S.perTick(), 8);
    S.configure(0);
    assert.equal(S.perTick(), 1);
    S.configure(6);
    assert.equal(S.perTick(), 6);
});
