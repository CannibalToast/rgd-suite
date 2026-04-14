import * as vscode from 'vscode';
import { parseRgd } from '../bundled/rgd-tools/dist/reader';
import { HashDictionary, RgdDataType, dataTypeName, LocaleEntry } from '../bundled/rgd-tools/dist/types';
import { rgdToTree, treeToRgd, RgdNode } from './rgdTable';
import { writeRgdFile } from '../bundled/rgd-tools/dist/writer';
import * as path from 'path';
import * as fs from 'fs';
import { DictionaryManager } from './dictionaryManager';
import { LocaleManager } from './localeManager';

class RgdTreeItem extends vscode.TreeItem {
    public editable: boolean = false;

    constructor(public readonly node: RgdNode, public readonly nodePath: number[], public readonly collapsibleState: vscode.TreeItemCollapsibleState) {
        super(node.key, collapsibleState);

        let desc = node.value !== undefined && node.value !== '' ? String(node.value) : '';
        if (node.localeText) {
            desc += ' (' + node.localeText + ')';
        }
        this.description = desc || undefined;

        this.contextValue = node.children ? 'rgdTable' : 'rgdValue';
        this.tooltip = node.ref ? node.ref : undefined;

        if (!node.children && node.value !== undefined) {
            this.editable = true;
        }

        if (node.resolvedPath && node.resolvedExists) {
            this.command = {
                command: 'rgdEditor.openReferencedFile',
                title: 'Open Referenced File',
                arguments: [node.resolvedPath]
            };
            this.tooltip = 'Click to open: ' + node.resolvedPath;
            this.iconPath = new vscode.ThemeIcon('link');
        } else if (node.localeFile) {
            this.command = {
                command: 'rgdEditor.openReferencedFile',
                title: 'Open Locale Source',
                arguments: [node.localeFile, node.localeLine]
            };
            this.tooltip = 'Click to open UCS source: ' + path.basename(node.localeFile) + ' (line ' + node.localeLine + ')';
            this.iconPath = new vscode.ThemeIcon('info');
        } else if (typeof node.value === 'string' && (node.key.includes('icon_name') || node.key.includes('symbol_name'))) {
            this.command = {
                command: 'rgdEditor.openReferencedFile',
                title: 'Search Icon',
                arguments: [node.value, 0, true]
            };
            this.tooltip = 'Click to search for icon: ' + node.value;
            this.iconPath = new vscode.ThemeIcon('image');
        }
    }
}

export class RgdTreeProvider implements vscode.TreeDataProvider<RgdTreeItem> {
    private _onDidChangeTreeData = new vscode.EventEmitter<void>();
    readonly onDidChangeTreeData = this._onDidChangeTreeData.event;

    private nodes: RgdNode[] = [];
    private dict: HashDictionary | null = null;
    private sourceUri: vscode.Uri | null = null;
    private rgdData: any = null;
    private readonly _PARSE_CACHE_MAX = 30;
    private _parseCache = new Map<string, { mtime: number; rgdData: any; nodes: RgdNode[]; attribRoot: string | undefined }>();

    constructor(private readonly context: vscode.ExtensionContext) { }

    async loadFromDocument(doc: vscode.TextDocument) {
        if (!doc || doc.isClosed) return;

        let realPath: string | undefined;
        if (doc.uri.scheme === 'rgd') {
            realPath = doc.uri.path;
            realPath = decodeURIComponent(realPath);
            realPath = realPath.replace(/^\/([a-zA-Z]):/, '$1:');
            if (realPath.startsWith('/') && /^[a-zA-Z]:/.test(realPath.substring(1))) {
                realPath = realPath.substring(1);
            }
        } else if (doc.uri.scheme === 'file' && doc.uri.fsPath.toLowerCase().endsWith('.rgd')) {
            realPath = doc.uri.fsPath;
        }

        if (!realPath) return;
        await this.loadFromUri(vscode.Uri.file(realPath));
    }

    async loadFromUri(uri: vscode.Uri) {
        try {
            const mtime = fs.statSync(uri.fsPath).mtimeMs;
            const hit = this._parseCache.get(uri.fsPath);
            if (hit && hit.mtime === mtime) {
                this.rgdData = hit.rgdData;
                this.nodes = hit.nodes;
                this.sourceUri = uri;
                this._onDidChangeTreeData.fire();
                return;
            }
            const buffer = fs.readFileSync(uri.fsPath);
            const dict = DictionaryManager.getInstance().getDictionary(this.context);
            this.dict = dict;

            const rgd = parseRgd(buffer, dict);
            this.rgdData = rgd;

            let attribRoot: string | undefined;
            const searchRoots = new Set<string>();
            const workspaceFolders = vscode.workspace.workspaceFolders;
            if (workspaceFolders) {
                workspaceFolders.forEach(f => {
                    searchRoots.add(f.uri.fsPath);
                    searchRoots.add(path.dirname(f.uri.fsPath));
                });
            }

            let currentDir = path.dirname(uri.fsPath);
            let depth = 0;
            while (currentDir !== path.dirname(currentDir) && depth < 15) {
                searchRoots.add(currentDir);
                currentDir = path.dirname(currentDir);
                depth++;
            }

            for (const root of searchRoots) {
                const testPaths = [
                    path.join(root, 'data', 'attrib'),
                    path.join(root, 'attrib'),
                    path.join(root, 'Engine', 'data', 'attrib'),
                    path.join(root, 'W40K', 'data', 'attrib'),
                    root
                ];
                for (const tp of testPaths) {
                    if (fs.existsSync(tp) && fs.statSync(tp).isDirectory()) {
                        attribRoot = tp;
                        break;
                    }
                }
                if (attribRoot) break;
            }

            const localeMap = LocaleManager.getInstance().getLocaleMap(uri.fsPath);
            this.nodes = rgdToTree(rgd.gameData, attribRoot, localeMap);
            if (this._parseCache.size >= this._PARSE_CACHE_MAX) {
                this._parseCache.delete(this._parseCache.keys().next().value!);
            }
            this._parseCache.set(uri.fsPath, { mtime, rgdData: rgd, nodes: this.nodes, attribRoot });
            this.sourceUri = uri;
            this._onDidChangeTreeData.fire();
        } catch (err: any) {
            console.error('[RGD Suite TreeView] Error loading:', err.message);
        }
    }

