#!/usr/bin/env node
/**
 * Dev-only helper: run a Bedrock Dedicated Server copy with LeviLamina, capture its
 * console, and forward commands from a small file-based inbox.
 *
 *   node scripts/dev-run-server.mjs [serverDir] [--minutes 5]
 *
 * Without serverDir it uses build.json -> bdsDir, i.e. the same single dev server that
 * `npm run deploy` and `npm run test:live` use.
 *
 * Console input: append one command per line to <serverDir>/.console-in and this
 * process forwards it to BDS' stdin (e.g. "help", "ll list", "stop").
 * Everything BDS prints goes to <serverDir>/.server-out.log and to stdout.
 *
 * Not shipped with the plugin; it exists so maintenance work can be verified against
 * a real server without touching a production world.
 */
import { spawn } from 'node:child_process';
import { createWriteStream, existsSync, readFileSync, writeFileSync, appendFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');

/** build.json -> bdsDir, so every dev entry point talks to the same server. */
function configuredServerDir() {
    try {
        const cfg = JSON.parse(readFileSync(join(ROOT, 'build.json'), 'utf8'));
        if (cfg != null && typeof cfg.bdsDir === 'string' && cfg.bdsDir !== '') {
            return resolve(ROOT, cfg.bdsDir);
        }
    } catch {
        /* no build.json */
    }
    return null;
}

const argDir = process.argv.slice(2).find((a) => !a.startsWith('--') && !/^\d+$/.test(a));
const serverDir = resolve(argDir ?? configuredServerDir() ?? '.');
const argMinutes = (() => {
    const i = process.argv.indexOf('--minutes');
    return i >= 0 ? Number(process.argv[i + 1]) : 5;
})();

if (!existsSync(join(serverDir, 'bedrock_server_mod.exe'))) {
    console.error('[dev-run] not a BDS directory: ' + serverDir);
    process.exit(2);
}

const inbox = join(serverDir, '.console-in');
const outLog = join(serverDir, '.server-out.log');
writeFileSync(inbox, '', 'utf8');
writeFileSync(outLog, '', 'utf8');
const out = createWriteStream(outLog, { flags: 'a' });

const child = spawn(join(serverDir, 'bedrock_server_mod.exe'), [], {
    cwd: serverDir,
    stdio: ['pipe', 'pipe', 'pipe'],
    windowsHide: true,
});

const relay = (stream, label) => {
    stream.setEncoding('utf8');
    stream.on('data', (chunk) => {
        out.write(chunk);
        process.stdout.write(chunk);
    });
};
relay(child.stdout, 'stdout');
relay(child.stderr, 'stderr');

// Poll the inbox and forward new lines to BDS' stdin.
let bytes = 0;
const pump = setInterval(() => {
    let content = '';
    try {
        content = readFileSync(inbox, 'utf8');
    } catch {
        return;
    }
    if (content.length <= bytes) return;
    const fresh = content.slice(bytes);
    bytes = content.length;
    for (const line of fresh.split(/\r?\n/)) {
        if (!line.trim()) continue;
        process.stdout.write('> ' + line + '\n');
        out.write('> ' + line + '\n');
        try {
            child.stdin.write(line + '\n');
        } catch (e) {
            console.error('[dev-run] stdin write failed: ' + e.message);
        }
    }
}, 500);

const log = (m) => {
    console.log('[dev-run] ' + m);
    try {
        appendFileSync(outLog, '[dev-run] ' + m + '\n');
    } catch {
        /* ignore */
    }
};

const deadline = Date.now() + Math.max(1, argMinutes) * 60_000;

child.on('exit', (code, signal) => {
    log('server exited (code=' + code + ' signal=' + signal + ')');
    clearInterval(pump);
    out.end();
    process.exit(code ?? 0);
});

// Graceful shutdown: send "stop" to the console a little before the deadline.
const stopper = setInterval(() => {
    if (Date.now() >= deadline && !child.killed) {
        log('time budget reached, sending stop');
        try {
            child.stdin.write('stop\n');
        } catch {
            /* ignore */
        }
        clearInterval(stopper);
        setTimeout(() => {
            log('still running, killing');
            child.kill();
        }, 60_000);
    }
}, 1000);

log('started in ' + serverDir + ' (deadline ' + argMinutes + ' min)');
