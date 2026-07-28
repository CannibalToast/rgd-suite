import * as vscode from "vscode";
import * as path from "path";
import * as fs from "fs";
import { treeToRgd, RgdNode } from "./rgdTable";
import { writeRgdFile } from "../bundled/rgd-tools/dist/writer";
import { DictionaryManager } from "./dictionaryManager";
import { findAttribBase } from "./attribUtils";
import { getErrorMessage } from "./errorUtils";
import {
  getTreeNodes,
  invalidateParsedRgdCache,
} from "./parsedRgdCache";
import {
  buildDiffHighlightMap,
  diffRgdAgainstGit,
  TableDiffResult,
} from "./tableDiff";

function shallowTreePayload(nodes: RgdNode[]): Record<string, unknown>[] {
  return nodes.map((n) => ({
    key: n.key,
    hash: n.hash,
    type: n.type,
    value: n.value,
    ref: n.ref,
    resolvedPath: n.resolvedPath,
    resolvedExists: n.resolvedExists,
    localeId: n.localeId,
    localeText: n.localeText,
    localeFile: n.localeFile,
    localeLine: n.localeLine,
    hasChildren: !!(n.children && n.children.length > 0),
    childCount: n.children?.length ?? 0,
  }));
}

function nodeAtPath(nodes: RgdNode[], nodePath: number[]): RgdNode | undefined {
  let list = nodes;
  let current: RgdNode | undefined;
  for (const idx of nodePath) {
    current = list[idx];
    if (!current) return undefined;
    if (current.children) list = current.children;
  }
  return current;
}

interface WebviewMessage {
  type: string;
  [key: string]: any;
}

class RgdDocument implements vscode.CustomDocument {
  public isDirty: boolean = false;
  public rgdVersion: number = 1;

  constructor(
    public readonly uri: vscode.Uri,
    public nodes: RgdNode[] = [],
  ) {}

  dispose(): void {}
}

export class RgdEditorProvider implements vscode.CustomReadonlyEditorProvider<RgdDocument> {
  public static readonly viewType = "rgdEditor.rgdEditor";

  constructor(
    private readonly _extensionUri: vscode.Uri,
    private readonly context: vscode.ExtensionContext,
    private readonly dictionaryManager: DictionaryManager,
  ) {}

  async openCustomDocument(
    uri: vscode.Uri,
    _openContext: vscode.CustomDocumentOpenContext,
    _token: vscode.CancellationToken,
  ): Promise<RgdDocument> {
    return new RgdDocument(uri);
  }

