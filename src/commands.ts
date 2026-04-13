import * as vscode from 'vscode';
import * as path from 'path';
import * as fs from 'fs';
import { parseRgd, readRgdFile } from '../bundled/rgd-tools/dist/reader';
import { rgdToText, textToRgd } from '../bundled/rgd-tools/dist/textFormat';
import { writeRgdFile } from '../bundled/rgd-tools/dist/writer';
import { rgdToLua, luaToRgdResolved, rgdToLuaDifferential, ParsedLuaTable, ParentLoader, RgdParentLoader, LuaFileLoader, parseLuaToTable } from '../bundled/rgd-tools/dist/luaFormat';
import { RgdTable } from '../bundled/rgd-tools/dist/types';
import { HashDictionary } from '../bundled/rgd-tools/dist/dictionary';
import { openSgaArchive } from '../bundled/rgd-tools/dist/sga';
import { DictionaryManager } from './dictionaryManager';
import { LocaleManager } from './localeManager';

export class RgdCommands {
    constructor(private readonly context: vscode.ExtensionContext) { }

    private getDictionary(): HashDictionary {
        return DictionaryManager.getInstance().getDictionary(this.context);
    }

    async convertToText(uri?: vscode.Uri): Promise<void> {
        uri = uri || vscode.window.activeTextEditor?.document.uri;

        if (!uri) {
            const files = await vscode.window.showOpenDialog({ canSelectMany: false, filters: { 'RGD Files': ['rgd'] } });
            if (files && files.length > 0) uri = files[0];
        }
        if (!uri) { vscode.window.showErrorMessage('No RGD file selected'); return; }

        try {
            const fileData = await vscode.workspace.fs.readFile(uri);
            const buffer = Buffer.from(fileData);
            const dict = this.getDictionary();
            const rgdFile = parseRgd(buffer, dict);
            const localeMap = LocaleManager.getInstance().getLocaleMap(uri.fsPath);
            const text = rgdToText(rgdFile, path.basename(uri.fsPath), localeMap);
            const outputPath = uri.fsPath + '.txt';
            fs.writeFileSync(outputPath, text, 'utf8');
            const doc = await vscode.workspace.openTextDocument(outputPath);
            await vscode.window.showTextDocument(doc);
            vscode.window.showInformationMessage(`Converted to ${path.basename(outputPath)}`);
        } catch (error: any) {
            vscode.window.showErrorMessage(`Failed to convert: ${error.message}`);
        }
    }

    async convertToBinary(uri?: vscode.Uri): Promise<void> {
        uri = uri || vscode.window.activeTextEditor?.document.uri;

        if (!uri) {
            const files = await vscode.window.showOpenDialog({ canSelectMany: false, filters: { 'RGD Text Files': ['txt'] } });
            if (files && files.length > 0) uri = files[0];
        }
        if (!uri) { vscode.window.showErrorMessage('No text file selected'); return; }

        try {
            const text = fs.readFileSync(uri.fsPath, 'utf8');
            const dict = this.getDictionary();
            const { gameData, version } = textToRgd(text, dict);

            let outputPath = uri.fsPath;
            if (outputPath.endsWith('.rgd.txt')) {
                outputPath = outputPath.slice(0, -4);
            } else if (outputPath.endsWith('.txt')) {
                outputPath = outputPath.slice(0, -4) + '.rgd';
            } else {
                outputPath = outputPath + '.rgd';
            }

            writeRgdFile(outputPath, gameData, dict, version);
            vscode.window.showInformationMessage(`Saved to ${path.basename(outputPath)}`);
        } catch (error: any) {
            vscode.window.showErrorMessage(`Failed to convert: ${error.message}`);
        }
    }

    async showInfo(uri?: vscode.Uri): Promise<void> {
        uri = uri || vscode.window.activeTextEditor?.document.uri;

        if (!uri) {
            const files = await vscode.window.showOpenDialog({ canSelectMany: false, filters: { 'RGD Files': ['rgd'] } });
            if (files && files.length > 0) uri = files[0];
        }
        if (!uri) { vscode.window.showErrorMessage('No RGD file selected'); return; }

        try {
            const fileData = await vscode.workspace.fs.readFile(uri);
            const buffer = Buffer.from(fileData);
            const dict = this.getDictionary();
            const rgdFile = parseRgd(buffer, dict);

            let totalEntries = 0;
            let tableCount = 0;
            const countEntries = (entries: any[]) => {
                for (const e of entries) {
                    totalEntries++;
                    if ((e.type === 100 || e.type === 101) && e.value?.entries) {
                        tableCount++;
                        countEntries(e.value.entries);
                    }
                }
            };
            countEntries(rgdFile.gameData.entries);

            const info = [
                `File: ${path.basename(uri.fsPath)}`,
                `Size: ${buffer.length} bytes`,
                `Version: ${rgdFile.header.version}`,
                `Chunks: ${rgdFile.chunks.length}`,
                `Total Entries: ${totalEntries}`,
                `Tables: ${tableCount}`,
            ];
            if (rgdFile.gameData.reference) info.push(`Reference: ${rgdFile.gameData.reference}`);
            vscode.window.showInformationMessage(info.join(' | '));
        } catch (error: any) {
            vscode.window.showErrorMessage(`Failed to read info: ${error.message}`);
        }
    }

