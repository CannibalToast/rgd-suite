'use strict';
const assert = require('assert');
const fs = require('fs');
const os = require('os');
const path = require('path');

const ROOT = path.join(__dirname, '..');
const DIST = path.join(ROOT, 'bundled', 'rgd-tools', 'dist');
const { createAndLoadDictionaries } = require(path.join(DIST, 'dictionary'));
const { readRgdFile, parseRgd } = require(path.join(DIST, 'reader'));
const { createTable, createEntry, buildRgd } = require(path.join(DIST, 'writer'));
const { rgdToLua, parseLuaToTable, luaToRgdResolved } = require(path.join(DIST, 'luaFormat'));
const { RgdDataType } = require(path.join(DIST, 'types'));

const { walkFiles } = require('../cli/fileWalk');
const { createAttribLoaders } = require('../cli/attribLoaders');
const { loadTs } = require('./load-ts');

const { collectFilesAsync } = loadTs('src/attribUtils.ts');

const dict = createAndLoadDictionaries([path.join(ROOT, 'dictionaries', 'RGD_DIC.TXT')]);

const tests = [];
function test(name, fn) {
    tests.push({ name, fn });
}

function makeTree() {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'rgd-walk-'));
    fs.writeFileSync(path.join(root, 'a.lua'), 'a');
    fs.writeFileSync(path.join(root, 'b.rgd'), 'b');
    fs.writeFileSync(path.join(root, 'c.RGD'), 'c');
    fs.writeFileSync(path.join(root, 'd.rgd.txt'), 'd');
    fs.writeFileSync(path.join(root, 'e.txt'), 'e');
    fs.mkdirSync(path.join(root, 'sub'));
    fs.writeFileSync(path.join(root, 'sub', 'f.lua'), 'f');
    fs.writeFileSync(path.join(root, 'sub', 'g.rgd'), 'g');
    fs.mkdirSync(path.join(root, 'locked'));
    fs.writeFileSync(path.join(root, 'locked', 'h.lua'), 'h');
    return root;
}

function referenceWalkOrder(dir) {
    const out = [];
    const stack = [dir];
    while (stack.length) {
        const d = stack.pop();
        let entries;
        try {
            entries = fs.readdirSync(d, { withFileTypes: true });
        } catch {
            continue;
        }
        for (const e of entries) {
            const full = path.join(d, e.name);
            if (e.isDirectory()) stack.push(full);
            else if (e.isFile()) out.push(full);
        }
    }
    return out;
}

function withPatchedReaddir(fn, denyDir) {
    const orig = fs.promises.readdir;
    let calls = 0;
    fs.promises.readdir = async (dir, opts) => {
        calls++;
        if (denyDir && path.basename(String(dir)) === denyDir) {
            const err = new Error('denied');
            err.code = 'EACCES';
            throw err;
        }
        return orig(dir, opts);
    };
    return Promise.resolve()
        .then(fn)
        .finally(() => { fs.promises.readdir = orig; })
        .then((result) => ({ result, calls }));
}

test('walkFiles matches nested mixed-case extensions case-insensitively', async () => {
    const root = makeTree();
    try {
        const rgd = await walkFiles(root, ['.rgd']);
        assert(rgd.some((f) => f.endsWith('c.RGD')), 'uppercase .RGD must match .rgd');
        const lua = await walkFiles(root, ['.lua']);
        assert(lua.some((f) => f.endsWith(path.join('sub', 'f.lua'))));
    } finally {
        fs.rmSync(root, { recursive: true, force: true });
    }
});

test('extension arguments are used verbatim against lowercased filenames', async () => {
    const root = makeTree();
    try {
        assert.deepStrictEqual(await walkFiles(root, ['.RGD']), []);
        assert.deepStrictEqual(await collectFilesAsync(root, '.RGD'), []);
        assert.deepStrictEqual(await collectFilesAsync(root, ['.RGD']), []);
        assert(
            (await collectFilesAsync(root, '.rgd')).some((f) => f.endsWith('c.RGD')),
            'lowercase .rgd still matches uppercase filename',
        );
    } finally {
        fs.rmSync(root, { recursive: true, force: true });
    }
});

