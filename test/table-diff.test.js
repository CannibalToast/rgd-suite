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
const { loadTs } = require('./load-ts');
const {
    diffFlatMaps,
    diffStringParts,
    buildDiffHighlightMap,
    flattenRgd,
    flattenRgdBuffer,
} = loadTs('src/tableDiff.ts');

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

test('flattenRgd flattens nested tables, hash/empty-name keys, and skips $REF/NoData', () => {
    const table = {
        entries: [
            {
                name: 'outer', hash: 1, type: RgdDataType.Table,
                value: {
                    entries: [
                        { name: 'leaf', hash: 2, type: RgdDataType.Integer, value: 5 },
                        { name: '', hash: 9, type: RgdDataType.Float, value: 2.5 },
                    ],
                },
            },
            { hash: 4, type: RgdDataType.Bool, value: true },
            { name: '$REF', hash: 5, type: RgdDataType.String, value: 'parent.lua' },
            { name: 'deleted', hash: 6, type: RgdDataType.NoData, value: null },
            { name: 'emptyTable', hash: 7, type: RgdDataType.TableInt, value: { entries: [] } },
        ],
    };
    const flat = flattenRgd(table);
    assert.deepStrictEqual(flat.get('outer.leaf'), { type: 'int', value: 5 });
    assert.deepStrictEqual(flat.get('outer.'), { type: 'float', value: 2.5 });
    assert.deepStrictEqual(flat.get('#00000004'), { type: 'bool', value: true });
    assert.ok(!flat.has('$REF'), '$REF entries must be skipped');
    assert.ok(!flat.has('deleted'), 'NoData entries must be skipped');
    assert.ok(!flat.has('emptyTable'), 'null nested tables must not produce keys');
    assert.strictEqual(flat.size, 3);
});

test('flattenRgdBuffer parses and flattens a binary buffer', () => {
    const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'rgd-flatbuf-'));
    try {
        const t = createTable();
        t.entries.push(createEntry('hitpoints', RgdDataType.Float, 42, dict));
        const outer = createTable();
        outer.entries.push(createEntry('GameData', RgdDataType.Table, t, dict));
        const p = path.join(tmp, 'unit.rgd');
        writeRgdFile(p, outer, dict, 1);
        const flat = flattenRgdBuffer(fs.readFileSync(p), dict);
        assert.deepStrictEqual(flat.get('GameData.hitpoints'), { type: 'float', value: 42 });
    } finally {
        fs.rmSync(tmp, { recursive: true, force: true });
    }
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
        const m1 = flattenRgd(parseRgd(fs.readFileSync(p1), dict).gameData);
        const m2 = flattenRgd(parseRgd(fs.readFileSync(p2), dict).gameData);
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
