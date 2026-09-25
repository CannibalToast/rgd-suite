'use strict';
/**
 * Unit tests for key-level RGD table diff (no git required for core map logic).
 */
const assert = require('assert');
const fs = require('fs');
const os = require('os');
const path = require('path');

const ROOT = path.join(__dirname, '..');
const DIST = path.join(ROOT, 'bundled', 'rgd-tools', 'dist');
const { createAndLoadDictionaries } = require(path.join(DIST, 'dictionary'));
const { createTable, createEntry, writeRgdFile } = require(path.join(DIST, 'writer'));
const { RgdDataType } = require(path.join(DIST, 'types'));

// esbuild bundles extension; for unit tests load compiled logic via ts transpile isn't available.
// Re-implement pure helpers here that mirror tableDiff.ts so we exercise the same algorithms
// the extension will use. Also smoke-test parse+flatten by writing two files and comparing via
// dynamic require of the built out if present — primary coverage is algorithm correctness.

function flattenLike(table, prefix, result) {
    const out = result || new Map();
    for (const entry of table.entries) {
        const k = entry.name || ('#' + entry.hash.toString(16).padStart(8, '0'));
        const full = prefix ? prefix + '.' + k : k;
        if (entry.type === RgdDataType.Table || entry.type === RgdDataType.TableInt) {
            if (entry.value) flattenLike(entry.value, full, out);
        } else if (entry.type === RgdDataType.Float) {
            out.set(full, { type: 'float', value: entry.value });
        } else if (entry.type === RgdDataType.Integer) {
            out.set(full, { type: 'int', value: entry.value });
        } else if (entry.type === RgdDataType.Bool) {
            out.set(full, { type: 'bool', value: entry.value });
        } else if (entry.type === RgdDataType.String || entry.type === RgdDataType.WString) {
            if (k === '$REF') continue;
            out.set(full, { type: 'string', value: entry.value });
        }
    }
    return out;
}

function valuesEqual(a, b) {
    const numeric = (t) => t === 'float' || t === 'int';
    if (numeric(a.type) && numeric(b.type)) {
        return Math.abs(a.value - b.value) <= 1e-4;
    }
    if (a.type !== b.type) return false;
    return a.value === b.value;
}

function diffStringParts(oldStr, newStr) {
    const min = Math.min(oldStr.length, newStr.length);
    let p = 0;
    while (p < min && oldStr[p] === newStr[p]) p++;
    let s = 0;
    while (s < min - p && oldStr[oldStr.length - 1 - s] === newStr[newStr.length - 1 - s]) s++;
    return {
        prefix: oldStr.slice(0, p),
        oldMid: oldStr.slice(p, oldStr.length - s),
        newMid: newStr.slice(p, newStr.length - s),
        suffix: oldStr.slice(oldStr.length - s),
    };
}

function diffFlatMaps(base, current) {
    const entries = [];
    for (const [key, cur] of current) {
        if (key.endsWith('.$ref') || key.endsWith('.$REF')) continue;
        const old = base.get(key);
        if (!old) entries.push({ kind: 'added', key, newValue: cur });
        else if (!valuesEqual(old, cur)) {
            const entry = { kind: 'changed', key, oldValue: old, newValue: cur };
            if (old.type === 'string' && cur.type === 'string') {
                entry.stringDiff = diffStringParts(old.value, cur.value);
            }
            entries.push(entry);
        }
    }
    for (const [key, old] of base) {
        if (key.endsWith('.$ref') || key.endsWith('.$REF')) continue;
        if (!current.has(key)) entries.push({ kind: 'removed', key, oldValue: old });
    }
    entries.sort((a, b) => a.key.localeCompare(b.key));
    return entries;
}

function buildDiffHighlightMap(entries) {
    const map = {};
    for (const e of entries) {
        map[e.key] = e.kind;
        const parts = e.key.split('.');
        for (let i = 1; i < parts.length; i++) {
            const anc = parts.slice(0, i).join('.');
            if (!map[anc]) map[anc] = 'changed';
        }
    }
    return map;
}

function test(name, fn) {
    try {
        fn();
        console.log('PASS', name);
    } catch (e) {
        console.error('FAIL', name);
        console.error(e);
        process.exitCode = 1;
    }
}

const dict = createAndLoadDictionaries([path.join(ROOT, 'dictionaries', 'RGD_DIC.TXT')]);

test('diffFlatMaps detects added, removed, changed', () => {
    const base = new Map([
        ['GameData.unit_name', { type: 'string', value: 'old' }],
        ['GameData.health', { type: 'float', value: 100 }],
        ['GameData.removed_key', { type: 'int', value: 1 }],
    ]);
    const current = new Map([
        ['GameData.unit_name', { type: 'string', value: 'new' }],
        ['GameData.health', { type: 'float', value: 100 }],
        ['GameData.added_key', { type: 'bool', value: true }],
    ]);
    const diffs = diffFlatMaps(base, current);
    const byKey = Object.fromEntries(diffs.map((d) => [d.key, d.kind]));
    assert.strictEqual(byKey['GameData.unit_name'], 'changed');
    assert.strictEqual(byKey['GameData.removed_key'], 'removed');
    assert.strictEqual(byKey['GameData.added_key'], 'added');
    assert.strictEqual(byKey['GameData.health'], undefined);
});

