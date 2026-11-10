/**
 * Preview block descriptors: `name[state=value]`.
 *
 * The preview used to send only the block NAME, so every stair faced north and every fence lost
 * its connections (the paste was always correct). HologramLib resolves the string through
 * `Block::tryGetFromRegistry`, which understands the /setblock descriptor syntax.
 *
 * Keys are deliberately UNQUOTED: the library parser trims the key but only unquotes the value,
 * so a quoted key arrives at the registry with literal quotes and the descriptor is refused.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { join, dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { existsSync } from 'node:fs';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..', '..');
const MOD = join(ROOT, 'dist', 'call', 'core', 'src', 'structure', 'SurfaceExtract.js');

function load() {
    assert.ok(existsSync(MOD), 'build first: npm run build:fast');
    return require(MOD);
}

test('a block without states stays a bare name', () => {
    const { descriptorOf } = load();
    assert.equal(descriptorOf({ name: 'minecraft:stone', states: {} }), 'minecraft:stone');
    assert.equal(descriptorOf({ name: 'minecraft:stone' }), 'minecraft:stone');
});

test('stairs carry their facing and half', () => {
    const { descriptorOf } = load();
    const id = descriptorOf({
        name: 'minecraft:stone_stairs',
        states: {
            weirdo_direction: { type: 3, value: 2 },
            upside_down_bit: { type: 1, value: 0 },
        },
    });
    assert.equal(id, 'minecraft:stone_stairs[weirdo_direction=2,upside_down_bit=false]');
});

test('string states are quoted, floats stay numeric', () => {
    const { descriptorOf } = load();
    assert.equal(
        descriptorOf({ name: 'minecraft:log', states: { pillar_axis: { type: 8, value: 'x' } } }),
        'minecraft:log[pillar_axis="x"]'
    );
    assert.equal(
        descriptorOf({ name: 'minecraft:tallgrass', states: { height: { type: 5, value: 1.5 } } }),
        'minecraft:tallgrass[height=1.5]'
    );
});

test('a plain value (no type wrapper) still works', () => {
    const { descriptorOf } = load();
    assert.equal(descriptorOf({ name: 'minecraft:door', states: { open_bit: true } }),
        'minecraft:door[open_bit=true]');
});
