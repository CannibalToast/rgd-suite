import { HashDictionary } from './types';
export { HashDictionary } from './types';
/**
 * Create an empty hash dictionary
 */
export declare function createDictionary(): HashDictionary;
/**
 * Add a name to the dictionary
 */
export declare function addToDictionary(dict: HashDictionary, name: string): number;
/**
 * Resolve a hash to a name (or null if unknown)
 */
export declare function hashToName(dict: HashDictionary, h: number): string | null;
/**
 * Get hash for a name, adding to dictionary if new
 */
export declare function nameToHash(dict: HashDictionary, name: string): number;
/**
 * Load a dictionary file in RGD_DIC format
 * Format:
 *   #RGD_DIC (header)
 *   0xHASH=name
 *   # comments
 */
export declare function loadDictionary(dict: HashDictionary, filePath: string): void;
/**
 * Save custom dictionary entries to a file
 */
export declare function saveDictionary(dict: HashDictionary, filePath: string, customOnly?: Set<number> | null): void;
/**
 * Scan a directory for dictionary files and load them all
 */
export declare function loadDictionariesFromDir(dict: HashDictionary, dirPath: string): void;
/**
 * Create a dictionary and load common dictionaries
 */
export declare function createAndLoadDictionaries(dictionaryPaths?: string[]): HashDictionary;
