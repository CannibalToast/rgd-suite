/**
 * Bob Jenkins hash function implementation
 * Used by Relic for RGD key hashing
 * Original: http://burtleburtle.net/bob/hash/evahash.html
 */
/**
 * Hash a variable-length key into a 32-bit value
 * @param key - The data to hash (as Buffer or string)
 * @param initval - Initial hash value (default 0)
 * @returns 32-bit hash value
 */
export declare function hash(key: Buffer | string, initval?: number): number;
/**
 * Convert a hash to hex string (0x prefixed, 8 chars)
 */
export declare function hashToHex(h: number): string;
/**
 * Parse a hex hash string to number
 */
export declare function hexToHash(hex: string): number;
/**
 * Check if a string looks like a hex hash (0xXXXXXXXX)
 */
export declare function isHexHash(str: string): boolean;