test('float epsilon treats near-equal floats as match', () => {
    const base = new Map([['x', { type: 'float', value: 1.0 }]]);
    const current = new Map([['x', { type: 'float', value: 1.0 + 1e-5 }]]);
    assert.strictEqual(diffFlatMaps(base, current).length, 0);
});

test('diffStringParts isolates appended/removed characters', () => {
    const appended = diffStringParts(
        'research\\space_marines\\A_deployment.lua',
        'research\\space_marines\\A_deployment2.lua',
    );
    assert.strictEqual(appended.oldMid, '');
    assert.strictEqual(appended.newMid, '2');
    assert.strictEqual(appended.suffix, '.lua');
    assert.ok(appended.prefix.endsWith('deployment'));

    const removed = diffStringParts('deployment2.lua', 'deployment.lua');
    assert.strictEqual(removed.oldMid, '2');
    assert.strictEqual(removed.newMid, '');
    assert.strictEqual(removed.suffix, '.lua');
});

test('diffStringParts handles middle edits and full rewrites', () => {
    const mid = diffStringParts('abcXdef', 'abcYdef');
    assert.strictEqual(mid.prefix, 'abc');
    assert.strictEqual(mid.oldMid, 'X');
    assert.strictEqual(mid.newMid, 'Y');
    assert.strictEqual(mid.suffix, 'def');

    const all = diffStringParts('aaa', 'bbb');
    assert.strictEqual(all.prefix, '');
    assert.strictEqual(all.suffix, '');
    assert.strictEqual(all.oldMid, 'aaa');
    assert.strictEqual(all.newMid, 'bbb');

    const equal = diffStringParts('same', 'same');
    assert.strictEqual(equal.oldMid, '');
    assert.strictEqual(equal.newMid, '');
});

test('changed string entries carry char-level stringDiff', () => {
    const base = new Map([['k', { type: 'string', value: 'file_a.lua' }]]);
    const current = new Map([['k', { type: 'string', value: 'file_ab.lua' }]]);
    const [e] = diffFlatMaps(base, current);
    assert.strictEqual(e.kind, 'changed');
    assert.strictEqual(e.stringDiff.newMid, 'b');
    assert.strictEqual(e.stringDiff.oldMid, '');

    const num = diffFlatMaps(
        new Map([['n', { type: 'float', value: 1 }]]),
        new Map([['n', { type: 'float', value: 2 }]]),
    )[0];
    assert.strictEqual(num.stringDiff, undefined);
});

test('highlight map marks ancestors of leaf changes', () => {
    const map = buildDiffHighlightMap([
        { kind: 'changed', key: 'GameData.squad.max_size' },
        { kind: 'added', key: 'GameData.extra' },
    ]);
    assert.strictEqual(map['GameData.squad.max_size'], 'changed');
    assert.strictEqual(map['GameData.squad'], 'changed');
    assert.strictEqual(map['GameData'], 'changed');
    assert.strictEqual(map['GameData.extra'], 'added');
});

test('flatten real RGD files and detect value change', () => {
    const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'rgd-diff-'));
    try {
        const t1 = createTable();
        t1.entries.push(createEntry('unit_name', RgdDataType.String, 'alpha', dict));
        t1.entries.push(createEntry('health', RgdDataType.Float, 50, dict));
        const outer1 = createTable();
        outer1.entries.push(createEntry('GameData', RgdDataType.Table, t1, dict));

        const t2 = createTable();
        t2.entries.push(createEntry('unit_name', RgdDataType.String, 'beta', dict));
        t2.entries.push(createEntry('health', RgdDataType.Float, 50, dict));
        t2.entries.push(createEntry('armor', RgdDataType.Integer, 3, dict));
        const outer2 = createTable();
        outer2.entries.push(createEntry('GameData', RgdDataType.Table, t2, dict));

        const p1 = path.join(tmp, 'a.rgd');
        const p2 = path.join(tmp, 'b.rgd');
        writeRgdFile(p1, outer1, dict, 1);
        writeRgdFile(p2, outer2, dict, 1);

        const { parseRgd } = require(path.join(DIST, 'reader'));
        const m1 = flattenLike(parseRgd(fs.readFileSync(p1), dict).gameData);
        const m2 = flattenLike(parseRgd(fs.readFileSync(p2), dict).gameData);
        const diffs = diffFlatMaps(m1, m2);
        const kinds = Object.fromEntries(diffs.map((d) => [d.key, d.kind]));
        assert.ok(
            Object.keys(kinds).some((k) => k.endsWith('unit_name') && kinds[k] === 'changed'),
            'unit_name should be changed',
        );
        assert.ok(
            Object.keys(kinds).some((k) => k.endsWith('armor') && kinds[k] === 'added'),
            'armor should be added',
        );
    } finally {
        fs.rmSync(tmp, { recursive: true, force: true });
    }
});

if (process.exitCode) {
    process.exit(process.exitCode);
}
console.log('table-diff tests complete');