test('grouped output equals ordered concatenation of single-extension walks', async () => {
    const root = makeTree();
    try {
        const grouped = await walkFiles(root, ['.lua', '.rgd'], { grouped: true });
        const luaOnly = await walkFiles(root, ['.lua']);
        const rgdOnly = await walkFiles(root, ['.rgd']);
        assert.deepStrictEqual(grouped, luaOnly.concat(rgdOnly));
    } finally {
        fs.rmSync(root, { recursive: true, force: true });
    }
});

test('grouped overlapping suffixes retain duplicates', async () => {
    const root = makeTree();
    try {
        const grouped = await walkFiles(root, ['.txt', '.rgd.txt'], { grouped: true });
        const txt = grouped.filter((f) => f.endsWith('d.rgd.txt'));
        assert.strictEqual(txt.length, 2, 'file matching two extensions appears in both buckets');
    } finally {
        fs.rmSync(root, { recursive: true, force: true });
    }
});

test('ungrouped order is the natural single-walk order', async () => {
    const root = makeTree();
    try {
        const files = await walkFiles(root, ['.lua', '.rgd', '.rgd.txt']);
        const exts = ['.lua', '.rgd', '.rgd.txt'];
        const expected = referenceWalkOrder(root).filter((f) =>
            exts.some((e) => f.toLowerCase().endsWith(e)));
        assert.deepStrictEqual(files, expected);
    } finally {
        fs.rmSync(root, { recursive: true, force: true });
    }
});

test('unreadable directories are skipped and grouped walking does one traversal', async () => {
    const root = makeTree();
    try {
        const { result: grouped, calls: groupedCalls } = await withPatchedReaddir(
            () => walkFiles(root, ['.lua', '.rgd', '.rgd.txt'], { grouped: true }),
            'locked',
        );
        assert(!grouped.some((f) => f.includes('locked')), 'unreadable dir contents skipped');
        const dirCount = 3;
        assert.strictEqual(groupedCalls, dirCount, `expected ${dirCount} readdir calls, got ${groupedCalls}`);

        const { calls: ungroupedCalls } = await withPatchedReaddir(
            () => walkFiles(root, ['.lua']),
            'locked',
        );
        assert.strictEqual(ungroupedCalls, dirCount);
    } finally {
        fs.rmSync(root, { recursive: true, force: true });
    }
});

function cliTools() {
    return { readRgdFile, rgdToLua, parseLuaToTable, luaToRgdResolved };
}

function workerTools(reads) {
    return {
        readRgdFile: (file, d) => { reads.push(file); return parseRgd(fs.readFileSync(file), d); },
        rgdToLua,
        parseLuaToTable,
        luaToRgdResolved,
    };
}

function writeBinaryRgd(file, label) {
    const table = createTable();
    table.entries.push(createEntry('unit_name', RgdDataType.String, label, dict));
    fs.writeFileSync(file, buildRgd(table, dict, 1));
}

test('loader prefers .lua over .rgd and strips BOM from the file on disk', () => {
    const attrib = fs.mkdtempSync(path.join(os.tmpdir(), 'rgd-loader-'));
    try {
        const bom = Buffer.concat([Buffer.from([0xef, 0xbb, 0xbf]), Buffer.from('GameData = Inherit([[]])\n')]);
        fs.writeFileSync(path.join(attrib, 'both.lua'), bom);
        writeBinaryRgd(path.join(attrib, 'both.rgd'), 'RGD_SIDE');
        const loader = createAttribLoaders(cliTools(), dict).makeLuaFileLoader(attrib);
        const text = loader('both');
        assert(text.includes('Inherit'), 'expected Lua text, got: ' + text);
        assert.strictEqual(fs.readFileSync(path.join(attrib, 'both.lua'))[0], 'G'.charCodeAt(0),
            'BOM must be stripped from the file in place');
    } finally {
        fs.rmSync(attrib, { recursive: true, force: true });
    }
});

