/**
 * Which table a structure id belongs to.
 *
 * Regression this pins: public folders were listed by the menu but `findId` never looked at
 * them, so clicking one answered "无法找到结构". The table also has to prefer the folder name
 * over an internal id when they clash, because the folder name is what the player sees.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { join, dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { existsSync } from 'node:fs';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..', '..');
const MOD = join(ROOT, 'dist', 'call', 'core', 'src', 'structure', 'StructureStore.js');

function load() {
    assert.ok(existsSync(MOD), 'build first: npm run build:fast');
    return require(MOD);
}

const SOURCES = {
    own: ['mwOwn1'],
    registry: ['mwPub1'],
    scanned: [
        { name: '领地02号', sid: 'mwScan1' },
        { name: 'mwLoose', sid: 'mwLoose' },
        { name: '完整结构test测试', sid: 'mwScan2' },
    ],
};

test('own saves resolve by id', () => {
    const S = load();
    const hit = S.resolveStructureId('mwOwn1', SOURCES);
    assert.equal(hit.kind, 'own');
    assert.equal(hit.sid, 'mwOwn1');
});

test('published registry resolves by id', () => {
    const S = load();
    assert.equal(S.resolveStructureId('mwPub1', SOURCES).kind, 'registry');
});

test('a public folder resolves by its folder name (what the menu shows)', () => {
    const S = load();
    const hit = S.resolveStructureId('领地02号', SOURCES);
    assert.equal(hit.kind, 'scanned');
    assert.equal(hit.sid, 'mwScan1', 'the slice id is used for reading files');
    assert.equal(hit.display, '领地02号');

    const second = S.resolveStructureId('完整结构test测试', SOURCES);
    assert.equal(second.kind, 'scanned');
    assert.equal(second.sid, 'mwScan2');
});

test('an internal id still finds the public entry', () => {
    const S = load();
    const hit = S.resolveStructureId('mwScan2', SOURCES);
    assert.equal(hit.kind, 'scanned');
    assert.equal(hit.display, '完整结构test测试');
});

test('a loose file in public/ answers to its file base name', () => {
    const S = load();
    const hit = S.resolveStructureId('mwLoose', SOURCES);
    assert.equal(hit.kind, 'scanned');
    assert.equal(hit.sid, 'mwLoose');
});

test('unknown / empty ids are missing, not a throw', () => {
    const S = load();
    assert.equal(S.resolveStructureId('nope', SOURCES).kind, 'missing');
    assert.equal(S.resolveStructureId('', SOURCES).kind, 'missing');
    assert.equal(S.resolveStructureId(undefined, SOURCES).kind, 'missing');
    assert.equal(S.resolveStructureId('  mwOwn1  ', SOURCES).kind, 'own', 'trimmed');
});

test('own beats scanned when the same string is in both', () => {
    const S = load();
    const hit = S.resolveStructureId('mwLoose', { own: ['mwLoose'], registry: [], scanned: [{ name: 'mwLoose', sid: 'other' }] });
    assert.equal(hit.kind, 'own');
});
