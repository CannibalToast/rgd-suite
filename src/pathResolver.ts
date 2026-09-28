import * as fs from "fs";
import * as path from "path";

const _DFS_CACHE_MAX = 2000;
const _dfsCache = new Map<string, string | undefined>();

// Per-attribRoot filename index. Built lazily on first fallback lookup; replaces
// a full directory DFS per miss (Tier 2 #8). Keyed on attribRoot absolute path.
interface FilenameIndex {
  byTail: Map<string, string[]>; // lowercase basename → absolute paths
}
const _FILENAME_INDEX_MAX_ROOTS = 8;
const _filenameIndexCache = new Map<string, FilenameIndex>();

export interface ResolvedPathInfo {
  path: string;
  exists: boolean;
}

export function resolveAttribPath(
  ref: string,
  attribRoot: string,
): ResolvedPathInfo {
  let normalizedRef = ref.replace(/\\/g, "/");
  if (normalizedRef.startsWith("/")) normalizedRef = normalizedRef.substring(1);

  // Reject traversal / absolute-style refs before joining.
  if (
    !normalizedRef ||
    normalizedRef.includes("\0") ||
    /^[a-zA-Z]:/.test(normalizedRef) ||
    normalizedRef.split("/").some((p) => p === "..")
  ) {
    return { path: path.join(attribRoot, "_invalid_ref_"), exists: false };
  }

  const attribRootNormalized = attribRoot.replace(/\\/g, "/");
  if (
    normalizedRef.toLowerCase().includes(attribRootNormalized.toLowerCase())
  ) {
    const index = normalizedRef
      .toLowerCase()
      .indexOf(attribRootNormalized.toLowerCase());
    normalizedRef = normalizedRef.substring(
      index + attribRootNormalized.length,
    );
    if (normalizedRef.startsWith("/"))
      normalizedRef = normalizedRef.substring(1);
  } else if (normalizedRef.toLowerCase().startsWith("data/attrib/")) {
    normalizedRef = normalizedRef.substring(12);
  } else if (normalizedRef.toLowerCase().startsWith("attrib/")) {
    normalizedRef = normalizedRef.substring(7);
  }

  const resolvedBase = path.resolve(attribRoot);
  const fullPath = path.resolve(resolvedBase, ...normalizedRef.split("/").filter(Boolean));
  const baseWithSep = resolvedBase.endsWith(path.sep)
    ? resolvedBase
    : resolvedBase + path.sep;
  if (fullPath !== resolvedBase && !fullPath.startsWith(baseWithSep)) {
    return { path: fullPath, exists: false };
  }
  if (fs.existsSync(fullPath)) return { path: fullPath, exists: true };

  const found = findInAttribRoot(normalizedRef, attribRoot);
  return { path: found ?? fullPath, exists: found ? true : false };
}

export function tryResolveValuePath(
  value: unknown,
  attribRoot: string,
): ResolvedPathInfo | undefined {
  if (typeof value !== "string") return undefined;
  if (
    !(/[\\/]/.test(value) || value.endsWith(".lua") || value.endsWith(".rgd"))
  )
    return undefined;
  return resolveAttribPath(value, attribRoot);
}

function getFilenameIndex(attribRoot: string): FilenameIndex {
  let idx = _filenameIndexCache.get(attribRoot);
  if (idx) return idx;

  // Cap cache so switching between many projects can't grow unbounded.
  if (_filenameIndexCache.size >= _FILENAME_INDEX_MAX_ROOTS) {
    const firstKey = _filenameIndexCache.keys().next().value;
    if (firstKey !== undefined) {
      _filenameIndexCache.delete(firstKey);
    }
  }

  const byTail = new Map<string, string[]>();
  const stack: string[] = [attribRoot];
  while (stack.length) {
    const dir = stack.pop()!;
    let entries: fs.Dirent[];
    try {
      entries = fs.readdirSync(dir, { withFileTypes: true });
    } catch {
      continue;
    }
    for (const entry of entries) {
      const full = path.join(dir, entry.name);
      if (entry.isDirectory()) {
        stack.push(full);
      } else if (entry.isFile()) {
        const key = entry.name.toLowerCase();
        const list = byTail.get(key);
        if (list) list.push(full);
        else byTail.set(key, [full]);
      }
    }
  }
  idx = { byTail };
  _filenameIndexCache.set(attribRoot, idx);
  return idx;
}

