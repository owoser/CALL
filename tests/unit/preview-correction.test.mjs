/**
 * Preview position correction, in blocks.
 *
 * The itemDisplay offset parameters are in an unclear unit (model units), so the residual
 * vertical error measured by /ca preview probe is stored in BLOCKS and applied to the spawn
 * position instead.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { join, dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { existsSync } from 'node:fs';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..', '..');
const MOD = join(ROOT, 'dist', 'call', 'core', 'src', 'structure', 'Clipboard.js');

function load() {
    assert.ok(existsSync(MOD), 'build first: npm run build:fast');
    return require(MOD);
}

test('landing N cells high shifts the spawn down by N', () => {
    const { correctionFromLandedCell } = load();
    assert.equal(correctionFromLandedCell(3), -3);
    assert.equal(correctionFromLandedCell(-2), 2);
    assert.equal(correctionFromLandedCell(0), -0);
});

test('the correction is applied in block units', () => {
    const { applyYCorrection } = load();
    assert.equal(applyYCorrection(64, -3), 61);
    assert.equal(applyYCorrection(64, 0.5), 64.5);
    // a broken/absent config must never produce NaN
    assert.equal(applyYCorrection(64, NaN), 64);
    assert.equal(applyYCorrection(64, undefined), 64);
});
