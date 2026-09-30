'use strict';
const fs = require('fs');
const { resolveAttribRefPath, stripUtf8BomFromFile } = require('./validators');

function createAttribLoaders(tools, dict, { cache = new Map(), cacheLimit = Infinity } = {}) {
    function cachePut(key, value) {
        if (!Number.isFinite(cacheLimit)) {
            cache.set(key, value);
            return;
        }
        cache.delete(key);
        for (let i = cache.size - cacheLimit; i >= 0; i--) {
            cache.delete(cache.keys().next().value);
        }
        cache.set(key, value);
    }

    function makeLuaFileLoader(attribBase) {
        return function loader(refPath) {
            if (!attribBase) return null;

            // Try .lua first (the canonical source form).
            const luaPath = resolveAttribRefPath(refPath, attribBase, '.lua');
            if (luaPath) {
                if (cache.has(luaPath)) {
                    const cached = cache.get(luaPath);
                    if (Number.isFinite(cacheLimit)) {
                        cache.delete(luaPath);
                        cache.set(luaPath, cached);
                    }
                    return cached;
                }
                if (fs.existsSync(luaPath)) {
                    const fixed = stripUtf8BomFromFile(luaPath, fs.readFileSync(luaPath));
                    const c = fixed.buffer.toString('utf8');
                    cachePut(luaPath, c);
                    return c;
                }
            }

            // Fall back to a compiled .rgd, converting it to Lua text.
            const rgdPath = resolveAttribRefPath(refPath, attribBase, '.rgd');
            if (rgdPath && fs.existsSync(rgdPath)) {
                const c = tools.rgdToLua(tools.readRgdFile(rgdPath, dict));
                cachePut(rgdPath, c);
                return c;
            }

            // Remember that this reference is missing so repeated lookups don't
            // keep hitting the disk / index.
            const cacheKey = luaPath || rgdPath;
            if (cacheKey) cachePut(cacheKey, null);
            return null;
        };
    }

    function makeLuaParentLoader(attribBase) {
        const fileLoader = makeLuaFileLoader(attribBase);
        return async function (refPath) {
            const luaCode = fileLoader(refPath);
            if (!luaCode) return null;
            return tools.parseLuaToTable(luaCode, fileLoader);
        };
    }

    function makeRgdParentLoader(attribBase) {
        const self = async function (refPath) {
            if (!attribBase) return null;

            // Prefer an already-compiled .rgd parent.
            const rgdPath = resolveAttribRefPath(refPath, attribBase, '.rgd');
            if (rgdPath && fs.existsSync(rgdPath)) {
                return tools.readRgdFile(rgdPath, dict).gameData;
            }

            // Fall back to a .lua parent and resolve its own inheritance.
            const luaPath = resolveAttribRefPath(refPath, attribBase, '.lua');
            if (luaPath && fs.existsSync(luaPath)) {
                const fixed = stripUtf8BomFromFile(luaPath, fs.readFileSync(luaPath));
                const code = fixed.buffer.toString('utf8');
                const { gameData } = await tools.luaToRgdResolved(code, dict, self);
                return gameData;
            }

            return null;
        };
        return self;
    }

    return { makeLuaFileLoader, makeLuaParentLoader, makeRgdParentLoader };
}

module.exports = { createAttribLoaders };
