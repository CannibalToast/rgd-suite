/**
 * Key-level table diff for RGD files (working tree vs git / arbitrary buffers).
 * Reuses flatten semantics compatible with parity checks (dot-separated keys).
 */
import { execFile } from "child_process";
import { promisify } from "util";
import * as fs from "fs";
import * as path from "path";
import { parseRgd } from "../bundled/rgd-tools/dist/reader";
import {
  HashDictionary,
  RgdDataType,
  RgdTable,
} from "../bundled/rgd-tools/dist/types";

const execFileAsync = promisify(execFile);
const FLOAT_EPSILON = 1e-4;

export type FlatScalarType = "float" | "int" | "bool" | "string";

export interface FlatScalar {
  type: FlatScalarType;
  value: number | boolean | string;
}

export type TableDiffKind = "added" | "removed" | "changed";

export interface TableDiffEntry {
  kind: TableDiffKind;
  key: string;
  oldValue?: FlatScalar;
  newValue?: FlatScalar;
}

export interface TableDiffResult {
  filePath: string;
  baseRef: string;
  totalKeys: number;
  entries: TableDiffEntry[];
  error?: string;
}

type FlatMap = Map<string, FlatScalar>;

function flattenRgd(
  table: RgdTable,
  prefix = "",
  result?: FlatMap,
): FlatMap {
  const out = result ?? new Map<string, FlatScalar>();
  for (const entry of table.entries) {
    const k = entry.name ?? `#${entry.hash.toString(16).padStart(8, "0")}`;
    const full = prefix ? `${prefix}.${k}` : k;
    switch (entry.type) {
      case RgdDataType.Table:
      case RgdDataType.TableInt: {
        const sub = entry.value as RgdTable;
        if (sub) flattenRgd(sub, full, out);
        break;
      }
      case RgdDataType.Float:
        out.set(full, { type: "float", value: entry.value as number });
        break;
      case RgdDataType.Integer:
        out.set(full, { type: "int", value: entry.value as number });
        break;
      case RgdDataType.Bool:
        out.set(full, { type: "bool", value: entry.value as boolean });
        break;
      case RgdDataType.String:
      case RgdDataType.WString:
        if (k === "$REF") break;
        out.set(full, { type: "string", value: entry.value as string });
        break;
      case RgdDataType.NoData:
        break;
    }
  }
  return out;
}

function valuesEqual(a: FlatScalar, b: FlatScalar): boolean {
  const numeric = (t: string) => t === "float" || t === "int";
  if (numeric(a.type) && numeric(b.type)) {
    return Math.abs((a.value as number) - (b.value as number)) <= FLOAT_EPSILON;
  }
  if (a.type !== b.type) return false;
  return a.value === b.value;
}

/** Diff two flat maps. `base` = older (git), `current` = working tree. */
export function diffFlatMaps(
  base: FlatMap,
  current: FlatMap,
): TableDiffEntry[] {
  const entries: TableDiffEntry[] = [];
  for (const [key, cur] of current) {
    if (key.endsWith(".$ref") || key.endsWith(".$REF")) continue;
    const old = base.get(key);
    if (!old) {
      entries.push({ kind: "added", key, newValue: cur });
    } else if (!valuesEqual(old, cur)) {
      entries.push({
        kind: "changed",
        key,
        oldValue: old,
        newValue: cur,
      });
    }
  }
  for (const [key, old] of base) {
    if (key.endsWith(".$ref") || key.endsWith(".$REF")) continue;
    if (!current.has(key)) {
      entries.push({ kind: "removed", key, oldValue: old });
    }
  }
  entries.sort((a, b) => a.key.localeCompare(b.key));
  return entries;
}

export function flattenRgdBuffer(
  buffer: Buffer,
  dict: HashDictionary,
): FlatMap {
  const rgd = parseRgd(buffer, dict);
  return flattenRgd(rgd.gameData);
}

export function flattenRgdFile(
  filePath: string,
  dict: HashDictionary,
): FlatMap {
  return flattenRgdBuffer(fs.readFileSync(filePath), dict);
}

/**
 * Diff working-tree RGD against a git revision (default HEAD).
 * Returns a structured result for UI / CLI.
 */
