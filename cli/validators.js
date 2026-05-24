'use strict';

const fs = require('fs');
const path = require('path');

const ABSOLUTE_RE = /^[a-zA-Z]:[\\/]|^\\\\|^\//;

function issue(kind, issuePath, details, extra) {
    return {
        kind,
        severity: kind === 'bom_detected' ? 'warning' : 'error',
        path: issuePath || '',
        details,
        ...(extra || {}),
    };
}

function detectBOM(buffer) {
    const sigs = [
        ['utf32le', [0xff, 0xfe, 0x00, 0x00]],
        ['utf32be', [0x00, 0x00, 0xfe, 0xff]],
        ['utf8', [0xef, 0xbb, 0xbf]],
        ['utf16le', [0xff, 0xfe]],
        ['utf16be', [0xfe, 0xff]],
    ];
    for (const [type, bytes] of sigs) {
        if (buffer.length >= bytes.length && bytes.every((b, i) => buffer[i] === b)) {
            return { detected: true, type, bytes };
        }
    }
    return { detected: false, type: null, bytes: [] };
}

function validateEncoding(buffer, filePath) {
    const bom = detectBOM(buffer);
    const issues = [];
    if (bom.detected) {
        issues.push(issue('bom_detected', filePath, `BOM detected: ${bom.type}`, { bom: bom.type }));
    }

    const sample = buffer.subarray(0, Math.min(buffer.length, 4096));
    const nulCount = sample.reduce((count, byte) => count + (byte === 0 ? 1 : 0), 0);
    if (sample.length > 0 && nulCount / sample.length > 0.1) {
        issues.push(issue('encoding_mismatch', filePath, 'Text file contains many NUL bytes; expected UTF-8-compatible Lua/text'));
    }

    return {
        isValid: !issues.some((i) => i.kind === 'encoding_mismatch'),
        encoding: bom.type ? (bom.type.startsWith('utf16') ? 'utf16' : bom.type.startsWith('utf32') ? 'utf32' : 'utf8') : 'utf8',
        hasBOM: bom.detected,
        issues,
    };
}

function stripUtf8BomFromFile(filePath, buffer) {
    const source = buffer || fs.readFileSync(filePath);
    if (detectBOM(source).type !== 'utf8') {
        return { fixed: false, buffer: source };
    }
    const stripped = source.subarray(3);
    fs.writeFileSync(filePath, stripped);
    return { fixed: true, buffer: stripped };
}

function validateFilePath(filePath) {
    const issues = [];
    if (!filePath || typeof filePath !== 'string') {
        issues.push(issue('invalid_reference', String(filePath || ''), 'Path is empty or not a string'));
        return issues;
    }
    if (filePath.includes('\0')) {
        issues.push(issue('null_byte', filePath.replace(/\0/g, '\\0'), 'Path contains a null byte'));
    }
    if (ABSOLUTE_RE.test(filePath)) {
        issues.push(issue('absolute_path', filePath, 'Path is absolute; attrib references must be relative'));
    }
    const parts = filePath.replace(/\\/g, '/').split('/');
    if (parts.some((part) => part === '..')) {
        issues.push(issue('path_traversal', filePath, 'Path contains parent-directory traversal'));
    }
    return issues;
}

