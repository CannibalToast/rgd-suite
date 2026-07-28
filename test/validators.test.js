#!/usr/bin/env node
'use strict';

const assert = require('assert');
const fs = require('fs');
const os = require('os');
const path = require('path');

const {
    detectBOM,
    stripUtf8BomFromFile,
    validateEncoding,
    validateFilePath,
    validateFolderStructure,
    validateLuaReferences,
    validateRgdReferences,
    isNilReference,
    resolveAttribRefPath,
    clearAttribIndex,
} = require('../cli/validators');

function test(name, fn) {
    try {
        fn();
        console.log(`PASS ${name}`);
    } catch (err) {
        console.error(`FAIL ${name}`);
        console.error(err.stack || err.message);
        process.exitCode = 1;
    }
}

test('detectBOM identifies common byte order marks', () => {
    assert.strictEqual(detectBOM(Buffer.from([0xef, 0xbb, 0xbf, 0x47])).type, 'utf8');
    assert.strictEqual(detectBOM(Buffer.from([0xff, 0xfe, 0x47, 0x00])).type, 'utf16le');
    assert.strictEqual(detectBOM(Buffer.from([0xfe, 0xff, 0x00, 0x47])).type, 'utf16be');
    assert.strictEqual(detectBOM(Buffer.from([0xff, 0xfe, 0x00, 0x00, 0x47])).type, 'utf32le');
    assert.strictEqual(detectBOM(Buffer.from([0x00, 0x00, 0xfe, 0xff, 0x47])).type, 'utf32be');
    assert.strictEqual(detectBOM(Buffer.from('GameData')).type, null);
});

test('validateEncoding warns on BOM and rejects binary-looking text buffers', () => {
    const bom = validateEncoding(Buffer.from([0xef, 0xbb, 0xbf, 0x47]));
    assert.strictEqual(bom.hasBOM, true);
    assert(bom.issues.some((issue) => issue.kind === 'bom_detected'));

    const binary = validateEncoding(Buffer.from([0x47, 0x00, 0x61, 0x00, 0x6d, 0x00]));
    assert.strictEqual(binary.isValid, false);
    assert(binary.issues.some((issue) => issue.kind === 'encoding_mismatch'));
});

test('stripUtf8BomFromFile removes UTF-8 BOMs in place', () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'rgd-bom-fix-'));
    const file = path.join(dir, 'unit.lua');
    fs.writeFileSync(file, Buffer.concat([
        Buffer.from([0xef, 0xbb, 0xbf]),
        Buffer.from('GameData = Inherit([[]])\n', 'utf8'),
    ]));

    const result = stripUtf8BomFromFile(file);
    const updated = fs.readFileSync(file);
    assert.strictEqual(result.fixed, true);
    assert.strictEqual(updated[0], 'G'.charCodeAt(0));
    assert.strictEqual(validateEncoding(updated, file).hasBOM, false);
});

test('validateFilePath rejects unsafe relative references', () => {
    assert(validateFilePath('../attrib/unit.lua').some((issue) => issue.kind === 'path_traversal'));
    assert(validateFilePath('attrib/\0/unit.lua').some((issue) => issue.kind === 'null_byte'));
    assert(validateFilePath('/absolute/unit.lua').some((issue) => issue.kind === 'absolute_path'));
    assert.deepStrictEqual(validateFilePath('ebps/races/space_marines/unit.lua'), []);
});

test('validateLuaReferences reports missing and unsafe references', () => {
    const attrib = fs.mkdtempSync(path.join(os.tmpdir(), 'rgd-validator-'));
    const table = {
        reference: 'missing/root.lua',
        entries: new Map([
            ['safe', { type: 'table', reference: 'missing/child.lua', table: { entries: new Map() } }],
            ['unsafe', { type: 'table', reference: '../escape.lua', table: { entries: new Map() } }],
        ]),
    };

    const issues = validateLuaReferences(table, attrib);
    assert(issues.some((issue) => issue.kind === 'missing_file' && issue.path === 'missing/root.lua'));
    assert(issues.some((issue) => issue.kind === 'missing_file' && issue.path === 'missing/child.lua'));
    assert(issues.some((issue) => issue.kind === 'path_traversal'));
});