export async function diffRgdAgainstGit(
  filePath: string,
  dict: HashDictionary,
  ref = "HEAD",
): Promise<TableDiffResult> {
  const abs = path.resolve(filePath);
  if (!fs.existsSync(abs)) {
    return {
      filePath: abs,
      baseRef: ref,
      totalKeys: 0,
      entries: [],
      error: `File not found: ${abs}`,
    };
  }

  let baseBuf: Buffer;
  try {
    baseBuf = await gitShow(abs, ref);
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e);
    return {
      filePath: abs,
      baseRef: ref,
      totalKeys: 0,
      entries: [],
      error: msg,
    };
  }

  try {
    const baseMap = flattenRgdBuffer(baseBuf, dict);
    const curMap = flattenRgdFile(abs, dict);
    const entries = diffFlatMaps(baseMap, curMap);
    return {
      filePath: abs,
      baseRef: ref,
      totalKeys: curMap.size,
      entries,
    };
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e);
    return {
      filePath: abs,
      baseRef: ref,
      totalKeys: 0,
      entries: [],
      error: msg,
    };
  }
}

/** Diff two RGD buffers (e.g. left/right panes without git). */
export function diffRgdBuffers(
  baseBuf: Buffer,
  currentBuf: Buffer,
  dict: HashDictionary,
  labels: { filePath?: string; baseRef?: string } = {},
): TableDiffResult {
  const baseMap = flattenRgdBuffer(baseBuf, dict);
  const curMap = flattenRgdBuffer(currentBuf, dict);
  return {
    filePath: labels.filePath ?? "",
    baseRef: labels.baseRef ?? "base",
    totalKeys: curMap.size,
    entries: diffFlatMaps(baseMap, curMap),
  };
}

/**
 * Ancestor prefixes for a dotted key so tree ancestors can highlight when a leaf changes.
 * e.g. "GameData.squad.max_size" → ["GameData", "GameData.squad", "GameData.squad.max_size"]
 */
export function keyAncestorPrefixes(key: string): string[] {
  const parts = key.split(".");
  const out: string[] = [];
  for (let i = 0; i < parts.length; i++) {
    out.push(parts.slice(0, i + 1).join("."));
  }
  return out;
}

/** Map key path → kind for UI highlight (prefer leaf kind; ancestors get 'changed' if any child). */
export function buildDiffHighlightMap(
  entries: TableDiffEntry[],
): Record<string, TableDiffKind> {
  const map: Record<string, TableDiffKind> = {};
  for (const e of entries) {
    map[e.key] = e.kind;
    const parts = e.key.split(".");
    for (let i = 1; i < parts.length; i++) {
      const anc = parts.slice(0, i).join(".");
      if (!map[anc] || map[anc] === "changed") {
        // Keep leaf-specific kinds; mark pure ancestors as changed when a child differs.
        if (!map[anc]) map[anc] = "changed";
      }
    }
  }
  return map;
}

async function gitShow(filePath: string, ref: string): Promise<Buffer> {
  const dir = path.dirname(filePath);
  // Resolve repo root and relative path so nested worktrees work.
  const { stdout: rootOut } = await execFileAsync(
    "git",
    ["-C", dir, "rev-parse", "--show-toplevel"],
    { encoding: "utf8", maxBuffer: 2 * 1024 * 1024 },
  );
  const root = rootOut.trim();
  const rel = path.relative(root, filePath).replace(/\\/g, "/");
  if (rel.startsWith("..") || path.isAbsolute(rel)) {
    throw new Error("File is outside the git repository");
  }
  try {
    const { stdout } = await execFileAsync(
      "git",
      ["-C", root, "show", `${ref}:${rel}`],
      { encoding: "buffer", maxBuffer: 32 * 1024 * 1024 },
    );
    return Buffer.isBuffer(stdout) ? stdout : Buffer.from(stdout);
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e);
    if (/exists on disk, but not in|does not exist|pathspec|bad object/i.test(msg)) {
      throw new Error(
        `No version of this file at ${ref} (new/untracked or bad ref).`,
      );
    }
    throw new Error(`git show failed: ${msg.split("\n")[0]}`);
  }
}
