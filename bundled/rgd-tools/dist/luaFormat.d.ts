/**
 * RGD Lua Format - Convert between RGD and Lua GameData format
 *
 * This matches the format used by Corsix Mod Studio for Lua dumps.
 *
 * Corsix Lua Format (Differential):
 *   GameData = Inherit([[]])                           -- Root inheritance (empty or parent path)
 *   GameData["table"] = Reference([[path\to\ref.lua]]) -- Child table with reference (only if different from parent)
 *   GameData["key"] = 5                                -- Only outputs values that differ from parent
 *   GameData["key"] = nil                              -- Delete/clear inherited value
 *
 * Key features:
 *   - Uses Reference() for child tables, Inherit() only for root GameData
 *   - Single backslashes in [[ ]] strings (no escaping needed)
 *   - Only outputs values that differ from the inherited parent
 *   - Uses nil to delete inherited values
 */
import { RgdDataType, RgdTable, RgdFile, HashDictionary } from './types';
/**
 * Type for a function that loads and parses a parent Lua/RGD file
 * Returns the parsed table structure, or null if file not found
 */
export type ParentLoader = (refPath: string) => Promise<ParsedLuaTable | null>;
/**
 * Parsed Lua table structure for comparison
 */
export interface ParsedLuaTable {
    reference?: string;
    entries: Map<string, ParsedLuaEntry>;
}
export interface ParsedLuaEntry {
    type: 'value' | 'table';
    value?: any;
    dataType?: RgdDataType;
    table?: ParsedLuaTable;
    reference?: string;
}
/**
 * Convert RGD file to Lua format (Corsix differential style)
 *
 * @param rgdFile The RGD file to convert
 * @param parentLoader Optional function to load parent files for differential comparison
 * @param sourceName Optional source filename for comments
 */
export declare function rgdToLuaDifferential(rgdFile: RgdFile, parentLoader?: ParentLoader): Promise<string>;
/**
 * Convert RGD file to Lua format (simple complete dump - no differential)
 */
export declare function rgdToLua(rgdFile: RgdFile, sourceName?: string): string;
/**
 * Parse Lua GameData format back to RGD structure
 */
export declare function luaToRgd(luaCode: string, dict: HashDictionary): {
    gameData: RgdTable;
    version: number;
};
/**
 * Loader function type for resolving parent RGD files
 */
export type RgdParentLoader = (refPath: string) => Promise<RgdTable | null>;
/**
 * Parse Lua GameData format to RGD with full resolution of Inherit/Reference
 * This creates a complete RGD by loading and merging parent files
 */
export declare function luaToRgdResolved(luaCode: string, dict: HashDictionary, parentLoader: RgdParentLoader): Promise<{
    gameData: RgdTable;
    version: number;
}>;
/**
 * Type for loading Lua files for ParsedLuaTable resolution
 */
export type LuaFileLoader = (refPath: string) => string | null;
/**
 * Parse Lua code into ParsedLuaTable structure with recursive reference resolution.
 * This is the canonical implementation for differential comparison.
 *
 * @param luaCode The Lua source code
 * @param luaFileLoader Function to load Lua files by reference path (returns code or null)
 * @param loadedFiles Set of already loaded files (normalized paths) to prevent infinite recursion
 */
export declare function parseLuaToTable(luaCode: string, luaFileLoader?: LuaFileLoader, loadedFiles?: Set<string>): ParsedLuaTable;
