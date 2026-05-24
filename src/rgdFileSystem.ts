import * as vscode from "vscode";
import * as path from "path";
import * as fs from "fs";
import { textToRgd } from "../bundled/rgd-tools/dist/textFormat";
import { buildRgd } from "../bundled/rgd-tools/dist/writer";
import { DictionaryManager } from "./dictionaryManager";
import { getErrorMessage } from "./errorUtils";
import { getParsedRgd, getVfsText, invalidateParsedRgdCache } from "./parsedRgdCache";

export class RgdFileSystemProvider implements vscode.FileSystemProvider {
  private _emitter = new vscode.EventEmitter<vscode.FileChangeEvent[]>();
  readonly onDidChangeFile: vscode.Event<vscode.FileChangeEvent[]> =
    this._emitter.event;

  constructor(private readonly context: vscode.ExtensionContext) {
    console.log("[RGD FS] Initialized");
  }

  toRealPath(uri: vscode.Uri): string {
    let p = uri.path;
    p = decodeURIComponent(p);
    p = p.replace(/^\/([a-zA-Z]):/, "$1:");
    if (p.startsWith("/") && /^[a-zA-Z]:/.test(p.substring(1))) {
      p = p.substring(1);
    }
    return p;
  }

  toRgdUri(filePath: string): vscode.Uri {
    const normalized = filePath.replace(/\\/g, "/");
    return vscode.Uri.parse(`rgd:///${normalized}`);
  }

  watch(): vscode.Disposable {
    return new vscode.Disposable(() => {});
  }

  async stat(uri: vscode.Uri): Promise<vscode.FileStat> {
    const realPath = this.toRealPath(uri);
    const stats = await fs.promises.stat(realPath);
    return {
      type: vscode.FileType.File,
      ctime: stats.ctimeMs,
      mtime: stats.mtimeMs,
      size: stats.size,
    };
  }

  readDirectory(): [string, vscode.FileType][] {
    return [];
  }
  createDirectory(): void {}

  async readFile(uri: vscode.Uri): Promise<Uint8Array> {
    const realPath = this.toRealPath(uri);
    try {
      const dict = DictionaryManager.getInstance().getDictionary(this.context);
      const text = await getVfsText(realPath, dict);
      return Buffer.from(text, "utf8");
    } catch (error) {
      const errorText = `# Error reading RGD file: ${getErrorMessage(error)}\n# File may be corrupted or not a valid RGD file.`;
      return Buffer.from(errorText, "utf8");
    }
  }

  async writeFile(uri: vscode.Uri, content: Uint8Array): Promise<void> {
    const realPath = this.toRealPath(uri);
    const text = Buffer.from(content).toString("utf8");
    try {
      const dict = DictionaryManager.getInstance().getDictionary(this.context);
      const { gameData, version } = textToRgd(text, dict);
      let finalVersion = version;
      try {
        const entry = await getParsedRgd(realPath, dict);
        finalVersion = entry.rgd.header.version;
      } catch {
        /* use version from text */
      }
      const binaryBuffer = buildRgd(gameData, dict, finalVersion);
      await fs.promises.writeFile(realPath, binaryBuffer);
      invalidateParsedRgdCache(realPath);
      this._emitter.fire([{ type: vscode.FileChangeType.Changed, uri }]);
      vscode.window.setStatusBarMessage(
        `✓ Saved ${path.basename(realPath)}`,
        2000,
      );
    } catch (error) {
      vscode.window.showErrorMessage(
        `Failed to save RGD: ${getErrorMessage(error)}`,
      );
      throw error;
    }
  }

  async delete(uri: vscode.Uri): Promise<void> {
    const realPath = this.toRealPath(uri);
    await fs.promises.unlink(realPath);
    invalidateParsedRgdCache(this.toRealPath(uri));
  }

  async rename(oldUri: vscode.Uri, newUri: vscode.Uri): Promise<void> {
    const oldPath = this.toRealPath(oldUri);
    await fs.promises.rename(oldPath, this.toRealPath(newUri));
    invalidateParsedRgdCache(oldPath);
  }
}

export function registerRgdFileSystem(
  context: vscode.ExtensionContext,
): RgdFileSystemProvider {
  const provider = new RgdFileSystemProvider(context);
  context.subscriptions.push(
    vscode.workspace.registerFileSystemProvider("rgd", provider, {
      isCaseSensitive: false,
      isReadonly: false,
    }),
  );
  return provider;
}
