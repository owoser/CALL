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

test('the template layout survives a migration of nested objects', () => {
    const J = load();
    const { readFileSync } = require('node:fs');
    const C = require(join(ROOT, 'dist', 'call', 'core', 'src', 'common', 'JsoncConfig.js'));
    const tpl = readFileSync(join(ROOT, 'assets', 'configs.default.jsonc'), 'utf8');
    const old = tpl.replace(/"version": \d+,/, '"version": 1,')
        .replace('"previewNearRadius": 5,', '"previewNearRadius": 7,');
    const res = C.migrateToTemplate(tpl, old);
    assert.ok(res.text != null, 'the version moved, so the file is re-rendered');
    const out = res.text;
    // `default.items` keeps the template's compact one-line-per-binding layout instead of being
    // re-serialised as deep JSON, and the user's own value survives.
    assert.ok(out.includes('{ "cmds": ["call menu"]'), 'compact binding layout kept');
    assert.equal(J.parseJsonc(out).previewNearRadius, 7, 'user value kept');
    assert.deepEqual(J.parseJsonc(out).default.items, J.parseJsonc(tpl).default.items, 'bindings unchanged');
    // Idempotent: a second migration has nothing to do.
    assert.equal(C.migrateToTemplate(tpl, out).text, null, 'a migrated file is already current');
});

test('a patched object keeps the indentation of the line it replaces', () => {
    const J = load();
    // Patching a NESTED object used to paste JSON.stringify output straight in, so every inner
    // line started at column 0 - and each migration pushed the block further out. A version bump
    // that re-renders `default.items` is exactly that case.
    const text = '{\n    "version": 1,\n    "default": {\n        "items": {\n            "k": 1\n        }\n    }\n}\n';
    const next = J.patchJsonc(text, ['default', 'items'], { a: { b: 1 } });
    assert.ok(next != null, 'the path exists');
    const lines = next.split('\n');
    const inner = lines.filter((l) => l.includes('"a"') || l.includes('"b"'));
    assert.ok(inner.length === 2, 'both keys are present: ' + JSON.stringify(lines));
    for (const line of inner) {
        assert.ok(line.startsWith('            '), 'inner line keeps the line indent: ' + JSON.stringify(line));
    }
    assert.deepEqual(J.parseJsonc(next).default.items, { a: { b: 1 } });
});

test('the shipped template parses and its items block is shallow', () => {
    const J = load();
    const { readFileSync } = require('node:fs');
    const text = readFileSync(join(ROOT, 'assets', 'configs.default.jsonc'), 'utf8');
    const value = J.parseJsonc(text);
    assert.ok(Number(value.version) >= 11, 'schema version moved for the reformat: ' + value.version);
    const ids = Object.keys(value.default.items.onUseItemOn);
    assert.ok(ids.every((id) => id.startsWith('call:')), 'only CALL tools are bound: ' + ids.join(','));
    // No line may be indented deeper than 40 columns - the previous file had 40+ inside items.
    const deep = text.split('\n').filter((l) => /^ {41,}\S/.test(l));
    assert.equal(deep.length, 0, 'over-indented lines: ' + deep.slice(0, 2).join(' | '));
});

test('trailing commas are tolerated', () => {
    const J = load();
    const value = J.parseJsonc('{ "a": 1, "b": [1,2,], }');
    assert.deepEqual(value, { a: 1, b: [1, 2] });
});
