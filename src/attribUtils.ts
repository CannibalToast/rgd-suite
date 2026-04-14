import * as path from 'path';
import * as fs from 'fs';
import { parseRgd } from '../bundled/rgd-tools/dist/reader';
import {
    rgdToLua,
    luaToRgdResolved,
    parseLuaToTable,
    LuaFileLoader,
    ParentLoader,
    RgdParentLoader,
    ParsedLuaTable,
} from '../bundled/rgd-tools/dist/luaFormat';
import { RgdTable } from '../bundled/rgd-tools/dist/types';
import { HashDictionary } from '../bundled/rgd-tools/dist/dictionary';

// Canonical attrib root finder — checks path for /attrib/, then walks up.
export function findAttribBase(filePath: string): string | null {
    const normalized = filePath.replace(/\\/g, '/').toLowerCase();
    const idx = normalized.lastIndexOf('/attrib/');
    if (idx !== -1) return filePath.substring(0, idx + 7);
    let dir = path.dirname(filePath);
    for (let d = 0; d < 15; d++) {
        const dataAttrib = path.join(dir, 'data', 'attrib');
        const attrib = path.join(dir, 'attrib');
        if (fs.existsSync(dataAttrib)) return dataAttrib;
        if (fs.existsSync(attrib)) return attrib;
        const parent = path.dirname(dir);
        if (parent === dir) break;
        dir = parent;
    }
    return null;
}

// LuaFileLoader that tries .lua first, falls back to .rgd->lua, and caches results.
export function makeLuaFileLoader(
    attribBase: string | null,
    dict: HashDictionary,
    cache = new Map<string, string | null>()
): LuaFileLoader {
    return (refPath: string): string | null => {
        if (!attribBase) return null;
        let clean = refPath.replace(/\\/g, '/');
        if (clean.endsWith('.lua')) clean = clean.slice(0, -4);
        const luaPath = path.join(attribBase, clean + '.lua');
        if (cache.has(luaPath)) return cache.get(luaPath)!;
        if (fs.existsSync(luaPath)) {
            const content = fs.readFileSync(luaPath, 'utf8');
            cache.set(luaPath, content);
            return content;
        }
        const rgdPath = path.join(attribBase, clean + '.rgd');
        if (fs.existsSync(rgdPath)) {
            const parentRgd = parseRgd(fs.readFileSync(rgdPath), dict);
            const content = rgdToLua(parentRgd);
            cache.set(luaPath, content);
            return content;
        }
        cache.set(luaPath, null);
        return null;
    };
}

// ParentLoader wrapping makeLuaFileLoader for use with rgdToLuaDifferential.
export function makeLuaParentLoader(
    attribBase: string | null,
    dict: HashDictionary,
    cache = new Map<string, string | null>()
): ParentLoader {
    const fileLoader = makeLuaFileLoader(attribBase, dict, cache);
    return async (refPath: string): Promise<ParsedLuaTable | null> => {
        const luaCode = fileLoader(refPath);
        if (!luaCode) return null;
        return parseLuaToTable(luaCode, fileLoader);
    };
}

// RgdParentLoader for use with luaToRgdResolved. Tries .rgd first, then .lua.
export function makeRgdParentLoader(attribBase: string | null, dict: HashDictionary): RgdParentLoader {
    const self: RgdParentLoader = async (refPath: string): Promise<RgdTable | null> => {
        if (!attribBase) return null;
        let clean = refPath.replace(/\\/g, '/');
        if (clean.endsWith('.lua')) clean = clean.slice(0, -4);
        const rgdPath = path.join(attribBase, clean + '.rgd');
        if (fs.existsSync(rgdPath)) {
            const data = parseRgd(fs.readFileSync(rgdPath), dict);
            return data.gameData;
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

// Recursive entry counter for RGD gameData.entries.
export function countEntries(entries: any[]): { totalEntries: number; tableCount: number } {
    let totalEntries = 0;
    let tableCount = 0;
    const walk = (arr: any[]) => {
        for (const e of arr) {
            totalEntries++;
            if ((e.type === 100 || e.type === 101) && e.value?.entries) {
                tableCount++;
                walk(e.value.entries);
            }
        }
    };
    walk(entries);
    return { totalEntries, tableCount };
}

// Recursively collect all files with the given extension under folder.
export function collectFiles(folder: string, ext: string): string[] {
    const results: string[] = [];
    const walk = (dir: string) => {
        let entries: fs.Dirent[];
        try { entries = fs.readdirSync(dir, { withFileTypes: true }); } catch { return; }
        for (const e of entries) {
            const full = path.join(dir, e.name);
            if (e.isDirectory()) {
                walk(full);
            } else if (e.isFile() && e.name.toLowerCase().endsWith(ext)) {
                results.push(full);
            }
        }
    };
    walk(folder);
    return results;
}
