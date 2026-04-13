"use strict";
/**
 * SGA Archive Reader - Relic's game data archive format
 * Used in Dawn of War (v2) and Company of Heroes (v4)
 *
 * Based on Corsix's Rainman Library (LGPL)
 */
var __createBinding = (this && this.__createBinding) || (Object.create ? (function(o, m, k, k2) {
    if (k2 === undefined) k2 = k;
    var desc = Object.getOwnPropertyDescriptor(m, k);
    if (!desc || ("get" in desc ? !m.__esModule : desc.writable || desc.configurable)) {
      desc = { enumerable: true, get: function() { return m[k]; } };
    }
    Object.defineProperty(o, k2, desc);
}) : (function(o, m, k, k2) {
    if (k2 === undefined) k2 = k;
    o[k2] = m[k];
}));
var __setModuleDefault = (this && this.__setModuleDefault) || (Object.create ? (function(o, v) {
    Object.defineProperty(o, "default", { enumerable: true, value: v });
}) : function(o, v) {
    o["default"] = v;
});
var __importStar = (this && this.__importStar) || (function () {
    var ownKeys = function(o) {
        ownKeys = Object.getOwnPropertyNames || function (o) {
            var ar = [];
            for (var k in o) if (Object.prototype.hasOwnProperty.call(o, k)) ar[ar.length] = k;
            return ar;
        };
        return ownKeys(o);
    };
    return function (mod) {
        if (mod && mod.__esModule) return mod;
        var result = {};
        if (mod != null) for (var k = ownKeys(mod), i = 0; i < k.length; i++) if (k[i] !== "default") __createBinding(result, mod, k[i]);
        __setModuleDefault(result, mod);
        return result;
    };
})();
Object.defineProperty(exports, "__esModule", { value: true });
exports.SgaArchive = void 0;
exports.openSgaArchive = openSgaArchive;
const fs = __importStar(require("fs"));
const zlib = __importStar(require("zlib"));
const SGA_SIGNATURE = '_ARCHIVE';
/**
 * Binary reader helper
 */
class BinaryReader {
    buffer;
    pos = 0;
    constructor(buffer) {
        this.buffer = buffer;
    }
    get position() { return this.pos; }
    set position(p) { this.pos = p; }
    get length() { return this.buffer.length; }
    readBytes(count) {
        const result = this.buffer.subarray(this.pos, this.pos + count);
        this.pos += count;
        return result;
    }
    readUInt32LE() {
        const result = this.buffer.readUInt32LE(this.pos);
        this.pos += 4;
        return result;
    }
    readUInt16LE() {
        const result = this.buffer.readUInt16LE(this.pos);
        this.pos += 2;
        return result;
    }
    readString(maxLength) {
        const bytes = this.readBytes(maxLength);
        const end = bytes.indexOf(0);
        return bytes.subarray(0, end === -1 ? maxLength : end).toString('utf8');
    }
    readWString(charCount) {
        const chars = [];
        for (let i = 0; i < charCount; i++) {
            const code = this.buffer.readUInt16LE(this.pos);
            this.pos += 2;
            if (code === 0) {
                this.pos += (charCount - i - 1) * 2;
                break;
            }
            chars.push(code);
        }
        return String.fromCharCode(...chars);
    }
}
/**
 * SGA Archive class
 */
