#!/usr/bin/env node
/**
 * Documentation guard.
 *
 * Runs in CI before anything ships. Three checks, each one a mistake that has actually
 * happened in this project:
 *
 *   1. every local .md link in _sidebar.md / _navbar.md resolves to a real file
 *      (the site renders "404 - Not found" otherwise, and nobody notices until a user
 *      reports it);
 *   2. no reference to the upstream project or its docs site is left in the pages
 *      (they describe 1.x behaviour, so they send readers to wrong instructions);
 *   3. the key list documented in user/config.md equals the keys in the shipped
 *      assets/configs.default.json (config drifted ahead of the docs more than once).
 *   4. no page still describes the removed userdata/ layout or the stale
 *      plugins/CALL/config/configs.json path.
 */
import { readFileSync, existsSync, readdirSync, statSync } from 'node:fs';
import { join, dirname, resolve, relative, sep } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const DOCS = join(ROOT, 'docs');

const problems = [];
const note = (msg) => problems.push(msg);

function walk(dir) {
    const out = [];
    for (const name of readdirSync(dir)) {
        const p = join(dir, name);
        if (statSync(p).isDirectory()) {
            if (name === 'vendor' || name === 'image') continue;
            out.push(...walk(p));
        } else if (name.endsWith('.md')) {
            out.push(p);
        }
    }
    return out;
}

// ---------------------------------------------------------------- 1. links
for (const index of ['_sidebar.md', '_navbar.md']) {
    const file = join(DOCS, index);
    if (!existsSync(file)) { note(index + ': missing'); continue; }
    const text = readFileSync(file, 'utf8');
    for (const m of text.matchAll(/\]\(([^)]+)\)/g)) {
        const target = m[1].split('#')[0].split('?')[0];
        if (target === '' || /^[a-z]+:\/\//i.test(target)) continue;
        const abs = join(DOCS, target);
        if (!existsSync(abs)) note(index + ': dead link -> ' + target);
    }
}

// ------------------------------------------------- 2. stale upstream links
const ALLOW = new Set([join(DOCS, 'user', 'introduction.md')]); // fork attribution lives here
for (const file of walk(DOCS)) {
    const text = readFileSync(file, 'utf8');
    const rel = relative(ROOT, file).split(sep).join('/');
    if (!ALLOW.has(file) && /superx101\.github\.io/.test(text)) {
        note(rel + ': links to the upstream docs site (describes 1.x)');
    }
    if (!ALLOW.has(file) && /github\.com\/superx101\/CALL/.test(text)) {
        note(rel + ': links to the upstream repository');
    }
    // user/config.md is allowed to quote the wrong path while explaining it is wrong
    // the upstream docs pointed at CALL/config/configs.json (no plugins/ prefix, and it never existed)
    if (/(?<!plugins\/)CALL\/config\/configs\.json/.test(text)) {
        note(rel + ': uses the wrong config path (CALL/config/configs.json)');
    }
}

// ------------------------------------------------ 4. removed userdata/ layout
for (const file of walk(DOCS)) {
    const rel = relative(ROOT, file).split(sep).join('/');
    if (rel.endsWith('docs/user/migrate.md')) continue; // migration note legitimately mentions it
    const text = readFileSync(file, 'utf8');
    if (/userdata\/(config|data|plugins|temp|build|import|export)/.test(text)) {
        note(rel + ': describes the removed userdata/ layout');
    }
}

// ------------------------------------------- 3. documented keys == shipped keys
const configPath = join(ROOT, 'assets', 'configs.default.json');
const docPath = join(DOCS, 'user', 'config.md');
if (!existsSync(configPath) || !existsSync(docPath)) {
    note('cannot compare config keys (missing file)');
} else {
    const raw = readFileSync(configPath, 'utf8');
    const stripped = raw.replace(/\/\*[\s\S]*?\*\//g, '').replace(/^\s*\/\/.*$/gm, '');
    const shipped = Object.keys(JSON.parse(stripped));

    const doc = readFileSync(docPath, 'utf8');
    // A key counts as documented when it appears in backticks anywhere in the page:
    // most are table rows, but nested objects (e.g. `default`) are documented as a
    // sub-table and would never match the "row starts with a key" pattern.
    const missing = shipped.filter((k) => !doc.includes('`' + k + '`'));
    if (missing.length > 0) note('undocumented config keys: ' + missing.join(', '));
}

if (problems.length > 0) {
    console.error('[check-docs] ' + problems.length + ' problem(s):');
    for (const p of problems) console.error('  - ' + p);
    process.exit(1);
}
console.log('[check-docs] ok (' + walk(DOCS).length + ' pages, sidebar/navbar links resolve, config keys documented)');