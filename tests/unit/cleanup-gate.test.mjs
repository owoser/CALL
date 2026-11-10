/**
 * The teardown gate: waiting for the library queue is what keeps a cancelled preview from
 * re-appearing, and the deadline is what keeps a cancel from hanging forever.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { join, dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { existsSync } from 'node:fs';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..', '..');
const MOD = join(ROOT, 'dist', 'call', 'core', 'src', 'structure', 'CleanupGate.js');

const gate = () => {
    assert.ok(existsSync(MOD), 'build first: npm run build:fast');
    return require(MOD).shouldWaitForDrain;
};

test('an empty queue never waits', () => {
    const shouldWaitForDrain = gate();
    assert.deepEqual(shouldWaitForDrain({ queued: 0, deadline: 12345, now: 1 }), { wait: false, expired: false });
});

test('a busy queue waits until the deadline', () => {
    const shouldWaitForDrain = gate();
    assert.deepEqual(shouldWaitForDrain({ queued: 3, deadline: 1000, now: 10 }), { wait: true, expired: false });
    assert.deepEqual(shouldWaitForDrain({ queued: 3, deadline: 1000, now: 999 }), { wait: true, expired: false });
});

test('a busy queue past the deadline is released as expired', () => {
    const shouldWaitForDrain = gate();
    assert.deepEqual(shouldWaitForDrain({ queued: 2, deadline: 1000, now: 1000 }), { wait: false, expired: true });
    assert.deepEqual(shouldWaitForDrain({ queued: 2, deadline: 1000, now: 5000 }), { wait: false, expired: true });
});

test('no deadline means wait as long as the queue is busy', () => {
    const shouldWaitForDrain = gate();
    assert.deepEqual(shouldWaitForDrain({ queued: 1, deadline: null, now: 9e9 }), { wait: true, expired: false });
    assert.deepEqual(shouldWaitForDrain({ queued: 1, now: 9e9 }), { wait: true, expired: false });
});

test('a negative/garbage depth is treated as empty', () => {
    const shouldWaitForDrain = gate();
    assert.equal(shouldWaitForDrain({ queued: -5, deadline: 1, now: 2 }).wait, false);
    assert.equal(shouldWaitForDrain({ queued: NaN, deadline: 1, now: 2 }).wait, false);
});