test('loader propagates supplied codec/dictionary and rereads .rgd fallbacks', () => {
    const attrib = fs.mkdtempSync(path.join(os.tmpdir(), 'rgd-loader-rgd-'));
    try {
        writeBinaryRgd(path.join(attrib, 'only_rgd.rgd'), 'RGD1');
        const reads = [];
        let seenDict = null;
        const tools = workerTools(reads);
        const wrapped = {
            ...tools,
            readRgdFile: (file, d) => { seenDict = d; return tools.readRgdFile(file, d); },
        };
        const loader = createAttribLoaders(wrapped, dict).makeLuaFileLoader(attrib);
        const first = loader('only_rgd');
        assert(first.includes('RGD1'));
        assert.strictEqual(seenDict, dict, 'dict must be propagated to readRgdFile');
        assert.strictEqual(reads.length, 1);

        writeBinaryRgd(path.join(attrib, 'only_rgd.rgd'), 'RGD2');
        const second = loader('only_rgd');
        assert(second.includes('RGD2'), '.rgd fallback must be re-read, not memoized');
        assert.strictEqual(reads.length, 2);
    } finally {
        fs.rmSync(attrib, { recursive: true, force: true });
    }
});

test('finite cache refreshes on hit and evicts oldest at the limit', () => {
    const attrib = fs.mkdtempSync(path.join(os.tmpdir(), 'rgd-loader-lru-'));
    try {
        for (const name of ['a', 'b', 'c']) {
            fs.writeFileSync(path.join(attrib, `${name}.lua`), `GameData["tag"] = "${name.toUpperCase()}1"\n`);
        }
        const loader = createAttribLoaders(cliTools(), dict, { cacheLimit: 2 }).makeLuaFileLoader(attrib);
        assert(loader('a').includes('A1'));
        assert(loader('b').includes('B1'));
        assert(loader('a').includes('A1'), 'hit refreshes recency');
        fs.writeFileSync(path.join(attrib, 'b.lua'), 'GameData["tag"] = "B2"\n');
        fs.writeFileSync(path.join(attrib, 'a.lua'), 'GameData["tag"] = "A2"\n');
        loader('c');
        assert(loader('a').includes('A1'), 'refreshed entry survives eviction');
        assert(loader('b').includes('B2'), 'evicted entry re-reads from disk');
    } finally {
        fs.rmSync(attrib, { recursive: true, force: true });
    }
});

test('unlimited cache never evicts and serves stale content', () => {
    const attrib = fs.mkdtempSync(path.join(os.tmpdir(), 'rgd-loader-unlim-'));
    try {
        const file = path.join(attrib, 'keep.lua');
        fs.writeFileSync(file, 'GameData["tag"] = "ORIGINAL"\n');
        const loader = createAttribLoaders(cliTools(), dict).makeLuaFileLoader(attrib);
        assert(loader('keep').includes('ORIGINAL'));
        for (let i = 0; i < 600; i++) {
            fs.writeFileSync(path.join(attrib, `pad${i}.lua`), `GameData["tag"] = "PAD${i}"\n`);
            loader(`pad${i}`);
        }
        fs.writeFileSync(file, 'GameData["tag"] = "UPDATED"\n');
        assert(loader('keep').includes('ORIGINAL'), 'unbounded cache still serves the first read');
    } finally {
        fs.rmSync(attrib, { recursive: true, force: true });
    }
});

test('loader returns null for missing, .nil, and traversal references', () => {
    const attrib = fs.mkdtempSync(path.join(os.tmpdir(), 'rgd-loader-null-'));
    try {
        const loader = createAttribLoaders(cliTools(), dict).makeLuaFileLoader(attrib);
        assert.strictEqual(loader('missing_file'), null);
        assert.strictEqual(loader('sentinel.nil'), null);
        assert.strictEqual(loader('../escape.lua'), null);
        assert.strictEqual(createAttribLoaders(cliTools(), dict).makeLuaFileLoader(null)('anything'), null);
    } finally {
        fs.rmSync(attrib, { recursive: true, force: true });
    }
});

async function main() {
    for (const { name, fn } of tests) {
        try {
            await fn();
            console.log(`PASS ${name}`);
        } catch (err) {
            console.error(`FAIL ${name}`);
            console.error(err.stack || err.message);
            process.exitCode = 1;
        }
    }
    if (process.exitCode) return;
    console.log('consolidation tests complete');
}

main().catch((e) => { console.error(e.stack); process.exitCode = 1; });
