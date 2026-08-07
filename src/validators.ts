import * as fs from "fs";
import * as path from "path";
import { ParsedLuaTable } from "../bundled/rgd-tools/dist/luaFormat";
import { RgdTable } from "../bundled/rgd-tools/dist/types";

const ABSOLUTE_RE = /^[a-zA-Z]:[\\/]|^\\\\|^\//;

const PATH_LIKE_VALUE_KEYS = new Set([
  "research_name",
  "structure_name",
  "weapon_name",
  "entity_name",
  "addon_name",
  "squad_name",
  "entity_blueprint",
  "squad_blueprint",
  "modifier_name",
  "parent_name",
  "inherit_from",
]);

export type ValidationIssueKind =
  | "path_traversal"
  | "null_byte"
  | "absolute_path"
  | "missing_file"
  | "relocated_ref"
  | "encoding_mismatch"
  | "bom_detected"
  | "invalid_reference"
  | "folder_structure";

export type ValidationSeverity = "error" | "warning";

export interface ValidationIssue {
  kind: ValidationIssueKind;
  severity: ValidationSeverity;
  path: string;
  details: string;
  key?: string;
  bom?: BOMType;
}

export type BOMType = "utf8" | "utf16le" | "utf16be" | "utf32le" | "utf32be" | null;

export interface BOMInfo {
  detected: boolean;
  type: BOMType;
  bytes: number[];
}

export interface EncodingResult {
  isValid: boolean;
  encoding: "utf8" | "utf16" | "utf32" | "unknown";
  hasBOM: boolean;
  issues: ValidationIssue[];
}

function makeIssue(
  kind: ValidationIssueKind,
  issuePath: string,
  details: string,
  extra: Partial<ValidationIssue> = {},
): ValidationIssue {
  return {
    kind,
    severity: kind === "bom_detected" ? "warning" : "error",
    path: issuePath,
    details,
    ...extra,
  };
}

export function detectBOM(buffer: Buffer): BOMInfo {
  const signatures: Array<[Exclude<BOMType, null>, number[]]> = [
    ["utf32le", [0xff, 0xfe, 0x00, 0x00]],
    ["utf32be", [0x00, 0x00, 0xfe, 0xff]],
    ["utf8", [0xef, 0xbb, 0xbf]],
    ["utf16le", [0xff, 0xfe]],
    ["utf16be", [0xfe, 0xff]],
  ];
  for (const [type, bytes] of signatures) {
    if (buffer.length >= bytes.length && bytes.every((b, i) => buffer[i] === b)) {
      return { detected: true, type, bytes };
    }
  }
  return { detected: false, type: null, bytes: [] };
}

export function validateEncoding(buffer: Buffer, filePath = ""): EncodingResult {
  const bom = detectBOM(buffer);
  const issues: ValidationIssue[] = [];
  if (bom.detected) {
    issues.push(
      makeIssue("bom_detected", filePath, `BOM detected: ${bom.type}`, {
        bom: bom.type,
      }),
    );
  }

  const sample = buffer.subarray(0, Math.min(buffer.length, 4096));
  let nulCount = 0;
  for (const byte of sample) {
    if (byte === 0) nulCount++;
  }
  if (sample.length > 0 && nulCount / sample.length > 0.1) {
    issues.push(
      makeIssue(
        "encoding_mismatch",
        filePath,
        "Text file contains many NUL bytes; expected UTF-8-compatible Lua/text",
      ),
    );
  }

  return {
    isValid: !issues.some((i) => i.kind === "encoding_mismatch"),
    encoding: bom.type
      ? bom.type.startsWith("utf16")
        ? "utf16"
        : bom.type.startsWith("utf32")
          ? "utf32"
          : "utf8"
      : "utf8",
    hasBOM: bom.detected,
    issues,
  };
}

export interface ValidationFix {
  kind: "bom_stripped";
  severity: "info";
  path: string;
  details: string;
}

export function stripUtf8BomFromFile(
  filePath: string,
  buffer: Buffer = fs.readFileSync(filePath),
): { fixed: boolean; buffer: Buffer; fix?: ValidationFix } {
  if (detectBOM(buffer).type !== "utf8") {
    return { fixed: false, buffer };
  }
  const stripped = buffer.subarray(3);
  fs.writeFileSync(filePath, stripped);
  return {
    fixed: true,
    buffer: stripped,
    fix: {
      kind: "bom_stripped",
      severity: "info",
      path: filePath,
      details: "Removed UTF-8 BOM",
    },
  };
}