function findInAttribRoot(rel: string, attribRoot: string): string | undefined {
  const cacheKey = attribRoot + "\0" + rel;
  if (_dfsCache.has(cacheKey)) return _dfsCache.get(cacheKey);
  if (_dfsCache.size >= _DFS_CACHE_MAX) {
    const firstKey = _dfsCache.keys().next().value;
    if (firstKey !== undefined) {
      _dfsCache.delete(firstKey);
    }
  }

  const targetTail = rel.replace(/\\/g, "/");
  const parts = targetTail.split("/");
  const tailName = parts[parts.length - 1].toLowerCase();
  const attribRootNormLen = attribRoot.length + 1;

  const index = getFilenameIndex(attribRoot);
  const candidates = index.byTail.get(tailName);
  if (!candidates || candidates.length === 0) {
    _dfsCache.set(cacheKey, undefined);
    return undefined;
  }

  if (parts.length === 1) {
    // Single basename — any match wins (first one in traversal order).
    _dfsCache.set(cacheKey, candidates[0]);
    return candidates[0];
  }

  const targetTailLower = targetTail.toLowerCase();
  for (const candidate of candidates) {
    const relFromRoot = candidate
      .substring(attribRootNormLen)
      .replace(/\\/g, "/")
      .toLowerCase();
    if (relFromRoot.endsWith(targetTailLower)) {
      _dfsCache.set(cacheKey, candidate);
      return candidate;
    }
  }
  _dfsCache.set(cacheKey, undefined);
  return undefined;
}

const IMAGE_EXTS = [
  ".tga",
  ".dds",
  ".png",
  ".jpg",
  ".jpeg",
  ".bmp",
  ".gif",
  ".webp",
];

// Case-insensitive subdirectory lookup — mod folders mix Data/Art casing.
function findDirCaseInsensitive(
  parent: string,
  name: string,
): string | undefined {
  try {
    const hit = fs
      .readdirSync(parent, { withFileTypes: true })
      .find((d) => d.isDirectory() && d.name.toLowerCase() === name);
    return hit ? path.join(parent, hit.name) : undefined;
  } catch {
    return undefined;
  }
}

// Per-attribRoot image roots — readdir hits add up when resolving per node.
const _imageRootsCache = new Map<string, string[]>();

/**
 * Directories to search for image files, given an attrib root. Art sits next
 * to attrib: <mod>/data/art for the data/attrib layout, <mod>/art or
 * <mod>/data/art for bare attrib roots. attribRoot itself is last (rare).
 */
export function imageSearchRoots(attribRoot: string): string[] {
  const hit = _imageRootsCache.get(attribRoot);
  if (hit) return hit;
  if (_imageRootsCache.size >= _FILENAME_INDEX_MAX_ROOTS) {
    const firstKey = _imageRootsCache.keys().next().value;
    if (firstKey !== undefined) _imageRootsCache.delete(firstKey);
  }
  const parent = path.dirname(attribRoot);
  const roots: string[] = [];
  const add = (dir?: string) => {
    if (dir && !roots.includes(dir)) roots.push(dir);
  };
  add(findDirCaseInsensitive(parent, "art"));
  if (path.basename(parent).toLowerCase() !== "data") {
    const dataDir = findDirCaseInsensitive(parent, "data");
    if (dataDir) add(findDirCaseInsensitive(dataDir, "art"));
  }
  add(attribRoot);
  _imageRootsCache.set(attribRoot, roots);
  return roots;
}

/**
 * Resolve a string value to an image file on disk — any value whose tail
 * carries an image extension, or an extensionless path tried against each
 * image extension (icon names like `chaos_icons/hq_upgrade_2_icon` land in
 * art/ebps/races/<race>/texture_icons/, so tail-match via the filename index
 * is what actually finds them).
 */
export function resolveImagePath(
  value: unknown,
  attribRoot: string,
): ResolvedPathInfo | undefined {
  if (typeof value !== "string") return undefined;
  const lower = value.toLowerCase();
  const hasImgExt = IMAGE_EXTS.some((e) => lower.endsWith(e));
  if (!hasImgExt && !/[\\/]/.test(value)) return undefined;
  const base = value.replace(/\\/g, "/").replace(/^\/+/, "");
  if (
    !base ||
    base.includes("\0") ||
    /^[a-zA-Z]:/.test(base) ||
    base.split("/").some((p) => p === "..")
  ) {
    return undefined;
  }
  const tail = base.split("/").pop()!;
  const dot = tail.lastIndexOf(".");
  if (dot > 0 && !hasImgExt) return undefined; // real non-image extension
  const candidates = hasImgExt ? [base] : IMAGE_EXTS.map((e) => base + e);
  for (const root of imageSearchRoots(attribRoot)) {
    for (const rel of candidates) {
      const full = path.resolve(root, ...rel.split("/"));
      if (fs.existsSync(full)) return { path: full, exists: true };
    }
    for (const rel of candidates) {
      const found = findInAttribRoot(rel, root);
      if (found) return { path: found, exists: true };
    }
  }
  return undefined;
}

/**
 * Invalidate filename index for the given attrib root (or all roots if
 * omitted). Call when disk contents change in a watched folder.
 */
export function invalidateAttribIndex(attribRoot?: string): void {
  if (attribRoot) {
    // Image resolution also indexes the sibling art roots — clear those too.
    for (const root of [attribRoot, ...imageSearchRoots(attribRoot)]) {
      _filenameIndexCache.delete(root);
      const prefix = root + "\0";
      for (const k of _dfsCache.keys()) {
        if (k.startsWith(prefix)) _dfsCache.delete(k);
      }
    }
    _imageRootsCache.delete(attribRoot);
  } else {
    _filenameIndexCache.clear();
    _imageRootsCache.clear();
    _dfsCache.clear();
  }
}
