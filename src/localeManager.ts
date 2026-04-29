import * as vscode from 'vscode';
import * as path from 'path';
import * as fs from 'fs';
import { loadLocaleMap } from './localeLoader';
import { LocaleEntry } from '../bundled/rgd-tools/dist/types';

const ALL_LANGUAGES = [
    'English', 'english', 'ENGLISH',
    'French', 'German', 'Spanish', 'Italian', 'Russian', 'Polish', 'Korean', 'Japanese',
    'Chinese', 'SChinese', 'schinese', 'CHINESE',
];

const LOCALE_SUBDIRS = [
    ['Engine', 'Locale'],
    ['W40K', 'Locale'],
    ['DXP2', 'Locale'],
    ['Locale'],
    ['locale'],
    ['data', 'Locale'],
];

interface CachedRoot {
    root: string;
    map: Map<string, LocaleEntry>;
}

export class LocaleManager {
    private static instance: LocaleManager;

    // Cache keyed on the detected game/mod root so switching between sibling
    // files in the same project doesn't wipe and rebuild the whole map.
    private rootCache = new Map<string, CachedRoot>();
    private manualOverlay: Map<string, LocaleEntry> | null = null;
    private outputChannel: vscode.OutputChannel | null = null;

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
        const detectedRoot = currentFilePath ? this.detectRoot(currentFilePath) : null;
        const cacheKey = detectedRoot ?? '__workspace__';

        let cached = this.rootCache.get(cacheKey);
        if (!cached) {
            const map = this.buildMap(currentFilePath, detectedRoot);
            cached = { root: cacheKey, map };
            this.rootCache.set(cacheKey, cached);
        }

        if (!this.manualOverlay) return cached.map;

        // Merge manual overlay on top. Overlay additions are few; allocate a
        // fresh result Map so we don't mutate the cached one.
        const merged = new Map(cached.map);
        for (const [k, v] of this.manualOverlay) merged.set(k, v);
        return merged;
    }

    /**
     * Walk up from the given file looking for a folder that holds `data/`,
     * `attrib/`, `Locale/`, `Engine/`, or `W40K/`. That folder is the detected
     * root and becomes the cache key.
     */
    private detectRoot(filePath: string): string | null {
        let dir = path.dirname(filePath);
        let depth = 0;
        while (dir !== path.dirname(dir) && depth < 20) {
            if (
                fs.existsSync(path.join(dir, 'data')) ||
                fs.existsSync(path.join(dir, 'attrib')) ||
                fs.existsSync(path.join(dir, 'Locale')) ||
                fs.existsSync(path.join(dir, 'Engine')) ||
                fs.existsSync(path.join(dir, 'W40K'))
            ) {
                return dir;
            }
            dir = path.dirname(dir);
            depth++;
        }
        return null;
    }

    private buildMap(contextFilePath: string | undefined, detectedRoot: string | null): Map<string, LocaleEntry> {
        this.log(`Building locale map for root: ${detectedRoot || '(workspace)'}`);
        const result = new Map<string, LocaleEntry>();

        const engineRoots = new Set<string>();
        const workspaceRoots = new Set<string>();
        const parentRoots = new Set<string>();

        const workspaceFolders = vscode.workspace.workspaceFolders;
        if (workspaceFolders) {
            for (const f of workspaceFolders) {
                const wsPath = f.uri.fsPath;
                workspaceRoots.add(wsPath);
                const parent = path.dirname(wsPath);
                if (fs.existsSync(path.join(parent, 'Engine'))) {
                    engineRoots.add(parent);
                }
            }
        }

        if (detectedRoot) parentRoots.add(detectedRoot);
        if (contextFilePath) {
            let dir = path.dirname(contextFilePath);
            let depth = 0;
            while (dir !== path.dirname(dir) && depth < 20) {
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
            ...Array.from(workspaceRoots),
        ];

        const config = vscode.workspace.getConfiguration('rgdEditor');
        const preferredLang = config.get<string>('preferredLanguage', 'Chinese');

        const preferredVariants = new Set<string>([preferredLang.toLowerCase()]);
        if (preferredLang.toLowerCase() === 'chinese') {
            preferredVariants.add('schinese');
        } else if (preferredLang.toLowerCase() === 'schinese') {
            preferredVariants.add('chinese');
        }

        // Non-preferred languages load first, preferred last so they "win" the
        // merge. This matches the previous behaviour.
        const nonPreferred = ALL_LANGUAGES.filter(l => !preferredVariants.has(l.toLowerCase()));
        const preferred = ALL_LANGUAGES.filter(l => preferredVariants.has(l.toLowerCase()));
        const loadingOrder = [...nonPreferred, ...preferred];

        const checkedPaths = new Set<string>();
        for (const root of prioritizedRoots) {
            for (const parts of LOCALE_SUBDIRS) {
                const lp = path.join(root, ...parts);
                if (checkedPaths.has(lp)) continue;
                checkedPaths.add(lp);
                if (!fs.existsSync(lp)) continue;

                this.log(`  Found locale folder: ${lp}`);

                for (const lang of loadingOrder) {
                    const fullPath = path.join(lp, lang);
                    if (!fs.existsSync(fullPath)) continue;
                    const map = loadLocaleMap(fullPath);
                    if (map.size === 0) continue;

                    // Precompute once per language whether it should force-win
                    // over existing entries (the preferred language overlay).
                    const isPreferred = preferredVariants.has(lang.toLowerCase());
                    this.mergeInto(result, map, isPreferred);
                }

                const rootMap = loadLocaleMap(lp);
                if (rootMap.size > 0) {
                    this.mergeInto(result, rootMap, false);
                }
            }
        }

        this.log(`  Locale map size: ${result.size} entries`);
        return result;
    }

    private mergeInto(
        target: Map<string, LocaleEntry>,
        src: Map<string, LocaleEntry>,
        preferred: boolean,
    ): void {
        if (preferred) {
            for (const [k, v] of src) target.set(k, v);
            return;
        }
        for (const [k, v] of src) {
            if (!target.has(k) || (v.text && v.text.length > 0)) {
                target.set(k, v);
            }
        }
    }

    /**
     * Clear the cached maps. Use when the user changes locale config or
     * explicitly refreshes the tree view.
     */
    public refresh(_contextFilePath?: string) {
        this.rootCache.clear();
    }

    public async setManualLocaleFolder() {
        const uris = await vscode.window.showOpenDialog({
            canSelectFiles: false,
            canSelectFolders: true,
            canSelectMany: false,
            openLabel: 'Select Locale Folder',
        });

        if (!uris || uris.length === 0) return;
        const folder = uris[0].fsPath;
        this.log(`Manually setting locale folder: ${folder}`);
        const map = loadLocaleMap(folder);
        if (map.size > 0) {
            this.manualOverlay = map;
            vscode.window.showInformationMessage(`Loaded ${map.size} locale entries from manual folder.`);
        } else {
            vscode.window.showWarningMessage(`No .ucs or .dat files found in the selected folder.`);
        }
    }
}
