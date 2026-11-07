/**
 * The config file must keep its comments across every write.
 *
 * Regression this pins: migrations used to JSON.stringify the whole document, so a server that
 * upgraded once lost the entire annotated template and had no idea what a key meant.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { join, dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { existsSync } from 'node:fs';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..', '..');
const MOD = join(ROOT, 'dist', 'call', 'core', 'src', 'common', 'JsoncDoc.js');

function load() {
    assert.ok(existsSync(MOD), 'build first: npm run build:fast');
    return require(MOD);
}

const SAMPLE = '{\n    // leading comment\n    "version": 1,\n    "a": 1, /* inline */\n    "b": {\n        "c": "x" // tail\n    }\n}\n';

test('comments are parsed away and values come out', () => {
    const J = load();
    const value = J.parseJsonc(SAMPLE);
    assert.equal(value.version, 1);
    assert.equal(value.a, 1);
    assert.equal(value.b.c, 'x');
});

test('a value is patched without touching a single comment', () => {
    const J = load();
    const next = J.patchJsonc(SAMPLE, ['a'], 42);
    assert.ok(next.includes('// leading comment'), 'leading comment kept');
    assert.ok(next.includes('/* inline */'), 'inline comment kept');
    assert.ok(next.includes('// tail'), 'nested comment kept');
    assert.equal(J.parseJsonc(next).a, 42);
    assert.equal(J.parseJsonc(next).b.c, 'x', 'other values untouched');
});

test('nested values are patched by dotted path', () => {
    const J = load();
    const next = J.patchJsonc(SAMPLE, ['b', 'c'], 'changed');
    assert.equal(J.parseJsonc(next).b.c, 'changed');
    assert.ok(next.includes('// tail'));
});

test('an unknown path returns null instead of corrupting the text', () => {
    const J = load();
    assert.equal(J.patchJsonc(SAMPLE, ['nope'], 1), null);
});

test('the template is rendered with user values and keeps its comments', () => {
    const J = load();
    const merged = J.renderFromTemplate(SAMPLE, { version: 2, a: 9 });
    const value = J.parseJsonc(merged);
    assert.equal(value.a, 9, 'user value wins');
    assert.equal(value.version, 2);
    assert.equal(value.b.c, 'x', 'template default survives');
    assert.ok(merged.includes('// leading comment'));
});

test('trailing commas are tolerated', () => {
    const J = load();
    const value = J.parseJsonc('{ "a": 1, "b": [1,2,], }');
    assert.deepEqual(value, { a: 1, b: [1, 2] });
});
