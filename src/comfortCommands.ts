/**
 * Creature-comfort explorer commands for RGD Suite.
 * Inspired by Corsix Mod Studio workflows: clone units, dump LUAs,
 * follow Reference()/Inherit chains, search keys, multi-file convert.
 */
import * as vscode from "vscode";
import * as path from "path";
import * as fs from "fs";
import { parseRgd, readRgdFile } from "../bundled/rgd-tools/dist/reader";
import { writeRgdFile, createTable, createEntry } from "../bundled/rgd-tools/dist/writer";
import { rgdToText } from "../bundled/rgd-tools/dist/textFormat";
import {
  rgdToLuaDifferential,
  luaToRgdResolved,
} from "../bundled/rgd-tools/dist/luaFormat";
import { hash, hashToHex } from "../bundled/rgd-tools/dist/hash";
import { RgdDataType, RgdTable } from "../bundled/rgd-tools/dist/types";
import {
  findAttribBase,
  makeLuaParentLoader,
  makeRgdParentLoader,
  collectFilesAsync,
  countEntries,
} from "./attribUtils";
import { DictionaryManager } from "./dictionaryManager";
import { getErrorMessage } from "./errorUtils";
import { stripUtf8BomFromFile, isNilReference } from "./validators";
import { safeJoin } from "./pathUtils";
import { diffRgdBuffers, TableDiffResult } from "./tableDiff";
import { invalidateParsedRgdCache } from "./parsedRgdCache";
import { LocaleManager } from "./localeManager";

function dict(context: vscode.ExtensionContext) {
  return DictionaryManager.getInstance().getDictionary(context);
}

/** Normalize explorer multi-select: VS Code passes (uri, uris[]). */
function collectUris(
  uri?: vscode.Uri,
  uris?: vscode.Uri[],
): vscode.Uri[] {
  if (uris && uris.length > 0) return uris;
  if (uri) return [uri];
  const active = vscode.window.activeTextEditor?.document.uri;
  return active ? [active] : [];
}


function siblingPath(filePath: string, fromExt: RegExp, toExt: string): string {
  if (fromExt.test(filePath)) return filePath.replace(fromExt, toExt);
  return filePath + toExt;
}

function attribRelativePath(filePath: string): string | null {
  const base = findAttribBase(filePath);
  if (!base) return null;
  let rel = path.relative(base, filePath).replace(/\\/g, "/");
  rel = rel.replace(/\.(rgd|lua|nil)$/i, "");
  return rel;
}

async function copyToClipboard(text: string, toast: string): Promise<void> {
  await vscode.env.clipboard.writeText(text);
  vscode.window.setStatusBarMessage(toast, 2500);
}

function openOutput(title: string): vscode.OutputChannel {
  const ch = vscode.window.createOutputChannel(title);
  ch.clear();
  ch.show(true);
  return ch;
}

// ── Commands ───────────────────────────────────────────────────────────────

