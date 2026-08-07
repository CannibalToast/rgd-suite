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
const os = require('os');

const dist = path.join(__dirname, '..', 'bundled', 'rgd-tools', 'dist');

const { createAndLoadDictionaries } = require(path.join(dist, 'dictionary.js'));
const { readRgdFile, parseRgd }       = require(path.join(dist, 'reader.js'));
const { writeRgdFile }                = require(path.join(dist, 'writer.js'));
const { rgdToText, textToRgd }        = require(path.join(dist, 'textFormat.js'));
const { rgdToLua, rgdToLuaDifferential, luaToRgdResolved, parseLuaToTable } = require(path.join(dist, 'luaFormat.js'));
const { hash, hashToHex }             = require(path.join(dist, 'hash.js'));
const { openSgaArchive }              = require(path.join(dist, 'sga.js'));
const { RgdDataType }                 = require(path.join(dist, 'types.js'));
const {
    validateEncoding,
    validateFilePath,
    validateLuaReferences,
    validateRgdReferences,
    resolveAttribRefPath,
    stripUtf8Bom,
    stripUtf8BomFromFile,
} = require('./validators');

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

const VALUE_FLAGS = ['-o', '--output', '-a', '--attrib', '-d', '--dictionary', '--version', '--format', '--workers', '-w'];

function defaultWorkerCount(configured) {
    const n = parseInt(configured, 10);
    if (n > 0) return n;
    return Math.max(1, Math.min(os.cpus().length - 1, 4));
}

