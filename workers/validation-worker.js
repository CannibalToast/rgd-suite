'use strict';
/**
 * validation-worker.js — validates individual RGD/Lua/text files inside a
 * worker thread so VS Code batch validation does not block the extension host.
 */
const { workerData, parentPort } = require('worker_threads');
const path = require('path');
const fs = require('fs');
const dist = workerData.distPath;

const { createAndLoadDictionaries } = require(path.join(dist, 'dictionary.js'));
const { parseRgd } = require(path.join(dist, 'reader.js'));
const { rgdToLua, parseLuaToTable } = require(path.join(dist, 'luaFormat.js'));
const {
    resolveAttribRefPath,
    stripUtf8Bom,
    stripUtf8BomFromFile,
    validateEncoding,
    validateLuaReferences,
    validateRgdReferences,
} = require(path.join(__dirname, '..', 'cli', 'validators.js'));

const dict = createAndLoadDictionaries(workerData.dictPaths || []);
const FILE_CACHE_MAX = 500;
const luaFileCache = new Map();

function touch(cache, key, value) {
    if (cache.has(key)) cache.delete(key);
    else if (cache.size >= FILE_CACHE_MAX) cache.delete(cache.keys().next().value);
    cache.set(key, value);
}

function makeFix(filePath) {
    return {
        kind: 'bom_stripped',
        severity: 'info',
        path: filePath,
        details: 'Removed UTF-8 BOM',
    };
}

function makeLuaFileLoader(attribBase) {
    return function loader(refPath) {
        if (!attribBase) return null;
        const luaPath = resolveAttribRefPath(refPath, attribBase, '.lua');
        if (!luaPath) return null;
        if (luaFileCache.has(luaPath)) {
            const cached = luaFileCache.get(luaPath);
            luaFileCache.delete(luaPath);
            luaFileCache.set(luaPath, cached);
            return cached;
        }
        if (fs.existsSync(luaPath)) {
            const fixed = stripUtf8BomFromFile(luaPath, fs.readFileSync(luaPath));
            const content = fixed.buffer.toString('utf8');
            touch(luaFileCache, luaPath, content);
            return content;
        }
        const rgdPath = resolveAttribRefPath(refPath, attribBase, '.rgd');
        if (rgdPath && fs.existsSync(rgdPath)) {
            const content = rgdToLua(parseRgd(fs.readFileSync(rgdPath), dict));
            touch(luaFileCache, luaPath, content);
            return content;
        }
        touch(luaFileCache, luaPath, null);
        return null;
    };
}

function validateFile(filePath, attribBase) {
    const lower = filePath.toLowerCase();
    const issues = [];
    const fixes = [];

    if (lower.endsWith('.lua') || lower.endsWith('.rgd.txt')) {
        const fixed = stripUtf8BomFromFile(filePath, fs.readFileSync(filePath));
        if (fixed.fixed) fixes.push(makeFix(filePath));
        const buffer = fixed.buffer;
        issues.push(...validateEncoding(buffer, filePath).issues);

        if (lower.endsWith('.lua')) {
            const lua = stripUtf8Bom(buffer.toString('utf8'));
            const loader = makeLuaFileLoader(attribBase);
            const table = parseLuaToTable(lua, loader);
            issues.push(...validateLuaReferences(table, attribBase));
        }
    } else if (lower.endsWith('.rgd')) {
        const rgd = parseRgd(fs.readFileSync(filePath), dict);
        issues.push(...validateRgdReferences(rgd.gameData, attribBase));
    }

    return { filePath, issues, fixes };
}

parentPort.on('message', function ({ id, filePath, attribBase }) {
    try {
        const result = validateFile(filePath, attribBase || null);
        parentPort.postMessage({ id, result });
    } catch (e) {
        parentPort.postMessage({ id, error: e && e.message ? e.message : String(e) });
    }
});
