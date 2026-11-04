/**
 * Offline tests for block-state normalisation.
 *
 * 3.0.7 rejected every states syntax except the canonical one and reported it as
 * "invalid:minecraft:smooth_stone_slab", which reads like a bad block name and sent the
 * investigation in the wrong direction.
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

const CANONICAL = '["minecraft:vertical_half"="bottom"]';

test('every reasonable way of writing states normalises to the canonical form', () => {
    load();
    for (const input of [
        '["minecraft:vertical_half"="bottom"]',
        '["minecraft:vertical_half"=bottom]',
        '[minecraft:vertical_half=bottom]',
        '[minecraft:vertical_half="bottom"]',
        ' minecraft:vertical_half = bottom ',
        '{"minecraft:vertical_half":"bottom"}',
        '["minecraft:vertical_half"="bottom",]',
    ]) {
        assert.equal(S.normaliseBlockStates(input), CANONICAL, 'failed for ' + input);
    }
});

test('multiple states, numbers and booleans', () => {
    load();
    assert.equal(
        S.normaliseBlockStates('[facing_direction=2,upside_down_bit=true]'),
        '["facing_direction"=2,"upside_down_bit"=true]');
    assert.equal(
        S.normaliseBlockStates('{"pillar_axis":"x","weird":-1}'),
        '["pillar_axis"="x","weird"=-1]');
});

test('empty states mean "no states"', () => {
    load();
    for (const input of ['', '   ', '[]', '{}', null, undefined]) {
        assert.equal(S.normaliseBlockStates(input), null, 'expected null for ' + JSON.stringify(input));
    }
});

test('unusable states are rejected rather than silently dropped', () => {
    load();
    // everything that could smuggle extra command syntax in must fail here
    for (const input of ['no equals sign', '[a]', '[=1]', '["a"=x y]', '[a=b,c]', '[a="b\"c"]']) {
        assert.equal(S.normaliseBlockStates(input), null, 'expected null for ' + JSON.stringify(input));
    }
});

test('odd but harmless values are quoted, never emitted raw', () => {
    load();
    // ".." is nonsense but harmless once quoted; what matters is that it cannot escape
    assert.equal(S.normaliseBlockStates('[a=..]'), '["a"=".."]');
    assert.equal(S.normaliseBlockStates('[a=north]'), '["a"="north"]');
});

test('isBlockStates keeps its old contract', () => {
    load();
    assert.equal(S.isBlockStates('["a"=1]'), true);
    assert.equal(S.isBlockStates('[]'), false);
    assert.equal(S.isBlockStates(''), false);
});

test('block[states] token form is split out', () => {
    load();
    assert.deepEqual(S.splitBlockToken('minecraft:oak_stairs[facing_direction=2]'),
        { name: 'minecraft:oak_stairs', states: '[facing_direction=2]' });
    assert.deepEqual(S.splitBlockToken('minecraft:stone'), { name: 'minecraft:stone', states: '' });
    assert.deepEqual(S.splitBlockToken('minecraft:oak_stairs[facing_direction=2'),
        { name: 'minecraft:oak_stairs', states: '[facing_direction=2]' });
});
