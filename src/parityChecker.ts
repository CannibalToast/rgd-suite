import * as vscode from 'vscode';
import * as path from 'path';
import * as fs from 'fs';
import { parseRgd } from '../bundled/rgd-tools/dist/reader';
import { parseLuaToTable, LuaFileLoader, ParsedLuaTable } from '../bundled/rgd-tools/dist/luaFormat';
import { RgdTable, RgdDataType, HashDictionary } from '../bundled/rgd-tools/dist/types';
import { DictionaryManager } from './dictionaryManager';

const FLOAT_EPSILON = 1e-4;

type FlatType = 'float' | 'int' | 'bool' | 'string' | 'nil' | 'ref';
interface FlatEntry { type: FlatType; value: any; }
type FlatMap = Map<string, FlatEntry>;

export interface ParityIssue {
    kind: 'missing_in_lua' | 'missing_in_rgd' | 'value_mismatch' | 'type_mismatch' | 'missing_ref';
    key: string;
    details: string;
}

export interface ParityResult {
    rgdFile: string;
    luaFile: string | null;
    totalKeys: number;
    issues: ParityIssue[];
    attribResolved: boolean;
    error?: string;
}

// ---------- Flatten RGD table ----------

function flattenRgd(table: RgdTable, dict: HashDictionary, prefix = ''): FlatMap {
    const result: FlatMap = new Map();
    for (const entry of table.entries) {
        const k = entry.name ?? `#${entry.hash.toString(16).padStart(8, '0')}`;
        const full = prefix ? `${prefix}.${k}` : k;
        switch (entry.type) {
            case RgdDataType.Table:
            case RgdDataType.TableInt: {
                const sub = entry.value as RgdTable;
                if (!sub) break;
                for (const [sk, sv] of flattenRgd(sub, dict, full)) result.set(sk, sv);
                break;
            }
            case RgdDataType.Float:
                result.set(full, { type: 'float', value: entry.value as number }); break;
            case RgdDataType.Integer:
                result.set(full, { type: 'int', value: entry.value as number }); break;
            case RgdDataType.Bool:
                result.set(full, { type: 'bool', value: entry.value as boolean }); break;
            case RgdDataType.String:
            case RgdDataType.WString:
                // Skip $REF entries — these are reference-path metadata, not comparable data values
                if (k === '$REF') break;
                result.set(full, { type: 'string', value: entry.value as string }); break;
            case RgdDataType.NoData:
                result.set(full, { type: 'nil', value: null }); break;
        }
    }
    return result;
}

// ---------- Flatten ParsedLuaTable ----------

function flattenLua(table: ParsedLuaTable, prefix = ''): FlatMap {
    const result: FlatMap = new Map();
    for (const [key, entry] of table.entries) {
        const full = prefix ? `${prefix}.${key}` : key;
        if (entry.type === 'table' && entry.table) {
            for (const [sk, sv] of flattenLua(entry.table, full)) result.set(sk, sv);
        } else {
            const val = entry.value;
            if (val === null || val === undefined) {
                result.set(full, { type: 'nil', value: null });
            } else if (typeof val === 'boolean') {
                result.set(full, { type: 'bool', value: val });
            } else if (typeof val === 'number') {
                const isFloat = entry.dataType === RgdDataType.Float || !Number.isInteger(val);
                result.set(full, { type: isFloat ? 'float' : 'int', value: val });
            } else if (typeof val === 'string') {
                result.set(full, { type: 'string', value: val });
            }
        }
    }
    return result;
}

// ---------- Helpers ----------

