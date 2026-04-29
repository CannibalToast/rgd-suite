"use strict";
/**
 * RGD Text Format - Human-readable format for editing RGD files
 *
 * Format:
 *   # RGD Text Format v1.0
 *   # Source: filename.rgd
 *
 *   GameData {
 *     $REF = "path/to/inherit.lua"
 *     key_name: float = 1.5
 *     another_key: string = "value"
 *     bool_key: bool = true
 *     int_key: int = 12345
 *     unicode_key: wstring = "unicode value"
 *
 *     nested_table {
 *       child_key: float = 2.0
 *     }
 *   }
 */
Object.defineProperty(exports, "__esModule", { value: true });
exports.rgdToText = rgdToText;
exports.unescapeString = unescapeString;
exports.textToRgd = textToRgd;
exports.rgdToFlatMap = rgdToFlatMap;
exports.rgdToCsv = rgdToCsv;
exports.csvToRgd = csvToRgd;
const types_1 = require("./types");
const dictionary_1 = require("./dictionary");
const hash_1 = require("./hash");
const REF_HASH = 0x49D60FAE;
/**
 * Convert RGD file to text format
 */
function rgdToText(rgdFile, sourceName, localeMap) {
    const lines = [];
    lines.push('# RGD Text Format v1.0');
    if (sourceName) {
        lines.push(`# Source: ${sourceName}`);
    }
    lines.push(`# Version: ${rgdFile.header.version}`);
    lines.push('');
    const refStr = rgdFile.gameData.reference ? ` : "${escapeString(rgdFile.gameData.reference)}"` : '';
    lines.push(`GameData${refStr} {`);
    writeTableContents(lines, rgdFile.gameData, 1, localeMap);
    lines.push('}');
    return lines.join('\n');
}
/**
 * Write table contents with indentation
 */
function writeTableContents(lines, table, indent, localeMap) {
    const prefix = '  '.repeat(indent);
    // Sort entries: tables last, others alphabetically
    const sorted = [...table.entries].sort((a, b) => {
        const aIsTable = a.type === types_1.RgdDataType.Table || a.type === types_1.RgdDataType.TableInt;
        const bIsTable = b.type === types_1.RgdDataType.Table || b.type === types_1.RgdDataType.TableInt;
        if (aIsTable !== bIsTable)
            return aIsTable ? 1 : -1;
        // Skip $REF entries in sorting (they go first)
        if (a.hash === REF_HASH)
            return -1;
        if (b.hash === REF_HASH)
            return 1;
        const aName = a.name ?? (0, hash_1.hashToHex)(a.hash);
        const bName = b.name ?? (0, hash_1.hashToHex)(b.hash);
        return aName.localeCompare(bName);
    });
    for (const entry of sorted) {
        // Skip $REF entries (handled above)
        if (entry.hash === REF_HASH)
            continue;
        const name = entry.name ?? (0, hash_1.hashToHex)(entry.hash);
        if (entry.type === types_1.RgdDataType.Table || entry.type === types_1.RgdDataType.TableInt) {
            // Nested table
            const tableValue = entry.value;
            lines.push('');
            if (tableValue.reference) {
                lines.push(`${prefix}${name} : "${escapeString(tableValue.reference)}" {`);
            }
            else {
                lines.push(`${prefix}${name} {`);
            }
            writeTableContents(lines, tableValue, indent + 1, localeMap);
            lines.push(`${prefix}}`);
        }
        else {
            // Simple value
            const typeName = (0, types_1.dataTypeName)(entry.type);
            const valueStr = formatValue(entry.type, entry.value);
            let comment = '';
            if (entry.type === types_1.RgdDataType.WString || entry.type === types_1.RgdDataType.String) {
                const val = entry.value;
                if (val.startsWith('$') && localeMap) {
                    // LocaleManager stores keys without the `$` sigil (see
                    // src/localeLoader.ts). Strip it once; fall back to the
                    // raw key for older maps that still include it.
                    const locEntry = localeMap.get(val.substring(1)) || localeMap.get(val);
                    if (locEntry) {
                        comment = ` - ${locEntry.text}`;
                    }
                }
            }
            lines.push(`${prefix}${name}: ${typeName} = ${valueStr}${comment}`);
        }
    }
}
/**
 * Format a value for text output
 */
function formatValue(type, value) {
    switch (type) {
        case types_1.RgdDataType.Float:
            // Format float with appropriate precision
            const f = value;
            if (Number.isInteger(f)) {
                return f.toFixed(1);
            }
            return f.toString();
        case types_1.RgdDataType.Integer:
            return value.toString();
        case types_1.RgdDataType.Bool:
            return value ? 'true' : 'false';
        case types_1.RgdDataType.String:
        case types_1.RgdDataType.WString:
            return `"${escapeString(value)}"`;
        default:
            return String(value);
    }
}
/**
 * Escape string for text format
 */
