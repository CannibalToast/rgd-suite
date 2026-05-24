#!/usr/bin/env node
'use strict';

const assert = require('assert');
const fs = require('fs');
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

test('batch validate uses progress, output channel, per-file errors, and event-loop yields', () => {
    const source = fs.readFileSync(path.join(ROOT, 'src', 'cliCommands.ts'), 'utf8');
    const batchStart = source.indexOf('"rgd.batchValidate"');
    assert(batchStart !== -1, 'rgd.batchValidate command is missing');
    const batchSource = source.slice(batchStart);

    assert(batchSource.includes('vscode.window.withProgress'), 'batch validation must show cancellable progress');
    assert(batchSource.includes('createOutputChannel("RGD Validation")'), 'batch validation must write details to an output channel');
    assert(batchSource.includes('out.appendLine'), 'batch validation must append detailed results outside toast notifications');
    assert(batchSource.includes('catch (fileError)'), 'batch validation must catch per-file failures');
    assert(batchSource.includes('setImmediate'), 'batch validation must yield so the extension host stays responsive');
});

test('batch validate uses a worker pool for heavy per-file validation', () => {
    const source = fs.readFileSync(path.join(ROOT, 'src', 'cliCommands.ts'), 'utf8');
    const batchStart = source.indexOf('"rgd.batchValidate"');
    assert(batchStart !== -1, 'rgd.batchValidate command is missing');
    const batchSource = source.slice(batchStart);

    assert(batchSource.includes('ValidationWorkerPool'), 'batch validation must use a validation worker pool');
    assert(batchSource.includes('validation-worker.js'), 'batch validation must load the validation worker script');
    assert(batchSource.includes('pool.start()'), 'batch validation must start the worker pool');
    assert(batchSource.includes('.validate(file, attribBase)'), 'batch validation must dispatch validation jobs to workers');
    assert(batchSource.includes('scheduleBatched'), 'batch validation must use bounded concurrent scheduling');
    assert(batchSource.includes('collectValidateFilesAsync'), 'batch validation must use a single directory walk');
    assert(batchSource.includes('pool.dispose()'), 'batch validation must dispose worker threads');
    assert(batchSource.includes('pool.cancel()'), 'batch validation must cancel queued worker jobs');
});

test('validation worker contains BOM fixing and reference validation logic', () => {
    const source = fs.readFileSync(path.join(ROOT, 'workers', 'validation-worker.js'), 'utf8');

    assert(source.includes('stripUtf8BomFromFile'), 'validation worker must strip UTF-8 BOMs');
    assert(source.includes('bom_stripped'), 'validation worker must report BOM fixes');
    assert(source.includes('makeLuaFileLoader'), 'validation worker must resolve Lua inherit/reference files');
    assert(source.includes('validateLuaReferences'), 'validation worker must validate Lua references');
    assert(source.includes('validateRgdReferences'), 'validation worker must validate RGD references');
});

test('extension activation log uses package version instead of a hardcoded version', () => {
    const source = fs.readFileSync(path.join(ROOT, 'src', 'extension.ts'), 'utf8');
    assert(!source.includes('RGD Suite v1.2.0 is now active'), 'activation log must not hardcode the old version');
    assert(source.includes('context.extension.packageJSON.version'), 'activation log must read the package version');
});

test('extension defers dictionary load and heavy subsystems on activate', () => {
    const source = fs.readFileSync(path.join(ROOT, 'src', 'extension.ts'), 'utf8');
    assert(!source.includes('getDictionary(context)'), 'activate must not eagerly load the hash dictionary');
    assert(source.includes('import("./cliCommands")'), 'CLI commands must be registered via dynamic import');
    assert(source.includes('import("./parityChecker")'), 'parity commands must be registered via dynamic import');
});

test('batch validate throttles output channel logging', () => {
    const source = fs.readFileSync(path.join(ROOT, 'src', 'cliCommands.ts'), 'utf8');
    const batchStart = source.indexOf('"rgd.batchValidate"');
    const batchSource = source.slice(batchStart);
    assert(batchSource.includes('setInterval'), 'batch validation should emit periodic throughput lines');
    assert(batchSource.includes('logIssuesAt'), 'batch validation should throttle per-file issue logging');
});

test('validateInProcess uses case-insensitive extension checks like worker', () => {
    const source = fs.readFileSync(path.join(ROOT, 'src', 'cliCommands.ts'), 'utf8');
    const fnStart = source.indexOf('const validateInProcess =');
    assert(fnStart !== -1, 'validateInProcess is missing');
    const fnEnd = source.indexOf('let completed = 0;', fnStart);
    const fnSource = source.slice(fnStart, fnEnd === -1 ? fnStart + 1200 : fnEnd);
    assert(fnSource.includes('const lower = file.toLowerCase()'), 'validateInProcess must lowercase path');
    assert(fnSource.includes('lower.endsWith(".lua")'), 'validateInProcess must match .lua case-insensitively');
    assert(fnSource.includes('lower.endsWith(".rgd.txt")'), 'validateInProcess must match .rgd.txt case-insensitively');
    assert(fnSource.includes('lower.endsWith(".rgd")'), 'validateInProcess must match .rgd case-insensitively');
    assert(!fnSource.includes('file.endsWith(".lua")'), 'validateInProcess must not use case-sensitive file.endsWith');
});
