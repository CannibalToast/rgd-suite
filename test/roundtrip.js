#!/usr/bin/env node
'use strict';

/**
 * RGD Suite — CLI roundtrip test
 * Builds synthetic RGD files, exercises every conversion path, then deletes all output.
 * Run: node test/roundtrip.js
 */

const path = require('path');
const fs   = require('fs');

const ROOT = path.join(__dirname, '..');
const DIST = path.join(ROOT, 'bundled', 'rgd-tools', 'dist');
const DICT_PATH = path.join(ROOT, 'dictionaries', 'RGD_DIC.TXT');

const { createDictionary, createAndLoadDictionaries, nameToHash } = require(path.join(DIST, 'dictionary'));
const { createTable, createEntry, buildRgd, writeRgdFile }        = require(path.join(DIST, 'writer'));
const { parseRgd, readRgdFile }                                   = require(path.join(DIST, 'reader'));
const { rgdToText, textToRgd, rgdToFlatMap }                      = require(path.join(DIST, 'textFormat'));
const { rgdToLua, rgdToLuaDifferential, luaToRgdResolved }        = require(path.join(DIST, 'luaFormat'));
const { RgdDataType }                                             = require(path.join(DIST, 'types'));

// ── Setup ──────────────────────────────────────────────────────────────────

const dict = createAndLoadDictionaries(fs.existsSync(DICT_PATH) ? [DICT_PATH] : []);
console.log(`Dictionary: ${dict.hashToName.size} entries`);

const created  = [];
let pass = 0, fail = 0;

function check(label, ok, detail) {
    const tag = ok ? '\x1b[32mPASS\x1b[0m' : '\x1b[31mFAIL\x1b[0m';
    const suffix = detail ? `  (${detail})` : '';
    console.log(`  [${tag}] ${label}${suffix}`);
    if (ok) pass++; else fail++;
}

function write(filePath, buf) {
    fs.writeFileSync(filePath, buf);
    created.push(filePath);
}

function flatCount(table) {
    let n = 0;
    const walk = t => { for (const e of t.entries) { n++; if (e.value && e.value.entries) walk(e.value); } };
    walk(table);
    return n;
}

// ── Build test table ───────────────────────────────────────────────────────
// Simple flat table simulating a unit attrib entry

const rootTable = createTable();
rootTable.entries.push(createEntry('unit_name',        RgdDataType.String,  'TestUnit',  dict));
rootTable.entries.push(createEntry('hp_max',           RgdDataType.Float,   100.0,       dict));
rootTable.entries.push(createEntry('cost_requisition', RgdDataType.Integer, 200,         dict));
rootTable.entries.push(createEntry('is_hero',          RgdDataType.Bool,    false,       dict));
rootTable.entries.push(createEntry('move_speed',       RgdDataType.Float,   4.5,         dict));

const nestedTable = createTable();
nestedTable.entries.push(createEntry('armor_front', RgdDataType.Float, 10.0, dict));
nestedTable.entries.push(createEntry('armor_rear',  RgdDataType.Float, 5.0,  dict));
rootTable.entries.push(createEntry('armor', RgdDataType.Table, nestedTable, dict));

const EXPECTED_FLAT = flatCount(rootTable);

// ── Paths ──────────────────────────────────────────────────────────────────

const P = {
    rgd:          path.join(__dirname, '_test.rgd'),
    txt:          path.join(__dirname, '_test.rgd.txt'),
    rgdFromTxt:   path.join(__dirname, '_test.fromtext.rgd'),
    lua:          path.join(__dirname, '_test.lua'),
    luaSimple:    path.join(__dirname, '_test.simple.lua'),
    rgdFromLua:   path.join(__dirname, '_test.fromlua.rgd'),
};

// ── Run ────────────────────────────────────────────────────────────────────

