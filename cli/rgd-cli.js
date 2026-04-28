#!/usr/bin/env node
'use strict';
/**
 * rgd-cli.js — Standalone CLI wrapper around bundled/rgd-tools.
 *
 * This is a thin shim that works around the commander.js version-option
 * clash in the upstream bundled CLI, adds sensible defaults for Dawn of War
 * modding paths, and exposes every operation as a flat sub-command so a
 * PowerShell module can alias them cleanly.
 */
const fs = require('fs');
const path = require('path');

const dist = path.join(__dirname, '..', 'bundled', 'rgd-tools', 'dist');

const { createAndLoadDictionaries } = require(path.join(dist, 'dictionary.js'));
const { readRgdFile, parseRgd }       = require(path.join(dist, 'reader.js'));
const { writeRgdFile }                = require(path.join(dist, 'writer.js'));
const { rgdToText, textToRgd }        = require(path.join(dist, 'textFormat.js'));
const { rgdToLua, rgdToLuaDifferential, luaToRgdResolved, parseLuaToTable } = require(path.join(dist, 'luaFormat.js'));
const { hash, hashToHex }             = require(path.join(dist, 'hash.js'));
const { openSgaArchive }              = require(path.join(dist, 'sga.js'));
const { RgdDataType }                 = require(path.join(dist, 'types.js'));

// ── Dictionary ───────────────────────────────────────────────────────────

function findDictionaries(extraPaths) {
    const candidates = [];
    if (extraPaths) {
        for (const p of extraPaths.split(path.delimiter)) {
            if (fs.existsSync(p)) candidates.push(p);
        }
    }
    // Common modding locations
    const envPaths = [
        process.env.RGD_SUITE_DICT,
        path.join(process.env.LOCALAPPDATA || '', 'RGD Suite', 'dictionaries'),
        path.join(process.env.USERPROFILE || '', '.rgd-tools', 'dictionaries'),
        './rgd_dic.txt',
        './dictionaries',
    ];
    for (const p of envPaths) {
        if (p && fs.existsSync(p)) candidates.push(p);
    }
    return candidates;
}

function getDict(argv) {
    const dictFlag = argv.find(a => a === '-d' || a === '--dictionary');
    const idx = dictFlag ? argv.indexOf(dictFlag) : -1;
    const extra = idx !== -1 && argv[idx + 1] ? argv[idx + 1] : process.env.RGD_SUITE_DICT;
    return createAndLoadDictionaries(findDictionaries(extra));
}

// ── Attrib-base discovery (mirrors src/attribUtils.ts) ───────────────────

function findAttribBase(filePath) {
    const normalized = filePath.replace(/\\/g, '/').toLowerCase();
    const idx = normalized.lastIndexOf('/attrib/');
    if (idx !== -1) return filePath.substring(0, idx + 7);
    let dir = path.dirname(filePath);
    for (let d = 0; d < 15; d++) {
        const da = path.join(dir, 'data', 'attrib');
        const a  = path.join(dir, 'attrib');
        if (fs.existsSync(da)) return da;
        if (fs.existsSync(a))  return a;
        const parent = path.dirname(dir);
        if (parent === dir) break;
        dir = parent;
    }
    return null;
}

// ── Lua / RGD parent loaders ───────────────────────────────────────────

function makeLuaFileLoader(attribBase, dict) {
    return function loader(refPath) {
        if (!attribBase) return null;
        let clean = refPath.replace(/\\/g, '/');
        if (clean.endsWith('.lua')) clean = clean.slice(0, -4);
        const luaPath = path.join(attribBase, clean + '.lua');
        if (fs.existsSync(luaPath)) return fs.readFileSync(luaPath, 'utf8');
        const rgdPath = path.join(attribBase, clean + '.rgd');
        if (fs.existsSync(rgdPath)) return rgdToLua(readRgdFile(rgdPath, dict));
        return null;
    };
}

function makeParentLoader(attribBase, dict) {
    const fileLoader = makeLuaFileLoader(attribBase, dict);
    return async (refPath) => {
        const code = fileLoader(refPath);
        return code ? parseLuaToTable(code, fileLoader) : null;
    };
}

function makeRgdParentLoader(attribBase, dict) {
    const self = async (refPath) => {
        if (!attribBase) return null;
        let clean = refPath.replace(/\\/g, '/');
        if (clean.endsWith('.lua')) clean = clean.slice(0, -4);
        const rgdPath = path.join(attribBase, clean + '.rgd');
        if (fs.existsSync(rgdPath)) return readRgdFile(rgdPath, dict).gameData;
        const luaPath = path.join(attribBase, clean + '.lua');
        if (fs.existsSync(luaPath)) {
            const code = fs.readFileSync(luaPath, 'utf8');
            const { gameData } = await luaToRgdResolved(code, dict, self);
            return gameData;
        }
        return null;
    };
    return self;
}

