/**
 * RGD Text Format - Human-readable format for editing RGD files
 *
 * Format:
 *   # RGD Text Format v1.0
 *   # Source: filename.rgd
 *
 *   GameData {
 *     $REF = "path/to/inherit.lua"
 *     key_name: float = 1.5
 *     another_key: string = "value"
 *     bool_key: bool = true
 *     int_key: int = 12345
 *     unicode_key: wstring = "unicode value"
 *
 *     nested_table {
 *       child_key: float = 2.0
 *     }
 *   }
 */
import { RgdDataType, RgdTable, RgdFile, HashDictionary, LocaleEntry } from './types';
/**
 * Convert RGD file to text format
 */
export declare function rgdToText(rgdFile: RgdFile, sourceName?: string, localeMap?: Map<string, LocaleEntry>): string;
/**
 * Unescape string from text format
 */
export declare function unescapeString(str: string): string;
/**
 * Parse text format back to RGD structure
 */
export declare function textToRgd(text: string, dict: HashDictionary): {
    gameData: RgdTable;
    version: number;
};
/**
 * Convert RGD table to flat key-value pairs (for CSV export)
 */
export declare function rgdToFlatMap(table: RgdTable, prefix?: string): Map<string, {
    type: RgdDataType;
    value: any;
}>;
/**
 * Convert RGD to CSV format
 */
export declare function rgdToCsv(rgdFile: RgdFile): string;
/**
 * Parse CSV back to RGD structure
 */
export declare function csvToRgd(csv: string, dict: HashDictionary): RgdTable;