function escapeString(str) {
    return str
        .replace(/\\/g, '\\\\')
        .replace(/"/g, '\\"')
        .replace(/\n/g, '\\n')
        .replace(/\r/g, '\\r')
        .replace(/\t/g, '\\t');
}
/**
 * Unescape string from text format
 */
function unescapeString(str) {
    return str.replace(/\\(.)/g, (match, char) => {
        switch (char) {
            case 'n': return '\n';
            case 'r': return '\r';
            case 't': return '\t';
            case '"': return '"';
            case '\\': return '\\';
            default: return match;
        }
    });
}
/**
 * Parse text format back to RGD structure
 */
function textToRgd(text, dict) {
    const lines = text.split(/\r?\n/);
    let version = 1;
    let lineNum = 0;
    // Parse header comments
    while (lineNum < lines.length) {
        const line = lines[lineNum].trim();
        if (line.startsWith('#')) {
            const versionMatch = line.match(/# Version:\s*(\d+)/);
            if (versionMatch) {
                version = parseInt(versionMatch[1], 10);
            }
            lineNum++;
        }
        else if (line === '') {
            lineNum++;
        }
        else {
            break;
        }
    }
    // Expect "GameData {" or "GameData : \"ref\" {"
    const gameDataLine = lines[lineNum]?.trim();
    const gameDataMatch = gameDataLine?.match(/^GameData\s*(?::\s*"([^"]+)")?\s*\{$/);
    if (!gameDataMatch) {
        throw new Error(`Line ${lineNum + 1}: Expected "GameData {", got "${gameDataLine}"`);
    }
    let gameDataRef;
    if (gameDataMatch[1]) {
        gameDataRef = unescapeString(gameDataMatch[1]);
    }
    lineNum++;
    const { table, endLine } = parseTableContents(lines, lineNum, dict);
    if (gameDataRef) {
        table.reference = gameDataRef;
        // Add $REF entry for consistency if not already present
        if (!table.entries.some(e => e.hash === REF_HASH)) {
            table.entries.unshift({
                hash: REF_HASH,
                name: '$REF',
                type: types_1.RgdDataType.String,
                value: gameDataRef
            });
        }
    }
    return { gameData: table, version };
}
/**
 * Parse table contents from lines
 */
function parseTableContents(lines, startLine, dict) {
    const entries = [];
    let reference;
    let lineNum = startLine;
    while (lineNum < lines.length) {
        const line = lines[lineNum].trim();
        // Skip empty lines
        if (line === '' || line.startsWith('#')) {
            lineNum++;
            continue;
        }
        // End of table
        if (line === '}') {
            break;
        }
        // $REF = "value"
        if (line.startsWith('$REF')) {
            const match = line.match(/\$REF\s*=\s*"(.*)"/);
            if (match) {
                reference = unescapeString(match[1]);
            }
            lineNum++;
            continue;
        }
        // Check for nested table: name { or name : "ref" {
        const tableMatch = line.match(/^(\S+)\s*(?::\s*"([^"]+)")?\s*\{$/);
        if (tableMatch) {
            const name = tableMatch[1];
            const tableRef = tableMatch[2] ? unescapeString(tableMatch[2]) : undefined;
            lineNum++;
            const { table: childTable, endLine } = parseTableContents(lines, lineNum, dict);
            lineNum = endLine + 1;
            if (tableRef) {
                childTable.reference = tableRef;
            }
            const h = (0, hash_1.isHexHash)(name) ? (0, hash_1.hexToHash)(name) : (0, dictionary_1.nameToHash)(dict, name);
            const tableEntry = {
                hash: h,
                name: (0, hash_1.isHexHash)(name) ? (0, dictionary_1.hashToName)(dict, h) ?? name : name,
                type: types_1.RgdDataType.Table,
                value: childTable
            };
            // Add $REF entry to child table if it has a reference
            if (tableRef && !childTable.entries.some(e => e.hash === REF_HASH)) {
                childTable.entries.unshift({
                    hash: REF_HASH,
                    name: '$REF',
                    type: types_1.RgdDataType.String,
                    value: tableRef
                });
            }
            entries.push(tableEntry);
            continue;
        }
        // Parse value: name: type = value
        // Robust matching: everything starting with ' -' is a comment.
        // We use a regex that handles quoted strings that might contain dashes.
        const valueMatch = line.match(/^(\S+)\s*:\s*(\w+)\s*=\s*(.+?)(?:\s+-.*)?$/);
        if (valueMatch) {
            const name = valueMatch[1];
            const typeName = valueMatch[2];
            let valueStr = valueMatch[3].trim();
            // Fix for quoted strings that might contain ' -'
            if (valueStr.startsWith('"') && !valueStr.endsWith('"')) {
                // Re-match greedily for the string content
                const greedyMatch = line.match(/^(\S+)\s*:\s*(\w+)\s*=\s*(".*?")(?:\s+-.*)?$/);
                if (greedyMatch) {
                    valueStr = greedyMatch[3];
                }
            }
            const type = (0, types_1.parseDataType)(typeName);
            const value = parseValue(type, valueStr);
            const h = (0, hash_1.isHexHash)(name) ? (0, hash_1.hexToHash)(name) : (0, dictionary_1.nameToHash)(dict, name);
            entries.push({
                hash: h,
                name: (0, hash_1.isHexHash)(name) ? (0, dictionary_1.hashToName)(dict, h) ?? name : name,
                type,
                value
            });
            lineNum++;
            continue;
        }
        throw new Error(`Line ${lineNum + 1}: Cannot parse line: "${line}"`);
    }
    // Add $REF entry if present
    if (reference) {
        entries.unshift({
            hash: REF_HASH,
            name: '$REF',
            type: types_1.RgdDataType.String,
            value: reference
        });
    }
    return { table: { entries, reference }, endLine: lineNum };
}
/**
 * Parse a value string to the appropriate type
 */
function parseValue(type, valueStr) {
    switch (type) {
        case types_1.RgdDataType.Float:
            return parseFloat(valueStr);
        case types_1.RgdDataType.Integer:
            return parseInt(valueStr, 10);
        case types_1.RgdDataType.Bool:
            return valueStr.toLowerCase() === 'true' || valueStr === '1';
        case types_1.RgdDataType.String:
        case types_1.RgdDataType.WString:
            // Remove quotes
            if (valueStr.startsWith('"') && valueStr.endsWith('"')) {
                return unescapeString(valueStr.slice(1, -1));
            }
            return valueStr;
        default:
            return valueStr;
    }
}
/**
 * Convert RGD table to flat key-value pairs (for CSV export)
 */
function rgdToFlatMap(table, prefix = '') {
    const result = new Map();
    for (const entry of table.entries) {
        if (entry.hash === REF_HASH)
            continue;
        const name = entry.name ?? (0, hash_1.hashToHex)(entry.hash);
        const fullPath = prefix ? `${prefix}.${name}` : name;
        if (entry.type === types_1.RgdDataType.Table || entry.type === types_1.RgdDataType.TableInt) {
            const childMap = rgdToFlatMap(entry.value, fullPath);
            for (const [k, v] of childMap) {
                result.set(k, v);
            }
        }
        else {
            result.set(fullPath, { type: entry.type, value: entry.value });
        }
    }
    return result;
}
/**
 * Convert RGD to CSV format
 */
function rgdToCsv(rgdFile) {
    const flatMap = rgdToFlatMap(rgdFile.gameData);
    const lines = [];
    lines.push('Path,Type,Value');
    for (const [path, { type, value }] of flatMap) {
        const typeName = (0, types_1.dataTypeName)(type);
        let valueStr = String(value);
        // Escape CSV
        if (valueStr.includes(',') || valueStr.includes('"') || valueStr.includes('\n')) {
            valueStr = `"${valueStr.replace(/"/g, '""')}"`;
        }
        lines.push(`${path},${typeName},${valueStr}`);
    }
    return lines.join('\n');
}
/**
 * Parse CSV back to RGD structure
 */
function csvToRgd(csv, dict) {
    const lines = csv.split(/\r?\n/);
    const root = { entries: [] };
    // Skip header
    for (let i = 1; i < lines.length; i++) {
        const line = lines[i].trim();
        if (!line)
            continue;
        // Parse CSV line (simple parser, handles quoted values)
        const parts = parseCSVLine(line);
        if (parts.length < 3)
            continue;
        const [path, typeName, ...valueParts] = parts;
        const valueStr = valueParts.join(',');
        const type = (0, types_1.parseDataType)(typeName);
        const value = parseValue(type, valueStr);
        // Navigate/create path
        const pathParts = path.split('.');
        let currentTable = root;
        for (let j = 0; j < pathParts.length - 1; j++) {
            const part = pathParts[j];
            const h = (0, hash_1.isHexHash)(part) ? (0, hash_1.hexToHash)(part) : (0, dictionary_1.nameToHash)(dict, part);
            let existingEntry = currentTable.entries.find(e => e.hash === h);
            if (!existingEntry) {
                existingEntry = {
                    hash: h,
                    name: part,
                    type: types_1.RgdDataType.Table,
                    value: { entries: [] }
                };
                currentTable.entries.push(existingEntry);
            }
            currentTable = existingEntry.value;
        }
        // Add the leaf entry
        const leafName = pathParts[pathParts.length - 1];
        const leafHash = (0, hash_1.isHexHash)(leafName) ? (0, hash_1.hexToHash)(leafName) : (0, dictionary_1.nameToHash)(dict, leafName);
        // Check if entry exists
        const existingIdx = currentTable.entries.findIndex(e => e.hash === leafHash);
        const entry = {
            hash: leafHash,
            name: leafName,
            type,
            value
        };
        if (existingIdx >= 0) {
            currentTable.entries[existingIdx] = entry;
        }
        else {
            currentTable.entries.push(entry);
        }
    }
    return root;
}
/**
 * Simple CSV line parser
 */
function parseCSVLine(line) {
    const result = [];
    let current = '';
    let inQuotes = false;
    for (let i = 0; i < line.length; i++) {
        const c = line[i];
        if (inQuotes) {
            if (c === '"') {
                if (line[i + 1] === '"') {
                    current += '"';
                    i++;
                }
                else {
                    inQuotes = false;
                }
            }
            else {
                current += c;
            }
        }
        else {
            if (c === '"') {
                inQuotes = true;
            }
            else if (c === ',') {
                result.push(current);
                current = '';
            }
            else {
                current += c;
            }
        }
    }
    result.push(current);
    return result;
}
//# sourceMappingURL=data:application/json;base64,eyJ2ZXJzaW9uIjozLCJmaWxlIjoidGV4dEZvcm1hdC5qcyIsInNvdXJjZVJvb3QiOiIiLCJzb3VyY2VzIjpbIi4uL3NyYy90ZXh0Rm9ybWF0LnRzIl0sIm5hbWVzIjpbXSwibWFwcGluZ3MiOiI7QUFBQTs7Ozs7Ozs7Ozs7Ozs7Ozs7OztHQW1CRzs7QUFXSCw4QkFnQkM7QUFnSEQsd0NBV0M7QUFLRCw4QkFrREM7QUF3SkQsb0NBb0JDO0FBS0QsNEJBbUJDO0FBS0QsNEJBNkRDO0FBamRELG1DQUE2SDtBQUM3SCw2Q0FBc0Q7QUFDdEQsaUNBQStEO0FBRS9ELE1BQU0sUUFBUSxHQUFHLFVBQVUsQ0FBQztBQUU1Qjs7R0FFRztBQUNILFNBQWdCLFNBQVMsQ0FBQyxPQUFnQixFQUFFLFVBQW1CLEVBQUUsU0FBb0M7SUFDN0YsTUFBTSxLQUFLLEdBQWEsRUFBRSxDQUFDO0lBRTNCLEtBQUssQ0FBQyxJQUFJLENBQUMsd0JBQXdCLENBQUMsQ0FBQztJQUNyQyxJQUFJLFVBQVUsRUFBRSxDQUFDO1FBQ1QsS0FBSyxDQUFDLElBQUksQ0FBQyxhQUFhLFVBQVUsRUFBRSxDQUFDLENBQUM7SUFDOUMsQ0FBQztJQUNELEtBQUssQ0FBQyxJQUFJLENBQUMsY0FBYyxPQUFPLENBQUMsTUFBTSxDQUFDLE9BQU8sRUFBRSxDQUFDLENBQUM7SUFDbkQsS0FBSyxDQUFDLElBQUksQ0FBQyxFQUFFLENBQUMsQ0FBQztJQUVmLE1BQU0sTUFBTSxHQUFHLE9BQU8sQ0FBQyxRQUFRLENBQUMsU0FBUyxDQUFDLENBQUMsQ0FBQyxPQUFPLFlBQVksQ0FBQyxPQUFPLENBQUMsUUFBUSxDQUFDLFNBQVMsQ0FBQyxHQUFHLENBQUMsQ0FBQyxDQUFDLEVBQUUsQ0FBQztJQUNwRyxLQUFLLENBQUMsSUFBSSxDQUFDLFdBQVcsTUFBTSxJQUFJLENBQUMsQ0FBQztJQUNsQyxrQkFBa0IsQ0FBQyxLQUFLLEVBQUUsT0FBTyxDQUFDLFFBQVEsRUFBRSxDQUFDLEVBQUUsU0FBUyxDQUFDLENBQUM7SUFDMUQsS0FBSyxDQUFDLElBQUksQ0FB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R0FBRyxFQUFFLENBQUM7Z0JBQ1IsUUFBUSxHQUFHLElBQUksQ0FBQztZQUN4QixDQUFDO2lCQUFNLElBQUksQ0FBQyxLQUFLLEdBQUcsRUFBRSxDQUFDO2dCQUNmLE1BQU0sQ0FBQyxJQUFJLENBQUMsT0FBTyxDQUFDLENBQUM7Z0JBQ3JCLE9BQU8sR0FBRyxFQUFFLENBQUM7WUFDckIsQ0FBQztpQkFBTSxDQUFDO2dCQUNBLE9BQU8sSUFBSSxDQUFDLENBQUM7WUFDckIsQ0FBQztRQUNULENBQUM7SUFDVCxDQUFDO0lBRUQsTUFBTSxDQUFDLElBQUksQ0FBQyxPQUFPLENBQUMsQ0FBQztJQUNyQixPQUFPLE1BQU0sQ0FBQztBQUN0QixDQUFDIiwic291cmNlc0NvbnRlbnQiOlsiLyoqXHJcbiAqIFJHRCBUZXh0IEZvcm1hdCAtIEh1bWFuLXJlYWRhYmxlIGZvcm1hdCBmb3IgZWRpdGluZyBSR0QgZmlsZXNcclxuICpcclxuICogRm9ybWF0OlxyXG4gKiAgICMgUkdEIFRleHQgRm9ybWF0IHYxLjBcclxuICogICAjIFNvdXJjZTogZmlsZW5hbWUucmdkXHJcbiAqXHJcbiAqICAgR2FtZURhdGEge1xyXG4gKiAgICAgJFJFRiA9IFwicGF0aC90by9pbmhlcml0Lmx1YVwiXHJcbiAqICAgICBrZXlfbmFtZTogZmxvYXQgPSAxLjVcclxuICogICAgIGFub3RoZXJfa2V5OiBzdHJpbmcgPSBcInZhbHVlXCJcclxuICogICAgIGJvb2xfa2V5OiBib29sID0gdHJ1ZVxyXG4gKiAgICAgaW50X2tleTogaW50ID0gMTIzNDVcclxuICogICAgIHVuaWNvZGVfa2V5OiB3c3RyaW5nID0gXCJ1bmljb2RlIHZhbHVlXCJcclxuICpcclxuICogICAgIG5lc3RlZF90YWJsZSB7XHJcbiAqICAgICAgIGNoaWxkX2tleTogZmxvYXQgPSAyLjBcclxuICogICAgIH1cclxuICogICB9XHJcbiAqL1xyXG5cclxuaW1wb3J0IHsgUmdkRGF0YVR5cGUsIFJnZEVudHJ5LCBSZ2RUYWJsZSwgUmdkRmlsZSwgSGFzaERpY3Rpb25hcnksIGRhdGFUeXBlTmFtZSwgcGFyc2VEYXRhVHlwZSwgTG9jYWxlRW50cnkgfSBmcm9tICcuL3R5cGVzJztcclxuaW1wb3J0IHsgbmFtZVRvSGFzaCwgaGFzaFRvTmFtZSB9IGZyb20gJy4vZGljdGlvbmFyeSc7XHJcbmltcG9ydCB7IGhhc2hUb0hleCwgaXNIZXhIYXNoLCBoZXhUb0hhc2gsIGhhc2ggfSBmcm9tICcuL2hhc2gnO1xyXG5cclxuY29uc3QgUkVGX0hBU0ggPSAweDQ5RDYwRkFFO1xyXG5cclxuLyoqXHJcbiAqIENvbnZlcnQgUkdEIGZpbGUgdG8gdGV4dCBmb3JtYXRcclxuICovXHJcbmV4cG9ydCBmdW5jdGlvbiByZ2RUb1RleHQocmdkRmlsZTogUmdkRmlsZSwgc291cmNlTmFtZT86IHN0cmluZywgbG9jYWxlTWFwPzogTWFwPHN0cmluZywgTG9jYWxlRW50cnk+KTogc3RyaW5nIHtcclxuICAgICAgICBjb25zdCBsaW5lczogc3RyaW5nW10gPSBbXTtcclxuXHJcbiAgICAgICAgbGluZXMucHVzaCgnIyBSR0QgVGV4dCBGb3JtYXQgdjEuMCcpO1xyXG4gICAgICAgIGlmIChzb3VyY2VOYW1lKSB7XHJcbiAgICAgICAgICAgICAgICBsaW5lcy5wdXNoKGAjIFNvdXJjZTogJHtzb3VyY2VOYW1lfWApO1xyXG4gICAgICAgIH1cclxuICAgICAgICBsaW5lcy5wdXNoKGAjIFZlcnNpb246ICR7cmdkRmlsZS5oZWFkZXIudmVyc2lvbn1gKTtcclxuICAgICAgICBsaW5lcy5wdXNoKCcnKTtcclxuXHJcbiAgICAgICAgY29uc3QgcmVmU3RyID0gcmdkRmlsZS5nYW1lRGF0YS5yZWZlcmVuY2UgPyBgIDogXCIke2VzY2FwZVN0cmluZyhyZ2RGaWxlLmdhbWVEYXRhLnJlZmVyZW5jZSl9XCJgIDogJyc7XHJcbiAgICAgICAgbGluZXMucHVzaChgR2FtZURhdGEke3JlZlN0cn0ge2ApO1xyXG4gICAgICAgIHdyaXRlVGFibGVDb250ZW50cyhsaW5lcywgcmdkRmlsZS5nYW1lRGF0YSwgMSwgbG9jYWxlTWFwKTtcclxuICAgICAgICBsaW5lcy5wdXNoKCd9Jyk7XHJcblxyXG4gICAgICAgIHJldHVybiBsaW5lcy5qb2luKCdcXG4nKTtcclxufVxyXG5cclxuLyoqXHJcbiAqIFdyaXRlIHRhYmxlIGNvbnRlbnRzIHdpdGggaW5kZW50YXRpb25cclxuICovXHJcbmZ1bmN0aW9uIHdyaXRlVGFibGVDb250ZW50cyhsaW5lczogc3RyaW5nW10sIHRhYmxlOiBSZ2RUYWJsZSwgaW5kZW50OiBudW1iZXIsIGxvY2FsZU1hcD86IE1hcDxzdHJpbmcsIExvY2FsZUVudHJ5Pik6IHZvaWQge1xyXG4gICAgICAgIGNvbnN0IHByZWZpeCA9ICcgICcucmVwZWF0KGluZGVudCk7XHJcblxyXG4gICAgICAgIC8vIFNvcnQgZW50cmllczogdGFibGVzIGxhc3QsIG90aGVycyBhbHBoYWJldGljYWxseVxyXG4gICAgICAgIGNvbnN0IHNvcnRlZCA9IFsuLi50YWJsZS5lbnRyaWVzXS5zb3J0KChhLCBiKSA9PiB7XHJcbiAgICAgICAgICAgICAgICBjb25zdCBhSXNUYWJsZSA9IGEudHlwZSA9PT0gUmdkRGF0YVR5cGUuVGFibGUgfHwgYS50eXBlID09PSBSZ2REYXRhVHlwZS5UYWJsZUludDtcclxuICAgICAgICAgICAgICAgIGNvbnN0IGJJc1RhYmxlID0gYi50eXBlID09PSBSZ2REYXRhVHlwZS5UYWJsZSB8fCBiLnR5cGUgPT09IFJnZERhdGFUeXBlLlRhYmxlSW50O1xyXG4gICAgICAgICAgICAgICAgaWYgKGFJc1RhYmxlICE9PSBiSXNUYWJsZSkgcmV0dXJuIGFJc1RhYmxlID8gMSA6IC0xO1xyXG5cclxuICAgICAgICAgICAgICAgIC8vIFNraXAgJFJFRiBlbnRyaWVzIGluIHNvcnRpbmcgKHRoZXkgZ28gZmlyc3QpXHJcbiAgICAgICAgICAgICAgICBpZiAoYS5oYXNoID09PSBSRUZfSEFTSCkgcmV0dXJuIC0xO1xyXG4gICAgICAgICAgICAgICAgaWYgKGIuaGFzaCA9PT0gUkVGX0hBU0gpIHJldHVybiAxO1xyXG5cclxuICAgICAgICAgICAgICAgIGNvbnN0IGFOYW1lID0gYS5uYW1lID8/IGhhc2hUb0hleChhLmhhc2gpO1xyXG4gICAgICAgICAgICAgICAgY29uc3QgYk5hbWUgPSBiLm5hbWUgPz8gaGFzaFRvSGV4KGIuaGFzaCk7XHJcbiAgICAgICAgICAgICAgICByZXR1cm4gYU5hbWUubG9jYWxlQ29tcGFyZShiTmFtZSk7XHJcbiAgICAgICAgfSk7XHJcblxyXG4gICAgICAgIGZvciAoY29uc3QgZW50cnkgb2Ygc29ydGVkKSB7XHJcbiAgICAgICAgICAgICAgICAvLyBTa2lwICRSRUYgZW50cmllcyAoaGFuZGxlZCBhYm92ZSlcclxuICAgICAgICAgICAgICAgIGlmIChlbnRyeS5oYXNoID09PSBSRUZfSEFTSCkgY29udGludWU7XHJcblxyXG4gICAgICAgICAgICAgICAgY29uc3QgbmFtZSA9IGVudHJ5Lm5hbWUgPz8gaGFzaFRvSGV4KGVudHJ5Lmhhc2gpO1xyXG5cclxuICAgICAgICAgICAgICAgIGlmIChlbnRyeS50eXBlID09PSBSZ2REYXRhVHlwZS5UYWJsZSB8fCBlbnRyeS50eXBlID09PSBSZ2REYXRhVHlwZS5UYWJsZUludCkge1xyXG4gICAgICAgICAgICAgICAgICAgICAgICAvLyBOZXN0ZWQgdGFibGVcclxuICAgICAgICAgICAgICAgICAgICAgICAgY29uc3QgdGFibGVWYWx1ZSA9IGVudHJ5LnZhbHVlIGFzIFJnZFRhYmxlO1xyXG4gICAgICAgICAgICAgICAgICAgICAgICBsaW5lcy5wdXNoKCcnKTtcclxuXHJcbiAgICAgICAgICAgICAgICAgICAgICAgIGlmICh0YWJsZVZhbHVlLnJlZmVyZW5jZSkge1xyXG4gICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgIGxpbmVzLnB1c2goYCR7cHJlZml4fSR7bmFtZX0gOiBcIiR7ZXNjYXBlU3RyaW5nKHRhYmxlVmFsdWUucmVmZXJlbmNlKX1cIiB7YCk7XHJcbiAgICAgICAgICAgICAgICAgICAgICAgIH0gZWxzZSB7XHJcbiAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgbGluZXMucHVzaChgJHtwcmVmaXh9JHtuYW1lfSB7YCk7XHJcbiAgICAgICAgICAgICAgICAgICAgICAgIH1cclxuXHJcbiAgICAgICAgICAgICAgICAgICAgICAgIHdyaXRlVGFibGVDb250ZW50cyhsaW5lcywgdGFibGVWYWx1ZSwgaW5kZW50ICsgMSwgbG9jYWxlTWFwKTtcclxuICAgICAgICAgICAgICAgICAgICAgICAgbGluZXMucHVzaChgJHtwcmVmaXh9fWApO1xyXG4gICAgICAgICAgICAgICAgfSBlbHNlIHtcclxuICAgICAgICAgICAgICAgICAgICAgICAgLy8gU2ltcGxlIHZhbHVlXHJcbiAgICAgICAgICAgICAgICAgICAgICAgIGNvbnN0IHR5cGVOYW1lID0gZGF0YVR5cGVOYW1lKGVudHJ5LnR5cGUpO1xyXG4gICAgICAgICAgICAgICAgICAgICAgICBjb25zdCB2YWx1ZVN0ciA9IGZvcm1hdFZhbHVlKGVudHJ5LnR5cGUsIGVudHJ5LnZhbHVlKTtcclxuXHJcbiAgICAgICAgICAgICAgICAgICAgICAgIGxldCBjb21tZW50ID0gJyc7XHJcbiAgICAgICAgICAgICAgICAgICAgICAgIGlmIChlbnRyeS50eXBlID09PSBSZ2REYXRhVHlwZS5XU3RyaW5nIHx8IGVudHJ5LnR5cGUgPT09IFJnZERhdGFUeXBlLlN0cmluZykge1xyXG4gICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgIGNvbnN0IHZhbCA9IGVudHJ5LnZhbHVlIGFzIHN0cmluZztcclxuICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICBpZiAodmFsLnN0YXJ0c1dpdGgoJyQnKSAmJiBsb2NhbGVNYXApIHtcclxuICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgIGNvbnN0IGxvY0VudHJ5ID0gbG9jYWxlTWFwLmdldCh2YWwpO1xyXG4gICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgaWYgKGxvY0VudHJ5KSB7XHJcbiAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgIGNvbW1lbnQgPSBgIC0gJHtsb2NFbnRyeS50ZXh0fWA7XHJcbiAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICB9IGVsc2Uge1xyXG4gICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAvLyBGYWxsYmFjazogdHJ5IHdpdGhvdXQgdGhlICQgaWYgdGhlIG1hcCBrZXlzIGRvbid0IGhhdmUgaXRcclxuICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgY29uc3QgbG9jRW50cnlOb0lkID0gbG9jYWxlTWFwLmdldCh2YWwuc3Vic3RyaW5nKDEpKTtcclxuICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgaWYgKGxvY0VudHJ5Tm9JZCkge1xyXG4gICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgIGNvbW1lbnQgPSBgIC0gJHtsb2NFbnRyeU5vSWQudGV4dH1gO1xyXG4gICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICB9XHJcbiAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICB9XHJcbiAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgfVxyXG4gICAgICAgICAgICAgICAgICAgICAgICB9XHJcblxyXG4gICAgICAgICAgICAgICAgICAgICAgICBsaW5lcy5wdXNoKGAke3ByZWZpeH0ke25hbWV9OiAke3R5cGVOYW1lfSA9ICR7dmFsdWVTdHJ9JHtjb21tZW50fWApO1xyXG4gICAgICAgICAgICAgICAgfVxyXG4gICAgICAgIH1cclxufVxyXG5cclxuLyoqXHJcbiAqIEZvcm1hdCBhIHZhbHVlIGZvciB0ZXh0IG91dHB1dFxyXG4gKi9cclxuZnVuY3Rpb24gZm9ybWF0VmFsdWUodHlwZTogUmdkRGF0YVR5cGUsIHZhbHVlOiBhbnkpOiBzdHJpbmcge1xyXG4gICAgICAgIHN3aXRjaCAodHlwZSkge1xyXG4gICAgICAgICAgICAgICAgY2FzZSBSZ2REYXRhVHlwZS5GbG9hdDpcclxuICAgICAgICAgICAgICAgICAgICAgICAgLy8gRm9ybWF0IGZsb2F0IHdpdGggYXBwcm9wcmlhdGUgcHJlY2lzaW9uXHJcbiAgICAgICAgICAgICAgICAgICAgICAgIGNvbnN0IGYgPSB2YWx1ZSBhcyBudW1iZXI7XHJcbiAgICAgICAgICAgICAgICAgICAgICAgIGlmIChOdW1iZXIuaXNJbnRlZ2VyKGYpKSB7XHJcbiAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgcmV0dXJuIGYudG9GaXhlZCgxKTtcclxuICAgICAgICAgICAgICAgICAgICAgICAgfVxyXG4gICAgICAgICAgICAgICAgICAgICAgICByZXR1cm4gZi50b1N0cmluZygpO1xyXG5cclxuICAgICAgICAgICAgICAgIGNhc2UgUmdkRGF0YVR5cGUuSW50ZWdlcjpcclxuICAgICAgICAgICAgICAgICAgICAgICAgcmV0dXJuICh2YWx1ZSBhcyBudW1iZXIpLnRvU3RyaW5nKCk7XHJcblxyXG4gICAgICAgICAgICAgICAgY2FzZSBSZ2REYXRhVHlwZS5Cb29sOlxyXG4gICAgICAgICAgICAgICAgICAgICAgICByZXR1cm4gdmFsdWUgPyAndHJ1ZScgOiAnZmFsc2UnO1xyXG5cclxuICAgICAgICAgICAgICAgIGNhc2UgUmdkRGF0YVR5cGUuU3RyaW5nOlxyXG4gICAgICAgICAgICAgICAgY2FzZSBSZ2REYXRhVHlwZS5XU3RyaW5nOlxyXG4gICAgICAgICAgICAgICAgICAgICAgICByZXR1cm4gYFwiJHtlc2NhcGVTdHJpbmcodmFsdWUgYXMgc3RyaW5nKX1cImA7XHJcblxyXG4gICAgICAgICAgICAgICAgZGVmYXVsdDpcclxuICAgICAgICAgICAgICAgICAgICAgICAgcmV0dXJuIFN0cmluZyh2YWx1ZSk7XHJcbiAgICAgICAgfVxyXG59XHJcblxyXG4vKipcclxuICogRXNjYXBlIHN0cmluZyBmb3IgdGV4dCBmb3JtYXRcclxuICovXHJcbmZ1bmN0aW9uIGVzY2FwZVN0cmluZyhzdHI6IHN0cmluZyk6IHN0cmluZyB7XHJcbiAgICAgICAgcmV0dXJuIHN0clxyXG4gICAgICAgICAgICAgICAgLnJlcGxhY2UoL1xcXFwvZywgJ1xcXFxcXFxcJylcclxuICAgICAgICAgICAgICAgIC5yZXBsYWNlKC9cIi9nLCAnXFxcXFwiJylcclxuICAgICAgICAgICAgICAgIC5yZXBsYWNlKC9cXG4vZywgJ1xcXFxuJylcclxuICAgICAgICAgICAgICAgIC5yZXBsYWNlKC9cXHIvZywgJ1xcXFxyJylcclxuICAgICAgICAgICAgICAgIC5yZXBsYWNlKC9cXHQvZywgJ1xcXFx0Jyk7XHJcbn1cclxuXHJcbi8qKlxyXG4gKiBVbmVzY2FwZSBzdHJpbmcgZnJvbSB0ZXh0IGZvcm1hdFxyXG4gKi9cclxuZXhwb3J0IGZ1bmN0aW9uIHVuZXNjYXBlU3RyaW5nKHN0cjogc3RyaW5nKTogc3RyaW5nIHtcclxuICAgICAgICByZXR1cm4gc3RyLnJlcGxhY2UoL1xcXFwoLikvZywgKG1hdGNoLCBjaGFyKSA9PiB7XHJcbiAgICAgICAgICAgICAgICBzd2l0Y2ggKGNoYXIpIHtcclxuICAgICAgICAgICAgICAgICAgICAgICAgY2FzZSAnbic6IHJldHVybiAnXFxuJztcclxuICAgICAgICAgICAgICAgICAgICAgICAgY2FzZSAncic6IHJldHVybiAnXFxyJztcclxuICAgICAgICAgICAgICAgICAgICAgICAgY2FzZSAndCc6IHJldHVybiAnXFx0JztcclxuICAgICAgICAgICAgICAgICAgICAgICAgY2FzZSAnXCInOiByZXR1cm4gJ1wiJztcclxuICAgICAgICAgICAgICAgICAgICAgICAgY2FzZSAnXFxcXCc6IHJldHVybiAnXFxcXCc7XHJcbiAgICAgICAgICAgICAgICAgICAgICAgIGRlZmF1bHQ6IHJldHVybiBtYXRjaDtcclxuICAgICAgICAgICAgICAgIH1cclxuICAgICAgICB9KTtcclxufVxyXG5cclxuLyoqXHJcbiAqIFBhcnNlIHRleHQgZm9ybWF0IGJhY2sgdG8gUkdEIHN0cnVjdHVyZVxyXG4gKi9cclxuZXhwb3J0IGZ1bmN0aW9uIHRleHRUb1JnZCh0ZXh0OiBzdHJpbmcsIGRpY3Q6IEhhc2hEaWN0aW9uYXJ5KTogeyBnYW1lRGF0YTogUmdkVGFibGU7IHZlcnNpb246IG51bWJlciB9IHtcclxuICAgICAgICBjb25zdCBsaW5lcyA9IHRleHQuc3BsaXQoL1xccj9cXG4vKTtcclxuICAgICAgICBsZXQgdmVyc2lvbiA9IDE7XHJcbiAgICAgICAgbGV0IGxpbmVOdW0gPSAwO1xyXG5cclxuICAgICAgICAvLyBQYXJzZSBoZWFkZXIgY29tbWVudHNcclxuICAgICAgICB3aGlsZSAobGluZU51bSA8IGxpbmVzLmxlbmd0aCkge1xyXG4gICAgICAgICAgICAgICAgY29uc3QgbGluZSA9IGxpbmVzW2xpbmVOdW1dLnRyaW0oKTtcclxuICAgICAgICAgICAgICAgIGlmIChsaW5lLnN0YXJ0c1dpdGgoJyMnKSkge1xyXG4gICAgICAgICAgICAgICAgICAgICAgICBjb25zdCB2ZXJzaW9uTWF0Y2ggPSBsaW5lLm1hdGNoKC8jIFZlcnNpb246XFxzKihcXGQrKS8pO1xyXG4gICAgICAgICAgICAgICAgICAgICAgICBpZiAodmVyc2lvbk1hdGNoKSB7XHJcbiAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgdmVyc2lvbiA9IHBhcnNlSW50KHZlcnNpb25NYXRjaFsxXSwgMTApO1xyXG4gICAgICAgICAgICAgICAgICAgICAgICB9XHJcbiAgICAgICAgICAgICAgICAgICAgICAgIGxpbmVOdW0rKztcclxuICAgICAgICAgICAgICAgIH0gZWxzZSBpZiAobGluZSA9PT0gJycpIHtcclxuICAgICAgICAgICAgICAgICAgICAgICAgbGluZU51bSsrO1xyXG4gICAgICAgICAgICAgICAgfSBlbHNlIHtcclxuICAgICAgICAgICAgICAgICAgICAgICAgYnJlYWs7XHJcbiAgICAgICAgICAgICAgICB9XHJcbiAgICAgICAgfVxyXG5cclxuICAgICAgICAvLyBFeHBlY3QgXCJHYW1lRGF0YSB7XCIgb3IgXCJHYW1lRGF0YSA6IFxcXCJyZWZcXFwiIHtcIlxyXG4gICAgICAgIGNvbnN0IGdhbWVEYXRhTGluZSA9IGxpbmVzW2xpbmVOdW1dPy50cmltKCk7XHJcbiAgICAgICAgY29uc3QgZ2FtZURhdGFNYXRjaCA9IGdhbWVEYXRhTGluZT8ubWF0Y2goL15HYW1lRGF0YVxccyooPzo6XFxzKlwiKFteXCJdKylcIik/XFxzKlxceyQvKTtcclxuICAgICAgICBpZiAoIWdhbWVEYXRhTWF0Y2gpIHtcclxuICAgICAgICAgICAgICAgIHRocm93IG5ldyBFcnJvcihgTGluZSAke2xpbmVOdW0gKyAxfTogRXhwZWN0ZWQgXCJHYW1lRGF0YSB7XCIsIGdvdCBcIiR7Z2FtZURhdGFMaW5lfVwiYCk7XHJcbiAgICAgICAgfVxyXG5cclxuICAgICAgICBsZXQgZ2FtZURhdGFSZWY6IHN0cmluZyB8IHVuZGVmaW5lZDtcclxuICAgICAgICBpZiAoZ2FtZURhdGFNYXRjaFsxXSkge1xyXG4gICAgICAgICAgICAgICAgZ2FtZURhdGFSZWYgPSB1bmVzY2FwZVN0cmluZyhnYW1lRGF0YU1hdGNoWzFdKTtcclxuICAgICAgICB9XHJcblxyXG4gICAgICAgIGxpbmVOdW0rKztcclxuXHJcbiAgICAgICAgY29uc3QgeyB0YWJsZSwgZW5kTGluZSB9ID0gcGFyc2VUYWJsZUNvbnRlbnRzKGxpbmVzLCBsaW5lTnVtLCBkaWN0KTtcclxuICAgICAgICBpZiAoZ2FtZURhdGFSZWYpIHtcclxuICAgICAgICAgICAgICAgIHRhYmxlLnJlZmVyZW5jZSA9IGdhbWVEYXRhUmVmO1xyXG4gICAgICAgICAgICAgICAgLy8gQWRkICRSRUYgZW50cnkgZm9yIGNvbnNpc3RlbmN5IGlmIG5vdCBhbHJlYWR5IHByZXNlbnRcclxuICAgICAgICAgICAgICAgIGlmICghdGFibGUuZW50cmllcy5zb21lKGUgPT4gZS5oYXNoID09PSBSRUZfSEFTSCkpIHtcclxuICAgICAgICAgICAgICAgICAgICAgICAgdGFibGUuZW50cmllcy51bnNoaWZ0KHtcclxuICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICBoYXNoOiBSRUZfSEFTSCxcclxuICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICBuYW1lOiAnJFJFRicsXHJcbiAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgdHlwZTogUmdkRGF0YVR5cGUuU3RyaW5nLFxyXG4gICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgIHZhbHVlOiBnYW1lRGF0YVJlZlxyXG4gICAgICAgICAgICAgICAgICAgICAgICB9KTtcclxuICAgICAgICAgICAgICAgIH1cclxuICAgICAgICB9XHJcblxyXG4gICAgICAgIHJldHVybiB7IGdhbWVEYXRhOiB0YWJsZSwgdmVyc2lvbiB9O1xyXG59XHJcblxyXG4vKipcclxuICogUGFyc2UgdGFibGUgY29udGVudHMgZnJvbSBsaW5lc1xyXG4gKi9cclxuZnVuY3Rpb24gcGFyc2VUYWJsZUNvbnRlbnRzKFxyXG4gICAgICAgIGxpbmVzOiBzdHJpbmdbXSxcclxuICAgICAgICBzdGFydExpbmU6IG51bWJlcixcclxuICAgICAgICBkaWN0OiBIYXNoRGljdGlvbmFyeVxyXG4pOiB7IHRhYmxlOiBSZ2RUYWJsZTsgZW5kTGluZTogbnVtYmVyIH0ge1xyXG4gICAgICAgIGNvbnN0IGVudHJpZXM6IFJnZEVudHJ5W10gPSBbXTtcclxuICAgICAgICBsZXQgcmVmZXJlbmNlOiBzdHJpbmcgfCB1bmRlZmluZWQ7XHJcbiAgICAgICAgbGV0IGxpbmVOdW0gPSBzdGFydExpbmU7XHJcblxyXG4gICAgICAgIHdoaWxlIChsaW5lTnVtIDwgbGluZXMubGVuZ3RoKSB7XHJcbiAgICAgICAgICAgICAgICBjb25zdCBsaW5lID0gbGluZXNbbGluZU51bV0udHJpbSgpO1xyXG5cclxuICAgICAgICAgICAgICAgIC8vIFNraXAgZW1wdHkgbGluZXNcclxuICAgICAgICAgICAgICAgIGlmIChsaW5lID09PSAnJyB8fCBsaW5lLnN0YXJ0c1dpdGgoJyMnKSkge1xyXG4gICAgICAgICAgICAgICAgICAgICAgICBsaW5lTnVtKys7XHJcbiAgICAgICAgICAgICAgICAgICAgICAgIGNvbnRpbnVlO1xyXG4gICAgICAgICAgICAgICAgfVxyXG5cclxuICAgICAgICAgICAgICAgIC8vIEVuZCBvZiB0YWJsZVxyXG4gICAgICAgICAgICAgICAgaWYgKGxpbmUgPT09ICd9Jykge1xyXG4gICAgICAgICAgICAgICAgICAgICAgICBicmVhaztcclxuICAgICAgICAgICAgICAgIH1cclxuXHJcbiAgICAgICAgICAgICAgICAvLyAkUkVGID0gXCJ2YWx1ZVwiXHJcbiAgICAgICAgICAgICAgICBpZiAobGluZS5zdGFydHNXaXRoKCckUkVGJykpIHtcclxuICAgICAgICAgICAgICAgICAgICAgICAgY29uc3QgbWF0Y2ggPSBsaW5lLm1hdGNoKC9cXCRSRUZcXHMqPVxccypcIiguKilcIi8pO1xyXG4gICAgICAgICAgICAgICAgICAgICAgICBpZiAobWF0Y2gpIHtcclxuICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICByZWZlcmVuY2UgPSB1bmVzY2FwZVN0cmluZyhtYXRjaFsxXSk7XHJcbiAgICAgICAgICAgICAgICAgICAgICAgIH1cclxuICAgICAgICAgICAgICAgICAgICAgICAgbGluZU51bSsrO1xyXG4gICAgICAgICAgICAgICAgICAgICAgICBjb250aW51ZTtcclxuICAgICAgICAgICAgICAgIH1cclxuXHJcbiAgICAgICAgICAgICAgICAvLyBDaGVjayBmb3IgbmVzdGVkIHRhYmxlOiBuYW1lIHsgb3IgbmFtZSA6IFwicmVmXCIge1xyXG4gICAgICAgICAgICAgICAgY29uc3QgdGFibGVNYXRjaCA9IGxpbmUubWF0Y2goL14oXFxTKylcXHMqKD86OlxccypcIihbXlwiXSspXCIpP1xccypcXHskLyk7XHJcbiAgICAgICAgICAgICAgICBpZiAodGFibGVNYXRjaCkge1xyXG4gICAgICAgICAgICAgICAgICAgICAgICBjb25zdCBuYW1lID0gdGFibGVNYXRjaFsxXTtcclxuICAgICAgICAgICAgICAgICAgICAgICAgY29uc3QgdGFibGVSZWYgPSB0YWJsZU1hdGNoWzJdID8gdW5lc2NhcGVTdHJpbmcodGFibGVNYXRjaFsyXSkgOiB1bmRlZmluZWQ7XHJcblxyXG4gICAgICAgICAgICAgICAgICAgICAgICBsaW5lTnVtKys7XHJcbiAgICAgICAgICAgICAgICAgICAgICAgIGNvbnN0IHsgdGFibGU6IGNoaWxkVGFibGUsIGVuZExpbmUgfSA9IHBhcnNlVGFibGVDb250ZW50cyhsaW5lcywgbGluZU51bSwgZGljdCk7XHJcbiAgICAgICAgICAgICAgICAgICAgICAgIGxpbmVOdW0gPSBlbmRMaW5lICsgMTtcclxuXHJcbiAgICAgICAgICAgICAgICAgICAgICAgIGlmICh0YWJsZVJlZikge1xyXG4gICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgIGNoaWxkVGFibGUucmVmZXJlbmNlID0gdGFibGVSZWY7XHJcbiAgICAgICAgICAgICAgICAgICAgICAgIH1cclxuXHJcbiAgICAgICAgICAgICAgICAgICAgICAgIGNvbnN0IGggPSBpc0hleEhhc2gobmFtZSkgPyBoZXhUb0hhc2gobmFtZSkgOiBuYW1lVG9IYXNoKGRpY3QsIG5hbWUpO1xyXG4gICAgICAgICAgICAgICAgICAgICAgICBjb25zdCB0YWJsZUVudHJ5OiBSZ2RFbnRyeSA9IHtcclxuICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICBoYXNoOiBoLFxyXG4gICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgIG5hbWU6IGlzSGV4SGFzaChuYW1lKSA/IGhhc2hUb05hbWUoZGljdCwgaCkgPz8gbmFtZSA6IG5hbWUsXHJcbiAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgdHlwZTogUmdkRGF0YVR5cGUuVGFibGUsXHJcbiAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgdmFsdWU6IGNoaWxkVGFibGVcclxuICAgICAgICAgICAgICAgICAgICAgICAgfTtcclxuXHJcbiAgICAgICAgICAgICAgICAgICAgICAgIC8vIEFkZCAkUkVGIGVudHJ5IHRvIGNoaWxkIHRhYmxlIGlmIGl0IGhhcyBhIHJlZmVyZW5jZVxyXG4gICAgICAgICAgICAgICAgICAgICAgICBpZiAodGFibGVSZWYgJiYgIWNoaWxkVGFibGUuZW50cmllcy5zb21lKGUgPT4gZS5oYXNoID09PSBSRUZfSEFTSCkpIHtcclxuICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICBjaGlsZFRhYmxlLmVudHJpZXMudW5zaGlmdCh7XHJcbiAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICBoYXNoOiBSRUZfSEFTSCxcclxuICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgIG5hbWU6ICckUkVGJyxcclxuICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgIHR5cGU6IFJnZERhdGFUeXBlLlN0cmluZyxcclxuICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgIHZhbHVlOiB0YWJsZVJlZlxyXG4gICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgIH0pO1xyXG4gICAgICAgICAgICAgICAgICAgICAgICB9XHJcblxyXG4gICAgICAgICAgICAgICAgICAgICAgICBlbnRyaWVzLnB1c2godGFibGVFbnRyeSk7XHJcbiAgICAgICAgICAgICAgICAgICAgICAgIGNvbnRpbnVlO1xyXG4gICAgICAgICAgICAgICAgfVxyXG5cclxuICAgICAgICAgICAgICAgIC8vIFBhcnNlIHZhbHVlOiBuYW1lOiB0eXBlID0gdmFsdWVcclxuICAgICAgICAgICAgICAgIC8vIFJvYnVzdCBtYXRjaGluZzogZXZlcnl0aGluZyBzdGFydGluZyB3aXRoICcgLScgaXMgYSBjb21tZW50LlxyXG4gICAgICAgICAgICAgICAgLy8gV2UgdXNlIGEgcmVnZXggdGhhdCBoYW5kbGVzIHF1b3RlZCBzdHJpbmdzIHRoYXQgbWlnaHQgY29udGFpbiBkYXNoZXMuXHJcbiAgICAgICAgICAgICAgICBjb25zdCB2YWx1ZU1hdGNoID0gbGluZS5tYXRjaCgvXihcXFMrKVxccyo6XFxzKihcXHcrKVxccyo9XFxzKiguKz8pKD86XFxzKy0uKik/JC8pO1xyXG4gICAgICAgICAgICAgICAgaWYgKHZhbHVlTWF0Y2gpIHtcclxuICAgICAgICAgICAgICAgICAgICAgICAgY29uc3QgbmFtZSA9IHZhbHVlTWF0Y2hbMV07XHJcbiAgICAgICAgICAgICAgICAgICAgICAgIGNvbnN0IHR5cGVOYW1lID0gdmFsdWVNYXRjaFsyXTtcclxuICAgICAgICAgICAgICAgICAgICAgICAgbGV0IHZhbHVlU3RyID0gdmFsdWVNYXRjaFszXS50cmltKCk7XHJcblxyXG4gICAgICAgICAgICAgICAgICAgICAgICAvLyBGaXggZm9yIHF1b3RlZCBzdHJpbmdzIHRoYXQgbWlnaHQgY29udGFpbiAnIC0nXHJcbiAgICAgICAgICAgICAgICAgICAgICAgIGlmICh2YWx1ZVN0ci5zdGFydHNXaXRoKCdcIicpICYmICF2YWx1ZVN0ci5lbmRzV2l0aCgnXCInKSkge1xyXG4gICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgIC8vIFJlLW1hdGNoIGdyZWVkaWx5IGZvciB0aGUgc3RyaW5nIGNvbnRlbnRcclxuICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICBjb25zdCBncmVlZHlNYXRjaCA9IGxpbmUubWF0Y2goL14oXFxTKylcXHMqOlxccyooXFx3KylcXHMqPVxccyooXCIuKj9cIikoPzpcXHMrLS4qKT8kLyk7XHJcbiAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgaWYgKGdyZWVkeU1hdGNoKSB7XHJcbiAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICB2YWx1ZVN0ciA9IGdyZWVkeU1hdGNoWzNdO1xyXG4gICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgIH1cclxuICAgICAgICAgICAgICAgICAgICAgICAgfVxyXG5cclxuICAgICAgICAgICAgICAgICAgICAgICAgY29uc3QgdHlwZSA9IHBhcnNlRGF0YVR5cGUodHlwZU5hbWUpO1xyXG4gICAgICAgICAgICAgICAgICAgICAgICBjb25zdCB2YWx1ZSA9IHBhcnNlVmFsdWUodHlwZSwgdmFsdWVTdHIpO1xyXG5cclxuICAgICAgICAgICAgICAgICAgICAgICAgY29uc3QgaCA9IGlzSGV4SGFzaChuYW1lKSA/IGhleFRvSGFzaChuYW1lKSA6IG5hbWVUb0hhc2goZGljdCwgbmFtZSk7XHJcbiAgICAgICAgICAgICAgICAgICAgICAgIGVudHJpZXMucHVzaCh7XHJcbiAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgaGFzaDogaCxcclxuICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICBuYW1lOiBpc0hleEhhc2gobmFtZSkgPyBoYXNoVG9OYW1lKGRpY3QsIGgpID8/IG5hbWUgOiBuYW1lLFxyXG4gICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgIHR5cGUsXHJcbiAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgdmFsdWVcclxuICAgICAgICAgICAgICAgICAgICAgICAgfSk7XHJcbiAgICAgICAgICAgICAgICAgICAgICAgIGxpbmVOdW0rKztcclxuICAgICAgICAgICAgICAgICAgICAgICAgY29udGludWU7XHJcbiAgICAgICAgICAgICAgICB9XHJcblxyXG4gICAgICAgICAgICAgICAgdGhyb3cgbmV3IEVycm9yKGBMaW5lICR7bGluZU51bSArIDF9OiBDYW5ub3QgcGFyc2UgbGluZTogXCIke2xpbmV9XCJgKTtcclxuICAgICAgICB9XHJcblxyXG4gICAgICAgIC8vIEFkZCAkUkVGIGVudHJ5IGlmIHByZXNlbnRcclxuICAgICAgICBpZiAocmVmZXJlbmNlKSB7XHJcbiAgICAgICAgICAgICAgICBlbnRyaWVzLnVuc2hpZnQoe1xyXG4gICAgICAgICAgICAgICAgICAgICAgICBoYXNoOiBSRUZfSEFTSCxcclxuICAgICAgICAgICAgICAgICAgICAgICAgbmFtZTogJyRSRUYnLFxyXG4gICAgICAgICAgICAgICAgICAgICAgICB0eXBlOiBSZ2REYXRhVHlwZS5TdHJpbmcsXHJcbiAgICAgICAgICAgICAgICAgICAgICAgIHZhbHVlOiByZWZlcmVuY2VcclxuICAgICAgICAgICAgICAgIH0pO1xyXG4gICAgICAgIH1cclxuXHJcbiAgICAgICAgcmV0dXJuIHsgdGFibGU6IHsgZW50cmllcywgcmVmZXJlbmNlIH0sIGVuZExpbmU6IGxpbmVOdW0gfTtcclxufVxyXG5cclxuLyoqXHJcbiAqIFBhcnNlIGEgdmFsdWUgc3RyaW5nIHRvIHRoZSBhcHByb3ByaWF0ZSB0eXBlXHJcbiAqL1xyXG5mdW5jdGlvbiBwYXJzZVZhbHVlKHR5cGU6IFJnZERhdGFUeXBlLCB2YWx1ZVN0cjogc3RyaW5nKTogYW55IHtcclxuICAgICAgICBzd2l0Y2ggKHR5cGUpIHtcclxuICAgICAgICAgICAgICAgIGNhc2UgUmdkRGF0YVR5cGUuRmxvYXQ6XHJcbiAgICAgICAgICAgICAgICAgICAgICAgIHJldHVybiBwYXJzZUZsb2F0KHZhbHVlU3RyKTtcclxuXHJcbiAgICAgICAgICAgICAgICBjYXNlIFJnZERhdGFUeXBlLkludGVnZXI6XHJcbiAgICAgICAgICAgICAgICAgICAgICAgIHJldHVybiBwYXJzZUludCh2YWx1ZVN0ciwgMTApO1xyXG5cclxuICAgICAgICAgICAgICAgIGNhc2UgUmdkRGF0YVR5cGUuQm9vbDpcclxuICAgICAgICAgICAgICAgICAgICAgICAgcmV0dXJuIHZhbHVlU3RyLnRvTG93ZXJDYXNlKCkgPT09ICd0cnVlJyB8fCB2YWx1ZVN0ciA9PT0gJzEnO1xyXG5cclxuICAgICAgICAgICAgICAgIGNhc2UgUmdkRGF0YVR5cGUuU3RyaW5nOlxyXG4gICAgICAgICAgICAgICAgY2FzZSBSZ2REYXRhVHlwZS5XU3RyaW5nOlxyXG4gICAgICAgICAgICAgICAgICAgICAgICAvLyBSZW1vdmUgcXVvdGVzXHJcbiAgICAgICAgICAgICAgICAgICAgICAgIGlmICh2YWx1ZVN0ci5zdGFydHNXaXRoKCdcIicpICYmIHZhbHVlU3RyLmVuZHNXaXRoKCdcIicpKSB7XHJcbiAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgcmV0dXJuIHVuZXNjYXBlU3RyaW5nKHZhbHVlU3RyLnNsaWNlKDEsIC0xKSk7XHJcbiAgICAgICAgICAgICAgICAgICAgICAgIH1cclxuICAgICAgICAgICAgICAgICAgICAgICAgcmV0dXJuIHZhbHVlU3RyO1xyXG5cclxuICAgICAgICAgICAgICAgIGRlZmF1bHQ6XHJcbiAgICAgICAgICAgICAgICAgICAgICAgIHJldHVybiB2YWx1ZVN0cjtcclxuICAgICAgICB9XHJcbn1cclxuXHJcbi8qKlxyXG4gKiBDb252ZXJ0IFJHRCB0YWJsZSB0byBmbGF0IGtleS12YWx1ZSBwYWlycyAoZm9yIENTViBleHBvcnQpXHJcbiAqL1xyXG5leHBvcnQgZnVuY3Rpb24gcmdkVG9GbGF0TWFwKHRhYmxlOiBSZ2RUYWJsZSwgcHJlZml4OiBzdHJpbmcgPSAnJyk6IE1hcDxzdHJpbmcsIHsgdHlwZTogUmdkRGF0YVR5cGU7IHZhbHVlOiBhbnkgfT4ge1xyXG4gICAgICAgIGNvbnN0IHJlc3VsdCA9IG5ldyBNYXA8c3RyaW5nLCB7IHR5cGU6IFJnZERhdGFUeXBlOyB2YWx1ZTogYW55IH0+KCk7XHJcblxyXG4gICAgICAgIGZvciAoY29uc3QgZW50cnkgb2YgdGFibGUuZW50cmllcykge1xyXG4gICAgICAgICAgICAgICAgaWYgKGVudHJ5Lmhhc2ggPT09IFJFRl9IQVNIKSBjb250aW51ZTtcclxuXHJcbiAgICAgICAgICAgICAgICBjb25zdCBuYW1lID0gZW50cnkubmFtZSA/PyBoYXNoVG9IZXgoZW50cnkuaGFzaCk7XHJcbiAgICAgICAgICAgICAgICBjb25zdCBmdWxsUGF0aCA9IHByZWZpeCA/IGAke3ByZWZpeH0uJHtuYW1lfWAgOiBuYW1lO1xyXG5cclxuICAgICAgICAgICAgICAgIGlmIChlbnRyeS50eXBlID09PSBSZ2REYXRhVHlwZS5UYWJsZSB8fCBlbnRyeS50eXBlID09PSBSZ2REYXRhVHlwZS5UYWJsZUludCkge1xyXG4gICAgICAgICAgICAgICAgICAgICAgICBjb25zdCBjaGlsZE1hcCA9IHJnZFRvRmxhdE1hcChlbnRyeS52YWx1ZSBhcyBSZ2RUYWJsZSwgZnVsbFBhdGgpO1xyXG4gICAgICAgICAgICAgICAgICAgICAgICBmb3IgKGNvbnN0IFtrLCB2XSBvZiBjaGlsZE1hcCkge1xyXG4gICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgIHJlc3VsdC5zZXQoaywgdik7XHJcbiAgICAgICAgICAgICAgICAgICAgICAgIH1cclxuICAgICAgICAgICAgICAgIH0gZWxzZSB7XHJcbiAgICAgICAgICAgICAgICAgICAgICAgIHJlc3VsdC5zZXQoZnVsbFBhdGgsIHsgdHlwZTogZW50cnkudHlwZSwgdmFsdWU6IGVudHJ5LnZhbHVlIH0pO1xyXG4gICAgICAgICAgICAgICAgfVxyXG4gICAgICAgIH1cclxuXHJcbiAgICAgICAgcmV0dXJuIHJlc3VsdDtcclxufVxyXG5cclxuLyoqXHJcbiAqIENvbnZlcnQgUkdEIHRvIENTViBmb3JtYXRcclxuICovXHJcbmV4cG9ydCBmdW5jdGlvbiByZ2RUb0NzdihyZ2RGaWxlOiBSZ2RGaWxlKTogc3RyaW5nIHtcclxuICAgICAgICBjb25zdCBmbGF0TWFwID0gcmdkVG9GbGF0TWFwKHJnZEZpbGUuZ2FtZURhdGEpO1xyXG4gICAgICAgIGNvbnN0IGxpbmVzOiBzdHJpbmdbXSA9IFtdO1xyXG5cclxuICAgICAgICBsaW5lcy5wdXNoKCdQYXRoLFR5cGUsVmFsdWUnKTtcclxuXHJcbiAgICAgICAgZm9yIChjb25zdCBbcGF0aCwgeyB0eXBlLCB2YWx1ZSB9XSBvZiBmbGF0TWFwKSB7XHJcbiAgICAgICAgICAgICAgICBjb25zdCB0eXBlTmFtZSA9IGRhdGFUeXBlTmFtZSh0eXBlKTtcclxuICAgICAgICAgICAgICAgIGxldCB2YWx1ZVN0ciA9IFN0cmluZyh2YWx1ZSk7XHJcblxyXG4gICAgICAgICAgICAgICAgLy8gRXNjYXBlIENTVlxyXG4gICAgICAgICAgICAgICAgaWYgKHZhbHVlU3RyLmluY2x1ZGVzKCcsJykgfHwgdmFsdWVTdHIuaW5jbHVkZXMoJ1wiJykgfHwgdmFsdWVTdHIuaW5jbHVkZXMoJ1xcbicpKSB7XHJcbiAgICAgICAgICAgICAgICAgICAgICAgIHZhbHVlU3RyID0gYFwiJHt2YWx1ZVN0ci5yZXBsYWNlKC9cIi9nLCAnXCJcIicpfVwiYDtcclxuICAgICAgICAgICAgICAgIH1cclxuXHJcbiAgICAgICAgICAgICAgICBsaW5lcy5wdXNoKGAke3BhdGh9LCR7dHlwZU5hbWV9LCR7dmFsdWVTdHJ9YCk7XHJcbiAgICAgICAgfVxyXG5cclxuICAgICAgICByZXR1cm4gbGluZXMuam9pbignXFxuJyk7XHJcbn1cclxuXHJcbi8qKlxyXG4gKiBQYXJzZSBDU1YgYmFjayB0byBSR0Qgc3RydWN0dXJlXHJcbiAqL1xyXG5leHBvcnQgZnVuY3Rpb24gY3N2VG9SZ2QoY3N2OiBzdHJpbmcsIGRpY3Q6IEhhc2hEaWN0aW9uYXJ5KTogUmdkVGFibGUge1xyXG4gICAgICAgIGNvbnN0IGxpbmVzID0gY3N2LnNwbGl0KC9cXHI/XFxuLyk7XHJcbiAgICAgICAgY29uc3Qgcm9vdDogUmdkVGFibGUgPSB7IGVudHJpZXM6IFtdIH07XHJcblxyXG4gICAgICAgIC8vIFNraXAgaGVhZGVyXHJcbiAgICAgICAgZm9yIChsZXQgaSA9IDE7IGkgPCBsaW5lcy5sZW5ndGg7IGkrKykge1xyXG4gICAgICAgICAgICAgICAgY29uc3QgbGluZSA9IGxpbmVzW2ldLnRyaW0oKTtcclxuICAgICAgICAgICAgICAgIGlmICghbGluZSkgY29udGludWU7XHJcblxyXG4gICAgICAgICAgICAgICAgLy8gUGFyc2UgQ1NWIGxpbmUgKHNpbXBsZSBwYXJzZXIsIGhhbmRsZXMgcXVvdGVkIHZhbHVlcylcclxuICAgICAgICAgICAgICAgIGNvbnN0IHBhcnRzID0gcGFyc2VDU1ZMaW5lKGxpbmUpO1xyXG4gICAgICAgICAgICAgICAgaWYgKHBhcnRzLmxlbmd0aCA8IDMpIGNvbnRpbnVlO1xyXG5cclxuICAgICAgICAgICAgICAgIGNvbnN0IFtwYXRoLCB0eXBlTmFtZSwgLi4udmFsdWVQYXJ0c10gPSBwYXJ0cztcclxuICAgICAgICAgICAgICAgIGNvbnN0IHZhbHVlU3RyID0gdmFsdWVQYXJ0cy5qb2luKCcsJyk7XHJcblxyXG4gICAgICAgICAgICAgICAgY29uc3QgdHlwZSA9IHBhcnNlRGF0YVR5cGUodHlwZU5hbWUpO1xyXG4gICAgICAgICAgICAgICAgY29uc3QgdmFsdWUgPSBwYXJzZVZhbHVlKHR5cGUsIHZhbHVlU3RyKTtcclxuXHJcbiAgICAgICAgICAgICAgICAvLyBOYXZpZ2F0ZS9jcmVhdGUgcGF0aFxyXG4gICAgICAgICAgICAgICAgY29uc3QgcGF0aFBhcnRzID0gcGF0aC5zcGxpdCgnLicpO1xyXG4gICAgICAgICAgICAgICAgbGV0IGN1cnJlbnRUYWJsZSA9IHJvb3Q7XHJcblxyXG4gICAgICAgICAgICAgICAgZm9yIChsZXQgaiA9IDA7IGogPCBwYXRoUGFydHMubGVuZ3RoIC0gMTsgaisrKSB7XHJcbiAgICAgICAgICAgICAgICAgICAgICAgIGNvbnN0IHBhcnQgPSBwYXRoUGFydHNbal07XHJcbiAgICAgICAgICAgICAgICAgICAgICAgIGNvbnN0IGggPSBpc0hleEhhc2gocGFydCkgPyBoZXhUb0hhc2gocGFydCkgOiBuYW1lVG9IYXNoKGRpY3QsIHBhcnQpO1xyXG5cclxuICAgICAgICAgICAgICAgICAgICAgICAgbGV0IGV4aXN0aW5nRW50cnkgPSBjdXJyZW50VGFibGUuZW50cmllcy5maW5kKGUgPT4gZS5oYXNoID09PSBoKTtcclxuICAgICAgICAgICAgICAgICAgICAgICAgaWYgKCFleGlzdGluZ0VudHJ5KSB7XHJcbiAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgZXhpc3RpbmdFbnRyeSA9IHtcclxuICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgIGhhc2g6IGgsXHJcbiAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICBuYW1lOiBwYXJ0LFxyXG4gICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgdHlwZTogUmdkRGF0YVR5cGUuVGFibGUsXHJcbiAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICB2YWx1ZTogeyBlbnRyaWVzOiBbXSB9IGFzIFJnZFRhYmxlXHJcbiAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgfTtcclxuICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICBjdXJyZW50VGFibGUuZW50cmllcy5wdXNoKGV4aXN0aW5nRW50cnkpO1xyXG4gICAgICAgICAgICAgICAgICAgICAgICB9XHJcbiAgICAgICAgICAgICAgICAgICAgICAgIGN1cnJlbnRUYWJsZSA9IGV4aXN0aW5nRW50cnkudmFsdWUgYXMgUmdkVGFibGU7XHJcbiAgICAgICAgICAgICAgICB9XHJcblxyXG4gICAgICAgICAgICAgICAgLy8gQWRkIHRoZSBsZWFmIGVudHJ5XHJcbiAgICAgICAgICAgICAgICBjb25zdCBsZWFmTmFtZSA9IHBhdGhQYXJ0c1twYXRoUGFydHMubGVuZ3RoIC0gMV07XHJcbiAgICAgICAgICAgICAgICBjb25zdCBsZWFmSGFzaCA9IGlzSGV4SGFzaChsZWFmTmFtZSkgPyBoZXhUb0hhc2gobGVhZk5hbWUpIDogbmFtZVRvSGFzaChkaWN0LCBsZWFmTmFtZSk7XHJcblxyXG4gICAgICAgICAgICAgICAgLy8gQ2hlY2sgaWYgZW50cnkgZXhpc3RzXHJcbiAgICAgICAgICAgICAgICBjb25zdCBleGlzdGluZ0lkeCA9IGN1cnJlbnRUYWJsZS5lbnRyaWVzLmZpbmRJbmRleChlID0+IGUuaGFzaCA9PT0gbGVhZkhhc2gpO1xyXG4gICAgICAgICAgICAgICAgY29uc3QgZW50cnk6IFJnZEVudHJ5ID0ge1xyXG4gICAgICAgICAgICAgICAgICAgICAgICBoYXNoOiBsZWFmSGFzaCxcclxuICAgICAgICAgICAgICAgICAgICAgICAgbmFtZTogbGVhZk5hbWUsXHJcbiAgICAgICAgICAgICAgICAgICAgICAgIHR5cGUsXHJcbiAgICAgICAgICAgICAgICAgICAgICAgIHZhbHVlXHJcbiAgICAgICAgICAgICAgICB9O1xyXG5cclxuICAgICAgICAgICAgICAgIGlmIChleGlzdGluZ0lkeCA+PSAwKSB7XHJcbiAgICAgICAgICAgICAgICAgICAgICAgIGN1cnJlbnRUYWJsZS5lbnRyaWVzW2V4aXN0aW5nSWR4XSA9IGVudHJ5O1xyXG4gICAgICAgICAgICAgICAgfSBlbHNlIHtcclxuICAgICAgICAgICAgICAgICAgICAgICAgY3VycmVudFRhYmxlLmVudHJpZXMucHVzaChlbnRyeSk7XHJcbiAgICAgICAgICAgICAgICB9XHJcbiAgICAgICAgfVxyXG5cclxuICAgICAgICByZXR1cm4gcm9vdDtcclxufVxyXG5cclxuLyoqXHJcbiAqIFNpbXBsZSBDU1YgbGluZSBwYXJzZXJcclxuICovXHJcbmZ1bmN0aW9uIHBhcnNlQ1NWTGluZShsaW5lOiBzdHJpbmcpOiBzdHJpbmdbXSB7XHJcbiAgICAgICAgY29uc3QgcmVzdWx0OiBzdHJpbmdbXSA9IFtdO1xyXG4gICAgICAgIGxldCBjdXJyZW50ID0gJyc7XHJcbiAgICAgICAgbGV0IGluUXVvdGVzID0gZmFsc2U7XHJcblxyXG4gICAgICAgIGZvciAobGV0IGkgPSAwOyBpIDwgbGluZS5sZW5ndGg7IGkrKykge1xyXG4gICAgICAgICAgICAgICAgY29uc3QgYyA9IGxpbmVbaV07XHJcblxyXG4gICAgICAgICAgICAgICAgaWYgKGluUXVvdGVzKSB7XHJcbiAgICAgICAgICAgICAgICAgICAgICAgIGlmIChjID09PSAnXCInKSB7XHJcbiAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgaWYgKGxpbmVbaSArIDFdID09PSAnXCInKSB7XHJcbiAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICBjdXJyZW50ICs9ICdcIic7XHJcbiAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICBpKys7XHJcbiAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgfSBlbHNlIHtcclxuICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgIGluUXVvdGVzID0gZmFsc2U7XHJcbiAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgfVxyXG4gICAgICAgICAgICAgICAgICAgICAgICB9IGVsc2Uge1xyXG4gICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgIGN1cnJlbnQgKz0gYztcclxuICAgICAgICAgICAgICAgICAgICAgICAgfVxyXG4gICAgICAgICAgICAgICAgfSBlbHNlIHtcclxuICAgICAgICAgICAgICAgICAgICAgICAgaWYgKGMgPT09ICdcIicpIHtcclxuICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICBpblF1b3RlcyA9IHRydWU7XHJcbiAgICAgICAgICAgICAgICAgICAgICAgIH0gZWxzZSBpZiAoYyA9PT0gJywnKSB7XHJcbiAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgcmVzdWx0LnB1c2goY3VycmVudCk7XHJcbiAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgY3VycmVudCA9ICcnO1xyXG4gICAgICAgICAgICAgICAgICAgICAgICB9IGVsc2Uge1xyXG4gICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgIGN1cnJlbnQgKz0gYztcclxuICAgICAgICAgICAgICAgICAgICAgICAgfVxyXG4gICAgICAgICAgICAgICAgfVxyXG4gICAgICAgIH1cclxuXHJcbiAgICAgICAgcmVzdWx0LnB1c2goY3VycmVudCk7XHJcbiAgICAgICAgcmV0dXJuIHJlc3VsdDtcclxufVxyXG4iXX0=