export function registerComfortCommands(
  context: vscode.ExtensionContext,
): void {
  const push = (id: string, fn: (...args: any[]) => any) => {
    context.subscriptions.push(vscode.commands.registerCommand(id, fn));
  };

  // Clone file with a new name (duplicate RGD/Lua/text for modding variants)
  push("rgdSuite.cloneFile", async (uri?: vscode.Uri) => {
    const file = uri?.fsPath ?? vscode.window.activeTextEditor?.document.uri.fsPath;
    if (!file || !fs.existsSync(file)) {
      vscode.window.showErrorMessage("No file selected");
      return;
    }
    const base = path.basename(file);
    const name = await vscode.window.showInputBox({
      prompt: "Clone as (new file name)",
      value: base.replace(/(\.[^.]+)$/, "_copy$1"),
      validateInput: (v) =>
        !v.trim()
          ? "Name required"
          : /[<>:"|?*]/.test(v)
            ? "Invalid characters"
            : null,
    });
    if (!name) return;
    const dest = path.join(path.dirname(file), name);
    if (fs.existsSync(dest)) {
      const ok = await vscode.window.showWarningMessage(
        `${name} exists. Overwrite?`,
        "Yes",
        "No",
      );
      if (ok !== "Yes") return;
    }
    await fs.promises.copyFile(file, dest);
    // Also clone paired sidecar if present (RGD↔Lua)
    const pairs: Array<[RegExp, string]> = [
      [/\.rgd$/i, ".lua"],
      [/\.lua$/i, ".rgd"],
      [/\.rgd\.txt$/i, ".rgd"],
    ];
    for (const [re, ext] of pairs) {
      if (re.test(file)) {
        const sib = siblingPath(file, re, ext);
        if (fs.existsSync(sib)) {
          const sibDest = siblingPath(dest, re, ext);
          if (!fs.existsSync(sibDest)) {
            const clonePair = await vscode.window.showQuickPick(
              ["Yes — clone pair too", "No — only this file"],
              { placeHolder: `Also clone ${path.basename(sib)}?` },
            );
            if (clonePair?.startsWith("Yes")) {
              await fs.promises.copyFile(sib, sibDest);
            }
          }
        }
        break;
      }
    }
    const doc = await vscode.workspace.openTextDocument(dest);
    await vscode.window.showTextDocument(doc);
    vscode.window.showInformationMessage(`Cloned → ${path.basename(dest)}`);
  });

  // Open counterpart (.rgd ↔ .lua ↔ .rgd.txt)
  push("rgdSuite.openCounterpart", async (uri?: vscode.Uri) => {
    const file = uri?.fsPath ?? vscode.window.activeTextEditor?.document.uri.fsPath;
    if (!file) {
      vscode.window.showErrorMessage("No file selected");
      return;
    }
    const candidates: string[] = [];
    if (/\.rgd$/i.test(file) && !/\.rgd\.txt$/i.test(file)) {
      candidates.push(file.replace(/\.rgd$/i, ".lua"), file + ".txt");
    } else if (/\.lua$/i.test(file)) {
      candidates.push(file.replace(/\.lua$/i, ".rgd"));
    } else if (/\.rgd\.txt$/i.test(file)) {
      candidates.push(file.slice(0, -4));
    }
    for (const c of candidates) {
      if (fs.existsSync(c)) {
        const doc = await vscode.workspace.openTextDocument(c);
        await vscode.window.showTextDocument(doc, { preview: false, viewColumn: vscode.ViewColumn.Beside });
        return;
      }
    }
    // Offer to generate counterpart
    if (/\.rgd$/i.test(file) && !/\.rgd\.txt$/i.test(file)) {
      const choice = await vscode.window.showQuickPick(
        ["Dump to Lua now", "Convert to Text now", "Cancel"],
        { placeHolder: "No counterpart found" },
      );
      if (choice?.startsWith("Dump")) {
        await vscode.commands.executeCommand("rgdEditor.dumpToLua", uri);
      } else if (choice?.startsWith("Convert")) {
        await vscode.commands.executeCommand("rgdEditor.convertToText", uri);
      }
    } else if (/\.lua$/i.test(file)) {
      const choice = await vscode.window.showQuickPick(
        ["Compile to RGD now", "Cancel"],
        { placeHolder: "No .rgd counterpart found" },
      );
      if (choice?.startsWith("Compile")) {
        await vscode.commands.executeCommand("rgdEditor.compileToRgd", uri);
      }
    } else {
      vscode.window.showWarningMessage("No counterpart found");
    }
  });

  // Open RGD and Lua side-by-side
  push("rgdSuite.openPairSideBySide", async (uri?: vscode.Uri) => {
    const file = uri?.fsPath ?? vscode.window.activeTextEditor?.document.uri.fsPath;
    if (!file) return;
    let rgd = file;
    let lua = file;
    if (/\.rgd$/i.test(file) && !/\.rgd\.txt$/i.test(file)) {
      lua = file.replace(/\.rgd$/i, ".lua");
    } else if (/\.lua$/i.test(file)) {
      rgd = file.replace(/\.lua$/i, ".rgd");
    } else {
      vscode.window.showWarningMessage("Select a .rgd or .lua file");
      return;
    }
    if (!fs.existsSync(rgd) || !fs.existsSync(lua)) {
      vscode.window.showWarningMessage("Both .rgd and .lua must exist (use Open Counterpart / Convert first)");
      return;
    }
    await vscode.commands.executeCommand(
      "vscode.openWith",
      vscode.Uri.file(rgd),
      "rgdEditor.rgdEditor",
      { preview: false, viewColumn: vscode.ViewColumn.One },
    );
    const luaDoc = await vscode.workspace.openTextDocument(lua);
    await vscode.window.showTextDocument(luaDoc, {
      preview: false,
      viewColumn: vscode.ViewColumn.Two,
    });
  });

  // Copy attrib-relative path (Reference-style)
  push("rgdSuite.copyAttribPath", async (uri?: vscode.Uri) => {
    const file = uri?.fsPath ?? vscode.window.activeTextEditor?.document.uri.fsPath;
    if (!file) return;
    const rel = attribRelativePath(file);
    if (!rel) {
      vscode.window.showWarningMessage("Could not resolve attrib root for this file");
      return;
    }
    await copyToClipboard(rel, `Copied attrib path: ${rel}`);
  });

  push("rgdSuite.copyAbsolutePath", async (uri?: vscode.Uri) => {
    const file = uri?.fsPath ?? vscode.window.activeTextEditor?.document.uri.fsPath;
    if (!file) return;
    await copyToClipboard(file, "Absolute path copied");
  });

  push("rgdSuite.copyFileName", async (uri?: vscode.Uri) => {
    const file = uri?.fsPath ?? vscode.window.activeTextEditor?.document.uri.fsPath;
    if (!file) return;
    await copyToClipboard(path.basename(file), "File name copied");
  });

  push("rgdSuite.copyFileStem", async (uri?: vscode.Uri) => {
    const file = uri?.fsPath ?? vscode.window.activeTextEditor?.document.uri.fsPath;
    if (!file) return;
    const stem = path.basename(file).replace(/\.(rgd\.txt|rgd|lua|sga)$/i, "");
    await copyToClipboard(stem, `Copied: ${stem}`);
  });

  // Hash of key / filename stem (Bob Jenkins)
  push("rgdSuite.copyHash", async (uri?: vscode.Uri) => {
    const file = uri?.fsPath;
    let key = file
      ? path.basename(file).replace(/\.(rgd\.txt|rgd|lua)$/i, "")
      : "";
    key =
      (await vscode.window.showInputBox({
        prompt: "String to hash (Bob Jenkins / Relic RGD hash)",
        value: key,
      })) ?? "";
    if (!key) return;
    const h = hash(key);
    const hex = hashToHex(h);
    const payload = `${hex}  (${h})  // ${key}`;
    await copyToClipboard(payload, `Hash copied: ${hex}`);
  });

  // Generate Reference("…") / Inherit snippet
  push("rgdSuite.copyReferenceSnippet", async (uri?: vscode.Uri) => {
    const file = uri?.fsPath ?? vscode.window.activeTextEditor?.document.uri.fsPath;
    if (!file) return;
    const rel = attribRelativePath(file);
    if (!rel) {
      vscode.window.showWarningMessage("Could not resolve attrib-relative path");
      return;
    }
    const style = await vscode.window.showQuickPick(
      [
        { label: "Reference", description: `GameData = Reference("${rel}")` },
        { label: "Inherit", description: `Inherit("${rel}") style path only` },
        { label: "Path only", description: rel },
      ],
      { placeHolder: "Snippet style" },
    );
    if (!style) return;
    let text = rel;
    if (style.label === "Reference") text = `GameData = Reference("${rel}")`;
    else if (style.label === "Inherit") text = `Inherit("${rel}")`;
    await copyToClipboard(text, "Reference snippet copied");
  });

  // Open parent Reference() / $REF from RGD or Lua
  push("rgdSuite.openParentReference", async (uri?: vscode.Uri) => {
    const file = uri?.fsPath ?? vscode.window.activeTextEditor?.document.uri.fsPath;
    if (!file) return;
    try {
      const attribBase = findAttribBase(file);
      if (!attribBase) {
        vscode.window.showWarningMessage("Attrib root not found");
        return;
      }
      let ref: string | undefined;
      if (/\.rgd$/i.test(file) && !/\.rgd\.txt$/i.test(file)) {
        const rgd = readRgdFile(file, dict(context));
        ref = rgd.gameData.reference;
      } else if (/\.lua$/i.test(file)) {
        const code = stripUtf8BomFromFile(
          file,
          await fs.promises.readFile(file),
        ).buffer.toString("utf8");
        // Match Reference("...") or Inherit("...") / GameData = Reference
        const m =
          code.match(/\bReference\s*\(\s*["']([^"']+)["']\s*\)/i) ||
          code.match(/\bInherit\s*\(\s*["']([^"']+)["']\s*\)/i);
        ref = m?.[1];
      } else {
        vscode.window.showWarningMessage("Open parent works on .rgd / .lua");
        return;
      }
      if (!ref || isNilReference(ref)) {
        vscode.window.showInformationMessage("No parent Reference() on this file");
        return;
      }
      const clean = ref.replace(/\\/g, "/").replace(/\.(lua|rgd)$/i, "");
      for (const ext of [".rgd", ".lua"]) {
        const p = safeJoin(attribBase, clean + ext);
        if (p && fs.existsSync(p)) {
          if (ext === ".rgd") {
            await vscode.commands.executeCommand(
              "vscode.openWith",
              vscode.Uri.file(p),
              "rgdEditor.rgdEditor",
            );
          } else {
            const doc = await vscode.workspace.openTextDocument(p);
            await vscode.window.showTextDocument(doc);
          }
          return;
        }
      }
      vscode.window.showWarningMessage(`Parent not found: ${ref}`);
    } catch (e) {
      vscode.window.showErrorMessage(`Open parent failed: ${getErrorMessage(e)}`);
    }
  });

  // Find who references this file (text search under attrib)
  push("rgdSuite.findReferencesToFile", async (uri?: vscode.Uri) => {
    const file = uri?.fsPath ?? vscode.window.activeTextEditor?.document.uri.fsPath;
    if (!file) return;
    const rel = attribRelativePath(file);
    if (!rel) {
      vscode.window.showWarningMessage("Could not resolve attrib path");
      return;
    }
    const needles = [
      rel,
      rel.replace(/\//g, "\\"),
      path.basename(rel),
    ];
    const base = findAttribBase(file) ?? path.dirname(file);
    const out = openOutput("RGD Find References");
    out.appendLine(`Searching for references to: ${rel}`);
    out.appendLine(`Root: ${base}`);
    out.appendLine("");

    await vscode.window.withProgress(
      {
        location: vscode.ProgressLocation.Notification,
        title: "Finding references…",
        cancellable: true,
      },
      async (progress, token) => {
        const files = [
          ...(await collectFilesAsync(base, ".lua")),
          ...(await collectFilesAsync(base, ".rgd")),
        ];
        let hits = 0;
        let scanned = 0;
        for (const f of files) {
          if (token.isCancellationRequested) break;
          if (path.resolve(f) === path.resolve(file)) continue;
          scanned++;
          if (scanned % 50 === 0) {
            progress.report({ message: `${scanned}/${files.length}` });
          }
          try {
            let text: string;
            if (/\.rgd$/i.test(f)) {
              // Only check root reference cheaply for binary
              const rgd = parseRgd(await fs.promises.readFile(f), dict(context));
              const rootRef = (rgd.gameData.reference || "").replace(/\\/g, "/");
              const match =
                rootRef.includes(rel) ||
                rootRef.endsWith(path.basename(rel));
              if (match) {
                hits++;
                out.appendLine(`[RGD REF] ${f}`);
              }
              // Also dump to search path-like strings in resolved names is expensive; skip.
            } else {
              text = (await fs.promises.readFile(f)).toString("utf8");
              if (needles.some((n) => text.includes(n))) {
                hits++;
                out.appendLine(`[LUA] ${f}`);
              }
            }
          } catch {
            /* skip unreadable */
          }
        }
        out.appendLine("");
        out.appendLine(`Done. ${hits} hit(s) in ${scanned} file(s).`);
        vscode.window.showInformationMessage(
          hits ? `Found ${hits} reference(s) — see Output` : "No references found",
        );
      },
    );
  });

  // Search key name across folder (leaf key / table path fragment)
  push("rgdSuite.searchKeyInFolder", async (uri?: vscode.Uri) => {
    let folder =
      uri && fs.existsSync(uri.fsPath) && fs.statSync(uri.fsPath).isDirectory()
        ? uri.fsPath
        : uri?.fsPath
          ? path.dirname(uri.fsPath)
          : vscode.workspace.workspaceFolders?.[0]?.uri.fsPath;
    if (!folder) {
      vscode.window.showErrorMessage("No folder context");
      return;
    }
    const key = await vscode.window.showInputBox({
      prompt: "Key name or path fragment to search (e.g. max_health, squad_loadout_ext)",
      placeHolder: "case-insensitive substring match on keys",
    });
    if (!key?.trim()) return;
    const needle = key.trim().toLowerCase();
    const out = openOutput("RGD Key Search");
    out.appendLine(`Search: "${key}" under ${folder}`);
    out.appendLine("");

    await vscode.window.withProgress(
      {
        location: vscode.ProgressLocation.Notification,
        title: `Searching keys for "${key}"…`,
        cancellable: true,
      },
      async (_p, token) => {
        const rgdFiles = await collectFilesAsync(folder, ".rgd");
        const d = dict(context);
        let hits = 0;
        for (const f of rgdFiles) {
          if (token.isCancellationRequested) break;
          try {
            const rgd = parseRgd(await fs.promises.readFile(f), d);
            const matches: string[] = [];
            walkKeys(rgd.gameData, "", (full) => {
              if (full.toLowerCase().includes(needle)) matches.push(full);
            });
            if (matches.length) {
              hits += matches.length;
              out.appendLine(f);
              for (const m of matches.slice(0, 40)) out.appendLine(`  ${m}`);
              if (matches.length > 40) out.appendLine(`  … +${matches.length - 40} more`);
            }
          } catch {
            /* skip */
          }
        }
        // Also search Lua as text for the key token
        const luaFiles = await collectFilesAsync(folder, ".lua");
        for (const f of luaFiles) {
          if (token.isCancellationRequested) break;
          try {
            const text = (await fs.promises.readFile(f)).toString("utf8");
            if (text.toLowerCase().includes(needle)) {
              out.appendLine(`[lua text] ${f}`);
              hits++;
            }
          } catch {
            /* skip */
          }
        }
        out.appendLine("");
        out.appendLine(`Finished. Approx. hits recorded: ${hits}`);
      },
    );
  });

  // Reveal attrib root in explorer
  push("rgdSuite.revealAttribRoot", async (uri?: vscode.Uri) => {
    const file = uri?.fsPath ?? vscode.window.activeTextEditor?.document.uri.fsPath;
    if (!file) return;
    const base = findAttribBase(file);
    if (!base) {
      vscode.window.showWarningMessage("Attrib root not detected");
      return;
    }
    await vscode.commands.executeCommand("revealInExplorer", vscode.Uri.file(base));
    vscode.window.setStatusBarMessage(`Attrib root: ${base}`, 4000);
  });

  // Copy rich file info
  push("rgdSuite.copyFileInfo", async (uri?: vscode.Uri) => {
    const file = uri?.fsPath ?? vscode.window.activeTextEditor?.document.uri.fsPath;
    if (!file || !/\.rgd$/i.test(file)) {
      vscode.window.showWarningMessage("Select a .rgd file");
      return;
    }
    try {
      const buf = await fs.promises.readFile(file);
      const rgd = parseRgd(buf, dict(context));
      const { totalEntries, tableCount } = countEntries(rgd.gameData.entries);
      const info = {
        file: path.basename(file),
        path: file,
        attribPath: attribRelativePath(file),
        sizeBytes: buf.length,
        version: rgd.header.version,
        chunks: rgd.chunks.length,
        totalEntries,
        tables: tableCount,
        reference: rgd.gameData.reference ?? null,
      };
      await copyToClipboard(JSON.stringify(info, null, 2), "File info JSON copied");
    } catch (e) {
      vscode.window.showErrorMessage(`Info failed: ${getErrorMessage(e)}`);
    }
  });

  // Multi-select convert helpers
  push("rgdSuite.convertSelectionToLua", async (uri?: vscode.Uri, uris?: vscode.Uri[]) => {
    await convertSelection(context, collectUris(uri, uris), "toLua");
  });
  push("rgdSuite.convertSelectionToRgd", async (uri?: vscode.Uri, uris?: vscode.Uri[]) => {
    await convertSelection(context, collectUris(uri, uris), "toRgd");
  });
  push("rgdSuite.convertSelectionToText", async (uri?: vscode.Uri, uris?: vscode.Uri[]) => {
    await convertSelection(context, collectUris(uri, uris), "toText");
  });

  // Strip BOM on selection
  push("rgdSuite.stripBom", async (uri?: vscode.Uri, uris?: vscode.Uri[]) => {
    const list = collectUris(uri, uris).filter(
      (u) =>
        /\.lua$/i.test(u.fsPath) ||
        /\.rgd\.txt$/i.test(u.fsPath) ||
        /\.txt$/i.test(u.fsPath),
    );
    if (!list.length) {
      vscode.window.showWarningMessage("Select .lua or .rgd.txt file(s)");
      return;
    }
    let fixed = 0;
    for (const u of list) {
      const buf = await fs.promises.readFile(u.fsPath);
      const result = stripUtf8BomFromFile(u.fsPath, buf);
      if (result.fix) fixed++;
    }
    vscode.window.showInformationMessage(
      fixed ? `Stripped BOM from ${fixed} file(s)` : "No BOMs found",
    );
  });

  // Rename .rgd and matching .lua together, optionally rewrite references + recompile
  push("rgdSuite.renamePair", async (uri?: vscode.Uri) => {
    await renamePairWithOptionalRewrite(context, uri);
  });

  // Compare two RGD files (table-level)
  push("rgdSuite.compareTwoRgd", async (uri?: vscode.Uri, uris?: vscode.Uri[]) => {
    const selected = collectUris(uri, uris).filter((u) => /\.rgd$/i.test(u.fsPath));
    let left = selected[0]?.fsPath;
    let right = selected[1]?.fsPath;
    if (!left) {
      vscode.window.showErrorMessage("Select a .rgd file first");
      return;
    }
    if (!right) {
      const pick = await vscode.window.showOpenDialog({
        canSelectMany: false,
        filters: { "RGD Files": ["rgd"] },
        openLabel: "Compare with…",
      });
      if (!pick?.length) return;
      right = pick[0].fsPath;
    }
    try {
      const d = dict(context);
      const result: TableDiffResult = diffRgdBuffers(
        await fs.promises.readFile(right),
        await fs.promises.readFile(left),
        d,
        {
          filePath: left,
          baseRef: path.basename(right),
        },
      );
      const out = openOutput("RGD Table Compare");
      out.appendLine(`Compare: ${left}`);
      out.appendLine(`   vs   : ${right}`);
      out.appendLine(`Changes : ${result.entries.length}`);
      out.appendLine("");
      for (const e of result.entries) {
        if (e.kind === "changed") {
          out.appendLine(
            `  ~ ${e.key}: ${JSON.stringify(e.oldValue?.value)} → ${JSON.stringify(e.newValue?.value)}`,
          );
        } else if (e.kind === "added") {
          out.appendLine(`  + ${e.key}: ${JSON.stringify(e.newValue?.value)}`);
        } else {
          out.appendLine(`  - ${e.key}: ${JSON.stringify(e.oldValue?.value)}`);
        }
      }
      vscode.window.showInformationMessage(
        result.entries.length
          ? `${result.entries.length} difference(s) — see Output → RGD Table Compare`
          : "Files are identical at key level",
      );
    } catch (e) {
      vscode.window.showErrorMessage(`Compare failed: ${getErrorMessage(e)}`);
    }
  });

  // New empty unit-like RGD from minimal template next to selection
  push("rgdSuite.newRgdFromTemplate", async (uri?: vscode.Uri) => {
    let dir =
      uri && fs.existsSync(uri.fsPath) && fs.statSync(uri.fsPath).isDirectory()
        ? uri.fsPath
        : uri
          ? path.dirname(uri.fsPath)
          : vscode.workspace.workspaceFolders?.[0]?.uri.fsPath;
    if (!dir) {
      vscode.window.showErrorMessage("No folder context");
      return;
    }
    const stem = await vscode.window.showInputBox({
      prompt: "New RGD base name (without .rgd)",
      value: "new_unit",
      validateInput: (v) => (!v.trim() ? "Required" : /[<>:"|?*\\/]/.test(v) ? "Invalid" : null),
    });
    if (!stem) return;
    const dest = path.join(dir, stem.replace(/\.rgd$/i, "") + ".rgd");
    if (fs.existsSync(dest)) {
      vscode.window.showErrorMessage("File already exists");
      return;
    }
    const d = dict(context);
    // Root table is GameData for Relic files (same shape as roundtrip tests).
    const gameData = createTable();
    gameData.entries.push(
      createEntry("unit_name", RgdDataType.String, stem, d),
    );
    writeRgdFile(dest, gameData, d, 1);
    await vscode.commands.executeCommand(
      "vscode.openWith",
      vscode.Uri.file(dest),
      "rgdEditor.rgdEditor",
    );
    vscode.window.showInformationMessage(`Created ${path.basename(dest)}`);
  });

  // List root Reference + entry count summary in output (quick digest)
  push("rgdSuite.quickDigest", async (uri?: vscode.Uri, uris?: vscode.Uri[]) => {
    const list = collectUris(uri, uris).filter((u) => /\.rgd$/i.test(u.fsPath));
    if (!list.length) {
      vscode.window.showWarningMessage("Select one or more .rgd files");
      return;
    }
    const out = openOutput("RGD Digest");
    const d = dict(context);
    for (const u of list) {
      try {
        const buf = await fs.promises.readFile(u.fsPath);
        const rgd = parseRgd(buf, d);
        const { totalEntries, tableCount } = countEntries(rgd.gameData.entries);
        out.appendLine(path.basename(u.fsPath));
        out.appendLine(`  path   : ${attribRelativePath(u.fsPath) || u.fsPath}`);
        out.appendLine(`  ver    : ${rgd.header.version}  size=${buf.length}`);
        out.appendLine(`  entries: ${totalEntries}  tables=${tableCount}`);
        out.appendLine(`  ref    : ${rgd.gameData.reference || "(none)"}`);
        out.appendLine("");
      } catch (e) {
        out.appendLine(`${u.fsPath}: ERROR ${getErrorMessage(e)}`);
      }
    }
  });

  // Open parent folder of attrib-relative reference under cursor is hard; offer "copy mod-relative data/attrib path"
  push("rgdSuite.copyDataAttribPath", async (uri?: vscode.Uri) => {
    const file = uri?.fsPath ?? vscode.window.activeTextEditor?.document.uri.fsPath;
    if (!file) return;
    const rel = attribRelativePath(file);
    if (!rel) {
      vscode.window.showWarningMessage("Could not resolve attrib path");
      return;
    }
    const full = `data/attrib/${rel}`;
    await copyToClipboard(full, `Copied: ${full}`);
  });

  // Rebuild binary from Lua + open result (compile & open)
  push("rgdSuite.compileAndOpen", async (uri?: vscode.Uri) => {
    if (!uri?.fsPath.endsWith(".lua") && !uri?.fsPath.match(/\.lua$/i)) {
      vscode.window.showWarningMessage("Select a .lua file");
      return;
    }
    await vscode.commands.executeCommand("rgdEditor.compileToRgd", uri);
    const rgd = uri.fsPath.replace(/\.lua$/i, ".rgd");
    if (fs.existsSync(rgd)) {
      await vscode.commands.executeCommand(
        "vscode.openWith",
        vscode.Uri.file(rgd),
        "rgdEditor.rgdEditor",
      );
    }
  });

  // Dump Lua and open beside
  push("rgdSuite.dumpLuaAndOpen", async (uri?: vscode.Uri) => {
    if (!uri || !/\.rgd$/i.test(uri.fsPath)) {
      vscode.window.showWarningMessage("Select a .rgd file");
      return;
    }
    await vscode.commands.executeCommand("rgdEditor.dumpToLua", uri);
  });

  // Invalidate parse/index caches after external edits (Corsix "refresh files")
  push("rgdSuite.refreshCaches", async () => {
    invalidateParsedRgdCache();
    try {
      const { invalidateAttribIndex } = await import("./pathResolver");
      invalidateAttribIndex();
    } catch {
      /* optional */
    }
    vscode.window.showInformationMessage("RGD Suite caches cleared");
  });

  // Find files by name substring / glob-ish pattern under attrib or folder
  push("rgdSuite.findFilesByName", async (uri?: vscode.Uri) => {
    let folder =
      uri && fs.existsSync(uri.fsPath) && fs.statSync(uri.fsPath).isDirectory()
        ? uri.fsPath
        : uri?.fsPath
          ? findAttribBase(uri.fsPath) || path.dirname(uri.fsPath)
          : vscode.workspace.workspaceFolders?.[0]?.uri.fsPath;
    if (!folder) {
      vscode.window.showErrorMessage("No folder context");
      return;
    }
    const pattern = await vscode.window.showInputBox({
      prompt: "File name contains (case-insensitive). Empty = list first 200 .rgd files",
      placeHolder: "e.g. engineer, squad_, _barracks",
    });
    if (pattern === undefined) return;
    const needle = pattern.trim().toLowerCase();
    const files = [
      ...(await collectFilesAsync(folder, ".rgd")),
      ...(await collectFilesAsync(folder, ".lua")),
    ];
    const hits = files
      .filter((f) => !needle || path.basename(f).toLowerCase().includes(needle))
      .slice(0, 200)
      .map((f) => ({
        label: path.basename(f),
        description: path.relative(folder, f),
        path: f,
      }));
    if (!hits.length) {
      vscode.window.showInformationMessage("No matches");
      return;
    }
    const pick = await vscode.window.showQuickPick(hits, {
      placeHolder: `${hits.length} match(es) — select to open`,
      matchOnDescription: true,
    });
    if (!pick) return;
    if (/\.rgd$/i.test(pick.path)) {
      await vscode.commands.executeCommand(
        "vscode.openWith",
        vscode.Uri.file(pick.path),
        "rgdEditor.rgdEditor",
      );
    } else {
      const doc = await vscode.workspace.openTextDocument(pick.path);
      await vscode.window.showTextDocument(doc);
    }
  });
}

function walkKeys(
  table: RgdTable,
  prefix: string,
  visit: (fullKey: string) => void,
): void {
  for (const entry of table.entries) {
    const k = entry.name ?? `#${entry.hash.toString(16)}`;
    const full = prefix ? `${prefix}.${k}` : k;
    visit(full);
    if (
      (entry.type === RgdDataType.Table || entry.type === RgdDataType.TableInt) &&
      entry.value &&
      typeof entry.value === "object" &&
      "entries" in (entry.value as RgdTable)
    ) {
      walkKeys(entry.value as RgdTable, full, visit);
    }
  }
}

async function convertSelection(
  context: vscode.ExtensionContext,
  uris: vscode.Uri[],
  mode: "toLua" | "toRgd" | "toText",
): Promise<void> {
  const d = dict(context);
  let ok = 0;
  let fail = 0;
  const errors: string[] = [];

  await vscode.window.withProgress(
    {
      location: vscode.ProgressLocation.Notification,
      title: `RGD Suite: converting ${uris.length} file(s)…`,
      cancellable: true,
    },
    async (progress, token) => {
      let i = 0;
      for (const u of uris) {
        if (token.isCancellationRequested) break;
        i++;
        progress.report({ message: `${i}/${uris.length}`, increment: 100 / Math.max(uris.length, 1) });
        const file = u.fsPath;
        try {
          if (mode === "toLua") {
            if (!/\.rgd$/i.test(file) || /\.rgd\.txt$/i.test(file)) continue;
            const rgd = parseRgd(await fs.promises.readFile(file), d);
            const attribBase = findAttribBase(file);
            const parentLoader = makeLuaParentLoader(attribBase, d);
            const lua = await rgdToLuaDifferential(rgd, parentLoader);
            await fs.promises.writeFile(file.replace(/\.rgd$/i, ".lua"), lua, "utf8");
            ok++;
          } else if (mode === "toRgd") {
            if (!/\.lua$/i.test(file)) continue;
            const code = stripUtf8BomFromFile(
              file,
              await fs.promises.readFile(file),
            ).buffer.toString("utf8");
            const attribBase = findAttribBase(file);
            const rgdParent = makeRgdParentLoader(attribBase, d);
            const { gameData, version } = await luaToRgdResolved(
              code,
              d,
              rgdParent,
            );
            const out = file.replace(/\.lua$/i, ".rgd");
            writeRgdFile(out, gameData, d, version);
            invalidateParsedRgdCache(out);
            ok++;
          } else {
            if (!/\.rgd$/i.test(file) || /\.rgd\.txt$/i.test(file)) continue;
            const rgd = parseRgd(await fs.promises.readFile(file), d);
            const localeMap = LocaleManager.getInstance().getLocaleMap(file);
            const text = rgdToText(rgd, path.basename(file), localeMap);
            await fs.promises.writeFile(file + ".txt", text, "utf8");
            ok++;
          }
        } catch (e) {
          fail++;
          errors.push(`${path.basename(file)}: ${getErrorMessage(e)}`);
        }
      }
    },
  );

  if (errors.length) {
    const out = openOutput("RGD Convert Selection");
    for (const e of errors) out.appendLine(e);
  }
  vscode.window.showInformationMessage(
    `Convert done: ${ok} ok, ${fail} failed` +
      (fail ? " (see Output)" : ""),
  );
}

// ── Rename pair + reference rewrite ────────────────────────────────────────

interface PathRewriteHit {
  file: string;
  kind: "lua-text" | "rgd-string" | "rgd-ref";
  count: number;
  samples: string[];
}

interface PathRewritePlan {
  attribBase: string;
  oldStem: string;
  newStem: string;
  replacements: Array<{ from: string; to: string }>;
  hits: PathRewriteHit[];
  totalHits: number;
}

/**
 * Build ordered replace pairs: longest first so we never partial-clobber.
 * Prefers full attrib-relative paths over bare stems (safer).
 */
export function buildRenameReplacements(
  oldRelNoExt: string,
  newRelNoExt: string,
): Array<{ from: string; to: string }> {
  const oldFwd = oldRelNoExt.replace(/\\/g, "/");
  const newFwd = newRelNoExt.replace(/\\/g, "/");
  const oldBack = oldFwd.replace(/\//g, "\\");
  const newBack = newFwd.replace(/\//g, "\\");
  const oldBase = path.posix.basename(oldFwd);
  const newBase = path.posix.basename(newFwd);

  const pairs: Array<{ from: string; to: string }> = [];
  const add = (from: string, to: string) => {
    if (from && to && from !== to) pairs.push({ from, to });
  };

  // Full paths with and without extensions, both separators
  for (const [o, n] of [
    [oldFwd, newFwd],
    [oldBack, newBack],
  ] as const) {
    add(o, n);
    add(o + ".rgd", n + ".rgd");
    add(o + ".lua", n + ".lua");
    add(o + ".nil", n + ".nil");
  }
  // data/attrib-prefixed forms
  add("data/attrib/" + oldFwd, "data/attrib/" + newFwd);
  add("data\\attrib\\" + oldBack, "data\\attrib\\" + newBack);
  add("attrib/" + oldFwd, "attrib/" + newFwd);
  add("attrib\\" + oldBack, "attrib\\" + newBack);

  // Bare stem only if unique-looking (not a generic token) — applied last
  if (oldBase.length >= 4 && oldBase !== newBase) {
    add(oldBase + ".rgd", newBase + ".rgd");
    add(oldBase + ".lua", newBase + ".lua");
    // Bare stem without ext is riskier; only as full path segment boundaries in apply
    add(oldBase, newBase);
  }

  pairs.sort((a, b) => b.from.length - a.from.length);
  // Dedupe by from
  const seen = new Set<string>();
  return pairs.filter((p) => {
    if (seen.has(p.from)) return false;
    seen.add(p.from);
    return true;
  });
}

/**
 * Apply replacements to a string. Bare stems (no slash, no extension) only
 * match as whole path segments or whole Reference() argument bodies.
 */
export function applyPathReplacements(
  text: string,
  replacements: Array<{ from: string; to: string }>,
): { text: string; count: number; samples: string[] } {
  let out = text;
  let count = 0;
  const samples: string[] = [];
  for (const { from, to } of replacements) {
    const isBareStem =
      !from.includes("/") &&
      !from.includes("\\") &&
      !/\.(rgd|lua|nil)$/i.test(from);

    if (isBareStem) {
      // Whole segment: /oldStem/ or \oldStem\ or start/end as segment
      const re = new RegExp(
        `(^|[/\\\\."'])(${escapeRegExp(from)})(?=$|[/\\\\."'])`,
        "gi",
      );
      out = out.replace(re, (m, pre: string, stem: string) => {
        count++;
        if (samples.length < 5) samples.push(`${stem} → ${to}`);
        return pre + to;
      });
    } else {
      // Case-sensitive first, then case-insensitive if needed
      if (out.includes(from)) {
        const parts = out.split(from);
        const n = parts.length - 1;
        if (n > 0) {
          count += n;
          if (samples.length < 5) samples.push(`${from} → ${to}`);
          out = parts.join(to);
        }
      } else {
        const re = new RegExp(escapeRegExp(from), "gi");
        out = out.replace(re, () => {
          count++;
          if (samples.length < 5) samples.push(`${from} → ${to}`);
          return to;
        });
      }
    }
  }
  return { text: out, count, samples };
}

function escapeRegExp(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

function rewriteRgdTableRefs(
  table: RgdTable,
  replacements: Array<{ from: string; to: string }>,
): { count: number; samples: string[] } {
  let count = 0;
  const samples: string[] = [];

  const touchStr = (s: string): string => {
    const r = applyPathReplacements(s, replacements);
    count += r.count;
    for (const x of r.samples) {
      if (samples.length < 8) samples.push(x);
    }
    return r.text;
  };

  if (table.reference) {
    table.reference = touchStr(table.reference);
  }
  for (const entry of table.entries) {
    if (typeof entry.value === "string") {
      entry.value = touchStr(entry.value);
    } else if (
      entry.value &&
      typeof entry.value === "object" &&
      "entries" in entry.value
    ) {
      const sub = rewriteRgdTableRefs(entry.value as RgdTable, replacements);
      count += sub.count;
      for (const x of sub.samples) {
        if (samples.length < 8) samples.push(x);
      }
    }
    if (entry.reference) {
      entry.reference = touchStr(entry.reference);
    }
  }
  return { count, samples };
}

async function applyRenameRewrites(
  context: vscode.ExtensionContext,
  plan: PathRewritePlan,
  renamedLuaPath: string | null,
  renamedRgdPath: string | null,
  recompile: boolean,
): Promise<{ luaEdited: number; rgdEdited: number; recompiled: number; errors: string[] }> {
  const d = dict(context);
  let luaEdited = 0;
  let rgdEdited = 0;
  let recompiled = 0;
  const errors: string[] = [];
  const out = openOutput("RGD Rename Rewrite");
  out.appendLine(
    `Rewriting references: ${plan.oldStem} → ${plan.newStem} under ${plan.attribBase}`,
  );
  out.appendLine(`Replacement patterns: ${plan.replacements.length}`);
  out.appendLine("");

  const editedLuaFiles: string[] = [];

  // Always rewrite the renamed lua itself if present
  const luaTargets = await collectFilesAsync(plan.attribBase, ".lua");
  for (const f of luaTargets) {
    try {
      const raw = await fs.promises.readFile(f);
      const fixed = stripUtf8BomFromFile(f, raw);
      const text = fixed.buffer.toString("utf8");
      const r = applyPathReplacements(text, plan.replacements);
      if (r.count > 0) {
        await fs.promises.writeFile(f, r.text, "utf8");
        luaEdited++;
        editedLuaFiles.push(f);
        out.appendLine(`[LUA] ${f}  (${r.count} replace(s))`);
        for (const s of r.samples) out.appendLine(`       ${s}`);
      }
    } catch (e) {
      errors.push(`${f}: ${getErrorMessage(e)}`);
    }
  }

  const rgdTargets = await collectFilesAsync(plan.attribBase, ".rgd");
  for (const f of rgdTargets) {
    try {
      const buf = await fs.promises.readFile(f);
      const rgd = parseRgd(buf, d);
      const before = JSON.stringify({
        ref: rgd.gameData.reference,
        n: rgd.gameData.entries.length,
      });
      const r = rewriteRgdTableRefs(rgd.gameData, plan.replacements);
      if (r.count > 0) {
        writeRgdFile(f, rgd.gameData, d, rgd.header.version);
        invalidateParsedRgdCache(f);
        rgdEdited++;
        out.appendLine(`[RGD] ${f}  (${r.count} replace(s))`);
        for (const s of r.samples) out.appendLine(`       ${s}`);
      } else {
        void before;
      }
    } catch (e) {
      errors.push(`${f}: ${getErrorMessage(e)}`);
    }
  }

  if (recompile && editedLuaFiles.length) {
    out.appendLine("");
    out.appendLine(
      `Recompiling Lua files that look like RGD sources (GameData / existing .rgd)…`,
    );
    for (const luaPath of editedLuaFiles) {
      const rgdOut = luaPath.replace(/\.lua$/i, ".rgd");
      try {
        const code = stripUtf8BomFromFile(
          luaPath,
          await fs.promises.readFile(luaPath),
        ).buffer.toString("utf8");
        const looksLikeRgdSource =
          fs.existsSync(rgdOut) ||
          /\bGameData\b/.test(code) ||
          /\bReference\s*\(/.test(code) ||
          /\bInherit\s*\(/.test(code);
        if (!looksLikeRgdSource) {
          out.appendLine(`  SKIP ${path.basename(luaPath)} (not an RGD-style Lua)`);
          continue;
        }
        const attribBase = findAttribBase(luaPath) || plan.attribBase;
        const parent = makeRgdParentLoader(attribBase, d);
        const { gameData, version } = await luaToRgdResolved(code, d, parent);
        writeRgdFile(rgdOut, gameData, d, version);
        invalidateParsedRgdCache(rgdOut);
        recompiled++;
        out.appendLine(
          `  compiled ${path.basename(luaPath)} → ${path.basename(rgdOut)}`,
        );
      } catch (e) {
        errors.push(`recompile ${luaPath}: ${getErrorMessage(e)}`);
        out.appendLine(`  SKIP compile ${luaPath}: ${getErrorMessage(e)}`);
      }
    }
  }

  void renamedLuaPath;
  void renamedRgdPath;
  out.appendLine("");
  out.appendLine(
    `Done. Lua files edited: ${luaEdited}, RGD files edited: ${rgdEdited}, recompiled: ${recompiled}`,
  );
  if (errors.length) {
    out.appendLine(`Errors/skips: ${errors.length}`);
  }
  return { luaEdited, rgdEdited, recompiled, errors };
}

async function renamePairWithOptionalRewrite(
  context: vscode.ExtensionContext,
  uri?: vscode.Uri,
): Promise<void> {
  const file = uri?.fsPath;
  if (!file) return;
  let rgd: string | null = null;
  let lua: string | null = null;
  if (/\.rgd$/i.test(file) && !/\.rgd\.txt$/i.test(file)) {
    rgd = file;
    lua = file.replace(/\.rgd$/i, ".lua");
  } else if (/\.lua$/i.test(file)) {
    lua = file;
    rgd = file.replace(/\.lua$/i, ".rgd");
  } else {
    vscode.window.showWarningMessage("Select a .rgd or .lua pair member");
    return;
  }

  const current = path.basename(rgd || lua || "").replace(/\.(rgd|lua)$/i, "");
  const next = await vscode.window.showInputBox({
    prompt:
      "New base name (without extension) — renames both .rgd and .lua if present",
    value: current,
    validateInput: (v) =>
      !v.trim()
        ? "Required"
        : /[<>:"|?*\\/]/.test(v)
          ? "Invalid characters"
          : v.trim() === current
            ? "Name unchanged"
            : null,
  });
  if (!next || next === current) return;

  const dir = path.dirname(file);
  const ops: Array<{ from: string; to: string }> = [];
  if (rgd && fs.existsSync(rgd)) {
    ops.push({ from: rgd, to: path.join(dir, next + ".rgd") });
  }
  if (lua && fs.existsSync(lua)) {
    ops.push({ from: lua, to: path.join(dir, next + ".lua") });
  }
  for (const op of ops) {
    if (fs.existsSync(op.to)) {
      vscode.window.showErrorMessage(`Target exists: ${path.basename(op.to)}`);
      return;
    }
  }

  const attribBase =
    findAttribBase(file) ||
    findAttribBase(dir) ||
    null;

  let rewriteMode:
    | "rename-only"
    | "rewrite"
    | "rewrite-recompile" = "rename-only";

  if (attribBase) {
    const oldAbs = rgd && fs.existsSync(rgd) ? rgd : lua!;
    // Pre-scan for references (using planned paths relative to attrib)
    const oldRel =
      attribRelativePath(oldAbs) ||
      path
        .relative(attribBase, oldAbs)
        .replace(/\\/g, "/")
        .replace(/\.(rgd|lua)$/i, "");
    const newRel = path.posix
      .join(path.posix.dirname(oldRel.replace(/\\/g, "/")), next)
      .replace(/^\.\//, "");
    const replacements = buildRenameReplacements(oldRel, newRel);

    let scanHits = 0;
    const sampleFiles: string[] = [];
    await vscode.window.withProgress(
      {
        location: vscode.ProgressLocation.Notification,
        title: "Scanning for references to rename…",
        cancellable: true,
      },
      async (_p, token) => {
        const files = [
          ...(await collectFilesAsync(attribBase, ".lua")),
          ...(await collectFilesAsync(attribBase, ".rgd")),
        ];
        for (const f of files) {
          if (token.isCancellationRequested) break;
          try {
            if (/\.lua$/i.test(f)) {
              const text = (await fs.promises.readFile(f)).toString("utf8");
              const r = applyPathReplacements(text, replacements);
              if (r.count > 0) {
                scanHits += r.count;
                if (sampleFiles.length < 12) {
                  sampleFiles.push(`${path.basename(f)} (${r.count})`);
                }
              }
            } else {
              // Fast string search on binary isn't great; parse quickly for refs
              const rgdFile = parseRgd(await fs.promises.readFile(f), dict(context));
              const r = rewriteRgdTableRefs(
                // Clone via JSON is heavy; mutate a throwaway parse then discard
                rgdFile.gameData,
                replacements,
              );
              // We mutated in-memory only — DO NOT write. parse was disposable.
              if (r.count > 0) {
                scanHits += r.count;
                if (sampleFiles.length < 12) {
                  sampleFiles.push(`${path.basename(f)} [rgd] (${r.count})`);
                }
              }
            }
          } catch {
            /* skip */
          }
        }
      },
    );

    const preview = sampleFiles.length
      ? `\nExamples: ${sampleFiles.slice(0, 6).join(", ")}`
      : "";
    const pick = await vscode.window.showQuickPick(
      [
        {
          label: "Rename files only",
          description: "No reference rewrites",
          mode: "rename-only" as const,
        },
        {
          label: "Rename + rewrite references",
          description: scanHits
            ? `~${scanHits} occurrence(s) found under attrib`
            : "No hits found in pre-scan (still rewrites if any)",
          detail: preview || undefined,
          mode: "rewrite" as const,
        },
        {
          label: "Rename + rewrite + recompile touched Lua → RGD",
          description: "Safest after Lua path changes; may take a while",
          mode: "rewrite-recompile" as const,
        },
      ],
      {
        placeHolder: `Rename ${current} → ${next}. Update other files that Reference() this path?`,
      },
    );
    if (!pick) return;
    rewriteMode = pick.mode;
  } else {
    const cont = await vscode.window.showWarningMessage(
      "Attrib root not found — can only rename files (no reference rewrite).",
      "Rename only",
      "Cancel",
    );
    if (cont !== "Rename only") return;
  }

  for (const op of ops) {
    await fs.promises.rename(op.from, op.to);
    invalidateParsedRgdCache(op.from);
  }

  const newRgd = ops.find((o) => o.to.endsWith(".rgd"))?.to ?? null;
  const newLua = ops.find((o) => o.to.endsWith(".lua"))?.to ?? null;

  if (rewriteMode === "rename-only" || !attribBase) {
    vscode.window.showInformationMessage(
      `Renamed ${ops.length} file(s) → ${next}.*`,
    );
    return;
  }

  const plan: PathRewritePlan = {
    attribBase,
    oldStem: current,
    newStem: next,
    replacements: buildRenameReplacements(
      attribRelativePath(newRgd || newLua || file) ||
        path
          .relative(attribBase, newRgd || newLua || file)
          .replace(/\\/g, "/")
          .replace(/\.(rgd|lua)$/i, "")
          .replace(new RegExp(escapeRegExp(next) + "$"), current),
      attribRelativePath(newRgd || newLua || file) ||
        path
          .relative(attribBase, newRgd || newLua || file)
          .replace(/\\/g, "/")
          .replace(/\.(rgd|lua)$/i, ""),
    ),
    hits: [],
    totalHits: 0,
  };

  // Fix replacements: old paths must use OLD relative path (before rename)
  // Reconstruct from parent dir + current/next
  {
    const sample = newRgd || newLua || file;
    const newRel =
      attribRelativePath(sample) ||
      path
        .relative(attribBase, sample)
        .replace(/\\/g, "/")
        .replace(/\.(rgd|lua)$/i, "");
    const oldRel = path.posix
      .join(path.posix.dirname(newRel), current)
      .replace(/^\.\//, "");
    plan.replacements = buildRenameReplacements(oldRel, newRel);
  }

  const result = await vscode.window.withProgress(
    {
      location: vscode.ProgressLocation.Notification,
      title: "Rewriting references after rename…",
      cancellable: false,
    },
    async () =>
      applyRenameRewrites(
        context,
        plan,
        newLua,
        newRgd,
        rewriteMode === "rewrite-recompile",
      ),
  );

  vscode.window.showInformationMessage(
    `Renamed → ${next}.* · Lua ${result.luaEdited}, RGD ${result.rgdEdited}` +
      (rewriteMode === "rewrite-recompile"
        ? `, recompiled ${result.recompiled}`
        : "") +
      " (details in Output → RGD Rename Rewrite)",
  );
}