// ── Commands ─────────────────────────────────────────────────────────────

const COMMANDS = {
    async 'to-text'(argv) {
        const [input] = argv;
        if (!input) { console.error('Usage: rgd to-text <input.rgd> [-o output.txt]'); process.exit(1); }
        const dict = getDict(argv);
        const rgd = readRgdFile(input, dict);
        const text = rgdToText(rgd, path.basename(input), null);
        const out = argv.find((a, i) => (a === '-o' || a === '--output') && argv[i + 1]) ? argv[argv.indexOf(argv.find(a => a === '-o' || a === '--output')) + 1] : input + '.txt';
        fs.writeFileSync(out, text, 'utf8');
        console.log(out);
    },

    async 'from-text'(argv) {
        const [input] = argv;
        if (!input) { console.error('Usage: rgd from-text <input.rgd.txt> [-o output.rgd] [--version 1|3]'); process.exit(1); }
        const dict = getDict(argv);
        const text = fs.readFileSync(input, 'utf8');
        const { gameData, version } = textToRgd(text, dict);
        const vIdx = argv.indexOf('--version');
        const out = argv.find((a, i) => (a === '-o' || a === '--output') && argv[i + 1]) ? argv[argv.indexOf(argv.find(a => a === '-o' || a === '--output')) + 1] : input.replace(/\.txt$/i, '');
        const finalVersion = vIdx !== -1 ? parseInt(argv[vIdx + 1], 10) : version;
        writeRgdFile(out, gameData, dict, finalVersion);
        console.log(out);
    },

    async 'to-lua'(argv) {
        const [input] = argv;
        if (!input) { console.error('Usage: rgd to-lua <input.rgd> [-o output.lua] [-a attribBase]'); process.exit(1); }
        const dict = getDict(argv);
        const rgd = readRgdFile(input, dict);
        let attribBase = argv.find((a, i) => (a === '-a' || a === '--attrib') && argv[i + 1]) ? argv[argv.indexOf(argv.find(a => a === '-a' || a === '--attrib')) + 1] : findAttribBase(input);
        const parentLoader = makeParentLoader(attribBase, dict);
        const lua = await rgdToLuaDifferential(rgd, parentLoader);
        const out = argv.find((a, i) => (a === '-o' || a === '--output') && argv[i + 1]) ? argv[argv.indexOf(argv.find(a => a === '-o' || a === '--output')) + 1] : input.replace(/\.rgd$/i, '.lua');
        fs.writeFileSync(out, lua, 'utf8');
        console.log(out);
    },

    async 'from-lua'(argv) {
        const [input] = argv;
        if (!input) { console.error('Usage: rgd from-lua <input.lua> [-o output.rgd] [-a attribBase] [--version 1|3]'); process.exit(1); }
        const dict = getDict(argv);
        const code = fs.readFileSync(input, 'utf8');
        let attribBase = argv.find((a, i) => (a === '-a' || a === '--attrib') && argv[i + 1]) ? argv[argv.indexOf(argv.find(a => a === '-a' || a === '--attrib')) + 1] : findAttribBase(input);
        const rgdParent = makeRgdParentLoader(attribBase, dict);
        const { gameData, version } = await luaToRgdResolved(code, dict, rgdParent);
        const vIdx = argv.indexOf('--version');
        const out = argv.find((a, i) => (a === '-o' || a === '--output') && argv[i + 1]) ? argv[argv.indexOf(argv.find(a => a === '-o' || a === '--output')) + 1] : input.replace(/\.lua$/i, '.rgd');
        const finalVersion = vIdx !== -1 ? parseInt(argv[vIdx + 1], 10) : version;
        writeRgdFile(out, gameData, dict, finalVersion);
        console.log(out);
    },

    async 'info'(argv) {
        const [input] = argv;
        if (!input) { console.error('Usage: rgd info <input.rgd>'); process.exit(1); }
        const dict = getDict(argv);
        const buf = fs.readFileSync(input);
        const rgd = parseRgd(buf, dict);
        function count(entries) {
            let total = 0, tables = 0;
            for (const e of entries) {
                total++;
                if ((e.type === RgdDataType.Table || e.type === RgdDataType.TableInt) && e.value?.entries) {
                    tables++;
                    const c = count(e.value.entries);
                    total += c.total; tables += c.tables;
                }
            }
            return { total, tables };
        }
        const c = count(rgd.gameData.entries);
        console.log(JSON.stringify({
            file: input,
            size: buf.length,
            version: rgd.header.version,
            chunks: rgd.chunks.length,
            totalEntries: c.total,
            tableCount: c.tables,
            reference: rgd.gameData.reference || null
        }, null, 2));
    },

    async 'hash'(argv) {
        const [str] = argv;
        if (!str) { console.error('Usage: rgd hash <string>'); process.exit(1); }
        const h = hash(str);
        console.log(JSON.stringify({ string: str, hash: hashToHex(h), decimal: h }));
    },

    async 'extract-sga'(argv) {
        const [input, outDir] = argv;
        if (!input || !outDir) { console.error('Usage: rgd extract-sga <archive.sga> <outputFolder>'); process.exit(1); }
        const sga = openSgaArchive(input);
        const files = sga.listRgdFiles();
        if (!files.length) { console.error('No RGD files in archive'); process.exit(1); }
        fs.mkdirSync(outDir, { recursive: true });
        const extracted = sga.extractRgdFiles(outDir);
        console.log(JSON.stringify({ archive: input, extracted: extracted.length, files: extracted }));
    },

    async 'batch-to-lua'(argv) {
        const [folder] = argv;
        if (!folder) { console.error('Usage: rgd batch-to-lua <folder> [-a attribBase]'); process.exit(1); }
        const dict = getDict(argv);
        let attribBase = argv.find((a, i) => (a === '-a' || a === '--attrib') && argv[i + 1]) ? argv[argv.indexOf(argv.find(a => a === '-a' || a === '--attrib')) + 1] : null;
        if (!attribBase) attribBase = findAttribBase(path.resolve(folder));
        const results = [];
        function walk(dir) {
            for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
                const full = path.join(dir, e.name);
                if (e.isDirectory()) walk(full);
                else if (e.name.endsWith('.rgd')) {
                    try {
                        const rgd = readRgdFile(full, dict);
                        const parentLoader = makeParentLoader(attribBase, dict);
                        rgdToLuaDifferential(rgd, parentLoader).then(lua => {
                            const out = full.replace(/\.rgd$/i, '.lua');
                            fs.writeFileSync(out, lua, 'utf8');
                            results.push({ input: full, output: out, ok: true });
                        }).catch(err => results.push({ input: full, error: err.message, ok: false }));
                    } catch (err) {
                        results.push({ input: full, error: err.message, ok: false });
                    }
                }
            }
        }
        walk(path.resolve(folder));
        // Simple synchronous-ish report (batch is fire-and-forget for now)
        console.log(JSON.stringify({ folder, processed: results.length, results }, null, 2));
    },

    async 'batch-to-rgd'(argv) {
        const [folder] = argv;
        if (!folder) { console.error('Usage: rgd batch-to-rgd <folder> [-a attribBase]'); process.exit(1); }
        const dict = getDict(argv);
        let attribBase = argv.find((a, i) => (a === '-a' || a === '--attrib') && argv[i + 1]) ? argv[argv.indexOf(argv.find(a => a === '-a' || a === '--attrib')) + 1] : null;
        if (!attribBase) attribBase = findAttribBase(path.resolve(folder));
        const results = [];
        function walk(dir) {
            for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
                const full = path.join(dir, e.name);
                if (e.isDirectory()) walk(full);
                else if (e.name.endsWith('.lua')) {
                    try {
                        const code = fs.readFileSync(full, 'utf8');
                        const rgdParent = makeRgdParentLoader(attribBase, dict);
                        luaToRgdResolved(code, dict, rgdParent).then(({ gameData, version }) => {
                            const out = full.replace(/\.lua$/i, '.rgd');
                            writeRgdFile(out, gameData, dict, version);
                            results.push({ input: full, output: out, ok: true });
                        }).catch(err => results.push({ input: full, error: err.message, ok: false }));
                    } catch (err) {
                        results.push({ input: full, error: err.message, ok: false });
                    }
                }
            }
        }
        walk(path.resolve(folder));
        console.log(JSON.stringify({ folder, processed: results.length, results }, null, 2));
    },

    async 'help'() {
        console.log(`
RGD Suite CLI — standalone command-line interface
Usage: rgd <command> [args...] [options]

Commands:
  to-text      <input.rgd> [-o output.txt]              Convert RGD to text
  from-text    <input.rgd.txt> [-o output.rgd]          Convert text to RGD
  to-lua       <input.rgd> [-o output.lua] [-a base]    Convert RGD to Lua
  from-lua     <input.lua> [-o output.rgd] [-a base]    Convert Lua to RGD
  info         <input.rgd>                              Show RGD file info (JSON)
  hash         <string>                                 Calculate RGD hash
  extract-sga  <archive.sga> <outputFolder>             Extract RGDs from SGA
  batch-to-lua <folder> [-a base]                       Batch convert folder
  batch-to-rgd <folder> [-a base]                       Batch compile folder

Global options:
  -d, --dictionary <paths>  Colon-separated dictionary paths
  --version <1|3>         RGD version for from-text / from-lua

Environment:
  RGD_SUITE_DICT            Default dictionary path(s)
`);
    }
};

// ── Entry point ──────────────────────────────────────────────────────────

(async () => {
    const [,, cmd, ...args] = process.argv;
    const handler = COMMANDS[cmd] || COMMANDS['help'];
    try { await handler(args); }
    catch (err) { console.error(err.message); process.exit(1); }
})();
