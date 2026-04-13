/**
 * RGD Data Types - matches Relic's internal type IDs
 */
export declare enum RgdDataType {
    Float = 0,
    Integer = 1,
    Bool = 2,
    String = 3,
    WString = 4,
    Table = 100,
    TableInt = 101,// Table with numeric keys (sorted numerically)
    NoData = 254
}
/**
 * Get human-readable name for data type
 */
export declare function dataTypeName(type: RgdDataType): string;
/**
 * Parse data type from name
 */
export declare function parseDataType(name: string): RgdDataType;
/**
 * Single RGD entry (key-value pair)
 */
export interface RgdEntry {
    hash: number;
    name: string | null;
    type: RgdDataType;
    value: RgdValue;
    reference?: string;
}
/**
 * Possible RGD values
 */
export type RgdValue = number | boolean | string | RgdTable | null;
/**
 * RGD Table - collection of entries
 */
export interface RgdTable {
    entries: RgdEntry[];
    reference?: string;
}
/**
 * RGD File header
 */
export interface RgdHeader {
    signature: string;
    version: number;
    unknown3: number;
    unknown4?: number;
    unknown5?: number;
    unknown6?: number;
}
/**
 * RGD Chunk
 */
export interface RgdChunk {
    type: string;
    version: number;
    descriptorString: string;
    crc: number;
    data: Buffer;
    rootEntry?: RgdEntry;
}
/**
 * Parsed RGD file
 */
export interface RgdFile {
    header: RgdHeader;
    chunks: RgdChunk[];
    gameData: RgdTable;
}
/**
 * Hash dictionary for resolving hash values to names
 */
export interface HashDictionary {
    hashToName: Map<number, string>;
    nameToHash: Map<string, number>;
}
export interface LocaleEntry {
    text: string;
    file: string;
    line: number;
}
