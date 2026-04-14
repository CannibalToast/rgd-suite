import * as vscode from 'vscode';
import * as path from 'path';
import * as fs from 'fs';
import { parseRgd } from '../bundled/rgd-tools/dist/reader';
import { rgdToText, textToRgd } from '../bundled/rgd-tools/dist/textFormat';
import { buildRgd } from '../bundled/rgd-tools/dist/writer';
import { DictionaryManager } from './dictionaryManager';
import { HashDictionary } from '../bundled/rgd-tools/dist/types';
import { LocaleManager } from './localeManager';

export class RgdFileSystemProvider implements vscode.FileSystemProvider {
    private _emitter = new vscode.EventEmitter<vscode.FileChangeEvent[]>();
    readonly onDidChangeFile: vscode.Event<vscode.FileChangeEvent[]> = this._emitter.event;

    private readonly FILE_CACHE_MAX = 50;
    private fileCache = new Map<string, { version: number; mtime: number; text: string }>();

    constructor(private readonly context: vscode.ExtensionContext) {
        console.log('[RGD FS] Initialized');
    }

    private getDictionary(): HashDictionary {
        return DictionaryManager.getInstance().getDictionary(this.context);
    }

    toRealPath(uri: vscode.Uri): string {
        let p = uri.path;
        p = decodeURIComponent(p);
        p = p.replace(/^\/([a-zA-Z]):/, '$1:');
        if (p.startsWith('/') && /^[a-zA-Z]:/.test(p.substring(1))) {
            p = p.substring(1);
        }
        return p;
    }

    toRgdUri(filePath: string): vscode.Uri {
        const normalized = filePath.replace(/\\/g, '/');
        return vscode.Uri.parse(`rgd:///${normalized}`);
    }

    watch(): vscode.Disposable {
        return new vscode.Disposable(() => { });
    }

    stat(uri: vscode.Uri): vscode.FileStat {
        const realPath = this.toRealPath(uri);
        const stats = fs.statSync(realPath);
        return {
            type: vscode.FileType.File,
            ctime: stats.ctimeMs,
            mtime: stats.mtimeMs,
            size: stats.size,
        };
    }

    readDirectory(): [string, vscode.FileType][] { return []; }
    createDirectory(): void { }

    readFile(uri: vscode.Uri): Uint8Array {
        const realPath = this.toRealPath(uri);
        try {
            const currentMtime = fs.statSync(realPath).mtimeMs;
            const cached = this.fileCache.get(realPath);
            if (cached && cached.mtime === currentMtime) {
                return Buffer.from(cached.text, 'utf8');
            }
            const buffer = fs.readFileSync(realPath);
            const dict = DictionaryManager.getInstance().getDictionary(this.context);
            const rgdFile = parseRgd(buffer, dict);
            const localeMap = LocaleManager.getInstance().getLocaleMap(realPath);
            const text = rgdToText(rgdFile, path.basename(realPath), localeMap);
            if (this.fileCache.size >= this.FILE_CACHE_MAX) {
                this.fileCache.delete(this.fileCache.keys().next().value!);
            }
            this.fileCache.set(realPath, { version: rgdFile.header.version, mtime: currentMtime, text });
            return Buffer.from(text, 'utf8');
        } catch (error: any) {
            const errorText = `# Error reading RGD file: ${error.message}\n# File may be corrupted or not a valid RGD file.`;
            return Buffer.from(errorText, 'utf8');
        }
    }

    writeFile(uri: vscode.Uri, content: Uint8Array): void {
        const realPath = this.toRealPath(uri);
        const text = Buffer.from(content).toString('utf8');
        try {
            const dict = DictionaryManager.getInstance().getDictionary(this.context);
            const { gameData, version } = textToRgd(text, dict);
            const cached = this.fileCache.get(realPath);
            const finalVersion = cached?.version ?? version;
            const binaryBuffer = buildRgd(gameData, dict, finalVersion);
            fs.writeFileSync(realPath, binaryBuffer);
            this.fileCache.set(realPath, { version: finalVersion, mtime: Date.now() });
            this._emitter.fire([{ type: vscode.FileChangeType.Changed, uri }]);
            vscode.window.setStatusBarMessage(`✓ Saved ${path.basename(realPath)}`, 2000);
        } catch (error: any) {
            vscode.window.showErrorMessage(`Failed to save RGD: ${error.message}`);
            throw error;
        }
    }

    delete(uri: vscode.Uri): void {
        const realPath = this.toRealPath(uri);
        fs.unlinkSync(realPath);
        this.fileCache.delete(realPath);
    }

    rename(oldUri: vscode.Uri, newUri: vscode.Uri): void {
        fs.renameSync(this.toRealPath(oldUri), this.toRealPath(newUri));
    }
}

export function registerRgdFileSystem(context: vscode.ExtensionContext): RgdFileSystemProvider {
    const provider = new RgdFileSystemProvider(context);
    context.subscriptions.push(
        vscode.workspace.registerFileSystemProvider('rgd', provider, {
            isCaseSensitive: false,
            isReadonly: false
        })
    );
    return provider;
}