test('validateLuaReferences resolves attrib-relative references under attrib root', () => {
    const attrib = fs.mkdtempSync(path.join(os.tmpdir(), 'rgd-validator-attrib-'));
    const parentRel = 'ebps/races/test/parent.lua';
    fs.mkdirSync(path.dirname(path.join(attrib, parentRel)), { recursive: true });
    fs.writeFileSync(path.join(attrib, parentRel), 'GameData = Inherit([[]])\n', 'utf8');
    const table = {
        reference: parentRel,
        entries: new Map([
            ['withPrefix', { type: 'table', reference: `data/attrib/${parentRel}`, table: { entries: new Map() } }],
            ['unsafe', { type: 'table', reference: '../escape.lua', table: { entries: new Map() } }],
        ]),
    };

    const issues = validateLuaReferences(table, attrib);
    assert(!issues.some((issue) => issue.kind === 'missing_file' && issue.path === parentRel));
    assert(!issues.some((issue) => issue.kind === 'missing_file' && issue.path === `data/attrib/${parentRel}`));
    assert(issues.some((issue) => issue.kind === 'path_traversal'));
});

test('isNilReference matches .nil paths case-insensitively', () => {
    assert.strictEqual(isNilReference('squadtrooper\\squad_trooper.nil'), true);
    assert.strictEqual(isNilReference('root/parent.NIL'), true);
    assert.strictEqual(isNilReference('root/parent.Nil'), true);
    assert.strictEqual(isNilReference('ebps/races/test/unit.lua'), false);
    assert.strictEqual(isNilReference('ebps/races/test/unit.rgd'), false);
});

test('resolveAttribRefPath returns null for nil sentinel references', () => {
    const attrib = fs.mkdtempSync(path.join(os.tmpdir(), 'rgd-validator-nil-resolve-'));
    assert.strictEqual(resolveAttribRefPath('squadtrooper\\squad_trooper.nil', attrib, '.lua'), null);
    assert.strictEqual(resolveAttribRefPath('root/parent.NIL', attrib, '.rgd'), null);
});

test('validateRgdReferences ignores root and nested .nil sentinel references', () => {
    const attrib = fs.mkdtempSync(path.join(os.tmpdir(), 'rgd-validator-nil-'));
    const table = {
        reference: 'squadtrooper\\squad_trooper.nil',
        entries: [
            {
                name: 'child',
                type: 100,
                reference: 'ebps/races/test/missing_parent.nil',
                value: {
                    reference: 'ebps/races/test/deep_child.NIL',
                    entries: [],
                },
            },
            {
                name: 'realMissing',
                type: 100,
                reference: 'ebps/races/test/actually_missing.lua',
                value: { entries: [] },
            },
        ],
    };

    const issues = validateRgdReferences(table, attrib);

    assert(!issues.some((issue) => issue.kind === 'missing_file' && issue.path.includes('.nil')));
    assert(!issues.some((issue) => issue.kind === 'missing_file' && issue.path.includes('.NIL')));
    assert(issues.some((issue) => issue.kind === 'missing_file' && issue.path === 'ebps/races/test/actually_missing.lua'));
});

