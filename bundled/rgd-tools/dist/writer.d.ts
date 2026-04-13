import { RgdDataType, RgdEntry, RgdTable, HashDictionary } from './types';
/**
 * Build an RGD file from data
 */
export declare function buildRgd(gameData: RgdTable, dict: HashDictionary, version?: number): Buffer;
/**
 * Write an RGD file to disk
 */
export declare function writeRgdFile(filePath: string, gameData: RgdTable, dict: HashDictionary, version?: number): void;
/**
 * Create an RgdEntry from values
 */
export declare function createEntry(name: string, type: RgdDataType, value: any, dict: HashDictionary): RgdEntry;
/**
 * Create an empty RgdTable
 */
export declare function createTable(reference?: string): RgdTable;
