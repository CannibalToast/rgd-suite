'use strict';
/**
 * parity-worker.js — runs checkParity() inside a worker thread.
 * Self-contained: loads the dist modules directly via absolute paths
 * supplied through workerData so it has no dependency on the bundled extension.
 */
const { workerData, parentPort } = require('worker_threads');
const path  = require('path');
const fs    = require('fs');
const dist  = workerData.distPath;

const { createAndLoadDictionaries }          = require(path.join(dist, 'dictionary.js'));
const { parseRgd }                           = require(path.join(dist, 'reader.js'));
const { luaToRgdResolved }                   = require(path.join(dist, 'luaFormat.js'));
const { RgdDataType }                        = require(path.join(dist, 'types.js'));
const {
    validateEncoding,
    validateRgdReferences,
    resolveAttribRefPath,
    stripUtf8Bom,
    stripUtf8BomFromFile,
} = require(path.join(__dirname, '..', 'cli', 'validators.js'));

const dict = createAndLoadDictionaries(workerData.dictPaths || []);

const FLOAT_EPSILON         = 1e-4;
const ATTRIB_BASE_CACHE_MAX = 2000;
const attribBaseCache       = new Map();

// ── Helpers ────────────────────────────────────────────────────────────────

function rememberAttribBase(key, value) {
    if (attribBaseCache.has(key)) attribBaseCache.delete(key);
    else if (attribBaseCache.size >= ATTRIB_BASE_CACHE_MAX) {
        attribBaseCache.delete(attribBaseCache.keys().next().value);
    }
    attribBaseCache.set(key, value);
}

function findAttribBase(filePath) {
    const norm = filePath.replace(/\\/g, '/').toLowerCase();
    const idx  = norm.lastIndexOf('/attrib/');
    if (idx !== -1) return filePath.substring(0, idx + 7);
    const dir = path.dirname(filePath);
    if (attribBaseCache.has(dir)) {
        const v = attribBaseCache.get(dir);
        attribBaseCache.delete(dir);
        attribBaseCache.set(dir, v);
        return v;
    }
    let cur = dir;
    for (let d = 0; d < 15; d++) {
        const da = path.join(cur, 'data', 'attrib');
        const a  = path.join(cur, 'attrib');
        if (fs.existsSync(da)) { rememberAttribBase(dir, da); return da; }
        if (fs.existsSync(a))  { rememberAttribBase(dir, a);  return a;  }
        const parent = path.dirname(cur);
        if (parent === cur) break;
        cur = parent;
    }
    rememberAttribBase(dir, null);
    return null;
}


function makeRgdParentLoader(attribBase) {
    const self = async (refPath) => {
        if (!attribBase) return null;

        const rgdPath = resolveAttribRefPath(refPath, attribBase, '.rgd');
        if (rgdPath && fs.existsSync(rgdPath)) {
            return parseRgd(fs.readFileSync(rgdPath), dict).gameData;
        }

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

function flattenRgd(table, prefix, out) {
    out = out || new Map();
    prefix = prefix || '';
    for (const entry of table.entries) {
        const k    = entry.name || ('#' + entry.hash.toString(16).padStart(8, '0'));
        const full = prefix ? prefix + '.' + k : k;
        switch (entry.type) {
            case RgdDataType.Table:
            case RgdDataType.TableInt:
                if (entry.value) flattenRgd(entry.value, full, out);
                break;
            case RgdDataType.Float:   out.set(full, { type: 'float',  value: entry.value }); break;
            case RgdDataType.Integer: out.set(full, { type: 'int',    value: entry.value }); break;
            case RgdDataType.Bool:    out.set(full, { type: 'bool',   value: entry.value }); break;
            case RgdDataType.String:
            case RgdDataType.WString:
                if (k === '$REF') break;
                out.set(full, { type: 'string', value: entry.value }); break;
            // NoData = "delete inherited value"; omitting the key in Lua is
            // the correct representation. Skip to avoid false missing_in_lua.
            case RgdDataType.NoData:  break;
        }
    }
    return out;
}

function valuesMatch(a, b) {
    const num = t => t === 'float' || t === 'int';
    if (num(a.type) && num(b.type)) return Math.abs(a.value - b.value) <= FLOAT_EPSILON;
    if (a.type !== b.type) return false;
    if (a.type === 'nil') return true;
    return a.value === b.value;
}

async function checkParity(rgdPath, luaPath) {
    const attribBase = findAttribBase(rgdPath) || findAttribBase(luaPath);
    const issues     = [];
    const validationIssues = [];
    const fixes = [];

    const rgdBuf = fs.readFileSync(rgdPath);

    const bomResult = stripUtf8BomFromFile(luaPath, fs.readFileSync(luaPath));
    if (bomResult.fix) fixes.push(bomResult.fix);
    const luaBuf = bomResult.buffer;
    validationIssues.push(...validateEncoding(luaBuf, luaPath).issues);
    const luaCode = stripUtf8Bom(luaBuf.toString('utf8'));

    // Compile the Lua source to an effective RGD so we compare full, resolved
    // data instead of the raw source text. Custom key names are added to the
    // shared dictionary during compilation, making the later RGD parse resolve
    // them to readable names.
    const rgdParent = makeRgdParentLoader(attribBase);
    const { gameData: compiledGameData } = await luaToRgdResolved(luaCode, dict, rgdParent);

    const rgdFile = parseRgd(rgdBuf, dict);
    const rgdMap  = flattenRgd(rgdFile.gameData);
    const compiledMap = flattenRgd(compiledGameData);

    validationIssues.push(...validateRgdReferences(rgdFile.gameData, attribBase));
    validationIssues.push(...validateRgdReferences(compiledGameData, attribBase));

    for (const [key, re] of rgdMap) {
        if (key.endsWith('.$ref')) continue;
        const ce = compiledMap.get(key);
        if (!ce) {
            issues.push({ kind: 'missing_in_lua', key, details: 'RGD: ' + JSON.stringify(re.value) + ' (' + re.type + ')' });
        } else if (!valuesMatch(re, ce)) {
            const num = t => t === 'float' || t === 'int';
            if (re.type !== ce.type && !num(re.type) && !num(ce.type))
                issues.push({ kind: 'type_mismatch',  key, details: 'RGD=' + re.type + ', Lua=' + ce.type });
            else
                issues.push({ kind: 'value_mismatch', key, details: 'RGD=' + JSON.stringify(re.value) + ', Lua=' + JSON.stringify(ce.value) });
        }
    }

    for (const [key, ce] of compiledMap) {
        if (key.endsWith('.$ref') || ce.type === 'nil') continue;
        if (!rgdMap.has(key))
            issues.push({ kind: 'missing_in_rgd', key, details: 'Lua: ' + JSON.stringify(ce.value) + ' (' + ce.type + ')' });
    }

    return { rgdFile: rgdPath, luaFile: luaPath, totalKeys: rgdMap.size, issues, validationIssues, fixes, attribResolved: !!attribBase };
}

// ── Message loop ───────────────────────────────────────────────────────────

parentPort.on('message', async ({ id, rgdPath, luaPath }) => {
    try {
        const result = await checkParity(rgdPath, luaPath);
        parentPort.postMessage({ id, result });
    } catch (e) {
        parentPort.postMessage({ id, error: e && e.message ? e.message : String(e) });
    }
});
