#!/usr/bin/env node
'use strict';

const assert = require('assert');
const childProcess = require('child_process');
const fs = require('fs');
const os = require('os');
const path = require('path');

const ROOT = path.join(__dirname, '..');
const DIST = path.join(ROOT, 'bundled', 'rgd-tools', 'dist');
const CLI = path.join(ROOT, 'cli', 'rgd-cli.js');
const DICT_PATH = path.join(ROOT, 'dictionaries', 'RGD_DIC.TXT');

const { createAndLoadDictionaries } = require(path.join(DIST, 'dictionary'));
const { createTable, createEntry, writeRgdFile } = require(path.join(DIST, 'writer'));
const { RgdDataType } = require(path.join(DIST, 'types'));

const dict = createAndLoadDictionaries(fs.existsSync(DICT_PATH) ? [DICT_PATH] : []);

function run(args, options = {}) {
    return childProcess.spawnSync(process.execPath, [CLI, ...args], {
        encoding: 'utf8',
        ...options,
    });
}

function makeFixture() {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'rgd-cli-parity-'));
    const attrib = path.join(root, 'data', 'attrib');
    const folder = path.join(attrib, 'ebps', 'races', 'test');
    fs.mkdirSync(folder, { recursive: true });

    const table = createTable();
    table.entries.push(createEntry('screen_name_id', RgdDataType.String, 'ParityUnit', dict));
    table.entries.push(createEntry('hitpoints', RgdDataType.Float, 100, dict));
    const rgd = path.join(folder, 'unit.rgd');
    const lua = path.join(folder, 'unit.lua');
    writeRgdFile(rgd, table, dict, 1);
    fs.writeFileSync(lua, [
        'GameData = Inherit([[]])',
        'GameData["screen_name_id"] = [[ParityUnit]]',
        'GameData["hitpoints"] = 100',
        '',
    ].join('\n'), 'utf8');

    return { root, attrib, folder, rgd, lua };
}

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

test('parity command returns agent-friendly JSON for a matching RGD/Lua pair', () => {
    const fixture = makeFixture();
    const res = run(['parity', fixture.rgd, '--format', 'json', '--attrib', fixture.attrib]);
    assert.strictEqual(res.status, 0, res.stderr);
    const parsed = JSON.parse(res.stdout);
    assert.strictEqual(parsed.ok, true);
    assert.strictEqual(parsed.summary.failed, 0);
    assert.strictEqual(parsed.results[0].issues.length, 0);
    assert.strictEqual(parsed.results[0].validationIssues.length, 0);
});

test('parity command accepts Lua input and reports mismatches as non-zero', () => {
    const fixture = makeFixture();
    fs.appendFileSync(fixture.lua, 'GameData["hitpoints"] = 75\n', 'utf8');
    const res = run(['parity', fixture.lua, '--format', 'json', '--attrib', fixture.attrib]);
    assert.strictEqual(res.status, 1);
    const parsed = JSON.parse(res.stdout);
    assert.strictEqual(parsed.ok, false);
    assert.strictEqual(parsed.summary.failed, 1);
    assert(parsed.results[0].issues.some((issue) => issue.kind === 'value_mismatch'));
});

test('parity-batch checks a folder and strips UTF-8 BOMs automatically', () => {
    const fixture = makeFixture();
    const bomLua = path.join(fixture.folder, 'bom.lua');
    const bomRgd = path.join(fixture.folder, 'bom.rgd');
    fs.copyFileSync(fixture.rgd, bomRgd);
    fs.writeFileSync(bomLua, Buffer.concat([
        Buffer.from([0xef, 0xbb, 0xbf]),
        Buffer.from('GameData = Inherit([[]])\nGameData["screen_name_id"] = [[ParityUnit]]\nGameData["hitpoints"] = 100\n', 'utf8'),
    ]));

    const res = run(['parity-batch', fixture.folder, '--format', 'json', '--attrib', fixture.attrib]);
    assert.strictEqual(res.status, 0, res.stderr || res.stdout);
    const parsed = JSON.parse(res.stdout);
    assert.strictEqual(parsed.summary.checked, 2);
    assert.strictEqual(parsed.summary.validationIssues, 0);
    assert.strictEqual(parsed.summary.fixes, 1);
    assert.strictEqual(fs.readFileSync(bomLua)[0], 'G'.charCodeAt(0));
});

test('validate command checks folders and reports path/encoding/reference issues as JSON', () => {
    const fixture = makeFixture();
    fs.writeFileSync(path.join(fixture.folder, 'encoded.lua'), Buffer.from([0xef, 0xbb, 0xbf, 0x47, 0x61, 0x6d, 0x65]));
    fs.writeFileSync(path.join(fixture.folder, 'badref.lua'), 'GameData = Inherit([[../escape.lua]])\n', 'utf8');

    const res = run(['validate', fixture.folder, '--format', 'json', '--attrib', fixture.attrib]);
    assert.strictEqual(res.status, 1);
    const parsed = JSON.parse(res.stdout);
    assert.strictEqual(parsed.ok, false);
    assert(parsed.summary.validationIssues >= 1);
    assert.strictEqual(parsed.summary.fixes, 1);
    assert(!parsed.results.some((result) => result.validationIssues.some((issue) => issue.kind === 'bom_detected')));
    assert(parsed.results.some((result) => result.validationIssues.some((issue) => issue.kind === 'path_traversal')));
});
