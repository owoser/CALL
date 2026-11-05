#!/usr/bin/env node
/**
 * CALL build pipeline (replaces the old gulpfile.mjs).
 *
 * Steps:
 *   1. clean dist/
 *   2. compile TypeScript with tsc (tsconfig.build.json) -> dist/call
 *   3. copy assets/ (read-only resources) + seed config/ + create data/ dirs
 *   4. relocate compiled shape plugins into data/shapes
 *   5. emit manifest.json + package.json + index.js
 *   6. generate tooth.json from tooth_template.json
 *   7. pack the lean zip (no node_modules - LSE installs them on first start)
 *   8. unless --no-deps: pack the "full" offline zip with node_modules vendored
 *   9. optional: deploy to a BDS server (build.json -> bdsDir)
 *
 * 3.1 layout: assets/ (read-only) + config/ (user) + data/ (user). The old
 * userdata/{config,data,plugins,temp,build} nesting is gone.
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
const CONFIG_OUT = join(OUT, 'config');
const DATA_OUT = join(OUT, 'data');

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
  const src = join(OUT, 'shapes');
  const dst = join(DATA_OUT, 'shapes');
  await mkdir(dst, { recursive: true });
  if (!(await exists(src))) return;
  for (const ent of await readdir(src, { withFileTypes: true })) {
    if (!ent.isFile()) continue;
    // Source lives at shapes/<pack>.ts (depth 1, so it imports "../core/..."), but it is
    // loaded from data/shapes/<pack>.js (depth 2). Rewrite the requires to match, otherwise
    // every built-in shape pack dies with MODULE_NOT_FOUND at load time.
    if (ent.name.endsWith('.js')) {
      const from = join(src, ent.name);
      const code = await readFile(from, 'utf8');
      await writeFile(join(dst, ent.name), code.split('"../core/').join('"../../core/').split("'../core/").join("'../../core/"), 'utf8');
      await rm(from, { force: true });
      continue;
    }
    await rename(join(src, ent.name), join(dst, ent.name));
  }
  await rm(src, { recursive: true, force: true });
  log('relocated compiled shape plugins -> data/shapes');
}

/**
 * Create the directories the plugin writes into at runtime.
 * Missing ones used to surface as "cannot open file for write" at runtime
 * (e.g. userdata/data/nbt, which broke copy/save/undo outright).
 */
async function ensureRuntimeDirs() {
  const dirs = [
    CONFIG_OUT,
    join(DATA_OUT, 'nbt'),
    join(DATA_OUT, 'shapes'),
    join(DATA_OUT, 'import'),
    join(DATA_OUT, 'export'),
  ];
  for (const d of dirs) await mkdir(d, { recursive: true });
  log('created runtime directories: config/ + data/{nbt,shapes,import,export}');
}

/**
 * config/ is deliberately left EMPTY in the package.
 *
 * If the shipped defaults were written here, an upgrade would find "target already exists"
 * and the player's real configs.json would be pushed aside as *.old. The plugin creates
 * configs.json from assets/configs.default.json on first start instead (see
 * Config.healGlobalConfig), so a legacy file always wins during migration.
 */

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

async function pack(pkg, suffix = '') {
  const entries = (await walk(OUT)).map((e) => ({
    name: PLUGIN_NAME + '/' + relative(OUT, e.sourcePath).split(sep).join('/'),
    sourcePath: e.sourcePath,
  }));
  const zipPath = join(DIST, 'CALL-' + pkg.version + suffix + '.zip');
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

  await copyIfPresent(join(ROOT, 'assets'), join(OUT, 'assets'));
  await ensureRuntimeDirs();
  await relocateShapePlugins();

  await emitManifests(pkg);
  await emitTooth(pkg);

  // Lean package first: node_modules is deliberately NOT shipped - LSE runs
  // `npm install --omit=dev` on the first start (verified on LL 26.51.x).
  if (!has('--no-zip')) await pack(pkg);

  if (!has('--no-deps')) {
    await vendorDependencies();
    if (!has('--no-zip')) await pack(pkg, '-full');
    // keep node_modules in dist/call only when deploying (offline dev server)
    if (!has('--deploy')) {
      await rm(join(OUT, 'node_modules'), { recursive: true, force: true });
    }
  }

  if (has('--deploy')) await deploy(pkg);

  log('done');
}

main().catch((e) => {
  console.error('[build] FAILED:', e && e.stack ? e.stack : e);
  process.exit(1);
});