import * as vscode from 'vscode';
import * as path from 'path';
import * as fs from 'fs';
import { RgdCommands } from './commands';
import { registerRgdFileSystem } from './rgdFileSystem';
import { registerRgdLinkProvider } from './rgdLinkProvider';
import { DictionaryManager } from './dictionaryManager';
import { LocaleManager } from './localeManager';
import { RgdEditorProvider } from './rgdEditorProvider';
import { registerRgdTreeView } from './rgdTreeView';
import { registerCliCommands } from './cliCommands';
import { registerParityCommands } from './parityChecker';
import { findAttribBase } from './attribUtils';

export function activate(context: vscode.ExtensionContext) {
    console.log('RGD Suite v1.1.1 is now active');

    // Initialize dictionary early — shared by all sub-systems
    DictionaryManager.getInstance().getDictionary(context);

    // Register the virtual file system (rgd:// scheme)
    const fsProvider = registerRgdFileSystem(context);

    // Register link provider for clickable paths in rgd-text files
    registerRgdLinkProvider(context);

    // Refresh dictionary when configuration changes
    context.subscriptions.push(vscode.workspace.onDidChangeConfiguration(e => {
        if (e.affectsConfiguration('rgdEditor.dictionaryPaths')) {
            console.log('[RGD Suite] Dictionary configuration changed, refreshing...');
            DictionaryManager.getInstance().refresh(context);
        }
    }));

    // Register editor commands (table editor, convert, dump, SGA, batch, etc.)
    const commands = new RgdCommands(context);
    context.subscriptions.push(
        vscode.commands.registerCommand('rgdEditor.convertToText', commands.convertToText.bind(commands)),
        vscode.commands.registerCommand('rgdEditor.convertToBinary', commands.convertToBinary.bind(commands)),
        vscode.commands.registerCommand('rgdEditor.showInfo', commands.showInfo.bind(commands)),
        vscode.commands.registerCommand('rgdEditor.extractFromSga', commands.extractFromSga.bind(commands)),
        vscode.commands.registerCommand('rgdEditor.dumpToLua', commands.dumpToLua.bind(commands)),
        vscode.commands.registerCommand('rgdEditor.compileToRgd', commands.compileToRgd.bind(commands)),
        vscode.commands.registerCommand('rgdEditor.batchToLua', commands.batchToLua.bind(commands)),
        vscode.commands.registerCommand('rgdEditor.batchToRgd', commands.batchToRgd.bind(commands)),
        vscode.commands.registerCommand('rgdEditor.selectLocaleFolder', async () => {
            await LocaleManager.getInstance().setManualLocaleFolder();
        }),
        vscode.commands.registerCommand('rgdEditor.openRgd', async (uri: vscode.Uri) => {
            if (uri) {
                const rgdUri = fsProvider.toRgdUri(uri.fsPath);
                const doc = await vscode.workspace.openTextDocument(rgdUri);
                await vscode.window.showTextDocument(doc, { preview: false });
                await vscode.languages.setTextDocumentLanguage(doc, 'rgd-text');
            }
        }),
        vscode.commands.registerCommand('rgdEditor.openRgdText', async (uri: vscode.Uri) => {
            if (uri) {
                const rgdUri = fsProvider.toRgdUri(uri.fsPath);
                const doc = await vscode.workspace.openTextDocument(rgdUri);
                await vscode.window.showTextDocument(doc, { preview: false });
                await vscode.languages.setTextDocumentLanguage(doc, 'rgd-text');
                vscode.window.showInformationMessage('Opened in Text Editor (backup mode). Use RGD: Open for Table Editor.');
            }
        })
    );

    // Handle link/reference navigation
    context.subscriptions.push(
        vscode.commands.registerCommand('rgdEditor.openReferencedFile', async (filePath: string, line: number = 0, isIcon: boolean = false) => {
            try {
                if (!filePath) return;
                let targetUri: vscode.Uri | undefined;

                if (isIcon) {
                    let cleanIcon = filePath.replace(/\\/g, '/');
                    if (cleanIcon.startsWith('/')) cleanIcon = cleanIcon.substring(1);
                    const iconName = path.basename(cleanIcon, path.extname(cleanIcon));
                    const patterns = [
                        `**/art/ui/**/${iconName}.{tga,dds,png}`,
                        `**/ui/**/${iconName}.{tga,dds,png}`,
                        `**/${iconName}.{tga,dds,png}`
                    ];
                    for (const pattern of patterns) {
                        const files = await vscode.workspace.findFiles(pattern, '**/node_modules/**', 10);
                        if (files.length > 0) { targetUri = files[0]; break; }
                    }
                } else if (path.isAbsolute(filePath)) {
                    targetUri = vscode.Uri.file(filePath);
                } else {
                    let searchPath = filePath.replace(/\\/g, '/');
                    if (searchPath.startsWith('/')) searchPath = searchPath.substring(1);

                    // Prefer the detected attribRoot of the current document — a
                    // direct join is O(1) vs globbing the whole workspace.
                    const activeFsPath = vscode.window.activeTextEditor?.document.uri.fsPath;
                    const attribBase = activeFsPath ? findAttribBase(activeFsPath) : null;
                    if (attribBase) {
                        let relForAttrib = searchPath;
                        if (relForAttrib.toLowerCase().startsWith('data/attrib/')) {
                            relForAttrib = relForAttrib.substring(12);
                        } else if (relForAttrib.toLowerCase().startsWith('attrib/')) {
                            relForAttrib = relForAttrib.substring(7);
                        }
                        const candidate = path.join(attribBase, relForAttrib);
                        if (fs.existsSync(candidate)) {
                            targetUri = vscode.Uri.file(candidate);
                        }
                    }

                    if (!targetUri) {
                        const files = await vscode.workspace.findFiles(`**/${searchPath}`, '**/node_modules/**', 1);
                        if (files.length > 0) {
                            targetUri = files[0];
                        } else {
                            if (searchPath.startsWith('data/')) {
                                const subPath = searchPath.substring(5);
                                const subFiles = await vscode.workspace.findFiles(`**/${subPath}`, '**/node_modules/**', 1);
                                if (subFiles.length > 0) targetUri = subFiles[0];
                            }
                            if (!targetUri) {
                                const fileName = path.basename(searchPath);
                                const fallback = await vscode.workspace.findFiles(`**/${fileName}`, '**/node_modules/**', 1);
                                if (fallback.length > 0) targetUri = fallback[0];
                            }
                        }
                    }
                }

                if (targetUri) {
                    const doc = await vscode.workspace.openTextDocument(targetUri);
                    const editor = await vscode.window.showTextDocument(doc);
                    if (line > 0) {
                        const pos = new vscode.Position(line - 1, 0);
                        editor.selection = new vscode.Selection(pos, pos);
                        editor.revealRange(new vscode.Range(pos, pos), vscode.TextEditorRevealType.InCenter);
                    }
                } else {
                    vscode.window.showWarningMessage(`Could not find file: ${filePath}`);
                }
            } catch (e: any) {
                vscode.window.showErrorMessage(`Failed to open linked file: ${e.message}`);
            }
        })
    );

    // Register the custom table editor webview
    const editorProvider = new RgdEditorProvider(context.extensionUri, context, DictionaryManager.getInstance());
    context.subscriptions.push(
        vscode.window.registerCustomEditorProvider(
            'rgdEditor.rgdEditor',
            editorProvider,
            {
                webviewOptions: { retainContextWhenHidden: true },
                supportsMultipleEditorsPerDocument: false
            }
        )
    );

    // Register the sidebar tree view
    registerRgdTreeView(context);

    // Register CLI-style commands (native, no child_process spawn)
    registerCliCommands(context);

    // Register parity checker commands
    registerParityCommands(context);

    // Guard: if a .rgd binary is opened directly as a text doc (bypasses custom editor),
    // redirect immediately to the VFS-backed text view with proper language
    context.subscriptions.push(
        vscode.workspace.onDidOpenTextDocument(async (doc) => {
            if (
                doc.uri.scheme === 'file' &&
                doc.fileName.endsWith('.rgd') &&
                doc.languageId !== 'rgd-text'
            ) {
                try {
                    const rgdUri = fsProvider.toRgdUri(doc.uri.fsPath);
                    const vfsDoc = await vscode.workspace.openTextDocument(rgdUri);
                    await vscode.window.showTextDocument(vfsDoc, { preview: false });
                    await vscode.languages.setTextDocumentLanguage(vfsDoc, 'rgd-text');
                } catch { /* silently ignore — custom editor will handle it */ }
            }
        })
    );

    // Auto-convert .rgd.txt to binary on save if enabled
    context.subscriptions.push(
        vscode.workspace.onDidSaveTextDocument(async (doc) => {
            const config = vscode.workspace.getConfiguration('rgdEditor');
            if (config.get('autoConvertOnSave', true) && doc.fileName.endsWith('.rgd.txt')) {
                await commands.autoConvertOnSave(doc);
            }
        })
    );
}

export function deactivate() {
    console.log('RGD Suite deactivated');
}
