#!/usr/bin/env node
/**
 * Vendor the official LegacyScriptEngine TypeScript declarations into types/lse.
 *
 * The upstream package "@levimc-lse/types" is NOT published to npm, so we pin a
 * commit of LiteLDev/legacy-script-engine-api and vendor platforms/javascript/src.
 *
 * Usage:
 *   node scripts/fetch-types.mjs                 # use the pinned commit below
 *   node scripts/fetch-types.mjs --sha <commit>  # use another commit
 */
import { mkdir, writeFile, rm } from 'node:fs/promises';
import { dirname, resolve, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const REPO = 'LiteLDev/legacy-script-engine-api';
const BRANCH = 'develop';
/** Pinned commit. Bump deliberately; the generated files are committed. */
const PINNED_SHA = '4a6ea7b1c804f2fb4d12346f5b89bf0df388c352';
const SRC_PREFIX = 'platforms/javascript/src/';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const outDir = join(root, 'types', 'lse');

function arg(name) {
  const i = process.argv.indexOf(name);
  return i >= 0 ? process.argv[i + 1] : undefined;
}

async function getJson(url) {
  const res = await fetch(url, {
    headers: { 'user-agent': 'call-plugin-build', accept: 'application/vnd.github+json' },
  });
  if (!res.ok) throw new Error(`GET ${url} -> ${res.status} ${res.statusText}`);
  return res.json();
}

async function getText(url) {
  const res = await fetch(url, { headers: { 'user-agent': 'call-plugin-build' } });
  if (!res.ok) throw new Error(`GET ${url} -> ${res.status} ${res.statusText}`);
  return res.text();
}

async function main() {
  const sha = arg('--sha') ?? PINNED_SHA;
  const tree = await getJson(
    `https://api.github.com/repos/${REPO}/git/trees/${sha}?recursive=1`
  );
  const blobs = (tree.tree ?? []).filter(
    (n) => n.type === 'blob' && n.path.startsWith(SRC_PREFIX) && n.path.endsWith('.d.ts')
  );
  if (blobs.length === 0) throw new Error('no .d.ts found under ' + SRC_PREFIX);

  await rm(outDir, { recursive: true, force: true });
  await mkdir(outDir, { recursive: true });

  let done = 0;
  const queue = [...blobs];
  const workers = Array.from({ length: 8 }, async () => {
    for (;;) {
      const node = queue.shift();
      if (!node) return;
      const rel = node.path.slice(SRC_PREFIX.length);
      const dest = join(outDir, rel);
      const url = `https://raw.githubusercontent.com/${REPO}/${sha}/${node.path}`;
      const text = await getText(url);
      await mkdir(dirname(dest), { recursive: true });
      await writeFile(dest, text, 'utf8');
      done++;
    }
  });
  await Promise.all(workers);

  await writeFile(
    join(outDir, 'VERSION.txt'),
    [
      `repo:   https://github.com/${REPO}`,
      `commit: ${sha}`,
      `branch: ${BRANCH}`,
      `files:  ${done}`,
      `date:   ${new Date().toISOString()}`,
      '',
      'These declarations are vendored copies of platforms/javascript/src from',
      'LiteLDev/legacy-script-engine-api (LGPL-3.0-or-later).',
      'Regenerate with: node scripts/fetch-types.mjs',
    ].join('\n') + '\n',
    'utf8'
  );

  console.log(`vendored ${done} declaration files -> types/lse (commit ${sha.slice(0, 12)})`);
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
