/**
 * A cancelled preview must be able to drop ITS queued pump jobs, without touching anyone else's.
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

function sender() {
    assert.ok(existsSync(MOD), 'build first: npm run build:fast');
    const s = require(MOD).default;
    s.reset();
    return s;
}

test('cancelOwner drops only that owner\'s jobs', () => {
    const s = sender();
    const ran = [];
    s.request(() => ran.push('a1'), 'preview:a');
    s.request(() => ran.push('b1'), 'preview:b');
    s.request(() => ran.push('a2'), 'preview:a');
    assert.equal(s.pending(), 3);
    assert.equal(s.pendingOf('preview:a'), 2);
    const dropped = s.cancelOwner('preview:a');
    assert.equal(dropped, 2);
    assert.equal(s.pendingOf('preview:a'), 0);
    assert.equal(s.pendingOf('preview:b'), 1);
    s.drainNow();
    assert.deepEqual(ran, ['b1'], 'only the untouched owner ran: ' + JSON.stringify(ran));
});

test('an untagged job is never cancelled by an owner', () => {
    const s = sender();
    const ran = [];
    s.request(() => ran.push('plain'));
    s.request(() => ran.push('owned'), 'preview:x');
    assert.equal(s.cancelOwner('preview:x'), 1);
    s.drainNow();
    assert.deepEqual(ran, ['plain']);
});

test('cancelOwner with an empty owner is a no-op', () => {
    const s = sender();
    s.request(() => { }, 'preview:x');
    assert.equal(s.cancelOwner(''), 0);
    assert.equal(s.pending(), 1);
    s.reset();
});
