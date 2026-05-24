import * as vscode from "vscode";
import {
  HashDictionary,
  RgdDataType,
  dataTypeName,
} from "../bundled/rgd-tools/dist/types";
import { treeToRgd, RgdNode } from "./rgdTable";
import { writeRgdFile } from "../bundled/rgd-tools/dist/writer";
import * as path from "path";
import { DictionaryManager } from "./dictionaryManager";
import { getErrorMessage } from "./errorUtils";
import { getTreeNodes, invalidateParsedRgdCache } from "./parsedRgdCache";

class RgdTreeItem extends vscode.TreeItem {
  public editable: boolean = false;

  constructor(
    public readonly node: RgdNode,
    public readonly nodePath: number[],
    public readonly collapsibleState: vscode.TreeItemCollapsibleState,
  ) {
    super(node.key, collapsibleState);

    let desc =
      node.value !== undefined && node.value !== "" ? String(node.value) : "";
    if (node.localeText) {
      desc += " (" + node.localeText + ")";
    }
    this.description = desc || undefined;

    this.contextValue = node.children ? "rgdTable" : "rgdValue";
    this.tooltip = node.ref ? node.ref : undefined;

    if (!node.children && node.value !== undefined) {
      this.editable = true;
    }

    if (node.resolvedPath && node.resolvedExists) {
      this.command = {
        command: "rgdEditor.openReferencedFile",
        title: "Open Referenced File",
        arguments: [node.resolvedPath],
      };
      this.tooltip = "Click to open: " + node.resolvedPath;
      this.iconPath = new vscode.ThemeIcon("link");
    } else if (node.localeFile) {
      this.command = {
        command: "rgdEditor.openReferencedFile",
        title: "Open Locale Source",
        arguments: [node.localeFile, node.localeLine],
      };
      this.tooltip =
        "Click to open UCS source: " +
        path.basename(node.localeFile) +
        " (line " +
        node.localeLine +
        ")";
      this.iconPath = new vscode.ThemeIcon("info");
    } else if (
      typeof node.value === "string" &&
      (node.key.includes("icon_name") || node.key.includes("symbol_name"))
    ) {
      this.command = {
        command: "rgdEditor.openReferencedFile",
        title: "Search Icon",
        arguments: [node.value, 0, true],
      };
      this.tooltip = "Click to search for icon: " + node.value;
      this.iconPath = new vscode.ThemeIcon("image");
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

  constructor(private readonly context: vscode.ExtensionContext) {}

  async loadFromDocument(doc: vscode.TextDocument) {
    if (!doc || doc.isClosed) return;

    let realPath: string | undefined;
    if (doc.uri.scheme === "rgd") {
      realPath = doc.uri.path;
      realPath = decodeURIComponent(realPath);
      realPath = realPath.replace(/^\/([a-zA-Z]):/, "$1:");
      if (
        realPath.startsWith("/") &&
        /^[a-zA-Z]:/.test(realPath.substring(1))
      ) {
        realPath = realPath.substring(1);
      }
    } else if (
      doc.uri.scheme === "file" &&
      doc.uri.fsPath.toLowerCase().endsWith(".rgd")
    ) {
      realPath = doc.uri.fsPath;
    }

    if (!realPath) return;
    await this.loadFromUri(vscode.Uri.file(realPath));
  }

  async loadFromUri(uri: vscode.Uri) {
    try {
      const dict = DictionaryManager.getInstance().getDictionary(this.context);
      this.dict = dict;
      const { nodes, rgd } = await getTreeNodes(uri.fsPath, dict, {
        resolvePaths: false,
      });
      this.rgdData = rgd;
      this.nodes = nodes;
      this.sourceUri = uri;
      this._onDidChangeTreeData.fire();
    } catch (err) {
      console.error(
        "[RGD Suite TreeView] Error loading:",
        getErrorMessage(err),
      );
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
    return element.node.children.map((n, idx) =>
      this.toItem(n, [...element.nodePath, idx]),
    );
  }

  private toItem(node: RgdNode, nodePath: number[]): RgdTreeItem {
    return new RgdTreeItem(
      node,
      nodePath,
      node.children
        ? vscode.TreeItemCollapsibleState.Collapsed
        : vscode.TreeItemCollapsibleState.None,
    );
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
      writeRgdFile(
        this.sourceUri.fsPath,
        this.rgdData.gameData,
        this.dict,
        this.rgdData.header.version,
      );
      invalidateParsedRgdCache(this.sourceUri.fsPath);
      this._onDidChangeTreeData.fire();
      vscode.window.setStatusBarMessage(
        "✓ Updated " + item.node.key + " = " + newValue,
        2000,
      );
      return true;
    } catch (error) {
      vscode.window.showErrorMessage(
        "Failed to update value: " + getErrorMessage(error),
      );
      return false;
    }
  }

  private parseValue(value: string, type: RgdDataType): any {
    switch (type) {
      case RgdDataType.Float:
        const floatVal = parseFloat(value);
        if (isNaN(floatVal)) throw new Error("Invalid float: " + value);
        return floatVal;
      case RgdDataType.Integer:
        const intVal = parseInt(value, 10);
        if (isNaN(intVal)) throw new Error("Invalid integer: " + value);
        return intVal;
      case RgdDataType.Bool:
        const lower = value.toLowerCase();
        if (lower === "true" || lower === "1") return true;
        if (lower === "false" || lower === "0") return false;
        throw new Error("Invalid boolean: " + value);
      case RgdDataType.String:
      case RgdDataType.WString:
        return value;
      default:
        throw new Error("Cannot edit type: " + dataTypeName(type));
    }
  }
}

export function registerRgdTreeView(context: vscode.ExtensionContext) {
  const provider = new RgdTreeProvider(context);
  const view = vscode.window.createTreeView("rgdTree", {
    treeDataProvider: provider,
  });
  context.subscriptions.push(view);

  context.subscriptions.push(
    vscode.commands.registerCommand("rgdEditor.refreshTree", async () => {
      const doc = vscode.window.activeTextEditor?.document;
      if (doc) await provider.loadFromDocument(doc);
    }),
  );

  context.subscriptions.push(
    vscode.commands.registerCommand(
      "rgdEditor.loadTreeView",
      async (uri: vscode.Uri) => {
        if (uri) await provider.loadFromUri(uri);
      },
    ),
  );

  let treeDebounce: ReturnType<typeof setTimeout> | undefined;
  let lastTreeRealPath: string | undefined;
  context.subscriptions.push(
    vscode.window.onDidChangeActiveTextEditor((ed) => {
      if (!ed?.document) return;
      let realPath: string | undefined;
      if (ed.document.uri.scheme === "rgd") {
        realPath = ed.document.uri.path;
        realPath = decodeURIComponent(realPath);
        realPath = realPath.replace(/^\/([a-zA-Z]):/, "$1:");
        if (
          realPath.startsWith("/") &&
          /^[a-zA-Z]:/.test(realPath.substring(1))
        ) {
          realPath = realPath.substring(1);
        }
      } else if (
        ed.document.uri.scheme === "file" &&
        ed.document.uri.fsPath.toLowerCase().endsWith(".rgd")
      ) {
        realPath = ed.document.uri.fsPath;
      }
      if (!realPath || realPath === lastTreeRealPath) return;
      if (treeDebounce) clearTimeout(treeDebounce);
      treeDebounce = setTimeout(() => {
        lastTreeRealPath = realPath;
        void provider.loadFromDocument(ed.document);
      }, 200);
    }),
  );

  context.subscriptions.push(
    vscode.commands.registerCommand(
      "rgdEditor.revealNode",
      (item: RgdTreeItem) => {
        provider.revealInEditor(item);
      },
    ),
  );

  context.subscriptions.push(
    vscode.commands.registerCommand(
      "rgdEditor.editValue",
      async (item: RgdTreeItem) => {
        if (!item.editable) return;
        const currentValue = String(item.node.value);
        const newValue = await vscode.window.showInputBox({
          prompt: "Edit " + item.node.key,
          value: currentValue,
          placeHolder: "Enter new " + dataTypeName(item.node.type) + " value",
        });
        if (newValue !== undefined && newValue !== currentValue) {
          await provider.editValue(item, newValue);
        }
      },
    ),
  );

  if (vscode.window.activeTextEditor?.document) {
    provider.loadFromDocument(vscode.window.activeTextEditor.document);
  }
}
