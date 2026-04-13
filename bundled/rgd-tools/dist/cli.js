#!/usr/bin/env node
"use strict";
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
const commander_1 = require("commander");
const fs = __importStar(require("fs"));
const path = __importStar(require("path"));
const reader_1 = require("./reader");
const writer_1 = require("./writer");
const textFormat_1 = require("./textFormat");
const luaFormat_1 = require("./luaFormat");
const dictionary_1 = require("./dictionary");
const hash_1 = require("./hash");
const types_1 = require("./types");
const sga_1 = require("./sga");
const program = new commander_1.Command();
program
    .name('rgd')
    .description('RGD file parser and editor for Relic games (Dawn of War, Company of Heroes)')
    .version('1.0.0');
// Global options
program
    .option('-d, --dictionary <paths...>', 'Path(s) to hash dictionary file(s) or directory')
    .option('-v, --verbose', 'Verbose output');
/**
 * Get dictionary from options
 */
function getDictionary(options) {
    const dictPaths = options.dictionary ?? [];
    // Also check for common dictionary locations
    const commonPaths = [
        './rgd_dic.txt',
        './dictionaries',
        path.join(process.env.HOME || '', '.rgd-tools', 'dictionaries')
    ];
    const allPaths = [...dictPaths, ...commonPaths.filter(p => fs.existsSync(p))];
    return (0, dictionary_1.createAndLoadDictionaries)(allPaths);
}
// Convert RGD to text format
program
    .command('to-text <input>')
    .description('Convert binary RGD file to human-readable text format')
    .option('-o, --output <file>', 'Output file (default: stdout or input.rgd.txt)')
    .action((input, cmdOptions) => {
    const options = program.opts();
    const dict = getDictionary(options);
    try {
        const rgdFile = (0, reader_1.readRgdFile)(input, dict);
        const text = (0, textFormat_1.rgdToText)(rgdFile, path.basename(input));
        if (cmdOptions.output) {
            fs.writeFileSync(cmdOptions.output, text, 'utf8');
            console.log(`Written to ${cmdOptions.output}`);
        }
        else {
            console.log(text);
        }
    }
    catch (err) {
        console.error(`Error: ${err.message}`);
        process.exit(1);
    }
});
// Convert text format to RGD
program
    .command('to-rgd <input>')
    .description('Convert text format back to binary RGD file')
    .option('-o, --output <file>', 'Output file (default: input without .txt extension)')
    .option('--version <num>', 'RGD version (1 or 3)', '1')
    .action((input, cmdOptions) => {
    const options = program.opts();
    const dict = getDictionary(options);
    try {
        const text = fs.readFileSync(input, 'utf8');
        const { gameData, version } = (0, textFormat_1.textToRgd)(text, dict);
        const outputVersion = parseInt(cmdOptions.version, 10) || version;
        let output = cmdOptions.output;
        if (!output) {
            output = input.replace(/\.txt$/i, '');
            if (output === input)
                output = input + '.rgd';
        }
        (0, writer_1.writeRgdFile)(output, gameData, dict, outputVersion);
        console.log(`Written to ${output}`);
    }
    catch (err) {
        console.error(`Error: ${err.message}`);
        process.exit(1);
    }
});
// Convert RGD to Lua (differential format)
program
    .command('to-lua <input>')
    .description('Convert binary RGD file to Lua format (Corsix differential style)')
    .option('-o, --output <file>', 'Output file (default: input.lua)')
    .option('-a, --attrib <path>', 'Attrib base path for resolving references')
    .action(async (input, cmdOptions) => {
    const options = program.opts();
    const dict = getDictionary(options);
    try {
        const rgdFile = (0, reader_1.readRgdFile)(input, dict);
        // Determine attrib base
        let attribBase = cmdOptions.attrib;
        if (!attribBase) {
            const normalized = input.replace(/\\/g, '/').toLowerCase();
            const attribIndex = normalized.lastIndexOf('/attrib/');
            if (attribIndex !== -1) {
                attribBase = input.substring(0, attribIndex + '/attrib'.length);
            }
        }
        // Create Lua file loader for parent resolution
        const luaFileLoader = (refPath) => {
            if (!attribBase)
                return null;
            let cleanPath = refPath.replace(/\\/g, '/');
            if (cleanPath.endsWith('.lua')) {
                cleanPath = cleanPath.slice(0, -4);
            }
            const rgdPath = path.join(attribBase, cleanPath + '.rgd');
            if (fs.existsSync(rgdPath)) {
                const parentRgd = (0, reader_1.readRgdFile)(rgdPath, dict);
                return (0, luaFormat_1.rgdToLua)(parentRgd);
            }
            const luaPath = path.join(attribBase, cleanPath + '.lua');
            if (fs.existsSync(luaPath)) {
                return fs.readFileSync(luaPath, 'utf8');
            }
            return null;
        };
        // Create parent loader
        const parentLoader = async (refPath) => {
            const luaCode = luaFileLoader(refPath);
            if (!luaCode)
                return null;
            return (0, luaFormat_1.parseLuaToTable)(luaCode, luaFileLoader);
        };
        const luaCode = await (0, luaFormat_1.rgdToLuaDifferential)(rgdFile, parentLoader);
        let output = cmdOptions.output;
        if (!output) {
            output = input.replace(/\.rgd$/i, '.lua');
        }
        fs.writeFileSync(output, luaCode, 'utf8');
        console.log(`Written to ${output}`);
    }
    catch (err) {
        console.error(`Error: ${err.message}`);
        process.exit(1);
    }
});
// Convert Lua to RGD (with full resolution)
program
    .command('from-lua <input>')
    .description('Convert Lua file to binary RGD (resolves Inherit/Reference)')
    .option('-o, --output <file>', 'Output file (default: input.rgd)')
    .option('-a, --attrib <path>', 'Attrib base path for resolving references')
    .option('--version <num>', 'RGD version (1 or 3)', '1')
    .action(async (input, cmdOptions) => {
    const options = program.opts();
    const dict = getDictionary(options);
    try {
        const luaCode = fs.readFileSync(input, 'utf8');
        // Determine attrib base
        let attribBase = cmdOptions.attrib;
        if (!attribBase) {
            const normalized = input.replace(/\\/g, '/').toLowerCase();
            const attribIndex = normalized.lastIndexOf('/attrib/');
            if (attribIndex !== -1) {
                attribBase = input.substring(0, attribIndex + '/attrib'.length);
            }
        }
        // Create RGD parent loader
        const rgdParentLoader = async (refPath) => {
            if (!attribBase)
                return null;
            let cleanPath = refPath.replace(/\\/g, '/');
            if (cleanPath.endsWith('.lua')) {
                cleanPath = cleanPath.slice(0, -4);
            }
            // Try RGD file first
            const rgdPath = path.join(attribBase, cleanPath + '.rgd');
            if (fs.existsSync(rgdPath)) {
                const parentRgd = (0, reader_1.readRgdFile)(rgdPath, dict);
                return parentRgd.gameData;
            }
            // Try Lua file
            const luaPath = path.join(attribBase, cleanPath + '.lua');
            if (fs.existsSync(luaPath)) {
                const parentLuaCode = fs.readFileSync(luaPath, 'utf8');
                const { gameData } = await (0, luaFormat_1.luaToRgdResolved)(parentLuaCode, dict, rgdParentLoader);
                return gameData;
            }
            return null;
        };
        const { gameData, version: detectedVersion } = await (0, luaFormat_1.luaToRgdResolved)(luaCode, dict, rgdParentLoader);
        const outputVersion = parseInt(cmdOptions.version, 10) || detectedVersion;
        let output = cmdOptions.output;
        if (!output) {
            output = input.replace(/\.lua$/i, '.rgd');
        }
        (0, writer_1.writeRgdFile)(output, gameData, dict, outputVersion);
        console.log(`Written to ${output}`);
    }
    catch (err) {
        console.error(`Error: ${err.message}`);
        process.exit(1);
    }
});
// Convert RGD to CSV
program
    .command('to-csv <input>')
    .description('Convert RGD file to CSV format (flat key-value pairs)')
    .option('-o, --output <file>', 'Output file (default: stdout or input.csv)')
    .action((input, cmdOptions) => {
    const options = program.opts();
    const dict = getDictionary(options);
    try {
        const rgdFile = (0, reader_1.readRgdFile)(input, dict);
        const csv = (0, textFormat_1.rgdToCsv)(rgdFile);
        if (cmdOptions.output) {
            fs.writeFileSync(cmdOptions.output, csv, 'utf8');
            console.log(`Written to ${cmdOptions.output}`);
        }
        else {
            console.log(csv);
        }
    }
    catch (err) {
        console.error(`Error: ${err.message}`);
        process.exit(1);
    }
});
// Convert CSV to RGD
program
    .command('from-csv <input>')
    .description('Convert CSV back to binary RGD file')
    .option('-o, --output <file>', 'Output file (required)')
    .option('--version <num>', 'RGD version (1 or 3)', '1')
    .action((input, cmdOptions) => {
    const options = program.opts();
    const dict = getDictionary(options);
    if (!cmdOptions.output) {
        console.error('Error: --output is required for CSV conversion');
        process.exit(1);
    }
    try {
        const csv = fs.readFileSync(input, 'utf8');
        const gameData = (0, textFormat_1.csvToRgd)(csv, dict);
        const version = parseInt(cmdOptions.version, 10) || 1;
        (0, writer_1.writeRgdFile)(cmdOptions.output, gameData, dict, version);
        console.log(`Written to ${cmdOptions.output}`);
    }
    catch (err) {
        console.error(`Error: ${err.message}`);
        process.exit(1);
    }
});
// Dump RGD info
program
    .command('info <input>')
    .description('Show information about an RGD file')
    .action((input) => {
    const options = program.opts();
    const dict = getDictionary(options);
    try {
        const buffer = fs.readFileSync(input);
        const rgdFile = (0, reader_1.parseRgd)(buffer, dict);
        console.log(`File: ${input}`);
        console.log(`Size: ${buffer.length} bytes`);
        console.log(`Version: ${rgdFile.header.version}`);
        console.log(`Chunks: ${rgdFile.chunks.length}`);
        for (const chunk of rgdFile.chunks) {
            console.log(`  - ${chunk.type} (v${chunk.version}, ${chunk.data.length} bytes)`);
            if (chunk.descriptorString) {
                console.log(`    Descriptor: "${chunk.descriptorString}"`);
            }
        }
        // Count entries
        function countEntries(entries) {
            let total = 0;
            let tables = 0;
            for (const e of entries) {
                total++;
                if (e.type === types_1.RgdDataType.Table || e.type === types_1.RgdDataType.TableInt) {
                    tables++;
                    const child = countEntries(e.value.entries);
                    total += child.total;
                    tables += child.tables;
                }
            }
            return { total, tables };
        }
        const counts = countEntries(rgdFile.gameData.entries);
        console.log(`Total entries: ${counts.total}`);
        console.log(`Tables: ${counts.tables}`);
        if (rgdFile.gameData.reference) {
            console.log(`Reference: ${rgdFile.gameData.reference}`);
        }
    }
    catch (err) {
        console.error(`Error: ${err.message}`);
        process.exit(1);
    }
});
// Calculate hash
program
    .command('hash <string>')
    .description('Calculate the hash value for a string')
    .action((str) => {
    const h = (0, hash_1.hash)(str);
    console.log(`String: "${str}"`);
    console.log(`Hash:   ${(0, hash_1.hashToHex)(h)} (${h})`);
});
// Batch convert
program
    .command('batch <pattern>')
    .description('Batch convert RGD files (supports glob patterns)')
    .option('-f, --format <format>', 'Output format: text, csv', 'text')
    .option('-o, --output-dir <dir>', 'Output directory (default: same as input)')
    .action((pattern, cmdOptions) => {
    const options = program.opts();
    const dict = getDictionary(options);
    // Simple glob support for current directory
    const dir = path.dirname(pattern);
    const basePattern = path.basename(pattern);
    const regex = new RegExp('^' + basePattern.replace(/\*/g, '.*').replace(/\?/g, '.') + '$', 'i');
    const files = fs.readdirSync(dir || '.').filter(f => regex.test(f));
    if (files.length === 0) {
        console.log('No files matched the pattern');
        return;
    }
    const outputDir = cmdOptions.outputDir || dir || '.';
    if (!fs.existsSync(outputDir)) {
        fs.mkdirSync(outputDir, { recursive: true });
    }
    let processed = 0;
    let errors = 0;
    for (const file of files) {
        const inputPath = path.join(dir || '.', file);
        try {
            const rgdFile = (0, reader_1.readRgdFile)(inputPath, dict);
            let output;
            let ext;
            if (cmdOptions.format === 'csv') {
                output = (0, textFormat_1.rgdToCsv)(rgdFile);
                ext = '.csv';
            }
            else {
                output = (0, textFormat_1.rgdToText)(rgdFile, file);
                ext = '.txt';
            }
            const outputPath = path.join(outputDir, file + ext);
            fs.writeFileSync(outputPath, output, 'utf8');
            if (options.verbose) {
                console.log(`Converted: ${inputPath} -> ${outputPath}`);
            }
            processed++;
        }
        catch (err) {
            console.error(`Error processing ${inputPath}: ${err.message}`);
            errors++;
        }
    }
    console.log(`\nProcessed: ${processed} files`);
    if (errors > 0) {
        console.log(`Errors: ${errors} files`);
    }
});
// Extract dictionary
program
    .command('extract-dict <input...>')
    .description('Extract hash->name mappings from RGD files to create a dictionary')
    .option('-o, --output <file>', 'Output dictionary file', 'extracted.dic')
    .action((inputs, cmdOptions) => {
    const options = program.opts();
    const dict = getDictionary(options);
    const customHashes = new Set();
    for (const input of inputs) {
        try {
            const rgdFile = (0, reader_1.readRgdFile)(input, dict);
            // Traverse and collect all name->hash mappings
            function collectNames(entries) {
                for (const e of entries) {
                    if (e.name && !/^0x[0-9A-Fa-f]{8}$/.test(e.name)) {
                        const h = (0, dictionary_1.addToDictionary)(dict, e.name);
                        customHashes.add(h);
                    }
                    if (e.type === types_1.RgdDataType.Table || e.type === types_1.RgdDataType.TableInt) {
                        collectNames(e.value.entries);
                    }
                }
            }
            collectNames(rgdFile.gameData.entries);
            if (options.verbose) {
                console.log(`Processed: ${input}`);
            }
        }
        catch (err) {
            console.error(`Error processing ${input}: ${err.message}`);
        }
    }
    (0, dictionary_1.saveDictionary)(dict, cmdOptions.output, customHashes);
    console.log(`Dictionary saved to ${cmdOptions.output}`);
    console.log(`Entries: ${customHashes.size}`);
});
// SGA Archive commands
program
    .command('sga-list <archive>')
    .description('List files in an SGA archive')
    .option('-r, --rgd-only', 'List only RGD files')
    .option('-p, --pattern <pattern>', 'Filter by regex pattern')
    .action((archive, cmdOptions) => {
    try {
        const sga = (0, sga_1.openSgaArchive)(archive);
        console.log(`Archive: ${archive}`);
        console.log(`Version: ${sga.version}`);
        console.log(`Type: ${sga.archiveType}`);
        console.log('');
        let files;
        if (cmdOptions.rgdOnly) {
            files = sga.listRgdFiles();
        }
        else if (cmdOptions.pattern) {
            files = sga.listFiles(new RegExp(cmdOptions.pattern, 'i'));
        }
        else {
            files = sga.listFiles();
        }
        console.log(`Files: ${files.length}`);
        console.log('---');
        for (const file of files) {
            const compressed = file.isCompressed ? ` (${file.compressedSize} compressed)` : '';
            console.log(`${file.path} - ${file.size} bytes${compressed}`);
        }
    }
    catch (err) {
        console.error(`Error: ${err.message}`);
        process.exit(1);
    }
});
program
    .command('sga-extract <archive>')
    .description('Extract files from an SGA archive')
    .option('-o, --output <dir>', 'Output directory', './extracted')
    .option('-r, --rgd-only', 'Extract only RGD files')
    .option('-p, --pattern <pattern>', 'Filter by regex pattern')
    .option('-c, --convert', 'Convert extracted RGD files to text format')
    .action((archive, cmdOptions) => {
    const options = program.opts();
    const dict = getDictionary(options);
    try {
        const sga = (0, sga_1.openSgaArchive)(archive);
        console.log(`Extracting from: ${archive}`);
        console.log(`Output directory: ${cmdOptions.output}`);
        let extracted;
        if (cmdOptions.rgdOnly) {
            extracted = sga.extractRgdFiles(cmdOptions.output);
        }
        else if (cmdOptions.pattern) {
            extracted = sga.extractFiles(cmdOptions.output, new RegExp(cmdOptions.pattern, 'i'));
        }
        else {
            extracted = sga.extractFiles(cmdOptions.output);
        }
        console.log(`Extracted ${extracted.length} files`);
        // Optionally convert RGD files to text
        if (cmdOptions.convert) {
            const rgdFiles = extracted.filter(f => f.toLowerCase().endsWith('.rgd'));
            let converted = 0;
            for (const rgdPath of rgdFiles) {
                try {
                    const rgdFile = (0, reader_1.readRgdFile)(rgdPath, dict);
                    const text = (0, textFormat_1.rgdToText)(rgdFile, path.basename(rgdPath));
                    const textPath = rgdPath + '.txt';
                    fs.writeFileSync(textPath, text, 'utf8');
                    converted++;
                    if (options.verbose) {
                        console.log(`Converted: ${rgdPath} -> ${textPath}`);
                    }
                }
                catch (e) {
                    console.error(`Failed to convert ${rgdPath}: ${e.message}`);
                }
            }
            console.log(`Converted ${converted} RGD files to text`);
        }
    }
    catch (err) {
        console.error(`Error: ${err.message}`);
        process.exit(1);
    }
});
program
    .command('sga-get <archive> <file>')
    .description('Extract and convert a single file from SGA')
    .option('-o, --output <file>', 'Output file')
    .option('-t, --text', 'Convert RGD to text format')
    .action((archive, file, cmdOptions) => {
    const options = program.opts();
    const dict = getDictionary(options);
    try {
        const sga = (0, sga_1.openSgaArchive)(archive);
        const data = sga.extractFile(file);
        let outputPath = cmdOptions.output || path.basename(file);
        if (cmdOptions.text && file.toLowerCase().endsWith('.rgd')) {
            // Convert to text
            const rgdFile = (0, reader_1.parseRgd)(data, dict);
            const text = (0, textFormat_1.rgdToText)(rgdFile, path.basename(file));
            if (!outputPath.endsWith('.txt')) {
                outputPath += '.txt';
            }
            fs.writeFileSync(outputPath, text, 'utf8');
            console.log(`Extracted and converted to: ${outputPath}`);
        }
        else {
            fs.writeFileSync(outputPath, data);
            console.log(`Extracted to: ${outputPath}`);
        }
    }
    catch (err) {
        console.error(`Error: ${err.message}`);
        process.exit(1);
    }
});
program.parse();
//# sourceMappingURL=data:application/json;base64,eyJ2ZXJzaW9uIjozLCJmaWxlIjoiY2xpLmpzIiwic291cmNlUm9vdCI6IiIsInNvdXJjZXMiOlsiLi4vc3JjL2NsaS50cyJdLCJuYW1lcyI6W10sIm1hcHBpbmdzIjoiOzs7Ozs7Ozs7Ozs7Ozs7Ozs7Ozs7Ozs7Ozs7Ozs7Ozs7Ozs7QUFFQSx5Q0FBb0M7QUFDcEMsdUNBQXlCO0FBQ3pCLDJDQUE2QjtBQUM3QixxQ0FBaUQ7QUFDakQscUNBQWtEO0FBQ2xELDZDQUF3RTtBQUN4RSwyQ0FBZ0k7QUFDaEksNkNBQTBGO0FBQzFGLGlDQUF5QztBQUN6QyxtQ0FBc0Q7QUFDdEQsK0JBQW1EO0FBRW5ELE1BQU0sT0FBTyxHQUFHLElBQUksbUJBQU8sRUFBRSxDQUFDO0FBRTlCLE9BQU87S0FDRSxJQUFJLENBQUMsS0FBSyxDQUFDO0tBQ1gsV0FBVyxDQUFDLDZFQUE2RSxDQUFDO0tBQzFGLE9BQU8sQ0FBQyxPQUFPLENBQUMsQ0FBQztBQUUxQixpQkFBaUI7QUFDakIsT0FBTztLQUNFLE1BQU0sQ0FBQyw2QkFBNkIsRUFBRSxpREFBaUQsQ0FBQztLQUN4RixNQUFNLENBQUMsZUFBZSxFQUFFLGdCQUFnQixDQUFDLENBQUM7QUFFbkQ7O0dBRUc7QUFDSCxTQUFTLGFBQWEsQ0FBQyxPQUFZO0lBQzNCLE1BQU0sU0FBUyxHQUFHLE9BQU8sQ0FBQyxVQUFVLElBQUksRUFBRSxDQUFDO0lBRTNDLDZDQUE2QztJQUM3QyxNQUFNLFdBQVcsR0FBRztRQUNaLGVBQWU7UUFDZixnQkFBZ0I7UUFDaEIsSUFBSSxDQUFDLElBQUksQ0FBQyxPQUFPLENBQUMsR0FBRyxDQUFDLElBQUksSUFBSSxFQUFFLEVBQUUsWUFBWSxFQUFFLGNBQWMsQ0FBQztLQUN0RSxDQUFDO0lBRUYsTUFBTSxRQUFRLEdBQUcsQ0FBQyxHQUFHLFNBQVMsRUFBRSxHQUFHLFdBQVcsQ0FBQyxNQUFNLENBQUMsQ0FBQyxDQUFDLEVBQUUsQ0FBQyxFQUFFLENBQUMsVUFBVSxDQUFDLENBQUMsQ0FBQyxDQUFDLENBQUMsQ0FBQztJQUM5RSxPQUFPLElB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QixDQUFDO1lBRUQsRUFBRSxDQUFDLGFBQWEsQ0FBQyxVQUFVLEVBQUUsSUFBSSxFQUFFLE1BQU0sQ0FBQyxDQUFDO1lBQzNDLE9BQU8sQ0FBQyxHQUFHLENBQUMsK0JBQStCLFVBQVUsRUFBRSxDQUFDLENBQUM7UUFDakUsQ0FBQzthQUFNLENBQUM7WUFDQSxFQUFFLENBQUMsYUFBYSxDQUFDLFVBQVUsRUFBRSxJQUFJLENBQUMsQ0FBQztZQUNuQyxPQUFPLENBQUMsR0FBRyxDQUFDLGlCQUFpQixVQUFVLEVBQUUsQ0FBQyxDQUFDO1FBQ25ELENBQUM7SUFDVCxDQUFDO0lBQUMsT0FBTyxHQUFRLEVBQUUsQ0FBQztRQUNaLE9BQU8sQ0FBQyxLQUFLLENBQUMsVUFBVSxHQUFHLENBQUMsT0FBTyxFQUFFLENBQUMsQ0FBQztRQUN2QyxPQUFPLENBQUMsSUFBSSxDQUFDLENBQUMsQ0FBQyxDQUFDO0lBQ3hCLENBQUM7QUFDVCxDQUFDLENBQUMsQ0FBQztBQUVYLE9BQU8sQ0FBQyxLQUFLLEVBQUUsQ0FBQyIsInNvdXJjZXNDb250ZW50IjpbIiMhL3Vzci9iaW4vZW52IG5vZGVcclxuXHJcbmltcG9ydCB7IENvbW1hbmQgfSBmcm9tICdjb21tYW5kZXInO1xyXG5pbXBvcnQgKiBhcyBmcyBmcm9tICdmcyc7XHJcbmltcG9ydCAqIGFzIHBhdGggZnJvbSAncGF0aCc7XHJcbmltcG9ydCB7IHJlYWRSZ2RGaWxlLCBwYXJzZVJnZCB9IGZyb20gJy4vcmVhZGVyJztcclxuaW1wb3J0IHsgYnVpbGRSZ2QsIHdyaXRlUmdkRmlsZSB9IGZyb20gJy4vd3JpdGVyJztcclxuaW1wb3J0IHsgcmdkVG9UZXh0LCB0ZXh0VG9SZ2QsIHJnZFRvQ3N2LCBjc3ZUb1JnZCB9IGZyb20gJy4vdGV4dEZvcm1hdCc7XHJcbmltcG9ydCB7IHJnZFRvTHVhRGlmZmVyZW50aWFsLCByZ2RUb0x1YSwgbHVhVG9SZ2RSZXNvbHZlZCwgcGFyc2VMdWFUb1RhYmxlLCBMdWFGaWxlTG9hZGVyLCBSZ2RQYXJlbnRMb2FkZXIgfSBmcm9tICcuL2x1YUZvcm1hdCc7XHJcbmltcG9ydCB7IGNyZWF0ZUFuZExvYWREaWN0aW9uYXJpZXMsIHNhdmVEaWN0aW9uYXJ5LCBhZGRUb0RpY3Rpb25hcnkgfSBmcm9tICcuL2RpY3Rpb25hcnknO1xyXG5pbXBvcnQgeyBoYXNoLCBoYXNoVG9IZXggfSBmcm9tICcuL2hhc2gnO1xyXG5pbXBvcnQgeyBSZ2REYXRhVHlwZSwgSGFzaERpY3Rpb25hcnkgfSBmcm9tICcuL3R5cGVzJztcclxuaW1wb3J0IHsgU2dhQXJjaGl2ZSwgb3BlblNnYUFyY2hpdmUgfSBmcm9tICcuL3NnYSc7XHJcblxyXG5jb25zdCBwcm9ncmFtID0gbmV3IENvbW1hbmQoKTtcclxuXHJcbnByb2dyYW1cclxuICAgICAgICAubmFtZSgncmdkJylcclxuICAgICAgICAuZGVzY3JpcHRpb24oJ1JHRCBmaWxlIHBhcnNlciBhbmQgZWRpdG9yIGZvciBSZWxpYyBnYW1lcyAoRGF3biBvZiBXYXIsIENvbXBhbnkgb2YgSGVyb2VzKScpXHJcbiAgICAgICAgLnZlcnNpb24oJzEuMC4wJyk7XHJcblxyXG4vLyBHbG9iYWwgb3B0aW9uc1xyXG5wcm9ncmFtXHJcbiAgICAgICAgLm9wdGlvbignLWQsIC0tZGljdGlvbmFyeSA8cGF0aHMuLi4+JywgJ1BhdGgocykgdG8gaGFzaCBkaWN0aW9uYXJ5IGZpbGUocykgb3IgZGlyZWN0b3J5JylcclxuICAgICAgICAub3B0aW9uKCctdiwgLS12ZXJib3NlJywgJ1ZlcmJvc2Ugb3V0cHV0Jyk7XHJcblxyXG4vKipcclxuICogR2V0IGRpY3Rpb25hcnkgZnJvbSBvcHRpb25zXHJcbiAqL1xyXG5mdW5jdGlvbiBnZXREaWN0aW9uYXJ5KG9wdGlvbnM6IGFueSk6IEhhc2hEaWN0aW9uYXJ5IHtcclxuICAgICAgICBjb25zdCBkaWN0UGF0aHMgPSBvcHRpb25zLmRpY3Rpb25hcnkgPz8gW107XHJcblxyXG4gICAgICAgIC8vIEFsc28gY2hlY2sgZm9yIGNvbW1vbiBkaWN0aW9uYXJ5IGxvY2F0aW9uc1xyXG4gICAgICAgIGNvbnN0IGNvbW1vblBhdGhzID0gW1xyXG4gICAgICAgICAgICAgICAgJy4vcmdkX2RpYy50eHQnLFxyXG4gICAgICAgICAgICAgICAgJy4vZGljdGlvbmFyaWVzJyxcclxuICAgICAgICAgICAgICAgIHBhdGguam9pbihwcm9jZXNzLmVudi5IT01FIHx8ICcnLCAnLnJnZC10b29scycsICdkaWN0aW9uYXJpZXMnKVxyXG4gICAgICAgIF07XHJcblxyXG4gICAgICAgIGNvbnN0IGFsbFBhdGhzID0gWy4uLmRpY3RQYXRocywgLi4uY29tbW9uUGF0aHMuZmlsdGVyKHAgPT4gZnMuZXhpc3RzU3luYyhwKSldO1xyXG4gICAgICAgIHJldHVybiBjcmVhdGVBbmRMb2FkRGljdGlvbmFyaWVzKGFsbFBhdGhzKTtcclxufVxyXG5cclxuLy8gQ29udmVydCBSR0QgdG8gdGV4dCBmb3JtYXRcclxucHJvZ3JhbVxyXG4gICAgICAgIC5jb21tYW5kKCd0by10ZXh0IDxpbnB1dD4nKVxyXG4gICAgICAgIC5kZXNjcmlwdGlvbignQ29udmVydCBiaW5hcnkgUkdEIGZpbGUgdG8gaHVtYW4tcmVhZGFibGUgdGV4dCBmb3JtYXQnKVxyXG4gICAgICAgIC5vcHRpb24oJy1vLCAtLW91dHB1dCA8ZmlsZT4nLCAnT3V0cHV0IGZpbGUgKGRlZmF1bHQ6IHN0ZG91dCBvciBpbnB1dC5yZ2QudHh0KScpXHJcbiAgICAgICAgLmFjdGlvbigoaW5wdXQ6IHN0cmluZywgY21kT3B0aW9uczogYW55KSA9PiB7XHJcbiAgICAgICAgICAgICAgICBjb25zdCBvcHRpb25zID0gcHJvZ3JhbS5vcHRzKCk7XHJcbiAgICAgICAgICAgICAgICBjb25zdCBkaWN0ID0gZ2V0RGljdGlvbmFyeShvcHRpb25zKTtcclxuXHJcbiAgICAgICAgICAgICAgICB0cnkge1xyXG4gICAgICAgICAgICAgICAgICAgICAgICBjb25zdCByZ2RGaWxlID0gcmVhZFJnZEZpbGUoaW5wdXQsIGRpY3QpO1xyXG4gICAgICAgICAgICAgICAgICAgICAgICBjb25zdCB0ZXh0ID0gcmdkVG9UZXh0KHJnZEZpbGUsIHBhdGguYmFzZW5hbWUoaW5wdXQpKTtcclxuXHJcbiAgICAgICAgICAgICAgICAgICAgICAgIGlmIChjbWRPcHRpb25zLm91dHB1dCkge1xyXG4gICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgIGZzLndyaXRlRmlsZVN5bmMoY21kT3B0aW9ucy5vdXRwdXQsIHRleHQsICd1dGY4Jyk7XHJcbiAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgY29uc29sZS5sb2coYFdyaXR0ZW4gdG8gJHtjbWRPcHRpb25zLm91dHB1dH1gKTtcclxuICAgICAgICAgICAgICAgICAgICAgICAgfSBlbHNlIHtcclxuICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICBjb25zb2xlLmxvZyh0ZXh0KTtcclxuICAgICAgICAgICAgICAgICAgICAgICAgfVxyXG4gICAgICAgICAgICAgICAgfSBjYXRjaCAoZXJyOiBhbnkpIHtcclxuICAgICAgICAgICAgICAgICAgICAgICAgY29uc29sZS5lcnJvcihgRXJyb3I6ICR7ZXJyLm1lc3NhZ2V9YCk7XHJcbiAgICAgICAgICAgICAgICAgICAgICAgIHByb2Nlc3MuZXhpdCgxKTtcclxuICAgICAgICAgICAgICAgIH1cclxuICAgICAgICB9KTtcclxuXHJcbi8vIENvbnZlcnQgdGV4dCBmb3JtYXQgdG8gUkdEXHJcbnByb2dyYW1cclxuICAgICAgICAuY29tbWFuZCgndG8tcmdkIDxpbnB1dD4nKVxyXG4gICAgICAgIC5kZXNjcmlwdGlvbignQ29udmVydCB0ZXh0IGZvcm1hdCBiYWNrIHRvIGJpbmFyeSBSR0QgZmlsZScpXHJcbiAgICAgICAgLm9wdGlvbignLW8sIC0tb3V0cHV0IDxmaWxlPicsICdPdXRwdXQgZmlsZSAoZGVmYXVsdDogaW5wdXQgd2l0aG91dCAudHh0IGV4dGVuc2lvbiknKVxyXG4gICAgICAgIC5vcHRpb24oJy0tdmVyc2lvbiA8bnVtPicsICdSR0QgdmVyc2lvbiAoMSBvciAzKScsICcxJylcclxuICAgICAgICAuYWN0aW9uKChpbnB1dDogc3RyaW5nLCBjbWRPcHRpb25zOiBhbnkpID0+IHtcclxuICAgICAgICAgICAgICAgIGNvbnN0IG9wdGlvbnMgPSBwcm9ncmFtLm9wdHMoKTtcclxuICAgICAgICAgICAgICAgIGNvbnN0IGRpY3QgPSBnZXREaWN0aW9uYXJ5KG9wdGlvbnMpO1xyXG5cclxuICAgICAgICAgICAgICAgIHRyeSB7XHJcbiAgICAgICAgICAgICAgICAgICAgICAgIGNvbnN0IHRleHQgPSBmcy5yZWFkRmlsZVN5bmMoaW5wdXQsICd1dGY4Jyk7XHJcbiAgICAgICAgICAgICAgICAgICAgICAgIGNvbnN0IHsgZ2FtZURhdGEsIHZlcnNpb24gfSA9IHRleHRUb1JnZCh0ZXh0LCBkaWN0KTtcclxuXHJcbiAgICAgICAgICAgICAgICAgICAgICAgIGNvbnN0IG91dHB1dFZlcnNpb24gPSBwYXJzZUludChjbWRPcHRpb25zLnZlcnNpb24sIDEwKSB8fCB2ZXJzaW9uO1xyXG5cclxuICAgICAgICAgICAgICAgICAgICAgICAgbGV0IG91dHB1dCA9IGNtZE9wdGlvbnMub3V0cHV0O1xyXG4gICAgICAgICAgICAgICAgICAgICAgICBpZiAoIW91dHB1dCkge1xyXG4gICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgIG91dHB1dCA9IGlucHV0LnJlcGxhY2UoL1xcLnR4dCQvaSwgJycpO1xyXG4gICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgIGlmIChvdXRwdXQgPT09IGlucHV0KSBvdXRwdXQgPSBpbnB1dCArICcucmdkJztcclxuICAgICAgICAgICAgICAgICAgICAgICAgfVxyXG5cclxuICAgICAgICAgICAgICAgICAgICAgICAgd3JpdGVSZ2RGaWxlKG91dHB1dCwgZ2FtZURhdGEsIGRpY3QsIG91dHB1dFZlcnNpb24pO1xyXG4gICAgICAgICAgICAgICAgICAgICAgICBjb25zb2xlLmxvZyhgV3JpdHRlbiB0byAke291dHB1dH1gKTtcclxuICAgICAgICAgICAgICAgIH0gY2F0Y2ggKGVycjogYW55KSB7XHJcbiAgICAgICAgICAgICAgICAgICAgICAgIGNvbnNvbGUuZXJyb3IoYEVycm9yOiAke2Vyci5tZXNzYWdlfWApO1xyXG4gICAgICAgICAgICAgICAgICAgICAgICBwcm9jZXNzLmV4aXQoMSk7XHJcbiAgICAgICAgICAgICAgICB9XHJcbiAgICAgICAgfSk7XHJcblxyXG4vLyBDb252ZXJ0IFJHRCB0byBMdWEgKGRpZmZlcmVudGlhbCBmb3JtYXQpXHJcbnByb2dyYW1cclxuICAgICAgICAuY29tbWFuZCgndG8tbHVhIDxpbnB1dD4nKVxyXG4gICAgICAgIC5kZXNjcmlwdGlvbignQ29udmVydCBiaW5hcnkgUkdEIGZpbGUgdG8gTHVhIGZvcm1hdCAoQ29yc2l4IGRpZmZlcmVudGlhbCBzdHlsZSknKVxyXG4gICAgICAgIC5vcHRpb24oJy1vLCAtLW91dHB1dCA8ZmlsZT4nLCAnT3V0cHV0IGZpbGUgKGRlZmF1bHQ6IGlucHV0Lmx1YSknKVxyXG4gICAgICAgIC5vcHRpb24oJy1hLCAtLWF0dHJpYiA8cGF0aD4nLCAnQXR0cmliIGJhc2UgcGF0aCBmb3IgcmVzb2x2aW5nIHJlZmVyZW5jZXMnKVxyXG4gICAgICAgIC5hY3Rpb24oYXN5bmMgKGlucHV0OiBzdHJpbmcsIGNtZE9wdGlvbnM6IGFueSkgPT4ge1xyXG4gICAgICAgICAgICAgICAgY29uc3Qgb3B0aW9ucyA9IHByb2dyYW0ub3B0cygpO1xyXG4gICAgICAgICAgICAgICAgY29uc3QgZGljdCA9IGdldERpY3Rpb25hcnkob3B0aW9ucyk7XHJcblxyXG4gICAgICAgICAgICAgICAgdHJ5IHtcclxuICAgICAgICAgICAgICAgICAgICAgICAgY29uc3QgcmdkRmlsZSA9IHJlYWRSZ2RGaWxlKGlucHV0LCBkaWN0KTtcclxuXHJcbiAgICAgICAgICAgICAgICAgICAgICAgIC8vIERldGVybWluZSBhdHRyaWIgYmFzZVxyXG4gICAgICAgICAgICAgICAgICAgICAgICBsZXQgYXR0cmliQmFzZSA9IGNtZE9wdGlvbnMuYXR0cmliO1xyXG4gICAgICAgICAgICAgICAgICAgICAgICBpZiAoIWF0dHJpYkJhc2UpIHtcclxuICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICBjb25zdCBub3JtYWxpemVkID0gaW5wdXQucmVwbGFjZSgvXFxcXC9nLCAnLycpLnRvTG93ZXJDYXNlKCk7XHJcbiAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgY29uc3QgYXR0cmliSW5kZXggPSBub3JtYWxpemVkLmxhc3RJbmRleE9mKCcvYXR0cmliLycpO1xyXG4gICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgIGlmIChhdHRyaWJJbmRleCAhPT0gLTEpIHtcclxuICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgIGF0dHJpYkJhc2UgPSBpbnB1dC5zdWJzdHJpbmcoMCwgYXR0cmliSW5kZXggKyAnL2F0dHJpYicubGVuZ3RoKTtcclxuICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICB9XHJcbiAgICAgICAgICAgICAgICAgICAgICAgIH1cclxuXHJcbiAgICAgICAgICAgICAgICAgICAgICAgIC8vIENyZWF0ZSBMdWEgZmlsZSBsb2FkZXIgZm9yIHBhcmVudCByZXNvbHV0aW9uXHJcbiAgICAgICAgICAgICAgICAgICAgICAgIGNvbnN0IGx1YUZpbGVMb2FkZXI6IEx1YUZpbGVMb2FkZXIgPSAocmVmUGF0aDogc3RyaW5nKTogc3RyaW5nIHwgbnVsbCA9PiB7XHJcbiAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgaWYgKCFhdHRyaWJCYXNlKSByZXR1cm4gbnVsbDtcclxuXHJcbiAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgbGV0IGNsZWFuUGF0aCA9IHJlZlBhdGgucmVwbGFjZSgvXFxcXC9nLCAnLycpO1xyXG4gICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgIGlmIChjbGVhblBhdGguZW5kc1dpdGgoJy5sdWEnKSkge1xyXG4gICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgY2xlYW5QYXRoID0gY2xlYW5QYXRoLnNsaWNlKDAsIC00KTtcclxuICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICB9XHJcblxyXG4gICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgIGNvbnN0IHJnZFBhdGggPSBwYXRoLmpvaW4oYXR0cmliQmFzZSwgY2xlYW5QYXRoICsgJy5yZ2QnKTtcclxuICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICBpZiAoZnMuZXhpc3RzU3luYyhyZ2RQYXRoKSkge1xyXG4gICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgY29uc3QgcGFyZW50UmdkID0gcmVhZFJnZEZpbGUocmdkUGF0aCwgZGljdCk7XHJcbiAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICByZXR1cm4gcmdkVG9MdWEocGFyZW50UmdkKTtcclxuICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICB9XHJcblxyXG4gICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgIGNvbnN0IGx1YVBhdGggPSBwYXRoLmpvaW4oYXR0cmliQmFzZSwgY2xlYW5QYXRoICsgJy5sdWEnKTtcclxuICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICBpZiAoZnMuZXhpc3RzU3luYyhsdWFQYXRoKSkge1xyXG4gICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgcmV0dXJuIGZzLnJlYWRGaWxlU3luYyhsdWFQYXRoLCAndXRmOCcpO1xyXG4gICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgIH1cclxuXHJcbiAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgcmV0dXJuIG51bGw7XHJcbiAgICAgICAgICAgICAgICAgICAgICAgIH07XHJcblxyXG4gICAgICAgICAgICAgICAgICAgICAgICAvLyBDcmVhdGUgcGFyZW50IGxvYWRlclxyXG4gICAgICAgICAgICAgICAgICAgICAgICBjb25zdCBwYXJlbnRMb2FkZXIgPSBhc3luYyAocmVmUGF0aDogc3RyaW5nKSA9PiB7XHJcbiAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgY29uc3QgbHVhQ29kZSA9IGx1YUZpbGVMb2FkZXIocmVmUGF0aCk7XHJcbiAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgaWYgKCFsdWFDb2RlKSByZXR1cm4gbnVsbDtcclxuICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICByZXR1cm4gcGFyc2VMdWFUb1RhYmxlKGx1YUNvZGUsIGx1YUZpbGVMb2FkZXIpO1xyXG4gICAgICAgICAgICAgICAgICAgICAgICB9O1xyXG5cclxuICAgICAgICAgICAgICAgICAgICAgICAgY29uc3QgbHVhQ29kZSA9IGF3YWl0IHJnZFRvTHVhRGlmZmVyZW50aWFsKHJnZEZpbGUsIHBhcmVudExvYWRlcik7XHJcblxyXG4gICAgICAgICAgICAgICAgICAgICAgICBsZXQgb3V0cHV0ID0gY21kT3B0aW9ucy5vdXRwdXQ7XHJcbiAgICAgICAgICAgICAgICAgICAgICAgIGlmICghb3V0cHV0KSB7XHJcbiAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgb3V0cHV0ID0gaW5wdXQucmVwbGFjZSgvXFwucmdkJC9pLCAnLmx1YScpO1xyXG4gICAgICAgICAgICAgICAgICAgICAgICB9XHJcblxyXG4gICAgICAgICAgICAgICAgICAgICAgICBmcy53cml0ZUZpbGVTeW5jKG91dHB1dCwgbHVhQ29kZSwgJ3V0ZjgnKTtcclxuICAgICAgICAgICAgICAgICAgICAgICAgY29uc29sZS5sb2coYFdyaXR0ZW4gdG8gJHtvdXRwdXR9YCk7XHJcbiAgICAgICAgICAgICAgICB9IGNhdGNoIChlcnI6IGFueSkge1xyXG4gICAgICAgICAgICAgICAgICAgICAgICBjb25zb2xlLmVycm9yKGBFcnJvcjogJHtlcnIubWVzc2FnZX1gKTtcclxuICAgICAgICAgICAgICAgICAgICAgICAgcHJvY2Vzcy5leGl0KDEpO1xyXG4gICAgICAgICAgICAgICAgfVxyXG4gICAgICAgIH0pO1xyXG5cclxuLy8gQ29udmVydCBMdWEgdG8gUkdEICh3aXRoIGZ1bGwgcmVzb2x1dGlvbilcclxucHJvZ3JhbVxyXG4gICAgICAgIC5jb21tYW5kKCdmcm9tLWx1YSA8aW5wdXQ+JylcclxuICAgICAgICAuZGVzY3JpcHRpb24oJ0NvbnZlcnQgTHVhIGZpbGUgdG8gYmluYXJ5IFJHRCAocmVzb2x2ZXMgSW5oZXJpdC9SZWZlcmVuY2UpJylcclxuICAgICAgICAub3B0aW9uKCctbywgLS1vdXRwdXQgPGZpbGU+JywgJ091dHB1dCBmaWxlIChkZWZhdWx0OiBpbnB1dC5yZ2QpJylcclxuICAgICAgICAub3B0aW9uKCctYSwgLS1hdHRyaWIgPHBhdGg+JywgJ0F0dHJpYiBiYXNlIHBhdGggZm9yIHJlc29sdmluZyByZWZlcmVuY2VzJylcclxuICAgICAgICAub3B0aW9uKCctLXZlcnNpb24gPG51bT4nLCAnUkdEIHZlcnNpb24gKDEgb3IgMyknLCAnMScpXHJcbiAgICAgICAgLmFjdGlvbihhc3luYyAoaW5wdXQ6IHN0cmluZywgY21kT3B0aW9uczogYW55KSA9PiB7XHJcbiAgICAgICAgICAgICAgICBjb25zdCBvcHRpb25zID0gcHJvZ3JhbS5vcHRzKCk7XHJcbiAgICAgICAgICAgICAgICBjb25zdCBkaWN0ID0gZ2V0RGljdGlvbmFyeShvcHRpb25zKTtcclxuXHJcbiAgICAgICAgICAgICAgICB0cnkge1xyXG4gICAgICAgICAgICAgICAgICAgICAgICBjb25zdCBsdWFDb2RlID0gZnMucmVhZEZpbGVTeW5jKGlucHV0LCAndXRmOCcpO1xyXG5cclxuICAgICAgICAgICAgICAgICAgICAgICAgLy8gRGV0ZXJtaW5lIGF0dHJpYiBiYXNlXHJcbiAgICAgICAgICAgICAgICAgICAgICAgIGxldCBhdHRyaWJCYXNlID0gY21kT3B0aW9ucy5hdHRyaWI7XHJcbiAgICAgICAgICAgICAgICAgICAgICAgIGlmICghYXR0cmliQmFzZSkge1xyXG4gICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgIGNvbnN0IG5vcm1hbGl6ZWQgPSBpbnB1dC5yZXBsYWNlKC9cXFxcL2csICcvJykudG9Mb3dlckNhc2UoKTtcclxuICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICBjb25zdCBhdHRyaWJJbmRleCA9IG5vcm1hbGl6ZWQubGFzdEluZGV4T2YoJy9hdHRyaWIvJyk7XHJcbiAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgaWYgKGF0dHJpYkluZGV4ICE9PSAtMSkge1xyXG4gICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgYXR0cmliQmFzZSA9IGlucHV0LnN1YnN0cmluZygwLCBhdHRyaWJJbmRleCArICcvYXR0cmliJy5sZW5ndGgpO1xyXG4gICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgIH1cclxuICAgICAgICAgICAgICAgICAgICAgICAgfVxyXG5cclxuICAgICAgICAgICAgICAgICAgICAgICAgLy8gQ3JlYXRlIFJHRCBwYXJlbnQgbG9hZGVyXHJcbiAgICAgICAgICAgICAgICAgICAgICAgIGNvbnN0IHJnZFBhcmVudExvYWRlcjogUmdkUGFyZW50TG9hZGVyID0gYXN5bmMgKHJlZlBhdGg6IHN0cmluZykgPT4ge1xyXG4gICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgIGlmICghYXR0cmliQmFzZSkgcmV0dXJuIG51bGw7XHJcblxyXG4gICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgIGxldCBjbGVhblBhdGggPSByZWZQYXRoLnJlcGxhY2UoL1xcXFwvZywgJy8nKTtcclxuICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICBpZiAoY2xlYW5QYXRoLmVuZHNXaXRoKCcubHVhJykpIHtcclxuICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgIGNsZWFuUGF0aCA9IGNsZWFuUGF0aC5zbGljZSgwLCAtNCk7XHJcbiAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgfVxyXG5cclxuICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAvLyBUcnkgUkdEIGZpbGUgZmlyc3RcclxuICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICBjb25zdCByZ2RQYXRoID0gcGF0aC5qb2luKGF0dHJpYkJhc2UsIGNsZWFuUGF0aCArICcucmdkJyk7XHJcbiAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgaWYgKGZzLmV4aXN0c1N5bmMocmdkUGF0aCkpIHtcclxuICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgIGNvbnN0IHBhcmVudFJnZCA9IHJlYWRSZ2RGaWxlKHJnZFBhdGgsIGRpY3QpO1xyXG4gICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgcmV0dXJuIHBhcmVudFJnZC5nYW1lRGF0YTtcclxuICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICB9XHJcblxyXG4gICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgIC8vIFRyeSBMdWEgZmlsZVxyXG4gICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgIGNvbnN0IGx1YVBhdGggPSBwYXRoLmpvaW4oYXR0cmliQmFzZSwgY2xlYW5QYXRoICsgJy5sdWEnKTtcclxuICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICBpZiAoZnMuZXhpc3RzU3luYyhsdWFQYXRoKSkge1xyXG4gICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgY29uc3QgcGFyZW50THVhQ29kZSA9IGZzLnJlYWRGaWxlU3luYyhsdWFQYXRoLCAndXRmOCcpO1xyXG4gICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgY29uc3QgeyBnYW1lRGF0YSB9ID0gYXdhaXQgbHVhVG9SZ2RSZXNvbHZlZChwYXJlbnRMdWFDb2RlLCBkaWN0LCByZ2RQYXJlbnRMb2FkZXIpO1xyXG4gICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgcmV0dXJuIGdhbWVEYXRhO1xyXG4gICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgIH1cclxuXHJcbiAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgcmV0dXJuIG51bGw7XHJcbiAgICAgICAgICAgICAgICAgICAgICAgIH07XHJcblxyXG4gICAgICAgICAgICAgICAgICAgICAgICBjb25zdCB7IGdhbWVEYXRhLCB2ZXJzaW9uOiBkZXRlY3RlZFZlcnNpb24gfSA9IGF3YWl0IGx1YVRvUmdkUmVzb2x2ZWQobHVhQ29kZSwgZGljdCwgcmdkUGFyZW50TG9hZGVyKTtcclxuICAgICAgICAgICAgICAgICAgICAgICAgY29uc3Qgb3V0cHV0VmVyc2lvbiA9IHBhcnNlSW50KGNtZE9wdGlvbnMudmVyc2lvbiwgMTApIHx8IGRldGVjdGVkVmVyc2lvbjtcclxuXHJcbiAgICAgICAgICAgICAgICAgICAgICAgIGxldCBvdXRwdXQgPSBjbWRPcHRpb25zLm91dHB1dDtcclxuICAgICAgICAgICAgICAgICAgICAgICAgaWYgKCFvdXRwdXQpIHtcclxuICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICBvdXRwdXQgPSBpbnB1dC5yZXBsYWNlKC9cXC5sdWEkL2ksICcucmdkJyk7XHJcbiAgICAgICAgICAgICAgICAgICAgICAgIH1cclxuXHJcbiAgICAgICAgICAgICAgICAgICAgICAgIHdyaXRlUmdkRmlsZShvdXRwdXQsIGdhbWVEYXRhLCBkaWN0LCBvdXRwdXRWZXJzaW9uKTtcclxuICAgICAgICAgICAgICAgICAgICAgICAgY29uc29sZS5sb2coYFdyaXR0ZW4gdG8gJHtvdXRwdXR9YCk7XHJcbiAgICAgICAgICAgICAgICB9IGNhdGNoIChlcnI6IGFueSkge1xyXG4gICAgICAgICAgICAgICAgICAgICAgICBjb25zb2xlLmVycm9yKGBFcnJvcjogJHtlcnIubWVzc2FnZX1gKTtcclxuICAgICAgICAgICAgICAgICAgICAgICAgcHJvY2Vzcy5leGl0KDEpO1xyXG4gICAgICAgICAgICAgICAgfVxyXG4gICAgICAgIH0pO1xyXG5cclxuLy8gQ29udmVydCBSR0QgdG8gQ1NWXHJcbnByb2dyYW1cclxuICAgICAgICAuY29tbWFuZCgndG8tY3N2IDxpbnB1dD4nKVxyXG4gICAgICAgIC5kZXNjcmlwdGlvbignQ29udmVydCBSR0QgZmlsZSB0byBDU1YgZm9ybWF0IChmbGF0IGtleS12YWx1ZSBwYWlycyknKVxyXG4gICAgICAgIC5vcHRpb24oJy1vLCAtLW91dHB1dCA8ZmlsZT4nLCAnT3V0cHV0IGZpbGUgKGRlZmF1bHQ6IHN0ZG91dCBvciBpbnB1dC5jc3YpJylcclxuICAgICAgICAuYWN0aW9uKChpbnB1dDogc3RyaW5nLCBjbWRPcHRpb25zOiBhbnkpID0+IHtcclxuICAgICAgICAgICAgICAgIGNvbnN0IG9wdGlvbnMgPSBwcm9ncmFtLm9wdHMoKTtcclxuICAgICAgICAgICAgICAgIGNvbnN0IGRpY3QgPSBnZXREaWN0aW9uYXJ5KG9wdGlvbnMpO1xyXG5cclxuICAgICAgICAgICAgICAgIHRyeSB7XHJcbiAgICAgICAgICAgICAgICAgICAgICAgIGNvbnN0IHJnZEZpbGUgPSByZWFkUmdkRmlsZShpbnB1dCwgZGljdCk7XHJcbiAgICAgICAgICAgICAgICAgICAgICAgIGNvbnN0IGNzdiA9IHJnZFRvQ3N2KHJnZEZpbGUpO1xyXG5cclxuICAgICAgICAgICAgICAgICAgICAgICAgaWYgKGNtZE9wdGlvbnMub3V0cHV0KSB7XHJcbiAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgZnMud3JpdGVGaWxlU3luYyhjbWRPcHRpb25zLm91dHB1dCwgY3N2LCAndXRmOCcpO1xyXG4gICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgIGNvbnNvbGUubG9nKGBXcml0dGVuIHRvICR7Y21kT3B0aW9ucy5vdXRwdXR9YCk7XHJcbiAgICAgICAgICAgICAgICAgICAgICAgIH0gZWxzZSB7XHJcbiAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgY29uc29sZS5sb2coY3N2KTtcclxuICAgICAgICAgICAgICAgICAgICAgICAgfVxyXG4gICAgICAgICAgICAgICAgfSBjYXRjaCAoZXJyOiBhbnkpIHtcclxuICAgICAgICAgICAgICAgICAgICAgICAgY29uc29sZS5lcnJvcihgRXJyb3I6ICR7ZXJyLm1lc3NhZ2V9YCk7XHJcbiAgICAgICAgICAgICAgICAgICAgICAgIHByb2Nlc3MuZXhpdCgxKTtcclxuICAgICAgICAgICAgICAgIH1cclxuICAgICAgICB9KTtcclxuXHJcbi8vIENvbnZlcnQgQ1NWIHRvIFJHRFxyXG5wcm9ncmFtXHJcbiAgICAgICAgLmNvbW1hbmQoJ2Zyb20tY3N2IDxpbnB1dD4nKVxyXG4gICAgICAgIC5kZXNjcmlwdGlvbignQ29udmVydCBDU1YgYmFjayB0byBiaW5hcnkgUkdEIGZpbGUnKVxyXG4gICAgICAgIC5vcHRpb24oJy1vLCAtLW91dHB1dCA8ZmlsZT4nLCAnT3V0cHV0IGZpbGUgKHJlcXVpcmVkKScpXHJcbiAgICAgICAgLm9wdGlvbignLS12ZXJzaW9uIDxudW0+JywgJ1JHRCB2ZXJzaW9uICgxIG9yIDMpJywgJzEnKVxyXG4gICAgICAgIC5hY3Rpb24oKGlucHV0OiBzdHJpbmcsIGNtZE9wdGlvbnM6IGFueSkgPT4ge1xyXG4gICAgICAgICAgICAgICAgY29uc3Qgb3B0aW9ucyA9IHByb2dyYW0ub3B0cygpO1xyXG4gICAgICAgICAgICAgICAgY29uc3QgZGljdCA9IGdldERpY3Rpb25hcnkob3B0aW9ucyk7XHJcblxyXG4gICAgICAgICAgICAgICAgaWYgKCFjbWRPcHRpb25zLm91dHB1dCkge1xyXG4gICAgICAgICAgICAgICAgICAgICAgICBjb25zb2xlLmVycm9yKCdFcnJvcjogLS1vdXRwdXQgaXMgcmVxdWlyZWQgZm9yIENTViBjb252ZXJzaW9uJyk7XHJcbiAgICAgICAgICAgICAgICAgICAgICAgIHByb2Nlc3MuZXhpdCgxKTtcclxuICAgICAgICAgICAgICAgIH1cclxuXHJcbiAgICAgICAgICAgICAgICB0cnkge1xyXG4gICAgICAgICAgICAgICAgICAgICAgICBjb25zdCBjc3YgPSBmcy5yZWFkRmlsZVN5bmMoaW5wdXQsICd1dGY4Jyk7XHJcbiAgICAgICAgICAgICAgICAgICAgICAgIGNvbnN0IGdhbWVEYXRhID0gY3N2VG9SZ2QoY3N2LCBkaWN0KTtcclxuXHJcbiAgICAgICAgICAgICAgICAgICAgICAgIGNvbnN0IHZlcnNpb24gPSBwYXJzZUludChjbWRPcHRpb25zLnZlcnNpb24sIDEwKSB8fCAxO1xyXG4gICAgICAgICAgICAgICAgICAgICAgICB3cml0ZVJnZEZpbGUoY21kT3B0aW9ucy5vdXRwdXQsIGdhbWVEYXRhLCBkaWN0LCB2ZXJzaW9uKTtcclxuICAgICAgICAgICAgICAgICAgICAgICAgY29uc29sZS5sb2coYFdyaXR0ZW4gdG8gJHtjbWRPcHRpb25zLm91dHB1dH1gKTtcclxuICAgICAgICAgICAgICAgIH0gY2F0Y2ggKGVycjogYW55KSB7XHJcbiAgICAgICAgICAgICAgICAgICAgICAgIGNvbnNvbGUuZXJyb3IoYEVycm9yOiAke2Vyci5tZXNzYWdlfWApO1xyXG4gICAgICAgICAgICAgICAgICAgICAgICBwcm9jZXNzLmV4aXQoMSk7XHJcbiAgICAgICAgICAgICAgICB9XHJcbiAgICAgICAgfSk7XHJcblxyXG4vLyBEdW1wIFJHRCBpbmZvXHJcbnByb2dyYW1cclxuICAgICAgICAuY29tbWFuZCgnaW5mbyA8aW5wdXQ+JylcclxuICAgICAgICAuZGVzY3JpcHRpb24oJ1Nob3cgaW5mb3JtYXRpb24gYWJvdXQgYW4gUkdEIGZpbGUnKVxyXG4gICAgICAgIC5hY3Rpb24oKGlucHV0OiBzdHJpbmcpID0+IHtcclxuICAgICAgICAgICAgICAgIGNvbnN0IG9wdGlvbnMgPSBwcm9ncmFtLm9wdHMoKTtcclxuICAgICAgICAgICAgICAgIGNvbnN0IGRpY3QgPSBnZXREaWN0aW9uYXJ5KG9wdGlvbnMpO1xyXG5cclxuICAgICAgICAgICAgICAgIHRyeSB7XHJcbiAgICAgICAgICAgICAgICAgICAgICAgIGNvbnN0IGJ1ZmZlciA9IGZzLnJlYWRGaWxlU3luYyhpbnB1dCk7XHJcbiAgICAgICAgICAgICAgICAgICAgICAgIGNvbnN0IHJnZEZpbGUgPSBwYXJzZVJnZChidWZmZXIsIGRpY3QpO1xyXG5cclxuICAgICAgICAgICAgICAgICAgICAgICAgY29uc29sZS5sb2coYEZpbGU6ICR7aW5wdXR9YCk7XHJcbiAgICAgICAgICAgICAgICAgICAgICAgIGNvbnNvbGUubG9nKGBTaXplOiAke2J1ZmZlci5sZW5ndGh9IGJ5dGVzYCk7XHJcbiAgICAgICAgICAgICAgICAgICAgICAgIGNvbnNvbGUubG9nKGBWZXJzaW9uOiAke3JnZEZpbGUuaGVhZGVyLnZlcnNpb259YCk7XHJcbiAgICAgICAgICAgICAgICAgICAgICAgIGNvbnNvbGUubG9nKGBDaHVua3M6ICR7cmdkRmlsZS5jaHVua3MubGVuZ3RofWApO1xyXG5cclxuICAgICAgICAgICAgICAgICAgICAgICAgZm9yIChjb25zdCBjaHVuayBvZiByZ2RGaWxlLmNodW5rcykge1xyXG4gICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgIGNvbnNvbGUubG9nKGAgIC0gJHtjaHVuay50eXBlfSAodiR7Y2h1bmsudmVyc2lvbn0sICR7Y2h1bmsuZGF0YS5sZW5ndGh9IGJ5dGVzKWApO1xyXG4gICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgIGlmIChjaHVuay5kZXNjcmlwdG9yU3RyaW5nKSB7XHJcbiAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICBjb25zb2xlLmxvZyhgICAgIERlc2NyaXB0b3I6IFwiJHtjaHVuay5kZXNjcmlwdG9yU3RyaW5nfVwiYCk7XHJcbiAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgfVxyXG4gICAgICAgICAgICAgICAgICAgICAgICB9XHJcblxyXG4gICAgICAgICAgICAgICAgICAgICAgICAvLyBDb3VudCBlbnRyaWVzXHJcbiAgICAgICAgICAgICAgICAgICAgICAgIGZ1bmN0aW9uIGNvdW50RW50cmllcyhlbnRyaWVzOiBhbnlbXSk6IHsgdG90YWw6IG51bWJlcjsgdGFibGVzOiBudW1iZXIgfSB7XHJcbiAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgbGV0IHRvdGFsID0gMDtcclxuICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICBsZXQgdGFibGVzID0gMDtcclxuICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICBmb3IgKGNvbnN0IGUgb2YgZW50cmllcykge1xyXG4gICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgdG90YWwrKztcclxuICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgIGlmIChlLnR5cGUgPT09IFJnZERhdGFUeXBlLlRhYmxlIHx8IGUudHlwZSA9PT0gUmdkRGF0YVR5cGUuVGFibGVJbnQpIHtcclxuICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgdGFibGVzKys7XHJcbiAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgIGNvbnN0IGNoaWxkID0gY291bnRFbnRyaWVzKChlLnZhbHVlIGFzIGFueSkuZW50cmllcyk7XHJcbiAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgIHRvdGFsICs9IGNoaWxkLnRvdGFsO1xyXG4gICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICB0YWJsZXMgKz0gY2hpbGQudGFibGVzO1xyXG4gICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgfVxyXG4gICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgIH1cclxuICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICByZXR1cm4geyB0b3RhbCwgdGFibGVzIH07XHJcbiAgICAgICAgICAgICAgICAgICAgICAgIH1cclxuXHJcbiAgICAgICAgICAgICAgICAgICAgICAgIGNvbnN0IGNvdW50cyA9IGNvdW50RW50cmllcyhyZ2RGaWxlLmdhbWVEYXRhLmVudHJpZXMpO1xyXG4gICAgICAgICAgICAgICAgICAgICAgICBjb25zb2xlLmxvZyhgVG90YWwgZW50cmllczogJHtjb3VudHMudG90YWx9YCk7XHJcbiAgICAgICAgICAgICAgICAgICAgICAgIGNvbnNvbGUubG9nKGBUYWJsZXM6ICR7Y291bnRzLnRhYmxlc31gKTtcclxuXHJcbiAgICAgICAgICAgICAgICAgICAgICAgIGlmIChyZ2RGaWxlLmdhbWVEYXRhLnJlZmVyZW5jZSkge1xyXG4gICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgIGNvbnNvbGUubG9nKGBSZWZlcmVuY2U6ICR7cmdkRmlsZS5nYW1lRGF0YS5yZWZlcmVuY2V9YCk7XHJcbiAgICAgICAgICAgICAgICAgICAgICAgIH1cclxuICAgICAgICAgICAgICAgIH0gY2F0Y2ggKGVycjogYW55KSB7XHJcbiAgICAgICAgICAgICAgICAgICAgICAgIGNvbnNvbGUuZXJyb3IoYEVycm9yOiAke2Vyci5tZXNzYWdlfWApO1xyXG4gICAgICAgICAgICAgICAgICAgICAgICBwcm9jZXNzLmV4aXQoMSk7XHJcbiAgICAgICAgICAgICAgICB9XHJcbiAgICAgICAgfSk7XHJcblxyXG4vLyBDYWxjdWxhdGUgaGFzaFxyXG5wcm9ncmFtXHJcbiAgICAgICAgLmNvbW1hbmQoJ2hhc2ggPHN0cmluZz4nKVxyXG4gICAgICAgIC5kZXNjcmlwdGlvbignQ2FsY3VsYXRlIHRoZSBoYXNoIHZhbHVlIGZvciBhIHN0cmluZycpXHJcbiAgICAgICAgLmFjdGlvbigoc3RyOiBzdHJpbmcpID0+IHtcclxuICAgICAgICAgICAgICAgIGNvbnN0IGggPSBoYXNoKHN0cik7XHJcbiAgICAgICAgICAgICAgICBjb25zb2xlLmxvZyhgU3RyaW5nOiBcIiR7c3RyfVwiYCk7XHJcbiAgICAgICAgICAgICAgICBjb25zb2xlLmxvZyhgSGFzaDogICAke2hhc2hUb0hleChoKX0gKCR7aH0pYCk7XHJcbiAgICAgICAgfSk7XHJcblxyXG4vLyBCYXRjaCBjb252ZXJ0XHJcbnByb2dyYW1cclxuICAgICAgICAuY29tbWFuZCgnYmF0Y2ggPHBhdHRlcm4+JylcclxuICAgICAgICAuZGVzY3JpcHRpb24oJ0JhdGNoIGNvbnZlcnQgUkdEIGZpbGVzIChzdXBwb3J0cyBnbG9iIHBhdHRlcm5zKScpXHJcbiAgICAgICAgLm9wdGlvbignLWYsIC0tZm9ybWF0IDxmb3JtYXQ+JywgJ091dHB1dCBmb3JtYXQ6IHRleHQsIGNzdicsICd0ZXh0JylcclxuICAgICAgICAub3B0aW9uKCctbywgLS1vdXRwdXQtZGlyIDxkaXI+JywgJ091dHB1dCBkaXJlY3RvcnkgKGRlZmF1bHQ6IHNhbWUgYXMgaW5wdXQpJylcclxuICAgICAgICAuYWN0aW9uKChwYXR0ZXJuOiBzdHJpbmcsIGNtZE9wdGlvbnM6IGFueSkgPT4ge1xyXG4gICAgICAgICAgICAgICAgY29uc3Qgb3B0aW9ucyA9IHByb2dyYW0ub3B0cygpO1xyXG4gICAgICAgICAgICAgICAgY29uc3QgZGljdCA9IGdldERpY3Rpb25hcnkob3B0aW9ucyk7XHJcblxyXG4gICAgICAgICAgICAgICAgLy8gU2ltcGxlIGdsb2Igc3VwcG9ydCBmb3IgY3VycmVudCBkaXJlY3RvcnlcclxuICAgICAgICAgICAgICAgIGNvbnN0IGRpciA9IHBhdGguZGlybmFtZShwYXR0ZXJuKTtcclxuICAgICAgICAgICAgICAgIGNvbnN0IGJhc2VQYXR0ZXJuID0gcGF0aC5iYXNlbmFtZShwYXR0ZXJuKTtcclxuICAgICAgICAgICAgICAgIGNvbnN0IHJlZ2V4ID0gbmV3IFJlZ0V4cCgnXicgKyBiYXNlUGF0dGVybi5yZXBsYWNlKC9cXCovZywgJy4qJykucmVwbGFjZSgvXFw/L2csICcuJykgKyAnJCcsICdpJyk7XHJcblxyXG4gICAgICAgICAgICAgICAgY29uc3QgZmlsZXMgPSBmcy5yZWFkZGlyU3luYyhkaXIgfHwgJy4nKS5maWx0ZXIoZiA9PiByZWdleC50ZXN0KGYpKTtcclxuXHJcbiAgICAgICAgICAgICAgICBpZiAoZmlsZXMubGVuZ3RoID09PSAwKSB7XHJcbiAgICAgICAgICAgICAgICAgICAgICAgIGNvbnNvbGUubG9nKCdObyBmaWxlcyBtYXRjaGVkIHRoZSBwYXR0ZXJuJyk7XHJcbiAgICAgICAgICAgICAgICAgICAgICAgIHJldHVybjtcclxuICAgICAgICAgICAgICAgIH1cclxuXHJcbiAgICAgICAgICAgICAgICBjb25zdCBvdXRwdXREaXIgPSBjbWRPcHRpb25zLm91dHB1dERpciB8fCBkaXIgfHwgJy4nO1xyXG4gICAgICAgICAgICAgICAgaWYgKCFmcy5leGlzdHNTeW5jKG91dHB1dERpcikpIHtcclxuICAgICAgICAgICAgICAgICAgICAgICAgZnMubWtkaXJTeW5jKG91dHB1dERpciwgeyByZWN1cnNpdmU6IHRydWUgfSk7XHJcbiAgICAgICAgICAgICAgICB9XHJcblxyXG4gICAgICAgICAgICAgICAgbGV0IHByb2Nlc3NlZCA9IDA7XHJcbiAgICAgICAgICAgICAgICBsZXQgZXJyb3JzID0gMDtcclxuXHJcbiAgICAgICAgICAgICAgICBmb3IgKGNvbnN0IGZpbGUgb2YgZmlsZXMpIHtcclxuICAgICAgICAgICAgICAgICAgICAgICAgY29uc3QgaW5wdXRQYXRoID0gcGF0aC5qb2luKGRpciB8fCAnLicsIGZpbGUpO1xyXG5cclxuICAgICAgICAgICAgICAgICAgICAgICAgdHJ5IHtcclxuICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICBjb25zdCByZ2RGaWxlID0gcmVhZFJnZEZpbGUoaW5wdXRQYXRoLCBkaWN0KTtcclxuXHJcbiAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgbGV0IG91dHB1dDogc3RyaW5nO1xyXG4gICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgIGxldCBleHQ6IHN0cmluZztcclxuXHJcbiAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgaWYgKGNtZE9wdGlvbnMuZm9ybWF0ID09PSAnY3N2Jykge1xyXG4gICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgb3V0cHV0ID0gcmdkVG9Dc3YocmdkRmlsZSk7XHJcbiAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICBleHQgPSAnLmNzdic7XHJcbiAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgfSBlbHNlIHtcclxuICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgIG91dHB1dCA9IHJnZFRvVGV4dChyZ2RGaWxlLCBmaWxlKTtcclxuICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgIGV4dCA9ICcudHh0JztcclxuICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICB9XHJcblxyXG4gICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgIGNvbnN0IG91dHB1dFBhdGggPSBwYXRoLmpvaW4ob3V0cHV0RGlyLCBmaWxlICsgZXh0KTtcclxuICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICBmcy53cml0ZUZpbGVTeW5jKG91dHB1dFBhdGgsIG91dHB1dCwgJ3V0ZjgnKTtcclxuXHJcbiAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgaWYgKG9wdGlvbnMudmVyYm9zZSkge1xyXG4gICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgY29uc29sZS5sb2coYENvbnZlcnRlZDogJHtpbnB1dFBhdGh9IC0+ICR7b3V0cHV0UGF0aH1gKTtcclxuICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICB9XHJcbiAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgcHJvY2Vzc2VkKys7XHJcbiAgICAgICAgICAgICAgICAgICAgICAgIH0gY2F0Y2ggKGVycjogYW55KSB7XHJcbiAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgY29uc29sZS5lcnJvcihgRXJyb3IgcHJvY2Vzc2luZyAke2lucHV0UGF0aH06ICR7ZXJyLm1lc3NhZ2V9YCk7XHJcbiAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgZXJyb3JzKys7XHJcbiAgICAgICAgICAgICAgICAgICAgICAgIH1cclxuICAgICAgICAgICAgICAgIH1cclxuXHJcbiAgICAgICAgICAgICAgICBjb25zb2xlLmxvZyhgXFxuUHJvY2Vzc2VkOiAke3Byb2Nlc3NlZH0gZmlsZXNgKTtcclxuICAgICAgICAgICAgICAgIGlmIChlcnJvcnMgPiAwKSB7XHJcbiAgICAgICAgICAgICAgICAgICAgICAgIGNvbnNvbGUubG9nKGBFcnJvcnM6ICR7ZXJyb3JzfSBmaWxlc2ApO1xyXG4gICAgICAgICAgICAgICAgfVxyXG4gICAgICAgIH0pO1xyXG5cclxuLy8gRXh0cmFjdCBkaWN0aW9uYXJ5XHJcbnByb2dyYW1cclxuICAgICAgICAuY29tbWFuZCgnZXh0cmFjdC1kaWN0IDxpbnB1dC4uLj4nKVxyXG4gICAgICAgIC5kZXNjcmlwdGlvbignRXh0cmFjdCBoYXNoLT5uYW1lIG1hcHBpbmdzIGZyb20gUkdEIGZpbGVzIHRvIGNyZWF0ZSBhIGRpY3Rpb25hcnknKVxyXG4gICAgICAgIC5vcHRpb24oJy1vLCAtLW91dHB1dCA8ZmlsZT4nLCAnT3V0cHV0IGRpY3Rpb25hcnkgZmlsZScsICdleHRyYWN0ZWQuZGljJylcclxuICAgICAgICAuYWN0aW9uKChpbnB1dHM6IHN0cmluZ1tdLCBjbWRPcHRpb25zOiBhbnkpID0+IHtcclxuICAgICAgICAgICAgICAgIGNvbnN0IG9wdGlvbnMgPSBwcm9ncmFtLm9wdHMoKTtcclxuICAgICAgICAgICAgICAgIGNvbnN0IGRpY3QgPSBnZXREaWN0aW9uYXJ5KG9wdGlvbnMpO1xyXG4gICAgICAgICAgICAgICAgY29uc3QgY3VzdG9tSGFzaGVzID0gbmV3IFNldDxudW1iZXI+KCk7XHJcblxyXG4gICAgICAgICAgICAgICAgZm9yIChjb25zdCBpbnB1dCBvZiBpbnB1dHMpIHtcclxuICAgICAgICAgICAgICAgICAgICAgICAgdHJ5IHtcclxuICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICBjb25zdCByZ2RGaWxlID0gcmVhZFJnZEZpbGUoaW5wdXQsIGRpY3QpO1xyXG5cclxuICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAvLyBUcmF2ZXJzZSBhbmQgY29sbGVjdCBhbGwgbmFtZS0+aGFzaCBtYXBwaW5nc1xyXG4gICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgIGZ1bmN0aW9uIGNvbGxlY3ROYW1lcyhlbnRyaWVzOiBhbnlbXSkge1xyXG4gICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgZm9yIChjb25zdCBlIG9mIGVudHJpZXMpIHtcclxuICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgaWYgKGUubmFtZSAmJiAhL14weFswLTlBLUZhLWZdezh9JC8udGVzdChlLm5hbWUpKSB7XHJcbiAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgY29uc3QgaCA9IGFkZFRvRGljdGlvbmFyeShkaWN0LCBlLm5hbWUpO1xyXG4gICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgIGN1c3RvbUhhc2hlcy5hZGQoaCk7XHJcbiAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgIH1cclxuICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgaWYgKGUudHlwZSA9PT0gUmdkRGF0YVR5cGUuVGFibGUgfHwgZS50eXBlID09PSBSZ2REYXRhVHlwZS5UYWJsZUludCkge1xyXG4gICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgIGNvbGxlY3ROYW1lcygoZS52YWx1ZSBhcyBhbnkpLmVudHJpZXMpO1xyXG4gICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICB9XHJcbiAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICB9XHJcbiAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgfVxyXG5cclxuICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICBjb2xsZWN0TmFtZXMocmdkRmlsZS5nYW1lRGF0YS5lbnRyaWVzKTtcclxuXHJcbiAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgaWYgKG9wdGlvbnMudmVyYm9zZSkge1xyXG4gICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgY29uc29sZS5sb2coYFByb2Nlc3NlZDogJHtpbnB1dH1gKTtcclxuICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICB9XHJcbiAgICAgICAgICAgICAgICAgICAgICAgIH0gY2F0Y2ggKGVycjogYW55KSB7XHJcbiAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgY29uc29sZS5lcnJvcihgRXJyb3IgcHJvY2Vzc2luZyAke2lucHV0fTogJHtlcnIubWVzc2FnZX1gKTtcclxuICAgICAgICAgICAgICAgICAgICAgICAgfVxyXG4gICAgICAgICAgICAgICAgfVxyXG5cclxuICAgICAgICAgICAgICAgIHNhdmVEaWN0aW9uYXJ5KGRpY3QsIGNtZE9wdGlvbnMub3V0cHV0LCBjdXN0b21IYXNoZXMpO1xyXG4gICAgICAgICAgICAgICAgY29uc29sZS5sb2coYERpY3Rpb25hcnkgc2F2ZWQgdG8gJHtjbWRPcHRpb25zLm91dHB1dH1gKTtcclxuICAgICAgICAgICAgICAgIGNvbnNvbGUubG9nKGBFbnRyaWVzOiAke2N1c3RvbUhhc2hlcy5zaXplfWApO1xyXG4gICAgICAgIH0pO1xyXG5cclxuLy8gU0dBIEFyY2hpdmUgY29tbWFuZHNcclxucHJvZ3JhbVxyXG4gICAgICAgIC5jb21tYW5kKCdzZ2EtbGlzdCA8YXJjaGl2ZT4nKVxyXG4gICAgICAgIC5kZXNjcmlwdGlvbignTGlzdCBmaWxlcyBpbiBhbiBTR0EgYXJjaGl2ZScpXHJcbiAgICAgICAgLm9wdGlvbignLXIsIC0tcmdkLW9ubHknLCAnTGlzdCBvbmx5IFJHRCBmaWxlcycpXHJcbiAgICAgICAgLm9wdGlvbignLXAsIC0tcGF0dGVybiA8cGF0dGVybj4nLCAnRmlsdGVyIGJ5IHJlZ2V4IHBhdHRlcm4nKVxyXG4gICAgICAgIC5hY3Rpb24oKGFyY2hpdmU6IHN0cmluZywgY21kT3B0aW9uczogYW55KSA9PiB7XHJcbiAgICAgICAgICAgICAgICB0cnkge1xyXG4gICAgICAgICAgICAgICAgICAgICAgICBjb25zdCBzZ2EgPSBvcGVuU2dhQXJjaGl2ZShhcmNoaXZlKTtcclxuXHJcbiAgICAgICAgICAgICAgICAgICAgICAgIGNvbnNvbGUubG9nKGBBcmNoaXZlOiAke2FyY2hpdmV9YCk7XHJcbiAgICAgICAgICAgICAgICAgICAgICAgIGNvbnNvbGUubG9nKGBWZXJzaW9uOiAke3NnYS52ZXJzaW9ufWApO1xyXG4gICAgICAgICAgICAgICAgICAgICAgICBjb25zb2xlLmxvZyhgVHlwZTogJHtzZ2EuYXJjaGl2ZVR5cGV9YCk7XHJcbiAgICAgICAgICAgICAgICAgICAgICAgIGNvbnNvbGUubG9nKCcnKTtcclxuXHJcbiAgICAgICAgICAgICAgICAgICAgICAgIGxldCBmaWxlcztcclxuICAgICAgICAgICAgICAgICAgICAgICAgaWYgKGNtZE9wdGlvbnMucmdkT25seSkge1xyXG4gICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgIGZpbGVzID0gc2dhLmxpc3RSZ2RGaWxlcygpO1xyXG4gICAgICAgICAgICAgICAgICAgICAgICB9IGVsc2UgaWYgKGNtZE9wdGlvbnMucGF0dGVybikge1xyXG4gICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgIGZpbGVzID0gc2dhLmxpc3RGaWxlcyhuZXcgUmVnRXhwKGNtZE9wdGlvbnMucGF0dGVybiwgJ2knKSk7XHJcbiAgICAgICAgICAgICAgICAgICAgICAgIH0gZWxzZSB7XHJcbiAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgZmlsZXMgPSBzZ2EubGlzdEZpbGVzKCk7XHJcbiAgICAgICAgICAgICAgICAgICAgICAgIH1cclxuXHJcbiAgICAgICAgICAgICAgICAgICAgICAgIGNvbnNvbGUubG9nKGBGaWxlczogJHtmaWxlcy5sZW5ndGh9YCk7XHJcbiAgICAgICAgICAgICAgICAgICAgICAgIGNvbnNvbGUubG9nKCctLS0nKTtcclxuXHJcbiAgICAgICAgICAgICAgICAgICAgICAgIGZvciAoY29uc3QgZmlsZSBvZiBmaWxlcykge1xyXG4gICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgIGNvbnN0IGNvbXByZXNzZWQgPSBmaWxlLmlzQ29tcHJlc3NlZCA/IGAgKCR7ZmlsZS5jb21wcmVzc2VkU2l6ZX0gY29tcHJlc3NlZClgIDogJyc7XHJcbiAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgY29uc29sZS5sb2coYCR7ZmlsZS5wYXRofSAtICR7ZmlsZS5zaXplfSBieXRlcyR7Y29tcHJlc3NlZH1gKTtcclxuICAgICAgICAgICAgICAgICAgICAgICAgfVxyXG4gICAgICAgICAgICAgICAgfSBjYXRjaCAoZXJyOiBhbnkpIHtcclxuICAgICAgICAgICAgICAgICAgICAgICAgY29uc29sZS5lcnJvcihgRXJyb3I6ICR7ZXJyLm1lc3NhZ2V9YCk7XHJcbiAgICAgICAgICAgICAgICAgICAgICAgIHByb2Nlc3MuZXhpdCgxKTtcclxuICAgICAgICAgICAgICAgIH1cclxuICAgICAgICB9KTtcclxuXHJcbnByb2dyYW1cclxuICAgICAgICAuY29tbWFuZCgnc2dhLWV4dHJhY3QgPGFyY2hpdmU+JylcclxuICAgICAgICAuZGVzY3JpcHRpb24oJ0V4dHJhY3QgZmlsZXMgZnJvbSBhbiBTR0EgYXJjaGl2ZScpXHJcbiAgICAgICAgLm9wdGlvbignLW8sIC0tb3V0cHV0IDxkaXI+JywgJ091dHB1dCBkaXJlY3RvcnknLCAnLi9leHRyYWN0ZWQnKVxyXG4gICAgICAgIC5vcHRpb24oJy1yLCAtLXJnZC1vbmx5JywgJ0V4dHJhY3Qgb25seSBSR0QgZmlsZXMnKVxyXG4gICAgICAgIC5vcHRpb24oJy1wLCAtLXBhdHRlcm4gPHBhdHRlcm4+JywgJ0ZpbHRlciBieSByZWdleCBwYXR0ZXJuJylcclxuICAgICAgICAub3B0aW9uKCctYywgLS1jb252ZXJ0JywgJ0NvbnZlcnQgZXh0cmFjdGVkIFJHRCBmaWxlcyB0byB0ZXh0IGZvcm1hdCcpXHJcbiAgICAgICAgLmFjdGlvbigoYXJjaGl2ZTogc3RyaW5nLCBjbWRPcHRpb25zOiBhbnkpID0+IHtcclxuICAgICAgICAgICAgICAgIGNvbnN0IG9wdGlvbnMgPSBwcm9ncmFtLm9wdHMoKTtcclxuICAgICAgICAgICAgICAgIGNvbnN0IGRpY3QgPSBnZXREaWN0aW9uYXJ5KG9wdGlvbnMpO1xyXG5cclxuICAgICAgICAgICAgICAgIHRyeSB7XHJcbiAgICAgICAgICAgICAgICAgICAgICAgIGNvbnN0IHNnYSA9IG9wZW5TZ2FBcmNoaXZlKGFyY2hpdmUpO1xyXG5cclxuICAgICAgICAgICAgICAgICAgICAgICAgY29uc29sZS5sb2coYEV4dHJhY3RpbmcgZnJvbTogJHthcmNoaXZlfWApO1xyXG4gICAgICAgICAgICAgICAgICAgICAgICBjb25zb2xlLmxvZyhgT3V0cHV0IGRpcmVjdG9yeTogJHtjbWRPcHRpb25zLm91dHB1dH1gKTtcclxuXHJcbiAgICAgICAgICAgICAgICAgICAgICAgIGxldCBleHRyYWN0ZWQ6IHN0cmluZ1tdO1xyXG4gICAgICAgICAgICAgICAgICAgICAgICBpZiAoY21kT3B0aW9ucy5yZ2RPbmx5KSB7XHJcbiAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgZXh0cmFjdGVkID0gc2dhLmV4dHJhY3RSZ2RGaWxlcyhjbWRPcHRpb25zLm91dHB1dCk7XHJcbiAgICAgICAgICAgICAgICAgICAgICAgIH0gZWxzZSBpZiAoY21kT3B0aW9ucy5wYXR0ZXJuKSB7XHJcbiAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgZXh0cmFjdGVkID0gc2dhLmV4dHJhY3RGaWxlcyhjbWRPcHRpb25zLm91dHB1dCwgbmV3IFJlZ0V4cChjbWRPcHRpb25zLnBhdHRlcm4sICdpJykpO1xyXG4gICAgICAgICAgICAgICAgICAgICAgICB9IGVsc2Uge1xyXG4gICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgIGV4dHJhY3RlZCA9IHNnYS5leHRyYWN0RmlsZXMoY21kT3B0aW9ucy5vdXRwdXQpO1xyXG4gICAgICAgICAgICAgICAgICAgICAgICB9XHJcblxyXG4gICAgICAgICAgICAgICAgICAgICAgICBjb25zb2xlLmxvZyhgRXh0cmFjdGVkICR7ZXh0cmFjdGVkLmxlbmd0aH0gZmlsZXNgKTtcclxuXHJcbiAgICAgICAgICAgICAgICAgICAgICAgIC8vIE9wdGlvbmFsbHkgY29udmVydCBSR0QgZmlsZXMgdG8gdGV4dFxyXG4gICAgICAgICAgICAgICAgICAgICAgICBpZiAoY21kT3B0aW9ucy5jb252ZXJ0KSB7XHJcbiAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgY29uc3QgcmdkRmlsZXMgPSBleHRyYWN0ZWQuZmlsdGVyKGYgPT4gZi50b0xvd2VyQ2FzZSgpLmVuZHNXaXRoKCcucmdkJykpO1xyXG4gICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgIGxldCBjb252ZXJ0ZWQgPSAwO1xyXG5cclxuICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICBmb3IgKGNvbnN0IHJnZFBhdGggb2YgcmdkRmlsZXMpIHtcclxuICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgIHRyeSB7XHJcbiAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgIGNvbnN0IHJnZEZpbGUgPSByZWFkUmdkRmlsZShyZ2RQYXRoLCBkaWN0KTtcclxuICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgY29uc3QgdGV4dCA9IHJnZFRvVGV4dChyZ2RGaWxlLCBwYXRoLmJhc2VuYW1lKHJnZFBhdGgpKTtcclxuICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgY29uc3QgdGV4dFBhdGggPSByZ2RQYXRoICsgJy50eHQnO1xyXG4gICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICBmcy53cml0ZUZpbGVTeW5jKHRleHRQYXRoLCB0ZXh0LCAndXRmOCcpO1xyXG4gICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICBjb252ZXJ0ZWQrKztcclxuXHJcbiAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgIGlmIChvcHRpb25zLnZlcmJvc2UpIHtcclxuICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICBjb25zb2xlLmxvZyhgQ29udmVydGVkOiAke3JnZFBhdGh9IC0+ICR7dGV4dFBhdGh9YCk7XHJcbiAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgIH1cclxuICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgIH0gY2F0Y2ggKGU6IGFueSkge1xyXG4gICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICBjb25zb2xlLmVycm9yKGBGYWlsZWQgdG8gY29udmVydCAke3JnZFBhdGh9OiAke2UubWVzc2FnZX1gKTtcclxuICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgIH1cclxuICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICB9XHJcblxyXG4gICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgIGNvbnNvbGUubG9nKGBDb252ZXJ0ZWQgJHtjb252ZXJ0ZWR9IFJHRCBmaWxlcyB0byB0ZXh0YCk7XHJcbiAgICAgICAgICAgICAgICAgICAgICAgIH1cclxuICAgICAgICAgICAgICAgIH0gY2F0Y2ggKGVycjogYW55KSB7XHJcbiAgICAgICAgICAgICAgICAgICAgICAgIGNvbnNvbGUuZXJyb3IoYEVycm9yOiAke2Vyci5tZXNzYWdlfWApO1xyXG4gICAgICAgICAgICAgICAgICAgICAgICBwcm9jZXNzLmV4aXQoMSk7XHJcbiAgICAgICAgICAgICAgICB9XHJcbiAgICAgICAgfSk7XHJcblxyXG5wcm9ncmFtXHJcbiAgICAgICAgLmNvbW1hbmQoJ3NnYS1nZXQgPGFyY2hpdmU+IDxmaWxlPicpXHJcbiAgICAgICAgLmRlc2NyaXB0aW9uKCdFeHRyYWN0IGFuZCBjb252ZXJ0IGEgc2luZ2xlIGZpbGUgZnJvbSBTR0EnKVxyXG4gICAgICAgIC5vcHRpb24oJy1vLCAtLW91dHB1dCA8ZmlsZT4nLCAnT3V0cHV0IGZpbGUnKVxyXG4gICAgICAgIC5vcHRpb24oJy10LCAtLXRleHQnLCAnQ29udmVydCBSR0QgdG8gdGV4dCBmb3JtYXQnKVxyXG4gICAgICAgIC5hY3Rpb24oKGFyY2hpdmU6IHN0cmluZywgZmlsZTogc3RyaW5nLCBjbWRPcHRpb25zOiBhbnkpID0+IHtcclxuICAgICAgICAgICAgICAgIGNvbnN0IG9wdGlvbnMgPSBwcm9ncmFtLm9wdHMoKTtcclxuICAgICAgICAgICAgICAgIGNvbnN0IGRpY3QgPSBnZXREaWN0aW9uYXJ5KG9wdGlvbnMpO1xyXG5cclxuICAgICAgICAgICAgICAgIHRyeSB7XHJcbiAgICAgICAgICAgICAgICAgICAgICAgIGNvbnN0IHNnYSA9IG9wZW5TZ2FBcmNoaXZlKGFyY2hpdmUpO1xyXG4gICAgICAgICAgICAgICAgICAgICAgICBjb25zdCBkYXRhID0gc2dhLmV4dHJhY3RGaWxlKGZpbGUpO1xyXG5cclxuICAgICAgICAgICAgICAgICAgICAgICAgbGV0IG91dHB1dFBhdGggPSBjbWRPcHRpb25zLm91dHB1dCB8fCBwYXRoLmJhc2VuYW1lKGZpbGUpO1xyXG5cclxuICAgICAgICAgICAgICAgICAgICAgICAgaWYgKGNtZE9wdGlvbnMudGV4dCAmJiBmaWxlLnRvTG93ZXJDYXNlKCkuZW5kc1dpdGgoJy5yZ2QnKSkge1xyXG4gICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgIC8vIENvbnZlcnQgdG8gdGV4dFxyXG4gICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgIGNvbnN0IHJnZEZpbGUgPSBwYXJzZVJnZChkYXRhLCBkaWN0KTtcclxuICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICBjb25zdCB0ZXh0ID0gcmdkVG9UZXh0KHJnZEZpbGUsIHBhdGguYmFzZW5hbWUoZmlsZSkpO1xyXG5cclxuICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICBpZiAoIW91dHB1dFBhdGguZW5kc1dpdGgoJy50eHQnKSkge1xyXG4gICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgb3V0cHV0UGF0aCArPSAnLnR4dCc7XHJcbiAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgfVxyXG5cclxuICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICBmcy53cml0ZUZpbGVTeW5jKG91dHB1dFBhdGgsIHRleHQsICd1dGY4Jyk7XHJcbiAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgY29uc29sZS5sb2coYEV4dHJhY3RlZCBhbmQgY29udmVydGVkIHRvOiAke291dHB1dFBhdGh9YCk7XHJcbiAgICAgICAgICAgICAgICAgICAgICAgIH0gZWxzZSB7XHJcbiAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgZnMud3JpdGVGaWxlU3luYyhvdXRwdXRQYXRoLCBkYXRhKTtcclxuICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICBjb25zb2xlLmxvZyhgRXh0cmFjdGVkIHRvOiAke291dHB1dFBhdGh9YCk7XHJcbiAgICAgICAgICAgICAgICAgICAgICAgIH1cclxuICAgICAgICAgICAgICAgIH0gY2F0Y2ggKGVycjogYW55KSB7XHJcbiAgICAgICAgICAgICAgICAgICAgICAgIGNvbnNvbGUuZXJyb3IoYEVycm9yOiAke2Vyci5tZXNzYWdlfWApO1xyXG4gICAgICAgICAgICAgICAgICAgICAgICBwcm9jZXNzLmV4aXQoMSk7XHJcbiAgICAgICAgICAgICAgICB9XHJcbiAgICAgICAgfSk7XHJcblxyXG5wcm9ncmFtLnBhcnNlKCk7XHJcbiJdfQ==