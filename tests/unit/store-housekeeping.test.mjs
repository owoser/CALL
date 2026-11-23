/**
 * data/nbt housekeeping: no folder without a structure in it.
 *
 * The layout migration used to mkdir a folder per xuid found in the old config and only then
 * look for slice files, so a server collected one empty folder per player who ever logged in -
 * permission or not.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { join, dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..', '..');
const STORE_MOD = join(ROOT, 'dist', 'call', 'core', 'src', 'structure', 'StructureStore.js');

test('hasAnyStructure sees files at any depth', () => {
    const { StructureStore } = require(STORE_MOD);
    const dir = mkdtempSync(join(tmpdir(), 'call-store-'));
    try {
        mkdirSync(join(dir, 'player', 'copy', 'abc'), { recursive: true });
        mkdirSync(join(dir, 'empty', 'undo', 'zzz'), { recursive: true });
        assert.equal(StructureStore.hasAnyStructure(join(dir, 'empty')), false);
        writeFileSync(join(dir, 'player', 'copy', 'abc', 'abc.mcstructure'), Buffer.from([10, 0, 0, 0]));
        assert.equal(StructureStore.hasAnyStructure(join(dir, 'player')), true);
    } finally {
        rmSync(dir, { recursive: true, force: true });
    }
});

test('pruneEmptyFolders removes only the folders without data', () => {
    const { StructureStore } = require(STORE_MOD);
    const dir = mkdtempSync(join(tmpdir(), 'call-prune-'));
    const realNbt = StructureStore.root;
    try {
        mkdirSync(join(dir, 'alice', 'copy', 's1'), { recursive: true });
        writeFileSync(join(dir, 'alice', 'copy', 's1', 's1.mcstructure'), Buffer.from([10, 0, 0, 0]));
        mkdirSync(join(dir, 'bob', 'undo', 's2'), { recursive: true }); // empty
        mkdirSync(join(dir, '_legacy'), { recursive: true });            // kept
        mkdirSync(join(dir, 'public'), { recursive: true });             // kept

        // point the store at the temp root for the duration of the call
        StructureStore.root = () => dir;
        const removed = StructureStore.pruneEmptyFolders();
        assert.equal(removed, 1);
        assert.ok(existsSync(join(dir, 'alice')), 'a folder with a structure must survive');
        assert.equal(existsSync(join(dir, 'bob')), false, 'the empty folder must be gone');
        assert.ok(existsSync(join(dir, '_legacy')));
        assert.ok(existsSync(join(dir, 'public')));
    } finally {
        StructureStore.root = realNbt;
        rmSync(dir, { recursive: true, force: true });
    }
});

test('scanFiles maps every slice to the folder it really sits in', () => {
    const { StructureStore } = require(STORE_MOD);
    const dir = mkdtempSync(join(tmpdir(), 'call-scan-'));
    try {
        mkdirSync(join(dir, 'alice', 'copy', 'abc'), { recursive: true });
        writeFileSync(join(dir, 'alice', 'copy', 'abc', 'abc_0_0.mcstructure'), Buffer.from([10, 0, 0, 0]));
        writeFileSync(join(dir, 'alice', 'copy', 'abc', 'abc_1_0.mcstructure'), Buffer.from([10, 0, 0, 0]));
        mkdirSync(join(dir, '_orphan'), { recursive: true });
        writeFileSync(join(dir, '_orphan', 'ghost_0_0.mcstructure'), Buffer.from([10, 0, 0, 0]));

        StructureStore.root = () => dir;
        const map = StructureStore.scanFiles();
        assert.equal(map.get('abc_0_0'), 'alice/copy/abc', 'slice folder is recorded');
        assert.equal(map.get('abc_1_0'), 'alice/copy/abc', 'every slice of the structure is found');
        assert.equal(map.has('ghost_0_0'), false, '_orphan is not resurrected');
    } finally {
        rmSync(dir, { recursive: true, force: true });
    }
});