function normRef(p: string): string {
    return p.replace(/\\/g, '/').toLowerCase().replace(/\.lua$/, '').replace(/^\//, '');
}

function valuesMatch(a: FlatEntry, b: FlatEntry): boolean {
    const numeric = (t: string) => t === 'float' || t === 'int';
    if (numeric(a.type) && numeric(b.type)) {
        return Math.abs((a.value as number) - (b.value as number)) <= FLOAT_EPSILON;
    }
    if (a.type !== b.type) return false;
    if (a.type === 'ref') return normRef(a.value ?? '') === normRef(b.value ?? '');
    if (a.type === 'nil') return true;
    return a.value === b.value;
}

function findAttribBase(filePath: string): string | null {
    const normalized = filePath.replace(/\\/g, '/').toLowerCase();
    const idx = normalized.lastIndexOf('/attrib/');
    if (idx !== -1) return filePath.substring(0, idx + 7);
    let dir = path.dirname(filePath);
    for (let d = 0; d < 15; d++) {
        const attrib = path.join(dir, 'attrib');
        const dataAttrib = path.join(dir, 'data', 'attrib');
        if (fs.existsSync(dataAttrib)) return dataAttrib;
        if (fs.existsSync(attrib)) return attrib;
        const parent = path.dirname(dir);
        if (parent === dir) break;
        dir = parent;
    }
    return null;
}

function makeLuaLoader(attribBase: string | null, fileCache: Map<string, string | null>): LuaFileLoader {
    return (refPath: string): string | null => {
        if (!attribBase) return null;
        let clean = refPath.replace(/\\/g, '/');
        if (!clean.endsWith('.lua')) clean += '.lua';
        const full = path.join(attribBase, clean);
        if (fileCache.has(full)) return fileCache.get(full)!;
        const content = fs.existsSync(full) ? fs.readFileSync(full, 'utf8') : null;
        fileCache.set(full, content);
        return content;
    };
}

function collectMissingRefs(luaTable: ParsedLuaTable, attribBase: string | null, prefix = ''): ParityIssue[] {
    const issues: ParityIssue[] = [];
    for (const [key, entry] of luaTable.entries) {
        const full = prefix ? `${prefix}.${key}` : key;
        if (entry.type === 'table' && entry.reference && attribBase) {
            let ref = entry.reference.replace(/\\/g, '/');
            if (!ref.endsWith('.lua')) ref += '.lua';
            if (!fs.existsSync(path.join(attribBase, ref))) {
                issues.push({ kind: 'missing_ref', key: full, details: `Reference not found on disk: ${ref}` });
            }
        }
        if (entry.type === 'table' && entry.table) {
            issues.push(...collectMissingRefs(entry.table, attribBase, full));
        }
    }
    return issues;
}

// ---------- Core parity check ----------

export function checkParity(
    rgdPath: string,
    luaPath: string,
    dict: HashDictionary,
    fileCache: Map<string, string | null> = new Map()
): ParityResult {
    const attribBase = findAttribBase(rgdPath) ?? findAttribBase(luaPath);
    const luaLoader = makeLuaLoader(attribBase, fileCache);
    const issues: ParityIssue[] = [];

    const rgdBuf = fs.readFileSync(rgdPath);
    const rgdFile = parseRgd(rgdBuf, dict);
    const rgdMap = flattenRgd(rgdFile.gameData, dict);

    const luaCode = fs.readFileSync(luaPath, 'utf8');
    const luaTable = parseLuaToTable(luaCode, luaLoader);
    const luaMap = flattenLua(luaTable);

    issues.push(...collectMissingRefs(luaTable, attribBase));

    for (const [key, rgdEntry] of rgdMap) {
        if (key.endsWith('.$ref')) continue;
        const luaEntry = luaMap.get(key);
        if (!luaEntry) {
            issues.push({ kind: 'missing_in_lua', key, details: `RGD: ${JSON.stringify(rgdEntry.value)} (${rgdEntry.type})` });
        } else if (!valuesMatch(rgdEntry, luaEntry)) {
            const numeric = (t: string) => t === 'float' || t === 'int';
            if (rgdEntry.type !== luaEntry.type && !numeric(rgdEntry.type) && !numeric(luaEntry.type)) {
                issues.push({ kind: 'type_mismatch', key, details: `RGD=${rgdEntry.type}, Lua=${luaEntry.type}` });
            } else {
                issues.push({ kind: 'value_mismatch', key, details: `RGD=${JSON.stringify(rgdEntry.value)}, Lua=${JSON.stringify(luaEntry.value)}` });
            }
        }
    }

    for (const [key, luaEntry] of luaMap) {
        if (key.endsWith('.$ref')) continue;
        if (luaEntry.type === 'nil') continue;
        if (!rgdMap.has(key)) {
            issues.push({ kind: 'missing_in_rgd', key, details: `Lua: ${JSON.stringify(luaEntry.value)} (${luaEntry.type})` });
        }
    }

    return { rgdFile: rgdPath, luaFile: luaPath, totalKeys: rgdMap.size, issues, attribResolved: !!attribBase };
}

// ---------- File discovery ----------

const SKIP_SUFFIXES = ['.test.rgd', '.fromtext.rgd'];

function findRgdLuaPairs(folder: string): { rgd: string; lua: string | null }[] {
    const pairs: { rgd: string; lua: string | null }[] = [];
    function walk(dir: string) {
        let entries: fs.Dirent[];
        try { entries = fs.readdirSync(dir, { withFileTypes: true }); } catch { return; }
        for (const e of entries) {
            const full = path.join(dir, e.name);
            if (e.isDirectory()) { walk(full); continue; }
            if (!e.isFile() || !e.name.endsWith('.rgd')) continue;
            if (SKIP_SUFFIXES.some(s => e.name.endsWith(s))) continue;
            const lua = full.replace(/\.rgd$/i, '.lua');
            pairs.push({ rgd: full, lua: fs.existsSync(lua) ? lua : null });
        }
    }
    walk(folder);
    return pairs;
}

// ---------- Output formatting ----------

let _channel: vscode.OutputChannel | null = null;
function getChannel(): vscode.OutputChannel {
    if (!_channel) _channel = vscode.window.createOutputChannel('RGD Parity Checker');
    return _channel;
}

function formatResult(result: ParityResult, folder?: string): string {
    const rel = (p: string) => folder ? path.relative(folder, p) : path.basename(p);
    const status = result.error ? 'ERROR' : result.issues.length === 0 ? 'PASS ' : 'FAIL ';
    const luaLabel = result.luaFile ? rel(result.luaFile) : '(no .lua found)';
    const header = `[${status}] ${rel(result.rgdFile)} ↔ ${luaLabel}  [${result.totalKeys} keys | ${result.issues.length} issues${!result.attribResolved ? ' | ⚠ no attrib root' : ''}]`;

    if (result.error) return `${header}\n  ERROR: ${result.error}`;
    if (result.issues.length === 0) return header;

    const byKind: Record<string, ParityIssue[]> = {};
    for (const issue of result.issues) (byKind[issue.kind] ??= []).push(issue);

    const lines = [header];
    const section = (label: string, items?: ParityIssue[], max = 10) => {
        if (!items?.length) return;
        lines.push(`  ${label} (${items.length}):`);
        items.slice(0, max).forEach(i => lines.push(`    - ${i.key}: ${i.details}`));
        if (items.length > max) lines.push(`    ... and ${items.length - max} more`);
    };
    section('Missing in Lua (exists in RGD)', byKind.missing_in_lua);
    section('Missing in RGD (exists in Lua)', byKind.missing_in_rgd);
    section('Value Mismatches', byKind.value_mismatch);
    section('Type Mismatches', byKind.type_mismatch);
    section('Missing Reference Files', byKind.missing_ref, 50);
    return lines.join('\n');
}

// ---------- Command registration ----------

export function registerParityCommands(context: vscode.ExtensionContext) {

    context.subscriptions.push(vscode.commands.registerCommand('rgdSuite.checkParity', async (uri?: vscode.Uri) => {
        const dict = DictionaryManager.getInstance().getDictionary(context);
        const out = getChannel();
        out.show(true);

        const filePath = uri?.fsPath ?? vscode.window.activeTextEditor?.document.uri.fsPath;
        if (!filePath) { vscode.window.showErrorMessage('No file selected'); return; }

        let rgdPath: string, luaPath: string;
        if (filePath.endsWith('.rgd')) {
            rgdPath = filePath;
            luaPath = filePath.replace(/\.rgd$/i, '.lua');
        } else if (filePath.endsWith('.lua')) {
            luaPath = filePath;
            rgdPath = filePath.replace(/\.lua$/i, '.rgd');
        } else {
            vscode.window.showErrorMessage('Select a .rgd or .lua file');
            return;
        }

        if (!fs.existsSync(rgdPath)) { vscode.window.showErrorMessage(`RGD not found: ${path.basename(rgdPath)}`); return; }
        if (!fs.existsSync(luaPath)) { vscode.window.showErrorMessage(`Lua not found: ${path.basename(luaPath)}`); return; }

        out.appendLine(`\n${'─'.repeat(60)}`);
        out.appendLine(`Parity Check: ${path.basename(rgdPath)}  [${new Date().toLocaleTimeString()}]`);
        try {
            const result = checkParity(rgdPath, luaPath, dict);
            out.appendLine(formatResult(result));
            if (!result.attribResolved) {
                out.appendLine('  ⚠ Attrib root not found — parent references unresolved. Results may show false positives.');
            }
            if (result.issues.length === 0) {
                vscode.window.showInformationMessage(`✓ Parity OK: ${path.basename(rgdPath)}`);
            } else {
                vscode.window.showWarningMessage(`⚠ ${result.issues.length} discrepancy/ies in ${path.basename(rgdPath)} — see Output > RGD Parity Checker`);
            }
        } catch (e: any) {
            out.appendLine(`[ERROR] ${e.message}`);
            vscode.window.showErrorMessage(`Parity check failed: ${e.message}`);
        }
    }));

    context.subscriptions.push(vscode.commands.registerCommand('rgdSuite.batchCheckParity', async (uri?: vscode.Uri) => {
        const dict = DictionaryManager.getInstance().getDictionary(context);
        const out = getChannel();
        out.show(true);

        let folder = uri?.fsPath;
        if (!folder || !fs.existsSync(folder) || !fs.statSync(folder).isDirectory()) {
            const sel = await vscode.window.showOpenDialog({
                canSelectFiles: false, canSelectFolders: true, canSelectMany: false,
                openLabel: 'Select Folder to Batch Check'
            });
            if (!sel?.length) return;
            folder = sel[0].fsPath;
        }

        const pairs = findRgdLuaPairs(folder);
        if (pairs.length === 0) { vscode.window.showInformationMessage('No .rgd files found in folder'); return; }

        out.appendLine(`\n${'═'.repeat(60)}`);
        out.appendLine(`Batch Parity Check: ${path.basename(folder)}  [${new Date().toLocaleTimeString()}]`);
        out.appendLine(`Found ${pairs.length} RGD files | Folder: ${folder}`);
        out.appendLine('═'.repeat(60));

        let passed = 0, failed = 0, errored = 0, noLua = 0;
        const failedFiles: string[] = [];
        const fileCache = new Map<string, string | null>();

        await vscode.window.withProgress({
            location: vscode.ProgressLocation.Notification,
            title: 'RGD Batch Parity Check',
            cancellable: true
        }, async (progress, token) => {
            for (let i = 0; i < pairs.length; i++) {
                if (token.isCancellationRequested) { out.appendLine('⚠ Cancelled by user'); break; }
                const { rgd, lua } = pairs[i];
                progress.report({ message: `${path.basename(rgd)} (${i + 1}/${pairs.length})`, increment: 100 / pairs.length });

                if (!lua) {
                    out.appendLine(`[SKIP ] ${path.relative(folder!, rgd)} — no .lua counterpart`);
                    noLua++;
                    continue;
                }

                try {
                    const result = checkParity(rgd, lua, dict, fileCache);
                    out.appendLine(formatResult(result, folder));
                    result.issues.length === 0 ? passed++ : (failed++, failedFiles.push(path.relative(folder!, rgd)));
                } catch (e: any) {
                    out.appendLine(`[ERROR] ${path.relative(folder!, rgd)}: ${e.message}`);
                    errored++;
                }
            }
        });

        out.appendLine(`\n${'═'.repeat(60)}`);
        out.appendLine(`Summary: ${pairs.length} total | ${passed} pass | ${failed} fail | ${errored} error | ${noLua} skipped (no Lua)`);
        if (failedFiles.length) {
            out.appendLine('\nFailed files:');
            failedFiles.forEach(f => out.appendLine(`  ✗ ${f}`));
        }
        out.appendLine('═'.repeat(60));

        const msg = `Parity batch done: ${passed} pass, ${failed} fail, ${noLua} skipped`;
        failed > 0
            ? vscode.window.showWarningMessage(msg + ' — see Output > RGD Parity Checker')
            : vscode.window.showInformationMessage(msg);
    }));
}
