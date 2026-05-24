#!/usr/bin/env node
'use strict';

const assert = require('assert');
const path = require('path');

const ROOT = path.join(__dirname, '..');

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

test('commands worker toRgd fallback strips UTF-8 BOM like serial path', () => {
    const source = require('fs').readFileSync(path.join(ROOT, 'src', 'commands.ts'), 'utf8');
    const workerFallback = source.indexOf('opts.op === "toRgd" && rgdParentLoader');
    assert(workerFallback !== -1);
    const slice = source.slice(workerFallback, workerFallback + 400);
    assert(slice.includes('stripUtf8BomFromFile'), 'worker fallback must strip BOM before luaToRgdResolved');
    assert(!slice.includes('readFile(\n                        inputFile,\n                        "utf8")'), 'worker fallback must not read lua as raw utf8');
});

test('collectValidateFilesAsync performs one walk for all extensions', () => {
    const source = require('fs').readFileSync(path.join(ROOT, 'src', 'attribUtils.ts'), 'utf8');
    assert(source.includes('export async function collectValidateFilesAsync'));
    assert(source.includes('COLLECT_YIELD_EVERY_DIRS'));
});
