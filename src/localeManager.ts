import * as vscode from 'vscode';
import * as path from 'path';
import * as fs from 'fs';
import { loadLocaleMap } from './localeLoader';
import { LocaleEntry } from '../bundled/rgd-tools/dist/types';

export class LocaleManager {
    private static instance: LocaleManager;
    private localeMap: Map<string, LocaleEntry> = new Map();
    private outputChannel: vscode.OutputChannel | null = null;
    private lastSearchedDir: string | null = null;

    private constructor() { }

    public static getInstance(): LocaleManager {
        if (!LocaleManager.instance) {
            LocaleManager.instance = new LocaleManager();
        }
        return LocaleManager.instance;
    }

    private log(message: string) {
        if (!this.outputChannel) {
            this.outputChannel = vscode.window.createOutputChannel('RGD Locale');
        }
        this.outputChannel.appendLine(`[${new Date().toLocaleTimeString()}] ${message}`);
    }

    public getLocaleMap(currentFilePath?: string): Map<string, LocaleEntry> {
        if (currentFilePath) {
            const currentDir = path.dirname(currentFilePath);
            if (this.lastSearchedDir && currentDir.startsWith(this.lastSearchedDir)) {
                return this.localeMap;
            }
            this.refresh(currentFilePath);
        }
        return this.localeMap;
    }

    public refresh(contextFilePath?: string) {
        this.log(`Refreshing locale map for context: ${contextFilePath || 'none'}`);
        this.localeMap.clear();

        const engineRoots = new Set<string>();
        const workspaceRoots = new Set<string>();
        const parentRoots = new Set<string>();

        const workspaceFolders = vscode.workspace.workspaceFolders;
        if (workspaceFolders) {
            workspaceFolders.forEach(f => {
                const wsPath = f.uri.fsPath;
                workspaceRoots.add(wsPath);
                const parent = path.dirname(wsPath);
                if (fs.existsSync(path.join(parent, 'Engine'))) {
                    engineRoots.add(parent);
                }
            });
        }

        if (contextFilePath) {
            let dir = path.dirname(contextFilePath);
            let depth = 0;
            while (dir !== path.dirname(dir) && depth < 20) {
                if (fs.existsSync(path.join(dir, 'data')) || fs.existsSync(path.join(dir, 'attrib')) || fs.existsSync(path.join(dir, 'Locale'))) {
                    parentRoots.add(dir);
                    this.lastSearchedDir = dir;
                }
                if (fs.existsSync(path.join(dir, 'Engine')) || fs.existsSync(path.join(dir, 'W40K'))) {
                    engineRoots.add(dir);
                }
                dir = path.dirname(dir);
                depth++;
            }
        }

        const prioritizedRoots = [
            ...Array.from(engineRoots),
            ...Array.from(parentRoots),
            ...Array.from(workspaceRoots)
        ];

        const config = vscode.workspace.getConfiguration('rgdEditor');
        const preferredLang = config.get<string>('preferredLanguage', 'Chinese');
        this.log(`Preferred language: ${preferredLang}`);

        const allLanguages = ['English', 'english', 'ENGLISH', 'French', 'German', 'Spanish', 'Italian', 'Russian', 'Polish', 'Korean', 'Japanese', 'Chinese', 'SChinese', 'schinese', 'CHINESE'];

        const preferredVariants = [preferredLang];
        if (preferredLang.toLowerCase() === 'chinese') {
            preferredVariants.push('SChinese', 'schinese', 'CHINESE');
        } else if (preferredLang.toLowerCase() === 'schinese') {
            preferredVariants.push('Chinese', 'chinese', 'CHINESE');
        }

        const loadingOrder = allLanguages.filter(l => !preferredVariants.some(v => v.toLowerCase() === l.toLowerCase()));
        loadingOrder.push(...preferredVariants);

        const checkedPaths = new Set<string>();
        for (const root of prioritizedRoots) {
            const potentialLocalePaths = [
                path.join(root, 'Engine', 'Locale'),
                path.join(root, 'W40K', 'Locale'),
                path.join(root, 'DXP2', 'Locale'),
                path.join(root, 'Locale'),
                path.join(root, 'locale'),
                path.join(root, 'data', 'Locale')
            ];

            for (const lp of potentialLocalePaths) {
                if (checkedPaths.has(lp)) continue;
                checkedPaths.add(lp);

                if (fs.existsSync(lp)) {
                    this.log(`  [MATCH] Found locale folder: ${lp}`);

                    for (const lang of loadingOrder) {
                        const fullPath = path.join(lp, lang);
                        if (fs.existsSync(fullPath)) {
                            const map = loadLocaleMap(fullPath);
                            if (map.size > 0) {
                                for (const [k, v] of map) {
                                    const isPreferred = preferredVariants.some(v_opt => v_opt.toLowerCase() === lang.toLowerCase());
                                    if (isPreferred || !this.localeMap.has(k) || (v.text && v.text.length > 0)) {
                                        this.localeMap.set(k, v);
                                    }
                                }
                            }
                        }
                    }

                    const rootMap = loadLocaleMap(lp);
                    if (rootMap.size > 0) {
                        for (const [k, v] of rootMap) {
                            if (!this.localeMap.has(k) || (v.text && v.text.length > 0)) {
                                this.localeMap.set(k, v);
                            }
                        }
                    }
                }
            }
        }

        this.log(`Locale map final size: ${this.localeMap.size} entries`);
    }

    public async setManualLocaleFolder() {
        const uris = await vscode.window.showOpenDialog({
            canSelectFiles: false,
            canSelectFolders: true,
            canSelectMany: false,
            openLabel: 'Select Locale Folder'
        });

        if (uris && uris.length > 0) {
            const folder = uris[0].fsPath;
            this.log(`Manually setting locale folder: ${folder}`);
            const map = loadLocaleMap(folder);
            if (map.size > 0) {
                for (const [k, v] of map) this.localeMap.set(k, v);
                vscode.window.showInformationMessage(`Loaded ${map.size} locale entries from manual folder.`);
            } else {
                vscode.window.showWarningMessage(`No .ucs or .dat files found in the selected folder.`);
            }
        }
    }
}
