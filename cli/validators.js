'use strict';

const fs = require('fs');
const path = require('path');

const ABSOLUTE_RE = /^[a-zA-Z]:[\\/]|^\\\\|^\//;

const PATH_LIKE_VALUE_KEYS = new Set([
    'research_name',
    'structure_name',
    'weapon_name',
    'entity_name',
    'addon_name',
    'squad_name',
    'entity_blueprint',
    'squad_blueprint',
    'modifier_name',
    'parent_name',
    'inherit_from',
]);

function issue(kind, issuePath, details, extra) {
    return {
        kind,
        severity: kind === 'bom_detected' ? 'warning' : 'error',
        path: issuePath || '',
        details,
        ...extra,
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
        .replace(/^ua_data\/attrib\//i, '')
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
    const resolvedCandidate = path.resolve(candidate).toLowerCase();
    const resolvedBase = path.resolve(base).toLowerCase();
    if (resolvedCandidate === resolvedBase || resolvedCandidate.startsWith(resolvedBase + path.sep)) {
        return true;
    }
    // Symlink/junction escape fallback
    try {
        return isInsideBase(fs.realpathSync(candidate), fs.realpathSync(base));
    } catch {
        return false;
    }
}

const _attribIndexCache = new Map();

function getAttribIndex(attribBase) {
    const cacheKey = path.resolve(attribBase).toLowerCase();
    let index = _attribIndexCache.get(cacheKey);
    if (index) return index;
    index = new Map();
    const walk = (dir) => {
        let entries;
        try {
            entries = fs.readdirSync(dir, { withFileTypes: true });
        } catch {
            return;
        }
        for (const ent of entries) {
            const full = path.join(dir, ent.name);
            if (ent.isDirectory()) {
                walk(full);
            } else if (ent.isFile() && /\.(lua|rgd)$/i.test(ent.name)) {
                const lower = ent.name.toLowerCase();
                let list = index.get(lower);
                if (!list) {
                    list = [];
                    index.set(lower, list);
                }
                list.push(full);
            }
        }
    };
    walk(attribBase);
    _attribIndexCache.set(cacheKey, index);
    return index;
}

function clearAttribIndex(attribBase) {
    if (attribBase) {
        _attribIndexCache.delete(path.resolve(attribBase).toLowerCase());
    } else {
        _attribIndexCache.clear();
    }
}

function resolveRefCandidates(refPath, attribBase) {
    if (!attribBase) return [];
    const pathIssues = validateFilePath(refPath);
    if (pathIssues.some((i) => i.severity === 'error')) return [];
    const clean = normalizeAttribRef(refPath).replace(/\.(lua|rgd)$/i, '');
    const literalCandidates = [clean + '.lua', clean + '.rgd']
        .map((c) => path.resolve(attribBase, c))
        .filter((c) => isInsideBase(c, attribBase));

    // Fast path: if any literal candidate exists on disk, return only those.
    const existingLiteral = literalCandidates.filter((c) => isExistingPathInsideBase(c, attribBase));
    if (existingLiteral.length > 0) return existingLiteral;

    // Basename fallback: ONLY for prefix-less references (bare filename, no
    // folder component). Handles the DoW pattern where an ability's
    // requirements field references "heavy_weapons_research" without the
    // "research/" prefix. Prefixed references are authoritative — if the
    // literal path doesn't exist, it's a wrong name and must be flagged.
    const hasFolder = clean.includes('/');
    if (hasFolder) return literalCandidates;

    const baseName = clean.toLowerCase();
    const index = getAttribIndex(attribBase);
    const fallback = [];
    for (const ext of ['.lua', '.rgd']) {
        const matches = index.get(baseName + ext);
        if (matches) {
            for (const m of matches) {
                if (isInsideBase(m, attribBase) && !fallback.includes(m)) {
                    fallback.push(m);
                }
            }
        }
    }
    return [...literalCandidates, ...fallback];
}

function resolveAttribRefPath(refPath, attribBase, extension) {
    if (isNilReference(refPath)) return null;
    const pathIssues = validateFilePath(refPath);
    if (!attribBase || pathIssues.some((i) => i.severity === 'error')) return null;

    // Try literal path first
    let clean = normalizeAttribRef(refPath);
    if (extension) {
        clean = clean.replace(/\.(lua|rgd)$/i, '');
    }
    const literalCandidate = path.resolve(attribBase, clean + (extension || ''));
    if (isInsideBase(literalCandidate, attribBase) && isExistingPathInsideBase(literalCandidate, attribBase)) {
        return literalCandidate;
    }

    // Fallback: search by basename across the attrib tree
    const candidates = resolveRefCandidates(refPath, attribBase);
    for (const candidate of candidates) {
        // Prefer candidates matching the requested extension if one was specified
        if (extension && !candidate.toLowerCase().endsWith(extension.toLowerCase())) continue;
        if (isExistingPathInsideBase(candidate, attribBase)) return candidate;
    }
    // If no extension-specific match, return any existing candidate
    for (const candidate of candidates) {
        if (isExistingPathInsideBase(candidate, attribBase)) return candidate;
    }
    return null;
}

function refExists(refPath, attribBase) {
    if (!attribBase) return false;
    for (const candidate of resolveRefCandidates(refPath, attribBase)) {
        if (isExistingPathInsideBase(candidate, attribBase)) return true;
    }
    return false;
}

function isPathLikeValueKey(key) {
    if (!key || typeof key !== 'string') return false;
    return PATH_LIKE_VALUE_KEYS.has(key);
}

function shouldValidateStringValue(key, value) {
    if (typeof value !== 'string' || !value) return false;
    // $REF is already validated via table.reference / entry.reference
    if (key === '$REF') return false;
    // Skip UCS-style and empty-ish markers
    if (value.startsWith('$')) return false;
    // Always check known path-carrying keys when they look like file refs
    if (isPathLikeValueKey(key)) return looksLikeFileRef(value);
    // Also catch any string that literally ends in .lua/.rgd (unknown keys)
    return /\.(lua|rgd)$/i.test(value);
}

function isTypeInternalRef(refPath) {
    const first = String(refPath).replace(/\\/g, '/').split('/')[0].toLowerCase();
    return first.startsWith('type_');
}

function looksLikeFileRef(refPath) {
    return /[\\\\/]/.test(refPath) || /\.(lua|rgd)$/i.test(refPath);
}

function resolveValueRef(refPath, attribBase, extension) {
    if (isNilReference(refPath)) return { resolved: true };
    const pathIssues = validateFilePath(refPath);
    if (pathIssues.some((i) => i.severity === 'error')) return { resolved: false, invalid: true };
    if (isTypeInternalRef(refPath)) return { resolved: true };

    let clean = normalizeAttribRef(refPath);
    if (extension) clean = clean.replace(/\.(lua|rgd)$/i, '');
    const ext = (extension && extension.toLowerCase()) || (clean.toLowerCase().endsWith('.rgd') ? '.rgd' : '.lua');
    if (!clean.toLowerCase().endsWith('.lua') && !clean.toLowerCase().endsWith('.rgd')) clean += ext;
    const hasFolder = clean.includes('/');
    const candidate = path.resolve(attribBase, clean);
    if (isInsideBase(candidate, attribBase) && isExistingPathInsideBase(candidate, attribBase)) {
        return { resolved: true, path: candidate };
    }

    const baseName = path.basename(clean).toLowerCase();
    if (baseName) {
        const index = getAttribIndex(attribBase);
        const baseNoExt = baseName.replace(/\.(lua|rgd)$/i, '');
        for (const tryExt of ['.lua', '.rgd']) {
            const matches = index.get(baseNoExt + tryExt);
            if (matches) {
                for (const m of matches) {
                    if (isInsideBase(m, attribBase) && isExistingPathInsideBase(m, attribBase)) {
                        return { resolved: true, path: m, fallback: hasFolder };
                    }
                }
            }
        }
    }
    return { resolved: false };
}

function validateValueReference(refPath, attribBase, key) {
    if (typeof refPath !== 'string' || !refPath) return [];
    if (isNilReference(refPath)) return [];
    if (isTypeInternalRef(refPath)) return [];
    if (!looksLikeFileRef(refPath)) return [];
    const issues = validateFilePath(refPath).map((i) => ({ ...i, key }));
    if (issues.some((i) => i.severity === 'error')) return issues;
    if (!attribBase) {
        issues.push(issue('invalid_reference', refPath, 'Attrib root was not resolved; reference could not be checked', { key }));
        return issues;
    }
    const r = resolveValueRef(refPath, attribBase, '.lua');
    if (r.resolved && r.fallback) {
        issues.push(issue('relocated_ref', refPath, `Resolved by basename fallback: ${r.path} (consider updating the exact path)`, { key, severity: 'warning' }));
    } else if (!r.resolved) {
        issues.push(issue('missing_file', refPath, `Reference not found under attrib root: ${refPath}`, { key }));
    }
    return issues;
}

function findBasenameRelocation(refPath, attribBase) {
    const clean = normalizeAttribRef(refPath).replace(/\.(lua|rgd)$/i, '');
    if (!clean.includes('/')) return null;
    const baseNoExt = path.basename(clean).toLowerCase();
    if (!baseNoExt) return null;
    const index = getAttribIndex(attribBase);
    for (const tryExt of ['.lua', '.rgd']) {
        const matches = index.get(baseNoExt + tryExt);
        if (!matches) continue;
        for (const m of matches) {
            if (isInsideBase(m, attribBase) && isExistingPathInsideBase(m, attribBase)) {
                return m;
            }
        }
    }
    return null;
}

function validateReferencePath(refPath, attribBase, key) {
    if (isNilReference(refPath)) return [];
    if (isTypeInternalRef(refPath)) return [];
    const issues = validateFilePath(refPath).map((i) => ({ ...i, key }));
    if (issues.some((i) => i.severity === 'error')) return issues;
    if (!attribBase) {
        issues.push(issue('invalid_reference', refPath, 'Attrib root was not resolved; reference could not be checked', { key }));
        return issues;
    }
    if (refExists(refPath, attribBase)) return issues;

    // Prefixed path missed the literal location, but the basename exists elsewhere.
    // Report as relocated_ref so wrong-prefix / wrong-race folder mismatches are visible.
    const relocated = findBasenameRelocation(refPath, attribBase);
    if (relocated) {
        issues.push(issue(
            'relocated_ref',
            refPath,
            `Resolved by basename fallback: ${relocated} (consider updating the exact path)`,
            { key, severity: 'warning' },
        ));
    } else {
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
        if (entry && shouldValidateStringValue(key, entry.value)) {
            issues.push(...validateValueReference(entry.value, attribBase, full));
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
        // Legacy/hand-built tables may put $REF on the entry itself
        if (entry.reference) {
            issues.push(...validateReferencePath(entry.reference, attribBase, full));
        }
        // Binary reader stores $REF on nested table.reference (validated via recursion)
        // Path-carrying string / wstring leaves
        if (typeof entry.value === 'string' && shouldValidateStringValue(key, entry.value)) {
            issues.push(...validateValueReference(entry.value, attribBase, full));
        }
        // Recurse into any table-shaped child so nesting depth never drops refs
        if (entry.value && typeof entry.value === 'object' && Array.isArray(entry.value.entries)) {
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
    clearAttribIndex,
    validateEncoding,
    validateFilePath,
    validateFolderStructure,
    validateLuaReferences,
    validateRgdReferences,
};
