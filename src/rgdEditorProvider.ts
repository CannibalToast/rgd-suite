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
  getTreeNodesFromBuffer,
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

/** Like shallowTreePayload but includes children recursively. */
function deepTreePayload(nodes: RgdNode[]): Record<string, unknown>[] {
  return nodes.map((n) => {
    const flat = shallowTreePayload([n])[0];
    if (n.children && n.children.length > 0) {
      flat.children = deepTreePayload(n.children);
    }
    return flat;
  });
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
  /** True for virtual URIs (git: etc.) — view-only, never written back. */
  public readOnly: boolean = false;

  constructor(
    public readonly uri: vscode.Uri,
    public nodes: RgdNode[] = [],
  ) { }

  dispose(): void { }
}

export class RgdEditorProvider implements vscode.CustomReadonlyEditorProvider<RgdDocument> {
  public static readonly viewType = "rgdEditor.rgdEditor";

  /** fsPath → open panels; >1 means a diff pair (git:/file: on the same file). */
  private readonly _panels = new Map<string, Set<vscode.WebviewPanel>>();
  /** Panels backed by a virtual URI (git: etc.) — the "before" side of diffs. */
  private readonly _gitPanes = new Set<vscode.WebviewPanel>();
  /** fsPath → merged diff window (one per file). */
  private readonly _diffPanels = new Map<string, vscode.WebviewPanel>();

  constructor(
    private readonly _extensionUri: vscode.Uri,
    private readonly context: vscode.ExtensionContext,
    private readonly dictionaryManager: DictionaryManager,
  ) { }

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
      const isFileScheme = document.uri.scheme === "file";
      document.readOnly = !isFileScheme;
      // Virtual URIs (git:, etc. — e.g. the "before" side of a git diff) must be
      // read through the FS provider: uri.fsPath resolves to the working-tree
      // file, which would render identical content on both diff panes.
      const { nodes, rgd } = isFileScheme
        ? await getTreeNodes(document.uri.fsPath, dict, {
          resolvePaths: false,
        })
        : getTreeNodesFromBuffer(
          Buffer.from(await vscode.workspace.fs.readFile(document.uri)),
          document.uri.fsPath,
          dict,
          { resolvePaths: false },
        );
      const attribRoot = findAttribBase(document.uri.fsPath) ?? undefined;

      document.rgdVersion = rgd.header.version;
      document.nodes = nodes;

      webviewPanel.webview.html = this._getHtml(
        webviewPanel.webview,
        document.uri.fsPath,
        document.nodes,
        document.readOnly,
      );

      // Register this panel under its real path so paired diff panes (a git:
      // URI plus the working file:) can sync tree state and share highlights.
      let panels = this._panels.get(document.uri.fsPath);
      if (!panels) {
        panels = new Set();
        this._panels.set(document.uri.fsPath, panels);
      }
      panels.add(webviewPanel);
      webviewPanel.onDidDispose(() => {
        panels.delete(webviewPanel);
        this._gitPanes.delete(webviewPanel);
        if (panels.size === 0) this._panels.delete(document.uri.fsPath);
      });

      // A virtual (git:) pane that pairs with the working file: pane is the
      // "before" side of a git diff — replace it with a single merged diff
      // window. A git: pane with no file: sibling is a standalone revision
      // view (timeline etc.) and stays as the plain read-only tree.
      if (isFileScheme) {
        setTimeout(() => this._tryMergeDiff(document.uri.fsPath), 0);
      } else {
        this._gitPanes.add(webviewPanel);
        setTimeout(() => this._tryMergeDiff(document.uri.fsPath), 700);
      }

