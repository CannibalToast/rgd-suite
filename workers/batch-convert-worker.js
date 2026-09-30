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
const {
    stripUtf8BomFromFile,
} = require(path.join(__dirname, '..', 'cli', 'validators.js'));
const { createAttribLoaders } = require(path.join(__dirname, '..', 'cli', 'attribLoaders.js'));

const dict = createAndLoadDictionaries(workerData.dictPaths || []);

const LRU_MAX = 200;
const luaFileCache = new Map();

const attribLoaders = createAttribLoaders(
    {
        readRgdFile: (file, d) => parseRgd(fs.readFileSync(file), d),
        rgdToLua,
        parseLuaToTable,
        luaToRgdResolved,
    },
    dict,
    { cache: luaFileCache, cacheLimit: LRU_MAX },
);

function makeLuaParentLoader(attribBase) {
    return attribLoaders.makeLuaParentLoader(attribBase);
}

function makeRgdParentLoader(attribBase) {
    return attribLoaders.makeRgdParentLoader(attribBase);
}

async function doToLua(inputPath, outputPath, attribBase) {
    const parentLoader = makeLuaParentLoader(attribBase);
    const rgd = parseRgd(fs.readFileSync(inputPath), dict);
    const luaCode = await rgdToLuaDifferential(rgd, parentLoader);
    fs.writeFileSync(outputPath, luaCode, 'utf8');
}

async function doToRgd(inputPath, outputPath, attribBase) {
    const rgdParentLoader = makeRgdParentLoader(attribBase);
    const fixed = stripUtf8BomFromFile(inputPath, fs.readFileSync(inputPath));
    const luaCode = fixed.buffer.toString('utf8');
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
