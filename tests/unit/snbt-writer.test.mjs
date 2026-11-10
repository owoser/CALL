/**
 * SNBT must be written from our OWN tag tree.
 *
 * Measured on a real capture: a banner payload (a Patterns LIST OF COMPOUNDS) converted through
 * LSE tags and toSNBT() came back as an empty string, while a chest (Items: []) worked. The caller
 * drops an empty payload, so banners were captured and then silently never sent - the black banner.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { join, dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { existsSync } from 'node:fs';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..', '..');
const MOD = join(ROOT, 'dist', 'call', 'core', 'src', 'io', 'NbtCodec.js');

const str = (v) => ({ type: 8, value: v });
const int = (v) => ({ type: 3, value: v });
const byte = (v) => ({ type: 1, value: v });
const list = (items) => ({ type: 9, items });
const compound = (entries) => ({ type: 10, entries: Object.entries(entries).map(([name, tag]) => ({ name, tag })) });

test('a banner payload serialises (the case toSNBT() returned "")', () => {
    const { snbtWrite } = require(MOD);
    const banner = compound({
        id: str('Banner'),
        Base: int(9),
        Patterns: list([compound({ Pattern: str('hh'), Color: int(9) })]),
    });
    const snbt = snbtWrite(banner);
    assert.ok(snbt.length > 0, 'empty SNBT');
    // Keys stay unquoted on purpose: that is the form the library's parser handles (the same
    // lesson as block-state strings, where a quoted KEY was refused).
    assert.equal(snbt, '{id:"Banner",Base:9,Patterns:[{Pattern:"hh",Color:9}]}');
});

test('an empty list and a nested compound both survive', () => {
    const { snbtWrite } = require(MOD);
    const chest = compound({ id: str('Chest'), Findable: byte(0), Items: list([]) });
    assert.equal(snbtWrite(chest), '{id:"Chest",Findable:0b,Items:[]}');
});

test('scalars get the suffixes the SNBT parser expects', () => {
    const { snbtWrite } = require(MOD);
    assert.equal(snbtWrite(byte(1)), '1b');
    assert.equal(snbtWrite({ type: 5, value: 1 }), '1.0f');
    assert.equal(snbtWrite({ type: 6, value: 2.5 }), '2.5d');
    assert.equal(snbtWrite({ type: 4, value: 7 }), '7L');
    assert.equal(snbtWrite({ type: 7, value: new Uint8Array([1, 2]) }), '[B;1b,2b]');
});

test('strings are escaped and odd keys are quoted', () => {
    const { snbtWrite } = require(MOD);
    assert.equal(snbtWrite(str('a"b\\c')), '"a\\"b\\\\c"');
    assert.equal(snbtWrite(compound({ 'weird key': int(1) })), '{"weird key":1}');
});