    getTreeItem(element: RgdTreeItem): vscode.TreeItem {
        return element;
    }

    getChildren(element?: RgdTreeItem): vscode.ProviderResult<RgdTreeItem[]> {
        if (!this.nodes) return [];
        if (!element) {
            return this.nodes.map((n, idx) => this.toItem(n, [idx]));
        }
        if (!element.node.children) return [];
        return element.node.children.map((n, idx) => this.toItem(n, [...element.nodePath, idx]));
    }

    private toItem(node: RgdNode, nodePath: number[]): RgdTreeItem {
        return new RgdTreeItem(node, nodePath, node.children ? vscode.TreeItemCollapsibleState.Collapsed : vscode.TreeItemCollapsibleState.None);
    }

    revealInEditor(item: RgdTreeItem) {
        if (!this.sourceUri) return;
        vscode.workspace.openTextDocument(this.sourceUri).then((doc) => {
            vscode.window.showTextDocument(doc, { preview: false });
        });
    }

    async editValue(item: RgdTreeItem, newValue: string): Promise<boolean> {
        if (!this.sourceUri || !this.rgdData || !this.dict) return false;
        try {
            const parsedValue = this.parseValue(newValue, item.node.type);
            item.node.value = parsedValue;
            this.rgdData.gameData = treeToRgd(this.nodes);
            writeRgdFile(this.sourceUri.fsPath, this.rgdData.gameData, this.dict, this.rgdData.header.version);
            this._onDidChangeTreeData.fire();
            vscode.window.setStatusBarMessage('✓ Updated ' + item.node.key + ' = ' + newValue, 2000);
            return true;
        } catch (error: any) {
            vscode.window.showErrorMessage('Failed to update value: ' + error.message);
            return false;
        }
    }

    private parseValue(value: string, type: RgdDataType): any {
        switch (type) {
            case RgdDataType.Float:
                const floatVal = parseFloat(value);
                if (isNaN(floatVal)) throw new Error('Invalid float: ' + value);
                return floatVal;
            case RgdDataType.Integer:
                const intVal = parseInt(value, 10);
                if (isNaN(intVal)) throw new Error('Invalid integer: ' + value);
                return intVal;
            case RgdDataType.Bool:
                const lower = value.toLowerCase();
                if (lower === 'true' || lower === '1') return true;
                if (lower === 'false' || lower === '0') return false;
                throw new Error('Invalid boolean: ' + value);
            case RgdDataType.String:
            case RgdDataType.WString:
                return value;
            default:
                throw new Error('Cannot edit type: ' + dataTypeName(type));
        }
    }
}

export function registerRgdTreeView(context: vscode.ExtensionContext) {
    const provider = new RgdTreeProvider(context);
    const view = vscode.window.createTreeView('rgdTree', { treeDataProvider: provider });
    context.subscriptions.push(view);

    context.subscriptions.push(
        vscode.commands.registerCommand('rgdEditor.refreshTree', async () => {
            const doc = vscode.window.activeTextEditor?.document;
            if (doc) await provider.loadFromDocument(doc);
        })
    );

    context.subscriptions.push(
        vscode.commands.registerCommand('rgdEditor.loadTreeView', async (uri: vscode.Uri) => {
            if (uri) await provider.loadFromUri(uri);
        })
    );

    context.subscriptions.push(
        vscode.window.onDidChangeActiveTextEditor(async (ed) => {
            if (ed?.document) await provider.loadFromDocument(ed.document);
        })
    );

    context.subscriptions.push(
        vscode.commands.registerCommand('rgdEditor.revealNode', (item: RgdTreeItem) => {
            provider.revealInEditor(item);
        })
    );

    context.subscriptions.push(
        vscode.commands.registerCommand('rgdEditor.editValue', async (item: RgdTreeItem) => {
            if (!item.editable) return;
            const currentValue = String(item.node.value);
            const newValue = await vscode.window.showInputBox({
                prompt: 'Edit ' + item.node.key,
                value: currentValue,
                placeHolder: 'Enter new ' + dataTypeName(item.node.type) + ' value'
            });
            if (newValue !== undefined && newValue !== currentValue) {
                await provider.editValue(item, newValue);
            }
        })
    );

    if (vscode.window.activeTextEditor?.document) {
        provider.loadFromDocument(vscode.window.activeTextEditor.document);
    }
}