  async resolveCustomEditor(
    document: RgdDocument,
    webviewPanel: vscode.WebviewPanel,
    _token: vscode.CancellationToken,
  ): Promise<void> {
    webviewPanel.webview.options = {
      enableScripts: true,
      localResourceRoots: [this._extensionUri],
    };

    try {
      const dict = this.dictionaryManager.getDictionary(this.context);
      const { nodes, rgd } = await getTreeNodes(document.uri.fsPath, dict, {
        resolvePaths: false,
      });
      const attribRoot = findAttribBase(document.uri.fsPath) ?? undefined;

      document.rgdVersion = rgd.header.version;
      document.nodes = nodes;

      webviewPanel.webview.html = this._getHtml(
        webviewPanel.webview,
        document.uri.fsPath,
        document.nodes,
      );

      webviewPanel.webview.onDidReceiveMessage(
        async (message: WebviewMessage) => {
          switch (message.type) {
            case "ready":
              webviewPanel.webview.postMessage({
                type: "loadData",
                data: shallowTreePayload(document.nodes),
              });
              break;

            case "requestChildren": {
              const nodePath = message.path;
              if (
                !Array.isArray(nodePath) ||
                !nodePath.every((n: unknown) => typeof n === "number")
              ) {
                break;
              }
              const parent = nodeAtPath(document.nodes, nodePath as number[]);
              webviewPanel.webview.postMessage({
                type: "loadChildren",
                path: nodePath,
                children: shallowTreePayload(parent?.children ?? []),
              });
              break;
            }

            case "openRef":
              if (message.ref) {
                const refPath = message.ref.replace(/\\/g, "/");
                const hasExtension = /\.(lua|rgd|scar|ai)$/i.test(refPath);
                const extensions = hasExtension ? [""] : [".rgd", ".lua"];
                let targetPath = "";
                // Prefer the memoized attribRoot detected at open time —
                // avoids walking the directory tree on every click.
                const base = attribRoot ?? findAttribBase(document.uri.fsPath);
                if (base) {
                  for (const ext of extensions) {
                    const testPath = path.join(base, refPath + ext);
                    if (fs.existsSync(testPath)) {
                      targetPath = testPath;
                      break;
                    }
                  }
                }
                if (targetPath) {
                  vscode.commands.executeCommand(
                    "vscode.open",
                    vscode.Uri.file(targetPath),
                  );
                } else {
                  vscode.window.showWarningMessage(
                    `Referenced file not found: ${refPath}`,
                  );
                }
              }
              break;

            case "updateValue":
              if (
                Array.isArray(message.path) &&
                message.path.every((n: unknown) => typeof n === "number") &&
                message.value !== undefined
              ) {
                this._updateNodeValue(
                  document.nodes,
                  message.path as number[],
                  typeof message.key === "string" ? message.key : null,
                  message.value,
                );
                document.isDirty = true;
              }
              break;

            case "save":
              try {
                await this._saveRgd(document);
                invalidateParsedRgdCache(document.uri.fsPath);
                const reloadDict = this.dictionaryManager.getDictionary(
                  this.context,
                );
                const reloaded = await getTreeNodes(
                  document.uri.fsPath,
                  reloadDict,
                  { resolvePaths: false },
                );
                document.nodes = reloaded.nodes;
                document.rgdVersion = reloaded.rgd.header.version;
                document.isDirty = false;
                webviewPanel.webview.postMessage({ type: "saved" });
                webviewPanel.webview.postMessage({
                  type: "loadData",
                  data: shallowTreePayload(document.nodes),
                });
                vscode.window.showInformationMessage("RGD saved and reloaded");
              } catch (saveError) {
                vscode.window.showErrorMessage(
                  `Failed to save RGD: ${getErrorMessage(saveError)}`,
                );
              }
              break;

            case "requestGitDiff": {
              const ref =
                typeof message.ref === "string" && message.ref.trim()
                  ? message.ref.trim()
                  : "HEAD";
              await this._runGitDiff(
                document,
                webviewPanel,
                ref,
              );
              break;
            }
          }
        },
      );
    } catch (error) {
      webviewPanel.webview.html = this._getErrorHtml(
        document.uri.fsPath,
        getErrorMessage(error),
      );
    }
  }

