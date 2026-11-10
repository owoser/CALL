/**
 * The two conversions that decide whether the library ACCEPTS what we hand it.
 *
 * - `unquoteStateKeys`: the engine reports states with quoted keys, the library only unquotes
 *   values, so a quoted key is looked up with the quotes in it and the entry is dropped.
 * - `parseStats`: `blockBatchStats()` also reports `dropped` / `bad` - the library telling us it
 *   threw work away. Those numbers must reach the debug output.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { join, dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { existsSync } from 'node:fs';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..', '..');
const MOD = join(ROOT, 'dist', 'call', 'core', 'src', 'holo', 'FakeBlocks.js');

const load = () => {
    assert.ok(existsSync(MOD), 'build first: npm run build:fast');
    return require(MOD);
};

test('engine-style quoted keys become bare keys', () => {
    const { unquoteStateKeys } = load();
    assert.equal(
        unquoteStateKeys('["weirdo_direction"=2,"upside_down_bit"=false]'),
        '[weirdo_direction=2,upside_down_bit=false]',
    );
    assert.equal(unquoteStateKeys('["pillar_axis"="x"]'), '[pillar_axis="x"]');
    assert.equal(unquoteStateKeys('[waterlogged=true]'), '[waterlogged=true]');
    assert.equal(unquoteStateKeys(''), '');
});

test('a value that looks like a key is left alone', () => {
    const { unquoteStateKeys } = load();
    // "a"="b" must become a="b" - the value keeps its quotes
    assert.equal(unquoteStateKeys('["a"="b"]'), '[a="b"]');
});

test('stats carry dropped and bad', () => {
    const { parseStats } = load();
    const st = parseStats('batch=12 queue=3 packets=40 bytes=9999 dropped=2 bad=7 nearSets=1');
    assert.equal(st.batch, 12);
    assert.equal(st.queue, 3);
    assert.equal(st.packets, 40);
    assert.equal(st.dropped, 2, 'dropped must be parsed: it is the only "we threw it away" signal');
    assert.equal(st.bad, 7);
    assert.equal(st.nearSets, 1);
});

test('a stats string without the new fields still parses', () => {
    const { parseStats } = load();
    const st = parseStats('batch=1 queue=0 packets=2 bytes=64');
    assert.equal(st.dropped, 0);
    assert.equal(st.bad, 0);
});