class SgaArchive {
    filePath;
    buffer;
    header;
    dataHeader;
    dataHeaderInfo;
    tocs = [];
    dirs = [];
    files = [];
    stringTable;
    constructor(filePath) {
        this.filePath = filePath;
        this.buffer = fs.readFileSync(filePath);
        this.parse();
    }
    parse() {
        const reader = new BinaryReader(this.buffer);
        // Read header
        const signature = reader.readString(8);
        if (signature !== SGA_SIGNATURE) {
            throw new Error(`Invalid SGA signature: "${signature}", expected "${SGA_SIGNATURE}"`);
        }
        const version = reader.readUInt32LE();
        if (version !== 2 && version !== 4) {
            throw new Error(`Unsupported SGA version: ${version} (only 2 and 4 supported)`);
        }
        const toolMD5 = reader.readBytes(16);
        const archiveType = reader.readWString(64);
        const headerMD5 = reader.readBytes(16);
        const dataHeaderSize = reader.readUInt32LE();
        const dataOffset = reader.readUInt32LE();
        let platform;
        if (version === 4) {
            platform = reader.readUInt32LE();
        }
        this.header = {
            signature,
            version,
            toolMD5,
            archiveType,
            headerMD5,
            dataHeaderSize,
            dataOffset,
            platform
        };
        // Read data header as one block
        this.dataHeader = reader.readBytes(dataHeaderSize);
        const dhReader = new BinaryReader(this.dataHeader);
        // Parse data header info
        this.dataHeaderInfo = {
            tocOffset: dhReader.readUInt32LE(),
            tocCount: dhReader.readUInt16LE(),
            dirOffset: dhReader.readUInt32LE(),
            dirCount: dhReader.readUInt16LE(),
            fileOffset: dhReader.readUInt32LE(),
            fileCount: dhReader.readUInt16LE(),
            itemOffset: dhReader.readUInt32LE(),
            itemCount: dhReader.readUInt16LE()
        };
        // Store string table reference
        this.stringTable = this.dataHeader.subarray(this.dataHeaderInfo.itemOffset);
        // Parse ToCs
        dhReader.position = this.dataHeaderInfo.tocOffset;
        for (let i = 0; i < this.dataHeaderInfo.tocCount; i++) {
            const alias = dhReader.readString(64);
            const baseDirName = dhReader.readString(64);
            const startDir = dhReader.readUInt16LE();
            const endDir = dhReader.readUInt16LE();
            const startFile = dhReader.readUInt16LE();
            const endFile = dhReader.readUInt16LE();
            const folderOffset = dhReader.readUInt32LE();
            this.tocs.push({
                alias,
                baseDirName,
                startDir,
                endDir,
                startFile,
                endFile,
                folderOffset
            });
        }
        // Parse directories
        dhReader.position = this.dataHeaderInfo.dirOffset;
        for (let i = 0; i < this.dataHeaderInfo.dirCount; i++) {
            const nameOffset = dhReader.readUInt32LE();
            const subDirBegin = dhReader.readUInt16LE();
            const subDirEnd = dhReader.readUInt16LE();
            const fileBegin = dhReader.readUInt16LE();
            const fileEnd = dhReader.readUInt16LE();
            // Read name from string table
            const nameEnd = this.stringTable.indexOf(0, nameOffset);
            const name = this.stringTable.subarray(nameOffset, nameEnd).toString('utf8');
            const lastSlash = name.lastIndexOf('\\');
            const shortName = lastSlash >= 0 ? name.substring(lastSlash + 1) : name;
            this.dirs.push({
                nameOffset,
                subDirBegin,
                subDirEnd,
                fileBegin,
                fileEnd,
                name,
                shortName
            });
        }
        // Parse files
        dhReader.position = this.dataHeaderInfo.fileOffset;
        for (let i = 0; i < this.dataHeaderInfo.fileCount; i++) {
            if (version === 2) {
                const nameOffset = dhReader.readUInt32LE();
                const flags = dhReader.readUInt32LE();
                const fileDataOffset = dhReader.readUInt32LE();
                const dataLengthCompressed = dhReader.readUInt32LE();
                const dataLength = dhReader.readUInt32LE();
                const nameEnd = this.stringTable.indexOf(0, nameOffset);
                const name = this.stringTable.subarray(nameOffset, nameEnd).toString('utf8');
                this.files.push({
                    nameOffset,
                    flags,
                    dataOffset: fileDataOffset,
                    dataLengthCompressed,
                    dataLength,
                    name
                });
            }
            else {
                const nameOffset = dhReader.readUInt32LE();
                const fileDataOffset = dhReader.readUInt32LE();
                const dataLengthCompressed = dhReader.readUInt32LE();
                const dataLength = dhReader.readUInt32LE();
                const modificationTime = dhReader.readUInt32LE();
                const flags = dhReader.readUInt16LE();
                const nameEnd = this.stringTable.indexOf(0, nameOffset);
                const name = this.stringTable.subarray(nameOffset, nameEnd).toString('utf8');
                this.files.push({
                    nameOffset,
                    dataOffset: fileDataOffset,
                    dataLengthCompressed,
                    dataLength,
                    modificationTime,
                    flags,
                    name
                });
            }
        }
    }
    /**
     * Get archive version
     */
    get version() {
        return this.header.version;
    }
    /**
     * Get archive type string
     */
    get archiveType() {
        return this.header.archiveType;
    }
    /**
     * List all files in the archive
     */
    listFiles(pattern) {
        const result = [];
        for (let tocIdx = 0; tocIdx < this.tocs.length; tocIdx++) {
            const toc = this.tocs[tocIdx];
            const tocAlias = this.header.version === 4 ? 'Data' : toc.alias;
            for (let fileIdx = 0; fileIdx < this.files.length; fileIdx++) {
                const file = this.files[fileIdx];
                // Find parent directory
                let dirPath = '';
                for (let dirIdx = 0; dirIdx < this.dirs.length; dirIdx++) {
                    const dir = this.dirs[dirIdx];
                    if (fileIdx >= dir.fileBegin && fileIdx < dir.fileEnd) {
                        dirPath = dir.name || '';
                        break;
                    }
                }
                const fullPath = dirPath
                    ? `${tocAlias}\\${dirPath}\\${file.name}`
                    : `${tocAlias}\\${file.name}`;
                if (pattern && !pattern.test(fullPath))
                    continue;
                result.push({
                    path: fullPath,
                    name: file.name,
                    size: file.dataLength,
                    compressedSize: file.dataLengthCompressed,
                    isCompressed: file.dataLengthCompressed !== file.dataLength
                });
            }
        }
        return result;
    }
    /**
     * List all RGD files
     */
    listRgdFiles() {
        return this.listFiles(/\.rgd$/i);
    }
    /**
     * Extract a file by path
     */
    extractFile(filePath) {
        // Normalize path
        filePath = filePath.replace(/\//g, '\\');
        // Find the file
        let foundFile = null;
        for (let tocIdx = 0; tocIdx < this.tocs.length; tocIdx++) {
            const toc = this.tocs[tocIdx];
            const tocAlias = this.header.version === 4 ? 'Data' : toc.alias;
            for (let fileIdx = 0; fileIdx < this.files.length; fileIdx++) {
                const file = this.files[fileIdx];
                // Find parent directory
                let dirPath = '';
                for (let dirIdx = 0; dirIdx < this.dirs.length; dirIdx++) {
                    const dir = this.dirs[dirIdx];
                    if (fileIdx >= dir.fileBegin && fileIdx < dir.fileEnd) {
                        dirPath = dir.name || '';
                        break;
                    }
                }
                const fullPath = dirPath
                    ? `${tocAlias}\\${dirPath}\\${file.name}`
                    : `${tocAlias}\\${file.name}`;
                if (fullPath.toLowerCase() === filePath.toLowerCase()) {
                    foundFile = file;
                    break;
                }
            }
            if (foundFile)
                break;
        }
        if (!foundFile) {
            throw new Error(`File not found in archive: ${filePath}`);
        }
        return this.extractFileByEntry(foundFile);
    }
    /**
     * Extract file by entry
     */
    extractFileByEntry(file) {
        // Calculate actual offset in file
        // Before each file: 256 bytes name + (v2: 4 bytes date) + 4 bytes CRC
        const preDataSize = this.header.version === 2 ? 264 : 260;
        const actualOffset = this.header.dataOffset + file.dataOffset - preDataSize;
        // Read pre-data and compressed data
        const compressedData = this.buffer.subarray(actualOffset + preDataSize, actualOffset + preDataSize + file.dataLengthCompressed);
        // Decompress if needed
        if (file.dataLengthCompressed !== file.dataLength) {
            try {
                return zlib.inflateSync(compressedData);
            }
            catch (e) {
                throw new Error(`Failed to decompress file: ${file.name}`);
            }
        }
        return compressedData;
    }
    /**
     * Extract all files matching a pattern
     */
    extractFiles(outputDir, pattern) {
        const files = this.listFiles(pattern);
        const extracted = [];
        for (const fileInfo of files) {
            try {
                const data = this.extractFile(fileInfo.path);
                const outputPath = `${outputDir}/${fileInfo.path.replace(/\\/g, '/')}`;
                // Create directory structure
                const dir = outputPath.substring(0, outputPath.lastIndexOf('/'));
                fs.mkdirSync(dir, { recursive: true });
                fs.writeFileSync(outputPath, data);
                extracted.push(outputPath);
            }
            catch (e) {
                console.error(`Failed to extract ${fileInfo.path}: ${e}`);
            }
        }
        return extracted;
    }
    /**
     * Extract all RGD files
     */
    extractRgdFiles(outputDir) {
        return this.extractFiles(outputDir, /\.rgd$/i);
    }
}
exports.SgaArchive = SgaArchive;
/**
 * Open an SGA archive
 */
function openSgaArchive(filePath) {
    return new SgaArchive(filePath);
}
//# sourceMappingURL=data:application/json;base64,eyJ2ZXJzaW9uIjozLCJmaWxlIjoic2dhLmpzIiwic291cmNlUm9vdCI6IiIsInNvdXJjZXMiOlsiLi4vc3JjL3NnYS50cyJdLCJuYW1lcyI6W10sIm1hcHBpbmdzIjoiO0FBQUE7Ozs7O0dBS0c7Ozs7Ozs7Ozs7Ozs7Ozs7Ozs7Ozs7Ozs7Ozs7Ozs7Ozs7OztBQTRlSCx3Q0FFQztBQTVlRCx1Q0FBeUI7QUFDekIsMkNBQTZCO0FBRTdCLE1BQU0sYUFBYSxHQUFHLFVBQVUsQ0FBQztBQTRGakM7O0dBRUc7QUFDSCxNQUFNLFlBQVk7SUFDRixNQUFNLENBQVM7SUFDZixHQUFHLEdBQVcsQ0FBQyxDQUFDO0lBRXhCLFlBQVksTUFBYztRQUNsQixJQUFJLENBQUMsTUFBTSxHQUFHLE1BQU0sQ0FBQztJQUM3QixDQUFDO0lBRUQsSUFBSSxRQUFRLEtBQWEsT0FBTyxJQUFJLENBQUMsR0FBRyxDQUFDLENBQUMsQ0FBQztJQUMzQyxJQUFJLFFBQVEsQ0FBQyxDQUFTLElBQUksSUFBSSxDQUFDLEdBQUcsR0FBRyxDQUFDLENBQUMsQ0FBQyxDQUFDO0lBQ3pDLElBQUksTUFBTSxLQUFhLE9BQU8sSUFBSSxDQUFDLE1BQU0sQ0FBQyxNQUFNLENBQUMsQ0FBQyxDQUFDO0lBRW5ELFNBQVMsQ0FBQyxLQUFhO1FBQ2YsTUFBTSxNQUFNLEdBQUcsSUFBSSxDQUFDLE1BQU0sQ0FBQyxRQUFRLENBQUMsSUFBSSxDQUFDLEdBQUcsRUFBRSxJQUFJLENBQUMsR0FBRyxHQUFHLEtBQUssQ0FBQyxDQUFDO1FBQ2hFLElBQUksQ0FBQyxHQUFHLElBQUksS0FBSyxDQUFDO1FBQ2xCLE9BQU8sTUFBTSxDQUFDO0lBQ3RCLENBQUM7SUFFRCxZQUFZO1FBQ0osTUFBTSxNQUFNLEdBQUcsSUFBSSxDQUFDLE1BQU0sQ0FBQyxZQUFZLENBQUMsSUFBSSxDQUFDLEdBQUcsQ0FBQyxDQUFDO1FBQ2xELElBQUksQ0FBQyxHQUFHLElBQUksQ0FBQyxDQUFDO1FBQ2QsT0FBTyxNQUFNLENBQUM7SUFDdEIsQ0FBQztJQUVELFlBQVk7UUFDSixN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QyxDQUFDO1lBQUMsT0FBTyxDQUFDLEVBQUUsQ0FBQztnQkFDTCxPQUFPLENBQUMsS0FBSyxDQUFDLHFCQUFxQixRQUFRLENBQUMsSUFBSSxLQUFLLENBQUMsRUFBRSxDQUFDLENBQUM7WUFDbEUsQ0FBQztRQUNULENBQUM7UUFFRCxPQUFPLFNBQVMsQ0FBQztJQUN6QixDQUFDO0lBRUQ7O09BRUc7SUFDSCxlQUFlLENBQUMsU0FBaUI7UUFDekIsT0FBTyxJQUFJLENBQUMsWUFBWSxDQUFDLFNBQVMsRUFBRSxTQUFTLENBQUMsQ0FBQztJQUN2RCxDQUFDO0NBQ1I7QUE3VUQsZ0NBNlVDO0FBRUQ7O0dBRUc7QUFDSCxTQUFnQixjQUFjLENBQUMsUUFBZ0I7SUFDdkMsT0FBTyxJQUFJLFVBQVUsQ0FBQyxRQUFRLENBQUMsQ0FBQztBQUN4QyxDQUFDIiwic291cmNlc0NvbnRlbnQiOlsiLyoqXHJcbiAqIFNHQSBBcmNoaXZlIFJlYWRlciAtIFJlbGljJ3MgZ2FtZSBkYXRhIGFyY2hpdmUgZm9ybWF0XHJcbiAqIFVzZWQgaW4gRGF3biBvZiBXYXIgKHYyKSBhbmQgQ29tcGFueSBvZiBIZXJvZXMgKHY0KVxyXG4gKlxyXG4gKiBCYXNlZCBvbiBDb3JzaXgncyBSYWlubWFuIExpYnJhcnkgKExHUEwpXHJcbiAqL1xyXG5cclxuaW1wb3J0ICogYXMgZnMgZnJvbSAnZnMnO1xyXG5pbXBvcnQgKiBhcyB6bGliIGZyb20gJ3psaWInO1xyXG5cclxuY29uc3QgU0dBX1NJR05BVFVSRSA9ICdfQVJDSElWRSc7XHJcblxyXG4vKipcclxuICogU0dBIEZpbGUgSGVhZGVyXHJcbiAqL1xyXG5leHBvcnQgaW50ZXJmYWNlIFNnYUhlYWRlciB7XHJcbiAgICAgICAgc2lnbmF0dXJlOiBzdHJpbmc7ICAgICAgLy8gOCBieXRlcyBcIl9BUkNISVZFXCJcclxuICAgICAgICB2ZXJzaW9uOiBudW1iZXI7ICAgICAgICAvLyAyID0gRG9XLCA0ID0gQ29IXHJcbiAgICAgICAgdG9vbE1ENTogQnVmZmVyOyAgICAgICAgLy8gMTYgYnl0ZXNcclxuICAgICAgICBhcmNoaXZlVHlwZTogc3RyaW5nOyAgICAvLyAxMjggYnl0ZXMgdW5pY29kZVxyXG4gICAgICAgIGhlYWRlck1ENTogQnVmZmVyOyAgICAgIC8vIDE2IGJ5dGVzXHJcbiAgICAgICAgZGF0YUhlYWRlclNpemU6IG51bWJlcjtcclxuICAgICAgICBkYXRhT2Zmc2V0OiBudW1iZXI7XHJcbiAgICAgICAgcGxhdGZvcm0/OiBudW1iZXI7ICAgICAgLy8gdjQgb25seVxyXG59XHJcblxyXG4vKipcclxuICogRGF0YSBIZWFkZXIgSW5mb1xyXG4gKi9cclxuaW50ZXJmYWNlIERhdGFIZWFkZXJJbmZvIHtcclxuICAgICAgICB0b2NPZmZzZXQ6IG51bWJlcjtcclxuICAgICAgICB0b2NDb3VudDogbnVtYmVyO1xyXG4gICAgICAgIGRpck9mZnNldDogbnVtYmVyO1xyXG4gICAgICAgIGRpckNvdW50OiBudW1iZXI7XHJcbiAgICAgICAgZmlsZU9mZnNldDogbnVtYmVyO1xyXG4gICAgICAgIGZpbGVDb3VudDogbnVtYmVyO1xyXG4gICAgICAgIGl0ZW1PZmZzZXQ6IG51bWJlcjtcclxuICAgICAgICBpdGVtQ291bnQ6IG51bWJlcjtcclxufVxyXG5cclxuLyoqXHJcbiAqIFRhYmxlIG9mIENvbnRlbnRzIGVudHJ5XHJcbiAqL1xyXG5pbnRlcmZhY2UgU2dhVG9jIHtcclxuICAgICAgICBhbGlhczogc3RyaW5nOyAgICAgICAgICAvLyA2NCBieXRlc1xyXG4gICAgICAgIGJhc2VEaXJOYW1lOiBzdHJpbmc7ICAgIC8vIDY0IGJ5dGVzXHJcbiAgICAgICAgc3RhcnREaXI6IG51bWJlcjtcclxuICAgICAgICBlbmREaXI6IG51bWJlcjtcclxuICAgICAgICBzdGFydEZpbGU6IG51bWJlcjtcclxuICAgICAgICBlbmRGaWxlOiBudW1iZXI7XHJcbiAgICAgICAgZm9sZGVyT2Zmc2V0OiBudW1iZXI7XHJcbn1cclxuXHJcbi8qKlxyXG4gKiBEaXJlY3RvcnkgZW50cnlcclxuICovXHJcbmludGVyZmFjZSBTZ2FEaXIge1xyXG4gICAgICAgIG5hbWVPZmZzZXQ6IG51bWJlcjtcclxuICAgICAgICBzdWJEaXJCZWdpbjogbnVtYmVyO1xyXG4gICAgICAgIHN1YkRpckVuZDogbnVtYmVyO1xyXG4gICAgICAgIGZpbGVCZWdpbjogbnVtYmVyO1xyXG4gICAgICAgIGZpbGVFbmQ6IG51bWJlcjtcclxuICAgICAgICBuYW1lPzogc3RyaW5nO1xyXG4gICAgICAgIHNob3J0TmFtZT86IHN0cmluZztcclxufVxyXG5cclxuLyoqXHJcbiAqIEZpbGUgZW50cnkgKHYyKVxyXG4gKi9cclxuaW50ZXJmYWNlIFNnYUZpbGVWMiB7XHJcbiAgICAgICAgbmFtZU9mZnNldDogbnVtYmVyO1xyXG4gICAgICAgIGZsYWdzOiBudW1iZXI7ICAgICAgICAgIC8vIDB4MDA9dW5jb21wcmVzc2VkLCAweDEwPXpsaWIgbGFyZ2UsIDB4MjA9emxpYiBzbWFsbFxyXG4gICAgICAgIGRhdGFPZmZzZXQ6IG51bWJlcjtcclxuICAgICAgICBkYXRhTGVuZ3RoQ29tcHJlc3NlZDogbnVtYmVyO1xyXG4gICAgICAgIGRhdGFMZW5ndGg6IG51bWJlcjtcclxuICAgICAgICBuYW1lPzogc3RyaW5nO1xyXG59XHJcblxyXG4vKipcclxuICogRmlsZSBlbnRyeSAodjQpXHJcbiAqL1xyXG5pbnRlcmZhY2UgU2dhRmlsZVY0IHtcclxuICAgICAgICBuYW1lT2Zmc2V0OiBudW1iZXI7XHJcbiAgICAgICAgZGF0YU9mZnNldDogbnVtYmVyO1xyXG4gICAgICAgIGRhdGFMZW5ndGhDb21wcmVzc2VkOiBudW1iZXI7XHJcbiAgICAgICAgZGF0YUxlbmd0aDogbnVtYmVyO1xyXG4gICAgICAgIG1vZGlmaWNhdGlvblRpbWU6IG51bWJlcjtcclxuICAgICAgICBmbGFnczogbnVtYmVyO1xyXG4gICAgICAgIG5hbWU/OiBzdHJpbmc7XHJcbn1cclxuXHJcbi8qKlxyXG4gKiBGaWxlIGluZm8gZm9yIGl0ZXJhdGlvblxyXG4gKi9cclxuZXhwb3J0IGludGVyZmFjZSBTZ2FGaWxlSW5mbyB7XHJcbiAgICAgICAgcGF0aDogc3RyaW5nO1xyXG4gICAgICAgIG5hbWU6IHN0cmluZztcclxuICAgICAgICBzaXplOiBudW1iZXI7XHJcbiAgICAgICAgY29tcHJlc3NlZFNpemU6IG51bWJlcjtcclxuICAgICAgICBpc0NvbXByZXNzZWQ6IGJvb2xlYW47XHJcbn1cclxuXHJcbi8qKlxyXG4gKiBCaW5hcnkgcmVhZGVyIGhlbHBlclxyXG4gKi9cclxuY2xhc3MgQmluYXJ5UmVhZGVyIHtcclxuICAgICAgICBwcml2YXRlIGJ1ZmZlcjogQnVmZmVyO1xyXG4gICAgICAgIHByaXZhdGUgcG9zOiBudW1iZXIgPSAwO1xyXG5cclxuICAgICAgICBjb25zdHJ1Y3RvcihidWZmZXI6IEJ1ZmZlcikge1xyXG4gICAgICAgICAgICAgICAgdGhpcy5idWZmZXIgPSBidWZmZXI7XHJcbiAgICAgICAgfVxyXG5cclxuICAgICAgICBnZXQgcG9zaXRpb24oKTogbnVtYmVyIHsgcmV0dXJuIHRoaXMucG9zOyB9XHJcbiAgICAgICAgc2V0IHBvc2l0aW9uKHA6IG51bWJlcikgeyB0aGlzLnBvcyA9IHA7IH1cclxuICAgICAgICBnZXQgbGVuZ3RoKCk6IG51bWJlciB7IHJldHVybiB0aGlzLmJ1ZmZlci5sZW5ndGg7IH1cclxuXHJcbiAgICAgICAgcmVhZEJ5dGVzKGNvdW50OiBudW1iZXIpOiBCdWZmZXIge1xyXG4gICAgICAgICAgICAgICAgY29uc3QgcmVzdWx0ID0gdGhpcy5idWZmZXIuc3ViYXJyYXkodGhpcy5wb3MsIHRoaXMucG9zICsgY291bnQpO1xyXG4gICAgICAgICAgICAgICAgdGhpcy5wb3MgKz0gY291bnQ7XHJcbiAgICAgICAgICAgICAgICByZXR1cm4gcmVzdWx0O1xyXG4gICAgICAgIH1cclxuXHJcbiAgICAgICAgcmVhZFVJbnQzMkxFKCk6IG51bWJlciB7XHJcbiAgICAgICAgICAgICAgICBjb25zdCByZXN1bHQgPSB0aGlzLmJ1ZmZlci5yZWFkVUludDMyTEUodGhpcy5wb3MpO1xyXG4gICAgICAgICAgICAgICAgdGhpcy5wb3MgKz0gNDtcclxuICAgICAgICAgICAgICAgIHJldHVybiByZXN1bHQ7XHJcbiAgICAgICAgfVxyXG5cclxuICAgICAgICByZWFkVUludDE2TEUoKTogbnVtYmVyIHtcclxuICAgICAgICAgICAgICAgIGNvbnN0IHJlc3VsdCA9IHRoaXMuYnVmZmVyLnJlYWRVSW50MTZMRSh0aGlzLnBvcyk7XHJcbiAgICAgICAgICAgICAgICB0aGlzLnBvcyArPSAyO1xyXG4gICAgICAgICAgICAgICAgcmV0dXJuIHJlc3VsdDtcclxuICAgICAgICB9XHJcblxyXG4gICAgICAgIHJlYWRTdHJpbmcobWF4TGVuZ3RoOiBudW1iZXIpOiBzdHJpbmcge1xyXG4gICAgICAgICAgICAgICAgY29uc3QgYnl0ZXMgPSB0aGlzLnJlYWRCeXRlcyhtYXhMZW5ndGgpO1xyXG4gICAgICAgICAgICAgICAgY29uc3QgZW5kID0gYnl0ZXMuaW5kZXhPZigwKTtcclxuICAgICAgICAgICAgICAgIHJldHVybiBieXRlcy5zdWJhcnJheSgwLCBlbmQgPT09IC0xID8gbWF4TGVuZ3RoIDogZW5kKS50b1N0cmluZygndXRmOCcpO1xyXG4gICAgICAgIH1cclxuXHJcbiAgICAgICAgcmVhZFdTdHJpbmcoY2hhckNvdW50OiBudW1iZXIpOiBzdHJpbmcge1xyXG4gICAgICAgICAgICAgICAgY29uc3QgY2hhcnM6IG51bWJlcltdID0gW107XHJcbiAgICAgICAgICAgICAgICBmb3IgKGxldCBpID0gMDsgaSA8IGNoYXJDb3VudDsgaSsrKSB7XHJcbiAgICAgICAgICAgICAgICAgICAgICAgIGNvbnN0IGNvZGUgPSB0aGlzLmJ1ZmZlci5yZWFkVUludDE2TEUodGhpcy5wb3MpO1xyXG4gICAgICAgICAgICAgICAgICAgICAgICB0aGlzLnBvcyArPSAyO1xyXG4gICAgICAgICAgICAgICAgICAgICAgICBpZiAoY29kZSA9PT0gMCkge1xyXG4gICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgIHRoaXMucG9zICs9IChjaGFyQ291bnQgLSBpIC0gMSkgKiAyO1xyXG4gICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgIGJyZWFrO1xyXG4gICAgICAgICAgICAgICAgICAgICAgICB9XHJcbiAgICAgICAgICAgICAgICAgICAgICAgIGNoYXJzLnB1c2goY29kZSk7XHJcbiAgICAgICAgICAgICAgICB9XHJcbiAgICAgICAgICAgICAgICByZXR1cm4gU3RyaW5nLmZyb21DaGFyQ29kZSguLi5jaGFycyk7XHJcbiAgICAgICAgfVxyXG59XHJcblxyXG4vKipcclxuICogU0dBIEFyY2hpdmUgY2xhc3NcclxuICovXHJcbmV4cG9ydCBjbGFzcyBTZ2FBcmNoaXZlIHtcclxuICAgICAgICBwcml2YXRlIGZpbGVQYXRoOiBzdHJpbmc7XHJcbiAgICAgICAgcHJpdmF0ZSBidWZmZXI6IEJ1ZmZlcjtcclxuICAgICAgICBwcml2YXRlIGhlYWRlciE6IFNnYUhlYWRlcjtcclxuICAgICAgICBwcml2YXRlIGRhdGFIZWFkZXIhOiBCdWZmZXI7XHJcbiAgICAgICAgcHJpdmF0ZSBkYXRhSGVhZGVySW5mbyE6IERhdGFIZWFkZXJJbmZvO1xyXG4gICAgICAgIHByaXZhdGUgdG9jczogU2dhVG9jW10gPSBbXTtcclxuICAgICAgICBwcml2YXRlIGRpcnM6IFNnYURpcltdID0gW107XHJcbiAgICAgICAgcHJpdmF0ZSBmaWxlczogKFNnYUZpbGVWMiB8IFNnYUZpbGVWNClbXSA9IFtdO1xyXG4gICAgICAgIHByaXZhdGUgc3RyaW5nVGFibGUhOiBCdWZmZXI7XHJcblxyXG4gICAgICAgIGNvbnN0cnVjdG9yKGZpbGVQYXRoOiBzdHJpbmcpIHtcclxuICAgICAgICAgICAgICAgIHRoaXMuZmlsZVBhdGggPSBmaWxlUGF0aDtcclxuICAgICAgICAgICAgICAgIHRoaXMuYnVmZmVyID0gZnMucmVhZEZpbGVTeW5jKGZpbGVQYXRoKTtcclxuICAgICAgICAgICAgICAgIHRoaXMucGFyc2UoKTtcclxuICAgICAgICB9XHJcblxyXG4gICAgICAgIHByaXZhdGUgcGFyc2UoKTogdm9pZCB7XHJcbiAgICAgICAgICAgICAgICBjb25zdCByZWFkZXIgPSBuZXcgQmluYXJ5UmVhZGVyKHRoaXMuYnVmZmVyKTtcclxuXHJcbiAgICAgICAgICAgICAgICAvLyBSZWFkIGhlYWRlclxyXG4gICAgICAgICAgICAgICAgY29uc3Qgc2lnbmF0dXJlID0gcmVhZGVyLnJlYWRTdHJpbmcoOCk7XHJcbiAgICAgICAgICAgICAgICBpZiAoc2lnbmF0dXJlICE9PSBTR0FfU0lHTkFUVVJFKSB7XHJcbiAgICAgICAgICAgICAgICAgICAgICAgIHRocm93IG5ldyBFcnJvcihgSW52YWxpZCBTR0Egc2lnbmF0dXJlOiBcIiR7c2lnbmF0dXJlfVwiLCBleHBlY3RlZCBcIiR7U0dBX1NJR05BVFVSRX1cImApO1xyXG4gICAgICAgICAgICAgICAgfVxyXG5cclxuICAgICAgICAgICAgICAgIGNvbnN0IHZlcnNpb24gPSByZWFkZXIucmVhZFVJbnQzMkxFKCk7XHJcbiAgICAgICAgICAgICAgICBpZiAodmVyc2lvbiAhPT0gMiAmJiB2ZXJzaW9uICE9PSA0KSB7XHJcbiAgICAgICAgICAgICAgICAgICAgICAgIHRocm93IG5ldyBFcnJvcihgVW5zdXBwb3J0ZWQgU0dBIHZlcnNpb246ICR7dmVyc2lvbn0gKG9ubHkgMiBhbmQgNCBzdXBwb3J0ZWQpYCk7XHJcbiAgICAgICAgICAgICAgICB9XHJcblxyXG4gICAgICAgICAgICAgICAgY29uc3QgdG9vbE1ENSA9IHJlYWRlci5yZWFkQnl0ZXMoMTYpO1xyXG4gICAgICAgICAgICAgICAgY29uc3QgYXJjaGl2ZVR5cGUgPSByZWFkZXIucmVhZFdTdHJpbmcoNjQpO1xyXG4gICAgICAgICAgICAgICAgY29uc3QgaGVhZGVyTUQ1ID0gcmVhZGVyLnJlYWRCeXRlcygxNik7XHJcbiAgICAgICAgICAgICAgICBjb25zdCBkYXRhSGVhZGVyU2l6ZSA9IHJlYWRlci5yZWFkVUludDMyTEUoKTtcclxuICAgICAgICAgICAgICAgIGNvbnN0IGRhdGFPZmZzZXQgPSByZWFkZXIucmVhZFVJbnQzMkxFKCk7XHJcblxyXG4gICAgICAgICAgICAgICAgbGV0IHBsYXRmb3JtOiBudW1iZXIgfCB1bmRlZmluZWQ7XHJcbiAgICAgICAgICAgICAgICBpZiAodmVyc2lvbiA9PT0gNCkge1xyXG4gICAgICAgICAgICAgICAgICAgICAgICBwbGF0Zm9ybSA9IHJlYWRlci5yZWFkVUludDMyTEUoKTtcclxuICAgICAgICAgICAgICAgIH1cclxuXHJcbiAgICAgICAgICAgICAgICB0aGlzLmhlYWRlciA9IHtcclxuICAgICAgICAgICAgICAgICAgICAgICAgc2lnbmF0dXJlLFxyXG4gICAgICAgICAgICAgICAgICAgICAgICB2ZXJzaW9uLFxyXG4gICAgICAgICAgICAgICAgICAgICAgICB0b29sTUQ1LFxyXG4gICAgICAgICAgICAgICAgICAgICAgICBhcmNoaXZlVHlwZSxcclxuICAgICAgICAgICAgICAgICAgICAgICAgaGVhZGVyTUQ1LFxyXG4gICAgICAgICAgICAgICAgICAgICAgICBkYXRhSGVhZGVyU2l6ZSxcclxuICAgICAgICAgICAgICAgICAgICAgICAgZGF0YU9mZnNldCxcclxuICAgICAgICAgICAgICAgICAgICAgICAgcGxhdGZvcm1cclxuICAgICAgICAgICAgICAgIH07XHJcblxyXG4gICAgICAgICAgICAgICAgLy8gUmVhZCBkYXRhIGhlYWRlciBhcyBvbmUgYmxvY2tcclxuICAgICAgICAgICAgICAgIHRoaXMuZGF0YUhlYWRlciA9IHJlYWRlci5yZWFkQnl0ZXMoZGF0YUhlYWRlclNpemUpO1xyXG4gICAgICAgICAgICAgICAgY29uc3QgZGhSZWFkZXIgPSBuZXcgQmluYXJ5UmVhZGVyKHRoaXMuZGF0YUhlYWRlcik7XHJcblxyXG4gICAgICAgICAgICAgICAgLy8gUGFyc2UgZGF0YSBoZWFkZXIgaW5mb1xyXG4gICAgICAgICAgICAgICAgdGhpcy5kYXRhSGVhZGVySW5mbyA9IHtcclxuICAgICAgICAgICAgICAgICAgICAgICAgdG9jT2Zmc2V0OiBkaFJlYWRlci5yZWFkVUludDMyTEUoKSxcclxuICAgICAgICAgICAgICAgICAgICAgICAgdG9jQ291bnQ6IGRoUmVhZGVyLnJlYWRVSW50MTZMRSgpLFxyXG4gICAgICAgICAgICAgICAgICAgICAgICBkaXJPZmZzZXQ6IGRoUmVhZGVyLnJlYWRVSW50MzJMRSgpLFxyXG4gICAgICAgICAgICAgICAgICAgICAgICBkaXJDb3VudDogZGhSZWFkZXIucmVhZFVJbnQxNkxFKCksXHJcbiAgICAgICAgICAgICAgICAgICAgICAgIGZpbGVPZmZzZXQ6IGRoUmVhZGVyLnJlYWRVSW50MzJMRSgpLFxyXG4gICAgICAgICAgICAgICAgICAgICAgICBmaWxlQ291bnQ6IGRoUmVhZGVyLnJlYWRVSW50MTZMRSgpLFxyXG4gICAgICAgICAgICAgICAgICAgICAgICBpdGVtT2Zmc2V0OiBkaFJlYWRlci5yZWFkVUludDMyTEUoKSxcclxuICAgICAgICAgICAgICAgICAgICAgICAgaXRlbUNvdW50OiBkaFJlYWRlci5yZWFkVUludDE2TEUoKVxyXG4gICAgICAgICAgICAgICAgfTtcclxuXHJcbiAgICAgICAgICAgICAgICAvLyBTdG9yZSBzdHJpbmcgdGFibGUgcmVmZXJlbmNlXHJcbiAgICAgICAgICAgICAgICB0aGlzLnN0cmluZ1RhYmxlID0gdGhpcy5kYXRhSGVhZGVyLnN1YmFycmF5KHRoaXMuZGF0YUhlYWRlckluZm8uaXRlbU9mZnNldCk7XHJcblxyXG4gICAgICAgICAgICAgICAgLy8gUGFyc2UgVG9Dc1xyXG4gICAgICAgICAgICAgICAgZGhSZWFkZXIucG9zaXRpb24gPSB0aGlzLmRhdGFIZWFkZXJJbmZvLnRvY09mZnNldDtcclxuICAgICAgICAgICAgICAgIGZvciAobGV0IGkgPSAwOyBpIDwgdGhpcy5kYXRhSGVhZGVySW5mby50b2NDb3VudDsgaSsrKSB7XHJcbiAgICAgICAgICAgICAgICAgICAgICAgIGNvbnN0IGFsaWFzID0gZGhSZWFkZXIucmVhZFN0cmluZyg2NCk7XHJcbiAgICAgICAgICAgICAgICAgICAgICAgIGNvbnN0IGJhc2VEaXJOYW1lID0gZGhSZWFkZXIucmVhZFN0cmluZyg2NCk7XHJcbiAgICAgICAgICAgICAgICAgICAgICAgIGNvbnN0IHN0YXJ0RGlyID0gZGhSZWFkZXIucmVhZFVJbnQxNkxFKCk7XHJcbiAgICAgICAgICAgICAgICAgICAgICAgIGNvbnN0IGVuZERpciA9IGRoUmVhZGVyLnJlYWRVSW50MTZMRSgpO1xyXG4gICAgICAgICAgICAgICAgICAgICAgICBjb25zdCBzdGFydEZpbGUgPSBkaFJlYWRlci5yZWFkVUludDE2TEUoKTtcclxuICAgICAgICAgICAgICAgICAgICAgICAgY29uc3QgZW5kRmlsZSA9IGRoUmVhZGVyLnJlYWRVSW50MTZMRSgpO1xyXG4gICAgICAgICAgICAgICAgICAgICAgICBjb25zdCBmb2xkZXJPZmZzZXQgPSBkaFJlYWRlci5yZWFkVUludDMyTEUoKTtcclxuXHJcbiAgICAgICAgICAgICAgICAgICAgICAgIHRoaXMudG9jcy5wdXNoKHtcclxuICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICBhbGlhcyxcclxuICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICBiYXNlRGlyTmFtZSxcclxuICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICBzdGFydERpcixcclxuICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICBlbmREaXIsXHJcbiAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgc3RhcnRGaWxlLFxyXG4gICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgIGVuZEZpbGUsXHJcbiAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgZm9sZGVyT2Zmc2V0XHJcbiAgICAgICAgICAgICAgICAgICAgICAgIH0pO1xyXG4gICAgICAgICAgICAgICAgfVxyXG5cclxuICAgICAgICAgICAgICAgIC8vIFBhcnNlIGRpcmVjdG9yaWVzXHJcbiAgICAgICAgICAgICAgICBkaFJlYWRlci5wb3NpdGlvbiA9IHRoaXMuZGF0YUhlYWRlckluZm8uZGlyT2Zmc2V0O1xyXG4gICAgICAgICAgICAgICAgZm9yIChsZXQgaSA9IDA7IGkgPCB0aGlzLmRhdGFIZWFkZXJJbmZvLmRpckNvdW50OyBpKyspIHtcclxuICAgICAgICAgICAgICAgICAgICAgICAgY29uc3QgbmFtZU9mZnNldCA9IGRoUmVhZGVyLnJlYWRVSW50MzJMRSgpO1xyXG4gICAgICAgICAgICAgICAgICAgICAgICBjb25zdCBzdWJEaXJCZWdpbiA9IGRoUmVhZGVyLnJlYWRVSW50MTZMRSgpO1xyXG4gICAgICAgICAgICAgICAgICAgICAgICBjb25zdCBzdWJEaXJFbmQgPSBkaFJlYWRlci5yZWFkVUludDE2TEUoKTtcclxuICAgICAgICAgICAgICAgICAgICAgICAgY29uc3QgZmlsZUJlZ2luID0gZGhSZWFkZXIucmVhZFVJbnQxNkxFKCk7XHJcbiAgICAgICAgICAgICAgICAgICAgICAgIGNvbnN0IGZpbGVFbmQgPSBkaFJlYWRlci5yZWFkVUludDE2TEUoKTtcclxuXHJcbiAgICAgICAgICAgICAgICAgICAgICAgIC8vIFJlYWQgbmFtZSBmcm9tIHN0cmluZyB0YWJsZVxyXG4gICAgICAgICAgICAgICAgICAgICAgICBjb25zdCBuYW1lRW5kID0gdGhpcy5zdHJpbmdUYWJsZS5pbmRleE9mKDAsIG5hbWVPZmZzZXQpO1xyXG4gICAgICAgICAgICAgICAgICAgICAgICBjb25zdCBuYW1lID0gdGhpcy5zdHJpbmdUYWJsZS5zdWJhcnJheShuYW1lT2Zmc2V0LCBuYW1lRW5kKS50b1N0cmluZygndXRmOCcpO1xyXG4gICAgICAgICAgICAgICAgICAgICAgICBjb25zdCBsYXN0U2xhc2ggPSBuYW1lLmxhc3RJbmRleE9mKCdcXFxcJyk7XHJcbiAgICAgICAgICAgICAgICAgICAgICAgIGNvbnN0IHNob3J0TmFtZSA9IGxhc3RTbGFzaCA+PSAwID8gbmFtZS5zdWJzdHJpbmcobGFzdFNsYXNoICsgMSkgOiBuYW1lO1xyXG5cclxuICAgICAgICAgICAgICAgICAgICAgICAgdGhpcy5kaXJzLnB1c2goe1xyXG4gICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgIG5hbWVPZmZzZXQsXHJcbiAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgc3ViRGlyQmVnaW4sXHJcbiAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgc3ViRGlyRW5kLFxyXG4gICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgIGZpbGVCZWdpbixcclxuICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICBmaWxlRW5kLFxyXG4gICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgIG5hbWUsXHJcbiAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgc2hvcnROYW1lXHJcbiAgICAgICAgICAgICAgICAgICAgICAgIH0pO1xyXG4gICAgICAgICAgICAgICAgfVxyXG5cclxuICAgICAgICAgICAgICAgIC8vIFBhcnNlIGZpbGVzXHJcbiAgICAgICAgICAgICAgICBkaFJlYWRlci5wb3NpdGlvbiA9IHRoaXMuZGF0YUhlYWRlckluZm8uZmlsZU9mZnNldDtcclxuICAgICAgICAgICAgICAgIGZvciAobGV0IGkgPSAwOyBpIDwgdGhpcy5kYXRhSGVhZGVySW5mby5maWxlQ291bnQ7IGkrKykge1xyXG4gICAgICAgICAgICAgICAgICAgICAgICBpZiAodmVyc2lvbiA9PT0gMikge1xyXG4gICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgIGNvbnN0IG5hbWVPZmZzZXQgPSBkaFJlYWRlci5yZWFkVUludDMyTEUoKTtcclxuICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICBjb25zdCBmbGFncyA9IGRoUmVhZGVyLnJlYWRVSW50MzJMRSgpO1xyXG4gICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgIGNvbnN0IGZpbGVEYXRhT2Zmc2V0ID0gZGhSZWFkZXIucmVhZFVJbnQzMkxFKCk7XHJcbiAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgY29uc3QgZGF0YUxlbmd0aENvbXByZXNzZWQgPSBkaFJlYWRlci5yZWFkVUludDMyTEUoKTtcclxuICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICBjb25zdCBkYXRhTGVuZ3RoID0gZGhSZWFkZXIucmVhZFVJbnQzMkxFKCk7XHJcblxyXG4gICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgIGNvbnN0IG5hbWVFbmQgPSB0aGlzLnN0cmluZ1RhYmxlLmluZGV4T2YoMCwgbmFtZU9mZnNldCk7XHJcbiAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgY29uc3QgbmFtZSA9IHRoaXMuc3RyaW5nVGFibGUuc3ViYXJyYXkobmFtZU9mZnNldCwgbmFtZUVuZCkudG9TdHJpbmcoJ3V0ZjgnKTtcclxuXHJcbiAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgdGhpcy5maWxlcy5wdXNoKHtcclxuICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgIG5hbWVPZmZzZXQsXHJcbiAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICBmbGFncyxcclxuICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgIGRhdGFPZmZzZXQ6IGZpbGVEYXRhT2Zmc2V0LFxyXG4gICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgZGF0YUxlbmd0aENvbXByZXNzZWQsXHJcbiAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICBkYXRhTGVuZ3RoLFxyXG4gICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgbmFtZVxyXG4gICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgIH0gYXMgU2dhRmlsZVYyKTtcclxuICAgICAgICAgICAgICAgICAgICAgICAgfSBlbHNlIHtcclxuICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICBjb25zdCBuYW1lT2Zmc2V0ID0gZGhSZWFkZXIucmVhZFVJbnQzMkxFKCk7XHJcbiAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgY29uc3QgZmlsZURhdGFPZmZzZXQgPSBkaFJlYWRlci5yZWFkVUludDMyTEUoKTtcclxuICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICBjb25zdCBkYXRhTGVuZ3RoQ29tcHJlc3NlZCA9IGRoUmVhZGVyLnJlYWRVSW50MzJMRSgpO1xyXG4gICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgIGNvbnN0IGRhdGFMZW5ndGggPSBkaFJlYWRlci5yZWFkVUludDMyTEUoKTtcclxuICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICBjb25zdCBtb2RpZmljYXRpb25UaW1lID0gZGhSZWFkZXIucmVhZFVJbnQzMkxFKCk7XHJcbiAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgY29uc3QgZmxhZ3MgPSBkaFJlYWRlci5yZWFkVUludDE2TEUoKTtcclxuXHJcbiAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgY29uc3QgbmFtZUVuZCA9IHRoaXMuc3RyaW5nVGFibGUuaW5kZXhPZigwLCBuYW1lT2Zmc2V0KTtcclxuICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICBjb25zdCBuYW1lID0gdGhpcy5zdHJpbmdUYWJsZS5zdWJhcnJheShuYW1lT2Zmc2V0LCBuYW1lRW5kKS50b1N0cmluZygndXRmOCcpO1xyXG5cclxuICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICB0aGlzLmZpbGVzLnB1c2goe1xyXG4gICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgbmFtZU9mZnNldCxcclxuICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgIGRhdGFPZmZzZXQ6IGZpbGVEYXRhT2Zmc2V0LFxyXG4gICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgZGF0YUxlbmd0aENvbXByZXNzZWQsXHJcbiAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICBkYXRhTGVuZ3RoLFxyXG4gICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgbW9kaWZpY2F0aW9uVGltZSxcclxuICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgIGZsYWdzLFxyXG4gICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgbmFtZVxyXG4gICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgIH0gYXMgU2dhRmlsZVY0KTtcclxuICAgICAgICAgICAgICAgICAgICAgICAgfVxyXG4gICAgICAgICAgICAgICAgfVxyXG4gICAgICAgIH1cclxuXHJcbiAgICAgICAgLyoqXHJcbiAgICAgICAgICogR2V0IGFyY2hpdmUgdmVyc2lvblxyXG4gICAgICAgICAqL1xyXG4gICAgICAgIGdldCB2ZXJzaW9uKCk6IG51bWJlciB7XHJcbiAgICAgICAgICAgICAgICByZXR1cm4gdGhpcy5oZWFkZXIudmVyc2lvbjtcclxuICAgICAgICB9XHJcblxyXG4gICAgICAgIC8qKlxyXG4gICAgICAgICAqIEdldCBhcmNoaXZlIHR5cGUgc3RyaW5nXHJcbiAgICAgICAgICovXHJcbiAgICAgICAgZ2V0IGFyY2hpdmVUeXBlKCk6IHN0cmluZyB7XHJcbiAgICAgICAgICAgICAgICByZXR1cm4gdGhpcy5oZWFkZXIuYXJjaGl2ZVR5cGU7XHJcbiAgICAgICAgfVxyXG5cclxuICAgICAgICAvKipcclxuICAgICAgICAgKiBMaXN0IGFsbCBmaWxlcyBpbiB0aGUgYXJjaGl2ZVxyXG4gICAgICAgICAqL1xyXG4gICAgICAgIGxpc3RGaWxlcyhwYXR0ZXJuPzogUmVnRXhwKTogU2dhRmlsZUluZm9bXSB7XHJcbiAgICAgICAgICAgICAgICBjb25zdCByZXN1bHQ6IFNnYUZpbGVJbmZvW10gPSBbXTtcclxuXHJcbiAgICAgICAgICAgICAgICBmb3IgKGxldCB0b2NJZHggPSAwOyB0b2NJZHggPCB0aGlzLnRvY3MubGVuZ3RoOyB0b2NJZHgrKykge1xyXG4gICAgICAgICAgICAgICAgICAgICAgICBjb25zdCB0b2MgPSB0aGlzLnRvY3NbdG9jSWR4XTtcclxuICAgICAgICAgICAgICAgICAgICAgICAgY29uc3QgdG9jQWxpYXMgPSB0aGlzLmhlYWRlci52ZXJzaW9uID09PSA0ID8gJ0RhdGEnIDogdG9jLmFsaWFzO1xyXG5cclxuICAgICAgICAgICAgICAgICAgICAgICAgZm9yIChsZXQgZmlsZUlkeCA9IDA7IGZpbGVJZHggPCB0aGlzLmZpbGVzLmxlbmd0aDsgZmlsZUlkeCsrKSB7XHJcbiAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgY29uc3QgZmlsZSA9IHRoaXMuZmlsZXNbZmlsZUlkeF07XHJcblxyXG4gICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgIC8vIEZpbmQgcGFyZW50IGRpcmVjdG9yeVxyXG4gICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgIGxldCBkaXJQYXRoID0gJyc7XHJcbiAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgZm9yIChsZXQgZGlySWR4ID0gMDsgZGlySWR4IDwgdGhpcy5kaXJzLmxlbmd0aDsgZGlySWR4KyspIHtcclxuICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgIGNvbnN0IGRpciA9IHRoaXMuZGlyc1tkaXJJZHhdO1xyXG4gICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgaWYgKGZpbGVJZHggPj0gZGlyLmZpbGVCZWdpbiAmJiBmaWxlSWR4IDwgZGlyLmZpbGVFbmQpIHtcclxuICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgZGlyUGF0aCA9IGRpci5uYW1lIHx8ICcnO1xyXG4gICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICBicmVhaztcclxuICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgIH1cclxuICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICB9XHJcblxyXG4gICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgIGNvbnN0IGZ1bGxQYXRoID0gZGlyUGF0aFxyXG4gICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgPyBgJHt0b2NBbGlhc31cXFxcJHtkaXJQYXRofVxcXFwke2ZpbGUubmFtZX1gXHJcbiAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICA6IGAke3RvY0FsaWFzfVxcXFwke2ZpbGUubmFtZX1gO1xyXG5cclxuICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICBpZiAocGF0dGVybiAmJiAhcGF0dGVybi50ZXN0KGZ1bGxQYXRoKSkgY29udGludWU7XHJcblxyXG4gICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgIHJlc3VsdC5wdXNoKHtcclxuICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgIHBhdGg6IGZ1bGxQYXRoLFxyXG4gICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgbmFtZTogZmlsZS5uYW1lISxcclxuICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgIHNpemU6IGZpbGUuZGF0YUxlbmd0aCxcclxuICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgIGNvbXByZXNzZWRTaXplOiBmaWxlLmRhdGFMZW5ndGhDb21wcmVzc2VkLFxyXG4gICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgaXNDb21wcmVzc2VkOiBmaWxlLmRhdGFMZW5ndGhDb21wcmVzc2VkICE9PSBmaWxlLmRhdGFMZW5ndGhcclxuICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICB9KTtcclxuICAgICAgICAgICAgICAgICAgICAgICAgfVxyXG4gICAgICAgICAgICAgICAgfVxyXG5cclxuICAgICAgICAgICAgICAgIHJldHVybiByZXN1bHQ7XHJcbiAgICAgICAgfVxyXG5cclxuICAgICAgICAvKipcclxuICAgICAgICAgKiBMaXN0IGFsbCBSR0QgZmlsZXNcclxuICAgICAgICAgKi9cclxuICAgICAgICBsaXN0UmdkRmlsZXMoKTogU2dhRmlsZUluZm9bXSB7XHJcbiAgICAgICAgICAgICAgICByZXR1cm4gdGhpcy5saXN0RmlsZXMoL1xcLnJnZCQvaSk7XHJcbiAgICAgICAgfVxyXG5cclxuICAgICAgICAvKipcclxuICAgICAgICAgKiBFeHRyYWN0IGEgZmlsZSBieSBwYXRoXHJcbiAgICAgICAgICovXHJcbiAgICAgICAgZXh0cmFjdEZpbGUoZmlsZVBhdGg6IHN0cmluZyk6IEJ1ZmZlciB7XHJcbiAgICAgICAgICAgICAgICAvLyBOb3JtYWxpemUgcGF0aFxyXG4gICAgICAgICAgICAgICAgZmlsZVBhdGggPSBmaWxlUGF0aC5yZXBsYWNlKC9cXC8vZywgJ1xcXFwnKTtcclxuXHJcbiAgICAgICAgICAgICAgICAvLyBGaW5kIHRoZSBmaWxlXHJcbiAgICAgICAgICAgICAgICBsZXQgZm91bmRGaWxlOiAoU2dhRmlsZVYyIHwgU2dhRmlsZVY0KSB8IG51bGwgPSBudWxsO1xyXG5cclxuICAgICAgICAgICAgICAgIGZvciAobGV0IHRvY0lkeCA9IDA7IHRvY0lkeCA8IHRoaXMudG9jcy5sZW5ndGg7IHRvY0lkeCsrKSB7XHJcbiAgICAgICAgICAgICAgICAgICAgICAgIGNvbnN0IHRvYyA9IHRoaXMudG9jc1t0b2NJZHhdO1xyXG4gICAgICAgICAgICAgICAgICAgICAgICBjb25zdCB0b2NBbGlhcyA9IHRoaXMuaGVhZGVyLnZlcnNpb24gPT09IDQgPyAnRGF0YScgOiB0b2MuYWxpYXM7XHJcblxyXG4gICAgICAgICAgICAgICAgICAgICAgICBmb3IgKGxldCBmaWxlSWR4ID0gMDsgZmlsZUlkeCA8IHRoaXMuZmlsZXMubGVuZ3RoOyBmaWxlSWR4KyspIHtcclxuICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICBjb25zdCBmaWxlID0gdGhpcy5maWxlc1tmaWxlSWR4XTtcclxuXHJcbiAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgLy8gRmluZCBwYXJlbnQgZGlyZWN0b3J5XHJcbiAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgbGV0IGRpclBhdGggPSAnJztcclxuICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICBmb3IgKGxldCBkaXJJZHggPSAwOyBkaXJJZHggPCB0aGlzLmRpcnMubGVuZ3RoOyBkaXJJZHgrKykge1xyXG4gICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgY29uc3QgZGlyID0gdGhpcy5kaXJzW2RpcklkeF07XHJcbiAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICBpZiAoZmlsZUlkeCA+PSBkaXIuZmlsZUJlZ2luICYmIGZpbGVJZHggPCBkaXIuZmlsZUVuZCkge1xyXG4gICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICBkaXJQYXRoID0gZGlyLm5hbWUgfHwgJyc7XHJcbiAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgIGJyZWFrO1xyXG4gICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgfVxyXG4gICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgIH1cclxuXHJcbiAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgY29uc3QgZnVsbFBhdGggPSBkaXJQYXRoXHJcbiAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICA/IGAke3RvY0FsaWFzfVxcXFwke2RpclBhdGh9XFxcXCR7ZmlsZS5uYW1lfWBcclxuICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgIDogYCR7dG9jQWxpYXN9XFxcXCR7ZmlsZS5uYW1lfWA7XHJcblxyXG4gICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgIGlmIChmdWxsUGF0aC50b0xvd2VyQ2FzZSgpID09PSBmaWxlUGF0aC50b0xvd2VyQ2FzZSgpKSB7XHJcbiAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICBmb3VuZEZpbGUgPSBmaWxlO1xyXG4gICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgYnJlYWs7XHJcbiAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgfVxyXG4gICAgICAgICAgICAgICAgICAgICAgICB9XHJcbiAgICAgICAgICAgICAgICAgICAgICAgIGlmIChmb3VuZEZpbGUpIGJyZWFrO1xyXG4gICAgICAgICAgICAgICAgfVxyXG5cclxuICAgICAgICAgICAgICAgIGlmICghZm91bmRGaWxlKSB7XHJcbiAgICAgICAgICAgICAgICAgICAgICAgIHRocm93IG5ldyBFcnJvcihgRmlsZSBub3QgZm91bmQgaW4gYXJjaGl2ZTogJHtmaWxlUGF0aH1gKTtcclxuICAgICAgICAgICAgICAgIH1cclxuXHJcbiAgICAgICAgICAgICAgICByZXR1cm4gdGhpcy5leHRyYWN0RmlsZUJ5RW50cnkoZm91bmRGaWxlKTtcclxuICAgICAgICB9XHJcblxyXG4gICAgICAgIC8qKlxyXG4gICAgICAgICAqIEV4dHJhY3QgZmlsZSBieSBlbnRyeVxyXG4gICAgICAgICAqL1xyXG4gICAgICAgIHByaXZhdGUgZXh0cmFjdEZpbGVCeUVudHJ5KGZpbGU6IFNnYUZpbGVWMiB8IFNnYUZpbGVWNCk6IEJ1ZmZlciB7XHJcbiAgICAgICAgICAgICAgICAvLyBDYWxjdWxhdGUgYWN0dWFsIG9mZnNldCBpbiBmaWxlXHJcbiAgICAgICAgICAgICAgICAvLyBCZWZvcmUgZWFjaCBmaWxlOiAyNTYgYnl0ZXMgbmFtZSArICh2MjogNCBieXRlcyBkYXRlKSArIDQgYnl0ZXMgQ1JDXHJcbiAgICAgICAgICAgICAgICBjb25zdCBwcmVEYXRhU2l6ZSA9IHRoaXMuaGVhZGVyLnZlcnNpb24gPT09IDIgPyAyNjQgOiAyNjA7XHJcbiAgICAgICAgICAgICAgICBjb25zdCBhY3R1YWxPZmZzZXQgPSB0aGlzLmhlYWRlci5kYXRhT2Zmc2V0ICsgZmlsZS5kYXRhT2Zmc2V0IC0gcHJlRGF0YVNpemU7XHJcblxyXG4gICAgICAgICAgICAgICAgLy8gUmVhZCBwcmUtZGF0YSBhbmQgY29tcHJlc3NlZCBkYXRhXHJcbiAgICAgICAgICAgICAgICBjb25zdCBjb21wcmVzc2VkRGF0YSA9IHRoaXMuYnVmZmVyLnN1YmFycmF5KFxyXG4gICAgICAgICAgICAgICAgICAgICAgICBhY3R1YWxPZmZzZXQgKyBwcmVEYXRhU2l6ZSxcclxuICAgICAgICAgICAgICAgICAgICAgICAgYWN0dWFsT2Zmc2V0ICsgcHJlRGF0YVNpemUgKyBmaWxlLmRhdGFMZW5ndGhDb21wcmVzc2VkXHJcbiAgICAgICAgICAgICAgICApO1xyXG5cclxuICAgICAgICAgICAgICAgIC8vIERlY29tcHJlc3MgaWYgbmVlZGVkXHJcbiAgICAgICAgICAgICAgICBpZiAoZmlsZS5kYXRhTGVuZ3RoQ29tcHJlc3NlZCAhPT0gZmlsZS5kYXRhTGVuZ3RoKSB7XHJcbiAgICAgICAgICAgICAgICAgICAgICAgIHRyeSB7XHJcbiAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgcmV0dXJuIHpsaWIuaW5mbGF0ZVN5bmMoY29tcHJlc3NlZERhdGEpO1xyXG4gICAgICAgICAgICAgICAgICAgICAgICB9IGNhdGNoIChlKSB7XHJcbiAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgdGhyb3cgbmV3IEVycm9yKGBGYWlsZWQgdG8gZGVjb21wcmVzcyBmaWxlOiAke2ZpbGUubmFtZX1gKTtcclxuICAgICAgICAgICAgICAgICAgICAgICAgfVxyXG4gICAgICAgICAgICAgICAgfVxyXG5cclxuICAgICAgICAgICAgICAgIHJldHVybiBjb21wcmVzc2VkRGF0YTtcclxuICAgICAgICB9XHJcblxyXG4gICAgICAgIC8qKlxyXG4gICAgICAgICAqIEV4dHJhY3QgYWxsIGZpbGVzIG1hdGNoaW5nIGEgcGF0dGVyblxyXG4gICAgICAgICAqL1xyXG4gICAgICAgIGV4dHJhY3RGaWxlcyhvdXRwdXREaXI6IHN0cmluZywgcGF0dGVybj86IFJlZ0V4cCk6IHN0cmluZ1tdIHtcclxuICAgICAgICAgICAgICAgIGNvbnN0IGZpbGVzID0gdGhpcy5saXN0RmlsZXMocGF0dGVybik7XHJcbiAgICAgICAgICAgICAgICBjb25zdCBleHRyYWN0ZWQ6IHN0cmluZ1tdID0gW107XHJcblxyXG4gICAgICAgICAgICAgICAgZm9yIChjb25zdCBmaWxlSW5mbyBvZiBmaWxlcykge1xyXG4gICAgICAgICAgICAgICAgICAgICAgICB0cnkge1xyXG4gICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgIGNvbnN0IGRhdGEgPSB0aGlzLmV4dHJhY3RGaWxlKGZpbGVJbmZvLnBhdGgpO1xyXG4gICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgIGNvbnN0IG91dHB1dFBhdGggPSBgJHtvdXRwdXREaXJ9LyR7ZmlsZUluZm8ucGF0aC5yZXBsYWNlKC9cXFxcL2csICcvJyl9YDtcclxuXHJcbiAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgLy8gQ3JlYXRlIGRpcmVjdG9yeSBzdHJ1Y3R1cmVcclxuICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICBjb25zdCBkaXIgPSBvdXRwdXRQYXRoLnN1YnN0cmluZygwLCBvdXRwdXRQYXRoLmxhc3RJbmRleE9mKCcvJykpO1xyXG4gICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgIGZzLm1rZGlyU3luYyhkaXIsIHsgcmVjdXJzaXZlOiB0cnVlIH0pO1xyXG5cclxuICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICBmcy53cml0ZUZpbGVTeW5jKG91dHB1dFBhdGgsIGRhdGEpO1xyXG4gICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgIGV4dHJhY3RlZC5wdXNoKG91dHB1dFBhdGgpO1xyXG4gICAgICAgICAgICAgICAgICAgICAgICB9IGNhdGNoIChlKSB7XHJcbiAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgY29uc29sZS5lcnJvcihgRmFpbGVkIHRvIGV4dHJhY3QgJHtmaWxlSW5mby5wYXRofTogJHtlfWApO1xyXG4gICAgICAgICAgICAgICAgICAgICAgICB9XHJcbiAgICAgICAgICAgICAgICB9XHJcblxyXG4gICAgICAgICAgICAgICAgcmV0dXJuIGV4dHJhY3RlZDtcclxuICAgICAgICB9XHJcblxyXG4gICAgICAgIC8qKlxyXG4gICAgICAgICAqIEV4dHJhY3QgYWxsIFJHRCBmaWxlc1xyXG4gICAgICAgICAqL1xyXG4gICAgICAgIGV4dHJhY3RSZ2RGaWxlcyhvdXRwdXREaXI6IHN0cmluZyk6IHN0cmluZ1tdIHtcclxuICAgICAgICAgICAgICAgIHJldHVybiB0aGlzLmV4dHJhY3RGaWxlcyhvdXRwdXREaXIsIC9cXC5yZ2QkL2kpO1xyXG4gICAgICAgIH1cclxufVxyXG5cclxuLyoqXHJcbiAqIE9wZW4gYW4gU0dBIGFyY2hpdmVcclxuICovXHJcbmV4cG9ydCBmdW5jdGlvbiBvcGVuU2dhQXJjaGl2ZShmaWxlUGF0aDogc3RyaW5nKTogU2dhQXJjaGl2ZSB7XHJcbiAgICAgICAgcmV0dXJuIG5ldyBTZ2FBcmNoaXZlKGZpbGVQYXRoKTtcclxufVxyXG4iXX0=