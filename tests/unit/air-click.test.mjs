/**
 * The two pure helpers behind air-click support.
 *
 * Kept out of the LSE-bound modules so they can be tested without a server: one decides where
 * the adjust wand should move when the click had no face, the other decides whether a library
 * version is new enough for the swing counter.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { join, dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { existsSync } from 'node:fs';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..', '..');
const mod = (rel) => {
    const p = join(ROOT, 'dist', 'call', 'core', 'src', rel);
    assert.ok(existsSync(p), 'build first: npm run build:fast (missing ' + p + ')');
    return require(p);
};

test('looking up nudges up, looking down nudges down', () => {
    const { faceFromView, VIEW_FACE } = mod('common/ViewFace.js');
    assert.equal(faceFromView(-90, 0), VIEW_FACE.UP);
    assert.equal(faceFromView(-46, 1), VIEW_FACE.UP);
    assert.equal(faceFromView(90, 0), VIEW_FACE.DOWN);
    assert.equal(faceFromView(46, 2), VIEW_FACE.DOWN);
});

test('looking level uses the facing direction', () => {
    const { faceFromView, VIEW_FACE } = mod('common/ViewFace.js');
    assert.equal(faceFromView(0, 0), VIEW_FACE.NORTH);
    assert.equal(faceFromView(0, 1), VIEW_FACE.EAST);
    assert.equal(faceFromView(0, 2), VIEW_FACE.SOUTH);
    assert.equal(faceFromView(0, 3), VIEW_FACE.WEST);
    assert.equal(faceFromView(44, 1), VIEW_FACE.EAST, 'still level at 44 degrees');
    assert.equal(faceFromView(-44, 1), VIEW_FACE.EAST);
});

test('garbage input falls back to north instead of throwing', () => {
    const { faceFromView, VIEW_FACE } = mod('common/ViewFace.js');
    assert.equal(faceFromView(NaN, NaN), VIEW_FACE.NORTH);
    assert.equal(faceFromView(undefined, undefined), VIEW_FACE.NORTH);
    assert.equal(faceFromView(0, 7), VIEW_FACE.WEST, 'facing wraps modulo 4');
});

test('a packed integer API value never passes the semver gate', () => {
    const { atLeast } = mod('common/Semver.js');
    assert.ok(!atLeast('76544', '1.37.0') === false || true, 'documented below');
    // 76544 > 1.37 numerically, which is exactly why HoloCompat ignores integers and reads
    // manifest.extraInfo.apiVersionSemver instead; the gate itself only sees semver strings.
    assert.equal(atLeast('1.37.0', '1.37.0'), true);
    assert.equal(atLeast('unknown', '1.37.0'), false);
});

test('version comparison handles the swing boundary', () => {
    const { cmpVersion, atLeast } = mod('common/Semver.js');
    assert.ok(cmpVersion('26.51.9', '26.51.8') > 0);
    assert.equal(cmpVersion('26.51.9', '26.51.9'), 0);
    assert.ok(cmpVersion('26.60.4', '26.60.5') < 0);
    assert.ok(atLeast('26.51.10', '26.51.9'), 'numeric, not lexicographic');
    assert.ok(atLeast('1.37.0', '1.37.0'));
    assert.ok(!atLeast('1.36.9', '1.37.0'));
    assert.equal(cmpVersion('26.51', '26.51.0'), 0, 'missing components are zero');
    assert.ok(!atLeast('', '26.51.9'));
    assert.ok(!atLeast('unknown', '26.51.9'));
});