test('validateLuaReferences ignores .nil sentinel references but still flags real missing files', () => {
    const attrib = fs.mkdtempSync(path.join(os.tmpdir(), 'rgd-validator-nil-lua-'));
    const table = {
        reference: 'squadtrooper/squad_trooper.Nil',
        entries: new Map([
            ['child', {
                type: 'table',
                reference: 'ebps/races/test/nested.nil',
                table: {
                    reference: 'ebps/races/test/deeper.NIL',
                    entries: new Map(),
                },
            }],
            ['missing', {
                type: 'table',
                reference: 'ebps/races/test/real_missing.lua',
                table: { entries: new Map() },
            }],
        ]),
    };

    const issues = validateLuaReferences(table, attrib);

    assert(!issues.some((issue) => issue.kind === 'missing_file' && /\.nil$/i.test(issue.path)));
    assert(issues.some((issue) => issue.kind === 'missing_file' && issue.path === 'ebps/races/test/real_missing.lua'));
});

test('validateFolderStructure distinguishes attrib roots from arbitrary folders', () => {
    const attrib = fs.mkdtempSync(path.join(os.tmpdir(), 'rgd-folder-attrib-'));
    fs.mkdirSync(path.join(attrib, 'ebps'), { recursive: true });
    fs.mkdirSync(path.join(attrib, 'sbps'), { recursive: true });
    assert.deepStrictEqual(validateFolderStructure(attrib), []);

    const arbitrary = fs.mkdtempSync(path.join(os.tmpdir(), 'rgd-folder-arbitrary-'));
    const issues = validateFolderStructure(arbitrary);
    assert(issues.some((issue) => issue.kind === 'folder_structure'));
});

// ---------- Prefix-agnostic reference resolution ----------

test('resolveAttribRefPath finds references that omit the type-folder prefix', () => {
    const attrib = fs.mkdtempSync(path.join(os.tmpdir(), 'rgd-prefix-fallback-'));
    // Simulate attrib tree: attrib/research/heavy_weapons_research.rgd
    fs.mkdirSync(path.join(attrib, 'research'), { recursive: true });
    fs.writeFileSync(path.join(attrib, 'research', 'heavy_weapons_research.rgd'), '');
    clearAttribIndex(attrib);

    // Reference without prefix — should find it via basename search
    const resolved = resolveAttribRefPath('heavy_weapons_research', attrib, '.rgd');
    assert.strictEqual(resolved, path.resolve(attrib, 'research', 'heavy_weapons_research.rgd'));
});

test('resolveAttribRefPath flags wrong-prefix references instead of basename-rescuing them', () => {
    const attrib = fs.mkdtempSync(path.join(os.tmpdir(), 'rgd-wrong-prefix-'));
    // File is under research/ but reference says abilities/
    fs.mkdirSync(path.join(attrib, 'research'), { recursive: true });
    fs.writeFileSync(path.join(attrib, 'research', 'target_research.lua'), 'GameData = Inherit([[]])\n');
    clearAttribIndex(attrib);

    // Wrong prefix is a wrong name — must NOT be rescued by basename fallback
    const resolved = resolveAttribRefPath('abilities/target_research', attrib, '.lua');
    assert.strictEqual(resolved, null);
});

test('resolveAttribRefPath flags wrong names with a prefix instead of basename-rescuing them', () => {
    const attrib = fs.mkdtempSync(path.join(os.tmpdir(), 'rgd-wrong-name-'));
    // File exists as research/correct_name.rgd
    fs.mkdirSync(path.join(attrib, 'research'), { recursive: true });
    fs.writeFileSync(path.join(attrib, 'research', 'correct_name.rgd'), '');
    // An unrelated file with the same basename exists under abilities/
    fs.mkdirSync(path.join(attrib, 'abilities'), { recursive: true });
    fs.writeFileSync(path.join(attrib, 'abilities', 'typo_name.rgd'), '');
    clearAttribIndex(attrib);

    // Reference has a prefix + wrong name — must NOT resolve via basename fallback
    assert.strictEqual(resolveAttribRefPath('research/typo_name', attrib, '.rgd'), null);
    // Correct prefixed name still resolves
    assert.strictEqual(
        resolveAttribRefPath('research/correct_name', attrib, '.rgd'),
        path.resolve(attrib, 'research', 'correct_name.rgd'),
    );
});