async function main() {
    console.log('\n\x1b[1m=== RGD Suite v1.1.1 — Roundtrip Test ===\x1b[0m\n');

    // 1. Write binary RGD
    try {
        writeRgdFile(P.rgd, rootTable, dict, 1);
        created.push(P.rgd);
        const stat = fs.statSync(P.rgd);
        check('Write binary RGD', stat.size > 0, `${stat.size} bytes`);
    } catch (e) { check('Write binary RGD', false, e.message); }

    // 2. Read back and validate header
    let rgdFile;
    try {
        rgdFile = readRgdFile(P.rgd, dict);
        const ok = rgdFile.header.version === 1 && rgdFile.gameData.entries.length > 0;
        check('Read back RGD', ok, `v${rgdFile.header.version}, ${rgdFile.gameData.entries.length} top-level entries`);
    } catch (e) { check('Read back RGD', false, e.message); return; }

    // 3. RGD → Text
    let textContent;
    try {
        textContent = rgdToText(rgdFile, '_test.rgd');
        write(P.txt, Buffer.from(textContent, 'utf8'));
        check('RGD → Text', textContent.includes('GameData') && textContent.includes('unit_name'), `${textContent.length} chars`);
    } catch (e) { check('RGD → Text', false, e.message); }

    // 4. Text → RGD roundtrip
    try {
        const { gameData: rt, version: rtV } = textToRgd(textContent, dict);
        writeRgdFile(P.rgdFromTxt, rt, dict, rtV);
        created.push(P.rgdFromTxt);
        const rtFlat = flatCount(rt);
        check('Text → RGD roundtrip', rtFlat === EXPECTED_FLAT, `${rtFlat}/${EXPECTED_FLAT} entries`);
    } catch (e) { check('Text → RGD roundtrip', false, e.message); }

    // 5. Flat key count via rgdToFlatMap (leaf values only — table containers are not counted)
    try {
        const flatMap = rgdToFlatMap(rgdFile.gameData);
        const EXPECTED_LEAF = EXPECTED_FLAT - 1; // subtract the 'armor' table container
        check('rgdToFlatMap', flatMap.size === EXPECTED_LEAF, `${flatMap.size} leaf keys`);
    } catch (e) { check('rgdToFlatMap', false, e.message); }

    // 6. RGD → Lua (simple full dump)
    let luaSimple;
    try {
        luaSimple = rgdToLua(rgdFile, '_test.rgd');
        write(P.luaSimple, Buffer.from(luaSimple, 'utf8'));
        check('RGD → Lua (simple)', luaSimple.includes('GameData') && luaSimple.includes('unit_name'), `${luaSimple.length} chars`);
    } catch (e) { check('RGD → Lua (simple)', false, e.message); }

    // 7. RGD → Lua (differential, no parent)
    let luaDiff;
    try {
        luaDiff = await rgdToLuaDifferential(rgdFile);
        write(P.lua, Buffer.from(luaDiff, 'utf8'));
        check('RGD → Lua (differential)', luaDiff.includes('GameData'), `${luaDiff.length} chars`);
    } catch (e) { check('RGD → Lua (differential)', false, e.message); }

    // 8. Lua → RGD roundtrip
    try {
        const luaCode = fs.readFileSync(P.lua, 'utf8');
        const { gameData: lt, version: ltV } = await luaToRgdResolved(luaCode, dict, async () => null);
        writeRgdFile(P.rgdFromLua, lt, dict, ltV);
        created.push(P.rgdFromLua);
        const ltFlat = flatCount(lt);
        check('Lua → RGD roundtrip', ltFlat === EXPECTED_FLAT, `${ltFlat}/${EXPECTED_FLAT} entries`);
    } catch (e) { check('Lua → RGD roundtrip', false, e.message); }

    // 9. Binary identity check (text roundtrip)
    try {
        const orig = fs.readFileSync(P.rgd);
        const rt   = fs.readFileSync(P.rgdFromTxt);
        check('Binary identity (text roundtrip)', orig.equals(rt), orig.equals(rt) ? 'identical' : `${orig.length} vs ${rt.length} bytes`);
    } catch (e) { check('Binary identity (text roundtrip)', false, e.message); }

    // ── Summary ───────────────────────────────────────────────────────────

    console.log(`\n  Results : ${pass} pass, ${fail} fail`);
    console.log(`  Created : ${created.length} file(s)`);
    created.forEach(f => console.log(`    + ${path.relative(ROOT, f)}`));

    // ── Cleanup ───────────────────────────────────────────────────────────

    let deleted = 0;
    for (const f of created) {
        try { fs.unlinkSync(f); deleted++; } catch (e) { console.error(`  Could not delete ${f}: ${e.message}`); }
    }
    console.log(`  Deleted : ${deleted} file(s)`);
    console.log('\n\x1b[1m=== Done ===\x1b[0m\n');

    process.exit(fail > 0 ? 1 : 0);
}

main().catch(e => { console.error('\nFatal:', e); process.exit(1); });
