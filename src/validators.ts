import * as fs from "fs";
import { ParsedLuaTable } from "../bundled/rgd-tools/dist/luaFormat";
import { RgdTable } from "../bundled/rgd-tools/dist/types";

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

export interface ValidationFix {
  kind: "bom_stripped";
  severity: "info";
  path: string;
  details: string;
}

type SharedValidators = {
  detectBOM: typeof detectBOM;
  validateEncoding: typeof validateEncoding;
  stripUtf8BomFromFile: typeof stripUtf8BomFromFile;
  validateFilePath: typeof validateFilePath;
  isNilReference: typeof isNilReference;
  clearAttribIndex: typeof clearAttribIndex;
  validateLuaReferences: typeof validateLuaReferences;
  validateRgdReferences: typeof validateRgdReferences;
  validateFolderStructure: typeof validateFolderStructure;
  stripUtf8Bom: typeof stripUtf8Bom;
};

const hostValidators: SharedValidators = (
  require("../cli/validators.js") as {
    createValidators(hostCompatibility?: boolean): SharedValidators;
  }
).createValidators(true);

export function detectBOM(buffer: Buffer): BOMInfo {
  return hostValidators.detectBOM(buffer);
}

export function validateEncoding(buffer: Buffer, filePath = ""): EncodingResult {
  return hostValidators.validateEncoding(buffer, filePath);
}

export function stripUtf8BomFromFile(
  filePath: string,
  buffer: Buffer = fs.readFileSync(filePath),
): { fixed: boolean; buffer: Buffer; fix?: ValidationFix } {
  return hostValidators.stripUtf8BomFromFile(filePath, buffer);
}

export function validateFilePath(filePath: string): ValidationIssue[] {
  return hostValidators.validateFilePath(filePath);
}

export function isNilReference(refPath: string): boolean {
  return hostValidators.isNilReference(refPath);
}

/** Clear the attrib tree index cache. Pass a path to invalidate a single
 *  attribBase, or omit to clear all cached indices. */
export function clearAttribIndex(attribBase?: string): void {
  hostValidators.clearAttribIndex(attribBase);
}

export function validateLuaReferences(
  table: ParsedLuaTable,
  attribBase: string | null,
  prefix = "GameData",
): ValidationIssue[] {
  return hostValidators.validateLuaReferences(table, attribBase, prefix);
}

export function validateRgdReferences(
  table: RgdTable,
  attribBase: string | null,
  prefix = "GameData",
): ValidationIssue[] {
  return hostValidators.validateRgdReferences(table, attribBase, prefix);
}

export function validateFolderStructure(folder: string): ValidationIssue[] {
  return hostValidators.validateFolderStructure(folder);
}

export function stripUtf8Bom(text: string): string {
  return hostValidators.stripUtf8Bom(text);
}
