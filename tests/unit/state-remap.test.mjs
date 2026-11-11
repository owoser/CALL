/**
 * Directional block states must turn with the cells.
 *
 * A rotated paste used to move the blocks and leave every palette entry alone, so a rotated
 * staircase kept facing the original way while the shape turned ("the stairs are scrambled").
 * The algebra below is the same matrix transformLayout()/cellOffset() apply to positions.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { join, dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { existsSync } from 'node:fs';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..', '..');
const MOD = join(ROOT, 'dist', 'call', 'core', 'src', 'structure', 'StateRemap.js');

function load() {
    assert.ok(existsSync(MOD), 'build first: npm run build:fast');
    return require(MOD);
}

/** weirdo_direction: 0 east, 1 west, 2 south, 3 north. */
const stairs = (d) => ({ weirdo_direction: d });
const dirOf = (states) => states.weirdo_direction;

test('no transform leaves the object untouched', () => {
    const { remapStates } = load();
    const states = stairs(2);
    assert.equal(remapStates(states, 0, 'none'), states);
});

test('stairs turn with the cells', () => {
    const { remapStates } = load();
    assert.equal(dirOf(remapStates(stairs(0), 90, 'none')), 2); // east -> south
    assert.equal(dirOf(remapStates(stairs(2), 90, 'none')), 1); // south -> west
    assert.equal(dirOf(remapStates(stairs(0), 180, 'none')), 1);
    assert.equal(dirOf(remapStates(stairs(0), 270, 'none')), 3);
});

test('four 90 degree turns return to the start', () => {
    const { remapStates } = load();
    for (let start = 0; start <= 3; start++) {
        let d = start;
        for (let i = 0; i < 4; i++) d = dirOf(remapStates({ weirdo_direction: d }, 90, 'none'));
        assert.equal(d, start);
    }
});

test('mirroring swaps only the matching axis', () => {
    const { remapStates } = load();
    assert.equal(dirOf(remapStates(stairs(0), 0, 'x')), 1); // east <-> west
    assert.equal(dirOf(remapStates(stairs(1), 0, 'x')), 0);
    assert.equal(dirOf(remapStates(stairs(2), 0, 'x')), 2); // south unaffected
    assert.equal(dirOf(remapStates(stairs(2), 0, 'z')), 3); // south <-> north
    assert.equal(dirOf(remapStates(stairs(0), 0, 'z')), 0);
});

test('mirror twice is the identity', () => {
    const { remapStates } = load();
    for (let start = 0; start <= 3; start++) {
        assert.equal(dirOf(remapStates(remapStates(stairs(start), 0, 'x'), 0, 'x')), start);
        assert.equal(dirOf(remapStates(remapStates(stairs(start), 0, 'z'), 0, 'z')), start);
    }
});

test('logs swap x and z on a quarter turn only', () => {
    const { remapStates } = load();
    assert.equal(remapStates({ pillar_axis: 'x' }, 90, 'none').pillar_axis, 'z');
    assert.equal(remapStates({ pillar_axis: 'z' }, 270, 'none').pillar_axis, 'x');
    assert.equal(remapStates({ pillar_axis: 'x' }, 180, 'none').pillar_axis, 'x');
    assert.equal(remapStates({ pillar_axis: 'y' }, 90, 'none').pillar_axis, 'y');
    assert.equal(remapStates({ pillar_axis: 'x' }, 0, 'x').pillar_axis, 'x'); // a mirror never turns an axis
});

test('facing_direction keeps up/down and turns the horizontals', () => {
    const { remapStates } = load();
    assert.equal(remapStates({ facing_direction: 2 }, 90, 'none').facing_direction, 5); // north -> east
    assert.equal(remapStates({ facing_direction: 4 }, 90, 'none').facing_direction, 2); // west -> north
    assert.equal(remapStates({ facing_direction: 0 }, 90, 'none').facing_direction, 0); // down
    assert.equal(remapStates({ facing_direction: 1 }, 90, 'none').facing_direction, 1); // up
});

