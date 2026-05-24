import * as path from "path";

const TRAVERSAL_RE = /(?:^|[\\/])\.\.(?:[\\/]|$)/;
const ABSOLUTE_RE = /^[a-zA-Z]:[\\/]|^\\|^\//;

/**
 * Validate that a relative path does not contain directory-traversal
 * sequences and is safe to join against a base directory.
 */
export function isSafeRelativePath(rel: string): boolean {
  if (ABSOLUTE_RE.test(rel)) {
    return false;
  }
  const normalized = rel.replace(/\\/g, "/");
  if (TRAVERSAL_RE.test(normalized)) {
    return false;
  }
  return true;
}

/**
 * Sanitize a reference path for use within an attrib root.
 * Removes leading/trailing separators, parent-directory references,
 * and null bytes. Returns null if the path is invalid or would
 * escape the base directory.
 */
export function sanitizeRefPath(refPath: string): string | null {
  if (!refPath || typeof refPath !== "string") {
    return null;
  }
  let clean = refPath.replace(/\\/g, "/");
  if (clean.startsWith("/")) {
    clean = clean.substring(1);
  }
  const parts = clean.split("/").filter((p) => p && p !== "." && p !== "..");
  if (parts.length === 0) {
    return null;
  }
  return parts.join("/");
}

const NULL_BYTE_RE = /\0/;

/**
 * Validate a user-supplied file path for suspicious content.
 * Returns the path if it appears safe, or null if it contains
 * directory-traversal sequences, null bytes, or other dangerous patterns.
 */
export function sanitizeUserPath(input: string): string | null {
  if (!input || typeof input !== "string") {
    return null;
  }
  if (NULL_BYTE_RE.test(input)) {
    return null;
  }
  const normalized = input.replace(/\\/g, "/");
  const parts = normalized.split("/");
  for (const p of parts) {
    if (p === "..") {
      return null;
    }
  }
  return input;
}

/**
 * Safely join a base directory with a relative path.
 * Returns null if the relative path would escape the base directory
 * or contains traversal sequences.
 */
export function safeJoin(baseDir: string, relPath: string): string | null {
  const sanitized = sanitizeRefPath(relPath);
  if (!sanitized) {
    return null;
  }
  const resolved = path.resolve(path.join(baseDir, sanitized));
  const resolvedBase = path.resolve(baseDir);
  if (
    !resolved.toLowerCase().startsWith(resolvedBase.toLowerCase() + path.sep) &&
    resolved.toLowerCase() !== resolvedBase.toLowerCase()
  ) {
    return null;
  }
  return resolved;
}
