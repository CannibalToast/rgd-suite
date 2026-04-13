import { RgdFile, HashDictionary } from './types';
/**
 * Parse an RGD file from a buffer
 */
export declare function parseRgd(buffer: Buffer, dict: HashDictionary): RgdFile;
/**
 * Read and parse an RGD file from disk
 */
export declare function readRgdFile(filePath: string, dict: HashDictionary): RgdFile;
