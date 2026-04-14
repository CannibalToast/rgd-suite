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
const { parseLuaToTable, rgdToLua }          = require(path.join(dist, 'luaFormat.js'));
const { RgdDataType }                        = require(path.join(dist, 'types.js'));

// Load dictionary once per worker
const dict = createAndLoadDictionaries(workerData.dictPaths || []);

const FLOAT_EPSILON    = 1e-4;
const CACHE_MAX        = 500;
const attribBaseCache  = new Map();

// ── Helpers ────────────────────────────────────────────────────────────────

function findAttribBase(filePath) {
    const norm = filePath.replace(/\\/g, '/').toLowerCase();
    const idx  = norm.lastIndexOf('/attrib/');
    if (idx !== -1) return filePath.substring(0, idx + 7);
    const dir = path.dirname(filePath);
    if (attribBaseCache.has(dir)) return attribBaseCache.get(dir);
    let cur = dir;
    for (let d = 0; d < 15; d++) {
        const da = path.join(cur, 'data', 'attrib');
        const a  = path.join(cur, 'attrib');
        if (fs.existsSync(da)) { attribBaseCache.set(dir, da); return da; }
        if (fs.existsSync(a))  { attribBaseCache.set(dir, a);  return a;  }
        const parent = path.dirname(cur);
        if (parent === cur) break;
        cur = parent;
    }
    attribBaseCache.set(dir, null);
    return null;
}

function makeLuaFileLoader(attribBase, cache) {
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
            const c = rgdToLua(parseRgd(fs.readFileSync(rgdPath), dict));
            cache.set(luaPath, c);
            return c;
        }
        cache.set(luaPath, null);
        return null;
    };
}

function flattenRgd(table, prefix) {
    const out = new Map();
    prefix = prefix || '';
    for (const entry of table.entries) {
        const k    = entry.name || ('#' + entry.hash.toString(16).padStart(8, '0'));
        const full = prefix ? prefix + '.' + k : k;
        switch (entry.type) {
            case RgdDataType.Table:
            case RgdDataType.TableInt:
                if (entry.value) for (const [sk, sv] of flattenRgd(entry.value, full)) out.set(sk, sv);
                break;
            case RgdDataType.Float:   out.set(full, { type: 'float',  value: entry.value }); break;
            case RgdDataType.Integer: out.set(full, { type: 'int',    value: entry.value }); break;
            case RgdDataType.Bool:    out.set(full, { type: 'bool',   value: entry.value }); break;
            case RgdDataType.String:
            case RgdDataType.WString:
                if (k === '$REF') break;
                out.set(full, { type: 'string', value: entry.value }); break;
            case RgdDataType.NoData:  out.set(full, { type: 'nil', value: null }); break;
        }
    }
    return out;
}

function flattenLua(table, prefix) {
    const out = new Map();
    prefix = prefix || '';
    for (const [key, entry] of table.entries) {
        const full = prefix ? prefix + '.' + key : key;
        if (entry.type === 'table' && entry.table) {
            for (const [sk, sv] of flattenLua(entry.table, full)) out.set(sk, sv);
        } else {
            const val = entry.value;
            if (val === null || val === undefined) {
                out.set(full, { type: 'nil', value: null });
            } else if (typeof val === 'boolean') {
                out.set(full, { type: 'bool', value: val });
            } else if (typeof val === 'number') {
                const isFloat = entry.dataType === RgdDataType.Float || !Number.isInteger(val);
                out.set(full, { type: isFloat ? 'float' : 'int', value: val });
            } else if (typeof val === 'string') {
                out.set(full, { type: 'string', value: val });
            }
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

function collectMissingRefs(luaTable, attribBase, prefix) {
    const issues = [];
    prefix = prefix || '';
    for (const [key, entry] of luaTable.entries) {
        const full = prefix ? prefix + '.' + key : key;
        if (entry.type === 'table' && entry.reference && attribBase) {
            let ref = entry.reference.replace(/\\/g, '/');
            if (!ref.endsWith('.lua')) ref += '.lua';
            if (!fs.existsSync(path.join(attribBase, ref)))
                issues.push({ kind: 'missing_ref', key: full, details: 'Reference not found on disk: ' + ref });
        }
        if (entry.type === 'table' && entry.table)
            issues.push(...collectMissingRefs(entry.table, attribBase, full));
    }
    return issues;
}

function checkParity(rgdPath, luaPath, fileCache) {
    const attribBase = findAttribBase(rgdPath) || findAttribBase(luaPath);
    const luaLoader  = makeLuaFileLoader(attribBase, fileCache);
    const issues     = [];

    const rgdFile = parseRgd(fs.readFileSync(rgdPath), dict);
    const rgdMap  = flattenRgd(rgdFile.gameData);

    const luaTable = parseLuaToTable(fs.readFileSync(luaPath, 'utf8'), luaLoader);
    const luaMap   = flattenLua(luaTable);

    issues.push(...collectMissingRefs(luaTable, attribBase));

    for (const [key, re] of rgdMap) {
        if (key.endsWith('.$ref')) continue;
        const le = luaMap.get(key);
        if (!le) {
            issues.push({ kind: 'missing_in_lua', key, details: 'RGD: ' + JSON.stringify(re.value) + ' (' + re.type + ')' });
        } else if (!valuesMatch(re, le)) {
            const num = t => t === 'float' || t === 'int';
            if (re.type !== le.type && !num(re.type) && !num(le.type))
                issues.push({ kind: 'type_mismatch',  key, details: 'RGD=' + re.type + ', Lua=' + le.type });
            else
                issues.push({ kind: 'value_mismatch', key, details: 'RGD=' + JSON.stringify(re.value) + ', Lua=' + JSON.stringify(le.value) });
        }
    }

    for (const [key, le] of luaMap) {
        if (key.endsWith('.$ref') || le.type === 'nil') continue;
        if (!rgdMap.has(key))
            issues.push({ kind: 'missing_in_rgd', key, details: 'Lua: ' + JSON.stringify(le.value) + ' (' + le.type + ')' });
    }

    return { rgdFile: rgdPath, luaFile: luaPath, totalKeys: rgdMap.size, issues, attribResolved: !!attribBase };
}

// ── Message loop ───────────────────────────────────────────────────────────

const fileCache = new Map();

parentPort.on('message', function ({ id, rgdPath, luaPath }) {
    if (fileCache.size >= CACHE_MAX) fileCache.clear();
    try {
        const result = checkParity(rgdPath, luaPath, fileCache);
        parentPort.postMessage({ id, result });
    } catch (e) {
        parentPort.postMessage({ id, error: e.message });
    }
});