test('resolveAttribRefPath prefers literal path over basename fallback', () => {
    const attrib = fs.mkdtempSync(path.join(os.tmpdir(), 'rgd-literal-preferred-'));
    // Create two files with the same basename in different folders
    fs.mkdirSync(path.join(attrib, 'abilities', 'space_marine'), { recursive: true });
    fs.mkdirSync(path.join(attrib, 'research'), { recursive: true });
    fs.writeFileSync(path.join(attrib, 'abilities', 'space_marine', 'shared_name.rgd'), '');
    fs.writeFileSync(path.join(attrib, 'research', 'shared_name.rgd'), '');
    clearAttribIndex(attrib);

    // Literal path should resolve to the abilities/ version
    const resolved = resolveAttribRefPath('abilities/space_marine/shared_name', attrib, '.rgd');
    assert.strictEqual(resolved, path.resolve(attrib, 'abilities', 'space_marine', 'shared_name.rgd'));
});

test('resolveAttribRefPath returns null for truly missing files even with basename search', () => {
    const attrib = fs.mkdtempSync(path.join(os.tmpdir(), 'rgd-truly-missing-'));
    fs.mkdirSync(path.join(attrib, 'research'), { recursive: true });
    fs.writeFileSync(path.join(attrib, 'research', 'exists.rgd'), '');
    clearAttribIndex(attrib);

    // No file with this name anywhere in the attrib tree
    assert.strictEqual(resolveAttribRefPath('nonexistent_file', attrib, '.rgd'), null);
});

test('validateLuaReferences resolves prefix-less ability requirements via basename search', () => {
    const attrib = fs.mkdtempSync(path.join(os.tmpdir(), 'rgd-ability-req-'));
    // Simulate: ability file references a research file without the research/ prefix
    fs.mkdirSync(path.join(attrib, 'research'), { recursive: true });
    fs.writeFileSync(path.join(attrib, 'research', 'heavy_weapons_research.lua'), 'GameData = Inherit([[]])\n');
    clearAttribIndex(attrib);

    // An ability's requirements table references "heavy_weapons_research" (no prefix)
    const table = {
        reference: 'missing/ability_parent.lua',
        entries: new Map([
            ['requirements', {
                type: 'table',
                reference: 'heavy_weapons_research',
                table: { entries: new Map() },
            }],
        ]),
    };

    const issues = validateLuaReferences(table, attrib);
    // The prefix-less reference should NOT be flagged as missing
    assert(!issues.some((issue) => issue.kind === 'missing_file' && issue.path === 'heavy_weapons_research'),
        'prefix-less reference should resolve via basename search');
    // The missing parent reference should still be flagged
    assert(issues.some((issue) => issue.kind === 'missing_file' && issue.path === 'missing/ability_parent.lua'),
        'truly missing reference should still be flagged');
});

test('validateRgdReferences resolves prefix-less references in nested requirement tables', () => {
    const attrib = fs.mkdtempSync(path.join(os.tmpdir(), 'rgd-rgd-req-'));
    fs.mkdirSync(path.join(attrib, 'upgrade'), { recursive: true });
    fs.writeFileSync(path.join(attrib, 'upgrade', 'target_upgrade.rgd'), '');
    clearAttribIndex(attrib);

    // Simulate an RGD table where a nested requirements table references
    // an upgrade file without the "upgrade/" prefix
    const table = {
        reference: 'missing/parent.lua',
        entries: [
            {
                name: 'requirements',
                type: 100, // RgdDataType.Table
                reference: 'target_upgrade', // no prefix!
                value: { entries: [] },
            },
            {
                name: 'realMissing',
                type: 100,
                reference: 'ebps/races/test/actually_missing.lua',
                value: { entries: [] },
            },
        ],
    };

    const issues = validateRgdReferences(table, attrib);
    assert(!issues.some((issue) => issue.kind === 'missing_file' && issue.path === 'target_upgrade'),
        'prefix-less reference should resolve via basename search');
    assert(issues.some((issue) => issue.kind === 'missing_file' && issue.path === 'ebps/races/test/actually_missing.lua'),
        'truly missing reference should still be flagged');
});

