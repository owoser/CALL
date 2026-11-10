/**
 * A Player has no `dimid` - only IntPos/FloatPos do (LSE typings). Reading it off the player made
 * every dimension resolve to 0, which is invisible in the Overworld and silently breaks EVERY
 * restore in the Nether/End (the server then asks Overworld chunks for Nether coordinates).
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { join, dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { existsSync } from 'node:fs';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..', '..');
const MOD = join(ROOT, 'dist', 'call', 'core', 'src', 'common', 'Dimension.js');

const load = () => {
    assert.ok(existsSync(MOD), 'build first: npm run build:fast');
    return require(MOD);
};

test('the dimension comes from the position object', () => {
    const { dimensionOf } = load();
    assert.equal(dimensionOf({ $: { pos: { dimid: 1 } } }), 1, 'nether');
    assert.equal(dimensionOf({ $: { pos: { dimid: 2 } } }), 2, 'end');
    assert.equal(dimensionOf({ $: { pos: { dimid: 0 } } }), 0);
});

test('a missing/invalid position falls back to the selection area, then 0', () => {
    const { dimensionOf } = load();
    // -1 is LSE's "invalid or unavailable": it must not win over a known-good area
    assert.equal(dimensionOf({ $: { pos: {} }, settings: { area: { start: { dimid: 2 } } } }), 2);
    assert.equal(dimensionOf({ $: { pos: { dimid: -1 } }, settings: { area: { start: { dimid: 1 } } } }), 1);
    assert.equal(dimensionOf(null), 0);
    assert.equal(dimensionOf({}), 0);
});

test('a raw player-like object works too', () => {
    const { dimensionOf } = load();
    assert.equal(dimensionOf({ pos: { dimid: 1 } }), 1);
});

test('the invalid marker is never treated as a dimension', () => {
    const { isValidDimension } = load();
    assert.equal(isValidDimension(0), true);
    assert.equal(isValidDimension(2), true);
    assert.equal(isValidDimension(-1), false);
    assert.equal(isValidDimension(undefined), false);
    assert.equal(isValidDimension('1'), true);
});
