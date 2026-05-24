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
