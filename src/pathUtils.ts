import * as path from "path";
import * as fs from "fs";
import {
  detectBOM as detectBufferBOM,
  validateEncoding,
  BOMType,
  EncodingResult,
} from "./validators";

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
 * Normalizes an attrib reference. Returns null if the path is invalid or
 * would escape the base directory.
 */
export function sanitizeRefPath(refPath: string): string | null {
  if (!refPath || typeof refPath !== "string") {
    return null;
  }
  if (NULL_BYTE_RE.test(refPath) || ABSOLUTE_RE.test(refPath)) {
    return null;
  }
  const clean = refPath
    .replace(/\\/g, "/")
    .trim()
    .replace(/^data\/attrib\//i, "")
    .replace(/^attrib\//i, "");
  if (TRAVERSAL_RE.test(clean)) {
    return null;
  }
  const parts = clean.split("/").filter((p) => p && p !== ".");
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
  if (fs.existsSync(resolved)) {
    try {
      const realResolved = fs.realpathSync(resolved);
      const realBase = fs.realpathSync(resolvedBase);
      if (
        !realResolved.toLowerCase().startsWith(realBase.toLowerCase() + path.sep) &&
        realResolved.toLowerCase() !== realBase.toLowerCase()
      ) {
        return null;
      }
    } catch {
      return null;
    }
  }
  return resolved;
}

export function detectBOM(buffer: Buffer): BOMType {
  return detectBufferBOM(buffer).type;
}

export function validatePathEncoding(filePath: string): EncodingResult | null {
  if (!fs.existsSync(filePath) || !fs.statSync(filePath).isFile()) {
    return null;
  }
  return validateEncoding(fs.readFileSync(filePath), filePath);
}
