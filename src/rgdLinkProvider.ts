import * as vscode from 'vscode';
import * as path from 'path';
import { unescapeString } from '../bundled/rgd-tools/dist/textFormat';
import { LocaleManager } from './localeManager';
import { localeGet } from './localeLoader';

// Single combined regex with named alternatives — one pass over the document
// body instead of three separate regexes (Tier 3 #19). The alternation is:
//   1. "…path.{lua|rgd|tga|dds|nil}"
//   2. "$<digits>"   (locale refs)
//   3. (icon|symbol|ui|texture)_name : string = "…"
const COMBINED_RE = new RegExp(
    '"([^"]+\\.(?:lua|rgd|tga|dds|nil))"' +               // group 1: pathish
    '|"\\$(\\d+)"' +                                      // group 2: locale id
    '|(icon_name|symbol_name|ui_name|texture_name)\\s*:\\s*string\\s*=\\s*"([^"]+)"', // groups 3+4: icon kind + value
    'g'
);

interface CachedLinks {
    version: number;
    links: vscode.DocumentLink[];
}

const _linkCache = new WeakMap<vscode.TextDocument, CachedLinks>();

export class RgdDocumentLinkProvider implements vscode.DocumentLinkProvider {
    provideDocumentLinks(
        document: vscode.TextDocument,
        _token: vscode.CancellationToken
    ): vscode.DocumentLink[] {
        const cached = _linkCache.get(document);
        if (cached && cached.version === document.version) {
            return cached.links;
        }

        const links: vscode.DocumentLink[] = [];
        const text = document.getText();
        const localeMap = LocaleManager.getInstance().getLocaleMap(document.uri.fsPath);

        const re = new RegExp(COMBINED_RE.source, COMBINED_RE.flags);
        let match: RegExpExecArray | null;
        while ((match = re.exec(text)) !== null) {
            if (match[1] !== undefined) {
                // Path link
                const raw = match[1];
                let filePath = unescapeString(raw).replace(/\\/g, '/');
                if (filePath.startsWith('/')) filePath = filePath.substring(1);
                filePath = filePath.replace(/\/+/g, '/');
                const start = document.positionAt(match.index + 1);
                const end = document.positionAt(match.index + 1 + raw.length);
                const uri = vscode.Uri.parse(
                    `command:rgdEditor.openReferencedFile?${encodeURIComponent(JSON.stringify([filePath]))}`
                );
                const link = new vscode.DocumentLink(new vscode.Range(start, end), uri);
                link.tooltip = `Follow link to ${filePath}`;
                links.push(link);
            } else if (match[2] !== undefined) {
                // Locale id
                const id = match[2];
                const fullId = `$${id}`;
                const entry = localeGet(localeMap, id);
                if (!entry) continue;
                const start = document.positionAt(match.index + 1);
                const end = document.positionAt(match.index + 1 + fullId.length);
                const uri = vscode.Uri.parse(
                    `command:rgdEditor.openReferencedFile?${encodeURIComponent(JSON.stringify([entry.file, entry.line]))}`
                );
                const link = new vscode.DocumentLink(new vscode.Range(start, end), uri);
                link.tooltip = `Follow link to UCS: ${path.basename(entry.file)} (line ${entry.line})`;
                links.push(link);
            } else if (match[4] !== undefined) {
                // Icon-style link
                const iconPath = unescapeString(match[4]);
                const valueStart = match.index + match[0].indexOf(match[4]);
                const start = document.positionAt(valueStart);
                const end = document.positionAt(valueStart + match[4].length);
                const uri = vscode.Uri.parse(
                    `command:rgdEditor.openReferencedFile?${encodeURIComponent(JSON.stringify([iconPath, 0, true]))}`
                );
                const link = new vscode.DocumentLink(new vscode.Range(start, end), uri);
                link.tooltip = `Search for icon: ${iconPath}`;
                links.push(link);
            }
        }

        _linkCache.set(document, { version: document.version, links });
        return links;
    }
}

export function registerRgdLinkProvider(context: vscode.ExtensionContext) {
    const provider = new RgdDocumentLinkProvider();
    context.subscriptions.push(
        vscode.languages.registerDocumentLinkProvider({ language: 'rgd-text' }, provider)
    );
}