  private _escapeHtml(text: string): string {
    return String(text)
      .replace(/&/g, "&amp;")
      .replace(/</g, "&lt;")
      .replace(/>/g, "&gt;")
      .replace(/"/g, "&quot;");
  }

  private _getNonce(): string {
    const chars =
      "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789";
    let nonce = "";
    for (let i = 0; i < 32; i++) {
      nonce += chars.charAt(Math.floor(Math.random() * chars.length));
    }
    return nonce;
  }

  private _getErrorHtml(filePath: string, errorMessage: string): string {
    const safeName = this._escapeHtml(path.basename(filePath));
    const safeError = this._escapeHtml(errorMessage);
    return `<!DOCTYPE html>
<html lang="en">
<head>
    <meta charset="UTF-8">
    <meta http-equiv="Content-Security-Policy" content="default-src 'none'; style-src 'unsafe-inline';">
    <style>
        body { font-family: sans-serif; padding: 20px; background: #1e1e1e; color: #ccc; }
        .error { color: #f44; padding: 20px; background: #2d2d30; border-radius: 4px; }
        h2 { color: #fff; }
    </style>
</head>
<body>
    <h2>Failed to load RGD file</h2>
    <div class="error">
        <strong>File:</strong> ${safeName}<br><br>
        <strong>Error:</strong> ${safeError}
    </div>
    <p>Try using the text editor backup: Right-click the file → "RGD Suite: Open (Plain Text Editor)"</p>
</body>
</html>`;
  }

  private _getHtml(
    webview: vscode.Webview,
    filePath: string,
    nodes: RgdNode[],
  ): string {
    const scriptUri = webview.asWebviewUri(
      vscode.Uri.joinPath(this._extensionUri, "media", "editor.js"),
    );
    const styleUri = webview.asWebviewUri(
      vscode.Uri.joinPath(this._extensionUri, "media", "editor.css"),
    );
    const nonce = this._getNonce();
    const csp = [
      "default-src 'none'",
      `style-src ${webview.cspSource} 'unsafe-inline'`,
      `script-src 'nonce-${nonce}'`,
      `img-src ${webview.cspSource} data:`,
      `font-src ${webview.cspSource}`,
    ].join("; ");
    const safeTitle = this._escapeHtml(path.basename(filePath));

    return `<!DOCTYPE html>
<html lang="en">
<head>
    <meta charset="UTF-8">
    <meta name="viewport" content="width=device-width, initial-scale=1.0">
    <meta http-equiv="Content-Security-Policy" content="${csp}">
    <link href="${styleUri}" rel="stylesheet">
    <title>RGD Suite - ${safeTitle}</title>
</head>
<body>
    <div class="rgd-container">
        <div class="toolbar">
            <span class="toolbar-title">📄 ${safeTitle}</span>
            <button class="toolbar-btn primary" id="save-btn" title="Save (Ctrl+S)">💾 Save</button>
            <button class="toolbar-btn" id="git-diff-btn" title="Compare against git HEAD">Git Diff</button>
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
            <div class="diff-panel" id="diff-panel" hidden>
                <div class="diff-header">
                    <span id="diff-header-text">Git Diff</span>
                    <button class="toolbar-btn" id="diff-close" title="Close diff panel">Close</button>
                </div>
                <div class="diff-content" id="diff-content"></div>
            </div>
        </div>
        <div class="status-bar">
            <div class="status-item"><span id="status-text">Ready</span></div>
            <div class="status-item"><span id="diff-status"></span></div>
            <div class="status-item"><span>${nodes.length} top-level nodes</span></div>
        </div>
    </div>
    <script nonce="${nonce}" src="${scriptUri}"></script>
</body>
</html>`;
  }

  private _updateNodeValue(
    nodes: RgdNode[],
    nodePath: number[],
    key: string | null,
    value: any,
  ): void {
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
      const child = current.children.find((c) => c.key === key);
      if (child) child.value = value;
    } else {
      current.value = value;
    }
  }

  private async _runGitDiff(
    document: RgdDocument,
    webviewPanel: vscode.WebviewPanel,
    ref: string,
  ): Promise<void> {
    const dict = this.dictionaryManager.getDictionary(this.context);
    const result: TableDiffResult = await diffRgdAgainstGit(
      document.uri.fsPath,
      dict,
      ref,
    );
    if (result.error) {
      webviewPanel.webview.postMessage({
        type: "gitDiffError",
        message: result.error,
        baseRef: result.baseRef,
      });
      return;
    }
    webviewPanel.webview.postMessage({
      type: "gitDiff",
      baseRef: result.baseRef,
      totalKeys: result.totalKeys,
      entries: result.entries,
      highlight: buildDiffHighlightMap(result.entries),
    });
  }

  private async _saveRgd(document: RgdDocument): Promise<void> {
    const rgdTable = treeToRgd(document.nodes);
    const dict = this.dictionaryManager.getDictionary(this.context);
    const backupPath = document.uri.fsPath + ".bak";
    let wroteBackup = false;
    if (fs.existsSync(document.uri.fsPath)) {
      fs.copyFileSync(document.uri.fsPath, backupPath);
      wroteBackup = true;
    }
    try {
      writeRgdFile(document.uri.fsPath, rgdTable, dict, document.rgdVersion);
      invalidateParsedRgdCache(document.uri.fsPath);
      if (wroteBackup && fs.existsSync(backupPath)) {
        try {
          fs.unlinkSync(backupPath);
        } catch {
          /* best-effort cleanup */
        }
      }
    } catch (writeError) {
      if (wroteBackup && fs.existsSync(backupPath)) {
        fs.copyFileSync(backupPath, document.uri.fsPath);
      }
      throw writeError;
    }
  }
}