async function scheduleBatched(items, concurrency, fn) {
    if (!items.length) return;
    const limit = Math.max(1, concurrency);
    let next = 0;
    const runners = Array.from({ length: Math.min(limit, items.length) }, async () => {
        while (true) {
            const i = next++;
            if (i >= items.length) break;
            await fn(items[i], i);
        }
    });
    await Promise.all(runners);
}

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
        path.join(__dirname, '..', 'dictionaries', 'RGD_DIC.TXT'),
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

        // Try .lua first (the canonical source form).
        const luaPath = resolveAttribRefPath(refPath, attribBase, '.lua');
        if (luaPath) {
            if (cache.has(luaPath)) return cache.get(luaPath);
            if (fs.existsSync(luaPath)) {
                const fixed = stripUtf8BomFromFile(luaPath, fs.readFileSync(luaPath));
                const c = fixed.buffer.toString('utf8');
                cache.set(luaPath, c);
                return c;
            }
        }

        // Fall back to a compiled .rgd, converting it to Lua text.
        const rgdPath = resolveAttribRefPath(refPath, attribBase, '.rgd');
        if (rgdPath && fs.existsSync(rgdPath)) {
            const c = rgdToLua(readRgdFile(rgdPath, dict));
            cache.set(rgdPath, c);
            return c;
        }

        // Remember that this reference is missing so repeated lookups don't
        // keep hitting the disk / index.
        const cacheKey = luaPath || rgdPath;
        if (cacheKey) cache.set(cacheKey, null);
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

        // Prefer an already-compiled .rgd parent.
        const rgdPath = resolveAttribRefPath(refPath, attribBase, '.rgd');
        if (rgdPath && fs.existsSync(rgdPath)) return readRgdFile(rgdPath, dict).gameData;

        // Fall back to a .lua parent and resolve its own inheritance.
        const luaPath = resolveAttribRefPath(refPath, attribBase, '.lua');
        if (luaPath && fs.existsSync(luaPath)) {
            const fixed = stripUtf8BomFromFile(luaPath, fs.readFileSync(luaPath));
            const code = fixed.buffer.toString('utf8');
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

// ── Parity checker helpers ─────────────────────────────────────────────────

const FLOAT_EPSILON = 1e-4;

function flattenRgd(table, prefix, out) {
    out = out || new Map();
    prefix = prefix || '';
    for (const entry of table.entries) {
        const k = entry.name || ('#' + entry.hash.toString(16).padStart(8, '0'));
        const full = prefix ? prefix + '.' + k : k;
        switch (entry.type) {
            case RgdDataType.Table:
            case RgdDataType.TableInt:
                if (entry.value) flattenRgd(entry.value, full, out);
                break;
            case RgdDataType.Float:   out.set(full, { type: 'float', value: entry.value }); break;
            case RgdDataType.Integer: out.set(full, { type: 'int', value: entry.value }); break;
            case RgdDataType.Bool:    out.set(full, { type: 'bool', value: entry.value }); break;
            case RgdDataType.String:
            case RgdDataType.WString:
                if (k !== '$REF') out.set(full, { type: 'string', value: entry.value });
                break;
            case RgdDataType.NoData:  out.set(full, { type: 'nil', value: null }); break;
        }
    }
    return out;
}


function normRef(p) {
    return String(p || '').replace(/\\/g, '/').toLowerCase().replace(/\.lua$/, '').replace(/^\//, '');
}

function valuesMatch(a, b) {
    const numeric = t => t === 'float' || t === 'int';
    if (numeric(a.type) && numeric(b.type)) return Math.abs(a.value - b.value) <= FLOAT_EPSILON;
    if (a.type !== b.type) return false;
    if (a.type === 'ref') return normRef(a.value) === normRef(b.value);
    if (a.type === 'nil') return true;
    return a.value === b.value;
}

function compareFlatMaps(rgdMap, luaMap) {
    const issues = [];
    for (const [key, rgdEntry] of rgdMap) {
        if (key.endsWith('.$ref')) continue;
        const luaEntry = luaMap.get(key);
        if (!luaEntry) {
            issues.push({ kind: 'missing_in_lua', key, details: `RGD: ${JSON.stringify(rgdEntry.value)} (${rgdEntry.type})` });
        } else if (!valuesMatch(rgdEntry, luaEntry)) {
            const numeric = t => t === 'float' || t === 'int';
            if (rgdEntry.type !== luaEntry.type && !numeric(rgdEntry.type) && !numeric(luaEntry.type)) {
                issues.push({ kind: 'type_mismatch', key, details: `RGD=${rgdEntry.type}, Lua=${luaEntry.type}` });
            } else {
                issues.push({ kind: 'value_mismatch', key, details: `RGD=${JSON.stringify(rgdEntry.value)}, Lua=${JSON.stringify(luaEntry.value)}` });
            }
        }
    }
    for (const [key, luaEntry] of luaMap) {
        if (key.endsWith('.$ref') || luaEntry.type === 'nil') continue;
        if (!rgdMap.has(key)) {
            issues.push({ kind: 'missing_in_rgd', key, details: `Lua: ${JSON.stringify(luaEntry.value)} (${luaEntry.type})` });
        }
    }
    return issues;
}

function resolvePair(input) {
    if (/\.rgd$/i.test(input)) return { rgd: input, lua: input.replace(/\.rgd$/i, '.lua') };
    if (/\.lua$/i.test(input)) return { rgd: input.replace(/\.lua$/i, '.rgd'), lua: input };
    throw new Error('Select a .rgd or .lua file');
}

function maybeStripBom(filePath, buffer, fixes) {
    const fixed = stripUtf8BomFromFile(filePath, buffer);
    if (fixed.fixed) {
        fixes.push({
            kind: 'bom_stripped',
            severity: 'info',
            path: filePath,
            details: 'Removed UTF-8 BOM',
        });
    }
    return fixed.buffer;
}

async function checkParityPair(rgdPath, luaPath, dict, attribBaseOverride) {
    const attribBase = attribBaseOverride || findAttribBase(rgdPath) || findAttribBase(luaPath);
    const validationIssues = [];
    const fixes = [];
    validationIssues.push(...validateFilePath(attribBase ? path.relative(attribBase, rgdPath) : rgdPath));
    validationIssues.push(...validateFilePath(attribBase ? path.relative(attribBase, luaPath) : luaPath));

    const luaBuf = maybeStripBom(luaPath, fs.readFileSync(luaPath), fixes);
    validationIssues.push(...validateEncoding(luaBuf, luaPath).issues);
    const luaCode = stripUtf8Bom(luaBuf.toString('utf8'));

    // Compile the Lua source to an RGD with full inheritance resolution.
    // This makes the parity comparison source-of-truth: any Lua that fails
    // to compile or diverges from the on-disk RGD will be caught.
    const rgdParent = makeRgdParentLoader(attribBase, dict);
    const { gameData: compiledGameData } = await luaToRgdResolved(luaCode, dict, rgdParent);

    // Read the on-disk RGD *after* compiling the Lua so custom names added to
    // the dictionary during compilation are available for name resolution.
    const rgdFile = readRgdFile(rgdPath, dict);
    const rgdMap = flattenRgd(rgdFile.gameData);
    const compiledMap = flattenRgd(compiledGameData);

    validationIssues.push(...validateRgdReferences(rgdFile.gameData, attribBase));
    validationIssues.push(...validateRgdReferences(compiledGameData, attribBase));

    const issues = compareFlatMaps(rgdMap, compiledMap);
    return {
        rgdFile: rgdPath,
        luaFile: luaPath,
        totalKeys: rgdMap.size,
        issues,
        validationIssues,
        fixes,
        attribResolved: !!attribBase,
    };
}

function summarizeParity(results, skipped) {
    const failed = results.filter(r => r.error || r.issues.length > 0 || r.validationIssues.length > 0).length;
    const errored = results.filter(r => r.error).length;
    const validationIssues = results.reduce((n, r) => n + (r.validationIssues?.length || 0), 0);
    const parityIssues = results.reduce((n, r) => n + (r.issues?.length || 0), 0);
    const fixes = results.reduce((n, r) => n + (r.fixes?.length || 0), 0);
    return {
        checked: results.length,
        passed: results.length - failed,
        failed,
        errored,
        skipped: skipped || 0,
        parityIssues,
        validationIssues,
        fixes,
    };
}

function printParity(results, skipped, format, label) {
    const summary = summarizeParity(results, skipped);
    const payload = { ok: summary.failed === 0 && summary.errored === 0, label, summary, results };
    if (format === 'json') {
        console.log(JSON.stringify(payload, null, 2));
    } else {
        console.error(`${label || 'Parity'}: ${summary.checked} checked | ${summary.passed} pass | ${summary.failed} fail | ${summary.errored} error | ${summary.skipped} skipped | ${summary.parityIssues + summary.validationIssues} total issues | ${summary.fixes} fixes`);
        for (const result of results) {
            const issueCount = (result.issues?.length || 0) + (result.validationIssues?.length || 0);
            console.error(`[${issueCount === 0 && !result.error ? 'PASS' : 'FAIL'}] ${result.rgdFile} ↔ ${result.luaFile || '(missing lua)'} (${issueCount} issues)`);
            if (result.error) console.error(`  ERROR: ${result.error}`);
        }
    }
    if (!payload.ok) process.exitCode = 1;
}

async function validateOneFile(filePath, dict, attribBaseOverride) {
    const attribBase = attribBaseOverride || findAttribBase(filePath);
    const validationIssues = [];
    const fixes = [];
    const lower = filePath.toLowerCase();
    try {
        if (lower.endsWith('.lua') || lower.endsWith('.txt')) {
            const buf = maybeStripBom(filePath, fs.readFileSync(filePath), fixes);
            validationIssues.push(...validateEncoding(buf, filePath).issues);
            if (lower.endsWith('.lua')) {
                const luaLoader = makeLuaFileLoader(attribBase, dict);
                const table = parseLuaToTable(stripUtf8Bom(buf.toString('utf8')), luaLoader);
                validationIssues.push(...validateLuaReferences(table, attribBase));
            }
        } else if (lower.endsWith('.rgd')) {
            const rgd = readRgdFile(filePath, dict);
            validationIssues.push(...validateRgdReferences(rgd.gameData, attribBase));
        }
        return {
            file: filePath,
            validationIssues,
            fixes,
            attribResolved: !!attribBase,
        };
    } catch (err) {
        return {
            file: filePath,
            validationIssues,
            fixes,
            attribResolved: !!attribBase,
            error: err.message,
        };
    }
}

async function validateTarget(target, dict, attribBase, format) {
    const resolved = path.resolve(target);
    const stat = fs.statSync(resolved);
    const files = stat.isDirectory()
        ? [
            ...(await collectFiles(resolved, '.lua')),
            ...(await collectFiles(resolved, '.rgd')),
            ...(await collectFiles(resolved, '.rgd.txt')),
        ]
        : [resolved];
    const results = [];
    for (const file of files) results.push(await validateOneFile(file, dict, attribBase));
    const validationIssues = results.reduce((n, r) => n + (r.validationIssues?.length || 0), 0);
    const fixes = results.reduce((n, r) => n + (r.fixes?.length || 0), 0);
    const errored = results.filter(r => r.error).length;
    const failed = results.filter(r => r.error || (r.validationIssues?.length || 0) > 0).length;
    const payload = {
        ok: failed === 0 && errored === 0,
        label: path.basename(resolved),
        summary: {
            checked: results.length,
            passed: results.length - failed,
            failed,
            errored,
            validationIssues,
            fixes,
        },
        results,
    };
    if (format === 'json') {
        console.log(JSON.stringify(payload, null, 2));
    } else {
        console.error(`Validation: ${payload.summary.checked} checked | ${payload.summary.passed} pass | ${failed} fail | ${errored} error | ${validationIssues} issues | ${fixes} fixes`);
        for (const result of results) {
            const count = (result.validationIssues?.length || 0) + (result.error ? 1 : 0);
            console.error(`[${count === 0 ? 'PASS' : 'FAIL'}] ${result.file} (${count} issues)`);
            if (result.error) console.error(`  ERROR: ${result.error}`);
        }
    }
    if (!payload.ok) process.exitCode = 1;
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
    },

    async 'from-text'(argv) {
        const [input] = positionals(argv, VALUE_FLAGS);
        if (!input) usage('from-text <input.rgd.txt> [-o output.rgd] [--version 1|3]');
        const dict = getDict(argv);
        const text = maybeStripBom(input, await fs.promises.readFile(input), []).toString('utf8');
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
    },

    async 'from-lua'(argv) {
        const [input] = positionals(argv, VALUE_FLAGS);
        if (!input) usage('from-lua <input.lua> [-o output.rgd] [-a attribBase] [--version 1|3]');
        const dict = getDict(argv);
        const code = maybeStripBom(input, await fs.promises.readFile(input), []).toString('utf8');
        const attribBase = getOpt(argv, ['-a', '--attrib'], findAttribBase(input));
        const rgdParent = makeRgdParentLoader(attribBase, dict);
        const { gameData, version } = await luaToRgdResolved(code, dict, rgdParent);
        const out = getOpt(argv, ['-o', '--output'], defaultOutput(input, '.lua', '.rgd'));
        const versionStr = getOpt(argv, ['--version']);
        const finalVersion = versionStr ? parseInt(versionStr, 10) : version;
        writeRgdFile(out, gameData, dict, finalVersion);
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

    async 'parity'(argv) {
        const [input] = positionals(argv, VALUE_FLAGS);
        if (!input) usage('parity <input.rgd|input.lua> [--format json|text] [-a attribBase]');
        const format = getOpt(argv, ['--format'], 'text');
        const dict = getDict(argv);
        const attribBase = getOpt(argv, ['-a', '--attrib'], null);
        const pair = resolvePair(path.resolve(input));
        if (!fs.existsSync(pair.rgd)) throw new Error('RGD not found: ' + pair.rgd);
        if (!fs.existsSync(pair.lua)) throw new Error('Lua not found: ' + pair.lua);
        const result = await checkParityPair(pair.rgd, pair.lua, dict, attribBase);
        printParity([result], 0, format, path.basename(pair.rgd));
    },

    async 'parity-batch'(argv) {
        const [folder] = positionals(argv, VALUE_FLAGS);
        if (!folder) usage('parity-batch <folder> [--format json|text] [-a attribBase] [--workers N]');
        const format = getOpt(argv, ['--format'], 'text');
        const dict = getDict(argv);
        const root = path.resolve(folder);
        const attribBase = getOpt(argv, ['-a', '--attrib'], null) || findAttribBase(root);
        const workers = defaultWorkerCount(getOpt(argv, ['--workers', '-w'], '0'));
        const rgdFiles = await collectFiles(root, '.rgd');
        const jobs = [];
        let skipped = 0;
        for (const rgdPath of rgdFiles) {
            const luaPath = rgdPath.replace(/\.rgd$/i, '.lua');
            if (!fs.existsSync(luaPath)) {
                skipped++;
                continue;
            }
            jobs.push({ rgdPath, luaPath });
        }
        const results = [];
        await scheduleBatched(jobs, workers, async ({ rgdPath, luaPath }) => {
            try {
                results.push(await checkParityPair(rgdPath, luaPath, dict, attribBase));
            } catch (err) {
                results.push({
                    rgdFile: rgdPath,
                    luaFile: luaPath,
                    totalKeys: 0,
                    issues: [],
                    validationIssues: [],
                    attribResolved: !!attribBase,
                    error: err.message,
                });
            }
        });
        printParity(results, skipped, format, path.basename(root));
    },

    async 'validate'(argv) {
        const [target] = positionals(argv, VALUE_FLAGS);
        if (!target) usage('validate <file|folder> [--format json|text] [-a attribBase]');
        const format = getOpt(argv, ['--format'], 'text');
        const dict = getDict(argv);
        const attribBase = getOpt(argv, ['-a', '--attrib'], null);
        await validateTarget(target, dict, attribBase, format);
    },

    async 'batch-to-lua'(argv) {
        const [folder] = positionals(argv, VALUE_FLAGS);
        if (!folder) usage('batch-to-lua <folder> [-a attribBase] [--workers N]');
        const dict = getDict(argv);
        const attribBase = getOpt(argv, ['-a', '--attrib'], null) || findAttribBase(path.resolve(folder));
        const workers = defaultWorkerCount(getOpt(argv, ['--workers', '-w'], '0'));
        const parentLoader = makeParentLoader(attribBase, dict);
        const files = await collectFiles(path.resolve(folder), '.rgd');
        const results = Array.from({ length: files.length });
        await scheduleBatched(files, workers, async (full, index) => {
            try {
                const rgd = readRgdFile(full, dict);
                const lua = await rgdToLuaDifferential(rgd, parentLoader);
                const out = full.replace(/\.rgd$/i, '.lua');
                await fs.promises.writeFile(out, lua, 'utf8');
                results[index] = { input: full, output: out, ok: true };
            } catch (err) {
                results[index] = { input: full, error: err.message, ok: false };
            }
        });
        const settled = results.filter(Boolean);
        const ok = settled.filter(r => r.ok).length;
        console.log(JSON.stringify({
            folder, attribBase, workers, processed: settled.length, succeeded: ok, failed: settled.length - ok, results: settled
        }, null, 2));
    },

    async 'batch-to-rgd'(argv) {
        const [folder] = positionals(argv, VALUE_FLAGS);
        if (!folder) usage('batch-to-rgd <folder> [-a attribBase] [--workers N]');
        const dict = getDict(argv);
        const attribBase = getOpt(argv, ['-a', '--attrib'], null) || findAttribBase(path.resolve(folder));
        const workers = defaultWorkerCount(getOpt(argv, ['--workers', '-w'], '0'));
        const rgdParent = makeRgdParentLoader(attribBase, dict);
        const files = await collectFiles(path.resolve(folder), '.lua');
        const results = Array.from({ length: files.length });
        await scheduleBatched(files, workers, async (full, index) => {
            try {
                const code = maybeStripBom(full, await fs.promises.readFile(full), []).toString('utf8');
                const { gameData, version } = await luaToRgdResolved(code, dict, rgdParent);
                const out = full.replace(/\.lua$/i, '.rgd');
                writeRgdFile(out, gameData, dict, version);
                results[index] = { input: full, output: out, ok: true };
            } catch (err) {
                results[index] = { input: full, error: err.message, ok: false };
            }
        });
        const settled = results.filter(Boolean);
        const ok = settled.filter(r => r.ok).length;
        console.log(JSON.stringify({
            folder, attribBase, workers, processed: settled.length, succeeded: ok, failed: settled.length - ok, results: settled
        }, null, 2));
    },

    async 'table-diff'(argv) {
        const flags = VALUE_FLAGS.concat(['--ref']);
        const [input] = positionals(argv, flags);
        if (!input) usage('table-diff <input.rgd> [--ref HEAD] [--format json|text]');
        const ref = getOpt(argv, ['--ref'], 'HEAD');
        const format = getOpt(argv, ['--format'], 'text');
        const dict = getDict(argv);
        const abs = path.resolve(input);
        if (!fs.existsSync(abs)) {
            console.error('File not found:', abs);
            process.exit(1);
        }
        let baseBuf;
        try {
            const { execFileSync } = require('child_process');
            const root = execFileSync('git', ['-C', path.dirname(abs), 'rev-parse', '--show-toplevel'], { encoding: 'utf8' }).trim();
            const rel = path.relative(root, abs).replace(/\\/g, '/');
            baseBuf = execFileSync('git', ['-C', root, 'show', `${ref}:${rel}`], { maxBuffer: 32 * 1024 * 1024 });
        } catch (e) {
            const msg = e && e.message ? e.message.split('\n')[0] : String(e);
            console.error('git show failed:', msg);
            process.exit(1);
        }
        const baseRgd = parseRgd(baseBuf, dict);
        const curRgd = parseRgd(fs.readFileSync(abs), dict);

        function flatten(table, prefix, out) {
            out = out || new Map();
            for (const entry of table.entries) {
                const k = entry.name || ('#' + entry.hash.toString(16).padStart(8, '0'));
                const full = prefix ? prefix + '.' + k : k;
                if (entry.type === RgdDataType.Table || entry.type === RgdDataType.TableInt) {
                    if (entry.value) flatten(entry.value, full, out);
                } else if (entry.type === RgdDataType.Float) {
                    out.set(full, { type: 'float', value: entry.value });
                } else if (entry.type === RgdDataType.Integer) {
                    out.set(full, { type: 'int', value: entry.value });
                } else if (entry.type === RgdDataType.Bool) {
                    out.set(full, { type: 'bool', value: entry.value });
                } else if (entry.type === RgdDataType.String || entry.type === RgdDataType.WString) {
                    if (k !== '$REF') out.set(full, { type: 'string', value: entry.value });
                }
            }
            return out;
        }
        const FLOAT_EPS = 1e-4;
        function eq(a, b) {
            if ((a.type === 'float' || a.type === 'int') && (b.type === 'float' || b.type === 'int')) {
                return Math.abs(a.value - b.value) <= FLOAT_EPS;
            }
            return a.type === b.type && a.value === b.value;
        }
        const baseMap = flatten(baseRgd.gameData);
        const curMap = flatten(curRgd.gameData);
        const entries = [];
        for (const [key, cur] of curMap) {
            const old = baseMap.get(key);
            if (!old) entries.push({ kind: 'added', key, newValue: cur });
            else if (!eq(old, cur)) entries.push({ kind: 'changed', key, oldValue: old, newValue: cur });
        }
        for (const [key, old] of baseMap) {
            if (!curMap.has(key)) entries.push({ kind: 'removed', key, oldValue: old });
        }
        entries.sort((a, b) => a.key.localeCompare(b.key));
        const result = { file: abs, baseRef: ref, totalKeys: curMap.size, changes: entries.length, entries };
        if (format === 'json') {
            console.log(JSON.stringify(result, null, 2));
        } else {
            const changed = entries.filter(e => e.kind === 'changed').length;
            const added = entries.filter(e => e.kind === 'added').length;
            const removed = entries.filter(e => e.kind === 'removed').length;
            console.log(`RGD table diff: ${abs} vs ${ref}`);
            console.log(`  ${changed} changed, ${added} added, ${removed} removed`);
            for (const e of entries) {
                if (e.kind === 'changed') {
                    console.log(`[CHANGED] ${e.key}: ${JSON.stringify(e.oldValue.value)} -> ${JSON.stringify(e.newValue.value)}`);
                } else if (e.kind === 'added') {
                    console.log(`[ADDED]   ${e.key}: ${JSON.stringify(e.newValue.value)}`);
                } else {
                    console.log(`[REMOVED] ${e.key}: ${JSON.stringify(e.oldValue.value)}`);
                }
            }
        }
        if (entries.length) process.exitCode = 1;
    },

    async 'help'() {
        showHelp(0);
    }
};

function showHelp(exitCode = 0, extra = '') {
    if (extra) console.error(extra);
    console.log(`RGD Suite CLI — Standalone RGD converter, validator and parity checker.

Usage: rgd <command> [options]

Commands:
  hash <string>                    Compute the RGD hash of a string
  info <input.rgd>                 Show RGD file metadata
  to-text <input.rgd>              Convert RGD to human-readable text (.rgd.txt)
  from-text <input.rgd.txt>        Convert text back to binary RGD
  to-lua <input.rgd>               Dump RGD to differential Lua
  from-lua <input.lua>             Compile Lua back to binary RGD
  batch-to-lua <folder>            Convert all .rgd files in a folder to .lua
  batch-to-rgd <folder>            Compile all .lua files in a folder to .rgd
  extract-sga <archive.sga> <outputFolder>
                                   Extract .rgd files from an SGA archive
  parity <input.rgd|input.lua>     Compare an RGD against its Lua source
  parity-batch <folder>            Compare all RGD/Lua pairs in a folder
  validate <file|folder>           Validate encoding, paths and references
  table-diff <input.rgd>           Diff working RGD against a git revision

Global options (where applicable):
  -d, --dictionary <path>          Additional hash dictionary file or folder
  -a, --attrib <path>              Attrib root for reference/parent resolution
  --version <1|3>                  RGD version for from-text / from-lua
  -w, --workers <N>                Worker thread count for batch/parity
  --format <json|text>             Output format for parity/validate/table-diff
  -o, --output <path>              Output file for single-file conversions

Examples:
  rgd hash "unit_name"
  rgd info unit.rgd
  rgd to-text unit.rgd -o unit.rgd.txt
  rgd from-lua unit.lua
  rgd validate ./data/attrib --format json
  rgd parity unit.rgd --format json`);
    process.exit(exitCode);
}

function usage(msg) {
    console.error('Usage: rgd ' + msg);
    process.exit(1);
}

// ── Entry point ──────────────────────────────────────────────────────────

(async () => {
    const [,, cmd, ...args] = process.argv;
    if (!cmd || cmd === 'help' || cmd === '--help' || cmd === '-h') {
        await COMMANDS['help']();
        return;
    }
    const handler = COMMANDS[cmd];
    if (!handler) {
        showHelp(1, `Unknown command: ${cmd}`);
        return;
    }
    try { await handler(args); }
    catch (err) { console.error(err.message); process.exit(1); }
})();
