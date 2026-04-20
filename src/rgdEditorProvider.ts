import * as vscode from 'vscode';
import * as path from 'path';
import * as fs from 'fs';
import { parseRgd } from '../bundled/rgd-tools/dist/reader';
import { rgdToTree, treeToRgd, RgdNode } from './rgdTable';
import { writeRgdFile } from '../bundled/rgd-tools/dist/writer';
import { DictionaryManager } from './dictionaryManager';
import { LocaleManager } from './localeManager';
import { findAttribBase } from './attribUtils';

interface WebviewMessage {
    type: string;
    [key: string]: any;
}

class RgdDocument implements vscode.CustomDocument {
    public isDirty: boolean = false;
    public rgdVersion: number = 1;

    constructor(
        public readonly uri: vscode.Uri,
        public nodes: RgdNode[] = []
    ) { }

    dispose(): void { }
}

export class RgdEditorProvider implements vscode.CustomReadonlyEditorProvider<RgdDocument> {
    public static readonly viewType = 'rgdEditor.rgdEditor';

    constructor(
        private readonly _extensionUri: vscode.Uri,
        private readonly context: vscode.ExtensionContext,
        private readonly dictionaryManager: DictionaryManager
    ) { }

    async openCustomDocument(
        uri: vscode.Uri,
        _openContext: vscode.CustomDocumentOpenContext,
        _token: vscode.CancellationToken
    ): Promise<RgdDocument> {
        return new RgdDocument(uri);
    }

    async resolveCustomEditor(
        document: RgdDocument,
        webviewPanel: vscode.WebviewPanel,
        _token: vscode.CancellationToken
    ): Promise<void> {
        webviewPanel.webview.options = {
            enableScripts: true,
            localResourceRoots: [this._extensionUri]
        };

        try {
            const buffer = await fs.promises.readFile(document.uri.fsPath);
            const dict = this.dictionaryManager.getDictionary(this.context);
            const rgd = parseRgd(buffer, dict);

            const attribRoot = findAttribBase(document.uri.fsPath) ?? undefined;

            document.rgdVersion = rgd.header.version;
            const localeMap = LocaleManager.getInstance().getLocaleMap(document.uri.fsPath);
            document.nodes = rgdToTree(rgd.gameData, attribRoot, localeMap);

            webviewPanel.webview.html = this._getHtml(webviewPanel.webview, document.uri.fsPath, document.nodes);

            webviewPanel.webview.onDidReceiveMessage(async (message: WebviewMessage) => {
                switch (message.type) {
                    case 'ready':
                        webviewPanel.webview.postMessage({ type: 'loadData', data: document.nodes });
                        break;

                    case 'openRef':
                        if (message.ref) {
                            const refPath = message.ref.replace(/\\/g, '/');
                            const hasExtension = /\.(lua|rgd|scar|ai)$/i.test(refPath);
                            const extensions = hasExtension ? [''] : ['.rgd', '.lua'];
                            let targetPath = '';
                            // Prefer the memoized attribRoot detected at open time —
                            // avoids walking the directory tree on every click.
                            const base = attribRoot ?? findAttribBase(document.uri.fsPath);
                            if (base) {
                                for (const ext of extensions) {
                                    const testPath = path.join(base, refPath + ext);
                                    if (fs.existsSync(testPath)) { targetPath = testPath; break; }
                                }
                            }
                            if (targetPath) {
                                vscode.commands.executeCommand('vscode.open', vscode.Uri.file(targetPath));
                            } else {
                                vscode.window.showWarningMessage(`Referenced file not found: ${refPath}`);
                            }
                        }
                        break;

                    case 'updateValue':
                        if (message.path && message.value !== undefined) {
                            this._updateNodeValue(document.nodes, message.path, message.key, message.value);
                            document.isDirty = true;
                        }
                        break;

                    case 'save':
                        try {
                            await this._saveRgd(document);
                            const reloadBuffer = await fs.promises.readFile(document.uri.fsPath);
                            const reloadDict = this.dictionaryManager.getDictionary(this.context);
                            const reloadRgd = parseRgd(reloadBuffer, reloadDict);
                            const reloadLocaleMap = LocaleManager.getInstance().getLocaleMap(document.uri.fsPath);
                            document.nodes = rgdToTree(reloadRgd.gameData, attribRoot, reloadLocaleMap);
                            document.isDirty = false;
                            webviewPanel.webview.postMessage({ type: 'saved' });
                            webviewPanel.webview.postMessage({ type: 'loadData', data: document.nodes });
                            vscode.window.showInformationMessage('RGD saved and reloaded');
                        } catch (saveError: any) {
                            vscode.window.showErrorMessage(`Failed to save RGD: ${saveError.message}`);
                        }
                        break;
                }
            });
        } catch (error: any) {
            webviewPanel.webview.html = this._getErrorHtml(document.uri.fsPath, error.message);
        }
    }

