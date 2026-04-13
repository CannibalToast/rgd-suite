import * as fs from 'fs';
import * as path from 'path';

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

function findInAttribRoot(rel: string, attribRoot: string): string | undefined {
  const targetTail = rel.replace(/\\/g, '/');
  const parts = targetTail.split('/');
  const tailName = parts[parts.length - 1];
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
        if (entry.name === tailName) {
          if (parts.length > 1) {
            const relFromRoot = full.substring(attribRoot.length + 1).replace(/\\/g, '/');
            if (relFromRoot.endsWith(targetTail)) return full;
          } else {
            return full;
          }
        }
      }
    }
  }
  return undefined;
}
