import * as vscode from 'vscode';
import * as path from 'path';
import { unescapeString } from '../bundled/rgd-tools/dist/textFormat';
import { LocaleManager } from './localeManager';
import { LocaleEntry } from '../bundled/rgd-tools/dist/types';

export class RgdDocumentLinkProvider implements vscode.DocumentLinkProvider {
    provideDocumentLinks(
        document: vscode.TextDocument,
        token: vscode.CancellationToken
    ): vscode.DocumentLink[] {
        const links: vscode.DocumentLink[] = [];
        const text = document.getText();

        const pathRegex = /"([^"]+\.(?:lua|rgd|tga|dds|nil))"/g;
        let match;

        while ((match = pathRegex.exec(text)) !== null) {
            let rawPath = match[1];
            let filePath = unescapeString(rawPath).replace(/\\/g, '/');
            if (filePath.startsWith('/')) filePath = filePath.substring(1);
            filePath = filePath.replace(/\/+/g, '/');

            const startPos = document.positionAt(match.index + 1);
            const endPos = document.positionAt(match.index + 1 + rawPath.length);
            const range = new vscode.Range(startPos, endPos);

            const uri = vscode.Uri.parse(`command:rgdEditor.openReferencedFile?${encodeURIComponent(JSON.stringify([filePath]))}`);
            const link = new vscode.DocumentLink(range, uri);
            link.tooltip = `Follow link to ${filePath}`;
            links.push(link);
        }

        const localeRegex = /"\$(\d+)"/g;
        const localeMap = LocaleManager.getInstance().getLocaleMap(document.uri.fsPath);

        while ((match = localeRegex.exec(text)) !== null) {
            const id = match[1];
            const fullId = `$${id}`;
            const entry = localeMap.get(fullId);

            if (entry) {
                const startPos = document.positionAt(match.index + 1);
                const endPos = document.positionAt(match.index + 1 + fullId.length);
                const range = new vscode.Range(startPos, endPos);

                const uri = vscode.Uri.parse(`command:rgdEditor.openReferencedFile?${encodeURIComponent(JSON.stringify([entry.file, entry.line]))}`);
                const link = new vscode.DocumentLink(range, uri);
                link.tooltip = `Follow link to UCS: ${path.basename(entry.file)} (line ${entry.line})`;
                links.push(link);
            }
        }

        const iconRegex = /(?:icon_name|symbol_name|ui_name|texture_name)\s*:\s*string\s*=\s*"([^"]+)"/g;
        while ((match = iconRegex.exec(text)) !== null) {
            const iconPath = unescapeString(match[1]);
            const startPos = document.positionAt(match.index + match[0].indexOf(match[1]));
            const endPos = document.positionAt(match.index + match[0].indexOf(match[1]) + match[1].length);
            const range = new vscode.Range(startPos, endPos);

            const uri = vscode.Uri.parse(`command:rgdEditor.openReferencedFile?${encodeURIComponent(JSON.stringify([iconPath, 0, true]))}`);
            const link = new vscode.DocumentLink(range, uri);
            link.tooltip = `Search for icon: ${iconPath}`;
            links.push(link);
        }

        return links;
    }
}

export function registerRgdLinkProvider(context: vscode.ExtensionContext) {
    const provider = new RgdDocumentLinkProvider();
    context.subscriptions.push(
        vscode.languages.registerDocumentLinkProvider({ language: 'rgd-text' }, provider)
    );
}
