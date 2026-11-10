/**
 * A selection whose corners end up in different dimensions must be TREATED AS STALE, not thrown.
 *
 * Both endpoints of the old error - selecting and cancelling - go through hasSetArea(), so throwing
 * there made the area feature unusable until a relog.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { join, dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { existsSync } from 'node:fs';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..', '..');
const MOD = join(ROOT, 'dist', 'call', 'core', 'src', 'common', 'Selection.js');

const load = () => {
    assert.ok(existsSync(MOD), 'build first: npm run build:fast');
    return require(MOD);
};

const corner = (dimid) => ({ x: 0, y: 64, z: 0, dimid });

test('no corners means no selection', () => {
    const { selectionState } = load();
    assert.equal(selectionState(null), 'none');
    assert.equal(selectionState({}), 'none');
    assert.equal(selectionState({ start: corner(null), end: corner(0) }), 'none');
    assert.equal(selectionState({ start: corner(-1), end: corner(0) }), 'none');
});

test('two corners in the same dimension are a real selection', () => {
    const { selectionState } = load();
    assert.equal(selectionState({ start: corner(0), end: corner(0) }), 'valid');
    assert.equal(selectionState({ start: corner(1), end: corner(1) }), 'valid');
    assert.equal(selectionState({ start: corner(2), end: corner(2) }), 'valid');
});

test('corners in different dimensions are stale, never an error', () => {
    const { selectionState } = load();
    assert.equal(selectionState({ start: corner(0), end: corner(1) }), 'mixed');
    assert.equal(selectionState({ start: corner(2), end: corner(0) }), 'mixed');
});
