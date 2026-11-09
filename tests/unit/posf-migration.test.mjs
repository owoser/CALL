/**
 * Old bindings used `${posf.x}` for what they meant as "the clicked block", but posf is the raw
 * click point on the FACE plane: clicking the +Z face of the block at z=-43 yields z=-42, so the
 * selection landed on the neighbour ("every wand is one block off").
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { join, dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { existsSync } from 'node:fs';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..', '..');
const MOD = join(ROOT, 'dist', 'call', 'core', 'src', 'user', 'BindingMigration.js');

test('posf bindings are rewritten to the clicked block', () => {
    assert.ok(existsSync(MOD), 'build first: npm run build:fast');
    const { migratePosfBindings } = require(MOD);
    assert.equal(typeof migratePosfBindings, 'function', 'the migration must exist');

    const settings = {
        items: {
            onStartDestroyBlock: {
                'call:wand_select': {
                    '': { cmds: ['call area a ${posf.x} ${posf.y} ${posf.z}'] },
                },
            },
            onUseItemOn: {
                'call:wand_paste': {
                    '': { cmds: ['call paste ${posf.x} ${posf.z}'] },
                },
            },
        },
    };
    const changed = migratePosfBindings(settings);
    assert.equal(changed, 2);
    assert.deepEqual(settings.items.onStartDestroyBlock['call:wand_select'][''].cmds,
        ['call area a ${pos.x} ${pos.y} ${pos.z}']);
    assert.deepEqual(settings.items.onUseItemOn['call:wand_paste'][''].cmds,
        ['call paste ${pos.x} ${pos.z}']);

    // idempotent: a second run has nothing to do
    assert.equal(migratePosfBindings(settings), 0);
});