    private _getErrorHtml(filePath: string, errorMessage: string): string {
        return `<!DOCTYPE html>
<html lang="en">
<head>
    <meta charset="UTF-8">
    <style>
        body { font-family: sans-serif; padding: 20px; background: #1e1e1e; color: #ccc; }
        .error { color: #f44; padding: 20px; background: #2d2d30; border-radius: 4px; }
        h2 { color: #fff; }
    </style>
</head>
<body>
    <h2>Failed to load RGD file</h2>
    <div class="error">
        <strong>File:</strong> ${path.basename(filePath)}<br><br>
        <strong>Error:</strong> ${errorMessage}
    </div>
    <p>Try using the text editor backup: Right-click the file → "RGD: Open (Plain Text Editor)"</p>
</body>
</html>`;
    }

    private _getHtml(webview: vscode.Webview, filePath: string, nodes: RgdNode[]): string {
        const scriptUri = webview.asWebviewUri(
            vscode.Uri.joinPath(this._extensionUri, 'media', 'editor.js')
        );
        const styleUri = webview.asWebviewUri(
            vscode.Uri.joinPath(this._extensionUri, 'media', 'editor.css')
        );

        return `<!DOCTYPE html>
<html lang="en">
<head>
    <meta charset="UTF-8">
    <meta name="viewport" content="width=device-width, initial-scale=1.0">
    <link href="${styleUri}" rel="stylesheet">
    <title>RGD Suite - ${path.basename(filePath)}</title>
</head>
<body>
    <div class="rgd-container">
        <div class="toolbar">
            <span class="toolbar-title">📄 ${path.basename(filePath)}</span>
            <button class="toolbar-btn primary" id="save-btn" title="Save (Ctrl+S)">💾 Save</button>
            <button class="toolbar-btn" id="expand-all" title="Expand All">Expand All</button>
            <button class="toolbar-btn" id="collapse-all" title="Collapse All">Collapse All</button>
        </div>
        <div class="split-view">
            <div class="tree-panel">
                <div class="tree-header">Tables</div>
                <div class="tree-content" id="tree-content">
                    <div class="empty-state">Loading...</div>
                </div>
            </div>
            <div class="resizer" id="resizer"></div>
            <div class="property-panel">
                <div class="property-header" id="property-header-text">Properties</div>
                <div class="property-content" id="property-content">
                    <div class="empty-state">
                        <div class="empty-state-icon">📋</div>
                        <div>Select a node to view properties</div>
                    </div>
                </div>
            </div>
        </div>
        <div class="status-bar">
            <div class="status-item"><span id="status-text">Ready</span></div>
            <div class="status-item"><span>${nodes.length} top-level nodes</span></div>
        </div>
    </div>
    <script src="${scriptUri}"></script>
</body>
</html>`;
    }

    private _updateNodeValue(nodes: RgdNode[], nodePath: number[], key: string | null, value: any): void {
        let current: RgdNode | undefined;
        let parent: RgdNode[] = nodes;
        for (let i = 0; i < nodePath.length; i++) {
            current = parent[nodePath[i]];
            if (!current) return;
            if (i < nodePath.length - 1 && current.children) {
                parent = current.children;
            }
        }
        if (!current) return;
        if (key && current.children) {
            const child = current.children.find(c => c.key === key);
            if (child) child.value = value;
        } else {
            current.value = value;
        }
    }

    private async _saveRgd(document: RgdDocument): Promise<void> {
        const rgdTable = treeToRgd(document.nodes);
        const dict = this.dictionaryManager.getDictionary(this.context);
        const backupPath = document.uri.fsPath + '.bak';
        if (fs.existsSync(document.uri.fsPath)) {
            fs.copyFileSync(document.uri.fsPath, backupPath);
        }
        try {
            writeRgdFile(document.uri.fsPath, rgdTable, dict, document.rgdVersion);
        } catch (writeError) {
            if (fs.existsSync(backupPath)) {
                fs.copyFileSync(backupPath, document.uri.fsPath);
            }
            throw writeError;
        }
    }
}
