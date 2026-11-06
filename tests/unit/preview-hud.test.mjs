/**
 * The preview countdown and the click gestures.
 *
 * Both are pure so the wording, the colour thresholds and the gesture table can be pinned
 * without a server: a gesture that silently switches meaning is exactly the kind of bug that
 * ends with someone pasting a building into the wrong place.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { join, dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { existsSync } from 'node:fs';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..', '..');
const MOD = join(ROOT, 'dist', 'call', 'core', 'src', 'structure', 'PreviewHud.js');

function load() {
    assert.ok(existsSync(MOD), 'build first: npm run build:fast');
    return require(MOD);
}

test('gestures: sneak decides confirm/cancel, plain click sets or rotates', () => {
    const H = load();
    // right click
    assert.equal(H.gestureOf('right', false, false), 'set');
    assert.equal(H.gestureOf('right', false, true), 'rotate');
    assert.equal(H.gestureOf('right', true, false), 'confirm');
    assert.equal(H.gestureOf('right', true, true), 'confirm');
    // left click
    assert.equal(H.gestureOf('left', false, false), 'set');
    assert.equal(H.gestureOf('left', false, true), 'move');
    assert.equal(H.gestureOf('left', true, true), 'cancel');
    assert.equal(H.gestureOf('left', true, false), 'cancel', 'cancel is reported, the caller warns about no preview');
});

test('countdown mode: unknown values fall back to auto', () => {
    const H = load();
    assert.equal(H.countdownMode('always'), 'always');
    assert.equal(H.countdownMode('OFF'), 'off');
    assert.equal(H.countdownMode('none'), 'off');
    assert.equal(H.countdownMode(''), 'auto');
    assert.equal(H.countdownMode(undefined), 'auto');
    assert.equal(H.countdownMode('banana'), 'auto');
});

test('remaining seconds round up and never go negative', () => {
    const H = load();
    assert.equal(H.remainingSeconds(60000), 60);
    assert.equal(H.remainingSeconds(59999), 60);
    assert.equal(H.remainingSeconds(1000), 1);
    assert.equal(H.remainingSeconds(1), 1, 'the last partial second still reads 1');
    assert.equal(H.remainingSeconds(0), 0);
    assert.equal(H.remainingSeconds(-5000), 0);
    assert.equal(H.remainingSeconds(NaN), 0);
});

test('auto mode only shows the bar for the last stretch', () => {
    const H = load();
    assert.equal(H.countdownVisible('auto', 60000), false);
    assert.equal(H.countdownVisible('auto', 21000), false);
    assert.equal(H.countdownVisible('auto', 20000), true);
    assert.equal(H.countdownVisible('auto', 3000), true);
    assert.equal(H.countdownVisible('always', 60000), true);
    assert.equal(H.countdownVisible('off', 3000), false);
    assert.equal(H.countdownVisible('always', 0), false, 'expired is never shown');
});

test('the bar fills with the remaining time and turns red near the end', () => {
    const H = load();
    assert.equal(H.bossBarProgress(30000, 60000), 0.5);
    assert.equal(H.bossBarProgress(60000, 60000), 1);
    assert.equal(H.bossBarProgress(0, 60000), 0);
    assert.equal(H.bossBarProgress(-1000, 60000), 0);
    assert.equal(H.bossBarProgress(60000, 0), 0, 'no divide by zero');

    assert.equal(H.bossBarStyle(60000).color, 1, 'blue while comfortable');
    assert.equal(H.bossBarStyle(10001).color, 1);
    assert.equal(H.bossBarStyle(10000).color, 2, 'red at ten seconds');
    assert.equal(H.bossBarStyle(1000).color, 2);
});

test('countdown text escalates near the end and stays one line', () => {
    const H = load();
    const early = H.countdownText(45000);
    assert.match(early, /45/);
    assert.match(early, /潜行左键=取消/);
    assert.ok(early.split('\n').length === 1, 'single line');

    const red = H.countdownText(9000);
    assert.match(red, /§c/, 'turns red under ten seconds');
    assert.match(red, /9/);

    const warn = H.countdownText(4000);
    assert.match(warn, /即将取消/);

    assert.match(H.countdownText(0), /已结束/);
});

test('the action-bar fallback is short', () => {
    const H = load();
    const text = H.countdownActionBar(30000);
    assert.match(text, /30/);
    assert.match(text, /潜行左键=取消/);
    assert.ok(text.length < 40, 'must not fill the action bar: ' + text);
    assert.match(H.countdownActionBar(5000), /§c/);
});
