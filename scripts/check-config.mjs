#!/usr/bin/env node
/**
 * Validate CALL's configuration files offline.
 *
 * Both files are JSON with comments (JsonConfigFile accepts them), so this strips
 * comments first, then checks that every key listed in assets/check.json exists in
 * assets/configs.default.json - the same invariant app.checkConfig() enforces at startup,
 * which used to abort plugin init when the two drifted apart.
 */
import { readFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');

/** Remove // and block comments outside of strings. */
function stripComments(src) {
    let out = '';
    let i = 0;
    let inString = false;
    while (i < src.length) {
        const c = src[i];
        if (inString) {
            out += c;
            if (c === '\\') {
                out += src[i + 1] ?? '';
                i += 2;
                continue;
            }
            if (c === '"') inString = false;
            i++;
            continue;
        }
        if (c === '"') {
            inString = true;
            out += c;
            i++;
            continue;
        }
        if (c === '/' && src[i + 1] === '*') {
            const end = src.indexOf('*/', i + 2);
            i = end < 0 ? src.length : end + 2;
            continue;
        }
        if (c === '/' && src[i + 1] === '/') {
            const end = src.indexOf('\n', i);
            i = end < 0 ? src.length : end;
            continue;
        }
        out += c;
        i++;
    }
    return out;
}

function loadJsonc(file) {
    return JSON.parse(stripComments(readFileSync(file, 'utf8')));
}

const configsPath = join(ROOT, 'assets', 'configs.default.json');
const checkPath = join(ROOT, 'assets', 'check.json');

const configs = loadJsonc(configsPath);
const check = loadJsonc(checkPath);

const getPath = (obj, dotted) => {
    let cur = obj;
    for (const key of dotted.split('.')) {
        if (cur == null || typeof cur !== 'object') return undefined;
        cur = cur[key];
    }
    return cur;
};

let problems = 0;
const specs = check.configs ?? {};
for (const key of Object.keys(specs)) {
    const value = getPath(configs, key);
    if (value === undefined) {
        console.log('MISSING  ' + key + '  (declared in check.json, absent from configs.json)');
        problems++;
        continue;
    }
    const spec = specs[key];
    if (spec.type && spec.type !== 'enum' && typeof value !== spec.type) {
        console.log('TYPE     ' + key + ': expected ' + spec.type + ', got ' + typeof value);
        problems++;
    }
    if (spec.type === 'enum' && Array.isArray(spec.values) && !spec.values.includes(value)) {
        console.log('ENUM     ' + key + ': "' + value + '" not in [' + spec.values.join(', ') + ']');
        problems++;
    }
    if (spec.type === 'number') {
        if (typeof spec.min === 'number' && value < spec.min) {
            console.log('RANGE    ' + key + ': ' + value + ' < min ' + spec.min);
            problems++;
        }
        if (typeof spec.max === 'number' && value > spec.max) {
            console.log('RANGE    ' + key + ': ' + value + ' > max ' + spec.max);
            problems++;
        }
    }
}

console.log('checked ' + Object.keys(specs).length + ' keys, ' + problems + ' problem(s)');
process.exit(problems === 0 ? 0 : 1);