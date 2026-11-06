/**
 * Binding lookup + migration for the bundled tool items.
 *
 * Both were the reason a click on a tool did nothing: bindings are keyed by item type AND
 * custom display name, and players registered before the tools existed never got the entries.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { join, dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { existsSync } from 'node:fs';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..', '..');
const MOD = join(ROOT, 'dist', 'call', 'core', 'src', 'user', 'Bindings.js');

function load() {
    assert.ok(existsSync(MOD), 'build first: npm run build:fast');
    return require(MOD);
}

const binding = (cmd) => ({ cmds: [cmd], describe: cmd });
const TOOLS = ['call:gear', 'call:wand_select'];

test('an unnamed item matches the empty-name entry', () => {
    const { matchBinding } = load();
    const byType = { '': binding('call menu'), tool: binding('named') };
    assert.equal(matchBinding(byType, '').cmds[0], 'call menu');
});

test('a named item prefers its own entry, then falls back to the unnamed one', () => {
    const { matchBinding } = load();
    const withBoth = { '': binding('default'), '我的魔杖': binding('mine') };
    assert.equal(matchBinding(withBoth, '我的魔杖').cmds[0], 'mine');
    assert.equal(matchBinding(withBoth, '别的名字').cmds[0], 'default');
    assert.equal(matchBinding({ '我的魔杖': binding('mine') }, '别的名字'), null);
});

test('a missing type has no binding', () => {
    const { matchBinding } = load();
    assert.equal(matchBinding(undefined, ''), null);
    assert.equal(matchBinding(null, ''), null);
});

test('migration adds only the missing tool bindings', () => {
    const { mergeToolBindings } = load();
    const defaults = {
        items: {
            onUseItemOn: { 'call:gear': binding('call menu'), 'call:wand_select': binding('b') },
            onStartDestroyBlock: { 'call:wand_select': binding('a') },
        },
    };
    const settings = {
        items: {
            // the player already personalised the right-click selection binding
            onUseItemOn: { 'call:wand_select': binding('my own') },
        },
    };

    const changed = mergeToolBindings(settings, defaults, TOOLS);
    assert.equal(changed, true);
    assert.equal(settings.items.onUseItemOn['call:gear'].cmds[0], 'call menu');
    assert.equal(settings.items.onUseItemOn['call:wand_select'].cmds[0], 'my own', 'never overwrite');
    assert.equal(settings.items.onStartDestroyBlock['call:wand_select'].cmds[0], 'a');
});

test('migration is a no-op once everything is present', () => {
    const { mergeToolBindings } = load();
    const defaults = {
        items: {
            onUseItemOn: { 'call:gear': binding('call menu') },
            onStartDestroyBlock: {},
        },
    };
    const settings = { items: { onUseItemOn: { 'call:gear': binding('call menu') }, onStartDestroyBlock: {} } };
    assert.equal(mergeToolBindings(settings, defaults, TOOLS), false);
});

// ------------------------------------------------------- template fallback

test('mergeDefaults fills keys only the shipped template knows about', () => {
    const { mergeDefaults } = load();
    const template = {
        items: { onUseItemOn: { 'call:wand_adjust': binding('nudge'), 'call:gear': binding('menu') } },
    };
    const live = { items: { onUseItemOn: { 'call:gear': binding('my menu') } } };

    const merged = mergeDefaults(template, live);
    assert.equal(merged.items.onUseItemOn['call:wand_adjust'].cmds[0], 'nudge', 'new tool appears');
    assert.equal(merged.items.onUseItemOn['call:gear'].cmds[0], 'my menu', 'customisation wins');
    // inputs must survive untouched: the live config object is a JsonConfigFile node
    assert.equal(live.items.onUseItemOn['call:wand_adjust'], undefined);
    assert.equal(template.items.onUseItemOn['call:gear'].cmds[0], 'menu');
});

test('a tool that the live defaults never heard of still gets bound', () => {
    const { mergeDefaults, mergeToolBindings } = load();
    // exactly the 3.5.0 situation: configs.json predates call:wand_adjust
    const templateItems = { onUseItemOn: { 'call:wand_adjust': binding('call preview nudgeface') } };
    const liveItems = { onUseItemOn: { 'call:gear': binding('call menu') } };
    const settings = { items: { onUseItemOn: { 'call:gear': binding('call menu') } } };

    const changed = mergeToolBindings(settings, { items: mergeDefaults(templateItems, liveItems) }, ['call:wand_adjust']);
    assert.equal(changed, true);
    assert.equal(settings.items.onUseItemOn['call:wand_adjust'].cmds[0], 'call preview nudgeface');
});

test('mergeDefaults replaces arrays wholesale and never shares references', () => {
    const { mergeDefaults } = load();
    const template = { a: { b: [1, 2] }, c: 1 };
    const live = { a: { b: [3] } };
    const out = mergeDefaults(template, live);

    assert.deepEqual(out.a.b, [3], 'arrays are replaced, not merged element-wise');
    assert.equal(out.c, 1, 'template-only scalar survives');
    out.a.b.push(4);
    assert.deepEqual(live.a.b, [3], 'override untouched');
});

test('migration ignores ids it was not asked about', () => {
    const { mergeToolBindings } = load();
    const defaults = { items: { onUseItemOn: { 'minecraft:clock': binding('call') } } };
    const settings = {};
    mergeToolBindings(settings, defaults, TOOLS);
    assert.equal(settings.items.onUseItemOn['minecraft:clock'], undefined);
});