    async extractFromSga(uri?: vscode.Uri): Promise<void> {
        if (!uri) {
            const files = await vscode.window.showOpenDialog({ canSelectMany: false, filters: { 'SGA Archives': ['sga'] } });
            if (files && files.length > 0) uri = files[0];
        }
        if (!uri) { vscode.window.showErrorMessage('No SGA archive selected'); return; }

        try {
            const sga = openSgaArchive(uri.fsPath);
            const rgdFiles = sga.listRgdFiles();

            if (rgdFiles.length === 0) {
                vscode.window.showInformationMessage('No RGD files found in archive');
                return;
            }

            const outputUri = await vscode.window.showOpenDialog({
                canSelectFiles: false, canSelectFolders: true, canSelectMany: false, openLabel: 'Extract Here'
            });
            if (!outputUri || outputUri.length === 0) return;

            const outputDir = outputUri[0].fsPath;

            await vscode.window.withProgress({
                location: vscode.ProgressLocation.Notification,
                title: 'Extracting RGD files...',
                cancellable: true
            }, async (progress, token) => {
                const extracted = sga.extractRgdFiles(outputDir);
                const convertChoice = await vscode.window.showQuickPick(
                    ['Yes - Convert to text format', 'No - Keep binary'],
                    { placeHolder: 'Convert extracted RGD files to text format?' }
                );

                if (convertChoice?.startsWith('Yes')) {
                    let converted = 0;
                    const dict = this.getDictionary();
                    for (const rgdPath of extracted) {
                        if (token.isCancellationRequested) break;
                        try {
                            const rgdFile = readRgdFile(rgdPath, dict);
                            const localeMap = LocaleManager.getInstance().getLocaleMap(rgdPath);
                            const text = rgdToText(rgdFile, path.basename(rgdPath), localeMap);
                            fs.writeFileSync(rgdPath + '.txt', text, 'utf8');
                            converted++;
                            progress.report({ message: `Converted ${converted}/${extracted.length}` });
                        } catch (e) { }
                    }
                    vscode.window.showInformationMessage(`Extracted and converted ${converted} RGD files`);
                } else {
                    vscode.window.showInformationMessage(`Extracted ${extracted.length} RGD files`);
                }
            });
        } catch (error: any) {
            vscode.window.showErrorMessage(`Failed to extract: ${error.message}`);
        }
    }

    async autoConvertOnSave(document: vscode.TextDocument): Promise<void> {
        if (!document.fileName.endsWith('.rgd.txt')) return;
        try {
            const text = document.getText();
            const dict = this.getDictionary();
            const { gameData, version } = textToRgd(text, dict);
            const outputPath = document.fileName.slice(0, -4);
            writeRgdFile(outputPath, gameData, dict, version);
            vscode.window.setStatusBarMessage(`RGD saved: ${path.basename(outputPath)}`, 3000);
        } catch (error: any) {
            vscode.window.showWarningMessage(`Auto-convert failed: ${error.message}`);
        }
    }

    private findAttribBase(filePath: string): string | null {
        const normalized = filePath.replace(/\\/g, '/').toLowerCase();
        const attribIndex = normalized.lastIndexOf('/attrib/');
        if (attribIndex !== -1) return filePath.substring(0, attribIndex + '/attrib'.length);
        return null;
    }

