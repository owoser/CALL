#!/usr/bin/env node
/**
 * CALL build pipeline (replaces the old gulpfile.mjs).
 *
 * Steps:
 *   1. clean dist/
 *   2. compile TypeScript with tsc (tsconfig.build.json) -> dist/call
 *   3. copy config/, data/, bin/
 *   4. relocate compiled shape plugins into userdata/plugins
 *   5. pre-create the runtime directories the plugin expects
 *   6. vendor the production dependency closure into node_modules/
 *   7. emit manifest.json + package.json
 *   8. generate tooth.json from tooth_template.json
 *   9. optional: pack dist/CALL-<version>.zip
 *  10. optional: deploy to a BDS server (build.json -> bdsDir)
 *
 * Usage:
 *   node scripts/build.mjs                # build + zip
 *   node scripts/build.mjs --no-zip
 *   node scripts/build.mjs --deploy       # also copy into <bdsDir>/plugins/call
 *   node scripts/build.mjs --no-deps      # skip node_modules vendoring (fast iteration)
 */
import { execFileSync } from 'node:child_process';
import {
  cp,
  mkdir,
  readFile,
  readdir,
  rename,
  rm,
  stat,
  writeFile,
} from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { dirname, join, relative, resolve, sep } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createZip, walk } from './zip.mjs';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const DIST = join(ROOT, 'dist');
const OUT = join(DIST, 'call');
const USERDATA = join(OUT, 'userdata');

const has = (flag) => process.argv.includes(flag);

const log = (...a) => console.log('[build]', ...a);

async function exists(p) {
  try {
    await stat(p);
    return true;
  } catch {
    return false;
  }
}

async function clean() {
  await rm(DIST, { recursive: true, force: true });
  await mkdir(OUT, { recursive: true });
  log('cleaned dist/');
}

function compile() {
  const tsc = join(ROOT, 'node_modules', 'typescript', 'bin', 'tsc');
  if (!require_exists(tsc)) {
    throw new Error('typescript is not installed. Run: npm ci');
  }
  log('tsc -p tsconfig.build.json');
  execFileSync(process.execPath, [tsc, '-p', 'tsconfig.build.json'], {
    cwd: ROOT,
    stdio: 'inherit',
  });
}

function require_exists(p) {
  return existsSync(p);
}

async function copyIfPresent(from, to) {
  if (!(await exists(from))) {
    log('skip (missing): ' + relative(ROOT, from));
    return;
  }
  await mkdir(dirname(to), { recursive: true });
  await cp(from, to, { recursive: true });
}

/** Move the compiled shape plugins next to the data they load at runtime. */
async function relocateShapePlugins() {
  const src = join(OUT, 'data', 'plugins');
  const dst = join(USERDATA, 'plugins');
  await mkdir(dst, { recursive: true });
  if (await exists(src)) {
    for (const ent of await readdir(src, { withFileTypes: true })) {
      if (!ent.isFile()) continue;
      await rename(join(src, ent.name), join(dst, ent.name));
    }
    await rm(join(OUT, 'data'), { recursive: true, force: true });
    log('relocated compiled shape plugins -> userdata/plugins');
  }
}

/**
 * Create the directories the plugin writes into at runtime.
 * Missing ones used to surface as "cannot open file for write" at runtime
 * (e.g. userdata/data/nbt, which broke copy/save/undo outright).
 */
async function ensureRuntimeDirs() {
  const dirs = [
    'plugins',
    'data/nbt',
    'temp',
    'build',
    'import',
    'export',
  ];
  for (const d of dirs) await mkdir(join(USERDATA, d), { recursive: true });
  log('created runtime directories under userdata/');
}

/**
 * Copy only the production dependency closure from the root node_modules.
 * `npm ls --omit=dev --parseable --all` lists the absolute path of every
 * package that ships, including nested duplicates, so copying those paths
 * reproduces a correct tree without re-resolving from the registry.
 */
async function vendorDependencies() {
  const rootModules = join(ROOT, 'node_modules');
  if (!(await exists(rootModules))) {
    log('WARN node_modules missing; run: npm ci  (plugin will not run without deps)');
    return;
  }
  let listing;
  try {
    listing = execFileSync(
      process.platform === 'win32' ? 'npm.cmd' : 'npm',
      ['ls', '--omit=dev', '--parseable', '--all'],
      { cwd: ROOT, encoding: 'utf8', shell: process.platform === 'win32' }
    );
  } catch (e) {
    log('WARN could not enumerate production deps: ' + e.message);
    return;
  }
  const wanted = listing
    .split(/\r?\n/)
    .map((s) => s.trim())
    .filter((s) => s && s !== ROOT)
    .filter((s) => s.split(sep).includes('node_modules'))
    .map((s) => relative(rootModules, s))
    .filter((s) => !s.startsWith('..'));

  let n = 0;
  for (const rel of wanted) {
    const from = join(rootModules, rel);
    if (!(await exists(from))) continue;
    await cp(from, join(OUT, 'node_modules', rel), { recursive: true });
    n++;
  }
  log('vendored ' + n + ' production packages into node_modules/');
}

