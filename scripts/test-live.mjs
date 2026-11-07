#!/usr/bin/env node
/**
 * One-command live verification for CALL.
 *
 *   node scripts/test-live.mjs [serverDir] [--minutes N] [--keep]
 *
 * What it does:
 *   1. builds CALL and deploys it to <serverDir>/plugins/CALL (or build.json bdsDir)
 *   2. installs tests/live/ as <serverDir>/plugins/CALLTEST
 *   3. boots the server headlessly, captures the console
 *   4. waits for "[CALLTEST] ALL DONE", sends "stop", prints a PASS/FAIL summary
 *   5. exits non-zero when any assertion failed
 *
 * The harness plugin is dev-only and is never part of the release archive.
 */
import { execFileSync, spawn } from 'node:child_process';
import { cp, mkdir, readFile, rm, writeFile, readdir } from 'node:fs/promises';
import { existsSync, createWriteStream, statSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');

function arg(flag, fallback) {
  const i = process.argv.indexOf(flag);
  return i >= 0 ? process.argv[i + 1] : fallback;
}
const keep = process.argv.includes('--keep');
const minutes = Number(arg('--minutes', '4'));

async function readJson(p, fallback = null) {
  try {
    return JSON.parse(await readFile(p, 'utf8'));
  } catch {
    return fallback;
  }
}

async function resolveServerDir() {
  const positional = process.argv[2] && !process.argv[2].startsWith('--') ? process.argv[2] : null;
  if (positional) return resolve(positional);
  const cfg = await readJson(join(ROOT, 'build.json'), {});
  if (cfg && cfg.bdsDir) return resolve(cfg.bdsDir);
  throw new Error('no server directory: pass one as argv[2] or set build.json -> bdsDir');
}

function runBuild() {
  console.log('[test-live] building + deploying CALL');
  execFileSync(process.execPath, [join(ROOT, 'scripts', 'build.mjs'), '--no-zip', '--deploy'], {
    cwd: ROOT,
    stdio: 'inherit',
  });
}

/**
 * Mirror dist/call into the server we are about to boot.
 *
 * build.mjs only deploys to build.json's bdsDir, so testing another server used to run
 * whatever happened to be installed there - which silently tested stale code.
 */
async function deployTo(serverDir) {
  const dist = join(ROOT, 'dist', 'call');
  const target = join(serverDir, 'plugins', 'CALL');
  if (!existsSync(join(target, 'manifest.json'))) {
    console.log('[test-live] ' + target + ' does not look like CALL, skipping the copy');
    return;
  }
  const stash = join(serverDir, '.calltest-stash');
  await rm(stash, { recursive: true, force: true });
  for (const keep of ['config', 'data']) {
    if (existsSync(join(target, keep))) {
      await cp(join(target, keep), join(stash, keep), { recursive: true });
    }
  }
  await rm(target, { recursive: true, force: true });
  await cp(dist, target, { recursive: true });
  for (const keep of ['config', 'data']) {
    if (existsSync(join(stash, keep))) {
      await cp(join(stash, keep), join(target, keep), { recursive: true });
    }
  }
  await rm(stash, { recursive: true, force: true });
  console.log('[test-live] copied dist/call -> ' + target);
}

async function installHarness(serverDir) {
  const src = join(ROOT, 'tests', 'live');
  const dst = join(serverDir, 'plugins', 'CALLTEST');
  await rm(dst, { recursive: true, force: true });
  await mkdir(dst, { recursive: true });
  for (const name of await readdir(src)) {
    await cp(join(src, name), join(dst, name), { recursive: true });
  }
  // The harness requires CALL by relative path; make sure the folder name matches.
  const callDir = join(serverDir, 'plugins', 'CALL');
  if (!existsSync(callDir)) throw new Error('CALL was not deployed to ' + callDir);
  console.log('[test-live] harness installed at ' + dst);
}

function killStale() {
  try {
    execFileSync('taskkill', ['/IM', 'bedrock_server_mod.exe', '/F'], { stdio: 'ignore' });
  } catch {
    // nothing running
  }
}

function startServer(serverDir) {
  const logPath = join(serverDir, '.test-out.log');
  const out = createWriteStream(logPath, { flags: 'w' });
  const child = spawn(join(serverDir, 'bedrock_server_mod.exe'), [], {
    cwd: serverDir,
    stdio: ['pipe', 'pipe', 'pipe'],
    windowsHide: true,
  });
  child.stdout.setEncoding('utf8');
  child.stderr.setEncoding('utf8');
  child.stdout.on('data', (c) => out.write(c));
  child.stderr.on('data', (c) => out.write(c));
  return { child, logPath, out };
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function waitForDone(logPath, limitMs) {
  const deadline = Date.now() + limitMs;
  while (Date.now() < deadline) {
    await sleep(1500);
    let text = '';
    try {
      text = await readFile(logPath, 'utf8');
    } catch {
      continue;
    }
    if (text.includes('[CALLTEST] ALL DONE')) return text;
    if (text.includes('加载插件代码失败')) return text;
  }
  try {
    return await readFile(logPath, 'utf8');
  } catch {
    return '';
  }
}

function stripAnsi(s) {
  return s.replace(/\u001b\[[0-9;]*m/g, '');
}

async function main() {
  const serverDir = await resolveServerDir();
  if (!existsSync(join(serverDir, 'bedrock_server_mod.exe'))) {
    throw new Error('not a LeviLamina server directory: ' + serverDir);
  }

  runBuild();
  await deployTo(serverDir);
  await installHarness(serverDir);
  killStale();
  await sleep(1500);

  console.log('[test-live] starting server');
  const { child, logPath, out } = startServer(serverDir);

  const limit = minutes * 60_000;
  const raw = await waitForDone(logPath, limit);

  try {
    child.stdin.write('stop\n');
  } catch {
    /* ignore */
  }
  await sleep(8000);
  if (child.exitCode == null) {
    console.log('[test-live] server did not stop in time, killing');
    child.kill();
    killStale();
  }
  out.end();

  const text = stripAnsi(raw);
  const lines = text.split(/\r?\n/).filter((l) => l.includes('[CALLTEST]'));
  const passes = lines.filter((l) => l.includes('] PASS '));
  const fails = lines.filter((l) => l.includes('] FAIL '));
  const done = lines.some((l) => l.includes('ALL DONE'));

  console.log('');
  console.log('================ CALL live integration ================');
  for (const l of lines) console.log(l.slice(l.indexOf('[CALLTEST]')));
  console.log('-------------------------------------------------------');
  console.log('pass: ' + passes.length + '   fail: ' + fails.length + '   completed: ' + done);
  console.log('console log: ' + logPath);

  if (!keep) {
    await rm(join(serverDir, 'plugins', 'CALLTEST'), { recursive: true, force: true });
  }

  if (!done || fails.length > 0) {
    console.log('RESULT: FAILED');
    process.exit(1);
  }
  console.log('RESULT: OK');
}

main().catch((e) => {
  console.error('[test-live] ' + (e && e.stack ? e.stack : e));
  process.exit(2);
});
