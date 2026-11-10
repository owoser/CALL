#!/usr/bin/env node
/**
 * Version consistency guard.
 *
 * There is exactly one release truth, and it lives in three places:
 *
 *   package.json   the version npm/build uses
 *   tooth.json     the version the lip package advertises
 *   CHANGELOG.md   the newest "## [x.y.z]" section
 *
 * A release also implies a git tag vX.Y.Z. This check is READ-ONLY: it never rewrites a
 * file, never tags and never publishes. It fails (exit 1) when the three sources disagree,
 * and merely warns when the version is not tagged yet - an un-released version in the tree
 * is normal during development, it is just not allowed to look released.
 *
 * Guardrail behind docs/dev/release.md: no version bump, tag or release without an explicit
 * maintainer instruction, and one version is published exactly once.
 */
import { readFileSync } from 'node:fs';
import { execFileSync } from 'node:child_process';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const problems = [];
const warnings = [];
const notes = [];

const readJson = (name) => JSON.parse(readFileSync(join(ROOT, name), 'utf8'));

const pkg = readJson('package.json');
const tooth = readJson('tooth.json');
const changelog = readFileSync(join(ROOT, 'CHANGELOG.md'), 'utf8');

const version = String(pkg.version || '').trim();
if (!version) problems.push('package.json: "version" is missing');
else notes.push('package.json version = ' + version);

if (String(tooth.version || '').trim() !== version) {
    problems.push('tooth.json version (' + tooth.version + ') != package.json version (' + version + ')');
} else {
    notes.push('tooth.json version    = ' + tooth.version);
}

const headings = [...changelog.matchAll(/^## \[([^\]]+)\]/gm)].map((m) => m[1]);
if (headings.length === 0) {
    problems.push('CHANGELOG.md: no "## [x.y.z]" section found');
} else {
    if (!headings.includes(version)) {
        problems.push('CHANGELOG.md: no section for ' + version + ' (newest is ' + headings[0] + ')');
    }
    if (headings[0] !== version) {
        problems.push('CHANGELOG.md: newest section is ' + headings[0] + ' but package.json says ' + version);
    }
    if (headings.includes(version)) notes.push('CHANGELOG.md section   = [' + version + ']');
}

// ---- git tags (warn-only: an untagged version is simply "not released yet")
const parse = (v) => String(v).replace(/^v/, '').split(/[.+-]/).map((x) => parseInt(x, 10)).filter((n) => !isNaN(n));
const cmp = (a, b) => {
    const pa = parse(a), pb = parse(b);
    const len = Math.max(pa.length, pb.length);
    for (let i = 0; i < len; i++) {
        const l = pa[i] ?? 0, r = pb[i] ?? 0;
        if (l !== r) return l < r ? -1 : 1;
    }
    return 0;
};
const tagOf = (v) => 'v' + v;

let tags = [];
try {
    tags = execFileSync('git', ['tag', '--list', 'v*'], { cwd: ROOT, encoding: 'utf8' })
        .split(/\r?\n/).map((s) => s.trim()).filter(Boolean);
} catch {
    warnings.push('git not available - tag check skipped');
}

if (tags.length) {
    const released = tags.includes(tagOf(version));
    const newestTag = tags.slice().sort(cmp).pop();
    if (released) {
        notes.push('git tag               = ' + tagOf(version) + ' (released)');
    } else {
        warnings.push('v' + version + ' is not tagged - this tree is an UNRELEASED version');
        if (newestTag && cmp(newestTag, tagOf(version)) > 0) {
            warnings.push('newest tag ' + newestTag + ' is higher than ' + tagOf(version) + ' - version went backwards?');
        }
    }
}

const mark = { ok: '  ok  ', warn: ' warn ', bad: ' FAIL ' };
console.log('version check - ' + ROOT);
for (const n of notes) console.log(mark.ok + n);
for (const w of warnings) console.log(mark.warn + w);
for (const p of problems) console.log(mark.bad + p);

if (problems.length) {
    console.log('\n' + problems.length + ' problem(s). Fix the three sources above; do not publish a version that disagrees.');
    process.exit(1);
}
console.log('\nVersion sources agree' + (warnings.length ? ' (with ' + warnings.length + ' warning(s))' : '') + '.');