    async dumpToLua(uri?: vscode.Uri): Promise<void> {
        uri = uri || vscode.window.activeTextEditor?.document.uri;

        if (!uri) {
            const files = await vscode.window.showOpenDialog({ canSelectMany: false, filters: { 'RGD Files': ['rgd'] } });
            if (files && files.length > 0) uri = files[0];
        }
        if (!uri) { vscode.window.showErrorMessage('No RGD file selected'); return; }

        try {
            const fileData = await vscode.workspace.fs.readFile(uri);
            const buffer = Buffer.from(fileData);
            const dict = this.getDictionary();
            const rgdFile = parseRgd(buffer, dict);
            const attribBase = this.findAttribBase(uri.fsPath);

            const luaFileLoader: LuaFileLoader = (refPath: string): string | null => {
                if (!attribBase) return null;
                let cleanPath = refPath.replace(/\\/g, '/');
                if (cleanPath.endsWith('.lua')) cleanPath = cleanPath.slice(0, -4);
                const luaPath = path.join(attribBase, cleanPath + '.lua');
                if (fs.existsSync(luaPath)) return fs.readFileSync(luaPath, 'utf8');
                const rgdPath = path.join(attribBase, cleanPath + '.rgd');
                if (fs.existsSync(rgdPath)) {
                    const parentRgd = parseRgd(Buffer.from(fs.readFileSync(rgdPath)), dict);
                    return rgdToLua(parentRgd);
                }
                return null;
            };

            const parentLoader: ParentLoader = async (refPath: string): Promise<ParsedLuaTable | null> => {
                const luaCode = luaFileLoader(refPath);
                if (!luaCode) return null;
                return parseLuaToTable(luaCode, luaFileLoader);
            };

            const luaCode = await rgdToLuaDifferential(rgdFile, parentLoader);
            const outputPath = uri.fsPath.replace(/\.rgd$/i, '.lua');
            fs.writeFileSync(outputPath, luaCode, 'utf8');
            const doc = await vscode.workspace.openTextDocument(outputPath);
            await vscode.window.showTextDocument(doc);
            vscode.window.showInformationMessage(`Dumped to ${path.basename(outputPath)}`);
        } catch (error: any) {
            vscode.window.showErrorMessage(`Failed to dump to Lua: ${error.message}`);
        }
    }

    async compileToRgd(uri?: vscode.Uri): Promise<void> {
        uri = uri || vscode.window.activeTextEditor?.document.uri;

        if (!uri) {
            const files = await vscode.window.showOpenDialog({ canSelectMany: false, filters: { 'Lua Files': ['lua'] } });
            if (files && files.length > 0) uri = files[0];
        }
        if (!uri) { vscode.window.showErrorMessage('No Lua file selected'); return; }

        try {
            const luaCode = fs.readFileSync(uri.fsPath, 'utf8');
            const dict = this.getDictionary();
            const attribBase = this.findAttribBase(uri.fsPath);

            const rgdParentLoader: RgdParentLoader = async (refPath: string): Promise<RgdTable | null> => {
                if (!attribBase) return null;
                let cleanPath = refPath.replace(/\\/g, '/');
                if (cleanPath.endsWith('.lua')) cleanPath = cleanPath.slice(0, -4);
                const rgdPath = path.join(attribBase, cleanPath + '.rgd');
                if (fs.existsSync(rgdPath)) {
                    const parentRgd = parseRgd(Buffer.from(fs.readFileSync(rgdPath)), dict);
                    return parentRgd.gameData;
                }
                const luaPath = path.join(attribBase, cleanPath + '.lua');
                if (fs.existsSync(luaPath)) {
                    const parentLuaCode = fs.readFileSync(luaPath, 'utf8');
                    const { gameData } = await luaToRgdResolved(parentLuaCode, dict, rgdParentLoader);
                    return gameData;
                }
                return null;
            };

            const { gameData, version } = await luaToRgdResolved(luaCode, dict, rgdParentLoader);
            const outputPath = uri.fsPath.replace(/\.lua$/i, '.rgd');

            if (fs.existsSync(outputPath)) {
                const choice = await vscode.window.showWarningMessage(
                    `${path.basename(outputPath)} already exists. Overwrite?`, 'Yes', 'No');
                if (choice !== 'Yes') return;
            }

            writeRgdFile(outputPath, gameData, dict, version);
            vscode.window.showInformationMessage(`Compiled to ${path.basename(outputPath)}`);
        } catch (error: any) {
            vscode.window.showErrorMessage(`Failed to compile to RGD: ${error.message}`);
        }
    }