test('clearAttribIndex invalidates the cache so new files are found', () => {
    const attrib = fs.mkdtempSync(path.join(os.tmpdir(), 'rgd-cache-invalidate-'));
    fs.mkdirSync(path.join(attrib, 'research'), { recursive: true });
    fs.writeFileSync(path.join(attrib, 'research', 'cached_file.rgd'), '');
    clearAttribIndex(attrib);

    // First resolution builds the index
    assert(resolveAttribRefPath('cached_file', attrib, '.rgd'));

    // Add a new file after the index was built
    fs.mkdirSync(path.join(attrib, 'abilities'), { recursive: true });
    fs.writeFileSync(path.join(attrib, 'abilities', 'new_ability.rgd'), '');

    // Without clearing, the index is stale and won't find the new file
    assert.strictEqual(resolveAttribRefPath('new_ability', attrib, '.rgd'), null);

    // After clearing, the new file is found
    clearAttribIndex(attrib);
    assert(resolveAttribRefPath('new_ability', attrib, '.rgd'));
});

// ---------- Full nested RGD / Lua path scanning & prefix mismatch detection ----------

const RGD_DIST = path.join(__dirname, '..', 'bundled', 'rgd-tools', 'dist');
const { createAndLoadDictionaries: createTestDict } = require(path.join(RGD_DIST, 'dictionary'));
const { createTable: rgdCreateTable, createEntry: rgdCreateEntry, writeRgdFile } = require(path.join(RGD_DIST, 'writer'));
const { readRgdFile } = require(path.join(RGD_DIST, 'reader'));
const { RgdDataType } = require(path.join(RGD_DIST, 'types'));
const TEST_DICT_PATH = path.join(__dirname, '..', 'dictionaries', 'RGD_DIC.TXT');
const REF_HASH = 0x49D60FAE;

function makeNestedRgdAttribRoot() {
    const attrib = fs.mkdtempSync(path.join(os.tmpdir(), 'rgd-nested-full-'));
    fs.mkdirSync(path.join(attrib, 'tables'), { recursive: true });
    fs.writeFileSync(path.join(attrib, 'tables', 'requirements.lua'), 'GameData = Inherit([[]])\n');
    fs.mkdirSync(path.join(attrib, 'requirements'), { recursive: true });
    fs.writeFileSync(path.join(attrib, 'requirements', 'required_structure.lua'), '');
    fs.mkdirSync(path.join(attrib, 'ebps', 'races', 'space_marines', 'structures'), { recursive: true });
    fs.writeFileSync(path.join(attrib, 'ebps', 'races', 'space_marines', 'structures', 'space_marine_hq.lua'), '');
    return attrib;
}

function addRefEntry(table, refPath, dict) {
    table.entries.push(rgdCreateEntry('$REF', RgdDataType.String, refPath, dict));
    table.reference = refPath;
}

test('validateRgdReferences walks nested binary RGD tables and validates table.$REF', () => {
    const dict = createTestDict(fs.existsSync(TEST_DICT_PATH) ? [TEST_DICT_PATH] : []);
    const attrib = makeNestedRgdAttribRoot();
    clearAttribIndex(attrib);

    const req = rgdCreateTable('requirements\\required_structure.lua');
    addRefEntry(req, 'requirements\\required_structure.lua', dict);

    const requirements = rgdCreateTable('tables\\requirements.lua');
    addRefEntry(requirements, 'tables\\requirements.lua', dict);
    requirements.entries.push(rgdCreateEntry('required_10', RgdDataType.Table, req, dict));

    const root = rgdCreateTable();
    root.entries.push(rgdCreateEntry('requirements', RgdDataType.Table, requirements, dict));

    const rgdPath = path.join(attrib, 'test.rgd');
    writeRgdFile(rgdPath, root, dict, 1);
    const rgd = readRgdFile(rgdPath, dict);

    const issues = validateRgdReferences(rgd.gameData, attrib);
    assert(!issues.some((i) => i.kind === 'missing_file' && i.path.includes('tables\\requirements.lua')),
        'nested table $REF should resolve');
    assert(!issues.some((i) => i.kind === 'missing_file' && i.path.includes('requirements\\required_structure.lua')),
        'deep nested table $REF should resolve');
});

