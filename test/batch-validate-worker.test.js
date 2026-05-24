#!/usr/bin/env node
'use strict';

const assert = require('assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { Worker } = require('worker_threads');

const ROOT = path.join(__dirname, '..');
const DIST = path.join(ROOT, 'bundled', 'rgd-tools', 'dist');
const DICT_PATH = path.join(ROOT, 'dictionaries', 'RGD_DIC.TXT');
const WORKER = path.join(ROOT, 'workers', 'validation-worker.js');

function test(name, fn) {
    Promise.resolve()
        .then(fn)
        .then(() => console.log(`PASS ${name}`))
        .catch((err) => {
            console.error(`FAIL ${name}`);
            console.error(err.stack || err.message);
            process.exitCode = 1;
        });
}

function makeFixture() {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'rgd-validation-worker-'));
    const attrib = path.join(root, 'data', 'attrib');
    const folder = path.join(attrib, 'ebps', 'races', 'test');
    fs.mkdirSync(folder, { recursive: true });
    return { root, attrib, folder };
}

function runWorker(filePath, attribBase) {
    return new Promise((resolve, reject) => {
        const worker = new Worker(WORKER, {
            workerData: {
                distPath: DIST,
                dictPaths: fs.existsSync(DICT_PATH) ? [DICT_PATH] : [],
            },
        });
        worker.once('message', (message) => {
            worker.terminate();
            if (message.error) reject(new Error(message.error));
            else resolve(message.result);
        });
        worker.once('error', reject);
        worker.postMessage({ id: 1, filePath, attribBase });
    });
}

test('validation worker strips UTF-8 BOMs and reports fixes', async () => {
    const fixture = makeFixture();
    const lua = path.join(fixture.folder, 'bom.lua');
    fs.writeFileSync(lua, Buffer.concat([
        Buffer.from([0xef, 0xbb, 0xbf]),
        Buffer.from('GameData = Inherit([[]])\n', 'utf8'),
    ]));

    const result = await runWorker(lua, fixture.attrib);

    assert.strictEqual(result.filePath, lua);
    assert(result.fixes.some((fix) => fix.kind === 'bom_stripped'), 'expected bom_stripped fix');
    assert.strictEqual(fs.readFileSync(lua)[0], 'G'.charCodeAt(0));
});

test('validation worker reports unsafe Lua references as issues', async () => {
    const fixture = makeFixture();
    const lua = path.join(fixture.folder, 'badref.lua');
    fs.writeFileSync(lua, 'GameData = Inherit([[../escape.lua]])\n', 'utf8');

    const result = await runWorker(lua, fixture.attrib);

    assert(result.issues.some((issue) => issue.kind === 'path_traversal'), 'expected path_traversal issue');
});

test('validation worker accepts nil sentinel inherit references', async () => {
    const fixture = makeFixture();
    const lua = path.join(fixture.folder, 'nilinherit.lua');
    fs.writeFileSync(lua, [
        'GameData = Inherit([[ebps/races/test/root.nil]])',
        'GameData["child"] = Inherit([[ebps/races/test/child.NIL]])',
        '',
    ].join('\n'), 'utf8');

    const result = await runWorker(lua, fixture.attrib);

    assert(!result.issues.some((issue) => issue.kind === 'missing_file'), 'nil sentinel refs should not report missing_file');
});