test('torch facing names turn too', () => {
    const { remapStates } = load();
    assert.equal(remapStates({ torch_facing_direction: 'north' }, 90, 'none').torch_facing_direction, 'east');
    assert.equal(remapStates({ torch_facing_direction: 'top' }, 90, 'none').torch_facing_direction, 'top');
});

test('a NAMESPACED state key is remapped too (a chest reports minecraft:cardinal_direction)', () => {
    const { remapStates } = load();
    // Bare key: 0 south, 1 west, 2 north, 3 east; 90 degrees clockwise -> south becomes west.
    assert.equal(remapStates({ cardinal_direction: 0 }, 90, 'none').cardinal_direction, 1);
    // The namespace must not hide it from the table.
    assert.equal(remapStates({ 'minecraft:cardinal_direction': 0 }, 90, 'none')['minecraft:cardinal_direction'], 1);
    // ... and the value may be the STRING form.
    assert.equal(remapStates({ 'minecraft:cardinal_direction': 'south' }, 90, 'none')['minecraft:cardinal_direction'], 'west');
    assert.equal(remapStates({ 'minecraft:cardinal_direction': 'north' }, 180, 'none')['minecraft:cardinal_direction'], 'south');
    assert.equal(remapStates({ 'minecraft:cardinal_direction': 'east' }, 0, 'x')['minecraft:cardinal_direction'], 'west');
    // An untouched namespace key keeps its original value.
    assert.equal(remapStates({ 'minecraft:cardinal_direction': 'up' }, 90, 'none')['minecraft:cardinal_direction'], 'up');
});

test('door / trapdoor direction follows the same four-way table', () => {
    const { remapStates } = load();
    assert.equal(remapStates({ direction: 0 }, 90, 'none').direction, 1);
    assert.equal(remapStates({ direction: 2 }, 90, 'none').direction, 3);
    assert.equal(remapStates({ direction: 0 }, 180, 'none').direction, 2);
});

test('ground_sign_direction rotates in 22.5 degree steps and mirrors', () => {
    const { remapStates } = load();
    assert.equal(remapStates({ ground_sign_direction: 0 }, 90, 'none').ground_sign_direction, 12); // south -> west
    assert.equal(remapStates({ ground_sign_direction: 0 }, 0, 'x').ground_sign_direction, 0);  // south stays south
    assert.equal(remapStates({ ground_sign_direction: 4 }, 0, 'x').ground_sign_direction, 12); // east <-> west
    assert.equal(remapStates({ ground_sign_direction: 4 }, 0, 'z').ground_sign_direction, 4);   // east unaffected
});

test('typed (NBT) values keep their type wrapper', () => {
    const { remapStates } = load();
    const out = remapStates({ weirdo_direction: { type: 3, value: 0 } }, 90, 'none');
    assert.deepEqual(out.weirdo_direction, { type: 3, value: 2 });
});

test('unknown directional keys are left alone, not guessed', () => {
    const { remapStates } = load();
    // `direction` USED to be here; doors/trapdoors confirmed the four-way table, so it is mapped now.
    assert.equal(remapStates({ rail_direction: 2 }, 90, 'none').rail_direction, 2);
    assert.equal(remapStates({ waterlogged: true }, 90, 'none').waterlogged, true);
});

test('the paste path (transformLayout) applies the same mapping', () => {
    const NbtCodec = require(join(ROOT, 'dist', 'call', 'core', 'src', 'io', 'NbtCodec.js'));
    const layout = {
        size: [2, 1, 2],
        indices: [0, 1, 1, 0],
        palette: [{ name: 'minecraft:stone_stairs', states: { weirdo_direction: { type: 3, value: 0 } } }],
    };
    const turned = NbtCodec.transformLayout(layout, { rotation: 90, mirror: 'none' });
    assert.equal(turned.palette[0].states.weirdo_direction.value, 2, 'the palette must turn with the cells');
});
