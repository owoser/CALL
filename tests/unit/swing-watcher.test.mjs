/**
 * SwingWatcher: turning a swing counter into "clicked air".
 *
 * The 100ms window is the whole point: a left click that hits a block also bumps the counter,
 * and the block event arrives in the same tick, so a swing must not fire until the window
 * closes without one.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { join, dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { existsSync } from 'node:fs';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..', '..');
const MOD = join(ROOT, 'dist', 'call', 'core', 'src', 'user', 'SwingWatcher.js');

function load() {
    assert.ok(existsSync(MOD), 'build first: npm run build:fast');
    return require(MOD).default;
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
function fakePlayer(xuid = 'x1', name = 'Alice') {
    return { xuid, $: { realName: name } };
}

/** A player whose held item the watcher can read (getHand is what app.ts uses). */
function makePlayerWithHand(type, xuid = 'x2', name = 'Bob') {
    const p = {
        xuid,
        hand: type,
        $: {
            realName: name,
            getHand() { return { type: p.hand }; },
        },
    };
    return p;
}

test('the first poll only establishes a baseline', async () => {
    const W = load();
    W.reset();
    let n = 7;
    W.setCounterSource(() => n);
    let fired = 0;
    const p = fakePlayer();
    W.poll(p, () => fired++);
    await sleep(160);
    assert.equal(fired, 0, 'history must not count as a click');
    W.setCounterSource(null);
});

test('a swing with no block click fires after the window', async () => {
    const W = load();
    W.reset();
    let n = 0;
    W.setCounterSource(() => n);
    let fired = 0;
    const p = fakePlayer();
    W.track(p);            // baseline 0
    n = 1;                 // one swing
    W.poll(p, () => fired++);
    await sleep(W.DEDUPE_MS + 80);
    assert.equal(fired, 1);
    // polling again without a new swing must not fire twice
    W.poll(p, () => fired++);
    await sleep(W.DEDUPE_MS + 60);
    assert.equal(fired, 1);
    W.setCounterSource(null);
});

test('a block click inside the window cancels the air click', async () => {
    const W = load();
    W.reset();
    let n = 0;
    W.setCounterSource(() => n);
    let fired = 0;
    const p = fakePlayer();
    W.track(p);
    n = 1;
    W.poll(p, () => fired++);
    W.noteBlockLeft(p);    // the block event landed
    await sleep(W.DEDUPE_MS + 80);
    assert.equal(fired, 0, 'the block click owns this swing');
    W.setCounterSource(null);
});

test('several swings in one window are all delivered (no lost clicks)', async () => {
    const W = load();
    W.reset();
    let n = 0;
    W.setCounterSource(() => n);
    let fired = 0;
    const p = fakePlayer();
    W.track(p);
    n = 1;
    W.poll(p, () => fired++);
    n = 3;                 // two more swings before the first decision
    W.poll(p, () => fired++);
    await sleep(W.DEDUPE_MS + 200);
    assert.equal(fired, 3, 'every click must reach the tool');
    W.setCounterSource(null);
});

test('a block click that arrives BEFORE the poll does not become an air click', async () => {
    const W = load();
    W.reset();
    W.setPollInterval(200);
    let n = 0;
    W.setCounterSource(() => n);
    let fired = 0;
    const p = fakePlayer();
    W.track(p);
    // the real order: the client sends swing + block interaction together, so the block
    // event lands first and the counter is read up to pollInterval later
    n = 1;
    W.noteBlockLeft(p);
    W.poll(p, () => fired++);
    await sleep(W.DEDUPE_MS + 120);
    assert.equal(fired, 0, 'this is the bug that put the selection at the player feet');
    W.setCounterSource(null);
});

test('two swings in one poll window fire twice', async () => {
    const W = load();
    W.reset();
    W.setPollInterval(200);
    let n = 0;
    W.setCounterSource(() => n);
    let fired = 0;
    const p = fakePlayer();
    W.track(p);
    n = 2;
    W.poll(p, () => fired++);
    await sleep(W.DEDUPE_MS + 200);
    assert.equal(fired, 2, 'both clicks must reach the tool');
    W.setCounterSource(null);
});

test('a counter reset does not fire', async () => {
    const W = load();
    W.reset();
    let n = 10;
    W.setCounterSource(() => n);
    let fired = 0;
    const p = fakePlayer();
    W.track(p);
    n = 0;                 // swingReset()
    W.poll(p, () => fired++);
    await sleep(W.DEDUPE_MS + 60);
    assert.equal(fired, 0);
    W.setCounterSource(null);
});

test('forget() drops the baseline so the next poll re-baselines', async () => {
    const W = load();
    W.reset();
    let n = 0;
    W.setCounterSource(() => n);
    let fired = 0;
    const p = fakePlayer();
    W.track(p);
    W.forget(p.xuid);
    n = 5;
    W.poll(p, () => fired++);
    await sleep(W.DEDUPE_MS + 60);
    assert.equal(fired, 0);
    W.setCounterSource(null);
});

test('a right click that already ran swallows the swing', async () => {
    const W = load();
    W.reset();
    let n = 0;
    W.setCounterSource(() => n);
    let fired = 0;
    const p = makePlayerWithHand('call:wand_preview');
    W.track(p);
    n = 1;                        // the arm swing that comes with a right click
    W.noteHandled(p);             // ...which the use handler already dealt with
    W.poll(p, () => fired++);
    await sleep(W.DEDUPE_MS + 80);
    assert.equal(fired, 0, 'a handled right click must not fire a left click');
    assert.ok(W.statsOf().swallowedHandled >= 1);
    W.setCounterSource(null);
});

test('switching the held item drops the pending swing', async () => {
    const W = load();
    W.reset();
    let n = 0;
    W.setCounterSource(() => n);
    let fired = 0;
    const p = makePlayerWithHand('call:wand_copy');
    W.track(p);
    W.poll(p, () => fired++);      // establishes the hand baseline
    p.hand = 'call:wand_preview';  // hotbar switch, no click
    n = 1;                         // a swing that belonged to the previous item
    W.poll(p, () => fired++);
    await sleep(W.DEDUPE_MS + 80);
    assert.equal(fired, 0, 'a swing collected across a hand change must not fire');
    assert.ok(W.statsOf().swallowedHand >= 1);
    W.setCounterSource(null);
});

test('a real swing on the same item still fires', async () => {
    const W = load();
    W.reset();
    let n = 0;
    W.setCounterSource(() => n);
    let fired = 0;
    const p = makePlayerWithHand('call:wand_select');
    W.track(p);
    W.poll(p, () => fired++);
    await sleep(5);
    n = 1;
    W.poll(p, () => fired++);
    await sleep(W.DEDUPE_MS + 80);
    assert.equal(fired, 1);
    W.setCounterSource(null);
});