test('validateRgdReferences flags path-like string values in deeply nested RGD tables', () => {
    const dict = createTestDict(fs.existsSync(TEST_DICT_PATH) ? [TEST_DICT_PATH] : []);
    const attrib = makeNestedRgdAttribRoot();
    clearAttribIndex(attrib);

    // Intentionally wrong race prefix: 'sisters' instead of 'space_marines' for a file that exists
    const wrongStructure = 'ebps\\races\\sisters\\structures\\space_marine_hq.lua';
    const req = rgdCreateTable('requirements\\required_structure.lua');
    req.entries.push(rgdCreateEntry('structure_name', RgdDataType.String, wrongStructure, dict));

    const requirements = rgdCreateTable();
    requirements.entries.push(rgdCreateEntry('required_10', RgdDataType.Table, req, dict));
    const root = rgdCreateTable();
    root.entries.push(rgdCreateEntry('requirements', RgdDataType.Table, requirements, dict));

    const rgdPath = path.join(attrib, 'test.rgd');
    writeRgdFile(rgdPath, root, dict, 1);
    const rgd = readRgdFile(rgdPath, dict);

    const issues = validateRgdReferences(rgd.gameData, attrib);
    assert(issues.some((i) => i.kind === 'relocated_ref' && i.path === wrongStructure),
        'nested path-like string with wrong race prefix should be reported as relocated_ref');
});

test('validateRgdReferences reports missing string references in deeply nested RGD tables', () => {
    const dict = createTestDict(fs.existsSync(TEST_DICT_PATH) ? [TEST_DICT_PATH] : []);
    const attrib = makeNestedRgdAttribRoot();
    clearAttribIndex(attrib);

    const missing = 'ebps\\races\\space_marines\\structures\\missing_hq.lua';
    const req = rgdCreateTable('requirements\\required_structure.lua');
    req.entries.push(rgdCreateEntry('structure_name', RgdDataType.String, missing, dict));

    const requirements = rgdCreateTable();
    requirements.entries.push(rgdCreateEntry('required_10', RgdDataType.Table, req, dict));
    const root = rgdCreateTable();
    root.entries.push(rgdCreateEntry('requirements', RgdDataType.Table, requirements, dict));

    const rgdPath = path.join(attrib, 'test.rgd');
    writeRgdFile(rgdPath, root, dict, 1);
    const rgd = readRgdFile(rgdPath, dict);

    const issues = validateRgdReferences(rgd.gameData, attrib);
    assert(issues.some((i) => i.kind === 'missing_file' && i.path === missing),
        'truly missing nested path-like string should be reported');
});

test('validateReferencePath reports relocated_ref for wrong-prefix Reference() when basename exists elsewhere', () => {
    const attrib = fs.mkdtempSync(path.join(os.tmpdir(), 'rgd-ref-reloc-'));
    fs.mkdirSync(path.join(attrib, 'research', 'races', 'correct'), { recursive: true });
    fs.writeFileSync(path.join(attrib, 'research', 'races', 'correct', 'shared_target.lua'), '');
    fs.mkdirSync(path.join(attrib, 'research', 'races', 'wrong'), { recursive: true });
    clearAttribIndex(attrib);

    const table = {
        reference: 'research\\races\\wrong\\shared_target.lua',
        entries: new Map(),
    };

    const issues = validateLuaReferences(table, attrib);
    assert(issues.some((i) => i.kind === 'relocated_ref' && i.path === 'research\\races\\wrong\\shared_target.lua'),
        'Reference() with wrong race prefix should surface as relocated_ref');
});

