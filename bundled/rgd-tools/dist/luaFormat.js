"use strict";
/**
 * RGD Lua Format - Convert between RGD and Lua GameData format
 *
 * This matches the format used by Corsix Mod Studio for Lua dumps.
 *
 * Corsix Lua Format (Differential):
 *   GameData = Inherit([[]])                           -- Root inheritance (empty or parent path)
 *   GameData["table"] = Reference([[path\to\ref.lua]]) -- Child table with reference (only if different from parent)
 *   GameData["key"] = 5                                -- Only outputs values that differ from parent
 *   GameData["key"] = nil                              -- Delete/clear inherited value
 *
 * Key features:
 *   - Uses Reference() for child tables, Inherit() only for root GameData
 *   - Single backslashes in [[ ]] strings (no escaping needed)
 *   - Only outputs values that differ from the inherited parent
 *   - Uses nil to delete inherited values
 */
Object.defineProperty(exports, "__esModule", { value: true });
exports.rgdToLuaDifferential = rgdToLuaDifferential;
exports.rgdToLua = rgdToLua;
exports.luaToRgd = luaToRgd;
exports.luaToRgdResolved = luaToRgdResolved;
exports.parseLuaToTable = parseLuaToTable;
const types_1 = require("./types");
const dictionary_1 = require("./dictionary");
const hash_1 = require("./hash");
const REF_HASH = 0x49D60FAE;
/**
 * Natural/numerical string comparison for proper ordering of numbered entries
 * e.g., text_01, text_02, ... text_10 instead of text_01, text_10, text_02
 */
function naturalCompare(a, b) {
    const aParts = a.split(/(\d+)/);
    const bParts = b.split(/(\d+)/);
    for (let i = 0; i < Math.max(aParts.length, bParts.length); i++) {
        const aPart = aParts[i] || '';
        const bPart = bParts[i] || '';
        // Check if both parts are numeric
        const aNum = parseInt(aPart, 10);
        const bNum = parseInt(bPart, 10);
        if (!isNaN(aNum) && !isNaN(bNum)) {
            if (aNum !== bNum)
                return aNum - bNum;
        }
        else {
            const cmp = aPart.localeCompare(bPart);
            if (cmp !== 0)
                return cmp;
        }
    }
    return 0;
}
/**
 * Convert RGD file to Lua format (Corsix differential style)
 *
 * @param rgdFile The RGD file to convert
 * @param parentLoader Optional function to load parent files for differential comparison
 * @param sourceName Optional source filename for comments
 */
async function rgdToLuaDifferential(rgdFile, parentLoader) {
    const lines = [];
    // GameData declaration with inheritance
    const ref = rgdFile.gameData.reference;
    if (ref) {
        lines.push(`GameData = Inherit([[${ref}]])`);
    }
    else {
        lines.push('GameData = Inherit([[]])');
    }
    // Load parent table if available
    let parentTable = null;
    if (parentLoader && ref) {
        try {
            parentTable = await parentLoader(ref);
        }
        catch (e) {
            // Parent not found, continue without differential
        }
    }
    // Write entries with differential comparison
    await writeTableEntriesDifferential(lines, rgdFile.gameData, 'GameData', parentTable, parentLoader);
    // Ensure trailing newline
    lines.push('');
    return lines.join('\n');
}
/**
 * Convert RGD file to Lua format (simple complete dump - no differential)
 */
function rgdToLua(rgdFile, sourceName) {
    const lines = [];
    // GameData declaration with inheritance
    const ref = rgdFile.gameData.reference;
    if (ref) {
        lines.push(`GameData = Inherit([[${ref}]])`);
    }
    else {
        lines.push('GameData = Inherit([[]])');
    }
    // Write all entries (complete dump)
    writeTableEntries(lines, rgdFile.gameData, 'GameData');
    // Ensure trailing newline
    lines.push('');
    return lines.join('\n');
}
/**
 * Write table entries with differential comparison (Corsix style)
 *
 * Algorithm from Corsix CLuaFromRgd.cpp:
 * 1. Merge entries from RGD table and inherited table (RGD entries first, then parent-only)
 * 2. For each merged entry:
 *    - If RGD has it but parent doesn't → output value
 *    - If parent has it but RGD doesn't → output nil
 *    - If both have it but values differ → output value
 *    - If both have it and values match → don't output
 * 3. For tables: if Reference() differs, load the NEW reference file for comparison
 */
async function writeTableEntriesDifferential(lines, table, path, parentTable, parentLoader) {
    const mergedEntries = [];
    const uniqueEntries = new Map();
    for (const entry of table.entries) {
        if (entry.hash === REF_HASH)
            continue;
        const name = entry.name ?? (0, hash_1.hashToHex)(entry.hash);
        uniqueEntries.set(name, entry);
    }
    for (const [name, rgdEntry] of uniqueEntries) {
        mergedEntries.push({
            name,
            rgdEntry,
            parentEntry: parentTable?.entries.get(name) ?? null
        });
    }
    // Sort entries using natural/numerical sort (text_01, text_02, ... text_10)
    mergedEntries.sort((a, b) => naturalCompare(a.name, b.name));
    // Process each merged entry
    for (const { name, rgdEntry, parentEntry } of mergedEntries) {
        const keyPath = `${path}["${escapeLuaString(name)}"]`;
        if (rgdEntry.type === types_1.RgdDataType.Table || rgdEntry.type === types_1.RgdDataType.TableInt) {
            const childTable = rgdEntry.value;
            const childRef = childTable.reference;
            const parentRef = parentEntry?.reference;
            // Check if reference differs from parent
            const refDiffers = childRef !== parentRef;
            // Determine what to compare against for children
            let comparisonTable = null;
            if (refDiffers) {
                // Reference differs from parent - output Reference() and load NEW reference for comparison
                if (childRef) {
                    lines.push(`${keyPath} = Reference([[${childRef}]])`);
                    // Load the NEW reference file to compare children against
                    if (parentLoader) {
                        try {
                            comparisonTable = await parentLoader(childRef);
                        }
                        catch (e) {
                            // Reference file not found
                        }
                    }
                }
                // If RGD has no reference but parent does, DON'T output {} 
                // Just process children with null comparison table (output all values)
                // comparisonTable stays null
            }
            else {
                // Reference same as parent - use parent's table for comparison
                comparisonTable = parentEntry?.table ?? null;
            }
            // Recursively process children
            await writeTableEntriesDifferential(lines, childTable, keyPath, comparisonTable, parentLoader);
        }
        else {
            // Simple value - check if it differs from parent
            const shouldOutput = !parentEntry ||
                parentEntry.type !== 'value' ||
                !valuesEqual(rgdEntry.type, rgdEntry.value, parentEntry.dataType, parentEntry.value) ||
                name === 'screen_name_id';
            if (shouldOutput) {
                const valueStr = formatLuaValue(rgdEntry.type, rgdEntry.value);
                lines.push(`${keyPath} = ${valueStr}`);
            }
        }
    }
}
/**
 * Check if two values are equal
 */
function valuesEqual(type1, val1, type2, val2) {
    if (type1 !== type2)
        return false;
    if (type1 === types_1.RgdDataType.Float) {
        return Math.abs(val1 - val2) < 0.00001;
    }
    return val1 === val2;
}
/**
 * Write table entries in Lua format (complete dump - no differential)
 */
function writeTableEntries(lines, table, path) {
    // Sort entries: simple values first, then tables
    const sorted = [...table.entries].sort((a, b) => {
        // Skip $REF
        if (a.hash === REF_HASH)
            return -1;
        if (b.hash === REF_HASH)
            return 1;
        const aIsTable = a.type === types_1.RgdDataType.Table || a.type === types_1.RgdDataType.TableInt;
        const bIsTable = b.type === types_1.RgdDataType.Table || b.type === types_1.RgdDataType.TableInt;
        if (aIsTable !== bIsTable)
            return aIsTable ? 1 : -1;
        const aName = a.name ?? (0, hash_1.hashToHex)(a.hash);
        const bName = b.name ?? (0, hash_1.hashToHex)(b.hash);
        return aName.localeCompare(bName);
    });
    for (const entry of sorted) {
        // Skip $REF entries (handled in inheritance)
        if (entry.hash === REF_HASH)
            continue;
        const name = entry.name ?? (0, hash_1.hashToHex)(entry.hash);
        const keyPath = `${path}["${escapeLuaString(name)}"]`;
        if (entry.type === types_1.RgdDataType.Table || entry.type === types_1.RgdDataType.TableInt) {
            const childTable = entry.value;
            // Corsix uses Reference() for child tables, not Inherit()
            // Single backslashes in [[ ]] strings - no escaping needed
            if (childTable.reference) {
                lines.push(`${keyPath} = Reference([[${childTable.reference}]])`);
            }
            else {
                lines.push(`${keyPath} = {}`);
            }
            // Write child entries
            writeTableEntries(lines, childTable, keyPath);
        }
        else {
            // Simple value
            const valueStr = formatLuaValue(entry.type, entry.value);
            lines.push(`${keyPath} = ${valueStr}`);
        }
    }
}
/**
 * Format a value for Lua output
 */
function formatLuaValue(type, value) {
    switch (type) {
        case types_1.RgdDataType.Float: {
            const f = value;
            // Corsix uses integer format for whole numbers
            if (Number.isInteger(f)) {
                return f.toString();
            }
            const precision = f.toPrecision(10);
            const trimmed = precision.replace(/\.?0+$/, '');
            return trimmed;
        }
        case types_1.RgdDataType.Integer:
            return value.toString();
        case types_1.RgdDataType.Bool:
            return value ? 'true' : 'false';
        case types_1.RgdDataType.String:
            return `[[${value}]]`;
        case types_1.RgdDataType.WString:
            // WStrings with $ prefix are UCS references
            const ws = value;
            if (ws.startsWith('$')) {
                return `[[${ws}]]`;
            }
            return `[[${ws}]]`;
        default:
            return `[[${String(value)}]]`;
    }
}
/**
 * Escape a string for use as a Lua table key
 */