    async batchToLua(): Promise<void> {
        const folders = await vscode.window.showOpenDialog({
            canSelectFiles: false, canSelectFolders: true, canSelectMany: false, openLabel: 'Select Folder'
        });
        if (!folders || folders.length === 0) return;

        const folderPath = folders[0].fsPath;
        const dict = this.getDictionary();
        const attribBase = this.findAttribBase(folderPath);

        const rgdFiles = fs.readdirSync(folderPath)
            .filter(f => f.toLowerCase().endsWith('.rgd'))
            .map(f => path.join(folderPath, f));

        if (rgdFiles.length === 0) { vscode.window.showWarningMessage('No RGD files found in folder'); return; }

        const luaFileLoader: LuaFileLoader = (refPath: string): string | null => {
            if (!attribBase) return null;
            let cleanPath = refPath.replace(/\\/g, '/');
            if (cleanPath.endsWith('.lua')) cleanPath = cleanPath.slice(0, -4);
            const luaPath = path.join(attribBase, cleanPath + '.lua');
            if (fs.existsSync(luaPath)) return fs.readFileSync(luaPath, 'utf8');
            const rgdPath = path.join(attribBase, cleanPath + '.rgd');
            if (fs.existsSync(rgdPath)) {
                const parentRgd = parseRgd(Buffer.from(fs.readFileSync(rgdPath)), dict);
                return rgdToLua(parentRgd);
            }
            return null;
        };

        const parentLoader: ParentLoader = async (refPath: string) => {
            const luaCode = luaFileLoader(refPath);
            if (!luaCode) return null;
            return parseLuaToTable(luaCode, luaFileLoader);
        };

        await vscode.window.withProgress({
            location: vscode.ProgressLocation.Notification,
            title: 'Converting RGD files to Lua',
            cancellable: true
        }, async (progress, token) => {
            let converted = 0;
            let errors = 0;
            for (let i = 0; i < rgdFiles.length; i++) {
                if (token.isCancellationRequested) break;
                const rgdFile = rgdFiles[i];
                progress.report({ message: `${path.basename(rgdFile)} (${i + 1}/${rgdFiles.length})`, increment: 100 / rgdFiles.length });
                try {
                    const buffer = fs.readFileSync(rgdFile);
                    const rgd = parseRgd(Buffer.from(buffer), dict);
                    const luaCode = await rgdToLuaDifferential(rgd, parentLoader);
                    fs.writeFileSync(rgdFile.replace(/\.rgd$/i, '.lua'), luaCode, 'utf8');
                    converted++;
                } catch (e: any) {
                    console.error(`Failed to convert ${rgdFile}: ${e.message}`);
                    errors++;
                }
            }
            vscode.window.showInformationMessage(`Converted ${converted} files${errors > 0 ? `, ${errors} errors` : ''}`);
        });
    }

    async batchToRgd(): Promise<void> {
        const folders = await vscode.window.showOpenDialog({
            canSelectFiles: false, canSelectFolders: true, canSelectMany: false, openLabel: 'Select Folder'
        });
        if (!folders || folders.length === 0) return;

        const folderPath = folders[0].fsPath;
        const dict = this.getDictionary();
        const attribBase = this.findAttribBase(folderPath);

        const luaFiles = fs.readdirSync(folderPath)
            .filter(f => f.toLowerCase().endsWith('.lua'))
            .map(f => path.join(folderPath, f));

        if (luaFiles.length === 0) { vscode.window.showWarningMessage('No Lua files found in folder'); return; }

        const rgdParentLoader: RgdParentLoader = async (refPath: string): Promise<RgdTable | null> => {
            if (!attribBase) return null;
            let cleanPath = refPath.replace(/\\/g, '/');
            if (cleanPath.endsWith('.lua')) cleanPath = cleanPath.slice(0, -4);
            const rgdPath = path.join(attribBase, cleanPath + '.rgd');
            if (fs.existsSync(rgdPath)) {
                const parentRgd = parseRgd(Buffer.from(fs.readFileSync(rgdPath)), dict);
                return parentRgd.gameData;
            }
            const luaPath = path.join(attribBase, cleanPath + '.lua');
            if (fs.existsSync(luaPath)) {
                const parentLuaCode = fs.readFileSync(luaPath, 'utf8');
                const { gameData } = await luaToRgdResolved(parentLuaCode, dict, rgdParentLoader);
                return gameData;
            }
            return null;
        };

        await vscode.window.withProgress({
            location: vscode.ProgressLocation.Notification,
            title: 'Compiling Lua files to RGD',
            cancellable: true
        }, async (progress, token) => {
            let compiled = 0;
            let errors = 0;
            for (let i = 0; i < luaFiles.length; i++) {
                if (token.isCancellationRequested) break;
                const luaFile = luaFiles[i];
                progress.report({ message: `${path.basename(luaFile)} (${i + 1}/${luaFiles.length})`, increment: 100 / luaFiles.length });
                try {
                    const luaCode = fs.readFileSync(luaFile, 'utf8');
                    const { gameData, version } = await luaToRgdResolved(luaCode, dict, rgdParentLoader);
                    writeRgdFile(luaFile.replace(/\.lua$/i, '.rgd'), gameData, dict, version);
                    compiled++;
                } catch (e: any) {
                    console.error(`Failed to compile ${luaFile}: ${e.message}`);
                    errors++;
                }
            }
            vscode.window.showInformationMessage(`Compiled ${compiled} files${errors > 0 ? `, ${errors} errors` : ''}`);
        });
    }
}
