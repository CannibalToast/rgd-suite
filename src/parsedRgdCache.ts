import * as fs from "fs";
import * as path from "path";
import { LRUCache } from "lru-cache";
import { parseRgd } from "../bundled/rgd-tools/dist/reader";
import { rgdToText } from "../bundled/rgd-tools/dist/textFormat";
import { HashDictionary, RgdFile } from "../bundled/rgd-tools/dist/types";
import { rgdToTree, RgdNode, resolveNodePaths } from "./rgdTable";
import { LocaleManager } from "./localeManager";
import { findAttribBase } from "./attribUtils";
import * as vscode from "vscode";

export interface ParsedRgdEntry {
  mtimeMs: number;
  rgd: RgdFile;
  vfsText?: string;
  treeNodes?: RgdNode[];
  attribRoot?: string;
  pathsResolved?: boolean;
}

let maxEntries = 50;

function createCache(cap: number): LRUCache<string, ParsedRgdEntry> {
  return new LRUCache<string, ParsedRgdEntry>({
    max: cap,
    ttl: 1000 * 60 * 30,
    updateAgeOnGet: true,
    allowStale: false,
    ttlAutopurge: true,
  });
}

let _cache = createCache(maxEntries);

export function configureParsedRgdCacheLimits(vfsSize?: number, treeSize?: number): void {
  const cap = Math.max(1, vfsSize ?? treeSize ?? maxEntries);
  maxEntries = cap;
  const newCache = createCache(cap);
  // Preserve the most-recently-used entries up to the new limit.
  let kept = 0;
  for (const [k, v] of _cache.entries()) {
    if (kept >= cap) break;
    newCache.set(k, v);
    kept++;
  }
  _cache = newCache;
}

function touch(fsPath: string, entry: ParsedRgdEntry): void {
  _cache.set(fsPath, entry);
}

function evictIfNeeded(): void {
  // LRUCache evicts automatically on set when over capacity.
}

function localeEnabled(): boolean {
  return vscode.workspace
    .getConfiguration("rgdEditor")
    .get("resolveLocaleStrings", true);
}

export async function getParsedRgd(
  fsPath: string,
  dict: HashDictionary,
): Promise<ParsedRgdEntry> {
  const stat = await fs.promises.stat(fsPath);
  const hit = _cache.get(fsPath);
  if (hit && hit.mtimeMs === stat.mtimeMs) {
    touch(fsPath, hit);
    return hit;
  }

  const buffer = await fs.promises.readFile(fsPath);
  const rgd = parseRgd(buffer, dict);
  const entry: ParsedRgdEntry = { mtimeMs: stat.mtimeMs, rgd };
  touch(fsPath, entry);
  evictIfNeeded();
  return entry;
}

export async function getVfsText(
  fsPath: string,
  dict: HashDictionary,
): Promise<string> {
  const entry = await getParsedRgd(fsPath, dict);
  if (entry.vfsText !== undefined) return entry.vfsText;

  const localeMap = localeEnabled()
    ? LocaleManager.getInstance().getLocaleMap(fsPath)
    : undefined;
  entry.vfsText = rgdToText(entry.rgd, path.basename(fsPath), localeMap);
  touch(fsPath, entry);
  return entry.vfsText;
}

export async function getTreeNodes(
  fsPath: string,
  dict: HashDictionary,
  options?: { resolvePaths?: boolean },
): Promise<{ nodes: RgdNode[]; rgd: RgdFile; attribRoot?: string }> {
  const resolvePaths = options?.resolvePaths !== false;
  const entry = await getParsedRgd(fsPath, dict);
  const attribRoot = findAttribBase(fsPath) ?? undefined;

  if (
    entry.treeNodes &&
    entry.attribRoot === attribRoot &&
    (!resolvePaths || entry.pathsResolved)
  ) {
    touch(fsPath, entry);
    return { nodes: entry.treeNodes, rgd: entry.rgd, attribRoot };
  }

  const localeMap = localeEnabled()
    ? LocaleManager.getInstance().getLocaleMap(fsPath)
    : undefined;
  entry.treeNodes = rgdToTree(entry.rgd.gameData, attribRoot, localeMap, {
    resolvePaths,
  });
  entry.attribRoot = attribRoot;
  entry.pathsResolved = resolvePaths;
  touch(fsPath, entry);

  if (attribRoot && !resolvePaths) {
    setImmediate(() => {
      if (entry.treeNodes && attribRoot) {
        resolveNodePaths(entry.treeNodes, attribRoot);
        entry.pathsResolved = true;
        touch(fsPath, entry);
      }
    });
  }

  return { nodes: entry.treeNodes, rgd: entry.rgd, attribRoot };
}

export function invalidateParsedRgdCache(fsPath?: string): void {
  if (!fsPath) {
    _cache.clear();
    return;
  }
  _cache.delete(fsPath);
}
