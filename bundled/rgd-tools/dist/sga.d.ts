/**
 * SGA Archive Reader - Relic's game data archive format
 * Used in Dawn of War (v2) and Company of Heroes (v4)
 *
 * Based on Corsix's Rainman Library (LGPL)
 */
/**
 * SGA File Header
 */
export interface SgaHeader {
    signature: string;
    version: number;
    toolMD5: Buffer;
    archiveType: string;
    headerMD5: Buffer;
    dataHeaderSize: number;
    dataOffset: number;
    platform?: number;
}
/**
 * File info for iteration
 */
export interface SgaFileInfo {
    path: string;
    name: string;
    size: number;
    compressedSize: number;
    isCompressed: boolean;
}
/**
 * SGA Archive class
 */
export declare class SgaArchive {
    private filePath;
    private buffer;
    private header;
    private dataHeader;
    private dataHeaderInfo;
    private tocs;
    private dirs;
    private files;
    private stringTable;
    constructor(filePath: string);
    private parse;
    /**
     * Get archive version
     */
    get version(): number;
    /**
     * Get archive type string
     */
    get archiveType(): string;
    /**
     * List all files in the archive
     */
    listFiles(pattern?: RegExp): SgaFileInfo[];
    /**
     * List all RGD files
     */
    listRgdFiles(): SgaFileInfo[];
    /**
     * Extract a file by path
     */
    extractFile(filePath: string): Buffer;
    /**
     * Extract file by entry
     */
    private extractFileByEntry;
    /**
     * Extract all files matching a pattern
     */
    extractFiles(outputDir: string, pattern?: RegExp): string[];
    /**
     * Extract all RGD files
     */
    extractRgdFiles(outputDir: string): string[];
}
/**
 * Open an SGA archive
 */
export declare function openSgaArchive(filePath: string): SgaArchive;
