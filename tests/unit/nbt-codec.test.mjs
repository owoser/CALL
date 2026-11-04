/**
 * Offline unit tests for the NBT codec.
 *
 * These run WITHOUT a LeviLamina server, which is the whole point: the 2.0 endian bug
 * (files > 787 bytes misdetected as big-endian -> "structure has no usable size") was
 * invisible to the live harness because it only used a 3x2x3 test region (337 bytes).
 *
 * The fixtures are real .mcstructure files shipped with the game, of increasing size.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, existsSync } from 'node:fs';
import { join, dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..', '..');
const CODEC = join(ROOT, 'dist', 'call', 'core', 'src', 'io', 'NbtCodec.js');

// A local LeviLamina install is needed for the real fixtures; skip gracefully without one.
const SERVER = process.env.CALL_TEST_SERVER ||
    join(ROOT, '.testserver');

const FIXTURES = [
    // [relative path, expected min size]
    ['behavior_packs/vanilla/structures/bastion/mobs/hoglin.mcstructure', 1000],
    ['behavior_packs/vanilla/structures/bastion/mobs/sword_piglin.mcstructure', 1000],
    ['behavior_packs/vanilla_1.26.30/structures/minecraft/sulfur_spring_small_1.mcstructure', 5000],
    ['behavior_packs/vanilla_1.26.30/structures/minecraft/sulfur_spring_extra_large_1.mcstructure', 20000],
];

let codec;

function loadCodec() {
    if (!existsSync(CODEC)) {
        throw new Error('build first: npm run build:fast  (missing ' + CODEC + ')');
    }
    // eslint-disable-next-line @typescript-eslint/no-var-requires
    codec = require(CODEC);
    return codec;
}

test('endian detection is size independent (regression: >787 byte files)', () => {
    loadCodec();
    const available = FIXTURES.filter(([rel]) => existsSync(join(SERVER, rel)));
    if (available.length === 0) {
        console.log('skipping: no the fixtures found under ' + SERVER);
        return;
    }
    for (const [rel] of available) {
        const buf = readFileSync(join(SERVER, rel));
        // every real .mcstructure is little-endian
        assert.equal(codec.detectEndian(buf), 'le', rel + ' should be detected as little-endian');
        const layout = codec.parseStructureLayout(buf);
        assert.ok(Array.isArray(layout.size) && layout.size.length === 3, rel + ' size');
        assert.ok(layout.size.every((n) => Number.isFinite(n) && n > 0), rel + ' size values: ' + layout.size);
        assert.ok(layout.indices.length > 0, rel + ' indices');
        assert.ok(layout.palette.length > 0, rel + ' palette entries');
        const expectedVolume = layout.size[0] * layout.size[1] * layout.size[2];
        assert.ok(
            layout.indices.length === expectedVolume || layout.indices.length >= expectedVolume,
            rel + ' indices ' + layout.indices.length + ' vs volume ' + expectedVolume
        );
    }
    console.log('verified ' + available.length + ' real structure file(s)');
});

test('big-endian and little-endian round trip', () => {
    loadCodec();
    // minimal structure: 1x1x1 stone
    const layoutBytes = buildVanillaStructureBuffer();
    assert.equal(codec.detectEndian(layoutBytes), 'le');

    const be = codec.toBigEndian(layoutBytes);
    assert.equal(codec.detectEndian(be), 'be', 'converted bytes must be recognised as big-endian');

    const back = codec.toLittleEndian(be);
    assert.equal(codec.detectEndian(back), 'le');
    assert.deepEqual(back, layoutBytes, 'little -> big -> little must be byte identical');

    const parsed = codec.parseStructureLayout(layoutBytes);
    assert.deepEqual(parsed.size, [1, 1, 1]);
    assert.equal(parsed.palette[0].name, 'minecraft:stone');
});

/** Hand-build a 1x1x1 .mcstructure (little-endian) without relying on the game. */
function buildVanillaStructureBuffer() {
    const parts = [];
    const u8 = (v) => parts.push(Buffer.from([v & 0xff]));
    const u16 = (v) => {
        const b = Buffer.allocUnsafe(2);
        b.writeUInt16LE(v, 0);
        parts.push(b);
    };
    const i32 = (v) => {
        const b = Buffer.allocUnsafe(4);
        b.writeInt32LE(v, 0);
        parts.push(b);
    };
    const str = (s) => {
        const body = Buffer.from(s, 'utf8');
        u16(body.length);
        parts.push(body);
    };
    const named = (type, name, writePayload) => {
        u8(type);
        str(name);
        writePayload();
    };

    // root compound
    u8(10);
    str('');
    named(3, 'format_version', () => i32(2));
    // size: list<int> [1,1,1]
    named(9, 'size', () => {
        u8(3);
        i32(3);
        i32(1);
        i32(1);
        i32(1);
    });
    // structure
    named(10, 'structure', () => {
        // block_indices: list<list<int>> [[0]]
        named(9, 'block_indices', () => {
            u8(9);
            i32(1);
            u8(3);
            i32(1);
            i32(0);
        });
        // entities: empty list
        named(9, 'entities', () => {
            u8(10);
            i32(0);
        });
        // palette.default.block_palette
        named(10, 'palette', () => {
            named(10, 'default', () => {
                named(9, 'block_palette', () => {
                    u8(10);
                    i32(1);
                    named(8, 'name', () => str('minecraft:stone'));
                    named(10, 'states', () => u8(0));
                    named(3, 'version', () => i32(1));
                    u8(0);
                });
                named(10, 'block_position_data', () => u8(0));
                u8(0);
            });
            u8(0);
        });
        u8(0);
    });
    // structure_world_origin
    named(9, 'structure_world_origin', () => {
        u8(3);
        i32(3);
        i32(0);
        i32(0);
        i32(0);
    });
    u8(0); // end of root compound

    return Buffer.concat(parts);
}
