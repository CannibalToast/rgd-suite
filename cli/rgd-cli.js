#!/usr/bin/env node
'use strict';
/**
 * rgd-cli.js — Standalone CLI wrapper around bundled/rgd-tools.
 *
 * Works without VS Code running and without the upstream commander dependency.
 * Every command is exposed as a flat sub-command so PowerShell wrappers can
 * pipe output cleanly.
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

// ── Argument parsing ─────────────────────────────────────────────────────

/** Return the value following one of `flags` in `argv`, or `fallback`. */
function getOpt(argv, flags, fallback) {
    for (const flag of flags) {
        const i = argv.indexOf(flag);
        if (i !== -1 && i + 1 < argv.length) return argv[i + 1];
    }
    return fallback;
}

/** Strip flag/value pairs so positional args are clean. */
function positionals(argv, flagsWithValue) {
    const skip = new Set();
    for (const flag of flagsWithValue) {
        const i = argv.indexOf(flag);
        if (i !== -1 && i + 1 < argv.length) { skip.add(i); skip.add(i + 1); }
    }
    return argv.filter((_, i) => !skip.has(i));
}

const VALUE_FLAGS = ['-o', '--output', '-a', '--attrib', '-d', '--dictionary', '--version'];

// ── Dictionary ───────────────────────────────────────────────────────────

function findDictionaries(extraPaths) {
    const candidates = [];
    if (extraPaths) {
        for (const p of extraPaths.split(path.delimiter)) {
            if (p && fs.existsSync(p)) candidates.push(p);
        }
    }
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
    const extra = getOpt(argv, ['-d', '--dictionary'], process.env.RGD_SUITE_DICT);
    return createAndLoadDictionaries(findDictionaries(extra));
}

// ── Path helpers ─────────────────────────────────────────────────────────

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

function defaultOutput(input, fromExt, toExt) {
    if (input.toLowerCase().endsWith(fromExt)) return input.slice(0, -fromExt.length) + toExt;
    return input + toExt;
}

// ── Lua / RGD parent loaders ─────────────────────────────────────────────

