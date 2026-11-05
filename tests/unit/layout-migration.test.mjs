/**
 * Offline tests for the 3.1 layout migration.
 *
 * The planner is pure (no fs) so the mapping rules can be tested exhaustively; the
 * executor is exercised against a real temporary directory, including the "target already
 * exists" case, because losing a user's structures.json on upgrade would be unforgivable.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { join, dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { existsSync, mkdtempSync, mkdirSync, writeFileSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..', '..');
const LAYOUT = join(ROOT, 'dist', 'call', 'core', 'src', 'common', 'Layout.js');

function load() {
    assert.ok(existsSync(LAYOUT), 'build first: npm run build:fast');
    return require(LAYOUT);
}

const entry = (path, isFile = true) => ({ path, isFile });

test('planner maps every legacy location to the new one', () => {
    const { planMigration } = load();
    const plan = planMigration([
        entry('userdata/config/configs.json'),
        entry('userdata/config/userlist.json'),
        entry('userdata/config/stupid_permission_file.json'),
        entry('userdata/data/settings.json'),
        entry('userdata/data/nbt/a.mcstructure'),
        entry('userdata/plugins/pack.js'),
        entry('userdata/import/x.mcstructure'),
        entry('userdata/export/y.mcstructure'),
        entry('userdata/version'),
    ]);
    const map = Object.fromEntries(plan.moves.map((m) => [m.from, m.to]));
    assert.equal(map['userdata/config/configs.json'], 'config/configs.json');
    assert.equal(map['userdata/config/userlist.json'], 'config/userlist.json');
    assert.equal(map['userdata/config/stupid_permission_file.json'], 'config/permission.json');
    assert.equal(map['userdata/data/settings.json'], 'data/settings.json');
    assert.equal(map['userdata/data/nbt/a.mcstructure'], 'data/nbt/a.mcstructure');
    assert.equal(map['userdata/plugins/pack.js'], 'data/shapes/pack.js');
    assert.equal(map['userdata/import/x.mcstructure'], 'data/import/x.mcstructure');
    assert.equal(map['userdata/export/y.mcstructure'], 'data/export/y.mcstructure');
    assert.equal(map['userdata/version'], 'data/version');
    assert.deepEqual(plan.dropDirs, ['userdata']);
});

test('never-used legacy directories are dropped, not moved', () => {
    const { planMigration } = load();
    const plan = planMigration([
        entry('userdata/temp/scratch.txt'),
        entry('userdata/build/out.js'),
        entry('userdata/data/settings.json'),
    ]);
    assert.deepEqual(plan.moves.map((m) => m.from), ['userdata/data/settings.json']);
});

test('read-only resources that moved to assets/ are removed from config/', () => {
    const { planMigration } = load();
    const plan = planMigration([
        entry('config/check.json'),
        entry('config/icons.json'),
        entry('config/item_texture.json'),
        entry('config/help.json'),
        entry('config/update.json'),
        entry('config/url.json'),
        entry('config/configs.default.json'),
        entry('config/lang/zh_CN.lang'),
        entry('config/configs.json'),   // user file, must be kept
    ]);
    assert.deepEqual(plan.remove.sort(), [
        'config/check.json',
        'config/configs.default.json',
        'config/help.json',
        'config/icons.json',
        'config/item_texture.json',
        'config/lang/zh_CN.lang',
        'config/update.json',
        'config/url.json',
    ].sort());
    assert.equal(plan.moves.length, 0, 'a config/configs.json must not be moved anywhere');
});

test('an already migrated install plans nothing', () => {
    const { planMigration } = load();
    assert.deepEqual(planMigration([entry('config/configs.json'), entry('data/nbt/a.mcstructure')]),
        { moves: [], remove: [], dropDirs: [] });
});

// ------------------------------------------------------------------ executor

function legacyTree() {
    const root = mkdtempSync(join(tmpdir(), 'call-layout-'));
    const put = (rel, content) => {
        const abs = join(root, rel);
        mkdirSync(dirname(abs), { recursive: true });
        writeFileSync(abs, content, 'utf8');
    };
    put('userdata/config/configs.json', '{"enable":true}');
    put('userdata/config/stupid_permission_file.json', '["steve"]');
    put('userdata/data/settings.json', '{"players":1}');
    put('userdata/data/nbt/sid_0_0.mcstructure', 'NBT');
    put('userdata/plugins/pack.js', 'module.exports={}');
    put('config/check.json', '{"configs":{}}');
    return root;
}

test('executor moves the data and prunes the legacy tree', () => {
    const { migrateLegacyLayout } = load();
    const root = legacyTree();
    try {
        const notice = migrateLegacyLayout(root);
        assert.ok(notice && notice.includes('moved'), 'expected a summary, got ' + notice);

        assert.equal(readFileSync(join(root, 'config/configs.json'), 'utf8'), '{"enable":true}');
        assert.equal(readFileSync(join(root, 'config/permission.json'), 'utf8'), '["steve"]');
        assert.equal(readFileSync(join(root, 'data/settings.json'), 'utf8'), '{"players":1}');
        assert.equal(readFileSync(join(root, 'data/nbt/sid_0_0.mcstructure'), 'utf8'), 'NBT');
        assert.equal(readFileSync(join(root, 'data/shapes/pack.js'), 'utf8'), 'module.exports={}');

        assert.equal(existsSync(join(root, 'userdata')), false, 'empty legacy tree must be pruned');
        assert.equal(existsSync(join(root, 'config/check.json')), false, 'stale resource must be removed');

        // idempotent: a second run has nothing to do
        assert.equal(migrateLegacyLayout(root), null);
    } finally {
        rmSync(root, { recursive: true, force: true });
    }
});

test('a legacy temp/ directory with content is left alone (it is not ours to delete)', () => {
    const { migrateLegacyLayout } = load();
    const root = legacyTree();
    try {
        mkdirSync(join(root, 'userdata/temp'), { recursive: true });
        writeFileSync(join(root, 'userdata/temp/scratch.txt'), 'x', 'utf8');
        migrateLegacyLayout(root);
        assert.equal(existsSync(join(root, 'userdata/temp/scratch.txt')), true, 'user content must survive');
        assert.equal(existsSync(join(root, 'userdata/data')), false, 'migrated dirs are pruned');
    } finally {
        rmSync(root, { recursive: true, force: true });
    }
});

test('executor never overwrites an existing target', () => {
    const { migrateLegacyLayout } = load();
    const root = legacyTree();
    try {
        mkdirSync(join(root, 'config'), { recursive: true });
        writeFileSync(join(root, 'config/configs.json'), '{"enable":false}', 'utf8');

        migrateLegacyLayout(root);

        // the newer file wins, the legacy one is kept next to it for inspection
        assert.equal(readFileSync(join(root, 'config/configs.json'), 'utf8'), '{"enable":false}');
        assert.equal(readFileSync(join(root, 'config/configs.json.old'), 'utf8'), '{"enable":true}');
    } finally {
        rmSync(root, { recursive: true, force: true });
    }
});