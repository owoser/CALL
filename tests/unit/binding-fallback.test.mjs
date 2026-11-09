/**
 * Binding resolution: a CALL tool must never be a dead item.
 *
 * The old matcher required the exact display name (or an unnamed entry), so a renamed tool - or
 * one whose config key drifted - reported "这个工具还没有绑定" at random.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { join, dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { existsSync } from 'node:fs';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..', '..');
const MOD = join(ROOT, 'dist', 'call', 'core', 'src', 'user', 'Bindings.js');

function load() {
    assert.ok(existsSync(MOD), 'build first: npm run build:fast');
    return require(MOD);
}

test('an exact display name wins', () => {
    const { matchBinding } = load();
    const byType = { 'named': { cmds: ['a'] }, '': { cmds: ['b'] }, 'other': { cmds: ['c'] } };
    assert.deepEqual(matchBinding(byType, 'named'), { cmds: ['a'] });
});

test('the unnamed entry is the second choice', () => {
    const { matchBinding } = load();
    const byType = { '': { cmds: ['b'] }, 'other': { cmds: ['c'] } };
    assert.deepEqual(matchBinding(byType, 'renamed-by-the-player'), { cmds: ['b'] });
});

test('a drifted name falls back to the type instead of nothing', () => {
    const { matchBinding } = load();
    const byType = { 'other': { cmds: ['c'] }, 'third': { cmds: ['d'] } };
    assert.deepEqual(matchBinding(byType, '§b选区魔杖'), { cmds: ['c'] });
});

test('surrounding whitespace does not defeat the match', () => {
    const { matchBinding } = load();
    const byType = { '§a复制魔杖': { cmds: ['copy'] } };
    assert.deepEqual(matchBinding(byType, '§a复制魔杖  '), { cmds: ['copy'] });
});

test('a type with no bindings still returns null (that is a real config problem)', () => {
    const { matchBinding } = load();
    assert.equal(matchBinding({}, 'anything'), null);
    assert.equal(matchBinding(null, 'anything'), null);
});
