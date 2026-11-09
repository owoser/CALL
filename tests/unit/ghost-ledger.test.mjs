/**
 * The ghost ledger: why a preview used to leave blocks behind.
 *
 * `applied` is the only memory of what the client is showing. Clearing it wholesale (which
 * maybeResend did on every chunk crossing) forgot every cell that left the window, so those
 * cells were never cleared again - they stayed until the player relogged, while the whole window
 * was re-sent over and over.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { join, dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { existsSync } from 'node:fs';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..', '..');
const MOD = join(ROOT, 'dist', 'call', 'core', 'src', 'structure', 'GhostLedger.js');

function load() {
    assert.ok(existsSync(MOD), 'build first: npm run build:fast');
    return require(MOD);
}

test('a set is remembered as shown and as ever-applied', () => {
    const L = load();
    const ledger = L.emptyLedger();
    L.markSet(ledger, '1,2,3', 1, 2, 3, 'minecraft:stone');
    assert.equal(ledger.applied.get('1,2,3'), 'minecraft:stone');
    assert.deepEqual(ledger.everApplied.get('1,2,3'), [1, 2, 3]);
});

test('a confirmed clear forgets the cell', () => {
    const L = load();
    const ledger = L.emptyLedger();
    L.markSet(ledger, '1,2,3', 1, 2, 3, 'minecraft:stone');
    L.markCleared(ledger, '1,2,3');
    assert.equal(ledger.applied.size, 0);
    assert.equal(ledger.everApplied.size, 0);
});

test('an unconfirmed clear becomes owed work, not a silent ghost', () => {
    const L = load();
    const ledger = L.emptyLedger();
    L.markSet(ledger, '1,2,3', 1, 2, 3, 'minecraft:stone');
    L.markOwed(ledger, '1,2,3', 1, 2, 3);
    assert.equal(ledger.applied.size, 0, 'we no longer claim it is applied');
    assert.deepEqual(ledger.stale.get('1,2,3'), [1, 2, 3], 'but we still owe the clear');
    assert.ok(ledger.everApplied.has('1,2,3'), 'and the teardown still knows the cell');
});

test('owed clears are taken in chunks and re-owed on failure', () => {
    const L = load();
    const ledger = L.emptyLedger();
    for (let i = 0; i < 5; i++) L.markOwed(ledger, i + ',0,0', i, 0, 0);
    const first = L.takeOwed(ledger, 2);
    assert.equal(first.length, 2);
    assert.equal(ledger.stale.size, 3);
    for (const entry of first) L.markOwed(ledger, entry.key, entry.pos[0], entry.pos[1], entry.pos[2]);
    assert.equal(ledger.stale.size, 5, 'a failed retry must be owed again');
});

test('teardown restores applied + stale + ever-applied', () => {
    const L = load();
    const ledger = L.emptyLedger();
    L.markSet(ledger, '10,0,0', 10, 0, 0, 'minecraft:stone');   // applied
    L.markOwed(ledger, '11,0,0', 11, 0, 0);                     // owed, no longer applied
    ledger.applied.set('12,0,0', 'minecraft:glass');            // applied but not in everApplied
    const cells = L.teardownCells(ledger);
    const keys = cells.map((c) => c.join(',')).sort();
    assert.deepEqual(keys, ['10,0,0', '11,0,0', '12,0,0']);
});

test('reset empties every map', () => {
    const L = load();
    const ledger = L.emptyLedger();
    L.markSet(ledger, '1,1,1', 1, 1, 1, 'minecraft:stone');
    L.markOwed(ledger, '2,2,2', 2, 2, 2);
    L.resetLedger(ledger);
    assert.equal(ledger.applied.size + ledger.stale.size + ledger.everApplied.size, 0);
});