function escapeLuaString(str) {
    return str
        .replace(/\\/g, '\\\\')
        .replace(/"/g, '\\"')
        .replace(/\n/g, '\\n')
        .replace(/\r/g, '\\r');
}
/**
 * Parse Lua GameData format back to RGD structure
 */
function luaToRgd(luaCode, dict) {
    const lines = luaCode.split(/\r?\n/);
    const gameData = { entries: [] };
    let version = 1; // Default to DoW version
    // Track tables we've created
    const tables = new Map();
    tables.set('GameData', gameData);
    for (const line of lines) {
        const trimmed = line.trim();
        // Skip comments and empty lines
        if (trimmed === '' || trimmed.startsWith('--'))
            continue;
        // Parse GameData = Inherit([[path]]) or GameData = Inherit([[]])
        const inheritMatch = trimmed.match(/^GameData\s*=\s*Inherit\s*\(\s*\[\[(.*?)\]\]\s*\)/);
        if (inheritMatch) {
            const refPath = inheritMatch[1];
            if (refPath) {
                gameData.reference = refPath;
                // Add $REF entry
                gameData.entries.push({
                    hash: REF_HASH,
                    name: '$REF',
                    type: types_1.RgdDataType.String,
                    value: refPath
                });
            }
            continue;
        }
        // Parse GameData = {}
        if (trimmed === 'GameData = {}') {
            continue;
        }
        // Parse assignments: GameData["key"]["subkey"] = value
        const assignMatch = trimmed.match(/^(GameData(?:\["[^"]+"\])+)\s*=\s*(.+)$/);
        if (assignMatch) {
            const fullPath = assignMatch[1];
            const valueStr = assignMatch[2].trim();
            // Extract keys from path
            const keys = [];
            const keyRegex = /\["([^"]+)"\]/g;
            let keyMatch;
            while ((keyMatch = keyRegex.exec(fullPath)) !== null) {
                keys.push(keyMatch[1]);
            }
            if (keys.length === 0)
                continue;
            // Navigate to parent table, creating as needed
            let currentTable = gameData;
            let currentPath = 'GameData';
            for (let i = 0; i < keys.length - 1; i++) {
                const key = keys[i];
                currentPath += `["${key}"]`;
                // Find or create table
                let existingTable = tables.get(currentPath);
                if (!existingTable) {
                    const h = (0, dictionary_1.nameToHash)(dict, key);
                    const newTable = { entries: [] };
                    tables.set(currentPath, newTable);
                    currentTable.entries.push({
                        hash: h,
                        name: key,
                        type: types_1.RgdDataType.Table,
                        value: newTable
                    });
                    existingTable = newTable;
                }
                currentTable = existingTable;
            }
            // Add the final entry
            const finalKey = keys[keys.length - 1];
            const finalHash = (0, dictionary_1.nameToHash)(dict, finalKey);
            const finalPath = currentPath + `["${finalKey}"]`;
            // Parse value
            if (valueStr === '{}') {
                // Empty table
                const newTable = { entries: [] };
                tables.set(finalPath, newTable);
                currentTable.entries.push({
                    hash: finalHash,
                    name: finalKey,
                    type: types_1.RgdDataType.Table,
                    value: newTable
                });
            }
            else if (valueStr.startsWith('Inherit') || valueStr.startsWith('Reference')) {
                // Table with inheritance (Inherit for root, Reference for children)
                const refMatch = valueStr.match(/(?:Inherit|Reference)\s*\(\s*\[\[(.+?)\]\]\s*\)/);
                const refPath = refMatch ? refMatch[1] : undefined;
                const newTable = { entries: [], reference: refPath };
                if (refPath) {
                    newTable.entries.push({
                        hash: REF_HASH,
                        name: '$REF',
                        type: types_1.RgdDataType.String,
                        value: refPath
                    });
                }
                tables.set(finalPath, newTable);
                currentTable.entries.push({
                    hash: finalHash,
                    name: finalKey,
                    type: types_1.RgdDataType.Table,
                    value: newTable
                });
            }
            else {
                // Parse simple value
                const { type, value } = parseLuaValue(valueStr);
                currentTable.entries.push({
                    hash: finalHash,
                    name: finalKey,
                    type,
                    value
                });
            }
        }
    }
    return { gameData, version };
}
/**
 * Parse Lua GameData format to RGD with full resolution of Inherit/Reference
 * This creates a complete RGD by loading and merging parent files
 */
async function luaToRgdResolved(luaCode, dict, parentLoader) {
    const lines = luaCode.split(/\r?\n/);
    let gameData = { entries: [] };
    let version = 1;
    // First pass: find root Inherit and load base data
    for (const line of lines) {
        const trimmed = line.trim();
        const inheritMatch = trimmed.match(/^GameData\s*=\s*Inherit\s*\(\s*\[\[(.*?)\]\]\s*\)/);
        if (inheritMatch) {
            const refPath = inheritMatch[1];
            if (refPath) {
                const parentTable = await parentLoader(refPath);
                if (parentTable) {
                    // Deep copy parent as base
                    gameData = deepCopyRgdTable(parentTable);
                }
            }
            break;
        }
    }
    // Track tables for navigation
    const tables = new Map();
    tables.set('GameData', gameData);
    // Second pass: apply all assignments
    for (const line of lines) {
        const trimmed = line.trim();
        if (trimmed === '' || trimmed.startsWith('--'))
            continue;
        if (trimmed.match(/^GameData\s*=\s*Inherit/))
            continue; // Already handled
        // Parse assignments
        const assignMatch = trimmed.match(/^(GameData(?:\["[^"]+"\])+)\s*=\s*(.+)$/);
        if (!assignMatch)
            continue;
        const fullPath = assignMatch[1];
        let valueStr = assignMatch[2].trim();
        // Remove trailing comment
        const commentIdx = valueStr.indexOf('--');
        if (commentIdx > 0) {
            valueStr = valueStr.substring(0, commentIdx).trim();
        }
        // Extract keys
        const keys = [];
        const keyRegex = /\["([^"]+)"\]/g;
        let keyMatch;
        while ((keyMatch = keyRegex.exec(fullPath)) !== null) {
            keys.push(keyMatch[1]);
        }
        if (keys.length === 0)
            continue;
        // Handle nil - remove entry from parent
        if (valueStr === 'nil') {
            const parentPath = keys.slice(0, -1);
            const finalKey = keys[keys.length - 1];
            const parentTable = navigateToTable(gameData, parentPath, tables, dict);
            if (parentTable) {
                // Remove entry with this name
                parentTable.entries = parentTable.entries.filter(e => e.name !== finalKey);
            }
            continue;
        }
        // Navigate to parent table
        let currentTable = gameData;
        let currentPath = 'GameData';
        for (let i = 0; i < keys.length - 1; i++) {
            const key = keys[i];
            currentPath += `["${key}"]`;
            let childTable = findOrCreateTable(currentTable, key, tables, currentPath, dict);
            currentTable = childTable;
        }
        const finalKey = keys[keys.length - 1];
        const finalHash = (0, dictionary_1.nameToHash)(dict, finalKey);
        const finalPath = currentPath + `["${finalKey}"]`;
        // Handle Reference - load base and merge
        if (valueStr.startsWith('Reference')) {
            const refMatch = valueStr.match(/Reference\s*\(\s*\[\[(.+?)\]\]\s*\)/);
            const refPath = refMatch ? refMatch[1] : undefined;
            let newTable;
            if (refPath) {
                const refTable = await parentLoader(refPath);
                if (refTable) {
                    newTable = deepCopyRgdTable(refTable);
                    newTable.reference = refPath;
                    // Ensure $REF entry exists
                    if (!newTable.entries.find(e => e.hash === REF_HASH)) {
                        newTable.entries.unshift({
                            hash: REF_HASH,
                            name: '$REF',
                            type: types_1.RgdDataType.String,
                            value: refPath
                        });
                    }
                }
                else {
                    newTable = { entries: [], reference: refPath };
                    newTable.entries.push({
                        hash: REF_HASH,
                        name: '$REF',
                        type: types_1.RgdDataType.String,
                        value: refPath
                    });
                }
            }
            else {
                newTable = { entries: [] };
            }
            // Replace or add table entry
            replaceOrAddEntry(currentTable, finalKey, finalHash, types_1.RgdDataType.Table, newTable);
            tables.set(finalPath, newTable);
        }
        else if (valueStr === '{}') {
            const newTable = { entries: [] };
            replaceOrAddEntry(currentTable, finalKey, finalHash, types_1.RgdDataType.Table, newTable);
            tables.set(finalPath, newTable);
        }
        else {
            // Simple value
            const { type, value } = parseLuaValue(valueStr);
            replaceOrAddEntry(currentTable, finalKey, finalHash, type, value);
        }
    }
    return { gameData, version };
}
/**
 * Deep copy an RGD table
 */
function deepCopyRgdTable(table) {
    const copy = {
        entries: [],
        reference: table.reference
    };
    for (const entry of table.entries) {
        if (entry.type === types_1.RgdDataType.Table || entry.type === types_1.RgdDataType.TableInt) {
            copy.entries.push({
                hash: entry.hash,
                name: entry.name,
                type: entry.type,
                value: deepCopyRgdTable(entry.value)
            });
        }
        else {
            copy.entries.push({ ...entry });
        }
    }
    return copy;
}
/**
 * Navigate to a table by path, using cache
 */
function navigateToTable(root, keys, tables, dict) {
    let current = root;
    let path = 'GameData';
    for (const key of keys) {
        path += `["${key}"]`;
        const cached = tables.get(path);
        if (cached) {
            current = cached;
            continue;
        }
        const entry = current.entries.find(e => e.name === key);
        if (!entry || (entry.type !== types_1.RgdDataType.Table && entry.type !== types_1.RgdDataType.TableInt)) {
            return null;
        }
        current = entry.value;
        tables.set(path, current);
    }
    return current;
}
/**
 * Find or create a child table
 */
function findOrCreateTable(parent, key, tables, path, dict) {
    const cached = tables.get(path);
    if (cached)
        return cached;
    const existing = parent.entries.find(e => e.name === key);
    if (existing && (existing.type === types_1.RgdDataType.Table || existing.type === types_1.RgdDataType.TableInt)) {
        tables.set(path, existing.value);
        return existing.value;
    }
    // Create new table
    const newTable = { entries: [] };
    const hash = (0, dictionary_1.nameToHash)(dict, key);
    parent.entries.push({
        hash,
        name: key,
        type: types_1.RgdDataType.Table,
        value: newTable
    });
    tables.set(path, newTable);
    return newTable;
}
/**
 * Replace or add an entry in a table
 */
function replaceOrAddEntry(table, name, hash, type, value) {
    const idx = table.entries.findIndex(e => e.name === name);
    const entry = { hash, name, type, value };
    if (idx >= 0) {
        table.entries[idx] = entry;
    }
    else {
        table.entries.push(entry);
    }
}
/**
 * Parse a Lua value string
 */
function parseLuaValue(valueStr) {
    // Boolean
    if (valueStr === 'true') {
        return { type: types_1.RgdDataType.Bool, value: true };
    }
    if (valueStr === 'false') {
        return { type: types_1.RgdDataType.Bool, value: false };
    }
    // String with [[ ]]
    const bracketStringMatch = valueStr.match(/^\[\[(.*)?\]\]$/);
    if (bracketStringMatch) {
        const str = bracketStringMatch[1] ?? '';
        // Check if it's a UCS reference
        if (str.startsWith('$')) {
            return { type: types_1.RgdDataType.WString, value: str };
        }
        return { type: types_1.RgdDataType.String, value: str };
    }
    // Quoted string
    const quotedMatch = valueStr.match(/^"(.*)"$/);
    if (quotedMatch) {
        return { type: types_1.RgdDataType.String, value: quotedMatch[1] };
    }
    // Number
    const num = parseFloat(valueStr);
    if (!isNaN(num)) {
        // Check if it's a float (has decimal point or is scientific notation)
        if (valueStr.includes('.') || valueStr.includes('e') || valueStr.includes('E')) {
            return { type: types_1.RgdDataType.Float, value: num };
        }
        // Could be integer or float - default to float for RGD compatibility
        return { type: types_1.RgdDataType.Float, value: num };
    }
    // Default to string
    return { type: types_1.RgdDataType.String, value: valueStr };
}
/**
 * Parse Lua code into ParsedLuaTable structure with recursive reference resolution.
 * This is the canonical implementation for differential comparison.
 *
 * @param luaCode The Lua source code
 * @param luaFileLoader Function to load Lua files by reference path (returns code or null)
 * @param loadedFiles Set of already loaded files (normalized paths) to prevent infinite recursion
 */
function parseLuaToTable(luaCode, luaFileLoader, loadedFiles = new Set()) {
    const result = { entries: new Map() };
    const lines = luaCode.split(/\r?\n/);
    const tableStack = new Map();
    tableStack.set('GameData', result);
    for (const line of lines) {
        const trimmed = line.trim();
        if (!trimmed || trimmed.startsWith('--'))
            continue;
        // Parse GameData = Inherit([[path]])
        const inheritMatch = trimmed.match(/^GameData\s*=\s*Inherit\s*\(\s*\[\[(.*?)\]\]\s*\)/);
        if (inheritMatch) {
            result.reference = inheritMatch[1] || undefined;
            continue;
        }
        // Parse assignments: GameData["key"]["subkey"] = value
        const assignMatch = trimmed.match(/^(GameData(?:\["[^"]+"\])+)\s*=\s*(.+)$/);
        if (assignMatch) {
            const fullPath = assignMatch[1];
            const valueStr = assignMatch[2].trim();
            // Extract keys
            const keys = [];
            const keyRegex = /\["([^"]+)"\]/g;
            let keyMatch;
            while ((keyMatch = keyRegex.exec(fullPath)) !== null) {
                keys.push(keyMatch[1]);
            }
            if (keys.length === 0)
                continue;
            // Navigate to parent table, creating as needed
            let currentTable = result;
            let currentPath = 'GameData';
            for (let i = 0; i < keys.length - 1; i++) {
                currentPath += `["${keys[i]}"]`;
                let existingEntry = currentTable.entries.get(keys[i]);
                let existing = existingEntry?.table;
                if (!existing) {
                    existing = { entries: new Map() };
                    tableStack.set(currentPath, existing);
                    currentTable.entries.set(keys[i], { type: 'table', table: existing });
                }
                currentTable = existing;
            }
            const finalKey = keys[keys.length - 1];
            const finalPath = currentPath + `["${finalKey}"]`;
            // Parse value
            if (valueStr === 'nil') {
                // nil means delete - remove from entries if exists
                currentTable.entries.delete(finalKey);
            }
            else if (valueStr.startsWith('Reference') || valueStr.startsWith('Inherit')) {
                const refMatch = valueStr.match(/(?:Reference|Inherit)\s*\(\s*\[\[(.+?)\]\]\s*\)/);
                const refPath = refMatch ? refMatch[1] : undefined;
                // Load and merge the referenced file (like Corsix does)
                let newTable = { entries: new Map(), reference: refPath };
                if (refPath && luaFileLoader) {
                    // Create a fresh loadedFiles set for this reference chain
                    const childLoadedFiles = new Set(loadedFiles);
                    const normalizedRef = refPath.replace(/\\/g, '/').toLowerCase();
                    if (!childLoadedFiles.has(normalizedRef)) {
                        childLoadedFiles.add(normalizedRef);
                        const refCode = luaFileLoader(refPath);
                        if (refCode) {
                            const resolvedTable = parseLuaToTable(refCode, luaFileLoader, childLoadedFiles);
                            // Deep copy entries from resolved table
                            newTable.entries = deepCopyParsedEntries(resolvedTable.entries);
                            newTable.reference = refPath;
                        }
                    }
                }
                tableStack.set(finalPath, newTable);
                currentTable.entries.set(finalKey, { type: 'table', table: newTable, reference: refPath });
            }
            else if (valueStr === '{}') {
                const newTable = { entries: new Map() };
                tableStack.set(finalPath, newTable);
                currentTable.entries.set(finalKey, { type: 'table', table: newTable });
            }
            else {
                // Parse simple value
                const parsed = parseLuaValueForTable(valueStr);
                currentTable.entries.set(finalKey, {
                    type: 'value',
                    value: parsed.value,
                    dataType: parsed.dataType
                });
            }
        }
    }
    return result;
}
/**
 * Deep copy ParsedLuaTable entries to avoid shared references
 */
function deepCopyParsedEntries(entries) {
    const copy = new Map();
    for (const [key, entry] of entries) {
        if (entry.type === 'table' && entry.table) {
            copy.set(key, {
                type: 'table',
                table: {
                    reference: entry.table.reference,
                    entries: deepCopyParsedEntries(entry.table.entries)
                },
                reference: entry.reference
            });
        }
        else {
            copy.set(key, { ...entry });
        }
    }
    return copy;
}
/**
 * Parse a Lua value string for ParsedLuaTable
 */
function parseLuaValueForTable(valueStr) {
    if (valueStr === 'true')
        return { value: true, dataType: types_1.RgdDataType.Bool };
    if (valueStr === 'false')
        return { value: false, dataType: types_1.RgdDataType.Bool };
    const bracketMatch = valueStr.match(/^\[\[(.*?)\]\]/);
    if (bracketMatch) {
        const str = bracketMatch[1] ?? '';
        if (str.startsWith('$')) {
            return { value: str, dataType: types_1.RgdDataType.WString };
        }
        return { value: str, dataType: types_1.RgdDataType.String };
    }
    const num = parseFloat(valueStr);
    if (!isNaN(num)) {
        return { value: num, dataType: types_1.RgdDataType.Float };
    }
    return { value: valueStr, dataType: types_1.RgdDataType.String };
}
//# sourceMappingURL=data:application/json;base64,eyJ2ZXJzaW9uIjozLCJmaWxlIjoibHVhRm9ybWF0LmpzIiwic291cmNlUm9vdCI6IiIsInNvdXJjZXMiOlsiLi4vc3JjL2x1YUZvcm1hdC50cyJdLCJuYW1lcyI6W10sIm1hcHBpbmdzIjoiO0FBQUE7Ozs7Ozs7Ozs7Ozs7Ozs7R0FnQkc7O0FBK0RILG9EQStCQztBQUtELDRCQWtCQztBQW1ORCw0QkFrSUM7QUFXRCw0Q0FzSUM7QUFpS0QsMENBb0dDO0FBOTFCRCxtQ0FBbUY7QUFDbkYsNkNBQXNEO0FBQ3RELGlDQUF5RDtBQUV6RCxNQUFNLFFBQVEsR0FBRyxVQUFVLENBQUM7QUFFNUI7OztHQUdHO0FBQ0gsU0FBUyxjQUFjLENBQUMsQ0FBUyxFQUFFLENBQVM7SUFDeEMsTUFBTSxNQUFNLEdBQUcsQ0FBQyxDQUFDLEtBQUssQ0FBQyxPQUFPLENBQUMsQ0FBQztJQUNoQyxNQUFNLE1BQU0sR0FBRyxDQUFDLENBQUMsS0FBSyxDQUFDLE9BQU8sQ0FBQyxDQUFDO0lBRWhDLEtBQUssSUFBSSxDQUFDLEdBQUcsQ0FBQyxFQUFFLENBQUMsR0FBRyxJQUFJLENBQUMsR0FBRyxDQUFDLE1BQU0sQ0FBQyxNQUFNLEVBQUUsTUFBTSxDQUFDLE1BQU0sQ0FBQyxFQUFFLENBQUMsRUFBRSxFQUFFLENBQUM7UUFDOUQsTUFBTSxLQUFLLEdBQUcsTUFBTSxDQUFDLENBQUMsQ0FBQyxJQUFJLEVBQUUsQ0FBQztRQUM5QixNQUFNLEtBQUssR0FBRyxNQUFNLENBQUMsQ0FBQyxDQUFDLElBQUksRUFBRSxDQUFDO1FBRTlCLGtDQUFrQztRQUNsQyxNQUFNLElBQUksR0FBRyxRQUFRLENBQUMsS0FBSyxFQUFFLEVBQUUsQ0FBQyxDQUFDO1FBQ2pDLE1BQU0sSUFBSSxHQUFHLFFBQVEsQ0FBQyxLQUFLLEVBQUUsRUFBRSxDQUFDLENBQUM7UUFFakMsSUFBSSxDQUFDLEtBQUssQ0FBQyxJQUFJLENBQUMsSUFBSSxDQUFDLEtBQUssQ0FBQyxJQUFJLENBQUMsRUFBRSxDQUFDO1lBQy9CLElBQUksSUFBSSxLQUFLLElBQUk7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QztRQUNELE9BQU8sRUFBRSxLQUFLLEVBQUUsR0FBRyxFQUFFLFFBQVEsRUFBRSxtQkFBVyxDQUFDLE1BQU0sRUFBRSxDQUFDO0lBQ3hELENBQUM7SUFFRCxNQUFNLEdBQUcsR0FBRyxVQUFVLENBQUMsUUFBUSxDQUFDLENBQUM7SUFDakMsSUFBSSxDQUFDLEtBQUssQ0FBQyxHQUFHLENBQUMsRUFBRSxDQUFDO1FBQ2QsT0FBTyxFQUFFLEtBQUssRUFBRSxHQUFHLEVBQUUsUUFBUSxFQUFFLG1CQUFXLENBQUMsS0FBSyxFQUFFLENBQUM7SUFDdkQsQ0FBQztJQUVELE9BQU8sRUFBRSxLQUFLLEVBQUUsUUFBUSxFQUFFLFFBQVEsRUFBRSxtQkFBVyxDQUFDLE1BQU0sRUFBRSxDQUFDO0FBQzdELENBQUMiLCJzb3VyY2VzQ29udGVudCI6WyIvKipcclxuICogUkdEIEx1YSBGb3JtYXQgLSBDb252ZXJ0IGJldHdlZW4gUkdEIGFuZCBMdWEgR2FtZURhdGEgZm9ybWF0XHJcbiAqIFxyXG4gKiBUaGlzIG1hdGNoZXMgdGhlIGZvcm1hdCB1c2VkIGJ5IENvcnNpeCBNb2QgU3R1ZGlvIGZvciBMdWEgZHVtcHMuXHJcbiAqIFxyXG4gKiBDb3JzaXggTHVhIEZvcm1hdCAoRGlmZmVyZW50aWFsKTpcclxuICogICBHYW1lRGF0YSA9IEluaGVyaXQoW1tdXSkgICAgICAgICAgICAgICAgICAgICAgICAgICAtLSBSb290IGluaGVyaXRhbmNlIChlbXB0eSBvciBwYXJlbnQgcGF0aClcclxuICogICBHYW1lRGF0YVtcInRhYmxlXCJdID0gUmVmZXJlbmNlKFtbcGF0aFxcdG9cXHJlZi5sdWFdXSkgLS0gQ2hpbGQgdGFibGUgd2l0aCByZWZlcmVuY2UgKG9ubHkgaWYgZGlmZmVyZW50IGZyb20gcGFyZW50KVxyXG4gKiAgIEdhbWVEYXRhW1wia2V5XCJdID0gNSAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgLS0gT25seSBvdXRwdXRzIHZhbHVlcyB0aGF0IGRpZmZlciBmcm9tIHBhcmVudFxyXG4gKiAgIEdhbWVEYXRhW1wia2V5XCJdID0gbmlsICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgLS0gRGVsZXRlL2NsZWFyIGluaGVyaXRlZCB2YWx1ZVxyXG4gKiBcclxuICogS2V5IGZlYXR1cmVzOlxyXG4gKiAgIC0gVXNlcyBSZWZlcmVuY2UoKSBmb3IgY2hpbGQgdGFibGVzLCBJbmhlcml0KCkgb25seSBmb3Igcm9vdCBHYW1lRGF0YVxyXG4gKiAgIC0gU2luZ2xlIGJhY2tzbGFzaGVzIGluIFtbIF1dIHN0cmluZ3MgKG5vIGVzY2FwaW5nIG5lZWRlZClcclxuICogICAtIE9ubHkgb3V0cHV0cyB2YWx1ZXMgdGhhdCBkaWZmZXIgZnJvbSB0aGUgaW5oZXJpdGVkIHBhcmVudFxyXG4gKiAgIC0gVXNlcyBuaWwgdG8gZGVsZXRlIGluaGVyaXRlZCB2YWx1ZXNcclxuICovXHJcblxyXG5pbXBvcnQgeyBSZ2REYXRhVHlwZSwgUmdkRW50cnksIFJnZFRhYmxlLCBSZ2RGaWxlLCBIYXNoRGljdGlvbmFyeSB9IGZyb20gJy4vdHlwZXMnO1xyXG5pbXBvcnQgeyBuYW1lVG9IYXNoLCBoYXNoVG9OYW1lIH0gZnJvbSAnLi9kaWN0aW9uYXJ5JztcclxuaW1wb3J0IHsgaGFzaFRvSGV4LCBpc0hleEhhc2gsIGhleFRvSGFzaCB9IGZyb20gJy4vaGFzaCc7XHJcblxyXG5jb25zdCBSRUZfSEFTSCA9IDB4NDlENjBGQUU7XHJcblxyXG4vKipcclxuICogTmF0dXJhbC9udW1lcmljYWwgc3RyaW5nIGNvbXBhcmlzb24gZm9yIHByb3BlciBvcmRlcmluZyBvZiBudW1iZXJlZCBlbnRyaWVzXHJcbiAqIGUuZy4sIHRleHRfMDEsIHRleHRfMDIsIC4uLiB0ZXh0XzEwIGluc3RlYWQgb2YgdGV4dF8wMSwgdGV4dF8xMCwgdGV4dF8wMlxyXG4gKi9cclxuZnVuY3Rpb24gbmF0dXJhbENvbXBhcmUoYTogc3RyaW5nLCBiOiBzdHJpbmcpOiBudW1iZXIge1xyXG4gICAgY29uc3QgYVBhcnRzID0gYS5zcGxpdCgvKFxcZCspLyk7XHJcbiAgICBjb25zdCBiUGFydHMgPSBiLnNwbGl0KC8oXFxkKykvKTtcclxuXHJcbiAgICBmb3IgKGxldCBpID0gMDsgaSA8IE1hdGgubWF4KGFQYXJ0cy5sZW5ndGgsIGJQYXJ0cy5sZW5ndGgpOyBpKyspIHtcclxuICAgICAgICBjb25zdCBhUGFydCA9IGFQYXJ0c1tpXSB8fCAnJztcclxuICAgICAgICBjb25zdCBiUGFydCA9IGJQYXJ0c1tpXSB8fCAnJztcclxuXHJcbiAgICAgICAgLy8gQ2hlY2sgaWYgYm90aCBwYXJ0cyBhcmUgbnVtZXJpY1xyXG4gICAgICAgIGNvbnN0IGFOdW0gPSBwYXJzZUludChhUGFydCwgMTApO1xyXG4gICAgICAgIGNvbnN0IGJOdW0gPSBwYXJzZUludChiUGFydCwgMTApO1xyXG5cclxuICAgICAgICBpZiAoIWlzTmFOKGFOdW0pICYmICFpc05hTihiTnVtKSkge1xyXG4gICAgICAgICAgICBpZiAoYU51bSAhPT0gYk51bSkgcmV0dXJuIGFOdW0gLSBiTnVtO1xyXG4gICAgICAgIH0gZWxzZSB7XHJcbiAgICAgICAgICAgIGNvbnN0IGNtcCA9IGFQYXJ0LmxvY2FsZUNvbXBhcmUoYlBhcnQpO1xyXG4gICAgICAgICAgICBpZiAoY21wICE9PSAwKSByZXR1cm4gY21wO1xyXG4gICAgICAgIH1cclxuICAgIH1cclxuICAgIHJldHVybiAwO1xyXG59XHJcblxyXG4vKipcclxuICogVHlwZSBmb3IgYSBmdW5jdGlvbiB0aGF0IGxvYWRzIGFuZCBwYXJzZXMgYSBwYXJlbnQgTHVhL1JHRCBmaWxlXHJcbiAqIFJldHVybnMgdGhlIHBhcnNlZCB0YWJsZSBzdHJ1Y3R1cmUsIG9yIG51bGwgaWYgZmlsZSBub3QgZm91bmRcclxuICovXHJcbmV4cG9ydCB0eXBlIFBhcmVudExvYWRlciA9IChyZWZQYXRoOiBzdHJpbmcpID0+IFByb21pc2U8UGFyc2VkTHVhVGFibGUgfCBudWxsPjtcclxuXHJcbi8qKlxyXG4gKiBQYXJzZWQgTHVhIHRhYmxlIHN0cnVjdHVyZSBmb3IgY29tcGFyaXNvblxyXG4gKi9cclxuZXhwb3J0IGludGVyZmFjZSBQYXJzZWRMdWFUYWJsZSB7XHJcbiAgICByZWZlcmVuY2U/OiBzdHJpbmc7XHJcbiAgICBlbnRyaWVzOiBNYXA8c3RyaW5nLCBQYXJzZWRMdWFFbnRyeT47XHJcbn1cclxuXHJcbmV4cG9ydCBpbnRlcmZhY2UgUGFyc2VkTHVhRW50cnkge1xyXG4gICAgdHlwZTogJ3ZhbHVlJyB8ICd0YWJsZSc7XHJcbiAgICB2YWx1ZT86IGFueTtcclxuICAgIGRhdGFUeXBlPzogUmdkRGF0YVR5cGU7XHJcbiAgICB0YWJsZT86IFBhcnNlZEx1YVRhYmxlO1xyXG4gICAgcmVmZXJlbmNlPzogc3RyaW5nO1xyXG59XHJcblxyXG4vKipcclxuICogQ29udmVydCBSR0QgZmlsZSB0byBMdWEgZm9ybWF0IChDb3JzaXggZGlmZmVyZW50aWFsIHN0eWxlKVxyXG4gKiBcclxuICogQHBhcmFtIHJnZEZpbGUgVGhlIFJHRCBmaWxlIHRvIGNvbnZlcnRcclxuICogQHBhcmFtIHBhcmVudExvYWRlciBPcHRpb25hbCBmdW5jdGlvbiB0byBsb2FkIHBhcmVudCBmaWxlcyBmb3IgZGlmZmVyZW50aWFsIGNvbXBhcmlzb25cclxuICogQHBhcmFtIHNvdXJjZU5hbWUgT3B0aW9uYWwgc291cmNlIGZpbGVuYW1lIGZvciBjb21tZW50c1xyXG4gKi9cclxuZXhwb3J0IGFzeW5jIGZ1bmN0aW9uIHJnZFRvTHVhRGlmZmVyZW50aWFsKFxyXG4gICAgcmdkRmlsZTogUmdkRmlsZSxcclxuICAgIHBhcmVudExvYWRlcj86IFBhcmVudExvYWRlclxyXG4pOiBQcm9taXNlPHN0cmluZz4ge1xyXG4gICAgY29uc3QgbGluZXM6IHN0cmluZ1tdID0gW107XHJcblxyXG4gICAgLy8gR2FtZURhdGEgZGVjbGFyYXRpb24gd2l0aCBpbmhlcml0YW5jZVxyXG4gICAgY29uc3QgcmVmID0gcmdkRmlsZS5nYW1lRGF0YS5yZWZlcmVuY2U7XHJcbiAgICBpZiAocmVmKSB7XHJcbiAgICAgICAgbGluZXMucHVzaChgR2FtZURhdGEgPSBJbmhlcml0KFtbJHtyZWZ9XV0pYCk7XHJcbiAgICB9IGVsc2Uge1xyXG4gICAgICAgIGxpbmVzLnB1c2goJ0dhbWVEYXRhID0gSW5oZXJpdChbW11dKScpO1xyXG4gICAgfVxyXG5cclxuICAgIC8vIExvYWQgcGFyZW50IHRhYmxlIGlmIGF2YWlsYWJsZVxyXG4gICAgbGV0IHBhcmVudFRhYmxlOiBQYXJzZWRMdWFUYWJsZSB8IG51bGwgPSBudWxsO1xyXG4gICAgaWYgKHBhcmVudExvYWRlciAmJiByZWYpIHtcclxuICAgICAgICB0cnkge1xyXG4gICAgICAgICAgICBwYXJlbnRUYWJsZSA9IGF3YWl0IHBhcmVudExvYWRlcihyZWYpO1xyXG4gICAgICAgIH0gY2F0Y2ggKGUpIHtcclxuICAgICAgICAgICAgLy8gUGFyZW50IG5vdCBmb3VuZCwgY29udGludWUgd2l0aG91dCBkaWZmZXJlbnRpYWxcclxuICAgICAgICB9XHJcbiAgICB9XHJcblxyXG4gICAgLy8gV3JpdGUgZW50cmllcyB3aXRoIGRpZmZlcmVudGlhbCBjb21wYXJpc29uXHJcbiAgICBhd2FpdCB3cml0ZVRhYmxlRW50cmllc0RpZmZlcmVudGlhbChsaW5lcywgcmdkRmlsZS5nYW1lRGF0YSwgJ0dhbWVEYXRhJywgcGFyZW50VGFibGUsIHBhcmVudExvYWRlcik7XHJcblxyXG4gICAgLy8gRW5zdXJlIHRyYWlsaW5nIG5ld2xpbmVcclxuICAgIGxpbmVzLnB1c2goJycpO1xyXG5cclxuICAgIHJldHVybiBsaW5lcy5qb2luKCdcXG4nKTtcclxufVxyXG5cclxuLyoqXHJcbiAqIENvbnZlcnQgUkdEIGZpbGUgdG8gTHVhIGZvcm1hdCAoc2ltcGxlIGNvbXBsZXRlIGR1bXAgLSBubyBkaWZmZXJlbnRpYWwpXHJcbiAqL1xyXG5leHBvcnQgZnVuY3Rpb24gcmdkVG9MdWEocmdkRmlsZTogUmdkRmlsZSwgc291cmNlTmFtZT86IHN0cmluZyk6IHN0cmluZyB7XHJcbiAgICBjb25zdCBsaW5lczogc3RyaW5nW10gPSBbXTtcclxuXHJcbiAgICAvLyBHYW1lRGF0YSBkZWNsYXJhdGlvbiB3aXRoIGluaGVyaXRhbmNlXHJcbiAgICBjb25zdCByZWYgPSByZ2RGaWxlLmdhbWVEYXRhLnJlZmVyZW5jZTtcclxuICAgIGlmIChyZWYpIHtcclxuICAgICAgICBsaW5lcy5wdXNoKGBHYW1lRGF0YSA9IEluaGVyaXQoW1ske3JlZn1dXSlgKTtcclxuICAgIH0gZWxzZSB7XHJcbiAgICAgICAgbGluZXMucHVzaCgnR2FtZURhdGEgPSBJbmhlcml0KFtbXV0pJyk7XHJcbiAgICB9XHJcblxyXG4gICAgLy8gV3JpdGUgYWxsIGVudHJpZXMgKGNvbXBsZXRlIGR1bXApXHJcbiAgICB3cml0ZVRhYmxlRW50cmllcyhsaW5lcywgcmdkRmlsZS5nYW1lRGF0YSwgJ0dhbWVEYXRhJyk7XHJcblxyXG4gICAgLy8gRW5zdXJlIHRyYWlsaW5nIG5ld2xpbmVcclxuICAgIGxpbmVzLnB1c2goJycpO1xyXG5cclxuICAgIHJldHVybiBsaW5lcy5qb2luKCdcXG4nKTtcclxufVxyXG5cclxuLyoqXHJcbiAqIFdyaXRlIHRhYmxlIGVudHJpZXMgd2l0aCBkaWZmZXJlbnRpYWwgY29tcGFyaXNvbiAoQ29yc2l4IHN0eWxlKVxyXG4gKiBcclxuICogQWxnb3JpdGhtIGZyb20gQ29yc2l4IENMdWFGcm9tUmdkLmNwcDpcclxuICogMS4gTWVyZ2UgZW50cmllcyBmcm9tIFJHRCB0YWJsZSBhbmQgaW5oZXJpdGVkIHRhYmxlIChSR0QgZW50cmllcyBmaXJzdCwgdGhlbiBwYXJlbnQtb25seSlcclxuICogMi4gRm9yIGVhY2ggbWVyZ2VkIGVudHJ5OlxyXG4gKiAgICAtIElmIFJHRCBoYXMgaXQgYnV0IHBhcmVudCBkb2Vzbid0IOKGkiBvdXRwdXQgdmFsdWVcclxuICogICAgLSBJZiBwYXJlbnQgaGFzIGl0IGJ1dCBSR0QgZG9lc24ndCDihpIgb3V0cHV0IG5pbFxyXG4gKiAgICAtIElmIGJvdGggaGF2ZSBpdCBidXQgdmFsdWVzIGRpZmZlciDihpIgb3V0cHV0IHZhbHVlXHJcbiAqICAgIC0gSWYgYm90aCBoYXZlIGl0IGFuZCB2YWx1ZXMgbWF0Y2gg4oaSIGRvbid0IG91dHB1dFxyXG4gKiAzLiBGb3IgdGFibGVzOiBpZiBSZWZlcmVuY2UoKSBkaWZmZXJzLCBsb2FkIHRoZSBORVcgcmVmZXJlbmNlIGZpbGUgZm9yIGNvbXBhcmlzb25cclxuICovXHJcbmFzeW5jIGZ1bmN0aW9uIHdyaXRlVGFibGVFbnRyaWVzRGlmZmVyZW50aWFsKFxyXG4gICAgbGluZXM6IHN0cmluZ1tdLFxyXG4gICAgdGFibGU6IFJnZFRhYmxlLFxyXG4gICAgcGF0aDogc3RyaW5nLFxyXG4gICAgcGFyZW50VGFibGU6IFBhcnNlZEx1YVRhYmxlIHwgbnVsbCxcclxuICAgIHBhcmVudExvYWRlcj86IFBhcmVudExvYWRlclxyXG4pOiBQcm9taXNlPHZvaWQ+IHtcclxuICAgIC8vIEJ1aWxkIGVudHJ5IGxpc3QgZnJvbSBSR0QgZW50cmllcyBvbmx5IChDb3JzaXggZG9lcyBub3QgZW1pdCBuaWwgZW50cmllcyBmb3IgcGFyZW50LW9ubHkga2V5cylcclxuICAgIGludGVyZmFjZSBNZXJnZWRFbnRyeSB7XHJcbiAgICAgICAgbmFtZTogc3RyaW5nO1xyXG4gICAgICAgIHJnZEVudHJ5OiBSZ2RFbnRyeTtcclxuICAgICAgICBwYXJlbnRFbnRyeTogUGFyc2VkTHVhRW50cnkgfCBudWxsO1xyXG4gICAgfVxyXG5cclxuICAgIGNvbnN0IG1lcmdlZEVudHJpZXM6IE1lcmdlZEVudHJ5W10gPSBbXTtcclxuICAgIGNvbnN0IHVuaXF1ZUVudHJpZXMgPSBuZXcgTWFwPHN0cmluZywgUmdkRW50cnk+KCk7XHJcblxyXG4gICAgZm9yIChjb25zdCBlbnRyeSBvZiB0YWJsZS5lbnRyaWVzKSB7XHJcbiAgICAgICAgaWYgKGVudHJ5Lmhhc2ggPT09IFJFRl9IQVNIKSBjb250aW51ZTtcclxuICAgICAgICBjb25zdCBuYW1lID0gZW50cnkubmFtZSA/PyBoYXNoVG9IZXgoZW50cnkuaGFzaCk7XHJcbiAgICAgICAgdW5pcXVlRW50cmllcy5zZXQobmFtZSwgZW50cnkpO1xyXG4gICAgfVxyXG5cclxuICAgIGZvciAoY29uc3QgW25hbWUsIHJnZEVudHJ5XSBvZiB1bmlxdWVFbnRyaWVzKSB7XHJcbiAgICAgICAgbWVyZ2VkRW50cmllcy5wdXNoKHtcclxuICAgICAgICAgICAgbmFtZSxcclxuICAgICAgICAgICAgcmdkRW50cnksXHJcbiAgICAgICAgICAgIHBhcmVudEVudHJ5OiBwYXJlbnRUYWJsZT8uZW50cmllcy5nZXQobmFtZSkgPz8gbnVsbFxyXG4gICAgICAgIH0pO1xyXG4gICAgfVxyXG5cclxuICAgIC8vIFNvcnQgZW50cmllcyB1c2luZyBuYXR1cmFsL251bWVyaWNhbCBzb3J0ICh0ZXh0XzAxLCB0ZXh0XzAyLCAuLi4gdGV4dF8xMClcclxuICAgIG1lcmdlZEVudHJpZXMuc29ydCgoYSwgYikgPT4gbmF0dXJhbENvbXBhcmUoYS5uYW1lLCBiLm5hbWUpKTtcclxuXHJcbiAgICAvLyBQcm9jZXNzIGVhY2ggbWVyZ2VkIGVudHJ5XHJcbiAgICBmb3IgKGNvbnN0IHsgbmFtZSwgcmdkRW50cnksIHBhcmVudEVudHJ5IH0gb2YgbWVyZ2VkRW50cmllcykge1xyXG4gICAgICAgIGNvbnN0IGtleVBhdGggPSBgJHtwYXRofVtcIiR7ZXNjYXBlTHVhU3RyaW5nKG5hbWUpfVwiXWA7XHJcblxyXG4gICAgICAgIGlmIChyZ2RFbnRyeS50eXBlID09PSBSZ2REYXRhVHlwZS5UYWJsZSB8fCByZ2RFbnRyeS50eXBlID09PSBSZ2REYXRhVHlwZS5UYWJsZUludCkge1xyXG4gICAgICAgICAgICBjb25zdCBjaGlsZFRhYmxlID0gcmdkRW50cnkudmFsdWUgYXMgUmdkVGFibGU7XHJcbiAgICAgICAgICAgIGNvbnN0IGNoaWxkUmVmID0gY2hpbGRUYWJsZS5yZWZlcmVuY2U7XHJcbiAgICAgICAgICAgIGNvbnN0IHBhcmVudFJlZiA9IHBhcmVudEVudHJ5Py5yZWZlcmVuY2U7XHJcblxyXG4gICAgICAgICAgICAvLyBDaGVjayBpZiByZWZlcmVuY2UgZGlmZmVycyBmcm9tIHBhcmVudFxyXG4gICAgICAgICAgICBjb25zdCByZWZEaWZmZXJzID0gY2hpbGRSZWYgIT09IHBhcmVudFJlZjtcclxuXHJcbiAgICAgICAgICAgIC8vIERldGVybWluZSB3aGF0IHRvIGNvbXBhcmUgYWdhaW5zdCBmb3IgY2hpbGRyZW5cclxuICAgICAgICAgICAgbGV0IGNvbXBhcmlzb25UYWJsZTogUGFyc2VkTHVhVGFibGUgfCBudWxsID0gbnVsbDtcclxuXHJcbiAgICAgICAgICAgIGlmIChyZWZEaWZmZXJzKSB7XHJcbiAgICAgICAgICAgICAgICAvLyBSZWZlcmVuY2UgZGlmZmVycyBmcm9tIHBhcmVudCAtIG91dHB1dCBSZWZlcmVuY2UoKSBhbmQgbG9hZCBORVcgcmVmZXJlbmNlIGZvciBjb21wYXJpc29uXHJcbiAgICAgICAgICAgICAgICBpZiAoY2hpbGRSZWYpIHtcclxuICAgICAgICAgICAgICAgICAgICBsaW5lcy5wdXNoKGAke2tleVBhdGh9ID0gUmVmZXJlbmNlKFtbJHtjaGlsZFJlZn1dXSlgKTtcclxuICAgICAgICAgICAgICAgICAgICAvLyBMb2FkIHRoZSBORVcgcmVmZXJlbmNlIGZpbGUgdG8gY29tcGFyZSBjaGlsZHJlbiBhZ2FpbnN0XHJcbiAgICAgICAgICAgICAgICAgICAgaWYgKHBhcmVudExvYWRlcikge1xyXG4gICAgICAgICAgICAgICAgICAgICAgICB0cnkge1xyXG4gICAgICAgICAgICAgICAgICAgICAgICAgICAgY29tcGFyaXNvblRhYmxlID0gYXdhaXQgcGFyZW50TG9hZGVyKGNoaWxkUmVmKTtcclxuICAgICAgICAgICAgICAgICAgICAgICAgfSBjYXRjaCAoZSkge1xyXG4gICAgICAgICAgICAgICAgICAgICAgICAgICAgLy8gUmVmZXJlbmNlIGZpbGUgbm90IGZvdW5kXHJcbiAgICAgICAgICAgICAgICAgICAgICAgIH1cclxuICAgICAgICAgICAgICAgICAgICB9XHJcbiAgICAgICAgICAgICAgICB9XHJcbiAgICAgICAgICAgICAgICAvLyBJZiBSR0QgaGFzIG5vIHJlZmVyZW5jZSBidXQgcGFyZW50IGRvZXMsIERPTidUIG91dHB1dCB7fSBcclxuICAgICAgICAgICAgICAgIC8vIEp1c3QgcHJvY2VzcyBjaGlsZHJlbiB3aXRoIG51bGwgY29tcGFyaXNvbiB0YWJsZSAob3V0cHV0IGFsbCB2YWx1ZXMpXHJcbiAgICAgICAgICAgICAgICAvLyBjb21wYXJpc29uVGFibGUgc3RheXMgbnVsbFxyXG4gICAgICAgICAgICB9IGVsc2Uge1xyXG4gICAgICAgICAgICAgICAgLy8gUmVmZXJlbmNlIHNhbWUgYXMgcGFyZW50IC0gdXNlIHBhcmVudCdzIHRhYmxlIGZvciBjb21wYXJpc29uXHJcbiAgICAgICAgICAgICAgICBjb21wYXJpc29uVGFibGUgPSBwYXJlbnRFbnRyeT8udGFibGUgPz8gbnVsbDtcclxuICAgICAgICAgICAgfVxyXG5cclxuICAgICAgICAgICAgLy8gUmVjdXJzaXZlbHkgcHJvY2VzcyBjaGlsZHJlblxyXG4gICAgICAgICAgICBhd2FpdCB3cml0ZVRhYmxlRW50cmllc0RpZmZlcmVudGlhbChsaW5lcywgY2hpbGRUYWJsZSwga2V5UGF0aCwgY29tcGFyaXNvblRhYmxlLCBwYXJlbnRMb2FkZXIpO1xyXG4gICAgICAgIH0gZWxzZSB7XHJcbiAgICAgICAgICAgIC8vIFNpbXBsZSB2YWx1ZSAtIGNoZWNrIGlmIGl0IGRpZmZlcnMgZnJvbSBwYXJlbnRcclxuICAgICAgICAgICAgY29uc3Qgc2hvdWxkT3V0cHV0ID0gIXBhcmVudEVudHJ5IHx8XHJcbiAgICAgICAgICAgICAgICBwYXJlbnRFbnRyeS50eXBlICE9PSAndmFsdWUnIHx8XHJcbiAgICAgICAgICAgICAgICAhdmFsdWVzRXF1YWwocmdkRW50cnkudHlwZSwgcmdkRW50cnkudmFsdWUsIHBhcmVudEVudHJ5LmRhdGFUeXBlLCBwYXJlbnRFbnRyeS52YWx1ZSkgfHxcclxuICAgICAgICAgICAgICAgIG5hbWUgPT09ICdzY3JlZW5fbmFtZV9pZCc7XHJcblxyXG4gICAgICAgICAgICBpZiAoc2hvdWxkT3V0cHV0KSB7XHJcbiAgICAgICAgICAgICAgICBjb25zdCB2YWx1ZVN0ciA9IGZvcm1hdEx1YVZhbHVlKHJnZEVudHJ5LnR5cGUsIHJnZEVudHJ5LnZhbHVlKTtcclxuICAgICAgICAgICAgICAgIGxpbmVzLnB1c2goYCR7a2V5UGF0aH0gPSAke3ZhbHVlU3RyfWApO1xyXG4gICAgICAgICAgICB9XHJcbiAgICAgICAgfVxyXG4gICAgfVxyXG59XHJcblxyXG4vKipcclxuICogQ2hlY2sgaWYgdHdvIHZhbHVlcyBhcmUgZXF1YWxcclxuICovXHJcbmZ1bmN0aW9uIHZhbHVlc0VxdWFsKHR5cGUxOiBSZ2REYXRhVHlwZSB8IHVuZGVmaW5lZCwgdmFsMTogYW55LCB0eXBlMjogUmdkRGF0YVR5cGUgfCB1bmRlZmluZWQsIHZhbDI6IGFueSk6IGJvb2xlYW4ge1xyXG4gICAgaWYgKHR5cGUxICE9PSB0eXBlMikgcmV0dXJuIGZhbHNlO1xyXG4gICAgaWYgKHR5cGUxID09PSBSZ2REYXRhVHlwZS5GbG9hdCkge1xyXG4gICAgICAgIHJldHVybiBNYXRoLmFicygodmFsMSBhcyBudW1iZXIpIC0gKHZhbDIgYXMgbnVtYmVyKSkgPCAwLjAwMDAxO1xyXG4gICAgfVxyXG4gICAgcmV0dXJuIHZhbDEgPT09IHZhbDI7XHJcbn1cclxuXHJcbi8qKlxyXG4gKiBXcml0ZSB0YWJsZSBlbnRyaWVzIGluIEx1YSBmb3JtYXQgKGNvbXBsZXRlIGR1bXAgLSBubyBkaWZmZXJlbnRpYWwpXHJcbiAqL1xyXG5mdW5jdGlvbiB3cml0ZVRhYmxlRW50cmllcyhsaW5lczogc3RyaW5nW10sIHRhYmxlOiBSZ2RUYWJsZSwgcGF0aDogc3RyaW5nKTogdm9pZCB7XHJcbiAgICAvLyBTb3J0IGVudHJpZXM6IHNpbXBsZSB2YWx1ZXMgZmlyc3QsIHRoZW4gdGFibGVzXHJcbiAgICBjb25zdCBzb3J0ZWQgPSBbLi4udGFibGUuZW50cmllc10uc29ydCgoYSwgYikgPT4ge1xyXG4gICAgICAgIC8vIFNraXAgJFJFRlxyXG4gICAgICAgIGlmIChhLmhhc2ggPT09IFJFRl9IQVNIKSByZXR1cm4gLTE7XHJcbiAgICAgICAgaWYgKGIuaGFzaCA9PT0gUkVGX0hBU0gpIHJldHVybiAxO1xyXG5cclxuICAgICAgICBjb25zdCBhSXNUYWJsZSA9IGEudHlwZSA9PT0gUmdkRGF0YVR5cGUuVGFibGUgfHwgYS50eXBlID09PSBSZ2REYXRhVHlwZS5UYWJsZUludDtcclxuICAgICAgICBjb25zdCBiSXNUYWJsZSA9IGIudHlwZSA9PT0gUmdkRGF0YVR5cGUuVGFibGUgfHwgYi50eXBlID09PSBSZ2REYXRhVHlwZS5UYWJsZUludDtcclxuICAgICAgICBpZiAoYUlzVGFibGUgIT09IGJJc1RhYmxlKSByZXR1cm4gYUlzVGFibGUgPyAxIDogLTE7XHJcblxyXG4gICAgICAgIGNvbnN0IGFOYW1lID0gYS5uYW1lID8/IGhhc2hUb0hleChhLmhhc2gpO1xyXG4gICAgICAgIGNvbnN0IGJOYW1lID0gYi5uYW1lID8/IGhhc2hUb0hleChiLmhhc2gpO1xyXG4gICAgICAgIHJldHVybiBhTmFtZS5sb2NhbGVDb21wYXJlKGJOYW1lKTtcclxuICAgIH0pO1xyXG5cclxuICAgIGZvciAoY29uc3QgZW50cnkgb2Ygc29ydGVkKSB7XHJcbiAgICAgICAgLy8gU2tpcCAkUkVGIGVudHJpZXMgKGhhbmRsZWQgaW4gaW5oZXJpdGFuY2UpXHJcbiAgICAgICAgaWYgKGVudHJ5Lmhhc2ggPT09IFJFRl9IQVNIKSBjb250aW51ZTtcclxuXHJcbiAgICAgICAgY29uc3QgbmFtZSA9IGVudHJ5Lm5hbWUgPz8gaGFzaFRvSGV4KGVudHJ5Lmhhc2gpO1xyXG4gICAgICAgIGNvbnN0IGtleVBhdGggPSBgJHtwYXRofVtcIiR7ZXNjYXBlTHVhU3RyaW5nKG5hbWUpfVwiXWA7XHJcblxyXG4gICAgICAgIGlmIChlbnRyeS50eXBlID09PSBSZ2REYXRhVHlwZS5UYWJsZSB8fCBlbnRyeS50eXBlID09PSBSZ2REYXRhVHlwZS5UYWJsZUludCkge1xyXG4gICAgICAgICAgICBjb25zdCBjaGlsZFRhYmxlID0gZW50cnkudmFsdWUgYXMgUmdkVGFibGU7XHJcblxyXG4gICAgICAgICAgICAvLyBDb3JzaXggdXNlcyBSZWZlcmVuY2UoKSBmb3IgY2hpbGQgdGFibGVzLCBub3QgSW5oZXJpdCgpXHJcbiAgICAgICAgICAgIC8vIFNpbmdsZSBiYWNrc2xhc2hlcyBpbiBbWyBdXSBzdHJpbmdzIC0gbm8gZXNjYXBpbmcgbmVlZGVkXHJcbiAgICAgICAgICAgIGlmIChjaGlsZFRhYmxlLnJlZmVyZW5jZSkge1xyXG4gICAgICAgICAgICAgICAgbGluZXMucHVzaChgJHtrZXlQYXRofSA9IFJlZmVyZW5jZShbWyR7Y2hpbGRUYWJsZS5yZWZlcmVuY2V9XV0pYCk7XHJcbiAgICAgICAgICAgIH0gZWxzZSB7XHJcbiAgICAgICAgICAgICAgICBsaW5lcy5wdXNoKGAke2tleVBhdGh9ID0ge31gKTtcclxuICAgICAgICAgICAgfVxyXG5cclxuICAgICAgICAgICAgLy8gV3JpdGUgY2hpbGQgZW50cmllc1xyXG4gICAgICAgICAgICB3cml0ZVRhYmxlRW50cmllcyhsaW5lcywgY2hpbGRUYWJsZSwga2V5UGF0aCk7XHJcbiAgICAgICAgfSBlbHNlIHtcclxuICAgICAgICAgICAgLy8gU2ltcGxlIHZhbHVlXHJcbiAgICAgICAgICAgIGNvbnN0IHZhbHVlU3RyID0gZm9ybWF0THVhVmFsdWUoZW50cnkudHlwZSwgZW50cnkudmFsdWUpO1xyXG4gICAgICAgICAgICBsaW5lcy5wdXNoKGAke2tleVBhdGh9ID0gJHt2YWx1ZVN0cn1gKTtcclxuICAgICAgICB9XHJcbiAgICB9XHJcbn1cclxuXHJcbi8qKlxyXG4gKiBGb3JtYXQgYSB2YWx1ZSBmb3IgTHVhIG91dHB1dFxyXG4gKi9cclxuZnVuY3Rpb24gZm9ybWF0THVhVmFsdWUodHlwZTogUmdkRGF0YVR5cGUsIHZhbHVlOiBhbnkpOiBzdHJpbmcge1xyXG4gICAgc3dpdGNoICh0eXBlKSB7XHJcbiAgICAgICAgY2FzZSBSZ2REYXRhVHlwZS5GbG9hdDoge1xyXG4gICAgICAgICAgICBjb25zdCBmID0gdmFsdWUgYXMgbnVtYmVyO1xyXG4gICAgICAgICAgICAvLyBDb3JzaXggdXNlcyBpbnRlZ2VyIGZvcm1hdCBmb3Igd2hvbGUgbnVtYmVyc1xyXG4gICAgICAgICAgICBpZiAoTnVtYmVyLmlzSW50ZWdlcihmKSkge1xyXG4gICAgICAgICAgICAgICAgcmV0dXJuIGYudG9TdHJpbmcoKTtcclxuICAgICAgICAgICAgfVxyXG4gICAgICAgICAgICBjb25zdCBwcmVjaXNpb24gPSBmLnRvUHJlY2lzaW9uKDEwKTtcclxuICAgICAgICAgICAgY29uc3QgdHJpbW1lZCA9IHByZWNpc2lvbi5yZXBsYWNlKC9cXC4/MCskLywgJycpO1xyXG4gICAgICAgICAgICByZXR1cm4gdHJpbW1lZDtcclxuICAgICAgICB9XHJcblxyXG4gICAgICAgIGNhc2UgUmdkRGF0YVR5cGUuSW50ZWdlcjpcclxuICAgICAgICAgICAgcmV0dXJuICh2YWx1ZSBhcyBudW1iZXIpLnRvU3RyaW5nKCk7XHJcblxyXG4gICAgICAgIGNhc2UgUmdkRGF0YVR5cGUuQm9vbDpcclxuICAgICAgICAgICAgcmV0dXJuIHZhbHVlID8gJ3RydWUnIDogJ2ZhbHNlJztcclxuXHJcbiAgICAgICAgY2FzZSBSZ2REYXRhVHlwZS5TdHJpbmc6XHJcbiAgICAgICAgICAgIHJldHVybiBgW1ske3ZhbHVlIGFzIHN0cmluZ31dXWA7XHJcblxyXG4gICAgICAgIGNhc2UgUmdkRGF0YVR5cGUuV1N0cmluZzpcclxuICAgICAgICAgICAgLy8gV1N0cmluZ3Mgd2l0aCAkIHByZWZpeCBhcmUgVUNTIHJlZmVyZW5jZXNcclxuICAgICAgICAgICAgY29uc3Qgd3MgPSB2YWx1ZSBhcyBzdHJpbmc7XHJcbiAgICAgICAgICAgIGlmICh3cy5zdGFydHNXaXRoKCckJykpIHtcclxuICAgICAgICAgICAgICAgIHJldHVybiBgW1ske3dzfV1dYDtcclxuICAgICAgICAgICAgfVxyXG4gICAgICAgICAgICByZXR1cm4gYFtbJHt3c31dXWA7XHJcblxyXG4gICAgICAgIGRlZmF1bHQ6XHJcbiAgICAgICAgICAgIHJldHVybiBgW1ske1N0cmluZyh2YWx1ZSl9XV1gO1xyXG4gICAgfVxyXG59XHJcblxyXG4vKipcclxuICogRXNjYXBlIGEgc3RyaW5nIGZvciB1c2UgYXMgYSBMdWEgdGFibGUga2V5XHJcbiAqL1xyXG5mdW5jdGlvbiBlc2NhcGVMdWFTdHJpbmcoc3RyOiBzdHJpbmcpOiBzdHJpbmcge1xyXG4gICAgcmV0dXJuIHN0clxyXG4gICAgICAgIC5yZXBsYWNlKC9cXFxcL2csICdcXFxcXFxcXCcpXHJcbiAgICAgICAgLnJlcGxhY2UoL1wiL2csICdcXFxcXCInKVxyXG4gICAgICAgIC5yZXBsYWNlKC9cXG4vZywgJ1xcXFxuJylcclxuICAgICAgICAucmVwbGFjZSgvXFxyL2csICdcXFxccicpO1xyXG59XHJcblxyXG4vKipcclxuICogUGFyc2UgTHVhIEdhbWVEYXRhIGZvcm1hdCBiYWNrIHRvIFJHRCBzdHJ1Y3R1cmVcclxuICovXHJcbmV4cG9ydCBmdW5jdGlvbiBsdWFUb1JnZChsdWFDb2RlOiBzdHJpbmcsIGRpY3Q6IEhhc2hEaWN0aW9uYXJ5KTogeyBnYW1lRGF0YTogUmdkVGFibGU7IHZlcnNpb246IG51bWJlciB9IHtcclxuICAgIGNvbnN0IGxpbmVzID0gbHVhQ29kZS5zcGxpdCgvXFxyP1xcbi8pO1xyXG4gICAgY29uc3QgZ2FtZURhdGE6IFJnZFRhYmxlID0geyBlbnRyaWVzOiBbXSB9O1xyXG4gICAgbGV0IHZlcnNpb24gPSAxOyAvLyBEZWZhdWx0IHRvIERvVyB2ZXJzaW9uXHJcblxyXG4gICAgLy8gVHJhY2sgdGFibGVzIHdlJ3ZlIGNyZWF0ZWRcclxuICAgIGNvbnN0IHRhYmxlcyA9IG5ldyBNYXA8c3RyaW5nLCBSZ2RUYWJsZT4oKTtcclxuICAgIHRhYmxlcy5zZXQoJ0dhbWVEYXRhJywgZ2FtZURhdGEpO1xyXG5cclxuICAgIGZvciAoY29uc3QgbGluZSBvZiBsaW5lcykge1xyXG4gICAgICAgIGNvbnN0IHRyaW1tZWQgPSBsaW5lLnRyaW0oKTtcclxuXHJcbiAgICAgICAgLy8gU2tpcCBjb21tZW50cyBhbmQgZW1wdHkgbGluZXNcclxuICAgICAgICBpZiAodHJpbW1lZCA9PT0gJycgfHwgdHJpbW1lZC5zdGFydHNXaXRoKCctLScpKSBjb250aW51ZTtcclxuXHJcbiAgICAgICAgLy8gUGFyc2UgR2FtZURhdGEgPSBJbmhlcml0KFtbcGF0aF1dKSBvciBHYW1lRGF0YSA9IEluaGVyaXQoW1tdXSlcclxuICAgICAgICBjb25zdCBpbmhlcml0TWF0Y2ggPSB0cmltbWVkLm1hdGNoKC9eR2FtZURhdGFcXHMqPVxccypJbmhlcml0XFxzKlxcKFxccypcXFtcXFsoLio/KVxcXVxcXVxccypcXCkvKTtcclxuICAgICAgICBpZiAoaW5oZXJpdE1hdGNoKSB7XHJcbiAgICAgICAgICAgIGNvbnN0IHJlZlBhdGggPSBpbmhlcml0TWF0Y2hbMV07XHJcbiAgICAgICAgICAgIGlmIChyZWZQYXRoKSB7XHJcbiAgICAgICAgICAgICAgICBnYW1lRGF0YS5yZWZlcmVuY2UgPSByZWZQYXRoO1xyXG4gICAgICAgICAgICAgICAgLy8gQWRkICRSRUYgZW50cnlcclxuICAgICAgICAgICAgICAgIGdhbWVEYXRhLmVudHJpZXMucHVzaCh7XHJcbiAgICAgICAgICAgICAgICAgICAgaGFzaDogUkVGX0hBU0gsXHJcbiAgICAgICAgICAgICAgICAgICAgbmFtZTogJyRSRUYnLFxyXG4gICAgICAgICAgICAgICAgICAgIHR5cGU6IFJnZERhdGFUeXBlLlN0cmluZyxcclxuICAgICAgICAgICAgICAgICAgICB2YWx1ZTogcmVmUGF0aFxyXG4gICAgICAgICAgICAgICAgfSk7XHJcbiAgICAgICAgICAgIH1cclxuICAgICAgICAgICAgY29udGludWU7XHJcbiAgICAgICAgfVxyXG5cclxuICAgICAgICAvLyBQYXJzZSBHYW1lRGF0YSA9IHt9XHJcbiAgICAgICAgaWYgKHRyaW1tZWQgPT09ICdHYW1lRGF0YSA9IHt9Jykge1xyXG4gICAgICAgICAgICBjb250aW51ZTtcclxuICAgICAgICB9XHJcblxyXG4gICAgICAgIC8vIFBhcnNlIGFzc2lnbm1lbnRzOiBHYW1lRGF0YVtcImtleVwiXVtcInN1YmtleVwiXSA9IHZhbHVlXHJcbiAgICAgICAgY29uc3QgYXNzaWduTWF0Y2ggPSB0cmltbWVkLm1hdGNoKC9eKEdhbWVEYXRhKD86XFxbXCJbXlwiXStcIlxcXSkrKVxccyo9XFxzKiguKykkLyk7XHJcbiAgICAgICAgaWYgKGFzc2lnbk1hdGNoKSB7XHJcbiAgICAgICAgICAgIGNvbnN0IGZ1bGxQYXRoID0gYXNzaWduTWF0Y2hbMV07XHJcbiAgICAgICAgICAgIGNvbnN0IHZhbHVlU3RyID0gYXNzaWduTWF0Y2hbMl0udHJpbSgpO1xyXG5cclxuICAgICAgICAgICAgLy8gRXh0cmFjdCBrZXlzIGZyb20gcGF0aFxyXG4gICAgICAgICAgICBjb25zdCBrZXlzOiBzdHJpbmdbXSA9IFtdO1xyXG4gICAgICAgICAgICBjb25zdCBrZXlSZWdleCA9IC9cXFtcIihbXlwiXSspXCJcXF0vZztcclxuICAgICAgICAgICAgbGV0IGtleU1hdGNoO1xyXG4gICAgICAgICAgICB3aGlsZSAoKGtleU1hdGNoID0ga2V5UmVnZXguZXhlYyhmdWxsUGF0aCkpICE9PSBudWxsKSB7XHJcbiAgICAgICAgICAgICAgICBrZXlzLnB1c2goa2V5TWF0Y2hbMV0pO1xyXG4gICAgICAgICAgICB9XHJcblxyXG4gICAgICAgICAgICBpZiAoa2V5cy5sZW5ndGggPT09IDApIGNvbnRpbnVlO1xyXG5cclxuICAgICAgICAgICAgLy8gTmF2aWdhdGUgdG8gcGFyZW50IHRhYmxlLCBjcmVhdGluZyBhcyBuZWVkZWRcclxuICAgICAgICAgICAgbGV0IGN1cnJlbnRUYWJsZSA9IGdhbWVEYXRhO1xyXG4gICAgICAgICAgICBsZXQgY3VycmVudFBhdGggPSAnR2FtZURhdGEnO1xyXG5cclxuICAgICAgICAgICAgZm9yIChsZXQgaSA9IDA7IGkgPCBrZXlzLmxlbmd0aCAtIDE7IGkrKykge1xyXG4gICAgICAgICAgICAgICAgY29uc3Qga2V5ID0ga2V5c1tpXTtcclxuICAgICAgICAgICAgICAgIGN1cnJlbnRQYXRoICs9IGBbXCIke2tleX1cIl1gO1xyXG5cclxuICAgICAgICAgICAgICAgIC8vIEZpbmQgb3IgY3JlYXRlIHRhYmxlXHJcbiAgICAgICAgICAgICAgICBsZXQgZXhpc3RpbmdUYWJsZSA9IHRhYmxlcy5nZXQoY3VycmVudFBhdGgpO1xyXG4gICAgICAgICAgICAgICAgaWYgKCFleGlzdGluZ1RhYmxlKSB7XHJcbiAgICAgICAgICAgICAgICAgICAgY29uc3QgaCA9IG5hbWVUb0hhc2goZGljdCwga2V5KTtcclxuICAgICAgICAgICAgICAgICAgICBjb25zdCBuZXdUYWJsZTogUmdkVGFibGUgPSB7IGVudHJpZXM6IFtdIH07XHJcbiAgICAgICAgICAgICAgICAgICAgdGFibGVzLnNldChjdXJyZW50UGF0aCwgbmV3VGFibGUpO1xyXG5cclxuICAgICAgICAgICAgICAgICAgICBjdXJyZW50VGFibGUuZW50cmllcy5wdXNoKHtcclxuICAgICAgICAgICAgICAgICAgICAgICAgaGFzaDogaCxcclxuICAgICAgICAgICAgICAgICAgICAgICAgbmFtZToga2V5LFxyXG4gICAgICAgICAgICAgICAgICAgICAgICB0eXBlOiBSZ2REYXRhVHlwZS5UYWJsZSxcclxuICAgICAgICAgICAgICAgICAgICAgICAgdmFsdWU6IG5ld1RhYmxlXHJcbiAgICAgICAgICAgICAgICAgICAgfSk7XHJcbiAgICAgICAgICAgICAgICAgICAgZXhpc3RpbmdUYWJsZSA9IG5ld1RhYmxlO1xyXG4gICAgICAgICAgICAgICAgfVxyXG4gICAgICAgICAgICAgICAgY3VycmVudFRhYmxlID0gZXhpc3RpbmdUYWJsZTtcclxuICAgICAgICAgICAgfVxyXG5cclxuICAgICAgICAgICAgLy8gQWRkIHRoZSBmaW5hbCBlbnRyeVxyXG4gICAgICAgICAgICBjb25zdCBmaW5hbEtleSA9IGtleXNba2V5cy5sZW5ndGggLSAxXTtcclxuICAgICAgICAgICAgY29uc3QgZmluYWxIYXNoID0gbmFtZVRvSGFzaChkaWN0LCBmaW5hbEtleSk7XHJcbiAgICAgICAgICAgIGNvbnN0IGZpbmFsUGF0aCA9IGN1cnJlbnRQYXRoICsgYFtcIiR7ZmluYWxLZXl9XCJdYDtcclxuXHJcbiAgICAgICAgICAgIC8vIFBhcnNlIHZhbHVlXHJcbiAgICAgICAgICAgIGlmICh2YWx1ZVN0ciA9PT0gJ3t9Jykge1xyXG4gICAgICAgICAgICAgICAgLy8gRW1wdHkgdGFibGVcclxuICAgICAgICAgICAgICAgIGNvbnN0IG5ld1RhYmxlOiBSZ2RUYWJsZSA9IHsgZW50cmllczogW10gfTtcclxuICAgICAgICAgICAgICAgIHRhYmxlcy5zZXQoZmluYWxQYXRoLCBuZXdUYWJsZSk7XHJcbiAgICAgICAgICAgICAgICBjdXJyZW50VGFibGUuZW50cmllcy5wdXNoKHtcclxuICAgICAgICAgICAgICAgICAgICBoYXNoOiBmaW5hbEhhc2gsXHJcbiAgICAgICAgICAgICAgICAgICAgbmFtZTogZmluYWxLZXksXHJcbiAgICAgICAgICAgICAgICAgICAgdHlwZTogUmdkRGF0YVR5cGUuVGFibGUsXHJcbiAgICAgICAgICAgICAgICAgICAgdmFsdWU6IG5ld1RhYmxlXHJcbiAgICAgICAgICAgICAgICB9KTtcclxuICAgICAgICAgICAgfSBlbHNlIGlmICh2YWx1ZVN0ci5zdGFydHNXaXRoKCdJbmhlcml0JykgfHwgdmFsdWVTdHIuc3RhcnRzV2l0aCgnUmVmZXJlbmNlJykpIHtcclxuICAgICAgICAgICAgICAgIC8vIFRhYmxlIHdpdGggaW5oZXJpdGFuY2UgKEluaGVyaXQgZm9yIHJvb3QsIFJlZmVyZW5jZSBmb3IgY2hpbGRyZW4pXHJcbiAgICAgICAgICAgICAgICBjb25zdCByZWZNYXRjaCA9IHZhbHVlU3RyLm1hdGNoKC8oPzpJbmhlcml0fFJlZmVyZW5jZSlcXHMqXFwoXFxzKlxcW1xcWyguKz8pXFxdXFxdXFxzKlxcKS8pO1xyXG4gICAgICAgICAgICAgICAgY29uc3QgcmVmUGF0aCA9IHJlZk1hdGNoID8gcmVmTWF0Y2hbMV0gOiB1bmRlZmluZWQ7XHJcblxyXG4gICAgICAgICAgICAgICAgY29uc3QgbmV3VGFibGU6IFJnZFRhYmxlID0geyBlbnRyaWVzOiBbXSwgcmVmZXJlbmNlOiByZWZQYXRoIH07XHJcbiAgICAgICAgICAgICAgICBpZiAocmVmUGF0aCkge1xyXG4gICAgICAgICAgICAgICAgICAgIG5ld1RhYmxlLmVudHJpZXMucHVzaCh7XHJcbiAgICAgICAgICAgICAgICAgICAgICAgIGhhc2g6IFJFRl9IQVNILFxyXG4gICAgICAgICAgICAgICAgICAgICAgICBuYW1lOiAnJFJFRicsXHJcbiAgICAgICAgICAgICAgICAgICAgICAgIHR5cGU6IFJnZERhdGFUeXBlLlN0cmluZyxcclxuICAgICAgICAgICAgICAgICAgICAgICAgdmFsdWU6IHJlZlBhdGhcclxuICAgICAgICAgICAgICAgICAgICB9KTtcclxuICAgICAgICAgICAgICAgIH1cclxuICAgICAgICAgICAgICAgIHRhYmxlcy5zZXQoZmluYWxQYXRoLCBuZXdUYWJsZSk7XHJcbiAgICAgICAgICAgICAgICBjdXJyZW50VGFibGUuZW50cmllcy5wdXNoKHtcclxuICAgICAgICAgICAgICAgICAgICBoYXNoOiBmaW5hbEhhc2gsXHJcbiAgICAgICAgICAgICAgICAgICAgbmFtZTogZmluYWxLZXksXHJcbiAgICAgICAgICAgICAgICAgICAgdHlwZTogUmdkRGF0YVR5cGUuVGFibGUsXHJcbiAgICAgICAgICAgICAgICAgICAgdmFsdWU6IG5ld1RhYmxlXHJcbiAgICAgICAgICAgICAgICB9KTtcclxuICAgICAgICAgICAgfSBlbHNlIHtcclxuICAgICAgICAgICAgICAgIC8vIFBhcnNlIHNpbXBsZSB2YWx1ZVxyXG4gICAgICAgICAgICAgICAgY29uc3QgeyB0eXBlLCB2YWx1ZSB9ID0gcGFyc2VMdWFWYWx1ZSh2YWx1ZVN0cik7XHJcbiAgICAgICAgICAgICAgICBjdXJyZW50VGFibGUuZW50cmllcy5wdXNoKHtcclxuICAgICAgICAgICAgICAgICAgICBoYXNoOiBmaW5hbEhhc2gsXHJcbiAgICAgICAgICAgICAgICAgICAgbmFtZTogZmluYWxLZXksXHJcbiAgICAgICAgICAgICAgICAgICAgdHlwZSxcclxuICAgICAgICAgICAgICAgICAgICB2YWx1ZVxyXG4gICAgICAgICAgICAgICAgfSk7XHJcbiAgICAgICAgICAgIH1cclxuICAgICAgICB9XHJcbiAgICB9XHJcblxyXG4gICAgcmV0dXJuIHsgZ2FtZURhdGEsIHZlcnNpb24gfTtcclxufVxyXG5cclxuLyoqXHJcbiAqIExvYWRlciBmdW5jdGlvbiB0eXBlIGZvciByZXNvbHZpbmcgcGFyZW50IFJHRCBmaWxlc1xyXG4gKi9cclxuZXhwb3J0IHR5cGUgUmdkUGFyZW50TG9hZGVyID0gKHJlZlBhdGg6IHN0cmluZykgPT4gUHJvbWlzZTxSZ2RUYWJsZSB8IG51bGw+O1xyXG5cclxuLyoqXHJcbiAqIFBhcnNlIEx1YSBHYW1lRGF0YSBmb3JtYXQgdG8gUkdEIHdpdGggZnVsbCByZXNvbHV0aW9uIG9mIEluaGVyaXQvUmVmZXJlbmNlXHJcbiAqIFRoaXMgY3JlYXRlcyBhIGNvbXBsZXRlIFJHRCBieSBsb2FkaW5nIGFuZCBtZXJnaW5nIHBhcmVudCBmaWxlc1xyXG4gKi9cclxuZXhwb3J0IGFzeW5jIGZ1bmN0aW9uIGx1YVRvUmdkUmVzb2x2ZWQoXHJcbiAgICBsdWFDb2RlOiBzdHJpbmcsXHJcbiAgICBkaWN0OiBIYXNoRGljdGlvbmFyeSxcclxuICAgIHBhcmVudExvYWRlcjogUmdkUGFyZW50TG9hZGVyXHJcbik6IFByb21pc2U8eyBnYW1lRGF0YTogUmdkVGFibGU7IHZlcnNpb246IG51bWJlciB9PiB7XHJcbiAgICBjb25zdCBsaW5lcyA9IGx1YUNvZGUuc3BsaXQoL1xccj9cXG4vKTtcclxuICAgIGxldCBnYW1lRGF0YTogUmdkVGFibGUgPSB7IGVudHJpZXM6IFtdIH07XHJcbiAgICBsZXQgdmVyc2lvbiA9IDE7XHJcblxyXG4gICAgLy8gRmlyc3QgcGFzczogZmluZCByb290IEluaGVyaXQgYW5kIGxvYWQgYmFzZSBkYXRhXHJcbiAgICBmb3IgKGNvbnN0IGxpbmUgb2YgbGluZXMpIHtcclxuICAgICAgICBjb25zdCB0cmltbWVkID0gbGluZS50cmltKCk7XHJcbiAgICAgICAgY29uc3QgaW5oZXJpdE1hdGNoID0gdHJpbW1lZC5tYXRjaCgvXkdhbWVEYXRhXFxzKj1cXHMqSW5oZXJpdFxccypcXChcXHMqXFxbXFxbKC4qPylcXF1cXF1cXHMqXFwpLyk7XHJcbiAgICAgICAgaWYgKGluaGVyaXRNYXRjaCkge1xyXG4gICAgICAgICAgICBjb25zdCByZWZQYXRoID0gaW5oZXJpdE1hdGNoWzFdO1xyXG4gICAgICAgICAgICBpZiAocmVmUGF0aCkge1xyXG4gICAgICAgICAgICAgICAgY29uc3QgcGFyZW50VGFibGUgPSBhd2FpdCBwYXJlbnRMb2FkZXIocmVmUGF0aCk7XHJcbiAgICAgICAgICAgICAgICBpZiAocGFyZW50VGFibGUpIHtcclxuICAgICAgICAgICAgICAgICAgICAvLyBEZWVwIGNvcHkgcGFyZW50IGFzIGJhc2VcclxuICAgICAgICAgICAgICAgICAgICBnYW1lRGF0YSA9IGRlZXBDb3B5UmdkVGFibGUocGFyZW50VGFibGUpO1xyXG4gICAgICAgICAgICAgICAgfVxyXG4gICAgICAgICAgICB9XHJcbiAgICAgICAgICAgIGJyZWFrO1xyXG4gICAgICAgIH1cclxuICAgIH1cclxuXHJcbiAgICAvLyBUcmFjayB0YWJsZXMgZm9yIG5hdmlnYXRpb25cclxuICAgIGNvbnN0IHRhYmxlcyA9IG5ldyBNYXA8c3RyaW5nLCBSZ2RUYWJsZT4oKTtcclxuICAgIHRhYmxlcy5zZXQoJ0dhbWVEYXRhJywgZ2FtZURhdGEpO1xyXG5cclxuICAgIC8vIFNlY29uZCBwYXNzOiBhcHBseSBhbGwgYXNzaWdubWVudHNcclxuICAgIGZvciAoY29uc3QgbGluZSBvZiBsaW5lcykge1xyXG4gICAgICAgIGNvbnN0IHRyaW1tZWQgPSBsaW5lLnRyaW0oKTtcclxuICAgICAgICBpZiAodHJpbW1lZCA9PT0gJycgfHwgdHJpbW1lZC5zdGFydHNXaXRoKCctLScpKSBjb250aW51ZTtcclxuICAgICAgICBpZiAodHJpbW1lZC5tYXRjaCgvXkdhbWVEYXRhXFxzKj1cXHMqSW5oZXJpdC8pKSBjb250aW51ZTsgLy8gQWxyZWFkeSBoYW5kbGVkXHJcblxyXG4gICAgICAgIC8vIFBhcnNlIGFzc2lnbm1lbnRzXHJcbiAgICAgICAgY29uc3QgYXNzaWduTWF0Y2ggPSB0cmltbWVkLm1hdGNoKC9eKEdhbWVEYXRhKD86XFxbXCJbXlwiXStcIlxcXSkrKVxccyo9XFxzKiguKykkLyk7XHJcbiAgICAgICAgaWYgKCFhc3NpZ25NYXRjaCkgY29udGludWU7XHJcblxyXG4gICAgICAgIGNvbnN0IGZ1bGxQYXRoID0gYXNzaWduTWF0Y2hbMV07XHJcbiAgICAgICAgbGV0IHZhbHVlU3RyID0gYXNzaWduTWF0Y2hbMl0udHJpbSgpO1xyXG5cclxuICAgICAgICAvLyBSZW1vdmUgdHJhaWxpbmcgY29tbWVudFxyXG4gICAgICAgIGNvbnN0IGNvbW1lbnRJZHggPSB2YWx1ZVN0ci5pbmRleE9mKCctLScpO1xyXG4gICAgICAgIGlmIChjb21tZW50SWR4ID4gMCkge1xyXG4gICAgICAgICAgICB2YWx1ZVN0ciA9IHZhbHVlU3RyLnN1YnN0cmluZygwLCBjb21tZW50SWR4KS50cmltKCk7XHJcbiAgICAgICAgfVxyXG5cclxuICAgICAgICAvLyBFeHRyYWN0IGtleXNcclxuICAgICAgICBjb25zdCBrZXlzOiBzdHJpbmdbXSA9IFtdO1xyXG4gICAgICAgIGNvbnN0IGtleVJlZ2V4ID0gL1xcW1wiKFteXCJdKylcIlxcXS9nO1xyXG4gICAgICAgIGxldCBrZXlNYXRjaDtcclxuICAgICAgICB3aGlsZSAoKGtleU1hdGNoID0ga2V5UmVnZXguZXhlYyhmdWxsUGF0aCkpICE9PSBudWxsKSB7XHJcbiAgICAgICAgICAgIGtleXMucHVzaChrZXlNYXRjaFsxXSk7XHJcbiAgICAgICAgfVxyXG4gICAgICAgIGlmIChrZXlzLmxlbmd0aCA9PT0gMCkgY29udGludWU7XHJcblxyXG4gICAgICAgIC8vIEhhbmRsZSBuaWwgLSByZW1vdmUgZW50cnkgZnJvbSBwYXJlbnRcclxuICAgICAgICBpZiAodmFsdWVTdHIgPT09ICduaWwnKSB7XHJcbiAgICAgICAgICAgIGNvbnN0IHBhcmVudFBhdGggPSBrZXlzLnNsaWNlKDAsIC0xKTtcclxuICAgICAgICAgICAgY29uc3QgZmluYWxLZXkgPSBrZXlzW2tleXMubGVuZ3RoIC0gMV07XHJcbiAgICAgICAgICAgIGNvbnN0IHBhcmVudFRhYmxlID0gbmF2aWdhdGVUb1RhYmxlKGdhbWVEYXRhLCBwYXJlbnRQYXRoLCB0YWJsZXMsIGRpY3QpO1xyXG4gICAgICAgICAgICBpZiAocGFyZW50VGFibGUpIHtcclxuICAgICAgICAgICAgICAgIC8vIFJlbW92ZSBlbnRyeSB3aXRoIHRoaXMgbmFtZVxyXG4gICAgICAgICAgICAgICAgcGFyZW50VGFibGUuZW50cmllcyA9IHBhcmVudFRhYmxlLmVudHJpZXMuZmlsdGVyKGUgPT4gZS5uYW1lICE9PSBmaW5hbEtleSk7XHJcbiAgICAgICAgICAgIH1cclxuICAgICAgICAgICAgY29udGludWU7XHJcbiAgICAgICAgfVxyXG5cclxuICAgICAgICAvLyBOYXZpZ2F0ZSB0byBwYXJlbnQgdGFibGVcclxuICAgICAgICBsZXQgY3VycmVudFRhYmxlID0gZ2FtZURhdGE7XHJcbiAgICAgICAgbGV0IGN1cnJlbnRQYXRoID0gJ0dhbWVEYXRhJztcclxuXHJcbiAgICAgICAgZm9yIChsZXQgaSA9IDA7IGkgPCBrZXlzLmxlbmd0aCAtIDE7IGkrKykge1xyXG4gICAgICAgICAgICBjb25zdCBrZXkgPSBrZXlzW2ldO1xyXG4gICAgICAgICAgICBjdXJyZW50UGF0aCArPSBgW1wiJHtrZXl9XCJdYDtcclxuXHJcbiAgICAgICAgICAgIGxldCBjaGlsZFRhYmxlID0gZmluZE9yQ3JlYXRlVGFibGUoY3VycmVudFRhYmxlLCBrZXksIHRhYmxlcywgY3VycmVudFBhdGgsIGRpY3QpO1xyXG4gICAgICAgICAgICBjdXJyZW50VGFibGUgPSBjaGlsZFRhYmxlO1xyXG4gICAgICAgIH1cclxuXHJcbiAgICAgICAgY29uc3QgZmluYWxLZXkgPSBrZXlzW2tleXMubGVuZ3RoIC0gMV07XHJcbiAgICAgICAgY29uc3QgZmluYWxIYXNoID0gbmFtZVRvSGFzaChkaWN0LCBmaW5hbEtleSk7XHJcbiAgICAgICAgY29uc3QgZmluYWxQYXRoID0gY3VycmVudFBhdGggKyBgW1wiJHtmaW5hbEtleX1cIl1gO1xyXG5cclxuICAgICAgICAvLyBIYW5kbGUgUmVmZXJlbmNlIC0gbG9hZCBiYXNlIGFuZCBtZXJnZVxyXG4gICAgICAgIGlmICh2YWx1ZVN0ci5zdGFydHNXaXRoKCdSZWZlcmVuY2UnKSkge1xyXG4gICAgICAgICAgICBjb25zdCByZWZNYXRjaCA9IHZhbHVlU3RyLm1hdGNoKC9SZWZlcmVuY2VcXHMqXFwoXFxzKlxcW1xcWyguKz8pXFxdXFxdXFxzKlxcKS8pO1xyXG4gICAgICAgICAgICBjb25zdCByZWZQYXRoID0gcmVmTWF0Y2ggPyByZWZNYXRjaFsxXSA6IHVuZGVmaW5lZDtcclxuXHJcbiAgICAgICAgICAgIGxldCBuZXdUYWJsZTogUmdkVGFibGU7XHJcbiAgICAgICAgICAgIGlmIChyZWZQYXRoKSB7XHJcbiAgICAgICAgICAgICAgICBjb25zdCByZWZUYWJsZSA9IGF3YWl0IHBhcmVudExvYWRlcihyZWZQYXRoKTtcclxuICAgICAgICAgICAgICAgIGlmIChyZWZUYWJsZSkge1xyXG4gICAgICAgICAgICAgICAgICAgIG5ld1RhYmxlID0gZGVlcENvcHlSZ2RUYWJsZShyZWZUYWJsZSk7XHJcbiAgICAgICAgICAgICAgICAgICAgbmV3VGFibGUucmVmZXJlbmNlID0gcmVmUGF0aDtcclxuICAgICAgICAgICAgICAgICAgICAvLyBFbnN1cmUgJFJFRiBlbnRyeSBleGlzdHNcclxuICAgICAgICAgICAgICAgICAgICBpZiAoIW5ld1RhYmxlLmVudHJpZXMuZmluZChlID0+IGUuaGFzaCA9PT0gUkVGX0hBU0gpKSB7XHJcbiAgICAgICAgICAgICAgICAgICAgICAgIG5ld1RhYmxlLmVudHJpZXMudW5zaGlmdCh7XHJcbiAgICAgICAgICAgICAgICAgICAgICAgICAgICBoYXNoOiBSRUZfSEFTSCxcclxuICAgICAgICAgICAgICAgICAgICAgICAgICAgIG5hbWU6ICckUkVGJyxcclxuICAgICAgICAgICAgICAgICAgICAgICAgICAgIHR5cGU6IFJnZERhdGFUeXBlLlN0cmluZyxcclxuICAgICAgICAgICAgICAgICAgICAgICAgICAgIHZhbHVlOiByZWZQYXRoXHJcbiAgICAgICAgICAgICAgICAgICAgICAgIH0pO1xyXG4gICAgICAgICAgICAgICAgICAgIH1cclxuICAgICAgICAgICAgICAgIH0gZWxzZSB7XHJcbiAgICAgICAgICAgICAgICAgICAgbmV3VGFibGUgPSB7IGVudHJpZXM6IFtdLCByZWZlcmVuY2U6IHJlZlBhdGggfTtcclxuICAgICAgICAgICAgICAgICAgICBuZXdUYWJsZS5lbnRyaWVzLnB1c2goe1xyXG4gICAgICAgICAgICAgICAgICAgICAgICBoYXNoOiBSRUZfSEFTSCxcclxuICAgICAgICAgICAgICAgICAgICAgICAgbmFtZTogJyRSRUYnLFxyXG4gICAgICAgICAgICAgICAgICAgICAgICB0eXBlOiBSZ2REYXRhVHlwZS5TdHJpbmcsXHJcbiAgICAgICAgICAgICAgICAgICAgICAgIHZhbHVlOiByZWZQYXRoXHJcbiAgICAgICAgICAgICAgICAgICAgfSk7XHJcbiAgICAgICAgICAgICAgICB9XHJcbiAgICAgICAgICAgIH0gZWxzZSB7XHJcbiAgICAgICAgICAgICAgICBuZXdUYWJsZSA9IHsgZW50cmllczogW10gfTtcclxuICAgICAgICAgICAgfVxyXG5cclxuICAgICAgICAgICAgLy8gUmVwbGFjZSBvciBhZGQgdGFibGUgZW50cnlcclxuICAgICAgICAgICAgcmVwbGFjZU9yQWRkRW50cnkoY3VycmVudFRhYmxlLCBmaW5hbEtleSwgZmluYWxIYXNoLCBSZ2REYXRhVHlwZS5UYWJsZSwgbmV3VGFibGUpO1xyXG4gICAgICAgICAgICB0YWJsZXMuc2V0KGZpbmFsUGF0aCwgbmV3VGFibGUpO1xyXG4gICAgICAgIH0gZWxzZSBpZiAodmFsdWVTdHIgPT09ICd7fScpIHtcclxuICAgICAgICAgICAgY29uc3QgbmV3VGFibGU6IFJnZFRhYmxlID0geyBlbnRyaWVzOiBbXSB9O1xyXG4gICAgICAgICAgICByZXBsYWNlT3JBZGRFbnRyeShjdXJyZW50VGFibGUsIGZpbmFsS2V5LCBmaW5hbEhhc2gsIFJnZERhdGFUeXBlLlRhYmxlLCBuZXdUYWJsZSk7XHJcbiAgICAgICAgICAgIHRhYmxlcy5zZXQoZmluYWxQYXRoLCBuZXdUYWJsZSk7XHJcbiAgICAgICAgfSBlbHNlIHtcclxuICAgICAgICAgICAgLy8gU2ltcGxlIHZhbHVlXHJcbiAgICAgICAgICAgIGNvbnN0IHsgdHlwZSwgdmFsdWUgfSA9IHBhcnNlTHVhVmFsdWUodmFsdWVTdHIpO1xyXG4gICAgICAgICAgICByZXBsYWNlT3JBZGRFbnRyeShjdXJyZW50VGFibGUsIGZpbmFsS2V5LCBmaW5hbEhhc2gsIHR5cGUsIHZhbHVlKTtcclxuICAgICAgICB9XHJcbiAgICB9XHJcblxyXG4gICAgcmV0dXJuIHsgZ2FtZURhdGEsIHZlcnNpb24gfTtcclxufVxyXG5cclxuLyoqXHJcbiAqIERlZXAgY29weSBhbiBSR0QgdGFibGVcclxuICovXHJcbmZ1bmN0aW9uIGRlZXBDb3B5UmdkVGFibGUodGFibGU6IFJnZFRhYmxlKTogUmdkVGFibGUge1xyXG4gICAgY29uc3QgY29weTogUmdkVGFibGUgPSB7XHJcbiAgICAgICAgZW50cmllczogW10sXHJcbiAgICAgICAgcmVmZXJlbmNlOiB0YWJsZS5yZWZlcmVuY2VcclxuICAgIH07XHJcbiAgICBmb3IgKGNvbnN0IGVudHJ5IG9mIHRhYmxlLmVudHJpZXMpIHtcclxuICAgICAgICBpZiAoZW50cnkudHlwZSA9PT0gUmdkRGF0YVR5cGUuVGFibGUgfHwgZW50cnkudHlwZSA9PT0gUmdkRGF0YVR5cGUuVGFibGVJbnQpIHtcclxuICAgICAgICAgICAgY29weS5lbnRyaWVzLnB1c2goe1xyXG4gICAgICAgICAgICAgICAgaGFzaDogZW50cnkuaGFzaCxcclxuICAgICAgICAgICAgICAgIG5hbWU6IGVudHJ5Lm5hbWUsXHJcbiAgICAgICAgICAgICAgICB0eXBlOiBlbnRyeS50eXBlLFxyXG4gICAgICAgICAgICAgICAgdmFsdWU6IGRlZXBDb3B5UmdkVGFibGUoZW50cnkudmFsdWUgYXMgUmdkVGFibGUpXHJcbiAgICAgICAgICAgIH0pO1xyXG4gICAgICAgIH0gZWxzZSB7XHJcbiAgICAgICAgICAgIGNvcHkuZW50cmllcy5wdXNoKHsgLi4uZW50cnkgfSk7XHJcbiAgICAgICAgfVxyXG4gICAgfVxyXG4gICAgcmV0dXJuIGNvcHk7XHJcbn1cclxuXHJcbi8qKlxyXG4gKiBOYXZpZ2F0ZSB0byBhIHRhYmxlIGJ5IHBhdGgsIHVzaW5nIGNhY2hlXHJcbiAqL1xyXG5mdW5jdGlvbiBuYXZpZ2F0ZVRvVGFibGUoXHJcbiAgICByb290OiBSZ2RUYWJsZSxcclxuICAgIGtleXM6IHN0cmluZ1tdLFxyXG4gICAgdGFibGVzOiBNYXA8c3RyaW5nLCBSZ2RUYWJsZT4sXHJcbiAgICBkaWN0OiBIYXNoRGljdGlvbmFyeVxyXG4pOiBSZ2RUYWJsZSB8IG51bGwge1xyXG4gICAgbGV0IGN1cnJlbnQgPSByb290O1xyXG4gICAgbGV0IHBhdGggPSAnR2FtZURhdGEnO1xyXG4gICAgZm9yIChjb25zdCBrZXkgb2Yga2V5cykge1xyXG4gICAgICAgIHBhdGggKz0gYFtcIiR7a2V5fVwiXWA7XHJcbiAgICAgICAgY29uc3QgY2FjaGVkID0gdGFibGVzLmdldChwYXRoKTtcclxuICAgICAgICBpZiAoY2FjaGVkKSB7XHJcbiAgICAgICAgICAgIGN1cnJlbnQgPSBjYWNoZWQ7XHJcbiAgICAgICAgICAgIGNvbnRpbnVlO1xyXG4gICAgICAgIH1cclxuICAgICAgICBjb25zdCBlbnRyeSA9IGN1cnJlbnQuZW50cmllcy5maW5kKGUgPT4gZS5uYW1lID09PSBrZXkpO1xyXG4gICAgICAgIGlmICghZW50cnkgfHwgKGVudHJ5LnR5cGUgIT09IFJnZERhdGFUeXBlLlRhYmxlICYmIGVudHJ5LnR5cGUgIT09IFJnZERhdGFUeXBlLlRhYmxlSW50KSkge1xyXG4gICAgICAgICAgICByZXR1cm4gbnVsbDtcclxuICAgICAgICB9XHJcbiAgICAgICAgY3VycmVudCA9IGVudHJ5LnZhbHVlIGFzIFJnZFRhYmxlO1xyXG4gICAgICAgIHRhYmxlcy5zZXQocGF0aCwgY3VycmVudCk7XHJcbiAgICB9XHJcbiAgICByZXR1cm4gY3VycmVudDtcclxufVxyXG5cclxuLyoqXHJcbiAqIEZpbmQgb3IgY3JlYXRlIGEgY2hpbGQgdGFibGVcclxuICovXHJcbmZ1bmN0aW9uIGZpbmRPckNyZWF0ZVRhYmxlKFxyXG4gICAgcGFyZW50OiBSZ2RUYWJsZSxcclxuICAgIGtleTogc3RyaW5nLFxyXG4gICAgdGFibGVzOiBNYXA8c3RyaW5nLCBSZ2RUYWJsZT4sXHJcbiAgICBwYXRoOiBzdHJpbmcsXHJcbiAgICBkaWN0OiBIYXNoRGljdGlvbmFyeVxyXG4pOiBSZ2RUYWJsZSB7XHJcbiAgICBjb25zdCBjYWNoZWQgPSB0YWJsZXMuZ2V0KHBhdGgpO1xyXG4gICAgaWYgKGNhY2hlZCkgcmV0dXJuIGNhY2hlZDtcclxuXHJcbiAgICBjb25zdCBleGlzdGluZyA9IHBhcmVudC5lbnRyaWVzLmZpbmQoZSA9PiBlLm5hbWUgPT09IGtleSk7XHJcbiAgICBpZiAoZXhpc3RpbmcgJiYgKGV4aXN0aW5nLnR5cGUgPT09IFJnZERhdGFUeXBlLlRhYmxlIHx8IGV4aXN0aW5nLnR5cGUgPT09IFJnZERhdGFUeXBlLlRhYmxlSW50KSkge1xyXG4gICAgICAgIHRhYmxlcy5zZXQocGF0aCwgZXhpc3RpbmcudmFsdWUgYXMgUmdkVGFibGUpO1xyXG4gICAgICAgIHJldHVybiBleGlzdGluZy52YWx1ZSBhcyBSZ2RUYWJsZTtcclxuICAgIH1cclxuXHJcbiAgICAvLyBDcmVhdGUgbmV3IHRhYmxlXHJcbiAgICBjb25zdCBuZXdUYWJsZTogUmdkVGFibGUgPSB7IGVudHJpZXM6IFtdIH07XHJcbiAgICBjb25zdCBoYXNoID0gbmFtZVRvSGFzaChkaWN0LCBrZXkpO1xyXG4gICAgcGFyZW50LmVudHJpZXMucHVzaCh7XHJcbiAgICAgICAgaGFzaCxcclxuICAgICAgICBuYW1lOiBrZXksXHJcbiAgICAgICAgdHlwZTogUmdkRGF0YVR5cGUuVGFibGUsXHJcbiAgICAgICAgdmFsdWU6IG5ld1RhYmxlXHJcbiAgICB9KTtcclxuICAgIHRhYmxlcy5zZXQocGF0aCwgbmV3VGFibGUpO1xyXG4gICAgcmV0dXJuIG5ld1RhYmxlO1xyXG59XHJcblxyXG4vKipcclxuICogUmVwbGFjZSBvciBhZGQgYW4gZW50cnkgaW4gYSB0YWJsZVxyXG4gKi9cclxuZnVuY3Rpb24gcmVwbGFjZU9yQWRkRW50cnkoXHJcbiAgICB0YWJsZTogUmdkVGFibGUsXHJcbiAgICBuYW1lOiBzdHJpbmcsXHJcbiAgICBoYXNoOiBudW1iZXIsXHJcbiAgICB0eXBlOiBSZ2REYXRhVHlwZSxcclxuICAgIHZhbHVlOiBhbnlcclxuKTogdm9pZCB7XHJcbiAgICBjb25zdCBpZHggPSB0YWJsZS5lbnRyaWVzLmZpbmRJbmRleChlID0+IGUubmFtZSA9PT0gbmFtZSk7XHJcbiAgICBjb25zdCBlbnRyeSA9IHsgaGFzaCwgbmFtZSwgdHlwZSwgdmFsdWUgfTtcclxuICAgIGlmIChpZHggPj0gMCkge1xyXG4gICAgICAgIHRhYmxlLmVudHJpZXNbaWR4XSA9IGVudHJ5O1xyXG4gICAgfSBlbHNlIHtcclxuICAgICAgICB0YWJsZS5lbnRyaWVzLnB1c2goZW50cnkpO1xyXG4gICAgfVxyXG59XHJcblxyXG4vKipcclxuICogUGFyc2UgYSBMdWEgdmFsdWUgc3RyaW5nXHJcbiAqL1xyXG5mdW5jdGlvbiBwYXJzZUx1YVZhbHVlKHZhbHVlU3RyOiBzdHJpbmcpOiB7IHR5cGU6IFJnZERhdGFUeXBlOyB2YWx1ZTogYW55IH0ge1xyXG4gICAgLy8gQm9vbGVhblxyXG4gICAgaWYgKHZhbHVlU3RyID09PSAndHJ1ZScpIHtcclxuICAgICAgICByZXR1cm4geyB0eXBlOiBSZ2REYXRhVHlwZS5Cb29sLCB2YWx1ZTogdHJ1ZSB9O1xyXG4gICAgfVxyXG4gICAgaWYgKHZhbHVlU3RyID09PSAnZmFsc2UnKSB7XHJcbiAgICAgICAgcmV0dXJuIHsgdHlwZTogUmdkRGF0YVR5cGUuQm9vbCwgdmFsdWU6IGZhbHNlIH07XHJcbiAgICB9XHJcblxyXG4gICAgLy8gU3RyaW5nIHdpdGggW1sgXV1cclxuICAgIGNvbnN0IGJyYWNrZXRTdHJpbmdNYXRjaCA9IHZhbHVlU3RyLm1hdGNoKC9eXFxbXFxbKC4qKT9cXF1cXF0kLyk7XHJcbiAgICBpZiAoYnJhY2tldFN0cmluZ01hdGNoKSB7XHJcbiAgICAgICAgY29uc3Qgc3RyID0gYnJhY2tldFN0cmluZ01hdGNoWzFdID8/ICcnO1xyXG4gICAgICAgIC8vIENoZWNrIGlmIGl0J3MgYSBVQ1MgcmVmZXJlbmNlXHJcbiAgICAgICAgaWYgKHN0ci5zdGFydHNXaXRoKCckJykpIHtcclxuICAgICAgICAgICAgcmV0dXJuIHsgdHlwZTogUmdkRGF0YVR5cGUuV1N0cmluZywgdmFsdWU6IHN0ciB9O1xyXG4gICAgICAgIH1cclxuICAgICAgICByZXR1cm4geyB0eXBlOiBSZ2REYXRhVHlwZS5TdHJpbmcsIHZhbHVlOiBzdHIgfTtcclxuICAgIH1cclxuXHJcbiAgICAvLyBRdW90ZWQgc3RyaW5nXHJcbiAgICBjb25zdCBxdW90ZWRNYXRjaCA9IHZhbHVlU3RyLm1hdGNoKC9eXCIoLiopXCIkLyk7XHJcbiAgICBpZiAocXVvdGVkTWF0Y2gpIHtcclxuICAgICAgICByZXR1cm4geyB0eXBlOiBSZ2REYXRhVHlwZS5TdHJpbmcsIHZhbHVlOiBxdW90ZWRNYXRjaFsxXSB9O1xyXG4gICAgfVxyXG5cclxuICAgIC8vIE51bWJlclxyXG4gICAgY29uc3QgbnVtID0gcGFyc2VGbG9hdCh2YWx1ZVN0cik7XHJcbiAgICBpZiAoIWlzTmFOKG51bSkpIHtcclxuICAgICAgICAvLyBDaGVjayBpZiBpdCdzIGEgZmxvYXQgKGhhcyBkZWNpbWFsIHBvaW50IG9yIGlzIHNjaWVudGlmaWMgbm90YXRpb24pXHJcbiAgICAgICAgaWYgKHZhbHVlU3RyLmluY2x1ZGVzKCcuJykgfHwgdmFsdWVTdHIuaW5jbHVkZXMoJ2UnKSB8fCB2YWx1ZVN0ci5pbmNsdWRlcygnRScpKSB7XHJcbiAgICAgICAgICAgIHJldHVybiB7IHR5cGU6IFJnZERhdGFUeXBlLkZsb2F0LCB2YWx1ZTogbnVtIH07XHJcbiAgICAgICAgfVxyXG4gICAgICAgIC8vIENvdWxkIGJlIGludGVnZXIgb3IgZmxvYXQgLSBkZWZhdWx0IHRvIGZsb2F0IGZvciBSR0QgY29tcGF0aWJpbGl0eVxyXG4gICAgICAgIHJldHVybiB7IHR5cGU6IFJnZERhdGFUeXBlLkZsb2F0LCB2YWx1ZTogbnVtIH07XHJcbiAgICB9XHJcblxyXG4gICAgLy8gRGVmYXVsdCB0byBzdHJpbmdcclxuICAgIHJldHVybiB7IHR5cGU6IFJnZERhdGFUeXBlLlN0cmluZywgdmFsdWU6IHZhbHVlU3RyIH07XHJcbn1cclxuXHJcbi8qKlxyXG4gKiBUeXBlIGZvciBsb2FkaW5nIEx1YSBmaWxlcyBmb3IgUGFyc2VkTHVhVGFibGUgcmVzb2x1dGlvblxyXG4gKi9cclxuZXhwb3J0IHR5cGUgTHVhRmlsZUxvYWRlciA9IChyZWZQYXRoOiBzdHJpbmcpID0+IHN0cmluZyB8IG51bGw7XHJcblxyXG4vKipcclxuICogUGFyc2UgTHVhIGNvZGUgaW50byBQYXJzZWRMdWFUYWJsZSBzdHJ1Y3R1cmUgd2l0aCByZWN1cnNpdmUgcmVmZXJlbmNlIHJlc29sdXRpb24uXHJcbiAqIFRoaXMgaXMgdGhlIGNhbm9uaWNhbCBpbXBsZW1lbnRhdGlvbiBmb3IgZGlmZmVyZW50aWFsIGNvbXBhcmlzb24uXHJcbiAqIFxyXG4gKiBAcGFyYW0gbHVhQ29kZSBUaGUgTHVhIHNvdXJjZSBjb2RlXHJcbiAqIEBwYXJhbSBsdWFGaWxlTG9hZGVyIEZ1bmN0aW9uIHRvIGxvYWQgTHVhIGZpbGVzIGJ5IHJlZmVyZW5jZSBwYXRoIChyZXR1cm5zIGNvZGUgb3IgbnVsbClcclxuICogQHBhcmFtIGxvYWRlZEZpbGVzIFNldCBvZiBhbHJlYWR5IGxvYWRlZCBmaWxlcyAobm9ybWFsaXplZCBwYXRocykgdG8gcHJldmVudCBpbmZpbml0ZSByZWN1cnNpb25cclxuICovXHJcbmV4cG9ydCBmdW5jdGlvbiBwYXJzZUx1YVRvVGFibGUoXHJcbiAgICBsdWFDb2RlOiBzdHJpbmcsXHJcbiAgICBsdWFGaWxlTG9hZGVyPzogTHVhRmlsZUxvYWRlcixcclxuICAgIGxvYWRlZEZpbGVzOiBTZXQ8c3RyaW5nPiA9IG5ldyBTZXQoKVxyXG4pOiBQYXJzZWRMdWFUYWJsZSB7XHJcbiAgICBjb25zdCByZXN1bHQ6IFBhcnNlZEx1YVRhYmxlID0geyBlbnRyaWVzOiBuZXcgTWFwKCkgfTtcclxuICAgIGNvbnN0IGxpbmVzID0gbHVhQ29kZS5zcGxpdCgvXFxyP1xcbi8pO1xyXG4gICAgY29uc3QgdGFibGVTdGFjayA9IG5ldyBNYXA8c3RyaW5nLCBQYXJzZWRMdWFUYWJsZT4oKTtcclxuICAgIHRhYmxlU3RhY2suc2V0KCdHYW1lRGF0YScsIHJlc3VsdCk7XHJcblxyXG4gICAgZm9yIChjb25zdCBsaW5lIG9mIGxpbmVzKSB7XHJcbiAgICAgICAgY29uc3QgdHJpbW1lZCA9IGxpbmUudHJpbSgpO1xyXG4gICAgICAgIGlmICghdHJpbW1lZCB8fCB0cmltbWVkLnN0YXJ0c1dpdGgoJy0tJykpIGNvbnRpbnVlO1xyXG5cclxuICAgICAgICAvLyBQYXJzZSBHYW1lRGF0YSA9IEluaGVyaXQoW1twYXRoXV0pXHJcbiAgICAgICAgY29uc3QgaW5oZXJpdE1hdGNoID0gdHJpbW1lZC5tYXRjaCgvXkdhbWVEYXRhXFxzKj1cXHMqSW5oZXJpdFxccypcXChcXHMqXFxbXFxbKC4qPylcXF1cXF1cXHMqXFwpLyk7XHJcbiAgICAgICAgaWYgKGluaGVyaXRNYXRjaCkge1xyXG4gICAgICAgICAgICByZXN1bHQucmVmZXJlbmNlID0gaW5oZXJpdE1hdGNoWzFdIHx8IHVuZGVmaW5lZDtcclxuICAgICAgICAgICAgY29udGludWU7XHJcbiAgICAgICAgfVxyXG5cclxuICAgICAgICAvLyBQYXJzZSBhc3NpZ25tZW50czogR2FtZURhdGFbXCJrZXlcIl1bXCJzdWJrZXlcIl0gPSB2YWx1ZVxyXG4gICAgICAgIGNvbnN0IGFzc2lnbk1hdGNoID0gdHJpbW1lZC5tYXRjaCgvXihHYW1lRGF0YSg/OlxcW1wiW15cIl0rXCJcXF0pKylcXHMqPVxccyooLispJC8pO1xyXG4gICAgICAgIGlmIChhc3NpZ25NYXRjaCkge1xyXG4gICAgICAgICAgICBjb25zdCBmdWxsUGF0aCA9IGFzc2lnbk1hdGNoWzFdO1xyXG4gICAgICAgICAgICBjb25zdCB2YWx1ZVN0ciA9IGFzc2lnbk1hdGNoWzJdLnRyaW0oKTtcclxuXHJcbiAgICAgICAgICAgIC8vIEV4dHJhY3Qga2V5c1xyXG4gICAgICAgICAgICBjb25zdCBrZXlzOiBzdHJpbmdbXSA9IFtdO1xyXG4gICAgICAgICAgICBjb25zdCBrZXlSZWdleCA9IC9cXFtcIihbXlwiXSspXCJcXF0vZztcclxuICAgICAgICAgICAgbGV0IGtleU1hdGNoO1xyXG4gICAgICAgICAgICB3aGlsZSAoKGtleU1hdGNoID0ga2V5UmVnZXguZXhlYyhmdWxsUGF0aCkpICE9PSBudWxsKSB7XHJcbiAgICAgICAgICAgICAgICBrZXlzLnB1c2goa2V5TWF0Y2hbMV0pO1xyXG4gICAgICAgICAgICB9XHJcbiAgICAgICAgICAgIGlmIChrZXlzLmxlbmd0aCA9PT0gMCkgY29udGludWU7XHJcblxyXG4gICAgICAgICAgICAvLyBOYXZpZ2F0ZSB0byBwYXJlbnQgdGFibGUsIGNyZWF0aW5nIGFzIG5lZWRlZFxyXG4gICAgICAgICAgICBsZXQgY3VycmVudFRhYmxlID0gcmVzdWx0O1xyXG4gICAgICAgICAgICBsZXQgY3VycmVudFBhdGggPSAnR2FtZURhdGEnO1xyXG4gICAgICAgICAgICBmb3IgKGxldCBpID0gMDsgaSA8IGtleXMubGVuZ3RoIC0gMTsgaSsrKSB7XHJcbiAgICAgICAgICAgICAgICBjdXJyZW50UGF0aCArPSBgW1wiJHtrZXlzW2ldfVwiXWA7XHJcbiAgICAgICAgICAgICAgICBsZXQgZXhpc3RpbmdFbnRyeSA9IGN1cnJlbnRUYWJsZS5lbnRyaWVzLmdldChrZXlzW2ldKTtcclxuICAgICAgICAgICAgICAgIGxldCBleGlzdGluZyA9IGV4aXN0aW5nRW50cnk/LnRhYmxlO1xyXG4gICAgICAgICAgICAgICAgaWYgKCFleGlzdGluZykge1xyXG4gICAgICAgICAgICAgICAgICAgIGV4aXN0aW5nID0geyBlbnRyaWVzOiBuZXcgTWFwKCkgfTtcclxuICAgICAgICAgICAgICAgICAgICB0YWJsZVN0YWNrLnNldChjdXJyZW50UGF0aCwgZXhpc3RpbmcpO1xyXG4gICAgICAgICAgICAgICAgICAgIGN1cnJlbnRUYWJsZS5lbnRyaWVzLnNldChrZXlzW2ldLCB7IHR5cGU6ICd0YWJsZScsIHRhYmxlOiBleGlzdGluZyB9KTtcclxuICAgICAgICAgICAgICAgIH1cclxuICAgICAgICAgICAgICAgIGN1cnJlbnRUYWJsZSA9IGV4aXN0aW5nO1xyXG4gICAgICAgICAgICB9XHJcblxyXG4gICAgICAgICAgICBjb25zdCBmaW5hbEtleSA9IGtleXNba2V5cy5sZW5ndGggLSAxXTtcclxuICAgICAgICAgICAgY29uc3QgZmluYWxQYXRoID0gY3VycmVudFBhdGggKyBgW1wiJHtmaW5hbEtleX1cIl1gO1xyXG5cclxuICAgICAgICAgICAgLy8gUGFyc2UgdmFsdWVcclxuICAgICAgICAgICAgaWYgKHZhbHVlU3RyID09PSAnbmlsJykge1xyXG4gICAgICAgICAgICAgICAgLy8gbmlsIG1lYW5zIGRlbGV0ZSAtIHJlbW92ZSBmcm9tIGVudHJpZXMgaWYgZXhpc3RzXHJcbiAgICAgICAgICAgICAgICBjdXJyZW50VGFibGUuZW50cmllcy5kZWxldGUoZmluYWxLZXkpO1xyXG4gICAgICAgICAgICB9IGVsc2UgaWYgKHZhbHVlU3RyLnN0YXJ0c1dpdGgoJ1JlZmVyZW5jZScpIHx8IHZhbHVlU3RyLnN0YXJ0c1dpdGgoJ0luaGVyaXQnKSkge1xyXG4gICAgICAgICAgICAgICAgY29uc3QgcmVmTWF0Y2ggPSB2YWx1ZVN0ci5tYXRjaCgvKD86UmVmZXJlbmNlfEluaGVyaXQpXFxzKlxcKFxccypcXFtcXFsoLis/KVxcXVxcXVxccypcXCkvKTtcclxuICAgICAgICAgICAgICAgIGNvbnN0IHJlZlBhdGggPSByZWZNYXRjaCA/IHJlZk1hdGNoWzFdIDogdW5kZWZpbmVkO1xyXG5cclxuICAgICAgICAgICAgICAgIC8vIExvYWQgYW5kIG1lcmdlIHRoZSByZWZlcmVuY2VkIGZpbGUgKGxpa2UgQ29yc2l4IGRvZXMpXHJcbiAgICAgICAgICAgICAgICBsZXQgbmV3VGFibGU6IFBhcnNlZEx1YVRhYmxlID0geyBlbnRyaWVzOiBuZXcgTWFwKCksIHJlZmVyZW5jZTogcmVmUGF0aCB9O1xyXG4gICAgICAgICAgICAgICAgaWYgKHJlZlBhdGggJiYgbHVhRmlsZUxvYWRlcikge1xyXG4gICAgICAgICAgICAgICAgICAgIC8vIENyZWF0ZSBhIGZyZXNoIGxvYWRlZEZpbGVzIHNldCBmb3IgdGhpcyByZWZlcmVuY2UgY2hhaW5cclxuICAgICAgICAgICAgICAgICAgICBjb25zdCBjaGlsZExvYWRlZEZpbGVzID0gbmV3IFNldChsb2FkZWRGaWxlcyk7XHJcbiAgICAgICAgICAgICAgICAgICAgY29uc3Qgbm9ybWFsaXplZFJlZiA9IHJlZlBhdGgucmVwbGFjZSgvXFxcXC9nLCAnLycpLnRvTG93ZXJDYXNlKCk7XHJcblxyXG4gICAgICAgICAgICAgICAgICAgIGlmICghY2hpbGRMb2FkZWRGaWxlcy5oYXMobm9ybWFsaXplZFJlZikpIHtcclxuICAgICAgICAgICAgICAgICAgICAgICAgY2hpbGRMb2FkZWRGaWxlcy5hZGQobm9ybWFsaXplZFJlZik7XHJcbiAgICAgICAgICAgICAgICAgICAgICAgIGNvbnN0IHJlZkNvZGUgPSBsdWFGaWxlTG9hZGVyKHJlZlBhdGgpO1xyXG4gICAgICAgICAgICAgICAgICAgICAgICBpZiAocmVmQ29kZSkge1xyXG4gICAgICAgICAgICAgICAgICAgICAgICAgICAgY29uc3QgcmVzb2x2ZWRUYWJsZSA9IHBhcnNlTHVhVG9UYWJsZShyZWZDb2RlLCBsdWFGaWxlTG9hZGVyLCBjaGlsZExvYWRlZEZpbGVzKTtcclxuICAgICAgICAgICAgICAgICAgICAgICAgICAgIC8vIERlZXAgY29weSBlbnRyaWVzIGZyb20gcmVzb2x2ZWQgdGFibGVcclxuICAgICAgICAgICAgICAgICAgICAgICAgICAgIG5ld1RhYmxlLmVudHJpZXMgPSBkZWVwQ29weVBhcnNlZEVudHJpZXMocmVzb2x2ZWRUYWJsZS5lbnRyaWVzKTtcclxuICAgICAgICAgICAgICAgICAgICAgICAgICAgIG5ld1RhYmxlLnJlZmVyZW5jZSA9IHJlZlBhdGg7XHJcbiAgICAgICAgICAgICAgICAgICAgICAgIH1cclxuICAgICAgICAgICAgICAgICAgICB9XHJcbiAgICAgICAgICAgICAgICB9XHJcblxyXG4gICAgICAgICAgICAgICAgdGFibGVTdGFjay5zZXQoZmluYWxQYXRoLCBuZXdUYWJsZSk7XHJcbiAgICAgICAgICAgICAgICBjdXJyZW50VGFibGUuZW50cmllcy5zZXQoZmluYWxLZXksIHsgdHlwZTogJ3RhYmxlJywgdGFibGU6IG5ld1RhYmxlLCByZWZlcmVuY2U6IHJlZlBhdGggfSk7XHJcbiAgICAgICAgICAgIH0gZWxzZSBpZiAodmFsdWVTdHIgPT09ICd7fScpIHtcclxuICAgICAgICAgICAgICAgIGNvbnN0IG5ld1RhYmxlOiBQYXJzZWRMdWFUYWJsZSA9IHsgZW50cmllczogbmV3IE1hcCgpIH07XHJcbiAgICAgICAgICAgICAgICB0YWJsZVN0YWNrLnNldChmaW5hbFBhdGgsIG5ld1RhYmxlKTtcclxuICAgICAgICAgICAgICAgIGN1cnJlbnRUYWJsZS5lbnRyaWVzLnNldChmaW5hbEtleSwgeyB0eXBlOiAndGFibGUnLCB0YWJsZTogbmV3VGFibGUgfSk7XHJcbiAgICAgICAgICAgIH0gZWxzZSB7XHJcbiAgICAgICAgICAgICAgICAvLyBQYXJzZSBzaW1wbGUgdmFsdWVcclxuICAgICAgICAgICAgICAgIGNvbnN0IHBhcnNlZCA9IHBhcnNlTHVhVmFsdWVGb3JUYWJsZSh2YWx1ZVN0cik7XHJcbiAgICAgICAgICAgICAgICBjdXJyZW50VGFibGUuZW50cmllcy5zZXQoZmluYWxLZXksIHtcclxuICAgICAgICAgICAgICAgICAgICB0eXBlOiAndmFsdWUnLFxyXG4gICAgICAgICAgICAgICAgICAgIHZhbHVlOiBwYXJzZWQudmFsdWUsXHJcbiAgICAgICAgICAgICAgICAgICAgZGF0YVR5cGU6IHBhcnNlZC5kYXRhVHlwZVxyXG4gICAgICAgICAgICAgICAgfSk7XHJcbiAgICAgICAgICAgIH1cclxuICAgICAgICB9XHJcbiAgICB9XHJcblxyXG4gICAgcmV0dXJuIHJlc3VsdDtcclxufVxyXG5cclxuLyoqXHJcbiAqIERlZXAgY29weSBQYXJzZWRMdWFUYWJsZSBlbnRyaWVzIHRvIGF2b2lkIHNoYXJlZCByZWZlcmVuY2VzXHJcbiAqL1xyXG5mdW5jdGlvbiBkZWVwQ29weVBhcnNlZEVudHJpZXMoZW50cmllczogTWFwPHN0cmluZywgUGFyc2VkTHVhRW50cnk+KTogTWFwPHN0cmluZywgUGFyc2VkTHVhRW50cnk+IHtcclxuICAgIGNvbnN0IGNvcHkgPSBuZXcgTWFwPHN0cmluZywgUGFyc2VkTHVhRW50cnk+KCk7XHJcbiAgICBmb3IgKGNvbnN0IFtrZXksIGVudHJ5XSBvZiBlbnRyaWVzKSB7XHJcbiAgICAgICAgaWYgKGVudHJ5LnR5cGUgPT09ICd0YWJsZScgJiYgZW50cnkudGFibGUpIHtcclxuICAgICAgICAgICAgY29weS5zZXQoa2V5LCB7XHJcbiAgICAgICAgICAgICAgICB0eXBlOiAndGFibGUnLFxyXG4gICAgICAgICAgICAgICAgdGFibGU6IHtcclxuICAgICAgICAgICAgICAgICAgICByZWZlcmVuY2U6IGVudHJ5LnRhYmxlLnJlZmVyZW5jZSxcclxuICAgICAgICAgICAgICAgICAgICBlbnRyaWVzOiBkZWVwQ29weVBhcnNlZEVudHJpZXMoZW50cnkudGFibGUuZW50cmllcylcclxuICAgICAgICAgICAgICAgIH0sXHJcbiAgICAgICAgICAgICAgICByZWZlcmVuY2U6IGVudHJ5LnJlZmVyZW5jZVxyXG4gICAgICAgICAgICB9KTtcclxuICAgICAgICB9IGVsc2Uge1xyXG4gICAgICAgICAgICBjb3B5LnNldChrZXksIHsgLi4uZW50cnkgfSk7XHJcbiAgICAgICAgfVxyXG4gICAgfVxyXG4gICAgcmV0dXJuIGNvcHk7XHJcbn1cclxuXHJcbi8qKlxyXG4gKiBQYXJzZSBhIEx1YSB2YWx1ZSBzdHJpbmcgZm9yIFBhcnNlZEx1YVRhYmxlXHJcbiAqL1xyXG5mdW5jdGlvbiBwYXJzZUx1YVZhbHVlRm9yVGFibGUodmFsdWVTdHI6IHN0cmluZyk6IHsgdmFsdWU6IGFueTsgZGF0YVR5cGU6IFJnZERhdGFUeXBlIH0ge1xyXG4gICAgaWYgKHZhbHVlU3RyID09PSAndHJ1ZScpIHJldHVybiB7IHZhbHVlOiB0cnVlLCBkYXRhVHlwZTogUmdkRGF0YVR5cGUuQm9vbCB9O1xyXG4gICAgaWYgKHZhbHVlU3RyID09PSAnZmFsc2UnKSByZXR1cm4geyB2YWx1ZTogZmFsc2UsIGRhdGFUeXBlOiBSZ2REYXRhVHlwZS5Cb29sIH07XHJcblxyXG4gICAgY29uc3QgYnJhY2tldE1hdGNoID0gdmFsdWVTdHIubWF0Y2goL15cXFtcXFsoLio/KVxcXVxcXS8pO1xyXG4gICAgaWYgKGJyYWNrZXRNYXRjaCkge1xyXG4gICAgICAgIGNvbnN0IHN0ciA9IGJyYWNrZXRNYXRjaFsxXSA/PyAnJztcclxuICAgICAgICBpZiAoc3RyLnN0YXJ0c1dpdGgoJyQnKSkge1xyXG4gICAgICAgICAgICByZXR1cm4geyB2YWx1ZTogc3RyLCBkYXRhVHlwZTogUmdkRGF0YVR5cGUuV1N0cmluZyB9O1xyXG4gICAgICAgIH1cclxuICAgICAgICByZXR1cm4geyB2YWx1ZTogc3RyLCBkYXRhVHlwZTogUmdkRGF0YVR5cGUuU3RyaW5nIH07XHJcbiAgICB9XHJcblxyXG4gICAgY29uc3QgbnVtID0gcGFyc2VGbG9hdCh2YWx1ZVN0cik7XHJcbiAgICBpZiAoIWlzTmFOKG51bSkpIHtcclxuICAgICAgICByZXR1cm4geyB2YWx1ZTogbnVtLCBkYXRhVHlwZTogUmdkRGF0YVR5cGUuRmxvYXQgfTtcclxuICAgIH1cclxuXHJcbiAgICByZXR1cm4geyB2YWx1ZTogdmFsdWVTdHIsIGRhdGFUeXBlOiBSZ2REYXRhVHlwZS5TdHJpbmcgfTtcclxufVxyXG4iXX0=