async function readJson(p, fallback = null) {
  try {
    return JSON.parse(await readFile(p, 'utf8'));
  } catch {
    return fallback;
  }
}

async function emitManifests(pkg) {
  const manifest = {
    // MUST equal the plugin directory name, or LeviLamina 3 rejects the manifest.
    name: PLUGIN_NAME,
    entry: 'index.js',
    type: 'lse-nodejs',
    version: pkg.version,
    author: pkg.author,
    description: pkg.description,
    dependencies: [{ name: 'legacy-script-engine-nodejs' }],
  };
  await writeFile(join(OUT, 'manifest.json'), JSON.stringify(manifest, null, 2) + '\n', 'utf8');
  await writeFile(
    join(OUT, 'package.json'),
    JSON.stringify(
      {
        name: pkg.name,
        version: pkg.version,
        description: pkg.description,
        main: 'index.js',
        author: pkg.author,
        license: pkg.license,
        dependencies: pkg.dependencies,
      },
      null,
      2
    ) + '\n',
    'utf8'
  );
  await writeFile(
    join(OUT, 'index.js'),
    '// GENERATED by scripts/build.mjs\n' +
      '// LegacyScriptEngine nodejs entry point (manifest.json -> "entry").\n' +
      'require("./core");\n',
    'utf8'
  );
  log('emitted manifest.json / package.json / index.js');
  return manifest;
}

async function emitTooth(pkg) {
  const template = await readJson(join(ROOT, 'tooth_template.json'));
  if (!template) {
    log('WARN tooth_template.json missing; skipped tooth.json');
    return;
  }
  const json = JSON.stringify(template, null, 4).replace(/\{\{VERSION\}\}/g, pkg.version);
  await writeFile(join(ROOT, 'tooth.json'), json + '\n', 'utf8');
  log('generated tooth.json (' + pkg.version + ')');
}

/**
 * LeviLamina 3 refuses to load a plugin whose manifest.json `name` differs from its
 * directory name (case-sensitively), so the archive folder and the deploy target are
 * both derived from the manifest name instead of being hardcoded.
 */
const PLUGIN_NAME = 'CALL';

async function pack(pkg) {
  const entries = (await walk(OUT)).map((e) => ({
    name: PLUGIN_NAME + '/' + relative(OUT, e.sourcePath).split(sep).join('/'),
    sourcePath: e.sourcePath,
  }));
  const zipPath = join(DIST, 'CALL-' + pkg.version + '.zip');
  const res = await createZip(zipPath, entries);
  const mb = (res.bytes / 1048576).toFixed(2);
  log('packed ' + relative(ROOT, zipPath) + ' (' + res.files + ' files, ' + mb + ' MB)');
}

async function deploy(pkg) {
  const cfg = (await readJson(join(ROOT, 'build.json'))) || {};
  const bdsDir = cfg.bdsDir;
  if (!bdsDir) {
    log('deploy skipped: set "bdsDir" in build.json');
    return;
  }
  const target = join(resolve(bdsDir), 'plugins', cfg.pluginDir || PLUGIN_NAME);
  await rm(target, { recursive: true, force: true });
  await cp(OUT, target, { recursive: true });
  log('deployed to ' + target);
}

async function main() {
  const pkg = await readJson(join(ROOT, 'package.json'));
  if (!pkg) throw new Error('package.json not found');
  log('building CALL ' + pkg.version);

  await clean();
  compile();

  await copyIfPresent(join(ROOT, 'config'), join(OUT, 'config'));
  // Pristine copy of the defaults in the READ-ONLY folder: the plugin restores from it when
  // the user's configs.json is missing or empty (LSE would create an empty file instead).
  await copyIfPresent(join(ROOT, 'data', 'config'), join(USERDATA, 'config'));
  await copyIfPresent(join(ROOT, 'data', 'config', 'configs.json'), join(OUT, 'config', 'configs.default.json'));
  await copyIfPresent(join(ROOT, 'data', 'data'), join(USERDATA, 'data'));
  await copyIfPresent(join(ROOT, 'data', 'version'), join(USERDATA, 'version'));
  await copyIfPresent(join(ROOT, 'bin'), join(OUT, 'bin'));

  await relocateShapePlugins();
  await ensureRuntimeDirs();
  if (!has('--no-deps')) await vendorDependencies();

  await emitManifests(pkg);
  await emitTooth(pkg);
  if (!has('--no-zip')) await pack(pkg);
  if (has('--deploy')) await deploy(pkg);

  log('done');
}

main().catch((e) => {
  console.error('[build] FAILED:', e && e.stack ? e.stack : e);
  process.exit(1);
});