export function validateFilePath(filePath: string): ValidationIssue[] {
  const issues: ValidationIssue[] = [];
  if (!filePath || typeof filePath !== "string") {
    return [
      makeIssue(
        "invalid_reference",
        String(filePath || ""),
        "Path is empty or not a string",
      ),
    ];
  }
  if (filePath.includes("\0")) {
    issues.push(
      makeIssue(
        "null_byte",
        filePath.replace(/\0/g, "\\0"),
        "Path contains a null byte",
      ),
    );
  }
  if (ABSOLUTE_RE.test(filePath)) {
    issues.push(
      makeIssue(
        "absolute_path",
        filePath,
        "Path is absolute; attrib references must be relative",
      ),
    );
  }
  const parts = filePath.replace(/\\/g, "/").split("/");
  if (parts.some((part) => part === "..")) {
    issues.push(
      makeIssue(
        "path_traversal",
        filePath,
        "Path contains parent-directory traversal",
      ),
    );
  }
  return issues;
}

function normalizeAttribRef(refPath: string): string {
  return refPath
    .replace(/\\/g, "/")
    .trim()
    .replace(/^\/+/, "")
    .replace(/^data\/attrib\//i, "")
    .replace(/^ua_data\/attrib\//i, "")
    .replace(/^attrib\//i, "");
}

export function isNilReference(refPath: string): boolean {
  return /\.nil$/i.test(refPath.replace(/\\/g, "/").trim());
}

function isInsideBase(candidate: string, base: string): boolean {
  const lowerCandidate = path.resolve(candidate).toLowerCase();
  const lowerBase = path.resolve(base).toLowerCase();
  return lowerCandidate === lowerBase || lowerCandidate.startsWith(lowerBase + path.sep);
}

const _realpathCache = new Map<string, string>();
const REALPATH_CACHE_MAX = 4000;

function cachedRealpath(p: string): string {
  const key = path.resolve(p);
  const hit = _realpathCache.get(key);
  if (hit !== undefined) return hit;
  const resolved = fs.realpathSync(key);
  if (_realpathCache.size >= REALPATH_CACHE_MAX) {
    const first = _realpathCache.keys().next().value;
    if (first !== undefined) _realpathCache.delete(first);
  }
  _realpathCache.set(key, resolved);
  return resolved;
}

function isExistingPathInsideBase(candidate: string, base: string): boolean {
  if (!fs.existsSync(candidate)) return false;
  const resolvedCandidate = path.resolve(candidate).toLowerCase();
  const resolvedBase = path.resolve(base).toLowerCase();
  if (
    resolvedCandidate === resolvedBase ||
    resolvedCandidate.startsWith(resolvedBase + path.sep)
  ) {
    return true;
  }
  // Symlink/junction escape fallback
  try {
    return isInsideBase(cachedRealpath(candidate), cachedRealpath(base));
  } catch {
    return false;
  }
}

const _attribIndexCache = new Map<string, Map<string, string[]>>();

function getAttribIndex(attribBase: string): Map<string, string[]> {
  const cacheKey = path.resolve(attribBase).toLowerCase();
  let index = _attribIndexCache.get(cacheKey);
  if (index) return index;
  index = new Map<string, string[]>();
  const walk = (dir: string): void => {
    let entries: fs.Dirent[];
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
        let list = index!.get(lower);
        if (!list) {
          list = [];
          index!.set(lower, list);
        }
        list.push(full);
      }
    }
  };
  walk(attribBase);
  _attribIndexCache.set(cacheKey, index);
  return index;
}

/** Clear the attrib tree index cache. Pass a path to invalidate a single
 *  attribBase, or omit to clear all cached indices. */
export function clearAttribIndex(attribBase?: string): void {
  if (attribBase) {
    _attribIndexCache.delete(path.resolve(attribBase).toLowerCase());
  } else {
    _attribIndexCache.clear();
  }
}

function resolveRefCandidates(refPath: string, attribBase: string): string[] {
  const pathIssues = validateFilePath(refPath);
  if (pathIssues.some((i) => i.severity === "error")) return [];
  const clean = normalizeAttribRef(refPath).replace(/\.(lua|rgd)$/i, "");
  const literalCandidates = [`${clean}.lua`, `${clean}.rgd`]
    .map((c) => path.resolve(attribBase, c))
    .filter((c) => isInsideBase(c, attribBase));

  // Fast path: if any literal candidate exists on disk, return only those
  // that exist — no need to scan the tree.
  const existingLiteral = literalCandidates.filter((c) =>
    isExistingPathInsideBase(c, attribBase),
  );
  if (existingLiteral.length > 0) return existingLiteral;

  // Basename fallback: ONLY for prefix-less references (a bare filename with
  // no folder component). This handles the common Dawn of War pattern where
  // an ability's requirements field references "heavy_weapons_research"
  // without the "research/" prefix. Prefixed references (e.g.
  // "research/typo_name") are authoritative — if the literal path doesn't
  // exist, it's a wrong name and must be flagged, not rescued.
  const hasFolder = clean.includes("/");
  if (hasFolder) return literalCandidates;

  const baseName = clean.toLowerCase();
  const index = getAttribIndex(attribBase);
  const fallback: string[] = [];
  for (const ext of [".lua", ".rgd"]) {
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

function refExists(refPath: string, attribBase: string): boolean {
  for (const candidate of resolveRefCandidates(refPath, attribBase)) {
    if (isExistingPathInsideBase(candidate, attribBase)) return true;
  }
  return false;
}

function isPathLikeValueKey(key: string): boolean {
  return PATH_LIKE_VALUE_KEYS.has(key);
}

function shouldValidateStringValue(key: string, value: unknown): value is string {
  if (typeof value !== "string" || !value) return false;
  // $REF is already validated via table.reference / entry.reference
  if (key === "$REF") return false;
  if (value.startsWith("$")) return false;
  if (isPathLikeValueKey(key)) return looksLikeFileRef(value);
  return /\.(lua|rgd)$/i.test(value);
}

function isTypeInternalRef(refPath: string): boolean {
  const first = refPath.replace(/\\/g, "/").split("/")[0].toLowerCase();
  return first.startsWith("type_");
}

function looksLikeFileRef(refPath: string): boolean {
  return /[\\/]/.test(refPath) || /\.(lua|rgd)$/i.test(refPath);
}

function resolveValueRef(
  refPath: string,
  attribBase: string,
  extension?: string,
): { resolved: boolean; path?: string; fallback?: boolean; invalid?: boolean } {
  if (isNilReference(refPath)) return { resolved: true };
  const pathIssues = validateFilePath(refPath);
  if (pathIssues.some((i) => i.severity === "error")) {
    return { resolved: false, invalid: true };
  }
  if (isTypeInternalRef(refPath)) return { resolved: true };

  let clean = normalizeAttribRef(refPath);
  if (extension) clean = clean.replace(/\.(lua|rgd)$/i, "");
  const ext =
    (extension && extension.toLowerCase()) ||
    (clean.toLowerCase().endsWith(".rgd") ? ".rgd" : ".lua");
  if (!clean.toLowerCase().endsWith(".lua") && !clean.toLowerCase().endsWith(".rgd")) {
    clean += ext;
  }
  const hasFolder = clean.includes("/");
  const candidate = path.resolve(attribBase, clean);
  if (isInsideBase(candidate, attribBase) && isExistingPathInsideBase(candidate, attribBase)) {
    return { resolved: true, path: candidate };
  }

  const baseName = path.basename(clean).toLowerCase();
  if (baseName) {
    const index = getAttribIndex(attribBase);
    const baseNoExt = baseName.replace(/\.(lua|rgd)$/i, "");
    for (const tryExt of [".lua", ".rgd"]) {
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

function validateValueReference(
  refPath: unknown,
  attribBase: string | null,
  key: string,
): ValidationIssue[] {
  if (typeof refPath !== "string" || !refPath) return [];
  if (isNilReference(refPath)) return [];
  if (isTypeInternalRef(refPath)) return [];
  if (!looksLikeFileRef(refPath)) return [];
  const issues: ValidationIssue[] = validateFilePath(refPath).map((i) => ({
    ...i,
    key,
  }));
  if (issues.some((i) => i.severity === "error")) return issues;
  if (!attribBase) {
    issues.push(
      makeIssue(
        "invalid_reference",
        refPath,
        "Attrib root was not resolved; reference could not be checked",
        { key },
      ),
    );
    return issues;
  }
  const r = resolveValueRef(refPath, attribBase, ".lua");
  if (r.resolved && r.fallback) {
    issues.push(
      makeIssue(
        "relocated_ref",
        refPath,
        `Resolved by basename fallback: ${r.path} (consider updating the exact path)`,
        { key, severity: "warning" },
      ),
    );
  } else if (!r.resolved) {
    issues.push(
      makeIssue(
        "missing_file",
        refPath,
        `Reference not found under attrib root: ${refPath}`,
        { key },
      ),
    );
  }
  return issues;
}

function findBasenameRelocation(refPath: string, attribBase: string): string | null {
  const clean = normalizeAttribRef(refPath).replace(/\.(lua|rgd)$/i, "");
  if (!clean.includes("/")) return null;
  const baseNoExt = path.basename(clean).toLowerCase();
  if (!baseNoExt) return null;
  const index = getAttribIndex(attribBase);
  for (const tryExt of [".lua", ".rgd"]) {
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

function validateReferencePath(
  refPath: string,
  attribBase: string | null,
  key: string,
): ValidationIssue[] {
  if (isNilReference(refPath)) return [];
  if (isTypeInternalRef(refPath)) return [];
  const issues: ValidationIssue[] = validateFilePath(refPath).map((i) => ({
    ...i,
    key,
  }));
  if (issues.some((i) => i.severity === "error")) return issues;
  if (!attribBase) {
    issues.push(
      makeIssue(
        "invalid_reference",
        refPath,
        "Attrib root was not resolved; reference could not be checked",
        { key },
      ),
    );
    return issues;
  }
  if (refExists(refPath, attribBase)) return issues;

  // Prefixed path missed the literal location, but the basename exists elsewhere.
  // Report as relocated_ref so wrong-prefix / wrong-race folder mismatches are visible.
  const relocated = findBasenameRelocation(refPath, attribBase);
  if (relocated) {
    issues.push(
      makeIssue(
        "relocated_ref",
        refPath,
        `Resolved by basename fallback: ${relocated} (consider updating the exact path)`,
        { key, severity: "warning" },
      ),
    );
  } else {
    issues.push(
      makeIssue(
        "missing_file",
        refPath,
        `Reference not found under attrib root: ${refPath}`,
        { key },
      ),
    );
  }
  return issues;
}

export function validateLuaReferences(
  table: ParsedLuaTable,
  attribBase: string | null,
  prefix = "GameData",
): ValidationIssue[] {
  const issues: ValidationIssue[] = [];
  if (table?.reference) {
    issues.push(...validateReferencePath(table.reference, attribBase, prefix));
  }
  if (!table?.entries || typeof table.entries[Symbol.iterator] !== "function") {
    return issues;
  }
  for (const [key, entry] of table.entries) {
    const full = `${prefix}.${key}`;
    if (entry.reference) {
      issues.push(...validateReferencePath(entry.reference, attribBase, full));
    }
    if (shouldValidateStringValue(key, entry.value)) {
      issues.push(...validateValueReference(entry.value, attribBase, full));
    }
    if (entry.type === "table" && entry.table) {
      issues.push(...validateLuaReferences(entry.table, attribBase, full));
    }
  }
  return issues;
}

export function validateRgdReferences(
  table: RgdTable,
  attribBase: string | null,
  prefix = "GameData",
): ValidationIssue[] {
  const issues: ValidationIssue[] = [];
  if (table?.reference) {
    issues.push(...validateReferencePath(table.reference, attribBase, prefix));
  }
  if (!table?.entries || !Array.isArray(table.entries)) {
    return issues;
  }
  for (const entry of table.entries) {
    const key = entry.name ?? `#${entry.hash.toString(16).padStart(8, "0")}`;
    const full = `${prefix}.${key}`;
    // Legacy/hand-built tables may put $REF on the entry itself
    if (entry.reference) {
      issues.push(...validateReferencePath(entry.reference, attribBase, full));
    }
    // Binary reader stores $REF on nested table.reference (validated via recursion)
    // Path-carrying string / wstring leaves
    if (typeof entry.value === "string" && shouldValidateStringValue(key, entry.value)) {
      issues.push(...validateValueReference(entry.value, attribBase, full));
    }
    // Recurse into any table-shaped child so nesting depth never drops refs
    if (
      entry.value &&
      typeof entry.value === "object" &&
      "entries" in entry.value &&
      Array.isArray((entry.value as RgdTable).entries)
    ) {
      issues.push(...validateRgdReferences(entry.value as RgdTable, attribBase, full));
    }
  }
  return issues;
}

export function validateFolderStructure(folder: string): ValidationIssue[] {
  if (!folder || !fs.existsSync(folder) || !fs.statSync(folder).isDirectory()) {
    return [makeIssue("folder_structure", folder, "Folder does not exist")];
  }
  const hasExpected = ["ebps", "sbps"].some((name) =>
    fs.existsSync(path.join(folder, name)),
  );
  if (!hasExpected) {
    return [
      makeIssue(
        "folder_structure",
        folder,
        "Folder does not look like an attrib root; expected ebps/ or sbps/",
      ),
    ];
  }
  return [];
}

export function stripUtf8Bom(text: string): string {
  return text.replace(/^\uFEFF/, "");
}
