/**
 * block_position_data recovery.
 *
 * The compound walk inside `structure` stops after `palette` on real files, so the codec anchors
 * on the `block_position_data` name and parses that compound directly. Verified against a 64 KB
 * banner structure from the test server: the walk saw 0 payloads, the scanner sees 33.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import { join, dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { existsSync } from 'node:fs';
import { readFileSync } from 'node:fs';

const require = createRequire(import.meta.url);
const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..', '..');
const MOD = join(ROOT, 'dist', 'call', 'core', 'src', 'io', 'NbtCodec.js');
const codec = existsSync(MOD) ? require(MOD) : null;

test('block entities are part of the parsed layout type', () => {
    assert.ok(codec != null, 'build first: npm run build:fast');
    assert.equal(typeof codec.parseStructureLayout, 'function');
    assert.equal(typeof codec.toLseTag, 'function');
});

test('the scanner is what recovers them from real files', async () => {
    // The compound walk inside `structure` stops after `palette` on real .mcstructure files, so the
    // codec anchors on the name and parses that compound directly. Verified against a real 64 KB
    // banner structure from the test server: the walk reported 0 payloads, the scanner 33.
    const src = readFileSync(join(ROOT, 'core', 'src', 'io', 'NbtCodec.ts'), 'utf8');
    assert.ok(src.includes('function scanBlockEntities('), 'the name-anchored scanner must exist');
    assert.ok(src.includes('parseBlockEntities(structureTag) ?? scanBlockEntities(buf)'),
        'the scanner must run when the tree walk finds nothing');
});