test('validateLuaReferences reports relocated_ref for nested path-like string with wrong race prefix', () => {
    const attrib = fs.mkdtempSync(path.join(os.tmpdir(), 'rgd-lua-reloc-'));
    fs.mkdirSync(path.join(attrib, 'ebps', 'races', 'tau', 'structures'), { recursive: true });
    fs.writeFileSync(path.join(attrib, 'ebps', 'races', 'tau', 'structures', 'tau_hq.lua'), '');
    clearAttribIndex(attrib);

    const wrongPath = 'ebps\\races\\dark_eldar\\structures\\tau_hq.lua';
    const table = {
        entries: new Map([
            ['requirements', {
                type: 'table',
                table: {
                    entries: new Map([
                        ['required_1', {
                            type: 'table',
                            table: {
                                entries: new Map([
                                    ['structure_name', { type: 'value', value: wrongPath }],
                                ]),
                            },
                        }],
                    ]),
                },
            }],
        ]),
    };

    const issues = validateLuaReferences(table, attrib);
    assert(issues.some((i) => i.kind === 'relocated_ref' && i.path === wrongPath),
        'nested string path with wrong race prefix should surface as relocated_ref');
});

test('validateLuaReferences does not flag bare stem *_name values', () => {
    const attrib = fs.mkdtempSync(path.join(os.tmpdir(), 'rgd-lua-bare-stem-'));
    fs.mkdirSync(path.join(attrib, 'research'), { recursive: true });
    fs.writeFileSync(path.join(attrib, 'research', 'heavy_weapons_research.lua'), '');
    clearAttribIndex(attrib);

    const table = {
        entries: new Map([
            ['requirements', {
                type: 'table',
                table: {
                    entries: new Map([
                        ['required_1', {
                            type: 'table',
                            table: {
                                entries: new Map([
                                    ['research_name', { type: 'value', value: 'heavy_weapons_research' }],
                                    ['modifier_name', { type: 'value', value: 'sisters_righteous_fervor_event' }],
                                ]),
                            },
                        }],
                    ]),
                },
            }],
        ]),
    };

    const issues = validateLuaReferences(table, attrib);
    assert(!issues.some((i) => i.kind === 'relocated_ref' || i.kind === 'missing_file'),
        'bare stem values should be ignored to avoid false positives');
});

test('validateRgdReferences skips internal type_* references in nested binary tables', () => {
    const dict = createTestDict(fs.existsSync(TEST_DICT_PATH) ? [TEST_DICT_PATH] : []);
    const attrib = fs.mkdtempSync(path.join(os.tmpdir(), 'rgd-type-ref-'));
    clearAttribIndex(attrib);

    const target = rgdCreateTable('tables\\target_filter_table.lua');
    const entry = rgdCreateTable('type_armour\\tp_monster_low.lua');
    entry.entries.push(rgdCreateEntry('screen_name_id', RgdDataType.WString, '$90106', dict));
    target.entries.push(rgdCreateEntry('entry_01', RgdDataType.Table, entry, dict));

    const root = rgdCreateTable();
    root.entries.push(rgdCreateEntry('target_filter', RgdDataType.Table, target, dict));

    const rgdPath = path.join(attrib, 'test.rgd');
    writeRgdFile(rgdPath, root, dict, 1);
    const rgd = readRgdFile(rgdPath, dict);

    const issues = validateRgdReferences(rgd.gameData, attrib);
    assert(!issues.some((i) => i.path && i.path.toLowerCase().startsWith('type_')),
        'internal type_* table references should not be reported as missing');
    assert(!issues.some((i) => i.kind === 'missing_file'),
        'only real file references should produce missing_file issues');
});
