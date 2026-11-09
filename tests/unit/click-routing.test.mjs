/**
 * Click routing: one physical click must run a tool ONCE, on the block that was clicked.
 *
 * The wands answer both buttons and both targets, so a single click can arrive twice: once as
 * the block event (correct coordinates) and once through the swing/use heuristics (feet block).
 * The second one is what made every wand look "one block off".
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { join, dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..', '..');
const read = (rel) => readFileSync(join(ROOT, rel), 'utf8');

/** The rule as implemented: block clicks win for 300 ms. */
function shouldRunAir(now, lastBlockAt) {
    return now - lastBlockAt >= 300;
}

test('an air click inside the block-click window is dropped', () => {
    const t0 = 1_000_000;
    assert.equal(shouldRunAir(t0 + 10, t0), false, 'same tick');
    assert.equal(shouldRunAir(t0 + 299, t0), false, 'inside the window');
    assert.equal(shouldRunAir(t0 + 300, t0), true, 'window over');
    assert.equal(shouldRunAir(t0 + 5000, 0), true, 'a fresh player is never blocked');
});

test('the routing is wired on both paths', () => {
    const op = read('core/src/user/ToolOperation.ts');
    assert.ok(op.includes('source: "block" | "air" = "block"'), 'onClick must know its source');
    assert.ok(op.includes('if (now - blockAt < 300) return;'), 'air must yield to a fresh block click');
    assert.ok(op.includes('"air");'), 'the air path must pass the marker');
});

test('air clicks take the crosshair block first, not the feet', () => {
    const op = read('core/src/user/ToolOperation.ts');
    const feet = op.slice(op.indexOf('private static feetBlock('), op.indexOf('public static onAirClick('));
    const view = feet.indexOf('getBlockFromViewVector');
    const standing = feet.indexOf('getBlockStandingOn');
    assert.ok(view > 0 && standing > 0, 'both lookups must exist');
    assert.ok(view < standing, 'the crosshair block must be preferred over the standing block');
});