function normalizeAttribRef(refPath) {
    return refPath
        .replace(/\\/g, '/')
        .trim()
        .replace(/^\/+/, '')
        .replace(/^data\/attrib\//i, '')
        .replace(/^attrib\//i, '');
}

function isNilReference(refPath) {
    return /\.nil$/i.test(refPath.replace(/\\/g, '/').trim());
}

function isInsideBase(candidate, base) {
    const lowerCandidate = path.resolve(candidate).toLowerCase();
    const lowerBase = path.resolve(base).toLowerCase();
    return lowerCandidate === lowerBase || lowerCandidate.startsWith(lowerBase + path.sep);
}

function isExistingPathInsideBase(candidate, base) {
    if (!fs.existsSync(candidate)) return false;
    try {
        return isInsideBase(fs.realpathSync(candidate), fs.realpathSync(base));
    } catch {
        return false;
    }
}

function resolveRefCandidates(refPath, attribBase) {
    if (!attribBase) return [];
    const pathIssues = validateFilePath(refPath);
    if (pathIssues.some((i) => i.severity === 'error')) return [];
    const clean = normalizeAttribRef(refPath).replace(/\.(lua|rgd)$/i, '');
    const candidates = [clean + '.lua', clean + '.rgd'];
    return candidates
        .map((candidate) => path.resolve(attribBase, candidate))
        .filter((candidate) => isInsideBase(candidate, attribBase));
}

function resolveAttribRefPath(refPath, attribBase, extension) {
    if (isNilReference(refPath)) return null;
    const pathIssues = validateFilePath(refPath);
    if (!attribBase || pathIssues.some((i) => i.severity === 'error')) return null;
    let clean = normalizeAttribRef(refPath);
    if (extension) {
        clean = clean.replace(/\.(lua|rgd)$/i, '');
    }
    const candidate = path.resolve(attribBase, clean + (extension || ''));
    if (!isInsideBase(candidate, attribBase)) return null;
    if (fs.existsSync(candidate) && !isExistingPathInsideBase(candidate, attribBase)) return null;
    return candidate;
}

function refExists(refPath, attribBase) {
    if (!attribBase) return false;
    for (const candidate of resolveRefCandidates(refPath, attribBase)) {
        if (isExistingPathInsideBase(candidate, attribBase)) return true;
    }
    return false;
}

function validateReferencePath(refPath, attribBase, key) {
    if (isNilReference(refPath)) return [];
    const issues = validateFilePath(refPath).map((i) => ({ ...i, key }));
    if (issues.some((i) => i.severity === 'error')) return issues;
    if (!attribBase) {
        issues.push(issue('invalid_reference', refPath, 'Attrib root was not resolved; reference could not be checked', { key }));
        return issues;
    }
    if (!refExists(refPath, attribBase)) {
        issues.push(issue('missing_file', refPath, `Reference not found under attrib root: ${refPath}`, { key }));
    }
    return issues;
}

function validateLuaReferences(table, attribBase, prefix) {
    const issues = [];
    const current = prefix || 'GameData';
    if (table && table.reference) {
        issues.push(...validateReferencePath(table.reference, attribBase, current));
    }
    if (!table || !table.entries || typeof table.entries[Symbol.iterator] !== 'function') return issues;

    for (const [key, entry] of table.entries) {
        const full = `${current}.${key}`;
        if (entry && entry.reference) {
            issues.push(...validateReferencePath(entry.reference, attribBase, full));
        }
        if (entry && entry.type === 'table' && entry.table) {
            issues.push(...validateLuaReferences(entry.table, attribBase, full));
        }
    }
    return issues;
}

function validateRgdReferences(table, attribBase, prefix) {
    const issues = [];
    const current = prefix || 'GameData';
    if (table && table.reference) {
        issues.push(...validateReferencePath(table.reference, attribBase, current));
    }
    if (!table || !Array.isArray(table.entries)) return issues;

    for (const entry of table.entries) {
        const key = entry.name || (entry.hash !== undefined ? `#${entry.hash.toString(16).padStart(8, '0')}` : '<unknown>');
        const full = `${current}.${key}`;
        if (entry.reference) {
            issues.push(...validateReferencePath(entry.reference, attribBase, full));
        }
        if ((entry.type === 100 || entry.type === 101) && entry.value && entry.value.entries) {
            issues.push(...validateRgdReferences(entry.value, attribBase, full));
        }
    }
    return issues;
}

function validateFolderStructure(folder) {
    const issues = [];
    if (!folder || !fs.existsSync(folder) || !fs.statSync(folder).isDirectory()) {
        issues.push(issue('folder_structure', folder, 'Folder does not exist'));
        return issues;
    }
    const expected = ['ebps', 'sbps'];
    const hasExpected = expected.some((name) => fs.existsSync(path.join(folder, name)));
    if (!hasExpected) {
        issues.push(issue('folder_structure', folder, 'Folder does not look like an attrib root; expected ebps/ or sbps/'));
    }
    return issues;
}

function stripUtf8Bom(text) {
    return text.replace(/^\uFEFF/, '');
}

module.exports = {
    detectBOM,
    stripUtf8Bom,
    stripUtf8BomFromFile,
    isNilReference,
    resolveAttribRefPath,
    validateEncoding,
    validateFilePath,
    validateFolderStructure,
    validateLuaReferences,
    validateRgdReferences,
};
