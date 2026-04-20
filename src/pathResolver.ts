import * as fs from 'fs';
import * as path from 'path';

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

export function resolveAttribPath(ref: string, attribRoot: string): ResolvedPathInfo {
  let normalizedRef = ref.replace(/\\/g, '/');
  if (normalizedRef.startsWith('/')) normalizedRef = normalizedRef.substring(1);

  const attribRootNormalized = attribRoot.replace(/\\/g, '/');
  if (normalizedRef.toLowerCase().includes(attribRootNormalized.toLowerCase())) {
    const index = normalizedRef.toLowerCase().indexOf(attribRootNormalized.toLowerCase());
    normalizedRef = normalizedRef.substring(index + attribRootNormalized.length);
    if (normalizedRef.startsWith('/')) normalizedRef = normalizedRef.substring(1);
  } else if (normalizedRef.toLowerCase().startsWith('data/attrib/')) {
    normalizedRef = normalizedRef.substring(12);
  } else if (normalizedRef.toLowerCase().startsWith('attrib/')) {
    normalizedRef = normalizedRef.substring(7);
  }

  const fullPath = path.join(attribRoot, normalizedRef);
  if (fs.existsSync(fullPath)) return { path: fullPath, exists: true };

  const found = findInAttribRoot(normalizedRef, attribRoot);
  return { path: found ?? fullPath, exists: found ? true : false };
}

export function tryResolveValuePath(value: unknown, attribRoot: string): ResolvedPathInfo | undefined {
  if (typeof value !== 'string') return undefined;
  if (!(/[\\/]/.test(value) || value.endsWith('.lua') || value.endsWith('.rgd'))) return undefined;
  return resolveAttribPath(value, attribRoot);
}

function getFilenameIndex(attribRoot: string): FilenameIndex {
  let idx = _filenameIndexCache.get(attribRoot);
  if (idx) return idx;

  // Cap cache so switching between many projects can't grow unbounded.
  if (_filenameIndexCache.size >= _FILENAME_INDEX_MAX_ROOTS) {
    _filenameIndexCache.delete(_filenameIndexCache.keys().next().value!);
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
        if (list) list.push(full); else byTail.set(key, [full]);
      }
    }
  }
  idx = { byTail };
  _filenameIndexCache.set(attribRoot, idx);
  return idx;
}

function findInAttribRoot(rel: string, attribRoot: string): string | undefined {
  const cacheKey = attribRoot + '\0' + rel;
  if (_dfsCache.has(cacheKey)) return _dfsCache.get(cacheKey);
  if (_dfsCache.size >= _DFS_CACHE_MAX) _dfsCache.delete(_dfsCache.keys().next().value!);

  const targetTail = rel.replace(/\\/g, '/');
  const parts = targetTail.split('/');
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
    const relFromRoot = candidate.substring(attribRootNormLen).replace(/\\/g, '/').toLowerCase();
    if (relFromRoot.endsWith(targetTailLower)) {
      _dfsCache.set(cacheKey, candidate);
      return candidate;
    }
  }
  _dfsCache.set(cacheKey, undefined);
  return undefined;
}

/**
 * Invalidate filename index for the given attrib root (or all roots if
 * omitted). Call when disk contents change in a watched folder.
 */
export function invalidateAttribIndex(attribRoot?: string): void {
  if (attribRoot) {
    _filenameIndexCache.delete(attribRoot);
    const prefix = attribRoot + '\0';
    for (const k of _dfsCache.keys()) {
      if (k.startsWith(prefix)) _dfsCache.delete(k);
    }
  } else {
    _filenameIndexCache.clear();
    _dfsCache.clear();
  }
}
