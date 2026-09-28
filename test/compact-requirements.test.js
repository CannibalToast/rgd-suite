'use strict';
/**
 * Tests for cli/requirements.js — required_* slot compaction.
 */
const assert = require('assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { test } = require('node:test');

const RGD_DIST = path.join(__dirname, '..', 'bundled', 'rgd-tools', 'dist');
const { createAndLoadDictionaries } = require(path.join(RGD_DIST, 'dictionary'));
const { createTable, createEntry, writeRgdFile } = require(path.join(RGD_DIST, 'writer'));
const { readRgdFile } = require(path.join(RGD_DIST, 'reader'));
const { RgdDataType } = require(path.join(RGD_DIST, 'types'));
const { nameToHash } = require(path.join(RGD_DIST, 'dictionary'));
const { compactRequirements } = require(path.join(__dirname, '..', 'cli', 'requirements'));

const TEST_DICT = path.join(__dirname, '..', 'dictionaries', 'RGD_DIC.TXT');
function newDict() {
    return createAndLoadDictionaries(fs.existsSync(TEST_DICT) ? [TEST_DICT] : []);
}

function reqSlot(refPath, dict) {
    const t = createTable(refPath);
    t.entries.push(createEntry('$REF', RgdDataType.String, refPath, dict));
    t.reference = refPath;
    return t;
}

function makeRequirementsTable(dict, slots) {
    const reqs = createTable('tables\\requirements.lua');
    reqs.entries.push(createEntry('$REF', RgdDataType.String, 'tables\\requirements.lua', dict));
    for (const [name, ref] of slots) {
        reqs.entries.push(createEntry(name, RgdDataType.Table, reqSlot(ref, dict), dict));
    }
    const root = createTable();
    root.entries.push(createEntry('requirements', RgdDataType.Table, reqs, dict));
    return root;
}

test('compactRequirements drops required_none slots and renumbers contiguously', () => {
    const dict = newDict();
    const root = makeRequirementsTable(dict, [
        ['required_1', 'requirements\\global_required_addon.lua'],
        ['required_2', 'requirements\\required_none.lua'],
        ['required_3', 'requirements\\required_none.lua'],
        ['required_4', 'requirements\\required_research.lua'],
        ['required_5', 'requirements\\required_none.lua'],
        ['required_10', 'requirements\\required_structure.lua'],
    ]);

    const report = compactRequirements(root, dict);
    assert.strictEqual(report.length, 1);
    assert.strictEqual(report[0].path, 'requirements');
    assert.strictEqual(report[0].dropped, 3);
    assert.strictEqual(report[0].kept, 3);

    const reqs = root.entries[0].value;
    const names = reqs.entries.filter((e) => e.name !== '$REF').map((e) => e.name);
    assert.deepStrictEqual(names, ['required_1', 'required_2', 'required_3']);

    // The required_10 structure requirement survived — now in slot 3.
    const refs = reqs.entries
        .filter((e) => e.name !== '$REF')
        .map((e) => e.value.reference);
    assert.deepStrictEqual(refs, [
        'requirements\\global_required_addon.lua',
        'requirements\\required_research.lua',
        'requirements\\required_structure.lua',
    ]);

    // Renames refresh the entry hash so the binary writes correctly.
    const e3 = reqs.entries.find((e) => e.name === 'required_3');
    assert.strictEqual(e3.hash, nameToHash(dict, 'required_3'));
});

test('compactRequirements is a no-op when every slot has real data', () => {
    const dict = newDict();
    const root = makeRequirementsTable(dict, [
        ['required_1', 'requirements\\required_research.lua'],
        ['required_2', 'requirements\\required_structure.lua'],
    ]);
    assert.deepStrictEqual(compactRequirements(root, dict), []);
    assert.strictEqual(root.entries[0].value.entries.length, 3); // $REF + 2 slots
});

test('compactRequirements leaves tables without required_* children alone', () => {
    const dict = newDict();
    const other = createTable();
    other.entries.push(createEntry('armour', RgdDataType.Float, 50, dict));
    const root = createTable();
    root.entries.push(createEntry('armour_piercing', RgdDataType.Table, other, dict));
    assert.deepStrictEqual(compactRequirements(root, dict), []);
    assert.strictEqual(other.entries[0].name, 'armour');
});

test('compactRequirements drops empty required tables and keeps non-required siblings', () => {
    const dict = newDict();
    const reqs = createTable('tables\\requirements.lua');
    reqs.entries.push(createEntry('$REF', RgdDataType.String, 'tables\\requirements.lua', dict));
    reqs.entries.push(createEntry('other_setting', RgdDataType.Bool, true, dict));
    reqs.entries.push(createEntry('required_1', RgdDataType.Table, createTable(), dict)); // empty
    reqs.entries.push(createEntry('required_2', RgdDataType.Table, reqSlot('requirements\\required_structure.lua', dict), dict));
    const root = createTable();
    root.entries.push(createEntry('requirements', RgdDataType.Table, reqs, dict));

    const report = compactRequirements(root, dict);
    assert.strictEqual(report[0].dropped, 1);
    const names = reqs.entries.map((e) => e.name);
    assert.deepStrictEqual(names, ['$REF', 'other_setting', 'required_1']);
    assert.strictEqual(reqs.entries[2].value.reference, 'requirements\\required_structure.lua');
});

test('compactRequirements keeps a required_none slot that carries real children', () => {
    const dict = newDict();
    const reqs = createTable('tables\\requirements.lua');
    reqs.entries.push(createEntry('$REF', RgdDataType.String, 'tables\\requirements.lua', dict));
    const slot = reqSlot('requirements\\required_none.lua', dict);
    slot.entries.push(createEntry('extra_data', RgdDataType.Integer, 42, dict));
    reqs.entries.push(createEntry('required_1', RgdDataType.Table, slot, dict));
    reqs.entries.push(createEntry('required_2', RgdDataType.Table, reqSlot('requirements\\required_none.lua', dict), dict));
    const root = createTable();
    root.entries.push(createEntry('requirements', RgdDataType.Table, reqs, dict));

    const report = compactRequirements(root, dict);
    // Only the pure required_none slot drops; the one with extra_data stays.
    assert.strictEqual(report[0].dropped, 1);
    assert.strictEqual(report[0].kept, 1);
    const kept = reqs.entries.find((e) => e.name === 'required_1');
    assert.strictEqual(kept.value.entries.length, 2); // $REF + extra_data preserved
});

test('compacted file survives a binary write/read round-trip', () => {
    const dict = newDict();
    const root = makeRequirementsTable(dict, [
        ['required_1', 'requirements\\required_research.lua'],
        ['required_2', 'requirements\\required_none.lua'],
        ['required_7', 'requirements\\required_structure.lua'],
    ]);
    compactRequirements(root, dict);

    const tmp = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'rgd-compact-')), 't.rgd');
    writeRgdFile(tmp, root, dict, 1);
    const back = readRgdFile(tmp, dict);
    const reqs = back.gameData.entries.find((e) => e.name === 'requirements').value;
    // Binary order is hash-sorted; assert the name→target mapping instead.
    const byName = new Map(
        reqs.entries.filter((e) => e.name !== '$REF').map((e) => [e.name, e.value.reference]),
    );
    assert.deepStrictEqual(
        byName,
        new Map([
            ['required_1', 'requirements\\required_research.lua'],
            ['required_2', 'requirements\\required_structure.lua'],
        ]),
    );
});

console.log('compact-requirements tests complete');
