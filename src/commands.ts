import * as vscode from 'vscode';
import * as os from 'os';
import * as path from 'path';
import * as fs from 'fs';
import { parseRgd, readRgdFile } from '../bundled/rgd-tools/dist/reader';
import { rgdToText, textToRgd } from '../bundled/rgd-tools/dist/textFormat';
import { writeRgdFile } from '../bundled/rgd-tools/dist/writer';
import { luaToRgdResolved, rgdToLuaDifferential } from '../bundled/rgd-tools/dist/luaFormat';
import { findAttribBase, makeLuaParentLoader, makeRgdParentLoader, countEntries, collectFilesAsync } from './attribUtils';
import { openSgaArchive } from '../bundled/rgd-tools/dist/sga';
import { DictionaryManager } from './dictionaryManager';
import { LocaleManager } from './localeManager';
import { BatchConvertWorkerPool, BatchOp } from './batchConvertPool';

export class RgdCommands {
    constructor(private readonly context: vscode.ExtensionContext) { }

    private getDictionary() {
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
            await fs.promises.writeFile(outputPath, text, 'utf8');
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
            const text = await fs.promises.readFile(uri.fsPath, 'utf8');
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
            const { totalEntries, tableCount } = countEntries(rgdFile.gameData.entries);

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
                            await fs.promises.writeFile(rgdPath + '.txt', text, 'utf8');
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
            const attribBase = findAttribBase(uri.fsPath);
            const parentLoader = makeLuaParentLoader(attribBase, dict);
            const luaCode = await rgdToLuaDifferential(rgdFile, parentLoader);
            const outputPath = uri.fsPath.replace(/\.rgd$/i, '.lua');
            await fs.promises.writeFile(outputPath, luaCode, 'utf8');
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
            const luaCode = await fs.promises.readFile(uri.fsPath, 'utf8');
            const dict = this.getDictionary();
            const attribBase = findAttribBase(uri.fsPath);
            const rgdParentLoader = makeRgdParentLoader(attribBase, dict);
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
        await this.runBatchConvert({
            op: 'toLua',
            inputExt: '.rgd',
            outputExt: '.lua',
            title: 'Converting RGD files to Lua',
            verbPast: 'Converted',
            promptLabel: '.lua files',
        });
    }

    async batchToRgd(): Promise<void> {
        await this.runBatchConvert({
            op: 'toRgd',
            inputExt: '.lua',
            outputExt: '.rgd',
            title: 'Compiling Lua files to RGD',
            verbPast: 'Compiled',
            promptLabel: '.rgd files',
        });
    }