function makeLuaFileLoader(attribBase, dict) {
    const cache = new Map();
    return function loader(refPath) {
        if (!attribBase) return null;
        let clean = refPath.replace(/\\/g, '/');
        if (clean.endsWith('.lua')) clean = clean.slice(0, -4);
        const luaPath = path.join(attribBase, clean + '.lua');
        if (cache.has(luaPath)) return cache.get(luaPath);
        if (fs.existsSync(luaPath)) {
            const c = fs.readFileSync(luaPath, 'utf8');
            cache.set(luaPath, c);
            return c;
        }
        const rgdPath = path.join(attribBase, clean + '.rgd');
        if (fs.existsSync(rgdPath)) {
            const c = rgdToLua(readRgdFile(rgdPath, dict));
            cache.set(luaPath, c);
            return c;
        }
        cache.set(luaPath, null);
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

// ── Recursive walker ─────────────────────────────────────────────────────

async function collectFiles(folder, ext) {
    const results = [];
    const stack = [folder];
    while (stack.length) {
        const dir = stack.pop();
        let entries;
        try { entries = await fs.promises.readdir(dir, { withFileTypes: true }); }
        catch { continue; }
        for (const e of entries) {
            const full = path.join(dir, e.name);
            if (e.isDirectory()) stack.push(full);
            else if (e.isFile() && e.name.toLowerCase().endsWith(ext)) results.push(full);
        }
    }
    return results;
}

// ── Commands ─────────────────────────────────────────────────────────────

const COMMANDS = {
    async 'to-text'(argv) {
        const [input] = positionals(argv, VALUE_FLAGS);
        if (!input) usage('to-text <input.rgd> [-o output.txt]');
        const dict = getDict(argv);
        const rgd = readRgdFile(input, dict);
        const text = rgdToText(rgd, path.basename(input), null);
        const out = getOpt(argv, ['-o', '--output'], input + '.txt');
        await fs.promises.writeFile(out, text, 'utf8');
        console.log(out);
    },

    async 'from-text'(argv) {
        const [input] = positionals(argv, VALUE_FLAGS);
        if (!input) usage('from-text <input.rgd.txt> [-o output.rgd] [--version 1|3]');
        const dict = getDict(argv);
        const text = await fs.promises.readFile(input, 'utf8');
        const { gameData, version } = textToRgd(text, dict);
        // Special-case: foo.rgd.txt -> foo.rgd, otherwise strip .txt or append .rgd
        let defaultOut = input;
        if (defaultOut.toLowerCase().endsWith('.rgd.txt'))      defaultOut = defaultOut.slice(0, -4);
        else if (defaultOut.toLowerCase().endsWith('.txt'))     defaultOut = defaultOut.slice(0, -4) + '.rgd';
        else                                                     defaultOut += '.rgd';
        const out = getOpt(argv, ['-o', '--output'], defaultOut);
        const versionStr = getOpt(argv, ['--version']);
        const finalVersion = versionStr ? parseInt(versionStr, 10) : version;
        writeRgdFile(out, gameData, dict, finalVersion);
        console.log(out);
    },

    async 'to-lua'(argv) {
        const [input] = positionals(argv, VALUE_FLAGS);
        if (!input) usage('to-lua <input.rgd> [-o output.lua] [-a attribBase]');
        const dict = getDict(argv);
        const rgd = readRgdFile(input, dict);
        const attribBase = getOpt(argv, ['-a', '--attrib'], findAttribBase(input));
        const parentLoader = makeParentLoader(attribBase, dict);
        const lua = await rgdToLuaDifferential(rgd, parentLoader);
        const out = getOpt(argv, ['-o', '--output'], defaultOutput(input, '.rgd', '.lua'));
        await fs.promises.writeFile(out, lua, 'utf8');
        console.log(out);
    },

    async 'from-lua'(argv) {
        const [input] = positionals(argv, VALUE_FLAGS);
        if (!input) usage('from-lua <input.lua> [-o output.rgd] [-a attribBase] [--version 1|3]');
        const dict = getDict(argv);
        const code = await fs.promises.readFile(input, 'utf8');
        const attribBase = getOpt(argv, ['-a', '--attrib'], findAttribBase(input));
        const rgdParent = makeRgdParentLoader(attribBase, dict);
        const { gameData, version } = await luaToRgdResolved(code, dict, rgdParent);
        const out = getOpt(argv, ['-o', '--output'], defaultOutput(input, '.lua', '.rgd'));
        const versionStr = getOpt(argv, ['--version']);
        const finalVersion = versionStr ? parseInt(versionStr, 10) : version;
        writeRgdFile(out, gameData, dict, finalVersion);
        console.log(out);
    },

    async 'info'(argv) {
        const [input] = positionals(argv, VALUE_FLAGS);
        if (!input) usage('info <input.rgd>');
        const dict = getDict(argv);
        const buf = await fs.promises.readFile(input);
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
        const [str] = positionals(argv, VALUE_FLAGS);
        if (!str) usage('hash <string>');
        const h = hash(str);
        console.log(JSON.stringify({ string: str, hash: hashToHex(h), decimal: h }));
    },

    async 'extract-sga'(argv) {
        const [input, outDir] = positionals(argv, VALUE_FLAGS);
        if (!input || !outDir) usage('extract-sga <archive.sga> <outputFolder>');
        const sga = openSgaArchive(input);
        const files = sga.listRgdFiles();
        if (!files.length) { console.error('No RGD files in archive'); process.exit(1); }
        await fs.promises.mkdir(outDir, { recursive: true });
        const extracted = sga.extractRgdFiles(outDir);
        console.log(JSON.stringify({ archive: input, extracted: extracted.length, files: extracted }, null, 2));
    },

    async 'batch-to-lua'(argv) {
        const [folder] = positionals(argv, VALUE_FLAGS);
        if (!folder) usage('batch-to-lua <folder> [-a attribBase]');
        const dict = getDict(argv);
        const attribBase = getOpt(argv, ['-a', '--attrib'], null) || findAttribBase(path.resolve(folder));
        const parentLoader = makeParentLoader(attribBase, dict);
        const files = await collectFiles(path.resolve(folder), '.rgd');
        const results = [];
        for (const full of files) {
            try {
                const rgd = readRgdFile(full, dict);
                const lua = await rgdToLuaDifferential(rgd, parentLoader);
                const out = full.replace(/\.rgd$/i, '.lua');
                await fs.promises.writeFile(out, lua, 'utf8');
                results.push({ input: full, output: out, ok: true });
            } catch (err) {
                results.push({ input: full, error: err.message, ok: false });
            }
        }
        const ok = results.filter(r => r.ok).length;
        console.log(JSON.stringify({
            folder, attribBase, processed: results.length, succeeded: ok, failed: results.length - ok, results
        }, null, 2));
    },

    async 'batch-to-rgd'(argv) {
        const [folder] = positionals(argv, VALUE_FLAGS);
        if (!folder) usage('batch-to-rgd <folder> [-a attribBase]');
        const dict = getDict(argv);
        const attribBase = getOpt(argv, ['-a', '--attrib'], null) || findAttribBase(path.resolve(folder));
        const rgdParent = makeRgdParentLoader(attribBase, dict);
        const files = await collectFiles(path.resolve(folder), '.lua');
        const results = [];
        for (const full of files) {
            try {
                const code = await fs.promises.readFile(full, 'utf8');
                const { gameData, version } = await luaToRgdResolved(code, dict, rgdParent);
                const out = full.replace(/\.lua$/i, '.rgd');
                writeRgdFile(out, gameData, dict, version);
                results.push({ input: full, output: out, ok: true });
            } catch (err) {
                results.push({ input: full, error: err.message, ok: false });
            }
        }
        const ok = results.filter(r => r.ok).length;
        console.log(JSON.stringify({
            folder, attribBase, processed: results.length, succeeded: ok, failed: results.length - ok, results
        }, null, 2));
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
  hash         <string>                                 Calculate RGD hash (JSON)
  extract-sga  <archive.sga> <outputFolder>             Extract RGDs from SGA
  batch-to-lua <folder> [-a base]                       Batch convert folder
  batch-to-rgd <folder> [-a base]                       Batch compile folder

Global options:
  -d, --dictionary <paths>  Colon-separated dictionary paths
  --version <1|3>           RGD version for from-text / from-lua

Environment:
  RGD_SUITE_DICT            Default dictionary path(s)
`.trimEnd());
    }
};

function usage(msg) {
    console.error('Usage: rgd ' + msg);
    process.exit(1);
}

// ── Entry point ──────────────────────────────────────────────────────────

(async () => {
    const [,, cmd, ...args] = process.argv;
    const handler = COMMANDS[cmd] || COMMANDS['help'];
    try { await handler(args); }
    catch (err) { console.error(err.message); process.exit(1); }
})();
