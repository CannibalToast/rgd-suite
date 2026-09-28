'use strict';
/**
 * requirements.js — required_* slot compaction for RGD tables.
 *
 * DoW requirement tables use sequentially numbered children
 * (required_1, required_2, ...) which the engine and Lua UI iterate
 * until the first missing index. Empty slots conventionally hold a
 * $REF to requirements\required_none.lua — dead weight that is safe
 * to drop only when the remaining entries are renumbered into a
 * contiguous 1..N block, which is what this does.
 */
const path = require('path');
const dist = path.join(__dirname, '..', 'bundled', 'rgd-tools', 'dist');
const { nameToHash } = require(path.join(dist, 'dictionary.js'));
const { RgdDataType } = require(path.join(dist, 'types.js'));

const REQ_RE = /^required_(\d+)$/i;
const NONE_REF_RE = /required_none\.lua$/i;

function entryName(e) {
    return e.name || '';
}

// The target a required_N slot points at: the table's own reference or a
// $REF child entry's string value.
function reqTargetRef(entry) {
    const v = entry.value;
    if (v && typeof v === 'object' && Array.isArray(v.entries)) {
        if (v.reference) return String(v.reference);
        const ref = v.entries.find((c) => entryName(c) === '$REF');
        if (ref && typeof ref.value === 'string') return ref.value;
    }
    return '';
}

function isNoneSlot(entry) {
    const v = entry.value;
    const isTable = entry.type === RgdDataType.Table || entry.type === RgdDataType.TableInt;
    if (!isTable || !v || !Array.isArray(v.entries)) return false;
    // A slot carrying real children alongside its $REF isn't dead weight —
    // dropping it would lose data, so leave it alone.
    if (v.entries.some((c) => entryName(c) !== '$REF')) return false;
    const ref = reqTargetRef(entry).replace(/\\/g, '/');
    // No reference at all, or a $REF to required_none — both are dead slots.
    return !ref || NONE_REF_RE.test(ref);
}

// Compact one table's required_* children in place. Returns a stat object
// or null when the table has no required_* entries or nothing to drop.
function compactRequirementsTable(table, dict) {
    const entries = table.entries;
    const isReq = (e) => REQ_RE.test(entryName(e));
    if (!entries.some(isReq)) return null;

    const dropped = new Set();
    const kept = [];
    for (const e of entries) {
        if (!isReq(e)) continue;
        if (isNoneSlot(e)) dropped.add(e); else kept.push(e);
    }
    if (!dropped.size) return null;

    kept.sort((a, b) =>
        parseInt(REQ_RE.exec(entryName(a))[1], 10) - parseInt(REQ_RE.exec(entryName(b))[1], 10));

    const renames = [];
    kept.forEach((e, i) => {
        const want = 'required_' + (i + 1);
        if (entryName(e).toLowerCase() !== want) renames.push([entryName(e), want]);
        e.name = want;
        e.hash = nameToHash(dict, want);
    });

    // Kept entries take over the positions the required_* slots occupied.
    const out = [];
    let ki = 0;
    for (const e of entries) {
        if (!isReq(e)) { out.push(e); continue; }
        if (dropped.has(e)) continue;
        out.push(kept[ki++]);
    }
    table.entries = out;
    return { dropped: dropped.size, kept: kept.length, renames };
}

// Walk the whole gameData tree; compacts every table that has required_*
// children. Returns a list of { path, dropped, kept, renames } reports.
function compactRequirements(gameData, dict) {
    const report = [];
    (function walk(table, trail) {
        const r = compactRequirementsTable(table, dict);
        if (r) report.push(Object.assign({ path: trail || '(root)' }, r));
        for (const e of table.entries) {
            const v = e.value;
            if (v && typeof v === 'object' && Array.isArray(v.entries)) {
                walk(v, trail ? trail + '.' + entryName(e) : entryName(e));
            }
        }
    })(gameData, '');
    return report;
}

module.exports = { compactRequirements, compactRequirementsTable, isNoneSlot, REQ_RE };