      webviewPanel.webview.onDidReceiveMessage(
        async (message: WebviewMessage) => {
          switch (message.type) {
            case "ready":
              webviewPanel.webview.postMessage({
                type: "loadData",
                data: shallowTreePayload(document.nodes),
              });
              // A second panel on the same fsPath is a diff view — push the
              // diff so both trees highlight without a manual Git Diff click.
              if ((this._panels.get(document.uri.fsPath)?.size ?? 0) > 1) {
                void this._broadcastGitDiff(document.uri.fsPath);
              }
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
              if (document.readOnly) break;
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
              if (document.readOnly) break;
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
                // Keep paired diff panes' highlights truthful after a save.
                if ((this._panels.get(document.uri.fsPath)?.size ?? 0) > 1) {
                  void this._broadcastGitDiff(document.uri.fsPath);
                }
                // Refresh an open merged diff window so it reflects the save.
                if (this._diffPanels.has(document.uri.fsPath)) {
                  void this._openMergedDiff(document.uri.fsPath);
                }
              } catch (saveError) {
                vscode.window.showErrorMessage(
                  `Failed to save RGD: ${getErrorMessage(saveError)}`,
                );
              }
              break;

            case "requestGitDiff": {
              void this._openMergedDiff(document.uri.fsPath);
              break;
            }

            case "diffSync": {
              // Relay expand/select/scroll to the sibling pane of this diff.
              const siblings = this._panels.get(document.uri.fsPath);
              if (!siblings || siblings.size < 2) break;
              for (const sibling of siblings) {
                if (sibling !== webviewPanel) {
                  sibling.webview.postMessage({
                    ...message,
                    type: "applyDiffSync",
                  });
                }
              }
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
    return text
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
    readOnly = false,
    diffMode = false,
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
<body data-readonly="${readOnly}" data-diffmode="${diffMode}">
    <div class="rgd-container">
        <div class="toolbar">
            <span class="toolbar-title">📄 ${safeTitle}${readOnly && !diffMode ? " (read-only)" : ""}</span>
            ${readOnly ? "" : '<button class="toolbar-btn primary save-action" id="save-btn" title="Save (Ctrl+S)">💾 Save</button>'}
            ${diffMode ? '<span class="toolbar-badge">vs ' + "HEAD" + '</span>' : '<button class="toolbar-btn" id="git-diff-btn" title="Compare against git HEAD">Git Diff</button>'}
            <button class="toolbar-btn" id="expand-all" title="Expand All">Expand All</button>
            <button class="toolbar-btn" id="collapse-all" title="Collapse All">Collapse All</button>
        </div>
        <div class="split-view">
            <div class="tree-panel">
                <div class="tree-header">Tables</div>
                <div class="tree-find">
                    <input type="text" id="tree-find" placeholder="Find…" spellcheck="false">
                    <label class="find-opt" title="Match case"><input type="checkbox" id="tree-find-case">Aa</label>
                    <label class="find-opt" title="Only what changed vs git"><input type="checkbox" id="tree-find-changed" disabled>Δ</label>
                </div>
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
                <div class="property-info" id="property-info" hidden></div>
            </div>
        </div>
        ${readOnly ? "" : `<div class="action-bar">
            <button class="toolbar-btn" id="undo-btn" title="Undo (Ctrl+Z)" disabled>↶ Undo</button>
            <button class="toolbar-btn" id="redo-btn" title="Redo (Ctrl+Shift+Z)" disabled>↷ Redo</button>
            <span class="action-spacer"></span>
            <button class="toolbar-btn primary save-action" id="save-btn-bottom" title="Save (Ctrl+S)">💾 Save</button>
        </div>`}
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

  /**
   * When a git: pane and a file: pane share an fsPath, the user opened a git
   * diff — collapse it into a single merged diff window instead of rendering
   * the before-pane as a second tree.
   */
  private _tryMergeDiff(fsPath: string): void {
    const panels = this._panels.get(fsPath);
    if (!panels || panels.size < 2) return;
    const gitPane = [...panels].find((p) => this._gitPanes.has(p));
    if (!gitPane) return;
    this._gitPanes.delete(gitPane);
    gitPane.dispose();
    void this._openMergedDiff(fsPath);
  }

  /**
   * Open (or reveal) the merged diff window for a file: one tree built from
   * the working file with removed keys materialised as ghost rows and value
   * cells showing old+new inline. Read-only — it is a diff report, and the
   * working file's own editor stays the place to edit.
   */
  private async _openMergedDiff(fsPath: string): Promise<void> {
    const existing = this._diffPanels.get(fsPath);
    const dict = this.dictionaryManager.getDictionary(this.context);
    let nodes: RgdNode[] = [];
    try {
      nodes = (await getTreeNodes(fsPath, dict, { resolvePaths: false })).nodes;
    } catch {
      nodes = [];
    }
    const result: TableDiffResult = await diffRgdAgainstGit(fsPath, dict, "HEAD");
    const entries = result.error ? [] : result.entries;
    const payload = {
      type: "loadData",
      data: deepTreePayload(nodes),
      diffEntries: entries,
      diffHighlight: buildDiffHighlightMap(entries),
      baseRef: result.baseRef || "HEAD",
      diffError: result.error || null,
    };

    if (existing) {
      existing.reveal();
      existing.webview.postMessage(payload);
      return;
    }

    const panel = vscode.window.createWebviewPanel(
      "rgdMergedDiff",
      `Diff: ${path.basename(fsPath)}`,
      vscode.ViewColumn.Active,
      { enableScripts: true, localResourceRoots: [this._extensionUri] },
    );

    this._diffPanels.set(fsPath, panel);
    panel.onDidDispose(() => {
      if (this._diffPanels.get(fsPath) === panel) this._diffPanels.delete(fsPath);
    });
    panel.webview.html = this._getHtml(
      panel.webview,
      `${path.basename(fsPath)} (diff)`,
      nodes,
      /* readOnly */ true,
      /* diffMode */ true,
    );
    panel.webview.onDidReceiveMessage(async (message: WebviewMessage) => {
      if (message.type === "ready") {
        panel.webview.postMessage(payload);
      } else if (message.type === "openRef" && message.ref) {
        const refPath = String(message.ref).replace(/\\/g, "/");
        const hasExtension = /\.(lua|rgd|scar|ai)$/i.test(refPath);
        const extensions = hasExtension ? [""] : [".rgd", ".lua"];
        const base = findAttribBase(fsPath);
        let targetPath = "";
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
          vscode.commands.executeCommand("vscode.open", vscode.Uri.file(targetPath));
        } else {
          vscode.window.showWarningMessage(`Referenced file not found: ${refPath}`);
        }
      }
    });
    // Keep an open working-file editor's highlights truthful alongside.
    if ((this._panels.get(fsPath)?.size ?? 0) > 0) {
      void this._broadcastGitDiff(fsPath);
    }
  }

  /**
   * Push the working-vs-HEAD diff to every panel open on fsPath. Used when a
   * git diff view pairs a git: pane with the file: pane — the `auto` flag tells
   * the webview to highlight trees without force-opening the diff panel.
   */
  private async _broadcastGitDiff(fsPath: string): Promise<void> {
    const panels = this._panels.get(fsPath);
    if (!panels || panels.size === 0) return;
    const dict = this.dictionaryManager.getDictionary(this.context);
    const result: TableDiffResult = await diffRgdAgainstGit(
      fsPath,
      dict,
      "HEAD",
    );
    const payload = result.error
      ? {
        type: "gitDiffError",
        message: result.error,
        baseRef: result.baseRef,
      }
      : {
        type: "gitDiff",
        baseRef: result.baseRef,
        totalKeys: result.totalKeys,
        entries: result.entries,
        highlight: buildDiffHighlightMap(result.entries),
        auto: true,
      };
    for (const panel of panels) {
      panel.webview.postMessage(payload);
    }
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
