import * as vscode from 'vscode';
import * as path from 'path';
import * as fs from 'fs';
import { createAndLoadDictionaries, HashDictionary } from '../bundled/rgd-tools/dist/dictionary';
import { hexToHash } from '../bundled/rgd-tools/dist/hash';

export class DictionaryManager {
    private static instance: DictionaryManager;
    private dictionary: HashDictionary | null = null;
    private outputChannel: vscode.OutputChannel | null = null;

    private constructor() { }

    public static getInstance(): DictionaryManager {
        if (!DictionaryManager.instance) {
            DictionaryManager.instance = new DictionaryManager();
        }
        return DictionaryManager.instance;
    }

    private log(message: string) {
        if (!this.outputChannel) {
            this.outputChannel = vscode.window.createOutputChannel('RGD Dictionary');
        }
        this.outputChannel.appendLine(`[${new Date().toLocaleTimeString()}] ${message}`);
    }

    public getDictionary(context: vscode.ExtensionContext): HashDictionary {
        if (!this.dictionary) {
            this.log('Initializing dictionary...');
            const config = vscode.workspace.getConfiguration('rgdEditor');
            const userPaths = config.get<string[]>('dictionaryPaths') || [];

            const bundledDictUri = vscode.Uri.joinPath(context.extensionUri, 'dictionaries', 'RGD_DIC.TXT');
            const bundledDict = bundledDictUri.fsPath;
            this.log(`Bundled dictionary path: ${bundledDict}`);

            const allPaths: string[] = [];
            if (fs.existsSync(bundledDict)) {
                allPaths.push(bundledDict);
                this.log('Found bundled dictionary');
            } else {
                this.log(`CRITICAL: Bundled RGD_DIC.TXT NOT FOUND at: ${bundledDict}`);
                const fallbackPath = path.join(context.extensionPath, 'dictionaries', 'RGD_DIC.TXT');
                if (fs.existsSync(fallbackPath)) {
                    allPaths.push(fallbackPath);
                    this.log(`Found dictionary via fallback: ${fallbackPath}`);
                }
            }

            for (const p of userPaths) {
                if (p && fs.existsSync(p)) {
                    allPaths.push(p);
                    this.log(`Added user dictionary: ${p}`);
                }
            }

            this.dictionary = createAndLoadDictionaries(allPaths);
            this.log(`Dictionary initialized: ${this.dictionary.hashToName.size} entries`);
            if (this.dictionary.hashToName.size < 10000) {
                this.log('WARNING: Dictionary seems smaller than expected.');
            }
        }
        return this.dictionary;
    }

    public refresh(context: vscode.ExtensionContext): HashDictionary {
        this.log('Refreshing dictionary...');
        this.dictionary = null;
        return this.getDictionary(context);
    }

    public hashToName(hash: string): string | undefined {
        if (!this.dictionary) return undefined;
        let hashNum: number;
        if (hash.startsWith('0x')) {
            hashNum = hexToHash(hash);
        } else {
            hashNum = parseInt(hash, 10);
        }
        return this.dictionary.hashToName.get(hashNum);
    }
}
