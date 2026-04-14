import * as vscode from 'vscode';
import * as path from 'path';
import * as fs from 'fs';
import { parseRgd } from '../bundled/rgd-tools/dist/reader';
import { rgdToLuaDifferential, luaToRgdResolved } from '../bundled/rgd-tools/dist/luaFormat';
import { findAttribBase, makeLuaParentLoader, makeRgdParentLoader, countEntries } from './attribUtils';
import { writeRgdFile } from '../bundled/rgd-tools/dist/writer';
import { DictionaryManager } from './dictionaryManager';

function getAttribPath(filePath: string): string {
    const cfg = vscode.workspace.getConfiguration();
    const configured = cfg.get<string>('rgdSuite.attribPath');
    if (configured && configured.trim().length > 0) {
        return path.isAbsolute(configured) ? configured : path.join(filePath, configured);
    }
    const root = vscode.workspace.workspaceFolders?.[0]?.uri.fsPath || path.dirname(filePath);
    return path.join(root, 'data', 'attrib');
}

export function registerCliCommands(context: vscode.ExtensionContext) {
    const dict = () => DictionaryManager.getInstance().getDictionary(context);

    // rgd.fromLua — compile Lua to RGD using native library
    context.subscriptions.push(vscode.commands.registerCommand('rgd.fromLua', async (uri?: vscode.Uri) => {
        try {
            const file = uri?.fsPath || vscode.window.activeTextEditor?.document.uri.fsPath;
            if (!file) { vscode.window.showErrorMessage('No Lua file selected'); return; }

            const luaCode = fs.readFileSync(file, 'utf8');
            const d = dict();
            const attribBase = findAttribBase(file) ?? getAttribPath(file);
            const rgdParentLoader = makeRgdParentLoader(attribBase, d);
            const { gameData, version } = await luaToRgdResolved(luaCode, d, rgdParentLoader);
            const out = file.replace(/\.lua$/i, '.rgd');
            if (fs.existsSync(out)) {
                const choice = await vscode.window.showWarningMessage(
                    `${path.basename(out)} already exists. Overwrite?`, 'Yes', 'No');
                if (choice !== 'Yes') return;
            }
            writeRgdFile(out, gameData, d, version);
            vscode.window.showInformationMessage(`RGD generated: ${path.basename(out)}`);
        } catch (e: any) {
            vscode.window.showErrorMessage(`from-lua failed: ${e.message}`);
        }
    }));

    // rgd.toLua — dump RGD to Lua using native library
    context.subscriptions.push(vscode.commands.registerCommand('rgd.toLua', async (uri?: vscode.Uri) => {
        try {
            const file = uri?.fsPath || vscode.window.activeTextEditor?.document.uri.fsPath;
            if (!file) { vscode.window.showErrorMessage('No RGD file selected'); return; }

            const d = dict();
            const attribBase = findAttribBase(file);
            const rgd = parseRgd(fs.readFileSync(file), d);
            const parentLoader = makeLuaParentLoader(attribBase, d);
            const luaCode = await rgdToLuaDifferential(rgd, parentLoader);
            const out = file.replace(/\.rgd$/i, '.lua');
            fs.writeFileSync(out, luaCode, 'utf8');
            const doc = await vscode.workspace.openTextDocument(out);
            await vscode.window.showTextDocument(doc);
            vscode.window.showInformationMessage(`Lua generated: ${path.basename(out)}`);
        } catch (e: any) {
            vscode.window.showErrorMessage(`to-lua failed: ${e.message}`);
        }
    }));

    // rgd.info — show RGD info using native library
    context.subscriptions.push(vscode.commands.registerCommand('rgd.info', async (uri?: vscode.Uri) => {
        try {
            const file = uri?.fsPath || vscode.window.activeTextEditor?.document.uri.fsPath;
            if (!file) { vscode.window.showErrorMessage('No RGD file selected'); return; }

            const d = dict();
            const buffer = fs.readFileSync(file);
            const rgd = parseRgd(buffer, d);
            const { totalEntries, tableCount } = countEntries(rgd.gameData.entries);

            const info = [
                `File: ${path.basename(file)}`,
                `Size: ${buffer.length} bytes`,
                `Version: ${rgd.header.version}`,
                `Chunks: ${rgd.chunks.length}`,
                `Total Entries: ${totalEntries}`,
                `Tables: ${tableCount}`
            ];
            if (rgd.gameData.reference) info.push(`Reference: ${rgd.gameData.reference}`);

            vscode.window.showInformationMessage(info.join(' | '));
        } catch (e: any) {
            vscode.window.showErrorMessage(`info failed: ${e.message}`);
        }
    }));

    // rgd.validate — validate RGD file using native library
    context.subscriptions.push(vscode.commands.registerCommand('rgd.validate', async (uri?: vscode.Uri) => {
        try {
            const file = uri?.fsPath || vscode.window.activeTextEditor?.document.uri.fsPath;
            if (!file) { vscode.window.showErrorMessage('No RGD file selected'); return; }

            const d = dict();
            parseRgd(fs.readFileSync(file), d);
            vscode.window.showInformationMessage(`✓ Valid RGD file: ${path.basename(file)}`);
        } catch (e: any) {
            vscode.window.showErrorMessage(`Validation failed: ${e.message}`);
        }
    }));
}
