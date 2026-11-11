/**
 * Emptying a container through the CONTAINER API before its block is replaced.
 *
 * Rewriting the block entity NBT is the trap: that write is itself what makes the engine spill the
 * contents (measured on the live server).
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { join, dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { existsSync } from 'node:fs';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..', '..');
const MOD = join(ROOT, 'dist', 'call', 'core', 'src', 'structure', 'ContainerClear.js');

const load = () => {
    assert.ok(existsSync(MOD), 'build first: npm run build:fast');
    return require(MOD);
};

const fakeContainer = (items) => {
    const slots = items.slice();
    return {
        size: slots.length,
        getItem: (i) => slots[i] ?? null,
        removeItem(i, count) { slots[i] = null; return true; },
        left: () => slots.filter(Boolean).length,
    };
};

test('a non-container block is left alone', () => {
    const { emptyContainerAt } = load();
    assert.equal(emptyContainerAt(null), 0);
    assert.equal(emptyContainerAt({}), 0);
    assert.equal(emptyContainerAt({ hasContainer: () => false }), 0);
});

test('every slot of a container is emptied, empty slots are skipped', () => {
    const { emptyContainerAt } = load();
    const container = fakeContainer([
        { type: 'minecraft:stone', count: 64 },
        null,
        { type: 'minecraft:gold_ingot', count: 7 },
    ]);
    const block = { hasContainer: () => true, getContainer: () => container };
    assert.equal(emptyContainerAt(block), 2, 'two stacks removed');
    assert.equal(container.left(), 0, 'the container is empty');
});

test('an "air" item counts as an empty slot', () => {
    const { emptyContainerAt } = load();
    const container = fakeContainer([{ type: 'minecraft:air', count: 0 }]);
    const block = { hasContainer: () => true, getContainer: () => container };
    assert.equal(emptyContainerAt(block), 0);
});

test('a broken container never throws and reports nothing cleared', () => {
    const { emptyContainerAt } = load();
    assert.equal(emptyContainerAt({ hasContainer: () => { throw new Error('boom'); } }), 0);
    assert.equal(emptyContainerAt({ hasContainer: () => true, getContainer: () => null }), 0);
});