    /**
     * Shared driver for rgd↔lua batch conversion. Uses a worker pool when
     * available (bundled workers/batch-convert-worker.js) so the extension host
     * stays responsive; falls back to in-process sequential conversion
     * otherwise. Behaviourally identical to the old per-direction
     * implementations.
     */
    private async runBatchConvert(opts: {
        op: BatchOp;
        inputExt: '.rgd' | '.lua';
        outputExt: '.rgd' | '.lua';
        title: string;
        verbPast: 'Converted' | 'Compiled';
        promptLabel: string;
    }): Promise<void> {
        const folders = await vscode.window.showOpenDialog({
            canSelectFiles: false, canSelectFolders: true, canSelectMany: false, openLabel: 'Select Folder'
        });
        if (!folders || folders.length === 0) return;

        const folderPath = folders[0].fsPath;
        const dict = this.getDictionary();
        const attribBase = findAttribBase(folderPath);

        const files = await collectFilesAsync(folderPath, opts.inputExt);
        if (files.length === 0) {
            vscode.window.showWarningMessage(`No ${opts.inputExt} files found in folder`);
            return;
        }

        // Pool setup — mirror the parity-check pattern so behaviour stays
        // consistent across batch commands.
        const extensionPath = this.context.extensionPath;
        const workerScript = path.join(extensionPath, 'workers', 'batch-convert-worker.js');
        const distPath = path.join(extensionPath, 'bundled', 'rgd-tools', 'dist');
        const cfg = vscode.workspace.getConfiguration('rgdEditor');
        const userDicts = (cfg.get<string[]>('dictionaryPaths') || []).filter(p => fs.existsSync(p));
        const bundledDict = path.join(extensionPath, 'dictionaries', 'RGD_DIC.TXT');
        const allDictPaths = fs.existsSync(bundledDict) ? [bundledDict, ...userDicts] : userDicts;

        const canUseWorkers = fs.existsSync(workerScript);
        const configuredCount = vscode.workspace.getConfiguration('rgdSuite').get<number>('batchWorkers', 0);
        const autoCount = Math.max(1, os.cpus().length - 1);
        const workerCount = canUseWorkers ? (configuredCount > 0 ? configuredCount : autoCount) : 0;

        let pool: BatchConvertWorkerPool | null = null;
        if (workerCount > 0) {
            pool = new BatchConvertWorkerPool(workerCount, workerScript, distPath, allDictPaths);
            pool.start();
        }

        await vscode.window.withProgress({
            location: vscode.ProgressLocation.Notification,
            title: `${opts.title}${workerCount > 0 ? ` (${workerCount} workers)` : ''}`,
            cancellable: true,
        }, async (progress, token) => {
            let done = 0;
            let errors = 0;
            const created: string[] = [];
            const total = files.length;
            const reportEvery = Math.max(1, Math.floor(total / 200));
            const bumpProgress = () => {
                done++;
                if (done % reportEvery === 0 || done === total) {
                    progress.report({ message: `${done}/${total}`, increment: (100 * reportEvery) / total });
                }
            };

            try {
                if (pool) {
                    // Dispatch all in parallel; pool drains per-worker.
                    const fallbackParentLoader = opts.op === 'toLua'
                        ? makeLuaParentLoader(attribBase, dict)
                        : null;
                    const rgdParentLoader = opts.op === 'toRgd'
                        ? makeRgdParentLoader(attribBase, dict)
                        : null;

                    token.onCancellationRequested(() => pool?.cancel());

                    const tasks = files.map(async inputFile => {
                        if (token.isCancellationRequested) return;
                        const outPath = inputFile.replace(
                            opts.inputExt === '.rgd' ? /\.rgd$/i : /\.lua$/i,
                            opts.outputExt,
                        );
                        try {
                            await pool!.convert(opts.op, inputFile, outPath, attribBase);
                            created.push(outPath);
                        } catch (e: any) {
                            // Don't re-run work on the extension host if the user
                            // just cancelled — pool.cancel() rejects the rest of
                            // the queue with Error('Cancelled') and falling back
                            // here would process every remaining file serially,
                            // defeating the cancel button.
                            if (token.isCancellationRequested) {
                                // Intentionally no-op: progress is bumped in finally.
                            } else {
                                // Workers may fail on a malformed file — fall back to
                                // in-process conversion so a single bad input doesn't
                                // fail the entire batch.
                                try {
                                    if (opts.op === 'toLua' && fallbackParentLoader) {
                                        const rgd = parseRgd(await fs.promises.readFile(inputFile), dict);
                                        const luaCode = await rgdToLuaDifferential(rgd, fallbackParentLoader);
                                        await fs.promises.writeFile(outPath, luaCode, 'utf8');
                                        created.push(outPath);
                                    } else if (opts.op === 'toRgd' && rgdParentLoader) {
                                        const luaCode = await fs.promises.readFile(inputFile, 'utf8');
                                        const { gameData, version } = await luaToRgdResolved(luaCode, dict, rgdParentLoader);
                                        writeRgdFile(outPath, gameData, dict, version);
                                        created.push(outPath);
                                    } else {
                                        throw e;
                                    }
                                } catch (fallbackErr: any) {
                                    console.error(`Failed to process ${inputFile}: ${fallbackErr.message}`);
                                    errors++;
                                }
                            }
                        } finally {
                            bumpProgress();
                        }
                    });
                    await Promise.all(tasks);
                } else {
                    // Serial fallback (no workers available)
                    const parentLoader = opts.op === 'toLua' ? makeLuaParentLoader(attribBase, dict) : null;
                    const rgdParentLoader = opts.op === 'toRgd' ? makeRgdParentLoader(attribBase, dict) : null;
                    for (let i = 0; i < files.length; i++) {
                        if (token.isCancellationRequested) break;
                        const inputFile = files[i];
                        const outPath = inputFile.replace(
                            opts.inputExt === '.rgd' ? /\.rgd$/i : /\.lua$/i,
                            opts.outputExt,
                        );
                        try {
                            if (opts.op === 'toLua') {
                                const rgd = parseRgd(await fs.promises.readFile(inputFile), dict);
                                const luaCode = await rgdToLuaDifferential(rgd, parentLoader!);
                                await fs.promises.writeFile(outPath, luaCode, 'utf8');
                            } else {
                                const luaCode = await fs.promises.readFile(inputFile, 'utf8');
                                const { gameData, version } = await luaToRgdResolved(luaCode, dict, rgdParentLoader!);
                                writeRgdFile(outPath, gameData, dict, version);
                            }
                            created.push(outPath);
                        } catch (e: any) {
                            console.error(`Failed to process ${inputFile}: ${e.message}`);
                            errors++;
                        }
                        bumpProgress();
                        if (i % 10 === 0) await new Promise<void>(r => setImmediate(r));
                    }
                }
            } finally {
                pool?.dispose();
            }

            // Use `created.length` rather than `done - errors` so cancelled
            // files (which bump progress but produce no output) aren't
            // miscounted as successes.
            const successes = created.length;
            vscode.window.showInformationMessage(
                `${opts.verbPast} ${successes} files${errors > 0 ? `, ${errors} errors` : ''}`
            );
            if (created.length > 0) {
                const choice = await vscode.window.showQuickPick(
                    ['Keep generated files', 'Delete generated files (test cleanup)'],
                    { placeHolder: `${created.length} ${opts.promptLabel} created — keep or delete?` }
                );
                if (choice?.startsWith('Delete')) {
                    let deleted = 0;
                    await Promise.all(created.map(async f => {
                        try { await fs.promises.unlink(f); deleted++; } catch { }
                    }));
                    vscode.window.showInformationMessage(`Deleted ${deleted} generated ${opts.promptLabel}`);
                }
            }
        });
    }
}
