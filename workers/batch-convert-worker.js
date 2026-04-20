'use strict';
/**
 * batch-convert-worker.js — runs rgd→lua and lua→rgd conversions inside a
 * worker thread so batch operations don't block the extension host.
 *
 * Receives { id, op, inputPath, outputPath, attribBase } messages and posts
 * back { id, ok: true } or { id, error }.
 */
const { workerData, parentPort } = require('worker_threads');
const path = require('path');
const fs = require('fs');
const dist = workerData.distPath;

const { createAndLoadDictionaries }                       = require(path.join(dist, 'dictionary.js'));
const { parseRgd }                                        = require(path.join(dist, 'reader.js'));
const { writeRgdFile }                                    = require(path.join(dist, 'writer.js'));
const { rgdToLua, rgdToLuaDifferential,
        luaToRgdResolved, parseLuaToTable }               = require(path.join(dist, 'luaFormat.js'));

const dict = createAndLoadDictionaries(workerData.dictPaths || []);

const LRU_MAX = 200;
const luaFileCache = new Map();

function touch(cache, key, value) {
    if (cache.has(key)) cache.delete(key);
    else if (cache.size >= LRU_MAX) cache.delete(cache.keys().next().value);
    cache.set(key, value);
}

function makeLuaFileLoader(attribBase) {
    return function loader(refPath) {
        if (!attribBase) return null;
        let clean = refPath.replace(/\\/g, '/');
        if (clean.endsWith('.lua')) clean = clean.slice(0, -4);
        const luaPath = path.join(attribBase, clean + '.lua');
        if (luaFileCache.has(luaPath)) {
            const v = luaFileCache.get(luaPath);
            luaFileCache.delete(luaPath); luaFileCache.set(luaPath, v);
            return v;
        }
        if (fs.existsSync(luaPath)) {
            const c = fs.readFileSync(luaPath, 'utf8');
            touch(luaFileCache, luaPath, c);
            return c;
        }
        const rgdPath = path.join(attribBase, clean + '.rgd');
        if (fs.existsSync(rgdPath)) {
            const c = rgdToLua(parseRgd(fs.readFileSync(rgdPath), dict));
            touch(luaFileCache, luaPath, c);
            return c;
        }
        touch(luaFileCache, luaPath, null);
        return null;
    };
}

function makeLuaParentLoader(attribBase) {
    const fileLoader = makeLuaFileLoader(attribBase);
    return async function (refPath) {
        const luaCode = fileLoader(refPath);
        if (!luaCode) return null;
        return parseLuaToTable(luaCode, fileLoader);
    };
}

function makeRgdParentLoader(attribBase) {
    const self = async function (refPath) {
        if (!attribBase) return null;
        let clean = refPath.replace(/\\/g, '/');
        if (clean.endsWith('.lua')) clean = clean.slice(0, -4);
        const rgdPath = path.join(attribBase, clean + '.rgd');
        if (fs.existsSync(rgdPath)) {
            return parseRgd(fs.readFileSync(rgdPath), dict).gameData;
        }
        const luaPath = path.join(attribBase, clean + '.lua');
        if (fs.existsSync(luaPath)) {
            const parentLua = fs.readFileSync(luaPath, 'utf8');
            const { gameData } = await luaToRgdResolved(parentLua, dict, self);
            return gameData;
        }
        return null;
    };
    return self;
}

async function doToLua(inputPath, outputPath, attribBase) {
    const parentLoader = makeLuaParentLoader(attribBase);
    const rgd = parseRgd(fs.readFileSync(inputPath), dict);
    const luaCode = await rgdToLuaDifferential(rgd, parentLoader);
    fs.writeFileSync(outputPath, luaCode, 'utf8');
}

async function doToRgd(inputPath, outputPath, attribBase) {
    const rgdParentLoader = makeRgdParentLoader(attribBase);
    const luaCode = fs.readFileSync(inputPath, 'utf8');
    const { gameData, version } = await luaToRgdResolved(luaCode, dict, rgdParentLoader);
    writeRgdFile(outputPath, gameData, dict, version);
}

parentPort.on('message', async function ({ id, op, inputPath, outputPath, attribBase }) {
    try {
        if (op === 'toLua')      await doToLua(inputPath, outputPath, attribBase);
        else if (op === 'toRgd') await doToRgd(inputPath, outputPath, attribBase);
        else throw new Error('Unknown op: ' + op);
        parentPort.postMessage({ id, ok: true });
    } catch (e) {
        parentPort.postMessage({ id, error: e.message });
    }
});
